import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildSync } from "esbuild";
import { afterAll, describe, expect, it } from "vitest";
import { analyzeJavaScriptTree, asarTree, type JsAppInfo } from "../src/javascript/app.js";
import { httpLoad } from "../src/javascript/loads.js";
import { auditBuild, checkRelease, parsePolicy, POLICY_RULES, Session } from "../src/index.js";
import { buildAsar } from "./fixtures/asar.js";

/**
 * Pages and resources the app loads (`loads`): loadURL calls with their receiver and how much of
 * the URL is read, and absolute script, stylesheet and iframe sources of the app's HTML files.
 * Expected rows are written from the fixture sources; nothing is fetched or run.
 */

const dir = mkdtempSync(join(tmpdir(), "hexvero-loads-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const files = (main: string, extra: Record<string, string> = {}) => ({
  "package.json": JSON.stringify({
    name: "l",
    main: "main.js",
    devDependencies: { electron: "30.0.0" },
  }),
  "main.js": main,
  ...extra,
});

const analyze = (main: string, extra: Record<string, string> = {}): JsAppInfo =>
  analyzeJavaScriptTree(asarTree(buildAsar(files(main, extra)), "app.asar"));

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

/** A loads row in a few words. */
const loads = (info: JsAppInfo): string[] =>
  info.loads.map(
    (r) =>
      `${r.kind} ${r.targetKind} ${r.argumentKind} ${r.argument ?? (r.values ? r.values.join("|") : "-")}`,
  );

export const LOADS = `import { BrowserWindow, BrowserView } from "electron";
const HOME = "http://example.com/app";
const DEV = "http://localhost:5173/";
export function open(url, port, host, isDev, other) {
  const win = new BrowserWindow({
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  win.loadURL(HOME);
  win.loadURL("https://example.com/");
  win.webContents.loadURL(\`http://localhost:\${port}/\`);
  win.loadURL(\`file://\${__dirname}/index.html\`);
  win.loadURL(url);
  win.loadURL(isDev ? DEV : "http://updates.example.com/");
  win.loadURL("http://" + host);
  win.loadURL(\`http://cdn.example.com/\${port}\`);
  const view = new BrowserView({ webPreferences: { sandbox: true } });
  view.webContents.loadURL("http://view.example.com/");
  other.webContents.loadURL("http://contents.example.com/");
  other.loadURL("http://other.example.com/");
  // win.loadURL("http://comment.example.com/") in a comment is no call
  return [win, view];
}
`;

const HTML = `<!doctype html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
<link rel="stylesheet" href="http://cdn.example.com/a.css">
<link rel="icon" href="http://cdn.example.com/favicon.ico">
<script src="http://cdn.example.com/lib.js"></script>
<script src="https://cdn.example.com/ok.js"></script>
<script src="./local.js"></script>
<script src="//cdn.example.com/relative.js"></script>
<script src="http://localhost:8097"></script>
<!-- <script src="http://comment.example.com/x.js"></script> -->
</head>
<body>
<iframe src="http://frame.example.com/"></iframe>
<img src="http://img.example.com/x.png">
<a href="http://link.example.com/">link</a>
<template><script src="http://template.example.com/x.js"></script></template>
<script>document.write('<script src="http://inline.example.com/x.js"><\\/script>')</script>
</body>
</html>
`;

