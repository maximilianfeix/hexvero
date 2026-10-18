import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildSync } from "esbuild";
import { afterAll, describe, expect, it } from "vitest";
import { analyzeJavaScriptTree, asarTree, type JsAppInfo } from "../src/javascript/app.js";
import { checkRelease, parsePolicy, Session } from "../src/index.js";
import { buildAsar } from "./fixtures/asar.js";

/**
 * Command-line switches, accepted certificate errors, verify procs and security warnings
 * (`switches`). The expected rows are written from the fixture sources; nothing is run.
 */

const dir = mkdtempSync(join(tmpdir(), "hexvero-switches-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const analyze = (main: string): JsAppInfo =>
  analyzeJavaScriptTree(
    asarTree(
      buildAsar({
        "package.json": JSON.stringify({ name: "s", main: "main.js" }),
        "main.js": main,
      }),
      "app.asar",
    ),
  );
const rows = (info: JsAppInfo): string[] =>
  info.switches.map(
    (r) =>
      `${r.kind} ${r.name ?? "?"}${r.valueRead === "literal" ? `=${r.value}` : r.valueRead === "unknown" ? "=?" : ""} ${r.accepts ?? "-"} ${String(r.dangerous)} ${r.targetKind}`,
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

const MAIN = `const { app, session } = require("electron");
const PORT_SWITCH = "remote-debugging-port";
app.commandLine.appendSwitch("ignore-certificate-errors");
app.commandLine.appendSwitch(PORT_SWITCH, "9222");
app.commandLine.appendSwitch("disable-features", "IsolateOrigins,site-per-process");
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
app.commandLine.appendSwitch(process.env.FLAG);
app.commandLine.appendArgument("--no-sandbox");
// app.commandLine.appendSwitch("disable-web-security") in a comment is no call
const text = 'app.commandLine.appendSwitch("allow-insecure-localhost")';
app.on("certificate-error", (event, webContents, url, error, certificate, callback) => {
  event.preventDefault();
  callback(true);
});
app.on("certificate-error", (event, webContents, url, error, certificate, callback) => {
  if (url.startsWith("https://localhost")) { event.preventDefault(); callback(true); }
  else callback(false);
});
app.on("certificate-error", (event, webContents, url, error, certificate, callback) => {
  callback(false);
});
session.defaultSession.setCertificateVerifyProc((request, callback) => { callback(0); });
process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = "true";
module.exports = { text };
`;

const EXPECTED = [
  "switch ignore-certificate-errors - true app",
  "switch remote-debugging-port=9222 - true app",
  "switch disable-features=IsolateOrigins,site-per-process - true app",
  "switch autoplay-policy=no-user-gesture-required - false app",
  "switch ? - null app",
  "argument --no-sandbox - true app",
  "certificate-error ? always true app",
  "certificate-error ? conditional true app",
  "certificate-verify-proc ? always true session",
  "security-warnings ELECTRON_DISABLE_SECURITY_WARNINGS=true - false process",
];

describe("switches", () => {
  it("reads a minified verify proc wrapped in parentheses, with constants for its results", () => {
    // the shape of Claude's local-pairing session: -2 fails, -3 takes Chromium's result
    const info = analyze(
      `var a=require("electron");var N=[],P=-3,F=-2,I;function L(){return I||(I=a.session.fromPartition("p",{cache:!1}),I.setCertificateVerifyProc(((e,t)=>{if(e.errorCode!==0)return t(F);if(N.length===0)return t(P);t(F)})),I)}module.exports={L};`,
    );
    expect(rows(info)).toEqual(["certificate-verify-proc ? never false session"]);
  });

  it("reads switches, certificate handlers, verify procs and warnings from the main file", () => {
    const info = analyze(MAIN);
    expect(rows(info)).toEqual(EXPECTED);
    const preventing = info.switches.filter((r) => r.kind === "certificate-error");
    expect(preventing.map((r) => r.preventsDefault)).toEqual([true, true]);
    expect(info.findings.map((f) => f.kind)).toContain("electron.unsafe-switch");
  });

  it("gives the same rows for the esbuild bundle, plain and minified", () => {
    for (const minify of [false, true]) {
      // the comment and the string are gone or kept as text; neither is a call
      const info = analyze(bundled(MAIN, minify));
      expect(rows(info), String(minify)).toEqual(EXPECTED);
    }
  });

  it("gives no row for look-alikes", () => {
    const info = analyze(`const { app: electronApp } = require("electron");
const app = { commandLine: { appendSwitch() {} }, on() {} };
app.commandLine.appendSwitch("no-sandbox");
const chrome = { commandLine: { appendSwitch() {} } };
chrome.commandLine.appendSwitch("disable-web-security");
function f(app) { app.commandLine.appendSwitch("no-sandbox"); }
// electronApp.commandLine.appendSwitch("no-sandbox")
const s = "electronApp.commandLine.appendSwitch('no-sandbox')";
electronApp.on("certificate-error", (e, w, u, er, c, cb) => { cb(false); });
electronApp.on("certificate-error", (e, w, u, er, c) => { e.preventDefault(); });
module.exports = { f, s };
`);
    expect(rows(info)).toEqual([]);
  });

  it("reads webpack's module of electron and a minified accepting handler", () => {
    const info = analyze(`(() => {
var m = { 4482(e) { "use strict"; e.exports = require("electron"); } };
function n(id) { var e = { exports: {} }; m[id](e); return e.exports; }
let { app: a } = n(4482), o = n(4482);
a.commandLine.appendSwitch("no-sandbox");
o.app.commandLine.appendSwitch("disable-gpu-sandbox");
o.app.on("certificate-error", (e, t, r, i, s, l) => { e.preventDefault(), l(!0); });
o.app.on("certificate-error", (e, t, r, i, s, l) => { verify(r, l); });
})();
`);
    expect(rows(info)).toEqual([
      "switch no-sandbox - true app",
      "switch disable-gpu-sandbox - true app",
      "certificate-error ? always true app",
      "certificate-error ? unknown null app",
    ]);
  });

  it("reads a verify proc that never reports success as such", () => {
    const info = analyze(`const { session } = require("electron");
const FAIL = -2, CHROMIUM = -3;
session.fromPartition("p").setCertificateVerifyProc((req, cb) => {
  if (req.errorCode !== 0) return cb(FAIL);
  cb(CHROMIUM);
});
session.defaultSession.setCertificateVerifyProc((req, cb) => { if (req.hostname === "x") cb(0); else cb(-3); });
`);
    expect(rows(info)).toEqual([
      "certificate-verify-proc ? never false session",
      "certificate-verify-proc ? conditional true session",
    ]);
  });
});

const NORMALIZED = `const { app } = require("electron");
app.commandLine.appendSwitch("disable-web-security=1");
app.commandLine.appendSwitch(" --No-Sandbox ");
app.commandLine.appendArgument("--ignore-certificate-errors=true");
app.commandLine.appendArgument("positional");
app.commandLine.appendSwitch("disable-features", " isolateorigins , Foo");
app.commandLine.appendSwitch("disable-features=SitePerProcess");
app.commandLine.appendSwitch("no sandbox");
app.on("certificate-error", (event, wc, url, error, cert, ...rest) => { rest[0](true); });
app.on("certificate-error", (event, wc, url, error, cert, { cb }) => { cb(true); });
app.on("certificate-error", (event, wc, url, error, cert, cb = noop) => { cb(true); });
app.on("certificate-error", function (event) { arguments[5](true); });
app.on("certificate-error", (event, wc) => { event.preventDefault(); });
function noop() {}
`;
const NORMALIZED_ROWS = [
  "switch disable-web-security=1 - true app",
  "switch No-Sandbox - true app",
  "argument --ignore-certificate-errors=true - true app",
  "argument positional - false app",
  "switch disable-features= isolateorigins , Foo - true app",
  "switch disable-features=SitePerProcess - true app",
  "switch no sandbox - null app",
  "certificate-error ? unknown null app",
  "certificate-error ? unknown null app",
  "certificate-error ? unknown null app",
  "certificate-error ? unknown null app",
];

describe("switches: names normalized, callbacks that are not plain parameters, the cap", () => {
  it("normalizes names and values and reads unplain callbacks as unknown, plain, bundled and minified", () => {
    for (const [label, source] of [
      ["plain", NORMALIZED],
      ["bundled", bundled(NORMALIZED, false)],
      ["minified", bundled(NORMALIZED, true)],
    ] as const)
      expect(rows(analyze(source)), label).toEqual(NORMALIZED_ROWS);
  });

  it("drops only harmless rows past the cap and says so", () => {
    const harmless = Array.from(
      { length: 205 },
      (_, i) => `app.commandLine.appendSwitch("harmless-${i}");`,
    ).join("\n");
    const info = analyze(`const { app } = require("electron");
${harmless}
app.commandLine.appendSwitch("no-sandbox");
app.commandLine.appendSwitch(process.env.X);
`);
    expect(info.switches.length).toBe(200);
    expect(info.switches.filter((r) => r.dangerous !== false).map((r) => r.name)).toEqual([
      "no-sandbox",
      null,
    ]);
    expect(info.limitations.map((l) => l.code)).toContain("switches_truncated");
  });
});

const write = (name: string, main: string): string => {
  const path = join(dir, `${name}.asar`);
  writeFileSync(
    path,
    buildAsar({ "package.json": JSON.stringify({ name, main: "main.js" }), "main.js": main }),
  );
  return path;
};
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

describe("new-unsafe-switch policy rule", () => {
  const before = `const { app } = require("electron");
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
app.commandLine.appendSwitch("no-sandbox");
`;
  it("warns on a new dangerous switch and newly accepted certificate errors when unlisted", async () => {
    const after = `${before}app.commandLine.appendSwitch("ignore-certificate-errors");
app.commandLine.appendSwitch("force-ui-direction", "rtl");
app.on("certificate-error", (event, w, u, e, c, callback) => { event.preventDefault(); callback(true); });
`;
    const r = await check(write("before", before), write("after", after), {});
    const f = r.findings.filter((x) => x.rule === "new-unsafe-switch");
    expect(f.map((x) => [x.key, x.level, x.unknown])).toEqual([
      ["certificate-error accepts always", "warn", false],
      ["switch ignore-certificate-errors", "warn", false],
    ]);
  });

  it("is undecidable when a side's switches list is truncated", async () => {
    const many = Array.from(
      { length: 205 },
      (_, i) => `app.commandLine.appendSwitch("h-${i}");`,
    ).join("\n");
    const r = await check(write("cap-a", before), write("cap-b", `${before}${many}\n`), {
      "new-unsafe-switch": { level: "fail" },
    });
    expect(r.incomplete.filter((i) => i.rule === "new-unsafe-switch")).toEqual([
      { rule: "new-unsafe-switch", collection: "switches", gaps: ["values_unresolved"] },
    ]);
    expect(r.status).toBe("incomplete");
  });

  it("does not report a switch the before build had already", async () => {
    const r = await check(write("same-a", before), write("same-b", `// moved\n${before}`), {
      "new-unsafe-switch": { level: "fail" },
    });
    expect(r.findings.filter((x) => x.rule === "new-unsafe-switch")).toEqual([]);
  });
});
