import { describe, expect, it } from "vitest";
import { Constants, resolveAliases } from "../src/javascript/aliases.js";
import { findCandidates, resolvePending } from "../src/javascript/candidates.js";
import { scanJavaScript, tokenize } from "../src/javascript/scan.js";

const known = (specifier: string, property: string): string | null =>
  specifier === "./net.js" && property === "API" ? "https://api.example/v2" : null;
const config = (specifier: string, property: string): string | null =>
  specifier === "./config" && property === "UPDATES_URL"
    ? "https://updates.example/feed.json"
    : null;
const ipc = (source: string): string[] =>
  scanJavaScript(source).ipc.map((u) => `${u.api} ${u.channel}${u.via ? ` (${u.via})` : ""}`);
const find = (source: string) => findCandidates(tokenize(source).tokens, source);
const show = (rows: ReturnType<typeof find>["endpoints"]): string[] =>
  rows.map(
    (r) =>
      `${r.kind}${r.method ? ` ${r.method}` : ""}${r.op ? ` ${r.op}` : ""} ${r.value ?? `?${r.expression}`} [${r.evidence}]`,
  );

describe("endpoints", () => {
  it("reads the URL of a request and says how it was obtained", () => {
    const found = find(
      [
        'const BASE = "https://api.example";',
        'fetch("https://api.example/items");',
        "fetch(`${BASE}/users/${id}`);",
        'fetch(BASE + "/orders/" + id);',
        "fetch(url);",
        'fetch("https://api.example/save", { method: "post", body });',
        'axios.post("/login", body);',
        'new WebSocket("wss://live.example/socket");',
        'new EventSource("https://live.example/events");',
        'navigator.sendBeacon("https://stats.example/hit", data);',
        "const xhr = new XMLHttpRequest();",
        'xhr.open("PUT", "https://upload.example/blob");',
        'net.request({ method: "DELETE", url: "https://api.example/item/1" });',
        'const request = fetch; request("https://alias.example/ping");',
      ].join("\n"),
    );
    expect(show(found.endpoints)).toEqual([
      "fetch https://api.example/items [literal]",
      "fetch https://api.example/users/${…} [template]",
      "fetch https://api.example/orders/${…} [template]",
      "fetch ?url [unknown]",
      "fetch POST https://api.example/save [literal]",
      "http-client POST /login [literal]",
      "websocket wss://live.example/socket [literal]",
      "event-source https://live.example/events [literal]",
      "beacon POST https://stats.example/hit [literal]",
      "xhr PUT https://upload.example/blob [literal]",
      "http-client DELETE https://api.example/item/1 [inferred]",
      "fetch https://alias.example/ping [inferred]",
    ]);
    expect(found.endpoints[0]).toMatchObject({ line: 2, column: 1, count: 1 });
  });

  it("does not take a look-alike for a request", () => {
    const found = find(
      [
        '// fetch("https://ghost.example/comment");',
        "const text = \"use fetch('https://ghost.example/string') to load\";",
        'const DOCS = "https://docs.example/help";',
        'router.get("/local/route", handler);',
        'cache.fetch("items");',
        'const notFetch = lookup; notFetch("https://ghost.example/not-fetch");',
        'store.open("GET", "https://ghost.example/not-xhr");',
        "const api = { fetch(key) { return map.get(key); } };",
        "function fetch(resource) { return resource; }",
        'params.get("https");',
      ].join("\n"),
    );
    expect(found.endpoints).toEqual([]);
    // a URL that only occurs as a string is listed apart, never as an endpoint
    expect(found.urls.map((u) => u.value)).toEqual([
      "https://docs.example/help",
      "https://ghost.example/not-fetch",
      "https://ghost.example/not-xhr",
    ]);
  });

  it("counts repeats instead of listing them, and stays linear on hostile input", () => {
    const found = find('fetch("/a");\n'.repeat(3));
    expect(found.endpoints).toHaveLength(1);
    expect(found.endpoints[0]?.count).toBe(3);
    const started = performance.now();
    const hostile = find(`${"fetch(`${a}".repeat(50_000)}`);
    // generous: the point is linear against quadratic, and test machines are busy
    expect(performance.now() - started).toBeLessThan(15_000);
    expect(hostile.endpoints.length).toBeLessThanOrEqual(2000);
  });

  it("fills in a constant of another module when that module is known", () => {
    const source = 'import { API } from "./net.js";\nfetch(`${API}/rooms`);\nfetch(API);';
    const [room, bare] = find(source).endpoints;
    expect(resolvePending(room!, known)).toMatchObject({
      value: "https://api.example/v2/rooms",
      evidence: "inferred",
    });
    expect(resolvePending(bare!, known)).toMatchObject({ value: "https://api.example/v2" });
    // while the module is unread the known part is kept and the rest is marked
    expect(resolvePending(room!, () => null)).toMatchObject({
      value: "${…}/rooms",
      evidence: "template",
    });
    expect(resolvePending(bare!, () => null)).toMatchObject({ value: null, evidence: "unknown" });
  });

  it("reads an address passed in by the callers of the function that makes the request", () => {
    const found = find(
      [
        'function sync(base) { return fetch(base + "/notes/sync"); }',
        'sync("https://api.example/v1");',
        "class ApiClient {",
        "  constructor(baseUrl) { this.baseUrl = baseUrl; }",
        "  request(path, init = {}) { return fetch(`${this.baseUrl}${path}`, init); }",
        "  get(path) { return this.request(path); }",
        '  post(path, body) { return this.request(path, { method: "POST", body }); }',
        "}",
        'const api = new ApiClient("https://api.example/v2");',
        'api.get("/me/recommendations");',
        "api.post(`/me/likes/${trackId}`, {});",
      ].join("\n"),
    );
    expect(show(found.endpoints)).toEqual([
      "fetch https://api.example/v1/notes/sync [inferred]",
      "fetch https://api.example/v2/me/recommendations [inferred]",
      "fetch https://api.example/v2/me/likes/${…} [template]",
    ]);
  });

  it("fills in a member of a required module", () => {
    const [row] = find('const cfg = require("./config");\nfetch(cfg.UPDATES_URL);').endpoints;
    expect(resolvePending(row!, config)).toMatchObject({
      value: "https://updates.example/feed.json",
      evidence: "inferred",
    });
  });

  it("does not take a string a caller passes for an address unless it reads as one", () => {
    const found = find(
      [
        "function fail(message) { return fetch(message); }",
        'fail("invalid url");',
        'fail("Proxy response was not ok");',
      ].join("\n"),
    );
    expect(show(found.endpoints)).toEqual(["fetch ?message [unknown]"]);
  });
});

describe("storage", () => {
  it("reads keys with what is done to them", () => {
    const found = find(
      [
        'const Store = require("electron-store");',
        "const settings = new Store();",
        'const KEY = "session";',
        'localStorage.setItem("theme", "dark");',
        'localStorage.getItem("theme");',
        "sessionStorage.getItem(KEY);",
        'window.localStorage.removeItem("token");',
        "const ls = window.localStorage;",
        'ls.getItem("via-alias");',
        'localStorage["direct"] = "1";',
        'indexedDB.open("db", 2);',
        'indexedDB.deleteDatabase("old-db");',
        'document.cookie = "a=1";',
        'settings.set("window.bounds", b);',
        'settings.get("window.bounds");',
        '// localStorage.setItem("ghost", "1");',
        'custom.getItem("ghost-custom");',
        "localStorage.getItem(dynamicKey);",
      ].join("\n"),
    );
    expect(show(found.storage)).toEqual([
      "localStorage write theme [literal]",
      "localStorage read theme [literal]",
      "sessionStorage read session [inferred]",
      "localStorage delete token [literal]",
      "localStorage read via-alias [literal]",
      "localStorage write direct [literal]",
      "indexedDB db [literal]",
      "indexedDB delete old-db [literal]",
      "cookie write document.cookie [literal]",
      "electron-store write window.bounds [inferred]",
      "electron-store read window.bounds [inferred]",
      "localStorage read ?dynamicKey [unknown]",
    ]);
  });
});

describe("names and scope", () => {
  const targets = new Set(["ipcMain", "ipcRenderer", "fetch"]);
  const uses = (source: string, own: string[] = []): string[] => {
    const { tokens } = tokenize(source);
    return [...resolveAliases(tokens, targets, new Set(own))].map(
      ([k, v]) => `${tokens[k]!.value}@${tokens[k]!.line}=${v}`,
    );
  };

  it("follows another name for a known object", () => {
    expect(
      uses(
        [
          'const { ipcMain: bus, app } = require("electron");',
          "const ipc = ipcRenderer;",
          "var s = e.ipcRenderer;",
          'import { ipcMain as im } from "electron";',
          'bus.handle("a"); ipc.send("b"); s.invoke("c"); im.on("d");',
        ].join("\n"),
      ),
    ).toEqual(["bus@5=ipcMain", "ipc@5=ipcRenderer", "s@5=ipcRenderer", "im@5=ipcMain"]);
  });

  it("follows a chain of names as a minifier writes it", () => {
    // `o` is ipcRenderer and also an imported name of the file; `a` is another name for `o`
    const source =
      'var{contextBridge:p,ipcRenderer:o}=require("electron"),s=i(),a=o;p.exposeInMainWorld("n",{r:(e,n)=>a.invoke("doc:rename",e,n),q:e=>o.send("app:ping")});';
    expect(scanJavaScript(source).ipc.map((u) => `${u.api} ${u.channel}`)).toEqual([
      "contextBridge.exposeInMainWorld n",
      "ipcRenderer.invoke doc:rename",
      "ipcRenderer.send app:ping",
    ]);
  });

  it("does not take a local of the same name for the alias", () => {
    // minified shape: `n` is ipcMain at the top, and a parameter inside the functions
    const source = [
      'const { ipcMain: n } = require("electron");',
      'n.handle("real", () => 1);',
      'function f(n) { n.on("data", g); }',
      'const h = (n) => n.on("arrow-param");',
      'const k = (a, n) => { n.once("block-param"); };',
      'for (const n of streams) { n.on("loop"); }',
      'try { x(); } catch (n) { n.on("catch"); }',
      '{ const n = make(); n.on("inner-const"); }',
      'n.on("real-again", () => 2);',
    ].join("\n");
    expect(uses(source)).toEqual(["n@2=ipcMain", "n@9=ipcMain"]);
    expect(scanJavaScript(source).ipc.map((u) => `${u.api} ${u.channel}`)).toEqual([
      "ipcMain.handle real",
      "ipcMain.on real-again",
    ]);
  });

  it("stays fast on deeply nested and repetitive input", () => {
    for (const hostile of [
      "{".repeat(200_000),
      `const x = 1;${"{x.a();".repeat(50_000)}`,
      "(a)=>".repeat(100_000),
      "const a = b(".repeat(50_000),
    ]) {
      const started = performance.now();
      const { tokens } = tokenize(hostile);
      resolveAliases(tokens, targets, new Set(["x"]));
      // eslint-disable-next-line no-new
      new Constants(tokens);
      // generous: the point is linear against quadratic, and test machines are busy
      expect(performance.now() - started).toBeLessThan(15_000);
    }
  });

  it("reads string constants only from the top level of a file", () => {
    const source = [
      'const SAVE = "doc:save";',
      'const CH = { OPEN: "doc:open", "quoted-key": "doc:quoted" };',
      'function inner() { const e = "wrong"; return e; }',
      "ipcMain.handle(SAVE, a);",
      "ipcMain.handle(CH.OPEN, b);",
      "function g(e) { ipcMain.on(e, c); }",
      "function shadow(SAVE) { ipcMain.on(SAVE, d); }",
    ].join("\n");
    expect(scanJavaScript(source).ipc.map((u) => `${u.channel} ${u.via ?? "literal"}`)).toEqual([
      "doc:save constant",
      "doc:open constant",
      "null literal",
      "null literal",
    ]);
  });
});

describe("IPC through indirection", () => {
  it("follows helpers that pass their first argument on as the channel", () => {
    expect(
      ipc(
        [
          "function route(channel, fn) { ipcMain.handle(channel, (_e, ...a) => fn(...a)); }",
          "const call = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);",
          "const emit = ipcRenderer.send.bind(ipcRenderer);",
          "function broadcast(channel, payload) { for (const w of all()) w.webContents.send(channel, payload); }",
          'route("rooms:list", list);',
          'const api = { list: call("rooms:list") };',
          'emit("telemetry:hit", {});',
          'broadcast("presence:update", {});',
          // not helpers: nothing is forwarded
          "function log(message) { console.log(message); }",
          'log("ghost:log");',
          // the channel as the second parameter: read through the call site (resolve.ts)
          "function later(fn, channel) { ipcMain.on(channel, fn); }",
          'later(g, "second:parameter");',
          // a parameter of the same name hides the helper
          'function other(route) { route("ghost:shadowed"); }',
        ].join("\n"),
      ).filter((line) => !line.endsWith(" null")),
    ).toEqual([
      "ipcMain.handle rooms:list (wrapper)",
      "ipcRenderer.invoke rooms:list (wrapper)",
      "ipcRenderer.send telemetry:hit (wrapper)",
      "webContents.send presence:update (wrapper)",
      "ipcMain.on second:parameter (resolved)",
    ]);
  });

  it("reads handlers registered from a table, and replies inside a listener", () => {
    expect(
      ipc(
        [
          'const handlers = { "rooms:join": join, "rooms:leave": leave, other() {} };',
          "for (const [channel, handler] of Object.entries(handlers)) ipcMain.handle(channel, handler);",
          'ipcMain.on("app:ping", (event) => { event.reply("app:pong"); event.sender.send("app:late"); });',
          "ipcMain.on(dynamic, () => {});",
        ].join("\n"),
      ),
    ).toEqual([
      "ipcMain.handle rooms:join (table)",
      "ipcMain.handle rooms:leave (table)",
      "ipcMain.handle other (table)",
      "ipcMain.on app:ping",
      "event.reply app:pong",
      "event.sender.send app:late",
      "ipcMain.on null",
    ]);
  });
});
