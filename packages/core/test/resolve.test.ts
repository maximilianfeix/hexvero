import { describe, expect, it } from "vitest";
import { analyzeJavaScriptTree, asarTree } from "../src/javascript/app.js";
import { buildAsar } from "./fixtures/asar.js";

/**
 * Idioms the bounded resolver reads (resolve.ts) and look-alikes it must not report. Written for
 * these tests; each case is a small application with its expected channels or window settings.
 */
type Case = { kind?: "window"; files: Record<string, string>; want: string[]; forbid?: string[] };
const CASES: Record<string, Case> = {
  "ipc:class-field": {
    files: {
      "main.js":
        "const { ipcMain } = require('electron');\nclass Svc {\n  constructor(ipc) { this.ipc = ipc; this.ipc.handle('svc:start', () => 1); }\n  bind() { this.ipc.on('svc:stop', () => 2); }\n}\nnew Svc(ipcMain).bind();",
    },
    want: ["svc:start", "svc:stop"],
  },
  "ipc:class-direct": {
    files: {
      "main.js":
        "const { ipcMain } = require('electron');\nclass Svc {\n  constructor() { ipcMain.handle('svc:a', () => 1); }\n  bind() { ipcMain.on('svc:b', () => 2); }\n}",
    },
    want: ["svc:a", "svc:b"],
  },
  "ipc:array-objects": {
    files: {
      "main.js":
        "const { ipcMain } = require('electron');\nconst routes = [ { channel: 'r:one', run: () => 1 }, { channel: 'r:two', run: () => 2 } ];\nfor (const r of routes) ipcMain.handle(r.channel, r.run);",
    },
    want: ["r:one", "r:two"],
  },
  "ipc:array-foreach": {
    files: {
      "main.js":
        "const { ipcMain } = require('electron');\nconst routes = [ { channel: 'f:one', run: () => 1 }, { channel: 'f:two', run: () => 2 } ];\nroutes.forEach(({ channel, run }) => ipcMain.handle(channel, run));",
    },
    want: ["f:one", "f:two"],
  },
  "ipc:map-foreach": {
    files: {
      "main.js":
        "const { ipcMain } = require('electron');\nconst m = new Map([['m:one', () => 1], ['m:two', () => 2]]);\nm.forEach((fn, ch) => ipcMain.handle(ch, fn));",
    },
    want: ["m:one", "m:two"],
  },
  "ipc:object-entries": {
    files: {
      "main.js":
        "const { ipcMain } = require('electron');\nconst handlers = { 'o:one': () => 1, 'o:two': () => 2 };\nfor (const [ch, fn] of Object.entries(handlers)) ipcMain.handle(ch, fn);",
    },
    want: ["o:one", "o:two"],
  },
  "ipc:second-arg-helper": {
    files: {
      "main.js":
        "const { ipcMain } = require('electron');\nfunction secured(scope, channel, fn) { ipcMain.handle(channel, (e, ...a) => fn(...a)); }\nsecured('scope:x', 'sec:one', () => 1);",
    },
    want: ["sec:one"],
    forbid: ["scope:x"],
  },
  "ipc:prefix-concat": {
    files: {
      "main.js":
        "const { ipcMain } = require('electron');\nconst P = 'timer:';\nipcMain.handle(P + 'tick', () => 1);\nipcMain.handle(`${P}stop`, () => 1);",
    },
    want: ["timer:tick", "timer:stop"],
  },
  "ipc:factory-template": {
    files: {
      "main.js":
        "const { ipcMain } = require('electron');\nconst ns = (n) => (a) => `${n}:${a}`;\nconst project = ns('projects');\nipcMain.handle(project('list'), () => 1);",
    },
    want: ["projects:list"],
  },
  "ipc:reexport-index": {
    files: {
      "main.js":
        "const { ipcMain } = require('electron');\nconst { SAVE_DOC } = require('./ipc');\nipcMain.handle(SAVE_DOC, () => 1);",
      "ipc/index.js": "const ch = require('./channels');\nmodule.exports = { SAVE_DOC: ch.SAVE };",
      "ipc/channels.js": "exports.SAVE = 'doc:save';",
    },
    want: ["doc:save"],
  },
  "ipc:esm-reexport": {
    files: {
      "main.js":
        "import { ipcMain } from 'electron';\nimport { OPEN } from './ipc/index.js';\nipcMain.handle(OPEN, () => 1);",
      "ipc/index.js": "export { OPEN_DOC as OPEN } from './channels.js';",
      "ipc/channels.js": "export const OPEN_DOC = 'doc:open';",
    },
    want: ["doc:open"],
  },
  "ipc:frozen-enum": {
    files: {
      "main.js":
        "const { ipcMain } = require('electron');\nconst C = Object.freeze({ A: 'fz:a', B: 'fz:b' });\nipcMain.handle(C.A, () => 1); ipcMain.on(C.B, () => 1);",
    },
    want: ["fz:a", "fz:b"],
  },
  "ipc:router-class": {
    files: {
      "main.js":
        "const { ipcMain } = require('electron');\nclass Router { handle(ch, fn) { ipcMain.handle(ch, fn); return this; } }\nconst r = new Router();\nr.handle('rt:a', () => 1).handle('rt:b', () => 2);",
    },
    want: ["rt:a", "rt:b"],
  },
  "ipc:comment-lookalike": {
    files: {
      "main.js":
        "const { ipcMain } = require('electron');\n// ipcMain.handle('fake:comment')\nconsole.log(\"ipcMain.handle('fake:log')\");\nconst em = new (require('events'))();\nem.on('fake:emitter', () => 1);\nipcMain.handle('real:one', () => 1);",
    },
    want: ["real:one"],
    forbid: ["fake:comment", "fake:log", "fake:emitter"],
  },
  "ipc:preload-invoke-const": {
    files: {
      "main.js": "const { ipcMain } = require('electron');",
      "preload.js":
        "const { contextBridge, ipcRenderer } = require('electron');\nconst CH = require('./channels');\ncontextBridge.exposeInMainWorld('api', { save: (d) => ipcRenderer.invoke(CH.SAVE, d), onPush: (f) => ipcRenderer.on(CH.PUSH, f) });",
      "channels.js": "module.exports = { SAVE: 'p:save', PUSH: 'p:push' };",
    },
    want: ["p:save", "p:push"],
  },
  "neg:partial-sites": {
    files: {
      "main.js":
        "const { ipcMain } = require('electron');\nfunction reg(ch, fn) { ipcMain.handle(ch, fn); }\nreg('ok:one', () => 1);\nreg(process.env.X, () => 2);",
    },
    want: ["ok:one"],
    forbid: [],
  },
  "neg:method-collision": {
    files: {
      "preload.js":
        "const { ipcRenderer } = require('electron');\nclass Bus { send(ch, d) { ipcRenderer.send(ch, d); } }\nconst ws = new WebSocket('wss://x');\nws.send('hello');\nconst b = new Bus();\nb.send('bus:ping', 1);",
      "main.js": "",
    },
    want: ["bus:ping"],
    forbid: ["hello"],
  },
  "neg:conditional": {
    files: {
      "main.js":
        "const { ipcMain } = require('electron');\nconst flag = Math.random() > 0.5;\nipcMain.handle(flag ? 'c:a' : 'c:b', () => 1);",
    },
    want: [],
    forbid: ["c:a", "c:b"],
  },
  "neg:reassigned": {
    files: {
      "main.js":
        "const { ipcMain } = require('electron');\nlet P = 'x:';\nif (process.env.Y) P = 'y:';\nipcMain.handle(P + 'a', () => 1);",
    },
    want: [],
    forbid: ["x:a", "y:a"],
  },
  "neg:shadowed": {
    files: {
      "main.js":
        "const { ipcMain } = require('electron');\nconst P = 'top:';\nfunction f() { const P = getPrefix(); ipcMain.handle(P + 'a', () => 1); }\nf();",
    },
    want: [],
    forbid: ["top:a"],
  },
  "neg:shadowed-param": {
    files: {
      "main.js":
        "const { ipcMain } = require('electron');\nconst P = 'top:';\nfunction f(P) { ipcMain.handle(P + 'a', () => 1); }\nf(window.prefix);",
    },
    want: [],
    forbid: ["top:a"],
  },
  "neg:mixed-array": {
    files: {
      "main.js":
        "const { ipcMain } = require('electron');\nconst list = ['m:a', computeName()];\nlist.forEach((c) => ipcMain.handle(c, () => 1));",
    },
    want: [],
    forbid: ["m:a"],
  },
  "neg:field-not-ipc": {
    files: {
      "main.js":
        "const { ipcMain } = require('electron');\nclass Net { constructor(sock) { this.ipc = sock; } go() { this.ipc.send('net:x'); } }\nnew Net(new WebSocket('wss://y')).go();\nipcMain.handle('real:x', () => 1);",
    },
    want: ["real:x"],
    forbid: ["net:x"],
  },
  "neg:unrelated-forEach": {
    files: {
      "main.js":
        "const { ipcMain } = require('electron');\nconst names = ['n:a', 'n:b'];\nnames.forEach((n) => console.log(n));\nipcMain.handle('n:real', () => 1);",
    },
    want: ["n:real"],
    forbid: ["n:a", "n:b"],
  },
  "neg:concat-unknown": {
    files: {
      "main.js": "const { ipcMain } = require('electron');\nipcMain.handle('win:' + id, () => 1);",
    },
    want: [],
    forbid: ["win:"],
  },
  "win:direct": {
    kind: "window",
    files: {
      "main.js":
        "const { BrowserWindow } = require('electron');\nnew BrowserWindow({ webPreferences: { contextIsolation: true, sandbox: true, preload: 'p.js' } });",
    },
    want: ["contextIsolation=true", "sandbox=true", "preload=p.js"],
  },
  "win:object-assign": {
    kind: "window",
    files: {
      "main.js":
        "const { BrowserWindow } = require('electron');\nconst base = { contextIsolation: true };\nconst prefs = Object.assign({}, base, { sandbox: false });\nnew BrowserWindow({ webPreferences: prefs });",
    },
    want: ["contextIsolation=true", "sandbox=false"],
  },
  "win:config-module": {
    kind: "window",
    files: {
      "main.js":
        "const { BrowserWindow } = require('electron');\nconst { WEB_PREFS } = require('./config');\nnew BrowserWindow({ width: 800, webPreferences: WEB_PREFS });",
      "config.js":
        "module.exports = { WEB_PREFS: { nodeIntegration: false, contextIsolation: true } };",
    },
    want: ["nodeIntegration=false", "contextIsolation=true"],
  },
  "win:config-module-esm": {
    kind: "window",
    files: {
      "main.js":
        "import { BrowserWindow } from 'electron';\nimport { prefs } from './config.js';\nnew BrowserWindow({ webPreferences: prefs });",
      "config.js": "export const prefs = { sandbox: true };",
    },
    want: ["sandbox=true"],
  },
  "win:factory": {
    kind: "window",
    files: {
      "main.js":
        "const { BrowserWindow } = require('electron');\nfunction createWindow(extra) { return new BrowserWindow({ width: 1, webPreferences: { contextIsolation: true, ...extra } }); }\ncreateWindow({ sandbox: false });",
    },
    want: ["contextIsolation=true", "sandbox=false"],
  },
  "win:spread-defaults": {
    kind: "window",
    files: {
      "main.js":
        "const { BrowserWindow } = require('electron');\nconst DEFAULTS = { webPreferences: { contextIsolation: true, sandbox: true } };\nnew BrowserWindow({ ...DEFAULTS, width: 400 });",
    },
    want: ["contextIsolation=true", "sandbox=true"],
  },
  "win:class-field": {
    kind: "window",
    files: {
      "main.js":
        "const { BrowserWindow } = require('electron');\nclass Win {\n  options = { webPreferences: { nodeIntegration: false, preload: 'pre.js' } };\n  open() { this.win = new BrowserWindow(this.options); }\n}\nnew Win().open();",
    },
    want: ["nodeIntegration=false", "preload=pre.js"],
  },
  "win:options-var": {
    kind: "window",
    files: {
      "main.js":
        "const { BrowserWindow } = require('electron');\nconst opts = { show: false, webPreferences: { webSecurity: false } };\nconst w = new BrowserWindow(opts);",
    },
    want: ["webSecurity=false"],
  },
  "win:preload-path": {
    kind: "window",
    files: {
      "main.js":
        "const { BrowserWindow } = require('electron');\nconst path = require('path');\nnew BrowserWindow({ webPreferences: { preload: path.join(__dirname, 'preload.js') } });",
    },
    want: ["preload=preload.js"],
  },
  "win:minified-bools": {
    kind: "window",
    files: {
      "main.js":
        "const {BrowserWindow:B}=require('electron');new B({webPreferences:{nodeIntegration:!1,contextIsolation:!0}});",
    },
    want: ["nodeIntegration=false", "contextIsolation=true"],
  },
  "win:browserview": {
    kind: "window",
    files: {
      "main.js":
        "const { BrowserView, WebContentsView } = require('electron');\nnew BrowserView({ webPreferences: { sandbox: true } });\nnew WebContentsView({ webPreferences: { contextIsolation: true } });",
    },
    want: ["sandbox=true", "contextIsolation=true"],
  },
  "win:not-a-window": {
    kind: "window",
    files: {
      "main.js":
        "const { BrowserWindow } = require('electron');\nconst webPreferences = { sandbox: false };\nconsole.log(webPreferences);\nnew BrowserWindow({ webPreferences: { sandbox: true } });",
    },
    want: ["sandbox=true"],
    forbid: ["sandbox=false"],
  },
  "winneg:assign-order": {
    kind: "window",
    files: {
      "main.js":
        "const { BrowserWindow } = require('electron');\nconst prefs = Object.assign({}, { sandbox: true }, { sandbox: false });\nnew BrowserWindow({ webPreferences: prefs });",
    },
    want: ["sandbox=false"],
    forbid: ["sandbox=true"],
  },
  "winneg:assign-unknown": {
    kind: "window",
    files: {
      "main.js":
        "const { BrowserWindow } = require('electron');\nconst prefs = Object.assign({ sandbox: true }, loadUserPrefs());\nnew BrowserWindow({ webPreferences: prefs });",
    },
    want: [],
    forbid: ["sandbox=true"],
  },
  "winneg:factory-unknown-caller": {
    kind: "window",
    files: {
      "main.js":
        "const { BrowserWindow } = require('electron');\nfunction make(extra) { return new BrowserWindow({ webPreferences: { ...extra } }); }\nmake({ sandbox: false });\nmake(userPrefs);",
    },
    want: [],
    forbid: ["sandbox=false"],
  },
  "winneg:assign-other-object": {
    kind: "window",
    files: {
      "main.js":
        "const { BrowserWindow } = require('electron');\nconst stats = Object.assign({}, { sandbox: false });\nnew BrowserWindow({ webPreferences: { sandbox: true } });",
    },
    want: ["sandbox=true"],
    forbid: ["sandbox=false"],
  },
};

