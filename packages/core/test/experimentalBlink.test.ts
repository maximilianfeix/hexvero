import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildSync } from "esbuild";
import { afterAll, describe, expect, it } from "vitest";
import { analyzeJavaScriptTree, asarTree, type JsAppInfo } from "../src/javascript/app.js";
import { auditBuild, auditToSarif, checkRelease, parsePolicy, Session } from "../src/index.js";
import { buildAsar } from "./fixtures/asar.js";

/**
 * `experimentalFeatures` and `enableBlinkFeatures` in a window's webPreferences (Electron's
 * security guide, sections 9 and 10). Expected rows and findings are written from the fixture
 * sources and the WebPreferences structure (experimentalFeatures: boolean, default false;
 * enableBlinkFeatures: a string of feature names separated by `,`, none by default); nothing is
 * run.
 */

const dir = mkdtempSync(join(tmpdir(), "hexvero-blink-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const PKG = JSON.stringify({
  name: "a",
  main: "main.js",
  devDependencies: { electron: "^33.0.0" },
});

const files = (main: string): Record<string, string> => ({
  "package.json": PKG,
  "main.js": main,
  "index.html": `<meta http-equiv="Content-Security-Policy" content="default-src 'self'">`,
});

let n = 0;
const write = (main: string): string => {
  const path = join(dir, `app-${n++}.asar`);
  writeFileSync(path, buildAsar(files(main)));
  return path;
};

const analyze = (main: string): JsAppInfo =>
  analyzeJavaScriptTree(asarTree(buildAsar(files(main)), "app.asar"));

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

const LIMITS = `app.on("web-contents-created", (e, contents) => {
  contents.on("will-navigate", (ev) => ev.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
});
session.defaultSession.setPermissionRequestHandler((wc, p, cb) => cb(false));
`;

const APP = `const { app, BrowserWindow, session } = require("electron");
${LIMITS}app.whenReady().then(() => {
  const lab = new BrowserWindow({ webPreferences: { experimentalFeatures: true, contextIsolation: true, sandbox: true } });
  const blink = new BrowserWindow({ webPreferences: { enableBlinkFeatures: "KeyboardEventKey,CSSVariables", contextIsolation: true, sandbox: true } });
  const dev = new BrowserWindow({ webPreferences: { experimentalFeatures: !app.isPackaged, enableBlinkFeatures: process.env.BLINK, contextIsolation: true, sandbox: true } });
  const off = new BrowserWindow({ webPreferences: { experimentalFeatures: false, enableBlinkFeatures: "", contextIsolation: true, sandbox: true } });
  const quiet = new BrowserWindow({ webPreferences: { contextIsolation: true, sandbox: true } });
  for (const w of [lab, blink, dev, off, quiet]) w.loadFile("index.html");
});
`;

const columns = (info: JsAppInfo): string[] =>
  info.windows.map(
    (w) =>
      `${w.windowName}: ${String(w.experimentalFeatures)} ${w.experimentalFeaturesInEffect} / ${JSON.stringify(w.enableBlinkFeatures)} ${w.blinkFeaturesInEffect}`,
  );

