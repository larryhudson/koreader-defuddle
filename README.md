# Defuddle for KOReader

Defuddle is a small local reading setup for a jailbroken Kindle running KOReader. It lets KOReader open web articles through a server on your Wi-Fi network, where a full browser renders the page and Defuddle extracts a clean article view before the Kindle downloads it.

This is intended for personal use on a trusted home network.

## How it works

The project has two parts:

- `defuddle-server`: a TypeScript/Node server that runs Playwright Chromium, renders article pages, extracts readable content with Defuddle, caches the result, and serves simple HTML for KOReader.
- `defuddle.koplugin`: a KOReader plugin that adds a Defuddle entry to the Tools menu and an "Open with Defuddle" action for HTTP links.

The server keeps a reading list in `defuddle-server/data/links.json` and cached article content in `defuddle-server/data/cache/`. Those files are generated locally and are not meant to be committed.

## Features

- Open a reading list from KOReader: `Tools -> Defuddle -> Open reading list`.
- Add links over HTTP with `POST /links`.
- Render articles through `/read?url=...`.
- Rewrite article links so tapping a link in KOReader opens the next page through Defuddle.
- Mark reading list items as read when opened.
- Move saved items to an archive.
- Cache extracted article content after the first render.
- Force refresh a cached article from the article header.

## Server setup

Install dependencies:

```sh
cd defuddle-server
npm install
npx playwright install chromium
```

Find the LAN IP address of the computer that will run the server. On macOS Wi-Fi this is usually:

```sh
ipconfig getifaddr en0
```

Start the server on all network interfaces:

```sh
HOST=0.0.0.0 npm run dev
```

The default port is `8787`. From another device on the same Wi-Fi, check:

```text
http://YOUR_SERVER_IP:8787/health
http://YOUR_SERVER_IP:8787/list
```

## KOReader plugin setup

Edit `defuddle.koplugin/main.lua` and set `proxy_base_url` to your server:

```lua
proxy_base_url = "http://YOUR_SERVER_IP:8787"
```

Copy the plugin directory to your Kindle:

```text
koreader/plugins/defuddle.koplugin
```

If you previously installed the prototype as `readerproxy.koplugin`, remove that old folder from the Kindle so KOReader does not load both plugins.

Restart KOReader. You should see `Defuddle` in the Tools menu.

## Adding links

You can add links from your computer:

```sh
curl -X POST http://localhost:8787/links \
  -H 'Content-Type: application/json' \
  --data '{"url":"https://example.com/article","title":"Optional title"}'
```

The server starts fetching and caching the article in the background after a link is added. You can also save the current article from the generated article header.

## Development

Run TypeScript checks:

```sh
cd defuddle-server
npm run check
```

Use `PORT` to change the server port:

```sh
PORT=8790 HOST=0.0.0.0 npm run dev
```
