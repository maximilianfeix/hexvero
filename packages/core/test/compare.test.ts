import { describe, expect, it } from "vitest";
import {
  canonical,
  compareItems,
  detectKey,
  positionalFields,
  storageSlot,
  type SideCoverage,
  type UnresolvedFamily,
} from "../src/compare.js";

const dotnetMethods = (shift: number, extra: object[] = []): object[] => [
  { type: "A", name: ".ctor", rva: `0x${(0x2000 + shift).toString(16)}`, flags: ["public"] },
  { type: "B", name: ".ctor", rva: `0x${(0x2100 + shift).toString(16)}`, flags: ["public"] },
  { type: "A", name: "Run", rva: `0x${(0x2200 + shift).toString(16)}`, flags: ["public"] },
  ...extra,
];

const bridgeRows = (shift: number, extra: object[] = []): object[] => [
  ...Array.from({ length: 12 }, (_, i) => ({
    api: "api",
    member: `m${i}`,
    channel: `c:${i}`,
    world: "main",
    file: "preload.js",
    line: 4 + i + shift,
  })),
  {
    api: "legacy",
    member: null,
    channel: null,
    world: "main",
    file: "old.js",
    line: 2 + shift,
  },
  ...extra,
];

const elfSymbols = (shift: number, extra: string[] = []): object[] => [
  ...Array.from({ length: 40 }, (_, i) => ({
    name: `fn_${i}`,
    value: `0x${(0x1000 + i * 16 + shift).toString(16)}`,
    type: "FUNC",
  })),
  { name: "crtstuff.c", value: "0x0", type: "FILE" },
  { name: "crtstuff.c", value: "0x0", type: "FILE" },
  { name: "__gmon_start__", value: "0x0", type: "NOTYPE" },
  { name: "__gmon_start__", value: "0x0", type: "NOTYPE" },
  ...extra.map((name) => ({ name, value: "0x9000", type: "FUNC" })),
];

/** One `webPreferences` row of a bundled main process. */
const pref = (windowName: string, window: number, key: string, value: boolean, line: number) => ({
  key,
  value,
  file: "main.build.js",
  line,
  window,
  windowName,
});

const ipcRow = (file: string, channel: string): Record<string, unknown> => ({
  module: file,
  api: "ipcMain.on",
  channel,
  line: 1,
});

const wholeSide = (...files: string[]): SideCoverage => ({
  complete: true,
  read: new Set(files),
  unreadable: new Set<string>(),
  unresolved: new Map(),
});

const unresolvedIn = (family: UnresolvedFamily, ...files: string[]): SideCoverage => ({
  ...wholeSide("main.js", "extra.js"),
  unresolved: new Map([[family, new Set(files)]]),
});

const storageRow = (kind: string, value: string) => ({
  file: "index.js",
  kind,
  value,
  op: "read",
  evidence: "inferred",
  line: 2,
  column: 1,
  count: 1,
});

const interfaceRow = (link: string, reason: string) => ({
  file: "preload.js",
  api: "api",
  member: "go",
  channel: "a:b",
  direction: null,
  ends: [],
  link,
  reason,
  line: 2,
});

const finding = (kind: string, title: string, location?: string) => ({
  kind,
  title,
  confidence: "confirmed",
  ...(location ? { location } : {}),
});

const filePref = (file: string, windowName: string, value: boolean) => ({
  key: "sandbox",
  value,
  file,
  line: 3,
  window: 1,
  windowName,
});

const namedWindowPref = (windowName: string, window: number) => ({
  key: "sandbox",
  value: true,
  file: "main.js",
  line: window,
  window,
  windowName,
});

/** A `windows` row with an explanation and, optionally, keys that could not be read. */
const windowRow = (computed: string[] | undefined, basis: string) => ({
  file: "main.js",
  window: 1,
  windowName: "win",
  line: 3,
  sandbox: true,
  basis,
  ...(computed ? { computed } : {}),
});

