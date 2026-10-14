import { describe, expect, it } from "vitest";
import {
  analyzeJavaScriptTree,
  asarTree,
  electronMajor,
  windowEffects,
} from "../src/javascript/app.js";
import { buildAsar } from "./fixtures/asar.js";

/** Analysis of an app with this main file; `electron` is the range package.json asks for. */
function analyze(main: string, electron?: string): ReturnType<typeof analyzeJavaScriptTree> {
  return analyzeJavaScriptTree(
    asarTree(
      buildAsar({
        "package.json": JSON.stringify({
          name: "x",
          main: "main.js",
          ...(electron ? { devDependencies: { electron } } : {}),
        }),
        "main.js": `const { app, BrowserWindow } = require("electron");\n${main}`,
      }),
      "app.asar",
    ),
  );
}

const effects = (
  nodeIntegration: boolean | "computed" | "not written",
  contextIsolation: boolean | "computed" | "not written",
  sandbox: boolean | "computed" | "not written",
  major: number | null,
  enableSandbox = false,
): string => {
  const e = windowEffects({ nodeIntegration, contextIsolation, sandbox }, major, enableSandbox);
  return `node ${e.nodeIntegrationInEffect}, isolation ${e.contextIsolationInEffect}, sandbox ${e.sandboxInEffect}, require ${e.pageRequire}`;
};

const detail = (prefs: string, electron?: string): string | undefined =>
  analyze(`const w = new BrowserWindow({ webPreferences: { ${prefs} } });`, electron).findings.find(
    (f) => f.kind === "electron.node-integration",
  )?.detail;

/** `sandbox contextIsolation` of a window created with these webPreferences, next to two bases. */
const state = (options: string): string =>
  analyze(
    `const unsafe = { sandbox: false, contextIsolation: false };\nfunction base () { return { sandbox: false } }\nconst w = new BrowserWindow({ webPreferences: ${options} });`,
  )
    .windows.map((w) => `${w.sandbox} ${w.contextIsolation}`)
    .join();

/** `sandboxInEffect` of a window that writes `sandbox: false`, after `main`. */
const sandbox = (main: string): string =>
  analyze(`${main}\nconst w = new BrowserWindow({ webPreferences: { sandbox: false } });`)
    .windows.map((w) => w.sandboxInEffect)
    .join();

describe("what follows from a window's settings together", () => {
  it("gives page scripts require() only with nodeIntegration on and contextIsolation off", () => {
    expect(effects(true, false, "not written", 38)).toBe(
      "node on, isolation off, sandbox off, require yes",
    );
    expect(effects(true, true, "not written", 38)).toBe(
      "node on, isolation on, sandbox off, require no",
    );
    expect(effects(false, false, "not written", 38)).toBe(
      "node off, isolation off, sandbox default on, require no",
    );
  });

  it("uses the default of the Electron version for a setting that is not written", () => {
    // a default is an assumption about the runtime and never reads as a written value
    expect(effects(true, "not written", "not written", 38)).toBe(
      "node on, isolation default on, sandbox off, require no by default",
    );
    expect(effects(true, "not written", "not written", 11)).toBe(
      "node on, isolation default off, sandbox off, require yes by default",
    );
    expect(effects("not written", "not written", "not written", 19)).toBe(
      "node default off, isolation default on, sandbox default off, require no by default",
    );
    expect(effects("not written", "not written", "not written", 20)).toBe(
      "node default off, isolation default on, sandbox default on, require no by default",
    );
  });

  it("knows that nodeIntegration was on by default before Electron 5", () => {
    expect(effects("not written", "not written", "not written", 4)).toBe(
      "node default on, isolation default off, sandbox default off, require yes by default",
    );
    expect(effects("not written", true, "not written", 4)).toBe(
      "node default on, isolation on, sandbox default off, require no",
    );
    expect(effects(false, "not written", "not written", 4)).toBe(
      "node off, isolation default off, sandbox default off, require no",
    );
  });

  it("says unknown when the version is not known or a value is computed", () => {
    expect(effects(true, "not written", "not written", null)).toBe(
      "node on, isolation unknown, sandbox off, require unknown",
    );
    expect(effects("not written", "not written", "not written", null)).toBe(
      "node unknown, isolation unknown, sandbox unknown, require unknown",
    );
    expect(effects("not written", true, "not written", null)).toBe(
      "node unknown, isolation on, sandbox unknown, require no",
    );
    expect(effects("computed", true, true, 38)).toBe(
      "node unknown, isolation on, sandbox on, require no",
    );
    expect(effects("computed", false, true, 38)).toBe(
      "node unknown, isolation off, sandbox on, require unknown",
    );
    expect(effects(false, true, "computed", 38)).toBe(
      "node off, isolation on, sandbox unknown, require no",
    );
    expect(effects("computed", true, "not written", 38)).toBe(
      "node unknown, isolation on, sandbox unknown, require no",
    );
  });

  it("lets nodeIntegration and app.enableSandbox() override the sandbox setting", () => {
    expect(effects(true, true, "not written", 38)).toBe(
      "node on, isolation on, sandbox off, require no",
    );
    // both written: the documentation does not say which decides, so nothing is claimed
    expect(effects(true, true, true, 38)).toBe(
      "node on, isolation on, sandbox unknown, require no",
    );
    expect(effects(true, false, true, 38)).toBe(
      "node on, isolation off, sandbox unknown, require unknown",
    );
    // a call that may not run does not make the sandbox certain
    expect(effects(false, true, false, 38, "maybe")).toBe(
      "node off, isolation on, sandbox unknown, require no",
    );
    expect(effects(false, true, true, 38, "maybe")).toBe(
      "node off, isolation on, sandbox on, require no",
    );
    expect(effects(false, true, false, 38, true)).toBe(
      "node off, isolation on, sandbox on, require no",
    );
  });

  it("reads the major version from a package.json range", () => {
    expect(["^38.0.0", "~12.2", "11.5.0", ">=20 <30", "v22.1.0", "38"].map(electronMajor)).toEqual([
      38, 12, 11, 20, 22, 38,
    ]);
    expect(
      ["latest", "", null, "github:electron/electron", "file:../e"].map(electronMajor),
    ).toEqual([null, null, null, null, null]);
  });
});

