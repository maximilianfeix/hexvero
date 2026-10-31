import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSync, transformSync } from "esbuild";
import { afterAll, describe, expect, it } from "vitest";
import { analyzeJavaScriptTree, asarTree, type JsAppInfo } from "../src/javascript/app.js";
import { buildAsar } from "./fixtures/asar.js";

/**
 * Electron reached through a lazy getter: `X().BrowserWindow`, `X().app`, `X().shell`, … must
 * read as `electron.X`. Seen in GitHub Desktop 3.6.10, whose webpack 5 bundle writes
 * `le = n.cw(function (e, t) { e.exports = require("electron") })` and `new (le().BrowserWindow)(t)`.
 * The expected facts below are written from the fixture sources; nothing is run.
 */

const dir = mkdtempSync(join(tmpdir(), "hexvero-lazy-electron-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const analyze = (main: string, preload = PRELOAD_LAZY): JsAppInfo =>
  analyzeJavaScriptTree(
    asarTree(
      buildAsar({
        "package.json": JSON.stringify({ name: "lazy", main: "main.js" }),
        "main.js": main,
        "preload.js": preload,
      }),
      "app.asar",
    ),
  );

/**
 * The same main process, written against the electron module as `get` (`electron`, or a getter
 * call `electron()`, whose class needs the parentheses: `new electron().BrowserWindow()` would
 * construct `electron` itself).
 */
const body = (get: string): string => {
  const ctor = get.endsWith(")") ? `(${get}.BrowserWindow)` : `${get}.BrowserWindow`;
  return `
const opts = { width: 600, webPreferences: { nodeIntegration: true, contextIsolation: false, preload: "preload.js" } };
const win = new ${ctor}(opts);
const other = new ${ctor}({ width: 300, webPreferences: { sandbox: false } });
${get}.ipcMain.handle("get-data", () => 1);
${get}.ipcMain.on("set-data", (event, value) => {});
win.webContents.send("pushed", 1);
${get}.app.on("certificate-error", (event, contents, url, error, certificate, callback) => { callback(false); });
${get}.app.on("certificate-error", (event, contents, url, error, certificate, callback) => { event.preventDefault(); callback(true); });
${get}.shell.openExternal("https://example.com/help");
${get}.app.commandLine.appendSwitch("ignore-certificate-errors");
win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
${get}.session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => callback(true));
`;
};

/** The reference: the module bound once, as 3.6.7 of the same app wrote it. */
const EAGER = `const electron = require("electron");${body("electron")}`;
const FUNCTION_GETTER = `function electron() { return require("electron"); }${body("electron()")}`;
const ARROW_GETTER = `const electron = () => require("electron");${body("electron()")}`;
/** Babel's `lazy: true` CommonJS import. */
const BABEL_LAZY = `"use strict";
function _electron() {
  const data = require("electron");
  _electron = function () {
    return data;
  };
  return data;
}${body("_electron()")}`;

/**
 * A webpack 5 bundle with its runtime: module 2385 is Electron, `n.cw` the lazy CommonJS wrapper,
 * `n.n` the default-import getter. Every getter is used, and `r = le()` names the module once.
 * The runtime's own `var t; … t = { exports: {} }` is another `t` than the window options `t`.
 */
const WEBPACK = `(() => {
  var __webpack_modules__ = {
    2385: (e) => {
      "use strict";
      e.exports = require("electron");
    },
  };
  var __webpack_module_cache__ = {};
  function n(id) {
    var c = __webpack_module_cache__[id];
    if (c !== undefined) return c.exports;
    var m = (__webpack_module_cache__[id] = { exports: {} });
    __webpack_modules__[id](m, m.exports, n);
    return m.exports;
  }
  n.n = (e) => {
    var t = e && e.__esModule ? () => e.default : () => e;
    return t;
  };
  n.cw = (e) => {
    var t;
    return () => {
      if (e) {
        var r = e;
        e = 0;
        t = { exports: {} };
        r.call(t.exports, t, t.exports);
      }
      return t.exports;
    };
  };
  (() => {
    "use strict";
    var ae = () => n(2385),
      ee = n(2385),
      de = n.n(ee),
      le = n.cw(function (e, t) {
        e.exports = require("electron");
      });
    class Main {
      constructor() {
        const t = { width: 600, webPreferences: { nodeIntegration: true, contextIsolation: false, preload: "preload.js" } };
        this.win = new (le().BrowserWindow)(t);
        this.other = new (de().BrowserWindow)({ width: 300, webPreferences: { sandbox: false } });
      }
    }
    const main = new Main();
    const r = le();
    r.ipcMain.handle("get-data", () => 1);
    ae().ipcMain.on("set-data", (e, t) => {});
    main.win.webContents.send("pushed", 1);
    le().app.on("certificate-error", (e, t, n, r, o, i) => { i(!1); });
    de().app.on("certificate-error", (e, t, n, r, o, i) => { e.preventDefault(); i(!0); });
    ae().shell.openExternal("https://example.com/help");
    r.app.commandLine.appendSwitch("ignore-certificate-errors");
    main.win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    le().session.defaultSession.setPermissionRequestHandler((e, t, n) => n(!0));
  })();
})();
`;

const PRELOAD_EAGER = `const electron = require("electron");
electron.contextBridge.exposeInMainWorld("api", {
  getData: () => electron.ipcRenderer.invoke("get-data"),
  setData: (value) => electron.ipcRenderer.send("set-data", value),
  ipc: electron.ipcRenderer,
});
electron.ipcRenderer.on("pushed", () => {});
`;
const PRELOAD_LAZY = `const electron = () => require("electron");
electron().contextBridge.exposeInMainWorld("api", {
  getData: () => electron().ipcRenderer.invoke("get-data"),
  setData: (value) => electron().ipcRenderer.send("set-data", value),
  ipc: electron().ipcRenderer,
});
electron().ipcRenderer.on("pushed", () => {});
`;

const minified = (source: string): string =>
  // wrapped in a function so the minifier renames the getters too (`le` → `a`)
  transformSync(`(function () {${source}\n})();`, { minify: true, loader: "js" }).code;
function bundled(source: string): string {
  const src = mkdtempSync(join(dir, "src-"));
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, "main.js"), source);
  const outfile = join(src, "out.js");
  buildSync({
    entryPoints: [join(src, "main.js")],
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["electron"],
    outfile,
    logLevel: "silent",
  });
  return readFileSync(outfile, "utf8");
}

