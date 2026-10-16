#!/usr/bin/env node
/**
 * Builds the reproducible example inputs under examples/: a small Electron app packed as ASAR
 * (main process, preload, a webpack-style renderer bundle with IPC, endpoints and storage), and
 * two versions of it for `hexvero compare`. Everything here is authored for hexvero and MIT
 * licensed; nothing is copied from a real product. Re-run after editing the sources below.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "examples");
mkdirSync(out, { recursive: true });

/** Packs {path: content} into the ASAR container format (8-byte pickle header + JSON index + blobs). */
function asar(files) {
  const index = { files: {} };
  const blobs = [];
  let offset = 0;
  for (const [path, text] of Object.entries(files)) {
    const bytes = Buffer.from(text, "utf8");
    let node = index;
    const parts = path.split("/");
    for (const dir of parts.slice(0, -1)) node = node.files[dir] ??= { files: {} };
    node.files[parts.at(-1)] = { size: bytes.length, offset: String(offset) };
    blobs.push(bytes);
    offset += bytes.length;
  }
  const header = Buffer.from(JSON.stringify(index), "utf8");
  const padded = Buffer.alloc((header.length + 3) & ~3);
  header.copy(padded);
  const prefix = Buffer.alloc(16);
  prefix.writeUInt32LE(4, 0);
  prefix.writeUInt32LE(padded.length + 8, 4);
  prefix.writeUInt32LE(padded.length + 4, 8);
  prefix.writeUInt32LE(header.length, 12);
  return Buffer.concat([prefix, padded, ...blobs]);
}

const packageJson = (version) =>
  JSON.stringify(
    {
      name: "notesdesk",
      version,
      main: "main.js",
      description: "Example Electron app packaged for hexvero demos",
      license: "MIT",
      devDependencies: { electron: "33.2.0" },
    },
    null,
    2,
  );

const mainJs = (v2) => `const { app, BrowserWindow, ipcMain, shell } = require("electron");
const path = require("path");
const Store = require("./lib/store");

const store = new Store(path.join(app.getPath("userData"), "settings.json"));

function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 720,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: ${v2 ? "false" : "true"},
      sandbox: ${v2 ? "true" : "false"},
    },
  });
  win.loadFile("renderer/index.html");
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
}

ipcMain.handle("settings:get", (_e, key) => store.get(key));
ipcMain.handle("settings:set", (_e, key, value) => store.set(key, value));
ipcMain.handle("notes:list", () => store.get("notes") ?? []);
ipcMain.handle("notes:save", (_e, note) => store.push("notes", note));
ipcMain.on("app:quit", () => app.quit());
${v2 ? 'ipcMain.handle("update:check", async () => fetch("https://updates.notesdesk.example/latest.json").then((r) => r.json()));\n' : 'ipcMain.on("shell:open", (_e, target) => shell.openPath(target));\n'}${v2 ? '// The channel name comes from the environment at run time, so no static reading can name it.\nfor (const plugin of (process.env.NOTESDESK_PLUGINS ?? "").split(",").filter(Boolean))\n  ipcMain.handle(`plugin:${plugin}`, () => store.get(`plugins.${plugin}`));\n' : ""}
app.whenReady().then(createWindow);
app.on("window-all-closed", () => app.quit());
`;

const storeJs = `const fs = require("fs");
class Store {
  constructor(file) { this.file = file; this.data = this.read(); }
  read() { try { return JSON.parse(fs.readFileSync(this.file, "utf8")); } catch { return {}; } }
  get(key) { return this.data[key]; }
  set(key, value) { this.data[key] = value; fs.writeFileSync(this.file, JSON.stringify(this.data)); return true; }
  push(key, item) { const list = this.data[key] ?? []; list.push(item); return this.set(key, list); }
}
module.exports = Store;
`;

const preloadJs = (v2) => `const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("notesdesk", {
  getSetting: (key) => ipcRenderer.invoke("settings:get", key),
  setSetting: (key, value) => ipcRenderer.invoke("settings:set", key, value),
  listNotes: () => ipcRenderer.invoke("notes:list"),
  saveNote: (note) => ipcRenderer.invoke("notes:save", note),
  quit: () => ipcRenderer.send("app:quit"),
${v2 ? '  checkUpdate: () => ipcRenderer.invoke("update:check"),' : '  openInShell: (target) => ipcRenderer.send("shell:open", target),'}
});
`;

const rendererHtml = `<!doctype html><html><head><meta charset="utf-8"><title>NotesDesk</title></head>
<body><div id="app"></div><script src="app.bundle.js"></script></body></html>
`;

