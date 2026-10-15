"use strict";
// Lattice: a kanban board. One board window with an activity feed docked on its right side (a
// BrowserView), a legacy importer window, and an offscreen window that prints the board to PDF.
const { app, BrowserView, BrowserWindow, Menu, dialog, ipcMain, net, session, shell } = require("electron");
const { EventEmitter } = require("node:events");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { board, card, lane, activity, prefs, auth } = require("./lib/channels");
const { makeWindow } = require("./lib/window-factory");
const model = require("./lib/board-model");

const SYNC_BASE = "https://sync.lattice.example/api/";
const SYNC_ORIGIN = new URL(SYNC_BASE).origin;
const GRAPHQL_URL = "https://graph.lattice.example/graphql";
const DOCS_URL = "https://docs.lattice.example/shortcuts";
// The 1.x sync server, switched off in 2.0. Kept for the migration notes.
const LEGACY_SYNC = "https://lattice-sync.herokuapp.example/v1";
const SESSION_COOKIE = "lattice_sid";

const MEMBERS_QUERY = `
  query BoardMembers {
    members(first: 50) { id name avatarUrl }
  }
`;

// ---------------------------------------------------------------------------------------------
// Settings: a JSON file in the user data folder, read and written whole.

const settingsFile = () => path.join(app.getPath("userData"), "lattice-settings.json");
const DEFAULT_SETTINGS = Object.freeze({ theme: "paper", lastBoard: null, zoom: 1 });

function readSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(settingsFile(), "utf8")) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function writeSettings(next) {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2));
  return next;
}

// ---------------------------------------------------------------------------------------------
// State and the event bus. Windows hear about main-process events only through forward().

let boardWindow = null;
let activityView = null;
let importWindow = null;

const boardStore = {
  boards: [model.demoBoard()],
  activeId: null,
  current() {
    return this.boards.find((b) => b.id === this.activeId) ?? this.boards[0];
  },
  save(next) {
    this.boards = this.boards.map((b) => (b.id === next.id ? next : b));
    return next;
  },
};

const bus = new EventEmitter();

// A token for this run, given to the board window on its command line. The zoom channel is named
// after it, so that a second board window (planned for 2.4) gets only its own zoom changes.
const windowToken = crypto.randomUUID();
const zoomChannel = `zoom:${windowToken}`;

function forward(eventName, channel, target) {
  bus.on(eventName, (payload) => {
    const contents = target()?.webContents;
    if (contents && !contents.isDestroyed()) contents.send(channel, payload);
  });
}

function changed(next, entry) {
  boardStore.save(next);
  bus.emit("board-changed", model.summary(next));
  if (entry) bus.emit("activity", { ...entry, at: Date.now() });
  return model.summary(next);
}

// ---------------------------------------------------------------------------------------------
// IPC helpers.

/** handle(channel)(fn) registers fn for invoke() on channel and gives fn back unchanged. */
const handle = (channel) => (fn) => {
  ipcMain.handle(channel, (_event, ...args) => fn(...args));
  return fn;
};

/** Listens on every lane channel it is given and applies the change to the active board. */
class LaneListeners {
  constructor(channels, store) {
    this.store = store;
    for (const channel of channels) {
      ipcMain.on(channel, (_event, laneId, payload) => this.apply(channel, laneId, payload));
    }
  }

  apply(channel, laneId, payload) {
    const current = this.store.current();
    if (channel === lane.collapse) changed(model.setCollapsed(current, laneId, true));
    else if (channel === lane.expand) changed(model.setCollapsed(current, laneId, false));
    else if (channel === lane.reorder) changed(model.reorderLanes(current, payload), { kind: "reorder" });
  }
}

const LANE_CHANNELS = [lane.collapse, lane.expand, lane.reorder];

// ---------------------------------------------------------------------------------------------
// Network.

async function fetchMembers() {
  const res = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: MEMBERS_QUERY, operationName: "BoardMembers" }),
  });
  const { data } = await res.json();
  return data?.members ?? [];
}

async function syncBoard(snapshot) {
  const [cookie] = await session.defaultSession.cookies.get({ url: SYNC_ORIGIN, name: SESSION_COOKIE });
  if (!cookie) return;
  const target = new URL(`boards/${encodeURIComponent(snapshot.id)}`, SYNC_BASE);
  const res = await fetch(target, {
    method: "PUT",
    headers: { "content-type": "application/json", authorization: `Bearer ${cookie.value}` },
    body: JSON.stringify(snapshot),
  });
  if (!res.ok) console.warn(`sync of ${snapshot.id} failed with ${res.status}`);
}

async function checkSyncHealth() {
  // A leading slash: this is https://sync.lattice.example/health, outside /api/.
  const res = await fetch(new URL("/health", SYNC_BASE)).catch(() => null);
  bus.emit("activity", { kind: res?.ok ? "sync-online" : "sync-offline", at: Date.now() });
}

// ---------------------------------------------------------------------------------------------
// IPC.

