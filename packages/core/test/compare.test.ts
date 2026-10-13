import { describe, expect, it } from "vitest";
import { canonical, compareItems, detectKey, positionalFields } from "../src/compare.js";

const dotnetMethods = (shift: number, extra: object[] = []): object[] => [
  { type: "A", name: ".ctor", rva: `0x${(0x2000 + shift).toString(16)}`, flags: ["public"] },
  { type: "B", name: ".ctor", rva: `0x${(0x2100 + shift).toString(16)}`, flags: ["public"] },
  { type: "A", name: "Run", rva: `0x${(0x2200 + shift).toString(16)}`, flags: ["public"] },
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
