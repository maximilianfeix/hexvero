import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { buildMap, type InterfaceRow, MAX_MEMBERS, memberId } from "../lib/interfaceMap.js";
import { InterfaceEvidence, ListTable, MapCanvas } from "./InterfaceMapView.js";

/** Built at run time: the source holds no direction-changing character. */
const RLO = String.fromCharCode(0x202e);
const HOSTILE = "<img src=x onerror=alert(1)>";

const hostile: InterfaceRow = {
  api: `${HOSTILE}api`,
  member: `run${RLO}exe`,
  world: "main",
  file: `${HOSTILE}.js`,
  line: 3,
  windows: [`main.js:<script>alert(1)</script>`],
  channel: `<b>chan</b>${RLO}`,
  direction: "to-main",
  ends: [{ file: "main.js", line: 9, api: "ipcMain.handle", via: `<i>via</i>` }],
  endsTotal: 30,
  endsTruncated: true,
  link: "resolved",
};
const unknown: InterfaceRow = {
  ...hostile,
  member: "maybe",
  line: 4,
  ends: [],
  endsTotal: 0,
  endsTruncated: false,
  link: "unknown",
  reason: `<script>x</script> blind spots`,
};
const rows = [hostile, unknown];
const map = buildMap(rows, [0, 1]);

const safe = (html: string): void => {
  expect(html).not.toMatch(/<img|<script|<b>|<i>/);
  expect(html).not.toContain(RLO);
};

describe("interface map rendering", () => {
  it("draws hostile names as text, and marks how links were read", () => {
    const html = renderToStaticMarkup(
      createElement(MapCanvas, { map, rows, sel: null, onSelect: () => undefined }),
    );
    safe(html);
    expect(html).toContain("run⟨U+202E⟩exe");
    expect(html).toContain("&lt;b&gt;chan&lt;/b&gt;⟨U+202E⟩");
    // the resolved marker is a word, the unread end a placeholder node, not only a line style
    expect(html).toContain(">resolved</text>");
    expect(html).toContain("end not found");
    // every node and every edge is focusable
    const focusable = html.match(/tabindex="0"/g)?.length ?? 0;
    expect(focusable).toBe(map.nodes.size + map.edges.length);
  });

  it("lists the same rows as a table", () => {
    const html = renderToStaticMarkup(
      createElement(ListTable, {
        rows,
        indexes: [0, 1],
        page: 0,
        sel: null,
        onSelect: () => undefined,
        onPage: () => undefined,
      }),
    );
    safe(html);
    expect(html).toContain("1 of 30 ends shown");
    expect(html).toContain("end not found");
  });

  it("pages the list past the map's cap", () => {
    const many = Array.from({ length: MAX_MEMBERS + 50 }, (_, i) => ({
      ...hostile,
      member: `m${i}`,
    }));
    const html = renderToStaticMarkup(
      createElement(ListTable, {
        rows: many,
        indexes: many.map((_, i) => i),
        page: 3,
        sel: null,
        onSelect: () => undefined,
        onPage: () => undefined,
      }),
    );
    expect(html).toContain("301–350 of 350");
    expect(html).toContain("m349");
  });

  it("shows the evidence with file:line links and the reason, never a made-up line", () => {
    const html = renderToStaticMarkup(
      createElement(InterfaceEvidence, {
        targetId: "t_1",
        id: memberId(unknown),
        map,
        rows: [unknown],
        onClose: () => undefined,
      }),
    );
    safe(html);
    expect(html).toContain(
      `href="/targets/t_1/source?file=${encodeURIComponent(unknown.file)}&amp;line=4"`,
    );
    expect(html).toContain("&lt;script&gt;x&lt;/script&gt; blind spots");
    expect(html).toContain("none found");
    expect(html).not.toMatch(/taint|exploit|vulnerab/i);
  });

  it("links every end it lists and says how many were kept", () => {
    const html = renderToStaticMarkup(
      createElement(InterfaceEvidence, {
        targetId: "t_1",
        id: memberId(hostile),
        map,
        rows: [hostile],
        onClose: () => undefined,
      }),
    );
    safe(html);
    expect(html).toContain('href="/targets/t_1/source?file=main.js&amp;line=9"');
    expect(html).toContain("1 of 30 ends shown");
    expect(html).toContain("via &lt;i&gt;via&lt;/i&gt;");
  });
});
