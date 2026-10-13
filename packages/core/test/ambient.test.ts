import { describe, expect, it } from "vitest";
import { analyzeJavaScriptTree, asarTree } from "../src/javascript/app.js";
import { buildAsar } from "./fixtures/asar.js";

/** Analysis of an app made of these files; `package.json` is added. */
function analyze(files: Record<string, string>): ReturnType<typeof analyzeJavaScriptTree> {
  return analyzeJavaScriptTree(
    asarTree(
      buildAsar({ "package.json": JSON.stringify({ name: "x", main: "main/main.js" }), ...files }),
      "app.asar",
    ),
  );
}

/** `file api channel line via` of every IPC row, in file order. */
function rows(info: ReturnType<typeof analyzeJavaScriptTree>): string[] {
  return info.modules.flatMap((m) =>
    m.ipc.map((u) => `${m.id} ${u.api} ${u.channel} ${u.line}${u.via ? ` ${u.via}` : ""}`),
  );
}

const MAIN = [
  'const electron = require("electron");',
  "const { app, BrowserWindow, ipcMain: ipc } = electron;",
  'ipc.on("boot", () => {});',
].join("\n");

/** IPC rows of a main file that defines the enum `Channels` and then runs `extra`. */
const channel = (extra: string): string[] =>
  rows(
    analyze({
      "main/main.js": [
        'const { ipcMain } = require("electron");',
        '(function(Channels){Channels.SAVE="doc:save"})(Channels||(exports.Channels=Channels={}));',
        extra,
      ].join("\n"),
    }),
  );

