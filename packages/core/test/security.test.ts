import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildSync } from "esbuild";
import { afterAll, describe, expect, it } from "vitest";
import { analyzeJavaScriptTree, asarTree, type JsAppInfo } from "../src/javascript/app.js";
import { cspMetaRows, cspWeaknesses, schemeOf } from "../src/javascript/security.js";
import { auditBuild, checkRelease, parsePolicy, Session } from "../src/index.js";
import { buildAsar } from "./fixtures/asar.js";

/**
 * shell.openExternal calls, permission handlers and Content Security Policies (`openExternal`,
 * `permissionHandlers`, `csp`), and the single-build audit. Expected rows are written from the
 * fixture sources; nothing is run.
 */

const dir = mkdtempSync(join(tmpdir(), "hexvero-security-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const analyze = (main: string, extra: Record<string, string> = {}): JsAppInfo =>
  analyzeJavaScriptTree(
    asarTree(
      buildAsar({
        "package.json": JSON.stringify({ name: "s", main: "main.js" }),
        "main.js": main,
        ...extra,
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

const opens = (info: JsAppInfo): string[] =>
  info.openExternal.map(
    (r) =>
      `${r.targetKind} ${r.argumentKind} ${r.argument ?? (r.values ? r.values.join("|") : "-")} ${r.scheme ?? "-"}`,
  );
const perms = (info: JsAppInfo): string[] =>
  info.permissionHandlers.map((r) => `${r.kind} ${r.targetKind} ${r.session ?? "-"} ${r.grants}`);
const csps = (info: JsAppInfo): string[] =>
  info.csp.map(
    (r) =>
      `${r.kind}${r.via ? `/${r.via}` : ""}${r.reportOnly ? " report-only" : ""} ${r.policy ?? "?"} [${r.weaknesses === null ? "?" : r.weaknesses.join("; ")}]`,
  );

const OPEN = `import { shell } from "electron";
import * as electron from "electron";
const HOME = "https://example.com";
export function open(url, repo) {
  shell.openExternal("https://example.com/docs");
  shell.openExternal(HOME);
  shell.openExternal(\`https://github.com/\${repo}\`);
  shell.openExternal("file://" + url);
  electron.shell.openExternal(url);
  // shell.openExternal(url) in a comment is no call
  const text = "shell.openExternal(url)";
  return text;
}
`;

describe("openExternal", () => {
  it("reads shell.openExternal calls and their URL argument", () => {
    expect(opens(analyze(OPEN))).toEqual([
      "shell literal https://example.com/docs https",
      "shell literal https://example.com https",
      "shell inferred https://github.com/ https",
      "shell inferred file:// file",
      "shell unknown - -",
    ]);
  });

  it("gives the same rows for the esbuild bundle, plain and minified", () => {
    for (const minify of [false, true]) {
      const rows = opens(analyze(bundled(OPEN, minify)));
      expect(rows.map((r) => r.split(" ").slice(0, 2).join(" "))).toEqual([
        "shell literal",
        "shell literal",
        "shell inferred",
        "shell inferred",
        "shell unknown",
      ]);
    }
  });

  it("reads require forms, a destructured method and webpack's module of electron", () => {
    const info = analyze(`const { shell: sh } = require("electron");
const e = require("electron");
const s2 = e.shell;
sh.openExternal(a);
s2.openExternal(b);
require("electron").shell.openExternal(c);
e.shell["openExternal"](d);
const { openExternal } = require("electron").shell;
openExternal(f);
`);
    expect(opens(info)).toEqual([
      "shell unknown - -",
      "shell unknown - -",
      "shell unknown - -",
      "shell unknown - -",
      "shell unknown - -",
    ]);
    const webpack = analyze(
      `var r={12:e=>{"use strict";e.exports=require("electron")}},o={};function n(t){var i=o[t];if(void 0!==i)return i.exports;var a=o[t]={exports:{}};return r[t](a,a.exports,n),a.exports}var a=n(12);a.shell.openExternal(u);n(12).shell.openExternal("https://x.org");`,
    );
    expect(opens(webpack)).toEqual(["shell unknown - -", "shell literal https://x.org https"]);
  });

  it("gives unknown-target rows for receivers not read as Electron's shell, none for look-alikes", () => {
    const info = analyze(`const { shell } = require("electron");
function open(shell, url) { shell.openExternal(url); }
const fake = { openExternal(u) { return u; } };
fake.openExternal(x);
const nested = { a: { openExternal: (u) => u } };
nested.a.openExternal(y);
const viaApp = { s: shell };
viaApp.s.openExternal(z);
window.api.openExternal(w);
function openExternal(u) {}
openExternal(v);
class Links { openExternal(u) {} go() { this.openExternal(q); } }
`);
    expect(opens(info)).toEqual([
      "unknown unknown - -",
      "unknown unknown - -",
      "unknown unknown - -",
      "unknown unknown - -",
    ]);
    expect(info.openExternal.map((r) => r.target)).toEqual([
      "shell",
      "viaApp.s",
      "window.api",
      "this",
    ]);
  });

  it("reads the scheme as a URL parser does and a short list of values", () => {
    expect(schemeOf("  \tHTTPS://x")).toBe("https");
    expect(schemeOf("\u0000java\tscript:alert(1)")).toBe("javascript");
    expect(schemeOf("/relative")).toBeNull();
    const info = analyze(`const { shell } = require("electron");
const url = flag ? "https://a.example" : "https://b.example";
shell.openExternal(url);
`);
    // a conditional value is not one the resolver reads whole: never a literal
    expect(info.openExternal[0]?.argumentKind).not.toBe("literal");
  });

  it("stays bounded on many calls and keeps the risky one past the cap", () => {
    const calls = Array.from(
      { length: 1500 },
      (_, i) => `shell.openExternal("https://e.org/${i}");`,
    );
    const source = `const { shell } = require("electron");\n${calls.join("\n")}\nshell.openExternal(userUrl);\n`;
    const t = performance.now();
    const info = analyze(source);
    expect(performance.now() - t).toBeLessThan(20_000);
    expect(info.openExternal.some((r) => r.argumentKind === "unknown")).toBe(true);
    expect(info.limitations.map((l) => l.code)).toContain("open_external_truncated");
  });

  it("reads deeply nested arguments without blowing up", () => {
    const deep = `${"(".repeat(20_000)}u${")".repeat(20_000)}`;
    const info = analyze(`const { shell } = require("electron");\nshell.openExternal(${deep});\n`);
    expect(info.openExternal.length).toBeLessThanOrEqual(1);
    expect(info.openExternal.every((r) => r.argumentKind !== "literal")).toBe(true);
  });
});

const PERMS = `const { session, app } = require("electron");
const ALLOWED = ["notifications"];
app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
    callback(true);
  });
  session.fromPartition("persist:main").setPermissionRequestHandler((wc, permission, cb) => {
    cb(ALLOWED.includes(permission));
  });
  const ses = session.defaultSession;
  ses.setPermissionCheckHandler(() => true);
  ses.setPermissionCheckHandler((wc, permission) => {
    if (permission === "notifications") return true;
    return false;
  });
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => callback(false));
  session.defaultSession.setPermissionRequestHandler(null);
  session.defaultSession.setPermissionRequestHandler(onPermission);
  session.defaultSession.setPermissionRequestHandler((wc, p, ...rest) => rest[0](true));
  session.defaultSession.setPermissionRequestHandler((wc, p, cb) => { setTimeout(() => cb(true)); });
});
`;

describe("permissionHandlers", () => {
  it("reads handlers, their sessions and what they grant", () => {
    expect(perms(analyze(PERMS))).toEqual([
      "request session default always",
      "request session partition:persist:main computed",
      "check session default always",
      "check session default conditional",
      "request session default never",
      "request session default always",
      "request session default unknown",
      "request session default unknown",
      // `setTimeout(() => cb(true))`: the grant runs when the timer calls it, not read
      "request session default unknown",
    ]);
  });

  it("gives the same rows for the esbuild bundle, plain and minified", () => {
    const plain = perms(analyze(PERMS));
    expect(perms(analyze(bundled(PERMS, false)))).toEqual(plain);
    // esbuild turns `if (p === "x") return true; return false;` into `p === "x"`: a computed
    // answer, neither of which is a grant of every check
    expect(perms(analyze(bundled(PERMS, true)))).toEqual(
      plain.map((r) =>
        r === "check session default conditional" ? "check session default computed" : r,
      ),
    );
  });

  it("reads the handler of Electronegativity issue #113 as never granting", () => {
    const info = analyze(`const { session } = require("electron");
session.defaultSession.setPermissionRequestHandler(
  (webContents, permission, callback) => {
    const requestingUrl = new URL(webContents.getURL());
    logAction(\`Permission request for '\${permission}' from '\${requestingUrl.origin}' was denied.\`);
    return callback(false);
  },
);
`);
    expect(perms(info)).toEqual(["request session default never"]);
  });

  it("reads look-alike and unproven receivers", () => {
    const info = analyze(`const { session } = require("electron");
const fake = { setPermissionRequestHandler(h) {} };
fake.setPermissionRequestHandler((a, b, cb) => cb(true));
function setup(ses) { ses.setPermissionRequestHandler((a, b, cb) => cb(true)); }
win.webContents.session.setPermissionCheckHandler(() => false);
const session2 = { defaultSession: {} };
session2.defaultSession.setPermissionRequestHandler((a, b, cb) => cb(true));
`);
    expect(perms(info)).toEqual([
      "request unknown - always",
      "check webContents - never",
      "request unknown - always",
    ]);
  });
});

const HTML = `<!doctype html>
<html><head>
<!-- <meta http-equiv="Content-Security-Policy" content="default-src *"> -->
<meta charset="utf-8">
<META HTTP-EQUIV="Content-Security-Policy" CONTENT="default-src 'self'; script-src 'self' 'unsafe-inline'">
<meta http-equiv=content-security-policy content=default-src&#x20;'none'>
<meta http-equiv="Content-Security-Policy-Report-Only" content="default-src 'none'">
<script>const s = '<meta http-equiv="Content-Security-Policy" content="x">';</script>
<title><meta http-equiv="Content-Security-Policy" content="y"></title>
</head></html>`;

describe("csp", () => {
  it("reads <meta> policies from HTML, skipping comments, scripts and report-only", () => {
    const { rows } = cspMetaRows(HTML, "index.html");
    expect(rows.map((r) => `${r.line} ${r.policy}`)).toEqual([
      "5 default-src 'self'; script-src 'self' 'unsafe-inline'",
      "6 default-src 'none'",
    ]);
  });

  it("reads header policies in onHeadersReceived and elsewhere", () => {
    const info = analyze(
      `const { session } = require("electron");
const POLICY = "default-src 'self'";
session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
  callback({ responseHeaders: { ...details.responseHeaders, "Content-Security-Policy": [POLICY] } });
});
session.defaultSession.webRequest.onHeadersReceived({ urls: ["*://*/*"] }, (d, cb) => {
  d.responseHeaders["content-security-policy"] = [computePolicy()];
  cb({ responseHeaders: d.responseHeaders });
});
const headers = { "Content-Security-Policy-Report-Only": "default-src 'none'" };
const server = { "Content-Security-Policy": "script-src *" };
`,
      { "index.html": HTML },
    );
    expect(csps(info)).toEqual([
      "header/onHeadersReceived default-src 'self' []",
      "header/onHeadersReceived ? [?]",
      "header/other report-only default-src 'none' []",
      "header/other script-src * [script-src allows *; no object-src or default-src: plugins are not restricted]",
      "meta default-src 'self'; script-src 'self' 'unsafe-inline' [script-src allows 'unsafe-inline']",
      "meta default-src 'none' []",
    ]);
  });

  it("judges policies by the documented rules", () => {
    expect(cspWeaknesses("default-src 'self'")).toEqual([]);
    expect(cspWeaknesses("img-src *")).toEqual([
      "no script-src or default-src: scripts are not restricted",
      "no object-src or default-src: plugins are not restricted",
    ]);
    expect(cspWeaknesses("default-src 'self'; script-src 'unsafe-inline' 'nonce-abc'")).toEqual([]);
    expect(cspWeaknesses("default-src 'self' 'unsafe-eval' https:")).toEqual([
      "default-src allows 'unsafe-eval'",
      "default-src allows https:",
    ]);
    // the first of a repeated directive counts
    expect(cspWeaknesses("script-src 'self'; script-src *; object-src 'none'")).toEqual([]);
  });

  it("reads hostile HTML in one pass", () => {
    const hostile = `${"<meta ".repeat(200_000)}${"<!--".repeat(10_000)}<meta http-equiv="Content-Security-Policy" content="x`;
    const t = performance.now();
    const { rows } = cspMetaRows(hostile, "x.html");
    expect(performance.now() - t).toBeLessThan(10_000);
    expect(rows.length).toBeLessThanOrEqual(50);
  });
});

const write = (name: string, files: Record<string, string>): string => {
  const path = join(dir, name);
  writeFileSync(path, buildAsar(files));
  return path;
};

describe("hexvero audit", () => {
  it("passes a build that sets what the rules ask for", async () => {
    const path = write("safe.asar", {
      "package.json": JSON.stringify({
        name: "safe",
        main: "main.js",
        devDependencies: { electron: "^33.0.0" },
      }),
      "main.js": `const { app, BrowserWindow, session, shell } = require("electron");
app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((wc, p, cb) => cb(p === "notifications"));
  const win = new BrowserWindow({ webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } });
  win.loadFile("index.html");
  shell.openExternal("https://example.com");
});
`,
      "index.html": `<meta http-equiv="Content-Security-Policy" content="default-src 'self'">`,
    });
    const session = new Session();
    const { id } = await session.open(path);
    const result = await auditBuild(session, id);
    expect(result.findings).toEqual([]);
    expect(result.status).toBe("pass");
  });

  it("fails on each rule and stays undecidable on unknowns", async () => {
    const path = write("unsafe.asar", {
      "package.json": JSON.stringify({ name: "u", main: "main.js" }),
      "main.js": `const { app, shell, session } = require("electron");
app.commandLine.appendSwitch("ignore-certificate-errors");
session.defaultSession.setPermissionCheckHandler(() => true);
ipcMain.on("open", (e, url) => shell.openExternal(url));
function helper(s, u) { s.openExternal(u); }
`,
    });
    const session = new Session();
    const { id } = await session.open(path);
    const result = await auditBuild(session, id);
    expect(result.status).toBe("fail");
    expect(result.findings.map((f) => `${f.rule}${f.unknown ? "?" : ""}`)).toEqual([
      "unsafe-switch",
      // by key: s.openExternal before shell.openExternal
      "open-external?",
      "open-external",
      "permission-handler-missing",
      "permission-handler-grants-all",
      "csp-missing",
    ]);
    const only = write("unknown-only.asar", {
      "package.json": JSON.stringify({ name: "u", main: "main.js" }),
      "main.js": `const { session } = require("electron");
session.defaultSession.setPermissionRequestHandler((a, b, cb) => cb(false));
session.defaultSession.webRequest.onHeadersReceived((d, cb) => cb({ responseHeaders: { "Content-Security-Policy": [make()] } }));
`,
    });
    const id2 = (await session.open(only)).id;
    const r2 = await auditBuild(session, id2);
    expect(r2.findings.map((f) => `${f.rule}${f.unknown ? "?" : ""}`)).toEqual(["csp-weak?"]);
    expect(r2.status).toBe("incomplete");
    expect((await auditBuild(session, id2, { unknown: "warn" })).status).toBe("pass");
  });

  it("leaves an absence undecided when the scan is partial", async () => {
    const files: Record<string, string> = {
      "package.json": JSON.stringify({ name: "p", main: "main.js" }),
      "main.js": `require("electron");\n`,
    };
    for (let i = 0; i < 5; i++) files[`f${i}.js`] = `module.exports = ${i};\n`;
    const path = write("partial.asar", files);
    const session = new Session();
    const { id } = await session.open(path);
    await session.continueAnalysis(id, { maxJsFiles: 2 });
    const result = await auditBuild(session, id);
    expect(result.findings.map((f) => f.rule)).not.toContain("permission-handler-missing");
    expect(result.incomplete.map((i) => i.rule)).toContain("permission-handler-missing");
    expect(result.status).toBe("incomplete");
  });

  it("refuses a target that is no Electron application", async () => {
    const path = join(dir, "plain.js");
    writeFileSync(path, "console.log(1);\n");
    const session = new Session();
    const { id } = await session.open(path);
    await expect(auditBuild(session, id)).rejects.toThrow(/Electron application/);
  });
});

const writeApp = (name: string, files: Record<string, string>): string =>
  write(`${name}.asar`, { "package.json": JSON.stringify({ name, main: "main.js" }), ...files });
const check = async (a: string, b: string, rules: Record<string, unknown> = {}) => {
  const session = new Session();
  const ta = await session.open(a);
  const tb = await session.open(b);
  const policy = parsePolicy(
    JSON.stringify({ hexvero: "policy", version: 1, rules, unknown: "fail", suppressions: [] }),
    "policy.json",
  );
  return checkRelease(session, ta.id, tb.id, policy);
};

const ours = (r: Awaited<ReturnType<typeof check>>) =>
  r.findings
    .filter((f) =>
      ["new-open-external", "permission-handler-grants-all", "csp-weakened"].includes(f.rule),
    )
    .map((f) => `${f.rule} ${f.level}${f.unknown ? " unknown" : ""} ${f.key}`);

describe("check rules: new-open-external, permission-handler-grants-all, csp-weakened", () => {
  const MAIN = `const { shell, session, ipcMain } = require("electron");
shell.openExternal("https://example.com");
session.defaultSession.setPermissionRequestHandler((wc, p, cb) => cb(p === "notifications"));
`;
  const PAGE = `<meta http-equiv="Content-Security-Policy" content="default-src 'self'">`;

  it("warns (unlisted) on a new unfixed URL, a handler granting all and a weaker policy", async () => {
    const a = writeApp("sec-a", { "main.js": MAIN, "index.html": PAGE });
    const b = writeApp("sec-b", {
      "main.js": `${MAIN}ipcMain.on("open", (e, url) => shell.openExternal(url));
session.defaultSession.setPermissionCheckHandler(() => true);
`,
      "index.html": `<meta http-equiv="Content-Security-Policy" content="default-src 'self' 'unsafe-eval'">`,
    });
    const r = await check(a, b);
    expect(ours(r)).toEqual([
      "new-open-external warn shell openExternal unknown",
      "permission-handler-grants-all warn check handler on default grants always",
      "csp-weakened warn default-src allows 'unsafe-eval'",
    ]);
    expect(r.status).toBe("pass");
    const strict = await check(a, b, {
      "new-open-external": { level: "fail" },
      "permission-handler-grants-all": { level: "fail" },
      "csp-weakened": { level: "fail" },
    });
    expect(strict.status).toBe("fail");
  });

  it("reports a request handler and a policy that are gone", async () => {
    const a = writeApp("gone-a", { "main.js": MAIN, "index.html": PAGE });
    const b = writeApp("gone-b", {
      "main.js": `const { shell } = require("electron");\nshell.openExternal("https://example.com");\n`,
      "index.html": "<p>no policy</p>",
    });
    expect(ours(await check(a, b))).toEqual([
      "permission-handler-grants-all warn setPermissionRequestHandler removed",
      "csp-weakened warn Content-Security-Policy removed",
    ]);
  });

  it("does not report what the before build already had, moved or not", async () => {
    const both = `${MAIN}shell.openExternal(url);\n`;
    const a = writeApp("same-a", { "main.js": both, "index.html": PAGE });
    const b = writeApp("same-b", { "main.js": `// moved\n${both}`, "index.html": `\n${PAGE}` });
    expect(ours(await check(a, b))).toEqual([]);
  });

  it("is undecidable when an HTML file of a side is not read", async () => {
    const a = writeApp("html-a", { "main.js": MAIN, "index.html": PAGE });
    const pages: Record<string, string> = { "main.js": MAIN, "index.html": PAGE };
    for (let i = 0; i < 2001; i++) pages[`pages/p${i}.html`] = "<p></p>";
    const b = writeApp("html-b", pages);
    const r = await check(a, b, { "csp-weakened": { level: "fail" } });
    expect(r.incomplete.filter((i) => i.rule === "csp-weakened")).toEqual([
      { rule: "csp-weakened", collection: "csp", gaps: ["values_unresolved"] },
    ]);
    expect(r.status).toBe("incomplete");
    const session = new Session();
    const audit = await auditBuild(session, (await session.open(b)).id);
    expect(audit.incomplete.map((i) => i.rule)).toEqual(["csp-missing", "csp-weak"]);
  });
});

const metaRows = (body: string): string =>
  cspMetaRows(body, "i.html")
    .rows.map((r) => `${r.policy} ${r.outsideHead ? "outside" : "head"}`)
    .join(" | ");
const metaTag = (p: string): string => `<meta http-equiv="Content-Security-Policy" content="${p}">`;

describe("fail-open fixes (review round 1)", () => {
  it("infers a URL prefix only for a template alone or a chain of + operands", () => {
    const info = analyze(`const { shell } = require("electron");
shell.openExternal(\`https://a.example/\${p}\`);
shell.openExternal("https://a.example/" + p + q);
shell.openExternal("https://a.example/" + p || u);
shell.openExternal(\`https://a.example/\${p}\` && u);
shell.openExternal(flag ? "https://a.example/" + p : u);
shell.openExternal("https://a.example/" + p ?? u);
shell.openExternal(\`https://a.example/\${p}\`.replace("https:", s));
shell.openExternal("https://a.example/".concat(p));
shell.openExternal("https://a.example/" + p, opts);
shell.openExternal(("https://a.example/" + p) || u);
`);
    expect(info.openExternal.map((r) => r.argumentKind)).toEqual([
      "inferred",
      "inferred",
      "unknown",
      "unknown",
      "unknown",
      "unknown",
      "unknown",
      "unknown",
      "inferred",
      "unknown",
    ]);
  });

  it("applies a <meta> policy only in <head>; template and noscript content none", () => {
    expect(metaRows(`<!doctype html><html><head>${metaTag("a")}</head><body></body></html>`)).toBe(
      "a head",
    );
    expect(metaRows(`<html><head></head><body>${metaTag("b")}</body></html>`)).toBe("b outside");
    expect(metaRows(`<html><head><title>t</title></head>${metaTag("c")}`)).toBe("c outside");
    expect(metaRows(`hello ${metaTag("d")}`)).toBe("d outside");
    expect(metaRows(`<div></div>${metaTag("e")}`)).toBe("e outside");
    expect(
      metaRows(
        `<head><template>${metaTag("f")}</template><noscript>${metaTag("g")}</noscript>${metaTag("h")}`,
      ),
    ).toBe("h head");
    // a <meta> after the head is no applied policy: csp-missing becomes unknown
    expect(
      csps(analyze("", { "index.html": `<body><p>x</p>${metaTag("default-src 'self'")}</body>` })),
    ).toEqual(["meta default-src 'self' []"]);
  });

  it("audit: a <meta> outside the head leaves csp-missing unknown, never passed", async () => {
    const path = write("outside.asar", {
      "package.json": JSON.stringify({ name: "o", main: "main.js" }),
      "main.js": `const { session } = require("electron");
session.defaultSession.setPermissionRequestHandler((a, b, cb) => cb(false));
`,
      "index.html": `<body><p>x</p><meta http-equiv="Content-Security-Policy" content="default-src 'self'"></body>`,
    });
    const session = new Session();
    const result = await auditBuild(session, (await session.open(path)).id);
    expect(result.findings.map((f) => `${f.rule}${f.unknown ? "?" : ""}`)).toEqual([
      "csp-missing?",
    ]);
    expect(result.status).toBe("incomplete");
  });

  it("check: a second unfixed openExternal call is new although the before build had one", async () => {
    const one = `const { shell } = require("electron");\nipcMain.on("a", (e, u) => shell.openExternal(u));\n`;
    const a = writeApp("multi-a", { "main.js": one });
    const b = writeApp("multi-b", {
      "main.js": `${one}ipcMain.on("b", (e, v) => shell.openExternal(v));\n`,
    });
    expect(ours(await check(a, b))).toEqual(["new-open-external warn shell openExternal unknown"]);
    // the same call only moved: nothing new
    const c = writeApp("multi-c", { "main.js": `// moved\n${one}` });
    expect(ours(await check(a, c))).toEqual([]);
  });

  it("check: CSP weaknesses are compared per applied policy, not build-wide", async () => {
    const MAINC = `const { session } = require("electron");
session.defaultSession.setPermissionRequestHandler((a, b, cb) => cb(false));
const server = { "Content-Security-Policy": "default-src 'self' 'unsafe-eval'" };
`;
    const strict = `<meta http-equiv="Content-Security-Policy" content="default-src 'self'">`;
    const evalPolicy = `<meta http-equiv="Content-Security-Policy" content="default-src 'self' 'unsafe-eval'">`;
    // before: the eval weakness only in a header that may not apply, and in another page
    const a = writeApp("pp-a", {
      "main.js": MAINC,
      "index.html": strict,
      "other.html": evalPolicy,
    });
    const b = writeApp("pp-b", {
      "main.js": MAINC,
      "index.html": evalPolicy,
      "other.html": evalPolicy,
    });
    expect(ours(await check(a, b))).toEqual(["csp-weakened warn default-src allows 'unsafe-eval'"]);
  });
});

const header = (key: string): string => `const { session } = require("electron");
session.defaultSession.webRequest.onHeadersReceived((d, c) =>
  c({ responseHeaders: { ...d.responseHeaders, "${key}": ["default-src 'self'"] } }));
`;

describe("fail-open fixes (review round 2)", () => {
  it("check: a policy made report-only, or a default-session handler dropped, is reported", async () => {
    const a = writeApp("ro-a", { "main.js": header("Content-Security-Policy") });
    const b = writeApp("ro-b", { "main.js": header("Content-Security-Policy-Report-Only") });
    const r = await check(a, b, { "csp-weakened": { level: "fail" } });
    expect(ours(r)).toContain("csp-weakened fail Content-Security-Policy removed");
    expect(r.status).toBe("fail");

    const both = `const { session } = require("electron");
session.defaultSession.setPermissionRequestHandler((w, p, cb) => cb(false));
session.fromPartition("p").setPermissionRequestHandler((w, p, cb) => cb(false));
`;
    const partOnly = `const { session } = require("electron");
session.fromPartition("p").setPermissionRequestHandler((w, p, cb) => cb(false));
`;
    expect(
      ours(
        await check(
          writeApp("ps-a", { "main.js": both }),
          writeApp("ps-b", { "main.js": partOnly }),
        ),
      ),
    ).toEqual([
      "permission-handler-grants-all warn setPermissionRequestHandler removed for default",
    ]);
  });

  it("audit: handlers only on a partition or an unproven receiver leave the default session unknown", async () => {
    for (const [name, main] of [
      [
        "part",
        `const { session } = require("electron");\nsession.fromPartition("unused").setPermissionRequestHandler((w, p, cb) => cb(false));\n`,
      ],
      [
        "wc",
        `function f(x) { x.webContents.session.setPermissionRequestHandler((w, p, cb) => cb(false)); }\n`,
      ],
    ] as const) {
      const path = write(`${name}-only.asar`, {
        "package.json": JSON.stringify({ name, main: "main.js" }),
        "main.js": main,
        "index.html": `<meta http-equiv="Content-Security-Policy" content="default-src 'self'">`,
      });
      const session = new Session();
      const result = await auditBuild(session, (await session.open(path)).id);
      expect(result.findings.map((f) => `${f.rule}${f.unknown ? "?" : ""}`)).toEqual([
        "permission-handler-missing?",
      ]);
    }
  });

  it("reads grants in try, bare blocks, comma sequences and after ASI as unconditional", () => {
    const info = analyze(`const { session } = require("electron");
const s = session.defaultSession;
s.setPermissionRequestHandler((w, p, cb) => { try { cb(true) } catch (e) {} });
s.setPermissionRequestHandler((w, p, cb) => { { cb(true) } });
s.setPermissionRequestHandler((w, p, cb) => (cb(true), 0));
s.setPermissionRequestHandler((w, p, cb) => {
  if (p === "x") console.log(p)
  cb(true)
});
s.setPermissionCheckHandler((w, p) => {
  if (p) log(p)
  return true
});
s.setPermissionRequestHandler((w, p, cb) => { Promise.resolve().then(() => cb(true)); });
s.setPermissionRequestHandler((w, p, cb) => {
  if (p === "x")
    cb(true)
});
s.setPermissionRequestHandler((w, p, cb) => cb({}));
`);
    expect(perms(info)).toEqual([
      "request session default always",
      "request session default always",
      "request session default always",
      "request session default always",
      "check session default always",
      "request session default unknown",
      "request session default conditional",
      "request session default always",
    ]);
  });

  it("gives a row for openExternal references that are not called here", () => {
    const info = analyze(`const { shell } = require("electron");
const e = require("electron");
const { openExternal: o } = shell;
const open = shell.openExternal;
const bound = shell.openExternal.bind(shell);
shell.openExternal?.(u1);
shell.openExternal.call(shell, u2);
(0, e.shell.openExternal)(u3);
const notShell = { openExternal: 1 };
`);
    expect(opens(info)).toEqual([
      "shell unknown - -",
      "shell unknown - -",
      "shell unknown - -",
      "shell unknown - -",
      "shell unknown - -",
      "shell unknown - -",
    ]);
  });

  it("judges script-src-elem, script-src-attr, host wildcards, empty nonces and object-src schemes", () => {
    expect(cspWeaknesses("default-src 'self'; script-src-elem * 'unsafe-inline'")).toEqual([
      "script-src-elem allows 'unsafe-inline'",
      "script-src-elem allows *",
    ]);
    expect(cspWeaknesses("default-src 'self' https://*")).toEqual(["default-src allows https://*"]);
    expect(cspWeaknesses("default-src 'self'; script-src 'self' 'unsafe-inline' 'nonce-'")).toEqual(
      ["script-src allows 'unsafe-inline'"],
    );
    expect(cspWeaknesses("default-src 'self'; object-src https:")).toEqual([
      "object-src allows https:",
    ]);
    expect(
      cspWeaknesses("default-src 'self'; script-src-attr 'unsafe-inline' 'nonce-abc'"),
    ).toEqual(["script-src-attr allows 'unsafe-inline'"]);
  });

  it("does not count a header behind a condition, after a spread or on an unproven receiver as applied", async () => {
    const info = analyze(`const { session } = require("electron");
const ses = session.defaultSession;
ses.webRequest.onHeadersReceived((d, cb) => {
  if (d.url.startsWith("never:")) d.responseHeaders["Content-Security-Policy"] = ["default-src 'self'"];
  cb({ responseHeaders: { "Content-Security-Policy": ["default-src 'self'"], ...d.responseHeaders } });
});
const x = make();
x.webRequest.onHeadersReceived((d, cb) => cb({ responseHeaders: { ...d.responseHeaders, "Content-Security-Policy": ["default-src 'self'"] } }));
ses.webRequest.onHeadersReceived((d, cb) => cb({ responseHeaders: { ...d.responseHeaders, "Content-Security-Policy": "default-src 'self', script-src *" } }));
`);
    expect(
      info.csp.map((r) => `${r.via} ${r.doubt ?? "-"} [${(r.weaknesses ?? []).join("; ")}]`),
    ).toEqual([
      "onHeadersReceived the header is set behind a condition []",
      "onHeadersReceived a spread after it in the same object may replace it []",
      "onHeadersReceived the webRequest receiver is not read as a session []",
      "onHeadersReceived - [script-src allows *; no object-src or default-src: plugins are not restricted]",
    ]);
  });

  it("reads http-equiv exactly and stops at <plaintext>", () => {
    expect(
      cspMetaRows(
        `<meta http-equiv=" Content-Security-Policy" content="a"><plaintext><meta http-equiv="Content-Security-Policy" content="b">`,
        "x.html",
      ).rows,
    ).toEqual([]);
  });

  it("reads many listeners and header keys in linear time", () => {
    const n = 20_000;
    const source = `${"w.webRequest.onHeadersReceived(()=>{});".repeat(n)}${'({"content-security-policy":1});'.repeat(n)}`;
    const t = performance.now();
    analyze(source);
    expect(performance.now() - t).toBeLessThan(15_000);
  });
});

describe("fail-open fixes (review round 3)", () => {
  it("reads grants after a comma, inside a return and in comma returns as unconditional", () => {
    const info = analyze(`const { session } = require("electron");
const s = session.defaultSession;
s.setPermissionRequestHandler((o, p, r) => { p === "media" && console.log("media asked"), r(!0) });
s.setPermissionRequestHandler((o, p, r) => { x = p ? 1 : 2, r(!0) });
s.setPermissionRequestHandler((o, p, r) => { u = o?.url, r(!0) });
s.setPermissionRequestHandler((o, p, r) => { let a = p || 1, b = r(!0) });
s.setPermissionRequestHandler((o, p, r) => { log(p || "x", r(!0)) });
s.setPermissionRequestHandler((wc, p, callback) => { return callback(true); });
s.setPermissionRequestHandler(function (w, p, cb) { return log(p), cb(!0); });
s.setPermissionCheckHandler((o, p) => (console.log("check", p), !0));
s.setPermissionCheckHandler((o, p) => { return log(p), !0 });
s.setPermissionCheckHandler((o, p) => {
  return
  true
});
s.setPermissionRequestHandler((w, p, cb) => {
  if (p) i++
  cb(true)
});
s.setPermissionRequestHandler((w, p, cb) => { if (p) return; cb(true); });
`);
    expect(perms(info)).toEqual([
      "request session default always",
      "request session default always",
      "request session default always",
      "request session default always",
      "request session default always",
      "request session default always",
      "request session default always",
      "check session default always",
      "check session default always",
      "check session default never",
      "request session default always",
      "request session default conditional",
    ]);
  });

  it("gives the minified build of a granting handler the plain build's answer", () => {
    const source = `const { session } = require("electron");
session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
  if (permission === "media") console.log("media asked");
  callback(true);
});
session.defaultSession.setPermissionCheckHandler((wc, permission) => {
  console.log("check", permission);
  return true;
});
`;
    const plain = perms(analyze(source));
    expect(plain).toEqual(["request session default always", "check session default always"]);
    expect(perms(analyze(bundled(source, true)))).toEqual(plain);
  });

  it("doubts a header behind a URL filter and ends the head at </body>", () => {
    const info = analyze(`const { session } = require("electron");
session.defaultSession.webRequest.onHeadersReceived({ urls: ["https://api.example.com/*"] }, (d, c) =>
  c({ responseHeaders: { ...d.responseHeaders, "Content-Security-Policy": ["default-src 'none'"] } }));
`);
    expect(info.csp.map((r) => r.doubt)).toEqual([
      "the listener has a URL filter, so which responses get the header is not read",
    ]);
    expect(
      cspMetaRows(
        `<head></body><meta http-equiv="Content-Security-Policy" content="a">`,
        "x.html",
      ).rows.map((r) => r.outsideHead),
    ).toEqual([true]);
  });

  it("check: one page losing its policy is not excused by another page's", async () => {
    const meta = `<meta http-equiv="Content-Security-Policy" content="default-src 'self'">`;
    const MAIN2 = `const { session } = require("electron");
session.defaultSession.setPermissionRequestHandler((a, b, cb) => cb(false));
`;
    const a = writeApp("pages-a", { "main.js": MAIN2, "index.html": meta, "about.html": meta });
    const gone = writeApp("pages-b", {
      "main.js": MAIN2,
      "index.html": "<p></p>",
      "about.html": meta,
    });
    expect(ours(await check(a, gone))).toEqual([
      "csp-weakened warn Content-Security-Policy removed from index.html",
    ]);
    const moved = writeApp("pages-c", {
      "main.js": MAIN2,
      "index.html": `<body>${meta}</body>`,
      "about.html": meta,
    });
    expect(ours(await check(a, moved))).toContain(
      "csp-weakened warn Content-Security-Policy removed from index.html",
    );
  });

  it("audit: a weak header outside a listener is unknown, and the message says why", async () => {
    const path = write("request-header.asar", {
      "package.json": JSON.stringify({ name: "rh", main: "main.js" }),
      "main.js": `const { session } = require("electron");
session.defaultSession.setPermissionRequestHandler((a, b, cb) => cb(false));
fetch(url, { headers: { "Content-Security-Policy": "script-src *" } });
`,
      "index.html": `<body><p></p><meta http-equiv="Content-Security-Policy" content="script-src *"></body>`,
    });
    const session = new Session();
    const result = await auditBuild(session, (await session.open(path)).id);
    const weak = result.findings.filter((f) => f.rule === "csp-weak");
    expect(weak.map((f) => f.unknown)).toEqual([true, true]);
    expect(weak.map((f) => f.message).join("\n")).toContain("after the document's head");
    expect(weak.map((f) => f.message).join("\n")).toContain(
      "not set in a webRequest.onHeadersReceived listener",
    );
    expect(result.status).toBe("incomplete");
  });
});

describe("fail-open fixes (review round 4)", () => {
  it("never reads a parameter or local as the top-level constant of the same name (tsc output)", async () => {
    const main = `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
const DOCS_URL = "https://docs.example.com";
const CSP = "default-src 'self'";
const base = "https://a/";
function openLink(DOCS_URL) { electron_1.shell.openExternal(DOCS_URL); }
const viaArrow = (url) => electron_1.shell.openExternal(base + url);
function concat(base) { electron_1.shell.openExternal(base + "x"); }
function local() { const DOCS_URL = make(); electron_1.shell.openExternal(DOCS_URL); }
function top() { electron_1.shell.openExternal(DOCS_URL); }
function installCsp(CSP) {
  electron_1.session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({ responseHeaders: { ...details.responseHeaders, "Content-Security-Policy": [CSP] } });
  });
}
electron_1.session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => callback(false));
exports.openLink = openLink; exports.installCsp = installCsp;
`;
    const info = analyze(main);
    expect(opens(info)).toEqual([
      "shell unknown - -",
      // a constant name before `+` is not read as a prefix: unknown, never a value
      "shell unknown - -",
      "shell unknown - -",
      "shell unknown - -",
      "shell literal https://docs.example.com https",
    ]);
    expect(csps(info)).toEqual(["header/onHeadersReceived ? [?]"]);
    const path = write("shadow.asar", {
      "package.json": JSON.stringify({ name: "sh", main: "main.js" }),
      "main.js": main,
    });
    const session = new Session();
    const result = await auditBuild(session, (await session.open(path)).id);
    expect(result.status).toBe("fail");
    expect(result.findings.map((f) => `${f.rule}${f.unknown ? "?" : ""}`)).toContain(
      "open-external",
    );
    expect(result.findings.map((f) => `${f.rule}${f.unknown ? "?" : ""}`)).toContain("csp-weak?");
  });

  it("doubts a CSP header on a partition session; reads ternaries of two URLs", () => {
    const info = analyze(`const { session, shell } = require("electron");
session.fromPartition("persist:x").webRequest.onHeadersReceived((d, cb) =>
  cb({ responseHeaders: { ...d.responseHeaders, "Content-Security-Policy": ["default-src 'self'"] } }));
shell.openExternal(a ? "https://a.example" : "https://b.example");
shell.openExternal(a ? "https://a.example" : u);
`);
    expect(info.csp.map((r) => r.doubt)).toEqual([
      "the listener is on session partition:persist:x, not the default session windows use unless they name a partition",
    ]);
    expect(opens(info)).toEqual([
      "shell inferred https://a.example|https://b.example https",
      "shell unknown - -",
    ]);
  });

  it("reads a ternary of more than eight URLs as unknown, never as a cut list", () => {
    // a balanced nested ternary without parentheses, as minifiers write it
    let n = 0;
    const tree = (leaves: string[]): string =>
      leaves.length === 1
        ? JSON.stringify(leaves[0])
        : `c${n++} ? ${tree(leaves.slice(0, leaves.length / 2))} : ${tree(leaves.slice(leaves.length / 2))}`;
    const eight = Array.from({ length: 8 }, (_, i) => `https://h${i}.example`);
    const nine = `c ? ${tree(eight)} : "file:///etc/passwd"`;
    const info = analyze(`const { shell } = require("electron");
shell.openExternal(${tree(eight)});
shell.openExternal(${nine});
`);
    expect(
      info.openExternal.map((r) => `${r.argumentKind} ${r.values?.length ?? 0} ${r.scheme}`),
    ).toEqual(["inferred 8 https", "unknown 0 null"]);
  });

  it("reads optional calls of a handler setter and a callback chosen in a ternary", () => {
    const info = analyze(`const { session } = require("electron");
session.defaultSession.setPermissionRequestHandler?.((w, p, cb) => cb(true));
session.defaultSession.setPermissionRequestHandler((w, p, callback) => { (c ? callback : f)(true); });
`);
    expect(perms(info)).toEqual([
      "request session default always",
      "request session default unknown",
    ]);
  });
});