/**
 * The facts that must not depend on how electron is reached, without places. `renamed`: the
 * minifier renamed the window variables, so a window is named by the order it is constructed in
 * (`#1`), which minifying keeps.
 */
function facts(info: JsAppInfo, renamed = false) {
  const order = new Map(info.windows.map((w) => [w.windowName, `#${w.window}`]));
  const named = (name: string | null): string | null =>
    renamed ? (order.get(name) ?? `? ${name}`) : name;
  return {
    windows: info.windows
      .map((w) => ({
        name: named(w.windowName),
        nodeIntegration: w.nodeIntegration,
        contextIsolation: w.contextIsolation,
        sandbox: w.sandbox,
        preload: w.preload,
        computed: w.computed ?? [],
      }))
      .toSorted((a, b) => String(a.name).localeCompare(String(b.name))),
    webPreferences: info.webPreferences
      .map((p) => `${named(p.windowName)} ${p.key}=${JSON.stringify(p.value)}`)
      .toSorted(),
    ipcChannels: info.ipcChannels,
    switches: info.switches
      .map(
        (r) =>
          `${r.kind} ${r.name ?? "?"} ${r.accepts ?? "-"} ${String(r.dangerous)} ${r.targetKind}${r.preventsDefault ? " preventsDefault" : ""}`,
      )
      .toSorted(),
    openExternal: info.openExternal.map((r) => `${r.targetKind} ${r.argumentKind} ${r.argument}`),
    permissionHandlers: info.permissionHandlers.map(
      (h) => `${h.kind} ${h.targetKind} ${h.session} ${h.grants}`,
    ),
    navigationHandlers: info.navigationHandlers.map(
      (h) => `${h.kind} ${h.targetKind} ${named(h.window)} ${h.returns}`,
    ),
    contextBridge: info.contextBridge.map((b) => `${b.api}.${b.member} ${b.channel}`).toSorted(),
    bridgeExposures: info.bridgeExposures.map((b) => `${b.api}.${b.member} ${b.exposed}`),
  };
}

/** Written from the sources above. */
const EXPECTED = {
  windows: [
    {
      name: "other",
      nodeIntegration: "not written",
      contextIsolation: "not written",
      sandbox: false,
      preload: null,
      computed: [],
    },
    {
      name: "win",
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: "not written",
      preload: "preload.js",
      computed: [],
    },
  ],
  webPreferences: [
    "other sandbox=false",
    "win contextIsolation=false",
    "win nodeIntegration=true",
    'win preload="preload.js"',
  ],
  ipcChannels: [
    { channel: "get-data", senders: ["preload.js"], receivers: ["main.js"] },
    { channel: "pushed", senders: ["main.js"], receivers: ["preload.js"] },
    { channel: "set-data", senders: ["preload.js"], receivers: ["main.js"] },
  ],
  // the first handler passes false to its callback: it accepts nothing and gives no row
  switches: [
    "certificate-error ? always true app preventsDefault",
    "switch ignore-certificate-errors - true app",
  ],
  openExternal: ["shell literal https://example.com/help"],
  permissionHandlers: ["request session default always"],
  navigationHandlers: ["setWindowOpenHandler window win deny"],
  contextBridge: ["api.getData get-data", "api.ipc null", "api.setData set-data"],
  bridgeExposures: ["api.ipc ipcRenderer"],
};

/** The same, with `win` (constructed first) and `other` named by their order. */
const EXPECTED_RENAMED = {
  ...EXPECTED,
  windows: [
    { ...EXPECTED.windows[1]!, name: "#1" },
    { ...EXPECTED.windows[0]!, name: "#2" },
  ],
  webPreferences: [
    "#1 contextIsolation=false",
    "#1 nodeIntegration=true",
    '#1 preload="preload.js"',
    "#2 sandbox=false",
  ],
  navigationHandlers: ["setWindowOpenHandler window #1 deny"],
};

