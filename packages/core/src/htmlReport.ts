import { createHash } from "node:crypto";
import {
  baseName,
  CHANGE_SIGN,
  DEFAULT_RELEASE_ROWS,
  notEstablished,
  summaryOf,
  type ChangeRow,
  type Place,
  type ReleaseComparison,
} from "./report.js";
import type { Session } from "./session.js";
import type { SourceWindow } from "./source.js";

/** Source excerpts a report embeds at most, and the lines and characters each may hold. */
export const MAX_HTML_EXCERPTS = 200;
export const HTML_EXCERPT_CONTEXT = 3;
const EXCERPT_LINES = HTML_EXCERPT_CONTEXT * 2 + 1;
/** All excerpt text together; past it excerpts are left out and the page says so. */
export const MAX_HTML_EXCERPT_CHARS = 250_000;
/** One piece of target text (a key, a value): longer ones are cut, with their length shown. */
const MAX_TEXT = 1_000;
/** Places listed per row and side. */
const MAX_PLACES = 8;

/** The key of a place's excerpt: `${side}:${file}:${line}`. */
export const placeKey = (p: Pick<Place, "side" | "file" | "line">): string =>
  `${p.side}:${p.file}:${p.line ?? ""}`;

// C0/C1 controls except tab, bidi marks/embeddings/overrides/isolates, zero-width and BOM: the
// same set as packages/web/src/lib/text.ts. Kept as escapes: the source must not hold them.
const INVISIBLE = new RegExp(
  // oxlint-disable-next-line no-control-regex -- finding control characters is the point
  "[\\u0000-\\u0008\\u000a-\\u001f\\u007f-\\u009f\\u061c\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u2069\\ufeff]",
  "g",
);
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const ENTITY: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/**
 * Text from a target as HTML text or an attribute value: markup characters become entities and
 * invisible characters (bidi overrides, zero-width, controls) become a visible `⟨U+202E⟩`, so
 * nothing a target holds can add markup, end an attribute or reorder what the reviewer reads.
 * Lone surrogates become U+FFFD.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(LONE_SURROGATE, "\uFFFD")
    .replace(INVISIBLE, (c) => `⟨U+${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}⟩`)
    .replace(/[&<>"']/g, (c) => ENTITY[c]!);
}

/** Target text cut to `max` characters, escaped, with the full length named when cut. */
const text = (value: string, max = MAX_TEXT): string =>
  value.length <= max
    ? escapeHtml(value)
    : `${escapeHtml(value.slice(0, max))}<span class="cut"> … (${value.length} characters)</span>`;
const code = (value: string, max?: number): string => `<code>${text(value, max)}</code>`;
const show = (v: unknown): string => (v === undefined ? "not written" : JSON.stringify(v));
const nf = (n: number): string => n.toLocaleString("en-US");

/**
 * Reads the source lines around the places of a comparison's rows, for the HTML report: at most
 * `max` excerpts of seven lines, in row order. A place hexvero cannot show (not a JavaScript app,
 * a file the analysis did not read) is left out; the report says how many have no excerpt.
 */
export async function collectReleaseSources(
  session: Session,
  r: ReleaseComparison,
  max = MAX_HTML_EXCERPTS,
): Promise<Map<string, SourceWindow>> {
  const out = new Map<string, SourceWindow>();
  const tried = new Set<string>();
  for (const row of r.changes)
    for (const p of [
      ...(row.whereBefore ?? []).slice(0, MAX_PLACES),
      ...row.where.slice(0, MAX_PLACES),
    ]) {
      if (p.line === undefined) continue;
      const key = placeKey(p);
      if (tried.has(key)) continue;
      if (tried.size >= max) return out;
      tried.add(key);
      try {
        const id = p.side === "a" ? r.a.id : r.b.id;
        out.set(key, await session.source(id, p.file, p.line, HTML_EXCERPT_CONTEXT));
      } catch {
        // not readable as source (not an app, not a file the analysis read): no excerpt
      }
    }
  return out;
}