describe("compareItems", () => {
  const a = [
    { name: "main", size: 40, address: "0x1000" },
    { name: "helper", size: 10, address: "0x1100" },
    { name: "old", size: 8, address: "0x1200" },
  ];
  const b = [
    { name: "main", size: 48, address: "0x1000" },
    { name: "helper", size: 10, address: "0x1180" }, // moved only
    { name: "fresh", size: 4, address: "0x1300" },
  ];

  it("detects the identity field and classifies added, removed, changed, relocated and unchanged", () => {
    expect(detectKey(a, b)).toBe("name");
    // nothing is set aside unless asked: by default the moved address is a change like any other
    expect(compareItems(a, b).changed.map((c) => c.key)).toEqual(["main", "helper"]);
    const diff = compareItems(a, b, { positional: ["address"] });
    expect(diff.key).toBe("name");
    expect(diff.added).toEqual(["fresh"]);
    expect(diff.removed).toEqual(["old"]);
    expect(diff.unchanged).toBe(0);
    expect(diff.relocated).toBe(1);
    expect(diff.changed).toEqual([
      {
        key: "main",
        fields: [{ field: "size", before: 40, after: 48 }],
        before: a[0],
        after: b[0],
      },
    ]);
    expect(diff.compared).toEqual({ a: 3, b: 3 });
    expect(diff.positional).toEqual(["address"]);
    expect(diff.relocatedSample).toMatchObject([
      { key: "helper", fields: [{ field: "address", before: "0x1100", after: "0x1180" }] },
    ]);
  });

  it("refuses non-unique identity fields and falls back to content", () => {
    const methods = [
      { selector: "init", class: "A" },
      { selector: "init", class: "B" },
      { selector: "dealloc", class: "A" },
    ];
    expect(detectKey(methods, methods)).toBeNull();
    const diff = compareItems(methods, methods.slice(0, 2));
    expect(diff.key).toBeNull();
    expect(diff.removed).toEqual([canonical(methods[2])]);
    expect(diff.unchanged).toBe(2);
  });

  it("requires the field on both sides and reports a missing explicit key", () => {
    const left = Array.from({ length: 100 }, (_, i) => ({ name: `f${i}` }));
    const right = Array.from({ length: 10 }, (_, i) => ({ id: i }));
    expect(detectKey(left, right)).toBeNull();
    const missing = compareItems(a, b, { key: "typo" });
    expect(missing.keyMissing).toBe(true);
    expect(missing.key).toBeNull();
    const explicit = compareItems(a, b, { key: "address" });
    expect(explicit.key).toBe("address");
    expect(explicit.added.toSorted()).toEqual(["0x1180", "0x1300"]);
    expect(explicit.removed.toSorted()).toEqual(["0x1100", "0x1200"]);
    const forced = compareItems(a, b, { key: null });
    expect(forced.key).toBeNull();
  });

  it("counts items, not keys, for duplicates on either side", () => {
    // 198 unique names plus one duplicated name keep `name` above the 99% distinct threshold
    const base = Array.from({ length: 198 }, (_, i) => ({ name: `f${i}`, v: i }));
    const left = [...base, { name: "dup", v: 1 }, { name: "dup", v: 2 }, { name: "solo", v: 0 }];
    const same = compareItems(left, [...left].toReversed());
    expect(same.key).toBe("name");
    expect(same.unchanged).toBe(201);
    expect(same.duplicateKeys).toBe(1);
    const moved = compareItems(left, [
      ...base,
      { name: "dup", v: 1 },
      { name: "dup", v: 3 },
      { name: "dup", v: 4 },
    ]);
    expect(moved.unchanged).toBe(199);
    expect(moved.removed.toSorted()).toEqual(["dup", "solo"]);
    expect(moved.added).toEqual(["dup", "dup"]);
    expect(moved.added.length + moved.removed.length + 2 * moved.unchanged).toBe(
      moved.compared.a + moved.compared.b,
    );
  });

  it("ignores key order, distinguishes string and number keys and handles scalars", () => {
    const reordered = compareItems(
      [{ name: "x", a: 1, b: { c: 2, d: 3 } }],
      [{ b: { d: 3, c: 2 }, a: 1, name: "x" }],
    );
    expect(reordered.unchanged).toBe(1);
    expect(reordered.changed).toEqual([]);
    const typed = compareItems([{ id: 1 }], [{ id: "1" }]);
    expect(typed.key).toBe("id");
    expect(typed.added).toEqual(["1"]);
    expect(typed.removed).toEqual(["1"]);
    const plain = compareItems([1, 2, 3], [2, 3, 4]);
    expect(plain.key).toBeNull();
    expect(plain.added).toEqual(["4"]);
    expect(plain.removed).toEqual(["1"]);
    expect(plain.unchanged).toBe(2);
    expect(compareItems([], []).key).toBeNull();
  });

  it("never hides a content change behind a position rule (regression: value old → new)", () => {
    const before = [{ name: "setting", value: "old" }];
    const after = [{ name: "setting", value: "new" }];
    // default: a change
    const plain = compareItems(before, after);
    expect(plain.relocated).toBe(0);
    expect(plain.changed).toMatchObject([
      { key: "setting", fields: [{ field: "value", before: "old", after: "new" }] },
    ]);
    // even with `value` declared positional, text is content, not an address
    const guarded = compareItems(before, after, { positional: ["value"] });
    expect(guarded.relocated).toBe(0);
    expect(guarded.changed.map((c) => c.key)).toEqual(["setting"]);
    // an address move in the same field is a relocation
    const moved = compareItems([{ name: "f", value: "0x1000" }], [{ name: "f", value: "0x2000" }], {
      positional: ["value"],
    });
    expect(moved.relocated).toBe(1);
    expect(moved.changed).toEqual([]);
    // a move plus a content change is a change that lists only the content path
    const both = compareItems(
      [{ name: "f", value: "0x1000", size: 4 }],
      [{ name: "f", value: "0x2000", size: 8 }],
      { positional: ["value"] },
    );
    expect(both.changed).toMatchObject([
      { key: "f", fields: [{ field: "size", before: 4, after: 8 }] },
    ]);
    // only an explicit ignore hides content, and it is echoed
    const ignored = compareItems(before, after, { ignore: ["value"] });
    expect(ignored.unchanged).toBe(1);
    expect(ignored.ignored).toEqual(["value"]);
  });

  it("applies position rules only to native collections", () => {
    expect(positionalFields("symbols", ["macho", "macho"])).toEqual(["value"]);
    expect(positionalFields("exports", ["elf", "elf"])).toContain("value");
    expect(positionalFields("sections", ["pe", "pe"])).toContain("offset");
    expect(positionalFields("entitlements", ["macho", "macho"])).toEqual([]);
    expect(positionalFields("symbols", ["macho", "asar"])).toEqual([]);
    expect(positionalFields("manifest", ["jar", "jar"])).toEqual([]);
    expect(positionalFields("symbols", [])).toEqual([]);
  });

  it("matches window settings by the window's name when a window is added before it", () => {
    const before = [
      pref("mainWindow", 1, "nodeIntegration", true, 10),
      pref("promptWindow", 2, "nodeIntegration", true, 40),
      pref("promptWindow", 2, "sandbox", false, 41),
    ];
    const after = [
      pref("mainWindow", 1, "nodeIntegration", true, 12),
      pref("translateWindow", 2, "nodeIntegration", false, 30),
      pref("promptWindow", 3, "nodeIntegration", false, 60),
      pref("promptWindow", 3, "sandbox", true, 61),
    ];
    const diff = compareItems(before, after, {
      collection: "webPreferences",
      positional: positionalFields("webPreferences", ["javascript-app", "javascript-app"]),
    });
    expect(diff.key).toBe("file+windowName+key");
    expect(diff.added).toEqual(["main.build.js::translateWindow::nodeIntegration"]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed.map((c) => c.key)).toEqual([
      "main.build.js::promptWindow::nodeIntegration",
      "main.build.js::promptWindow::sandbox",
    ]);
    // the moved line and the shifted window number are positions, not changes
    expect(diff.relocated).toBe(1);
  });

  it("treats the source line of an Electron fact as a position, not as content", () => {
    expect(positionalFields("contextBridge", ["asar", "asar"])).toEqual(["line"]);
    expect(positionalFields("webPreferences", ["asar", "javascript-app"])).toEqual([
      "line",
      "window",
    ]);
    const added = {
      api: "api",
      member: "new",
      channel: null,
      world: "main",
      file: "preload.js",
      line: 3,
    };
    const diff = compareItems(bridgeRows(0), bridgeRows(7, [added]), {
      collection: "contextBridge",
      positional: positionalFields("contextBridge", ["asar", "asar"]),
    });
    expect(diff.key).toBe("api+member");
    expect(diff.added).toEqual(["api::new"]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([]);
    expect(diff.unchanged + diff.relocated).toBe(13);
    // strict mode keeps the line as content
    expect(
      compareItems(bridgeRows(0), bridgeRows(7), { collection: "contextBridge" }).changed,
      // the 12 members and the entry without a readable member, which is matched by its api
    ).toHaveLength(13);
  });

  it("reports nested changes by path", () => {
    const diff = compareItems(
      [{ name: "win", webPreferences: { sandbox: false, nodeIntegration: true, extra: { a: 1 } } }],
      [{ name: "win", webPreferences: { sandbox: true, nodeIntegration: true, extra: { a: 2 } } }],
    );
    expect(diff.changed[0]?.fields).toEqual([
      { field: "webPreferences.extra.a", before: 1, after: 2 },
      { field: "webPreferences.sandbox", before: false, after: true },
    ]);
  });

  it("is strict about what counts as an address", () => {
    const rule = { positional: ["value"] };
    for (const [before, after] of [
      ["10", "11"],
      ["deadbeef", "cafe"],
      ["abc", "abd"],
      [null, "0x10"],
      ["1.0", "1.1"],
      [true, 1],
    ] as const) {
      const d = compareItems([{ name: "x", value: before }], [{ name: "x", value: after }], rule);
      expect(d.relocated, `${String(before)} → ${String(after)}`).toBe(0);
      expect(d.changed).toHaveLength(1);
    }
    // a field that exists on one side only is content
    const oneSided = compareItems([{ name: "x" }], [{ name: "x", value: "0x10" }], rule);
    expect(oneSided.changed).toHaveLength(1);
    expect(
      compareItems([{ name: "x", value: 4096 }], [{ name: "x", value: 8192 }], rule).relocated,
    ).toBe(1);
  });

  it("matches .NET-style methods by type+name and treats moved bodies as relocated", () => {
    expect(detectKey(dotnetMethods(0), dotnetMethods(16), "methods")).toBe("type+name");
    const diff = compareItems(
      dotnetMethods(0),
      dotnetMethods(16, [{ type: "B", name: "New", rva: "0x3000", flags: [] }]),
      {
        collection: "methods",
        positional: positionalFields("methods", ["pe", "pe"]),
      },
    );
    expect(diff.key).toBe("type+name");
    expect(diff.relocated).toBe(3);
    expect(diff.added).toEqual(["B::New"]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([]);
    // an explicit composite key works the same way, a missing part is reported
    expect(compareItems(dotnetMethods(0), dotnetMethods(0), { key: "type+name" }).unchanged).toBe(
      3,
    );
    expect(compareItems(dotnetMethods(0), dotnetMethods(0), { key: "type+nope" }).keyMissing).toBe(
      true,
    );
  });

  it("applies the position rule to duplicate identities too", () => {
    const rule = { key: "name", positional: ["value"] };
    const moved = compareItems(
      [
        { name: "a", value: "0x1" },
        { name: "a", value: "0x5" },
      ],
      [
        { name: "a", value: "0x2" },
        { name: "a", value: "0x5" },
      ],
      rule,
    );
    expect(moved).toMatchObject({ unchanged: 1, relocated: 1, added: [], removed: [] });
  });

  it("keeps name as identity for ELF-style symbol tables with a few repeated names (regression)", () => {
    // gcc/glibc executables list crtstuff.c twice and a few names in both .symtab and .dynsym.
    expect(detectKey(elfSymbols(0), elfSymbols(32))).toBe("name");
    const diff = compareItems(elfSymbols(0), elfSymbols(32, ["read_config"]), {
      positional: ["value"],
    });
    expect(diff.key).toBe("name");
    expect(diff.added).toEqual(["read_config"]);
    expect(diff.removed).toEqual([]);
    expect(diff.relocated).toBe(40);
    expect(diff.unchanged).toBe(4);
    expect(diff.duplicateKeys).toBe(2);
    // a field that mostly repeats is still no identity
    const selectors = Array.from({ length: 20 }, (_, i) => ({
      selector: i % 2 ? "init" : "dealloc",
      class: `C${i}`,
    }));
    expect(detectKey(selectors, selectors)).toBe("class");
    // .NET-style: 10% of the methods are .ctor spread over types, type+name stays the identity
    const many = Array.from({ length: 200 }, (_, i) => ({
      type: `T${i % 20}`,
      name: i < 20 ? ".ctor" : `M${i}`,
      rva: "0x1",
    }));
    expect(detectKey(many, many, "methods")).toBe("type+name");
  });

  it("keeps composite identities unambiguous and typed", () => {
    const d = compareItems([{ type: "a::b", name: "c" }], [{ type: "a", name: "b::c" }], {
      key: "type+name",
    });
    expect(d.changed).toEqual([]);
    expect(d.added).toEqual(["a::b::c"]);
    expect(d.removed).toEqual(["a::b::c"]);
    const typed = compareItems([{ module: "m", line: 1 }], [{ module: "m", line: "1" }], {
      key: "module+line",
    });
    expect(typed.changed).toEqual([]);
    expect(typed.added).toHaveLength(1);
  });
});

const rows = (...names: string[]) => names.map((name) => ({ name }));

describe("items on one side only", () => {
  it("calls an item unknown, not added or removed, when the other side's list was cut", () => {
    const cutRight = compareItems(rows("a", "b", "c"), rows("a", "d"), { cut: { b: true } });
    expect(cutRight.removed).toEqual([]);
    expect(cutRight.unknown.map((u) => [u.key, u.side, u.reason])).toEqual([
      ["b", "a", "the other side was compared only in part"],
      ["c", "a", "the other side was compared only in part"],
    ]);
    // The left side was whole, so an item only on the cut right side is still added.
    expect(cutRight.added).toEqual(["d"]);
    const neither = compareItems(rows("a", "b"), rows("a", "c"), { cut: { a: false, b: false } });
    expect([neither.added, neither.removed, neither.unknown]).toEqual([["c"], ["b"], []]);
  });

  const old = [ipcRow("main.js", "open"), ipcRow("main.js", "quit"), ipcRow("extra.js", "debug")];
  const next = [ipcRow("main.js", "open"), ipcRow("main.js", "update")];
  const options = { collection: "ipc", key: "channel" };

  it("calls an item removed when it exists on the left and the right read everything", () => {
    const diff = compareItems(old, next, {
      ...options,
      coverage: { a: wholeSide("main.js", "extra.js"), b: wholeSide("main.js") },
    });
    expect(diff.removed.toSorted()).toEqual(["debug", "quit"]);
    expect(diff.added).toEqual(["update"]);
    expect(diff.unknown).toEqual([]);
  });

  it("swaps added and removed, and nothing else, when the direction is reversed", () => {
    const forward = compareItems(old, next, options);
    const backward = compareItems(next, old, options);
    expect(backward.added.toSorted()).toEqual(forward.removed.toSorted());
    expect(backward.removed.toSorted()).toEqual(forward.added.toSorted());
    expect(backward.unchanged).toBe(forward.unchanged);
    expect(backward.changed.length).toBe(forward.changed.length);
  });

  it("calls an item unknown when the other side did not read its file", () => {
    // the right side stopped before extra.js; main.js was read on both
    const partial: SideCoverage = {
      complete: false,
      read: new Set(["main.js"]),
      unreadable: new Set<string>(),
      unresolved: new Map(),
    };
    const diff = compareItems(old, next, {
      ...options,
      coverage: { a: wholeSide("main.js", "extra.js"), b: partial },
    });
    expect(diff.removed).toEqual(["quit"]);
    expect(diff.added).toEqual(["update"]);
    expect(diff.unknown).toEqual([
      { key: "debug", side: "a", file: "extra.js", reason: "file not read on the other side" },
    ]);
    // and in the other direction it is not "added" either
    const reversed = compareItems(next, old, {
      ...options,
      coverage: { a: partial, b: wholeSide("main.js", "extra.js") },
    });
    expect(reversed.added).toEqual(["quit"]);
    expect(reversed.removed).toEqual(["update"]);
    expect(reversed.unknown).toEqual([
      { key: "debug", side: "b", file: "extra.js", reason: "file not read on the other side" },
    ]);
  });

  it("calls an item unknown when its file exists on the other side but could not be read", () => {
    const diff = compareItems(old, next, {
      ...options,
      coverage: {
        a: wholeSide("main.js", "extra.js"),
        b: {
          complete: false,
          read: new Set(["main.js"]),
          unreadable: new Set(["extra.js"]),
          unresolved: new Map(),
        },
      },
    });
    expect(diff.unknown).toEqual([
      {
        key: "debug",
        side: "a",
        file: "extra.js",
        reason: "file could not be read on the other side",
      },
    ]);
  });

  it("does not pair same-named settings of different files or different windows", () => {
    const diff = compareItems(
      [filePref("main.js", "win", false), filePref("other.js", "win", true)],
      [filePref("main.js", "win", true), filePref("main.js", "prompt", false)],
      { collection: "webPreferences", positional: ["line", "window"] },
    );
    expect(diff.key).toBe("file+windowName+key");
    expect(diff.changed.map((c) => c.key)).toEqual(["main.js::win::sandbox"]);
    expect(diff.added).toEqual(["main.js::prompt::sandbox"]);
    expect(diff.removed).toEqual(["other.js::win::sandbox"]);
  });

  it("says how many settings were matched by a window's position because it has no name", () => {
    const diff = compareItems(
      [namedWindowPref("win", 1), namedWindowPref("#2", 2)],
      [namedWindowPref("win", 1), namedWindowPref("#2", 2)],
      {
        collection: "webPreferences",
        positional: ["line", "window"],
      },
    );
    expect(diff.matchedByPosition).toBe(2);
    expect(
      compareItems([namedWindowPref("win", 1)], [namedWindowPref("win", 1)], {
        collection: "webPreferences",
      }).matchedByPosition,
    ).toBe(0);
  });

  it("leaves an item open when the other side cut more files than it names", () => {
    // every file was read, but more were cut at the token budget than are named
    const cut: SideCoverage = {
      ...wholeSide("main.js"),
      complete: false,
      unreadableUnlisted: true,
    };
    const diff = compareItems(
      [ipcRow("main.js", "open"), ipcRow("main.js", "late")],
      [ipcRow("main.js", "open")],
      {
        collection: "ipc",
        coverage: { a: wholeSide("main.js"), b: cut },
      },
    );
    expect(diff.removed).toEqual([]);
    expect(diff.unknown).toMatchObject([
      { side: "a", file: "main.js", reason: "the other side was read only in part" },
    ]);
    expect(diff.completeness.gaps).toContain("files_unreadable");
  });

  it("places a summary row by every file it names, and one that names none by the side's coverage", () => {
    const partial: SideCoverage = {
      complete: false,
      read: new Set(["main.js"]),
      unreadable: new Set(["big.js"]),
      unresolved: new Map(),
    };
    const diff = compareItems(
      [
        { channel: "open", senders: [], receivers: ["main.js"] },
        { channel: "tail", senders: [], receivers: ["big.js"] },
        { channel: "gone", senders: [], receivers: ["main.js"] },
      ],
      [{ channel: "open", senders: [], receivers: ["main.js"] }],
      { collection: "ipcChannels", coverage: { a: wholeSide("main.js", "big.js"), b: partial } },
    );
    expect(diff.removed).toEqual(["gone"]);
    expect(diff.unknown).toEqual([
      {
        key: "tail",
        side: "a",
        file: "big.js",
        reason: "file could not be read on the other side",
      },
    ]);
    // no file named: with the other side read in part, nothing is known about the item there
    const bare = compareItems([{ name: "only-left" }], [], {
      key: "name",
      coverage: { a: wholeSide(), b: partial },
    });
    expect(bare.removed).toEqual([]);
    expect(bare.unknown.map((u) => u.reason)).toEqual(["the other side was read only in part"]);
    // and with both sides read whole it is simply removed
    expect(
      compareItems([{ name: "only-left" }], [], {
        key: "name",
        coverage: { a: wholeSide(), b: wholeSide() },
      }).removed,
    ).toEqual(["only-left"]);
  });

  it("shows a window whose settings stop being readable as changed, and ignores only the explanation", () => {
    const windowOptions = { collection: "windows", positional: ["line", "window"] };
    // only the wording of the explanation differs: no change
    expect(
      compareItems([windowRow(undefined, "a")], [windowRow(undefined, "b")], windowOptions).changed,
    ).toEqual([]);
    // a key outside the three columns became unreadable: a change
    const diff = compareItems(
      [windowRow(undefined, "a")],
      [windowRow(["webSecurity"], "a")],
      windowOptions,
    );
    expect(diff.changed.map((c) => c.fields.map((f) => f.field))).toEqual([["computed"]]);
  });

  describe("completeness (C1)", () => {
    it("is complete when both sides were compared whole and no gap applies", () => {
      const diff = compareItems(old, next, {
        ...options,
        coverage: { a: wholeSide("main.js", "extra.js"), b: wholeSide("main.js") },
      });
      expect(diff.completeness).toEqual({
        compared: { a: 3, b: 2 },
        total: { a: 3, b: 2 },
        complete: true,
        gaps: [],
      });
    });

    it("names every gap that applies: a part of a side, unread and partly read files", () => {
      const cut = compareItems(old, next, { ...options, cut: { b: true }, total: { a: 3, b: 9 } });
      expect(cut.completeness).toMatchObject({
        compared: { a: 3, b: 2 },
        total: { a: 3, b: 9 },
        complete: false,
        gaps: ["budget"],
      });
      const partlyRead: SideCoverage = {
        complete: false,
        read: new Set(["main.js", "extra.js"]),
        unreadable: new Set(["extra.js"]),
        unresolved: new Map(),
      };
      const diff = compareItems(old, next, {
        ...options,
        coverage: { a: wholeSide("main.js", "extra.js"), b: partlyRead },
      });
      expect(diff.unknown.map((u) => u.reason)).toEqual([
        "file could not be read on the other side",
      ]);
      expect(diff.completeness.complete).toBe(false);
      expect(diff.completeness.gaps).toEqual(["scan_partial", "files_unreadable"]);
      const unread = compareItems(old, next, {
        ...options,
        coverage: {
          a: wholeSide("main.js", "extra.js"),
          b: { ...wholeSide("main.js"), complete: false },
        },
      });
      expect(unread.completeness.gaps).toEqual(["scan_partial", "files_unread"]);
    });
  });

  describe("values that could not be resolved (C2)", () => {
    const before = [ipcRow("main.js", "a:b"), ipcRow("extra.js", "debug")];
    const after = [{ ...ipcRow("main.js", "a:b"), channel: null }];
    const reason = "the other side has values there that could not be resolved";

    it("calls an item unknown, not removed, when the other side has an unresolved value in its file", () => {
      const diff = compareItems(before, after, {
        collection: "ipc",
        coverage: { a: wholeSide("main.js", "extra.js"), b: unresolvedIn("ipc", "main.js") },
      });
      expect(diff.unknown).toEqual([
        { key: "main.js::ipcMain.on::a:b", side: "a", file: "main.js", reason },
      ]);
      // a proven deletion: extra.js was read on the other side and holds no unresolved value
      expect(diff.removed).toEqual(["extra.js::ipcMain.on::debug"]);
      expect(diff.completeness.gaps).toEqual(["values_unresolved"]);
      expect(diff.completeness.complete).toBe(false);
      // and in the other direction it is not "added" either
      const back = compareItems(after, before, {
        collection: "ipc",
        coverage: { a: unresolvedIn("ipc", "main.js"), b: wholeSide("main.js", "extra.js") },
      });
      expect(back.unknown).toEqual([
        { key: "main.js::ipcMain.on::a:b", side: "b", file: "main.js", reason },
      ]);
      expect(back.added).toEqual(["extra.js::ipcMain.on::debug"]);
    });

    it("applies an unresolved value of an unknown file to every file, and only to its own family", () => {
      const anywhere = compareItems(before, after, {
        collection: "ipc",
        coverage: { a: wholeSide("main.js", "extra.js"), b: unresolvedIn("ipc", "*") },
      });
      expect(anywhere.removed).toEqual([]);
      expect(anywhere.unknown.map((u) => u.key).toSorted()).toEqual([
        "extra.js::ipcMain.on::debug",
        "main.js::ipcMain.on::a:b",
      ]);
      // an unresolved endpoint says nothing about IPC channels
      const other = compareItems(before, after, {
        collection: "ipc",
        coverage: { a: wholeSide("main.js", "extra.js"), b: unresolvedIn("endpoint", "main.js") },
      });
      expect(other.removed.toSorted()).toEqual([
        "extra.js::ipcMain.on::debug",
        "main.js::ipcMain.on::a:b",
      ]);
      expect(other.completeness.complete).toBe(true);
      // channel summaries and interface rows belong to the IPC family too
      const channels = compareItems([{ channel: "a:b", senders: [], receivers: ["main.js"] }], [], {
        collection: "ipcChannels",
        coverage: { a: wholeSide("main.js"), b: unresolvedIn("ipc", "main.js") },
      });
      expect(channels.unknown.map((u) => u.reason)).toEqual([reason]);
    });
  });

  it("lets an unread storage key hide only items of its own storage kind in its file", () => {
    // Electron Fiddle 0.38 → 0.39: an unread sessionStorage key in the same bundle
    const unread = (kind: string): SideCoverage => ({
      ...wholeSide("index.js"),
      unresolved: new Map([["storage", new Set([storageSlot("index.js", kind)])]]),
    });
    const after = [
      storageRow("localStorage", "theme"),
      storageRow("localStorage", "isUsingSocketFirewall"),
    ];
    const other = compareItems([storageRow("localStorage", "theme")], after, {
      collection: "storage",
      coverage: { a: unread("sessionStorage"), b: wholeSide("index.js") },
    });
    expect(other.added).toEqual(["index.js::localStorage::isUsingSocketFirewall::read"]);
    expect(other.unknown).toEqual([]);
    // an unread localStorage key there may be the new one: not called added
    const same = compareItems([storageRow("localStorage", "theme")], after, {
      collection: "storage",
      coverage: { a: unread("localStorage"), b: wholeSide("index.js") },
    });
    expect(same.added).toEqual([]);
    expect(same.unknown.map((u) => [u.key, u.file])).toEqual([
      ["index.js::localStorage::isUsingSocketFirewall::read", "index.js"],
    ]);
  });

  it("does not call an interface row changed when only the explanation of its link differs", () => {
    const lineRule = { collection: "interfaces", positional: ["line"] };
    const blind = "no main-process end found, but the analysis has blind spots";
    const same = compareItems(
      [interfaceRow("unknown", `${blind} (ipc_channel_unresolved)`)],
      [interfaceRow("unknown", `${blind} (ipc_channel_unresolved, ipc_open_calls_capped)`)],
      lineRule,
    );
    expect([same.changed, same.unchanged]).toEqual([[], 1]);
    // a different link is a change, and the reason travels with it
    const moved = compareItems(
      [interfaceRow("direct", "")],
      [interfaceRow("unknown", blind)],
      lineRule,
    );
    expect(moved.changed.map((c) => c.fields.map((f) => f.field))).toEqual([["link"]]);
  });

  it("matches findings by kind and location, so a reworded title is a change, not a new finding", () => {
    const diff = compareItems(
      [finding("electron.ipc", "3 IPC channels"), finding("elf.nx", "NX off", "0x40")],
      [
        finding("electron.ipc", "3 IPC channels in the scanned part (2 of 4 files)"),
        finding("elf.nx", "NX off", "0x40"),
      ],
      { collection: "findings" },
    );
    expect(diff.key).toBe("kind+location");
    expect([diff.added, diff.removed]).toEqual([[], []]);
    expect(diff.changed.map((c) => [c.key, c.fields.map((f) => f.field)])).toEqual([
      ["electron.ipc::null", ["title"]],
    ]);
  });
  it("matches imported modules by specifier, so a changed count is a change", () => {
    // Electron Fiddle 0.39.0: a new module importing node:https raised 10 import counts, which
    // were reported as 10 removed and 10 added imports
    const a = [
      { specifier: "node:https", count: 3, builtin: true },
      { specifier: "electron", count: 9, builtin: true },
    ];
    const b = [
      { specifier: "node:https", count: 4, builtin: true },
      { specifier: "electron", count: 9, builtin: true },
    ];
    const diff = compareItems(a, b, { collection: "externals" });
    expect(diff.key).toBe("specifier");
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed.map((c) => [c.key, c.fields])).toEqual([
      ["node:https", [{ field: "count", before: 3, after: 4 }]],
    ]);
  });
});