describe("windows: experimentalFeatures and enableBlinkFeatures", () => {
  const EXPECTED = [
    'lab: true on / "not written" default off',
    'blink: not written default off / ["CSSVariables","KeyboardEventKey"] on',
    'dev: computed unknown / "computed" unknown',
    // an empty list enables no feature
    "off: false off / [] off",
    // not written: off by default in every Electron version
    'quiet: not written default off / "not written" default off',
  ];

  it("reads both settings as written, else Electron's default, in all three builds", () => {
    for (const [name, source] of variants(APP)) {
      const info = analyze(source);
      expect(
        info.windows.map((w) => [
          w.experimentalFeatures,
          w.experimentalFeaturesInEffect,
          w.enableBlinkFeatures,
          w.blinkFeaturesInEffect,
        ]),
        name,
      ).toEqual([
        [true, "on", "not written", "default off"],
        ["not written", "default off", ["CSSVariables", "KeyboardEventKey"], "on"],
        ["computed", "unknown", "computed", "unknown"],
        [false, "off", [], "off"],
        ["not written", "default off", "not written", "default off"],
      ]);
    }
    expect(columns(analyze(APP))).toEqual(EXPECTED);
  });

  it("lists the rows with the literal string, or the expression when computed", () => {
    const rows = analyze(APP)
      .webPreferences.filter(
        (p) => p.key === "experimentalFeatures" || p.key === "enableBlinkFeatures",
      )
      .map((p) => [p.windowName, p.key, p.value, p.computed ?? null, p.line]);
    expect(rows).toEqual([
      ["lab", "experimentalFeatures", true, null, 8],
      ["blink", "enableBlinkFeatures", "KeyboardEventKey,CSSVariables", null, 9],
      ["dev", "experimentalFeatures", null, "!app.isPackaged", 10],
      ["dev", "enableBlinkFeatures", null, "process.env.BLINK", 10],
      ["off", "experimentalFeatures", false, null, 11],
      ["off", "enableBlinkFeatures", "", null, 11],
    ]);
  });

  it("reads a template literal without substitutions as the string, one with them as computed", () => {
    const info = analyze(`const { BrowserWindow } = require("electron");
const a = new BrowserWindow({ webPreferences: { enableBlinkFeatures: \`CSSVariables\` } });
const b = new BrowserWindow({ webPreferences: { enableBlinkFeatures: \`\${process.env.X},CSSVariables\` } });
const c = new BrowserWindow({ webPreferences: { enableBlinkFeatures: "CSSVariables" + extra } });
`);
    expect(info.windows.map((w) => w.enableBlinkFeatures)).toEqual([
      ["CSSVariables"],
      "computed",
      "computed",
    ]);
  });

  it("reads them from options evaluated across a helper", () => {
    const info = analyze(`const { BrowserWindow } = require("electron");
const base = { webPreferences: { experimentalFeatures: true, enableBlinkFeatures: "CSSVariables" } };
function make(extra) {
  const made = new BrowserWindow(Object.assign({}, base, extra));
  return made;
}
make({ width: 800 });
`);
    const w = info.windows.find((x) => x.windowName === "made")!;
    expect([w.experimentalFeaturesInEffect, w.enableBlinkFeatures]).toEqual([
      "on",
      ["CSSVariables"],
    ]);
  });
});

const audit = async (path: string) => {
  const session = new Session();
  const { id } = await session.open(path);
  return auditBuild(session, id, {});
};
type Audit = Awaited<ReturnType<typeof audit>>;
const ruleList = (r: Audit): string[] =>
  r.findings
    .filter((f) => f.rule === "window-permissive")
    .map((f) => `${f.key}${f.unknown ? " ?" : ""}`);

