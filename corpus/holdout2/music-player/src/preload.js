"use strict";
// Preload script of every Cadence window (main window, mini player, about box).
// Compiled by tsc from src/preload.ts (module: commonjs, target: es2022).
// MIT licensed, written for this corpus.
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
const ipc_1 = require("./shared/ipc");
const time_1 = require("./shared/time");
// Each part of the API is written as its own object and the parts are merged below.
const libraryApi = {
    getTracks: () => electron_1.ipcRenderer.invoke("library:get-tracks"),
    addFolder: () => electron_1.ipcRenderer.invoke("library:add-folder"),
    onScanProgress: (listener) => {
        const wrapped = (_event, progress) => listener(progress);
        electron_1.ipcRenderer.on("library:scan-progress", wrapped);
        return () => {
            electron_1.ipcRenderer.removeListener("library:scan-progress", wrapped);
        };
    },
    listPlaylists: () => electron_1.ipcRenderer.invoke(ipc_1.Channels.PlaylistsList),
    savePlaylist: (playlist) => electron_1.ipcRenderer.invoke(ipc_1.Channels.PlaylistsSave, playlist),
    exportPlaylist: (playlistId) => electron_1.ipcRenderer.invoke("playlists:export", playlistId),
};
const playerApi = {
    reportState: (state) => electron_1.ipcRenderer.send(ipc_1.PLAYER_STATE_CHANGED, state),
    onMediaKey: (listener) => {
        electron_1.ipcRenderer.on("media:key", (_event, action) => listener(action));
    },
    onCommand: (listener) => {
        electron_1.ipcRenderer.on("player:command", (_event, command) => listener(command));
    },
    fetchLyrics: (artist, title) => electron_1.ipcRenderer.invoke("lyrics:fetch", artist, title),
    toggleMiniPlayer: () => electron_1.ipcRenderer.send("mini:toggle"),
};
const settingsApi = {
    getSettings: () => electron_1.ipcRenderer.invoke(ipc_1.Channels.SettingsGet),
    updateSettings: (patch) => electron_1.ipcRenderer.invoke(ipc_1.Channels.SettingsSet, patch),
    onSettingsChanged: (listener) => {
        electron_1.ipcRenderer.on(ipc_1.Channels.SettingsChanged, (_event, settings) => listener(settings));
    },
};
const windowApi = {
    minimize: () => electron_1.ipcRenderer.send("window:minimize"),
    toggleMaximize: () => electron_1.ipcRenderer.send("window:toggle-maximize"),
    getVersion: () => electron_1.ipcRenderer.invoke("app:get-version"),
};
const api = {
    ...libraryApi,
    ...playerApi,
    ...settingsApi,
    ...windowApi,
    platform: process.platform,
    formatTime: time_1.formatTime,
};
electron_1.contextBridge.exposeInMainWorld("cadence", api);
// The mini player only needs the state, the artwork and a way to send commands back.
electron_1.contextBridge.exposeInMainWorld("mini", {
    onState: (listener) => {
        electron_1.ipcRenderer.on(ipc_1.PLAYER_STATE, (_event, state) => listener(state));
    },
    getArtwork: (trackId) => electron_1.ipcRenderer.invoke(ipc_1.MINI_ARTWORK, trackId),
    send: (command) => electron_1.ipcRenderer.send("mini:command", command),
});
// Development builds used to expose a reload hook; it was removed before 3.0.
// electron_1.contextBridge.exposeInMainWorld("devtools", { reload: () => electron_1.ipcRenderer.send("dev:reload") });
