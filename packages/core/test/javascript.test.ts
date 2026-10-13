import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { openAsar } from "../src/formats/asar.js";
import { analyzeJavaScriptTree, asarTree, directoryTree } from "../src/javascript/app.js";
import { scanJavaScript, tokenize } from "../src/javascript/scan.js";
import { decodeVlq, originalPositionFor, summarizeSourceMap } from "../src/javascript/sourcemap.js";
import { buildAsar } from "./fixtures/asar.js";

const mainJs = `const { app, BrowserWindow, ipcMain } = require("electron");
const path = require('path');
const db = require("./lib/db.js");
import("./lazy.mjs");
// require("./commented-out")
const s = "require('./in-string')";
const re = /require\\(['"]x['"]\\)/g;
ipcMain.handle("get-user", async (e, id) => db.find(id));
ipcMain.on(\`log\`, () => {});
ipcMain.on(channelName, () => {});
app.whenReady().then(() => new BrowserWindow({ webPreferences: { nodeIntegration: true, contextIsolation: false, preload: path.join(__dirname, "preload.js") } }));
module.exports.start = 1;
`;
const preloadJs = `import { contextBridge, ipcRenderer } from "electron";
export const api = { getUser: (id) => ipcRenderer.invoke("get-user", id), log: (m) => ipcRenderer.send("log", m) };
contextBridge.exposeInMainWorld("api", api);
export default api;
//# source${"MappingURL"}=preload.js.map
`;
const dbJs = `exports.find = (id) => ({ id });\nexport * from "./missing.js";\n`;

describe("tokenize/scanJavaScript", () => {
  it("skips comments, strings, regexes and templates while finding references", () => {
    const scan = scanJavaScript(mainJs);
    expect(scan.references.map((r) => `${r.kind}:${r.specifier}:${r.line}`)).toEqual([
      "require:electron:1",
      "require:path:2",
      "require:./lib/db.js:3",
      "dynamic-import:./lazy.mjs:4",
    ]);
    expect(scan.ipc).toEqual([
      { api: "ipcMain.handle", channel: "get-user", line: 8 },
      { api: "ipcMain.on", channel: "log", line: 9 },
      { api: "ipcMain.on", channel: null, line: 10 },
    ]);
    expect(scan.moduleSystem).toBe("cjs");
    expect(scan.exports).toEqual(["start"]);
  });
  it("handles ESM exports, template expressions and source map comments", () => {
    const scan = scanJavaScript(preloadJs);
    expect(scan.references[0]).toMatchObject({
      kind: "import",
      specifier: "electron",
    });
    expect(scan.exports).toEqual(["api", "default"]);
    expect(scan.moduleSystem).toBe("esm");
    expect(scan.sourceMappingUrl).toBe("preload.js.map");
    const { tokens } = tokenize(
      "const x = `a${b}c${d}e`; const y = 1 / 2 / 3; const z = a / b / c;",
    );
    expect(tokens.filter((t) => t.type === "template").map((t) => t.value)).toEqual([
      "a${…}",
      "c${…}",
      "e",
    ]);
    expect(tokens.filter((t) => t.type === "regex")).toHaveLength(0);
  });
  it("marks dynamic specifiers", () => {
    const scan = scanJavaScript("require(name); import(`./locale/${lang}.js`); require('x' + y);");
    expect(scan.references.map((r) => [r.specifier, r.dynamic])).toEqual([
      ["<expression>", true],
      ["./locale/${…}", true],
      ["<expression>", true],
    ]);
  });
});

describe("source maps", () => {
  it("decodes VLQ and resolves positions", () => {
    expect(decodeVlq("AAAA")).toEqual([0, 0, 0, 0]);
    expect(decodeVlq("gBAAC")).toEqual([16, 0, 0, 1]);
    const map = JSON.stringify({
      version: 3,
      file: "out.js",
      sources: ["src/a.ts", "node_modules/@scope/pkg/index.js", "node_modules/lodash/x.js"],
      names: ["foo"],
      mappings: "AAAA,IACAA;AAEA",
      sourcesContent: ["x", null, null],
    });
    const s = summarizeSourceMap(map);
    expect(s).toMatchObject({
      sources: ["src/a.ts", "node_modules/@scope/pkg/index.js", "node_modules/lodash/x.js"],
      sourcesWithContent: 1,
      names: 1,
      mappingCount: 3,
      isIndexMap: false,
    });
    expect(s.packages).toEqual([
      { name: "src", files: 1 },
      { name: "@scope/pkg", files: 1 },
      { name: "lodash", files: 1 },
    ]);
    expect(originalPositionFor(map, 1, 4)).toEqual({
      source: "src/a.ts",
      line: 2,
      column: 0,
      name: "foo",
    });
    expect(originalPositionFor(map, 2, 0)).toEqual({
      source: "src/a.ts",
      line: 4,
      column: 0,
      name: null,
    });
  });
});

