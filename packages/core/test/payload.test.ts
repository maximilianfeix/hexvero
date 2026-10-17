import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildSync } from "esbuild";
import { afterAll, describe, expect, it } from "vitest";
import { compareItems, positionalFields } from "../src/compare.js";
import {
  collectReleaseSources,
  compareReleases,
  renderReleaseReport,
  renderReleaseReportHtml,
  Session,
} from "../src/index.js";
import { analyzeJavaScriptTree, asarTree, type JsAppInfo } from "../src/javascript/app.js";
import { NOT_READ, PayloadReader } from "../src/javascript/payload.js";
import { scanJavaScript, tokenize } from "../src/javascript/scan.js";
import { buildAsar } from "./fixtures/asar.js";

/**
 * The payload shape of an IPC call (`args`): what the arguments after the channel look like as
 * written. Expected shapes are written from the fixture sources; nothing of them is run.
 */

const dir = mkdtempSync(join(tmpdir(), "hexvero-payload-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** The shape of the first call `send(` in `code`. */
function shape(code: string): string {
  const { tokens } = tokenize(code);
  const open = tokens.findIndex(
    (t, i) => t.value === "(" && tokens[i - 1]?.value === "send" && t.type === "punct",
  );
  return new PayloadReader(tokens, code).shapeAt(open);
}

describe("payload shape of one call", () => {
  it("counts arguments and names the keys of object literals, sorted", () => {
    expect(shape(`send("c")`)).toBe("()");
    expect(shape(`send("c", 1, x, "s")`)).toBe("(_, _, _)");
    expect(shape(`send("c", { b: 1, a, "c-d": 2, 3: x, m() {}, get g() { return 1 } })`)).toBe(
      '({3, a, b, "c-d", g, m})',
    );
    expect(shape(`send("c", {})`)).toBe("({})");
    expect(shape(`send("c", { a, }, )`)).toBe("({a})");
    expect(shape(`send("c", { async, get, set })`)).toBe("({async, get, set})");
    expect(shape(`send("c", { async *gen() {}, set s(v) {} })`)).toBe("({gen, s})");
  });

  it("marks a spread or a computed key as open instead of guessing names", () => {
    expect(shape(`send("c", { a, ...rest })`)).toBe("({a, …})");
    expect(shape(`send("c", { [k]: 1, b: 2 })`)).toBe("({b, …})");
    expect(shape(`send("c", { 1.5: x, 0x1: y })`)).toBe("({…})");
    expect(shape(`send("c", { __proto__: p, a })`)).toBe("({a, …})");
    expect(shape(`send("c", { a }, ...names)`)).toBe("({a}, ...)");
    expect(shape(`send("c", ...args)`)).toBe("(...)");
  });

  it("describes only an argument that is exactly an object literal", () => {
    expect(shape(`send("c", { a } || b)`)).toBe("(_)");
    expect(shape(`send("c", f({ a }), [{ b }], () => ({ c }))`)).toBe("(_, _, _)");
    expect(shape("send(`c${id}`, { a: `x${y}` })")).toBe("({a})");
    expect(shape(`send("c", { a: { b: 1, c: 2 }, d: [1, 2] })`)).toBe("({a, d})");
  });

  it("says not read when the call's brackets do not close", () => {
    expect(shape(`send("c", { a, b`)).toBe(NOT_READ);
  });

  it("says not read when brackets of different kinds meet (a file cut off or misread)", () => {
    expect(shape(`send("c", ( ], { a })`)).toBe(NOT_READ);
    expect(shape(`send("c", [ ), { a } ]`)).toBe(NOT_READ);
    expect(shape(`send("c", x ], { a })`)).toBe(NOT_READ);
    expect(shape(`send("c", { a ) }`)).toBe(NOT_READ);
  });

  it("reads a template literal as one argument, commas in its gaps included", () => {
    expect(shape("send(`c`, `${a, b}`, { k })")).toBe("(_, {k})");
    expect(shape("send(`c`, `x${a, b}y${c, d}z`, e)")).toBe("(_, _)");
    expect(shape("send(`c`, `${`in${a, b}`}`, { k })")).toBe("(_, {k})");
    expect(shape("send(`c`, `${ {x: 1}.x }`, y)")).toBe("(_, _)");
    expect(shape("send(`c`, { a: `${p, q}`, b })")).toBe("({a, b})");
    // an escaped `${` is text, not a gap
    expect(shape("send(`c`, `\\${a, b}`)")).toBe("(_)");
  });

  it("keeps a long list short and says how much it left out", () => {
    const keys = Array.from({ length: 70 }, (_, i) => `k${String(i).padStart(2, "0")}: ${i}`);
    expect(shape(`send("c", { ${keys.join(", ")} })`)).toMatch(
      /^\(\{k00, k01, .* k63, … \+6 more\}\)$/,
    );
    const many = Array.from({ length: 40 }, () => "x").join(", ");
    expect(shape(`send("c", ${many})`)).toMatch(/, _, … \+8 more\)$/);
  });
});

function analyze(files: Record<string, string>): JsAppInfo {
  return analyzeJavaScriptTree(
    asarTree(
      buildAsar({
        "package.json": JSON.stringify({
          name: "p",
          main: "main.js",
          devDependencies: { electron: "^38.0.0" },
        }),
        "main.js":
          'const { ipcMain } = require("electron");\nipcMain.handle("npm:add", () => 1);\n',
        ...files,
      }),
      "app.asar",
    ),
  );
}

/** `preload.js` bundled by esbuild, optionally minified. */
function bundled(sources: Record<string, string>, minify: boolean): Record<string, string> {
  const src = mkdtempSync(join(dir, "src-"));
  for (const [name, text] of Object.entries(sources)) {
    mkdirSync(dirname(join(src, name)), { recursive: true });
    writeFileSync(join(src, name), text);
  }
  const outfile = join(src, "out", "preload.js");
  buildSync({
    entryPoints: [join(src, "preload.js")],
    bundle: true,
    minify,
    platform: "node",
    format: "cjs",
    external: ["electron"],
    outfile,
    logLevel: "silent",
  });
  return { "preload.js": readFileSync(outfile, "utf8") };
}

/** The `ipc` collection as the session lists it. */
const ipcRows = (info: JsAppInfo): Array<Record<string, unknown>> =>
  info.modules.flatMap((m) => m.ipc.map((u) => ({ module: m.id, ...u })));

const compareIpc = (a: JsAppInfo, b: JsAppInfo) =>
  compareItems(ipcRows(a), ipcRows(b), {
    collection: "ipc",
    positional: positionalFields("ipc", []),
  });

/** Electron Fiddle 0.38.0 → 0.39.0, reduced: a third field in the payload of an existing call. */
const preload = (third: boolean): Record<string, string> => ({
  "channels.js": 'exports.IpcEvents = { NPM_ADD_MODULES: "NPM_ADD_MODULES" };\n',
  "preload.js": [
    'const { contextBridge, ipcRenderer } = require("electron");',
    'const { IpcEvents } = require("./channels.js");',
    'contextBridge.exposeInMainWorld("ElectronFiddle", {',
    `  addModules({ dir, packageManager${third ? ", useSocketFirewall" : ""} }, ...names) {`,
    "    return ipcRenderer.invoke(",
    "      IpcEvents.NPM_ADD_MODULES,",
    `      { dir, packageManager${third ? ", useSocketFirewall" : ""} },`,
    "      ...names,",
    "    );",
    "  },",
    '  ping: () => ipcRenderer.send("ping"),',
    "});",
  ].join("\n"),
});

/** Three calls of one channel in one file; in v2 the second one sends one key more. */
const repeated = (v2: boolean): Record<string, string> => ({
  "preload.js": [
    'const { ipcRenderer } = require("electron");',
    'ipcRenderer.send("log", { level, text });',
    `ipcRenderer.send("log", { level${v2 ? ", source" : ""} });`,
    'ipcRenderer.send("log");',
  ].join("\n"),
});

/** One preload file with these calls. */
const rows = (calls: string[]): JsAppInfo =>
  analyze({
    "preload.js": ['const { ipcRenderer } = require("electron");', ...calls].join("\n"),
  });

describe("a new payload field on an existing channel", () => {
  const variants: Array<[string, (third: boolean) => Record<string, string>]> = [
    ["plain", preload],
    ["bundled", (third) => bundled(preload(third), false)],
    ["minified", (third) => bundled(preload(third), true)],
  ];
  for (const [name, files] of variants)
    it(`is one changed call, not removed and added (${name})`, () => {
      const a = analyze(files(false));
      const b = analyze(files(true));
      const invoke = (info: JsAppInfo) =>
        ipcRows(info).filter((r) => r["api"] === "ipcRenderer.invoke");
      expect(invoke(a).map((r) => [r["channel"], r["args"]])).toEqual([
        ["NPM_ADD_MODULES", "({dir, packageManager}, ...)"],
      ]);
      expect(invoke(b).map((r) => [r["channel"], r["args"]])).toEqual([
        ["NPM_ADD_MODULES", "({dir, packageManager, useSocketFirewall}, ...)"],
      ]);
      const diff = compareIpc(a, b);
      expect(diff.added).toEqual([]);
      expect(diff.removed).toEqual([]);
      expect(diff.changed.map((c) => c.fields)).toEqual([
        [
          {
            field: "args",
            before: "({dir, packageManager}, ...)",
            after: "({dir, packageManager, useSocketFirewall}, ...)",
          },
        ],
      ]);
      // the call without a payload is read too, and the receiver carries no shape
      expect(ipcRows(b).find((r) => r["channel"] === "ping")?.["args"]).toBe("()");
      expect(ipcRows(b).find((r) => r["api"] === "ipcMain.handle")).not.toHaveProperty("args");
    });

  it("reads webContents.send, event.reply and event.sender.send", () => {
    const info = analyze({
      "main.js": [
        'const { app, BrowserWindow, ipcMain } = require("electron");',
        "const win = new BrowserWindow({});",
        'win.webContents.send("progress", { done, total });',
        'ipcMain.on("ask", (event, q) => { event.reply("answer", { q, a: 1 }); event.sender.send("seen", q); });',
      ].join("\n"),
    });
    const shapes = Object.fromEntries(
      ipcRows(info)
        .filter((r) => r["args"] !== undefined)
        .map((r) => [`${String(r["api"])} ${String(r["channel"])}`, r["args"]]),
    );
    expect(shapes).toEqual({
      "webContents.send progress": "({done, total})",
      "event.reply answer": "({a, q})",
      "event.sender.send seen": "(_)",
    });
  });

  it("pairs repeated calls of one channel that differ only in their payload", () => {
    const diff = compareIpc(analyze(repeated(false)), analyze(repeated(true)));
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.unchanged).toBe(3);
    expect(diff.changed.map((c) => c.fields)).toEqual([
      [{ field: "args", before: "({level})", after: "({level, source})" }],
    ]);
  });

  it("does not count a removed repeat in the changed row as well", () => {
    const diff = compareIpc(
      rows(['ipcRenderer.send("c", { a });', 'ipcRenderer.send("c", { a });']),
      rows(['ipcRenderer.send("c", { b });']),
    );
    expect(diff.removed).toEqual(["preload.js::ipcRenderer.send::c"]);
    expect(diff.added).toEqual([]);
    expect(diff.changed.map((c) => c.fields)).toEqual([
      [{ field: "args", before: "({a})", after: "({b})" }],
    ]);
    // several per side: the changed row lists the paired calls only
    const many = compareIpc(
      rows(Array.from({ length: 3 }, () => 'ipcRenderer.send("c", { a });')),
      rows(Array.from({ length: 2 }, () => 'ipcRenderer.send("c", { b });')),
    );
    expect(many.removed).toEqual(["preload.js::ipcRenderer.send::c"]);
    expect(many.changed.map((c) => c.fields)).toEqual([
      [{ field: "args", before: ["({a})", "({a})"], after: ["({b})", "({b})"] }],
    ]);
  });

  it("does not report a call that only moved", () => {
    const one = analyze({
      "preload.js": 'const { ipcRenderer } = require("electron");\nipcRenderer.send("x", { a });',
    });
    const two = analyze({
      "preload.js":
        'const { ipcRenderer } = require("electron");\n\n\n// moved\nipcRenderer.send("x", { a });',
    });
    const diff = compareIpc(one, two);
    expect(diff.changed).toEqual([]);
    expect(diff.relocated).toBe(1);
  });

  it("shows the change in the release report, escaped as target text", async () => {
    const key = "<img src=x onerror=alert(1)>|`";
    const app = (v2: boolean) => ({
      "package.json": JSON.stringify({ name: "p", main: "main.js" }),
      "main.js": 'const { ipcMain } = require("electron");\nipcMain.handle("save", () => 1);\n',
      "preload.js": [
        'const { contextBridge, ipcRenderer } = require("electron");',
        'contextBridge.exposeInMainWorld("api", {',
        `  save: (d) => ipcRenderer.invoke("save", { d${v2 ? `, ${JSON.stringify(key)}: 1` : ""} }),`,
        "});",
      ].join("\n"),
    });
    writeFileSync(join(dir, "r1.asar"), buildAsar(app(false)));
    writeFileSync(join(dir, "r2.asar"), buildAsar(app(true)));
    const session = new Session();
    const a = await session.open(join(dir, "r1.asar"));
    const b = await session.open(join(dir, "r2.asar"));
    const r = await compareReleases(session, a.id, b.id);
    const row = r.changes.find((c) => c.collection === "ipc");
    expect(row?.change).toBe("changed");
    expect(row?.where[0]).toMatchObject({ file: "preload.js", line: 3 });
    expect(row?.fields?.map((f) => f.field)).toEqual(["args"]);
    const md = renderReleaseReport(r);
    expect(md).toContain("ipcRenderer.invoke");
    // target text stays inside a code span, whose content Markdown does not interpret
    expect(md).toContain('`args`: `"({d})"` → `` "({\\"<img src=x onerror=alert(1)>|`\\", d})" ``');
    const html = renderReleaseReportHtml(r, await collectReleaseSources(session, r));
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });
});