/** A webpack-5 style bundle with four modules, so hexvero's bundle splitting has something to find. */
const bundleJs = (v2) => `/******/ (() => { // webpackBootstrap
/******/ var __webpack_modules__ = ({

/***/ "./src/api.js":
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {
__webpack_require__.r(__webpack_exports__);
__webpack_require__.d(__webpack_exports__, { sync: () => sync, telemetry: () => telemetry });
const BASE = "https://api.notesdesk.example/v1";
async function sync(notes) {
  const token = localStorage.getItem("notesdesk.token");
  const res = await fetch(BASE + "/notes/sync", { method: "POST", headers: { Authorization: "Bearer " + token }, body: JSON.stringify(notes) });
  return res.json();
}
async function telemetry(event) {
  ${v2 ? 'if (localStorage.getItem("notesdesk.telemetry") !== "on") return;' : ""}
  await fetch("https://telemetry.notesdesk.example/collect", { method: "POST", body: JSON.stringify({ event, ts: Date.now() }) });
}
/***/ }),

/***/ "./src/editor.js":
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {
__webpack_require__.r(__webpack_exports__);
__webpack_require__.d(__webpack_exports__, { Editor: () => Editor });
class Editor {
  constructor(root) { this.root = root; this.root.innerHTML = '<textarea id="note"></textarea><button id="save">Save</button>'; }
  value() { return this.root.querySelector("#note").value; }
  onSave(fn) { this.root.querySelector("#save").addEventListener("click", fn); }
}
/***/ }),

/***/ "./src/index.js":
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {
__webpack_require__.r(__webpack_exports__);
var _editor_js__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__("./src/editor.js");
var _api_js__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__("./src/api.js");
var _util_js__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__("./src/util.js");
const editor = new _editor_js__WEBPACK_IMPORTED_MODULE_0__.Editor(document.getElementById("app"));
editor.onSave(async () => {
  const note = { id: (0,_util_js__WEBPACK_IMPORTED_MODULE_2__.uid)(), text: editor.value(), at: Date.now() };
  await window.notesdesk.saveNote(note);
  const notes = await window.notesdesk.listNotes();
  if (await window.notesdesk.getSetting("sync")) await (0,_api_js__WEBPACK_IMPORTED_MODULE_1__.sync)(notes);
  (0,_api_js__WEBPACK_IMPORTED_MODULE_1__.telemetry)("note.saved");
});
${v2 ? "window.notesdesk.checkUpdate().catch(() => {});" : 'document.addEventListener("dblclick", () => window.notesdesk.openInShell("/Applications"));'}
/***/ }),

/***/ "./src/util.js":
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {
__webpack_require__.r(__webpack_exports__);
__webpack_require__.d(__webpack_exports__, { uid: () => uid });
const uid = () => Math.random().toString(36).slice(2, 10);
/***/ })

/******/ });
/******/ var __webpack_module_cache__ = {};
/******/ function __webpack_require__(moduleId) {
/******/ var cachedModule = __webpack_module_cache__[moduleId];
/******/ if (cachedModule !== undefined) { return cachedModule.exports; }
/******/ var module = __webpack_module_cache__[moduleId] = { exports: {} };
/******/ __webpack_modules__[moduleId](module, module.exports, __webpack_require__);
/******/ return module.exports;
/******/ }
/******/ __webpack_require__.d = (exports, definition) => { for (var key in definition) { if (!Object.prototype.hasOwnProperty.call(exports, key)) Object.defineProperty(exports, key, { enumerable: true, get: definition[key] }); } };
/******/ __webpack_require__.r = (exports) => { Object.defineProperty(exports, "__esModule", { value: true }); };
/******/ __webpack_require__("./src/index.js");
/******/ })();
`;

for (const [name, v2] of [
  ["notesdesk-1.4.0.asar", false],
  ["notesdesk-1.5.0.asar", true],
]) {
  const files = {
    "package.json": packageJson(v2 ? "1.5.0" : "1.4.0"),
    "main.js": mainJs(v2),
    "preload.js": preloadJs(v2),
    "lib/store.js": storeJs,
    "renderer/index.html": rendererHtml,
    "renderer/app.bundle.js": bundleJs(v2),
  };
  writeFileSync(join(out, name), asar(files));
  console.log(`wrote examples/${name}`);
}
writeFileSync(join(out, "notesdesk-1.5.0.bundle.js"), bundleJs(true));
console.log("wrote examples/notesdesk-1.5.0.bundle.js");
