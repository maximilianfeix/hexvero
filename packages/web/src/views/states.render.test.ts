import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AnalysisResponse, TargetRecord } from "../lib/api.js";
import { cellText, Table } from "./CollectionView.js";
import { Overview } from "./Overview.js";
import { LoadError } from "./LoadError.js";
import { tabsFor, Workspace } from "./Workspace.js";

/** Built at run time: the source holds no direction-changing or control character. */
const RLO = String.fromCharCode(0x202e);
const BEL = String.fromCharCode(7);
const HOSTILE = "<img src=x onerror=alert(1)>";

const target = (path: string, format = "asar"): TargetRecord => ({
  id: "t_x",
  info: { path, size: 1, sha256: "0".repeat(64), format },
  openedAt: "",
  analyzed: true,
});

const analysis = (patch: Partial<AnalysisResponse>): AnalysisResponse => ({
  target: target("/x/a.asar"),
  summary: "s",
  durationMs: 1,
  findings: [],
  limitations: [],
  collections: {},
  data: { kind: "javascript" },
  ...patch,
});

describe("target text in the workspace", () => {
  it("writes out direction-changing and control characters in findings and limitations", () => {
    const html = renderToStaticMarkup(
      createElement(Overview, {
        analysis: analysis({
          findings: [
            {
              kind: "electron.ipc",
              title: `channel ${HOSTILE}`,
              detail: `safe${RLO}exe, ctl${BEL}x`,
              confidence: "confirmed",
              location: `main${RLO}.js:3`,
            },
          ],
          limitations: [{ code: "c", message: `odd${RLO}name` }],
        }),
      }),
    );
    expect(html).not.toContain(RLO);
    expect(html).not.toContain(BEL);
    expect(html).not.toContain("<img");
    expect(html).toContain("safe⟨U+202E⟩exe, ctl⟨U+0007⟩x");
    expect(html).toContain("odd⟨U+202E⟩name");
    expect(html).toContain("main⟨U+202E⟩.js:3");
  });

  it("writes out direction-changing characters in the target path", () => {
    const html = renderToStaticMarkup(
      createElement(Workspace, {
        target: target(`/x/${HOSTILE}${RLO}gpj.exe`),
        tab: "overview",
        query: new URLSearchParams(),
      }),
    );
    expect(html).not.toContain(RLO);
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;⟨U+202E⟩gpj.exe");
    // while the analysis runs, the reading line is announced
    expect(html).toMatch(/<p[^>]*role="status"[^>]*>Reading /);
  });

  it("writes out invisible characters in table cells", () => {
    expect(cellText(`safe${RLO}exe`)).toBe("safe⟨U+202E⟩exe");
    expect(cellText({ k: `a${BEL}` })).not.toContain(BEL);
  });
});

describe("failed loads", () => {
  it("a table that failed to load says so instead of claiming no rows match", () => {
    const html = renderToStaticMarkup(
      createElement(Table, {
        rows: [],
        loading: false,
        error: new Error("Injected failure"),
        onRetry: () => undefined,
      }),
    );
    expect(html).not.toContain("No rows match");
    expect(html).toContain('role="alert"');
    expect(html).toContain("Injected failure");
    expect(html).toContain("Retry");
  });

  it("a view that failed to load is announced and offers a retry", () => {
    const html = renderToStaticMarkup(
      createElement(LoadError, {
        what: "the module graph",
        error: new Error(`bad${RLO}`),
        onRetry: () => undefined,
      }),
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("Could not load the module graph: bad⟨U+202E⟩");
    expect(html).toContain("Retry");
  });
});

describe("views a target does not have", () => {
  it("offers the module graph and interface map only for a JavaScript application", () => {
    const plain = tabsFor(target("/x/plain.js", "javascript"), "overview", analysis({}));
    expect(plain).not.toContain("graph");
    expect(plain).not.toContain("interface-map");
    const app = tabsFor(
      target("/x/a.asar"),
      "overview",
      analysis({ data: { kind: "javascript-app" }, collections: { interfaces: 2 } }),
    );
    expect(app).toContain("graph");
    expect(app).toContain("interface-map");
  });
});

describe("source view", () => {
  it("names the file:line it shows with invisible characters written out", async () => {
    const { SourceView } = await import("./SourceView.js");
    const html = renderToStaticMarkup(
      createElement(SourceView, {
        targetId: "t_x",
        query: new URLSearchParams({ file: `a${RLO}.js`, line: "3" }),
      }),
    );
    expect(html).not.toContain(RLO);
    expect(html).toContain("a⟨U+202E⟩.js:3");
  });
});
