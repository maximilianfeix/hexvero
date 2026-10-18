import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildSync } from "esbuild";
import { afterAll, describe, expect, it } from "vitest";
import { analyzeJavaScriptTree, asarTree, type JsAppInfo } from "../src/javascript/app.js";
import { buildAsar } from "./fixtures/asar.js";

/**
 * Regressions from the review of the cross-module IPC rules (R1, R3, R4, R5): each case gave a
 * false row or lost a true one. Every case is read as written, bundled by esbuild and minified,
 * where a build of it makes sense. The expected rows are written from the fixture sources;
 * nothing is run.
 */

const dir = mkdtempSync(join(tmpdir(), "hexvero-real-ipc-review-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

type Files = Record<string, string>;

function analyze(files: Files): JsAppInfo {
  return analyzeJavaScriptTree(
    asarTree(
      buildAsar({ "package.json": JSON.stringify({ name: "r", main: "main.js" }), ...files }),
      "app.asar",
    ),
  );
}

/** Page scripts are bundled as browser scripts, everything else as CommonJS for node. */
const PAGE = /^(renderer|page|a|b|client|worker|shim)\b.*\.js$/;

function build(files: Files, minify: boolean): Files {
  const src = mkdtempSync(join(dir, "src-"));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(src, name)), { recursive: true });
    writeFileSync(join(src, name), text);
  }
  const out: Files = {};
  for (const name of Object.keys(files)) {
    if (!name.endsWith(".js") || name.includes("/")) {
      if (!name.endsWith(".js")) out[name] = files[name]!;
      continue;
    }
    const outfile = join(src, "out", name);
    const page = PAGE.test(name);
    buildSync({
      entryPoints: [join(src, name)],
      bundle: true,
      minify,
      platform: page ? "browser" : "node",
      format: page ? "iife" : "cjs",
      external: ["electron"],
      outfile,
      logLevel: "silent",
    });
    out[name] = readFileSync(outfile, "utf8");
  }
  return out;
}

/** The file set as written, bundled and minified. */
const builds = (files: Files): Array<[string, Files]> => [
  ["plain", files],
  ["bundled", build(files, false)],
  ["minified", build(files, true)],
];

/** `channel allowed` of the page script's rows through the bridge. */
const pageRows = (info: JsAppInfo, file = "renderer.js"): string[] =>
  info.modules
    .filter((m) => m.id === file)
    .flatMap((m) =>
      m.ipc.filter((u) => u.via === "bridge").map((u) => `${u.channel} ${u.allowed ?? "-"}`),
    )
    .toSorted();

const MAIN = `const { app, BrowserWindow } = require("electron");
const path = require("path");
app.whenReady().then(() => {
  const win = new BrowserWindow({ webPreferences: { preload: path.join(__dirname, "preload.js") } });
  win.loadFile("index.html");
});
`;
const forwarder = (member: string, extra = ""): Files => ({
  "main.js": MAIN,
  "preload.js": `const { contextBridge, ipcRenderer } = require("electron");
const L = ["a:one", "a:two"];
${extra}contextBridge.exposeInMainWorld("api", { ${member} });
`,
  "renderer.js": `window.api.call("a:one");\nwindow.api.call("z:bad");\n`,
});

