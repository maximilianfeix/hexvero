import { describe, expect, it } from "vitest";
import { compareItems, positionalFields } from "../src/compare.js";
import { interfaceMap } from "../src/javascript/interfaces.js";

type App = Parameters<typeof interfaceMap>[0];

const app = (over: Partial<App> = {}): App =>
  ({
    modules: [
      {
        id: "main.js",
        ipc: [
          { api: "ipcMain.handle", channel: "doc:open", line: 40 },
          { api: "ipcMain.handle", channel: "doc:save", line: 44, via: "constant" },
          { api: "webContents.send", channel: "doc:changed", line: 50 },
        ],
      },
      {
        id: "preload.js",
        ipc: [
          { api: "ipcRenderer.invoke", channel: "doc:open", line: 3 },
          { api: "ipcRenderer.invoke", channel: "doc:save", line: 4 },
          { api: "ipcRenderer.on", channel: "doc:changed", line: 5 },
          { api: "ipcRenderer.invoke", channel: "doc:print", line: 6 },
        ],
      },
      // Renderer code that calls ipcRenderer itself is not an end of a preload member.
      { id: "renderer.js", ipc: [{ api: "ipcRenderer.send", channel: "doc:open", line: 9 }] },
    ],
    contextBridge: [
      {
        api: "docs",
        member: "open",
        channel: "doc:open",
        world: "main",
        file: "preload.js",
        line: 3,
      },
      {
        api: "docs",
        member: "save",
        channel: "doc:save",
        world: "main",
        file: "preload.js",
        line: 4,
      },
      {
        api: "docs",
        member: "onChanged",
        channel: "doc:changed",
        world: "main",
        file: "preload.js",
        line: 5,
      },
      {
        api: "docs",
        member: "print",
        channel: "doc:print",
        world: "main",
        file: "preload.js",
        line: 6,
      },
      { api: "docs", member: "version", channel: null, world: "main", file: "preload.js", line: 7 },
    ],
    windows: [{ file: "main.js", windowName: "win", line: 12, preload: "preload.js" }],
    coverage: { complete: true },
    ...over,
  }) as unknown as App;

describe("interface map", () => {
  const rows = interfaceMap(app(), []);
  const by = (member: string) => rows.find((r) => r.member === member)!;

  it("links a member to its main-process end by the exact channel, with file and line", () => {
    expect(by("open")).toMatchObject({
      windows: ["main.js:win"],
      direction: "to-main",
      ends: [{ file: "main.js", line: 40, api: "ipcMain.handle" }],
      link: "direct",
    });
    expect(by("open").ends.some((e) => e.file === "renderer.js")).toBe(false);
  });

  it("says when an end was reached through a constant or an alias", () => {
    expect(by("save")).toMatchObject({ link: "resolved", ends: [{ via: "constant" }] });
  });

  it("follows a member that listens to the main process to the sender", () => {
    expect(by("onChanged")).toMatchObject({ direction: "to-renderer", link: "direct" });
  });

  it("reports no end only when the analysis could have seen one", () => {
    expect(by("print")).toMatchObject({ link: "none", ends: [], direction: null });
    const blind = interfaceMap(app(), [{ code: "ipc_channel_unresolved", message: "" }]);
    expect(blind.find((r) => r.member === "print")).toMatchObject({ link: "unknown" });
    expect(blind.find((r) => r.member === "print")?.reason).toContain("ipc_channel_unresolved");
    const partial = interfaceMap(app({ coverage: { complete: false } as App["coverage"] }), []);
    expect(partial.find((r) => r.member === "print")?.reason).toContain("scan_partial");
  });

  it("never invents a channel for a member whose channel is unknown", () => {
    expect(by("version")).toMatchObject({ link: "unresolved", channel: null, ends: [] });
  });

  it("does not link a window whose preload is another file", () => {
    const other = interfaceMap(
      app({
        windows: [{ file: "main.js", windowName: "about", line: 3, preload: "about.js" }],
      } as Partial<App>),
      [],
    );
    expect(other.every((r) => r.windows.length === 0)).toBe(true);
  });
});

const ipcRows = (shift: number) => [
  { module: "main.js", api: "ipcMain.on", channel: "a", line: 1 + shift },
  { module: "main.js", api: "ipcMain.on", channel: "a", line: 9 + shift },
  { module: "main.js", api: "ipcMain.handle", channel: "b", line: 5 + shift },
];

/** IPC rows of a single file: no `module`. */
const singleFileRows = (shift: number) => [
  { api: "ipcMain.on", channel: "a", line: 1 + shift },
  { api: "ipcMain.handle", channel: "b", line: 5 + shift },
  { api: "ipcMain.handle", channel: null, line: 7 + shift },
];

describe("comparing interface rows", () => {
  const options = { collection: "interfaces", positional: positionalFields("interfaces", []) };

  it("treats a member and its ends that only moved as relocated, and a new end as a change", () => {
    const before = interfaceMap(app(), []);
    const moved = app();
    for (const m of moved.modules) for (const u of m.ipc) u.line += 30;
    for (const b of moved.contextBridge) b.line += 30;
    const after = interfaceMap(moved, []);
    const same = compareItems(before, after, options);
    expect([same.added, same.removed, same.changed]).toEqual([[], [], []]);
    expect(same.relocated).toBe(before.length);

    const gone = app();
    gone.modules[0]!.ipc = gone.modules[0]!.ipc.filter((u) => u.channel !== "doc:open");
    const diff = compareItems(before, interfaceMap(gone, []), options);
    expect(diff.changed.map((c) => c.key)).toEqual(["preload.js::docs::open"]);
    expect(diff.changed[0]?.fields.map((f) => f.field)).toContain("link");
  });

  it("matches a single file's IPC calls that only moved, whose rows have no module", () => {
    const diff = compareItems(singleFileRows(0), singleFileRows(4), {
      collection: "ipc",
      positional: positionalFields("ipc", []),
    });
    expect(diff.key).toBe("api+channel");
    expect([diff.added, diff.removed, diff.changed]).toEqual([[], [], []]);
    expect(diff.relocated).toBe(3);
  });

  it("matches IPC calls that only moved instead of reporting them removed and added", () => {
    const diff = compareItems(ipcRows(0), ipcRows(20), {
      collection: "ipc",
      positional: positionalFields("ipc", []),
    });
    expect([diff.added, diff.removed, diff.changed]).toEqual([[], [], []]);
    expect(diff.relocated).toBe(3);
  });
});
