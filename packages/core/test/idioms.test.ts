import { describe, expect, it } from "vitest";
import { analyzeJavaScriptTree, asarTree } from "../src/javascript/app.js";
import { buildAsar } from "./fixtures/asar.js";

/** Analysis of an app made of these files; `package.json` is added. */
function analyze(files: Record<string, string>): ReturnType<typeof analyzeJavaScriptTree> {
  return analyzeJavaScriptTree(
    asarTree(
      buildAsar({ "package.json": JSON.stringify({ name: "x", main: "main.js" }), ...files }),
      "app.asar",
    ),
  );
}

const channels = [
  "class Library {",
  '  static LIST = "library:list";',
  '  static REFRESH = "library:refresh";',
  "}",
  'const Playback = Object.freeze({ STATE: "playback:state" });',
  "module.exports = { Library, Playback };",
].join("\n");

const app = analyze({
  "shared/channels.js": channels,
  // A module that passes everything of another one on.
  "shared/index.js": 'const channels = require("./channels");\nmodule.exports = { ...channels };',
  "main.js": [
    'const { ipcMain } = require("electron");',
    'const { Library, Playback } = require("./shared");',
    "const routes = [",
    "  [Library.LIST, () => []],",
    '  ["library:add", () => 1],',
    "];",
    "const more = new Map([[Library.REFRESH, () => 0]]);",
    "for (const [channel, fn] of routes) ipcMain.handle(channel, fn);",
    "for (const [channel, fn] of more) ipcMain.handle(channel, fn);",
    'ipcMain.on("player:hello", (event) => {',
    "  event.reply(Playback.STATE, {});",
    "});",
  ].join("\n"),
  "preload.js": [
    'const { contextBridge, ipcRenderer } = require("electron");',
    'const { Library } = require("./shared/channels");',
    "const call = (ch) => (...a) => ipcRenderer.invoke(ch, ...a);",
    "const base = { list: call(Library.LIST) };",
    'const extra = { add: () => ipcRenderer.invoke("library:add") };',
    'contextBridge.exposeInMainWorld("lib", Object.assign(base, extra));',
    "contextBridge.exposeInMainWorld(",
    '  "player",',
    '  Object.freeze({ hello: () => ipcRenderer.send("player:hello") }),',
    ");",
  ].join("\n"),
});

describe("idioms of channel and bridge definitions", () => {
  it("reads members of objects exposed through Object.assign and Object.freeze", () => {
    expect(app.contextBridge.map((b) => `${b.api}.${b.member} ${b.channel}`)).toEqual([
      "lib.list library:list",
      "lib.add library:add",
      "player.hello player:hello",
    ]);
  });

  it("reads static string fields of a class as a table, also through a spread re-export", () => {
    const main = app.modules.find((m) => m.id === "main.js")!;
    expect(main.ipc.map((u) => `${u.api} ${u.channel}`)).toEqual([
      "ipcMain.handle library:list",
      "ipcMain.handle library:add",
      "ipcMain.handle library:refresh",
      "ipcMain.on player:hello",
      "event.reply playback:state",
    ]);
  });

  it("never claims members for an exposed value it cannot read whole", () => {
    const other = analyze({
      "main.js": "",
      "preload.js": [
        'const { contextBridge } = require("electron");',
        'contextBridge.exposeInMainWorld("api", Object.assign(makeApi(), { a: () => 1 }));',
      ].join("\n"),
    });
    expect(other.contextBridge).toEqual([
      expect.objectContaining({ api: "api", member: null, channel: null }),
    ]);
  });
});