describe("R1: a check of the channel is read only where it decides the call", () => {
  const guarded: Record<string, string> = {
    early: `call(ch, ...a) { if (!L.includes(ch)) return; return ipcRenderer.invoke(ch, ...a); }`,
    and: `call: (ch, ...a) => { L.includes(ch) && ipcRenderer.send(ch, ...a); }`,
    expression: `call: (ch, ...a) => L.includes(ch) && ipcRenderer.send(ch, ...a)`,
    // Element: statements that do not use the channel before the exit
    element: `call(ch, ...a) { if (!L.includes(ch)) { console.error("blocked"); return; } ipcRenderer.send(ch, ...a); }`,
  };
  const unguarded: Record<string, string> = {
    nested: `call(ch, ...a) { if (process.env.STRICT) { if (!L.includes(ch)) return; } return ipcRenderer.invoke(ch, ...a); }`,
    swallowed: `call(ch, ...a) { try { if (!L.includes(ch)) throw new Error("no"); } catch (e) { console.warn(e); } return ipcRenderer.invoke(ch, ...a); }`,
    inverted: `call(ch, ...a) { if (!L.includes(ch)) return ipcRenderer.invoke(ch, ...a); }`,
    invertedPrefix: `call(ch, ...a) { if (!ch.startsWith("a:")) return ipcRenderer.invoke(ch, ...a); }`,
    notAnd: `call: (ch, ...a) => { !L.includes(ch) && ipcRenderer.send(ch, ...a); }`,
    notAndExpression: `call: (ch, ...a) => !L.includes(ch) && ipcRenderer.send(ch, ...a)`,
    switchCase: `call(ch, ...a) { switch (mode) { case 1: if (!L.includes(ch)) return; } return ipcRenderer.invoke(ch, ...a); }`,
    loop: `call(ch, ...a) { for (const x of [1]) { if (!L.includes(ch)) return; } return ipcRenderer.invoke(ch, ...a); }`,
    logs: `call(ch, ...a) { if (L.includes(ch)) console.log(ch); ipcRenderer.send(ch, ...a); }`,
    value: `call(ch, ...a) { const ok = L.includes(ch); note(ok); ipcRenderer.send(ch, ...a); }`,
  };
  it("records an allow-list in its exact shapes, in every build", () => {
    for (const [name, member] of Object.entries(guarded))
      for (const [b, files] of builds(forwarder(member)))
        expect(pageRows(analyze(files)), `${name} ${b}`).toEqual(["a:one yes", "z:bad no"]);
  });
  it("reads any other use of the channel as an unknown check, in every build", () => {
    for (const [name, member] of Object.entries(unguarded))
      for (const [b, files] of builds(forwarder(member)))
        expect(pageRows(analyze(files)), `${name} ${b}`).toEqual([
          "a:one unknown",
          "z:bad unknown",
        ]);
  });
  it("takes no list a call may change (`Set.add`, `push`)", () => {
    const set = forwarder(
      `call(ch, ...a) { if (!S.has(ch)) return; return ipcRenderer.invoke(ch, ...a); }`,
      `const S = new Set(["a:one"]);\nS.add("z:bad");\n`,
    );
    for (const [b, files] of builds(set))
      expect(pageRows(analyze(files)), b).toEqual(["a:one unknown", "z:bad unknown"]);
  });
  it("reads forwarders through the electron module object (tsc, esbuild, minified)", () => {
    for (const pre of [
      `"use strict";\nconst electron_1 = require("electron");\nelectron_1.contextBridge.exposeInMainWorld("api", { call: (ch, ...a) => electron_1.ipcRenderer.invoke(ch, ...a) });\n`,
      `var import_electron = require("electron");\nimport_electron.contextBridge.exposeInMainWorld("api", { call: (ch, ...a) => import_electron.ipcRenderer.invoke(ch, ...a) });\n`,
      `var o=require("electron");o.contextBridge.exposeInMainWorld("api",{call:(e,...t)=>o.ipcRenderer.invoke(e,...t)});`,
    ])
      expect(pageRows(analyze({ ...forwarder(""), "preload.js": pre }))).toEqual([
        "a:one -",
        "z:bad -",
      ]);
  });
});

