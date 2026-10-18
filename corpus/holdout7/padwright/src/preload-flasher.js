"use strict";
// Compiled from src/preload-flasher.ts. Sandboxed: only "electron" can be required here, so the
// channel names are written out.
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
electron_1.contextBridge.exposeInMainWorld("flasher", {
    start: (deviceId, model, version) => electron_1.ipcRenderer.invoke("flash:start", { deviceId, model, version }),
    cancel: (deviceId) => electron_1.ipcRenderer.send("flash:cancel", deviceId),
    onProgress: (listener) => {
        electron_1.ipcRenderer.on("flash:progress", (_event, progress) => listener(progress));
    },
});