describe("loads", () => {
  it("reads loadURL calls with their receiver and how much of the URL is read", () => {
    for (const [name, source] of variants(LOADS)) {
      const rows = loads(analyze(source));
      expect(rows, name).toEqual([
        "loadURL window literal http://example.com/app",
        "loadURL window literal https://example.com/",
        "loadURL window inferred http://localhost:",
        "loadURL window inferred file://",
        "loadURL window unknown -",
        "loadURL window inferred http://localhost:5173/|http://updates.example.com/",
        "loadURL window inferred http://",
        "loadURL window inferred http://cdn.example.com/",
        "loadURL window literal http://view.example.com/",
        "loadURL webContents literal http://contents.example.com/",
        "loadURL unknown literal http://other.example.com/",
      ]);
    }
  });

  it("names the window (a BrowserView is one) a loadURL call is on", () => {
    const info = analyze(LOADS);
    expect(info.loads.filter((r) => r.targetKind === "window").map((r) => r.window)).toEqual([
      ...Array(8).fill("win"),
      "view",
    ]);
    expect(info.windows.map((w) => w.windowName)).toEqual(["win", "view"]);
  });

  it("does not take a parameter or a local of a window's name for the window", () => {
    const info = analyze(`const { BrowserWindow } = require("electron");
const win = new BrowserWindow();
win.loadURL("http://a.example.com/");
function f(win) { win.loadURL("http://b.example.com/"); }
function g() { const win = makeWindow(); win.loadURL("http://c.example.com/"); }
`);
    expect(loads(info)).toEqual([
      "loadURL window literal http://a.example.com/",
      "loadURL unknown literal http://b.example.com/",
      "loadURL unknown literal http://c.example.com/",
    ]);
  });

  it("gives a function of an object literal of the file no row", () => {
    const info = analyze(`const router = { loadURL(url) { return url; } };
router.loadURL("http://example.com/");
`);
    expect(loads(info)).toEqual([]);
  });

  it("reads absolute script, stylesheet and iframe sources of the app's HTML files", () => {
    const info = analyze("", { "index.html": HTML, "node_modules/x/page.html": HTML });
    expect(loads(info)).toEqual([
      "stylesheet html literal http://cdn.example.com/a.css",
      "script html literal http://cdn.example.com/lib.js",
      "script html literal https://cdn.example.com/ok.js",
      "script html literal http://localhost:8097",
      "iframe html literal http://frame.example.com/",
    ]);
    expect(info.loads.map((r) => `${r.file}:${r.line}`)).toEqual([
      "index.html:4",
      "index.html:6",
      "index.html:7",
      "index.html:10",
      "index.html:14",
    ]);
  });

  it("resolves relative sources against an absolute <base href>", () => {
    const info = analyze("", {
      "a.html": `<base href="http://base.example.com/app/"><script src="main.js"></script><script src="//cdn.example.com/x.js"></script>`,
      "b.html": `<base href="./"><script src="main.js"></script>`,
    });
    expect(loads(info)).toEqual([
      "script html literal http://base.example.com/app/main.js",
      "script html literal http://cdn.example.com/x.js",
    ]);
  });
});

describe("httpLoad", () => {
  it("tells remote hosts from this machine, and a host that is not read", () => {
    expect(httpLoad("http://example.com/", true)).toBe("remote");
    expect(httpLoad("HTTP://Example.com", true)).toBe("remote");
    expect(httpLoad("  http://example.com", true)).toBe("remote");
    expect(httpLoad("http://localhost:3000/", true)).toBe("local");
    expect(httpLoad("http://app.localhost/", true)).toBe("local");
    expect(httpLoad("http://127.0.0.1:8080", true)).toBe("local");
    expect(httpLoad("http://127.1/", true)).toBe("local");
    expect(httpLoad("http://[::1]:9000/", true)).toBe("local");
    expect(httpLoad("http://0.0.0.0:9000/", true)).toBe("local");
    expect(httpLoad("http://user@localhost.example.com/", true)).toBe("remote");
    expect(httpLoad("https://example.com/", true)).toBeNull();
    expect(httpLoad("file:///index.html", true)).toBeNull();
    expect(httpLoad("http://", true)).toBeNull();
    // only a start
    expect(httpLoad("http://example.com/", false)).toBe("remote");
    expect(httpLoad("http://example.com:", false)).toBe("remote");
    expect(httpLoad("http://localhost:", false)).toBe("local");
    expect(httpLoad("http://", false)).toBe("maybe");
    expect(httpLoad("http://local", false)).toBe("maybe");
    expect(httpLoad("https://", false)).toBeNull();
  });
});

let n = 0;
const writeApp = (main: string, extra: Record<string, string> = {}): string => {
  const path = join(dir, `app-${n++}.asar`);
  writeFileSync(path, buildAsar(files(main, extra)));
  return path;
};
const auditOf = async (path: string) => {
  const session = new Session();
  return auditBuild(session, (await session.open(path)).id);
};
const found = (r: Awaited<ReturnType<typeof auditOf>>) =>
  r.findings
    .filter((f) => f.rule === "http-resource")
    .map((f) => `${f.unknown ? "?" : "!"} ${f.key}`);

