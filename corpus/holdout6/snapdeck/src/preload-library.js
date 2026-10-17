"use strict";
// Runs sandboxed: only "electron" can be required, so the channel names are written out.
// They must match shared/channels.js.
const { contextBridge, ipcRenderer } = require("electron");

// Request/response calls, member name -> channel.
const INVOKE = {
  listShots: "library:list",
  deleteShot: "library:delete",
  openShot: "shot:open",
  getPrefs: "prefs:get",
  setPrefs: "prefs:set",
};

function invokers(table) {
  return Object.fromEntries(
    Object.entries(table).map(([member, channel]) => [member, (...args) => ipcRenderer.invoke(channel, ...args)]),
  );
}

const api = {
  platform: process.platform,
  ...invokers(INVOKE),
  revealShot: (id) => ipcRenderer.send("library:reveal", id),
  startCapture: () => ipcRenderer.send("capture:start"),
  appVersion: () => ipcRenderer.sendSync("app:version"),
  onMenuCommand(callback) {
    const listener = (_event, command) => callback(command);
    ipcRenderer.on("menu:command", listener);
    return () => ipcRenderer.removeListener("menu:command", listener);
  },
};

contextBridge.exposeInMainWorld("snapdeck", api);