describe("R1: page scripts and preloads that may give the api something else", () => {
  const base = forwarder(`call: (ch, ...a) => ipcRenderer.invoke(ch, ...a)`);
  const classic = (html: string): JsAppInfo =>
    analyze({
      ...base,
      "index.html": html,
      "other.html": `<script src="other.js"></script>`,
      "client.js": `var api = { call: function (c) { return fetch("/" + c); } };\n`,
      "renderer.js": `api.call("w:global");\n`,
      "other.js": `window.api.call("w:other");\n`,
    });
  const together = classic(`<script src="client.js"></script><script src="renderer.js"></script>`);
  it("reads no call where a page script replaces the api, in every build", () => {
    for (const [name, page] of Object.entries({
      bracket: `window["api"] = { call: (c) => fetch(c) };\nwindow.api.call("w:x");\n`,
      assign: `Object.assign(window, { api: { call: (c) => fetch(c) } });\nwindow.api.call("w:x");\n`,
      define: `Object.defineProperty(window, "api", { value: { call: (c) => fetch(c) } });\nwindow.api.call("w:x");\n`,
    }))
      for (const [b, files] of builds({ ...base, "renderer.js": page }))
        expect(pageRows(analyze(files)), `${name} ${b}`).toEqual([]);
    // a classic script of the page that declares the global: the scripts of that page only
    expect(pageRows(together)).toEqual([]);
    expect(pageRows(together, "other.js")).toEqual(["w:other -"]);
    // no page read loads the script: the rows stay, and the write is named
    const unknown = classic(`<script src="renderer.js"></script>`);
    expect(pageRows(unknown)).toEqual(["w:global -"]);
    expect(unknown.limitations.map((l) => l.code)).toContain("bridge_global_written");
    // a write of the name inside a function, or of a local, is no global
    for (const [b, files] of builds({
      ...base,
      "renderer.js": `function f() { let api = 1; api = 2; return api; }\nconst g = (api) => { api = 3; return api; };\nf(); g();\nwindow.api.call("w:kept");\n`,
    }))
      expect(pageRows(analyze(files)), b).toEqual(["w:kept -"]);
  });
  it("names the files it does not read, by what is written, not by text", () => {
    const info = analyze({
      ...base,
      // a comment that names ipcMain and a file of the same name elsewhere are no reason
      "renderer.js": `// talks to ipcMain through the bridge\nwindow.api.call("ok:page");\nnew Worker("./w/worker.js");\n`,
      "w/worker.js": `self.api.call("w:worker");\n`,
      "worker.js": `window.api.call("ok:same-name");\n`,
      "with.js": `with (o) { api.call("w:with"); }\n`,
    });
    expect(pageRows(info)).toEqual(["ok:page -"]);
    expect(pageRows(info, "worker.js")).toEqual(["ok:same-name -"]);
    expect(pageRows(info, "w/worker.js")).toEqual([]);
    expect(pageRows(info, "with.js")).toEqual([]);
    const why = info.limitations.find((l) => l.code === "bridge_calls_unread")?.message ?? "";
    expect(why).toContain("w/worker.js (a worker script");
    expect(why).toContain("with.js (a with statement");
  });

  it("reads no call in a worker script or a main-process file", () => {
    const info = analyze({
      ...base,
      "renderer.js": `window.api.call("ok:page"); new Worker("worker.js");\n`,
      "worker.js": `self.api.call("w:worker");\n`,
      "lazy.js": `const { ipcMain } = require("electron");\nglobal.api = { call() {} };\napi.call("main:lazy");\n`,
    });
    expect(pageRows(info)).toEqual(["ok:page -"]);
    expect(pageRows(info, "worker.js")).toEqual([]);
    expect(pageRows(info, "lazy.js")).toEqual([]);
  });
  it("gives no rows where another preload exposes the api unreadably or by a spread", () => {
    for (const other of [
      `const { contextBridge, ipcRenderer } = require("electron");\nconst build = require("./build");\ncontextBridge.exposeInMainWorld("api", build(ipcRenderer));\n`,
      `const { contextBridge } = require("electron");\nconst extra = makeExtra();\ncontextBridge.exposeInMainWorld("api", { ...extra });\n`,
    ]) {
      const info = analyze({
        ...base,
        "preload2.js": other,
        "build.js": `module.exports = (ipc) => ({ call: (ch) => ipc.invoke("b:" + ch) });\n`,
      });
      expect(pageRows(info)).toEqual([]);
      expect(info.limitations.map((l) => l.code)).toContain("bridge_forwarder_ambiguous");
    }
  });
  it("stays bounded on a page with many aliases of the bridge", () => {
    // one name declared 24,000 times: every use was read against every declaration (29 s)
    const page = Array.from(
      { length: 24_000 },
      (_, i) => `var { api: e } = window;\ne.call("c${i % 50}");`,
    ).join("\n");
    const started = performance.now();
    const info = analyze({ ...base, "renderer.js": page });
    expect(performance.now() - started).toBeLessThan(8_000);
    expect(info.modules.find((m) => m.id === "renderer.js")).toBeDefined();
  });
});

