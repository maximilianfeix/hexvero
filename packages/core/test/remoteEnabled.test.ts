import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildSync } from "esbuild";
import { afterAll, describe, expect, it } from "vitest";
import { analyzeJavaScriptTree, asarTree, type JsAppInfo } from "../src/javascript/app.js";
import { checkRelease, parsePolicy, Session } from "../src/index.js";
import { buildAsar } from "./fixtures/asar.js";
import { timeLimit } from "./timeLimit.js";

/**
 * `@electron/remote` turned on (`remoteEnabled`), as Joplin (`require("@electron/remote/main")
 * .enable(this.win_.webContents)`) and Beekeeper Studio (`remoteMain.enable(this.win.webContents)`)
 * write it. The expected rows are written from the fixture sources; nothing is run.
 */

const dir = mkdtempSync(join(tmpdir(), "hexvero-remote-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const files = (extra: Record<string, string>): Record<string, string> => ({
  "package.json": JSON.stringify({ name: "r", main: "main.js" }),
  ...extra,
});
const analyze = (extra: Record<string, string>): JsAppInfo =>
  analyzeJavaScriptTree(asarTree(buildAsar(files(extra)), "app.asar"));
const rows = (info: JsAppInfo): string[] =>
  info.remoteEnabled.map(
    (r) => `${r.kind} ${r.targetKind ?? "-"} ${r.window ?? "-"} ${r.file}:${r.line}`,
  );

function bundled(source: string, minify: boolean): string {
  const src = mkdtempSync(join(dir, "src-"));
  mkdirSync(dirname(join(src, "main.js")), { recursive: true });
  writeFileSync(join(src, "main.js"), source);
  const outfile = join(src, "out.js");
  buildSync({
    entryPoints: [join(src, "main.js")],
    bundle: true,
    minify,
    platform: "node",
    format: "cjs",
    external: ["electron", "@electron/remote", "@electron/remote/main"],
    outfile,
    logLevel: "silent",
  });
  return readFileSync(outfile, "utf8");
}

const MAIN = `const { app, BrowserWindow } = require("electron");
const remoteMain = require("@electron/remote/main");
remoteMain.initialize();
// remoteMain.enable(fake.webContents) in a comment is no call
function helper(contents) { remoteMain.enable(contents); }
function shadow(remoteMain) { remoteMain.enable(other.webContents); }
app.whenReady().then(() => {
  const win = new BrowserWindow({});
  remoteMain.enable(win.webContents);
  helper(win.webContents);
});
app.on("web-contents-created", (e, contents) => { remoteMain.enable(contents); });
module.exports = { helper, shadow };
`;

