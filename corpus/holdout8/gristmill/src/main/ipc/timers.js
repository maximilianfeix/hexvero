"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerTimerHandlers = exports.TimerService = void 0;
const electron_1 = require("electron");
const channels_1 = require("../../common/channels");
const messages_1 = require("../../common/messages");
class TimerService {
    constructor() {
        this.timers = new Map();
        this.nextId = 1;
    }
    start(target, label, seconds) {
        const id = this.nextId++;
        const endsAt = Date.now() + seconds * 1000;
        const handle = setInterval(() => {
            if (target.isDestroyed()) {
                this.cancel(id);
                return;
            }
            const remaining = Math.max(0, Math.round((endsAt - Date.now()) / 1000));
            target.webContents.send(messages_1.MessageToWebApp.TimerTick, { id, remaining });
            if (remaining === 0) {
                this.cancel(id);
                this.finish(target, id, label);
            }
        }, 1000);
        this.timers.set(id, handle);
        return id;
    }
    finish(target, id, label) {
        new electron_1.Notification({ title: "Timer done", body: label }).show();
        target.webContents.send(messages_1.MessageToWebApp.TimerDone, { id, label });
    }
    cancel(id) {
        clearInterval(this.timers.get(id));
        this.timers.delete(id);
    }
}
exports.TimerService = TimerService;
const timers = new TimerService();
const registerTimerHandlers = () => {
    electron_1.ipcMain.handle(channels_1.IPC_CHANNELS.TIMER_START, (event, { label, seconds }) => {
        const target = electron_1.BrowserWindow.fromWebContents(event.sender);
        if (!target)
            throw new Error("Timers need a window");
        return timers.start(target, label, seconds);
    });
    electron_1.ipcMain.on(channels_1.IPC_CHANNELS.TIMER_CANCEL, (_event, id) => timers.cancel(id));
};
exports.registerTimerHandlers = registerTimerHandlers;
