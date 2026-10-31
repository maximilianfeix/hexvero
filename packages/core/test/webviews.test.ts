import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildSync } from "esbuild";
import { afterAll, describe, expect, it } from "vitest";
import { analyzeJavaScriptTree, asarTree, type JsAppInfo } from "../src/javascript/app.js";
import {
  parseWebPreferences,
  webviewTagRows,
  webviewWeaknesses,
} from "../src/javascript/webviews.js";
import { auditBuild, checkRelease, parsePolicy, POLICY_RULES, Session } from "../src/index.js";
import { buildAsar } from "./fixtures/asar.js";

/**
 * `<webview>` tags, webviews created in code and will-attach-webview listeners (`webviews`),
 * and the rules that read them. Expected rows are written from the fixture sources and
 * Electron's own code (lib/browser/guest-view-manager.ts: boolean attributes are on when
 * present, `webpreferences` is applied over them); nothing is run.
 */

const dir = mkdtempSync(join(tmpdir(), "hexvero-webviews-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const analyze = (main: string, extra: Record<string, string> = {}): JsAppInfo =>
  analyzeJavaScriptTree(
    asarTree(
      buildAsar({
        "package.json": JSON.stringify({ name: "w", main: "main.js" }),
        "main.js": main,
        ...extra,
      }),
      "app.asar",
    ),
  );

function bundled(source: string, minify: boolean, jsx = false): string {
  const src = mkdtempSync(join(dir, "src-"));
  const entry = join(src, jsx ? "main.jsx" : "main.js");
  mkdirSync(dirname(entry), { recursive: true });
  writeFileSync(entry, source);
  const outfile = join(src, "out.js");
  buildSync({
    entryPoints: [entry],
    bundle: true,
    minify,
    platform: "node",
    format: "cjs",
    external: ["electron", "react", "react/jsx-runtime"],
    ...(jsx ? { jsx: "automatic" as const } : {}),
    outfile,
    logLevel: "silent",
  });
  return readFileSync(outfile, "utf8");
}

const variants = (source: string, jsx = false): Array<[string, string]> => [
  ["plain", source],
  ["bundled", bundled(source, false, jsx)],
  ["minified", bundled(source, true, jsx)],
];

/** A webview row in a few words: kind, src, what is weak and what is not read. */
const views = (info: JsAppInfo): string[] =>
  info.webviews.map((r) =>
    r.kind === "attach-listener"
      ? `listener prevent=${r.preventsDefault} preload=${r.deletesPreload} node=${r.disablesNodeIntegration}`
      : `${r.kind} ${r.src ?? "-"} [${r.insecure.join("; ")}] host[${r.hostDependent.join("; ")}]${r.unread ? ` unread[${r.unread.join(",")}]` : ""}`,
  );

describe("webview attributes", () => {
  it("parses webpreferences as Electron does: key=value pairs, a bare key is true", () => {
    expect([
      ...parseWebPreferences("allowRunningInsecureContent, contextIsolation=no ,x=1"),
    ]).toEqual([
      ["allowRunningInsecureContent", { value: true, raw: "allowRunningInsecureContent" }],
      ["contextIsolation", { value: false, raw: "contextIsolation=no" }],
      ["x", { value: true, raw: "x=1" }],
    ]);
  });

  it("reads boolean attributes by presence and lets webpreferences override them", () => {
    // nodeintegration="false" is still on: Electron reads hasAttribute
    expect(webviewWeaknesses({ nodeintegration: "false", allowpopups: "" })).toEqual({
      insecure: ["allowpopups"],
      hostDependent: ["nodeintegration"],
    });
    expect(
      webviewWeaknesses({ nodeintegration: "", webpreferences: "nodeIntegration=no" }),
    ).toEqual({ insecure: [], hostDependent: [] });
    expect(
      webviewWeaknesses({
        disablewebsecurity: "",
        webpreferences: "experimentalFeatures=yes, sandbox=0, enableBlinkFeatures=CSSVariables",
        blinkfeatures: "",
      }),
    ).toEqual({
      insecure: [
        "disablewebsecurity",
        "webpreferences experimentalFeatures=yes",
        "webpreferences enableBlinkFeatures=CSSVariables",
      ],
      hostDependent: ["webpreferences sandbox=0"],
    });
    // keys are case-sensitive, as in Electron: `websecurity=no` sets nothing it reads
    expect(webviewWeaknesses({ webpreferences: "websecurity=no" })).toEqual({
      insecure: [],
      hostDependent: [],
    });
  });
});

const PAGE = `<!doctype html>
<html><head><title>x</title></head>
<body>
<!-- <webview nodeintegration src="https://comment.example"></webview> -->
<webview id="a" src="https://example.com" nodeintegration
  allowpopups webpreferences="allowRunningInsecureContent, contextIsolation=no"></webview>
<webview src="./safe.html" partition="persist:x"></webview>
<script>const s = "<webview disablewebsecurity>";</script>
<template><webview src="t.html" disablewebsecurity></webview></template>
<WEBVIEW SRC="upper.html" PRELOAD="file:///p.js"></WEBVIEW>
</body></html>`;

describe("webviews in HTML files", () => {
  it("reads tags and their attributes, not comments or scripts", () => {
    const { rows } = webviewTagRows(PAGE, "index.html");
    expect(
      rows.map(
        (r) => `${r.line} ${r.src} [${r.insecure.join("; ")}] host[${r.hostDependent.join("; ")}]`,
      ),
    ).toEqual([
      "5 https://example.com [allowpopups; webpreferences allowRunningInsecureContent] host[nodeintegration; webpreferences contextIsolation=no]",
      "7 ./safe.html [] host[]",
      "9 t.html [disablewebsecurity] host[]",
      "10 upper.html [] host[]",
    ]);
    expect(rows[3]!.attributes).toEqual({ src: "upper.html", preload: "file:///p.js" });
  });

  it("lists the app's HTML files' tags in the collection, outside node_modules", () => {
    const info = analyze(`require("electron");`, {
      "index.html": PAGE,
      "node_modules/x/index.html": `<webview nodeintegration></webview>`,
    });
    expect(views(info)).toEqual([
      "html https://example.com [allowpopups; webpreferences allowRunningInsecureContent] host[nodeintegration; webpreferences contextIsolation=no]",
      "html ./safe.html [] host[]",
      "html t.html [disablewebsecurity] host[]",
      "html upper.html [] host[]",
    ]);
  });
});

const ELEMENT = `export function make(url, attr) {
  const wv = document.createElement("webview");
  wv.setAttribute("src", url);
  wv.setAttribute("nodeintegration", "");
  wv.setAttribute("webpreferences", "webSecurity=no");
  wv.allowpopups = true;
  document.body.appendChild(wv);
  const other = document.createElement("webview");
  other.setAttribute(attr, "");
  document.body.appendChild(other);
  const plain = document.createElement("div");
  plain.setAttribute("nodeintegration", "");
  return [wv, other, plain];
}
`;

describe("webviews created in code", () => {
  it("reads createElement with its setAttribute calls and properties, plain, bundled and minified", () => {
    for (const [name, source] of variants(ELEMENT))
      expect(views(analyze(source)), name).toEqual([
        "element - [allowpopups; webpreferences webSecurity=no] host[nodeintegration]",
        "element - [] host[] unread[*]",
      ]);
  });

  it("reads a framework's props object, and does not guess props it cannot read", () => {
    const source = `export const View = ({ url, prefs }) => [
  <webview src="https://example.com" allowpopups="true" />,
  <webview src={url} webpreferences={prefs} nodeintegration={true} />,
  <webview src="b.html" disablewebsecurity={false} />,
];
`;
    for (const [name, code] of variants(source, true).slice(1))
      expect(views(analyze(code)), name).toEqual([
        "element https://example.com [allowpopups] host[]",
        "element - [] host[] unread[nodeintegration,webpreferences]",
        "element b.html [] host[]",
      ]);
  });

  it("reads markup in strings and templates, and says what a cut tag hides", () => {
    const info = analyze(`export function show(el, url) {
  el.innerHTML = '<webview src="https://a.example" disablewebsecurity></webview>';
  el.innerHTML = \`<webview src="\${url}" nodeintegration></webview>\`;
  el.innerHTML = '<webview src="' + url + '" allowpopups>';
  // <webview nodeintegration> in a comment is none
}
`);
    expect(views(info)).toEqual([
      "markup https://a.example [disablewebsecurity] host[]",
      "markup - [] host[] unread[*]",
      "markup - [] host[] unread[*]",
    ]);
    expect(info.webviews.map((r) => r.line)).toEqual([2, 3, 4]);
  });
});

const LISTENER = `import { app } from "electron";
app.on("web-contents-created", (_e, contents) => {
  contents.on("will-attach-webview", (event, webPreferences, params) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    if (!params.src.startsWith("https://example.com/")) event.preventDefault();
  });
});
export function other(win, handler) {
  win.webContents.on("will-attach-webview", handler);
  win.webContents.on("will-attach-webview", (e) => setTimeout(() => e.preventDefault()));
}
`;

describe("will-attach-webview listeners", () => {
  it("reads what a listener does with the event and webPreferences, plain, bundled and minified", () => {
    for (const [name, source] of variants(LISTENER))
      expect(views(analyze(source)), name).toEqual([
        "listener prevent=conditional preload=always node=always",
        "listener prevent=unknown preload=unknown node=unknown",
        "listener prevent=unknown preload=no node=no",
      ]);
  });
});

const PKG = JSON.stringify({
  name: "w",
  main: "main.js",
  devDependencies: { electron: "^33.0.0" },
});
const HOST = (
  webviewTag: string,
  extra = "",
) => `const { app, BrowserWindow, session } = require("electron");
session.defaultSession.setPermissionRequestHandler((wc, p, cb) => cb(false));
app.whenReady().then(() => {
  const win = new BrowserWindow({ webPreferences: { contextIsolation: true, sandbox: true${webviewTag} } });
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
${extra}  win.loadFile("index.html");
});
`;
const TAGS = `<!doctype html><html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'self'">
</head><body>
<webview src="https://example.com" allowpopups nodeintegration></webview>
<webview src="./help.html"></webview>
</body></html>`;

let n = 0;
const writeApp = (main: string, extra: Record<string, string> = {}): string => {
  const path = join(dir, `app-${n++}.asar`);
  writeFileSync(
    path,
    buildAsar({ "package.json": PKG, "main.js": main, "index.html": TAGS, ...extra }),
  );
  return path;
};
const audit = async (path: string) => {
  const session = new Session();
  return auditBuild(session, (await session.open(path)).id);
};
const rule = (r: Awaited<ReturnType<typeof audit>>) =>
  r.findings
    .filter((f) => f.rule === "webview-insecure")
    .map((f) => `${f.unknown ? "?" : "!"} ${f.key}`);

describe("audit webview-insecure", () => {
  it("reports an insecure tag and no will-attach-webview listener when a window enables webviewTag", async () => {
    for (const [name, source] of variants(HOST(", webviewTag: true"))) {
      const r = await audit(writeApp(source));
      // nodeintegration is taken from the window, which has Node integration off (Electron 33):
      // only allowpopups counts
      expect(rule(r), name).toEqual([
        "! html https://example.com: allowpopups",
        "! webviewTag on, no will-attach-webview listener",
      ]);
      expect(r.status, name).toBe("fail");
    }
  });

  it("keeps a weakness the hosting window gives effect to, as unknown when it is the only one", async () => {
    const r = await audit(
      writeApp(HOST(", webviewTag: true, nodeIntegration: true"), {
        "index.html": `<webview src="a.html" nodeintegration></webview>`,
      }),
    );
    expect(rule(r)).toEqual([
      "? html a.html: nodeintegration",
      "! webviewTag on, no will-attach-webview listener",
    ]);
  });

  it("is unknown without webviewTag, and with a will-attach-webview listener the absence goes", async () => {
    const off = await audit(writeApp(HOST("")));
    expect(rule(off)).toEqual(["? html https://example.com: allowpopups"]);
    expect(off.findings.find((f) => f.rule === "webview-insecure")!.message).toContain(
      "no window read enables webviewTag",
    );
    const guarded = await audit(
      writeApp(
        HOST(
          ", webviewTag: true",
          `  win.webContents.on("will-attach-webview", (e, prefs) => { delete prefs.preload; });\n`,
        ),
      ),
    );
    expect(rule(guarded)).toEqual(["? html https://example.com: allowpopups"]);
  });

  it("keeps fingerprints when the code and the page move", async () => {
    const a = await audit(writeApp(HOST(", webviewTag: true")));
    const b = await audit(
      writeApp(`// moved\n\n${HOST(", webviewTag: true")}`, { "index.html": `\n\n\n${TAGS}` }),
    );
    expect(b.findings.map((f) => f.fingerprint)).toEqual(a.findings.map((f) => f.fingerprint));
  });

  it("does not report the missing listener on a partial scan", async () => {
    const all: Record<string, string> = {
      "package.json": PKG,
      "main.js": HOST(", webviewTag: true"),
      "index.html": TAGS,
    };
    for (let i = 0; i < 5; i++) all[`f${i}.js`] = `module.exports = ${i};\n`;
    const path = join(dir, "partial.asar");
    writeFileSync(path, buildAsar(all));
    const session = new Session();
    const { id } = await session.open(path);
    await session.continueAnalysis(id, { maxJsFiles: 2 });
    const r = await auditBuild(session, id);
    // the tag is read; the listener may be in a file not read, so its absence is no finding
    expect(rule(r)).toEqual(["! html https://example.com: allowpopups"]);
    expect(r.incomplete.find((i) => i.rule === "webview-insecure")).toEqual({
      rule: "webview-insecure",
      collection: "webviews",
      gaps: ["scan_partial"],
    });
  });
});

describe("check new-insecure-webview", () => {
  const policy = parsePolicy(
    JSON.stringify({
      hexvero: "policy",
      version: 1,
      rules: Object.fromEntries(POLICY_RULES.map((id) => [id, { level: "off" }])),
    }).replace(`"new-insecure-webview":{"level":"off"}`, `"new-insecure-webview":{"level":"fail"}`),
    "policy.json",
  );
  const check = async (a: string, b: string) => {
    const session = new Session();
    const [x, y] = [await session.open(a), await session.open(b)];
    return checkRelease(session, x.id, y.id, policy);
  };
  const LISTENER_LINE = `  win.webContents.on("will-attach-webview", (e, prefs) => { delete prefs.preload; });\n`;

  it("reports a newly insecure attribute and a removed listener, not what stayed", async () => {
    const before = writeApp(HOST(", webviewTag: true", LISTENER_LINE), {
      "index.html": `<webview src="https://example.com" allowpopups></webview>`,
    });
    const same = await check(before, before);
    expect(same.findings).toEqual([]);
    const after = writeApp(HOST(", webviewTag: true"), {
      "index.html": `<webview src="https://example.com" allowpopups disablewebsecurity></webview>`,
    });
    const r = await check(before, after);
    expect(r.findings.map((f) => `${f.unknown ? "?" : "!"} ${f.key}`).toSorted()).toEqual([
      '! html webview (src "https://example.com"): disablewebsecurity',
      "! will-attach-webview listener removed",
    ]);
    expect(r.status).toBe("fail");
  });
});
