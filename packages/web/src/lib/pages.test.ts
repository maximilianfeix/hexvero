import { describe, expect, it } from "vitest";
import type { Page } from "./api.js";
import { formatBytes, nextOffset, reducedRow } from "./pages.js";

const page = (over: Partial<Page<unknown>>): Page<unknown> => ({
  items: [{}, {}],
  total: 10,
  offset: 0,
  truncated: true,
  collection: "symbols",
  bytes: 100,
  ...over,
});

describe("collection pages", () => {
  it("follows next, so a page cut short by its byte budget skips no rows", () => {
    expect(nextOffset(page({ next: 2 }))).toBe(2);
    expect(nextOffset(page({ next: null, truncated: false }))).toBeNull();
    // without next: what the page holds, not the page size that was asked for
    expect(nextOffset(page({ offset: 4 }))).toBe(6);
    expect(nextOffset(page({ offset: 8, truncated: false }))).toBeNull();
  });

  it("names the shortened row and its full size", () => {
    expect(reducedRow(page({ itemTruncated: true, itemBytes: 3_500_000 }))).toEqual({
      index: 0,
      bytes: 3_500_000,
    });
    expect(reducedRow(page({}))).toBeNull();
    expect(formatBytes(3_500_000)).toBe("3.3 MB");
    expect(formatBytes(900)).toBe("900 B");
  });
});
