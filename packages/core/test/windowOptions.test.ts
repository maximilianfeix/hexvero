import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildSync } from "esbuild";
import { afterAll, describe, expect, it } from "vitest";
import { analyzeJavaScriptTree, asarTree, type JsAppInfo } from "../src/javascript/app.js";
import { buildAsar } from "./fixtures/asar.js";

/**
 * Window options built from module constants: `Object.assign({}, A, B, {…})`, `{ ...A, k: v }`,
 * the shorthand `{ webPreferences }`, class fields and constructor assignments read through
 * `this.x`, and factories. The expected facts are written from the fixture sources; nothing of
 * them is run.
 */

const dir = mkdtempSync(join(tmpdir(), "hexvero-window-options-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function analyze(files: Record<string, string>): JsAppInfo {
  return analyzeJavaScriptTree(
    asarTree(
      buildAsar({
        "package.json": JSON.stringify({
          name: "w",
          main: "main.js",
          devDependencies: { electron: "^38.0.0" },
        }),
        ...files,
      }),
      "app.asar",
    ),
  );
}

/** One main file; `BrowserWindow` is taken from electron. */
const one = (main: string): JsAppInfo =>
  analyze({ "main.js": `const { BrowserWindow } = require("electron");\n${main}` });

/** The fixture sources bundled by esbuild into main.js, optionally minified. */
function bundled(sources: Record<string, string>, minify: boolean): Record<string, string> {
  const src = mkdtempSync(join(dir, "src-"));
  for (const [name, text] of Object.entries(sources)) {
    mkdirSync(dirname(join(src, name)), { recursive: true });
    writeFileSync(join(src, name), text);
  }
  const outfile = join(src, "out", "main.js");
  buildSync({
    entryPoints: [join(src, "main.js")],
    bundle: true,
    minify,
    platform: "node",
    format: "cjs",
    external: ["electron"],
    outfile,
    logLevel: "silent",
  });
  return { "main.js": readFileSync(outfile, "utf8") };
}

/** `ni ci sb pre web` of every window, in source order. */
const states = (info: JsAppInfo): string[] =>
  info.windows.map((w) => {
    const web = info.webPreferences.filter(
      (p) => p.file === w.file && p.window === w.window && p.key === "webSecurity",
    );
    const webSecurity = w.computed?.includes("webSecurity")
      ? "computed"
      : web.length === 1
        ? String(web[0]!.value)
        : web.length
          ? "several"
          : "not written";
    return `${w.nodeIntegration} ${w.contextIsolation} ${w.sandbox} ${w.preload} ${webSecurity}`;
  });

const PREFS = `"use strict";
// Shared by every window that shows user content.
const SECURE = Object.freeze({
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
});
module.exports = { SECURE, LOOSE: { contextIsolation: true, sandbox: false } };
`;

const WINDOWS = `"use strict";
const path = require("node:path");
const { BrowserWindow } = require("electron");
const { SECURE, LOOSE } = require("./prefs");

const LOCAL = { nodeIntegration: false, webSecurity: true };

function openLedger() {
  // the later source wins: sandbox is false here
  const options = Object.assign({}, SECURE, { preload: path.join(__dirname, "ledger-preload.js") }, { sandbox: false });
  return new BrowserWindow({ width: 900, show: false, webPreferences: options });
}

function openReport() {
  const webPreferences = { ...SECURE, webSecurity: false };
  return new BrowserWindow({ width: 600, webPreferences });
}

class AuditWindow {
  constructor() {
    this.options = {
      width: 700,
      webPreferences: { ...LOCAL, contextIsolation: true, preload: path.join(__dirname, "audit-preload.js") },
    };
    this.win = null;
  }
  open() {
    if (this.win) return this.win;
    this.win = new BrowserWindow(this.options);
    return this.win;
  }
}

class ChartWindow {
  prefs = Object.assign({}, LOCAL, LOOSE, { nodeIntegration: false });
  win = null;
  show() {
    this.win = new BrowserWindow({ width: 400, webPreferences: this.prefs });
    return this.win;
  }
}

function settingsPrefs() {
  return { ...SECURE, preload: path.join(__dirname, "settings-preload.js") };
}

function openSettings() {
  return new BrowserWindow({ width: 500, webPreferences: settingsPrefs() });
}

module.exports = { openLedger, openReport, openSettings, audit: new AuditWindow(), chart: new ChartWindow() };
`;

const MAIN = `"use strict";
const { app } = require("electron");
const windows = require("./main/windows");
app.whenReady().then(() => {
  windows.openLedger();
  windows.openReport();
  windows.openSettings();
  windows.audit.open();
  windows.chart.show();
});
`;

const SOURCES = { "main.js": MAIN, "main/windows.js": WINDOWS, "main/prefs.js": PREFS };

/** Written from the sources above, window by window in source order. */
const EXPECTED = [
  // openLedger: SECURE, then the preload, then sandbox: false over SECURE's sandbox: true
  "false true false ledger-preload.js not written",
  // openReport: SECURE spread, webSecurity written after it
  "false true true null false",
  // AuditWindow: LOCAL spread, contextIsolation and preload after it; no sandbox anywhere
  "false true not written audit-preload.js true",
  // ChartWindow: LOCAL, then LOOSE (contextIsolation true, sandbox false), then nodeIntegration
  "false true false null true",
  // settingsPrefs(): SECURE and a preload
  "false true true settings-preload.js not written",
];

/** An ES module main file that default-imports prefs.js. */
const esmSources = (prefs: string): Record<string, string> => ({
  "main.js": [
    'import { BrowserWindow } from "electron";',
    'import prefs from "./prefs.js";',
    "export function open() {",
    "  return new BrowserWindow({ webPreferences: { ...prefs.SECURE, nodeIntegration: false } });",
    "}",
  ].join("\n"),
  "prefs.js": prefs,
});

describe("window options built from constants, fields and factories", () => {
  it("reads them across modules in the plain build", () => {
    const info = analyze(SOURCES);
    expect(states(info)).toEqual(EXPECTED);
    expect(info.limitations.map((l) => l.code)).not.toContain("window_options_unresolved");
  });

  it("reads the same settings in an esbuild bundle, plain and minified", () => {
    for (const minify of [false, true]) {
      const info = analyze(bundled(SOURCES, minify));
      expect(states(info), minify ? "minified" : "bundled").toEqual(EXPECTED);
    }
  });

  it("reads the default import of a CommonJS module through esbuild's interop helper", () => {
    // a plain CommonJS module: its `default` is module.exports itself
    const plain = esmSources(
      "module.exports = { SECURE: { sandbox: true, contextIsolation: true } };",
    );
    for (const minify of [false, true])
      expect(states(analyze(bundled(plain, minify))), String(minify)).toEqual([
        "false true true null not written",
      ]);
    // a module that says it is an ES module: its `default` is what it exports as default
    const esm = esmSources(
      'Object.defineProperty(exports, "__esModule", { value: true });\nexports.SECURE = { sandbox: true, contextIsolation: true };\nexports.default = { SECURE: { sandbox: false, contextIsolation: true } };',
    );
    for (const minify of [false, true])
      expect(states(analyze(bundled(esm, minify))), String(minify)).toEqual([
        "false true false null not written",
      ]);
  });

  it("reads the shorthand { webPreferences } like webPreferences: webPreferences", () => {
    expect(
      states(
        one(
          "const BASE = Object.freeze({ sandbox: true, contextIsolation: true });\nfunction f() { const webPreferences = Object.assign({}, BASE, { sandbox: false }); return new BrowserWindow({ width: 1, webPreferences }); }",
        ),
      ),
    ).toEqual(["not written true false null not written"]);
    // a shorthand of something that cannot be read is not the same as no webPreferences at all
    const unknown = one(
      "function f(webPreferences) { return new BrowserWindow({ width: 1, webPreferences }); }\nf(loadPrefs());",
    );
    expect(states(unknown)).toEqual(["computed computed computed null computed"]);
    expect(unknown.limitations.map((l) => l.code)).toContain("window_options_unresolved");
  });

  it("follows the binding a name has where it is used, not another of the same name", () => {
    // an inner declaration shadows the outer one
    const shadowed = one(
      [
        "const BASE = { sandbox: true, contextIsolation: true };",
        "function f() { const BASE = { sandbox: false, contextIsolation: true }; return new BrowserWindow({ webPreferences: { ...BASE } }); }",
        "const top = new BrowserWindow({ webPreferences: BASE });",
      ].join("\n"),
    );
    expect(states(shadowed)).toEqual([
      "not written true false null not written",
      "not written true true null not written",
    ]);
    // a parameter of the same name, with no caller that can be read: not the constant
    const param = one(
      "const BASE = { sandbox: true };\nfunction f(BASE) { return new BrowserWindow({ webPreferences: Object.assign({}, BASE) }); }\nf(userPrefs);",
    );
    expect(states(param)).toEqual(["computed computed computed null computed"]);
    // a minifier's short name reused in another function does not change the window's object
    const minified = one(
      'const K=Object.freeze({contextIsolation:!0,sandbox:!0});function a(){let e=Object.assign({},K,{sandbox:!1});return new BrowserWindow({webPreferences:e})}function b(e){e.sandbox=!0;e.on("x",()=>{})}',
    );
    expect(states(minified)).toEqual(["not written true false null not written"]);
  });

  it("reads a value as unknown when a base or the merged object may be changed", () => {
    // the base changed after the merge
    const base = one(
      "const BASE = { sandbox: true, contextIsolation: true };\nconst prefs = Object.assign({}, BASE, { nodeIntegration: false });\nBASE.sandbox = false;\nconst w = new BrowserWindow({ webPreferences: prefs });",
    );
    expect(states(base)).toEqual(["false true computed null not written"]);
    // the merged object changed
    const merged = one(
      "const BASE = { sandbox: true };\nconst prefs = Object.assign({}, BASE);\nprefs.sandbox = false;\nconst w = new BrowserWindow({ webPreferences: prefs });",
    );
    expect(states(merged)).toEqual(["not written not written computed null not written"]);
    // handed to a function that may change it
    const handed = one(
      "const BASE = { sandbox: true };\nconst prefs = { ...BASE };\ntweak(prefs);\nconst w = new BrowserWindow({ webPreferences: prefs });",
    );
    expect(states(handed)).toEqual(["computed computed computed null computed"]);
    // a class field written elsewhere, or a key of it changed
    for (const change of [
      "reset() { this.prefs = loadPrefs(); }",
      "loosen() { this.prefs.sandbox = false; }",
      "share() { tweak(this.prefs); }",
    ])
      expect(
        states(
          one(
            `class W {\n  prefs = { sandbox: true, contextIsolation: true };\n  open() { this.win = new BrowserWindow({ webPreferences: this.prefs }); }\n  ${change}\n}`,
          ),
        ),
        change,
      ).not.toContain("not written true true null not written");
    // changed from outside, through an instance
    const outside = one(
      "class W {\n  prefs = { sandbox: true };\n  open() { this.win = new BrowserWindow({ webPreferences: this.prefs }); }\n}\nconst w = new W();\nw.prefs.sandbox = false;",
    );
    expect(states(outside)[0]).not.toContain("true null");
    // assigned twice in the constructor
    const twice = one(
      "class W {\n  constructor(dev) { this.options = { webPreferences: { sandbox: true } }; if (dev) this.options = devOptions; }\n  open() { this.win = new BrowserWindow(this.options); }\n}",
    );
    expect(states(twice)).toEqual(["computed computed computed null computed"]);
  });

  it("makes a key unknown when something unknown is spread or assigned after it", () => {
    expect(
      states(
        one(
          "const w = new BrowserWindow({ webPreferences: { sandbox: true, contextIsolation: true, ...userPrefs } });",
        ),
      ),
    ).toEqual(["computed computed computed null computed"]);
    expect(
      states(
        one(
          "const BASE = { sandbox: true };\nconst prefs = Object.assign({}, BASE, loadPrefs(), { contextIsolation: true });\nconst w = new BrowserWindow({ webPreferences: prefs });",
        ),
      ),
    ).toEqual(["computed true computed null computed"]);
    // in a class field, too
    expect(
      states(
        one(
          "class W {\n  prefs = { sandbox: true, ...this.extra, contextIsolation: true };\n  open() { this.win = new BrowserWindow({ webPreferences: this.prefs }); }\n}",
        ),
      ),
    ).toEqual(["computed true computed null computed"]);
  });

  it("reads a factory that merges a base, and a static field or a getter not at all", () => {
    expect(
      states(
        one(
          "const BASE = Object.freeze({ sandbox: true, contextIsolation: true });\nfunction prefs() { return Object.assign({}, BASE, { sandbox: false }); }\nconst w = new BrowserWindow({ webPreferences: prefs() });",
        ),
      ),
    ).toEqual(["not written true false null not written"]);
    expect(
      states(
        one(
          "class W {\n  static prefs = { sandbox: true };\n  open() { this.win = new BrowserWindow({ webPreferences: this.prefs }); }\n}",
        ),
      ),
    ).toEqual(["computed computed computed null computed"]);
    expect(
      states(
        one(
          "class W {\n  get prefs() { return { sandbox: true }; }\n  open() { this.win = new BrowserWindow({ webPreferences: this.prefs }); }\n}",
        ),
      ),
    ).toEqual(["computed computed computed null computed"]);
  });

  it("does not attach a webPreferences object to no window when a later window takes it", () => {
    const info = one(
      "const BASE = { sandbox: true };\nclass W {\n  constructor() { this.options = { webPreferences: { ...BASE, sandbox: false } }; }\n  open() { this.win = new BrowserWindow(this.options); }\n}",
    );
    expect(info.webPreferences.map((p) => `${p.windowName} ${p.key}=${p.value}`)).toEqual([
      "win sandbox=false",
    ]);
  });
});
