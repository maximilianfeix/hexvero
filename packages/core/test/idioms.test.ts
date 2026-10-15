import { describe, expect, it } from "vitest";
import { analyzeJavaScriptTree, asarTree, bridgeMembers } from "../src/javascript/app.js";
import { compareItems, positionalFields } from "../src/compare.js";
import { buildAsar } from "./fixtures/asar.js";

/** Analysis of an app made of these files; `package.json` is added. */
function analyze(files: Record<string, string>): ReturnType<typeof analyzeJavaScriptTree> {
  return analyzeJavaScriptTree(
    asarTree(
      buildAsar({ "package.json": JSON.stringify({ name: "x", main: "main.js" }), ...files }),
      "app.asar",
    ),
  );
}

const channels = [
  "class Library {",
  '  static LIST = "library:list";',
  '  static REFRESH = "library:refresh";',
  "}",
  'const Playback = Object.freeze({ STATE: "playback:state" });',
  "module.exports = { Library, Playback };",
].join("\n");

const app = analyze({
  "shared/channels.js": channels,
  // A module that passes everything of another one on.
  "shared/index.js": 'const channels = require("./channels");\nmodule.exports = { ...channels };',
  "main.js": [
    'const { ipcMain } = require("electron");',
    'const { Library, Playback } = require("./shared");',
    "const routes = [",
    "  [Library.LIST, () => []],",
    '  ["library:add", () => 1],',
    "];",
    "const more = new Map([[Library.REFRESH, () => 0]]);",
    "for (const [channel, fn] of routes) ipcMain.handle(channel, fn);",
    "for (const [channel, fn] of more) ipcMain.handle(channel, fn);",
    'ipcMain.on("player:hello", (event) => {',
    "  event.reply(Playback.STATE, {});",
    "});",
  ].join("\n"),
  "preload.js": [
    'const { contextBridge, ipcRenderer } = require("electron");',
    'const { Library } = require("./shared/channels");',
    "const call = (ch) => (...a) => ipcRenderer.invoke(ch, ...a);",
    "const base = { list: call(Library.LIST) };",
    'const extra = { add: () => ipcRenderer.invoke("library:add") };',
    'contextBridge.exposeInMainWorld("lib", Object.assign(base, extra));',
    "contextBridge.exposeInMainWorld(",
    '  "player",',
    '  Object.freeze({ hello: () => ipcRenderer.send("player:hello") }),',
    ");",
  ].join("\n"),
});

/** An app whose window takes its base from another module; `sandbox` is the override. */
const externalBaseApp = (sandbox: string) => ({
  "config/windows.js": [
    "const secure = Object.freeze({ contextIsolation: true, nodeIntegration: false, sandbox: true });",
    "const frame = { width: 800, webPreferences: { spellcheck: false } };",
    "module.exports = { secure, frame };",
  ].join("\n"),
  "main.js": [
    'import { BrowserWindow } from "electron";',
    'import windowConfig from "./config/windows.js";',
    "class Main {",
    "  options = {",
    "    ...windowConfig.frame,",
    `    webPreferences: Object.assign({ preload: "p.js" }, windowConfig.secure, { sandbox: ${sandbox} }),`,
    "  };",
    "  open() { this.window = new BrowserWindow(this.options); }",
    "}",
  ].join("\n"),
});

