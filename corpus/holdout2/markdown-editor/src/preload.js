// Preload script of the editor, the preview pane and the settings window.
// MIT licensed, written for this corpus.
"use strict";

const { contextBridge, ipcRenderer } = require("electron");
const channels = require("./ipc/channels");

/** Subscribes to a push from the main process; returns the function that unsubscribes. */
function on(channel, listener) {
  const wrapped = (_event, ...args) => listener(...args);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

// The vault's request/response calls: member name -> channel.
const vaultInvokers = {
  listNotes: "vault:list",
  searchNotes: "vault:search",
};

const vault = Object.fromEntries(
  Object.entries(vaultInvokers).map(([member, channel]) => [
    member,
    (...args) => ipcRenderer.invoke(channel, ...args),
  ]),
);

const api = {
  ...vault,
  revealNote: (notePath) => ipcRenderer.send("vault:reveal", notePath),

  openFile: () => ipcRenderer.invoke("file:open"),
  saveFile: (filePath, content) => ipcRenderer.invoke("file:save", filePath, content),
  saveFileAs: (content) => ipcRenderer.invoke("file:save-as", content),
  onFileOpened: (listener) => on("file:opened", listener),

  setTitle: (title) => ipcRenderer.send("app:set-title", title),
  setDirty: (value) => ipcRenderer.send("editor:dirty", value),
  updatePreview: (markdown) => ipcRenderer.send("preview:update", markdown),
  onScrollTo: (listener) => on("editor:scroll-to", listener),
  onMenuAction: (listener) => on("menu:action", listener),
  onConfirmClose(listener) {
    ipcRenderer.on("app:confirm-close", () => listener());
  },
  confirmClose: () => ipcRenderer.send("app:close-confirmed"),

  openSettings: () => ipcRenderer.send("settings:open"),
  getSettings: () => ipcRenderer.invoke(channels.settings.get),
  setSetting: (key, value) => ipcRenderer.invoke(channels.settings.set, key, value),
  onSettingsChanged: (listener) => on(channels.settings.changed, listener),
};

const previewApi = {
  onRender: (listener) => on("preview:render", listener),
  reportScroll: (ratio) => ipcRenderer.send("preview:scroll", ratio),
};

const pluginsApi = {
  list: () => ipcRenderer.invoke("plugins:list"),
  invoke: (pluginId, method, ...args) => ipcRenderer.invoke("plugin:invoke", pluginId, method, ...args),
  // One channel per plug-in; the id is only known when the plug-in is loaded.
  onEvent: (pluginId, listener) => on(`plugin:${pluginId}:event`, listener),
};

// Without context isolation the page shares this script's world, so the APIs are plain globals.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld("inkwell", api);
    contextBridge.exposeInMainWorld("preview", previewApi);
    contextBridge.exposeInMainWorld("plugins", pluginsApi);
  } catch (error) {
    console.error(error);
  }
} else {
  window.inkwell = api;
  window.preview = previewApi;
  window.plugins = pluginsApi;
}
