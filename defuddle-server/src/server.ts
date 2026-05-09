import express from "express";
import type { Request } from "express";
import { chromium, type Browser } from "playwright";
import { JSDOM } from "jsdom";
import { Defuddle } from "defuddle/node";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";
const DATA_DIR = path.join(process.cwd(), "data");
const LINKS_FILE = path.join(DATA_DIR, "links.json");
const CACHE_DIR = path.join(DATA_DIR, "cache");

type RenderedPage = {
  html: string;
  url: string;
};

type Article = {
  title: string;
  byline: string;
  content: string;
  excerpt: string;
  source: string;
};

type CachedArticle = Article & {
  url: string;
  finalUrl: string;
  fetchedAt: string;
};

type RenderMode = "styled" | "plain";

type ReadingListItem = {
  id: string;
  url: string;
  title: string;
  addedAt: string;
  readAt: string | null;
  archivedAt: string | null;
};

let browserPromise: Promise<Browser> | undefined;

const app = express();

app.get("/", (_req, res) => {
  res.type("html").send(renderHome());
});

app.get("/read", async (req, res) => {
  const url = normalizeUrl(unwrapProxyUrl(req.query.url, req));
  if (!url) {
    res.status(400).type("text").send("Missing or invalid ?url=https://...");
    return;
  }

  try {
    await markReadFromRequest(req, url);
    const cached = await getCachedArticle(url, shouldRefresh(req));
    const isSaved = await isInReadingList([url, cached.finalUrl]);
    res.type("html").send(renderArticle(cached, cached.finalUrl, req, getRenderMode(req), getPreviousUrl(req, cached.finalUrl), isSaved, url));
  } catch (error) {
    console.error(error);
    res.status(502).type("html").send(renderError(url, error));
  }
});

app.get("/links", async (_req, res) => {
  res.json(await loadReadingList());
});

app.get("/list", async (req, res) => {
  res.type("html").send(renderReadingList(await loadReadingList(), req));
});

app.post("/links", express.json(), async (req, res) => {
  const url = normalizeUrl(req.body?.url);
  if (!url) {
    res.status(400).json({ error: "Missing or invalid JSON body: { \"url\": \"https://...\" }" });
    return;
  }

  const item = await saveToReadingList(url, req.body?.title);
  void prefetchArticle(url);
  res.status(201).json(item);
});

app.get("/save", async (req, res) => {
  const url = normalizeUrl(unwrapProxyUrl(req.query.url, req));
  if (!url) {
    res.status(400).type("text").send("Missing or invalid ?url=https://...");
    return;
  }

  const item = await saveToReadingList(url, stringQueryParam(req.query.title));
  void prefetchArticle(url);
  res.redirect(303, buildProxyReadUrl(`${req.protocol}://${req.get("host")}`, item.url));
});

app.get("/archive", async (req, res) => {
  const url = normalizeUrl(unwrapProxyUrl(req.query.url, req));
  if (!url) {
    res.status(400).type("text").send("Missing or invalid ?url=https://...");
    return;
  }

  const item = await archiveReadingListItem(url);
  if (!item) {
    res.status(404).type("html").send(renderMessage("Not in reading list", "This URL is not in the reading list."));
    return;
  }

  res.type("html").send(renderArchiveConfirmation(item, req));
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.listen(PORT, HOST, () => {
  console.log(`defuddle-server listening on http://${HOST}:${PORT}`);
});

process.on("SIGINT", async () => {
  if (browserPromise) {
    const browser = await browserPromise;
    await browser.close();
  }
  process.exit(0);
});

function normalizeUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.href;
  } catch {
    return null;
  }
}

function unwrapProxyUrl(value: unknown, req: Request): unknown {
  if (typeof value !== "string") return value;

  let current = value;
  for (let i = 0; i < 5; i += 1) {
    let parsed: URL;
    try {
      parsed = new URL(current);
    } catch {
      return current;
    }

    if (!isProxyReadUrl(parsed, req)) return current;

    const nested = parsed.searchParams.get("url");
    if (!nested) return current;
    current = nested;
  }

  return current;
}

