import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildSync } from "esbuild";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { compareItems, positionalFields } from "../src/compare.js";
import { compareReleases, renderReleaseReport, Session } from "../src/index.js";
import { analyzeJavaScriptTree, asarTree, type JsAppInfo } from "../src/javascript/app.js";
import { ExpressionResolver } from "../src/javascript/resolve.js";
import { buildAsar } from "./fixtures/asar.js";

/**
 * Two Electron observations: privileged objects a preload hands to pages as they are
 * (`bridgeExposures`), and navigation / new-window handlers (`navigationHandlers`). The expected
 * facts below are written from the fixture sources by reading them; nothing of them is run.
 */

const dir = mkdtempSync(join(tmpdir(), "hexvero-observe-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function analyze(files: Record<string, string>): JsAppInfo {
  return analyzeJavaScriptTree(
    asarTree(
      buildAsar({ "package.json": JSON.stringify({ name: "o", main: "main.js" }), ...files }),
      "app.asar",
    ),
  );
}

/** Entry points bundled by esbuild into one CommonJS file each, optionally minified. */
function bundled(
  sources: Record<string, string>,
  entries: string[],
  minify: boolean,
): Record<string, string> {
  const src = mkdtempSync(join(dir, "src-"));
  for (const [name, text] of Object.entries(sources)) {
    mkdirSync(dirname(join(src, name)), { recursive: true });
    writeFileSync(join(src, name), text);
  }
  const out: Record<string, string> = {};
  for (const entry of entries) {
    const outfile = join(src, "out", entry);
    buildSync({
      entryPoints: [join(src, entry)],
      bundle: true,
      minify,
      platform: "node",
      format: "cjs",
      external: ["electron"],
      outfile,
      logLevel: "silent",
    });
    out[entry] = readFileSync(outfile, "utf8");
  }
  return out;
}

// The preload as an ES module, so esbuild's bundle reads it as authors write it.
const PRELOAD = [
  'import { contextBridge, ipcRenderer, shell } from "electron";',
  'import * as fs from "node:fs";',
  'import cp from "child_process";',
  "// contextBridge.exposeInMainWorld('c', ipcRenderer) in a comment is no call",
  "const note = \"exposeInMainWorld('s', ipcRenderer)\";",
  'contextBridge.exposeInMainWorld("api", {',
  "  ipc: ipcRenderer,",
  "  send: ipcRenderer.send,",
  "  on: ipcRenderer.on.bind(ipcRenderer),",
  "  open: shell,",
  "  fs,",
  "  cp,",
  "  proc: process,",
  "  invoke: (ch, ...args) => ipcRenderer.invoke(ch, ...args),",
  "  openUrl(url) { return shell.openExternal(url); },",
  "  note,",
  "});",
  'contextBridge.exposeInMainWorld("raw", ipcRenderer);',
  "",
].join("\n");

// A preload whose `shell` is its own object, and a string that names ipcRenderer.
const DECOY = [
  'import { contextBridge } from "electron";',
  "const shell = { open: (u) => u };",
  'contextBridge.exposeInMainWorld("tools", { shell, label: "ipcRenderer" });',
  "",
].join("\n");

/** Expected from PRELOAD: member → what it is. `invoke`, `openUrl`, `note` are not listed. */
const EXPOSED = [
  "api.cp child_process",
  "api.fs fs",
  "api.ipc ipcRenderer",
  "api.on ipcRenderer.on",
  "api.open shell",
  "api.proc process",
  "api.send ipcRenderer.send",
  "raw.null ipcRenderer",
];

const exposed = (info: JsAppInfo): string[] =>
  info.bridgeExposures.map((x) => `${x.api}.${x.member} ${x.exposed}`).toSorted();

const MAIN = [
  'import { app, BrowserWindow, shell } from "electron";',
  'app.on("web-contents-created", (event, contents) => {',
  '  contents.on("will-navigate", (e) => e.preventDefault());',
  '  contents.setWindowOpenHandler(() => ({ action: "deny" }));',
  "});",
  "// win.webContents.on('will-navigate', f) in a comment is no listener",
  'export const label = "setWindowOpenHandler";',
  "function createWindow() {",
  "  const win = new BrowserWindow({ webPreferences: { sandbox: true } });",
  "  win.webContents.setWindowOpenHandler(({ url }) => {",
  "    shell.openExternal(url);",
  '    return { action: "deny" };',
  "  });",
  '  win.webContents.on("will-frame-navigate", (e) => console.log(e.url));',
  "  const help = new BrowserWindow({});",
  "  help.webContents.setWindowOpenHandler((d) =>",
  '    d.url.startsWith("https:") ? { action: "allow" } : { action: "deny" },',
  "  );",
  "  return [win, help];",
  "}",
  "app.whenReady().then(createWindow);",
  "",
].join("\n");

/** Expected from MAIN, by kind, target kind and what the handler returns. */
const HANDLERS = [
  "setWindowOpenHandler app deny",
  "setWindowOpenHandler window deny",
  "setWindowOpenHandler window unknown",
  "will-frame-navigate window -",
  "will-navigate app -",
];

const handlers = (info: JsAppInfo): string[] =>
  info.navigationHandlers.map((h) => `${h.kind} ${h.targetKind} ${h.returns ?? "-"}`).toSorted();

/** The CommonJS form of a fixture, for the plain variant. */
const cjs = (text: string): string =>
  text
    .replace(
      'import { contextBridge, ipcRenderer, shell } from "electron";',
      'const { contextBridge, ipcRenderer, shell } = require("electron");',
    )
    .replace('import * as fs from "node:fs";', 'const fs = require("node:fs");')
    .replace('import cp from "child_process";', 'const cp = require("child_process");')
    .replace(
      'import { contextBridge } from "electron";',
      'const { contextBridge } = require("electron");',
    );

const exposureRow = (member: string, what: string, line: number): object => ({
  api: "api",
  member,
  exposed: what,
  evidence: what,
  world: "main",
  file: "preload.js",
  line,
});

/** A small release: v2 removes the window-open handler and exposes ipcRenderer. */
const release = (v2: boolean): Record<string, string> => ({
  "package.json": JSON.stringify({ name: "r", version: v2 ? "2.0.0" : "1.0.0", main: "main.js" }),
  "main.js": [
    'const { BrowserWindow } = require("electron");',
    "const win = new BrowserWindow({});",
    v2 ? "" : 'win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));',
  ].join("\n"),
  "preload.js": [
    'const { contextBridge, ipcRenderer } = require("electron");',
    'contextBridge.exposeInMainWorld("api", {',
    '  list: () => ipcRenderer.invoke("list"),',
    v2 ? "  ipc: ipcRenderer," : "",
    "});",
  ].join("\n"),
});

describe("privileged objects exposed through contextBridge", () => {
  it("lists each one with file, line and the value as written (plain)", () => {
    const info = analyze({ "main.js": "", "preload.js": cjs(PRELOAD), "decoy.js": cjs(DECOY) });
    expect(exposed(info)).toEqual(EXPOSED);
    const send = info.bridgeExposures.find((x) => x.member === "send")!;
    expect(send).toMatchObject({
      file: "preload.js",
      line: 8,
      evidence: "ipcRenderer.send",
      world: "main",
    });
    expect(info.bridgeExposures.find((x) => x.member === "on")!.evidence).toBe(
      "ipcRenderer.on.bind(ipcRenderer)",
    );
    expect(info.bridgeExposures.some((x) => x.file === "decoy.js")).toBe(false);
    const finding = info.findings.find((f) => f.kind === "electron.bridge-exposure")!;
    expect(finding.title).toContain("8 privileged objects exposed");
    expect(finding.confidence).toBe("inferred");
    expect(finding.location).toBe("preload.js:7");
  });

  it("finds the same in an esbuild bundle, plain and minified", () => {
    for (const minify of [false, true]) {
      const files = bundled(
        { "preload.js": PRELOAD, "decoy.js": DECOY },
        ["preload.js", "decoy.js"],
        minify,
      );
      const info = analyze({ "main.js": "", ...files });
      expect(exposed(info), `minify ${minify}`).toEqual(EXPOSED);
      expect(info.bridgeExposures.some((x) => x.file === "decoy.js")).toBe(false);
    }
  });

  it("does not take a wrapper, a parameter or a redeclared name for the object", () => {
    const info = analyze({
      "main.js": "",
      "preload.js": [
        'const { contextBridge, ipcRenderer } = require("electron");',
        "const wrap = (ipcRenderer) => ({ ipc: ipcRenderer });",
        "function expose(ipcRenderer) {",
        '  contextBridge.exposeInMainWorld("param", { ipc: ipcRenderer });',
        "}",
        'contextBridge.exposeInMainWorld("wrapped", {',
        '  send: (...a) => ipcRenderer.send("x", ...a),',
        "  get ipc() { return ipcRenderer; },",
        "  made: wrap(ipcRenderer),",
        "});",
      ].join("\n"),
    });
    expect(info.bridgeExposures).toEqual([]);
    expect(info.findings.some((f) => f.kind === "electron.bridge-exposure")).toBe(false);
  });

  it("says not established, not none, when the exposed value cannot be read", () => {
    const info = analyze({
      "main.js": "",
      "preload.js": [
        'const { contextBridge } = require("electron");',
        'const { api } = require("./api");',
        'contextBridge.exposeInMainWorld("api", api);',
      ].join("\n"),
    });
    expect(info.bridgeExposures).toEqual([]);
    const limitation = info.limitations.find((l) => l.code === "context_bridge_members_unreadable");
    expect(limitation?.message).toContain(
      "Whether it exposes a privileged object directly (collection bridgeExposures) is not established.",
    );
  });
});

describe("navigation and new-window handlers", () => {
  it("lists them per window and for app-wide web-contents-created (plain)", () => {
    const info = analyze({
      "main.js": MAIN.replace("export const", "const").replace(
        'import { app, BrowserWindow, shell } from "electron";',
        'const { app, BrowserWindow, shell } = require("electron");',
      ),
    });
    expect(handlers(info)).toEqual(HANDLERS);
    expect(
      info.navigationHandlers.map((h) => `${h.kind} ${h.target} ${h.line}`).toSorted(),
    ).toEqual([
      "setWindowOpenHandler app 4",
      "setWindowOpenHandler help 16",
      "setWindowOpenHandler win 10",
      "will-frame-navigate win 14",
      "will-navigate app 3",
    ]);
    const finding = info.findings.find((f) => f.kind === "electron.navigation")!;
    expect(finding.title).toBe(
      "setWindowOpenHandler for app, returns deny, win, returns deny, help, returns unknown; will-navigate/will-frame-navigate listener for app, win",
    );
    expect(finding.location).toBe("main.js:3");
  });

  it("finds the same in an esbuild bundle, plain and minified", () => {
    for (const minify of [false, true]) {
      const info = analyze(bundled({ "main.js": MAIN }, ["main.js"], minify));
      expect(handlers(info), `minify ${minify}`).toEqual(HANDLERS);
    }
  });

  it("reports absence only as not found in the files read", () => {
    const info = analyze({
      "main.js": [
        'const { BrowserWindow } = require("electron");',
        "const win = new BrowserWindow({});",
        "win.webContents.setWindowOpenHandler(policy);",
      ].join("\n"),
    });
    expect(info.navigationHandlers).toMatchObject([
      { kind: "setWindowOpenHandler", target: "win", targetKind: "window", returns: "unknown" },
    ]);
    const finding = info.findings.find((f) => f.kind === "electron.navigation")!;
    expect(finding.title).toBe(
      "setWindowOpenHandler for win, returns unknown; no will-navigate or will-frame-navigate listener found in the files read",
    );
    expect(finding.detail).toContain("1 of 1 JavaScript files read");
    expect(finding.detail).not.toMatch(/\b(safe|unsafe|denies|allows)\b/);
  });
});

describe("comparing the observations", () => {
  it("an added exposure is added, a moved one is not changed", () => {
    const a = [exposureRow("ipc", "ipcRenderer", 3)];
    const b = [exposureRow("ipc", "ipcRenderer", 9), exposureRow("open", "shell", 10)];
    const diff = compareItems(a, b, {
      collection: "bridgeExposures",
      positional: positionalFields("bridgeExposures", ["asar", "asar"]),
    });
    expect(diff.key).toBe("file+api+member+exposed");
    expect(diff.added).toEqual(["preload.js::api::open::shell"]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([]);
    expect(diff.relocated).toBe(1);
  });

  it("a minifier's new name in the evidence is no change", () => {
    const a = [{ ...exposureRow("ipc", "ipcRenderer", 1), evidence: "o.ipcRenderer" }];
    const b = [{ ...exposureRow("ipc", "ipcRenderer", 1), evidence: "n.ipcRenderer" }];
    const diff = compareItems(a, b, { collection: "bridgeExposures" });
    expect(diff.changed).toEqual([]);
  });

  it("names an added exposure and a removed handler in the release report, after windows", async () => {
    const session = new Session();
    writeFileSync(join(dir, "r1.asar"), buildAsar(release(false)));
    writeFileSync(join(dir, "r2.asar"), buildAsar(release(true)));
    const a = (await session.open(join(dir, "r1.asar"))).id;
    const b = (await session.open(join(dir, "r2.asar"))).id;
    const r = await compareReleases(session, a, b);
    const rows = r.changes.filter((c) =>
      ["bridgeExposures", "navigationHandlers"].includes(c.collection),
    );
    expect(rows.map((c) => `${c.collection} ${c.change} ${c.key}`)).toEqual([
      "bridgeExposures added preload.js::api::ipc::ipcRenderer",
      "navigationHandlers removed main.js::setWindowOpenHandler::window::win",
    ]);
    expect(rows[0]!.where).toEqual([{ side: "b", file: "preload.js", line: 4 }]);
    expect(rows[1]!.where).toEqual([{ side: "a", file: "main.js", line: 3 }]);
    const order = r.changes.map((c) => c.collection);
    const windows = order.indexOf("windows");
    if (windows !== -1) expect(windows).toBeLessThan(order.indexOf("bridgeExposures"));
    expect(renderReleaseReport(r)).toContain("bridgeExposures");
  });

  it("is unknown, not removed, where the other side's bridge cannot be read", async () => {
    const session = new Session();
    writeFileSync(
      join(dir, "u1.asar"),
      buildAsar({
        "package.json": JSON.stringify({ name: "u", version: "1.0.0", main: "main.js" }),
        "main.js": "",
        "preload.js": [
          'const { contextBridge, ipcRenderer } = require("electron");',
          'contextBridge.exposeInMainWorld("api", { ipc: ipcRenderer });',
        ].join("\n"),
      }),
    );
    writeFileSync(
      join(dir, "u2.asar"),
      buildAsar({
        "package.json": JSON.stringify({ name: "u", version: "2.0.0", main: "main.js" }),
        "main.js": "",
        "preload.js": [
          'const { contextBridge } = require("electron");',
          'contextBridge.exposeInMainWorld("api", require("./api"));',
        ].join("\n"),
      }),
    );
    const a = (await session.open(join(dir, "u1.asar"))).id;
    const b = (await session.open(join(dir, "u2.asar"))).id;
    const { diff } = await session.compareCollection(a, b, "bridgeExposures");
    expect(diff.removed).toEqual([]);
    expect(diff.unknown.map((u) => u.reason)).toEqual([
      "the other side has values there that could not be resolved",
    ]);
  });
});

const preload = (body: string): JsAppInfo =>
  analyze({
    "main.js": "",
    "preload.js": `const { contextBridge, ipcRenderer } = require("electron");\n${body}`,
  });
const navigation = (body: string): Array<Record<string, unknown>> =>
  analyze({
    "main.js": `const { app, BrowserWindow, shell } = require("electron");\nconst win = new BrowserWindow({});\n${body}`,
  }).navigationHandlers.map(({ kind, target, targetKind, returns, window }) => ({
    kind,
    target,
    targetKind,
    window,
    ...(returns ? { returns } : {}),
  }));
/** A handler row on a receiver that is not a window. */
const row = (target: string): object => ({
  kind: "setWindowOpenHandler",
  target,
  targetKind: "webContents",
  window: null,
  returns: "deny",
  evidence: `${target}.setWindowOpenHandler(…)`,
  file: "main.js",
  line: 1,
});

/** Review findings on sprint/091: each was a false fact before the fix. */
describe("review regressions", () => {
  it("#3a a name assigned again after its declaration is not the privileged object", () => {
    const info = preload(
      'let r = require("electron").ipcRenderer; r = { send(){} };\ncontextBridge.exposeInMainWorld("api", { r });',
    );
    expect(info.bridgeExposures).toEqual([]);
  });

  it("#3b/#3c a loop variable, an arrow parameter or a catch parameter shadows the import", () => {
    for (const body of [
      'for (const ipcRenderer of [1]) contextBridge.exposeInMainWorld("api", { ipcRenderer });',
      '[1].forEach(ipcRenderer => contextBridge.exposeInMainWorld("api", { ipcRenderer }));',
      '[1].forEach((ipcRenderer) => contextBridge.exposeInMainWorld("api", { x: ipcRenderer }));',
      'try {} catch (ipcRenderer) { contextBridge.exposeInMainWorld("api", { ipcRenderer }); }',
    ])
      expect(preload(body).bridgeExposures, body).toEqual([]);
  });

  it("#3d a Node module's method counts only where it acts; information helpers do not", () => {
    const info = preload(
      [
        'const os = require("os");',
        'const fs = require("fs");',
        'const path = require("path");',
        'const cp = require("child_process");',
        'contextBridge.exposeInMainWorld("api", {',
        "  platform: os.platform, os, env: process.env,",
        "  stat: fs.statSync, join: path.join,",
        "  read: fs.readFileSync, run: cp.spawn,",
        "});",
      ].join("\n"),
    );
    expect(exposed(info)).toEqual(["api.read fs.readFileSync", "api.run child_process.spawn"]);
  });

  it("#4 returns is unknown when a spread or a computed key may replace the action", () => {
    for (const body of [
      'win.webContents.setWindowOpenHandler(() => ({ action: "deny", ...extra }));',
      'win.webContents.setWindowOpenHandler(() => ({ action: "deny", [k]: "allow" }));',
      'win.webContents.setWindowOpenHandler(() => ({ ...base, action: "deny", [k]: 1 }));',
      // one path returns nothing
      'win.webContents.setWindowOpenHandler((d) => { if (d.url) return { action: "deny" }; });',
    ])
      expect(navigation(body)[0]?.["returns"], body).toBe("unknown");
    // the later of two literal keys wins, as in JavaScript
    expect(
      navigation(
        'win.webContents.setWindowOpenHandler(() => ({ action: "deny", action: "allow" }));',
      )[0]?.["returns"],
    ).toBe("allow");
    // a spread before the literal action is replaced by it
    expect(
      navigation('win.webContents.setWindowOpenHandler(() => ({ ...base, action: "deny" }));')[0]?.[
        "returns"
      ],
    ).toBe("deny");
  });

  it("#5 a parameter of the same name is not the window, nor the created webContents", () => {
    expect(
      navigation(
        'function f(win){ win.webContents.setWindowOpenHandler(() => ({ action: "deny" })); }',
      ),
    ).toEqual([
      {
        kind: "setWindowOpenHandler",
        target: "win.webContents",
        targetKind: "webContents",
        window: null,
        returns: "deny",
      },
    ]);
    expect(
      navigation(
        'app.on("web-contents-created", (e, contents) => { [other].forEach(contents => contents.setWindowOpenHandler(() => ({ action: "deny" }))); });',
      ),
    ).toEqual([
      {
        kind: "setWindowOpenHandler",
        target: "contents",
        targetKind: "webContents",
        window: null,
        returns: "deny",
      },
    ]);
    // the window itself, also when it is assigned to a name declared without a value
    expect(
      analyze({
        "main.js": [
          'const { BrowserWindow } = require("electron");',
          "let mainWindow;",
          "function create() {",
          "  mainWindow = new BrowserWindow({});",
          '  mainWindow.webContents.on("will-navigate", (e) => e.preventDefault());',
          "}",
        ].join("\n"),
      }).navigationHandlers.map((h) => `${h.targetKind} ${h.window}`),
    ).toEqual(["window mainWindow"]);
  });

  it("#9 a renamed receiver that is not a window is no removed and added handler", () => {
    const diff = compareItems([row("e.webContents")], [row("t.webContents")], {
      collection: "navigationHandlers",
    });
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([]);
  });
});

/** Security review of the review fixes: each decoy hid an exposure the tool must show. */
describe("review regressions, false negatives", () => {
  it("1 every member of a Node module is reported unless it only informs", () => {
    const info = preload(
      [
        'const fs = require("fs");',
        'const net = require("net");',
        'const tls = require("tls");',
        'const mod = require("module");',
        'const proc = require("process");',
        'contextBridge.exposeInMainWorld("api", {',
        "  promises: fs.promises, write: fs.createWriteStream, read: fs.createReadStream,",
        "  lchown: fs.lchown, fchmod: fs.fchmod,",
        "  Socket: net.Socket, TLSSocket: tls.TLSSocket, req: mod.require, main: proc.mainModule,",
        "  stat: fs.statSync, exists: fs.existsSync, env: proc.env, platform: proc.platform,",
        "});",
      ].join("\n"),
    );
    expect(exposed(info)).toEqual([
      "api.Socket net.Socket",
      "api.TLSSocket tls.TLSSocket",
      "api.fchmod fs.fchmod",
      "api.lchown fs.lchown",
      "api.main process.mainModule",
      "api.promises fs.promises",
      "api.read fs.createReadStream",
      "api.req module.require",
      "api.write fs.createWriteStream",
    ]);
  });

  it("2 a write or a declaration of the same name in another scope hides nothing", () => {
    for (const elsewhere of [
      "function g(){ let ipcRenderer; ipcRenderer = 1; }",
      "function g(){ const { ipcRenderer } = other; return ipcRenderer; }",
      "function g(ipcRenderer = 1){ return ipcRenderer; }",
      "function g(){ let ipcRenderer = 2; ipcRenderer++; }",
    ])
      expect(
        exposed(
          preload(`${elsewhere}\ncontextBridge.exposeInMainWorld("api", { ipc: ipcRenderer });`),
        ),
        elsewhere,
      ).toEqual(["api.ipc ipcRenderer"]);
  });

  it("3 a loop variable of the same name in another function hides nothing", () => {
    const info = preload(
      'function g(xs){ for (const ipcRenderer of xs) use(ipcRenderer); }\ncontextBridge.exposeInMainWorld("api", { ipcRenderer });',
    );
    expect(exposed(info)).toEqual(["api.ipcRenderer ipcRenderer"]);
  });

  it("4 an accessor, a method or a generator around the action makes returns unknown", () => {
    for (const literal of [
      '{ action: "deny", get action() { return "allow"; } }',
      '{ action: "deny", set x(v) {} }',
      '{ action: "deny", action() {} }',
      '{ action: "deny", async m() {} }',
      '{ action: "deny", *m() {} }',
      '{ get action() { return "allow"; }, action: "deny" }',
    ])
      expect(
        navigation(`win.webContents.setWindowOpenHandler(() => (${literal}));`)[0]?.["returns"],
        literal,
      ).toBe("unknown");
    // a shorthand of another name cannot replace the action
    expect(
      navigation('win.webContents.setWindowOpenHandler(() => ({ action: "deny", url }));')[0]?.[
        "returns"
      ],
    ).toBe("deny");
  });
});

/** Paths where the analysis cannot decide keep the exposure and say so; none drops it. */
describe("review regressions, undecided scope", () => {
  afterEach(() => vi.restoreAllMocks());

  it("1 an answer read before a later round recorded its declaration is read again", () => {
    // Round 1 records the top-level `r` (shell); `t = r` inside g asks for g's own `r`, which is
    // privileged only once `ipc` (round 2) and then g's `r` (round 3) are recorded.
    const info = preload(
      [
        'const r = require("electron").shell;',
        "function g() {",
        "  var t = r;",
        "  var r = ipc;",
        '  contextBridge.exposeInMainWorld("api", { r });',
        "}",
        "var ipc = q;",
        'var q = require("electron").ipcRenderer;',
      ].join("\n"),
    );
    expect(exposed(info)).toEqual(["api.r ipcRenderer"]);
  });

  it("2 a resolver whose budget ran out keeps the exposure, flagged", () => {
    vi.spyOn(ExpressionResolver.prototype, "binding").mockReturnValue(null);
    vi.spyOn(ExpressionResolver.prototype, "exhausted").mockReturnValue(true);
    const info = preload(
      'function g(){ const ipcRenderer = 1; return ipcRenderer; }\ncontextBridge.exposeInMainWorld("api", { ipc: ipcRenderer });',
    );
    expect(info.bridgeExposures.map((x) => `${x.member} ${x.exposed} ${x.undecided}`)).toEqual([
      "ipc ipcRenderer budget",
    ]);
    expect(
      info.limitations.find((l) => l.code === "bridge_exposures_undecided")?.message,
    ).toContain("ipcRenderer at preload.js:3 (budget)");
  });

  it("3 hostile input: thousands of declarations of the name keep every exposure, flagged", () => {
    const source = [
      'const { contextBridge: c, ipcRenderer: r } = require("electron");',
      Array.from({ length: 3000 }, (_, i) => `function f${i}(){var r=${i};r=r+1;return r}`).join(
        "",
      ),
      Array.from(
        { length: 400 },
        (_, i) => `function g${i}(){c.exposeInMainWorld("x${i}",{ipc:r})}`,
      ).join(""),
    ].join("\n");
    const started = performance.now();
    const info = analyze({ "main.js": "", "preload.js": source });
    expect(performance.now() - started).toBeLessThan(15_000);
    expect(info.bridgeExposures).toHaveLength(400);
    expect(info.bridgeExposures.every((x) => x.exposed === "ipcRenderer")).toBe(true);
    expect(info.limitations.some((l) => l.code === "bridge_exposures_undecided")).toBe(true);
  });

  it("an alias of the import, also in a function, is the import", () => {
    for (const body of [
      'var r = ipcRenderer;\ncontextBridge.exposeInMainWorld("api", { r });',
      'function g() {\n  var r = ipcRenderer;\n  contextBridge.exposeInMainWorld("api", { r });\n}',
    ])
      expect(exposed(preload(body)), body).toEqual(["api.r ipcRenderer"]);
  });

  it("a block that declares the name again is decided, not flagged", () => {
    const info = preload(
      '{ const ipcRenderer = { send(){} }; contextBridge.exposeInMainWorld("api", { x: ipcRenderer }); }',
    );
    expect(info.bridgeExposures).toEqual([]);
    expect(info.limitations.some((l) => l.code === "bridge_exposures_undecided")).toBe(false);
  });

  it("the hostile input of the timing run keeps its real exposures", () => {
    const source = `const{contextBridge:c,ipcRenderer:r}=require("electron");${"var a=r,b=r;".repeat(20_000)}c.exposeInMainWorld("x",{${"m:r,".repeat(20_000)}});`;
    const started = performance.now();
    const info = analyze({ "main.js": "", "preload.js": source });
    expect(performance.now() - started).toBeLessThan(15_000);
    // the per-file cap: the inventory says it is cut
    expect(info.bridgeExposures).toHaveLength(500);
    expect(info.bridgeExposures.every((x) => x.exposed === "ipcRenderer")).toBe(true);
    expect(info.limitations.some((l) => l.code === "context_bridge_truncated")).toBe(true);
  });

  it("4 a value under a key that is not read, and a bundler's default import, are read", () => {
    const info = preload(
      [
        'const e = __toESM(require("electron"));',
        'contextBridge.exposeInMainWorld(PREFIX + "ipc", ipcRenderer);',
        'contextBridge.exposeInMainWorld("api", { send: e.default.ipcRenderer.send });',
      ].join("\n"),
    );
    expect(exposed(info)).toEqual(["[computed].null ipcRenderer", "api.send ipcRenderer.send"]);
  });
});
