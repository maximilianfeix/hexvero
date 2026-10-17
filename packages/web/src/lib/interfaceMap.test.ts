import { describe, expect, it } from "vitest";
import {
  buildMap,
  CHANNEL_UNREAD,
  END_NOT_FOUND,
  endsNote,
  filterRows,
  hotEdges,
  type InterfaceRow,
  MAX_MEMBERS,
  memberId,
  rowKey,
  rowsOf,
} from "./interfaceMap.js";

const row = (over: Partial<InterfaceRow>): InterfaceRow => ({
  api: "app",
  member: "get",
  world: "main",
  file: "preload.js",
  line: 1,
  windows: ["main.js:win"],
  channel: "x:get",
  direction: "to-main",
  ends: [{ file: "main.js", line: 10, api: "ipcMain.handle" }],
  endsTotal: 1,
  endsTruncated: false,
  link: "direct",
  ...over,
});

const all = (rows: InterfaceRow[]) =>
  buildMap(
    rows,
    rows.map((_, i) => i),
  );

describe("interface map layout", () => {
  it("groups windows, members, channels and ends into four columns", () => {
    const rows = [
      row({}),
      row({
        member: "set",
        line: 2,
        channel: "x:set",
        ends: [{ file: "main.js", line: 11, api: "ipcMain.handle" }],
      }),
    ];
    const map = all(rows);
    expect(map.columns.window.map((n) => n.label)).toEqual(["main.js:win"]);
    expect(map.columns.member.map((n) => n.label)).toEqual(["window.app.get", "window.app.set"]);
    expect(map.columns.channel.map((n) => n.label)).toEqual(["x:get", "x:set"]);
    expect(map.columns.handler.map((n) => n.label)).toEqual(["main.js:10", "main.js:11"]);
    // one window shared by both members: one node, two edges
    expect(map.columns.window[0]!.rows).toEqual([0, 1]);
    expect(map.edges.filter((e) => e.kind === "window")).toHaveLength(2);
    expect(map.edges.filter((e) => e.kind === "direct")).toHaveLength(4);
    // same input, same layout
    expect(all(rows).columns.member.map((n) => n.y)).toEqual(map.columns.member.map((n) => n.y));
  });

  it("styles edges by how they were read", () => {
    const rows = [
      row({
        link: "resolved",
        ends: [{ file: "main.js", line: 3, api: "ipcMain.on", via: "constant" }],
      }),
      row({
        member: "dyn",
        line: 2,
        channel: null,
        ends: [],
        endsTotal: 0,
        link: "unresolved",
        reason: "built at run time",
      }),
      row({
        member: "maybe",
        line: 3,
        channel: "x:maybe",
        ends: [],
        endsTotal: 0,
        link: "unknown",
        reason: "blind spots",
      }),
      row({
        member: "lone",
        line: 4,
        channel: "x:lone",
        ends: [],
        endsTotal: 0,
        link: "none",
        reason: "no end",
      }),
    ];
    const map = all(rows);
    const kinds = (r: number) =>
      map.edges.filter((e) => e.rows.includes(r) && e.kind !== "window").map((e) => e.kind);
    expect(kinds(0)).toEqual(["resolved", "resolved"]);
    expect(kinds(1)).toEqual(["unresolved"]);
    expect(map.edges.find((e) => e.to === CHANNEL_UNREAD)!.reason).toBe("built at run time");
    expect(kinds(2)).toEqual(["direct", "unknown"]);
    expect(map.edges.find((e) => e.to === END_NOT_FOUND)!.reason).toBe("blind spots");
    // none: the member reaches its channel, and no edge leaves the channel
    expect(kinds(3)).toEqual(["direct"]);
    expect(map.nodes.get(memberId(rows[3]!))!.note).toContain("no handler found");
    // placeholders sit last in their column and are marked as such
    expect(map.columns.channel.at(-1)!.id).toBe(CHANNEL_UNREAD);
    expect(map.columns.channel.at(-1)!.placeholder).toBe(true);
  });

  it("caps the members it draws and says how many matched", () => {
    const rows = Array.from({ length: MAX_MEMBERS + 25 }, (_, i) =>
      row({ member: `m${i}`, line: i + 1, channel: `c${i}` }),
    );
    const map = all(rows);
    expect(map.shown).toBe(MAX_MEMBERS);
    expect(map.matched).toBe(MAX_MEMBERS + 25);
    expect(map.columns.member).toHaveLength(MAX_MEMBERS);
    expect(buildMap(rows, [0, 1, 2], 2).columns.member).toHaveLength(2);
  });

  it("searches members, channels and handler places", () => {
    const rows = [
      row({}),
      row({
        member: "save",
        channel: "notes:save",
        ends: [{ file: "ipc/notes.js", line: 4, api: "ipcMain.handle" }],
      }),
    ];
    expect(filterRows(rows, "")).toEqual([0, 1]);
    expect(filterRows(rows, "NOTES:SAVE")).toEqual([1]);
    expect(filterRows(rows, "window.app.get")).toEqual([0]);
    expect(filterRows(rows, "ipc/notes.js:4")).toEqual([1]);
    expect(filterRows(rows, "nothing")).toEqual([]);
  });

  it("uses the comparison key of the collection as member identity", () => {
    expect(rowKey(row({}))).toBe("preload.js::app::get");
    expect(rowKey(row({ member: null }))).toBe("preload.js::app::null");
  });

  it("highlights a member's whole path and reports its rows", () => {
    const rows = [row({}), row({ member: "other", line: 2, channel: "y" })];
    const map = all(rows);
    const id = memberId(rows[0]!);
    const hot = hotEdges(map, id);
    expect([...hot].every((e) => map.edges.find((x) => x.id === e)!.rows.includes(0))).toBe(true);
    expect(hot.size).toBe(3);
    expect(rowsOf(map, id)).toEqual([0]);
    expect(rowsOf(map, "w:main.js:win")).toEqual([0, 1]);
  });

  it("says when only some ends are listed", () => {
    expect(endsNote(row({ endsTotal: 41, endsTruncated: true }))).toBe("1 of 41 ends shown; all of them are in the ipc list");
    expect(endsNote(row({}))).toBe("");
  });
});
