"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppWindow = void 0;
const electron_1 = require("electron");
const path_1 = __importDefault(require("path"));
// Sent by a preload once its page has loaded (preload.ts, preload-shopping.js).
const MOUNTED = "app-window:mounted";
// TODO: move the main window to AppWindow as well (windows.ts still builds it by hand).
class AppWindow {
    constructor(props) {
        this.cleanup = () => {
            AppWindow.windows.delete(this.id);
        };
        const { route, ...rest } = props;
        this.browserWindow = new electron_1.BrowserWindow({
            ...rest,
            webPreferences: {
                contextIsolation: true,
                nodeIntegration: false,
                ...rest.webPreferences,
            },
            show: false,
        });
        this.id = this.browserWindow.id;
        AppWindow.windows.set(this.id, this);
        this.browserWindow.webContents.ipc.once(MOUNTED, () => {
            this.browserWindow.show();
        });
        this.browserWindow.on("closed", this.cleanup);
        void this.browserWindow.loadFile(path_1.default.join(electron_1.app.getAppPath(), route));
    }
    static fromId(id) {
        return AppWindow.windows.get(id);
    }
    static getAll() {
        return [...AppWindow.windows.values()];
    }
    get webContents() {
        return this.browserWindow.webContents;
    }
    focus() {
        if (this.browserWindow.isMinimized())
            this.browserWindow.restore();
        this.browserWindow.focus();
    }
}
exports.AppWindow = AppWindow;
AppWindow.windows = new Map();
