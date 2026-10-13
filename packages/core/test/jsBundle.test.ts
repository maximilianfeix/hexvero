import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Script } from "node:vm";
import { afterAll, describe, expect, it } from "vitest";
import { analyzeBundle } from "../src/javascript/bundle.js";
import { recoverBundle, recoverSourceMap, safeRelativePath } from "../src/javascript/recover.js";

const webpack5 = `(self.webpackChunkdemo=self.webpackChunkdemo||[]).push([[179,"shared"],{
"./src/index.js":(module,__webpack_exports__,__webpack_require__)=>{"use strict";__webpack_require__.r(__webpack_exports__);__webpack_require__.d(__webpack_exports__,{start:()=>start,version:()=>v});var _api__WEBPACK_IMPORTED_MODULE_0__=__webpack_require__("./src/api.js");const v="1.0";function start(){localStorage.setItem("token",_api__WEBPACK_IMPORTED_MODULE_0__.login());}},
"./src/api.js":(e,t,n)=>{n.d(t,{login:()=>o});const r=n(4216);async function o(){const s=await fetch("/api/v1/login",{method:"POST"});return s.json()}},
4216:(e,t)=>{e.exports={ok:1}; /* fetch("/not/a/call") */ }
}]);`;

const webpack4 = `!function(e){var t={};function n(r){if(t[r])return t[r].exports;var o=t[r]={i:r,l:!1,exports:{}};return e[r].call(o.exports,o,o.exports,n),o.l=!0,o.exports}n.m=e,n.d=function(e,t,r){};n(n.s=1)}([function(e,t,n){e.exports=function(){return"a"}},function(e,t,n){var r=n(0);t.default=r()+document.cookie}]);`;

const browserify = `(function(){function r(e,n,t){function o(i,f){if(!n[i]){if(!e[i]){var c="function"==typeof require&&require;if(!f&&c)return c(i,!0);throw new Error("Cannot find module '"+i+"'")}}}return o}return r})()({1:[function(require,module,exports){
var dep = require('./dep');
module.exports = dep.value + 1;
},{"./dep":2}],2:[function(require,module,exports){
exports.value = 41; sessionStorage.getItem("sid");
},{}]},{},[1]);`;

const esbuild = `var __commonJS = (cb, mod) => function __require() { return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports; };
var require_util = __commonJS({ "src/util.js"(exports, module) { module.exports = { twice: (x) => x * 2 }; } });
var require_main = __commonJS({ "src/main.js"(exports) { var util = require_util(); exports.run = () => util.twice(21); new WebSocket("wss://live.example.com/ws"); } });`;

describe("analyzeBundle", () => {
  it("splits a webpack 5 chunk push into named modules with requires, exports and candidates", () => {
    const b = analyzeBundle(webpack5);
    expect(b.bundler).toBe("webpack");
    expect(b.chunkIds).toEqual(["179", "shared"]);
    expect(b.modules.map((m) => m.id)).toEqual(["./src/index.js", "./src/api.js", "4216"]);
    expect(b.modules[0]).toMatchObject({
      name: "./src/index.js",
      requires: ["./src/api.js"],
      exports: ["start", "version"],
    });
    expect(b.modules[1]).toMatchObject({ requires: ["4216"], exports: ["login"] });
    expect(b.modules[2]!.exports).toEqual(["module.exports"]);
    expect(b.endpoints.map((e) => `${e.kind}:${e.value}@${e.moduleId}`)).toEqual([
      "fetch:/api/v1/login@./src/api.js",
    ]);
    expect(b.storage.map((s) => `${s.kind}:${s.value}`)).toEqual(["localStorage:token"]);
    expect(b.vendors).toContain("webpack");
    expect(b.limitations).toEqual([]);
  });
  it("handles the webpack 4 array bootstrap", () => {
    const b = analyzeBundle(webpack4);
    expect(b.bundler).toBe("webpack");
    expect(b.hasRuntime).toBe(true);
    expect(b.modules.map((m) => `${m.id}:${m.requires.join("|")}`)).toEqual(["0:", "1:0"]);
    expect(b.modules[1]!.exports).toEqual(["default"]);
    expect(b.storage[0]).toMatchObject({ kind: "cookie" });
  });
  it("handles browserify module maps with dependency maps and entries", () => {
    const b = analyzeBundle(browserify);
    expect(b.bundler).toBe("browserify");
    expect(b.entryIds).toEqual(["1"]);
    expect(b.modules.map((m) => `${m.id}:${m.requires.join("|")}`)).toEqual(["1:2", "2:"]);
    expect(b.modules[1]!.exports).toEqual(["value"]);
    expect(b.storage.map((s) => s.kind)).toEqual(["sessionStorage"]);
  });
  it("handles esbuild __commonJS wrappers", () => {
    const b = analyzeBundle(esbuild);
    expect(b.bundler).toBe("esbuild");
    expect(b.modules.map((m) => m.name)).toEqual(["src/util.js", "src/main.js"]);
    expect(b.modules[1]!.exports).toEqual(["run"]);
    expect(b.endpoints[0]).toMatchObject({ kind: "websocket", value: "wss://live.example.com/ws" });
  });
  it("keeps exports and requires inside their own module and ignores member calls and shadowed bindings", () => {
    const b = analyzeBundle(
      `var __webpack_modules__={0:(m,e,r)=>{r.d(e,"x",()=>x);r(7);obj.r(9);function f(r){r(8)};r.d(e,{y:()=>1,z:()=>2})},1:(m,e,r)=>{e.y={wrong:1};r(id)}};`,
    );
    expect(b.modules[0]).toMatchObject({ requires: ["7"], exports: ["x", "y", "z"] });
    expect(b.modules[1]).toMatchObject({ requires: [], exports: ["y"] });
  });
  it("reports when markers exist but no module map is found", () => {
    const b = analyzeBundle("var x = __webpack_require__; console.log(x);");
    expect(b.bundler).toBe("webpack");
    expect(b.modules).toEqual([]);
    expect(b.limitations[0]?.code).toBe("bundle_modules_not_found");
  });
});

