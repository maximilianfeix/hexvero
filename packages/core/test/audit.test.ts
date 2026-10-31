import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildSync } from "esbuild";
import { afterAll, describe, expect, it } from "vitest";
import { analyzeJavaScriptTree, asarTree, type JsAppInfo } from "../src/javascript/app.js";
import {
  AUDIT_RULES,
  auditBuild,
  auditToSarif,
  checkRelease,
  parsePolicy,
  POLICY_RULES,
  Session,
} from "../src/index.js";
import { buildAsar } from "./fixtures/asar.js";

/**
 * `hexvero audit` and `check` on webSecurity, allowRunningInsecureContent (Electron's security
 * guide, sections 6 and 8) and limited navigation and window creation (sections 13 and 14).
 * Expected rows and findings are written from the fixture sources and Electron's documented
 * defaults (webSecurity on, allowRunningInsecureContent off, and on when webSecurity is false and
 * it is not written); nothing is run.
 */

const dir = mkdtempSync(join(tmpdir(), "hexvero-audit-"));
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

const audit = async (path: string, unknown?: "fail" | "warn" | "allow") => {
  const session = new Session();
  const { id } = await session.open(path);
  return auditBuild(session, id, { unknown });
};
const ruleList = (r: Awaited<ReturnType<typeof audit>>, rule: string): string[] =>
  r.findings.filter((f) => f.rule === rule).map((f) => `${f.key}${f.unknown ? " ?" : ""}`);

/** Every limit the navigation rule asks for, on every webContents. */
const LIMITS = `app.on("web-contents-created", (e, contents) => {
  contents.on("will-navigate", (ev) => ev.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
});
session.defaultSession.setPermissionRequestHandler((wc, p, cb) => cb(false));
`;

const WEB = `const { app, BrowserWindow, session } = require("electron");
${LIMITS}app.whenReady().then(() => {
  const loose = new BrowserWindow({ webPreferences: { webSecurity: false, contextIsolation: true, sandbox: true } });
  const mixed = new BrowserWindow({ webPreferences: { allowRunningInsecureContent: true, contextIsolation: true, sandbox: true } });
  const dev = new BrowserWindow({ webPreferences: { webSecurity: !app.isPackaged, contextIsolation: true, sandbox: true } });
  const strict = new BrowserWindow({ webPreferences: { webSecurity: true, allowRunningInsecureContent: false, contextIsolation: true, sandbox: true } });
  const quiet = new BrowserWindow({ webPreferences: { contextIsolation: true, sandbox: true } });
  for (const w of [loose, mixed, dev, strict, quiet]) w.loadFile("index.html");
});
`;

const effects = (info: JsAppInfo): string[] =>
  info.windows.map((w) => `${w.webSecurityInEffect} / ${w.allowRunningInsecureContentInEffect}`);

describe("windows: webSecurity and allowRunningInsecureContent", () => {
  const EXPECTED = [
    // webSecurity: false turns allowRunningInsecureContent on unless it is written
    "off / on",
    "default on / on",
    // computed: neither is known, since the second follows the first
    "unknown / unknown",
    "on / off",
    // never written: Electron's default in every version (no version is needed for it)
    "default on / default off",
  ];

  it("derives both settings from the literal, else Electron's default, in all three builds", () => {
    for (const [name, source] of variants(WEB))
      expect(effects(analyze(source)), name).toEqual(EXPECTED);
  });

  it("keeps the raw state next to the derived one", () => {
    const [loose, mixed, dev] = analyze(WEB).windows;
    expect([loose!.webSecurity, loose!.allowRunningInsecureContent]).toEqual([
      false,
      "not written",
    ]);
    expect(mixed!.allowRunningInsecureContent).toBe(true);
    expect(dev!.webSecurity).toBe("computed");
  });
});