describe("electron through a lazy getter", () => {
  it("reads the reference (electron bound once) as written", () => {
    expect(facts(analyze(EAGER, PRELOAD_EAGER))).toEqual(EXPECTED);
  });

  const variants: Array<[string, string, boolean]> = [
    ["function getter", FUNCTION_GETTER, false],
    ["arrow getter", ARROW_GETTER, false],
    ["Babel lazy import", BABEL_LAZY, false],
    ["webpack 5 bundle (n.cw, () => n(id), n.n)", WEBPACK, false],
    ["function getter, bundled by esbuild", bundled(FUNCTION_GETTER), false],
    ["function getter, minified", minified(FUNCTION_GETTER), true],
    ["Babel lazy import, minified", minified(BABEL_LAZY), true],
    // the window variables are fields (`this.win`), which the minifier keeps
    ["webpack 5 bundle, minified", minified(WEBPACK), false],
  ];
  for (const [name, source, renamed] of variants)
    it(`reads ${name} as electron`, () => {
      expect(facts(analyze(source), renamed)).toEqual(renamed ? EXPECTED_RENAMED : EXPECTED);
    });

  it("takes the minified preload's getter for electron too", () => {
    expect(facts(analyze(minified(WEBPACK), minified(PRELOAD_LAZY)))).toEqual(EXPECTED);
  });

  it("reads the minified prints of the getters it is given", () => {
    // what the minifier writes, so the shapes above are the ones read
    expect(minified(BABEL_LAZY)).toMatch(/return \w+=function\(\)\{return \w+\},\w+\}/);
    expect(minified(WEBPACK)).toMatch(/new\(\w+\(\)\)\.BrowserWindow\(/);
  });

  it("does not take a getter of another module, a parameter or an unfinished factory for electron", () => {
    const info = analyze(`
const other = () => require("./electron-like");
const busy = n.cw(function (e) { e.exports = require("electron"); e.exports = {}; });
function self() { return self(); }
function withArg(x) { return require("electron"); }
const accept = (event, contents, url, error, certificate, callback) => { callback(true); };
other().app.on("certificate-error", accept);
busy().app.on("certificate-error", accept);
self().app.on("certificate-error", accept);
withArg().app.on("certificate-error", accept);
function register(get) { get().app.on("certificate-error", accept); }
other().app.commandLine.appendSwitch("ignore-certificate-errors");
other().shell.openExternal("https://example.com/");
`);
    // every receiver is unknown: the rows stay, but none is read as Electron's app or shell
    expect(info.switches.map((r) => `${r.kind} ${r.targetKind}`)).toEqual([
      "certificate-error unknown",
      "certificate-error unknown",
      "certificate-error unknown",
      "certificate-error unknown",
      "certificate-error unknown",
      "switch unknown",
    ]);
    expect(info.openExternal.map((r) => r.targetKind)).toEqual(["unknown"]);
  });

  it("does not take a write to a same-named variable of another function for one to the options", () => {
    // webpack's runtime writes its own `t` (`var t; … t = { exports: {} }`), as GitHub Desktop
    // 3.6.10 does, next to `const t = {…}; new r.BrowserWindow(t)` of 3.6.7's shape
    const info = analyze(`
const r = require("electron");
const wrap = (e) => { var t; return () => { t = { exports: {} }; t.webPreferences = {}; return t.exports; }; };
function open() {
  const t = { webPreferences: { nodeIntegration: true, sandbox: false } };
  return new r.BrowserWindow(t);
}
`);
    expect(info.windows.map((w) => [w.nodeIntegration, w.sandbox, w.computed ?? []])).toEqual([
      [true, false, []],
    ]);
  });

  it("does not take a parameter of the options' name declared after the window for a change", () => {
    // GitHub Desktop 3.6.7 and 3.6.10 both hand a callback `(t, n, r) => …` on right after
    // `this.window = new …BrowserWindow(t)`: its `t` is another variable
    const info = analyze(`
const r = require("electron");
const onEvent = (f) => f;
class Main {
  constructor() {
    const e = { width: 1 },
      t = { width: e.width, webPreferences: { nodeIntegration: true, contextIsolation: false } };
    this.window = new r.BrowserWindow(t);
    onEvent((t, n, r) => { t.webPreferences = n; });
    onEvent(function (t = {}) { return t; });
  }
}
`);
    expect(
      info.windows.map((w) => [w.nodeIntegration, w.contextIsolation, w.computed ?? []]),
    ).toEqual([[true, false, []]]);
  });

  it("keeps a write to the options' own name in scope as a change", () => {
    const info = analyze(`
const get = () => require("electron");
function open(flag) {
  const t = { webPreferences: { nodeIntegration: false } };
  t.webPreferences.nodeIntegration = flag;
  return new (get().BrowserWindow)(t);
}
`);
    expect(info.windows.map((w) => [w.nodeIntegration, w.computed])).toEqual([
      ["computed", expect.arrayContaining(["nodeIntegration"])],
    ]);
  });
});
