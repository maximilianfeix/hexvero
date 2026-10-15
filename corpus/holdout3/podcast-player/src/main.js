"use strict";
// Driftwood, a desktop podcast player. Main process.

const path = require("node:path");
const https = require("node:https");
const crypto = require("node:crypto");
const { app, BrowserWindow, ipcMain, Menu, shell } = require("electron");
const Store = require("electron-store");
const {
  Library,
  Episodes,
  DOWNLOAD_PREFIX,
  Downloads,
  Playback,
  Settings,
  App,
  DIRECTORY_URL,
  ARTWORK_CDN,
  ALERTS_SOCKET,
  STATUS_PAGE,
  t,
} = require("./shared");

const store = new Store({
  name: "driftwood-prefs",
  defaults: {
    subscriptions: [],
    settings: { speed: 1, skipSeconds: 30, autoDownload: false },
  },
});

// 1.x kept a window option here that the app no longer honours.
store.delete("windows.nodeIntegration");

const SECURE_DEFAULTS = Object.freeze({
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webSecurity: true,
});

// Channels whose names are picked at start, so that a page left over from an earlier run cannot
// listen in. The library preload asks for them once (App.TOPICS).
const topics = {
  alerts: `alerts.${crypto.randomBytes(4).toString("hex")}`,
};

let libraryWindow = null;
let playerWindow = null;
let helpWindow = null;

const hashId = (text) => crypto.createHash("sha1").update(text).digest("hex").slice(0, 12);

// ---------------------------------------------------------------------------------------------
// Feeds

// A small GET helper over node:https that follows one redirect. Feed addresses come from the
// user (subscriptions) or from the feeds themselves (redirects).
function requestText(url, redirects = 1) {
  return new Promise((resolve, reject) => {
    const headers = { "user-agent": `Driftwood/${app.getVersion()}` };
    https
      .get(url, { headers }, (res) => {
        const moved = res.statusCode >= 300 && res.statusCode < 400 && res.headers.location;
        if (moved && redirects > 0) {
          res.resume();
          resolve(requestText(new URL(res.headers.location, url).href, redirects - 1));
          return;
        }
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve(body));
      })
      .on("error", reject);
  });
}

function parseFeed(xml) {
  const pick = (text, tag) => {
    const match = text.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
    return match ? match[1].trim() : "";
  };
  const episodes = xml
    .split("<item>")
    .slice(1)
    .map((chunk) => ({
      guid: pick(chunk, "guid"),
      title: pick(chunk, "title"),
      audio: (chunk.match(/<enclosure[^>]*url="([^"]+)"/) ?? [])[1] ?? null,
      duration: Number(pick(chunk, "itunes:duration")) || 0,
      played: false,
    }));
  return { title: pick(xml, "title"), episodes };
}

// Subscriptions and their episodes. Tells the library window about every change.
class FeedService {
  #window = null;
  #episodes = new Map(); // feed address -> episodes of the last load

  attach(win) {
    this.#window = win;
  }

  list() {
    return store.get("subscriptions", []);
  }

  async subscribe(feedUrl) {
    const shows = this.list();
    if (shows.some((show) => show.feedUrl === feedUrl)) return shows;
    const show = await this.#load(feedUrl);
    store.set("subscriptions", [...shows, show]);
    this.notify("subscribed", show);
    return this.list();
  }

  unsubscribe(feedUrl) {
    const rest = this.list().filter((show) => show.feedUrl !== feedUrl);
    store.set("subscriptions", rest);
    this.#episodes.delete(feedUrl);
    this.notify("unsubscribed", { feedUrl });
    return rest;
  }

