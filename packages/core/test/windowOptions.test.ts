import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildSync } from "esbuild";
import { afterAll, describe, expect, it } from "vitest";
import { Constants } from "../src/javascript/aliases.js";
import { analyzeJavaScriptTree, asarTree, type JsAppInfo } from "../src/javascript/app.js";
import { ExpressionResolver } from "../src/javascript/resolve.js";
import { tokenize } from "../src/javascript/scan.js";
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
function bundled(
  sources: Record<string, string>,
  minify: boolean,
  /** An older target makes esbuild lower `?.` (`es2019`). */
  target?: string,
): Record<string, string> {
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
    ...(target ? { target } : {}),
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
  // AuditWindow and ChartWindow take `this.options` / `this.prefs`: a field of an object is not
  // read (it can be changed in ways a reading of the text does not see)
  "computed computed computed null computed",
  "computed computed computed null computed",
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
    // the two windows that take a class field are named as not followed
    expect(info.limitations.find((l) => l.code === "window_options_unresolved")?.message).toContain(
      "2 window(s)",
    );
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

  it("reads the node mode of esbuild's interop helper, and nothing when it is not a literal", () => {
    const esm = esmSources(
      'Object.defineProperty(exports, "__esModule", { value: true });\nexports.SECURE = { sandbox: true, contextIsolation: true };\nexports.default = { SECURE: { sandbox: false, contextIsolation: true } };',
    );
    const main = bundled(esm, false)["main.js"]!;
    expect(main).toMatch(/__toESM\(require_prefs\(\)\)/);
    const withMode = (mode: string): string[] =>
      states(
        analyze({
          "main.js": main.replace(
            /__toESM\(require_prefs\(\)\)/,
            `__toESM(require_prefs(), ${mode})`,
          ),
        }),
      );
    // node mode: `default` is module.exports, whatever the module says it is
    expect(withMode("1")).toEqual(["false true true null not written"]);
    expect(withMode("0")).toEqual(["false true false null not written"]);
    // not a literal: either may hold
    expect(withMode("isNode")).toEqual(["false computed computed null computed"]);
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
    // reached by a computed member access: the field's name as a key, or a key not known
    for (const change of [
      'loosen() { this["prefs"].nodeIntegration = true; }',
      'reset() { this["prefs"] = { nodeIntegration: true }; }',
      "set(key, v) { this[key] = v; }",
      "static patch(obj, k) { obj[k].nodeIntegration = true; }",
      'static name() { return ["prefs"]; }',
    ]) {
      const info = one(
        `class W {\n  prefs = { nodeIntegration: false, contextIsolation: true };\n  open() { this.win = new BrowserWindow({ webPreferences: this.prefs }); }\n  ${change}\n}`,
      );
      expect(states(info), change).toEqual(["computed computed computed null computed"]);
      expect(
        info.webPreferences.filter((p) => p.value !== null),
        change,
      ).toEqual([]);
    }
    // a write into a list or object the code creates there, a pattern or a list literal is none
    const fresh = one(
      "class W {\n  prefs = { nodeIntegration: false };\n  open() { this.win = new BrowserWindow({ webPreferences: this.prefs }); }\n}\nfunction f(k, list) { const seen = {}; seen[k] = 1; const [first] = list; return [first]; }",
    );
    expect(states(fresh)).toEqual(["computed computed computed null computed"]);
    // the same through the constructor's `this.options = …`, changed from outside
    const outer = one(
      'class W {\n  constructor() { this.options = { webPreferences: { nodeIntegration: false } }; }\n  open() { this.win = new BrowserWindow(this.options); }\n}\nconst w = new W();\nw["options"].webPreferences.nodeIntegration = true;',
    );
    expect(states(outer)).toEqual(["computed computed computed null computed"]);
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
    // in a class field, which is not read at all
    expect(
      states(
        one(
          "class W {\n  prefs = { sandbox: true, ...this.extra, contextIsolation: true };\n  open() { this.win = new BrowserWindow({ webPreferences: this.prefs }); }\n}",
        ),
      ),
    ).toEqual(["computed computed computed null computed"]);
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
      "const BASE = { sandbox: true };\nconst options = { webPreferences: { ...BASE, sandbox: false } };\nfunction open() { const win = new BrowserWindow(options); return win; }",
    );
    expect(info.webPreferences.map((p) => `${p.windowName} ${p.key}=${p.value}`)).toEqual([
      "win sandbox=false",
    ]);
  });
});