/** The inline script: filters rows by kind, list and text. The page reads the same without it. */
const SCRIPT = `(function () {
  var d = document, form = d.getElementById("filters");
  if (!form) return;
  form.hidden = false;
  var rows = Array.prototype.slice.call(d.querySelectorAll("li.row"));
  var groups = Array.prototype.slice.call(d.querySelectorAll("section.group"));
  var kinds = Array.prototype.slice.call(form.querySelectorAll("input[name=kind]"));
  var list = d.getElementById("f-list"), query = d.getElementById("f-text"), count = d.getElementById("f-count");
  var words = rows.map(function (r) { return (r.textContent || "").toLowerCase(); });
  function apply() {
    var on = {}, shown = 0, l = list.value, t = query.value.trim().toLowerCase();
    kinds.forEach(function (k) { on[k.value] = k.checked; });
    rows.forEach(function (r, i) {
      var keep = on[r.getAttribute("data-change")] && (!l || r.getAttribute("data-list") === l) && (!t || words[i].indexOf(t) !== -1);
      r.hidden = !keep;
      if (keep) shown++;
    });
    groups.forEach(function (g) { g.hidden = !g.querySelector("li.row:not([hidden])"); });
    count.textContent = shown === rows.length ? "" : shown + " of " + rows.length + " rows on this page match";
  }
  form.addEventListener("input", apply);
  form.addEventListener("change", apply);
  form.addEventListener("submit", function (e) { e.preventDefault(); });
  apply();
})();`;

/** The CSP source for the inline script: its sha256, computed from the text the page carries. */
export const scriptHash = (script: string): string =>
  `'sha256-${createHash("sha256").update(script, "utf8").digest("base64")}'`;

const STYLE = `
:root{color-scheme:dark light;--bg:#1b1d21;--panel:#23262c;--line:#31353d;--ink:#e8e6e1;--ink-2:#9a9ea7;--ink-3:#8e939d;--amber:#f2b84b;--amber-soft:#3a2f17;--alert:#e5736f;--ok:#8fc98a;--sans:"IBM Plex Sans",system-ui,-apple-system,"Segoe UI",sans-serif;--mono:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
@media (prefers-color-scheme:light){:root{--bg:#f3f4f6;--panel:#fff;--line:#dcdfe4;--ink:#1d2026;--ink-2:#5c616b;--ink-3:#676c76;--amber:#8a5e04;--amber-soft:#fbefcf;--alert:#b3261e;--ok:#2a752e}}
*{box-sizing:border-box}[hidden]{display:none!important}
html{background:var(--bg)}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 var(--sans);font-variant-numeric:tabular-nums}
::selection{background:var(--amber-soft)}
:focus-visible{outline:2px solid var(--amber);outline-offset:2px}
main{max-width:1180px;margin:0 auto;padding:32px 24px 64px}
h1{font-size:clamp(1.25rem,2.2vw,1.75rem);font-weight:600;letter-spacing:-.02em;margin:0 0 8px;text-wrap:balance;overflow-wrap:anywhere}
h2{font-size:1.1rem;font-weight:600;margin:40px 0 12px;padding-top:16px;border-top:1px solid var(--line)}
h3{font-size:.95rem;font-weight:600;margin:24px 0 8px}
p{margin:0 0 12px;max-width:80ch}.note{color:var(--ink-3);font-size:14px}
code,pre,.mono{font-family:var(--mono);font-size:13px}
code{overflow-wrap:anywhere}
table{border-collapse:collapse;width:auto;min-width:min(100%,640px);font-size:14px;margin:0 0 16px}
th,td{text-align:left;padding:6px 12px 6px 0;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--ink-2);font-weight:500}td.n,th.n{text-align:right}
.wrap-table{overflow-x:auto}
ul.plain{margin:0 0 16px;padding-left:20px}ul.plain li{margin:4px 0}
.dir-more{color:var(--alert)}.dir-less{color:var(--ok)}.dir-unclear{color:var(--ink-2)}
form#filters{display:flex;flex-wrap:wrap;gap:12px 20px;align-items:center;background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:10px 14px;margin:0 0 16px;font-size:14px}
form#filters label{display:inline-flex;gap:6px;align-items:center}
form#filters select,form#filters input[type=search]{font:inherit;color:var(--ink);background:var(--bg);border:1px solid var(--line);border-radius:4px;padding:4px 8px}
form#filters input[type=checkbox]{accent-color:var(--amber)}
#f-count{color:var(--ink-3)}
ul.rows{list-style:none;margin:0;padding:0}
li.row{display:grid;grid-template-columns:1.5rem minmax(0,1fr);gap:4px 8px;padding:12px 0;border-bottom:1px solid var(--line)}
.sign{font-family:var(--mono);font-weight:600;text-align:center}
.added .sign{color:var(--ok)}.removed .sign{color:var(--alert)}.changed .sign{color:var(--amber)}.unknown .sign{color:var(--ink-2)}
.word{font-weight:500;margin-right:6px}.key{color:var(--ink)}
.tag{font-size:12px;color:var(--ink-2);border:1px solid var(--line);border-radius:3px;padding:0 5px;margin-left:6px;white-space:nowrap}
.reason{color:var(--ink-2);font-size:14px;margin:4px 0 0}
table.fields{margin:6px 0 4px;width:auto;min-width:50%}
.sides>*{min-width:0}.sides{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(340px,100%),1fr));gap:12px;margin-top:8px}
.side h4{margin:0 0 4px;font-size:13px;font-weight:500;color:var(--ink-2)}
.place{margin:0 0 6px}.role{color:var(--ink-3);font-size:13px;margin-right:4px}
figure.src{margin:0 0 8px;background:var(--panel);border:1px solid var(--line);border-radius:6px;overflow:hidden}
figure.src figcaption{font-size:12px;color:var(--ink-2);padding:4px 10px;border-bottom:1px solid var(--line)}
figure.src pre{margin:0;padding:6px 0;overflow-x:auto;line-height:1.5}
.ln{display:block;padding:0 10px;white-space:pre}.ln i{display:inline-block;min-width:3.5ch;margin-right:12px;color:var(--ink-3);font-style:normal;text-align:right;user-select:none}
.ln.hit{background:var(--amber-soft)}.ln.hit i{color:var(--amber)}
.cut{color:var(--ink-3);font-family:var(--sans);font-size:12px}
details.more summary{cursor:pointer;color:var(--ink-2);font-size:13px}
pre.cmd{background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:10px 14px;overflow-x:auto}
footer{margin-top:48px;color:var(--ink-3);font-size:13px}
@media (max-width:640px){main{padding:20px 16px 48px}.sides{grid-template-columns:1fr}}
`;

