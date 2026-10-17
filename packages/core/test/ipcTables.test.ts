import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildSync } from "esbuild";
import { afterAll, describe, expect, it } from "vitest";
import { compareReleases, Session } from "../src/index.js";
import { analyzeJavaScriptTree, asarTree, type JsAppInfo } from "../src/javascript/app.js";
import { interfaceMap } from "../src/javascript/interfaces.js";
import { buildAsar } from "./fixtures/asar.js";

/**
 * IPC that an application builds from data: bridge members and invoke senders made from a
 * channel table, receivers registered from a list of routes, ipcMain passed to a function or
 * method as an argument, and channel helpers inside the modules a bundler wraps. Every fixture
 * is read as written, bundled by esbuild, and bundled and minified; the expected facts are
 * written from the fixture sources. Nothing of them is run.
 */

const dir = mkdtempSync(join(tmpdir(), "hexvero-ipc-tables-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

type Build = "plain" | "bundled" | "minified";
const BUILDS: Build[] = ["plain", "bundled", "minified"];

/** The files of one build: the sources as they are, or each entry bundled into one file. */
function build(
  sources: Record<string, string>,
  entries: string[],
  how: Build,
): Record<string, string> {
  if (how === "plain") return sources;
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
      minify: how === "minified",
      platform: "node",
      format: "cjs",
      external: ["electron"],
      outfile,
      logLevel: "silent",
    });
    out[entry] = readFileSync(outfile, "utf8");
  }
  return out;
}

function analyze(files: Record<string, string>): JsAppInfo {
  return analyzeJavaScriptTree(
    asarTree(
      buildAsar({ "package.json": JSON.stringify({ name: "t", main: "main.js" }), ...files }),
      "app.asar",
    ),
  );
}

/** `channel api file` for every IPC row with a channel (contextBridge calls left out). */
const rows = (info: JsAppInfo): string[] =>
  info.modules
    .flatMap((m) =>
      m.ipc
        .filter((u) => u.channel !== null && !u.api.startsWith("contextBridge."))
        .map((u) => `${u.channel} ${u.api} ${m.id}`),
    )
    .toSorted();

/** `api.member channel` for every bridge member. */
const members = (info: JsAppInfo): string[] =>
  info.contextBridge.map((b) => `${b.api}.${b.member} ${b.channel}`).toSorted();

const unresolved = (info: JsAppInfo): number =>
  info.modules.flatMap((m) =>
    m.ipc.filter((u) => u.channel === null && !u.api.startsWith("contextBridge.")),
  ).length;

// ---------------------------------------------------------------------------------------------
// 1. Bridge members and invoke senders generated from a channel table

const PRELOAD_TABLES = `"use strict";
const { contextBridge, ipcRenderer } = require("electron");
// member -> channel
const CALLS = {
  listNotes: "notes:list",
  readNote: "notes:read",
};
function invokers(table) {
  return Object.fromEntries(
    Object.entries(table).map(([member, channel]) => [member, (...args) => ipcRenderer.invoke(channel, ...args)]),
  );
}
const SENDS = { closeWindow: "win:close", minimize: "win:min" };
const ASK = { getTheme: "theme:get", setTheme: "theme:set" };
const api = { version: 2, ...invokers(CALLS), ping: () => ipcRenderer.send("app:ping") };
for (const [name, channel] of Object.entries(SENDS)) api[name] = (...a) => ipcRenderer.send(channel, ...a);
Object.keys(ASK).forEach((key) => {
  api[key] = (...args) => ipcRenderer.invoke(ASK[key], ...args);
});
contextBridge.exposeInMainWorld("notes", api);
const LOOKUP = { find: "search:find" };
contextBridge.exposeInMainWorld(
  "search",
  Object.fromEntries(Object.entries(LOOKUP).map(([m, ch]) => [m, (q) => ipcRenderer.invoke(ch, q)])),
);
`;

