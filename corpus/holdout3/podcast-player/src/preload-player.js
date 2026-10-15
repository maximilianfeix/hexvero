"use strict";
// Preload of the mini player. The window runs in the sandbox, so this file requires nothing but
// electron and writes its channel names out.

const { contextBridge, ipcRenderer } = require("electron");

const call = (ch) => (...a) => ipcRenderer.invoke(ch, ...a);

contextBridge.exposeInMainWorld(
  "player",
  Object.freeze({
    toggle: () => ipcRenderer.send("playback:toggle"),
    seek: (position) => ipcRenderer.send("playback:seek", position),
    ready: () => ipcRenderer.send("player:hello"),
    close: () => ipcRenderer.send("player:close"),
    nowPlaying: call("player:now-playing"),
    artwork: call("player:artwork"),
    onState(listener) {
      const wrapped = (_event, state) => listener(state);
      ipcRenderer.on("playback:state", wrapped);
      return () => ipcRenderer.off("playback:state", wrapped);
    },
  }),
);
