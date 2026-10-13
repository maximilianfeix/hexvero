import { describe, expect, it } from "vitest";
import { MIN_PAGE_BYTES, pageOf, reduceItem } from "../src/paging.js";

const bytesOf = (v: unknown): number => Buffer.byteLength(JSON.stringify(v));

/** Items built to defeat a budget: multibyte text, escapes, long keys, many fields, deep nesting. */
const hostile: Record<string, unknown[]> = {
  multibyte: [{ name: "ü".repeat(5000) }, { name: "😀".repeat(3000) }],
  escapes: [{ name: '"\\\n\t'.repeat(3000) }],
  longKeys: [
    Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`${"k".repeat(400)}${i}`, i])),
  ],
  manyFields: [
    Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`f${i}`, "x".repeat(20)])),
  ],
  nested: [{ a: { b: { c: { d: { e: { f: { g: "y".repeat(9000) } } } } } } }],
  hugeArray: [{ list: Array.from({ length: 4000 }, (_, i) => ({ i, text: "z".repeat(30) })) }],
  scalars: ["s".repeat(8000), 12345678901234567890n, null],
  mixed: [{ small: 1 }, { big: "q".repeat(4000) }, { small: 2 }, { small: 3 }],
};

describe("page byte budget contract", () => {
  it("bounds the real serialized size for every budget and every hostile shape", () => {
    for (const [name, items] of Object.entries(hostile)) {
      for (const budget of [MIN_PAGE_BYTES, 513, 600, 777, 1024, 2048, 4096, 65536]) {
        const page = pageOf(name, items, { maxBytes: budget });
        const real = bytesOf(
          JSON.parse(JSON.stringify(page, (_k, v) => (typeof v === "bigint" ? v.toString() : v))),
        );
        expect(real, `${name}@${budget}`).toBeLessThanOrEqual(budget);
        expect(page.bytes, `${name}@${budget} bytes field`).toBe(real);
        expect(page.items.length, `${name}@${budget} progress`).toBeGreaterThan(0);
      }
    }
  });

  it("rejects budgets outside the valid range instead of adjusting them", () => {
    for (const bad of [0, 1, 100, 511, 511.5, Number.NaN, 64 * 1024 * 1024 + 1, -5])
      expect(() => pageOf("x", [1], { maxBytes: bad }), String(bad)).toThrow(
        /maxBytes must be an integer/,
      );
    expect(pageOf("x", [1], { maxBytes: 512 }).items).toEqual([1]);
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => pageOf("x", [1, 2], { limit: bad })).toThrow(/limit must be a finite number/);
      expect(() => pageOf("x", [1, 2], { offset: bad })).toThrow(/offset must be a finite number/);
    }
    // a collection name so long that not even a placeholder fits is an error that names the minimum
    expect(() => pageOf("n".repeat(600), [{ a: "b".repeat(900) }], { maxBytes: 700 })).toThrow(
      /use at least \d+/,
    );
  });

  it("always advances: following `next` visits every item exactly once and terminates", () => {
    for (const [name, items] of Object.entries(hostile)) {
      for (const budget of [MIN_PAGE_BYTES, 900, 5000]) {
        const seen: number[] = [];
        let offset: number | null = 0;
        let guard = 0;
        while (offset !== null) {
          const page = pageOf(name, items, { maxBytes: budget, offset, limit: 2 });
          expect(page.offset).toBe(offset);
          for (let i = 0; i < page.items.length; i++) seen.push(page.offset + i);
          expect(page.truncated).toBe(page.next !== null);
          offset = page.next;
          expect(++guard, `${name}@${budget} loops`).toBeLessThanOrEqual(items.length + 1);
        }
        expect(seen, `${name}@${budget}`).toEqual(items.map((_, i) => i));
      }
    }
    const empty = pageOf("none", [], {});
    expect(empty).toMatchObject({ items: [], total: 0, next: null, truncated: false });
    const past = pageOf("x", [1, 2], { offset: 10 });
    expect(past).toMatchObject({ items: [], next: null, truncated: false });
  });

  it("marks a reduced item and says how large the full one is, and returns it whole when asked", () => {
    const item = { name: "big", body: "é".repeat(4000) };
    const page = pageOf("c", [item, { name: "small" }], { maxBytes: 1024 });
    expect(page.items).toHaveLength(1);
    expect(page.itemTruncated).toBe(true);
    expect(page.itemBytes).toBe(bytesOf(item));
    expect(page.next).toBe(1);
    const full = pageOf("c", [item, { name: "small" }], {
      maxBytes: page.itemBytes! + 512,
      limit: 1,
    });
    expect(full.items[0]).toEqual(item);
    expect(full.itemTruncated).toBeUndefined();
    // pages whose items fit carry no marker
    expect(pageOf("c", [{ a: 1 }], {}).itemTruncated).toBeUndefined();
  });

  it("reduces any item to any budget that holds the placeholder, never above it", () => {
    for (const items of Object.values(hostile)) {
      for (const item of items) {
        for (const budget of [70, 100, 200, 333, 1000]) {
          const reduced = reduceItem(item, budget);
          if (reduced === undefined) continue;
          expect(
            Buffer.byteLength(
              JSON.stringify(reduced, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
            ),
          ).toBeLessThanOrEqual(budget);
        }
      }
    }
    expect(reduceItem({ a: "x".repeat(100) }, 10)).toBeUndefined();
    const cut = reduceItem({ name: "😀".repeat(500) }, 120) as { $preview: string };
    expect(cut.$preview.endsWith("\uD83D")).toBe(false); // no split surrogate pair
  });
});
