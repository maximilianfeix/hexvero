"use strict";
// Preload of the library window. It runs outside the sandbox because it requires the shared
// channel module; the window keeps context isolation on.

const { contextBridge, ipcRenderer } = require("electron");
const {
  Library,
  Episodes,
  DOWNLOAD_PREFIX,
  Downloads,
  Playback,
  Settings,
  App,
} = require("./shared/channels");

// Turns a channel into a function that invokes it with whatever arguments it gets.
const call = (ch) => (...a) => ipcRenderer.invoke(ch, ...a);

// Subscribes a listener without handing it the event, and returns a function that unsubscribes.
function listen(channel, listener) {
  const wrapped = (_event, ...args) => listener(...args);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

// The names of the channels the main process picks at start (see `topics` in main.js).
const topics = ipcRenderer.sendSync(App.TOPICS);

const api = {
  platform: process.platform,
  formatDuration(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = String(Math.floor(seconds % 60)).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
  },
  listShows: call(Library.LIST),
  subscribe: call(Library.SUBSCRIBE),
  unsubscribe: call(Library.UNSUBSCRIBE),
  refreshAll: call(Library.REFRESH),
  onLibraryChanged: (listener) => listen(Library.CHANGED, listener),
  getSetting: call(Settings.GET),
  setSetting: call(Settings.SET),
  onAlert: (listener) => listen(topics.alerts, listener),
  openHelp: () => ipcRenderer.send("help:open"),
  onMenuCommand: (listener) => listen(App.MENU, listener),
};

const episodesApi = {
  listEpisodes: call(Episodes.LIST),
  markPlayed: call(Episodes.MARK_PLAYED),
  download: call(Downloads.START),
  cancelDownload: call(`${DOWNLOAD_PREFIX}cancel`),
  onDownloadProgress: (listener) => listen(Downloads.PROGRESS, listener),
  play: (episode) => ipcRenderer.send(Playback.PLAY, episode),
  onPlaybackState: (listener) => listen(Playback.STATE, listener),
};

contextBridge.exposeInMainWorld("driftwood", Object.assign(api, episodesApi));
