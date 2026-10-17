"use strict";
// Compiled from src/main/windows.ts.
Object.defineProperty(exports, "__esModule", { value: true });
exports.windows = void 0;
const path = require("node:path");
const electron_1 = require("electron");
const SECURE_DEFAULTS = Object.freeze({
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
});
function appFile(name) {
    return path.join(electron_1.app.getAppPath(), name);
}
/** Window preferences: the secure defaults, the preload, then whatever the window needs. */
function prefsFor(preloadName, overrides = {}) {
    return { ...SECURE_DEFAULTS, preload: appFile(preloadName), ...overrides };
}
let mainWindow = null;
let flasherWindow = null;
let diagnosticsWindow = null;
function createMainWindow() {
    const options = {
        width: 1180,
        height: 760,
        minWidth: 900,
        title: "Padwright",
        show: false,
        // preload.js requires its client and the channel contract, so it cannot run sandboxed.
        webPreferences: prefsFor("preload.js", { sandbox: false }),
    };
    mainWindow = new electron_1.BrowserWindow(options);
    mainWindow.once("ready-to-show", () => mainWindow?.show());
    mainWindow.on("closed", () => (mainWindow = null));
    void mainWindow.loadFile("index.html");
    return mainWindow;
}
function openFlasher(deviceId) {
    if (flasherWindow) {
        flasherWindow.focus();
        return flasherWindow;
    }
    const flasherPrefs = prefsFor("preload-flasher.js");
    flasherWindow = new electron_1.BrowserWindow({
        parent: mainWindow ?? undefined,
        modal: true,
        width: 520,
        height: 360,
        resizable: false,
        webPreferences: flasherPrefs,
    });
    flasherWindow.on("closed", () => (flasherWindow = null));
    void flasherWindow.loadFile("flasher.html", { query: { device: deviceId } });
    return flasherWindow;
}
function openDiagnostics() {
    // The 1.x diagnostics console still calls window.require("electron") from its page.
    const legacyPrefs = { nodeIntegration: true, contextIsolation: false };
    diagnosticsWindow = new electron_1.BrowserWindow({ width: 820, height: 600, webPreferences: legacyPrefs });
    diagnosticsWindow.on("closed", () => (diagnosticsWindow = null));
    void diagnosticsWindow.loadFile("diagnostics.html");
    return diagnosticsWindow;
}
exports.windows = {
    createMainWindow,
    openFlasher,
    openDiagnostics,
    get main() {
        return mainWindow;
    },
    get flasher() {
        return flasherWindow;
    },
};
