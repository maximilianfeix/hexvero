import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildSync } from "esbuild";
import { afterAll, describe, expect, it } from "vitest";
import { analyzeJavaScriptTree, asarTree, type JsAppInfo } from "../src/javascript/app.js";
import { interfaceMap } from "../src/javascript/interfaces.js";
import { buildAsar } from "./fixtures/asar.js";

/**
 * IPC wrappers that are classes or objects: a method that passes its parameter on, whole, as the
 * channel of an IPC call, called on an instance. The expected facts below are written from the
 * fixture sources; nothing of them is run.
 */

const dir = mkdtempSync(join(tmpdir(), "hexvero-wrappers-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function analyze(files: Record<string, string>): JsAppInfo {
  return analyzeJavaScriptTree(
    asarTree(
      buildAsar({
        "package.json": JSON.stringify({ name: "w", main: "main.js" }),
        ...files,
      }),
      "app.asar",
    ),
  );
}

/** Entry points bundled by esbuild into one file each, optionally minified. */
function bundled(
  sources: Record<string, string>,
  entries: string[],
  minify: boolean,
): Record<string, string> {
  const src = mkdtempSync(join(dir, "src-"));
  for (const [name, text] of Object.entries(sources)) {
    mkdirSync(dirname(join(src, name)), { recursive: true });
    writeFileSync(join(src, name), text);
  }
  const out: Record<string, string> = {};
  for (const entry of entries) {
    const outfile = join(src, "out", entry);
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
    out[entry.replace(/\.ts$/, ".js")] = readFileSync(outfile, "utf8");
  }
  return out;
}

/** `channel: file api wrapper` for every IPC row of the main process read through a wrapper. */
const wrapperEnds = (info: JsAppInfo): string[] =>
  info.modules
    .flatMap((m) =>
      m.ipc
        .filter((u) => u.via === "wrapper" && u.wrapper)
        .map((u) => `${u.channel} ${m.id} ${u.api} ${u.wrapper}`),
    )
    .toSorted();

const channelsOf = (info: JsAppInfo): Record<string, [string[], string[]]> =>
  Object.fromEntries(info.ipcChannels.map((c) => [c.channel, [c.senders, c.receivers]]));

// ---------------------------------------------------------------------------------------------
// A singleton manager, as Electron Fiddle 0.39 writes it (src/main/ipc.ts), compiled by tsc.

/** `src/ipc-events.ts` as tsc emits it for CommonJS: a string enum and a list of its members. */
const EVENTS_CJS = `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ipcMainEvents = exports.IpcEvents = void 0;
var IpcEvents;
(function (IpcEvents) {
    IpcEvents["GET_FILES"] = "GET_FILES";
    IpcEvents["GET_TEMPLATE"] = "GET_TEMPLATE";
    IpcEvents["PATH_EXISTS"] = "PATH_EXISTS";
    IpcEvents["SHOW_WINDOW"] = "SHOW_WINDOW";
    IpcEvents["NEVER_HANDLED"] = "NEVER_HANDLED";
})(IpcEvents || (exports.IpcEvents = IpcEvents = {}));
exports.ipcMainEvents = [IpcEvents.PATH_EXISTS];
`;

/** The manager: handle/handleOnce forward the channel; send writes to a webContents. */
const MANAGER_CJS = `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ipcMainManager = void 0;
const node_events_1 = require("node:events");
const electron_1 = require("electron");
const ipc_events_1 = require("../ipc-events");
class IpcMainManager extends node_events_1.EventEmitter {
    constructor() {
        super();
        this.readyWebContents = new WeakSet();
        ipc_events_1.ipcMainEvents.forEach((name) => {
            electron_1.ipcMain.removeAllListeners(name);
            electron_1.ipcMain.on(name, (...args) => this.emit(name, ...args));
        });
    }
    send(channel, args, target) {
        if (!target)
            return;
        target.send(channel, ...(args || []));
    }
    handle(channel, listener) {
        // there can be only one, so remove previous one first
        electron_1.ipcMain.removeHandler(channel);
        electron_1.ipcMain.handle(channel, listener);
    }
    handleOnce(channel, listener) {
        electron_1.ipcMain.handleOnce(channel, listener);
    }
}
exports.ipcMainManager = new IpcMainManager();
`;

const FILES_CJS = `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.setupFileListeners = setupFileListeners;
const ipc_events_1 = require("../ipc-events");
const ipc_1 = require("./ipc");
function setupFileListeners() {
    ipc_1.ipcMainManager.handle(ipc_events_1.IpcEvents.GET_FILES, async () => []);
    ipc_1.ipcMainManager.handleOnce(ipc_events_1.IpcEvents.GET_TEMPLATE, async () => "");
    // EventEmitter's own on(): a listener for what the constructor forwards, not a registration
    ipc_1.ipcMainManager.on(ipc_events_1.IpcEvents.PATH_EXISTS, (event) => { event.returnValue = false; });
    // send() is the manager's own method and writes to a webContents
    ipc_1.ipcMainManager.send(ipc_events_1.IpcEvents.SHOW_WINDOW);
}
`;

const MAIN_CJS = `"use strict";
const electron_1 = require("electron");
const files_1 = require("./main/files");
electron_1.app.whenReady().then(() => {
    (0, files_1.setupFileListeners)();
    new electron_1.BrowserWindow({ webPreferences: { preload: __dirname + "/preload.js" } });
});
`;

const PRELOAD_CJS = `"use strict";
const electron_1 = require("electron");
const ipc_events_1 = require("./ipc-events");
electron_1.contextBridge.exposeInMainWorld("ElectronFiddle", {
    getFiles: () => electron_1.ipcRenderer.invoke(ipc_events_1.IpcEvents.GET_FILES),
    getTemplate: () => electron_1.ipcRenderer.invoke(ipc_events_1.IpcEvents.GET_TEMPLATE),
    showWindow: () => electron_1.ipcRenderer.send(ipc_events_1.IpcEvents.SHOW_WINDOW),
    neverHandled: () => electron_1.ipcRenderer.invoke(ipc_events_1.IpcEvents.NEVER_HANDLED),
});
`;

const FIDDLE_CJS = {
  "ipc-events.js": EVENTS_CJS,
  "main/ipc.js": MANAGER_CJS,
  "main/files.js": FILES_CJS,
  "main.js": MAIN_CJS,
  "preload.js": PRELOAD_CJS,
};

/** The same app as tsc emits it for ES modules. */
const FIDDLE_ESM = {
  "ipc-events.js": `export var IpcEvents;
(function (IpcEvents) {
    IpcEvents["GET_FILES"] = "GET_FILES";
    IpcEvents["GET_TEMPLATE"] = "GET_TEMPLATE";
    IpcEvents["PATH_EXISTS"] = "PATH_EXISTS";
    IpcEvents["SHOW_WINDOW"] = "SHOW_WINDOW";
    IpcEvents["NEVER_HANDLED"] = "NEVER_HANDLED";
})(IpcEvents || (IpcEvents = {}));
export const ipcMainEvents = [IpcEvents.PATH_EXISTS];
`,
  "main/ipc.js": `import { EventEmitter } from "node:events";
import { ipcMain } from "electron";
import { ipcMainEvents } from "../ipc-events";
class IpcMainManager extends EventEmitter {
    readyWebContents = new WeakSet();
    constructor() {
        super();
        ipcMainEvents.forEach((name) => {
            ipcMain.removeAllListeners(name);
            ipcMain.on(name, (...args) => this.emit(name, ...args));
        });
    }
    send(channel, args, target) {
        if (!target)
            return;
        target.send(channel, ...(args || []));
    }
    handle(channel, listener) {
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, listener);
    }
    handleOnce(channel, listener) {
        ipcMain.handleOnce(channel, listener);
    }
}
export const ipcMainManager = new IpcMainManager();
`,
  "main/files.js": `import { IpcEvents } from "../ipc-events";
import { ipcMainManager } from "./ipc";
export function setupFileListeners() {
    ipcMainManager.handle(IpcEvents.GET_FILES, async () => []);
    ipcMainManager.handleOnce(IpcEvents.GET_TEMPLATE, async () => "");
    ipcMainManager.on(IpcEvents.PATH_EXISTS, (event) => { event.returnValue = false; });
    ipcMainManager.send(IpcEvents.SHOW_WINDOW);
}
`,
  "main.js": `import { app, BrowserWindow } from "electron";
import { setupFileListeners } from "./main/files";
app.whenReady().then(() => {
    setupFileListeners();
    new BrowserWindow({ webPreferences: { preload: __dirname + "/preload.js" } });
});
`,
  "preload.js": `import { contextBridge, ipcRenderer } from "electron";
import { IpcEvents } from "./ipc-events";
contextBridge.exposeInMainWorld("ElectronFiddle", {
    getFiles: () => ipcRenderer.invoke(IpcEvents.GET_FILES),
    getTemplate: () => ipcRenderer.invoke(IpcEvents.GET_TEMPLATE),
    showWindow: () => ipcRenderer.send(IpcEvents.SHOW_WINDOW),
    neverHandled: () => ipcRenderer.invoke(IpcEvents.NEVER_HANDLED),
});
`,
};

/**
 * The shape of Electron Fiddle's webpack 5 production build: numeric module keys, `i(id)` for
 * require, the exports object `n`, minified names reused in every module. Module 87296 also has
 * a class `l` of its own with a `handle` method that is no wrapper.
 */
const FIDDLE_WEBPACK = `(()=>{var e={57755(e,n){"use strict";var i;Object.defineProperty(n,"__esModule",{value:!0}),n.ipcMainEvents=n.IpcEvents=void 0,function(e){e.GET_FILES="GET_FILES",e.GET_TEMPLATE="GET_TEMPLATE",e.PATH_EXISTS="PATH_EXISTS",e.SHOW_WINDOW="SHOW_WINDOW",e.NEVER_HANDLED="NEVER_HANDLED"}(i||(n.IpcEvents=i={})),n.ipcMainEvents=[i.PATH_EXISTS]},76675(e,n,i){"use strict";Object.defineProperty(n,"__esModule",{value:!0}),n.ipcMainManager=void 0;const s=i(78474),t=i(84157),r=i(57755);class l extends s.EventEmitter{readyWebContents=new WeakSet;constructor(){super(),r.ipcMainEvents.forEach(e=>{t.ipcMain.removeAllListeners(e),t.ipcMain.on(e,(...n)=>this.emit(e,...n))})}send(e,n,i){i&&i.send(e,...n||[])}handle(e,n){t.ipcMain.removeHandler(e),t.ipcMain.handle(e,n)}handleOnce(e,n){t.ipcMain.handleOnce(e,n)}}n.ipcMainManager=new l},87296(e,n,i){"use strict";Object.defineProperty(n,"__esModule",{value:!0}),n.setupFileListeners=async function(){a.ipcMainManager.handle(c.IpcEvents.GET_FILES,(e,n)=>[]),a.ipcMainManager.handleOnce(c.IpcEvents.GET_TEMPLATE,e=>""),a.ipcMainManager.on(c.IpcEvents.PATH_EXISTS,e=>{}),a.ipcMainManager.send(c.IpcEvents.SHOW_WINDOW),o.handle("decoy:not-ipc")};const a=i(76675),c=i(57755);class l{handle(e){return e}}const o=new l},84157(e){"use strict";e.exports=require("electron")},78474(e){"use strict";e.exports=require("node:events")}},n={};function i(t){var s=n[t];if(void 0!==s)return s.exports;var o=n[t]={id:t,loaded:!1,exports:{}};return e[t](o,o.exports,i),o.loaded=!0,o.exports}(async function(){await(0,i(87296).setupFileListeners)();const{BrowserWindow:t}=i(84157);new t({webPreferences:{preload:__dirname+"/preload.js"}})})()})();
`;

/** label: the class's name, or the key a minified class is reached through. */
function expectFiddle(info: JsAppInfo, file: string, label: string): void {
  expect(wrapperEnds(info)).toEqual([
    `GET_FILES ${file} ipcMain.handle ${label}.handle`,
    `GET_TEMPLATE ${file} ipcMain.handleOnce ${label}.handleOnce`,
  ]);
  const got = channelsOf(info);
  expect(got["GET_FILES"]?.[1]).toEqual([file]);
  expect(got["GET_TEMPLATE"]?.[1]).toEqual([file]);
  // EventEmitter's on() and the manager's send() are no registrations of a channel
  expect(got["PATH_EXISTS"]?.[1] ?? []).not.toContain("main/files.js");
  expect(got["SHOW_WINDOW"]?.[1] ?? []).toEqual([]);
  expect(got["decoy:not-ipc"]).toBeUndefined();
  const rows = interfaceMap(info, info.limitations);
  const byMember = Object.fromEntries(rows.map((r) => [r.member, r]));
  expect(byMember["getFiles"]).toMatchObject({
    channel: "GET_FILES",
    direction: "to-main",
    link: "resolved",
    ends: [
      {
        file,
        api: "ipcMain.handle",
        via: "wrapper",
        wrapper: `${label}.handle`,
      },
    ],
  });
  expect(byMember["getTemplate"]).toMatchObject({
    channel: "GET_TEMPLATE",
    link: "resolved",
  });
  expect(byMember["neverHandled"]!.ends).toEqual([]);
}

describe("a singleton wrapper class, as Electron Fiddle writes it", () => {
  it("links the preload's members to the handlers registered across CommonJS modules", () => {
    expectFiddle(analyze(FIDDLE_CJS), "main/files.js", "IpcMainManager");
  });

  it("links them across ES modules", () => {
    expectFiddle(analyze(FIDDLE_ESM), "main/files.js", "IpcMainManager");
  });

  it("links them in esbuild bundles, plain and minified", () => {
    const entries = ["main.js", "preload.js"];
    const plain = analyze(bundled(FIDDLE_ESM, entries, false));
    expectFiddle(plain, "main.js", "IpcMainManager");
    // minified, the class has a one-letter name and no export key: that is what is shown
    const minified = analyze(bundled(FIDDLE_ESM, entries, true));
    const label = wrapperEnds(minified)[0]?.split(" ").at(-1)?.split(".")[0] ?? "";
    expect(label).toMatch(/^[\w$]{1,2}$/);
    expectFiddle(minified, "main.js", label);
  });

  it("links them in a minified webpack 5 bundle with numeric module keys", () => {
    const info = analyze({
      "main.js": FIDDLE_WEBPACK,
      "preload.js": PRELOAD_CJS,
      "ipc-events.js": EVENTS_CJS,
    });
    // the class is `l`: the export key it is reached through names it
    expectFiddle(info, "main.js", "ipcMainManager");
    // the constructor registers every channel of `ipcMainEvents` (module 57755) with ipcMain.on
    const forwarded = info.modules
      .find((m) => m.id === "main.js")!
      .ipc.filter((u) => u.api === "ipcMain.on" && u.channel);
    expect(forwarded.map((u) => [u.channel, u.via, u.resolution?.method])).toEqual([
      ["PATH_EXISTS", "resolved", "element"],
    ]);
  });

  it("links them in the same bundle as an older webpack writes it (arrow modules, wrapped callbacks)", () => {
    // webpack 5.94 (Electron Fiddle 0.38.0): `76675:(e,n,i)=>{…}` and `forEach((e=>{…}))`
    const older = FIDDLE_WEBPACK.replace(/(\d{5})\((e(?:,n(?:,i)?)?)\)\{/g, "$1:($2)=>{").replace(
      "forEach(e=>{t.ipcMain.removeAllListeners(e),t.ipcMain.on(e,(...n)=>this.emit(e,...n))})",
      "forEach((e=>{t.ipcMain.removeAllListeners(e),t.ipcMain.on(e,((...n)=>this.emit(e,...n)))}))",
    );
    expect(older).toContain("76675:(e,n,i)=>{");
    expect(older).toContain("forEach((e=>");
    const info = analyze({
      "main.js": older,
      "preload.js": PRELOAD_CJS,
      "ipc-events.js": EVENTS_CJS,
    });
    expectFiddle(info, "main.js", "ipcMainManager");
    const forwarded = info.modules
      .find((m) => m.id === "main.js")!
      .ipc.filter((u) => u.api === "ipcMain.on" && u.channel);
    expect(forwarded.map((u) => u.channel)).toEqual(["PATH_EXISTS"]);
  });
});

// ---------------------------------------------------------------------------------------------
// A router instance created in one module and passed to a function of another.

const ROUTER_APP: Record<string, string> = {
  "shared/ch.js": `const CH = Object.freeze({ LIST: "items:list", PING: "items:ping", SAVE: "items:save" });
const KINDS = ["csv", "json"];
const exportChannel = (kind) => \`export:\${kind}\`;
module.exports = { CH, KINDS, exportChannel };
`,
  "main/router.js": `const { ipcMain } = require("electron");
class Router {
  constructor(name) {
    this.name = name;
    this.registered = new Set();
  }
  handle(channel, fn) {
    this.registered.add(channel);
    ipcMain.handle(channel, async (_event, ...args) => fn(...args));
  }
  on(channel, fn) {
    this.registered.add(channel);
    ipcMain.on(channel, (event, ...args) => fn(event, ...args));
  }
  dispose() {
    for (const channel of this.registered) ipcMain.removeHandler(channel);
  }
}
module.exports = { Router };
`,
  "main/routes.js": `const { CH, KINDS, exportChannel } = require("../shared/ch");
function registerRoutes(router, cache) {
  router.handle(CH.LIST, async () => []);
  router.on(CH.PING, () => {});
  for (const kind of KINDS) router.handle(exportChannel(kind), async () => "");
  // set at run time only: a registration whose channel cannot be read
  router.handle(process.env.EXTRA_CHANNEL, async () => 0);
  // a Map, not a router: no channel
  cache.set("decoy:map", 1);
}
module.exports = { registerRoutes };
`,
  "main.js": `const { app } = require("electron");
const { Router } = require("./main/router");
const { registerRoutes } = require("./main/routes");
const router = new Router("app");
app.whenReady().then(() => registerRoutes(router, new Map()));
app.on("will-quit", () => router.dispose());
`,
  "preload.js": `const { contextBridge, ipcRenderer } = require("electron");
const { CH } = require("./shared/ch");
contextBridge.exposeInMainWorld("items", {
  list: () => ipcRenderer.invoke(CH.LIST),
  ping: () => ipcRenderer.send(CH.PING),
  save: (x) => ipcRenderer.invoke(CH.SAVE, x),
});
`,
};

function expectRouter(info: JsAppInfo, file: string, label: string, loop: boolean): void {
  expect(wrapperEnds(info)).toEqual(
    [
      `items:list ${file} ipcMain.handle ${label}.handle`,
      `items:ping ${file} ipcMain.on ${label}.on`,
      `null ${file} ipcMain.handle ${label}.handle`,
      ...(loop
        ? [
            `export:csv ${file} ipcMain.handle ${label}.handle`,
            `export:json ${file} ipcMain.handle ${label}.handle`,
          ]
        : [`null ${file} ipcMain.handle ${label}.handle`]),
    ].toSorted(),
  );
  const got = channelsOf(info);
  expect(got["items:list"]).toEqual([["preload.js"], [file]]);
  expect(got["items:ping"]).toEqual([["preload.js"], [file]]);
  // nothing registers items:save, and the Map is no router
  expect(got["items:save"]).toEqual([["preload.js"], []]);
  expect(got["decoy:map"]).toBeUndefined();
  // the run-time channel is named as a call without one
  const unresolved = info.limitations.find((l) => l.code === "ipc_channel_unresolved");
  expect(unresolved?.message).toContain(`ipcMain.handle at ${file}`);
}

describe("a router instance passed to another module's function", () => {
  it("reads the calls in the module that receives the router (CommonJS)", () => {
    expectRouter(analyze(ROUTER_APP), "main/routes.js", "Router", true);
  });

  it("reads them in an esbuild bundle, plain and minified", () => {
    const entries = ["main.js", "preload.js"];
    expectRouter(analyze(bundled(ROUTER_APP, entries, false)), "main.js", "Router", true);
    expectRouter(analyze(bundled(ROUTER_APP, entries, true)), "main.js", "Router", true);
  });
});

describe("an instance made in place for a parameter (holdout7: createApi(new IpcClient(…)))", () => {
  /** `preload/ipc-client.js` as tsc emits it: `ipcRenderer?.invoke(channel, payload)`. */
  const CLIENT = `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.IpcClient = void 0;
const electron_1 = require("electron");
class IpcClient {
    invoke(channel, payload) { return electron_1.ipcRenderer?.invoke(channel, payload); }
    send(channel, payload) { electron_1.ipcRenderer?.send(channel, payload); }
}
exports.IpcClient = IpcClient;
`;
  const PRELOAD = `"use strict";
const ipc_client_1 = require("./preload/ipc-client");
function createApi(client) {
    return { list: () => client.invoke("device:list"), open: (id) => client.send("flasher:open", id) };
}
const api = createApi(new ipc_client_1.IpcClient("padwright"));
`;
  it("reads `new m.C(…)` as one construction, not a call of a method C on `new m`", () => {
    const info = analyze({ "main.js": "", "preload/ipc-client.js": CLIENT, "preload.js": PRELOAD });
    expect(
      info.modules
        .flatMap((m) =>
          m.ipc.filter((u) => u.via === "wrapper").map((u) => `${m.id} ${u.channel} ${u.wrapper}`),
        )
        .toSorted(),
    ).toEqual([
      "preload.js device:list IpcClient.invoke",
      "preload.js flasher:open IpcClient.send",
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
// Forms in one file, and look-alikes that must give no channel.

/** An app of one main.js with the given code after its electron import. */
function one(main: string): JsAppInfo {
  return analyze({
    "main.js": `const { ipcMain, ipcRenderer, contextBridge } = require("electron");\n${main}`,
  });
}

/** `channel api wrapper` of the wrapper rows of one main.js. */
function ends(main: string): string[] {
  return wrapperEnds(one(main)).map((e) => e.replace(" main.js", ""));
}

/** A bundle-like file whose `a.router` is a property key defined by `x.router = …`. */
function keyed(second: string): string {
  return `
class Router { handle(channel, fn) { ipcMain.handle(channel, fn); } }
const a = load(1);
x.router = void 0;
x.router = new Router();
${second}
a.router.handle("key:router", f);
`;
}

describe("wrapper methods in one file", () => {
  it("follows this, a chain of methods that return this, new and an object literal", () => {
    expect(
      ends(`
class Hub {
  handle(channel, fn) { ipcMain.handle(channel, fn); return this; }
  listen(channel, fn) { ipcMain.on(channel, fn); return this; }
  start() { this.handle("hub:start", () => 1); }
}
new Hub().handle("hub:a", f).listen("hub:b", f);
const hub = new Hub();
hub.listen("hub:c", f);
const ipc = { answer(name, fn) { ipcMain.handle(name, fn); } };
ipc.answer("obj:a", f);
`),
    ).toEqual([
      "hub:a ipcMain.handle Hub.handle",
      "hub:b ipcMain.on Hub.listen",
      "hub:c ipcMain.on Hub.listen",
      "hub:start ipcMain.handle Hub.handle",
      "obj:a ipcMain.handle ipc.answer",
    ]);
  });

  it("reads the channel argument where the method forwards a later parameter", () => {
    expect(
      ends(`
class Reg { add(fn, channel) { ipcMain.on(channel, fn); } }
const reg = new Reg();
reg.add(() => {}, "reg:second");
`),
    ).toEqual(["reg:second ipcMain.on Reg.add"]);
  });

  it("gives no channel for methods that change or build the channel, or do not pass it on", () => {
    const info = one(`
class Prefixed {
  constructor(ns) { this.ns = ns; }
  handle(name, fn) { ipcMain.handle(this.ns + ":" + name, fn); }
}
class Reassigned { handle(channel, fn) { channel = "x:" + channel; ipcMain.handle(channel, fn); } }
class Shadowed { handle(channel, fn) { const ch = channel; { const channel = "fixed"; ipcMain.handle(channel, fn); } } }
class Store { handle(key, value) { this.map.set(key, value); } }
new Prefixed("p").handle("one", f);
new Reassigned().handle("two", f);
new Shadowed().handle("three", f);
new Store().handle("four", 1);
`);
    expect(wrapperEnds(info)).toEqual([]);
    const got = channelsOf(info);
    for (const name of ["one", "two", "x:two", "three", "four"]) expect(got[name]).toBeUndefined();
  });

  it("gives no channel for a receiver that cannot be traced to an instance", () => {
    const info = one(`
class Router { handle(channel, fn) { ipcMain.handle(channel, fn); } }
const router = new Router();
router.handle("ok:one", f);
// another object with a method of the same name
const other = new Map();
other.handle("no:map", f);
const plain = { handle(x) { return x; } };
plain.handle("no:plain");
// a name assigned twice: which instance is meant is not read
let maybe = new Router();
maybe = somethingElse();
maybe.handle("no:reassigned", f);
// a parameter whose only call site passes something else
function wire(r) { r.handle("no:param", f); }
wire(other);
// a global the file does not define
window.router.handle("no:global", f);
`);
    expect(wrapperEnds(info)).toEqual(["ok:one main.js ipcMain.handle Router.handle"]);
  });

  it("reads a property key of a bundle only when every definition of it says the same", () => {
    expect(ends(keyed(""))).toEqual(["key:router ipcMain.handle Router.handle"]);
    expect(ends(keyed("y.router = makeOther();"))).toEqual([]);
    expect(ends(keyed("const o = { router: new Map() };"))).toEqual([]);
  });

  it("reads a renderer-side wrapper and gives the bridge member its channel", () => {
    const info = analyze({
      "main.js": `const { ipcMain } = require("electron");
ipcMain.handle("items:list", () => []);
`,
      "preload.js": `const { contextBridge, ipcRenderer } = require("electron");
class Bridge {
  invoke(channel, ...args) { return ipcRenderer.invoke(channel, ...args); }
}
const bridge = new Bridge();
contextBridge.exposeInMainWorld("api", { list: () => bridge.invoke("items:list") });
`,
    });
    expect(wrapperEnds(info)).toEqual(["items:list preload.js ipcRenderer.invoke Bridge.invoke"]);
    const [row] = interfaceMap(info, info.limitations);
    expect(row).toMatchObject({
      member: "list",
      channel: "items:list",
      link: "direct",
    });
  });
});

/** A webpack module that defines an enum under the one-letter name `i`, then `rest`. */
const enumModule = (rest: string): string =>
  `(()=>{var e={1(e,n){var i;function(e){e.OPEN="win:open",e.CLOSE="win:close"}(i||(i={}));${rest}}}})();`;

describe("enums under a minifier's one-letter name", () => {
  it("reads them in the block that declares the name, when it means the enum everywhere there", () => {
    const info = analyze({
      "main.js": `const { ipcMain } = require("electron");\n${enumModule("ipcMain.on(i.OPEN,f)")}`,
    });
    expect(info.ipcChannels.map((c) => c.channel)).toEqual(["win:open"]);
  });

  it("does not read them where the name is bound to something else in the block", () => {
    for (const rest of [
      "ipcMain.on(i.OPEN,f);[1].forEach(i=>g(i))",
      'ipcMain.on(i.OPEN,f);i={OPEN:"other"}',
      "function h(i){ipcMain.on(i.OPEN,f)}",
    ]) {
      const info = analyze({
        "main.js": `const { ipcMain } = require("electron");\n${enumModule(rest)}`,
      });
      expect(info.ipcChannels.map((c) => c.channel)).toEqual([]);
    }
  });
});

describe("block scope of the names a wrapper call goes through", () => {
  const router = `class Router { handle(channel, fn) { ipcMain.handle(channel, fn); } }\n`;

  it("does not take an inner block's const for the outer name used outside the block", () => {
    for (const outer of ['const ipc = require("./other");', 'import { ipc } from "./other";'])
      for (const inner of ["const ipc = new Router();", "let ipc = new Router();"]) {
        const info = analyze({
          "other.js": "exports.ipc = { handle() {} };\n",
          "main.js": `const { ipcMain } = require("electron");\n${outer}\n${router}function setup() {
  {
    ${inner}
    ipc.handle("in:block", f);
  }
  ipc.handle("out:block", f);
}
`,
        });
        expect(wrapperEnds(info)).toEqual(["in:block main.js ipcMain.handle Router.handle"]);
      }
  });

  it("does not take the outer name for an inner block's const of the same name, at the top too", () => {
    const info = analyze({
      "main.js": `const { ipcMain } = require("electron");\n${router}const ipc = new Router();
ipc.handle("outer:top", f);
if (ready) {
  const ipc = new Map();
  ipc.handle("no:inner-map", f);
}
`,
    });
    expect(wrapperEnds(info)).toEqual(["outer:top main.js ipcMain.handle Router.handle"]);
  });

  it("does not take a pattern of an inner block for the name outside it, nor a var there", () => {
    const info = analyze({
      "main.js": `const { ipcMain } = require("electron");\n${router}x.ipc = new Router();
function setup(ipc) {
  if (ready) {
    const { ipc } = load(1);
    ipc.handle("in:pattern", f);
  }
  ipc.handle("out:param", f);
}
setup(other);
function loose() {
  if (ready) { var r = new Router(); }
  r.handle("var:in-block", f);
}
`,
    });
    // the var declared in a block is not followed (it is ambiguous where it is set)
    expect(wrapperEnds(info)).toEqual(["in:pattern main.js ipcMain.handle Router.handle"]);
  });
});
