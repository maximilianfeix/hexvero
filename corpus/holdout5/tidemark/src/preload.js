"use strict";
const { contextBridge, ipcRenderer } = require("electron");
const { CHANNELS, exportChannel } = require("./shared/channels");

// Every router handler answers { ok, value } or { ok, error } (main/ipc-router.js); unwrap it.
const call =
  (channel) =>
  async (...args) => {
    const reply = await ipcRenderer.invoke(channel, ...args);
    if (!reply.ok) throw new Error(reply.error);
    return reply.value;
  };

const api = {
  platform: process.platform,
  listReleases: call(CHANNELS.RELEASES_LIST),
  loadRelease: call(CHANNELS.RELEASE_LOAD),
  saveRelease: call(CHANNELS.RELEASE_SAVE),
  deleteRelease: call(CHANNELS.RELEASE_DELETE),
  getSettings: call(CHANNELS.SETTINGS_GET),
  setSettings: call(CHANNELS.SETTINGS_SET),
  exportMarkdown: call(exportChannel("markdown")),
  exportHtml: call(exportChannel("html")),
  publish: call(CHANNELS.PUBLISH_START),
  onPublishProgress: (listener) => {
    const wrapped = (_event, progress) => listener(progress);
    ipcRenderer.on(CHANNELS.PUBLISH_PROGRESS, wrapped);
    return () => ipcRenderer.removeListener(CHANNELS.PUBLISH_PROGRESS, wrapped);
  },
  markDirty: (dirty) => ipcRenderer.send(CHANNELS.EDITOR_DIRTY, Boolean(dirty)),
  openPreview: () => ipcRenderer.send(CHANNELS.PREVIEW_OPEN),
  updatePreview: (release) => ipcRenderer.send(CHANNELS.PREVIEW_UPDATE, release),
  appInfo: () => ipcRenderer.invoke("app:info"),
  sendDiagnostics: (report) => {
    // Set only in support builds; the channel name comes with the environment.
    const channel = process.env.TIDEMARK_DIAG_CHANNEL;
    if (channel) ipcRenderer.send(channel, report);
  },
};

contextBridge.exposeInMainWorld("tidemark", api);
