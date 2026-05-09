local BD = require("ui/bidi")
local DataStorage = require("datastorage")
local Dispatcher = require("dispatcher")
local Event = require("ui/event")
local InfoMessage = require("ui/widget/infomessage")
local NetworkMgr = require("ui/network/manager")
local UIManager = require("ui/uimanager")
local WidgetContainer = require("ui/widget/container/widgetcontainer")
local ffiUtil = require("ffi/util")
local http = require("socket.http")
local lfs = require("libs/libkoreader-lfs")
local logger = require("logger")
local socket = require("socket")
local socketutil = require("socketutil")
local util = require("util")
local _ = require("gettext")
local T = ffiUtil.template

local function insertMenuItem(order_table, parent_id, item_id, after_id)
    local parent = order_table[parent_id]
    if not parent then return end

    for _, id in ipairs(parent) do
        if id == item_id then return end
    end

    for index, id in ipairs(parent) do
        if id == after_id then
            table.insert(parent, index + 1, item_id)
            return
        end
    end

    table.insert(parent, 1, item_id)
end

local function placeDefuddleInToolsMenu()
    insertMenuItem(require("ui/elements/reader_menu_order"), "tools", "defuddle", "read_timer")
    insertMenuItem(require("ui/elements/filemanager_menu_order"), "tools", "defuddle", "read_timer")
end

local Defuddle = WidgetContainer:extend{
    name = "defuddle",

    -- Change this to your Mac/server LAN address before copying to the Kindle.
    proxy_base_url = "http://192.168.1.100:8787",

    output_dir_name = "defuddle",
    output_file_name = "current.html",
}

function Defuddle:init()
    placeDefuddleInToolsMenu()
    self:onDispatcherRegisterActions()
    self.ui.menu:registerToMainMenu(self)

    if self.ui and self.ui.link then
        self.ui.link:addToExternalLinkDialog("25_defuddle", function(this, link_url)
            return {
                text = _("Open with Defuddle"),
                callback = function()
                    UIManager:close(this.external_link_dialog)
                    self:openUrlWhenOnline(link_url)
                end,
                show_in_dialog_func = function(url)
                    return self:isHttpUrl(url)
                end,
            }
        end)
    end
end

function Defuddle:onDispatcherRegisterActions()
    Dispatcher:registerAction("defuddle_open_reading_list", {
        category = "none",
        event = "DefuddleOpenReadingList",
        title = _("Defuddle: open reading list"),
        general = true,
    })
end

function Defuddle:addToMainMenu(menu_items)
    menu_items.defuddle = {
        text = _("Defuddle"),
        sorting_hint = "tools",
        sub_item_table = {
            {
                text = _("Open reading list"),
                callback = function()
                    self:onDefuddleOpenReadingList()
                end,
            },
            {
                text = T(_("Server: %1"), self.proxy_base_url),
                enabled = false,
            },
        },
    }
end

function Defuddle:onDefuddleOpenReadingList()
    self:openDefuddlePageWhenOnline("/list")
end

function Defuddle:openUrlWhenOnline(url)
    if not self:isHttpUrl(url) then
        UIManager:show(InfoMessage:new{
            text = T(_("Defuddle only supports HTTP/HTTPS URLs:\n%1"), BD.url(url)),
        })
        return
    end

    NetworkMgr:runWhenOnline(function()
        self:downloadAndOpen(url)
    end)
end

function Defuddle:openDefuddlePageWhenOnline(path)
    NetworkMgr:runWhenOnline(function()
        self:downloadAndOpenDirect(self.proxy_base_url .. path)
    end)
end

function Defuddle:downloadAndOpen(url)
    local info = InfoMessage:new{
        text = T(_("Defuddle is fetching:\n%1"), BD.url(url)),
    }
    UIManager:show(info)

    local output_file = self:getOutputFile()
    local ok, err = self:downloadProxyHtml(url, output_file)

    UIManager:close(info)

    if not ok then
        UIManager:show(InfoMessage:new{
            text = T(_("Defuddle failed:\n%1"), err or _("Unknown error")),
        })
        return
    end

    self:openFile(output_file)
end

function Defuddle:downloadAndOpenDirect(url)
    local info = InfoMessage:new{
        text = T(_("Defuddle is fetching:\n%1"), BD.url(url)),
    }
    UIManager:show(info)

    local output_file = self:getOutputFile()
    local ok, err = self:downloadUrl(url, output_file)

    UIManager:close(info)

    if not ok then
        UIManager:show(InfoMessage:new{
            text = T(_("Defuddle failed:\n%1"), err or _("Unknown error")),
        })
        return
    end

    self:openFile(output_file)
end

function Defuddle:downloadProxyHtml(url, output_file)
    local proxy_url = self:buildProxyUrl(url)
    return self:downloadUrl(proxy_url, output_file)
end

function Defuddle:downloadUrl(url, output_file)
    logger.dbg("Defuddle: fetching", url, "to", output_file)

    local file, file_err = io.open(output_file, "w")
    if not file then
        return false, file_err
    end

    socketutil:set_timeout(socketutil.FILE_BLOCK_TIMEOUT, socketutil.FILE_TOTAL_TIMEOUT)
    local code, headers, status = socket.skip(1, http.request{
        url = url,
        method = "GET",
        sink = socketutil.file_sink(file),
        headers = {
            ["Accept"] = "text/html,application/xhtml+xml",
        },
    })
    socketutil:reset_timeout()

    if code ~= 200 then
        os.remove(output_file)
        logger.warn("Defuddle: fetch failed", status or code, headers)
        return false, status or T(_("HTTP status %1"), code or _("unknown"))
    end

    return true
end

function Defuddle:openFile(file)
    UIManager:broadcastEvent(Event:new("SetupShowReader"))
    if self.ui.document then
        self.ui:switchDocument(file)
    else
        self.ui:openFile(file)
    end
end

function Defuddle:buildProxyUrl(url)
    return self.proxy_base_url .. "/read?url=" .. util.urlEncode(url)
end

function Defuddle:getOutputFile()
    local output_dir = ffiUtil.joinPath(DataStorage:getDataDir(), self.output_dir_name)
    if lfs.attributes(output_dir, "mode") ~= "directory" then
        lfs.mkdir(output_dir)
    end
    return ffiUtil.joinPath(output_dir, self.output_file_name)
end

function Defuddle:isHttpUrl(url)
    return type(url) == "string" and url:match("^https?://") ~= nil
end

return Defuddle