describe("audit window-permissive: webSecurity and allowRunningInsecureContent", () => {
  it("reports the literal settings as findings and the computed one as unknown", async () => {
    const r = await audit(write(WEB));
    expect(ruleList(r, "window-permissive")).toEqual([
      // allowRunningInsecureContent of dev is unknown only through webSecurity: one finding
      "dev webSecurityInEffect unknown ?",
      "loose allowRunningInsecureContentInEffect on",
      "loose webSecurityInEffect off",
      "mixed allowRunningInsecureContentInEffect on",
    ]);
    const byKey = (k: string) => r.findings.find((f) => f.key === k)!;
    expect(byKey("loose webSecurityInEffect off").message).toBe(
      "Window loose: webSecurity is false as written, so the same-origin policy is off for its pages (Electron's security guide, section 6).",
    );
    expect(byKey("loose allowRunningInsecureContentInEffect on").message).toBe(
      "Window loose: allowRunningInsecureContent is not written and webSecurity: false turns it on, so its https pages may run scripts, styles and plugins loaded over http (Electron's security guide, section 8).",
    );
    expect(byKey("mixed allowRunningInsecureContentInEffect on").message).toBe(
      "Window mixed: allowRunningInsecureContent is true as written, so its https pages may run scripts, styles and plugins loaded over http (Electron's security guide, section 8).",
    );
    expect(byKey("dev webSecurityInEffect unknown").message).toBe(
      "Window dev: webSecurity cannot be told (a value computed at run time); allowRunningInsecureContent is not read as a value of its own and depends on it (webSecurity: false turns it on), so it cannot be told either.",
    );
    // the identity is the window and setting, as before the dependent finding was folded in
    expect(byKey("dev webSecurityInEffect unknown").fingerprint).toBe(
      createHash("sha256")
        .update("window-permissive\0maybe\0main.js\0dev\0webSecurityInEffect")
        .digest("hex")
        .slice(0, 32),
    );
    expect(byKey("loose webSecurityInEffect off").where).toEqual([{ file: "main.js", line: 8 }]);
    expect(r.status).toBe("fail");
  });

  it("finds the same in the bundled and minified builds", async () => {
    for (const [name, source] of variants(WEB).slice(1)) {
      const r = await audit(write(source));
      const values = r.findings
        .filter((f) => f.rule === "window-permissive")
        .map((f) => f.key.split(" ").slice(1).join(" "))
        .toSorted();
      expect(values, name).toEqual([
        "allowRunningInsecureContentInEffect on",
        "allowRunningInsecureContentInEffect on",
        "webSecurityInEffect off",
        "webSecurityInEffect unknown",
      ]);
    }
  });

  it("keeps an unknown of its own for allowRunningInsecureContent written as a computed value", async () => {
    const r = await audit(
      write(`const { app, BrowserWindow, session } = require("electron");
${LIMITS}const both = new BrowserWindow({ webPreferences: { webSecurity: !app.isPackaged, allowRunningInsecureContent: !app.isPackaged, contextIsolation: true, sandbox: true } });
const mixedOnly = new BrowserWindow({ webPreferences: { allowRunningInsecureContent: process.env.DEV === "1", contextIsolation: true, sandbox: true } });
function open(options) {
  const opaque = new BrowserWindow({ ...options, webPreferences: { ...options.prefs } });
  return opaque;
}
`),
    );
    expect(ruleList(r, "window-permissive").filter((k) => !k.startsWith("opaque"))).toEqual([
      "both allowRunningInsecureContentInEffect unknown ?",
      "both webSecurityInEffect unknown ?",
      "mixedOnly allowRunningInsecureContentInEffect unknown ?",
    ]);
    // options that could not be followed hide both settings: one finding, not two
    expect(
      ruleList(r, "window-permissive").filter((k) => /^opaque (webSecurity|allowRunning)/.test(k)),
    ).toEqual(["opaque webSecurityInEffect unknown ?"]);
    expect(r.findings.find((f) => f.key === "both webSecurityInEffect unknown")!.message).toBe(
      "Window both: webSecurity cannot be told (a value computed at run time).",
    );
    expect(
      r.findings.find((f) => f.key === "mixedOnly allowRunningInsecureContentInEffect unknown")!
        .message,
    ).toBe(
      "Window mixedOnly: allowRunningInsecureContent cannot be told (a value computed at run time).",
    );
  });

  it("keeps fingerprints when the code moves", async () => {
    const before = await audit(write(WEB));
    const after = await audit(write(`// a comment\n\n${WEB}`));
    expect(after.findings.map((f) => f.fingerprint)).toEqual(
      before.findings.map((f) => f.fingerprint),
    );
    expect(after.findings[0]!.where[0]!.line).not.toBe(before.findings[0]!.where[0]!.line);
  });

  it("does not report a window whose settings are safe or defaults", async () => {
    const r = await audit(
      write(`const { app, BrowserWindow, session } = require("electron");
${LIMITS}new BrowserWindow({ webPreferences: { webSecurity: true, contextIsolation: true, sandbox: true } });
new BrowserWindow({ webPreferences: { allowRunningInsecureContent: false, contextIsolation: true, sandbox: true } });
`),
    );
    expect(r.findings).toEqual([]);
    expect(r.status).toBe("pass");
  });
});

const NAV = (body: string): string => `const { app, BrowserWindow, session } = require("electron");
session.defaultSession.setPermissionRequestHandler((wc, p, cb) => cb(false));
app.whenReady().then(() => {
  const win = new BrowserWindow({ webPreferences: { contextIsolation: true, sandbox: true } });
${body}  win.loadFile("index.html");
});
`;

