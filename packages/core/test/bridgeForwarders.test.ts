import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildSync } from "esbuild";
import { afterAll, describe, expect, it } from "vitest";
import { analyzeJavaScriptTree, asarTree, type JsAppInfo } from "../src/javascript/app.js";
import { buildAsar } from "./fixtures/asar.js";

/**
 * Generic bridge forwarders (R1): a preload member that passes its first parameter on as the
 * channel (electron-react-boilerplate's `window.electron.ipcRenderer.sendMessage`, an exposed
 * `ipcRenderer.invoke`, Element's allow-list, VS Code's prefix check), and the page scripts'
 * calls of it, which carry the channels. Plain, bundled and minified. The expected rows are
 * written from the fixture sources; nothing is run.
 */

const dir = mkdtempSync(join(tmpdir(), "hexvero-bridge-forwarders-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const MAIN = `const { ipcMain, BrowserWindow } = require("electron");
new BrowserWindow({ webPreferences: { preload: require("path").join(__dirname, "preload.js") } });
ipcMain.on("ipc-example", (event) => event.reply("ipc-example", "pong"));
ipcMain.handle("renderer:rename-collection", () => 1);
`;

const PRELOAD = `const { contextBridge, ipcRenderer } = require("electron");
const CHANNELS = ["app_onAction", "ipcCall"];
const electronHandler = {
  ipcRenderer: {
    sendMessage(channel, ...args) { ipcRenderer.send(channel, ...args); },
    on(channel, func) {
      const subscription = (_event, ...args) => func(...args);
      ipcRenderer.on(channel, subscription);
      return () => { ipcRenderer.removeListener(channel, subscription); };
    },
  },
  send(channel, ...args) { if (!CHANNELS.includes(channel)) return; ipcRenderer.send(channel, ...args); },
  sendIf(channel, ...args) { if (CHANNELS.includes(channel)) { ipcRenderer.send(channel, ...args); } },
  vs(channel, ...args) { if (!channel?.startsWith("vscode:")) throw new Error("no"); ipcRenderer.send(channel, ...args); },
  logged(channel, ...args) { if (CHANNELS.includes(channel)) console.log(channel); ipcRenderer.send(channel, ...args); },
  warned(channel, ...args) { if (!CHANNELS.includes(channel)) console.warn("x"); ipcRenderer.send(channel, ...args); },
  noted(channel, ...args) { const ok = CHANNELS.includes(channel); note(ok); ipcRenderer.send(channel, ...args); },
  checked(channel, ...args) { if (validate(channel)) ipcRenderer.send(channel, ...args); },
  ping: () => ipcRenderer.send("ping"),
};
function validate(c) { return c.startsWith("vscode:"); }
function note() {}
contextBridge.exposeInMainWorld("electron", electronHandler);
contextBridge.exposeInMainWorld("ipcRenderer", { invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args) });
`;

const RENDERER = `window.electron.ipcRenderer.on("ipc-example", (arg) => console.log(arg));
window.electron.ipcRenderer.sendMessage("ipc-example", ["ping"]);
window.electron.send("ipcCall", 1);
window.electron.send("evil", 1);
window.electron.sendIf("evil", 1);
electron.vs("vscode:hello");
electron.vs("other:x");
globalThis.electron.logged("evil");
window.electron.warned("evil");
window.electron.noted("evil");
window.electron.checked("vscode:checked");
const { ipcRenderer } = window;
ipcRenderer.invoke("renderer:rename-collection", { id: 1 });
const api = window.electron;
api.send("app_onAction");
function shadow(electron) { electron.send("shadowed"); }
window.electron.ping("not-forwarded");
`;

const EXPECTED = [
  "app_onAction ipcRenderer.send electron.send yes",
  "evil ipcRenderer.send electron.logged unknown",
  "evil ipcRenderer.send electron.noted unknown",
  "evil ipcRenderer.send electron.send no",
  "evil ipcRenderer.send electron.sendIf no",
  "evil ipcRenderer.send electron.warned unknown",
  "ipc-example ipcRenderer.on electron.ipcRenderer.on -",
  "ipc-example ipcRenderer.send electron.ipcRenderer.sendMessage -",
  "ipcCall ipcRenderer.send electron.send yes",
  "other:x ipcRenderer.send electron.vs no",
  "renderer:rename-collection ipcRenderer.invoke ipcRenderer.invoke -",
  "vscode:checked ipcRenderer.send electron.checked unknown",
  "vscode:hello ipcRenderer.send electron.vs yes",
];

function analyze(files: Record<string, string>): JsAppInfo {
  return analyzeJavaScriptTree(
    asarTree(
      buildAsar({ "package.json": JSON.stringify({ name: "r", main: "main.js" }), ...files }),
      "app.asar",
    ),
  );
}

function build(minify: boolean): Record<string, string> {
  const src = mkdtempSync(join(dir, "src-"));
  const files = { "main.js": MAIN, "preload.js": PRELOAD, "renderer.js": RENDERER };
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(src, name)), { recursive: true });
    writeFileSync(join(src, name), text);
  }
  const out: Record<string, string> = {};
  for (const name of Object.keys(files)) {
    const outfile = join(src, "out", name);
    buildSync({
      entryPoints: [join(src, name)],
      bundle: true,
      minify,
      platform: name === "renderer.js" ? "browser" : "node",
      format: name === "renderer.js" ? "iife" : "cjs",
      external: ["electron"],
      outfile,
      logLevel: "silent",
    });
    out[name] = readFileSync(outfile, "utf8");
  }
  return out;
}

const pageRows = (info: JsAppInfo): string[] =>
  info.modules
    .filter((m) => m.id === "renderer.js")
    .flatMap((m) =>
      m.ipc.map((u) => `${u.channel} ${u.api} ${u.member ?? "-"} ${u.allowed ?? "-"}`),
    )
    .toSorted();

describe("generic bridge forwarders and the page's calls of them", () => {
  it("gives one row per call in the page script, the check read only in its exact shapes", () => {
    const info = analyze({ "main.js": MAIN, "preload.js": PRELOAD, "renderer.js": RENDERER });
    expect(pageRows(info)).toEqual(EXPECTED);
    const forwards = info.contextBridge
      .filter((b) => b.forwards)
      .map(
        (b) =>
          `${b.api}.${b.member} ${b.forwards} ${b.allowed?.join("|") ?? "-"} ${b.prefix ?? "-"} ${b.guard ?? "-"}`,
      );
    expect(forwards).toEqual([
      "electron.send ipcRenderer.send app_onAction|ipcCall - -",
      "electron.sendIf ipcRenderer.send app_onAction|ipcCall - -",
      "electron.vs ipcRenderer.send - vscode: -",
      // a check that does not stop the call (a log, a warning, a value) is no guard
      "electron.logged ipcRenderer.send - - unknown",
      "electron.warned ipcRenderer.send - - unknown",
      "electron.noted ipcRenderer.send - - unknown",
      "electron.checked ipcRenderer.send - - unknown",
      "ipcRenderer.invoke ipcRenderer.invoke - - -",
    ]);
    // the channel is then sent and received by the files that do so
    const channel = info.ipcChannels.find((c) => c.channel === "renderer:rename-collection");
    expect(channel).toEqual({
      channel: "renderer:rename-collection",
      senders: ["renderer.js"],
      receivers: ["main.js"],
    });
  });

  it("gives the same rows in esbuild bundles, plain and minified", () => {
    for (const minify of [false, true])
      expect(pageRows(analyze(build(minify))), String(minify)).toEqual(EXPECTED);
  });

  it("gives no rows where two preloads expose the member differently", () => {
    const info = analyze({
      "main.js": MAIN,
      "preload.js": `const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("api", { call: (channel, ...a) => ipcRenderer.invoke(channel, ...a) });
`,
      "preload2.js": `const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("api", { call: (channel, ...a) => ipcRenderer.send(channel, ...a) });
`,
      "renderer.js": `window.api.call("x");\n`,
    });
    expect(pageRows(info)).toEqual([]);
    expect(info.limitations.map((l) => l.code)).toContain("bridge_forwarder_ambiguous");
  });
});
