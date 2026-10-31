import { describe, expect, it } from "vitest";
import {
  adoptHashToken,
  fallbackRowId,
  normalizeComparison,
  type ChangeRow,
  type ReleaseComparison,
} from "./api.js";
import {
  MEANING,
  completenessWords,
  filterQuery,
  matches,
  readFilter,
  sidesOf,
  summarize,
} from "./compare.js";
import { hasInvisible, visible } from "./text.js";

const row = (over: Partial<ChangeRow>): ChangeRow => ({
  id: "r1",
  collection: "interfaces",
  change: "added",
  key: "preload.js::api::open",
  where: [{ side: "b", file: "preload.js", line: 9 }],
  ...over,
});

describe("compare filter in the query", () => {
  it("round-trips through the URL and ignores unknown kinds", () => {
    const f = readFilter(
      new URLSearchParams("kind=added,bogus,unknown&list=interfaces&basis=literal,none&q=open"),
    );
    expect(f).toEqual({
      kinds: ["added", "unknown"],
      lists: ["interfaces"],
      bases: ["literal", "none"],
      text: "open",
    });
    expect(new URLSearchParams(filterQuery(f) as Record<string, string>).toString()).toBe(
      "kind=added%2Cunknown&list=interfaces&basis=literal%2Cnone&q=open",
    );
    expect(filterQuery(readFilter(new URLSearchParams()))).toEqual({
      kind: undefined,
      list: undefined,
      basis: undefined,
      q: undefined,
    });
  });

  it("matches kind, list, basis (none = not recorded) and text in key or before/after files", () => {
    const f = readFilter(new URLSearchParams());
    expect(matches(row({}), { ...f, kinds: ["removed"] })).toBe(false);
    expect(matches(row({}), { ...f, bases: ["none"] })).toBe(true);
    expect(matches(row({ basis: "literal" }), { ...f, bases: ["none"] })).toBe(false);
    expect(
      matches(row({ whereBefore: [{ side: "a", file: "old/main.js" }] }), { ...f, text: "OLD/" }),
    ).toBe(true);
    expect(matches(row({}), { ...f, text: "nothing" })).toBe(false);
  });
});

describe("evidence sides", () => {
  it("never invents a before position for a changed row", () => {
    const changed = row({ change: "changed" });
    expect(sidesOf(changed).before.state).toBe("unrecorded");
    const withBefore = row({
      change: "changed",
      whereBefore: [{ side: "a", file: "main.js", line: 3 }],
    });
    expect(sidesOf(withBefore).before).toEqual({ state: "places", places: withBefore.whereBefore });
    expect(sidesOf(row({ where: [] })).after.state).toBe("unrecorded");
  });

  it("says added is absent before, removed absent after, unknown not established", () => {
    expect(sidesOf(row({})).before.state).toBe("absent");
    expect(
      sidesOf(row({ change: "removed", where: [{ side: "a", file: "x.js", line: 1 }] })).after
        .state,
    ).toBe("absent");
    const unknown = sidesOf(
      row({ change: "unknown", reason: "the other side was read only in part" }),
    );
    expect(unknown.before).toMatchObject({ state: "unrecorded" });
    expect(unknown.before.state === "unrecorded" && unknown.before.why).toContain(
      "read only in part",
    );
  });
});

describe("completeness and summary", () => {
  it("puts gaps in words with the counts", () => {
    expect(
      completenessWords(
        {
          compared: { a: 10, b: 200 },
          total: { a: 10, b: 300 },
          complete: false,
          gaps: ["budget", "values_unresolved"],
        },
        false,
      ),
    ).toBe(
      "Incomplete: compared up to the size budget; items beyond it were not compared; some values could not be resolved (computed at run time). Compared 10 of 10 items before, 200 of 300 after.",
    );
    expect(completenessWords(undefined, false)).toBeNull();
    expect(completenessWords(undefined, true)).toContain("first 2,000");
  });

  it("counts from the overview, with no score", () => {
    const r = {
      overview: {
        collections: [
          { collection: "interfaces", added: 1, removed: 1, changed: 0, unknown: 0 },
          { collection: "endpoints", added: 2, removed: 0, changed: 0, unknown: 1 },
          { collection: "ipc", added: 0, removed: 0, changed: 0, unknown: 9 },
        ],
        windowChanges: [{ direction: "less permissive" }, { direction: "more permissive" }],
      },
      limitations: { a: [], b: [{ code: "x", message: "y" }] },
    } as unknown as ReleaseComparison;
    expect(summarize(r).map((f) => [f.id, f.count, f.detail])).toEqual([
      ["interfaces", 2, "1 added · 1 removed"],
      ["windows", 2, "1 less permissive · 1 more permissive"],
      ["network", 3, "2 added · 1 unknown"],
      // ipc repeats ipcChannels and is not reviewed row by row
      ["open", 2, "1 unknown row · 1 limitation"],
    ]);
  });
});

