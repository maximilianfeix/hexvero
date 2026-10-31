import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ChangeRow, ReleaseComparison } from "../lib/api.js";
import { EvidencePanel } from "./EvidencePanel.js";

/** Built at run time: the source holds no direction-changing character. */
const RLO = String.fromCharCode(0x202e);
const HOSTILE = "<img src=x onerror=alert(1)>";

const target = (id: string, path: string) => ({
  id,
  info: { path, size: 1, sha256: "0", format: "asar" },
  openedAt: "",
  analyzed: true,
});

describe("evidence panel rendering", () => {
  it("renders hostile channel names, markdown and bidi controls as text", () => {
    const row: ChangeRow = {
      id: "x",
      collection: "ipcChannels",
      change: "unknown",
      key: `${HOSTILE} **bold** [x](javascript:alert(1)) safe${RLO}exe`,
      where: [{ side: "b", file: `${HOSTILE}.js`, line: 1 }],
      reason: `<script>alert(1)</script>`,
      fields: [{ field: "<b>f</b>", before: HOSTILE, after: undefined }],
    };
    const r = {
      a: target("t_a", "/x/a.asar"),
      b: target("t_b", `/x/${HOSTILE}.asar`),
    } as unknown as ReleaseComparison;
    const html = renderToStaticMarkup(
      createElement(EvidencePanel, { row, r, position: "1 of 1", onClose: () => undefined }),
    );
    expect(html).not.toMatch(/<img|<script|<b>/);
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("[x](javascript:alert(1))");
    expect(html).not.toContain('href="javascript');
    expect(html).not.toContain(RLO);
    expect(html).toContain("safe⟨U+202E⟩exe");
    // the side the item was not found on says why, with no line of its own
    expect(html).toContain("not established as absent");
  });

  it("states a missing source position instead of showing a line", () => {
    const row: ChangeRow = {
      id: "y",
      collection: "windows",
      change: "changed",
      key: "main.js::win",
      where: [],
    };
    const html = renderToStaticMarkup(
      createElement(EvidencePanel, {
        row,
        r: { a: target("t", "a"), b: target("u", "b") } as unknown as ReleaseComparison,
        position: "1 of 1",
        onClose: () => undefined,
      }),
    );
    expect(html.match(/No source position recorded/g)).toHaveLength(2);
    expect(html).not.toContain("source-line");
  });

  it("draws an interface row as window → member → channel → handler → host on its line", () => {
    const row: ChangeRow = {
      id: "z",
      collection: "interfaces",
      change: "added",
      key: "preload.js::notesdesk::checkUpdate",
      where: [
        { side: "b", file: "preload.js", line: 9 },
        { side: "b", file: "main.js", line: 30, role: "handler" },
      ],
      basis: "link direct",
      trace: { windows: ["main.js:win"], channel: `update:check${HOSTILE}` },
    };
    const host: ChangeRow = {
      id: "h",
      collection: "endpoints",
      change: "added",
      key: "main.js::fetch::https://updates.notesdesk.example/latest.json",
      where: [{ side: "b", file: "main.js", line: 30 }],
    };
    const other: ChangeRow = {
      ...host,
      id: "o",
      key: "x.js::fetch::https://elsewhere.example/",
      where: [{ side: "b", file: "x.js", line: 1 }],
    };
    const r = {
      a: target("t_a", "a"),
      b: target("t_b", "b"),
      changes: [row, host, other],
    } as unknown as ReleaseComparison;
    const html = renderToStaticMarkup(
      createElement(EvidencePanel, { row, r, position: "1 of 3", onClose: () => undefined }),
    );
    const path = /<ol class="trace-path"[^>]*>([\s\S]*?)<\/ol>/.exec(html)![1]!;
    const steps = [
      ...path.matchAll(/<span class="trace-role">([^<]*)<\/span><code>([^<]*)<\/code>/g),
    ].map((m) => `${m[1]} ${m[2]}`);
    expect(steps).toEqual([
      "window main.js:win",
      "preload member notesdesk.checkUpdate",
      "channel update:check&lt;img src=x onerror=alert(1)&gt;",
      "handler main.js:30",
      "host on the handler&#x27;s line https://updates.notesdesk.example/latest.json",
    ]);
    expect(path).toContain('<span class="trace-at">preload.js:9</span>');
    expect(path).not.toContain("elsewhere");
    // a row from an older server, without trace: no path
    const { trace: _drop, ...withoutTrace } = row;
    const plain = renderToStaticMarkup(
      createElement(EvidencePanel, {
        row: withoutTrace,
        r,
        position: "1 of 3",
        onClose: () => undefined,
      }),
    );
    expect(plain).not.toContain("trace-path");
  });
});