/** A window that takes a class field's options, with code that may change the field. */
const fieldWindow = (extra: string, ctor = ""): string =>
  `class W { opts = { webPreferences: { contextIsolation: true, sandbox: true } }; constructor(){ ${ctor} } open(){ return new BrowserWindow(this.opts); } }\nconst w = new W();\n${extra}\nw.open();`;

describe("review 2: no safe value for options the code may have changed", () => {
  const BLOCKS: Array<[string, string]> = [
    ["block", "{ const prefs = { contextIsolation: false }; NEW }"],
    ["if", "if (x) { let prefs = { contextIsolation: false }; NEW }"],
    ["catch", "try {} catch (prefs) { NEW }"],
    ["for of", "for (const prefs of list) { NEW }"],
    ["switch", "switch (x) { case 1: { const prefs = { contextIsolation: false }; NEW } }"],
  ];

  it("reads a name declared in a block at the top of the file as that block's, in the evaluation", () => {
    for (const [label, block] of BLOCKS) {
      const src = `const prefs = { contextIsolation: true };\n${block.replace("NEW", "new B({ w: prefs });")}`;
      const { tokens } = tokenize(src);
      const res = new ExpressionResolver(tokens, new Constants(tokens), "main.js");
      const k = tokens.findIndex((t, i) => t.value === "B" && tokens[i + 1]?.value === "(");
      const read = res.valuesAt(k + 2).values[0];
      const w = read?.kind === "obj" ? read.props.get("w") : null;
      const ci = w?.kind === "obj" ? w.props.get("contextIsolation") : null;
      expect(ci?.kind === "bool" && ci.value, label).not.toBe(true);
    }
  });

  it("reports no safe value for a window in such a block", () => {
    for (const [label, block] of BLOCKS)
      for (const make of [
        "new BrowserWindow({ webPreferences: prefs });",
        "new BrowserWindow(dev ? {} : { webPreferences: prefs });",
      ]) {
        const info = one(
          `const prefs = { contextIsolation: true, sandbox: true };\n${block.replace("NEW", make)}`,
        );
        expect(
          info.windows.map((w) => w.contextIsolation),
          `${label}: ${make}`,
        ).not.toContain(true);
        expect(
          info.webPreferences.filter(
            (p) => p.window !== null && p.key === "sandbox" && p.value === true,
          ),
          `${label}: ${make}`,
        ).toEqual([]);
      }
    // the options object itself shadowed in a block
    const options = one(
      "const o = { webPreferences: { contextIsolation: true, sandbox: true } };\nif (x) { const o = { webPreferences: { contextIsolation: false } }; new BrowserWindow(o); }",
    );
    expect(options.windows.map((w) => w.contextIsolation)).not.toContain(true);
    expect(options.webPreferences.filter((p) => p.window !== null && p.value === true)).toEqual([]);
  });

  it("does not read a class field's options at all", () => {
    for (const [extra, ctor] of [
      ["", "Object.assign(this.opts.webPreferences, { contextIsolation: false });"],
      ["", "loosen(this.opts.webPreferences);"],
      ["", "const wp = this.opts.webPreferences; wp.contextIsolation = false;"],
      ["", "Object.assign(this, { opts: { webPreferences: { contextIsolation: false } } });"],
      ['Reflect.set(w, "opts", { webPreferences: { contextIsolation: false } });', ""],
      [
        'Object.defineProperty(w, "opts", { value: { webPreferences: { contextIsolation: false } } });',
        "",
      ],
      [
        "const key = pick(); Object.assign(w, { [key]: { webPreferences: { contextIsolation: false } } });",
        "",
      ],
      ["const key = pick(); const o = w[key]; o.webPreferences.contextIsolation = false;", ""],
      [
        "const key = pick(); Object.assign(w[key].webPreferences, { contextIsolation: false });",
        "",
      ],
      ["const v = w; v.opts.webPreferences.contextIsolation = false;", ""],
      [
        "Object.setPrototypeOf(w, { get opts(){ return { webPreferences: { contextIsolation: false } }; } });",
        "",
      ],
      ["", ""],
    ] as const) {
      const info = one(fieldWindow(extra, ctor));
      expect(states(info), `${extra}${ctor}`).toEqual(["computed computed computed null computed"]);
      expect(
        info.webPreferences.filter((p) => p.window !== null && p.value !== null),
        `${extra}${ctor}`,
      ).toEqual([]);
    }
  });
});

