import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Welcome } from "../App.js";
import type { ChangeRow, ReleaseComparison } from "../lib/api.js";
import { readFilter } from "../lib/compare.js";
import { Filters, Ready } from "./CompareView.js";

const target = (id: string, path: string) => ({
  id,
  info: { path, size: 1, sha256: "0".repeat(64), format: "asar" },
  openedAt: "",
  analyzed: true,
});

const rows: ChangeRow[] = [
  {
    id: "r1",
    collection: "interfaces",
    change: "added",
    key: "notesdesk.checkUpdate",
    basis: "link direct",
    where: [{ side: "b", file: "preload.js", line: 9 }],
  },
  {
    id: "r2",
    collection: "ipcChannels",
    change: "unknown",
    key: "dyn:*",
    reason: "computed at run time",
    where: [],
  },
];

const comparison = {
  hexvero: "compare",
  a: target("t_a", "/x/notesdesk-1.4.0.asar"),
  b: target("t_b", "/x/notesdesk-1.5.0.asar"),
  overview: {
    collections: [
      { collection: "interfaces", added: 1, removed: 0, changed: 0, unknown: 0, unchanged: 3 },
      {
        collection: "ipcChannels",
        added: 0,
        removed: 0,
        changed: 0,
        unknown: 1,
        unchanged: 4,
        partial: false,
      },
    ],
    onlyA: [],
    onlyB: [],
    partialScan: { a: false, b: false },
    windowChanges: [],
  },
  changes: rows,
  cut: [],
  limitations: {
    a: [],
    b: [{ code: "dynamic-channel", message: "A channel name is computed at run time." }],
  },
  completeness: {
    interfaces: {
      complete: false,
      gaps: ["dynamic"],
      compared: { a: 3, b: 4 },
      total: { a: 3, b: 4 },
    },
    ipcChannels: {
      complete: false,
      gaps: ["dynamic"],
      compared: { a: 4, b: 5 },
      total: { a: 4, b: 5 },
    },
  },
  page: { offset: 0, limit: 200, total: 2, next: null },
} as unknown as ReleaseComparison;

const noop = (): void => undefined;

describe("start screen", () => {
  it("is about Electron release review, with the example first", () => {
    const html = renderToStaticMarkup(
      createElement(Welcome, { onDemo: noop, demoBusy: false, onOpenFile: noop, fileBusy: false }),
    );
    expect(html).toContain("Review an Electron release.");
    const demo = html.indexOf("Compare example releases");
    const own = html.indexOf("Open your build");
    expect(demo).toBeGreaterThan(-1);
    expect(own).toBeGreaterThan(demo);
    expect(html).toMatch(/btn primary[^>]*>Compare example releases</);
    expect(html).toContain("<code>app.asar</code>");
    expect(html).toContain("<code>.app</code> bundle");
    expect(html).toContain("an install directory or a release ZIP");
    // the full format list is still there, behind a closed disclosure
    expect(html).toMatch(/<details class="formats-more"><summary>Other formats<\/summary>/);
    expect(html).toContain("WebAssembly");
    expect(html).not.toContain("Also reads");
  });
});

describe("compare filters", () => {
  it("keeps change types in view and folds list and basis behind More filters", () => {
    const html = renderToStaticMarkup(
      createElement(Filters, { rows, filter: readFilter(new URLSearchParams()), setFilter: noop }),
    );
    expect(html).toContain("<legend>Change</legend>");
    expect(html).toMatch(/aria-expanded="false"[^>]*>More filters<\/button>/);
    // the folded part exists for the button to control, and is hidden
    const id = /aria-controls="([^"]+)"/.exec(html)?.[1];
    expect(id).toBeTruthy();
    expect(html).toContain(`id="${id}" class="filters-more" hidden=""`);
    expect(html).not.toContain(" active</span>");
  });

  it("says how many folded filters are on while collapsed", () => {
    const filter = readFilter(new URLSearchParams("list=interfaces,ipcChannels&basis=link+direct"));
    expect(filter.lists.length + filter.bases.length).toBe(3);
    const html = renderToStaticMarkup(createElement(Filters, { rows, filter, setFilter: noop }));
    expect(html).toContain('More filters<span class="n"> · 3 active</span>');
    const open = renderToStaticMarkup(
      createElement(Filters, { rows, filter, setFilter: noop, initiallyOpen: true }),
    );
    expect(open).toContain('aria-expanded="true"');
    expect(open).not.toContain(" active</span>");
    expect(open).toContain("<legend>List</legend>");
    expect(open).not.toMatch(/class="filters-more" hidden/);
  });
});

describe("compare limitations", () => {
  it("states what is not compared whole above the changes and lists every limitation", () => {
    const html = renderToStaticMarkup(
      createElement(Ready, {
        a: "t_a",
        b: "t_b",
        r: comparison,
        rows,
        next: null,
        filter: readFilter(new URLSearchParams()),
        setFilter: noop,
        sel: null,
        loadMore: noop,
        more: { busy: false, error: null },
      }),
    );
    const gap = html.indexOf("Not compared whole.");
    const changes = html.indexOf('id="changes-title"');
    expect(gap).toBeGreaterThan(-1);
    expect(gap).toBeLessThan(changes);
    expect(html).toContain("2 lists may hold more changes than shown");
    // one reason shared by two lists is written once, naming both
    const gaps = html.slice(gap, changes).match(/<li>/g) ?? [];
    expect(gaps).toHaveLength(1);
    expect(html.slice(gap, changes)).toMatch(/interfaces.*ipcChannels.*Incomplete:/);
    expect(html).toContain("Incomplete:");
    expect(html).toContain("Not established");
    expect(html).toContain("After: A channel name is computed at run time.");
    expect(html).toContain("Absence from a list means hexvero did not find it");
  });
});