describe("recovery", () => {
  const dir = mkdtempSync(join(tmpdir(), "hexvero-recover-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  it("sanitizes paths", () => {
    expect(safeRelativePath("webpack:///./src/a.ts?1234", "x")).toBe("src/a.ts");
    expect(safeRelativePath("../../etc/passwd", "fallback.js")).toBe("etc/passwd.js");
    expect(safeRelativePath("/abs/path.js", "x")).toBe("abs/path.js");
    expect(safeRelativePath("..", "fallback.js")).toBe("fallback.js");
  });
  it("writes bundle modules and a manifest", () => {
    const out = join(dir, "bundle");
    const r = recoverBundle(webpack5, out);
    expect(r.written.map((w) => w.path)).toEqual([
      "src/index.js",
      "src/api.js",
      "modules/module-4216.js",
    ]);
    expect(readFileSync(join(out, "src/api.js"), "utf8")).toContain('fetch("/api/v1/login"');
    const manifest = JSON.parse(readFileSync(join(out, r.manifest), "utf8"));
    expect(manifest.modules[0]).toMatchObject({
      id: "./src/index.js",
      file: "src/index.js",
      requires: ["./src/api.js"],
    });
    expect(() => recoverBundle(webpack5, out)).toThrow(/not empty/);
  });
  it("recovers esbuild method factories as valid JavaScript and resolves name collisions", () => {
    const out = join(dir, "esbuild");
    const r = recoverBundle(esbuild, out);
    for (const w of r.written)
      expect(() => new Script(readFileSync(join(out, w.path), "utf8"))).not.toThrow();
    const dup = join(dir, "dup");
    const d = recoverBundle(
      `var __webpack_modules__={"a.js":(m,e,r)=>{},"A.js":(m,e,r)=>{},"a.js/b.js":(m,e,r)=>{},"hexvero-bundle.json":(m,e,r)=>{}};`,
      dup,
    );
    expect(d.written.map((w) => w.path)).toEqual([
      "a.js",
      "A.1.js",
      "a.js/b.js".replace("a.js/b.js", "modules/module-a.js_b.js.2.js"),
      "hexvero-bundle.1.json",
    ]);
    expect(d.skipped).toEqual([]);
  });
  it("writes sourcesContent from a source map", () => {
    const out = join(dir, "map");
    const map = JSON.stringify({
      version: 3,
      file: "app.js",
      sourceRoot: "webpack:///",
      sources: ["./src/a.ts", "./src/b.ts", "node_modules/x/index.js"],
      sourcesContent: ["export const a = 1;", null, "module.exports = 1;"],
      mappings: "AAAA",
    });
    const r = recoverSourceMap(map, out);
    expect(r.written.map((w) => w.path)).toEqual(["src/a.ts", "node_modules/x/index.js"]);
    expect(r.skipped).toEqual([{ name: "./src/b.ts", reason: "no sourcesContent" }]);
    expect(existsSync(join(out, "src/a.ts"))).toBe(true);
  });

  it("splits webpack 5 output whose modules are parenthesized arrow functions", () => {
    const text = `/******/ (() => { // webpackBootstrap
/******/ var __webpack_modules__ = ({
/***/ "./src/api.js":
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {
__webpack_require__.r(__webpack_exports__);
__webpack_require__.d(__webpack_exports__, { sync: () => sync });
const sync = () => fetch("https://api.example.com/v1/sync");
/***/ }),
/***/ "./src/index.js":
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {
var _api = __webpack_require__("./src/api.js");
(0,_api.sync)();
/***/ })
/******/ });
/******/ var __webpack_module_cache__ = {};
/******/ function __webpack_require__(moduleId) { return __webpack_modules__[moduleId]; }
/******/ __webpack_require__.d = (exports, definition) => {};
/******/ __webpack_require__.r = (exports) => {};
/******/ __webpack_require__("./src/index.js");
/******/ })();
`;
    const bundle = analyzeBundle(text);
    expect(bundle.bundler).toBe("webpack");
    expect(bundle.modules.map((m) => m.name ?? m.id).toSorted()).toEqual([
      "./src/api.js",
      "./src/index.js",
    ]);
    expect(bundle.limitations.map((l) => l.code)).not.toContain("bundle_modules_not_found");
  });
});
