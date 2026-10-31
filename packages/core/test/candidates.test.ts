import { describe, expect, it } from "vitest";
import { Constants, resolveAliases } from "../src/javascript/aliases.js";
import { findCandidates, resolvePending } from "../src/javascript/candidates.js";
import { scanJavaScript, tokenize } from "../src/javascript/scan.js";
import { timeLimit } from "./timeLimit.js";

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
    expect(performance.now() - started).toBeLessThan(timeLimit(15_000));
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

  it("reads constants of modules a bundler wrapped into the file", () => {
    const helpers = [
      "var __commonJS = (cb, mod) => function __require() { return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports; };",
      'var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target, mod));',
    ];
    const readable = find(
      [
        ...helpers,
        'var require_endpoints = __commonJS({ "src/endpoints.js"(exports) { exports.API = exports.FEED = void 0; exports.API = "https://api.example/v2"; exports.FEED = "https://feed.example/latest.json"; } });',
        'var require_config = __commonJS({ "src/config.js"(exports, module) { module.exports = { CDN: "https://cdn.example/plugins" }; } });',
        "var import_endpoints = __toESM(require_endpoints());",
        "var { CDN } = require_config();",
        "var ApiClient = class {",
        "  constructor(base) { this.base = base; }",
        "  get(path) { return fetch(`${this.base}${path}`); }",
        "};",
        "var api = new ApiClient(import_endpoints.API);",
        'api.get("/me");',
        "fetch(import_endpoints.FEED);",
        "fetch(`${CDN}/${id}/plugin.zip`);",
      ].join("\n"),
    );
    expect(show(readable.endpoints)).toEqual([
      "fetch https://api.example/v2/me [inferred]",
      "fetch https://feed.example/latest.json [inferred]",
      "fetch https://cdn.example/plugins/${…}/plugin.zip [template]",
    ]);
    // the same once minified: helpers recognised by what they do, several patterns per statement
    const minified = find(
      [
        "var y=(t,e)=>()=>{try{return e||t((e={exports:{}}).exports,e),e.exports}catch(n){throw e=0,n}};",
        'var S=(t,e,n)=>(n=t!=null?_(U(t)):{},$(e||!t||!t.__esModule?L(n,"default",{value:t,enumerable:!0}):n,t));',
        'var E=y(c=>{c.API=void 0;c.API="https://api.example/v2"});',
        'var W=y((c,m)=>{m.exports={CDN:"https://cdn.example/plugins"}});',
        "var r=S(E()),{CDN:ce}=W();",
        "fetch(`${r.API}/rooms`);fetch(`${ce}/x.zip`);",
      ].join("\n"),
    );
    expect(show(minified.endpoints)).toEqual([
      "fetch https://api.example/v2/rooms [inferred]",
      "fetch https://cdn.example/plugins/x.zip [inferred]",
    ]);
  });

  it("reads addresses passed to the methods of a helper object, and built with new URL", () => {
    const found = find(
      [
        'const EMBED_BASE = "https://embed.example";',
        "const http = {",
        "  async getJson(url) { const r = await fetch(url, { headers: {} }); return r.json(); },",
        '  postJson: (url, body) => fetch(url, { method: "POST", body }),',
        "};",
        'function changelog() { return http.getJson("https://api.example/v1/changelog"); }',
        'function feedback(text) { return http.postJson("https://api.example/v1/feedback", { text }); }',
        // a bare call of the same name is another function, not the helper's method
        'function getJson(x) { return x; }\ngetJson("not an address");',
        "async function embedFor(link) {",
        '  const url = new URL("/oembed", EMBED_BASE);',
        '  url.searchParams.set("url", link);',
        "  return fetch(url);",
        "}",
      ].join("\n"),
    );
    expect(show(found.endpoints)).toEqual([
      "fetch https://api.example/v1/changelog [inferred]",
      "fetch POST https://api.example/v1/feedback [inferred]",
      "fetch https://embed.example/oembed [inferred]",
    ]);
  });

  it("refers to a key of another module's object until that module is read", () => {
    const [row] = find('import { links } from "./endpoints.js";\nfetch(links.upload);').endpoints;
    expect(
      resolvePending(row!, (s, p) =>
        s === "./endpoints.js" && p === "links.upload" ? "https://files.example/up" : null,
      ),
    ).toMatchObject({
      value: "https://files.example/up",
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

describe("storage through helpers", () => {
  it("reads keys a helper object builds from its callers, and keys written as properties", () => {
    const found = find(
      [
        'const PREF_PREFIX = "inkwell.";',
        "const prefs = {",
        "  get(name, fallback) { const raw = localStorage.getItem(PREF_PREFIX + name); return raw ?? fallback; },",
        "  set(name, value) { localStorage.setItem(PREF_PREFIX + name, JSON.stringify(value)); },",
        "};",
        // `prefs.set(…)` is a call on the helper, not a change of what `prefs` is
        'prefs.set("theme", theme);',
        'restore(prefs.get("theme", "light"));',
        "if (localStorage.sidebarWidth) width(localStorage.sidebarWidth);",
        "localStorage.sidebarWidth = String(w);",
        "localStorage.clear();",
      ].join("\n"),
    );
    expect(show(found.storage)).toEqual([
      "localStorage read inkwell.theme [inferred]",
      "localStorage write inkwell.theme [inferred]",
      "localStorage read sidebarWidth [literal]",
      "localStorage write sidebarWidth [literal]",
    ]);
  });

  it("reads a key a bundled module defines with var and exports as an object", () => {
    const found = find(
      [
        "var __commonJS = (cb, mod) => function __require() { return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports; };",
        'var require_defaults = __commonJS({ "src/defaults.js"(exports2, module2) { var RECENT_KEY = "inkwell.recent"; var count = 0; count++; module2.exports = { RECENT_KEY, count }; } });',
        "var { RECENT_KEY, count } = require_defaults();",
        "localStorage.getItem(RECENT_KEY);",
        // a local that changes (`count++`) is not followed
        "localStorage.getItem(`n${count}`);",
      ].join("\n"),
    );
    expect(show(found.storage)).toEqual([
      "localStorage read inkwell.recent [inferred]",
      "localStorage read n${…} [template]",
    ]);
  });
});

const rows = (source: string): string[] =>
  find(source).storage.map(
    (r) =>
      `${r.kind} ${r.op} ${r.value ?? `?${r.expression}`} [${r.evidence}]${r.via ? ` via ${r.via}` : ""} @${r.line}:${r.column}`,
  );

describe("storage through wrapper methods and enums", () => {
  // Electron Fiddle's AppState as webpack and terser emit it: a TypeScript string enum in one
  // module, announced in tsc's export chain; the class as `exports.AppState = class {…}` in another
  const enumModule =
    '33271(e,t){"use strict";var u,h;Object.defineProperty(t,"__esModule",{value:!0}),t.WindowSpecificSetting=t.GlobalSetting=t.PACKAGE_NAME=void 0,t.PACKAGE_NAME="package.json",function(e){e.theme="theme",e.isUsingSocketFirewall="isUsingSocketFirewall",e.knownVersion="known-electron-versions"}(u||(t.GlobalSetting=u={})),function(e){e.version="version"}(h||(t.WindowSpecificSetting=h={}))},';
  const fiddle = (body: string[]): string =>
    [
      "(()=>{var __webpack_modules__={",
      enumModule,
      "500(e,t,n){const c=n(33271);t.AppState=class{theme=localStorage.getItem(c.GlobalSetting.theme);",
      ...body,
      'save(e,t){if(null!=t){const n="object"==typeof t?JSON.stringify(t):t.toString();localStorage.setItem(e,n)}else localStorage.removeItem(e)}retrieve(e){const t=localStorage.getItem(e);return JSON.parse(t||"null")}}},',
      "};})();",
    ].join("\n");

  it("reads keys a method passes on, at each call of the method, with the enum member named there", () => {
    expect(
      rows(
        fiddle([
          "isUsingSocketFirewall=this.retrieve(c.GlobalSetting.isUsingSocketFirewall);",
          "setFirewall(e){this.isUsingSocketFirewall=e,this.save(c.GlobalSetting.isUsingSocketFirewall,e)}",
          "known(){return this.retrieve(c.GlobalSetting.knownVersion)}",
          "setVersion(e){this.save(c.WindowSpecificSetting.version,e)}",
        ]),
      ),
    ).toEqual([
      "localStorage read theme [inferred] @3:52",
      "localStorage write isUsingSocketFirewall [inferred] via AppState.save @5:50",
      "localStorage write version [inferred] via AppState.save @7:20",
      "localStorage delete isUsingSocketFirewall [inferred] via AppState.save @5:50",
      "localStorage delete version [inferred] via AppState.save @7:20",
      "localStorage read isUsingSocketFirewall [inferred] via AppState.retrieve @4:28",
      "localStorage read known-electron-versions [inferred] via AppState.retrieve @6:21",
    ]);
  });

  it("keeps the unread row when a call site passes a key it cannot read, and never guesses", () => {
    expect(
      rows(
        fiddle([
          "a(){this.retrieve(c.GlobalSetting.theme)}",
          // computed at run time: no key
          "b(e){return this.retrieve(e+Math.random())}",
          // a member the enum does not have
          "d(){return this.retrieve(c.GlobalSetting.missing)}",
        ]),
      ),
    ).toEqual([
      "localStorage read theme [inferred] @3:52",
      "localStorage write ?e [unknown] @7:81",
      "localStorage delete ?e [unknown] @7:112",
      "localStorage read theme [inferred] via AppState.retrieve @4:10",
      "localStorage read ?e [unknown] @7:159",
    ]);
  });

  it("does not take a call of another class's method of the same name for the wrapper", () => {
    expect(
      rows(
        [
          'class Prefs { load() { return this.read("prefs.ui"); } read(key) { return localStorage.getItem(key); } }',
          'class Doc { open() { this.read("not-a-key"); } read(path) { return path; } }',
          'function put(name, v) { localStorage.setItem("app." + name, v); }',
          'put("zoom", 1);',
          'const K = "tab"; put(K, 2);',
          // an object of helpers in a minifier's declaration list; a parameter of the same name
          // in another function is another object, and its call no call of the helper
          'var a=1,c={get:t=>sessionStorage.getItem(t)};c.get("pane");function f(c){c.get("nope")}',
          // a prefix the wrapper adds that cannot be read: no `${…}theme` key, the unread row
          'function pref(n) { return localStorage.getItem(prefix() + n); } pref("theme");',
        ].join("\n"),
      ),
    ).toEqual([
      "localStorage read prefs.ui [inferred] via Prefs.read @1:36",
      "localStorage write app.zoom [inferred] via put @4:1",
      "localStorage write app.tab [inferred] via put @5:18",
      "sessionStorage read pane [inferred] via c.get @6:48",
      "localStorage read ?<expression> [unknown] @7:27",
    ]);
  });

  it("reads an enum member only where the enum's name means the enum", () => {
    // a second binding of the name makes it ambiguous: nothing is read through it
    expect(
      rows(
        [
          '(function (S) { S.theme = "theme"; })(Setting || (exports.Setting = Setting = {}));',
          'var Setting; Setting = { theme: "other" };',
          "localStorage.getItem(Setting.theme);",
        ].join("\n"),
      ),
    ).toEqual(["localStorage read ?<expression> [unknown] @3:1"]);
  });

  it("takes a call for the wrapper's only where the name means the wrapper there (R3)", () => {
    const cases: Array<[string, string[]]> = [
      // H1: another class's method of the same name, classes written as `t.Name = class`
      [
        '1(e,t){t.AppState=class{save(e,n){localStorage.setItem(e,n)}}},\n2(e,t){t.Doc=class{save(e){return e}run(){this.save("not-a-storage-key")}}}',
        ["localStorage write ?e [unknown] @1:35"],
      ],
      [
        'class A{ get(k){ return localStorage.getItem(k) } } class B{ get(k){ return k } run(){ this.get("not-a-key-B") } }',
        ["localStorage read ?k [unknown] @1:25"],
      ],
      // M1: `this` inside an object literal's method, or inside a plain function, is not the class
      [
        'class A{ save(k){ localStorage.setItem(k,1) } m(){ const o = { save(z){ return z }, f(){ this.save("not-a-key") } }; o.f(); } }',
        ["localStorage write ?k [unknown] @1:19"],
      ],
      [
        'class A{ save(k){ localStorage.setItem(k,1) } m(){ [1].forEach(function(){ this.save("not-a-key-fn") }); } }',
        ["localStorage write ?k [unknown] @1:19"],
      ],
      // ... but inside an arrow function it is
      [
        'class A{ save(k){ localStorage.setItem(k,1) } m(){ [1].forEach(() => this.save("arrow-ok")); } }',
        ["localStorage write arrow-ok [inferred] via A.save @1:75"],
      ],
      // M2: a name assigned again, bound by catch or for-of, or a property `exports.save`
      [
        'let put = function(n){ localStorage.setItem(n, 1) };\nput("a");\nput = function(p){ return p };\nput("not-a-key");',
        ["localStorage write ?n [unknown] @1:24"],
      ],
      [
        'function put(n){ localStorage.setItem(n,1) }\nput("a");\ntry{}catch(put){ put("nope-catch") }',
        ["localStorage write a [inferred] via put @2:1"],
      ],
      [
        'function put(n){ localStorage.setItem(n,1) }\nput("a");\nfor (const put of fns) put("nope-for");',
        ["localStorage write ?n [unknown] @1:18"],
      ],
      [
        'exports.save = function(k){ localStorage.setItem(k, 1) };\nfunction save(k){ return k }\nsave("not-a-key");',
        ["localStorage write ?k [unknown] @1:29"],
      ],
      // L1: an enum member written later; L2: an enum name read through an object that is no module
      [
        '(function (S) { S.theme = "theme"; })(Setting || (exports.Setting = Setting = {}));\nSetting.theme = "other";\nlocalStorage.getItem(Setting.theme);',
        ["localStorage read ?<expression> [unknown] @3:1"],
      ],
      [
        '(function (S) { S.theme = "theme"; })(Setting || (exports.Setting = Setting = {}));\nlocalStorage.getItem(other.Setting.theme);',
        ["localStorage read ?<expression> [unknown] @2:1"],
      ],
      [
        '(function (S) { S.theme = "theme"; })(Setting || (exports.Setting = Setting = {}));\nconst m = require("./s");\nlocalStorage.getItem(m.Setting.theme);',
        ["localStorage read theme [inferred] @3:1"],
      ],
    ];
    for (const [source, expected] of cases)
      expect([source, rows(source)]).toEqual([source, expected]);
    // the same rule for endpoints, which read helper parameters at their call sites as well
    const api =
      '1(e,t){t.Api=class{get(u){return fetch(u)}}},\n2(e,t){t.Doc=class{get(e){return e}run(){this.get("https://not.an.endpoint/")}}}';
    expect(find(api).endpoints.map((r) => r.value ?? `?${r.expression}`)).toEqual(["?u"]);
  });

  it("reads no call of a wrapper whose name is assigned as a member anywhere in the file", () => {
    const cls = 'class A{ save(k){ localStorage.setItem(k,1) } run(){ this.save("ka") } }\n';
    const obj = 'const prefs = { get(k){ return localStorage.getItem(k) } };\nprefs.get("kb");\n';
    // the wrapper itself, read while no member of its name is written
    expect(rows(cls)).toEqual(["localStorage write ka [inferred] via A.save @1:59"]);
    expect(rows(obj)).toEqual(["localStorage read kb [inferred] via prefs.get @2:7"]);
    for (const write of [
      "const a = new A(); a.save = (x)=>x;",
      'const a = new A(); a["save"] = (x)=>x;',
      "A.prototype.save = function(x){ return x };",
      'Object.defineProperty(a, "save", { value: (x)=>x });',
      "Object.assign(a, { save: (x)=>x });",
      "Object.assign(a, { save(x){ return x } });",
    ])
      expect([write, rows(cls + write)]).toEqual([
        write,
        ["localStorage write ?k [unknown] @1:19"],
      ]);
    for (const write of ["prefs.get = (x)=>x;", "Object.assign(prefs, { get: (x)=>x });"])
      expect([write, rows(obj + write)]).toEqual([write, ["localStorage read ?k [unknown] @1:32"]]);
    // a comparison is no write, nor is a value that is no function (an enum member, an icon)
    for (const other of [
      "if (a.save == null) f();",
      '(function (e) { e.save = "save"; })(K || (K = {}));',
      'Icon.save = new Icon("save", {});',
    ])
      expect([other, rows(cls + other)]).toEqual([
        other,
        ["localStorage write ka [inferred] via A.save @1:59"],
      ]);
  });

  it("reads module.Enum.MEMBER only through a module binding visible at the use (R3 N2)", () => {
    const E = '1(e,t){var u;t.Setting=void 0,function(e){e.theme="theme"}(u||(t.Setting=u={}))},\n';
    const cases: Array<[string, string[]]> = [
      // webpack's require parameter with a module id, and require("…")
      [
        `${E}3(e,t,n){const c=n(1);localStorage.getItem(c.Setting.theme)}`,
        ["localStorage read theme [inferred] @2:23"],
      ],
      [
        `${E}3(e,t){const c=require("./s");localStorage.getItem(c.Setting.theme)}`,
        ["localStorage read theme [inferred] @2:31"],
      ],
      // used in a function the module defines before the declaration, as webpack writes it
      [
        `${E}3(e,t,n){t.f=function(){return localStorage.getItem(r.Setting.theme)};const i=n(2),r=n(1)}`,
        ["localStorage read theme [inferred] @2:32"],
      ],
      // used at the module's own level before the declaration: not yet bound
      [
        `${E}3(e,t,n){localStorage.getItem(r.Setting.theme);const r=n(1)}`,
        ["localStorage read ?<expression> [unknown] @2:10"],
      ],
      // any other call is no module
      [
        `${E}3(e,t,n){const c=getConfig("x");localStorage.getItem(c.Setting.theme)}`,
        ["localStorage read ?<expression> [unknown] @2:33"],
      ],
      [
        `${E}3(e,t,n){const c=f(1);localStorage.getItem(c.Setting.theme)}`,
        ["localStorage read ?<expression> [unknown] @2:23"],
      ],
      // a parameter of the same name in another module, a binding assigned again
      [
        `${E}3(e,t,n){const c=n(1)},\n4(e,t){function f(c){return localStorage.getItem(c.Setting.theme)}}`,
        ["localStorage read ?<expression> [unknown] @3:29"],
      ],
      [
        `${E}3(e,t,n){let c=n(1);c=other;localStorage.getItem(c.Setting.theme)}`,
        ["localStorage read ?<expression> [unknown] @2:29"],
      ],
    ];
    for (const [source, expected] of cases)
      expect([source, rows(source)]).toEqual([source, expected]);
  });

  it("takes a member write of an unknown construction for a callable (R3 N3)", () => {
    const cls = 'class A{save(k){localStorage.setItem(k,1)} run(){this.save("ka")}}\n';
    for (const write of [
      'const a=new A(); a.save = new Proxy(other, {});\na.save("not-a-key-proxy");',
      'const a=new A(); a.save = new Function("x", "return x");',
      "const a=new A(); a.save = new Wrapper(f);",
    ])
      expect([write, rows(cls + write)]).toEqual([
        write,
        ["localStorage write ?k [unknown] @1:17"],
      ]);
    // a class's own static instances, as Monaco's icons are written (`e.save = new e("save", …)`)
    const own = 'var I=class{constructor(n){this.n=n}};I.save=new I("save");';
    expect(rows(cls + own)).toEqual(["localStorage write ka [inferred] via A.save @1:55"]);
  });

  it("does not take a static method for an instance method of the same class (R3 N4)", () => {
    const cases: Array<[string, string[]]> = [
      [
        'class A{static save(k){localStorage.setItem(k,1)} run(){this.save("not-static-call")}}',
        ["localStorage write ?k [unknown] @1:24"],
      ],
      [
        'class A{save(k){localStorage.setItem(k,1)} static run(){this.save("not-instance-call")}}',
        ["localStorage write ?k [unknown] @1:17"],
      ],
      [
        'class A{static save(k){localStorage.setItem(k,1)} static run(){this.save("static-ok")}}',
        ["localStorage write static-ok [inferred] via A.save @1:69"],
      ],
      [
        'class A{static x = this.save("static-field"); save(k){localStorage.setItem(k,1)}}',
        ["localStorage write ?k [unknown] @1:55"],
      ],
      [
        'class A{x = this.save("field-ok"); save(k){localStorage.setItem(k,1)}}',
        ["localStorage write field-ok [inferred] via A.save @1:18"],
      ],
    ];
    for (const [source, expected] of cases)
      expect([source, rows(source)]).toEqual([source, expected]);
  });

  it("follows no wrapper per call in a file with more functions than it follows wrappers for", () => {
    const source = [
      "function put(k) { localStorage.setItem(k, 1); }",
      'put("a");',
      ...Array.from({ length: 50_001 }, (_, i) => `function g${i}(a){return a}`),
    ].join("\n");
    const found = find(source);
    expect(found.wrappersSkipped).toBe(true);
    // no row per call: the resolver's own reading of the parameter, at the storage call
    expect(rows(source)).toEqual(["localStorage write a [inferred] @1:19"]);
    expect(find('function put(k) { localStorage.setItem(k, 1); }\nput("a");').wrappersSkipped).toBe(
      undefined,
    );
  });

  it("stays linear on many wrapper calls and long export chains", () => {
    const calls = 20_000;
    const source = [
      `exports.${Array.from({ length: 5000 }, (_, i) => `E${i}`).join("=exports.")}=void 0;`,
      '(function (S) { S.a = "a"; })(Setting || (exports.Setting = Setting = {}));',
      "class Store { save(k, v) { localStorage.setItem(k, v); } run() {",
      ...Array.from(
        { length: calls },
        (_, i) => `this.save(Setting.a, ${i}); this.save(x${i}, 1);`,
      ),
      "} }",
    ].join("\n");
    const started = performance.now();
    const found = find(source);
    // generous: the point is linear against quadratic, and test machines are busy
    expect(performance.now() - started).toBeLessThan(timeLimit(15_000));
    expect(found.storage.length).toBeLessThanOrEqual(2000);
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
      expect(performance.now() - started).toBeLessThan(timeLimit(15_000));
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

describe("IPC through esbuild's ES-module interop", () => {
  it("reads names a bundled ES module sets once and hands out through its namespace", () => {
    const source = [
      "var TIMER_PREFIX, Channel;",
      'var init_channels = __esm({ "src/ipc/channels.js"() { TIMER_PREFIX = "timer:"; Channel = Object.freeze({ TimerStart: "timer:start", ConfigGetSync: "config:get-sync" }); } });',
      "var Push;",
      'var init_events = __esm({ "src/ipc/events.js"() { (function(Push3) { Push3["MenuNewEntry"] = "menu:new-entry"; })(Push || (Push = {})); } });',
      "var ipc_exports = {};",
      "__export(ipc_exports, { Channel: () => Channel, ConfigSync: () => ConfigSync, Push: () => Push, TIMER_PREFIX: () => TIMER_PREFIX });",
      "var ConfigSync;",
      'var init_ipc = __esm({ "src/ipc/index.js"() { init_channels(); init_events(); ConfigSync = Channel.ConfigGetSync; } });',
      "var { Channel: Channel2, ConfigSync: ConfigSync2, Push: Push2, TIMER_PREFIX: TIMER_PREFIX2 } = (init_ipc(), __toCommonJS(ipc_exports));",
      'const { ipcRenderer } = require("electron");',
      "ipcRenderer.invoke(Channel2.TimerStart);",
      "ipcRenderer.sendSync(ConfigSync2);",
      "ipcRenderer.on(Push2.MenuNewEntry, f);",
      "ipcRenderer.on(`${TIMER_PREFIX2}tick`, f);",
    ].join("\n");
    expect(ipc(source)).toEqual([
      "ipcRenderer.invoke timer:start (constant)",
      "ipcRenderer.sendSync config:get-sync (constant)",
      "ipcRenderer.on menu:new-entry (constant)",
      "ipcRenderer.on timer:tick (constant)",
    ]);
  });
});

const each = (lines: string[]): string[] => lines.flatMap((l) => show(find(l).endpoints));

describe("a URL argument derived from a string (#196)", () => {
  // one file per call: rows of the same value fold into one
  it("never takes the receiver's text for a method or member of it", () => {
    expect(
      each([
        "fetch(`https://api.x.com/${p}`.replace(/api/, p));",
        'fetch("https://api.x.com/".replace("api.x.com", p));',
        'fetch(`https://api.x.com/${p}`.replaceAll("api.x.com", p));',
        "fetch(`https://api.x.com/${p}`.slice(8));",
        'fetch("https://api.x.com/".concat(p));',
        'fetch("https://api.x.com/"[0]);',
        'fetch("https://api.x.com/" + "v1/".replace("v1", p));',
      ]),
    ).toEqual([
      "fetch ?<expression> [unknown]",
      "fetch ?<expression> [unknown]",
      "fetch ?<expression> [unknown]",
      "fetch ?<expression> [unknown]",
      "fetch ?<expression> [unknown]",
      "fetch ?<expression> [unknown]",
      // a later part derived: its own place is computed, the text before it stays
      "fetch https://api.x.com/${…} [template]",
    ]);
  });

  it("still reads the same strings when nothing is called on them", () => {
    expect(each(['fetch("https://api.x.com/" + p);', "fetch(`https://api.x.com/${p}`);"])).toEqual([
      "fetch https://api.x.com/${…} [template]",
      "fetch https://api.x.com/${…} [template]",
    ]);
  });
});

/** The endpoints of `get(p)` making the request \`call\`, called n times with its own literal. */
const helper = (n: number, call: string) =>
  find(
    [
      `function get(p) { return ${call}; }`,
      ...Array.from({ length: n }, (_, i) => `get("v${i}");`),
    ].join("\n"),
  ).endpoints;

describe("a request helper called more often than its call sites are read", () => {
  for (const [name, call] of [
    ["fetch", 'fetch("https://api.example.com/" + p)'],
    ["WebSocket", 'new WebSocket("wss://live.example.com/" + p)'],
  ] as const)
    it(`${name}: past 64 sites the values read come with an unknown row`, () => {
      const at64 = helper(64, call);
      expect(at64.length).toBe(64);
      expect(at64.filter((r) => r.value === null)).toEqual([]);
      const at70 = helper(70, call);
      expect(at70.filter((r) => r.value !== null).length).toBe(64);
      expect(at70.filter((r) => r.value === null)).toMatchObject([
        { evidence: "unknown", line: 1 },
      ]);
    });
});
