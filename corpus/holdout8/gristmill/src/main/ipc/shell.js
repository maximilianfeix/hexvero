"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerShellHandlers = void 0;
const electron_1 = require("electron");
const EXTERNAL_PROTOCOLS = ["http:", "https:", "mailto:"];
const isSafeExternalUrl = (url) => {
    if (typeof url !== "string")
        return false;
    try {
        return EXTERNAL_PROTOCOLS.includes(new URL(url).protocol);
    }
    catch {
        return false;
    }
};
const registerShellHandlers = () => {
    electron_1.ipcMain.handle("gm::shell::open-external", async (_event, url) => {
        if (!isSafeExternalUrl(url)) {
            console.warn("[shell] blocked url", url);
            return false;
        }
        await electron_1.shell.openExternal(url);
        return true;
    });
    electron_1.ipcMain.on("gm::shell::show-item", (_event, fullPath) => {
        electron_1.shell.showItemInFolder(fullPath);
    });
    electron_1.ipcMain.on("gm::clipboard::write-text", (_event, text) => {
        electron_1.clipboard.writeText(String(text));
    });
};
exports.registerShellHandlers = registerShellHandlers;
