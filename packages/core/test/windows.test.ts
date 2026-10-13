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
  return `isolation ${e.contextIsolationInEffect}, sandbox ${e.sandboxInEffect}, require ${e.pageRequire}`;
};

const detail = (prefs: string, electron?: string): string | undefined =>
  analyze(`const w = new BrowserWindow({ webPreferences: { ${prefs} } });`, electron).findings.find(
    (f) => f.kind === "electron.node-integration",
  )?.detail;

describe("what follows from a window's settings together", () => {
  it("gives page scripts require() only with nodeIntegration on and contextIsolation off", () => {
    expect(effects(true, false, "not written", 38)).toBe("isolation off, sandbox off, require yes");
    expect(effects(true, true, "not written", 38)).toBe("isolation on, sandbox off, require no");
    expect(effects(false, false, "not written", 38)).toBe("isolation off, sandbox on, require no");
  });

  it("uses the default of the Electron version for a setting that is not written", () => {
    expect(effects(true, "not written", "not written", 38)).toBe(
      "isolation on, sandbox off, require no",
    );
    expect(effects(true, "not written", "not written", 11)).toBe(
      "isolation off, sandbox off, require yes",
    );
    expect(effects("not written", "not written", "not written", 19)).toBe(
      "isolation on, sandbox off, require no",
    );
    expect(effects("not written", "not written", "not written", 20)).toBe(
      "isolation on, sandbox on, require no",
    );
  });

  it("says unknown when the version is not known or a value is computed", () => {
    expect(effects(true, "not written", "not written", null)).toBe(
      "isolation unknown, sandbox off, require unknown",
    );
    expect(effects("not written", "not written", "not written", null)).toBe(
      "isolation unknown, sandbox unknown, require no",
    );
    expect(effects("computed", true, true, 38)).toBe("isolation on, sandbox on, require unknown");
    expect(effects(false, true, "computed", 38)).toBe("isolation on, sandbox unknown, require no");
    expect(effects("computed", true, "not written", 38)).toBe(
      "isolation on, sandbox unknown, require unknown",
    );
  });

  it("lets nodeIntegration and app.enableSandbox() override the sandbox setting", () => {
    expect(effects(true, true, true, 38)).toBe("isolation on, sandbox off, require no");
    expect(effects(false, true, false, 38, true)).toBe("isolation on, sandbox on, require no");
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
      "main:2 ni=not written ci=not written sb=not written preload=null -> on/on/no",
      "prompt:3 ni=true ci=false sb=not written preload=prompt.js -> off/off/yes",
    ]);
    expect(info.windows[0]!.basis).toBe(
      "contextIsolation not written: on by default in Electron 38 (on since 12); sandbox not written: on by default in Electron 38 (on since 20)",
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
    expect(detail("nodeIntegration: true", "^38.0.0")).toMatch(/^contextIsolation is on/);
    expect(detail("nodeIntegration: true", "^11.0.0")).toMatch(/^contextIsolation is off/);
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
});
