import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildSync } from "esbuild";
import { afterAll, describe, expect, it } from "vitest";
import { analyzeJavaScriptTree, asarTree, type JsAppInfo } from "../src/javascript/app.js";
import { buildAsar } from "./fixtures/asar.js";

/**
 * Channel-forwarding functions of another module (R4), as real apps write them: Heroic
 * (`export function addHandler(channel, handler) { ipcMain.handle(channel, …) }`), Insomnia
 * (`export const ipcMainHandle = (channel, listener) => ipcMain.handle(channel, listener)`),
 * Rocket.Chat (`import { handle as handleOnMain } from "../ipc/main"`), GitHub Desktop
 * (`import * as ipcMain from "./ipc-main"`, a module of the app under Electron's name), and a
 * curried factory (`makeHandlerInvoker("openDialog")`). The expected rows are written from the
 * fixture sources; nothing is run.
 */

const dir = mkdtempSync(join(tmpdir(), "hexvero-forwarders-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function analyze(files: Record<string, string>, type?: "module"): JsAppInfo {
  return analyzeJavaScriptTree(
    asarTree(
      buildAsar({
        "package.json": JSON.stringify({ name: "f", main: "main.js", ...(type ? { type } : {}) }),
        ...files,
      }),
      "app.asar",
    ),
  );
}

function bundled(sources: Record<string, string>, entry: string, minify: boolean): string {
  const src = mkdtempSync(join(dir, "src-"));
  for (const [name, text] of Object.entries(sources)) {
    mkdirSync(dirname(join(src, name)), { recursive: true });
    writeFileSync(join(src, name), text);
  }
  const outfile = join(src, "out.js");
  buildSync({
    entryPoints: [join(src, entry)],
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

/** `channel api module wrapper` of every row with a channel. */
const rows = (info: JsAppInfo): string[] =>
  info.modules
    .flatMap((m) =>
      m.ipc
        .filter((u) => u.channel !== null && !u.api.startsWith("contextBridge."))
        .map((u) => `${u.channel} ${u.api} ${m.id}${u.wrapper ? ` ${u.wrapper}` : ""}`),
    )
    .toSorted();

const ESM = {
  "ipc/electron.js": `import { ipcMain } from "electron";
export const ipcMainHandle = (channel, listener) => ipcMain.handle(channel, listener);
`,
  "ipc/main.js": `import { ipcMain } from "electron";
export const handle = (channel, handler) => {
  ipcMain.handle(channel, async (_e, ...args) => handler(...args));
};
export function rewrite(ch, fn) { ch = "x:" + ch; ipcMain.handle(ch, fn); }
`,
  "ipc/heroic.js": `import { ipcMain } from "electron";
export function addHandler(channel, handler) {
  ipcMain.handle(channel, (e, ...a) => handler(e, ...a));
}
`,
  "main.js": `import { ipcMainHandle } from "./ipc/electron";
import { handle as handleOnMain, rewrite } from "./ipc/main";
import * as ipc from "./ipc/heroic";
import { addHandler } from "./ipc/heroic";
ipcMainHandle("renderer:rename-collection", () => 1);
handleOnMain("servers:fetch-info", async () => 2);
rewrite("never", () => 3);
ipc.addHandler("openDialog", () => 4);
addHandler("install", () => 5);
function local(addHandler) { addHandler("shadowed", () => 6); }
local(console.log);
`,
};

describe("channel-forwarding functions of another module", () => {
  it("gives a row at each call, named by the module and export (ES modules)", () => {
    expect(rows(analyze(ESM, "module"))).toEqual([
      "install ipcMain.handle main.js ipc/heroic.addHandler",
      "openDialog ipcMain.handle main.js ipc/heroic.addHandler",
      "renderer:rename-collection ipcMain.handle main.js ipc/electron.ipcMainHandle",
      "servers:fetch-info ipcMain.handle main.js ipc/main.handle",
    ]);
  });

  it("reads tsc's CommonJS: `exports.f = f`, `(0, m_1.f)(…)`, require patterns", () => {
    const info = analyze({
      "ipc.js": `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.addHandler = addHandler;
const electron_1 = require("electron");
function addHandler(channel, handler) {
    electron_1.ipcMain.handle(channel, (e, ...a) => handler(e, ...a));
}
`,
      "main.js": `"use strict";
const ipc_1 = require("./ipc");
const { addHandler: add } = require("./ipc");
(0, ipc_1.addHandler)("library:refresh", () => 1);
add("library:clear", () => 2);
require("./ipc").addHandler("library:open", () => 3);
`,
    });
    expect(rows(info)).toEqual([
      "library:clear ipcMain.handle main.js ipc.addHandler",
      "library:open ipcMain.handle main.js ipc.addHandler",
      "library:refresh ipcMain.handle main.js ipc.addHandler",
    ]);
  });

  it("reads a curried factory's calls as senders where they are made", () => {
    const info = analyze(
      {
        "main.js": "",
        "ipc.js": `import { ipcRenderer } from "electron";
export const makeHandlerInvoker = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);
`,
        "library.js": `import { makeHandlerInvoker } from "./ipc";
export const openDialog = makeHandlerInvoker("openDialog");
`,
      },
      "module",
    );
    expect(rows(info)).toEqual(["openDialog ipcRenderer.invoke library.js ipc.makeHandlerInvoker"]);
  });

  it("reads a forwarder of a module of the app named ipcMain at its calls (GitHub Desktop)", () => {
    const info = analyze({
      "ipc-main.js": `const electron = require("electron");
function handle(channel, listener) {
  electron.ipcMain.handle(channel, (event, ...args) => listener(event, ...args));
}
function on(name, listener) { emitter.on(name, listener); }
exports.handle = handle;
exports.on = on;
`,
      "main.js": `const ipcMain = require("./ipc-main");
ipcMain.handle("show-contextual-menu", async () => 1);
ipcMain.on("not-ipc", () => {});
`,
    });
    // `handle` is a forwarder of the module: its row replaces the direct one. The module's own
    // `on` forwards nothing; as it is no forwarder, the direct row of 0.9.9 stays (a module of the
    // app may as well hand Electron's object on: `export { ipcMain } from "electron"`)
    expect(rows(info)).toEqual([
      "not-ipc ipcMain.on main.js",
      "show-contextual-menu ipcMain.handle main.js ipc-main.handle",
    ]);
  });

  it("gives the same channels in an esbuild bundle, plain and minified (helpers in one file)", () => {
    for (const minify of [false, true]) {
      const out = bundled(ESM, "main.js", minify);
      const channels = analyze({ "main.js": out }).ipcChannels.map((c) => c.channel);
      expect(channels.toSorted(), String(minify)).toEqual([
        "install",
        "openDialog",
        "renderer:rename-collection",
        "servers:fetch-info",
      ]);
    }
  });
});