function observe(c: Case): string[] {
  const info = analyzeJavaScriptTree(
    asarTree(
      buildAsar({
        "package.json": JSON.stringify({
          name: "p",
          main: "main.js",
          dependencies: { electron: "^30.0.0" },
        }),
        ...c.files,
      }),
      "app.asar",
    ),
  );
  return c.kind === "window"
    ? info.webPreferences.map((p) => `${p.key}=${String(p.value)}`)
    : info.ipcChannels.map((ch) => ch.channel);
}

/** Not read yet: window options declared in another module. The analysis must say so. */
const KNOWN_GAPS = new Set(["win:config-module", "win:config-module-esm"]);

describe("bounded expression resolution", () => {
  for (const name of KNOWN_GAPS)
    it(`${name} (known gap: reported as not followed, nothing invented)`, () => {
      const c = CASES[name]!;
      const info = analyzeJavaScriptTree(
        asarTree(
          buildAsar({ "package.json": JSON.stringify({ name: "p", main: "main.js" }), ...c.files }),
          "app.asar",
        ),
      );
      expect(info.webPreferences).toEqual([]);
      expect(info.limitations.map((l) => l.code)).toContain("window_options_unresolved");
    });
  for (const [name, c] of Object.entries(CASES).filter(([n]) => !KNOWN_GAPS.has(n)))
    it(name, () => {
      const got = observe(c);
      for (const want of c.want) expect(got).toContain(want);
      for (const forbid of c.forbid ?? []) expect(got).not.toContain(forbid);
    });

  it("says how a resolved channel was read and where it was bound", () => {
    const info = analyzeJavaScriptTree(
      asarTree(
        buildAsar({
          "package.json": JSON.stringify({ name: "p", main: "main.js" }),
          "main.js":
            "const { ipcMain } = require('electron');\nfunction secured(scope, channel, fn) { ipcMain.handle(channel, fn); }\nsecured('scope:x', 'sec:one', () => 1);",
        }),
        "app.asar",
      ),
    );
    const row = info.modules[0]!.ipc.find((u) => u.channel === "sec:one");
    expect(row).toMatchObject({ via: "resolved", resolution: { method: "parameter", lines: [3] } });
  });
});
