"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// Preload of the main window and the settings window. Not sandboxed: it requires ./common.
const electron_1 = require("electron");
const channels_1 = require("./common/channels");
const messages_1 = require("./common/messages");
const invoke = (channel, ...args) => electron_1.ipcRenderer.invoke(channel, ...args);
const send = (channel, ...args) => electron_1.ipcRenderer.send(channel, ...args);
const recipesAPI = {
    list: () => invoke(channels_1.IPC_CHANNELS.RECIPES_LIST),
    get: (id) => invoke(channels_1.IPC_CHANNELS.RECIPES_GET, id),
    save: (recipe) => invoke(channels_1.IPC_CHANNELS.RECIPES_SAVE, recipe),
    remove: (id) => invoke(channels_1.IPC_CHANNELS.RECIPES_DELETE, id),
    importFromUrl: (url) => invoke(channels_1.IPC_CHANNELS.RECIPES_IMPORT, { url }),
    exportPdf: (id) => invoke(channels_1.IPC_CHANNELS.RECIPES_EXPORT_PDF, { id }),
    addToShoppingList: (recipeId, servings) => invoke(channels_1.IPC_CHANNELS.SHOPPING_ADD, { recipeId, servings }),
};
const syncAPI = {
    signIn: (email, password) => invoke(channels_1.IPC_CHANNELS.SYNC_SIGN_IN, { email, password }),
    signOut: () => send(channels_1.IPC_CHANNELS.SYNC_SIGN_OUT),
    now: () => invoke(channels_1.IPC_CHANNELS.SYNC_NOW),
};
const timersAPI = {
    start: (label, seconds) => invoke(channels_1.IPC_CHANNELS.TIMER_START, { label, seconds }),
    cancel: (id) => send(channels_1.IPC_CHANNELS.TIMER_CANCEL, id),
};
const desktopAPI = {
    isMac: process.platform === "darwin",
    openExternal: (url) => invoke("gm::shell::open-external", url),
    showItemInFolder: (fullPath) => send("gm::shell::show-item", fullPath),
    copyText: (text) => send("gm::clipboard::write-text", text),
    minimize: () => send("gm::win::minimize"),
    toggleMaximize: () => send("gm::win::toggle-maximize"),
    close: () => send("gm::win::close"),
    isMaximized: () => invoke("gm::win::is-maximized"),
    openShoppingList: () => send(channels_1.IPC_CHANNELS.SHOPPING_OPEN),
    openSettings: () => send(channels_1.IPC_CHANNELS.SETTINGS_OPEN),
};
const settingsStoreAPI = {
    get: (key) => electron_1.ipcRenderer.sendSync(channels_1.IPC_CHANNELS.STORE_GET, key),
    set: (key, value) => send(channels_1.IPC_CHANNELS.STORE_SET, key, value),
};
try {
    electron_1.contextBridge.exposeInMainWorld("recipes", recipesAPI);
    electron_1.contextBridge.exposeInMainWorld("sync", syncAPI);
    electron_1.contextBridge.exposeInMainWorld("timers", timersAPI);
    electron_1.contextBridge.exposeInMainWorld("desktop", desktopAPI);
    electron_1.contextBridge.exposeInMainWorld("settingsStore", settingsStoreAPI);
}
catch (error) {
    console.error(error);
}
process.once("loaded", () => {
    const mainEvents = {
        setTimerTickHandler: (handler) => electron_1.ipcRenderer.on(messages_1.MessageToWebApp.TimerTick, handler),
        setTimerDoneHandler: (handler) => electron_1.ipcRenderer.on(messages_1.MessageToWebApp.TimerDone, handler),
        setSyncStatusHandler: (handler) => electron_1.ipcRenderer.on(messages_1.MessageToWebApp.SyncStatus, handler),
        setUpdateAvailableHandler: (handler) => electron_1.ipcRenderer.on(messages_1.MessageToWebApp.UpdateAvailable, handler),
        setSettingChangedHandler: (handler) => electron_1.ipcRenderer.on("setting-changed", handler),
    };
    electron_1.contextBridge.exposeInMainWorld("gristmillEvents", mainEvents);
});
window.addEventListener("DOMContentLoaded", () => {
    send("app-window:mounted");
});
