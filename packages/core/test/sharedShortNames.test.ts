import { describe, expect, it } from "vitest";
import { analyzeJavaScriptTree, asarTree, type JsAppInfo } from "../src/javascript/app.js";
import { buildAsar } from "./fixtures/asar.js";

/**
 * #281: a page script's channel-forwarding helper whose (minified) name other functions of the
 * same bundle declare as well. The helper's calls bind to it by scope; a call of another function
 * of the same name must not count. Another function declares the name once more in a declarator
 * list whose earlier initializer is a function expression called in place after `?`
 * (`const a = …, b = x ? function (r) {…}(y) : z, f = …`): that is a local of that function, not a
 * write of the helper. Three hand-written builds of the same program: plain, bundled the way
 * webpack wraps modules, and minified with the names reused.
 */

/** As written: one module per file. */
const PLAIN = {
  "crash.js": `const { ipcRenderer } = require("electron");
const { total } = require("./math");
function send(channel, ...args) { return ipcRenderer.send(channel, ...args); }
function listen(channel, fn) { ipcRenderer.on(channel, fn); }
function layout(state) {
  const show = state.show,
    place = show ? function (r) { return r.top; }(state.rect) : 0,
    send = "tooltip " + place;
  return send;
}
function report() {
  function send(x) { return x; }
  return send("not-a-channel-inner");
}
class CrashApp {
  mount() { listen("window-state-changed", () => {}); send("crash-ready"); }
  quit() { send("crash-quit"); }
}
module.exports = { CrashApp, layout, report, total };
`,
  "math.js": `function send(a, b) { return a + b; }
exports.total = (a) => send(a, "not-a-channel-other-module");
`,
};

/** The same program as a webpack-style bundle: every module is a function, the app's as well. */
const BUNDLED = {
  "crash.js": `(() => {
  "use strict";
  var __modules = {
    101: (module) => {
      function send(a, b) { return a + b; }
      module.exports = { total: (a) => send(a, "not-a-channel-other-module") };
    },
  };
  var __cache = {};
  function __require(id) {
    var cached = __cache[id];
    if (cached !== undefined) return cached.exports;
    var module = (__cache[id] = { exports: {} });
    __modules[id](module, module.exports, __require);
    return module.exports;
  }
  (() => {
    const electron = require("electron");
    const math = __require(101);
    function send(channel, ...args) { return electron.ipcRenderer.send(channel, ...args); }
    function listen(channel, fn) { electron.ipcRenderer.on(channel, fn); }
    function layout(state) {
      const show = state.show,
        place = show ? function (r) { return r.top; }(state.rect) : 0,
        send = "tooltip " + place;
      return send;
    }
    function report() {
      function send(x) { return x; }
      return send("not-a-channel-inner");
    }
    class CrashApp {
      mount() { listen("window-state-changed", () => {}); send("crash-ready"); }
      quit() { send("crash-quit"); }
    }
    window.crash = { CrashApp, layout, report, total: math.total };
  })();
})();
`,
};

/** Minified: one line, short names, `f` declared by three functions and in a declarator list. */
const MINIFIED = {
  "crash.js":
    '(()=>{"use strict";var e={101:e=>{function f(e,t){return e+t}e.exports={total:e=>f(e,"not-a-channel-other-module")}}},t={};function n(r){var o=t[r];if(void 0!==o)return o.exports;var i=t[r]={exports:{}};return e[r](i,i.exports,n),i.exports}(()=>{const r=require("electron"),o=n(101);function f(e,...t){return r.ipcRenderer.send(e,...t)}function d(e,t){r.ipcRenderer.on(e,t)}function l(e){const t=e.show,n=t?function(e){return e.top}(e.rect):0,f="tooltip "+n;return f}function a(){function f(e){return e}return f("not-a-channel-inner")}class u{mount(){d("window-state-changed",()=>{}),f("crash-ready")}quit(){f("crash-quit")}}window.crash={CrashApp:u,layout:l,report:a,total:o.total}})()})();\n',
};

function analyze(files: Record<string, string>): JsAppInfo {
  return analyzeJavaScriptTree(
    asarTree(
      buildAsar({
        "package.json": JSON.stringify({ name: "crash", main: "main.js" }),
        "main.js":
          'const { ipcMain } = require("electron");\nipcMain.on("crash-quit", () => {});\n',
        ...files,
      }),
      "app.asar",
    ),
  );
}

/** `channel api file` of every crash.js row with a channel. */
const rows = (info: JsAppInfo): string[] =>
  info.modules
    .filter((m) => m.id === "crash.js")
    .flatMap((m) => m.ipc.filter((u) => u.channel !== null).map((u) => `${u.channel} ${u.api}`))
    .toSorted();

describe("#281: a forwarder whose short name other functions declare too", () => {
  for (const [name, files] of Object.entries({
    plain: PLAIN,
    bundled: BUNDLED,
    minified: MINIFIED,
  }))
    it(`reads the forwarder's calls by scope, and no call of another function of its name (${name})`, () => {
      const info = analyze(files);
      expect(rows(info)).toEqual([
        "crash-quit ipcRenderer.send",
        "crash-ready ipcRenderer.send",
        "window-state-changed ipcRenderer.on",
      ]);
      const quit = info.ipcChannels.find((c) => c.channel === "crash-quit");
      expect(quit).toMatchObject({ senders: ["crash.js"], receivers: ["main.js"] });
      expect(info.ipcChannels.find((c) => c.channel === "crash-ready")?.senders).toEqual([
        "crash.js",
      ]);
      const channels = info.ipcChannels.map((c) => c.channel);
      for (const other of ["not-a-channel-inner", "not-a-channel-other-module", "tooltip "])
        expect(channels.some((c) => c?.startsWith(other))).toBe(false);
    });

  it("still counts a write of the forwarder's name in a function that does not declare it", () => {
    // `f = …` in a function without its own `f`: the forwarder may be another function by then
    const info = analyze({
      "crash.js":
        '(()=>{(()=>{const r=require("electron");function f(e,...t){return r.ipcRenderer.send(e,...t)}function l(e){const t=e.show,n=t?function(e){return e.top}(e.rect):0;f=function(e){return e};return n}class u{quit(){f("crash-quit")}}window.crash={u,l}})()})();\n',
    });
    expect(rows(info)).not.toContain("crash-quit ipcRenderer.send");
  });
});
