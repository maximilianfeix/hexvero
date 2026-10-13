// Runs a bundled main.js against stand-ins for electron, electron-store and node:https and
// prints what it did. Part of corpus/holdout/verify.mjs; no analysis tool is involved.
"use strict";
const Module = require("node:module");
const path = require("node:path");

// The program logs; only the result may go to standard output.
console.log = console.info = console.warn = () => {};

const seen = { ipc: [], sends: [], windows: [], store: [], requests: [], external: [] };
const listeners = [];
const later = [];
let startTimer = null;
const port = () => ({ on() {}, start() {}, postMessage() {} });

class BrowserWindow {
  static all = [];
  constructor(options) {
    this.options = options;
    this.id = BrowserWindow.all.push(this);
    this.record = { hash: null, webPreferences: { ...options.webPreferences } };
    seen.windows.push(this.record);
    this.webContents = {
      send: (channel) => seen.sends.push(["webContents.send", channel]),
      postMessage: (channel) => seen.sends.push(["webContents.postMessage", channel]),
      once: (_name, fn) => later.push(fn),
      setWindowOpenHandler: (fn) => later.push(() => fn({ url: "https://runtime.example/link" })),
      getLastWebPreferences: () => options.webPreferences,
    };
  }
  static getAllWindows = () => BrowserWindow.all;
  static getFocusedWindow = () => BrowserWindow.all[0];
  static fromWebContents = () => BrowserWindow.all[0];
  on(_name, fn) {
    later.push(fn);
  }
  once(_name, fn) {
    later.push(fn);
  }
  loadFile(_file, options) {
    this.record.hash = options?.hash ?? "";
  }
  setBounds() {}
  getBounds() {
    return {};
  }
  show() {}
  close() {}
  setAlwaysOnTop() {}
}

const ipcMain = { removeHandler: (channel) => seen.ipc.push(["removeHandler", channel]) };
for (const method of ["handle", "on", "once", "handleOnce"])
  ipcMain[method] = (channel, fn) => {
    seen.ipc.push([method, channel]);
    listeners.push(fn);
    if (channel === "timer:start") startTimer = fn;
  };

const electron = {
  app: {
    whenReady: () => Promise.resolve(),
    on() {},
    quit() {},
    getLocale: () => "en",
    getVersion: () => "4.2.0",
    getPath: () => "/tmp",
    dock: { setBadge() {} },
  },
  BrowserWindow,
  ipcMain,
  MessageChannelMain: class {
    port1 = port();
    port2 = port();
  },
  globalShortcut: { register: (_keys, fn) => later.push(fn), unregisterAll() {} },
  nativeTheme: { on: (_name, fn) => later.push(fn), shouldUseDarkColors: false },
  powerMonitor: { on: (_name, fn) => later.push(fn) },
  shell: { openExternal: (url) => seen.external.push(String(url)) },
  net: {
    fetch: async (url, init) => {
      seen.requests.push(["net.fetch", String(url), init?.method ?? null]);
      return { ok: true, json: async () => ({ version: "9.9.9" }) };
    },
  },
};

class Store {
  constructor(options) {
    seen.store.push(["file", options?.name ?? "config"]);
  }
  get(key, fallback) {
    seen.store.push(["read", key]);
    return fallback;
  }
  set(key) {
    for (const name of typeof key === "object" ? Object.keys(key) : [key])
      seen.store.push(["write", name]);
  }
  delete(key) {
    seen.store.push(["delete", key]);
  }
}

const https = {
  request(url, options) {
    seen.requests.push(["https.request", String(url), options?.method ?? null]);
    return { on() {}, end() {} };
  },
};

const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === "electron") return electron;
  if (request === "electron-store") return Store;
  if (request === "node:https") return https;
  return load.call(this, request, ...rest);
};

require(path.resolve(process.argv[2]));

const event = () => ({
  reply: (channel) => seen.sends.push(["event.reply", channel]),
  sender: { send: (channel) => seen.sends.push(["event.sender.send", channel]) },
  ports: [port()],
});

setTimeout(async () => {
  // Every listener is called twice: with arguments and without.
  for (const fn of [...listeners]) {
    await Promise.resolve(fn(event(), 1, "x")).catch(() => {});
    await Promise.resolve(fn(event())).catch(() => {});
  }
  for (const fn of [...later]) await Promise.resolve(fn({})).catch(() => {});
  // Several of the calls above stop the timer. Start it once more and wait: it ticks once a
  // second, and a sync ends a second and a half after it began.
  startTimer?.(event(), 1);
  setTimeout(() => {
    process.stdout.write(JSON.stringify(seen));
    process.exit(0);
  }, 1800);
}, 50);