describe("R4: the name guard keeps Electron's rows a module of the app hands on", () => {
  it("keeps the direct row unless the module exports a forwarder of that name", () => {
    const cases: Array<[string, Files, string]> = [
      [
        "named",
        {
          "main.js": `const { ipcMain } = require("./ipc-main");\nipcMain.handle("re:named", () => 1);\n`,
          "ipc-main.js": `exports.ipcMain = require("electron").ipcMain;\n`,
        },
        "re:named",
      ],
      [
        "whole",
        {
          "main.js": `const ipcMain = require("./ipc-main");\nipcMain.handle("re:cjs", () => 1);\n`,
          "ipc-main.js": `module.exports = require("electron").ipcMain;\n`,
        },
        "re:cjs",
      ],
      [
        "star",
        {
          "main.js": `const ipcMain = __importStar(require("./ipc-main"));\nipcMain.on("re:tsstar", () => 1);\n`,
          "ipc-main.js": `module.exports = require("electron").ipcMain;\n`,
        },
        "re:tsstar",
      ],
      [
        "destructured",
        {
          "main.js": `const { ipcMain } = require("./electron-wrap");\nipcMain.on("re:destr", () => 1);\n`,
          "electron-wrap.js": `module.exports = require("electron");\n`,
        },
        "re:destr",
      ],
      [
        "renderer",
        {
          "main.js": "",
          "renderer.js": `const { ipcRenderer } = require("./ipc");\nipcRenderer.send("re:renderer");\n`,
          "ipc.js": `module.exports = require("electron");\n`,
        },
        "re:renderer",
      ],
    ];
    // a name taken out of the module keeps its rows, also where the module exports a forwarder
    // of the method's name: it is the object the module exports under that name
    cases.push([
      "taken out",
      {
        "main.js": `const { ipcMain } = require("./ipc-main");\nipcMain.handle("re:taken", () => 1);\n`,
        "ipc-main.js": `const electron = require("electron");\nfunction handle(channel, fn) { electron.ipcMain.handle(channel, fn); }\nexports.handle = handle;\nexports.ipcMain = electron.ipcMain;\n`,
      },
      "re:taken",
    ]);
    for (const [name, files, channel] of cases)
      expect(
        analyze(files).ipcChannels.map((c) => c.channel),
        name,
      ).toEqual([channel]);
  });
});

const wrapperRows = (info: JsAppInfo): string[] =>
  info.modules.flatMap((m) => m.ipc.filter((u) => u.via === "wrapper").map((u) => `${u.channel}`));

const exposed = (files: Files): string[] =>
  analyze({
    "package.json": JSON.stringify({ name: "x", main: "main.js", type: "module" }),
    "main.js": "",
    ...files,
  }).contextBridge.map((b) => `${b.member}=${b.channel}`);

const caller = (main: string, ipc: string): Files => ({ "main.js": main, "ipc.js": ipc });

describe("R4: forwarders that may not be what is called", () => {
  it("gives no rows for a key defined twice, one the importer replaces, or a shadowed parameter", () => {
    const twice = caller(
      `const { addHandler } = require("./ipc");\naddHandler("cjs:x", () => 1);\n`,
      `const { ipcMain } = require("electron");\nfunction a(channel, h) { ipcMain.handle(channel, h); }\nexports.addHandler = a;\nexports.addHandler = (c, h) => ipcMain.on("fixed", h);\n`,
    );
    const replaced = caller(
      `const ipc = require("./ipc");\nipc.addHandler = (c, h) => 1;\nipc.addHandler("cjs:mut", () => 1);\n`,
      `const { ipcMain } = require("electron");\nfunction a(channel, h) { ipcMain.handle(channel, h); }\nmodule.exports = { addHandler: a };\n`,
    );
    const shadowed = caller(
      `const { addHandler } = require("./ipc");\naddHandler("sh:x", () => 1);\n`,
      `const { ipcMain } = require("electron");\nfunction addHandler(channel, handler) { ["fixed:a"].forEach((channel) => ipcMain.handle(channel, handler)); }\nexports.addHandler = addHandler;\n`,
    );
    for (const [name, files] of Object.entries({ twice, replaced, shadowed }))
      expect(wrapperRows(analyze(files)), name).toEqual([]);
  });
});

