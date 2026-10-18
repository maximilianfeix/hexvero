"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerSyncHandlers = void 0;
const electron_1 = require("electron");
const channels_1 = require("../../common/channels");
const sync_engine_1 = require("../sync/sync-engine");
const registerSyncHandlers = () => {
    electron_1.ipcMain.handle(channels_1.IPC_CHANNELS.SYNC_SIGN_IN, (_event, { email, password }) => sync_engine_1.syncEngine.signIn(email, password));
    electron_1.ipcMain.on(channels_1.IPC_CHANNELS.SYNC_SIGN_OUT, () => sync_engine_1.syncEngine.signOut());
    electron_1.ipcMain.handle(channels_1.IPC_CHANNELS.SYNC_NOW, () => sync_engine_1.syncEngine.run());
    // Raised by the application menu (menu.ts) through ipcMain.emit.
    electron_1.ipcMain.on("menu:sync-now", () => {
        void sync_engine_1.syncEngine.run();
    });
};
exports.registerSyncHandlers = registerSyncHandlers;