function registerIpc() {
  forward("board-changed", board.changed, () => boardWindow);
  forward("activity", activity.push, () => activityView);
  bus.on("board-changed", (snapshot) => syncBoard(snapshot).catch(() => {}));

  handle(board.list)(async () => {
    const members = await fetchMembers().catch(() => []);
    return { boards: boardStore.boards.map(model.summary), members };
  });

  handle(board.move)(async (cardId, toLane, index) =>
    changed(model.moveCard(boardStore.current(), cardId, toLane, index), { kind: "move", cardId }),
  );

  handle(board.archive)(async (boardId) => {
    const target = boardStore.boards.find((b) => b.id === boardId);
    if (!target) return null;
    return changed({ ...target, archived: true }, { kind: "archive", boardId });
  });

  // ipcMain.handle("board:export", ...) comes with the JSON export in 2.4.

  ipcMain.on("import:open", () => openImporter());

  handle(card.create)(async (laneId, title) =>
    changed(model.addCard(boardStore.current(), laneId, title), { kind: "create", title }),
  );

  handle(card.rename)(async (cardId, title) =>
    changed(model.renameCard(boardStore.current(), cardId, title)),
  );

  handle(card.remove)(async (cardId) => {
    try {
      return changed(model.removeCard(boardStore.current(), cardId), { kind: "remove", cardId });
    } catch (err) {
      console.error("card:remove failed", err);
      throw err;
    }
  });

  handle(card.linkPreview)(async (url) => {
    const res = await net.fetch(url, { headers: { accept: "text/html" } });
    const html = await res.text();
    const title = /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim();
    return { url, title: title || url };
  });

  new LaneListeners(LANE_CHANNELS, boardStore);

  ipcMain.on(activity.clear, () => bus.emit("activity", { kind: "cleared", at: Date.now() }));

  handle(prefs.load)(async () => readSettings());
  handle(prefs.save)(async (patch) => writeSettings({ ...readSettings(), ...patch }));

  handle(auth.signIn)(async (token) => {
    await session.defaultSession.cookies.set({
      url: SYNC_ORIGIN,
      name: SESSION_COOKIE,
      value: token,
      secure: true,
      httpOnly: true,
      expirationDate: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
    });
    bus.emit("activity", { kind: "signed-in", at: Date.now() });
    return true;
  });

  handle(auth.signOut)(async () => {
    await session.defaultSession.cookies.remove(SYNC_ORIGIN, SESSION_COOKIE);
    return true;
  });

  ipcMain.handle("import:cards", async (_event, rows) => {
    changed(model.importRows(boardStore.current(), rows), { kind: "import", count: rows.length });
    importWindow?.close();
    return rows.length;
  });

  ipcMain.on(zoomChannel, (_event, level) => {
    boardWindow?.webContents.setZoomFactor(level);
    writeSettings({ ...readSettings(), zoom: level });
  });
}

function sendZoom(delta) {
  const level = Math.min(2, Math.max(0.5, readSettings().zoom + delta));
  boardWindow?.webContents.send(zoomChannel, level);
}

// ---------------------------------------------------------------------------------------------
// Windows.

function createBoardWindow() {
  boardWindow = new BrowserWindow(
    makeWindow(
      {
        preload: path.join(__dirname, "preload.js"),
        // The preload requires ./lib/channels.js, which a sandboxed preload cannot do.
        sandbox: false,
        additionalArguments: [`--lattice-window=${windowToken}`],
      },
      { title: "Lattice" },
    ),
  );
  boardWindow.loadFile("index.html");
  boardWindow.once("ready-to-show", () => boardWindow.show());
  boardWindow.on("resize", layoutActivity);
  boardWindow.on("closed", () => {
    boardWindow = null;
    activityView = null;
  });
  attachActivity();
}

function attachActivity() {
  activityView = new BrowserView({
    webPreferences: {
      preload: path.join(__dirname, "preload-activity.js"),
      sandbox: true,
      contextIsolation: true,
    },
  });
  boardWindow.setBrowserView(activityView);
  layoutActivity();
  activityView.webContents.loadFile("activity.html");
}

function layoutActivity() {
  if (!boardWindow || !activityView) return;
  const [width, height] = boardWindow.getContentSize();
  activityView.setBounds({ x: width - 300, y: 0, width: 300, height });
}

function openImporter() {
  if (importWindow) return importWindow.focus();
  importWindow = new BrowserWindow({
    width: 640,
    height: 520,
    parent: boardWindow ?? undefined,
    title: "Import a Trello export",
    webPreferences: {
      // The importer is still the 1.x page: it reads the export with Node's fs from the page.
      nodeIntegration: true,
      contextIsolation: false,
      webSecurity: false,
      allowRunningInsecureContent: true,
    },
  });
  importWindow.loadFile("import.html");
  importWindow.on("closed", () => {
    importWindow = null;
  });
}

function boardAsHtml(snapshot) {
  const lanes = snapshot.lanes
    .map((l) => `<section><h2>${l.title}</h2><ul>${l.cards.map((c) => `<li>${c.title}</li>`).join("")}</ul></section>`)
    .join("");
  return `<!doctype html><meta charset="utf-8"><title>${snapshot.title}</title><body>${lanes}</body>`;
}

async function savePdf() {
  // Card covers are images from other origins drawn onto a canvas, hence webSecurity: false.
  const printWindow = new BrowserWindow(makeWindow({ webSecurity: false }, { width: 1100 }));
  const html = boardAsHtml(boardStore.current());
  await printWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  const pdf = await printWindow.webContents.printToPDF({ landscape: true });
  printWindow.destroy();
  const { filePath } = await dialog.showSaveDialog({ defaultPath: "board.pdf" });
  if (filePath) fs.writeFileSync(filePath, pdf);
}

function buildMenu() {
  const template = [
    {
      label: "Board",
      submenu: [
        { label: "Import Trello export…", click: () => openImporter() },
        { label: "Print to PDF…", click: () => savePdf() },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "View",
      submenu: [
        { label: "Zoom in", accelerator: "CmdOrCtrl+=", click: () => sendZoom(0.1) },
        { label: "Zoom out", accelerator: "CmdOrCtrl+-", click: () => sendZoom(-0.1) },
        { role: "toggleDevTools" },
      ],
    },
    {
      role: "help",
      submenu: [{ label: "Keyboard shortcuts", click: () => shell.openExternal(DOCS_URL) }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  registerIpc();
  buildMenu();
  createBoardWindow();
  checkSyncHealth();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createBoardWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
