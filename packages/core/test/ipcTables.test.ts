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

// Issue #199: contextBridge copies the object when it is exposed. Members written after the
// call, members of an object the name no longer holds, and a second exposure of one object.
const PRELOAD_AFTER = `"use strict";
const { contextBridge, ipcRenderer } = require("electron");
const CH = { open: "doc:open", save: "doc:save" };
const api = { ping: () => ipcRenderer.send("app:ping") };
contextBridge.exposeInMainWorld("api", api);
for (const [k, ch] of Object.entries(CH)) api[k] = (...a) => ipcRenderer.invoke(ch, ...a);
api["late"] = () => ipcRenderer.invoke("late:x");
api.later = () => ipcRenderer.invoke("later:x");
let b = {};
for (const [k, ch] of Object.entries(CH)) b[k] = (...a) => ipcRenderer.invoke(ch, ...a);
b = { only: () => ipcRenderer.invoke("only:one") };
contextBridge.exposeInMainWorld("b", b);
let c = {};
if (globalThis.flag) c = { maybe: () => ipcRenderer.invoke("maybe:x") };
contextBridge.exposeInMainWorld("c", c);
const d = {};
ipcRenderer.on("ready", () => {
  d.onReady = () => ipcRenderer.invoke("ready:x");
});
contextBridge.exposeInMainWorld("d", d);
const e = {};
e.one = () => ipcRenderer.invoke("e:one");
contextBridge.exposeInMainWorld("first", e);
e.two = () => ipcRenderer.invoke("e:two");
contextBridge.exposeInMainWorld("second", e);
`;

describe("members written after the exposure (#199)", () => {
  for (const how of BUILDS)
    it(`are not exposed; an object that may be another one is unreadable (${how})`, () => {
      const info = analyze(
        build({ "main.js": "", "preload.js": PRELOAD_AFTER }, ["main.js", "preload.js"], how),
      );
      const got = members(info);
      // never a member that is not exposed
      for (const wrong of [
        "api.open",
        "api.save",
        "api.late",
        "api.later",
        "b.open",
        "b.save",
        "c.maybe",
        "d.onReady",
        "first.two",
      ])
        expect(
          got.some((m) => m.startsWith(`${wrong} `)),
          wrong,
        ).toBe(false);
      expect(got).toEqual(
        expect.arrayContaining([
          "api.ping app:ping",
          // the conditional object and the write in a callback: one unreadable entry each
          "c.null null",
          "d.null null",
          "first.one e:one",
          "second.one e:one",
          "second.two e:two",
        ]),
      );
      // the object the last unconditional write gives `b`
      expect(got.filter((m) => m.startsWith("b."))).toEqual(["b.only only:one"]);
      expect(got.filter((m) => m.startsWith("api."))).toEqual(["api.ping app:ping"]);
    });
});

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

