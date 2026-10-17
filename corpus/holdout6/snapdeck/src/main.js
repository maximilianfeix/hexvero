"use strict";
const { app, ipcMain, Menu, BrowserWindow } = require("electron");
const { Channels } = require("./shared/channels");
const windows = require("./main/windows");
const { registerRoutes } = require("./main/ipc");
const prefs = require("./main/prefs");
const { buildMenu } = require("./main/menu");
const { lockNavigation } = require("./main/navigation");
const { checkForUpdates } = require("./main/updates");
const { auditWindow } = require("./main/policy");

lockNavigation();

ipcMain.handle(Channels.SHOT_OPEN, async (_event, id) => {
  windows.openAnnotator(id);
  return true;
});

// Answered synchronously: the library page shows the version in its footer on load.
ipcMain.on("app:version", (event) => {
  event.returnValue = app.getVersion();
});

app.whenReady().then(() => {
  registerRoutes();
  prefs.register(ipcMain);
  windows.watchAnnotators();
  Menu.setApplicationMenu(buildMenu());
  const library = windows.openLibrary();
  if (!app.isPackaged) auditWindow(library, "library");
  checkForUpdates();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) windows.openLibrary();
});
