import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildSync } from "esbuild";
import { afterAll, describe, expect, it } from "vitest";
import { analyzeJavaScriptTree, asarTree, type JsAppInfo } from "../src/javascript/app.js";
import { buildAsar } from "./fixtures/asar.js";

/**
 * Bridge objects built in another module (R3), modeled on Signal (`exposeInMainWorld(
 * "SignalContext", MinimalSignalContext)` imported), Bitwarden (`export const ipc = { auth,
 * platform }` of default exports), Heroic (`export default { ...Misc, ...Library }` of
 * namespaces) and a bridge returned by a function (`createApi(new IpcClient("x"))`). Each is read
 * as ES modules, as tsc's CommonJS, and bundled by esbuild (plain and minified). The expected
 * members are written from the fixture sources; nothing is run.
 */

const dir = mkdtempSync(join(tmpdir(), "hexvero-bridge-modules-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function analyze(files: Record<string, string>, type?: "module"): JsAppInfo {
  return analyzeJavaScriptTree(
    asarTree(
      buildAsar({
        "package.json": JSON.stringify({ name: "b", main: "main.js", ...(type ? { type } : {}) }),
        "main.js": "",
        ...files,
      }),
      "app.asar",
    ),
  );
}

function bundled(sources: Record<string, string>, minify: boolean): Record<string, string> {
  const src = mkdtempSync(join(dir, "src-"));
  for (const [name, text] of Object.entries(sources)) {
    mkdirSync(dirname(join(src, name)), { recursive: true });
    writeFileSync(join(src, name), text);
  }
  const outfile = join(src, "out.js");
  buildSync({
    entryPoints: [join(src, "preload.js")],
    bundle: true,
    minify,
    platform: "node",
    format: "cjs",
    external: ["electron"],
    outfile,
    logLevel: "silent",
  });
  return { "preload.js": readFileSync(outfile, "utf8") };
}

/** `api.member=channel` of every bridge row. */
const members = (info: JsAppInfo): string[] =>
  info.contextBridge.map((b) => `${b.api}.${b.member ?? "?"}=${b.channel ?? "-"}`).toSorted();
const codes = (info: JsAppInfo): string[] => info.limitations.map((l) => l.code);

const SIGNAL = {
  "preload.js": `import { contextBridge } from "electron";
import { MinimalSignalContext } from "./minimalContext";
contextBridge.exposeInMainWorld("SignalContext", MinimalSignalContext);
`,
  "minimalContext.js": `import { ipcRenderer } from "electron";
export const MinimalSignalContext = {
  getVersion: () => ipcRenderer.sendSync("version"),
  restartApp: () => ipcRenderer.send("restart"),
  platform: process.platform,
};
`,
};
const SIGNAL_MEMBERS = [
  "SignalContext.getVersion=version",
  "SignalContext.platform=-",
  "SignalContext.restartApp=restart",
];

const BITWARDEN = {
  "preload.js": `import { contextBridge } from "electron";
import { ipc } from "./preload.base";
contextBridge.exposeInMainWorld("ipc", ipc);
`,
  "preload.base.js": `import auth from "./platform/auth";
import platform from "./platform/platform";
export const ipc = { auth, platform };
`,
  "platform/auth.js": `import { ipcRenderer } from "electron";
export default {
  loginRequest: (alert) => ipcRenderer.invoke("loginRequest", { alert }),
};
`,
  "platform/platform.js": `import { ipcRenderer } from "electron";
export default {
  versions: { app: () => ipcRenderer.invoke("appVersion") },
  isDev: () => ipcRenderer.sendSync("isDev"),
};
`,
};
// a nested object literal is one member, as in a preload of its own; a named object is followed
const BITWARDEN_MEMBERS = [
  "ipc.auth.loginRequest=loginRequest",
  "ipc.platform.isDev=isDev",
  "ipc.platform.versions=appVersion",
];

const HEROIC = {
  "preload.js": `import { contextBridge } from "electron";
import api from "./api";
contextBridge.exposeInMainWorld("api", api);
`,
  "api.js": `import * as Misc from "./misc";
import * as Library from "./library";
export default { ...Misc, ...Library };
`,
  "ipc.js": `import { ipcRenderer } from "electron";
export const makeHandlerInvoker = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);
`,
  "misc.js": `import { ipcRenderer } from "electron";
export const clearCache = () => ipcRenderer.send("clearCache");
export function openExternalUrl(url) { ipcRenderer.send("openExternalUrl", url); }
`,
  "library.js": `import { makeHandlerInvoker } from "./ipc";
export const openDialog = makeHandlerInvoker("openDialog");
export const install = makeHandlerInvoker("install");
`,
};
const HEROIC_MEMBERS = [
  "api.clearCache=clearCache",
  "api.install=install",
  "api.openDialog=openDialog",
  "api.openExternalUrl=openExternalUrl",
];

describe("a bridge object of another module", () => {
  it("reads it in that module, as ES modules", () => {
    expect(members(analyze(SIGNAL, "module"))).toEqual(SIGNAL_MEMBERS);
    expect(members(analyze(BITWARDEN, "module"))).toEqual(BITWARDEN_MEMBERS);
    expect(members(analyze(HEROIC, "module"))).toEqual(HEROIC_MEMBERS);
    const signal = analyze(SIGNAL, "module");
    // the rows are where the members are written
    expect(signal.contextBridge.map((b) => `${b.file}:${b.line}`)).toEqual([
      "minimalContext.js:3",
      "minimalContext.js:4",
      "minimalContext.js:5",
    ]);
    expect(codes(signal)).not.toContain("context_bridge_members_unreadable");
  });

  it("reads it as tsc writes CommonJS", () => {
    const info = analyze({
      "preload.js": `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
const preload_base_1 = require("./preload.base");
electron_1.contextBridge.exposeInMainWorld("ipc", preload_base_1.ipc);
`,
      "preload.base.js": `"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ipc = void 0;
const auth_1 = __importDefault(require("./platform/auth"));
const platform_1 = __importDefault(require("./platform/platform"));
exports.ipc = { auth: auth_1.default, platform: platform_1.default };
`,
      "platform/auth.js": `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
exports.default = {
    loginRequest: (alert) => electron_1.ipcRenderer.invoke("loginRequest", { alert }),
};
`,
      "platform/platform.js": `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
exports.default = {
    versions: { app: () => electron_1.ipcRenderer.invoke("appVersion") },
    isDev: () => electron_1.ipcRenderer.sendSync("isDev"),
};
`,
    });
    expect(members(info)).toEqual(BITWARDEN_MEMBERS);
  });

  it("gives the same members in the esbuild bundle, plain and minified", () => {
    for (const minify of [false, true]) {
      expect(members(analyze(bundled(SIGNAL, minify))), `signal ${minify}`).toEqual(SIGNAL_MEMBERS);
      expect(members(analyze(bundled(BITWARDEN, minify))), `bitwarden ${minify}`).toEqual(
        BITWARDEN_MEMBERS,
      );
      // `import * as` is `var x_exports = {}; __export(x_exports, { k: () => k })` there
      expect(members(analyze(bundled(HEROIC, minify))), `heroic ${minify}`).toEqual(HEROIC_MEMBERS);
    }
  });

  it("reads a bridge a function of the file returns, the calls through a client made in place", () => {
    const info = analyze({
      "preload/ipc-client.js": `"use strict";
exports.IpcClient = void 0;
const electron_1 = require("electron");
class IpcClient {
    invoke(channel, payload) { return electron_1.ipcRenderer?.invoke(channel, payload); }
}
exports.IpcClient = IpcClient;
`,
      "preload.js": `"use strict";
const electron_1 = require("electron");
const ipc_client_1 = require("./preload/ipc-client");
function createApi(client) {
    return {
        isMac: process.platform === "darwin",
        listDevices: () => client.invoke("device:list"),
    };
}
electron_1.contextBridge.exposeInMainWorld("padwright", createApi(new ipc_client_1.IpcClient("padwright")));
`,
    });
    expect(members(info)).toEqual(["padwright.isMac=-", "padwright.listDevices=device:list"]);
  });

  it("does not read an object some module may change, and says why", () => {
    // a module that imports the object writes a member of it
    const written = analyze(
      {
        ...SIGNAL,
        "patch.js": `import { MinimalSignalContext } from "./minimalContext";
MinimalSignalContext.extra = () => 1;
`,
      },
      "module",
    );
    expect(members(written)).toEqual(["SignalContext.?=-"]);
    expect(codes(written)).toContain("context_bridge_module_unread");
    // the module writes it itself
    const own = analyze(
      {
        ...SIGNAL,
        "minimalContext.js": `${SIGNAL["minimalContext.js"]}MinimalSignalContext.extra = () => 1;\n`,
      },
      "module",
    );
    expect(members(own)).toEqual(["SignalContext.?=-"]);
    // a module that is not among the files
    const missing = analyze(
      {
        "preload.js": `import { contextBridge } from "electron";
import { api } from "./gone";
contextBridge.exposeInMainWorld("api", api);
`,
      },
      "module",
    );
    expect(members(missing)).toEqual(["api.?=-"]);
    expect(
      missing.limitations.find((l) => l.code === "context_bridge_module_unread")?.message,
    ).toContain('"./gone"');
  });

  it("keeps an unreadable part as one entry, and a function with two returns unread", () => {
    const spread = analyze(
      {
        "preload.js": `import { contextBridge } from "electron";
import { api } from "./api";
contextBridge.exposeInMainWorld("api", api);
`,
        "api.js": `import { ipcRenderer } from "electron";
export const api = { ping: () => ipcRenderer.send("ping"), ...extra() };
`,
      },
      "module",
    );
    expect(members(spread)).toEqual(["api.?=-", "api.ping=ping"]);
    const twice = analyze({
      "preload.js": `const { contextBridge, ipcRenderer } = require("electron");
function make(x) {
  if (x) return { a: () => ipcRenderer.send("a") };
  return { b: () => ipcRenderer.send("b") };
}
contextBridge.exposeInMainWorld("api", make(1));
`,
    });
    expect(members(twice)).toEqual(["api.?=-"]);
  });
});
