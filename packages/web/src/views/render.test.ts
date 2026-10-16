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
});