describe("audit navigation-unlimited", () => {
  it("reports no will-navigate listener as an absence, as in the demo build", async () => {
    const source = NAV(`  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));\n`);
    for (const [name, code] of variants(source)) {
      const r = await audit(write(code));
      const found = r.findings.filter((f) => f.rule === "navigation-unlimited");
      expect(
        found.map((f) => [f.key, f.unknown, f.where]),
        name,
      ).toEqual([["no will-navigate listener", false, []]]);
      expect(found[0]!.message).toBe(
        "No will-navigate or will-frame-navigate listener was found in the files read: without one, a page of the app may navigate its window to a URL the app does not expect (Electron's security guide, section 13).",
      );
      expect(r.status, name).toBe("fail");
    }
  });

  it("passes listeners on every webContents (web-contents-created), plain, bundled and minified", async () => {
    for (const [name, code] of variants(
      `const { app, BrowserWindow, session } = require("electron");\n${LIMITS}new BrowserWindow({ webPreferences: { contextIsolation: true, sandbox: true } });\n`,
    )) {
      const r = await audit(write(code));
      expect(ruleList(r, "navigation-unlimited"), name).toEqual([]);
      expect(r.status, name).toBe("pass");
    }
  });

  it("reports a missing setWindowOpenHandler and one that allows every window", async () => {
    const none = await audit(
      write(NAV(`  win.webContents.on("will-navigate", (e) => e.preventDefault());\n`)),
    );
    expect(ruleList(none, "navigation-unlimited")).toEqual(["no setWindowOpenHandler"]);
    const allow = await audit(
      write(
        NAV(`  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => { if (url) return { action: "allow" }; return { action: "allow" }; });
`),
      ),
    );
    const found = allow.findings.filter((f) => f.rule === "navigation-unlimited");
    expect(found.map((f) => [f.key, f.unknown, f.where])).toEqual([
      ["setWindowOpenHandler on win returns allow", false, [{ file: "main.js", line: 6 }]],
    ]);
    expect(found[0]!.message).toBe(
      'The setWindowOpenHandler of win returns { action: "allow" } on every path, so a page may open a window for a URL the app does not expect (Electron\'s security guide, section 14).',
    );
    // a handler whose answer is not read is no finding: what it allows is not known
    const unread = await audit(
      write(
        NAV(`  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(decide);
`),
      ),
    );
    expect(ruleList(unread, "navigation-unlimited")).toEqual([]);
  });

  it("names a window without a listener when others have one", async () => {
    const r = await audit(
      write(
        NAV(`  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const about = new BrowserWindow({ webPreferences: { contextIsolation: true, sandbox: true } });
  about.loadFile("about.html");
`),
      ),
    );
    expect(
      r.findings.filter((f) => f.rule === "navigation-unlimited").map((f) => [f.key, f.where]),
    ).toEqual([
      ["about: no setWindowOpenHandler", [{ file: "main.js", line: 7 }]],
      ["about: no will-navigate listener", [{ file: "main.js", line: 7 }]],
    ]);
  });

  it("leaves it unknown when a listener is on a webContents not read as a window", async () => {
    const path = write(`const { app, BrowserWindow, session } = require("electron");
session.defaultSession.setPermissionRequestHandler((wc, p, cb) => cb(false));
function watch(contents) { contents.on("will-navigate", (e) => e.preventDefault()); }
app.whenReady().then(() => {
  const win = new BrowserWindow({ webPreferences: { contextIsolation: true, sandbox: true } });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  watch(win.webContents);
});
`);
    const r = await audit(path);
    expect(ruleList(r, "navigation-unlimited")).toEqual([
      "will-navigate listener not read for win ?",
    ]);
    expect(r.findings.find((f) => f.rule === "navigation-unlimited")!.where).toEqual([
      { file: "main.js", line: 5 },
    ]);
    expect(r.status).toBe("incomplete");
    expect((await audit(path, "warn")).status).toBe("pass");
  });

  it("is undecided, not fired, when the scan is partial", async () => {
    const all: Record<string, string> = files(
      NAV(`  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));\n`),
    );
    for (let i = 0; i < 5; i++) all[`f${i}.js`] = `module.exports = ${i};\n`;
    const path = join(dir, "partial.asar");
    writeFileSync(path, buildAsar(all));
    const session = new Session();
    const { id } = await session.open(path);
    await session.continueAnalysis(id, { maxJsFiles: 2 });
    const r = await auditBuild(session, id);
    expect(ruleList(r, "navigation-unlimited")).toEqual([]);
    expect(r.incomplete.find((i) => i.rule === "navigation-unlimited")).toEqual({
      rule: "navigation-unlimited",
      collection: "navigationHandlers",
      gaps: ["scan_partial"],
    });
    expect(r.status).toBe("incomplete");
  });

  it("writes the rules into SARIF with the security guide's sections", async () => {
    const r = await audit(write(NAV("")));
    const sarif = auditToSarif(r, { version: "0.0.0" }) as {
      runs: Array<{
        tool: {
          driver: {
            rules: Array<{ id: string; fullDescription: { text: string }; help: { text: string } }>;
          };
        };
        results: Array<{ ruleId: string; ruleIndex: number }>;
      }>;
    };
    const rules = sarif.runs[0]!.tool.driver.rules;
    expect(rules.map((x) => x.id)).toEqual([...AUDIT_RULES]);
    const text = (id: string) => rules.find((x) => x.id === id)!;
    expect(text("navigation-unlimited").help.text).toMatch(/section 13/);
    expect(text("navigation-unlimited").help.text).toMatch(/section 14/);
    expect(text("window-permissive").help.text).toMatch(/section 6/);
    expect(text("window-permissive").help.text).toMatch(/section 8/);
    const results = sarif.runs[0]!.results.filter((x) => x.ruleId === "navigation-unlimited");
    expect(results).toHaveLength(2);
    expect(results.every((x) => x.ruleIndex === AUDIT_RULES.indexOf("navigation-unlimited"))).toBe(
      true,
    );
  });
});

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
const ofRule = (r: Awaited<ReturnType<typeof check>>, rule: string): string[] =>
  r.findings
    .filter((f) => f.rule === rule)
    .map((f) => `${f.level}${f.unknown ? " unknown" : ""} ${f.key}`);