describe("hostile input", () => {
  it("stays linear in many calls, huge object literals and deep nesting", () => {
    const calls = Array.from(
      { length: 20_000 },
      (_, i) => `ipcRenderer.send("c${i % 50}", { a${i}: 1, b, ...r }, ...x);`,
    ).join("\n");
    const huge = `ipcRenderer.send("big", { ${Array.from({ length: 50_000 }, (_, i) => `k${i}: ${i}`).join(", ")} });`;
    const deep = `ipcRenderer.send("deep", ${"{ a: ".repeat(5_000)}1${" }".repeat(5_000)});`;
    // calls nested in the arguments of calls: each walks only its own top level
    const nested = `${'ipcRenderer.send("n", { k: '.repeat(2_000)}1${" })".repeat(2_000)};`;
    const source = `const { ipcRenderer } = require("electron");\n${calls}\n${huge}\n${deep}\n${nested}\n`;
    const started = performance.now();
    const result = scanJavaScript(source, { maxTokens: 10_000_000 });
    const elapsed = performance.now() - started;
    expect(result.ipc.find((u) => u.channel === "big")?.args).toMatch(/\+49936 more\}\)$/);
    expect(result.ipc.find((u) => u.channel === "deep")?.args).toBe("({a})");
    expect(result.ipc.filter((u) => u.channel === "n").every((u) => u.args === "({k})")).toBe(true);
    expect(result.ipc.find((u) => u.channel === "c7")?.args).toBe("({a7, b, …}, ...)");
    expect(elapsed).toBeLessThan(15_000);
  });
});
