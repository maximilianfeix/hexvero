"use strict";
const { app, ipcMain, BrowserWindow, Menu, shell } = require("electron");
const { CHANNELS } = require("./shared/channels");
const { IpcRouter } = require("./main/ipc-router");
const { registerHandlers } = require("./main/handlers");
const windows = require("./main/windows");

const UPDATE_FEED = "https://updates.tidemark.example/desktop/latest.json";
const DOCS_URL = "https://docs.tidemark.example/writing-release-notes";

const router = new IpcRouter("editor");

async function checkForUpdate() {
  try {
    const res = await fetch(UPDATE_FEED, { headers: { accept: "application/json" } });
    const { version } = await res.json();
    return version && version !== app.getVersion() ? version : null;
  } catch {
    return null;
  }
}

ipcMain.handle("app:info", async () => ({
  version: app.getVersion(),
  update: await checkForUpdate(),
  platform: process.platform,
}));

ipcMain.on(CHANNELS.PREVIEW_OPEN, () => {
  windows.previewWindow.open(windows.editor());
});

ipcMain.on("preview:ping", (event) => {
  event.reply("preview:pong", { at: Date.now(), editorOpen: Boolean(windows.editor()) });
});

function buildMenu() {
  return Menu.buildFromTemplate([
    {
      label: "File",
      submenu: [
        // Disabled until PDF export lands; the id only lets the menu find the item.
        { id: "export:pdf", label: "Export as PDF…", enabled: false },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    { role: "editMenu" },
    {
      label: "Help",
      submenu: [
        { label: "Markdown help", click: () => windows.openHelp() },
        { label: "Writing release notes", click: () => shell.openExternal(DOCS_URL) },
      ],
    },
  ]);
}

app.whenReady().then(() => {
  registerHandlers(router, windows);
  Menu.setApplicationMenu(buildMenu());
  windows.createEditorWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) windows.createEditorWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    router.dispose();
    app.quit();
  }
});