const each = (files: Files): Array<[string, string[]]> => [
  ["plain", exposed(files)],
  ...[false, true].map((minify): [string, string[]] => [
    minify ? "minified" : "bundled",
    analyze({ "main.js": "", ...build({ ...files, "main.js": "" }, minify) }).contextBridge.map(
      (b) => `${b.member}=${b.channel}`,
    ),
  ]),
];
describe("R3: an exported object changed through another name", () => {
  const E = `import { ipcRenderer } from "electron";\n`;
  const plat = (tail: string): Files => ({
    "preload.js": `import { contextBridge } from "electron";\nimport { platform } from "./plat.js";\ncontextBridge.exposeInMainWorld("api", { platform });\n`,
    "plat.js": `${E}export const platform = { a: () => ipcRenderer.invoke("ok:a") };\n${tail}`,
  });
  /** The members in each build: plain ES modules, and the preload bundled (plain, minified). */
  it("does not read the object as written", () => {
    // a module that imports it as a namespace writes a member
    expect(
      exposed({
        "preload.js": `import { contextBridge } from "electron";\nimport { api } from "./base.js";\nimport "./patch.js";\ncontextBridge.exposeInMainWorld("api", api);\n`,
        "base.js": `${E}export const api = { a: () => ipcRenderer.send("ok:a") };\n`,
        "patch.js": `${E}import * as base from "./base.js";\nbase.api.a = () => ipcRenderer.send("evil:a");\n`,
      }),
    ).toEqual(["null=null"]);
    for (const [name, tail] of Object.entries({
      alias: `const p = platform;\np.a = () => ipcRenderer.invoke("evil:a");\n`,
      call: `function patch(o) { o.a = () => ipcRenderer.invoke("evil:a"); }\npatch(platform);\n`,
      // a local function named like a read-only call, and a shadowed console
      localLog: `function log(t) { t.a = () => ipcRenderer.invoke("evil:a"); }\nlog(platform);\n`,
      localConsole: `const console = { log(t) { t.a = () => ipcRenderer.invoke("evil:a"); } };\nconsole.log(platform);\n`,
      // a function of the file named like contextBridge's method
      fakeExpose: `function exposeInMainWorld(k, o) { o.a = () => ipcRenderer.invoke("evil:a"); }\nexposeInMainWorld("x", platform);\n`,
      // held by an object that is changed, or chosen by an operator
      holder: `const box = { platform };\nbox.platform.a = () => ipcRenderer.invoke("evil:a");\n`,
      operator: `const q = globalThis.x || platform;\nq.a = () => ipcRenderer.invoke("evil:a");\n`,
    }))
      for (const [b, rows] of each(plat(tail)))
        expect(rows, `${name} ${b}`).not.toContain("platform.a=ok:a");
  });
  it("reads it where it is only read", () => {
    for (const [name, tail] of Object.entries({
      none: "",
      frozen: `Object.freeze(platform);\nconsole.log(platform);\n`,
    }))
      for (const [b, rows] of each(plat(tail)))
        expect(rows, `${name} ${b}`).toEqual(["platform.a=ok:a"]);
  });
});

describe("R5: one load per file, and a webpack module", () => {
  it("gives one use row per file and reads the main module through webpack's require", () => {
    const info = analyze({
      "main.js": `(()=>{var m={12:e=>{"use strict";e.exports=require("@electron/remote/main")}},c={};function n(t){var r=c[t];if(r!==undefined)return r.exports;var i=c[t]={exports:{}};return m[t](i,i.exports,n),i.exports}var a=n(12);const e=require("electron");a.initialize();let w=new e.BrowserWindow({});a.enable(w.webContents)})();`,
      "renderer.js": `const { dialog } = require("@electron/remote");\nconst r = require("@electron/remote/renderer");\n`,
    });
    expect(info.remoteEnabled.map((r) => `${r.kind} ${r.file}`)).toEqual([
      "initialize main.js",
      "enable main.js",
      "use renderer.js",
    ]);
  });
});
