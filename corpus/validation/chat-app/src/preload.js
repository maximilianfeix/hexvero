// Preload script of the main window.
// MIT licensed, written for this corpus.
"use strict";

const { contextBridge, ipcRenderer } = require("electron");
const CHANNELS = require("./ipc-names");

/** Makes a function that sends a request on one channel. */
const call =
  (channel) =>
  (...args) =>
    ipcRenderer.invoke(channel, ...args);

/** ipcRenderer.send under another name. */
const emit = ipcRenderer.send.bind(ipcRenderer);

contextBridge.exposeInMainWorld("chat", {
  sendMessage: call(CHANNELS.SEND_MESSAGE),
  listRooms: call("rooms:list"),
  history: (room, before) => ipcRenderer.invoke(CHANNELS.HISTORY, room, before),
  join: (room) => ipcRenderer.invoke("rooms:join", room),
  leave: (room) => ipcRenderer.invoke("rooms:leave", room),
  typing: (room) => emit(CHANNELS.TYPING, room),
  onIncoming(listener) {
    const wrapped = (_event, message) => listener(message);
    ipcRenderer.on("chat:incoming", wrapped);
    return () => ipcRenderer.removeListener("chat:incoming", wrapped);
  },
  openSettings: () => ipcRenderer.send("settings:open"),
  // exposed, talk to no channel
  platform: process.platform,
  formatTime: (ms) => new Date(ms).toLocaleTimeString(),
});

// The second API: its name is a constant and the object is put together in steps.
const SESSION_API = "session";
const sessionApi = {
  bootstrap: () => ipcRenderer.invoke("auth:bootstrap"),
  signOut() {
    return ipcRenderer.invoke("auth:sign-out");
  },
};
sessionApi.onPresence = (listener) =>
  ipcRenderer.on("presence:update", (_event, presence) => listener(presence));
contextBridge.exposeInMainWorld(SESSION_API, sessionApi);

// An API that was removed; the line is kept for reference.
// contextBridge.exposeInMainWorld("debug", { dump: () => ipcRenderer.invoke("ghost:debug-dump") });

// Not part of any exposed API.
window.addEventListener("DOMContentLoaded", () => {
  ipcRenderer.send("app:renderer-ready");
  // nobody in the main process listens for this one
  emit("telemetry:hit", { view: "main" });
});

// Not IPC: a message port and a DOM event target have send/on-like methods too.
// ipcRenderer.send("ghost:preload-comment");
const channel = new MessageChannel();
channel.port1.postMessage("ghost:port-message");
window.addEventListener("ghost:dom-event", () => {});
