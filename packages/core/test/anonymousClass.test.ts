import { describe, expect, it } from "vitest";
import { analyzeJavaScriptTree, asarTree, type JsAppInfo } from "../src/javascript/app.js";
import { buildAsar } from "./fixtures/asar.js";

/**
 * #302: methods of a class expression created in place (`S = new class extends B {…}`) are
 * functions of their own. Before, such a class had no name and its methods were not read as
 * functions, so calls in them were read at module level, and a local `g` of one method counted
 * as a write of the forwarder `g` beside the class.
 */
const PLAIN = `const { ipcRenderer } = require("electron");
class Base {}
function send(channel, ...args) { ipcRenderer.send(channel, ...args); }
const store = new class extends Base {
  quit() { send("will-quit"); }
  later() { let send = 1; send = 2; return send; }
}();
window.store = store;
`;

const MINIFIED =
  '(()=>{const r=require("electron");class u{}function g(e,...t){r.ipcRenderer.send(e,...t)}const S=new class extends u{quit(){g("will-quit")}later(){let g=1;return g=2,g}};window.store=S})();\n';

const ANONYMOUS =
  '(()=>{const r=require("electron");function g(e){r.ipcRenderer.send(e)}window.s=new class{q(){g("will-quit")}l(){let g;g=1;return g}}})();\n';

function analyze(source: string): JsAppInfo {
  return analyzeJavaScriptTree(
    asarTree(
      buildAsar({
        "package.json": JSON.stringify({ name: "s", main: "main.js" }),
        "main.js": 'require("electron").ipcMain.on("will-quit", () => {});\n',
        "renderer.js": source,
      }),
      "app.asar",
    ),
  );
}

describe("#302: methods of a class created in place", () => {
  for (const [name, source] of Object.entries({
    plain: PLAIN,
    minified: MINIFIED,
    anonymous: ANONYMOUS,
  }))
    it(`reads the forwarder's call in a method, not the method's own local (${name})`, () => {
      const info = analyze(source);
      const channel = info.ipcChannels.find((c) => c.channel === "will-quit");
      expect(channel).toMatchObject({ senders: ["renderer.js"], receivers: ["main.js"] });
    });

  it("does not take a property named class for a class", () => {
    const info = analyze(
      '(()=>{const r=require("electron");function g(e){r.ipcRenderer.send(e)}const o={class:{a(){let g;g=1}}};o.class={b(){}};g("will-quit")})();\n',
    );
    expect(info.ipcChannels.find((c) => c.channel === "will-quit")?.senders).toEqual([
      "renderer.js",
    ]);
  });
});