/** A file name as one shell word, shown as text: single-quoted unless it is plain. */
const shellWord = (value: string): string => {
  const flat = [...value].filter((c) => c.charCodeAt(0) > 31 && c !== "\u007f").join("");
  return /^[\w./@:+-]+$/.test(flat) ? flat : `'${flat.replace(/'/g, "'\\''")}'`;
};

interface Budget {
  excerpts: number;
  chars: number;
  /** Places with a line whose excerpt was not shown: none given, or past a limit. */
  missing: number;
  capped: boolean;
}

function excerpt(p: Place, w: SourceWindow, budget: Budget, role: string): string {
  if (budget.excerpts >= MAX_HTML_EXCERPTS || budget.chars >= MAX_HTML_EXCERPT_CHARS) {
    budget.capped = true;
    budget.missing++;
    return "";
  }
  const line = p.line!;
  const from = Math.max(w.start, line - HTML_EXCERPT_CONTEXT);
  const lines = w.lines.slice(from - w.start, from - w.start + EXCERPT_LINES);
  const cut = new Map(w.cut.map((c) => [c.line, c.length]));
  budget.excerpts++;
  const body = lines
    .map((textLine, i) => {
      const n = from + i;
      budget.chars += textLine.length;
      const long = cut.get(n);
      return `<span class="ln${n === line ? " hit" : ""}"><i>${n}</i>${escapeHtml(textLine) || " "}${
        long === undefined ? "" : `<span class="cut"> … (line is ${nf(long)} characters)</span>`
      }</span>`;
    })
    .join("");
  return `<figure class="src"><figcaption>${role}<code>${escapeHtml(`${p.file}:${line}`)}</code> · lines ${from}–${
    from + lines.length - 1
  } of ${nf(w.totalLines)}</figcaption><pre><code>${body}</code></pre></figure>`;
}

