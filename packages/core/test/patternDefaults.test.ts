import { describe, expect, it } from "vitest";
import { analyzeJavaScriptTree, asarTree, type JsAppInfo } from "../src/javascript/app.js";
import { buildAsar } from "./fixtures/asar.js";

/**
 * #306: a page script's sending forwarder (`function send(channel, ...args) { return
 * ipcRenderer.send(channel, ...args) }`) whose name another function of the same bundle binds in
 * a declaration's pattern with a default (`const { flipAlignment: send = true } = options`, as
 * Floating UI's flip middleware declares its options), or a class uses as a field name
 * (`class A { send = "light" }`). Neither is a write of the forwarder: its call in a class
 * field's arrow (`update = () => { … send("…") }`) is read. A call of the pattern's local is no
 * call of the forwarder. Three hand-written builds of the same program: plain, bundled the way
 * webpack wraps modules, and minified with the names reused.
 */

/** As written: one module per file. */
const PLAIN = {
  "page.js": `const { ipcRenderer } = require("electron");
function send(channel, ...args) {
  return ipcRenderer.send(channel, ...args);
}
const flip = (options = {}) => ({
  name: "flip",
  async fn(state) {
    const { placement } = state,
      { mainAxis: checkMain = true, flipAlignment: send = (v) => v, ...rest } = options;
    send("not-a-channel-local");
    return checkMain ? placement : rest;
  },
});
class Theme {
  send = "light";
  update = () => {
    const color = getComputedStyle(document.body).getPropertyValue("--background-color");
    color && send("update-window-background-color", color.trim());
  };
}
window.theme = { flip, Theme };
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
    const electron = __require(7);
    function send(channel, ...args) {
      return electron.ipcRenderer.send(channel, ...args);
    }
    const flip = (options = {}) => ({
      name: "flip",
      async fn(state) {
        const { placement } = state,
          { mainAxis: checkMain = true, flipAlignment: send = (v) => v, ...rest } = options;
        send("not-a-channel-local");
        return checkMain ? placement : rest;
      },
    });
    class Theme {
      send = "light";
      update = () => {
        const color = getComputedStyle(document.body).getPropertyValue("--background-color");
        color && send("update-window-background-color", color.trim());
      };
    }
    window.theme = { flip, Theme };
  })();
})();
`,
};

/** Minified: one line, short names, `f` the forwarder, a pattern's local and a field. */
const MINIFIED = {
  "page.js":
    '(()=>{var e={7:e=>{e.exports=require("electron")}},t={};function n(r){var o=t[r];if(void 0!==o)return o.exports;var i=t[r]={exports:{}};return e[r](i,i.exports,n),i.exports}(()=>{"use strict";const m=n(7);function f(e,...t){return m.ipcRenderer.send(e,...t)}const o=(e={})=>({name:"flip",async fn(t){const{placement:i}=t,{mainAxis:h=!0,flipAlignment:f=e=>e,...g}=e;return f("not-a-channel-local"),h?i:g}});class D{f="light";u=()=>{const e=getComputedStyle(document.body).getPropertyValue("--background-color");e&&f("update-window-background-color",e.trim())}}window.theme={flip:o,Theme:D}})()})();\n',
};

function analyze(files: Record<string, string>): JsAppInfo {
  return analyzeJavaScriptTree(
    asarTree(
      buildAsar({
        "package.json": JSON.stringify({ name: "page", main: "main.js" }),
        "main.js":
          'const { BrowserWindow, ipcMain } = require("electron");\nconst win = new BrowserWindow({});\nwin.loadFile("index.html");\nipcMain.on("update-window-background-color", (e, color) => win.setBackgroundColor(color));\n',
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

/** The minified page with `local` in place of the pattern's function and `field` of the class. */
const minified = (local: string, field = 'f="light";'): Record<string, string> => ({
  "page.js": `(()=>{const m=require("electron");function f(e,...t){return m.ipcRenderer.send(e,...t)}const o={async fn(t){${local}}};class D{${field}u=()=>{f("update-window-background-color",1)}}window.theme={o,D}})();\n`,
});

describe("#306: a forwarder whose name a pattern default or a class field reuses", () => {
  for (const [name, files] of Object.entries({
    plain: PLAIN,
    bundled: BUNDLED,
    minified: MINIFIED,
  }))
    it(`reads the forwarder's call in a class field's arrow, no call of the local (${name})`, () => {
      const info = analyze(files);
      expect(rows(info)).toEqual(["update-window-background-color ipcRenderer.send"]);
      expect(
        info.ipcChannels.find((c) => c.channel === "update-window-background-color"),
      ).toMatchObject({ senders: ["page.js"], receivers: ["main.js"] });
      expect(info.ipcChannels.some((c) => c.channel === "not-a-channel-local")).toBe(false);
    });

  it("reads a name a declaration's pattern binds as a local of its function", () => {
    // with a default, nested, in an array, after a `,` of a list: each binds `f` in `fn`
    for (const local of [
      "const{a:f=!0}=t;return f",
      "let{a:{b:f}}=t;return f=1,f",
      "var[i,f=2]=t;return f++",
      "const i=t,[f]=i;f=3;return f",
      "const{f=4,...g}=t;return f",
    ]) {
      const info = analyze(minified(local));
      expect(rows(info), local).toEqual(["update-window-background-color ipcRenderer.send"]);
    }
  });

  it("reads no call of the pattern's local as a call of the forwarder", () => {
    // without a default nothing writes `f`: before, such a call was read as the forwarder's
    const locals = [
      'const{a:f=e=>e}=t;return f("not-a-channel-local")',
      'const[f]=t;return f("not-a-channel-local")',
      'let[i,[f]]=t;return f("not-a-channel-local")',
      'if(t){const{a:{b:f}}=t;return f("not-a-channel-local")}',
    ];
    const found = locals.map((local) => rows(analyze(minified(local, ""))));
    expect(found).toEqual(locals.map(() => ["update-window-background-color ipcRenderer.send"]));
  });

  it("still counts a write of the forwarder's name that is no declaration", () => {
    // a pattern assigned to (no declaration), a plain assignment, and a name assigned in a
    // field's value: the forwarder may be another function by then
    for (const [local, field] of [
      ["({a:f=!0}=t);return f", 'f="light";'],
      ["[f]=t", 'f="light";'],
      ["return f=null", 'f="light";'],
      ["return t", "a=f=null;"],
    ] as const) {
      const info = analyze(minified(local, field));
      expect(rows(info), `${local} ${field}`).not.toContain(
        "update-window-background-color ipcRenderer.send",
      );
    }
  });
});
