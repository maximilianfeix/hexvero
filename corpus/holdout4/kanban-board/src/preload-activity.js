"use strict";
// Preload of the activity feed view. It is sandboxed and may require "electron" only, so the
// channel names are written out here instead of coming from ./lib/channels.js.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("feed", {
  onPush(listener) {
    const wrapped = (_event, entry) => listener(entry);
    ipcRenderer.on("activity:push", wrapped);
    return () => ipcRenderer.off("activity:push", wrapped);
  },
  clear: () => ipcRenderer.send("activity:clear"),
  locale: navigator.language,
});