describe("a placed literal is listed once", () => {
  it("drops the windowless copy of a line the evaluation gave to a window", () => {
    // a helper merges SECURE and an override; a third window spreads `display.bounds` first, so
    // not every window's options are known and windowless rows are otherwise kept
    const info = one(
      [
        "const SECURE = Object.freeze({ contextIsolation: true, nodeIntegration: false, sandbox: true });",
        'function opts(prefs = {}, extra = {}) { return { ...extra, webPreferences: { ...SECURE, preload: "p.js", ...prefs } }; }',
        'function lib() { return new BrowserWindow(opts({}, { title: "x" })); }',
        "function ann() { const options = opts({ sandbox: false }); return new BrowserWindow(options); }",
        "function ov(display) { const webPreferences = { contextIsolation: true, sandbox: true }; return new BrowserWindow({ ...display.bounds, webPreferences }); }",
      ].join("\n"),
    );
    const rows = info.webPreferences.map(
      (p) => `${p.key}=${String(p.value)}@${p.line}:${p.window}`,
    );
    expect(rows.filter((r) => r.endsWith(":null"))).toEqual([]);
    expect(rows).toEqual(
      expect.arrayContaining(["sandbox=true@2:1", "sandbox=false@5:2", "preload=p.js@3:2"]),
    );
    // the third window writes its whole webPreferences after the spread: the spread reaches
    // none of its settings (up to 0.9.6 they read as computed)
    expect(states(info)[2]).toBe("not written true true null not written");
  });
});

/**
 * A spread of something unread before the window's own `webPreferences`: the later key replaces
 * the whole object, so what the spread may bring decides none of the settings. One window each.
 */
const REPLACED = [
  // the overlay of holdout6: a display's bounds, then the shorthand
  "function overlay(display) {\n  const webPreferences = { contextIsolation: true, sandbox: true, webSecurity: false };\n  return new BrowserWindow({\n    ...display.bounds,\n    frame: false,\n    webPreferences,\n  });\n}",
  // a literal, after a parameter's spread
  'function literal(opts) {\n  return new BrowserWindow({ ...opts, show: false, webPreferences: { sandbox: true, preload: "p.js" } });\n}',
  // `webPreferences: NAME` after the spread of a call
  "const PREFS = { contextIsolation: true };\nfunction named() {\n  return new BrowserWindow({ ...bounds(), webPreferences: PREFS });\n}",
  // a named options object built that way
  "function fromOptions(extra) {\n  const webPreferences = { sandbox: false };\n  const options = { ...extra, webPreferences };\n  return new BrowserWindow(options);\n}",
  // a base followed inside the later literal
  "const BASE = Object.freeze({ sandbox: true, contextIsolation: true });\nfunction based(opts) {\n  return new BrowserWindow({ ...opts, webPreferences: { ...BASE, nodeIntegration: false } });\n}",
].join("\n");
const REPLACED_STATES = [
  "not written true true null false",
  "not written not written true p.js not written",
  "not written true not written null not written",
  "not written not written false null not written",
  "false true true null not written",
];