describe("IPC through names another file defines", () => {
  it("resolves a renderer global assigned on window", () => {
    const info = analyze({
      "js/default.js": 'window.electron = require("electron");\nwindow.ipc = electron.ipcRenderer;',
      "js/tabs.js": [
        'ipc.send("tab:close", 1);',
        'ipc.on("tab:closed", () => {});',
        "function later () {",
        '  return ipc.invoke("tab:list");',
        "}",
      ].join("\n"),
    });
    expect(rows(info)).toEqual([
      "js/tabs.js ipcRenderer.send tab:close 1 global",
      "js/tabs.js ipcRenderer.on tab:closed 2 global",
      "js/tabs.js ipcRenderer.invoke tab:list 4 global",
    ]);
    expect(info.limitations.map((l) => l.code)).not.toContain("ipc_receiver_unresolved");
  });

  it("resolves a name bound at the top of a main-process file in its sibling files", () => {
    const info = analyze({
      "main/main.js": MAIN,
      "main/download.js": 'ipc.on("cancelDownload", () => {});\nipc.handle("downloads", () => []);',
    });
    expect(rows(info)).toEqual([
      "main/main.js ipcMain.on boot 3 alias",
      "main/download.js ipcMain.on cancelDownload 1 global",
      "main/download.js ipcMain.handle downloads 2 global",
    ]);
    expect(info.modules.find((m) => m.id === "main/download.js")?.role).toBe("main");
    expect(info.ipcChannels.map((c) => c.channel).toSorted()).toEqual([
      "boot",
      "cancelDownload",
      "downloads",
    ]);
  });

  it("lets the nearest definition decide when main and renderer use the same name", () => {
    const info = analyze({
      "main/main.js": MAIN,
      "main/menu.js": 'ipc.on("menu", () => {});',
      "js/default.js": 'window.ipc = require("electron").ipcRenderer;',
      "js/ui.js": 'ipc.send("menu");',
    });
    expect(rows(info)).toContain("main/menu.js ipcMain.on menu 1 global");
    expect(rows(info)).toContain("js/ui.js ipcRenderer.send menu 1 global");
    expect(info.ipcChannels).toEqual([
      { channel: "boot", senders: [], receivers: ["main/main.js"] },
      { channel: "menu", senders: ["js/ui.js"], receivers: ["main/menu.js"] },
    ]);
  });

  it("does not take a name the file binds itself, or an unrelated emitter", () => {
    const info = analyze({
      "main/main.js": MAIN,
      "main/a.js": 'function wire (ipc) {\n  ipc.on("param", () => {});\n}',
      "main/b.js": 'const ipc = makeBus();\nipc.on("own", () => {});',
      "main/c.js": 'emitter.on("event", () => {});\nsocket.send("frame");',
    });
    expect(rows(info)).toEqual(["main/main.js ipcMain.on boot 3 alias"]);
    expect(info.limitations.map((l) => l.code)).not.toContain("ipc_receiver_unresolved");
  });

  it("does not let a name bound at the top of a file reach another directory tree", () => {
    const info = analyze({
      "main/main.js": MAIN,
      "tools/report.js": 'ipc.on("report", () => {});',
    });
    expect(rows(info)).toEqual(["main/main.js ipcMain.on boot 3 alias"]);
    const limitation = info.limitations.find((l) => l.code === "ipc_receiver_unresolved");
    expect(limitation?.message).toContain('ipc.on("report") at tools/report.js:1');
  });

  it("reports calls it cannot trace with their location and lowers the finding's confidence", () => {
    const info = analyze({
      "main/main.js": 'const { ipcMain } = require("electron");\nipcMain.on("known", () => {});',
      "main/late.js": 'ipc.on("lost", () => {});\nipc.handle("alsoLost", () => {});',
    });
    expect(rows(info)).toEqual(["main/main.js ipcMain.on known 2"]);
    const limitation = info.limitations.find((l) => l.code === "ipc_receiver_unresolved");
    expect(limitation?.message).toMatch(/^2 call\(s\) that look like IPC/);
    expect(limitation?.message).toContain('ipc.on("lost") at main/late.js:1');
    expect(limitation?.message).toContain('ipc.handle("alsoLost") at main/late.js:2');
    expect(info.findings.find((f) => f.kind === "electron.ipc")?.confidence).toBe("inferred");
  });

  it("does not choose between definitions that disagree", () => {
    const info = analyze({
      "a/one.js": 'window.bus = require("electron").ipcRenderer;',
      "b/two.js": 'global.bus = require("electron").ipcMain;',
      "c/use.js": 'bus.on("which", () => {});',
    });
    expect(rows(info)).toEqual([]);
    expect(info.limitations.find((l) => l.code === "ipc_receiver_unresolved")?.message).toContain(
      'bus.on("which") at c/use.js:1',
    );
  });

  it("reports, and does not list, a method the resolved object does not have", () => {
    const info = analyze({
      "main/main.js": MAIN,
      "main/x.js": 'ipc.send("notIpcMain");\nipc.on("fine", () => {});',
    });
    expect(rows(info)).toEqual([
      "main/main.js ipcMain.on boot 3 alias",
      "main/x.js ipcMain.on fine 2 global",
    ]);
    expect(info.limitations.find((l) => l.code === "ipc_receiver_unresolved")?.message).toContain(
      'ipc.send("notIpcMain") at main/x.js:1',
    );
  });

  it("takes a global only when the assigned value is the object itself", () => {
    const info = analyze({
      "js/default.js": [
        'const { ipcRenderer } = require("electron");',
        "window.bus = wrap(ipcRenderer);",
        "window.count = 1, window.other = ipcRenderer.listenerCount;",
        'window.rpc = require("electron").ipcRenderer',
        "start()",
      ].join("\n"),
      "js/use.js": 'bus.on("wrapped", () => {});\nrpc.send("direct");',
    });
    expect(rows(info)).toEqual(["js/use.js ipcRenderer.send direct 2 global"]);
  });
});

describe("IPC on a page's own channel object", () => {
  it("lists handlers registered on webContents.ipc and not webContents events", () => {
    const info = analyze({
      "main/main.js": [
        'const { BrowserWindow } = require("electron");',
        "const win = new BrowserWindow({});",
        'win.webContents.ipc.on("set-title", () => {});',
        'win.webContents.on("did-finish-load", () => {});',
        'win.webContents.send("state", 1);',
      ].join("\n"),
    });
    expect(rows(info)).toEqual([
      "main/main.js ipcMain.on set-title 3 webContents",
      "main/main.js webContents.send state 5",
    ]);
  });
});

