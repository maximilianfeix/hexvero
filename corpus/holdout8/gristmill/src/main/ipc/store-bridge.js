"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerStoreBridge = void 0;
const electron_1 = require("electron");
const channels_1 = require("../../common/channels");
const store_1 = require("../store");
// Renderers read and write a few preferences synchronously through here
// (window.settingsStore in preload.ts).
const registerStoreBridge = () => {
    electron_1.ipcMain.on(channels_1.IPC_CHANNELS.STORE_GET, (event, key) => {
        if (!(0, store_1.isRendererStoreKey)(key)) {
            console.warn("[store-bridge] blocked read of key", key);
            event.returnValue = undefined;
            return;
        }
        event.returnValue = store_1.store.get(key);
    });
    electron_1.ipcMain.on(channels_1.IPC_CHANNELS.STORE_SET, (event, key, value) => {
        if (!(0, store_1.isRendererStoreKey)(key)) {
            console.warn("[store-bridge] blocked write to key", key);
            return;
        }
        store_1.store.set(key, value);
        // Every other window follows the change (the settings window sets the theme).
        for (const win of electron_1.BrowserWindow.getAllWindows()) {
            if (win.webContents.id !== event.sender.id) {
                win.webContents.send("setting-changed", key, value);
            }
        }
    });
};
exports.registerStoreBridge = registerStoreBridge;
