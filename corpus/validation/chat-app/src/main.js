// Main process of the corpus chat application.
// MIT licensed, written for this corpus.
"use strict";

const path = require("node:path");
const https = require("node:https");
const { EventEmitter } = require("node:events");
const { app, BrowserWindow, ipcMain, net } = require("electron");
const Store = require("electron-store");
const CHANNELS = require("./ipc-names");

const prefs = new Store({ name: "chat-prefs" });
const PRELOAD = path.join(__dirname, "preload.js");

/** @type {BrowserWindow | null} */
let mainWindow = null;

// ---------------------------------------------------------------------------------------------
// Objects that only look like window settings.

// Options for the push-notification gateway client. Not a window.
const apns = { sandbox: true, bundleId: "example.chat.desktop" };

// Attributes the renderer puts on the <video> and <iframe> elements of a link preview.
const linkPreviewAttributes = { preload: "metadata", sandbox: "allow-scripts" };

// ---------------------------------------------------------------------------------------------
// Windows.

/** The settings every window starts from; a caller may add to them or replace one. */
function basePreferences(extra = {}) {
  return { contextIsolation: true, nodeIntegration: false, sandbox: false, ...extra };
}

function openMainWindow() {
  const bounds = prefs.get("window.bounds") ?? { width: 1180, height: 760 };
  const win = new BrowserWindow({
    ...bounds,
    minWidth: 640,
    title: "Chat",
    // sandbox: true given here replaces the sandbox: false of basePreferences.
    webPreferences: basePreferences({ preload: PRELOAD, sandbox: true, spellcheck: true }),
  });
  win.on("close", () => prefs.set("window.bounds", win.getBounds()));
  win.on("closed", () => {
    mainWindow = null;
  });
  win.loadFile("index.html");
  return win;
}

// The settings dialog is old code: it has no preload script and uses Node from the page.
const LEGACY_PREFERENCES = { nodeIntegration: true, contextIsolation: false };

function openSettingsWindow(parent) {
  const dialog = new BrowserWindow({
    parent,
    modal: true,
    width: 520,
    height: 420,
    webPreferences: { ...LEGACY_PREFERENCES, sandbox: false, webSecurity: false },
  });
  dialog.loadFile("index.html", { hash: "settings" });
  return dialog;
}

// ---------------------------------------------------------------------------------------------
// Main -> renderer.

/** Sends to every open window. */
function broadcast(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, payload);
}

// ---------------------------------------------------------------------------------------------
// Renderer -> main.

/** Registers a request handler that does not care about the event object. */
function route(channel, fn) {
  ipcMain.handle(channel, (_event, ...args) => fn(...args));
}

const rooms = new Map([["general", { members: 3 }]]);

// A table of handlers; each key is registered as a channel in registerIpc().
const roomHandlers = {
  "rooms:join": async (_event, room) => {
    rooms.set(room, { members: (rooms.get(room)?.members ?? 0) + 1 });
    return true;
  },
  "rooms:leave": async (_event, room) => rooms.delete(room),
};

function registerIpc() {
  // through the wrapper, name from the shared constants
  route(CHANNELS.SEND_MESSAGE, (room, text) => {
    const message = { room, text, at: Date.now() };
    mainWindow?.webContents.send("chat:incoming", message);
    return message;
  });
  // through the wrapper, literal name
  route("rooms:list", () => [...rooms.keys()]);

  // directly, name from the shared constants
  ipcMain.handle(CHANNELS.HISTORY, async (_event, room, before) => ({ room, before, items: [] }));

  // every key of the table
  for (const [channel, handler] of Object.entries(roomHandlers)) ipcMain.handle(channel, handler);

  // one-way messages
  ipcMain.on("presence:typing", (_event, room) =>
    broadcast("presence:update", { room, typing: true }),
  );
  ipcMain.once("app:renderer-ready", () => broadcast("presence:update", { online: true }));
  ipcMain.on("app:locale", (event) => {
    event.returnValue = app.getLocale();
  });

  // answered at most once per start
  ipcMain.handleOnce("auth:bootstrap", async () => ({
    user: "corpus",
    preview: linkPreviewAttributes,
  }));
  ipcMain.handle("auth:sign-out", async () => {
    prefs.delete("auth.refreshToken");
    return true;
  });

  // settings dialog
  ipcMain.on("settings:open", () => openSettingsWindow(mainWindow));
  ipcMain.removeHandler("settings:reset");
  ipcMain.handle("settings:reset", async () => {
    prefs.set("ui.zoom", 1);
    return prefs.get("ui.zoom");
  });
  ipcMain.on("settings:save", (event, values) => {
    prefs.set("ui.zoom", values.zoom);
    // event.sender is the webContents of the window that sent the message
    event.sender.send("settings:saved", { ok: true });
  });

  // a listener per room: the name exists only at run time
  for (const room of rooms.keys()) ipcMain.on(`room:${room}:ack`, () => {});
}

// ---------------------------------------------------------------------------------------------
// Things that look like IPC or storage and are neither.

function notIpc() {
  // ipcMain.handle("ghost:commented-out", () => {});
  const manual = "Register with ipcMain.on('ghost:in-a-string', listener) in main.js";
  // an ordinary event emitter and a job scheduler with the same method names
  const bus = new EventEmitter();
  bus.on("ghost:emitter-event", () => {});
  bus.once("ghost:emitter-once", () => {});
  const scheduler = {
    jobs: [],
    handle(name, job) {
      this.jobs.push([name, job]);
    },
  };
  scheduler.handle("ghost:scheduler-job", () => manual);
  bus.emit("ghost:emitter-event");

  // a Map has get/set/delete too
  const seen = new Map();
  seen.set("ghost.map-key", 1);
  seen.get("ghost.map-key");
  seen.delete("ghost.map-key");
  return scheduler.jobs.length + seen.size + (apns.sandbox ? 1 : 0);
}

// ---------------------------------------------------------------------------------------------
// Update check, with the HTTP clients of Node and of Electron.

function checkForUpdate() {
  https
    .get("https://updates.chat.example/desktop/latest.json", (res) => {
      res.resume();
      const report = net.request({
        method: "POST",
        url: "https://updates.chat.example/desktop/report",
      });
      report.end(JSON.stringify({ status: res.statusCode, checks: notIpc() }));
    })
    .on("error", () => {});
}

// app events, not channels
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.whenReady().then(() => {
  registerIpc();
  mainWindow = openMainWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = openMainWindow();
  });
  checkForUpdate();
});
