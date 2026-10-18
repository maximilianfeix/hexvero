/**
 * Requests made with an HTTP client module (`node:https`, `node:http`, Electron's `net`): the URL
 * is read like a fetch URL, also when it is a parameter of a wrapper, and a call whose URL cannot
 * be read is an unknown row. Case-study miss M3 (Electron Fiddle 0.39.0, the vendored `sfw.mjs`).
 */
import { buildSync } from "esbuild";
import { describe, expect, it } from "vitest";
import { findCandidates } from "../src/javascript/candidates.js";
import { tokenize } from "../src/javascript/scan.js";

const find = (source: string) => findCandidates(tokenize(source).tokens, source);
const show = (source: string): string[] =>
  find(source).endpoints.map(
    (r) =>
      `${r.kind}${r.method ? ` ${r.method}` : ""} ${r.value ?? `?${r.expression}`} [${r.evidence}]`,
  );

/** The source bundled by esbuild (node platform, CommonJS out), optionally minified. */
const bundle = (source: string, minify: boolean): string =>
  buildSync({
    stdin: { contents: source, loader: "js", resolveDir: process.cwd() },
    bundle: true,
    minify,
    platform: "node",
    format: "cjs",
    external: ["electron", "axios", "got", "ky", "needle", "superagent"],
    write: false,
    logLevel: "silent",
  }).outputFiles[0]!.text;

/** The request code of `sfw.mjs` (sfw 2.0.4), unminified, with its shape kept. */
const SFW = [
  'import kt from "node:https";',
  'import { URL as Nt } from "node:url";',
  "async function Mt(t, e = {}) {",
  "  const { headers: r = {}, maxRedirects: n = 5 } = e;",
  "  return new Promise((i, s) => {",
  "    const c = new Nt(t), a = { headers: { ...r } };",
  "    kt.get(c, a, (r) => {",
  "      const { statusCode: o, headers: c } = r;",
  "      return o >= 300 && c.location && n > 0 ? i(Mt(c.location, { ...e, maxRedirects: n - 1 })) : i(r);",
  '    }).on("error", s);',
  "  });",
  "}",
  "async function Rt(t, e = {}) {",
  "  const r = await async function (t, e = {}) {",
  "    const r = await Mt(t, e);",
  "    return r;",
  "  }(t, e);",
  "  return JSON.parse(r);",
  "}",
  "async function Gt() {",
  '  const t = await Rt("https://api.github.com/repos/SocketDev/sfw-free/releases/latest", { userAgent: "sfw" });',
  "  return t.tag_name;",
  "}",
  "Gt();",
].join("\n");

