"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getShoppingWindow = exports.getMainWindow = exports.openShoppingList = exports.openSettings = exports.createMainWindow = void 0;
const electron_1 = require("electron");
const path_1 = __importDefault(require("path"));
const app_window_1 = require("./app-window");
const config_1 = require("./config");
const store_1 = require("./store");
let mainWindow = null;
let settingsWindow = null;
let shoppingWindow = null;
const backgroundFor = (theme) => {
    const dark = theme === "dark" || (theme === "system" && electron_1.nativeTheme.shouldUseDarkColors);
    return dark ? "#1d1b19" : "#faf7f2";
};
const createMainWindow = () => {
    const winOptions = Object.assign({}, config_1.mainWinOptions);
    const bounds = store_1.store.get("window.bounds");
    if (bounds) {
        Object.assign(winOptions, bounds);
    }
    winOptions.backgroundColor = backgroundFor(store_1.store.get("ui.theme"));
    mainWindow = new electron_1.BrowserWindow(winOptions);
    mainWindow.once("ready-to-show", () => mainWindow?.show());
    mainWindow.on("close", () => {
        if (mainWindow)
            store_1.store.set("window.bounds", mainWindow.getBounds());
    });
    mainWindow.on("closed", () => {
        mainWindow = null;
    });
    void mainWindow.loadFile(path_1.default.join(electron_1.app.getAppPath(), "index.html"));
    return mainWindow;
};
exports.createMainWindow = createMainWindow;
const openSettings = () => {
    if (settingsWindow) {
        settingsWindow.focus();
        return;
    }
    settingsWindow = new app_window_1.AppWindow({
        route: "settings.html",
        title: "Preferences",
        width: 640,
        height: 540,
        resizable: false,
        minimizable: false,
        parent: mainWindow ?? undefined,
        webPreferences: {
            preload: path_1.default.join(__dirname, "..", "preload.js"),
        },
    });
    settingsWindow.browserWindow.on("closed", () => {
        settingsWindow = null;
    });
};
exports.openSettings = openSettings;
const openShoppingList = () => {
    if (shoppingWindow) {
        shoppingWindow.focus();
        return;
    }
    shoppingWindow = new app_window_1.AppWindow({
        route: "shopping.html",
        title: "Shopping list",
        width: 360,
        height: 600,
        alwaysOnTop: true,
        webPreferences: {
            preload: path_1.default.join(electron_1.app.getAppPath(), "preload-shopping.js"),
            sandbox: true,
        },
    });
    shoppingWindow.browserWindow.on("closed", () => {
        shoppingWindow = null;
    });
};
exports.openShoppingList = openShoppingList;
const getMainWindow = () => mainWindow;
exports.getMainWindow = getMainWindow;
const getShoppingWindow = () => shoppingWindow?.browserWindow ?? null;
exports.getShoppingWindow = getShoppingWindow;