  async refreshAll() {
    const shows = this.list();
    const fresh = await Promise.all(shows.map((show) => this.#load(show.feedUrl).catch(() => show)));
    store.set("subscriptions", fresh);
    this.notify("refreshed", { count: fresh.length });
    return fresh;
  }

  episodes(feedUrl) {
    return this.#episodes.get(feedUrl) ?? [];
  }

  markPlayed(feedUrl, guid) {
    for (const episode of this.episodes(feedUrl)) if (episode.guid === guid) episode.played = true;
    this.notify("played", { feedUrl, guid });
  }

  notify(kind, detail) {
    if (!this.#window || this.#window.isDestroyed()) return;
    this.#window.webContents.send(Library.CHANGED, { kind, detail });
  }

  async #load(feedUrl) {
    const feed = parseFeed(await requestText(feedUrl));
    this.#episodes.set(feedUrl, feed.episodes);
    return { feedUrl, id: hashId(feedUrl), title: feed.title, episodes: feed.episodes.length };
  }
}

// Downloads of episode audio. Progress goes to the page that asked for the download.
class DownloadManager {
  #jobs = new Map();

  start(sender, episode) {
    const id = hashId(episode.audio);
    const controller = new AbortController();
    this.#jobs.set(id, controller);
    this.#run(sender, id, episode.audio, controller.signal)
      .catch((err) => this.#report(sender, { id, error: err.message }))
      .finally(() => this.#jobs.delete(id));
    return id;
  }

  cancel(id) {
    this.#jobs.get(id)?.abort();
    return this.#jobs.delete(id);
  }

  async #run(sender, id, audioUrl, signal) {
    const res = await fetch(audioUrl, { signal });
    const total = Number(res.headers.get("content-length")) || 0;
    let received = 0;
    // The bytes go to the episode cache in a later version; for now only the progress counts.
    for await (const chunk of res.body) {
      received += chunk.length;
      this.#report(sender, { id, received, total });
    }
    this.#report(sender, { id, received, total, done: true });
  }

  #report(sender, progress) {
    if (!sender.isDestroyed()) sender.send(Downloads.PROGRESS, progress);
  }
}

// What is playing, shared by the library window and the mini player.
class PlaybackHub {
  state = { episode: null, playing: false, position: 0 };

  update(patch) {
    Object.assign(this.state, patch);
    this.broadcast();
  }

  broadcast() {
    for (const win of [libraryWindow, playerWindow]) {
      if (win && !win.isDestroyed()) win.webContents.send(Playback.STATE, this.state);
    }
  }
}

const feeds = new FeedService();
const downloads = new DownloadManager();
const playback = new PlaybackHub();

// ---------------------------------------------------------------------------------------------
// Windows

function createLibraryWindow() {
  libraryWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    title: "Driftwood",
    // The library preload requires ./shared/channels.js, which a sandboxed preload cannot do.
    webPreferences: Object.assign({}, SECURE_DEFAULTS, {
      preload: path.join(__dirname, "preload.js"),
      sandbox: false,
    }),
  });
  libraryWindow.loadFile("index.html");
  libraryWindow.on("closed", () => {
    libraryWindow = null;
  });
  feeds.attach(libraryWindow);
}

function createPlayerWindow() {
  const bounds = store.get("player.bounds", { width: 360, height: 140 });
  playerWindow = new BrowserWindow({
    ...bounds,
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    webPreferences: {
      ...SECURE_DEFAULTS,
      preload: path.join(__dirname, "preload-player.js"),
    },
  });
  playerWindow.loadFile("player.html");
  playerWindow.on("moved", () => store.set("player.bounds", playerWindow.getBounds()));
  playerWindow.on("closed", () => {
    playerWindow = null;
  });
}

function openHelp() {
  if (helpWindow) return helpWindow.focus();
  helpWindow = new BrowserWindow({
    width: 640,
    height: 560,
    parent: libraryWindow ?? undefined,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // The guide still frames the old online docs, which send no CORS headers.
      webSecurity: false,
    },
  });
  helpWindow.loadFile("index.html", { hash: "help" });
  helpWindow.on("closed", () => {
    helpWindow = null;
  });
}

// ---------------------------------------------------------------------------------------------
// IPC

// Request/response channels of the library window, as [channel, handler] pairs.
const routes = [
  [Library.LIST, () => ({ shows: feeds.list(), directory: store.get("directory", []) })],
  [Library.SUBSCRIBE, (_event, feedUrl) => feeds.subscribe(feedUrl)],
  [Library.UNSUBSCRIBE, (_event, feedUrl) => feeds.unsubscribe(feedUrl)],
  [Library.REFRESH, () => feeds.refreshAll()],
  [Downloads.START, (event, episode) => downloads.start(event.sender, episode)],
  [Settings.GET, (_event, key) => store.get("settings")[key]],
  [Settings.SET, (_event, key, value) => store.set("settings", { ...store.get("settings"), [key]: value })],
];