describe("HTTP client modules", () => {
  it("reads a literal, a constant and a template URL", () => {
    expect(
      show(
        [
          'const https = require("node:https");',
          'const h = require("http");',
          'const BASE = "https://api.example/v2";',
          'https.get("https://a.example/x", (res) => res.resume());',
          "h.request(`${BASE}/items`).end();",
          "https.get(`${BASE}/users/${id}`);",
        ].join("\n"),
      ),
    ).toEqual([
      "http-client GET https://a.example/x [literal]",
      "http-client https://api.example/v2/items [inferred]",
      "http-client GET https://api.example/v2/users/${…} [template]",
    ]);
  });

  it("keeps a client call whose URL cannot be read as an unknown row", () => {
    expect(
      show(
        [
          'import https from "node:https";',
          'const { net } = require("electron");',
          "https.get(process.env.FEED_URL);",
          "net.request(target);",
        ].join("\n"),
      ),
    ).toEqual(["http-client GET ?<expression> [unknown]", "http-client ?target [unknown]"]);
  });

  it("follows a URL parameter through wrappers to the call sites (sfw.mjs)", () => {
    // The redirect, `Mt(c.location, …)`, passes a run-time value: that call site keeps the
    // unknown row beside the address the other one gives.
    expect(show(SFW)).toEqual([
      "http-client GET https://api.github.com/repos/SocketDev/sfw-free/releases/latest [inferred]",
      "http-client GET ?c [unknown]",
    ]);
  });

  it("does not guess a wrapper's URL when a call site cannot be read", () => {
    expect(
      show(
        [
          'const https = require("https");',
          "function load(url) { return https.get(url); }",
          "load(process.argv[2]);",
        ].join("\n"),
      ),
    ).toEqual(["http-client GET ?url [unknown]"]);
  });

  it("reads an options object only when every part of the address is known", () => {
    expect(
      show(
        [
          'const https = require("https");',
          'const http = require("node:http");',
          'https.request({ hostname: "api.example", path: "/v1/items", method: "POST" });',
          'http.request({ host: "local.example", path: "/status" });',
          'https.request({ protocol: "https:", hostname: "p.example" });',
          'https.request({ hostname: host, path: "/v1/x" });',
          'https.request({ hostname: "port.example", port: 8443, path: "/" });',
          'https.request({ ...defaults, path: "/v1/y" });',
          "https.request(options);",
        ].join("\n"),
      ),
    ).toEqual([
      "http-client POST https://api.example/v1/items [inferred]",
      "http-client http://local.example/status [inferred]",
      "http-client https://p.example/ [inferred]",
      "http-client ?options.hostname [unknown]",
      "http-client ?options.port [unknown]",
      "http-client ?<options> [unknown]",
      "http-client ?options [unknown]",
    ]);
  });

  it("reads Electron's net through the module object and named functions", () => {
    expect(
      show(
        [
          'const electron = require("electron");',
          'const { get, request: send } = require("node:https");',
          'electron.net.request("https://n.example/feed");',
          'electron.net.request({ url: "https://n.example/post", method: "POST" });',
          'get("https://d.example/");',
          "send(u);",
        ].join("\n"),
      ),
    ).toEqual([
      "http-client https://n.example/feed [literal]",
      "http-client POST https://n.example/post [inferred]",
      "http-client GET https://d.example/ [literal]",
      "http-client ?u [unknown]",
    ]);
  });

  it("does not take look-alikes for requests", () => {
    expect(
      show(
        [
          'const https = require("https");',
          "function get(u) { return cache[u]; }",
          "get(url);",
          "function viaParam(https, u) { return https.get(u); }",
          'viaParam(fake, "https://ghost.example/param");',
          'const { request } = require("./api");',
          "request(url);",
          'const api = require("./api");',
          "api.get(url);",
          'label.textContent = "https://shown.example/docs";',
          "console.log(`GET ${url}`);",
          "const o = { get(u) { return u; } };",
          "o.get(url);",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  for (const minify of [false, true])
    it(`reads the same requests in an esbuild bundle${minify ? ", minified" : ""}`, () => {
      const source = bundle(
        [
          'import https from "node:https";',
          'import { get } from "node:http";',
          'import { net } from "electron";',
          "export function check(u) { return https.get(u); }",
          'check("https://b.example/feed");',
          'get("http://named.example/status");',
          'net.request("https://e.example/ping");',
          "net.request(process.env.X);",
        ].join("\n"),
        minify,
      );
      expect(show(source)).toEqual([
        "http-client GET https://b.example/feed [inferred]",
        "http-client GET http://named.example/status [literal]",
        "http-client https://e.example/ping [literal]",
        "http-client ?<expression> [unknown]",
      ]);
      const sfw = show(bundle(SFW, minify));
      expect(sfw[0]).toBe(
        "http-client GET https://api.github.com/repos/SocketDev/sfw-free/releases/latest [inferred]",
      );
      expect(sfw.slice(1)).toEqual([expect.stringMatching(/^http-client GET \?\w+ \[unknown\]$/)]);
    });

  it("does not take a function passed to a call for an immediately called one", () => {
    const H = 'const https = require("https");\n';
    expect(
      show(H + 'foo(function (u) { https.get(u); })("https://not-the-arg.example/");'),
    ).toEqual(["http-client GET ?u [unknown]"]);
    expect(show(H + 'foo((u) => https.get(u))("https://not-the-arg-arrow.example/");')).toEqual([
      "http-client GET ?u [unknown]",
    ]);
    expect(show(H + '(function (u) { https.get(u); })("https://iife-real.example/");')).toEqual([
      "http-client GET https://iife-real.example/ [inferred]",
    ]);
    expect(show(H + '!function (u) { https.get(u); }("https://iife-bang.example/");')).toEqual([
      "http-client GET https://iife-bang.example/ [inferred]",
    ]);
    expect(show(H + '((u) => https.get(u))("https://iife-arrow.example/");')).toEqual([
      "http-client GET https://iife-arrow.example/ [inferred]",
    ]);
  });

  it("does not take another binding of the client's name for the client", () => {
    const H = 'const https = require("https");\n';
    for (const source of [
      'const { get } = require("https");\nfunction f(o) { const { get } = o; get("https://other-get.example/"); }',
      'const { get } = require("https");\nfunction f(o) { const [get] = o; get("https://other-get.example/"); }',
      H +
        'function f(o) { { const { https } = o; https.get("https://fake-destructure.example/"); } }',
      H +
        'function f(o) { const { https } = o; return () => https.get("https://fake-destructure2.example/"); }',
      H + 'for (const https of mirrors) https.get("https://fake-forof.example/");',
      H + 'try { x(); } catch (https) { https.get("https://fake-catch.example/"); }',
      H + 'class A { https = makeFake(); run() { this.https.get("https://via-this.example/"); } }',
      // name-only, without a binding to the module
      'function f(o) { { const { https } = o; https.get("https://fake-destructure.example/"); } }',
      'for (const https of mirrors) https.get("https://fake-forof.example/");',
      'class A { run() { this.https.get("https://via-this.example/"); } }',
    ])
      expect(show(source)).toEqual([]);
    // the client itself, in a block of its own scope, is still read
    expect(show(H + '{ https.get("https://real.example/a"); }')).toEqual([
      "http-client GET https://real.example/a [literal]",
    ]);
  });

  it("keeps the client's requests where another binding of its name is elsewhere", () => {
    const H = 'const https = require("https");\n';
    const cases: Array<[string, string[]]> = [
      [
        H +
          'function a() { const https = fake; return https; }\nhttps.get("https://real-otherfn.example/");',
        ["http-client GET https://real-otherfn.example/ [literal]"],
      ],
      [
        H +
          'function f() { { let https = fake; } https.get("https://real-after-block.example/"); }',
        ["http-client GET https://real-after-block.example/ [literal]"],
      ],
      [
        H +
          'if (x) { const https = fake; https.get("https://fake-inblock.example/") } https.get("https://real-after-if.example/");',
        ["http-client GET https://real-after-if.example/ [literal]"],
      ],
      [
        H + 'function f(){{const https=fake}https.get("https://real-edge.example/")}',
        ["http-client GET https://real-edge.example/ [literal]"],
      ],
      [
        H + 'function f(){https.get("https://real-before.example/");{const https=fake}}',
        ["http-client GET https://real-before.example/ [literal]"],
      ],
      [
        H +
          'class A { https = fake; m() { return https.get("https://real-classfield.example/"); } }',
        ["http-client GET https://real-classfield.example/ [literal]"],
      ],
      [
        H + 'class A { https = 1 }\nhttps.get("https://real-classfield2.example/");',
        ["http-client GET https://real-classfield2.example/ [literal]"],
      ],
      [
        H +
          'const g = function https() { return 1; };\nhttps.get("https://real-after-fnexpr.example/");',
        ["http-client GET https://real-after-fnexpr.example/ [literal]"],
      ],
      [
        '1:function(e,t,n){const https=n(5);https.get("https://wp1.example/")},\n2:function(e,t,n){const https=require("https");https.get("https://wp2.example/")}',
        [
          "http-client GET https://wp1.example/ [literal]",
          "http-client GET https://wp2.example/ [literal]",
        ],
      ],
      [
        'const axios = require("axios");\nfunction t() { const axios = mock; }\naxios.get("https://axios-real.example/");',
        ["http-client GET https://axios-real.example/ [literal]"],
      ],
      [
        'let h = require("https");\nfunction t() { let h = 1; h = 2; }\nh.get("https://h-real.example/");',
        ["http-client GET https://h-real.example/ [literal]"],
      ],
      // shadowed where it is used: another object
      [H + 'function f(https, a = https.get("https://fake-param-default.example/")) {}', []],
      [H + 'function f() { https.get("https://fake-hoisted.example/"); var https = fake; }', []],
      [H + 'try {} catch (https) { https.get("https://fake-catch.example/"); }', []],
    ];
    for (const [source, rows] of cases) expect(show(source)).toEqual(rows);
  });

  it("does not fall back to the name rule for a reassigned client or another module (#157)", () => {
    const cases: Array<[string, string[]]> = [
      // reassigned where the call means the binding: which object is called is not known, an
      // unknown row instead of the address
      [
        'let h = require("https");\nh = fake;\nh.get("https://fake-reassigned.example/");',
        ["http-client GET ?<expression> [unknown]"],
      ],
      [
        'let https = require("https");\nhttps = fake;\nhttps.get("https://fake-reassigned.example/");',
        ["http-client GET ?<expression> [unknown]"],
      ],
      [
        'let h = require("https");\nh.get("https://real-before-reassign.example/");\nh = fake;',
        ["http-client GET ?<expression> [unknown]"],
      ],
      [
        'let h = require("https");\nh ??= fake;\nh.get("https://nullish.example/");',
        ["http-client GET ?<expression> [unknown]"],
      ],
      // every value assigned is a client module: still the client
      [
        'let https = require("https");\nif (x) https = require("http");\nhttps.get("https://either.example/");',
        ["http-client GET https://either.example/ [literal]"],
      ],
      [
        'let h = require("https");\nif (x) h = require("node:http");\nh.get("https://either2.example/");',
        ["http-client GET https://either2.example/ [literal]"],
      ],
      // a webpack module whose id is not known to be a client: an unknown row at most
      [
        '2:function(e,t,n){const r=require("https")},\n3:function(e,t,n){const r=n(7);r.request("https://fake-other-module.example/")}',
        ["http-client ?<expression> [unknown]"],
      ],
      // the module id is a client module of the same bundle: a request
      [
        '7:function(e){"use strict";e.exports=require("https")},\n2:function(e,t,n){const r=require("https")},\n3:function(e,t,n){const r=n(7);r.request("https://wp-known.example/")}',
        ["http-client https://wp-known.example/ [literal]"],
      ],
      [
        '{7(e){"use strict";e.exports=require("node:https")},3(e,t,n){const r=n(7);r.get("https://wp-known2.example/")},9(e){e.exports=require("https")}}',
        ["http-client GET https://wp-known2.example/ [literal]"],
      ],
      // the module id is known to be something else: no client
      [
        '7:function(e){e.exports=require("fs")},\n2:function(e,t,n){const r=require("https")},\n3:function(e,t,n){const r=n(7);r.request("https://fake-fs.example/")}',
        [],
      ],
      // a local bound to another module by require
      [
        'function a(){ const h = require("https"); h.get("https://real-a.example/"); }\nfunction b(){ const h = require("./cache"); return h.get("https://fake-cache.example/"); }',
        ["http-client GET https://real-a.example/ [literal]"],
      ],
      // a wrapper module under a client's own name stays a client by name (0.9.2)
      [
        'const axios = require("./http");\naxios.post("https://api.example/wrapped");',
        ["http-client POST https://api.example/wrapped [literal]"],
      ],
      // the client's own name stays a client by name (0.9.2), whatever module n(5) is
      [
        '1:function(e,t,n){const https=n(5);https.get("https://wp-n.example/")}',
        ["http-client GET https://wp-n.example/ [literal]"],
      ],
    ];
    for (const [source, rows] of cases) expect(show(source)).toEqual(rows);
  });

  it("reads calls past the check cap by the name rule, and folds unknown rows", () => {
    const source =
      'const https = require("https");\nfunction m() {\n' +
      Array.from({ length: 2100 }, (_, i) => `x.on(z${i}, () => https.get(x${i}));`).join("\n") +
      '\nhttps.get("https://after-cap.example/");\nhttps.request("https://after-cap-req.example/");\n}';
    const found = find(source);
    expect(found.clientsSkipped).toBe(true);
    expect(found.endpoints.filter((e) => e.value !== null).map((e) => e.value)).toEqual([
      "https://after-cap.example/",
      "https://after-cap-req.example/",
    ]);
    expect(found.endpoints.filter((e) => e.value === null).length).toBeLessThanOrEqual(201);
  });

  it("reads options merged over a URL only when every part they set is known", () => {
    const H = 'const https = require("https");\n';
    expect(
      show(
        [
          H + 'https.request("https://a.example/x?q=1", { hostname: "b.example" });',
          'https.request("https://a.example/x", { path: "/y", method: "POST" });',
          'https.request("https://a.example/x", { hostname: host });',
          'https.request("https://a.example/x", { port: 8443 });',
          'https.request("https://a.example/x", { ...defaults });',
          'https.request("https://a.example/x", { host: "b.example:99" });',
          'https.get("https://a.example/z", { headers: { accept: "json" } });',
          'https.request({ hostname: "a.example", defaultPort: 8443, path: "/p" });',
          'https.request({ hostname: "a.example", lookup: myLookup, path: "/p" });',
        ].join("\n"),
      ),
    ).toEqual([
      "http-client https://b.example/x?q=1 [inferred]",
      "http-client POST https://a.example/y [inferred]",
      "http-client ?options.hostname [unknown]",
      "http-client ?options.port [unknown]",
      "http-client ?<options> [unknown]",
      "http-client ?options.host [unknown]",
      "http-client GET https://a.example/z [literal]",
      "http-client ?options.defaultPort [unknown]",
      "http-client ?options.lookup [unknown]",
    ]);
  });

  it("reads new URL under an imported name only where that name means the import", () => {
    const head = 'const { URL: U } = require("url");\nconst https = require("https");\n';
    expect(show(head + 'https.get(new U("/x", "https://base.example/"));')).toEqual([
      "http-client GET https://base.example/x [inferred]",
    ]);
    expect(
      show(head + 'function f(U) { https.get(new U("/x", "https://base.example/")); }'),
    ).toEqual(["http-client GET ?<expression> [unknown]"]);
  });

  it("stays linear on many client calls (outer bindings, nesting, named functions, options)", () => {
    const n = 32_000;
    const shapes = [
      'const https = require("https");\nfunction mod() {\n' +
        Array.from({ length: n }, (_, i) => `https.get("https://h${i}.example/");`).join("\n") +
        "\n}",
      'const https = require("https");\n' +
        "function a() {".repeat(60) +
        Array.from({ length: 16_000 }, (_, i) => `https.get(x${i});`).join("\n") +
        "}".repeat(60),
      'const { get } = require("https");\nfunction mod() {\n' +
        Array.from({ length: n }, (_, i) => `get(y${i});`).join("\n") +
        "\n}",
      'const https = require("https");\nfunction mod() {\n' +
        Array.from({ length: n }, (_, i) => `https.request({ hostname: h${i}, path: "/" });`).join(
          "\n",
        ) +
        "\n}",
      Array.from({ length: n }, (_, i) => `function f${i}(https) { https.get(u${i}); }`).join("\n"),
    ];
    for (const source of shapes) {
      const started = performance.now();
      const found = find(source);
      // generous: the point is linear against quadratic, and test machines are busy
      expect(performance.now() - started).toBeLessThan(5_000);
      expect(found.endpoints.length).toBeLessThanOrEqual(2000);
    }
    const capped = find(shapes[0]!);
    expect(capped.clientsSkipped).toBe(true);
    // past the cap the literal addresses are still read, by the name rule
    expect(capped.endpoints).toHaveLength(2000);
    expect(capped.truncated).toBe(true);
  });

  it("stays linear on hostile input", () => {
    const n = 20_000;
    const source = [
      'const https = require("https");',
      ...Array.from(
        { length: n },
        (_, i) => `function w${i}(u) { return https.get(u); } w${i}(x${i});`,
      ),
      `https.request({ ${Array.from({ length: n }, (_, i) => `k${i}: "v"`).join(", ")} });`,
      "https.get(".repeat(n),
    ].join("\n");
    const started = performance.now();
    const found = find(source);
    // generous: the point is linear against quadratic, and test machines are busy
    expect(performance.now() - started).toBeLessThan(15_000);
    expect(found.endpoints.length).toBeLessThanOrEqual(2000);
  });
});

describe("request libraries, instances and Request objects", () => {
  it("reads direct calls of a request library bound by require or import", () => {
    expect(
      show(
        [
          'const axios = require("axios");',
          'const got = require("got");',
          'import ky from "ky";',
          'const needle = require("needle");',
          'const superagent = require("superagent");',
          'axios("https://ax.example/1");',
          'axios("https://ax.example/2", { method: "post", data });',
          'axios({ url: "https://ax.example/3", method: "PUT" });',
          'got("https://got.example/1");',
          'got("https://got.example/2", { method: "PATCH" });',
          'got({ url: "https://got.example/3" });',
          'ky("https://ky.example/1");',
          'needle("post", "https://needle.example/1", body);',
          'needle.request("put", "https://needle.example/2", body);',
          'superagent("DELETE", "https://sa.example/1");',
          'superagent("https://sa.example/2");',
        ].join("\n"),
      ),
    ).toEqual([
      "http-client GET https://ax.example/1 [literal]",
      "http-client POST https://ax.example/2 [literal]",
      "http-client PUT https://ax.example/3 [literal]",
      "http-client GET https://got.example/1 [literal]",
      "http-client PATCH https://got.example/2 [literal]",
      "http-client GET https://got.example/3 [literal]",
      "http-client GET https://ky.example/1 [literal]",
      "http-client POST https://needle.example/1 [literal]",
      "http-client PUT https://needle.example/2 [literal]",
      "http-client DELETE https://sa.example/1 [literal]",
      "http-client GET https://sa.example/2 [literal]",
    ]);
  });

  it("does not guess the method or the address of a direct call it cannot read", () => {
    expect(
      show(
        [
          'const axios = require("axios");',
          'const needle = require("needle");',
          "axios(url, config);",
          'axios("https://ax.example/cfg", cfg);',
          'axios({ url: "https://ax.example/spread", ...rest });',
          'axios("https://ax.example/o", { url: "https://other.example/" });',
          'axios("https://ax.example/b", { baseURL: "https://other.example/" });',
          'axios({ method: "POST" });',
          'needle(m, "https://needle.example/m");',
          // a name that is not bound to a library is not one (`got` is a common word)
          'function f() { const got = seen.get(x); got("https://not-a-client.example/"); }',
          'function g(axios) { const ky = mock; ky("https://not-ky.example/"); }',
        ].join("\n"),
      ),
    ).toEqual([
      "http-client ?url [unknown]",
      "http-client https://ax.example/cfg [literal]",
      "http-client ?<options> [unknown]",
      "http-client ?options.url [unknown]",
      "http-client ?options.baseURL [unknown]",
      "http-client POST ?options.url [unknown]",
      "http-client https://needle.example/m [literal]",
    ]);
  });

  it("joins an instance's base URL by each library's rule", () => {
    expect(
      show(
        [
          'const axios = require("axios");',
          'const got = require("got");',
          'const ky = require("ky");',
          'const BASE = "https://api.example/v1/";',
          "const api = axios.create({ baseURL: BASE });",
          'api.get("/users");',
          'api.post("items", body, { headers });',
          'api("https://other.example/abs");',
          'api({ url: "me", method: "delete" });',
          "api.get(`users/${id}`);",
          'const g = got.extend({ prefixUrl: "https://got.example/api" });',
          'g("users");',
          'g.post("/leading-slash");',
          'g.get("https://absolute.example/");',
          'const k = ky.create({ prefixUrl: "https://ky.example" });',
          'k.get("me");',
          'const k2 = ky.extend({ prefixUrl: "https://ky2.example/" });',
          'k2("me");',
        ].join("\n"),
      ),
    ).toEqual([
      "http-client GET https://api.example/v1/users [inferred]",
      "http-client POST https://api.example/v1/items [inferred]",
      "http-client GET https://other.example/abs [literal]",
      "http-client DELETE https://api.example/v1/me [inferred]",
      "http-client GET https://api.example/v1/users/${…} [template]",
      "http-client GET https://got.example/api/users [inferred]",
      "http-client POST ?<expression> [unknown]",
      "http-client GET ?<expression> [unknown]",
      "http-client GET https://ky.example/me [inferred]",
      "http-client GET https://ky2.example/me [inferred]",
    ]);
  });

  it("reads an instance only when its binding is proven and its base is one known string", () => {
    const H = 'const axios = require("axios");\n';
    const cases: Array<[string, string[]]> = [
      // written again: which object is called is not known
      [
        H +
          'let api = axios.create({ baseURL: "https://x.example" });\napi = mock;\napi.get("/p");',
        ["http-client GET ?<expression> [unknown]"],
      ],
      [
        H + 'const api = axios.create({ baseURL: process.env.API });\napi.get("/p");',
        ["http-client GET ?options.baseURL [unknown]"],
      ],
      [
        H + 'const api = axios.create({ baseURL: `${host}/v1` });\napi.get("/p");',
        ["http-client GET ?options.baseURL [unknown]"],
      ],
      [
        H +
          'const api = axios.create({ ...defaults, baseURL: "https://x.example" });\napi.get("/p");',
        ["http-client GET ?<options> [unknown]"],
      ],
      [
        H + 'const api = axios.create(config);\napi.get("/p");',
        ["http-client GET ?<options> [unknown]"],
      ],
      [
        H +
          'const api = axios.create({ baseURL: "https://x.example", allowAbsoluteUrls: false });\napi.get("/p");',
        ["http-client GET ?options.allowAbsoluteUrls [unknown]"],
      ],
      // a base given at the call replaces the instance's: not read
      [
        H +
          'const api = axios.create({ baseURL: "https://x.example" });\napi.get("/p", { baseURL: "https://y.example" });',
        ["http-client GET ?options.baseURL [unknown]"],
      ],
      // got refuses a prefix with a query; ky 2 has `prefix` and `baseUrl` instead
      [
        'const got = require("got");\nconst g = got.extend({ prefixUrl: "https://g.example/?a=1" });\ng.get("x");',
        ["http-client GET ?options.prefixUrl [unknown]"],
      ],
      [
        'const ky = require("ky");\nconst k = ky.create({ prefix: "https://k.example/" });\nk.get("x");',
        ["http-client GET ?options.prefix [unknown]"],
      ],
      // an instance of an instance: what it keeps is not read
      [
        'const ky = require("ky");\nconst k = ky.create({ prefixUrl: "https://k.example" });\nk.extend({ headers }).get("x");',
        ["http-client GET ?<expression> [unknown]"],
      ],
      // another binding of the name where it is used: another object
      [
        H +
          'const api = axios.create({ baseURL: "https://x.example" });\nfunction f(api) { return api.get("/param"); }',
        [],
      ],
      [
        H +
          'const api = axios.create({ baseURL: "https://x.example" });\nfunction f() { const api = other; api.get("/local"); }',
        [],
      ],
      // not a library: no instance
      [
        'const lib = require("./lib");\nconst api = lib.create({ baseURL: "https://x.example" });\napi.get("/p");',
        [],
      ],
      [H + 'const api = axios.extend({ baseURL: "https://x.example" });\napi.get("/p");', []],
      // made where it is used, and on `require("axios")` itself; the default method of the instance
      [
        H + 'axios.create({ baseURL: "https://c.example/api", method: "post" }).get("/x");',
        ["http-client GET https://c.example/api/x [inferred]"],
      ],
      [
        'const api = require("axios").create({ baseURL: "https://r.example", method: "post" });\napi("/y");',
        ["http-client POST https://r.example/y [inferred]"],
      ],
    ];
    for (const [source, rows] of cases) expect(show(source), source).toEqual(rows);
  });

  it("reads each module's instance where many modules of a bundle use the same name", () => {
    // every call is checked against the declarations in the functions around it only, so 300
    // modules with an `api` each stay within the 2,000 checks per file
    const n = 300;
    const source =
      'const axios = require("axios");\n' +
      Array.from(
        { length: n },
        (_, i) =>
          `function m${i}() { const api = axios.create({ baseURL: "https://h${i}.example" }); return api.get("/x"); }`,
      ).join("\n");
    const found = find(source);
    expect(found.clientsSkipped).toBeUndefined();
    expect(found.endpoints.map((e) => e.value)).toEqual(
      Array.from({ length: n }, (_, i) => `https://h${i}.example/x`),
    );
  });

  for (const minify of [false, true])
    it(`reads libraries and instances in an esbuild bundle${minify ? ", minified" : ""}`, () => {
      const source = bundle(
        [
          'import axios from "axios";',
          'import got from "got";',
          'import ky from "ky";',
          'import https from "node:https";',
          'import { net } from "electron";',
          'const api = axios.create({ baseURL: "https://b.example/v1" });',
          'const g = got.extend({ prefixUrl: "https://g.example/api" });',
          'const k = ky.create({ prefixUrl: "https://k.example" });',
          "const send = https.request;",
          "const l = net.request;",
          "export async function f(id) {",
          '  await axios("https://ax.example/1");',
          '  await axios({ url: "https://ax.example/2", method: "POST" });',
          '  await got("https://g.example/direct");',
          '  await ky("https://k.example/direct");',
          '  await api.get("/p");',
          "  await g.post(`items/${id}`);",
          '  await k.get("me");',
          '  send("https://send.example/");',
          '  l("https://net.example/");',
          '  return fetch(new Request("https://r.example/", { method: "PATCH" }));',
          "}",
        ].join("\n"),
        minify,
      );
      expect(show(source)).toEqual([
        "http-client GET https://ax.example/1 [literal]",
        "http-client POST https://ax.example/2 [literal]",
        "http-client GET https://g.example/direct [literal]",
        "http-client GET https://k.example/direct [literal]",
        "http-client GET https://b.example/v1/p [inferred]",
        "http-client POST https://g.example/api/items/${…} [template]",
        "http-client GET https://k.example/me [inferred]",
        "http-client https://send.example/ [literal]",
        "http-client https://net.example/ [literal]",
        "fetch PATCH https://r.example/ [literal]",
      ]);
    });

  it("reads fetch of a Request: written in the call, or a declaration never written again", () => {
    expect(
      show(
        [
          'fetch(new Request("https://r.example/1", { method: "POST" }));',
          'globalThis.fetch(new Request("https://r.example/2"), { method: "put" });',
          "function save(entry) {",
          '  const request = new Request("https://r.example/3", { method: "POST", body: entry });',
          "  return fetch(request);",
          "}",
          'const r4 = new Request("https://r.example/4", { method: "DELETE" });',
          "fetch(r4, { headers });",
          "fetch(r4, init);",
          'let r5 = new Request("https://r.example/5");',
          "r5 = other;",
          "fetch(r5);",
          "function shadow(r4) { return fetch(r4); }",
          'function own() { const Request = Mine; return fetch(new Request("https://mine.example/")); }',
        ].join("\n"),
      ),
    ).toEqual([
      "fetch POST https://r.example/1 [literal]",
      "fetch PUT https://r.example/2 [literal]",
      "fetch POST https://r.example/3 [literal]",
      "fetch DELETE https://r.example/4 [literal]",
      "fetch https://r.example/4 [literal]",
      "fetch ?r5 [unknown]",
      "fetch ?r4 [unknown]",
      "fetch ?<expression> [unknown]",
    ]);
  });

  it("reads a request function held as a value only where its binding is proven", () => {
    expect(
      show(
        [
          'const https = require("https");',
          'const electron = require("electron");',
          'const { net } = require("electron");',
          "const req = https.request;",
          'req("https://q.example/1");',
          "const l = net.request;",
          'l({ url: "https://net.example/1", method: "POST" });',
          "const e = electron.net.request;",
          'e("https://net.example/2");',
          "const { get, request: r } = https;",
          'get("https://d.example/1");',
          'r({ hostname: "o.example", path: "/x" });',
          'const g2 = require("https").get;',
          'g2("https://g2.example/");',
          "let w = https.request;",
          "w = fake;",
          'w("https://written.example/");',
          'function f(https) { const p = https.request; p("https://param.example/"); }',
          'const o = cache.request;\no("https://not-a-client.example/");',
        ].join("\n"),
      ),
    ).toEqual([
      "http-client https://q.example/1 [literal]",
      "http-client POST https://net.example/1 [inferred]",
      "http-client https://net.example/2 [literal]",
      "http-client GET https://d.example/1 [literal]",
      "http-client https://o.example/x [inferred]",
      "http-client GET https://g2.example/ [literal]",
      "http-client ?<expression> [unknown]",
    ]);
  });

  it("stays linear on many instances, direct calls, Request objects and written names", () => {
    const n = 20_000;
    const shapes = [
      'const axios = require("axios");\nconst api = axios.create({ baseURL: "https://x.example/v1" });\nfunction m() {\n' +
        Array.from({ length: n }, (_, i) => `api.get("/p${i}");`).join("\n") +
        "\n}",
      'const axios = require("axios");\nfunction m() {\n' +
        Array.from(
          { length: n },
          (_, i) =>
            `const a${i} = axios.create({ baseURL: "https://h${i}.example" }); a${i}.get("/x");`,
        ).join("\n") +
        "\n}",
      'const axios = require("axios");\nvar o = r(require("got"));\nfunction m() {\n' +
        Array.from(
          { length: n },
          (_, i) => `axios(u${i}, { method: "post" }); (0, o.default)(v${i});`,
        ).join("\n") +
        "\n}",
      'const axios = require("axios");\nfunction m() {\n' +
        Array.from(
          { length: n },
          (_, i) => `axios.create({ baseURL: "https://c${i}.example" }).get("/x");`,
        ).join("\n") +
        "\n}",
      "function m() {\n" +
        Array.from({ length: n }, (_, i) => `const r${i} = new Request(u${i}); fetch(r${i});`).join(
          "\n",
        ) +
        "\n}",
      'const https = require("https");\n' +
        Array.from(
          { length: n },
          (_, i) => `let q${i} = https.request; q${i} = f; q${i}(x${i});`,
        ).join("\n"),
      // one name declared and written in every function: 340 s in 0.9.7
      Array.from(
        { length: n },
        (_, i) => `function f${i}() { let h = require("https"); h = 1; h.get("/x"); }`,
      ).join("\n"),
      'const axios = require("axios");\n' +
        Array.from(
          { length: n },
          (_, i) =>
            `function f${i}() { let api = axios.create({ baseURL: "https://h.example" }); api = 1; api.get("/x"); }`,
        ).join("\n"),
    ];
    for (const source of shapes) {
      const started = performance.now();
      const found = find(source);
      // generous: the point is linear against quadratic, and test machines are busy
      expect(performance.now() - started).toBeLessThan(15_000);
      expect(found.endpoints.length).toBeLessThanOrEqual(2000);
    }
  });
});

describe("request libraries: review fixes", () => {
  it("does not keep an instance's base when the file may change it", () => {
    const A =
      'const axios = require("axios");\nconst api = axios.create({ baseURL: "https://old.example/api" });\n';
    const unknown = ["http-client GET ?<expression> [unknown]"];
    const cases: Array<[string, string[]]> = [
      [A + 'api.defaults.baseURL = "https://new.example/v2";\napi.get("/users");', unknown],
      [A + 'api.defaults.baseURL = cfg.base;\napi.get("/users");', unknown],
      [
        A +
          'api.interceptors.request.use((c) => { c.baseURL = other; return c; });\napi.get("/users");',
        unknown,
      ],
      [
        A + 'Object.assign(api.defaults, { baseURL: "https://x.example" });\napi.get("/users");',
        unknown,
      ],
      [
        A +
          'function setup(a) { a.defaults.baseURL = "https://z.example"; }\nsetup(api);\napi.get("/users");',
        unknown,
      ],
      [A + 'module.exports = { api };\napi.get("/users");', unknown],
      [
        'import axios from "axios";\nexport const api = axios.create({ baseURL: "https://exp.example" });\napi.get("/users");',
        unknown,
      ],
      [
        'const got = require("got");\nconst g = got.extend({ prefixUrl: "https://g.example/api" });\ng.defaults.options.prefixUrl = "https://h.example";\ng("users");',
        ["http-client ?<expression> [unknown]"],
      ],
      // only requests: the base is kept
      [
        A + 'api.get("/users");\napi("items");',
        [
          "http-client GET https://old.example/api/users [inferred]",
          "http-client GET https://old.example/api/items [inferred]",
        ],
      ],
    ];
    for (const [source, rows] of cases) expect(show(source), source).toEqual(rows);
  });

  for (const minify of [false, true])
    it(`does not keep an instance's base changed after create in an esbuild bundle${minify ? ", minified" : ""}`, () => {
      const source = bundle(
        [
          'import axios from "axios";',
          'const api = axios.create({ baseURL: "https://old.example/api" });',
          'api.defaults.baseURL = "https://new.example/v2";',
          'export function f() { return api.get("/users"); }',
        ].join("\n"),
        minify,
      );
      expect(show(source)).toEqual(["http-client GET ?<expression> [unknown]"]);
    });

  it("does not read a relative address where the library's global defaults are changed", () => {
    expect(
      show(
        [
          'const axios = require("axios");',
          'axios.defaults.baseURL = "https://glob.example/api";',
          'axios.get("/users");',
          'axios("/items");',
          'axios.get("https://abs.example/x");',
          "const api = axios.create({ timeout: 1 });",
          'api.get("/u");',
        ].join("\n"),
      ),
    ).toEqual([
      "http-client GET ?<expression> [unknown]",
      "http-client GET https://abs.example/x [literal]",
    ]);
  });

  it("does not keep the base of an instance whose call passes its config as a name", () => {
    expect(
      show(
        [
          'const axios = require("axios");',
          'const api = axios.create({ baseURL: "https://b.example/api" });',
          'api.get("/users", opts);',
          'api.post("/p", body, config);',
          'api.get("/plain");',
        ].join("\n"),
      ),
    ).toEqual([
      "http-client GET ?opts [unknown]",
      "http-client POST ?config [unknown]",
      "http-client GET https://b.example/api/plain [inferred]",
    ]);
  });

  it("does not take an imported or replaced Request for the global one", () => {
    for (const head of [
      'import { Request } from "./mine";',
      'import Request from "./mine";',
      'import { Foo as Request } from "./mine";',
      'import X, { Request } from "./mine";',
      "globalThis.Request = MyRequest;",
      "window.Request = MyRequest;",
      "self.Request = MyRequest;",
      "Request = MyRequest;",
    ])
      expect(show(`${head}\nfetch(new Request("https://r.example/a"));`), head).toEqual([
        "fetch ?<expression> [unknown]",
      ]);
  });

  it("counts destructuring and for-of writes of a binding", () => {
    const cases: Array<[string, string[]]> = [
      [
        'const axios = require("axios");\nlet api = axios.create({ baseURL: "https://b.example" });\n({ api } = other);\napi.get("/x");',
        ["http-client GET ?<expression> [unknown]"],
      ],
      [
        'const axios = require("axios");\nlet api = axios.create({ baseURL: "https://b.example" });\n[api] = list;\napi.get("/x");',
        ["http-client GET ?<expression> [unknown]"],
      ],
      [
        'const axios = require("axios");\nlet api = axios.create({ baseURL: "https://b.example" });\nfor (api of list) {}\napi.get("/x");',
        ["http-client GET ?<expression> [unknown]"],
      ],
      [
        'let h = require("https");\n[h] = list;\nh.get("https://x.example/a");',
        ["http-client GET ?<expression> [unknown]"],
      ],
      [
        'let h = require("https");\nfor (h of list) {}\nh.get("https://x.example/b");',
        ["http-client GET ?<expression> [unknown]"],
      ],
      [
        'let h = require("https");\n({ k: { h } } = o);\nh.get("https://x.example/c");',
        ["http-client GET ?<expression> [unknown]"],
      ],
      [
        'let axios = require("axios");\n({ axios } = other);\naxios("https://x.example/direct");',
        ["http-client ?<expression> [unknown]"],
      ],
      // a parameter pattern, a declaration pattern and an object literal write nothing
      [
        'const https = require("https");\nfunction f({ https } = {}) { return https; }\nconst { a: { b } } = o;\nconst o2 = { https };\nhttps.get("https://kept.example/");',
        ["http-client GET https://kept.example/ [literal]"],
      ],
      // a pattern later in a declaration list declares (Claude.app's minified main chunk)
      [
        'let He = require("electron");\nasync function q(r) { let t = f(r), [{ env: Fe }, [[He, Ue], Xe]] = await Promise.all([a, b]); return He; }\nfunction Qh(e) { return He.net.request({ method: "GET", url: e }); }',
        ["http-client GET ?options.url [unknown]"],
      ],
      // a name declared twice in one scope and written: either may be meant
      [
        'var h = require("https");\nvar h = require("https");\nh = other;\nh.get("https://dup.example/x");',
        ["http-client GET ?<expression> [unknown]"],
      ],
    ];
    for (const [source, rows] of cases) expect(show(source), source).toEqual(rows);
  });

  it("reads superagent callbacks, agents, bases with a query and calls before a declaration", () => {
    expect(
      show(
        [
          'const superagent = require("superagent");',
          'superagent("https://s.example/f", function (err, res) {});',
          'superagent("https://s.example/g", (e) => e);',
          'const agent = require("superagent").agent();',
          'agent.get("https://s.example/agent");',
          "const a2 = superagent.agent();",
          'a2.post("https://s.example/agent2");',
        ].join("\n"),
      ),
    ).toEqual([
      "http-client GET https://s.example/f [literal]",
      "http-client GET https://s.example/g [literal]",
      "http-client GET https://s.example/agent [literal]",
      "http-client POST https://s.example/agent2 [literal]",
    ]);
    expect(
      show(
        [
          'const axios = require("axios");',
          'const ky = require("ky");',
          'const a = axios.create({ baseURL: "https://b.example/api?key=1" });',
          'a.get("/users");',
          'const k = ky.create({ prefixUrl: "https://k.example/v1#x" });',
          'k.get("users");',
        ].join("\n"),
      ),
    ).toEqual([
      "http-client GET ?options.baseURL [unknown]",
      "http-client GET ?options.prefixUrl [unknown]",
    ]);
    expect(
      show(
        [
          'const axios = require("axios");',
          'api.get("/early");',
          'const api = axios.create({ baseURL: "https://b.example" });',
          'const https = require("https");',
          'req("https://early.example/");',
          "const req = https.request;",
          'req("https://late.example/");',
        ].join("\n"),
      ),
    ).toEqual(["http-client https://late.example/ [literal]"]);
  });

  it("flags and reads conservatively past the write bounds", () => {
    // more writes than are checked: the name is not proven, its calls are unknown rows
    const writes =
      'let h = require("https");\n' +
      Array.from({ length: 2100 }, (_, i) => `h = o${i};`).join("\n") +
      '\nh.get("https://after-writes.example/");\nconst q = require("http");\nq.get("http://kept.example/");';
    const a = find(writes);
    expect(a.clientWritesSkipped).toBe(true);
    expect(show(writes)).toEqual([
      "http-client GET ?<expression> [unknown]",
      "http-client GET http://kept.example/ [literal]",
    ]);
    // 40 nested functions declaring `h`, 900 writes in the innermost: past 32,000 questions
    const depth = 40;
    let nested = 'function f0() {\n  let h = require("https");\n';
    for (let d = 1; d < depth; d++) nested += `function f${d}() { let h = require("https");\n`;
    for (let i = 0; i < 900; i++) nested += `h = o${i};\n`;
    nested += "}\n".repeat(depth - 1);
    nested +=
      '  h = other;\n  h.get("https://outer.example/after-cap");\n}\nfunction g() { const q = require("https"); q.get("https://unrelated.example/"); }';
    expect(find(nested).clientWritesSkipped).toBe(true);
    expect(show(nested)).toEqual([
      "http-client GET ?<expression> [unknown]",
      "http-client GET https://unrelated.example/ [literal]",
    ]);
  });

  it("does not charge writes of a function's own locals to the write bound", () => {
    // a minified bundle: `o` and `a` are clients at the top; every other function declares and
    // writes its own `o` and `a`
    for (const n of [500, 999, 2500]) {
      const source =
        'var o=require("https"),a=require("axios"),c=a.create({baseURL:"https://api.example/v1"});\n' +
        'function go(){o.get("https://known.example/x");c.get("/users");a.post("https://lib.example/p")}\n' +
        Array.from(
          { length: n },
          (_, i) => `function f${i}(e){let o=e;o=o+1;var a=2;a=3;return o+a}`,
        ).join("\n") +
        '\no.request("https://known.example/end");';
      const found = find(source);
      expect(found.clientWritesSkipped, `${n}`).toBeUndefined();
      expect(show(source), `${n}`).toEqual([
        "http-client GET https://known.example/x [literal]",
        "http-client GET https://api.example/v1/users [inferred]",
        "http-client POST https://lib.example/p [literal]",
        "http-client https://known.example/end [literal]",
      ]);
    }
  });

  it("resolves a write against a later declaration of its own scope first", () => {
    const cases: Array<[string, string[]]> = [
      // a hoisted `var` in the inner function: the write is of that one
      [
        'function g() {\n  function f() { h = other; var h = require("https"); }\n  let h = require("http");\n  h.default.get("https://r.example/1");\n  h.get("https://r.example/1b");\n}',
        [
          "http-client GET https://r.example/1 [literal]",
          "http-client GET https://r.example/1b [literal]",
        ],
      ],
      // a `const` later in the same function (the write is in its dead zone)
      [
        'function g() {\n  function f() { h = other; const h = require("https"); }\n  let h = require("http");\n  h.get("https://r.example/2");\n}',
        ["http-client GET https://r.example/2 [literal]"],
      ],
      // a `let` later in an inner arrow
      [
        'const g = () => {\n  const h = require("https");\n  const k = () => { h = require("https"); let h = require("http"); };\n  h.post("https://r.example/3a");\n};',
        ["http-client POST https://r.example/3a [literal]"],
      ],
      // the write is of the outer binding: unknown
      [
        'function g() {\n  function f() { h = other; }\n  let h = require("http");\n  h.get("https://r.example/4");\n}',
        ["http-client GET ?<expression> [unknown]"],
      ],
    ];
    for (const [source, rows] of cases) expect(show(source), source).toEqual(rows);
  });

  it("does not read a call on an undeclared global that the file assigns", () => {
    expect(
      show(
        '{ const h = require("https"); }\nh = require("https");\nh = other;\nh.request("https://g.example/p");',
      ),
    ).toEqual(["http-client ?<expression> [unknown]"]);
    // not assigned: the name rule reads the address at the call
    expect(show('{ const h = require("https"); }\nh.request("https://g.example/q");')).toEqual([
      "http-client https://g.example/q [literal]",
    ]);
  });

  it("finds the parameter list of a pattern without walking a long argument list", () => {
    // each `{ api } = d` walked back over every argument before it: 50,000 took over a minute
    const n = 50_000;
    const source =
      'const axios = require("axios");\nlet api = axios.create({ baseURL: "https://b.example" });\nf(' +
      Array.from({ length: n }, (_, i) => `x${i}`).join(", ") +
      ", " +
      Array.from({ length: n }, () => "{ api } = d").join(", ") +
      ');\napi.get("/x");';
    const started = performance.now();
    const found = find(source);
    expect(performance.now() - started).toBeLessThan(15_000);
    expect(found.clientWritesSkipped).toBeUndefined();
    expect(show(source)).toEqual(["http-client GET ?<expression> [unknown]"]);
  });

  it("stays bounded past the functions the resolver reads, and on deep nesting", () => {
    for (const n of [61_000, 80_000]) {
      const source = Array.from(
        { length: n },
        (_, i) =>
          `function f${i}(){ let h = require("https"); h = o${i}; h.get("https://x.example/${i}"); }`,
      ).join("\n");
      const started = performance.now();
      const found = find(source);
      // generous: the point is bounded against quadratic (0.9.8: minutes or out of memory)
      expect(performance.now() - started).toBeLessThan(15_000);
      expect(found.clientWritesSkipped).toBe(true);
      expect(found.endpoints.filter((e) => e.value !== null)).toEqual([]);
    }
    const n = 60_000;
    const nested =
      'const axios = require("axios");\n' +
      Array.from(
        { length: n },
        (_, i) =>
          `function f${i}(){ let api = axios.create({ baseURL: "https://b.example" }); api.get("/p${i}");`,
      ).join("\n") +
      "}".repeat(n);
    const started = performance.now();
    find(nested);
    expect(performance.now() - started).toBeLessThan(15_000);
  });
});