describe("bridge members and senders built from a channel table", () => {
  for (const how of BUILDS)
    it(`reads a member per key and a sender per channel (${how})`, () => {
      const info = analyze(
        build({ "main.js": "", "preload.js": PRELOAD_TABLES }, ["main.js", "preload.js"], how),
      );
      expect(members(info)).toEqual([
        "notes.closeWindow win:close",
        "notes.getTheme theme:get",
        "notes.listNotes notes:list",
        "notes.minimize win:min",
        "notes.ping app:ping",
        "notes.readNote notes:read",
        "notes.setTheme theme:set",
        "notes.version null",
        "search.find search:find",
      ]);
      expect(rows(info)).toEqual([
        "app:ping ipcRenderer.send preload.js",
        "notes:list ipcRenderer.invoke preload.js",
        "notes:read ipcRenderer.invoke preload.js",
        "search:find ipcRenderer.invoke preload.js",
        "theme:get ipcRenderer.invoke preload.js",
        "theme:set ipcRenderer.invoke preload.js",
        "win:close ipcRenderer.send preload.js",
        "win:min ipcRenderer.send preload.js",
      ]);
      expect(unresolved(info)).toBe(0);
      expect(info.limitations.map((l) => l.code)).not.toContain(
        "context_bridge_members_unreadable",
      );
    });

  it("takes no write to another binding of the object's name for a member", () => {
    // as a minifier writes Sentry's preload: `e` is a parameter of the enum IIFEs and a const
    const info = analyze({
      "main.js": "",
      "preload.js": `const electron=require("electron");var M,C;(function(e){e[e.Classic=1]="Classic"})(M||(M={})),function(e){e.EVENT="s.event"}(C||(C={}));{const e={sendEvent:t=>electron.ipcRenderer.send(C.EVENT,t)};electron.contextBridge.exposeInMainWorld("__S__",e)}`,
    });
    expect(members(info)).toEqual(["__S__.sendEvent null"]);
  });

  it("gives an unreadable entry, never a guessed member or channel, for anything else", () => {
    const info = analyze({
      "main.js": "",
      // the table is written again after it is declared
      "preload-a.js": `const { contextBridge, ipcRenderer } = require("electron");
const CALLS = { listNotes: "notes:list" };
CALLS.extra = "notes:extra";
const api = Object.fromEntries(Object.entries(CALLS).map(([m, ch]) => [m, (...a) => ipcRenderer.invoke(ch, ...a)]));
contextBridge.exposeInMainWorld("a", api);`,
      // the member does something before the call: not exactly a forwarding call
      "preload-b.js": `const { contextBridge, ipcRenderer } = require("electron");
const CALLS = { listNotes: "notes:list" };
const api = Object.fromEntries(Object.entries(CALLS).map(([m, ch]) => [m, (...a) => { log(m); return ipcRenderer.invoke(ch, ...a); }]));
contextBridge.exposeInMainWorld("b", api);`,
      // a loop over keys only known at run time, and a channel built from one
      "preload-c.js": `const { contextBridge, ipcRenderer } = require("electron");
const api = {};
for (const k of Object.keys(window.extra)) api[k] = () => ipcRenderer.invoke(k);
contextBridge.exposeInMainWorld("c", api);`,
      // a spread of a call that returns something that is not a table of forwarding calls
      "preload-d.js": `const { contextBridge, ipcRenderer } = require("electron");
const CALLS = { listNotes: "notes:list" };
const wrap = (t) => Object.fromEntries(Object.entries(t).map(([m, ch]) => [m, (...a) => fetch(ch, ...a)]));
contextBridge.exposeInMainWorld("d", { ...wrap(CALLS) });`,
    });
    expect(members(info)).toEqual(["a.null null", "b.null null", "c.null null", "d.null null"]);
    // the senders of a and c stay without a channel; b's are read (its channels are known)
    expect(rows(info).filter((r) => r.includes("preload-a") || r.includes("preload-c"))).toEqual(
      [],
    );
    expect(info.limitations.map((l) => l.code)).toContain("context_bridge_members_unreadable");
    expect(info.limitations.map((l) => l.code)).toContain("ipc_channel_unresolved");
  });
});

// ---------------------------------------------------------------------------------------------
// 2. Receivers registered from a list of routes

const CHANNELS = `"use strict";
const NS = "notes:";
const C = Object.freeze({ LIST: NS + "list", SAVE: NS + "save", PING: "app:ping", DROP: "notes:drop" });
module.exports = { C };
`;