function places(
  list: readonly Place[],
  sources: ReadonlyMap<string, SourceWindow>,
  budget: Budget,
): string {
  const shown = list.slice(0, MAX_PLACES).map((p) => {
    const label = `${p.file}${p.line === undefined ? "" : `:${p.line}`}`;
    const role = p.role ? `<span class="role">${escapeHtml(p.role)}</span>` : "";
    const w = p.line === undefined ? undefined : sources.get(placeKey(p));
    if (p.line !== undefined && !w) budget.missing++;
    const figure = w ? excerpt(p, w, budget, role) : "";
    return `<div class="place">${figure || `${role}${code(label)}`}</div>`;
  });
  if (list.length > MAX_PLACES)
    shown.push(`<p class="note">+${list.length - MAX_PLACES} more place(s) not listed.</p>`);
  return shown.join("");
}

function sideBlock(
  title: string,
  list: readonly Place[] | undefined,
  sources: ReadonlyMap<string, SourceWindow>,
  budget: Budget,
): string {
  if (!list) return "";
  const body = list.length
    ? places(list, sources, budget)
    : `<p class="note">No position recorded for this item.</p>`;
  return `<div class="side"><h4>${title}</h4>${body}</div>`;
}

function rowHtml(
  row: ChangeRow,
  names: { a: string; b: string },
  sources: ReadonlyMap<string, SourceWindow>,
  budget: Budget,
): string {
  const label = (side: "a" | "b"): string =>
    `${side === "a" ? "before (a)" : "after (b)"} · ${escapeHtml(names[side])}`;
  const side = row.where[0]?.side ?? (row.change === "removed" ? "a" : "b");
  const fields = row.fields?.length
    ? `<div class="wrap-table"><table class="fields"><thead><tr><th>field</th><th>before</th><th>after</th></tr></thead><tbody>${row.fields
        .slice(0, 50)
        .map(
          (f) =>
            `<tr><td>${code(f.field, 200)}</td><td>${code(show(f.before), 300)}</td><td>${code(show(f.after), 300)}</td></tr>`,
        )
        .join("")}</tbody></table></div>${
        row.fields.length > 50
          ? `<p class="note">${row.fields.length - 50} more field(s) not listed.</p>`
          : ""
      }`
    : "";
  const sides =
    row.change === "changed"
      ? sideBlock(label("a"), row.whereBefore ?? [], sources, budget) +
        sideBlock(label("b"), row.where, sources, budget)
      : sideBlock(`in ${label(side)}`, row.where, sources, budget);
  return `<li class="row ${row.change}" id="row-${escapeHtml(row.id)}" data-change="${row.change}" data-list="${escapeHtml(row.collection)}">
<span class="sign" aria-hidden="true">${CHANGE_SIGN[row.change]}</span>
<div><div><span class="word">${row.change}</span>${code(row.key)}${
    row.basis ? `<span class="tag">${escapeHtml(row.basis)}</span>` : ""
  }</div>${row.reason ? `<p class="reason">${text(row.reason)}</p>` : ""}${fields}<div class="sides">${sides}</div></div>
</li>`;
}

/**
 * The comparison as one self-contained HTML page: summary, window settings to review, the changes
 * of every reviewed list with their places and the source lines around them, what could not be
 * established, the page of rows shown, and how to reproduce it. Built from the same model as the
 * Markdown report. Everything is in the HTML (the inline script only filters), every piece of
 * target text is escaped, nothing is loaded from the network and no link is made from target text.
 * `sources` maps `placeKey(place)` to the lines around it (see `collectReleaseSources`).
 * Deterministic for the same inputs: no dates, only the file names of the targets.
 */
