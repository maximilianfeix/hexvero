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
    external: ["electron"],
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
          'let h = require("https");',
          "h = mock;",
          "h.get(url);",
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
      // reassigned where the call means the binding: no row
      ['let h = require("https");\nh = fake;\nh.get("https://fake-reassigned.example/");', []],
      [
        'let https = require("https");\nhttps = fake;\nhttps.get("https://fake-reassigned.example/");',
        [],
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