describe("main-to-page messages outside a written-out ipcMain listener", () => {
  it("lists replies in listeners registered under a global name, once", () => {
    const info = analyze({
      "main/main.js": MAIN,
      "main/actions.js": [
        'ipc.on("minimize", function (e) {',
        '  e.sender.send("minimized");',
        "});",
        'const { ipcMain } = require("electron");',
        'ipcMain.on("ask", (event) => {',
        '  event.sender.send("answer");',
        "});",
        'sender.send("notElectron");',
        'win.webContents.postMessage("port", null, [port]);',
      ].join("\n"),
    });
    expect(rows(info).filter((r) => r.startsWith("main/actions.js"))).toEqual([
      "main/actions.js ipcMain.on minimize 1 global",
      "main/actions.js event.sender.send minimized 2",
      "main/actions.js ipcMain.on ask 5",
      "main/actions.js event.sender.send answer 6",
      "main/actions.js webContents.postMessage port 9",
    ]);
  });
});

describe("a call written above the binding it uses", () => {
  it("resolves it when the file binds the name exactly once", () => {
    const info = analyze({
      "main/main.js": [
        "function settings () {",
        '  ipc.on("settingChanged", () => {});',
        "}",
        'const { ipcMain: ipc } = require("electron");',
        'ipc.on("boot", () => {});',
      ].join("\n"),
    });
    expect(rows(info)).toEqual([
      "main/main.js ipcMain.on settingChanged 2 alias",
      "main/main.js ipcMain.on boot 5 alias",
    ]);
  });

  it("leaves it alone when the name is bound a second time", () => {
    const info = analyze({
      "main/main.js": [
        "function settings (ipc) {",
        '  ipc.on("local", () => {});',
        "}",
        'const { ipcMain: ipc } = require("electron");',
        'ipc.on("boot", () => {});',
      ].join("\n"),
    });
    expect(rows(info)).toEqual(["main/main.js ipcMain.on boot 5 alias"]);
  });
});

describe("several calls on one line of minified code", () => {
  it("keeps rows that share line and channel but are different calls", () => {
    const info = analyze({
      "main/main.js":
        'const{ipcMain:a,BrowserWindow:b}=require("electron");const w=new b({});a.on("x",e=>{e.sender.send("x")});w.webContents.ipc.on("x",()=>{});w.webContents.postMessage("x");e.sender.send("x");',
    });
    expect(rows(info)).toEqual([
      "main/main.js ipcMain.on x 1 alias",
      "main/main.js event.sender.send x 1",
      "main/main.js ipcMain.on x 1 webContents",
      "main/main.js webContents.postMessage x 1",
      "main/main.js event.sender.send x 1",
    ]);
  });
});

describe("another name bound from the module itself", () => {
  it('resolves `const ipc = require("electron").ipcRenderer`', () => {
    const info = analyze({
      "renderer/tray.js": [
        "const ipc = require('electron').ipcRenderer",
        "const bus = require('events').ipcRenderer",
        "ipc.send('put-in-tray')",
        "ipc.on('tray-removed', function () {",
        "  ipc.send('remove-tray')",
        "})",
        "bus.send('notElectron')",
      ].join("\n"),
      "main/tray.js":
        "const ipc = require('electron/main').ipcMain\nipc.on('put-in-tray', () => {})",
    });
    expect(rows(info).toSorted()).toEqual([
      "main/tray.js ipcMain.on put-in-tray 2 alias",
      "renderer/tray.js ipcRenderer.on tray-removed 4 alias",
      "renderer/tray.js ipcRenderer.send put-in-tray 3 alias",
      "renderer/tray.js ipcRenderer.send remove-tray 5 alias",
    ]);
  });
});