describe("remoteEnabled", () => {
  it("reads enable and initialize on the name the main module is bound to, by scope", () => {
    const info = analyze({ "main.js": MAIN });
    expect(rows(info)).toEqual([
      "initialize - - main.js:3",
      // a parameter: which webContents it is depends on the callers
      "enable unknown - main.js:5",
      // `shadow(remoteMain)` is another binding of the name: no row at line 6
      "enable window win main.js:9",
      "enable app app main.js:12",
    ]);
    const f = info.findings.find((x) => x.kind === "electron.remote-enabled");
    expect(f?.title).toBe(
      "@electron/remote enabled for a webContents passed in as contents (callers not followed), window win, every webContents (web-contents-created)",
    );
    expect(f?.confidence).toBe("inferred");
  });

  it("reads the call on the require itself, a class's window and the import forms", () => {
    const info = analyze({
      "main.js": `const { BrowserWindow } = require("electron");
class App {
  open() {
    this.win_ = new BrowserWindow({});
    require("@electron/remote/main").enable(this.win_.webContents);
  }
}
module.exports = App;
`,
      "other.mjs": `import { enable as en, initialize } from "@electron/remote/main";
import * as rm from "@electron/remote/main";
initialize();
en(view.webContents);
rm.enable(getContents());
`,
      "ts.js": `const main_1 = __importDefault(require("@electron/remote/main"));
(0, main_1.default.enable)(w.webContents);
main_1.default.initialize();
`,
    });
    expect(rows(info)).toEqual([
      "enable window win_ main.js:5",
      "initialize - - other.mjs:3",
      "enable webContents - other.mjs:4",
      "enable webContents - other.mjs:5",
      "enable webContents - ts.js:2",
      "initialize - - ts.js:3",
    ]);
  });

  it("gives the same rows for the esbuild bundle, plain and minified", () => {
    for (const minify of [false, true]) {
      const info = analyze({ "main.js": bundled(MAIN, minify) });
      expect(
        info.remoteEnabled.map((r) => `${r.kind} ${r.targetKind ?? "-"}`),
        String(minify),
      ).toEqual(["initialize -", "enable unknown", "enable window", "enable app"]);
    }
    const esm = bundled(
      `import { enable } from "@electron/remote/main";
import { BrowserWindow } from "electron";
const w = new BrowserWindow({});
enable(w.webContents);
`,
      true,
    );
    expect(
      rows(analyze({ "main.js": esm })).map((r) => r.split(" ").slice(0, 2).join(" ")),
    ).toEqual(["enable window"]);
  });

  it("says that a renderer loads it when no enable is found", () => {
    const info = analyze({
      "main.js": `require("electron");\n`,
      "renderer.js": `const { dialog } = require("@electron/remote");\n`,
    });
    expect(rows(info)).toEqual(["use - - renderer.js:1"]);
    expect(info.findings.find((x) => x.kind === "electron.remote-enabled")?.title).toBe(
      "@electron/remote is loaded; enable not found in the files read",
    );
  });

  it("takes no name that is written after its declaration, nor a look-alike module", () => {
    const info = analyze({
      "main.js": `let remoteMain = require("@electron/remote/main");
remoteMain = { enable() {} };
remoteMain.enable(win.webContents);
const other = require("@electron/remote-main-lookalike");
other.enable(win.webContents);
const s = "require('@electron/remote/main').enable(x)";
`,
    });
    expect(rows(info)).toEqual([]);
  });

  it("stays linear on a webpack bundle with many modules and requires of them", () => {
    const modules = Array.from(
      { length: 3000 },
      (_, i) => `${i}:e=>{e.exports=require("@electron/remote/main")}`,
    ).join(",");
    const requires = Array.from({ length: 60_000 }, (_, i) => `var a${i}=n(${i % 3000});`).join("");
    const started = performance.now();
    const info = analyze({
      "main.js": `(()=>{var m={${modules}};${requires}a0.enable(w.webContents)})();`,
    });
    expect(performance.now() - started).toBeLessThan(timeLimit(10_000));
    expect(info.remoteEnabled.some((r) => r.kind === "enable")).toBe(true);
  });

  it("stays linear on a file with many calls", () => {
    const calls = Array.from({ length: 5000 }, (_, i) => `r.enable(w${i}.webContents);`).join("\n");
    const started = performance.now();
    const info = analyze({ "main.js": `const r = require("@electron/remote/main");\n${calls}\n` });
    // a cost bound, not a timing assertion: rows are capped per file and the cap is said
    expect(info.remoteEnabled.length).toBe(200);
    expect(info.limitations.map((l) => l.code)).toContain("remote_enabled_truncated");
    expect(performance.now() - started).toBeLessThan(timeLimit(60_000));
  });
});

const check = async (a: string, b: string, rules: Record<string, unknown>) => {
  const session = new Session();
  const ta = await session.open(a);
  const tb = await session.open(b);
  const policy = parsePolicy(
    JSON.stringify({ hexvero: "policy", version: 1, rules, unknown: "fail", suppressions: [] }),
    "policy.json",
  );
  return checkRelease(session, ta.id, tb.id, policy);
};

const write = (name: string, main: string): string => {
  const path = join(dir, `${name}.asar`);
  writeFileSync(
    path,
    buildAsar({
      "package.json": JSON.stringify({
        name,
        main: "main.js",
        devDependencies: { electron: "^38.0.0" },
      }),
      "main.js": main,
    }),
  );
  return path;
};

describe("remote-enabled policy rule", () => {
  const base = `const { BrowserWindow } = require("electron");
const remoteMain = require("@electron/remote/main");
const win = new BrowserWindow({ webPreferences: { contextIsolation: true, sandbox: true } });
`;

  it("reports a window newly enabled, at warn when the policy does not list the rule", async () => {
    const r = await check(
      write("before", base),
      write("after", `${base}remoteMain.enable(win.webContents);\n`),
      {},
    );
    const f = r.findings.filter((x) => x.rule === "remote-enabled");
    expect(f.map((x) => [x.key, x.level, x.unknown])).toEqual([
      ["enable window win", "warn", false],
    ]);
  });

  it("does not report a window the before build enabled already", async () => {
    const enabled = `${base}remoteMain.enable(win.webContents);\n`;
    const r = await check(write("same-a", enabled), write("same-b", `// moved\n${enabled}`), {
      "remote-enabled": { level: "fail" },
    });
    expect(r.findings.filter((x) => x.rule === "remote-enabled")).toEqual([]);
  });
});