describe("hostile input stays bounded", () => {
  it("charges every `api[…] =` occurrence before reading it, and says the inventory is cut", () => {
    // 100 statements, each 600 `api[` deep: walking each bracket again would be quadratic
    const one = `${"api[".repeat(600)}0${"]".repeat(600)} = 1;`;
    const info = analyze({
      "main.js": "",
      "preload.js": `const { contextBridge } = require("electron");\nconst api = {};\n${Array(100).fill(one).join("\n")}\ncontextBridge.exposeInMainWorld("x", api);\n`,
    });
    expect(info.contextBridge.length).toBeLessThan(100);
    expect(info.limitations.map((l) => l.code)).toContain("context_bridge_truncated");
  });

  it("reads a bounded number of calls with a computed method per file, the rest unresolved", () => {
    const loops = Array.from(
      { length: 300 },
      (_, i) => `for (const r of R) ipcMain[r.kind](r.channel, f${i});`,
    ).join("\n");
    const info = analyze({
      "main.js": `const { ipcMain } = require("electron");\nconst R = [{ channel: "r:a", kind: "handle" }, { channel: "r:b", kind: "on" }];\n${loops}\n`,
    });
    const ipc = info.modules.flatMap((m) => m.ipc);
    // 256 calls read, two rows each; the 44 after them without a channel, and said why
    expect(ipc.filter((u) => u.channel !== null).length).toBe(512);
    const unread = ipc.filter((u) => u.channel === null);
    expect(unread.length).toBe(44);
    expect(
      unread.every((u) => u.api === "ipcMain.[unknown]" && /computed method/.test(u.reason ?? "")),
    ).toBe(true);
    expect(info.limitations.map((l) => l.code)).toContain("ipc_channel_unresolved");
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

// ---------------------------------------------------------------------------------------------
// Review findings (R7 on 06bbc5d and 482fcc6): each reads as an unreadable entry or an
// unresolved row, or as 0.9.8 read it, never as a guessed member, channel or receiver.

const PRE = 'const { contextBridge, ipcRenderer } = require("electron");\n';
const FORWARD =
  "Object.fromEntries(Object.entries(T).map(([m, c]) => [m, (...x) => ipcRenderer.invoke(c, ...x)]))";
const preload = (body: string): JsAppInfo => analyze({ "main.js": "", "preload.js": PRE + body });
const mainOnly = (body: string): JsAppInfo =>
  analyze({ "main.js": `const { ipcMain } = require("electron");\n${body}` });
const codes = (info: JsAppInfo): string[] => info.limitations.map((l) => l.code);

describe("review: budgets of the step-by-step bridge members", () => {
  it("does not charge writes to other bindings of a short name before the scope says so", () => {
    // as a minifier writes 300 helpers that all name their parameter `e`
    const helpers = Array.from(
      { length: 300 },
      (_, i) => `function f${i}(e,t){e[t]=${i};return e}`,
    ).join("");
    const info = preload(
      `${helpers}\nconst T = { x: "t:x", y: "t:y" };\nconst e = {};\nfor (const [k, c] of Object.entries(T)) e[k] = () => ipcRenderer.invoke(c);\ncontextBridge.exposeInMainWorld("api", e);\n`,
    );
    expect(members(info)).toEqual(["api.x t:x", "api.y t:y"]);
    expect(codes(info)).not.toContain("context_bridge_truncated");
  });

  it("does not cut real members after thousands of unrelated `e.k = …` writes", () => {
    const helpers = Array.from(
      { length: 10_000 },
      (_, i) => `function g${i}(e){e.k${i}=${i};}`,
    ).join("");
    const info = preload(
      `${helpers}\nconst e = {};\ne.a = () => ipcRenderer.invoke("d:a");\ncontextBridge.exposeInMainWorld("api", e);\n`,
    );
    expect(members(info)).toEqual(["api.a d:a"]);
    expect(codes(info)).not.toContain("context_bridge_truncated");
  });
});

describe("review: tables and lists that may change", () => {
  for (const [name, write] of [
    ["delete T.b", "delete T.b;"],
    ["delete T[k]", 'delete T["b"];'],
    ["Object.defineProperty", 'Object.defineProperty(T, "c", { value: "t:c", enumerable: true });'],
  ] as const)
    it(`reads no member or channel after ${name}`, () => {
      const info = preload(
        `const T = { a: "t:a", b: "t:b" };\n${write}\ncontextBridge.exposeInMainWorld("x", ${FORWARD});\n`,
      );
      expect(members(info)).toEqual(["x.null null"]);
      expect(rows(info)).toEqual([]);
      expect(codes(info)).toContain("ipc_channel_unresolved");
    });

  // what the evaluation cannot follow makes the members built from the table unreadable, and
  // the senders too: the callback runs over the table as it is then, which may not be as written
  // (#198, RA's probes D and K; 0.9.8 read the senders from the table as written)
  for (const [name, write] of [
    ["an alias write", 'const U = T; U.c = "t:c";'],
    ["a function that writes its parameter", 'function more(t) { t.c = "t:c"; }\nmore(T);'],
    ["a call of a function that is not read", "register(T);"],
  ] as const)
    it(`reads no member and no sender after ${name}`, () => {
      const info = preload(
        `const T = { a: "t:a", b: "t:b" };\n${write}\ncontextBridge.exposeInMainWorld("x", ${FORWARD});\n`,
      );
      expect(members(info)).toEqual(["x.null null"]);
      expect(rows(info)).toEqual([]);
      expect(codes(info)).toContain("ipc_channel_unresolved");
    });

  it("reads no channel when the function that builds the members writes the table", () => {
    const info = preload(
      `const A = { a: "t:a" };\nfunction invokers(t) { t.z = "t:z"; return Object.fromEntries(Object.entries(t).map(([m, c]) => [m, (...x) => ipcRenderer.invoke(c, ...x)])); }\ncontextBridge.exposeInMainWorld("x", { ...invokers(A) });\n`,
    );
    expect(rows(info)).toEqual([]);
    expect(codes(info)).toContain("ipc_channel_unresolved");
  });

  for (const [name, write] of [
    ["an element's member", 'R[0].channel = "r:changed";'],
    ["the loop variable's member", 'for (const r of R) r.channel = "x:" + r.channel;'],
    ["a forEach parameter's member", 'R.forEach((r) => { r.kind = "on"; });'],
  ] as const)
    it(`leaves a route list unresolved after a write to ${name}`, () => {
      const info = mainOnly(
        `const R = [{ channel: "r:a", kind: "handle" }];\n${write}\nfor (const r of R) ipcMain[r.kind](r.channel, () => 1);\nfor (const r of R) ipcMain.handle(r.channel, () => 1);\nR.forEach((r) => ipcMain.on(r.channel, () => 1));\n`,
      );
      expect(rows(info)).toEqual([]);
      expect(unresolved(info)).toBe(3);
    });
});

describe("review: changes the evaluation cannot follow, in a route list", () => {
  for (const [name, write] of [
    ["a push through an alias", 'const Q = R; Q.push({ channel: "r:b", kind: "on" });'],
    [
      "a push in a function",
      'function add(l) { l.push({ channel: "r:b", kind: "on" }); }\nadd(R);',
    ],
  ] as const)
    // every loop reads its list strictly (#198): 0.9.8 read the last two from the list as written
    it(`leaves every loop over the list unresolved after ${name}`, () => {
      const info = mainOnly(
        `const R = [{ channel: "r:a", kind: "handle" }];\n${write}\nfor (const r of R) ipcMain[r.kind](r.channel, () => 1);\nfor (const r of R) ipcMain.handle(r.channel, () => 1);\nR.forEach((r) => ipcMain.on(r.channel, () => 1));\n`,
      );
      expect(rows(info)).toEqual([]);
      expect(unresolved(info)).toBe(3);
    });
});

describe("review: what only reads a table", () => {
  // as R7's probes n2 and n3: what 0.9.8 read after such a use is still read
  for (const use of ["console.log(X)", "JSON.stringify(X)", "Object.freeze(X)", "const X2 = X"])
    it(`reads the tables after ${use}`, () => {
      const info = analyze({
        "main.js": `const { ipcMain } = require("electron");\nconst CH = { A: "n:a", B: "n:b" };\nconst URLS = { api: "https://n.example.com/api" };\nconst KEYS = { theme: "n.theme" };\nconst ROUTES = [{ channel: "r:a", kind: "handle" }];\n${use.replaceAll("X", "CH")}; ${use.replaceAll("X", "URLS")}; ${use.replaceAll("X", "KEYS")}; ${use.replaceAll("X", "ROUTES")};\nipcMain.on(CH["B"], () => 1);\nfor (const k of Object.keys(CH)) ipcMain.handle(CH[k], () => 1);\nfor (const r of ROUTES) ipcMain.handle(r.channel, () => 1);\nfetch(URLS["api"] + "/x");\nlocalStorage.getItem(KEYS["theme"]);\n`,
      });
      expect(rows(info)).toEqual([
        "n:a ipcMain.handle main.js",
        "n:b ipcMain.handle main.js",
        "n:b ipcMain.on main.js",
        "r:a ipcMain.handle main.js",
      ]);
      expect(info.endpoints.map((e) => e.value)).toContain("https://n.example.com/api/x");
      expect(info.storage.map((e) => e.value)).toContain("n.theme");
    });

  // RW's review of #198: uses that are no use of the table at all, that only test it, or that
  // bind a name of their own, are reads in the loops too (they were taken for escapes)
  for (const use of [
    "const o = { T: 2 };",
    "T: for (;;) { break T; }",
    "const { A } = T;",
    "let { B: bb = CH } = T;",
    "if (T) f();",
    "while (T && T.A) f();",
    "const n = !T;",
    "const m = T === null, m2 = T != null;",
    "const y = T || {};",
    "const z = x ? T : null;",
    "switch (x) { case T: break; }",
    "class Q { T() {} static T = 1; }",
    "function h(T) { g(T); }",
    "const h2 = (a, T) => a;",
    "try { f(); } catch (T) { g(T); }",
    "function g2({ T }) {}",
    "function h7([T]) { g(T); }",
    "function h8() { const { a: T } = o; g(T); }",
    // handed on as a value, as `module.exports = T` is (what is done with it there is not read)
    "function r() { return T; }",
    "const arr = [T];",
    "module.exports = T;",
    "structuredClone(T);",
    "Object.getOwnPropertyNames(T);",
  ])
    for (const how of BUILDS)
      it(`reads the loops over a table after \`${use}\` (${how})`, () => {
        const info = analyze(
          build(
            {
              "main.js": `const { ipcMain } = require("electron");\nlet CH = "c:a";\nvar T = { A: "t:a", B: "t:b" };\n${use}\nfor (const k of Object.keys(T)) ipcMain.handle(T[k], () => 1);\n`,
            },
            ["main.js"],
            how,
          ),
        );
        expect(rows(info)).toEqual(["t:a ipcMain.handle main.js", "t:b ipcMain.handle main.js"]);
      });

  it("reads a list's callback after a use that only reads it", () => {
    for (const use of [
      "if (T) f();",
      "function h(T) {}",
      "const { A } = T;",
      "T: for (;;) break T;",
    ]) {
      const info = analyze({
        "main.js": `const { ipcMain } = require("electron");\nvar T = { A: "t:a", B: "t:b" };\n${use}\nObject.values(T).forEach((c) => ipcMain.on(c, () => 1));\n`,
      });
      expect(rows(info), use).toEqual(["t:a ipcMain.on main.js", "t:b ipcMain.on main.js"]);
    }
  });

  it("reads the endpoint and storage loops after uses that only read", () => {
    for (const use of [
      "if (U) f();",
      "function h(U) {}",
      "const { a } = U;",
      "const o = { U: 1 };",
    ]) {
      const info = analyze({
        "main.js": `const U = { a: "https://a.example.com/x", b: "https://b.example.com/y" };\nconst K = ["k.one", "k.two"];\n${use.replaceAll("U", "U")} ${use.replaceAll("U", "K")}\nfor (const k of Object.keys(U)) fetch(U[k]);\nK.forEach((k) => localStorage.getItem(k));\n`,
      });
      expect(info.endpoints.map((e) => e.value).toSorted(), use).toEqual([
        "https://a.example.com/x",
        "https://b.example.com/y",
      ]);
      expect(info.storage.map((e) => e.value).toSorted(), use).toEqual(["k.one", "k.two"]);
    }
  });

  // A function that is not read may change the table it is given (#198, RA's probe K): a key
  // the loop finds (`T[k]`) and an element of a loop are no longer read; a literal key still is.
  for (const use of ["log(X)", 'emitter.emit("c", X)'])
    it(`reads only the literal keys after ${use}`, () => {
      const info = analyze({
        "main.js": `const { ipcMain } = require("electron");\nconst CH = { A: "n:a", B: "n:b" };\nconst URLS = { api: "https://n.example.com/api" };\nconst KEYS = { theme: "n.theme" };\nconst ROUTES = [{ channel: "r:a", kind: "handle" }];\n${use.replaceAll("X", "CH")}; ${use.replaceAll("X", "URLS")}; ${use.replaceAll("X", "KEYS")}; ${use.replaceAll("X", "ROUTES")};\nipcMain.on(CH["B"], () => 1);\nfor (const k of Object.keys(CH)) ipcMain.handle(CH[k], () => 1);\nfor (const r of ROUTES) ipcMain.handle(r.channel, () => 1);\nfetch(URLS["api"] + "/x");\nlocalStorage.getItem(KEYS["theme"]);\n`,
      });
      expect(rows(info)).toEqual(["n:b ipcMain.on main.js"]);
      expect(info.endpoints.map((e) => e.value)).toContain("https://n.example.com/api/x");
      expect(info.storage.map((e) => e.value)).toContain("n.theme");
    });

  it("reads the members a table builds after uses known to only read it", () => {
    const info = preload(
      `const CH = { A: "n:a", B: "n:b" };\nconsole.log(CH); JSON.stringify(CH); const s = \`\${CH}\`;\nconst api = Object.fromEntries(Object.entries(CH).map(([m, c]) => [m, (...a) => ipcRenderer.invoke(c, ...a)]));\ncontextBridge.exposeInMainWorld("x", { ...api });\n`,
    );
    expect(members(info)).toEqual(["x.A n:a", "x.B n:b"]);
  });

  it("reads a table passed to a local function that only reads it, or to another module's", () => {
    const info = analyze({
      "main.js": `const { ipcMain } = require("electron");\nconst logger = require("./logger");\nfunction show(o) { return Object.keys(o).length; }\nconst A = { x: "a:x" }; show(A); ipcMain.on(A["x"], f);\nconst C = { x: "c:x" }; logger.info(C); ipcMain.on(C["x"], f);\nconst D = { x: "d:x" }; const s = \`\${JSON.stringify(D)}\`; ipcMain.on(D["x"], f);\nconst F = { x: "f:x" }; ipcMain.on(F["x"], f); console.log(F);\n`,
      "logger.js": "module.exports = { info: (o) => process.stdout.write(String(o)) };\n",
    });
    expect(rows(info)).toEqual([
      "a:x ipcMain.on main.js",
      "c:x ipcMain.on main.js",
      "d:x ipcMain.on main.js",
      "f:x ipcMain.on main.js",
    ]);
  });
});

describe("review: control flow in a round", () => {
  it("gives an unreadable entry for a member written after a condition or `continue`", () => {
    const info = preload(
      `const T = { a: "t:a", secret: "t:s" };\nconst api = {};\nObject.keys(T).forEach((k) => { if (k !== "secret") api[k] = (...x) => ipcRenderer.invoke(T[k], ...x); });\nfor (const [k, c] of Object.entries(T)) { if (k.startsWith("s")) continue; api[k] = () => ipcRenderer.send(c); }\ncontextBridge.exposeInMainWorld("x", api);\n`,
    );
    expect(members(info)).toEqual(["x.null null", "x.null null"]);
    expect(rows(info)).toEqual([]);
  });

  it("leaves a route call after a condition or `break` unresolved", () => {
    const info = mainOnly(
      `const R = [{ channel: "r:a", kind: "handle" }, { channel: "r:stop" }];\nfor (const r of R) { if (!r.kind) break; ipcMain[r.kind](r.channel, () => 1); }\nR.forEach((r) => { if (r.kind) ipcMain.handle(r.channel, () => 1); });\n`,
    );
    expect(rows(info)).toEqual([]);
    expect(unresolved(info)).toBe(2);
  });
});

describe("review: what an IPC object parameter is bound to", () => {
  it("counts a destructuring assignment and a for-of head as writes of the parameter", () => {
    const info = mainOnly(
      `function a(ipc) { ({ ipc } = { ipc: make() }); ipc.handle("rw:e", () => 1); }\na(ipcMain);\nfunction b(ipc) { for (ipc of [make()]) ipc.handle("rw:f", () => 1); }\nb(ipcMain);\n`,
    );
    expect(rows(info)).toEqual([]);
  });

  it("counts .call, .apply, .bind and callback uses as call sites that pass something else", () => {
    for (const use of [
      "reg.apply(null, [make()]);",
      "const r2 = reg.bind(null, make()); r2();",
      "[make()].forEach(reg);",
      "setTimeout(reg, 0, make());",
      "reg.call(null, make());",
    ]) {
      const info = mainOnly(
        `function reg(ipc) { ipc.handle("u:a", () => 1); }\nreg(ipcMain);\n${use}\n`,
      );
      expect(rows(info)).toEqual([]);
    }
    // `.call(this, ipcMain)` is read: its argument after `this` is ipcMain
    expect(
      rows(
        mainOnly('function reg(ipc) { ipc.handle("u:b", () => 1); }\nreg.call(null, ipcMain);\n'),
      ),
    ).toEqual(["u:b ipcMain.handle main.js"]);
  });

  it("offers other modules only functions that look like IPC", () => {
    const info = analyze({
      // a library that mentions IPC once, with a function that listens on a stream
      "lib.js":
        '// not an ipc helper\nfunction listen(stream) { stream.on("data", () => 1); }\nmodule.exports = { listen };\n',
      "main.js":
        'const { ipcMain } = require("electron");\nconst { listen } = require("./lib");\nlisten(ipcMain);\nlisten(process.stdin);\n',
    });
    expect(info.modules.find((m) => m.id === "lib.js")?.wrappers).toBeUndefined();
    expect(rows(info)).toEqual([]);
  });
});

describe("review: literal keys outside a loop", () => {
  it('reads `api["lit"] = …` and `api[KEY] = …` as the member that key names', () => {
    const info = preload(
      'const K = "konst";\nconst api = {};\napi["lit"] = () => ipcRenderer.invoke("l:lit");\napi[K] = () => ipcRenderer.invoke("l:k");\ncontextBridge.exposeInMainWorld("x", api);\n',
    );
    expect(members(info)).toEqual(["x.konst l:k", "x.lit l:lit"]);
  });
});

describe("review: the parameter stage across modules", () => {
  it("reads a function whose parameter has another name when it calls a method only IPC has", () => {
    const info = analyze({
      // nothing in this file says `ipc`
      "lib/reg.js":
        'function register(m) { m.handle("rn:a", () => 1); }\nmodule.exports = { register };\n',
      "main.js":
        'const { ipcMain } = require("electron");\nrequire("./lib/reg").register(ipcMain);\n',
    });
    expect(rows(info)).toEqual(["rn:a ipcMain.handle lib/reg.js"]);
  });

  it("says so when it cannot read every module that calls such a function", () => {
    // more modules call it than the stage reads (200)
    const callers = Object.fromEntries(
      Array.from({ length: 201 }, (_, i) => [
        `c/m${String(i).padStart(3, "0")}.js`,
        'const { ipcMain } = require("electron");\nrequire("../lib/reg").register(ipcMain);\n',
      ]),
    );
    const info = analyze({
      "lib/reg.js":
        'function register(ipc) { ipc.handle("cut:a", () => 1); }\nmodule.exports = { register };\n',
      "main.js": Object.keys(callers)
        .map((f) => `require("./${f}");`)
        .join("\n"),
      ...callers,
    });
    expect(rows(info)).toEqual([]);
    const cut = info.limitations.find(
      (l) => l.code === "ipc_wrappers_capped" && /as a parameter/.test(l.message),
    );
    expect(cut?.message).toContain("c/m200.js");
  });
});

// Issue #201: a method of the file's own wrapper that the file replaces gives no row in the file,
// as a replacement in another module already did. One build of one bundle each.
const MAIN_REPLACED = `"use strict";
const { ipcMain } = require("electron");
const { Svc } = require("./svc");
Svc.prototype.register = function (ipc) { ipc.handle("svc:new", () => 2); };
new Svc().register(ipcMain);
class T { register(ipc) { ipc.handle("t:orig", () => 1); } }
const t = new T();
t.register = (ipc) => {};
t.register(ipcMain);
class Ipc { handle(ch, fn) { ipcMain.handle(ch, fn); } }
const w = new Ipc();
w.handle = () => {};
w.handle("w:replaced", () => 1);
// not replaced: another object's method of the same name is written
class Kept { register(ipc) { ipc.handle("kept:a", () => 1); } }
const other = { register() {} };
other.register = () => {};
new Kept().register(ipcMain);
// a write on one instance counts for the class, as across modules: no row for v either
const v = new Ipc();
v.handle("v:also", () => 1);
module.exports = { t, w, v };
`;

describe("a wrapper method the file itself replaces (#201)", () => {
  for (const how of BUILDS)
    it(`gives no row of the original method (${how})`, () => {
      const info = analyze(
        build(
          {
            "main.js": MAIN_REPLACED,
            "svc.js":
              'class Svc { register(ipc) { ipc.handle("svc:orig", () => 1); } }\nmodule.exports = { Svc };\n',
          },
          ["main.js"],
          how,
        ),
      );
      const got = rows(info).map((r) => r.split(" ").slice(0, 2).join(" "));
      expect(got).toEqual(["kept:a ipcMain.handle"]);
      expect(info.limitations.map((l) => l.code)).toContain("wrapper_method_replaced");
    });
});

describe("a computed method that names one method, outside a loop", () => {
  for (const how of BUILDS)
    it(`reads ipcMain["handle"](…) and ipcMain[M](…) as that method (${how})`, () => {
      const main =
        'const { ipcMain } = require("electron");\nconst M = "handle";\nipcMain["handle"]("lit:computed", () => 1);\nipcMain[M]("const:computed", () => 1);\nfor (const M of ["on"]) ipcMain[M]("loop:m", () => 1);\nmodule.exports = {};\n';
      const info = analyze(build({ "main.js": main }, ["main.js"], how));
      expect(rows(info)).toEqual([
        "const:computed ipcMain.handle main.js",
        "lit:computed ipcMain.handle main.js",
        // the loop's own M, not the constant
        "loop:m ipcMain.on main.js",
      ]);
      expect(unresolved(info)).toBe(0);
    });
});

describe("a block's own ipcMain passed to a function", () => {
  for (const how of BUILDS)
    it(`is not Electron's, so the function gives no row (${how})`, () => {
      const main = [
        'const { ipcMain } = require("electron");',
        'const { EventEmitter } = require("events");',
        "{",
        "  const ipcMain = new EventEmitter();",
        "  register(ipcMain);",
        "}",
        'function register(ipc) { ipc.handle("r2:x", () => 1); }',
        'function kept(ipc) { ipc.handle("kept:x", () => 1); }',
        "kept(ipcMain);",
        // a value that may be Electron's is read as before (review RC of #207)
        'function getIpc() { return require("electron").ipcMain; }',
        'function viaCall(ipc) { ipc.handle("call:x", () => 1); }',
        "{",
        "  const ipcMain = getIpc();",
        "  viaCall(ipcMain);",
        "}",
        "module.exports = {};",
      ].join("\n");
      const info = analyze(build({ "main.js": main }, ["main.js"], how));
      // (a bundle renames the block's name, which is then not read as ipcMain at all)
      expect(rows(info)).toEqual([
        ...(how === "plain" ? ["call:x ipcMain.handle main.js"] : []),
        "kept:x ipcMain.handle main.js",
      ]);
    });
});

// Review RC of #207: an exposure inside a function or listener that runs from the top of the
// file, a setup function or IIFE that runs before it, a loop the call and a write share, and
// statements a minifier joins with commas.
const RC_PRELOADS: Record<string, { source: string; members: string[] }> = {
  called: {
    source:
      'const api = { a: () => ipcRenderer.send("a") };\nfunction expose() { contextBridge.exposeInMainWorld("api", api); }\napi.x = () => ipcRenderer.send("x");\nexpose();\napi.y = () => ipcRenderer.send("y");\n',
    // y is written after the call that exposes the object
    members: ["api.a a", "api.x x"],
  },
  timer: {
    source:
      'const api = {};\nfunction later() { contextBridge.exposeInMainWorld("api", api); }\napi.z = () => ipcRenderer.send("z");\nsetTimeout(later, 0);\n',
    members: ["api.z z"],
  },
  listener: {
    source:
      'const api = { a: () => ipcRenderer.send("a") };\napi.b = () => ipcRenderer.send("b");\nwindow.addEventListener("DOMContentLoaded", () => { contextBridge.exposeInMainWorld("api", api); });\napi.x = () => ipcRenderer.send("x");\n',
    // x is written after the listener is registered: it may or may not run first
    members: ["api.a a", "api.b b", "api.null null"],
  },
  hoisted: {
    source:
      'const api = {};\nsetup();\ncontextBridge.exposeInMainWorld("api", api);\nfunction setup() { api.h = () => ipcRenderer.send("hoisted"); }\n',
    members: ["api.h hoisted"],
  },
  iife: {
    source:
      'const api = {};\n(function () { api.i = () => ipcRenderer.send("iife"); })();\ncontextBridge.exposeInMainWorld("api", api);\n',
    members: ["api.i iife"],
  },
  loop: {
    source:
      'const api = { a: () => ipcRenderer.send("a") };\nfor (let i = 0; i < 2; i++) { if (i === 1) contextBridge.exposeInMainWorld("api", api); api.x = () => ipcRenderer.send("loopx"); }\n',
    members: ["api.a a", "api.null null"],
  },
  loopWithoutBraces: {
    source:
      'const api = { a: () => ipcRenderer.send("a") };\nlet n = 0;\nwhile (n++ < 2) { if (n === 2) { contextBridge.exposeInMainWorld("api", api); break; } api.w = () => ipcRenderer.send("whilew"); }\n',
    members: ["api.a a", "api.null null"],
  },
  calledTwice: {
    source:
      'const api = {};\nfunction expose() { contextBridge.exposeInMainWorld("api", api); }\nif (process.env.EARLY) expose();\napi.c = () => ipcRenderer.send("c-cond");\nif (!process.env.EARLY) expose();\n',
    // written between two calls: exposed by the later one or not, as the conditions decide
    members: ["api.null null"],
  },
  reassigned: {
    source:
      'let api = { old: () => ipcRenderer.send("old") };\napi = { neu: () => ipcRenderer.send("neu") };\napi.more = () => ipcRenderer.send("more");\ncontextBridge.exposeInMainWorld("api", api);\n',
    members: ["api.more more", "api.neu neu"],
  },
};

describe("where a bridge member is written, as the review of #207 found (RC)", () => {
  for (const [name, { source, members: want }] of Object.entries(RC_PRELOADS))
    for (const how of BUILDS)
      it(`${name} (${how})`, () => {
        const text = `const { contextBridge, ipcRenderer } = require("electron");\n${source}`;
        const info = analyze(
          build({ "main.js": "", "preload.js": text }, ["main.js", "preload.js"], how),
        );
        expect(members(info)).toEqual(want);
      });
});

describe("the in-file replacement check of a large bundle (RC 7)", () => {
  it("reads past the other member writes of the file and finds the replacement", () => {
    // many member writes that replace no wrapper method, then one that does
    const main = [
      'const { ipcMain } = require("electron");',
      "class Ipc { handle(ch, fn) { ipcMain.handle(ch, fn); } }",
      "const w = new Ipc();",
      Array.from({ length: 6000 }, (_, i) => `o${i % 50}.k${i} = v${i};`).join("\n"),
      "w.handle = () => {};",
      'w.handle("late:replaced", () => 1);',
      "module.exports = { w };",
    ].join("\n");
    const info = analyze({ "main.js": main });
    expect(rows(info)).toEqual([]);
    expect(codes(info)).toContain("wrapper_method_replaced");
    expect(codes(info)).not.toContain("wrapper_replacements_unchecked");
  });

  it("reads the rows past a computed write of the class's own fields, and says so", () => {
    // `this[key] = value` in a setter, as Electron Fiddle's AppState has: not a proven replacement
    const main =
      'const { ipcMain } = require("electron");\nclass Ipc { set(k, v) { this[k] = v; } handle(ch, fn) { ipcMain.handle(ch, fn); } }\nconst w = new Ipc();\nw.set("title", "x");\nw.handle("kept:h", () => 1);\nmodule.exports = { w };\n';
    const info = analyze({ "main.js": main });
    expect(rows(info)).toEqual(["kept:h ipcMain.handle main.js"]);
    expect(codes(info)).toContain("wrapper_replacements_unchecked");
  });

  it("does not read a file whose wrappers give no row there", () => {
    const main =
      'const { ipcMain } = require("electron");\nclass Ipc { handle(ch, fn) { ipcMain.handle(ch, fn); } }\nconst w = new Ipc();\nw.handle = () => {};\nmodule.exports = { w };\n';
    expect(codes(analyze({ "main.js": main }))).not.toContain("wrapper_method_replaced");
  });
});

// RC re-review of #207: a replacement through a computed key that is a string constant, or a
// loop over a list of strings, blocks that method in the wrapper's own file as across modules.
const KEYED: Record<string, string> = {
  constant:
    'class Ipc { handle(ch, fn) { ipcMain.handle(ch, fn); } }\nconst a = new Ipc();\nconst k = "handle";\na[k] = () => {};\na.handle("keyed:const", () => 1);\n',
  prototype:
    'class Ipc { handle(ch, fn) { ipcMain.handle(ch, fn); } }\nconst k = "handle";\nIpc.prototype[k] = function () {};\nconst a = new Ipc();\na.handle("keyed:proto", () => 1);\n',
  loop: 'class Ipc { handle(ch, fn) { ipcMain.handle(ch, fn); } on(ch, fn) { ipcMain.on(ch, fn); } }\nfor (const m of ["handle", "on"]) Ipc.prototype[m] = function () {};\nconst a = new Ipc();\na.handle("keyed:loop", () => 1);\n',
};

describe("a wrapper method replaced through a computed key that is read (RC)", () => {
  for (const [name, body] of Object.entries(KEYED))
    for (const how of BUILDS)
      it(`${name} (${how})`, () => {
        const main = `const { ipcMain } = require("electron");\n${body}module.exports = {};\n`;
        const info = analyze(build({ "main.js": main }, ["main.js"], how));
        expect(rows(info).filter((r) => r.startsWith("keyed:"))).toEqual([]);
        expect(codes(info)).toContain("wrapper_method_replaced");
      });
  for (const how of BUILDS)
    it(`from another module, as one bundle (${how})`, () => {
      const info = analyze(
        build(
          {
            "ipc.js":
              'const { ipcMain } = require("electron");\nclass Ipc { handle(ch, fn) { ipcMain.handle(ch, fn); } }\nmodule.exports = { Ipc };\n',
            "main.js":
              'const { Ipc } = require("./ipc");\nconst k = "handle";\nIpc.prototype[k] = function () {};\nnew Ipc().handle("keyed:xmod", () => 1);\n',
          },
          ["main.js"],
          how,
        ),
      );
      expect(rows(info).filter((r) => r.startsWith("keyed:"))).toEqual([]);
      expect(codes(info)).toContain("wrapper_method_replaced");
    });
  for (const how of BUILDS)
    it(`a key that cannot be read leaves the file unchecked (${how})`, () => {
      const main =
        'const { ipcMain } = require("electron");\nclass Ipc { handle(ch, fn) { ipcMain.handle(ch, fn); } }\nconst a = new Ipc();\na[process.env.M] = () => {};\na.handle("keyed:unknown", () => 1);\nmodule.exports = {};\n';
      const info = analyze(build({ "main.js": main }, ["main.js"], how));
      expect(rows(info).filter((r) => r.startsWith("keyed:"))).toEqual([
        "keyed:unknown ipcMain.handle main.js",
      ]);
      expect(codes(info)).toContain("wrapper_replacements_unchecked");
    });
});

/** `reg(ipc)` called n times: with ipcMain, the last time with `last`. */
const objectSites = (n: number, last: string, exported = false) =>
  [
    'const { ipcMain, ipcRenderer } = require("electron");',
    'function reg(ipc) { ipc.on("evt", () => 1); }',
    ...(exported ? ["module.exports = { register: reg };"] : []),
    ...Array.from({ length: n - 1 }, () =>
      exported ? "module.exports.register(ipcMain);" : "reg(ipcMain);",
    ),
    exported ? `module.exports.register(${last});` : `reg(${last});`,
  ].join("\n");
describe("a function with an IPC object parameter called past the sites read", () => {
  for (const exported of [false, true])
    it(`gives no definite row and says the search was cut${exported ? " (through an export key)" : ""}`, () => {
      // 64 sites are read whole: the mixed callers give no row, and no cap is met
      const at64 = analyze({ "main.js": objectSites(64, "ipcRenderer", exported) });
      expect(rows(at64)).toEqual([]);
      expect(codes(at64)).not.toContain("ipc_wrappers_capped");
      // the 65th site passes ipcRenderer: ipcMain.on evt is not established from the first 64
      const at65 = analyze({ "main.js": objectSites(65, "ipcRenderer", exported) });
      expect(rows(at65)).toEqual([]);
      expect(codes(at65)).toContain("ipc_wrappers_capped");
    });
  it("keeps the rows of the file's other such functions", () => {
    const main = `${objectSites(65, "ipcRenderer")}\nfunction other(ipc) { ipc.handle("kept", () => 1); }\nother(ipcMain);`;
    const info = analyze({ "main.js": main });
    expect(rows(info)).toEqual(["kept ipcMain.handle main.js"]);
    expect(codes(info)).toContain("ipc_wrappers_capped");
  });
  it("keeps the row of a function called at 64 sites", () => {
    expect(rows(analyze({ "main.js": objectSites(64, "ipcMain") }))).toEqual([
      "evt ipcMain.on main.js",
    ]);
  });
});

describe("#209: a loop variable over a table's keys is bound by its own loop", () => {
  const head = `const { ipcMain } = require("electron");\nconst T = { A: "t:a", B: "t:b" };\nconst V = { x: "v:x", y: "v:y" };\nconst h = () => 1;\nconst f = (k) => globalThis.seen?.(k);\n`;
  const cases: Array<{ name: string; body: string; want: string[] }> = [
    {
      // as h02: esbuild's minifier names both loop variables `o`
      name: "another loop's callback parameter after the keys loop",
      body: `for (const key of Object.keys(T)) f(key);\nObject.values(V).forEach((ch) => ipcMain.on(ch, h));\n`,
      want: ["v:x ipcMain.on main.js", "v:y ipcMain.on main.js"],
    },
    {
      name: "the same name reused by a callback parameter",
      body: `for (let o of Object.keys(T)) f(o);\nObject.values(V).forEach((o) => ipcMain.on(o, h));\n`,
      want: ["v:x ipcMain.on main.js", "v:y ipcMain.on main.js"],
    },
    {
      // as h04: an outer binding of the name, read after the loop
      name: "an outer binding read after the loop",
      body: `let o = "t:outer";\nfor (let o of Object.keys(T)) f(o);\nipcMain.on(o, h);\n`,
      want: ["t:outer ipcMain.on main.js"],
    },
    {
      // as h07: a parameter of the same name
      name: "a parameter of the same name",
      body: `for (let o of Object.keys(T)) f(o);\nfunction reg(o) { ipcMain.on(o, h); }\nreg("t:param");\n`,
      want: ["t:param ipcMain.on main.js"],
    },
    {
      name: "the keys loop itself",
      body: `for (const o of Object.keys(T)) ipcMain.on(o, h);\n`,
      want: ["A ipcMain.on main.js", "B ipcMain.on main.js"],
    },
    {
      name: "the entries loop itself, in a block",
      body: `for (const [o, fn] of Object.entries(T)) { f(fn); ipcMain.handle(o, h); }\n`,
      want: ["A ipcMain.handle main.js", "B ipcMain.handle main.js"],
    },
    {
      name: "an in loop",
      body: `for (const o in T) ipcMain.on(o, h);\n`,
      want: ["A ipcMain.on main.js", "B ipcMain.on main.js"],
    },
    {
      name: "a values loop nested in a keys loop with the same name",
      body: `for (const o of Object.keys(T)) { for (const o of Object.values(V)) ipcMain.on(o, h); }\n`,
      want: ["v:x ipcMain.on main.js", "v:y ipcMain.on main.js"],
    },
    {
      name: "a keys loop nested in a values loop with the same name",
      body: `for (const o of Object.values(V)) { for (const o of Object.keys(T)) ipcMain.on(o, h); }\n`,
      want: ["A ipcMain.on main.js", "B ipcMain.on main.js"],
    },
    {
      name: "a callback inside the keys loop with a parameter of the same name",
      body: `for (const o of Object.keys(T)) ["t:cb"].forEach((o) => ipcMain.on(o, h));\n`,
      want: ["t:cb ipcMain.on main.js"],
    },
    {
      // T05: a braceless `if … else …` body
      name: "an if … else body of the keys loop",
      body: `for (const o of Object.keys(T)) if (globalThis.x) f(o); else ipcMain.on(o, h);\n`,
      want: ["A ipcMain.on main.js", "B ipcMain.on main.js"],
    },
    {
      // T06
      name: "an if … else body of an in loop",
      body: `for (const o in T) if (o === "Z") f(o); else ipcMain.handle(o, h);\n`,
      want: ["A ipcMain.handle main.js", "B ipcMain.handle main.js"],
    },
    {
      // T16
      name: "an if … else body of a loop over pairs",
      body: `const L = [["p:a", 1], ["p:b", 2]];\nfor (const [o, n] of L) if (n > 5) f(o); else ipcMain.on(o, h);\n`,
      want: ["p:a ipcMain.on main.js", "p:b ipcMain.on main.js"],
    },
    {
      // T10
      name: "a for await loop",
      body: `async function g() { for await (const o of Object.keys(T)) ipcMain.on(o, h); }\ng();\n`,
      want: ["A ipcMain.on main.js", "B ipcMain.on main.js"],
    },
    {
      name: "an entries loop's value",
      body: `for (const [k, o] of Object.entries(V)) { f(k); ipcMain.on(o, h); }\n`,
      want: ["v:x ipcMain.on main.js", "v:y ipcMain.on main.js"],
    },
  ];
  for (const c of cases)
    for (const how of BUILDS)
      it(`${c.name} (${how})`, () => {
        const info = analyze(build({ "main.js": head + c.body }, ["main.js"], how));
        expect(rows(info)).toEqual(c.want);
      });
});

describe("#209: loop variables in the shapes a minifier writes", () => {
  const head = `var{ipcMain:t}=require("electron");var s={A:"t:a",B:"t:b"},v={x:"v:x",y:"v:y"},c=()=>1,e=o=>globalThis.seen?.(o);`;
  const keys = ["A t.on", "B t.on"];
  const cases: Array<[string, string, string[]]> = [
    [
      "a body of expressions joined with commas",
      `for(let o of Object.keys(s))e(o),t.on(o,c);`,
      keys,
    ],
    ["the statement after such a body", `for(let o of Object.keys(s))e(o),e(o);t.on(o,c);`, []],
    [
      "an entries value in such a body",
      `for(let[o,n]of Object.entries(v))e(o),t.on(n,c);`,
      ["v:x t.on", "v:y t.on"],
    ],
    [
      "a values loop's variable in such a body",
      `for(let o of Object.values(v))e(o),t.on(o,c);`,
      ["v:x t.on", "v:y t.on"],
    ],
    ["a loop variable without a declaration", `var o;for(o of Object.keys(s))t.on(o,c);`, keys],
    [
      "a loop variable without a declaration, read after",
      `var o;for(o of Object.keys(s))e(o);t.on(o,c);`,
      [],
    ],
    ["a var read after its loop", `for(var o of Object.keys(s))e(o);t.on(o,c);`, []],
    [
      "a loop shadowing a parameter",
      `function r(o){for(const o of Object.keys(s))t.on(o,c)}r(1);`,
      keys,
    ],
    [
      "an outer keys loop around an inner one",
      `for(const o of Object.keys(s)){for(const n of Object.keys(v))e(n);t.on(o,c)}`,
      keys,
    ],
    ["a test, not a loop", `function q(o){if(o in s)t.on(o,c)}q(globalThis.k);`, []],
    [
      "an in loop with a parameter of the same name inside",
      `for(const o in s)[1].forEach(function(o){t.on(o,c)});`,
      [],
    ],
  ];
  for (const [name, body, want] of cases)
    it(name, () => {
      expect(rows(analyze({ "main.js": head + body }))).toEqual(
        want.map((w) => `${w.replace(" t.", " ipcMain.")} main.js`),
      );
    });
});

describe("#225: a loop variable is not bound where a nearer declaration hides it", () => {
  const head = `const { ipcMain } = require("electron");\nconst T = { A: "t:a", B: "t:b" };\nconst h = () => 1;\nconst f = (k) => globalThis.seen?.(k);\n`;
  // Where the inner declaration keeps the loop variable's name, the channel is the inner
  // constant, which is not followed past a second declaration of the name in the function: the
  // row stays without a channel (no rows of the loop's list). A minifier renames the inner one,
  // and an esbuild bundle may, and then it is read.
  const cases: Array<{ name: string; body: string; want: Record<Build, string[]> }> = [
    {
      name: "a head without a declaration, the parameter it assigns hidden in the body",
      body: `function reg(o) { for (o of Object.keys(T)) { const o = "t:inner"; ipcMain.on(o, h); } }\nreg("t:p");\n`,
      want: {
        plain: [],
        bundled: ["t:inner ipcMain.on main.js"],
        minified: ["t:inner ipcMain.on main.js"],
      },
    },
    {
      name: "a declared head over a table's keys, hidden in the body",
      body: `for (const o of Object.keys(T)) { const o = "t:inner"; ipcMain.on(o, h); }\n`,
      want: { plain: [], bundled: [], minified: ["t:inner ipcMain.on main.js"] },
    },
    {
      name: "a declared head over a list, hidden in the body",
      body: `for (const o of ["l:a", "l:b"]) { const o = "l:inner"; ipcMain.handle(o, h); }\n`,
      want: { plain: [], bundled: [], minified: ["l:inner ipcMain.handle main.js"] },
    },
  ];
  for (const c of cases)
    for (const how of BUILDS)
      it(`${c.name} (${how})`, () => {
        const info = analyze(build({ "main.js": head + c.body }, ["main.js"], how));
        expect(rows(info)).toEqual(c.want[how]);
        // one row in all: without a channel when none is read
        const ipc = info.modules.flatMap((m) => m.ipc);
        expect(ipc.map((u) => u.channel === null)).toEqual([c.want[how].length === 0]);
      });
  // a `var` head: another `var` of the name in the same function is the same binding
  const L = `const L = ["l:a", "l:b"];\n`;
  const both = `for (var o of Object.keys(T)) { ipcMain.on(o, h); } for (var o of L) { ipcMain.handle(o, h); }`;
  const varCases: Array<[string, string, string[]]> = [
    [
      "two var loops of one name in a function",
      `${L}function reg() { ${both} }\nreg();\n`,
      [
        "A ipcMain.on main.js",
        "B ipcMain.on main.js",
        "l:a ipcMain.handle main.js",
        "l:b ipcMain.handle main.js",
      ],
    ],
    [
      "two var loops of one name at the top of the file",
      `${L}${both}\n`,
      [
        "A ipcMain.on main.js",
        "B ipcMain.on main.js",
        "l:a ipcMain.handle main.js",
        "l:b ipcMain.handle main.js",
      ],
    ],
    [
      "a var loop and a var of the name after it",
      `${L}for (var o of L) { ipcMain.handle(o, h); } var o = 1;\n`,
      ["l:a ipcMain.handle main.js", "l:b ipcMain.handle main.js"],
    ],
  ];
  for (const [name, body, want] of varCases)
    for (const how of BUILDS)
      it(`${name} (${how})`, () => {
        expect(rows(analyze(build({ "main.js": head + body }, ["main.js"], how)))).toEqual(want);
      });
  it("does not bind a var loop's variable where a block's const hides it", () => {
    for (const how of BUILDS) {
      const got = rows(
        analyze(
          build(
            {
              "main.js": `${head}${L}for (var o of L) { { const o = "l:x"; ipcMain.on(o, h); } ipcMain.handle(o, h); }\n`,
            },
            ["main.js"],
            how,
          ),
        ),
      );
      // the inner constant is read where the minifier renames it; never the loop's values
      expect(
        got.filter((r) => r.includes("ipcMain.handle")),
        how,
      ).toEqual(["l:a ipcMain.handle main.js", "l:b ipcMain.handle main.js"]);
      expect(
        got.filter((r) => r.includes("ipcMain.on")),
        how,
      ).toEqual(how === "minified" ? ["l:x ipcMain.on main.js"] : []);
    }
  });
  it("binds the loop variable where only an inner block declares the name", () => {
    for (const how of BUILDS)
      expect(
        rows(
          analyze(
            build(
              {
                "main.js": `${head}for (const o of ["l:a", "l:b"]) { { const o = "l:x"; f(o); } ipcMain.on(o, h); }\n`,
              },
              ["main.js"],
              how,
            ),
          ),
        ),
        how,
      ).toEqual(["l:a ipcMain.on main.js", "l:b ipcMain.on main.js"]);
  });
});

describe("#209: a loop variable over a table's keys is bound by its own loop", () => {
  const head = `const { ipcMain } = require("electron");\nconst T = { A: "t:a", B: "t:b" };\nconst V = { x: "v:x", y: "v:y" };\nconst h = () => 1;\nconst f = (k) => globalThis.seen?.(k);\n`;
  const cases: Array<{ name: string; body: string; want: string[] }> = [
    {
      // as h02: esbuild's minifier names both loop variables `o`
      name: "another loop's callback parameter after the keys loop",
      body: `for (const key of Object.keys(T)) f(key);\nObject.values(V).forEach((ch) => ipcMain.on(ch, h));\n`,
      want: ["v:x ipcMain.on main.js", "v:y ipcMain.on main.js"],
    },
    {
      name: "the same name reused by a callback parameter",
      body: `for (let o of Object.keys(T)) f(o);\nObject.values(V).forEach((o) => ipcMain.on(o, h));\n`,
      want: ["v:x ipcMain.on main.js", "v:y ipcMain.on main.js"],
    },
    {
      // as h04: an outer binding of the name, read after the loop
      name: "an outer binding read after the loop",
      body: `let o = "t:outer";\nfor (let o of Object.keys(T)) f(o);\nipcMain.on(o, h);\n`,
      want: ["t:outer ipcMain.on main.js"],
    },
    {
      // as h07: a parameter of the same name
      name: "a parameter of the same name",
      body: `for (let o of Object.keys(T)) f(o);\nfunction reg(o) { ipcMain.on(o, h); }\nreg("t:param");\n`,
      want: ["t:param ipcMain.on main.js"],
    },
    {
      name: "the keys loop itself",
      body: `for (const o of Object.keys(T)) ipcMain.on(o, h);\n`,
      want: ["A ipcMain.on main.js", "B ipcMain.on main.js"],
    },
    {
      name: "the entries loop itself, in a block",
      body: `for (const [o, fn] of Object.entries(T)) { f(fn); ipcMain.handle(o, h); }\n`,
      want: ["A ipcMain.handle main.js", "B ipcMain.handle main.js"],
    },
    {
      name: "an in loop",
      body: `for (const o in T) ipcMain.on(o, h);\n`,
      want: ["A ipcMain.on main.js", "B ipcMain.on main.js"],
    },
    {
      name: "a values loop nested in a keys loop with the same name",
      body: `for (const o of Object.keys(T)) { for (const o of Object.values(V)) ipcMain.on(o, h); }\n`,
      want: ["v:x ipcMain.on main.js", "v:y ipcMain.on main.js"],
    },
    {
      name: "a keys loop nested in a values loop with the same name",
      body: `for (const o of Object.values(V)) { for (const o of Object.keys(T)) ipcMain.on(o, h); }\n`,
      want: ["A ipcMain.on main.js", "B ipcMain.on main.js"],
    },
    {
      name: "a callback inside the keys loop with a parameter of the same name",
      body: `for (const o of Object.keys(T)) ["t:cb"].forEach((o) => ipcMain.on(o, h));\n`,
      want: ["t:cb ipcMain.on main.js"],
    },
    {
      // T05: a braceless `if … else …` body
      name: "an if … else body of the keys loop",
      body: `for (const o of Object.keys(T)) if (globalThis.x) f(o); else ipcMain.on(o, h);\n`,
      want: ["A ipcMain.on main.js", "B ipcMain.on main.js"],
    },
    {
      // T06
      name: "an if … else body of an in loop",
      body: `for (const o in T) if (o === "Z") f(o); else ipcMain.handle(o, h);\n`,
      want: ["A ipcMain.handle main.js", "B ipcMain.handle main.js"],
    },
    {
      // T16
      name: "an if … else body of a loop over pairs",
      body: `const L = [["p:a", 1], ["p:b", 2]];\nfor (const [o, n] of L) if (n > 5) f(o); else ipcMain.on(o, h);\n`,
      want: ["p:a ipcMain.on main.js", "p:b ipcMain.on main.js"],
    },
    {
      // T10
      name: "a for await loop",
      body: `async function g() { for await (const o of Object.keys(T)) ipcMain.on(o, h); }\ng();\n`,
      want: ["A ipcMain.on main.js", "B ipcMain.on main.js"],
    },
    {
      name: "an entries loop's value",
      body: `for (const [k, o] of Object.entries(V)) { f(k); ipcMain.on(o, h); }\n`,
      want: ["v:x ipcMain.on main.js", "v:y ipcMain.on main.js"],
    },
  ];
  for (const c of cases)
    for (const how of BUILDS)
      it(`${c.name} (${how})`, () => {
        const info = analyze(build({ "main.js": head + c.body }, ["main.js"], how));
        expect(rows(info)).toEqual(c.want);
      });
});

describe("#209: loop variables in the shapes a minifier writes", () => {
  const head = `var{ipcMain:t}=require("electron");var s={A:"t:a",B:"t:b"},v={x:"v:x",y:"v:y"},c=()=>1,e=o=>globalThis.seen?.(o);`;
  const keys = ["A t.on", "B t.on"];
  const cases: Array<[string, string, string[]]> = [
    [
      "a body of expressions joined with commas",
      `for(let o of Object.keys(s))e(o),t.on(o,c);`,
      keys,
    ],
    ["the statement after such a body", `for(let o of Object.keys(s))e(o),e(o);t.on(o,c);`, []],
    [
      "an entries value in such a body",
      `for(let[o,n]of Object.entries(v))e(o),t.on(n,c);`,
      ["v:x t.on", "v:y t.on"],
    ],
    [
      "a values loop's variable in such a body",
      `for(let o of Object.values(v))e(o),t.on(o,c);`,
      ["v:x t.on", "v:y t.on"],
    ],
    ["a loop variable without a declaration", `var o;for(o of Object.keys(s))t.on(o,c);`, keys],
    [
      "a loop variable without a declaration, read after",
      `var o;for(o of Object.keys(s))e(o);t.on(o,c);`,
      [],
    ],
    ["a var read after its loop", `for(var o of Object.keys(s))e(o);t.on(o,c);`, []],
    [
      "a loop shadowing a parameter",
      `function r(o){for(const o of Object.keys(s))t.on(o,c)}r(1);`,
      keys,
    ],
    [
      "an outer keys loop around an inner one",
      `for(const o of Object.keys(s)){for(const n of Object.keys(v))e(n);t.on(o,c)}`,
      keys,
    ],
    ["a test, not a loop", `function q(o){if(o in s)t.on(o,c)}q(globalThis.k);`, []],
    [
      "an in loop with a parameter of the same name inside",
      `for(const o in s)[1].forEach(function(o){t.on(o,c)});`,
      [],
    ],
  ];
  for (const [name, body, want] of cases)
    it(name, () => {
      expect(rows(analyze({ "main.js": head + body }))).toEqual(
        want.map((w) => `${w.replace(" t.", " ipcMain.")} main.js`),
      );
    });
});

describe("#225: a loop variable is not bound where a nearer declaration hides it", () => {
  const head = `const { ipcMain } = require("electron");\nconst T = { A: "t:a", B: "t:b" };\nconst h = () => 1;\nconst f = (k) => globalThis.seen?.(k);\n`;
  // Where the inner declaration keeps the loop variable's name, the channel is the inner
  // constant, which is not followed past a second declaration of the name in the function: the
  // row stays without a channel (no rows of the loop's list). A minifier renames the inner one,
  // and an esbuild bundle may, and then it is read.
  const cases: Array<{ name: string; body: string; want: Record<Build, string[]> }> = [
    {
      name: "a head without a declaration, the parameter it assigns hidden in the body",
      body: `function reg(o) { for (o of Object.keys(T)) { const o = "t:inner"; ipcMain.on(o, h); } }\nreg("t:p");\n`,
      want: {
        plain: [],
        bundled: ["t:inner ipcMain.on main.js"],
        minified: ["t:inner ipcMain.on main.js"],
      },
    },
    {
      name: "a declared head over a table's keys, hidden in the body",
      body: `for (const o of Object.keys(T)) { const o = "t:inner"; ipcMain.on(o, h); }\n`,
      want: { plain: [], bundled: [], minified: ["t:inner ipcMain.on main.js"] },
    },
    {
      name: "a declared head over a list, hidden in the body",
      body: `for (const o of ["l:a", "l:b"]) { const o = "l:inner"; ipcMain.handle(o, h); }\n`,
      want: { plain: [], bundled: [], minified: ["l:inner ipcMain.handle main.js"] },
    },
  ];
  for (const c of cases)
    for (const how of BUILDS)
      it(`${c.name} (${how})`, () => {
        const info = analyze(build({ "main.js": head + c.body }, ["main.js"], how));
        expect(rows(info)).toEqual(c.want[how]);
        // one row in all: without a channel when none is read
        const ipc = info.modules.flatMap((m) => m.ipc);
        expect(ipc.map((u) => u.channel === null)).toEqual([c.want[how].length === 0]);
      });
  // a `var` head: another `var` of the name in the same function is the same binding
  const L = `const L = ["l:a", "l:b"];\n`;
  const both = `for (var o of Object.keys(T)) { ipcMain.on(o, h); } for (var o of L) { ipcMain.handle(o, h); }`;
  const varCases: Array<[string, string, string[]]> = [
    [
      "two var loops of one name in a function",
      `${L}function reg() { ${both} }\nreg();\n`,
      [
        "A ipcMain.on main.js",
        "B ipcMain.on main.js",
        "l:a ipcMain.handle main.js",
        "l:b ipcMain.handle main.js",
      ],
    ],
    [
      "two var loops of one name at the top of the file",
      `${L}${both}\n`,
      [
        "A ipcMain.on main.js",
        "B ipcMain.on main.js",
        "l:a ipcMain.handle main.js",
        "l:b ipcMain.handle main.js",
      ],
    ],
    [
      "a var loop and a var of the name after it",
      `${L}for (var o of L) { ipcMain.handle(o, h); } var o = 1;\n`,
      ["l:a ipcMain.handle main.js", "l:b ipcMain.handle main.js"],
    ],
  ];
  for (const [name, body, want] of varCases)
    for (const how of BUILDS)
      it(`${name} (${how})`, () => {
        expect(rows(analyze(build({ "main.js": head + body }, ["main.js"], how)))).toEqual(want);
      });
  it("does not bind a var loop's variable where a block's const hides it", () => {
    for (const how of BUILDS) {
      const got = rows(
        analyze(
          build(
            {
              "main.js": `${head}${L}for (var o of L) { { const o = "l:x"; ipcMain.on(o, h); } ipcMain.handle(o, h); }\n`,
            },
            ["main.js"],
            how,
          ),
        ),
      );
      // the inner constant is read where the minifier renames it; never the loop's values
      expect(
        got.filter((r) => r.includes("ipcMain.handle")),
        how,
      ).toEqual(["l:a ipcMain.handle main.js", "l:b ipcMain.handle main.js"]);
      expect(
        got.filter((r) => r.includes("ipcMain.on")),
        how,
      ).toEqual(how === "minified" ? ["l:x ipcMain.on main.js"] : []);
    }
  });
  it("binds the loop variable where only an inner block declares the name", () => {
    for (const how of BUILDS)
      expect(
        rows(
          analyze(
            build(
              {
                "main.js": `${head}for (const o of ["l:a", "l:b"]) { { const o = "l:x"; f(o); } ipcMain.on(o, h); }\n`,
              },
              ["main.js"],
              how,
            ),
          ),
        ),
        how,
      ).toEqual(["l:a ipcMain.on main.js", "l:b ipcMain.on main.js"]);
  });
});

/** A helper whose first parameter is `o`, called with t:p: as a function, and as a method. */
const fn = (body: string): string => `function reg(o) { ${body} }\nreg("t:p");\n`;
const method = (body: string): string => `class S { reg(o) { ${body} } }\nnew S().reg("t:p");\n`;

describe("#227: a wrapper's parameter is not bound where a nearer declaration hides it", () => {
  const head = `const { ipcMain } = require("electron");\nconst h = () => 1;\nconst f = (k) => globalThis.seen?.(k);\n`;
  const P = ["t:p ipcMain.on main.js"];
  // Every build reads the same rows: a bundler or minifier that renames the inner name gives
  // the same answer as the scope rule on the plain source.
  const cases: Array<[string, string, string[]]> = [
    [
      "a block's const (the issue)",
      fn(`{ const o = "t:inner"; ipcMain.on(o, h); }`),
      ["t:inner ipcMain.on main.js"],
    ],
    [
      "a block's let",
      fn(`if (f(1)) { let o = "t:inner"; ipcMain.on(o, h); }`),
      ["t:inner ipcMain.on main.js"],
    ],
    [
      "an arrow's parameter of the name",
      fn(`["t:e"].forEach((o) => ipcMain.on(o, h));`),
      ["t:e ipcMain.on main.js"],
    ],
    ["a var of the function itself: the parameter", fn(`var o; ipcMain.on(o, h);`), P],
    [
      "a var with a value: what it holds",
      fn(`var o = "t:w"; ipcMain.on(o, h);`),
      ["t:w ipcMain.on main.js"],
    ],
    ["a catch parameter", fn(`try { f(1); } catch (o) { ipcMain.on(o, h); }`), []],
    [
      "a nested function's parameter",
      fn(`function g(o) { ipcMain.on(o, h); } g("t:g");`),
      ["t:g ipcMain.on main.js"],
    ],
    [
      "a declaration after the call in another block",
      fn(`{ ipcMain.on(o, h); } { const o = "t:later"; f(o); }`),
      P,
    ],
    [
      "an arrow wrapper's block const",
      `const reg = (o) => { { const o = "t:inner"; ipcMain.on(o, h); } };\nreg("t:p");\n`,
      ["t:inner ipcMain.on main.js"],
    ],
    [
      "a method's block const",
      method(`{ const o = "t:inner"; ipcMain.on(o, h); }`),
      ["t:inner ipcMain.on main.js"],
    ],
    ["a method's catch parameter", method(`try { f(1); } catch (o) { ipcMain.on(o, h); }`), []],
    ["a method's var: the parameter", method(`var o; ipcMain.on(o, h);`), P],
    [
      "a method's declaration after the call in another block",
      method(`{ ipcMain.on(o, h); } { const o = "t:later"; f(o); }`),
      P,
    ],
    ["a plain wrapper (unchanged)", fn(`ipcMain.on(o, h);`), P],
  ];
  for (const [name, body, want] of cases)
    for (const how of BUILDS)
      it(`${name} (${how})`, () => {
        const info = analyze(build({ "main.js": head + body }, ["main.js"], how));
        expect(rows(info)).toEqual(want);
        // the IPC call inside the helper stays a row, without a channel where none is read
        expect(unresolved(info)).toBe(want.length === 0 || want === P ? 1 : 0);
        expect(info.limitations.map((l) => l.code)).not.toContain("ipc_wrapper_param_undecided");
      });
  it("does not take a helper of another module whose parameter a block's const hides", () => {
    const files = {
      "ipc.js": `const { ipcMain } = require("electron");\nconst h = () => 1;\nfunction reg(o) { { const o = "t:inner"; ipcMain.on(o, h); } }\nfunction ok(o) { ipcMain.handle(o, h); }\nmodule.exports = { reg, ok };\n`,
      "main.js": `const { reg, ok } = require("./ipc");\nreg("t:p");\nok("t:ok");\n`,
    };
    // a bundle wraps the module in a function, where a helper is not read across modules: only
    // the plain build has t:ok, and no build has t:p
    for (const how of BUILDS)
      expect(
        rows(analyze(build(files, ["main.js"], how))).map((r) =>
          r.split(" ").slice(0, 2).join(" "),
        ),
        how,
      ).toEqual(
        how === "plain" ? ["t:inner ipcMain.on", "t:ok ipcMain.handle"] : ["t:inner ipcMain.on"],
      );
  });
  it("keeps the row and says so where the nesting is too deep to decide", () => {
    const deep = `${"{ ".repeat(300)}ipcMain.on(o, h);${" }".repeat(300)}`;
    const info = analyze({ "main.js": head + fn(deep) });
    expect(rows(info)).toEqual(P);
    const l = info.limitations.find((x) => x.code === "ipc_wrapper_param_undecided");
    expect(l?.message).toMatch(/reg at main\.js:4\.$/);
  });
});

describe("#209: a loop body without semicolons ends at the line break (S01)", () => {
  // as code without semicolons: the call after the loop reads the outer binding
  const main = [
    `const { ipcMain } = require("electron")`,
    `const h = () => 1`,
    `const T = { A: "t:a", B: "t:b" }`,
    `let ch = "g:outer"`,
    `function a() {`,
    `  for (const ch of ["g:in"]) h(ch), h(ch)`,
    `  ipcMain.on(ch, h)`,
    `}`,
    `let o = "t:outer"`,
    `function b() {`,
    `  for (const o of Object.keys(T)) h(o), h(o)`,
    `  ipcMain.handle(o, h)`,
    `}`,
    `let url = "https://outer.example.com"`,
    `function c() {`,
    `  for (const url of ["https://in.example.com"]) h(url), h(url)`,
    `  fetch(url)`,
    `}`,
    `let key = "store:outer"`,
    `function d() {`,
    `  for (const key of ["store:in"]) h(key)`,
    `  localStorage.setItem(key, 1)`,
    `}`,
    `a(); b(); c(); d()`,
    ``,
  ].join("\n");
  for (const how of BUILDS)
    it(`reads no loop value after the loop (${how})`, () => {
      const info = analyze(build({ "main.js": main }, ["main.js"], how));
      const ipc = rows(info);
      expect(ipc.filter((r) => /^(g:in|A|B) /.test(r))).toEqual([]);
      expect(info.endpoints.map((e) => e.value)).not.toContain("https://in.example.com");
      expect(info.storage.map((e) => e.value)).not.toContain("store:in");
      if (how !== "plain") {
        expect(ipc).toEqual(["g:outer ipcMain.on main.js", "t:outer ipcMain.handle main.js"]);
        expect(info.storage.map((e) => e.value)).toContain("store:outer");
      }
    });
});

describe("#209: a braceless loop body at the end of the file, and line starts that end a body", () => {
  const head = `const { ipcMain, ipcRenderer } = require("electron")\nconst h = () => 1\nconst T = { A: "t:a", B: "t:b" }\nconst L = [["p:a", 1], ["p:b", 2]]\n`;
  const cases: Array<[string, string, string[]]> = [
    ["keys", `for (const o of Object.keys(T)) ipcMain.on(o, h)`, ["A ipcMain.on", "B ipcMain.on"]],
    [
      "entries",
      `for (const [k, ch] of Object.entries(T)) ipcRenderer.on(ch, h)`,
      ["t:a ipcRenderer.on", "t:b ipcRenderer.on"],
    ],
    ["pairs", `for (const [o, n] of L) ipcMain.on(o, h)`, ["p:a ipcMain.on", "p:b ipcMain.on"]],
  ];
  for (const [name, body, want] of cases)
    for (const nl of ["", "\n"])
      it(`reads a ${name} loop as the last statement${nl ? ", with a newline" : ""}`, () => {
        expect(rows(analyze({ "main.js": head + body + nl }))).toEqual(
          want.map((w) => `${w} main.js`),
        );
      });
  for (const [name, after] of [
    ["a prefix ++", `n = n\n  ++n, ipcMain.on(ch, h)`],
    ["a `!`", `h(ch)\n  !globalThis.x && ipcMain.on(ch, h)`],
    ["`return`", `if (ch) return\n  ipcMain.on(ch, h)`],
    ["an arrow's block", `q = () => { h(ch) }\n  (ipcMain.on(ch, h))`],
  ])
    it(`ends the body before a line after ${name}`, () => {
      const main = `${head}let ch = "g:outer"\nlet n = 0, q\nfunction a() {\n  for (const ch of ["g:in"]) ${after}\n}\na()\n`;
      expect(rows(analyze({ "main.js": main })).filter((r) => r.startsWith("g:in"))).toEqual([]);
    });
});
