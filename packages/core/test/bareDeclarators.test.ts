import { describe, expect, it } from "vitest";
import { analyzeJavaScriptTree, asarTree, type JsAppInfo } from "../src/javascript/app.js";
import { buildAsar } from "./fixtures/asar.js";

/**
 * #298: a page script's receiving forwarder (`function listen(channel, fn) { ipcRenderer.on(channel,
 * fn) }`) whose name other functions of the same bundle declare as locals without a value, in a
 * declarator list, and assign later (`let g, listen; … listen = …`), as minifiers write a
 * function's locals. Such a local belongs to its function: its assignments are no writes of the
 * forwarder, and a call of it is no call of the forwarder. Three hand-written builds of the same
 * program: plain, bundled the way webpack wraps modules, and minified with the names reused.
 */

/** As written: one module per file; one list ends at a line break, without `;`. */
const PLAIN = {
  "page.js": `const { ipcRenderer } = require("electron");
function listen(channel, fn) { ipcRenderer.on(channel, fn); }
const sizes = {
  async fit(state) {
    const side = state.side;
    let edge, listen;
    side === "top" ? (edge = side, listen = await state.flip()) : (listen = side, edge = "end");
    return edge + listen;
  },
};
function render(items) {
  let i, n = items.length, listen, out = "";
  for (i = 0; i < n; i++) listen = items[i].checked, out += listen;
  return out;
}
function local(x) {
  var a = x, listen
  listen = function (v) { return v; };
  return listen("not-a-channel-local");
}
listen("zoom-factor-changed", (e, factor) => factor);
listen("app-menu", (e, menu) => menu);
module.exports = { sizes, render, local };
`,
};

/** The same program as a webpack-style bundle: every module is a function, the page's as well. */
const BUNDLED = {
  "page.js": `(() => {
  var __modules = {
    7: (module) => {
      module.exports = require("electron");
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
    "use strict";
    var electron = __require(7);
    function listen(channel, fn) { electron.ipcRenderer.on(channel, fn); }
    const sizes = {
      async fit(state) {
        const side = state.side;
        let edge, listen;
        side === "top" ? (edge = side, listen = await state.flip()) : (listen = side, edge = "end");
        return edge + listen;
      },
    };
    function render(items) {
      let i, n = items.length, listen, out = "";
      for (i = 0; i < n; i++) listen = items[i].checked, out += listen;
      return out;
    }
    function local(x) {
      var a = x, listen;
      listen = function (v) { return v; };
      return listen("not-a-channel-local");
    }
    listen("zoom-factor-changed", (e, factor) => factor);
    listen("app-menu", (e, menu) => menu);
    window.page = { sizes, render, local };
  })();
})();
`,
};

/** Minified: one line, short names, `y` the forwarder and a local of three other functions. */
const MINIFIED = {
  "page.js":
    '(()=>{var e={7:e=>{e.exports=require("electron")}},t={};function n(r){var o=t[r];if(void 0!==o)return o.exports;var i=t[r]={exports:{}};return e[r](i,i.exports,n),i.exports}(()=>{"use strict";var m=n(7);function y(e,t){m.ipcRenderer.on(e,t)}const s={async fn(e){const t=e.side;let g,y;"top"===t?(g=t,y=await e.flip()):(y=t,g="end");return g+y}};function p(e){let t,n=e.length,y,r="";for(t=0;t<n;t++)y=e[t].checked,r+=y;return r}function l(e){var t=e,y;return y=function(e){return e},y("not-a-channel-local")}y("zoom-factor-changed",(e,t)=>t),y("app-menu",(e,t)=>t),window.page={sizes:s,render:p,local:l}})()})();\n',
};

function analyze(files: Record<string, string>): JsAppInfo {
  return analyzeJavaScriptTree(
    asarTree(
      buildAsar({
        "package.json": JSON.stringify({ name: "page", main: "main.js" }),
        "main.js":
          'const { BrowserWindow } = require("electron");\nconst win = new BrowserWindow({});\nwin.loadFile("index.html");\nwin.webContents.send("zoom-factor-changed", 1);\n',
        "index.html": '<script src="page.js"></script>\n',
        ...files,
      }),
      "app.asar",
    ),
  );
}

/** `channel api` of every page.js row with a channel. */
const rows = (info: JsAppInfo): string[] =>
  info.modules
    .filter((m) => m.id === "page.js")
    .flatMap((m) => m.ipc.filter((u) => u.channel !== null).map((u) => `${u.channel} ${u.api}`))
    .toSorted();

describe("#298: a forwarder whose name other functions declare without a value", () => {
  for (const [name, files] of Object.entries({
    plain: PLAIN,
    bundled: BUNDLED,
    minified: MINIFIED,
  }))
    it(`reads the forwarder's calls, and no call of a local of its name (${name})`, () => {
      const info = analyze(files);
      expect(rows(info)).toEqual(["app-menu ipcRenderer.on", "zoom-factor-changed ipcRenderer.on"]);
      expect(info.ipcChannels.find((c) => c.channel === "zoom-factor-changed")).toMatchObject({
        senders: ["main.js"],
        receivers: ["page.js"],
      });
      expect(info.ipcChannels.some((c) => c.channel === "not-a-channel-local")).toBe(false);
    });

  it("still counts a write of the forwarder's name in a function that does not declare it", () => {
    // `y = …` in a function whose list declares other names only: the forwarder may be another
    // function by then
    const info = analyze({
      "page.js":
        '(()=>{var m=require("electron");function y(e,t){m.ipcRenderer.on(e,t)}function p(e){let t,n;return y=function(e){return e},t}y("zoom-factor-changed",(e,t)=>t),window.page={render:p}})();\n',
    });
    expect(rows(info)).not.toContain("zoom-factor-changed ipcRenderer.on");
  });

  it("reads no call of a local declared without a value as a call of the forwarder", () => {
    // `var t = e, y;` in `l` binds `y` there: `y("…")` inside `l` calls that local
    for (const local of ["var t=e,y;", "let t,y,r=e;", "var t=e,y\n"]) {
      const info = analyze({
        "page.js": `(()=>{var m=require("electron");function y(e,t){m.ipcRenderer.on(e,t)}function l(e){${local}return y("not-a-channel-local",t)}y("zoom-factor-changed",(e,t)=>t),window.page={local:l}})();\n`,
      });
      expect(rows(info)).toEqual(["zoom-factor-changed ipcRenderer.on"]);
    }
  });

  it("reads no declaration in a call's arguments or a sequence expression", () => {
    // `f(a, y)` and `g = 1, y;` name the forwarder; neither declares it, so it stays read
    const info = analyze({
      "page.js":
        '(()=>{var m=require("electron");function y(e,t){m.ipcRenderer.on(e,t)}function p(e){var g;return g=1,y;}function q(e){return e(1,y)}y("zoom-factor-changed",(e,t)=>t),window.page={p,q}})();\n',
    });
    expect(rows(info)).toContain("zoom-factor-changed ipcRenderer.on");
  });
});