const episodeHandlers = new Map([
  [Episodes.LIST, (_event, feedUrl) => feeds.episodes(feedUrl)],
  [Episodes.MARK_PLAYED, (_event, feedUrl, guid) => feeds.markPlayed(feedUrl, guid)],
]);

function registerIpc() {
  for (const [channel, handler] of routes) ipcMain.handle(channel, handler);
  for (const [channel, handler] of episodeHandlers) ipcMain.handle(channel, handler);

  ipcMain.handle(`${DOWNLOAD_PREFIX}cancel`, (_event, id) => downloads.cancel(id));

  ipcMain.on(App.TOPICS, (event) => {
    event.returnValue = topics;
  });

  ipcMain.on(Playback.PLAY, (_event, episode) => {
    playback.update({ episode, playing: true, position: 0 });
    if (!playerWindow) createPlayerWindow();
  });

  ipcMain.on("playback:toggle", () => playback.update({ playing: !playback.state.playing }));
  ipcMain.on("playback:seek", (_event, position) => playback.update({ position }));

  ipcMain.on("player:hello", (event) => {
    event.reply(Playback.STATE, playback.state);
  });
  ipcMain.on("player:close", () => playerWindow?.close());

  ipcMain.handle("player:now-playing", () => playback.state.episode);
  ipcMain.handle("player:artwork", async (_event, showId) => {
    const res = await fetch(`${ARTWORK_CDN}/${showId}/600.jpg`);
    if (!res.ok) return null;
    const type = res.headers.get("content-type") ?? "image/jpeg";
    return `data:${type};base64,${Buffer.from(await res.arrayBuffer()).toString("base64")}`;
  });

  // Waiting for the OPML parser:
  // ipcMain.handle(Library.IMPORT_OPML, (_event, file) => importOpml(file));

  ipcMain.on("help:open", () => {
    try {
      openHelp();
    } catch (err) {
      console.error("help:open failed", err);
    }
  });
}

// ---------------------------------------------------------------------------------------------
// Menu, alerts, directory

function buildMenu() {
  const sendCommand = (item) => libraryWindow?.webContents.send(App.MENU, item.id);
  const template = [
    {
      label: t("menu:file"),
      submenu: [
        { id: "subscribe", label: t("menu:file.subscribe"), accelerator: "CmdOrCtrl+N", click: sendCommand },
        { id: "refresh", label: t("menu:file.refresh"), accelerator: "CmdOrCtrl+R", click: sendCommand },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: t("menu:playback"),
      submenu: [
        {
          label: t("menu:playback.toggle"),
          accelerator: "Space",
          click: () => playback.update({ playing: !playback.state.playing }),
        },
      ],
    },
    {
      label: t("menu:help"),
      submenu: [
        { label: t("menu:help.guide"), click: () => openHelp() },
        { label: t("menu:help.status"), click: () => shell.openExternal(STATUS_PAGE) },
        {
          label: t("menu:help.prefs"),
          click: () => console.info("settings:open is not a window; preferences live in the library"),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function connectAlerts() {
  const socket = new WebSocket(`${ALERTS_SOCKET}?client=${hashId(app.getPath("userData"))}`);
  socket.addEventListener("message", (event) => {
    const alert = JSON.parse(event.data);
    libraryWindow?.webContents.send(topics.alerts, alert);
  });
  socket.addEventListener("close", () => setTimeout(connectAlerts, 30_000));
}

async function refreshDirectory() {
  try {
    const res = await fetch(DIRECTORY_URL, { headers: { accept: "application/json" } });
    if (res.ok) store.set("directory", (await res.json()).shows);
  } catch (err) {
    console.warn("directory refresh failed:", err.message);
  }
}

app.whenReady().then(() => {
  registerIpc();
  buildMenu();
  createLibraryWindow();
  connectAlerts();
  refreshDirectory();
  app.on("activate", () => {
    if (!libraryWindow) createLibraryWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
