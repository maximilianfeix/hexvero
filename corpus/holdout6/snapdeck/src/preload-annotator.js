"use strict";
// Not sandboxed (see main/windows.js): this preload reads captures from disk.
const fs = require("node:fs");
const { contextBridge, ipcRenderer } = require("electron");
const { Channels } = require("./shared/channels");

/** A subscribe function for a main-to-page channel; calling it returns an unsubscribe. */
function listen(channel) {
  return (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  };
}

/** Invokes a handleSafe handler and turns { ok: false } back into a thrown error. */
async function request(channel, ...args) {
  const reply = await ipcRenderer.invoke(channel, ...args);
  if (!reply.ok) throw new Error(reply.error);
  return reply.value;
}

contextBridge.exposeInMainWorld("annotator", {
  // Any path the page passes is read; the page only passes shot.file from shot:loaded.
  loadImage: (file) => fs.promises.readFile(file),
  saveShot: (shot) => request(Channels.SHOT_SAVE, shot),
  shareShot: (id) => request(Channels.SHOT_SHARE, id),
  getPrefs: () => ipcRenderer.invoke(Channels.PREFS_GET),
  setDirty: (dirty) => ipcRenderer.send(Channels.ANNOTATOR_DIRTY, dirty),
  onShotLoaded: listen(Channels.SHOT_LOADED),
  onMenuCommand: listen(Channels.MENU_COMMAND),
});