describe("channels named by a compiled TypeScript enum", () => {
  const ENUM =
    'var Channels;(function(Channels){Channels["SAVE"]="doc:save";Channels.OPEN="doc:open"})(Channels||(exports.Channels=Channels={}));';
  const MINIFIED =
    '7(e,n){var i;n.IpcEvents=void 0,function(e){e.RUN="FIDDLE_RUN",e.QUIT="CONFIRM_QUIT"}(i||(n.IpcEvents=i={}))},';

  it("resolves Enum.MEMBER and module.Enum.MEMBER, also in minified output", () => {
    const info = analyze({
      "main/main.js": [
        'const { ipcMain } = require("electron");',
        ENUM,
        "ipcMain.handle(Channels.SAVE, () => {});",
        "ipcMain.on(shared.Channels.OPEN, () => {});",
        "ipcMain.on(Channels.MISSING, () => {});",
        "ipcMain.on(Other.SAVE, () => {});",
      ].join("\n"),
      "main/bundle.js": `const t=require("electron");var m={${MINIFIED}9(e,n,i){const c=i(7);t.ipcMain.handle(c.IpcEvents.RUN,()=>{});t.ipcMain.on(c.IpcEvents.QUIT,()=>{});t.ipcMain.on(i.RUN,()=>{})}};`,
    });
    expect(rows(info)).toEqual([
      "main/main.js ipcMain.handle doc:save 3 constant",
      "main/main.js ipcMain.on doc:open 4 constant",
      "main/main.js ipcMain.on null 5",
      "main/main.js ipcMain.on null 6",
      "main/bundle.js ipcMain.handle FIDDLE_RUN 1 constant",
      "main/bundle.js ipcMain.on CONFIRM_QUIT 1 constant",
      // `i` is the minifier's local for the enum inside one function, and something else here
      "main/bundle.js ipcMain.on null 1",
    ]);
  });

  it("says where a channel could not be read and lowers the finding's confidence", () => {
    const info = analyze({
      "main/main.js": [
        'const { ipcMain } = require("electron");',
        'ipcMain.on("known", () => {});',
        "names.forEach((name) => ipcMain.on(name, () => {}));",
      ].join("\n"),
    });
    const limitation = info.limitations.find((l) => l.code === "ipc_channel_unresolved");
    expect(limitation?.message).toMatch(/^1 IPC call\(s\) pass a channel that is not a literal/);
    expect(limitation?.message).toContain("ipcMain.on at main/main.js:3");
    expect(info.findings.find((f) => f.kind === "electron.ipc")?.confidence).toBe("inferred");
  });

  it("resolves nothing through an enum name that two different enums share", () => {
    const info = analyze({
      "main/main.js": [
        'const { ipcMain } = require("electron");',
        '(function(Kind){Kind.A="one"})(Kind||(Kind={}));',
        '(function(Kind){Kind.A="two"})(Kind||(Kind={}));',
        "ipcMain.on(Kind.A, () => {});",
      ].join("\n"),
    });
    expect(rows(info)).toEqual(["main/main.js ipcMain.on null 4"]);
  });

  it("resolves nothing through an enum name that the file also binds to something else", () => {
    // a local of the same name is a different object
    expect(
      channel(
        'function f () { const Channels = { SAVE: "other" }; ipcMain.on(Channels.SAVE, g); }',
      ),
    ).toEqual(["main/main.js ipcMain.on null 3"]);
    expect(channel("function f (Channels) { ipcMain.on(Channels.SAVE, g); }")).toEqual([
      "main/main.js ipcMain.on null 3",
    ]);
    expect(channel('other.Channels = { SAVE: "x" }; ipcMain.on(other.Channels.SAVE, g);')).toEqual([
      "main/main.js ipcMain.on null 3",
    ]);
    // the forms compilers emit around the definition leave it resolvable
    expect(
      channel("var Channels;\nexports.Channels = void 0;\nipcMain.on(Channels.SAVE, g);"),
    ).toEqual(["main/main.js ipcMain.on doc:save 5 constant"]);
  });
});
