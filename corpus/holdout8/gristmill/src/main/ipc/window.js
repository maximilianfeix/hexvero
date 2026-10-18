"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerWindowHandlers = void 0;
const electron_1 = require("electron");
const channels_1 = require("../../common/channels");
const windows_1 = require("../windows");
const fromEvent = (event) => electron_1.BrowserWindow.fromWebContents(event.sender);
// Title bar buttons of the frameless windows on Windows and Linux.
const registerWindowHandlers = () => {
    electron_1.ipcMain.on("gm::win::minimize", (event) => fromEvent(event)?.minimize());
    electron_1.ipcMain.on("gm::win::toggle-maximize", (event) => {
        const win = fromEvent(event);
        if (!win)
            return;
        if (win.isMaximized())
            win.unmaximize();
        else
            win.maximize();
    });
    electron_1.ipcMain.on("gm::win::close", (event) => fromEvent(event)?.close());
    electron_1.ipcMain.handle("gm::win::is-maximized", (event) => fromEvent(event)?.isMaximized() ?? false);
    electron_1.ipcMain.on(channels_1.IPC_CHANNELS.SETTINGS_OPEN, () => (0, windows_1.openSettings)());
};
exports.registerWindowHandlers = registerWindowHandlers;