/** The NAV build with more settings written in its window's webPreferences. */
const win = (prefs: string): string =>
  NAV("").replace("contextIsolation: true", `${prefs}contextIsolation: true`);

describe("check: window-more-permissive and navigation-limit-removed", () => {
  it("reports webSecurity turned off and insecure content turned on, not the reverse", async () => {
    const safe = write(win(""));
    const open = write(win("webSecurity: false, "));
    const r = await check(safe, open);
    expect(ofRule(r, "window-more-permissive")).toEqual([
      "fail main.js::win allowRunningInsecureContentInEffect",
      "fail main.js::win webSecurityInEffect",
    ]);
    expect(r.findings.find((f) => f.key === "main.js::win webSecurityInEffect")!.message).toBe(
      "Window main.js::win lets its pages do more: webSecurityInEffect default on → off.",
    );
    expect(ofRule(await check(open, safe), "window-more-permissive")).toEqual([]);
    const mixed = write(win("allowRunningInsecureContent: true, "));
    expect(ofRule(await check(safe, mixed), "window-more-permissive")).toEqual([
      "fail main.js::win allowRunningInsecureContentInEffect",
    ]);
    // a value computed at run time is a change whose direction cannot be told
    const computed = write(win("webSecurity: !app.isPackaged, "));
    expect(ofRule(await check(safe, computed), "window-more-permissive")).toEqual([
      "fail unknown main.js::win allowRunningInsecureContentInEffect",
      "fail unknown main.js::win webSecurityInEffect",
    ]);
  });

  it("reports a will-navigate listener or a window open handler that is gone", async () => {
    const both = NAV(`  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
`);
    const a = write(both);
    const none = write(NAV(""));
    const r = await check(a, none);
    expect(ofRule(r, "navigation-limit-removed")).toEqual([
      "warn setWindowOpenHandler removed",
      "warn will-navigate listener removed",
    ]);
    expect(r.findings.find((f) => f.key === "will-navigate listener removed")!.message).toBe(
      "The before build listens for will-navigate or will-frame-navigate and the after build does not: a page may navigate its window to a URL the app does not expect (Electron's security guide, section 13).",
    );
    const strict = await check(a, none, { "navigation-limit-removed": { level: "fail" } });
    expect(strict.status).toBe("fail");
    // moved code is no change
    expect(ofRule(await check(a, write(`// moved\n${both}`)), "navigation-limit-removed")).toEqual(
      [],
    );
  });

  it("reports a window open handler that newly allows every window", async () => {
    const deny = NAV(`  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
`);
    const a = write(deny);
    const b = write(deny.replace('"deny"', '"allow"'));
    expect(ofRule(await check(a, b), "navigation-limit-removed")).toEqual([
      "warn setWindowOpenHandler on win returns allow",
    ]);
    expect(ofRule(await check(b, b), "navigation-limit-removed")).toEqual([]);
  });

  it("is a known rule of the policy schema and the example policy", () => {
    const root = join(import.meta.dirname, "..", "..", "..");
    const schema = JSON.parse(readFileSync(join(root, "docs", "policy.schema.json"), "utf8"));
    expect(Object.keys(schema.properties.rules.properties)).toEqual([...POLICY_RULES]);
    const example = JSON.parse(readFileSync(join(root, "examples", "policy.json"), "utf8"));
    expect(example.rules["navigation-limit-removed"]).toEqual({ level: "fail" });
  });
});