describe("window settings as written, computed, or absent", () => {
  it("lists one row per window, also for a window that writes no setting", () => {
    const info = analyze(
      [
        "const main = new BrowserWindow({ width: 800 });",
        "const prompt = new BrowserWindow({ webPreferences: {",
        "  nodeIntegration: true,",
        "  contextIsolation: false,",
        '  preload: __dirname + "/prompt.js",',
        "} });",
      ].join("\n"),
      "^38.0.0",
    );
    expect(
      info.windows.map(
        (w) =>
          `${w.windowName}:${w.line} ni=${w.nodeIntegration} ci=${w.contextIsolation} sb=${w.sandbox} preload=${w.preload} -> ${w.contextIsolationInEffect}/${w.sandboxInEffect}/${w.pageRequire}`,
      ),
    ).toEqual([
      "main:2 ni=not written ci=not written sb=not written preload=null -> default on/default on/no by default",
      "prompt:3 ni=true ci=false sb=not written preload=prompt.js -> off/off/yes",
    ]);
    expect(info.windows[0]!.basis).toContain(
      "nodeIntegration not written: off by default in Electron 38, the version package.json asks for (off since 5); the shipped runtime was not checked",
    );
  });

  it("keeps a computed value apart from a literal and says which expression decides it", () => {
    const info = analyze(
      [
        "const isDev = !app.isPackaged;",
        "const w = new BrowserWindow({ webPreferences: {",
        "  sandbox: !isDev,",
        "  nodeIntegration: options.node || false,",
        "  contextIsolation: true,",
        "} });",
      ].join("\n"),
      "^38.0.0",
    );
    expect(
      info.webPreferences.map((p) => `${p.key}=${p.value} ${p.computed ?? ""}`.trim()),
    ).toEqual([
      "sandbox=null !isDev",
      "nodeIntegration=null options.node || false",
      "contextIsolation=true",
    ]);
    expect(
      info.windows.map((w) => `${w.sandbox} ${w.nodeIntegration} ${w.sandboxInEffect}`),
    ).toEqual(["computed computed unknown"]);
    // a computed value decides no app-wide flag and raises no finding
    expect(info.electron).toMatchObject({ sandbox: null, nodeIntegration: null });
    expect(info.findings.map((f) => f.kind)).not.toContain("electron.sandbox");
    expect(info.limitations.find((l) => l.code === "webpreferences_computed")?.message).toBe(
      "2 window setting(s) are computed at run time, so their value is not known: sandbox at main.js:4 (!isDev), nodeIntegration at main.js:5 (options.node || false).",
    );
  });

  it("words the nodeIntegration finding from the same window and the Electron version", () => {
    expect(detail("nodeIntegration: true, contextIsolation: true", "^38.0.0")).toMatch(
      /^contextIsolation is on for the same window, so page scripts do not get require\(\)/,
    );
    // a default taken from package.json is worded as an assumption, never as a fact
    expect(detail("nodeIntegration: true", "^38.0.0")).toMatch(
      /^contextIsolation is not written for the same window\. It is on by default in the Electron version package\.json asks for \(\^38\.0\.0\), and then page scripts do not get require\(\); the shipped runtime was not checked\./,
    );
    expect(detail("nodeIntegration: true", "^11.0.0")).toMatch(
      /^contextIsolation is not written for the same window and is off by default .* if that is the runtime, page scripts can require Node modules\./,
    );
    expect(detail("nodeIntegration: true")).toMatch(
      /^Whether page scripts get require\(\) depends/,
    );
    expect(detail("nodeIntegration: true, contextIsolation: flag", "^38.0.0")).toMatch(
      /^Whether page scripts get require\(\) depends/,
    );
  });

  it("reads further settings and raises a finding only for the value that matters", () => {
    const info = analyze(
      [
        "const a = new BrowserWindow({ webPreferences: {",
        "  webSecurity: false,",
        "  allowRunningInsecureContent: true,",
        "  webviewTag: true,",
        "  nodeIntegrationInSubFrames: true,",
        "  nodeIntegrationInWorker: false,",
        "} });",
        "const b = new BrowserWindow({ webPreferences: { webSecurity: true, webviewTag: false } });",
      ].join("\n"),
    );
    expect(info.webPreferences.map((p) => `${p.windowName} ${p.key}=${p.value}`)).toEqual([
      "a webSecurity=false",
      "a allowRunningInsecureContent=true",
      "a webviewTag=true",
      "a nodeIntegrationInSubFrames=true",
      "a nodeIntegrationInWorker=false",
      "b webSecurity=true",
      "b webviewTag=false",
    ]);
    expect(
      info.findings
        .filter((f) => f.kind.startsWith("electron.w") || f.kind.includes("insecure"))
        .map((f) => `${f.kind} @ ${f.location}`),
    ).toEqual([
      "electron.web-security @ main.js:3",
      "electron.insecure-content @ main.js:4",
      "electron.webview-tag @ main.js:5",
    ]);
  });

  it("treats the sandbox as on everywhere when app.enableSandbox() is called", () => {
    const info = analyze(
      "app.enableSandbox();\nconst w = new BrowserWindow({ webPreferences: { sandbox: false } });",
      "^38.0.0",
    );
    expect(info.windows.map((w) => `${w.sandbox} ${w.sandboxInEffect}`)).toEqual(["false on"]);
  });

  it("lets the last of two values written for one key decide, as JavaScript does", () => {
    const info = analyze(
      "const w = new BrowserWindow({ webPreferences: { sandbox: true, contextIsolation: true, sandbox: false, contextIsolation: false, nodeIntegration: true } });",
      "^38.0.0",
    );
    expect(info.windows.map((w) => `${w.sandbox} ${w.contextIsolation} ${w.pageRequire}`)).toEqual([
      "false false yes",
    ]);
    expect(info.findings.find((f) => f.kind === "electron.node-integration")?.detail).toMatch(
      /^contextIsolation is off for the same window/,
    );
  });

  it("reports the window where page scripts get require() before one where they do not", () => {
    const info = analyze(
      [
        "const safe = new BrowserWindow({ webPreferences: { nodeIntegration: true, contextIsolation: true } });",
        "const open = new BrowserWindow({ webPreferences: { nodeIntegration: true, contextIsolation: false } });",
      ].join("\n"),
    );
    const finding = info.findings.find((f) => f.kind === "electron.node-integration");
    expect(finding?.detail).toMatch(/^contextIsolation is off for the same window/);
    expect(finding?.location).toBe("main.js:3");
  });

  it("raises a finding when nothing is written and the named Electron version predates 5", () => {
    const old = analyze("const mainWindow = new BrowserWindow({ width: 800 });", "^4.0.1");
    expect(old.windows.map((w) => `${w.nodeIntegrationInEffect} ${w.pageRequire}`)).toEqual([
      "default on yes by default",
    ]);
    const finding = old.findings.find((f) => f.kind === "electron.node-integration-default");
    expect(finding?.location).toBe("main.js:2");
    expect(finding?.detail).toContain("package.json asks for Electron ^4.0.1");
    const current = analyze("const mainWindow = new BrowserWindow({ width: 800 });", "^38.0.0");
    expect(current.findings.map((f) => f.kind)).not.toContain("electron.node-integration-default");
  });

  it("lets a base object spread after a key replace it, and one spread before be replaced", () => {
    // JavaScript: the later write wins
    expect(state("{ sandbox: true, contextIsolation: true, ...unsafe }")).toBe("false false");
    expect(state("{ ...unsafe, sandbox: true, contextIsolation: true }")).toBe("true true");
    expect(state("{ sandbox: true, ...unsafe, contextIsolation: true }")).toBe("false true");
    expect(state("{ sandbox: true, ...base() }")).toBe("false not written");
    expect(state("{ ...base(), sandbox: true }")).toBe("true not written");
  });

  it("keeps both values when a key is written in two separate objects of one window", () => {
    // the later, unrelated `sandbox: true` must not hide the `sandbox: false` of webPreferences
    const info = analyze(
      "const w = new BrowserWindow({ webPreferences: { sandbox: false, nodeIntegration: true, contextIsolation: false }, tabOptions: { sandbox: true, nodeIntegration: false } });",
      "^38.0.0",
    );
    expect(info.webPreferences.map((p) => `${p.key}=${p.value}`)).toEqual([
      "sandbox=false",
      "nodeIntegration=true",
      "contextIsolation=false",
      "sandbox=true",
      "nodeIntegration=false",
    ]);
    expect(info.windows.map((w) => `${w.sandbox} ${w.nodeIntegration} ${w.pageRequire}`)).toEqual([
      "conflicting conflicting unknown",
    ]);
    // the least safe value still decides the findings
    expect(info.findings.map((f) => f.kind)).toEqual(
      expect.arrayContaining(["electron.sandbox", "electron.node-integration"]),
    );
  });

  it("lays a helper's argument over what the helper returns", () => {
    const info = analyze(
      "function base (extra) { return { sandbox: false, contextIsolation: false, ...extra } }\nconst w = new BrowserWindow({ webPreferences: base({ sandbox: true }) });",
    );
    // The argument's `sandbox: true` is laid over the helper's value. The helper also spreads
    // its parameter after `contextIsolation: false`; its only call passes `{ sandbox: true }`,
    // which does not touch that key, so it stays false.
    expect(info.windows.map((w) => `${w.sandbox} ${w.contextIsolation}`)).toEqual(["true false"]);
    // with a caller whose argument cannot be read, the key is not known
    const opaque = analyze(
      "function base (extra) { return { sandbox: false, contextIsolation: false, ...extra } }\nconst w = new BrowserWindow({ webPreferences: base({ sandbox: true }) });\nbase(userOptions);",
    );
    expect(opaque.windows.map((w) => `${w.sandbox} ${w.contextIsolation}`)).toEqual([
      "true computed",
    ]);
    const plain = analyze(
      "function base () { return { sandbox: false, contextIsolation: false } }\nconst w = new BrowserWindow({ webPreferences: base({ sandbox: true }) });",
    );
    expect(plain.windows.map((w) => `${w.sandbox} ${w.contextIsolation}`)).toEqual(["true false"]);
  });

  it("reads app.enableSandbox() from code, and only an unconditional top-level call as certain", () => {
    expect(sandbox("app.enableSandbox();")).toBe("on");
    expect(sandbox("// we tried app.enableSandbox() once and removed it")).toBe("off");
    expect(sandbox('const note = "app.enableSandbox()";')).toBe("off");
    expect(sandbox("if (process.env.SANDBOX) app.enableSandbox();")).toBe("unknown");
    expect(sandbox("function harden () { app.enableSandbox(); }")).toBe("unknown");
    expect(sandbox("flag && app.enableSandbox();")).toBe("unknown");
  });

  it("reads settings as computed when a window's options cannot be followed", () => {
    const rows = (main: string): string[] =>
      analyze(main, "^38.0.0").windows.map(
        (w) => `${w.nodeIntegration} ${w.contextIsolation} ${w.sandbox} ${w.pageRequire}`,
      );
    // options passed in as a parameter that one caller fills in from something unreadable
    const info = analyze(
      "function make (o) { return new BrowserWindow(o); }\nmake({ webPreferences: { nodeIntegration: true, contextIsolation: false } });\nmake(loadOptions());",
      "^38.0.0",
    );
    expect(info.windows.map((w) => `${w.nodeIntegration} ${w.pageRequire}`)).toEqual([
      "computed unknown",
    ]);
    expect(info.limitations.find((l) => l.code === "window_options_unresolved")?.message).toContain(
      "#1 at main.js:2",
    );
    // a conditional between two objects
    expect(
      rows(
        "const w = new BrowserWindow(dev ? { webPreferences: { nodeIntegration: true, contextIsolation: false } } : { webPreferences: { nodeIntegration: false, contextIsolation: true } });",
      ),
    ).toEqual(["computed computed computed unknown"]);
    expect(
      rows(
        "const w = new BrowserWindow({ webPreferences: dev ? { sandbox: false } : { sandbox: true } });",
      ),
    ).toEqual(["computed computed computed unknown"]);
    // a spread of something that is not an object of the file: keys written after it stand
    expect(
      rows(
        "const w = new BrowserWindow({ webPreferences: { nodeIntegration: false, ...extra, contextIsolation: true } });",
      ),
    ).toEqual(["computed true computed no"]);
    expect(
      rows(
        "const w = new BrowserWindow({ webPreferences: { ...extra, nodeIntegration: false, sandbox: true } });",
      ),
    ).toEqual(["false computed true no"]);
  });

  it("reads a key as computed when the followed options object is assigned to later", () => {
    const info = analyze(
      [
        "const prefs = { nodeIntegration: false, contextIsolation: true, sandbox: true };",
        "prefs.nodeIntegration = true;",
        'prefs["contextIsolation"] = false;',
        "const w = new BrowserWindow({ webPreferences: prefs });",
      ].join("\n"),
      "^38.0.0",
    );
    expect(
      info.windows.map(
        (w) => `${w.nodeIntegration} ${w.contextIsolation} ${w.sandbox} ${w.pageRequire}`,
      ),
    ).toEqual(["computed computed true unknown"]);
    const assigned = analyze(
      "const prefs = { nodeIntegration: false };\nObject.assign(prefs, overrides);\nconst w = new BrowserWindow({ webPreferences: prefs });",
    );
    expect(assigned.windows.map((w) => w.nodeIntegration)).toEqual(["computed"]);
  });

  it("reads every key as computed when the followed object may be changed in a way it does not read", () => {
    for (const change of [
      "tweak(prefs);",
      "prefs = loadPrefs();",
      "prefs.extra.deep.sandbox = false;",
      "new Tweaker(prefs);",
      "tweak({ webPreferences: prefs });",
      "const copy = { ...prefs }; share(copy);",
      "prefs?.sandbox;",
      "prefs[`sandbox`] = false;",
      "const alias = prefs; alias.sandbox = false;",
      "prefs[name] = false;",
      "Object.defineProperty(prefs, 'sandbox', { value: false });",
    ])
      expect(
        analyze(
          `let prefs = { sandbox: true, contextIsolation: true };\n${change}\nconst w = new BrowserWindow({ webPreferences: prefs });`,
        ).windows.map((w) => `${w.sandbox} ${w.contextIsolation}`),
        change,
      ).toEqual(["computed computed"]);
    // a compound write to one key is a write to that key
    for (const change of [
      "prefs.sandbox ||= other;",
      "prefs.sandbox &&= other;",
      "prefs.sandbox ??= other;",
      "prefs.sandbox ^= true;",
      "prefs.sandbox++;",
      "delete prefs.sandbox;",
    ])
      expect(
        analyze(
          `const prefs = { sandbox: true, contextIsolation: true };\n${change}\nconst w = new BrowserWindow({ webPreferences: prefs });`,
        ).windows.map((w) => `${w.sandbox} ${w.contextIsolation}`),
        change,
      ).toEqual(["computed true"]);
    // a read of a key is not a change
    expect(
      analyze(
        "const prefs = { sandbox: true };\nif (prefs.sandbox) log();\nconst w = new BrowserWindow({ webPreferences: prefs });",
      ).windows.map((w) => w.sandbox),
    ).toEqual([true]);
    // followed and unchanged, also through the module's name
    expect(
      analyze(
        'const electron = require("electron");\nconst opts = { webPreferences: { sandbox: true } };\nconst w = new electron.BrowserWindow(opts);',
      ).windows.map((w) => w.sandbox),
    ).toEqual([true]);
    const whole = analyze(
      "const opts = { webPreferences: { sandbox: true } };\nopts.webPreferences = other;\nconst w = new BrowserWindow(opts);",
    );
    expect(whole.windows.map((w) => w.sandbox)).toEqual(["computed"]);
  });

  it("does not call a setting safe app-wide while a window leaves it open", () => {
    // written safe in one window, computed in another
    const mixed = analyze(
      "const a = new BrowserWindow({ webPreferences: { sandbox: true, nodeIntegration: false } });\nconst b = new BrowserWindow({ webPreferences: { sandbox: !isDev, nodeIntegration: flag } });",
    );
    expect(mixed.electron).toMatchObject({ sandbox: null, nodeIntegration: null });
    // options that could not be followed
    const opaque = analyze(
      "const a = new BrowserWindow({ webPreferences: { sandbox: true, contextIsolation: true } });\nconst b = new BrowserWindow(options);",
    );
    expect(opaque.electron).toMatchObject({ sandbox: null, contextIsolation: null });
    // an unsafe literal still decides
    const unsafe = analyze(
      "const a = new BrowserWindow({ webPreferences: { sandbox: false } });\nconst b = new BrowserWindow(options);",
    );
    expect(unsafe.electron?.sandbox).toBe(false);
    // and with every window read, the safe value stands
    const read = analyze("const a = new BrowserWindow({ webPreferences: { sandbox: true } });");
    expect(read.electron?.sandbox).toBe(true);
  });

  it("replaces a whole webPreferences object by a later write of that key", () => {
    const BASE =
      "const base = { webPreferences: { nodeIntegration: true, contextIsolation: false } };\n";
    // the window's own `webPreferences` comes after the spread: nothing of the base's is left
    const own = analyze(
      `${BASE}const w = new BrowserWindow({ ...base, webPreferences: { nodeIntegration: false, contextIsolation: true } });`,
    );
    expect(own.windows.map((w) => `${w.nodeIntegration} ${w.contextIsolation}`)).toEqual([
      "false true",
    ]);
    expect(own.findings.map((f) => f.kind)).not.toContain("electron.node-integration");
    // the spread comes after: the base's object replaces the window's own
    const base = analyze(
      `${BASE}const w = new BrowserWindow({ webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true }, ...base });`,
    );
    expect(
      base.windows.map((w) => `${w.nodeIntegration} ${w.contextIsolation} ${w.sandbox}`),
    ).toEqual(["true false not written"]);
    expect(base.findings.map((f) => f.kind)).toContain("electron.node-integration");
  });

  it("attributes the settings of an options object declared above its constructor to that window", () => {
    const info = analyze(
      "const opts = { webPreferences: { sandbox: false, contextIsolation: true } };\nconst w = new BrowserWindow(opts);",
    );
    expect(info.webPreferences.map((p) => `${p.windowName} ${p.key}=${p.value}`)).toEqual([
      "w sandbox=false",
      "w contextIsolation=true",
    ]);
    expect(info.windows.map((w) => `${w.sandbox} ${w.contextIsolation}`)).toEqual(["false true"]);
  });

  it("does not let a change to a followed object touch a window whose options are written in place", () => {
    const info = analyze(
      [
        "const prefs = { sandbox: true };",
        "prefs.sandbox = false;",
        "const named = new BrowserWindow({ webPreferences: prefs });",
        "const inline = new BrowserWindow({ webPreferences: { sandbox: true, nodeIntegration: false } });",
      ].join("\n"),
    );
    expect(info.windows.map((w) => `${w.windowName} ${w.sandbox} ${w.nodeIntegration}`)).toEqual([
      "named computed not written",
      "inline true false",
    ]);
  });
});