const ROUTES = `"use strict";
const { ipcMain } = require("electron");
const { C } = require("./channels");
// kind is the ipcMain method to register with
const ROUTES = [
  { channel: C.LIST, kind: "handle", fn: () => [] },
  { channel: C.SAVE, kind: "handleOnce", fn: (_e, n) => n },
  { channel: C.PING, kind: "on", fn: () => {} },
  { channel: "notes:watch", kind: "once", fn: () => {} },
];
function start() {
  for (const route of ROUTES) ipcMain[route.kind](route.channel, route.fn);
}
const PLAIN = [{ channel: C.DROP, fn: () => 1 }, { channel: "notes:undo", fn: () => 2 }];
PLAIN.forEach((r) => ipcMain.handle(r.channel, r.fn));
// a method that is not one of ipcMain's registrations: the channel, but not a receiver
const ODD = [{ channel: "odd:a", kind: "removeHandler" }];
for (const r of ODD) ipcMain[r.kind](r.channel, () => 1);
module.exports = { start };
`;

describe("receivers registered from a list of routes", () => {
  for (const how of BUILDS)
    it(`reads one receiver per element, with its kind as the method (${how})`, () => {
      const info = analyze(
        build(
          {
            "main.js": 'require("./routes").start();\n',
            "routes.js": ROUTES,
            "channels.js": CHANNELS,
          },
          ["main.js"],
          how,
        ),
      );
      const file = how === "plain" ? "routes.js" : "main.js";
      expect(rows(info)).toEqual(
        [
          `app:ping ipcMain.on ${file}`,
          `notes:drop ipcMain.handle ${file}`,
          `notes:list ipcMain.handle ${file}`,
          `notes:save ipcMain.handleOnce ${file}`,
          `notes:undo ipcMain.handle ${file}`,
          `notes:watch ipcMain.once ${file}`,
          `odd:a ipcMain.[unknown] ${file}`,
        ].toSorted(),
      );
      expect(unresolved(info)).toBe(0);
      // the call whose method is not read is no end of the channel
      expect(info.ipcChannels.find((c) => c.channel === "odd:a")).toEqual({
        channel: "odd:a",
        senders: [],
        receivers: [],
      });
      expect(info.ipcChannels.find((c) => c.channel === "notes:list")?.receivers).toEqual([file]);
    });

  it("leaves a list that may change or has other elements unresolved", () => {
    const info = analyze({
      "main.js": `const { ipcMain } = require("electron");
const A = [{ channel: "a:one", kind: "handle", fn: () => 1 }];
A.push({ channel: "a:two", kind: "on", fn: () => 2 });
for (const r of A) ipcMain[r.kind](r.channel, r.fn);
const BASE = [{ channel: "b:one", kind: "handle", fn: () => 1 }];
const B = [...BASE, { channel: "b:two", kind: "handle", fn: () => 2 }];
for (const r of B) ipcMain[r.kind](r.channel, r.fn);
const C = [{ channel: "c:one", kind: "handle", fn: () => 1 }];
C[0] = { channel: "c:other", kind: "on" };
for (const r of C) ipcMain[r.kind](r.channel, r.fn);
const D = [["d:one", "handle"]];
for (const r of D) ipcMain[r.kind](r.channel, () => 1);
const E = [{ channel: process.env.CH, kind: "handle", fn: () => 1 }];
E.forEach((r) => ipcMain.handle(r.channel, r.fn));
`,
    });
    expect(rows(info)).toEqual([]);
    expect(unresolved(info)).toBe(5);
    expect(info.limitations.map((l) => l.code)).toContain("ipc_channel_unresolved");
  });

  it("reads a table entry built from a constant for other modules", () => {
    const info = analyze({
      "main.js":
        'const { ipcMain } = require("electron");\nconst { C } = require("./channels");\nipcMain.handle(C.LIST, () => 1);\nipcMain.on(C.PING, () => 1);\n',
      "channels.js": CHANNELS,
    });
    expect(rows(info)).toEqual([
      "app:ping ipcMain.on main.js",
      "notes:list ipcMain.handle main.js",
    ]);
  });

  it("gives an unread method no end in the interface map", () => {
    const info = analyze({
      "main.js": 'require("./routes").start();\n',
      "routes.js": ROUTES,
      "channels.js": CHANNELS,
      "preload.js":
        'const { contextBridge, ipcRenderer } = require("electron");\ncontextBridge.exposeInMainWorld("x", { odd: () => ipcRenderer.invoke("odd:a"), list: () => ipcRenderer.invoke("notes:list") });\n',
    });
    const map = interfaceMap(info, info.limitations);
    expect(map.find((r) => r.member === "odd")?.endsTotal).toBe(0);
    expect(map.find((r) => r.member === "list")?.endsTotal).toBe(1);
  });
});