function isProxyReadUrl(url: URL, req: Request): boolean {
  const requestHost = req.get("host");
  const configuredHost = `${HOST}:${PORT}`;
  const localhostHosts = new Set([
    `127.0.0.1:${PORT}`,
    `localhost:${PORT}`,
    `0.0.0.0:${PORT}`,
    requestHost,
    configuredHost,
  ]);

  return url.pathname === "/read" && localhostHosts.has(url.host);
}

function getPreviousUrl(req: Request, currentUrl: string): string | null {
  const directPrevious = normalizeUrl(unwrapProxyUrl(req.query.prev, req));
  if (directPrevious && directPrevious !== currentUrl) return directPrevious;

  const nestedPrevious = normalizeUrl(unwrapProxyUrl(getNestedProxyParam(req.query.url, req, "prev"), req));
  if (nestedPrevious && nestedPrevious !== currentUrl) return nestedPrevious;

  return null;
}

function getNestedProxyParam(value: unknown, req: Request, param: string): string | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = new URL(value);
    if (!isProxyReadUrl(parsed, req)) return null;
    return parsed.searchParams.get(param);
  } catch {
    return null;
  }
}

function stringQueryParam(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function shouldRefresh(req: Request): boolean {
  return req.query.refresh === "1" || req.query.refresh === "true";
}

async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = chromium.launch({ headless: true });
  }
  return browserPromise;
}

async function fetchRenderedPage(url: string): Promise<RenderedPage> {
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent: USER_AGENT,
    viewport: { width: 900, height: 1200 },
    deviceScaleFactor: 1,
    isMobile: false,
  });
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
    const html = await page.content();
    return { html, url: page.url() };
  } finally {
    await context.close();
  }
}

async function extractArticle(html: string, url: string): Promise<Article> {
  const dom = new JSDOM(html, { url });
  const document = dom.window.document;

  const result = await Defuddle(document, url, {
    removeHiddenElements: true,
    removeExactSelectors: true,
    removePartialSelectors: true,
    removeLowScoring: true,
    standardize: true,
  });

  if (!result?.content) {
    throw new Error("No readable content found");
  }

  return {
    title: result.title || document.title || url,
    byline: result.author || result.site || "",
    content: result.content,
    excerpt: result.description || "",
    source: "Defuddle",
  };
}

async function getCachedArticle(url: string, refresh: boolean): Promise<CachedArticle> {
  if (!refresh) {
    const cached = await loadCachedArticle(url);
    if (cached) return cached;
  }

  return fetchExtractAndCacheArticle(url);
}

async function prefetchArticle(url: string): Promise<void> {
  try {
    await getCachedArticle(url, false);
  } catch (error) {
    console.warn(`Prefetch failed for ${url}: ${errorMessage(error)}`);
  }
}

async function fetchExtractAndCacheArticle(url: string): Promise<CachedArticle> {
  const page = await fetchRenderedPage(url);
  const article = await extractArticle(page.html, page.url);
  const cached: CachedArticle = {
    ...article,
    url,
    finalUrl: page.url,
    fetchedAt: new Date().toISOString(),
  };
  await saveCachedArticle(cached);
  return cached;
}

