"use strict";
// Main process of Cadence, a desktop music player.
// Compiled by tsc from src/main.ts (module: commonjs, target: es2022).
// MIT licensed, written for this corpus.
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_path_1 = __importDefault(require("node:path"));
const promises_1 = require("node:fs/promises");
const electron_1 = require("electron");
const electron_store_1 = __importDefault(require("electron-store"));
const ipc_1 = require("./shared/ipc");
const endpoints_1 = require("./shared/endpoints");
const time_1 = require("./shared/time");
const window_options_1 = require("./main/window-options");
const PRELOAD = node_path_1.default.join(__dirname, "preload.js");
const AUDIO_EXTENSIONS = new Set([".mp3", ".flac", ".ogg", ".m4a", ".wav", ".opus"]);
const log = (...args) => console.log("[cadence]", ...args);
// ---------------------------------------------------------------------------------------------
// Persistent configuration.
const store = new electron_store_1.default({
    name: "cadence-config",
    defaults: {
        "library.folders": [],
        preferences: { volume: 0.8, crossfade: 0, replayGain: true },
        playlists: [],
    },
});
let mainWindow = null;
let miniWindow = null;
let aboutWindow = null;
let tray = null;
let lastState = null;
const tracks = new Map();
// ---------------------------------------------------------------------------------------------
// Windows.
function createMainWindow() {
    const bounds = store.get("window.bounds", { width: 1280, height: 800 });
    const win = new electron_1.BrowserWindow({
        ...bounds,
        minWidth: 900,
        minHeight: 600,
        show: false,
        title: "Cadence",
        titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
        backgroundColor: "#121212",
        webPreferences: {
            preload: PRELOAD,
            contextIsolation: true,
            nodeIntegration: false,
            // Off since 2.x, when the visualizer needed Node in the preload script; not yet turned back on.
            sandbox: false,
        },
    });
    win.once("ready-to-show", () => win.show());
    win.on("close", () => store.set("window.bounds", win.getBounds()));
    win.on("closed", () => {
        mainWindow = null;
    });
    // Links in artist biographies open in the system browser.
    win.webContents.setWindowOpenHandler(({ url }) => {
        if (url.startsWith("https:"))
            void electron_1.shell.openExternal(url);
        return { action: "deny" };
    });
    void win.loadFile("index.html");
    return win;
}
function toggleMiniPlayer() {
    if (miniWindow && !miniWindow.isDestroyed()) {
        miniWindow.close();
        return false;
    }
    const win = new electron_1.BrowserWindow((0, window_options_1.windowOptions)({
        width: 340,
        height: 120,
        frame: false,
        resizable: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        webPreferences: { preload: PRELOAD, sandbox: false },
    }));
    // Registered on this window's own IPC: only the mini player can ask for artwork.
    win.webContents.ipc.handle(ipc_1.MINI_ARTWORK, async (_event, trackId) => {
        const track = tracks.get(trackId);
        if (!track?.artworkPath)
            return null;
        const image = electron_1.nativeImage.createFromPath(track.artworkPath);
        return image.isEmpty() ? null : image.resize({ width: 96 }).toDataURL();
    });
    win.once("ready-to-show", () => {
        win.showInactive();
        if (lastState)
            win.webContents.send(ipc_1.PLAYER_STATE, lastState);
    });
    win.on("closed", () => {
        miniWindow = null;
    });
    void win.loadFile("index.html", { hash: "mini" });
    miniWindow = win;
    return true;
}
function showAbout() {
    if (aboutWindow) {
        aboutWindow.focus();
        return;
    }
    aboutWindow = new electron_1.BrowserWindow((0, window_options_1.windowOptions)({
        width: 420,
        height: 320,
        resizable: false,
        minimizable: false,
        title: "About Cadence",
        parent: mainWindow ?? undefined,
        webPreferences: { preload: PRELOAD },
    }));
    aboutWindow.once("ready-to-show", () => aboutWindow?.show());
    aboutWindow.on("closed", () => {
        aboutWindow = null;
    });
    void aboutWindow.loadFile("index.html", { hash: "about" });
}
function buildMenu() {
    const template = [
        {
            label: "Cadence",
            submenu: [
                { label: "About Cadence", click: () => showAbout() },
                { type: "separator" },
                { role: "quit" },
            ],
        },
        {
            label: "Controls",
            submenu: [
                { label: "Play / Pause", accelerator: "Space", click: () => mainWindow?.webContents.send("player:command", "play-pause") },
                { label: "Mini Player", accelerator: "CmdOrCtrl+M", click: () => toggleMiniPlayer() },
            ],
        },
        {
            label: "Help",
            submenu: [{ label: "Support", click: () => void electron_1.shell.openExternal(endpoints_1.SUPPORT_URL) }],
        },
    ];
    electron_1.Menu.setApplicationMenu(electron_1.Menu.buildFromTemplate(template));
}
function updateTray(state) {
    if (!tray)
        return;
    tray.setToolTip(`${(0, time_1.trackLabel)(state.track)} (${(0, time_1.formatTime)(state.position)})`);
}
// ---------------------------------------------------------------------------------------------
// Library.
async function walkAudioFiles(dir, found = []) {
    for (const entry of await (0, promises_1.readdir)(dir, { withFileTypes: true })) {
        const full = node_path_1.default.join(dir, entry.name);
        if (entry.isDirectory())
            await walkAudioFiles(full, found);
        else if (AUDIO_EXTENSIONS.has(node_path_1.default.extname(entry.name).toLowerCase()))
            found.push(full);
    }
    return found;
}
function registerLibraryIpc() {
    electron_1.ipcMain.handle("library:get-tracks", () => [...tracks.values()]);
    electron_1.ipcMain.handle("library:add-folder", async (event) => {
        const result = await electron_1.dialog.showOpenDialog(mainWindow, { properties: ["openDirectory"] });
        if (result.canceled || result.filePaths.length === 0)
            return null;
        const folder = result.filePaths[0];
        const folders = store.get("library.folders");
        if (!folders.includes(folder))
            store.set("library.folders", [...folders, folder]);
        const files = await walkAudioFiles(folder);
        files.forEach((file, index) => {
            const title = node_path_1.default.basename(file, node_path_1.default.extname(file));
            tracks.set(file, { id: file, path: file, title });
            if (index % 50 === 0)
                event.sender.send("library:scan-progress", { done: index, total: files.length });
        });
        event.sender.send("library:scan-progress", { done: files.length, total: files.length });
        return folder;
    });
    // electron_1.ipcMain.handle("library:remove-folder", ...) moved to the settings page in 3.2.
    electron_1.ipcMain.handle("playlists:export", async (_event, playlistId) => {
        const playlist = store.get("playlists").find((item) => item.id === playlistId);
        if (!playlist)
            return false;
        const { canceled, filePath } = await electron_1.dialog.showSaveDialog(mainWindow, {
            defaultPath: `${playlist.name}.m3u8`,
        });
        if (canceled || !filePath)
            return false;
        await (0, promises_1.writeFile)(filePath, ["#EXTM3U", ...playlist.trackIds].join("\n"));
        return true;
    });
}
// ---------------------------------------------------------------------------------------------
// Settings and playlists: one table of handlers, keyed by channel.
const handlers = {
    [ipc_1.Channels.SettingsGet]: () => store.get("preferences"),
    [ipc_1.Channels.SettingsSet]: (_event, patch) => {
        const next = { ...store.get("preferences"), ...patch };
        store.set("preferences", next);
        for (const win of electron_1.BrowserWindow.getAllWindows())
            win.webContents.send(ipc_1.Channels.SettingsChanged, next);
        return next;
    },
    [ipc_1.Channels.PlaylistsList]: () => store.get("playlists"),
    [ipc_1.Channels.PlaylistsSave]: (_event, playlist) => {
        const others = store.get("playlists").filter((item) => item.id !== playlist.id);
        store.set("playlists", [...others, playlist]);
        return playlist;
    },
};
// ---------------------------------------------------------------------------------------------
// Playback.
function registerPlayerIpc() {
    electron_1.ipcMain.on(ipc_1.PLAYER_STATE_CHANGED, (event, state) => {
        if (mainWindow && event.sender !== mainWindow.webContents) {
            log("ignoring player:seek from a stale renderer");
            return;
        }
        lastState = state;
        if (state.track)
            store.set("player.lastTrack", state.track.id);
        updateTray(state);
        miniWindow?.webContents.send(ipc_1.PLAYER_STATE, state);
    });
    electron_1.ipcMain.on("mini:command", (_event, command) => {
        if (command === "expand") {
            miniWindow?.close();
            mainWindow?.show();
            return;
        }
        mainWindow?.webContents.send("player:command", command);
    });
    electron_1.ipcMain.on("mini:toggle", () => toggleMiniPlayer());
    electron_1.ipcMain.handle("lyrics:fetch", async (_event, artist, title) => {
        const query = new URLSearchParams({ artist, title });
        const response = await fetch(endpoints_1.LYRICS_API + "/search?" + query.toString());
        if (!response.ok)
            return null;
        const body = await response.json();
        return body.lyrics ?? null;
    });
}
function registerWindowIpc() {
    electron_1.ipcMain.on("window:minimize", (event) => {
        electron_1.BrowserWindow.fromWebContents(event.sender)?.minimize();
    });
    electron_1.ipcMain.on("window:toggle-maximize", (event) => {
        const win = electron_1.BrowserWindow.fromWebContents(event.sender);
        if (!win)
            return;
        if (win.isMaximized())
            win.unmaximize();
        else
            win.maximize();
    });
    electron_1.ipcMain.handle("app:get-version", () => electron_1.app.getVersion());
}
function registerMediaKeys() {
    const keys = {
        MediaPlayPause: "play-pause",
        MediaNextTrack: "next",
        MediaPreviousTrack: "previous",
    };
    for (const [accelerator, action] of Object.entries(keys)) {
        electron_1.globalShortcut.register(accelerator, () => mainWindow?.webContents.send("media:key", action));
    }
}
async function checkForUpdates() {
    try {
        const response = await fetch(endpoints_1.UPDATE_FEED, {
            headers: { "user-agent": `Cadence/${electron_1.app.getVersion()}` },
        });
        const feed = await response.json();
        if (feed.version !== electron_1.app.getVersion())
            log("update available:", feed.version, "notes at https://cadence.example/changelog");
    }
    catch (error) {
        log("update check failed:", error);
    }
}
// ---------------------------------------------------------------------------------------------
// Application life cycle.
if (!electron_1.app.requestSingleInstanceLock())
    electron_1.app.quit();
electron_1.app.on("second-instance", () => {
    mainWindow?.show();
    mainWindow?.focus();
});
electron_1.app.on("window-all-closed", () => {
    if (process.platform !== "darwin")
        electron_1.app.quit();
});
electron_1.app.on("activate", () => {
    if (!mainWindow)
        mainWindow = createMainWindow();
});
electron_1.app.on("will-quit", () => electron_1.globalShortcut.unregisterAll());
electron_1.app.whenReady().then(() => {
    // 3.0 cached the scanned library in the config file; it is rebuilt from disk now.
    store.delete("legacy.libraryCache");
    registerLibraryIpc();
    for (const channel of Object.keys(handlers))
        electron_1.ipcMain.handle(channel, handlers[channel]);
    registerPlayerIpc();
    registerWindowIpc();
    mainWindow = createMainWindow();
    buildMenu();
    tray = new electron_1.Tray(electron_1.nativeImage.createEmpty());
    tray.setToolTip("Cadence");
    tray.on("click", () => mainWindow?.show());
    registerMediaKeys();
    void checkForUpdates();
});