describe("ASAR", () => {
  const asar = buildAsar({
    "package.json": JSON.stringify({
      name: "demo",
      version: "1.0.0",
      main: "main.js",
      devDependencies: { electron: "^31.0.0" },
    }),
    "main.js": mainJs,
    "preload.js": preloadJs,
    "lib/db.js": dbJs,
    "lazy.mjs": "export const x = 1;",
  });
  it("reads the pickle header and file tree", () => {
    const archive = openAsar(asar);
    expect(archive.files.map((f) => f.path)).toEqual([
      "package.json",
      "main.js",
      "preload.js",
      "lib/db.js",
      "lazy.mjs",
    ]);
    expect(new TextDecoder().decode(archive.read(archive.find("lib\\db.js")!))).toBe(dbJs);
  });
  it("analyzes the application graph", () => {
    const info = analyzeJavaScriptTree(asarTree(asar, "app.asar"));
    expect(info.package).toMatchObject({
      name: "demo",
      main: "main.js",
      devDependencies: ["electron"],
    });
    expect(info.electron).toEqual({
      version: "^31.0.0",
      preloadScripts: ["preload.js"],
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: null,
      remoteModule: false,
    });
    expect(info.modules.map((m) => `${m.id}:${m.role}`)).toEqual([
      "main.js:main",
      "preload.js:preload",
      "lib/db.js:unknown",
      "lazy.mjs:unknown",
    ]);
    expect(info.edges.filter((e) => e.resolved).map((e) => `${e.from}->${e.to}`)).toEqual([
      "main.js->lib/db.js",
      "main.js->lazy.mjs",
    ]);
    expect(info.edges.find((e) => e.to === "./missing.js")).toMatchObject({
      resolved: false,
      from: "lib/db.js",
    });
    expect(info.externals).toEqual([
      { specifier: "electron", count: 2, builtin: true },
      { specifier: "path", count: 1, builtin: true },
    ]);
    expect(info.ipcChannels).toEqual([
      { channel: "get-user", senders: ["preload.js"], receivers: ["main.js"] },
      { channel: "log", senders: ["preload.js"], receivers: ["main.js"] },
    ]);
    expect(info.findings.map((f) => f.kind)).toEqual([
      "electron.node-integration",
      "electron.context-isolation",
      "electron.ipc",
      "electron.preload",
    ]);
    expect(info.limitations.map((l) => l.code)).toEqual(["unresolved_references"]);
  });
});

describe("directory analysis", () => {
  const dir = mkdtempSync(join(tmpdir(), "hexvero-js-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  it("walks a directory and ignores node_modules sources", () => {
    mkdirSync(join(dir, "src"));
    mkdirSync(join(dir, "node_modules", "x"), { recursive: true });
    writeFileSync(
      join(dir, "src", "index.js"),
      "import x from 'x'; import './util.js'; console.log(x);",
    );
    writeFileSync(join(dir, "src", "util.js"), "export const u = 1;");
    writeFileSync(
      join(dir, "src", "util.js.map"),
      JSON.stringify({ version: 3, sources: ["util.ts"], mappings: "AAAA" }),
    );
    writeFileSync(join(dir, "node_modules", "x", "index.js"), "module.exports = 1;");
    writeFileSync(join(dir, "addon.node"), "");
    const info = analyzeJavaScriptTree(directoryTree(dir));
    expect(info.modules.map((m) => m.id)).toEqual(["src/index.js", "src/util.js"]);
    expect(info.electron).toBeNull();
    expect(info.externals).toEqual([{ specifier: "x", count: 1, builtin: false }]);
    expect(info.sourceMaps).toEqual([
      { file: "src/util.js.map", sources: 1, packages: ["util.ts"] },
    ]);
    expect(info.nativeAddons).toEqual(["addon.node"]);
    expect(info.totals).toMatchObject({ javascript: 2, skipped: 0 });
  });

  it("follows symbolic links only while they stay inside the analyzed directory", () => {
    const root = mkdtempSync(join(tmpdir(), "hexvero-symlink-"));
    const outside = join(tmpdir(), `hexvero-outside-${process.pid}.js`);
    try {
      writeFileSync(join(root, "index.js"), "module.exports = 1;");
      mkdirSync(join(root, "pkg"));
      writeFileSync(join(root, "pkg", "lib.js"), "module.exports = 2;");
      symlinkSync(join(root, "pkg"), join(root, "linked"));
      writeFileSync(outside, "process.env.SECRET");
      symlinkSync(outside, join(root, "evil.js"));
      symlinkSync(tmpdir(), join(root, "escape"));
      const tree = directoryTree(root);
      expect(tree.files.map((f) => f.path).toSorted()).toEqual([
        "index.js",
        "linked/lib.js",
        "pkg/lib.js",
      ]);
      expect(tree.skippedLinks?.toSorted()).toEqual(["escape", "evil.js"]);
      expect(() => tree.read("evil.js")).toThrow(/outside the root/);
      expect(() => tree.read("escape/hexvero-outside-" + process.pid + ".js")).toThrow(
        /outside the root/,
      );
      expect(new TextDecoder().decode(tree.read("linked/lib.js"))).toContain("2");
      expect(existsSync(join(root, "evil.js"))).toBe(true);
    } finally {
      rmSync(outside, { force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
});
