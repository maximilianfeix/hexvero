// Main process of Inkwell, a markdown editor with a live preview.
// MIT licensed, written for this corpus.
"use strict";

const path = require("node:path");
const fs = require("node:fs/promises");
const {
  app,
  BrowserWindow,
  Menu,
  WebContentsView,
  dialog,
  ipcMain,
  shell,
  webContents,
} = require("electron");
const channels = require("./ipc/channels");
const { WINDOW_DEFAULTS, WEB_DEFAULTS } = require("./config/defaults");
const { PLUGIN_REGISTRY, PLUGIN_CDN, GUIDE_URL } = require("./config/endpoints");
const { renderMarkdown, titleOf } = require("./lib/markdown");
const { SettingsFile } = require("./lib/settings-file");

const PRELOAD = path.join(__dirname, "preload.js");
const PREVIEW_WIDTH = 0.45;

const settings = new SettingsFile(path.join(app.getPath("userData"), "settings.json"), {
  "editor.fontSize": 15,
  "plugins.unsafe": false,
  "vault.path": null,
  "recent.files": [],
});

let editorWindow = null;
let settingsWindow = null;
let preview = null;
let dirty = false;
let pendingFile = null;

// ---------------------------------------------------------------------------------------------
// A tiny router: the handlers of one feature share a prefix ("vault:list", "vault:search").

class IpcRouter {
  constructor(namespace) {
    this.namespace = namespace;
    this.registered = [];
  }

  channel(name) {
    return `${this.namespace}:${name}`;
  }

  handle(name, handler) {
    const channel = this.channel(name);
    ipcMain.handle(channel, (event, ...args) => handler(...args, event));
    this.registered.push(channel);
    return this;
  }

  on(name, listener) {
    const channel = this.channel(name);
    ipcMain.on(channel, (event, ...args) => listener(...args, event));
    this.registered.push(channel);
    return this;
  }

  dispose() {
    for (const channel of this.registered) {
      ipcMain.removeHandler(channel);
      ipcMain.removeAllListeners(channel);
    }
    this.registered = [];
  }
}

// ---------------------------------------------------------------------------------------------
// Windows.