/** What may still reach a setting: each stays computed for the keys it may bring. */
const STILL_COMPUTED = [
  // the spread after the key replaces it
  "function after(opts) {\n  return new BrowserWindow({ webPreferences: { sandbox: true }, ...opts });\n}",
  // the spread inside the later object may bring any key
  "function inside(opts, prefs) {\n  return new BrowserWindow({ ...opts, webPreferences: { sandbox: true, ...prefs } });\n}",
  // the same, in the declaration the shorthand is followed to
  "function declared(opts, prefs) {\n  const webPreferences = { ...prefs, sandbox: true };\n  return new BrowserWindow({ ...opts, webPreferences });\n}",
  // a later value that is not an object written here
  "function chosen(opts, dev) {\n  return new BrowserWindow({ ...opts, webPreferences: dev ? { sandbox: false } : { sandbox: true } });\n}",
  // a parameter the callers do not all fill in
  "function param(opts, webPreferences) {\n  return new BrowserWindow({ ...opts, webPreferences });\n}",
  // a later write of the key the reading does not name: quoted, computed, a method, an accessor
  'function quoted(o) {\n  return new BrowserWindow({ ...o, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false }, "webPreferences": o.p });\n}',
  "function single(o) {\n  return new BrowserWindow({ ...o, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false }, 'webPreferences': o.p });\n}",
  'function computedKey(o) {\n  return new BrowserWindow({ ...o, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false }, ["webPreferences"]: o.p });\n}',
  "function anyKey(o, k) {\n  return new BrowserWindow({ ...o, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false }, [k]: o.p });\n}",
  'function quotedUnsafe(o) {\n  return new BrowserWindow({ ...o, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false }, "webPreferences": { nodeIntegration: true, contextIsolation: false, sandbox: false } });\n}',
  "function method(o) {\n  return new BrowserWindow({ ...o, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false }, webPreferences() { return o.p; } });\n}",
  "function getter(o) {\n  return new BrowserWindow({ ...o, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false }, get webPreferences() { return o.p; } });\n}",
  'const P = { contextIsolation: true, sandbox: true };\nfunction namedThenQuoted(o) {\n  return new BrowserWindow({ ...o, webPreferences: P, "webPreferences": o.p });\n}',
  // a later spread of an object that brings the key
  "function spreadAfter(o) {\n  return new BrowserWindow({ ...o, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false }, ...{ webPreferences: o.p } });\n}",
  "function spreadCond(o) {\n  return new BrowserWindow({ ...o, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false }, ...(o.dev && { webPreferences: o.p }) });\n}",
].join("\n");
const ALL = "computed computed computed null computed";

/** Members after the settings, without any spread: which of them may replace them. */
const LATER_MEMBERS = [
  // a computed key that may be "webPreferences"
  "function param(k) {\n  return new BrowserWindow({ webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false }, [k]: 1 });\n}",
  // a constant key that is not, and one that is
  'const TITLE = "title";\nfunction other() {\n  return new BrowserWindow({ webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false }, [TITLE]: "x" });\n}',
  'const KEY = "webPreferences";\nfunction same() {\n  return new BrowserWindow({ webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false }, [KEY]: { sandbox: false } });\n}',
  // an accessor and a method of that name
  "function getter(o) {\n  return new BrowserWindow({ webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false }, get webPreferences() { return o; } });\n}",
  "function method(o) {\n  return new BrowserWindow({ webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false }, webPreferences() { return o; } });\n}",
  // an async generator or an unnamed accessor of any name
  "function asyncGen(o) {\n  return new BrowserWindow({ webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false }, async *webPreferences() { yield o; } });\n}",
  "function numbered(o) {\n  return new BrowserWindow({ webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false }, get 1() { return o; } });\n}",
  // a prototype the options take an inherited webPreferences from
  "const EVIL = { webPreferences: { nodeIntegration: true, contextIsolation: false } };\nfunction inherits() {\n  return new BrowserWindow({ width: 1, __proto__: EVIL });\n}",
  // a prototype of webPreferences: what it does not write itself may come from there
  "function prefsProto(x) {\n  return new BrowserWindow({ webPreferences: { __proto__: x, sandbox: true } });\n}",
  // the same prototypes written with a quoted key ("__proto__": x sets the prototype as well)
  'function inheritsQuoted() {\n  return new BrowserWindow({ width: 1, "__proto__": EVIL });\n}',
  'function prefsProtoQuoted(x) {\n  return new BrowserWindow({ webPreferences: { "__proto__": x, sandbox: true } });\n}',
  // a prototype never replaces an own key, also after a spread
  "function proto(o) {\n  return new BrowserWindow({ ...o, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false }, __proto__: o });\n}",
].join("\n");
const LATER_STATES = [
  "computed computed computed null computed",
  "false true true null not written",
  "not written not written false null not written",
  "computed computed computed null computed",
  "computed computed computed null computed",
  "computed computed computed null computed",
  "computed computed computed null computed",
  "computed computed computed null computed",
  "computed computed true null computed",
  "computed computed computed null computed",
  "computed computed true null computed",
  "false true true null not written",
];

