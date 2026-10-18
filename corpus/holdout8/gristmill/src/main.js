"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
const ipc_1 = require("./main/ipc");
const menu_1 = require("./main/menu");
const sync_engine_1 = require("./main/sync/sync-engine");
const updates_1 = require("./main/updates");
const windows_1 = require("./main/windows");
if (!electron_1.app.requestSingleInstanceLock()) {
    electron_1.app.quit();
}
electron_1.app.on("second-instance", () => {
    const win = (0, windows_1.getMainWindow)();
    if (win) {
        if (win.isMinimized())
            win.restore();
        win.focus();
    }
});
electron_1.app.whenReady().then(() => {
    (0, ipc_1.registerIpcHandlers)();
    (0, menu_1.buildMenu)();
    (0, windows_1.createMainWindow)();
    if (electron_1.app.isPackaged) {
        (0, updates_1.checkForUpdates)(windows_1.getMainWindow);
    }
    void sync_engine_1.syncEngine.run();
});
electron_1.app.on("window-all-closed", () => {
    if (process.platform !== "darwin")
        electron_1.app.quit();
});
electron_1.app.on("activate", () => {
    if (!(0, windows_1.getMainWindow)())
        (0, windows_1.createMainWindow)();
});