describe("api shim and token", () => {
  it("fills row ids and the page for a server before contract C3", () => {
    const wire = {
      changes: [{ collection: "urls", change: "added", key: "https://x", where: [] }],
      cut: [{ collection: "urls", shown: 1, total: 4 }],
    } as unknown as Parameters<typeof normalizeComparison>[0];
    const r = normalizeComparison(wire);
    expect(r.changes[0]!.id).toBe(
      fallbackRowId({ collection: "urls", change: "added", key: "https://x" }),
    );
    expect(r.changes[0]!.id).toMatch(/^[0-9a-f]{16}$/);
    expect(r.page).toEqual({ offset: 0, limit: 1, total: 4, next: null });
    const paged = normalizeComparison({
      ...wire,
      page: { offset: 0, limit: 1, total: 9, next: 1 },
    });
    expect(paged.page.total).toBe(9);
  });

  it("moves the token out of the address bar, unless storage refuses it", () => {
    const stored = new Map<string, string>();
    const urls: string[] = [];
    const location = { hash: "#token=s3cret&x=1", pathname: "/compare", search: "?a=1&b=2" };
    expect(
      adoptHashToken(location, { setItem: (k, v) => void stored.set(k, v) }, (u) => urls.push(u)),
    ).toBe("s3cret");
    expect(stored.get("hexvero.token")).toBe("s3cret");
    expect(urls).toEqual(["/compare?a=1&b=2#x=1"]);
    expect(urls.join()).not.toContain("s3cret");
    // storage refuses: the hash stays, so a reload still works
    const kept: string[] = [];
    adoptHashToken(
      location,
      {
        setItem: () => {
          throw new Error("quota");
        },
      },
      (u) => kept.push(u),
    );
    expect(kept).toEqual([]);
    expect(adoptHashToken({ ...location, hash: "" }, null, (u) => kept.push(u))).toBe("");
  });
});

/** Built at run time: the source holds no direction-changing character. */
const RLO = String.fromCharCode(0x202e);

describe("visible text", () => {
  it("writes out bidi controls and zero-width characters, keeps tabs and markup as text", () => {
    expect(visible(`safe${RLO}exe.txt`)).toBe("safe⟨U+202E⟩exe.txt");
    expect(
      visible(
        `a${String.fromCharCode(0x200b)}b${String.fromCharCode(0x2066)}c${String.fromCharCode(0)}`,
      ),
    ).toBe("a⟨U+200B⟩b⟨U+2066⟩c⟨U+0000⟩");
    expect(visible("\tx <img src=x>")).toBe("\tx <img src=x>");
    expect(hasInvisible("plain")).toBe(false);
    expect(hasInvisible(`x${RLO}`)).toBe(true);
    // the global pattern keeps no state between calls
    expect(hasInvisible(`x${RLO}`)).toBe(true);
  });
});

describe("list meanings", () => {
  it("explains every list a release comparison can show, also the changed ipc calls", () => {
    // the lists core's release report orders (packages/core/src/report.ts ORDER)
    for (const list of [
      "interfaces",
      "contextBridge",
      "ipcChannels",
      "ipc",
      "windows",
      "bridgeExposures",
      "navigationHandlers",
      "remoteEnabled",
      "switches",
      "permissionHandlers",
      "openExternal",
      "csp",
      "dangerousCalls",
      "webviews",
      "protocols",
      "webPreferences",
      "endpoints",
      "storage",
      "urls",
    ])
      expect(MEANING[list], list).toBeTruthy();
  });
});
