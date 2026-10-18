"use strict";
// Compiled from src/preload/ipc-client.ts: a typed client around ipcRenderer.
Object.defineProperty(exports, "__esModule", { value: true });
exports.IpcClient = void 0;
const electron_1 = require("electron");
class IpcClient {
    constructor(label) {
        this.label = label;
    }
    /** Request and response; rejects with the main process's message. */
    invoke(channel, payload) {
        const pending = electron_1.ipcRenderer?.invoke(channel, payload);
        if (!pending)
            return Promise.reject(new Error(`${this.label}: no IPC in this context`));
        return pending;
    }
    /** Fire and forget. */
    send(channel, payload) {
        electron_1.ipcRenderer?.send(channel, payload);
    }
    /** Listens for pushes from the main process; returns the unsubscribe function. */
    subscribe(channel, listener) {
        const wrapped = (_event, data) => listener(data);
        electron_1.ipcRenderer.on(channel, wrapped);
        return () => electron_1.ipcRenderer.removeListener(channel, wrapped);
    }
}
exports.IpcClient = IpcClient;
