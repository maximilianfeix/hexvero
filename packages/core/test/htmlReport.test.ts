import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  collectReleaseSources,
  compareReleases,
  escapeHtml,
  MAX_HTML_EXCERPTS,
  placeKey,
  renderReleaseReportHtml,
  Session,
  type ReleaseComparison,
  type SourceWindow,
} from "../src/index.js";
import { buildAsar } from "./fixtures/asar.js";

const examples = join(import.meta.dirname, "..", "..", "..", "examples");
const dir = mkdtempSync(join(tmpdir(), "hexvero-html-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function render(
  pathA: string,
  pathB: string,
): Promise<{ r: ReleaseComparison; html: string }> {
  const session = new Session();
  const a = await session.open(pathA);
  const b = await session.open(pathB);
  const r = await compareReleases(session, a.id, b.id);
  return { r, html: renderReleaseReportHtml(r, await collectReleaseSources(session, r)) };
}
const example = (): Promise<{ r: ReleaseComparison; html: string }> =>
  render(join(examples, "notesdesk-1.4.0.asar"), join(examples, "notesdesk-1.5.0.asar"));

const scripts = (html: string): string[] =>
  [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
const csp = (html: string): string =>
  /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html)![1]!;
/** The page as a browser without JavaScript shows it: the script never runs. */
const withoutScript = (html: string): string => html.replace(/<script>[\s\S]*?<\/script>/g, "");

/** A build whose names hold markup, a script scheme and invisible characters. */
const hostile = (v2: boolean): Record<string, string> => ({
  "package.json": JSON.stringify({
    name: "x",
    version: v2 ? "2.0.0" : "1.0.0",
    main: "main.js",
  }),
  "main.js": [
    'const { ipcMain, BrowserWindow } = require("electron");',
    "new BrowserWindow({ webPreferences: { preload: 'preload.js' } });",
    v2 ? 'ipcMain.handle("</script><script>alert(1)</script>", () => 1);' : "",
    v2 ? 'ipcMain.handle("\\"><img src=x onerror=alert(1)>", () => 1);' : "",
    v2 ? 'ipcMain.handle("</style><b>x</b>", () => 1);' : "",
    v2 ? 'fetch("javascript:alert(document.domain)");' : "",
    v2 ? 'ipcMain.handle("evil‮txt.exe​", () => 1);' : "",
  ].join("\n"),
  "preload.js": [
    'const { contextBridge, ipcRenderer } = require("electron");',
    'contextBridge.exposeInMainWorld("api", {',
    v2
      ? '  "<svg onload=alert(1)>": () => ipcRenderer.invoke("</script><script>alert(1)</script>"),'
      : "",
    "});",
  ].join("\n"),
});

/** A build with one IPC handler and no preload member. */
const plain = (v2: boolean): string => {
  const path = join(dir, `plain-${v2}.asar`);
  writeFileSync(
    path,
    buildAsar({
      "package.json": JSON.stringify({ name: "p", main: "main.js" }),
      "main.js": `require("electron").ipcMain.handle("${v2 ? "b" : "a"}", () => 1);`,
    }),
  );
  return path;
};

describe("escapeHtml", () => {
  it("turns markup into text in element content and attribute values", () => {
    expect(escapeHtml("<script>alert(1)</script>")).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(escapeHtml('"><img src=x onerror=alert(1)>')).toBe(
      "&quot;&gt;&lt;img src=x onerror=alert(1)&gt;",
    );
    expect(escapeHtml("</style><style>*{}")).toBe("&lt;/style&gt;&lt;style&gt;*{}");
    expect(escapeHtml("' onmouseover='x")).toBe("&#39; onmouseover=&#39;x");
    expect(escapeHtml("a & b &amp;")).toBe("a &amp; b &amp;amp;");
    // a scheme stays text; nothing in the report turns target text into a link
    expect(escapeHtml("javascript:alert(1)")).toBe("javascript:alert(1)");
  });

  it("makes bidi, zero-width and control characters visible", () => {
    expect(escapeHtml("evil‮txt.exe")).toBe("evil⟨U+202E⟩txt.exe");
    expect(escapeHtml("a​b⁦c⁩﻿")).toBe("a⟨U+200B⟩b⟨U+2066⟩c⟨U+2069⟩⟨U+FEFF⟩");
    expect(escapeHtml("x\u0000y\u001Bz\u007F\u0085\nw")).toBe(
      "x⟨U+0000⟩y⟨U+001B⟩z⟨U+007F⟩⟨U+0085⟩⟨U+000A⟩w",
    );
    expect(escapeHtml("tab\tstays")).toBe("tab\tstays");
    expect(escapeHtml("lone \uD800 surrogate")).toBe("lone � surrogate");
  });
});

describe("HTML release report", () => {
  it("draws a new preload member from window to handler, and a host on the handler's line", async () => {
    const { r, html } = await example();
    const row = r.changes.find((c) => c.key === "preload.js::notesdesk::checkUpdate")!;
    expect(row.trace).toEqual({ windows: ["main.js:win"], channel: "update:check" });
    const section = /<section id="paths">([\s\S]*?)<\/section>/.exec(html)![1]!;
    const nodes = [
      ...section.matchAll(
        /<li class="tnode[^"]*"><span class="trole">([^<]*)<\/span><code>([^<]*)<\/code>(?:<span class="tat">([^<]*)<\/span>)?/g,
      ),
    ].map((m) => [m[1], m[2], m[3] ?? ""]);
    expect(nodes).toEqual([
      ["window", "main.js:win", ""],
      ["preload member", "notesdesk.checkUpdate", "preload.js:9"],
      ["IPC channel", "update:check", "link direct"],
      ["handler", "main.js:30", ""],
      [
        "host on the handler&#39;s line",
        "https://updates.notesdesk.example/latest.json",
        "main.js:30",
      ],
    ]);
    // a removed member is not drawn: the section is about what pages can newly reach
    expect(section).not.toContain("openInShell");
    expect(section).toContain("an inference from place, not a traced call");
  });

  it("leaves the section out when no preload member was added or changed", async () => {
    const { html } = await render(plain(false), plain(true));
    expect(html).not.toContain('<section id="paths">');
  });

  it("renders the example builds with places, excerpts, gaps, page and reproduce command", async () => {
    const { r, html } = await example();
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<h1>What changed: notesdesk-1.4.0.asar → notesdesk-1.5.0.asar</h1>");
    expect(html).toContain(`hexvero ${r.hexvero}`);
    expect(html).toContain(`<strong>${r.changes.length} of ${r.page.total} rows shown</strong>`);
    expect(html).toContain("Window settings to review");
    expect(html).toContain("sandboxInEffect");
    // every row, with its id, sign and word, grouped per list
    for (const row of r.changes) {
      expect(html).toContain(`id="row-${row.id}" data-change="${row.change}"`);
      expect(html).toContain(escapeHtml(row.key));
    }
    expect(html).toContain('<section class="group"><h3><code>interfaces</code>');
    expect(html).toMatch(
      /<span class="sign" aria-hidden="true">\+<\/span>\s*<div><div><span class="word">added<\/span>/,
    );
    // the source line of the added member, marked, with its line number
    expect(html).toContain(
      '<span class="ln hit"><i>9</i>  checkUpdate: () =&gt; ipcRenderer.invoke(&quot;update:check&quot;),</span>',
    );
    // a changed window shows before (a) and after (b) side by side
    expect(html).toContain("before (a) · notesdesk-1.4.0.asar");
    expect(html).toContain("after (b) · notesdesk-1.5.0.asar");
    // completeness gaps and what was not established
    expect(html).toContain("<h2>Not established</h2>");
    expect(html).toContain("<code>values_unresolved</code>");
    expect(html).toContain(
      `npx hexvero@${r.hexvero} compare notesdesk-1.4.0.asar notesdesk-1.5.0.asar --report report.html`,
    );
    // no dates, no directories
    expect(html).not.toContain(examples);
    expect(html).not.toMatch(/20\d\d-\d\d-\d\d/);
  });

  it("is the same bytes for the same inputs", async () => {
    expect((await example()).html).toBe((await example()).html);
  });

  it("allows exactly its own inline script by hash and loads nothing", async () => {
    const { html } = await example();
    const list = scripts(html);
    expect(list).toHaveLength(1);
    const hash = createHash("sha256").update(list[0]!, "utf8").digest("base64");
    expect(csp(html)).toBe(
      `default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${hash}'; img-src data:; base-uri 'none'; form-action 'none'`,
    );
    expect(html).not.toMatch(/\s(src|href|action|srcset)=/i);
    expect(html).not.toMatch(/<(link|iframe|object|embed|img|base)\b/i);
    expect(html).not.toMatch(/url\(|@import/i);
  });

  it("reads the same without JavaScript: the rows are in the HTML, the filters hidden", async () => {
    const { r, html } = await example();
    const page = withoutScript(html);
    expect(page.match(/<li class="row /g)).toHaveLength(r.changes.length);
    expect(page).toContain('<form id="filters" hidden');
    expect(page.match(/<figure class="src">/g)!.length).toBeGreaterThan(5);
    expect(page).not.toMatch(/<li class="row[^>]*\shidden/);
    // the script only filters what is there: it creates no markup
    expect(scripts(html)[0]).not.toMatch(/innerHTML|insertAdjacent|createElement|document\.write/);
  });

  it("shows hostile text from a target as text", async () => {
    writeFileSync(join(dir, "h1.asar"), buildAsar(hostile(false)));
    writeFileSync(join(dir, "h2.asar"), buildAsar(hostile(true)));
    const { r, html } = await render(join(dir, "h1.asar"), join(dir, "h2.asar"));
    expect(r.changes.length).toBeGreaterThan(3);
    const page = withoutScript(html);
    expect(page).not.toMatch(/<script|<img|<svg|<b>|<\/style><b/i);
    expect(html.match(/<\/style>/g)).toHaveLength(1);
    expect(html.match(/<script>/g)).toHaveLength(1);
    expect(page).toContain("&lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(page).toContain("&quot;&gt;&lt;img src=x onerror=alert(1)&gt;");
    expect(page).toContain("javascript:alert(document.domain)");
    expect(page).not.toMatch(/href=/);
    expect(page).toContain("evil⟨U+202E⟩txt.exe⟨U+200B⟩");
    expect(page).not.toMatch(/[‮​]/);
    // attribute values hold no quote a target could close
    for (const m of page.matchAll(/data-list="([^"]*)"/g)) expect(m[1]).not.toMatch(/[<>"]/);
  });

  it("caps excerpts and long text, and says so", async () => {
    const { r } = await example();
    const base = r.changes[0]!;
    const changes = Array.from({ length: 300 }, (_, i) => ({
      ...base,
      id: `id${i}`,
      key: i === 0 ? "k".repeat(5000) : `key${i}`,
      where: [{ side: "b" as const, file: `f${i}.js`, line: 1 }],
    }));
    const sources = new Map<string, SourceWindow>();
    for (const row of changes)
      sources.set(placeKey(row.where[0]!), {
        file: row.where[0]!.file,
        line: 1,
        start: 1,
        lines: Array.from({ length: 20 }, (_, i) => `line ${i + 1}`),
        totalLines: 20,
        cut: [],
      });
    const big = { ...r, changes, page: { ...r.page, total: 300, limit: 300 } };
    const html = renderReleaseReportHtml(big, sources);
    expect(html.match(/<figure class="src">/g)).toHaveLength(MAX_HTML_EXCERPTS);
    // seven lines each, however many the window holds
    expect(html.match(/<span class="ln/g)).toHaveLength(MAX_HTML_EXCERPTS * 7);
    expect(html).toContain(`at most ${MAX_HTML_EXCERPTS} excerpts`);
    expect(html).toContain("… (5000 characters)");
    expect(html).not.toContain("k".repeat(1001));
  });
});
