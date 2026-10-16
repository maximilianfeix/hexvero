"use strict";
// Sandboxed: only "electron" can be required here, so the channel names are written out.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("preview", {
  onRender: (listener) => ipcRenderer.on("preview:render", (_event, html) => listener(html)),
  ping: () => ipcRenderer.send("preview:ping"),
  onPong: (listener) => ipcRenderer.once("preview:pong", (_event, info) => listener(info)),
});