/** Every window gets the defaults; webPreferences are merged key by key. */
function createWindow(options) {
  const win = new BrowserWindow({
    ...WINDOW_DEFAULTS,
    ...options,
    webPreferences: { ...WEB_DEFAULTS, ...options.webPreferences },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  win.once("ready-to-show", () => win.show());
  return win;
}

function layoutPreview() {
  if (!editorWindow || !preview) return;
  const { width, height } = editorWindow.getContentBounds();
  const left = Math.round(width * (1 - PREVIEW_WIDTH));
  preview.setBounds({ x: left, y: 0, width: width - left, height });
}

function openEditor() {
  const unsafePlugins = settings.get("plugins.unsafe") === true;
  editorWindow = createWindow({
    width: 1240,
    height: 820,
    minWidth: 720,
    title: "Inkwell",
    webPreferences: {
      preload: PRELOAD,
      // Community plug-ins that load Node modules need an unsandboxed page; the user opts in.
      sandbox: unsafePlugins ? false : true,
    },
  });

  // The rendered note sits next to the editor, in a page of its own.
  preview = new WebContentsView({
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  editorWindow.contentView.addChildView(preview);
  // Links in the preview leave the application.
  preview.webContents.on("will-navigate", (event, url) => {
    event.preventDefault();
    shell.openExternal(url);
  });
  preview.webContents.loadFile("index.html", { hash: "preview" });
  layoutPreview();
  editorWindow.on("resize", layoutPreview);

  editorWindow.on("close", (event) => {
    if (!dirty) return;
    event.preventDefault();
    ipcMain.once("app:close-confirmed", () => {
      dirty = false;
      editorWindow?.close();
    });
    editorWindow.webContents.send("app:confirm-close");
  });
  editorWindow.on("closed", () => {
    editorWindow = null;
    preview = null;
  });
  editorWindow.webContents.once("did-finish-load", () => {
    if (pendingFile) sendOpened(pendingFile);
    pendingFile = null;
  });
  editorWindow.loadFile("index.html");
}

/** Created the first time it is asked for, and hidden rather than closed. */
function showSettings() {
  if (settingsWindow) {
    settingsWindow.show();
    return;
  }
  settingsWindow = new BrowserWindow({
    parent: editorWindow ?? undefined,
    width: 640,
    height: 520,
    show: false,
    title: "Settings",
    minimizable: false,
    webPreferences: {
      preload: PRELOAD,
      sandbox: true,
    },
  });
  settingsWindow.on("close", (event) => {
    if (editorWindow) {
      event.preventDefault();
      settingsWindow.hide();
    }
  });
  settingsWindow.once("ready-to-show", () => settingsWindow.show());
  settingsWindow.loadFile("index.html", { hash: "settings" });
}

// ---------------------------------------------------------------------------------------------
// Notes on disk.

const WELCOME = [
  "# Welcome to Inkwell",
  "",
  "Write on the left, read on the right. The guide lives at https://inkwell.example/guide and",
  "plug-ins at [the directory](https://plugins.inkwell.example/browse).",
].join("\n");

async function readNote(filePath) {
  const content = await fs.readFile(filePath, "utf8");
  const recent = settings.get("recent.files").filter((item) => item !== filePath);
  settings.set("recent.files", [filePath, ...recent].slice(0, 10));
  return { path: filePath, content, title: titleOf(content, path.basename(filePath)) };
}

async function sendOpened(filePath) {
  editorWindow?.webContents.send("file:opened", await readNote(filePath));
}

async function listNotes() {
  const vault = settings.get("vault.path");
  if (!vault) return [{ path: null, title: "Welcome", content: WELCOME }];
  const names = await fs.readdir(vault);
  return names.filter((name) => name.endsWith(".md")).map((name) => ({ path: path.join(vault, name), title: name }));
}

async function searchNotes(query) {
  const needle = String(query).toLowerCase();
  const hits = [];
  for (const note of await listNotes()) {
    const content = note.path ? await fs.readFile(note.path, "utf8") : note.content;
    if (content.toLowerCase().includes(needle)) hits.push({ ...note, content: undefined });
  }
  return hits;
}

// ---------------------------------------------------------------------------------------------
// Plug-ins. Their ids come from the manifests on disk, so the names of their event channels
// exist only at run time.

const loadedPlugins = new Map();

// Manifests from before 1.0 asked for a page with Node. Such plug-ins are refused; nothing ever
// creates a window with these preferences.
const LEGACY_MANIFEST = { webPreferences: { nodeIntegration: true, contextIsolation: false } };

function isLegacyPlugin(manifest) {
  const asked = manifest.webPreferences ?? {};
  return Object.entries(LEGACY_MANIFEST.webPreferences).some(([key, value]) => asked[key] === value);
}

async function loadPlugins() {
  const dir = path.join(app.getPath("userData"), "plugins");
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const manifest = JSON.parse(await fs.readFile(path.join(dir, entry.name, "manifest.json"), "utf8"));
      if (isLegacyPlugin(manifest)) {
        console.warn(`[plugins] ${manifest.id} needs a legacy page and was not loaded`);
        continue;
      }
      loadedPlugins.set(manifest.id, { manifest, calls: 0 });
    } catch (error) {
      console.warn(`[plugins] ${entry.name}: ${error.message}`);
    }
  }
}

function emitPluginEvent(pluginId, payload) {
  editorWindow?.webContents.send(`plugin:${pluginId}:event`, payload);
}

async function checkPluginUpdates() {
  const response = await fetch(PLUGIN_REGISTRY, { headers: { accept: "application/json" } });
  if (!response.ok) return;
  const registry = await response.json();
  for (const [id, plugin] of loadedPlugins) {
    const latest = registry.plugins?.[id];
    if (!latest || latest.version === plugin.manifest.version) continue;
    const archive = await fetch(`${PLUGIN_CDN}/${id}/${latest.version}/plugin.zip`);
    const target = path.join(app.getPath("userData"), "plugins", `${id}-${latest.version}.zip`);
    await fs.writeFile(target, Buffer.from(await archive.arrayBuffer()));
    emitPluginEvent(id, { type: "update-downloaded", version: latest.version });
  }
}

// ---------------------------------------------------------------------------------------------
// IPC.

function registerIpc() {
  ipcMain.handle("file:open", async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(editorWindow, {
      properties: ["openFile"],
      filters: [{ name: "Markdown", extensions: ["md", "markdown", "txt"] }],
    });
    if (canceled || filePaths.length === 0) return null;
    return readNote(filePaths[0]);
  });

  ipcMain.handle("file:save", async (_event, filePath, content) => {
    await fs.writeFile(filePath, content, "utf8");
    dirty = false;
    return { path: filePath, savedAt: Date.now() };
  });

  ipcMain.handle("file:save-as", async (_event, content) => {
    const { canceled, filePath } = await dialog.showSaveDialog(editorWindow, {
      defaultPath: `${titleOf(content, "Untitled")}.md`,
    });
    if (canceled || !filePath) return null;
    await fs.writeFile(filePath, content, "utf8");
    dirty = false;
    return { path: filePath, savedAt: Date.now() };
  });

  ipcMain.on("app:set-title", (event, title) => {
    BrowserWindow.fromWebContents(event.sender)?.setTitle(`${title} - Inkwell`);
  });

  ipcMain.on("editor:dirty", (event, value) => {
    dirty = Boolean(value);
    BrowserWindow.fromWebContents(event.sender)?.setDocumentEdited(dirty);
  });

  ipcMain.on("settings:open", () => showSettings());

  ipcMain.on("preview:update", (_event, markdown) => {
    preview?.webContents.send("preview:render", renderMarkdown(markdown));
  });

  ipcMain.on("preview:scroll", (_event, ratio) => {
    editorWindow?.webContents.send("editor:scroll-to", ratio);
  });

  ipcMain.handle(channels.settings.get, () => settings.all());

  ipcMain.handle(channels.settings.set, (_event, key, value) => {
    settings.set(key, value);
    // The editor, the preview and the settings window all hear about it.
    for (const contents of webContents.getAllWebContents()) contents.send(channels.settings.changed, key, value);
    return settings.all();
  });

  ipcMain.handle("plugin:invoke", async (_event, pluginId, method, ...args) => {
    const plugin = loadedPlugins.get(pluginId);
    if (!plugin) throw new Error(`unknown plug-in ${pluginId}`);
    plugin.calls += 1;
    emitPluginEvent(pluginId, { type: "called", method, args: args.length });
    return { ok: true, calls: plugin.calls };
  });

  new IpcRouter("vault")
    .handle("list", () => listNotes())
    .handle("search", (query) => searchNotes(query))
    .on("reveal", (notePath) => shell.showItemInFolder(notePath));

  new IpcRouter("plugins").handle("list", () => [...loadedPlugins.values()].map((plugin) => plugin.manifest));

  console.info("[ipc] vault:rebuild is done by the indexer in the page since 1.4");
}

// ---------------------------------------------------------------------------------------------
// Menu and life cycle.

const menuAction = (action) => () => editorWindow?.webContents.send("menu:action", action);

function buildMenu() {
  const template = [
    {
      label: "File",
      submenu: [
        { label: "New Note", accelerator: "CmdOrCtrl+N", click: menuAction("new") },
        { label: "Open...", accelerator: "CmdOrCtrl+O", click: menuAction("open") },
        { label: "Save", accelerator: "CmdOrCtrl+S", click: menuAction("save") },
        { label: "Save As...", accelerator: "CmdOrCtrl+Shift+S", click: menuAction("save-as") },
        { type: "separator" },
        { label: "Settings...", accelerator: "CmdOrCtrl+,", click: () => showSettings() },
      ],
    },
    {
      label: "View",
      submenu: [
        { label: "Toggle Preview", accelerator: "CmdOrCtrl+P", click: menuAction("toggle-preview") },
        { role: "toggleDevTools" },
      ],
    },
    {
      label: "Help",
      submenu: [{ label: "Guide", click: () => shell.openExternal(GUIDE_URL) }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// macOS hands over files dropped on the dock icon before the window may exist.
app.on("open-file", (event, filePath) => {
  event.preventDefault();
  if (editorWindow) sendOpened(filePath);
  else pendingFile = filePath;
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (!editorWindow) openEditor();
});

app.whenReady().then(async () => {
  registerIpc();
  buildMenu();
  openEditor();
  await loadPlugins();
  checkPluginUpdates().catch((error) => console.warn("[plugins] update check failed:", error.message));
});