describe("audit http-resource", () => {
  it("reports http loads from another host, unknown where the host or receiver is not read", async () => {
    for (const [name, source] of variants(LOADS)) {
      const r = await auditOf(writeApp(source));
      const keys = found(r).map((k) => k.replace(/ on (?!webContents:|unknown:)[\w$]+:/, " on W:"));
      expect(keys.toSorted(), name).toEqual(
        [
          "! loadURL on W: http://example.com/app",
          "! loadURL on W: one of http://localhost:5173/, http://updates.example.com/",
          "? loadURL on W: http:// …",
          "! loadURL on W: http://cdn.example.com/ …",
          "! loadURL on W: http://view.example.com/",
          "! loadURL on webContents: http://contents.example.com/",
          "? loadURL on unknown: http://other.example.com/",
        ].toSorted(),
      );
    }
  });

  it("says when the window has Node integration in effect, and links the window", async () => {
    const r = await auditOf(writeApp(LOADS));
    const home = r.findings.find((f) => f.key === "loadURL on win: http://example.com/app")!;
    expect(home.message).toContain("Node integration in effect");
    expect(home.message).toContain("section 1");
    expect(home.where).toEqual([
      { file: "main.js", line: 8 },
      { file: "main.js", line: 5 },
    ]);
    // another webContents: the window with Node integration is named, not taken for it
    // a view without Node integration: linked, not said
    const view = r.findings.find((f) => f.key.includes("view.example.com"))!;
    expect(view.message).not.toContain("Node integration in effect");
    expect(view.where).toEqual([
      { file: "main.js", line: 17 },
      { file: "main.js", line: 16 },
    ]);
    // another webContents: the window with Node integration is named, not taken for it
    const other = r.findings.find((f) => f.key.includes("contents.example.com"))!;
    expect(other.message).toContain("window win has Node integration in effect");
    expect(other.message).toContain("not read");
    expect(other.where).toEqual([{ file: "main.js", line: 18 }]);

    const safe = await auditOf(
      writeApp(`const { BrowserWindow } = require("electron");
const win = new BrowserWindow();
win.loadURL("http://example.com/");
`),
    );
    const plain = safe.findings.find((f) => f.rule === "http-resource")!;
    expect(plain.unknown).toBe(false);
    expect(plain.message).not.toContain("Node integration in effect");
    // Node integration is part of what is accepted: turning it on gives a new fingerprint
    expect(plain.fingerprint).not.toBe(
      (
        await auditOf(
          writeApp(`const { BrowserWindow } = require("electron");
const win = new BrowserWindow({ webPreferences: { nodeIntegration: true } });
win.loadURL("http://example.com/");
`),
        )
      ).findings.find((f) => f.rule === "http-resource")!.fingerprint,
    );
  });

  it("reports http scripts, stylesheets and iframes of HTML files, not local, https or other tags", async () => {
    const r = await auditOf(writeApp("", { "index.html": HTML }));
    expect(found(r)).toEqual([
      "! iframe http://frame.example.com/",
      "! script http://cdn.example.com/lib.js",
      "! stylesheet http://cdn.example.com/a.css",
    ]);
  });

  it("gives no finding for an unknown URL, a file, https or a loopback dev server", async () => {
    const r = await auditOf(
      writeApp(`const { BrowserWindow } = require("electron");
const win = new BrowserWindow();
win.loadURL(process.env.URL);
win.loadURL("http://localhost:3000");
win.loadURL("http://127.0.0.1:" + port);
win.loadURL("https://example.com/");
win.loadURL("app://index.html");
`),
    );
    expect(found(r)).toEqual([]);
  });

  it("keeps fingerprints when the code moves", async () => {
    const a = await auditOf(writeApp(LOADS, { "index.html": HTML }));
    const b = await auditOf(writeApp(`// moved\n\n${LOADS}`, { "index.html": `\n\n${HTML}` }));
    const fp = (r: typeof a) =>
      r.findings.filter((f) => f.rule === "http-resource").map((f) => f.fingerprint);
    expect(fp(b)).toEqual(fp(a));
    expect(fp(a).length).toBe(10);
  });
});

describe("check new-http-resource", () => {
  const policy = parsePolicy(
    JSON.stringify({
      hexvero: "policy",
      version: 1,
      rules: Object.fromEntries(
        POLICY_RULES.map((id) => [id, { level: id === "new-http-resource" ? "fail" : "off" }]),
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
const win = new BrowserWindow();
win.loadURL("http://example.com/");
win.loadURL("https://secure.example.com/");
`;

  it("reports a new http load, not one that stayed, moved or is local", async () => {
    expect((await check(writeApp(BEFORE), writeApp(BEFORE))).findings).toEqual([]);
    expect((await check(writeApp(BEFORE), writeApp(`// moved\n${BEFORE}`))).findings).toEqual([]);
    const after = `const { BrowserWindow } = require("electron");
const win = new BrowserWindow();
win.loadURL("http://example.com/");
win.loadURL("http://secure.example.com/");
win.loadURL("http://localhost:3000/");
`;
    const r = await check(
      writeApp(BEFORE),
      writeApp(after, { "index.html": `<script src="http://cdn.example.com/x.js"></script>` }),
    );
    expect(r.findings.map((f) => `${f.unknown ? "?" : "!"} ${f.key}`).toSorted()).toEqual([
      "! loadURL window http://secure.example.com/",
      "! script html http://cdn.example.com/x.js",
    ]);
    expect(r.status).toBe("fail");
  });
});
