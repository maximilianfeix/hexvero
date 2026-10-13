import { describe, expect, it } from "vitest";
import { canonical, compareItems, detectKey } from "../src/compare.js";

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
    const diff = compareItems(a, b);
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
    // addresses count when asked
    const strict = compareItems(a, b, { ignore: [] });
    expect(strict.relocated).toBe(0);
    expect(strict.changed.map((c) => c.key)).toEqual(["main", "helper"]);
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
});
