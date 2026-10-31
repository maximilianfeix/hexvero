import { describe, expect, it } from "vitest";
import { analyzeJavaScriptTree, asarTree, type JsAppInfo } from "../src/javascript/app.js";
import { buildAsar } from "./fixtures/asar.js";

/**
 * #280: a main-process send helper whose IPC object and channel are both parameters
 * (`send(webContents, channel, ...args) { … webContents.send(channel, ...args) }`), called with
 * a window's webContents, a destructured one, and the result of a getter a factory is called
 * with in place. Three hand-written builds of the same program: plain (module level), bundled
 * the way webpack hoists modules into one function, and minified, where the object is a bare
 * parameter (`e.send(t, ...n)`). Look-alike: another helper of the same shape and name in another
 * scope, called with an object that is no webContents.
 */

const PLAIN = `const electron = require("electron");
function send(webContents, channel, ...args) {
  if (webContents.isDestroyed()) {
    const message = \`failed to send on \${channel}\`;
    console.error(message);
  } else webContents.send(channel, ...args);
}
let mainWindow;
class AppWindow {
  constructor() {
    this.window = new electron.BrowserWindow({});
    this.window.on("focus", () => send(this.window.webContents, "focus"));
  }
  sendMenuEvent(name) { send(this.window.webContents, "menu-event", name); }
}
function zoom(factor) {
  return (item, win) => {
    const { webContents: contents } = win;
    contents.zoomFactor = factor;
    send(contents, "zoom-factor-changed", factor);
  };
}
const tokens = function (getRenderer, timeout = 35000) {
  return {
    resolveToken: (endpoint, token) => {
      const sender = getRenderer();
      if (sender === undefined || sender.isDestroyed()) return null;
      send(sender, "resolve-image-token", endpoint, token, timeout);
    },
  };
}(() => mainWindow?.webContents);
function socketHelper(socket) {
  function send(target, channel) { target.send(channel); }
  return send(socket, "not-ipc-socket");
}
electron.app.on("ready", () => {
  mainWindow = new AppWindow();
  zoom(1);
  socketHelper(null);
  tokens.resolveToken("e", "t");
});
`;

const BUNDLED = `(() => {
  "use strict";
  var __modules = {};
  (() => {
${PLAIN.split("\n")
  .map((l) => (l ? `    ${l}` : l))
  .join("\n")}
  })();
})();
`;

const MINIFIED =
  '(()=>{"use strict";const e=require("electron");function ut(e,t,...n){if(e.isDestroyed()){const e=`failed to send on ${t}`;console.error(e)}else e.send(t,...n)}let zn;class W{constructor(){this.window=new e.BrowserWindow({}),this.window.on("focus",()=>ut(this.window.webContents,"focus"))}sendMenuEvent(e){ut(this.window.webContents,"menu-event",e)}}function Ht(e){return(t,n)=>{const{webContents:r}=n;r.zoomFactor=e,ut(r,"zoom-factor-changed",e)}}const t=function(e,t=35e3){return{resolveToken:(n,o)=>{const s=e();if(void 0===s||s.isDestroyed())return null;ut(s,"resolve-image-token",n,o,t)}}}(()=>zn?.webContents);function x(e){function ut(e,t){e.send(t)}return ut(e,"not-ipc-socket")}e.app.on("ready",()=>{zn=new W,Ht(1),x(null),t.resolveToken("e","t")})})();\n';

function analyze(main: string): JsAppInfo {
  return analyzeJavaScriptTree(
    asarTree(
      buildAsar({
        "package.json": JSON.stringify({ name: "desk", main: "main.js" }),
        "main.js": main,
        "renderer.js":
          'const { ipcRenderer } = require("electron");\nipcRenderer.on("resolve-image-token", () => {});\n',
      }),
      "app.asar",
    ),
  );
}

const SENT = ["focus", "menu-event", "resolve-image-token", "zoom-factor-changed"];

describe("#280: a send helper whose object and channel are parameters", () => {
  for (const [name, main] of Object.entries({
    plain: PLAIN,
    bundled: BUNDLED,
    minified: MINIFIED,
  }))
    it(`gives main.js as the sender of each channel passed with a webContents (${name})`, () => {
      const info = analyze(main);
      const sent = info.ipcChannels
        .filter((c) => c.senders.includes("main.js"))
        .map((c) => c.channel)
        .toSorted();
      expect(sent).toEqual(SENT);
      // main sends to the renderer: main.js never receives these, the page does
      expect(info.ipcChannels.find((c) => c.channel === "resolve-image-token")).toMatchObject({
        senders: ["main.js"],
        receivers: ["renderer.js"],
      });
      const mainModule = info.modules.find((m) => m.id === "main.js")!;
      for (const u of mainModule.ipc.filter((r) => r.channel !== null))
        expect(u.api).toBe("webContents.send");
      expect(info.ipcChannels.map((c) => c.channel)).not.toContain("not-ipc-socket");
    });

  it("reads the rows at the helper's calls, through it", () => {
    const rows = analyze(MINIFIED)
      .modules.find((m) => m.id === "main.js")!
      .ipc.filter((u) => u.channel === "resolve-image-token");
    expect(rows).toEqual([
      {
        api: "webContents.send",
        channel: "resolve-image-token",
        line: 1,
        via: "wrapper",
        wrapper: "ut",
      },
    ]);
  });

  it("gives no row where the object passed is not a webContents by what is written", () => {
    const info = analyze(
      '(()=>{const e=require("electron");function ut(e,t,...n){e.send(t,...n)}const p=new e.MessageChannelMain().port1,w=new e.BrowserWindow({});ut(p,"not-ipc-port"),ut(o(),"not-ipc-unknown"),ut(w,"not-ipc-window"),ut(w.webContents,"real-send")})();\n',
    );
    expect(info.ipcChannels.map((c) => c.channel)).toEqual(["real-send", "resolve-image-token"]);
  });

  it("does not take a call of another function of the helper's name for one", () => {
    // the helper is declared in one module function; `ut` of the other module is another function
    const info = analyze(
      '(()=>{(()=>{function ut(e,t){e.send(t)}const w={webContents:null};ut(w.webContents,"real-send")})();(()=>{function ut(e,t){return t}const w=require("electron").webContents.getFocusedWebContents();ut(w.webContents,"not-ipc-other")})()})();\n',
    );
    expect(info.ipcChannels.map((c) => c.channel)).not.toContain("not-ipc-other");
    expect(info.ipcChannels.map((c) => c.channel)).toContain("real-send");
  });

  it("does not read a helper that writes its object or channel parameter", () => {
    const info = analyze(
      '(()=>{function ut(e,t){t="x:"+t,e.send(t)}function vt(e,t){e=other(),e.send(t)}const w=require("electron").BrowserWindow;ut(w.webContents,"not-ipc-rewritten"),vt(w.webContents,"not-ipc-replaced")})();\n',
    );
    const channels = info.ipcChannels.map((c) => c.channel);
    expect(channels).not.toContain("not-ipc-rewritten");
    expect(channels).not.toContain("not-ipc-replaced");
  });
});