async function loadCachedArticle(url: string): Promise<CachedArticle | null> {
  try {
    const raw = await readFile(cachePathForUrl(url), "utf8");
    const parsed = JSON.parse(raw);
    return isCachedArticle(parsed) ? parsed : null;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

async function saveCachedArticle(article: CachedArticle): Promise<void> {
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(cachePathForUrl(article.url), `${JSON.stringify(article, null, 2)}\n`);
  if (article.finalUrl !== article.url) {
    await writeFile(cachePathForUrl(article.finalUrl), `${JSON.stringify(article, null, 2)}\n`);
  }
}

function cachePathForUrl(url: string): string {
  return path.join(CACHE_DIR, `${createLinkId(url)}.json`);
}

function getRenderMode(req: Request): RenderMode {
  return req.query.style === "styled" ? "styled" : "plain";
}

function renderArticle(
  article: Article,
  sourceUrl: string,
  req: Request,
  mode: RenderMode,
  previousUrl: string | null,
  isSaved: boolean,
  requestedUrl: string,
): string {
  const rewritten = rewriteLinks(article.content, sourceUrl, req);
  const style = mode === "styled" ? renderArticleStyle() : "";
  const origin = `${req.protocol}://${req.get("host")}`;
  const previousLink = previousUrl
    ? `<p><a href="${escapeAttribute(buildProxyReadUrl(`${req.protocol}://${req.get("host")}`, previousUrl))}">Previous</a></p>`
    : "";
  const listActionLink = isSaved
    ? `<p><a href="${escapeAttribute(buildArchiveUrl(origin, sourceUrl))}">Move to archive</a></p>`
    : `<p><a href="${escapeAttribute(buildSaveUrl(origin, sourceUrl, article.title))}">Save to reading list</a></p>`;
  const refreshLink = `<p><a href="${escapeAttribute(buildRefreshUrl(origin, requestedUrl, previousUrl))}">Force refresh</a></p>`;
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(article.title)}</title>
  ${style}
</head>
<body>
  <header>
    ${previousLink}
    ${listActionLink}
    ${refreshLink}
    <h1>${escapeHtml(article.title)}</h1>
    <div class="meta">
      ${escapeHtml(article.byline)}
      ${article.byline ? "<br>" : ""}
      ${escapeHtml(article.source)} from <a href="${escapeAttribute(sourceUrl)}">${escapeHtml(sourceUrl)}</a>
    </div>
  </header>
  <main>${rewritten}</main>
</body>
</html>`;
}

function renderArticleStyle(): string {
  return `<style>
    body {
      margin: 0 auto;
      max-width: 42rem;
      padding: 1.25rem;
      font-family: Georgia, "Times New Roman", serif;
      font-size: 20px;
      line-height: 1.55;
      color: #111;
      background: #fff;
    }
    header { border-bottom: 1px solid #aaa; margin-bottom: 1.25rem; padding-bottom: .75rem; }
    h1 { font-size: 1.7rem; line-height: 1.15; margin: 0 0 .5rem; }
    h2, h3 { line-height: 1.25; margin-top: 1.6rem; }
    .meta { color: #444; font-family: system-ui, sans-serif; font-size: .82rem; line-height: 1.35; }
    a { color: #000; text-decoration: underline; text-decoration-thickness: 1px; }
    img, video, iframe { max-width: 100%; height: auto; }
    pre, code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .88em; }
    pre { white-space: pre-wrap; border-left: 3px solid #777; padding-left: .8rem; }
    blockquote { border-left: 3px solid #777; margin-left: 0; padding-left: 1rem; color: #222; }
  </style>`;
}

function rewriteLinks(content: string, sourceUrl: string, req: Request): string {
  const dom = new JSDOM(`<main>${content}</main>`, { url: sourceUrl });
  const document = dom.window.document;
  const origin = `${req.protocol}://${req.get("host")}`;

  for (const link of document.querySelectorAll("a[href]")) {
    if (!link.textContent?.trim() && link.querySelector("img, picture, figure")) {
      link.replaceWith(...Array.from(link.childNodes));
    }
  }

  for (const link of document.querySelectorAll("a[href]")) {
    const originalHref = link.getAttribute("href");
    if (!originalHref || originalHref.startsWith("#")) continue;
    try {
      const absoluteUrl = new URL(originalHref, sourceUrl);
      if (absoluteUrl.protocol === "http:" || absoluteUrl.protocol === "https:") {
        const targetUrl = unwrapProxyUrl(absoluteUrl.href, req);
        link.setAttribute("href", buildProxyReadUrl(origin, String(targetUrl), sourceUrl));
      }
    } catch {
      link.removeAttribute("href");
    }
  }

  for (const image of document.querySelectorAll("img[src]")) {
    try {
      const src = image.getAttribute("src");
      if (src) {
        image.setAttribute("src", new URL(src, sourceUrl).href);
      }
    } catch {
      image.remove();
    }
    image.removeAttribute("srcset");
    image.removeAttribute("sizes");
  }

  return document.querySelector("main")?.innerHTML || "";
}

function buildProxyReadUrl(origin: string, targetUrl: string, previousUrl?: string): string {
  const params = new URLSearchParams({
    style: "plain",
    url: targetUrl,
  });
  if (previousUrl) {
    params.set("prev", previousUrl);
  }
  return `${origin}/read?${params.toString()}`;
}

function buildRefreshUrl(origin: string, targetUrl: string, previousUrl?: string | null): string {
  const params = new URLSearchParams({
    style: "plain",
    refresh: "1",
    url: targetUrl,
  });
  if (previousUrl) {
    params.set("prev", previousUrl);
  }
  return `${origin}/read?${params.toString()}`;
}

function buildSaveUrl(origin: string, targetUrl: string, title: string): string {
  const params = new URLSearchParams({
    url: targetUrl,
    title,
  });
  return `${origin}/save?${params.toString()}`;
}

function buildArchiveUrl(origin: string, targetUrl: string): string {
  const params = new URLSearchParams({ url: targetUrl });
  return `${origin}/archive?${params.toString()}`;
}

function buildListReadUrl(origin: string, item: ReadingListItem): string {
  const params = new URLSearchParams({
    style: "plain",
    id: item.id,
    url: item.url,
    prev: `${origin}/list`,
  });
  return `${origin}/read?${params.toString()}`;
}

async function markReadFromRequest(req: Request, url: string): Promise<void> {
  const id = stringQueryParam(req.query.id);
  if (!id) return;

  const items = await loadReadingList();
  const item = items.find((candidate) => candidate.id === id && candidate.url === url);
  if (!item || item.readAt) return;

  item.readAt = new Date().toISOString();
  await saveReadingList(items);
}

async function loadReadingList(): Promise<ReadingListItem[]> {
  try {
    const raw = await readFile(LINKS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isReadingListItem).map(normalizeReadingListItem) : [];
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }
}

async function isInReadingList(urls: string[]): Promise<boolean> {
  const urlSet = new Set(urls);
  const items = await loadReadingList();
  return items.some((item) => urlSet.has(item.url));
}

async function saveReadingList(items: ReadingListItem[]): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(LINKS_FILE, `${JSON.stringify(items, null, 2)}\n`);
}

async function saveToReadingList(url: string, title?: string): Promise<ReadingListItem> {
  const items = await loadReadingList();
  const existing = items.find((item) => item.url === url);
  if (existing) {
    if (title && existing.title === existing.url) {
      existing.title = title;
      await saveReadingList(items);
    }
    return existing;
  }

  const item: ReadingListItem = {
    id: createLinkId(url),
    url,
    title: title || url,
    addedAt: new Date().toISOString(),
    readAt: null,
    archivedAt: null,
  };
  items.unshift(item);
  await saveReadingList(items);
  return item;
}

async function archiveReadingListItem(url: string): Promise<ReadingListItem | null> {
  const items = await loadReadingList();
  const item = items.find((candidate) => candidate.url === url);
  if (!item) return null;

  item.archivedAt = new Date().toISOString();
  await saveReadingList(items);
  return item;
}

function renderArchiveConfirmation(item: ReadingListItem, req: Request): string {
  const origin = `${req.protocol}://${req.get("host")}`;
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Archived</title>
</head>
<body>
  <h1>Moved to archive</h1>
  <p>${escapeHtml(item.title)}</p>
  <p><a href="${escapeAttribute(`${origin}/list`)}">Back to reading list</a></p>
  <p><a href="${escapeAttribute(buildProxyReadUrl(origin, item.url))}">Back to article</a></p>
</body>
</html>`;
}

function renderReadingList(items: ReadingListItem[], req: Request): string {
  const origin = `${req.protocol}://${req.get("host")}`;
  const unread = items.filter((item) => !item.archivedAt && !item.readAt);
  const read = items.filter((item) => !item.archivedAt && item.readAt);
  const archived = items.filter((item) => item.archivedAt);
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Reading List</title>
</head>
<body>
  <h1>Reading List</h1>
  ${renderReadingListSection("Unread", unread, origin)}
  ${renderReadingListSection("Read", read, origin)}
  ${renderReadingListSection("Archived", archived, origin)}
</body>
</html>`;
}

function renderReadingListSection(title: string, items: ReadingListItem[], origin: string): string {
  if (items.length === 0) {
    return `<h2>${escapeHtml(title)}</h2><p>None</p>`;
  }

  const rows = items
    .map((item) => {
      const date = item.archivedAt || item.readAt || item.addedAt;
      return `<li><a href="${escapeAttribute(buildListReadUrl(origin, item))}">${escapeHtml(item.title)}</a><br><small>${escapeHtml(date)}</small></li>`;
    })
    .join("\n");
  return `<h2>${escapeHtml(title)}</h2><ul>${rows}</ul>`;
}

function createLinkId(url: string): string {
  let hash = 5381;
  for (let i = 0; i < url.length; i += 1) {
    hash = ((hash << 5) + hash + url.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}

function isReadingListItem(value: unknown): value is ReadingListItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<ReadingListItem>;
  return (
    typeof item.id === "string" &&
    typeof item.url === "string" &&
    typeof item.title === "string" &&
    typeof item.addedAt === "string" &&
    (typeof item.readAt === "string" || item.readAt === null) &&
    (typeof item.archivedAt === "string" || item.archivedAt === null || item.archivedAt === undefined)
  );
}

function normalizeReadingListItem(item: ReadingListItem): ReadingListItem {
  return {
    ...item,
    archivedAt: item.archivedAt || null,
  };
}

function isCachedArticle(value: unknown): value is CachedArticle {
  if (!value || typeof value !== "object") return false;
  const article = value as Partial<CachedArticle>;
  return (
    typeof article.url === "string" &&
    typeof article.finalUrl === "string" &&
    typeof article.title === "string" &&
    typeof article.byline === "string" &&
    typeof article.content === "string" &&
    typeof article.excerpt === "string" &&
    typeof article.source === "string" &&
    typeof article.fetchedAt === "string"
  );
}

function renderMessage(title: string, message: string): string {
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>
<body>
  <h1>${escapeHtml(title)}</h1>
  <p>${escapeHtml(message)}</p>
</body>
</html>`;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function renderHome(): string {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Defuddle</title>
  <style>
    body { max-width: 42rem; margin: 2rem auto; padding: 0 1rem; font: 18px/1.5 system-ui, sans-serif; }
    input { width: 100%; box-sizing: border-box; font: inherit; padding: .6rem; }
    button { font: inherit; padding: .55rem .8rem; margin-top: .75rem; }
  </style>
</head>
<body>
  <h1>Defuddle</h1>
  <form action="/read" method="get">
    <input name="url" type="url" placeholder="https://example.com/article" required>
    <button>Read</button>
  </form>
</body>
</html>`;
}

function renderError(url: string, error: unknown): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Fetch failed</title></head>
<body>
  <h1>Fetch failed</h1>
  <p>${escapeHtml(url)}</p>
  <pre>${escapeHtml(errorStack(error))}</pre>
</body></html>`;
}

function escapeHtml(value: unknown): string {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeAttribute(value: unknown): string {
  return escapeHtml(value).replaceAll("'", "&#39;");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorStack(error: unknown): string {
  return error instanceof Error ? error.stack || error.message : String(error);
}