describe("idioms of channel and bridge definitions", () => {
  it("reads members of objects exposed through Object.assign and Object.freeze", () => {
    expect(app.contextBridge.map((b) => `${b.api}.${b.member} ${b.channel}`)).toEqual([
      "lib.list library:list",
      "lib.add library:add",
      "player.hello player:hello",
    ]);
  });

  it("reads static string fields of a class as a table, also through a spread re-export", () => {
    const main = app.modules.find((m) => m.id === "main.js")!;
    expect(main.ipc.map((u) => `${u.api} ${u.channel}`)).toEqual([
      "ipcMain.handle library:list",
      "ipcMain.handle library:add",
      "ipcMain.handle library:refresh",
      "ipcMain.on player:hello",
      "event.reply playback:state",
    ]);
  });

  it("never claims members for an exposed value it cannot read whole", () => {
    const other = analyze({
      "main.js": "",
      "preload.js": [
        'const { contextBridge } = require("electron");',
        'contextBridge.exposeInMainWorld("api", Object.assign(makeApi(), { a: () => 1 }));',
      ].join("\n"),
    });
    expect(other.contextBridge).toEqual([
      expect.objectContaining({ api: "api", member: null, channel: null }),
    ]);
  });

  it("follows tables through a bundler's module wrappers, also minified", () => {
    const bundled = [
      'var { ipcMain } = require("electron");',
      "var require_channels = __commonJS({",
      '  "src/channels.js"(exports2, module2) {',
      '    var Library2 = class { static LIST = "library:list"; };',
      '    var PREFIX2 = "download:";',
      "    module2.exports = { Library: Library2, PREFIX: PREFIX2 };",
      "  }",
      "});",
      "var require_shared = __commonJS({",
      '  "src/shared.js"(exports2, module2) {',
      "    var channels = require_channels();",
      "    module2.exports = { ...channels };",
      "  }",
      "});",
      "var { Library, PREFIX } = require_shared();",
      "ipcMain.handle(Library.LIST, () => 1);",
      "ipcMain.handle(`${PREFIX}cancel`, () => 1);",
    ].join("\n");
    const minified =
      'var y=(t,e)=>()=>e||t((e={exports:{}}).exports,e),e.exports;var p=y((C,S)=>{var c=class{static LIST="library:list"},P="download:";S.exports={Library:c,PREFIX:P}});var{ipcMain:a}=require("electron"),{Library:r,PREFIX:I}=p(),m=new Map([[r.LIST,()=>1]]);for(const[k,f]of m)a.handle(k,f);a.handle(`${I}cancel`,()=>1);';
    for (const main of [bundled, minified]) {
      const info = analyze({ "main.js": main });
      expect(info.modules[0]!.ipc.map((u) => u.channel)).toEqual([
        "library:list",
        "download:cancel",
      ]);
    }
  });

  it("does not take a loop variable or a reused short name for another object of the file", () => {
    const loop = bridgeMembers(
      'var n={__SENTRY__:{},sentry_key:"k"};function f(e,u){for(let[t,n]of Object.entries(u))e.contextBridge.exposeInMainWorld(t,n)}',
      "p.js",
    );
    expect(loop.members.map((m) => `${m.api}.${m.member}`)).toEqual(["[t].null"]);
    const reused = bridgeMembers(
      'function a(){var c={x:1};return c}var c=compute(process.argv);contextBridge.exposeInMainWorld("flag",c);',
      "p.js",
    );
    expect(reused.members.map((m) => `${m.api}.${m.member}`)).toEqual(["flag.null"]);
    // Declared once, the object is still followed.
    const once = bridgeMembers(
      'const api={open(){}};contextBridge.exposeInMainWorld("app",api);',
      "p.js",
    );
    expect(once.members.map((m) => `${m.api}.${m.member}`)).toEqual(["app.open"]);
  });

  it("lays Object.assign arguments over a frozen base in webPreferences, the later one winning", () => {
    const info = analyze({
      "main.js": [
        'const { BrowserWindow } = require("electron");',
        "const SAFE = Object.freeze({ contextIsolation: true, sandbox: true });",
        "const win = new BrowserWindow({",
        "  webPreferences: Object.assign({}, SAFE, { sandbox: false }),",
        "});",
        "const later = new BrowserWindow({",
        "  webPreferences: Object.assign({}, { sandbox: false }, SAFE),",
        "});",
      ].join("\n"),
    });
    const summary = (name: string) => {
      const w = info.windows.find((x) => x.windowName === name)!;
      return `${w.contextIsolation} ${w.sandbox} ${w.computed ?? "-"}`;
    };
    expect(summary("win")).toBe("true false -");
    expect(summary("later")).toBe("true true -");
  });

  it("reads windows a factory of another module builds, with rest parameters and ??", () => {
    const info = analyze({
      "lib/factory.js": [
        "const DEFAULTS = Object.freeze({ contextIsolation: true, sandbox: true, webSecurity: true });",
        "function makeWindow({ preload, sandbox, ...more } = {}) {",
        "  return { webPreferences: { ...DEFAULTS, ...more, preload, sandbox: sandbox ?? DEFAULTS.sandbox } };",
        "}",
        "module.exports = { makeWindow };",
      ].join("\n"),
      "main.js": [
        'const { BrowserWindow } = require("electron");',
        'const { makeWindow } = require("./lib/factory");',
        "const print = new BrowserWindow(makeWindow({ webSecurity: false }));",
        "const open = new BrowserWindow(makeWindow({ sandbox: false }));",
      ].join("\n"),
    });
    const settings = (name: string) =>
      info.webPreferences
        .filter((p) => p.windowName === name)
        .map((p) => `${p.key}=${p.value}`)
        .toSorted();
    expect(settings("print")).toEqual([
      "contextIsolation=true",
      "sandbox=true",
      "webSecurity=false",
    ]);
    expect(settings("open")).toEqual([
      "contextIsolation=true",
      "sandbox=false",
      "webSecurity=true",
    ]);
    // The factory's defaults are those windows' settings, not a second, windowless row.
    expect(info.webPreferences.filter((p) => p.window === null && p.value !== null)).toEqual([]);
  });

  it("reads new URL(template, base) with a gap in the path, never with a gap that may be the origin", () => {
    const info = analyze({
      "main.js": [
        'const BASE = "https://sync.example/api/";',
        "async function push(board, host) {",
        "  await fetch(new URL(`boards/${encodeURIComponent(board.id)}`, BASE));",
        "  await fetch(new URL(`${host}/status`, BASE));",
        "}",
      ].join("\n"),
    });
    expect(info.endpoints.map((e) => `${e.evidence} ${e.value}`)).toEqual([
      "template https://sync.example/api/boards/${…}",
      "unknown null",
    ]);
  });

  it("applies a window base another module exports, at the level it is used", () => {
    const info = analyze(externalBaseApp("false"));
    const w = info.windows[0]!;
    expect([w.nodeIntegration, w.contextIsolation, w.sandbox, w.preload]).toEqual([
      false,
      true,
      false,
      "p.js",
    ]);
    // Moving the base's lines in its own module is no change of the window.
    const moved = analyze({
      ...externalBaseApp("false"),
      "config/windows.js": `// moved\n// down\n${externalBaseApp("false")["config/windows.js"]}`,
    });
    const diff = compareItems(info.webPreferences, moved.webPreferences, {
      collection: "webPreferences",
      positional: positionalFields("webPreferences", []),
    });
    expect([diff.added, diff.removed, diff.changed]).toEqual([[], [], []]);
  });
});
