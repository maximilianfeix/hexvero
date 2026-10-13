// Preload script, shared by all three windows.
// MIT licensed, written for this corpus.
"use strict";

const { contextBridge, ipcRenderer } = require("electron");
const { Channel, ConfigSync, Push, TIMER_PREFIX } = require("./ipc");
const { formatDuration } = require("./lib/format");

/** Like invoke, but gives up after `timeoutMs`. */
function request(timeoutMs, channel, ...args) {
  return Promise.race([
    ipcRenderer.invoke(channel, ...args),
    new Promise((_resolve, reject) =>
      setTimeout(() => reject(new Error(`${channel} timed out`)), timeoutMs),
    ),
  ]);
}

/** All project operations share one naming scheme. */
const project =
  (operation) =>
  (...args) =>
    ipcRenderer.invoke(`projects:${operation}`, ...args);

const trackerApi = {
  startTimer: (projectId) => ipcRenderer.invoke(Channel.TimerStart, projectId),
  stopTimer() {
    return ipcRenderer.invoke(Channel.TimerStop);
  },
  onTick(listener) {
    const wrapped = (_event, tick) => listener(tick);
    ipcRenderer.on(`${TIMER_PREFIX}tick`, wrapped);
    return () => ipcRenderer.off(`${TIMER_PREFIX}tick`, wrapped);
  },

  listProjects: project("list"),
  createProject: project("create"),
  renameProject: project("rename"),

  createInvoice: (draft) => request(8000, "invoice:create", draft),
  exportInvoice: (invoiceId) => ipcRenderer.send(Channel.InvoiceExport, invoiceId),
  onceExported: (listener) =>
    ipcRenderer.once("invoice:exported", (_event, result) => listener(result)),

  startSync: () => ipcRenderer.send("sync:start"),
  cancelSync: () => ipcRenderer.invoke("sync:cancel"),
  onSyncProgress: (listener) =>
    ipcRenderer.on(Channel.SyncProgress, (_event, progress) => listener(progress)),

  setting: (name) => ipcRenderer.sendSync(ConfigSync, name),
  activate: (key) => ipcRenderer.invoke("license:activate", key),
  onNewEntry: (listener) => ipcRenderer.on(Push.MenuNewEntry, () => listener()),
  onUpdateReady: (listener) =>
    ipcRenderer.addListener(Push.UpdateReady, (_event, info) => listener(info)),

  // Exposed, but none of these talks to the main process.
  formatDuration,
  copy: (text) => navigator.clipboard.writeText(text),
  runtime: {
    sandbox: process.sandboxed === true,
    contextIsolation: process.contextIsolated === true,
    platform: process.platform,
  },
};

// The dock badge exists on macOS only.
if (process.platform === "darwin")
  trackerApi.setBadge = (count) => ipcRenderer.send("dock:badge", count);

contextBridge.exposeInMainWorld("tracker", trackerApi);

// The widget's API is described by one object: its name in the page and its members.
const widgetBridge = {
  key: "widget",
  api: {
    pin: (pinned) => ipcRenderer.send("widget:pin", pinned),
    close: () => ipcRenderer.send("widget:close"),
    connect(onMessage) {
      const { port1, port2 } = new MessageChannel();
      port1.onmessage = (event) => onMessage(event.data);
      ipcRenderer.postMessage("widget:port", null, [port2]);
      port1.postMessage({ type: "ghost:port-hello" });
    },
  },
};
contextBridge.exposeInMainWorld(widgetBridge.key, widgetBridge.api);

// Removed in 4.0, kept for reference.
// contextBridge.exposeInMainWorld("debug", {
//   reload: () => ipcRenderer.send("ghost:debug-reload"),
// });

// The main process hands the widget a port. It goes on to the page as a window message;
// "timer-port" is the text of that message, not a channel.
ipcRenderer.on("timer:port", (event) => {
  window.postMessage("timer-port", "*", event.ports);
});

window.addEventListener("DOMContentLoaded", () => {
  window.dispatchEvent(new CustomEvent("ghost:bridge-ready"));
  requestAnimationFrame(() => ipcRenderer.send("app:first-paint"));
});
