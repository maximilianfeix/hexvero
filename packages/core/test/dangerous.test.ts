import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildSync } from "esbuild";
import { afterAll, describe, expect, it } from "vitest";
import { analyzeJavaScriptTree, asarTree, type JsAppInfo } from "../src/javascript/app.js";
import { auditBuild, checkRelease, parsePolicy, POLICY_RULES, Session } from "../src/index.js";
import { buildAsar } from "./fixtures/asar.js";

/**
 * Calls that run code or styles in a page (`dangerousCalls`): executeJavaScript,
 * executeJavaScriptInIsolatedWorld and insertCSS, with whether the code is a literal. Expected
 * rows are written from the fixture sources; nothing is run.
 */

const dir = mkdtempSync(join(tmpdir(), "hexvero-dangerous-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const analyze = (main: string): JsAppInfo =>
  analyzeJavaScriptTree(
    asarTree(
      buildAsar({
        "package.json": JSON.stringify({ name: "d", main: "main.js" }),
        "main.js": main,
      }),
      "app.asar",
    ),
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
    external: ["electron"],
    outfile,
    logLevel: "silent",
  });
  return readFileSync(outfile, "utf8");
}

const variants = (source: string): Array<[string, string]> => [
  ["plain", source],
  ["bundled", bundled(source, false)],
  ["minified", bundled(source, true)],
];

/** A dangerousCalls row in a few words. */
const calls = (info: JsAppInfo): string[] =>
  info.dangerousCalls.map(
    (r) => `${r.method} ${r.targetKind} ${r.argumentKind} ${r.argument ?? "-"}`,
  );

export const DANGEROUS = `import { BrowserWindow, webFrame } from "electron";
const CSS = "body { color: red }";
export function run(win, code, name) {
  win.webContents.executeJavaScript("document.title");
  win.webContents.executeJavaScript(code);
  win.webContents.executeJavaScript(\`window.greet(\${JSON.stringify(name)})\`);
  win.webContents.insertCSS(CSS);
  win.webContents.insertCSS("h1 {" + name + "}");
  win.webContents.mainFrame.executeJavaScript(code, true);
  webFrame.executeJavaScriptInIsolatedWorld(1, [{ code: "1 + 1" }, { code: "2" }]);
  webFrame.executeJavaScriptInIsolatedWorld(1, [{ code }]);
  const tag = document.querySelector("webview");
  tag.executeJavaScript(code);
  // win.webContents.executeJavaScript(code) in a comment is no call
  return new BrowserWindow();
}
`;

describe("dangerousCalls", () => {
  it("reads executeJavaScript, insertCSS and isolated worlds with how much of the code is read", () => {
    for (const [name, source] of variants(DANGEROUS)) {
      const rows = calls(analyze(source));
      expect(
        rows.map((r) => r.split(" ").slice(0, 3).join(" ")),
        name,
      ).toEqual([
        "executeJavaScript webContents literal",
        "executeJavaScript webContents unknown",
        "executeJavaScript webContents inferred",
        "insertCSS webContents literal",
        "insertCSS webContents inferred",
        "executeJavaScript frame unknown",
        "executeJavaScriptInIsolatedWorld webFrame literal",
        "executeJavaScriptInIsolatedWorld webFrame unknown",
        "executeJavaScript unknown unknown",
      ]);
      if (name === "plain")
        expect(rows.slice(0, 4).map((r) => r.split(" ").slice(3).join(" "))).toEqual([
          "document.title",
          "-",
          "window.greet(",
          "body { color: red }",
        ]);
    }
  });

  it("gives a function of an object literal of the file no row", () => {
    const info = analyze(`const helper = { executeJavaScript(code) { return code; } };
helper.executeJavaScript(x);
`);
    expect(calls(info)).toEqual([]);
  });
});

let n = 0;
const writeApp = (main: string): string => {
  const path = join(dir, `app-${n++}.asar`);
  writeFileSync(
    path,
    buildAsar({ "package.json": JSON.stringify({ name: "d", main: "main.js" }), "main.js": main }),
  );
  return path;
};
const auditOf = async (path: string) => {
  const session = new Session();
  return auditBuild(session, (await session.open(path)).id);
};
const found = (r: Awaited<ReturnType<typeof auditOf>>) =>
  r.findings
    .filter((f) => f.rule === "dangerous-call")
    .map((f) => `${f.unknown ? "?" : "!"} ${f.key}`);

describe("audit dangerous-call", () => {
  it("reports code that is not a literal, unknown on a receiver not read, nothing for literals", async () => {
    for (const [name, source] of variants(DANGEROUS)) {
      const r = await auditOf(writeApp(source));
      expect(found(r).toSorted(), name).toEqual(
        [
          "! executeJavaScript on webContents: code not read",
          '! executeJavaScript on webContents: code starting "window.greet("',
          '! insertCSS on webContents: code starting "h1 {"',
          "! executeJavaScript on frame: code not read",
          "! executeJavaScriptInIsolatedWorld on webFrame: code not read",
          "? executeJavaScript on unknown: code not read",
        ].toSorted(),
      );
    }
  });

  it("keeps fingerprints when the code moves", async () => {
    const a = await auditOf(writeApp(DANGEROUS));
    const b = await auditOf(writeApp(`// moved\n\n${DANGEROUS}`));
    const fp = (r: typeof a) =>
      r.findings.filter((f) => f.rule === "dangerous-call").map((f) => f.fingerprint);
    expect(fp(b)).toEqual(fp(a));
  });
});

describe("check new-dangerous-call", () => {
  const policy = parsePolicy(
    JSON.stringify({
      hexvero: "policy",
      version: 1,
      rules: Object.fromEntries(
        POLICY_RULES.map((id) => [id, { level: id === "new-dangerous-call" ? "fail" : "off" }]),
      ),
    }),
    "policy.json",
  );
  const check = async (a: string, b: string) => {
    const session = new Session();
    const [x, y] = [await session.open(a), await session.open(b)];
    return checkRelease(session, x.id, y.id, policy);
  };
  const BEFORE = `const { BrowserWindow } = require("electron");
export function run(win, code) {
  win.webContents.executeJavaScript(code);
  win.webContents.executeJavaScript("document.title");
}
`;

  it("reports a new call with code that is not a literal, not a new literal or one that stayed", async () => {
    expect((await check(writeApp(BEFORE), writeApp(BEFORE))).findings).toEqual([]);
    const after = `const { BrowserWindow } = require("electron");
export function run(win, code, css) {
  win.webContents.executeJavaScript(code);
  win.webContents.executeJavaScript("document.body.innerText");
  win.webContents.insertCSS(css);
}
`;
    const r = await check(writeApp(BEFORE), writeApp(after));
    expect(r.findings.map((f) => `${f.unknown ? "?" : "!"} ${f.key}`)).toEqual([
      "! insertCSS webContents unknown",
    ]);
    expect(r.status).toBe("fail");
  });
});