describe("a member after the settings that may replace them", () => {
  it("hides them unless its key is known to be another one", () => {
    const main = `const { BrowserWindow } = require("electron");\n${LATER_MEMBERS}\nmodule.exports = { param, other, same, getter, method, asyncGen, numbered, inherits, prefsProto, inheritsQuoted, prefsProtoQuoted, proto };`;
    expect(states(analyze({ "main.js": main }))).toEqual(LATER_STATES);
    for (const minify of [false, true])
      expect(states(analyze(bundled({ "main.js": main }, minify))), String(minify)).toEqual(
        LATER_STATES,
      );
  });
});

describe("a whole webPreferences written after an unread spread", () => {
  it("decides every setting of the window, plain, bundled and minified", () => {
    const main = `const { BrowserWindow } = require("electron");\n${REPLACED}\nmodule.exports = { overlay, literal, named, fromOptions, based };`;
    const plain = analyze({ "main.js": main });
    expect(states(plain)).toEqual(REPLACED_STATES);
    // nothing about their settings is left unknown, so no window is named as not followed
    expect(plain.windows.filter((w) => w.computed || w.opaque)).toEqual([]);
    expect(plain.limitations.map((l) => l.code)).not.toContain("window_options_unresolved");
    for (const minify of [false, true])
      expect(states(analyze(bundled({ "main.js": main }, minify))), String(minify)).toEqual(
        REPLACED_STATES,
      );
  });

  it("decides nothing when the spread comes after it or may reach inside it", () => {
    const main = `const { BrowserWindow } = require("electron");\n${STILL_COMPUTED}\nmodule.exports = { after, inside, declared, chosen, param, quoted, single, computedKey, anyKey, quotedUnsafe, method, getter, namedThenQuoted, spreadAfter, spreadCond };`;
    // the quoted unsafe object is read as well: two different values, which decide nothing
    const expected = Array.from({ length: 15 }, (_, i) =>
      i === 9 ? "conflicting conflicting conflicting null computed" : ALL,
    );
    expect(states(analyze({ "main.js": main }))).toEqual(expected);
    // esbuild's minifier writes `"webPreferences":` as a plain key: the later object then
    // stands, with its unsafe values
    const minified = expected.map((e, i) => (i === 9 ? "true false false null not written" : e));
    for (const minify of [false, true])
      expect(states(analyze(bundled({ "main.js": main }, minify))), String(minify)).toEqual(
        minify ? minified : expected,
      );
  });

  it("keeps a later write to the followed object computed", () => {
    const info = one(
      "function f(opts) {\n  const webPreferences = { sandbox: true };\n  webPreferences.sandbox = opts.sandbox;\n  return new BrowserWindow({ ...opts, webPreferences });\n}",
    );
    expect(info.windows[0]?.computed ?? []).toContain("sandbox");
  });
});