describe("audit window-permissive: experimentalFeatures and enableBlinkFeatures", () => {
  it("fails on the literal settings and is unknown on computed ones", async () => {
    const r = await audit(write(APP));
    expect(ruleList(r)).toEqual([
      "blink blinkFeaturesInEffect on (CSSVariables, KeyboardEventKey)",
      "dev blinkFeaturesInEffect unknown ?",
      "dev experimentalFeaturesInEffect unknown ?",
      "lab experimentalFeaturesInEffect on",
    ]);
    const byKey = (k: string) => r.findings.find((f) => f.key === k)!;
    expect(byKey("lab experimentalFeaturesInEffect on").message).toBe(
      "Window lab: experimentalFeatures is true as written, so Chromium's experimental features are on for its pages (Electron's security guide, section 9).",
    );
    expect(byKey("blink blinkFeaturesInEffect on (CSSVariables, KeyboardEventKey)").message).toBe(
      "Window blink: enableBlinkFeatures turns on the Blink features CSSVariables, KeyboardEventKey as written, so its pages get features Chromium keeps off by default (Electron's security guide, section 10).",
    );
    expect(byKey("dev experimentalFeaturesInEffect unknown").message).toBe(
      "Window dev: experimentalFeatures cannot be told (a value computed at run time).",
    );
    expect(byKey("dev blinkFeaturesInEffect unknown").message).toBe(
      "Window dev: enableBlinkFeatures cannot be told (a value computed at run time).",
    );
    expect(byKey("lab experimentalFeaturesInEffect on").where).toEqual([
      { file: "main.js", line: 8 },
    ]);
    // identity: file, window name, setting (and the features turned on); no line
    expect(byKey("lab experimentalFeaturesInEffect on").fingerprint).toBe(
      createHash("sha256")
        .update("window-permissive\0main.js\0lab\0experimentalFeaturesInEffect")
        .digest("hex")
        .slice(0, 32),
    );
    expect(
      byKey("blink blinkFeaturesInEffect on (CSSVariables, KeyboardEventKey)").fingerprint,
    ).toBe(
      createHash("sha256")
        .update(
          "window-permissive\0main.js\0blink\0blinkFeaturesInEffect\0CSSVariables,KeyboardEventKey",
        )
        .digest("hex")
        .slice(0, 32),
    );
    expect(r.status).toBe("fail");
  });

  it("finds the same in the bundled and minified builds", async () => {
    for (const [name, source] of variants(APP).slice(1)) {
      const r = await audit(write(source));
      const values = r.findings
        .filter((f) => f.rule === "window-permissive")
        .map((f) => `${f.key.split(" ").slice(1).join(" ")}${f.unknown ? " ?" : ""}`)
        .toSorted();
      expect(values, name).toEqual([
        "blinkFeaturesInEffect on (CSSVariables, KeyboardEventKey)",
        "blinkFeaturesInEffect unknown ?",
        "experimentalFeaturesInEffect on",
        "experimentalFeaturesInEffect unknown ?",
      ]);
    }
  });

  it("folds both into the webSecurity unknown of a window whose options could not be followed", async () => {
    const r = await audit(
      write(`const { app, BrowserWindow, session } = require("electron");
${LIMITS}function open(options) {
  const opaque = new BrowserWindow({ ...options, webPreferences: { ...options.prefs } });
  return opaque;
}
function own(options) {
  const written = new BrowserWindow({ ...options, webPreferences: { ...options.prefs, experimentalFeatures: options.lab } });
  return written;
}
`),
    );
    const keys = ruleList(r).filter((k) => /Features|webSecurity/.test(k));
    expect(keys).toEqual([
      "opaque webSecurityInEffect unknown ?",
      // written as a computed value of its own: its own unknown
      "written experimentalFeaturesInEffect unknown ?",
      "written webSecurityInEffect unknown ?",
    ]);
    expect(r.findings.find((f) => f.key === "opaque webSecurityInEffect unknown")!.message).toBe(
      "Window opaque: webSecurity cannot be told (a value computed at run time); allowRunningInsecureContent is not read as a value of its own and depends on it (webSecurity: false turns it on), so it cannot be told either; experimentalFeatures and enableBlinkFeatures are not read as values of their own (the window's options could not be followed), so they cannot be told either.",
    );
    expect(r.findings.find((f) => f.key === "written webSecurityInEffect unknown")!.message).toBe(
      "Window written: webSecurity cannot be told (a value computed at run time); allowRunningInsecureContent is not read as a value of its own and depends on it (webSecurity: false turns it on), so it cannot be told either; enableBlinkFeatures is not read as a value of its own (the window's options could not be followed), so it cannot be told either.",
    );
  });

  it("keeps fingerprints when the code moves", async () => {
    const before = await audit(write(APP));
    const after = await audit(write(`// moved\n\n\n${APP}`));
    expect(after.findings.map((f) => f.fingerprint)).toEqual(
      before.findings.map((f) => f.fingerprint),
    );
  });

  it("reports nothing for settings left out, written off, or an empty feature list", async () => {
    const r = await audit(
      write(`const { app, BrowserWindow, session } = require("electron");
${LIMITS}new BrowserWindow({ webPreferences: { experimentalFeatures: false, enableBlinkFeatures: "", contextIsolation: true, sandbox: true } });
new BrowserWindow({ webPreferences: { contextIsolation: true, sandbox: true } });
`),
    );
    expect(r.findings).toEqual([]);
    expect(r.status).toBe("pass");
  });

  it("cites sections 9 and 10 in SARIF", async () => {
    const r = await audit(write(APP));
    const sarif = auditToSarif(r, { version: "0.0.0" }) as {
      runs: Array<{
        tool: {
          driver: {
            rules: Array<{ id: string; fullDescription: { text: string }; help: { text: string } }>;
          };
        };
      }>;
    };
    const rule = sarif.runs[0]!.tool.driver.rules.find((x) => x.id === "window-permissive")!;
    expect(rule.help.text).toMatch(/section 9 \(do not enable experimental features\)/);
    expect(rule.help.text).toMatch(/section 10 \(do not use enableBlinkFeatures\)/);
    expect(rule.fullDescription.text).toMatch(/experimentalFeatures: true/);
    expect(rule.fullDescription.text).toMatch(/enableBlinkFeatures/);
  });
});

const check = async (a: string, b: string) => {
  const session = new Session();
  const ta = await session.open(a);
  const tb = await session.open(b);
  const policy = parsePolicy(
    JSON.stringify({ hexvero: "policy", version: 1, rules: {}, unknown: "fail", suppressions: [] }),
    "policy.json",
  );
  return checkRelease(session, ta.id, tb.id, policy);
};
type Check = Awaited<ReturnType<typeof check>>;
const ofRule = (r: Check): string[] =>
  r.findings
    .filter((f) => f.rule === "window-more-permissive")
    .map((f) => `${f.level}${f.unknown ? " unknown" : ""} ${f.key}`);

const win = (prefs: string): string => `const { app, BrowserWindow, session } = require("electron");
${LIMITS}app.whenReady().then(() => {
  const win = new BrowserWindow({ webPreferences: { ${prefs}contextIsolation: true, sandbox: true } });
  win.loadFile("index.html");
});
`;

