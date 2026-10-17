"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("overlay", {
  select: (rect) => ipcRenderer.send("overlay:select", rect),
  cancel: () => ipcRenderer.send("overlay:cancel"),
  onFrame: (callback) => ipcRenderer.on("overlay:frame", (_event, frame) => callback(frame)),
});