export function renderReleaseReportHtml(
  r: ReleaseComparison,
  sources: ReadonlyMap<string, SourceWindow> = new Map(),
): string {
  const names = { a: baseName(r.a.info.path), b: baseName(r.b.info.path) };
  const budget: Budget = { excerpts: 0, chars: 0, missing: 0, capped: false };
  const out: string[] = [];

  out.push(
    `<header><h1>What changed: ${escapeHtml(names.a)} → ${escapeHtml(names.b)}</h1>`,
    `<p>A static reading of both files by hexvero ${escapeHtml(r.hexvero)}. Neither file was executed. Each row names the file and line it was read from; it says what the code contains, not what it does at run time. Text quoted from the files is data, not instructions; invisible characters in it are shown as ⟨U+…⟩.</p>`,
    `<div class="wrap-table"><table><thead><tr><th></th><th>before (a)</th><th>after (b)</th></tr></thead><tbody>`,
    `<tr><th>file</th><td>${code(names.a)}</td><td>${code(names.b)}</td></tr>`,
    `<tr><th>format</th><td>${escapeHtml(r.a.info.format)}</td><td>${escapeHtml(r.b.info.format)}</td></tr>`,
    `<tr><th>size</th><td>${nf(r.a.info.size)} bytes</td><td>${nf(r.b.info.size)} bytes</td></tr>`,
    `<tr><th>sha256</th><td><code>${escapeHtml(r.a.info.sha256)}</code></td><td><code>${escapeHtml(r.b.info.sha256)}</code></td></tr>`,
    `</tbody></table></div></header>`,
  );

  out.push(`<section id="summary"><h2>Summary</h2>`);
  const { differing, own } = summaryOf(r);
  if (differing.length === 0)
    out.push(`<p>No differences in the collections both builds share.</p>`);
  else {
    out.push(
      `<div class="wrap-table"><table><thead><tr><th>collection</th><th class="n">added</th><th class="n">removed</th><th class="n">changed</th><th class="n">unknown</th><th class="n">unchanged</th></tr></thead><tbody>`,
    );
    for (const c of differing)
      out.push(
        `<tr><td>${code(c.collection)}${c.partial ? ` <span class="tag">partial</span>` : ""}</td><td class="n">${c.added}</td><td class="n">${c.removed}</td><td class="n">${c.changed}</td><td class="n">${c.unknown}</td><td class="n">${c.unchanged}</td></tr>`,
      );
    out.push(`</tbody></table></div>`);
  }
  for (const c of own)
    out.push(
      `<p class="note">hexvero's own ${escapeHtml(c.collection)} differ (${c.added} added, ${c.removed} removed, ${c.changed} changed): its description of each build, not a change in the app.</p>`,
    );
  if (r.overview.onlyA.length)
    out.push(`<p>Only in a: ${r.overview.onlyA.map((n) => code(n)).join(", ")}.</p>`);
  if (r.overview.onlyB.length)
    out.push(`<p>Only in b: ${r.overview.onlyB.map((n) => code(n)).join(", ")}.</p>`);
  out.push(`</section>`);

  if (r.overview.windowChanges.length) {
    out.push(
      `<section id="windows"><h2>Window settings to review</h2><div class="wrap-table"><table><thead><tr><th>window</th><th>setting</th><th>before</th><th>after</th><th>direction</th></tr></thead><tbody>`,
    );
    for (const w of r.overview.windowChanges)
      out.push(
        `<tr><td>${code(w.window)}</td><td>${code(w.setting)}</td><td>${code(w.before)}</td><td>${code(w.after)}</td><td class="dir-${w.direction.split(" ")[0]}">${escapeHtml(w.direction)}</td></tr>`,
      );
    out.push(
      `</tbody></table></div><p class="note">Whether a change matters depends on what the window loads; this is a fact to review, not a verdict.</p></section>`,
    );
  }

  out.push(`<section id="changes"><h2>Changes</h2>`);
  if (r.page.total === 0) out.push(`<p>No row-level changes in the reviewed collections.</p>`);
  else {
    const range =
      r.changes.length > 0
        ? ` (rows ${r.page.offset + 1}–${r.page.offset + r.changes.length})`
        : "";
    out.push(
      `<p id="page"><strong>${r.changes.length} of ${r.page.total} rows shown</strong>${range}.</p>`,
    );
  }
  const groups = new Map<string, ChangeRow[]>();
  for (const row of r.changes) {
    const list = groups.get(row.collection);
    if (list) list.push(row);
    else groups.set(row.collection, [row]);
  }
  if (r.changes.length) {
    const kinds = (["added", "removed", "changed", "unknown"] as const).filter((k) =>
      r.changes.some((c) => c.change === k),
    );
    out.push(
      `<form id="filters" hidden aria-label="Filter rows">${kinds
        .map(
          (k) =>
            `<label><input type="checkbox" name="kind" value="${k}" checked> ${CHANGE_SIGN[k]} ${k}</label>`,
        )
        .join("")}<label>list <select id="f-list"><option value="">all on this page</option>${[
        ...groups.keys(),
      ]
        .map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`)
        .join(
          "",
        )}</select></label><label>text <input type="search" id="f-text" placeholder="key, file, value"></label><span id="f-count" aria-live="polite"></span></form>`,
    );
  }
  for (const [collection, list] of groups) {
    const cut = r.cut.find((c) => c.collection === collection);
    out.push(
      `<section class="group"><h3>${code(collection)} <span class="note">${
        cut
          ? `${cut.shown} of ${cut.total} rows of this list on this page`
          : `${list.length} row(s)`
      }</span></h3><ul class="rows">`,
    );
    for (const row of list) out.push(rowHtml(row, names, sources, budget));
    out.push(`</ul></section>`);
  }
  if (r.cut.length)
    out.push(
      `<ul class="plain">${r.cut
        .map((c) => `<li>${code(c.collection)}: ${c.shown} of ${c.total} rows shown.</li>`)
        .join("")}</ul>`,
    );
  const reportName = "report.html";
  const cmd = (extra: string): string =>
    `hexvero compare &lt;a&gt; &lt;b&gt; --report ${reportName}${extra}`;
  if (r.page.next !== null)
    out.push(
      `<p>The other rows: <code>${cmd(` --offset ${r.page.next} --limit ${r.page.limit}`)}</code> (next page), or <code>hexvero compare &lt;a&gt; &lt;b&gt; &lt;collection&gt; --json</code> for one collection's comparison.</p>`,
    );
  else if (r.page.offset > 0) out.push(`<p>Earlier rows: <code>${cmd(" --offset 0")}</code>.</p>`);
  if (budget.missing || budget.capped)
    out.push(
      `<p class="note">${budget.missing} place(s) with a line have no source excerpt here${
        budget.capped
          ? ` (this report embeds at most ${MAX_HTML_EXCERPTS} excerpts and ${nf(MAX_HTML_EXCERPT_CHARS)} characters of source)`
          : " (the file could not be shown as source, or the excerpt limit was reached)"
      }. <code>hexvero ui</code> opens every place.</p>`,
    );
  out.push(`</section>`);

  out.push(`<section id="not-established"><h2>Not established</h2>`);
  const gaps = Object.entries(r.completeness).filter(([, c]) => !c.complete);
  if (gaps.length) {
    out.push(
      `<div class="wrap-table"><table><thead><tr><th>collection</th><th>gaps</th><th class="n">compared in a</th><th class="n">compared in b</th></tr></thead><tbody>`,
    );
    for (const [collection, c] of gaps)
      out.push(
        `<tr><td>${code(collection)}</td><td>${c.gaps.map((g) => code(g)).join(" ")}</td><td class="n">${c.compared.a} of ${c.total.a}</td><td class="n">${c.compared.b} of ${c.total.b}</td></tr>`,
      );
    out.push(`</tbody></table></div>`);
  }
  out.push(
    `<ul class="plain">${notEstablished(r)
      .map(
        (note) =>
          `<li>${note
            .map((part) =>
              typeof part === "string"
                ? escapeHtml(part).replace(/`([^`]+)`/g, "<code>$1</code>")
                : "code" in part
                  ? code(part.code, 300)
                  : text(part.data),
            )
            .join("")}</li>`,
      )
      .join("")}</ul></section>`,
  );

  const page =
    r.page.offset > 0 || r.page.limit !== DEFAULT_RELEASE_ROWS
      ? ` --offset ${r.page.offset} --limit ${r.page.limit}`
      : "";
  out.push(
    `<section id="reproduce"><h2>Reproduce</h2><pre class="cmd"><code>${escapeHtml(
      `npx hexvero@${r.hexvero} compare ${shellWord(names.a)} ${shellWord(names.b)} --report ${reportName}${page}`,
    )}</code></pre></section>`,
    `<footer>hexvero ${escapeHtml(r.hexvero)} · static analysis, nothing was run · this file loads nothing from the network</footer>`,
  );

  const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src ${scriptHash(SCRIPT)}; img-src data:; base-uri 'none'; form-action 'none'`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<meta name="referrer" content="no-referrer">
<meta name="generator" content="hexvero ${escapeHtml(r.hexvero)}">
<title>What changed: ${escapeHtml(names.a)} → ${escapeHtml(names.b)} · hexvero</title>
<style>${STYLE}</style>
</head>
<body>
<main>
${out.join("\n")}
</main>
<script>${SCRIPT}</script>
</body>
</html>
`;
}

/** The inline script's text, for tests that check the CSP hash against it. */
export const REPORT_SCRIPT = SCRIPT;
