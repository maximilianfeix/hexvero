import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildSync } from "esbuild";
import { afterAll, describe, expect, it } from "vitest";
import { Session } from "../src/session.js";
import { buildAsar } from "./fixtures/asar.js";

/**
 * Comparing two builds whose preload exposes generic forwarders (`send(channel, data)` behind an
 * allow-list, #221): the forwarder detail on the member row (`forwards`, `allowed`, `guard`) is
 * content, its line a position. Two builds that differ only in lines around the forwarders give
 * no contextBridge or ipc change; an allow-list in another order is the same list; a channel
 * taken out of the list is a change of every member that checks it, and of the page's call of
 * that channel (`allowed` yes → no). Plain, bundled and minified. Nothing is run.
 */

const dir = mkdtempSync(join(tmpdir(), "hexvero-forwarder-compare-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const MAIN = `const { ipcMain, BrowserWindow } = require("electron");
new BrowserWindow({ webPreferences: { preload: require("path").join(__dirname, "preload.js"), sandbox: true } });
ipcMain.handle("shopping:items", () => []);
ipcMain.on("shopping:toggle", () => {});
ipcMain.on("shopping:clear", () => {});
`;

const LIST = ["shopping:items", "shopping:toggle", "shopping:clear", "shopping:changed"];

/** The preload: `extra` lines above and between the members, the allow-list as given. */
function preload(list: readonly string[], extra: boolean): string {
  const pad = extra ? "// sandboxed: only electron can be required here\n// (see main.js)\n" : "";
  return `${pad}const { contextBridge, ipcRenderer } = require("electron");
${pad}const validChannels = [
${list.map((c) => `  "${c}",`).join("\n")}
];
${pad}const shoppingAPI = {
  send: (channel, data) => {
    ${extra ? "// allowed channels only\n    " : ""}if (validChannels.includes(channel)) {
      ipcRenderer.send(channel, data);
    }
  },
  request: (channel, data) => {
    if (validChannels.includes(channel)) {
      return ipcRenderer.invoke(channel, data);
    }
    return Promise.reject(new Error("Blocked channel " + channel));
  },
  receive: (channel, callback) => {
    if (validChannels.includes(channel)) {
      ${extra ? "// the event is not passed on\n      " : ""}ipcRenderer.on(channel, (_, data) => callback(data));
    }
  },
  platform: process.platform,
};
contextBridge.exposeInMainWorld("shopping", shoppingAPI);
${pad}window.addEventListener("DOMContentLoaded", () => {
  ipcRenderer.send("app-window:mounted");
});
`;
}

const RENDERER = `window.shopping.receive("shopping:changed", (items) => console.log(items));
window.shopping.request("shopping:items").then((items) => console.log(items));
document.body.onclick = () => window.shopping.send("shopping:toggle", 1);
document.body.ondblclick = () => window.shopping.send("shopping:clear");
`;

type Mode = "plain" | "bundled" | "minified";

function files(mode: Mode, list: readonly string[], extra: boolean): Record<string, string> {
  const sources = { "main.js": MAIN, "preload.js": preload(list, extra), "renderer.js": RENDERER };
  if (mode === "plain") return sources;
  const src = mkdtempSync(join(dir, "src-"));
  const out: Record<string, string> = {};
  for (const [name, text] of Object.entries(sources)) {
    mkdirSync(dirname(join(src, name)), { recursive: true });
    writeFileSync(join(src, name), text);
    const outfile = join(src, "out", name);
    buildSync({
      entryPoints: [join(src, name)],
      bundle: true,
      minify: mode === "minified",
      platform: name === "renderer.js" ? "browser" : "node",
      format: name === "renderer.js" ? "iife" : "cjs",
      external: ["electron"],
      outfile,
      logLevel: "silent",
    });
    out[name] = readFileSync(outfile, "utf8");
  }
  return out;
}

let n = 0;
async function compare(
  mode: Mode,
  a: { list: readonly string[]; extra: boolean },
  b: { list: readonly string[]; extra: boolean },
) {
  const session = new Session();
  const open = async (side: { list: readonly string[]; extra: boolean }) => {
    const path = join(dir, `app-${n++}.asar`);
    writeFileSync(
      path,
      buildAsar({
        "package.json": JSON.stringify({ name: "shop", main: "main.js" }),
        ...files(mode, side.list, side.extra),
      }),
    );
    return session.open(path);
  };
  const [ta, tb] = [await open(a), await open(b)];
  const bridge = (await session.compareCollection(ta.id, tb.id, "contextBridge")).diff;
  const ipc = (await session.compareCollection(ta.id, tb.id, "ipc")).diff;
  const forwarders = (await session.items(ta.id, "contextBridge")).filter(
    (m) => (m as { forwards?: string }).forwards,
  );
  return { bridge, ipc, forwarders };
}

const summary = (d: { added: string[]; removed: string[]; changed: { key: string }[] }) => ({
  added: d.added,
  removed: d.removed,
  changed: d.changed.map((c) => c.key),
});
const NONE = { added: [], removed: [], changed: [] };

describe("compare of generic bridge forwarders (#221)", () => {
  for (const mode of ["plain", "bundled", "minified"] as const) {
    it(`gives no change for lines added around the forwarders (${mode})`, async () => {
      const r = await compare(mode, { list: LIST, extra: false }, { list: LIST, extra: true });
      // the forwarders are read with their allow-list in every build; minified, `request` is
      // `i.includes(e)?n.invoke(e,r):Promise.reject(…)`
      const rows = r.forwarders as { member: string; allowed?: string[] }[];
      expect(rows.map((m) => `${m.member} ${m.allowed?.join("|")}`).toSorted()).toEqual(
        ["receive", "request", "send"].map((m) => `${m} ${LIST.join("|")}`),
      );
      expect(summary(r.bridge)).toEqual(NONE);
      expect(summary(r.ipc)).toEqual(NONE);
    });

    it(`gives no change for the same allow-list in another order (${mode})`, async () => {
      const r = await compare(
        mode,
        { list: LIST, extra: false },
        { list: LIST.toReversed(), extra: true },
      );
      expect(summary(r.bridge)).toEqual(NONE);
      expect(summary(r.ipc)).toEqual(NONE);
    });

    it(`gives a change of each checking member when the allow-list changes (${mode})`, async () => {
      const without = LIST.filter((c) => c !== "shopping:toggle");
      const r = await compare(mode, { list: LIST, extra: false }, { list: without, extra: true });
      expect(summary(r.bridge)).toEqual({
        added: [],
        removed: [],
        changed: ["shopping::send", "shopping::request", "shopping::receive"],
      });
      for (const c of r.bridge.changed) expect(c.fields.map((f) => f.field)).toEqual(["allowed"]);
      // the page's call of the channel taken out is now blocked: allowed yes → no
      expect(r.ipc.added).toEqual([]);
      expect(r.ipc.removed).toEqual([]);
      expect(r.ipc.changed.map((c) => c.fields)).toEqual([
        [{ field: "allowed", before: "yes", after: "no" }],
      ]);
    });
  }
});