describe("check window-more-permissive: experimentalFeatures and enableBlinkFeatures", () => {
  it("reports experimentalFeatures turned on, never the reverse", async () => {
    const safe = write(win(""));
    const on = write(win("experimentalFeatures: true, "));
    const r = await check(safe, on);
    expect(ofRule(r)).toEqual(["fail main.js::win experimentalFeaturesInEffect"]);
    expect(r.findings.find((f) => f.rule === "window-more-permissive")!.message).toBe(
      "Window main.js::win lets its pages do more: experimentalFeaturesInEffect default off → on.",
    );
    expect(ofRule(await check(on, safe))).toEqual([]);
    expect(ofRule(await check(on, write(win("experimentalFeatures: false, "))))).toEqual([]);
    // writing the default explicitly, or dropping it, lets pages do nothing more
    expect(ofRule(await check(safe, write(win("experimentalFeatures: false, "))))).toEqual([]);
    expect(ofRule(await check(write(win("experimentalFeatures: false, ")), safe))).toEqual([]);
    expect(
      ofRule(await check(safe, write(win("experimentalFeatures: !app.isPackaged, ")))),
    ).toEqual(["fail unknown main.js::win experimentalFeaturesInEffect"]);
  });

  it("reports enableBlinkFeatures newly written or gaining features, never the reverse", async () => {
    const safe = write(win(""));
    const one = write(win('enableBlinkFeatures: "CSSVariables", '));
    const two = write(win('enableBlinkFeatures: "CSSVariables,KeyboardEventKey", '));
    const r = await check(safe, one);
    expect(ofRule(r)).toEqual(["fail main.js::win blinkFeaturesInEffect"]);
    expect(r.findings.find((f) => f.rule === "window-more-permissive")!.message).toBe(
      "Window main.js::win lets its pages do more: blinkFeaturesInEffect default off → on (enableBlinkFeatures CSSVariables).",
    );
    const gained = await check(one, two);
    expect(ofRule(gained)).toEqual(["fail main.js::win enableBlinkFeatures"]);
    const finding = gained.findings.find((f) => f.rule === "window-more-permissive")!;
    expect(finding.message).toBe(
      "Window main.js::win lets its pages do more: enableBlinkFeatures CSSVariables → CSSVariables, KeyboardEventKey.",
    );
    expect(finding.fingerprint).toBe(
      createHash("sha256")
        .update(
          "window-more-permissive\0window\0main.js::win\0enableBlinkFeatures\0CSSVariables, KeyboardEventKey",
        )
        .digest("hex")
        .slice(0, 32),
    );
    expect(ofRule(await check(two, one))).toEqual([]);
    expect(ofRule(await check(one, safe))).toEqual([]);
    // the same features in another order are no change
    expect(
      ofRule(
        await check(two, write(win('enableBlinkFeatures: "KeyboardEventKey,CSSVariables", '))),
      ),
    ).toEqual([]);
    // one feature swapped for another: a feature is new
    expect(
      ofRule(await check(one, write(win('enableBlinkFeatures: "KeyboardEventKey", ')))),
    ).toEqual(["fail main.js::win enableBlinkFeatures"]);
    expect(ofRule(await check(one, write(win("enableBlinkFeatures: process.env.B, "))))).toEqual([
      "fail unknown main.js::win blinkFeaturesInEffect",
    ]);
  });

  it("folds them into webSecurity for windows whose options could not be followed, changed or new", async () => {
    const shape = (options: string) => `const { app, BrowserWindow, session } = require("electron");
${LIMITS}function open(opts) {
  const win = new BrowserWindow(${options});
  win.loadFile("index.html");
}
`;
    const before = write(shape("{ webPreferences: { contextIsolation: true, sandbox: true } }"));
    const after = write(shape("{ ...opts, webPreferences: { ...opts.prefs } }"));
    const none = write(`const { app, session } = require("electron");
${LIMITS}`);
    for (const r of [await check(before, after), await check(none, after)]) {
      const keys = ofRule(r).filter((k) => /Features|webSecurity/.test(k));
      expect(keys).toEqual(["fail unknown main.js::win webSecurityInEffect"]);
      expect(r.findings.find((f) => f.key === "main.js::win webSecurityInEffect")!.message).toMatch(
        /experimentalFeatures and enableBlinkFeatures are not read as values of their own \(the window's options could not be followed\), so they cannot be told either\.$/,
      );
    }
  });

  it("judges a new window by its own settings", async () => {
    const none = write(`const { app, session } = require("electron");
${LIMITS}`);
    const r = await check(
      none,
      write(win('experimentalFeatures: true, enableBlinkFeatures: "CSSVariables", ')),
    );
    expect(ofRule(r)).toEqual([
      "fail main.js::win blinkFeaturesInEffect",
      "fail main.js::win experimentalFeaturesInEffect",
    ]);
  });
});