/** IPC calls with optional chaining, in main and preload, and look-alikes that are no IPC. */
const OPTIONAL_MAIN = [
  'const { ipcMain, BrowserWindow } = require("electron");',
  'ipcMain?.handle("main:a", () => 1);',
  'ipcMain.handle?.("main:b", (_e, x) => x);',
  'ipcMain?.on?.("main:c", (event, x) => {',
  '  event.sender?.send("reply:a", { x });',
  '  event?.reply("reply:b", x);',
  '  event.reply?.("reply:c");',
  "});",
  "const win = new BrowserWindow({});",
  'win.webContents?.send("push:a", 1);',
  'win?.webContents?.send("push:b", { a: 1, b: 2 });',
  'win.webContents.send?.("push:c");',
  "// look-alikes: another object, another temporary, another receiver",
  "const socket = makeSocket();",
  'socket?.send("no:a");',
  'var t; (t = socket) == null ? void 0 : t.send("no:b");',
  'var u; (u = ipcMain) == null ? void 0 : socket.send("no:c");',
  'ipcMain == null ? void 0 : socket.on("no:d", () => {});',
  "module.exports = { win };",
].join("\n");
const OPTIONAL_PRELOAD = [
  'const { ipcRenderer, contextBridge } = require("electron");',
  'ipcRenderer?.send("pre:a", 1, { b: 2 });',
  'ipcRenderer.send?.("pre:b", { x: 1 });',
  'ipcRenderer?.invoke?.("pre:c");',
  'ipcRenderer?.on("pre:d", () => {});',
  'contextBridge?.exposeInMainWorld("api", { go: (n) => ipcRenderer?.invoke("pre:e", n) });',
  'var c; (c = ipcRenderer.send) == null ? void 0 : c.call(socket, "no:e");',
  'var s; (s = other.ipcRenderer) == null ? void 0 : s.call(ipcRenderer, "no:f");',
].join("\n");
/** The same files written without `?.`. */
const plainOf = (text: string): string => text.replace(/\?\.\(/g, "(").replace(/\?\./g, ".");
/** `file api channel args` of every IPC row, without how the call was read (`via`). */
const ipcRows = (info: JsAppInfo): string[] =>
  info.modules
    .flatMap((m) => m.ipc.map((r) => `${m.id} ${r.api} ${r.channel} ${r.args ?? ""}`.trim()))
    .toSorted();

const files = (main: string, preload: string): JsAppInfo =>
  analyze({ "main.js": main, "preload.js": preload });
/** IPC rows of a renderer that finds the IPC object on the window (`window.ipc = …`). */
const ambientRows = (ui: string): string[] =>
  ipcRows(
    analyze({
      "main.js": 'const { ipcMain } = require("electron");\nipcMain.on("boot", () => {});',
      "js/default.js": 'window.ipc = require("electron").ipcRenderer;',
      "js/ui.js": ui,
    }),
  );

/** Both files bundled by esbuild. */
const both = (minify: boolean, target?: string): JsAppInfo =>
  files(
    bundled({ "main.js": OPTIONAL_MAIN }, minify, target)["main.js"]!,
    bundled({ "main.js": OPTIONAL_PRELOAD }, minify, target)["main.js"]!,
  );

describe("optional chaining on IPC calls", () => {
  it("gives the rows of the plain call, in the source and as esbuild lowers it", () => {
    const plain = files(plainOf(OPTIONAL_MAIN), plainOf(OPTIONAL_PRELOAD));
    const expected = ipcRows(plain);
    // the plain call is read as before: every channel, with its payload
    expect(expected).toEqual([
      "main.js event.reply reply:b (_)",
      "main.js event.reply reply:c ()",
      "main.js event.sender.send reply:a ({x})",
      "main.js ipcMain.handle main:a",
      "main.js ipcMain.handle main:b",
      "main.js ipcMain.on main:c",
      "main.js webContents.send push:a (_)",
      "main.js webContents.send push:b ({a, b})",
      "main.js webContents.send push:c ()",
      "preload.js contextBridge.exposeInMainWorld api",
      "preload.js ipcRenderer.invoke pre:c ()",
      "preload.js ipcRenderer.invoke pre:e (_)",
      "preload.js ipcRenderer.on pre:d",
      "preload.js ipcRenderer.send pre:a (_, {b})",
      "preload.js ipcRenderer.send pre:b ({x})",
    ]);
    const optional = files(OPTIONAL_MAIN, OPTIONAL_PRELOAD);
    expect(ipcRows(optional)).toEqual(expected);
    expect(optional.ipcChannels).toEqual(plain.ipcChannels);
    expect(optional.contextBridge).toEqual(plain.contextBridge);
    // esbuild keeps `?.` for a current target and lowers it for es2019:
    // `(_a = ipcRenderer.send) == null ? void 0 : _a.call(ipcRenderer, …)`, minified `||`
    for (const [minify, target] of [
      [false, undefined],
      [true, undefined],
      [false, "es2019"],
      [true, "es2019"],
    ] as const) {
      const info = both(minify, target);
      const label = `${minify ? "minified" : "bundled"} ${target ?? "esnext"}`;
      expect(ipcRows(info), label).toEqual(expected);
      expect(info.ipcChannels, label).toEqual(plain.ipcChannels);
    }
  });

  it("reads the lowered forms only where the temporary is assigned from the receiver", () => {
    const rows = ipcRows(files(OPTIONAL_MAIN, OPTIONAL_PRELOAD)).join("\n");
    expect(rows).not.toContain("no:");
    // by hand: the forms esbuild, a minifier and TypeScript emit
    const info = one(
      [
        'const { ipcRenderer } = require("electron");',
        'var _a; (_a = ipcRenderer) == null ? void 0 : _a.send("low:a", 1);',
        'var a; (a = ipcRenderer.invoke) == null || a.call(ipcRenderer, "low:b");',
        'var _b; (_b = ipcRenderer) === null || _b === void 0 ? void 0 : _b.send("low:c");',
        'null == ipcRenderer || ipcRenderer.send("low:d");',
        'var _c, _d; (_d = (_c = ipcRenderer).send) == null ? void 0 : _d.call(_c, "low:e");',
        "// not the same object",
        'var _e; (_e = ipcRenderer) == null ? void 0 : _f.send("no:a");',
        'var _g; (_g = ipcRenderer.send) == null ? void 0 : _g.call(_x, "no:b");',
        'var _h; (_h = ipcRenderer.send) == null ? void 0 : _h.apply(ipcRenderer, ["no:c"]);',
        'ipcRenderer == null ? void 0 : ipcRenderer2.send("no:d");',
      ].join("\n"),
    );
    expect(ipcRows(info)).toEqual([
      "main.js ipcRenderer.invoke low:b ()",
      "main.js ipcRenderer.send low:a (_)",
      "main.js ipcRenderer.send low:c ()",
      "main.js ipcRenderer.send low:d ()",
      "main.js ipcRenderer.send low:e ()",
    ]);
  });

  it("reads an optional call on an IPC object a renderer finds on the window", () => {
    const ui = 'window.ipc?.send("amb:a");\nipc?.send?.("amb:b", 1);';
    expect(ambientRows(ui)).toEqual(ambientRows(plainOf(ui)));
    expect(ambientRows(ui)).toContain("js/ui.js ipcRenderer.send amb:b");
  });
});

/** Titles of the minified-bundle finding. */
const minifiedTitles = (info: JsAppInfo): string[] =>
  info.findings.filter((f) => f.kind === "js.minified").map((f) => f.title);

describe("the minified-bundle finding", () => {
  it("counts one bundle in the singular", () => {
    // one line over 2,000 characters: the scan counts it as minified
    const min = `var a=1;${"function b(c){return c+1}".repeat(120)}`;
    const single = analyze({ "main.js": min });
    const pair = analyze({ "main.js": `require("./x.js");${min}`, "x.js": min });
    expect([...minifiedTitles(single), ...minifiedTitles(pair)]).toEqual([
      "1 minified bundle",
      "2 minified bundles",
    ]);
  });
});

// Issue #200: keys written as strings, as constants in brackets, as accessors or methods, and
// a computed key that cannot be read. esbuild's minifier unquotes `"nodeIntegration":`, so the
// plain and minified sources must read the same.
const QUOTED_KEYS = [
  'const w1 = new BrowserWindow({ webPreferences: { "nodeIntegration": true, "contextIsolation": false } });',
  'const NI = "nodeIntegration";',
  "const w2 = new BrowserWindow({ webPreferences: { [NI]: true } });",
  "const w3 = new BrowserWindow({ webPreferences: { sandbox: true, [process.env.K]: false } });",
  "const w4 = new BrowserWindow({ webPreferences: { get contextIsolation() { return false; } } });",
  'const w5 = new BrowserWindow({ webPreferences: { nodeIntegration: false, "nodeIntegration": true } });',
  "const w6 = new BrowserWindow({ webPreferences: { [process.env.K]: false, sandbox: true } });",
  'const w7 = new BrowserWindow({ webPreferences: { ["sandbox"]: false, title: pick(a, sandbox(x)) } });',
  "module.exports = { w1, w2, w3, w4, w5, w6, w7 };",
].join("\n");
const QUOTED_STATES = [
  "true false not written null not written",
  "true not written not written null not written",
  // the unread key may be any of them, and replaces the sandbox written before it
  "computed computed computed null computed",
  "not written computed not written null not written",
  // the later of two writes of one key wins
  "true not written not written null not written",
  // written after the unread key: it stands
  "computed computed true null computed",
  // a call in a value is not a method `sandbox() {…}`
  "not written not written false null not written",
];

describe("webPreferences keys that are not plain names (#200)", () => {
  it("reads quoted and constant keys, and no key an accessor or an unread key may write", () => {
    const main = `const { BrowserWindow } = require("electron");\n${QUOTED_KEYS}`;
    expect(states(analyze({ "main.js": main }))).toEqual(QUOTED_STATES);
    for (const minify of [false, true])
      expect(states(analyze(bundled({ "main.js": main }, minify))), String(minify)).toEqual(
        QUOTED_STATES,
      );
  });
});

// Review RC of #207: a parameter that shadows a string constant, computed keys of accessors and
// generators, an unread key in a later argument of Object.assign, quoted `preload`, and getters
// in an object nested in the settings.
const RC_KEYS = [
  "const k = process.env.K;",
  'const SB = "sandbox";',
  "function make(SB) { return new BrowserWindow({ webPreferences: { nodeIntegration: false, [SB]: true } }); }",
  "make(process.env.X);",
  "const w2 = new BrowserWindow({ webPreferences: { nodeIntegration: false, get [k]() { return true; } } });",
  'const NI = "nodeIntegration";',
  "const w3 = new BrowserWindow({ webPreferences: { nodeIntegration: false, get [NI]() { return true; } } });",
  "const w4 = new BrowserWindow({ webPreferences: { nodeIntegration: false, *[k]() {} } });",
  "const w5 = new BrowserWindow({ webPreferences: { nodeIntegration: false, async [k]() {} } });",
  "const w6 = new BrowserWindow({ webPreferences: Object.assign({ nodeIntegration: false }, { [k]: true }) });",
  'const w7 = new BrowserWindow({ webPreferences: { "preload": "p.js", "nodeIntegration": true } });',
  "const w8 = new BrowserWindow({ webPreferences: { nodeIntegration: true, inner: { get nodeIntegration() { return false; } } } });",
  'const w9 = new BrowserWindow({ webPreferences: { contextIsolation: false, f: () => ({ "contextIsolation": true }) } });',
  'const w10 = new BrowserWindow({ webPreferences: { ["preload"]: "q.js" } });',
  "module.exports = { make, w2, w3, w4, w5, w6, w7, w8, w9, w10 };",
].join("\n");
const RC_STATES = [
  // the parameter is not the constant: an unread key, which may be any setting
  "computed computed computed null computed",
  "computed computed computed null computed",
  // a getter of a known key: that key is computed
  "computed not written not written null not written",
  "computed computed computed null computed",
  "computed computed computed null computed",
  "computed computed computed null computed",
  "true not written not written p.js not written",
  // a getter in an object nested in the settings is not one of them
  "true not written not written null not written",
  // what a function there returns is read as written, as esbuild's minifier unquotes it
  "not written conflicting not written null not written",
  "not written not written not written q.js not written",
];

describe("keys the review of #207 found (RC)", () => {
  it("reads them alike in the source, the bundle and the minified bundle", () => {
    const main = `const { BrowserWindow } = require("electron");\n${RC_KEYS}`;
    expect(states(analyze({ "main.js": main }))).toEqual(RC_STATES);
    for (const minify of [false, true])
      expect(states(analyze(bundled({ "main.js": main }, minify))), String(minify)).toEqual(
        RC_STATES,
      );
  });
});