describe("lists longer than the evaluation reads", () => {
  it("keeps the call without a channel as well when not every element is read", () => {
    const routes = Array.from({ length: 300 }, (_, i) => `{ channel: "r:${i}" }`).join(", ");
    const info = analyze({
      "main.js": `const { ipcMain } = require("electron");\nconst R = [${routes}];\nfor (const r of R) ipcMain.handle(r.channel, () => 1);\nfor (const r of R) ipcMain[r.kind](r.channel, () => 1);\n`,
    });
    // the rows of the elements read, the loop's call without a channel, and the computed call
    // not read at all (its rounds would not be all there are)
    expect(rows(info).length).toBe(256);
    expect(unresolved(info)).toBe(2);
  });
});

describe("a call whose method is not read, in a release comparison", () => {
  it("is placed as neither the sender nor the receiver of its channel", async () => {
    const dirOf = mkdtempSync(join(dir, "cmp-"));
    const write = (name: string, odd: boolean): string => {
      const file = join(dirOf, name);
      writeFileSync(
        file,
        buildAsar({
          "package.json": JSON.stringify({ name: "t", main: "main.js" }),
          "main.js": `const { ipcMain } = require("electron");\nipcMain.handle("keep:a", () => 1);\n${
            odd
              ? 'for (const r of [{ channel: "odd:a", kind: "removeHandler" }]) ipcMain[r.kind](r.channel, () => 1);\n'
              : ""
          }`,
        }),
      );
      return file;
    };
    const session = new Session();
    const a = await session.open(write("v1.asar", false));
    const b = await session.open(write("v2.asar", true));
    const r = await compareReleases(session, a.id, b.id);
    const channel = r.changes.find(
      (c) => c.collection === "ipcChannels" && c.key.includes("odd:a"),
    );
    expect(channel?.change).toBe("added");
    expect(channel?.where.some((w) => w.role === "receiver" || w.role === "sender")).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// 3. ipcMain passed as an argument

const SETTINGS = `"use strict";
const { C } = require("./channels");
class SettingsService {
  constructor() { this.data = {}; }
  /** Attaches the channels to ipcMain (passed in, so tests can hand in a fake). */
  register(ipc) {
    ipc.handle(C.GET, () => this.data);
    ipc.handle(C.SET, (_e, p) => Object.assign(this.data, p));
  }
}
module.exports = new SettingsService();
`;
const HEALTH = `"use strict";
function attach(ipc, name) {
  ipc.on("health:ping", () => name);
}
module.exports = { attach };
`;
const PARAM_SOURCES = {
  "lib/channels.js": 'module.exports = { C: { GET: "cfg:get", SET: "cfg:set" } };\n',
  "lib/settings.js": SETTINGS,
  "lib/health.js": HEALTH,
  "main.js": `"use strict";
const { app, ipcMain } = require("electron");
const settings = require("./lib/settings");
const { attach } = require("./lib/health");
function local(bus) { bus.handle("local:echo", (_e, x) => x); }
app.whenReady().then(() => {
  settings.register(ipcMain);
  attach(ipcMain, "main");
  local(ipcMain);
});
`,
  "preload.js": `"use strict";
const { ipcRenderer } = require("electron");
function wire(r) { r.send("ui:ready", 1); }
wire(ipcRenderer);
`,
};

describe("ipcMain passed to a function or method", () => {
  for (const how of BUILDS)
    it(`reads the calls on the parameter when every call site passes ipcMain (${how})`, () => {
      const info = analyze(build(PARAM_SOURCES, ["main.js", "preload.js"], how));
      const at = (file: string): string => (how === "plain" ? file : "main.js");
      expect(rows(info)).toEqual(
        [
          `cfg:get ipcMain.handle ${at("lib/settings.js")}`,
          `cfg:set ipcMain.handle ${at("lib/settings.js")}`,
          `health:ping ipcMain.on ${at("lib/health.js")}`,
          "local:echo ipcMain.handle main.js",
          "ui:ready ipcRenderer.send preload.js",
        ].toSorted(),
      );
      const settings = info.modules.flatMap((m) => m.ipc).find((u) => u.channel === "cfg:get");
      expect(settings).toMatchObject({ via: "parameter" });
      if (how !== "minified") expect(settings?.wrapper).toBe("SettingsService.register");
    });

  it("reads none when any call site passes another object", () => {
    const info = analyze({
      ...PARAM_SOURCES,
      // one more module calls each with something else
      "lib/other.js":
        'const settings = require("./settings");\nconst { attach } = require("./health");\nsettings.register({ handle() {} });\nattach(makeBus(), "x");\n',
      "main.js": `${PARAM_SOURCES["main.js"]}require("./lib/other");\nlocal(new Map());\n`,
      "preload.js": `${PARAM_SOURCES["preload.js"]}wire(window.fake);\n`,
    });
    expect(rows(info)).toEqual([]);
  });

  it("follows a parameter that is handed on to another function", () => {
    const info = analyze({
      "main.js": `const { ipcMain } = require("electron");
function attach(ipc) { ipc.handle("deep:x", () => 1); }
function setup(bus) { attach(bus); }
setup(ipcMain);
`,
    });
    expect(rows(info)).toEqual(["deep:x ipcMain.handle main.js"]);
  });

  it("reads a bundle with hundreds of such candidates and reused short names within its budget", () => {
    // 300 module bodies, each with its own helper `n` called 10 times with something else, as a
    // minifier reuses names; and one function that every call site passes ipcMain to
    const modules = Array.from(
      { length: 300 },
      (_, i) => `(function () { function n(e) { e.on("c${i}", f); } ${"n(z);".repeat(10)} })();`,
    ).join("\n");
    const info = analyze({
      "main.js": `const { ipcMain } = require("electron");\n${modules}\nfunction q(ipc) { ipc.handle("q:x", f); }\nq(ipcMain);\n`,
    });
    expect(rows(info)).toEqual(["q:x ipcMain.handle main.js"]);
    expect(info.limitations.map((l) => l.code)).not.toContain("ipc_wrappers_capped");
  });

  it("decides a function of one file there when calls of other modules' functions are cut", () => {
    // more calls of another module's exports than the cross-file stage reads (256)
    const info = analyze({
      "lib/settings.js": SETTINGS,
      "lib/channels.js": PARAM_SOURCES["lib/channels.js"],
      "main.js": `const { ipcMain } = require("electron");\nconst settings = require("./lib/settings");\nfunction local(bus) { bus.handle("local:x", f); }\nlocal(ipcMain);\n${"settings.register(ipcMain);\n".repeat(300)}`,
    });
    expect(rows(info)).toEqual([
      "cfg:get ipcMain.handle lib/settings.js",
      "cfg:set ipcMain.handle lib/settings.js",
      "local:x ipcMain.handle main.js",
    ]);
  });

  it("reads none for a function nobody calls, or a parameter written in the body", () => {
    const info = analyze({
      "main.js": `const { ipcMain } = require("electron");
function never(ipc) { ipc.handle("never:x", () => 1); }
function rewritten(ipc) { ipc = makeBus(); ipc.handle("rw:x", () => 1); }
rewritten(ipcMain);
module.exports = { never };
`,
    });
    expect(rows(info)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// 4. A channel helper inside a module a bundler wraps

const GUARDED = `"use strict";
const { ipcMain } = require("electron");
const CH = { SAVE: "doc:save", LOAD: "doc:load" };
/** Registers fn so that the renderer gets { ok, value } or { ok: false }, never a rejection. */
function guarded(channel, fn) {
  ipcMain.handle(channel, async (_e, ...a) => {
    try { return { ok: true, value: await fn(...a) }; } catch { return { ok: false }; }
  });
}
function install() {
  guarded(CH.SAVE, (d) => d);
  guarded(CH.LOAD, () => 1);
}
module.exports = { install };
`;

describe("a channel helper of a module a bundler wraps", () => {
  for (const how of BUILDS)
    it(`reads its calls as receivers (${how})`, () => {
      const info = analyze(
        build(
          { "main.js": 'require("./lib/routes").install();\n', "lib/routes.js": GUARDED },
          ["main.js"],
          how,
        ),
      );
      const file = how === "plain" ? "lib/routes.js" : "main.js";
      expect(rows(info)).toEqual([
        `doc:load ipcMain.handle ${file}`,
        `doc:save ipcMain.handle ${file}`,
      ]);
    });

  it("does not take a call of another function of the same name for the helper", () => {
    const info = analyze({
      "main.js": `const { ipcMain } = require("electron");
function one() {
  function reg(channel) { ipcMain.on(channel, () => 1); }
  reg("one:a");
}
function two() {
  const reg = (x) => x;
  reg("two:not-ipc");
}
one(); two();
`,
    });
    expect(rows(info)).toEqual(["one:a ipcMain.on main.js"]);
  });
});
