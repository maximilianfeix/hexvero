#!/usr/bin/env node
/**
 * Writes the website's example comparison (site/demo/index.html, report.md and report.html) from
 * a real run of hexvero over the two example builds in examples/. Nothing on the page is typed by
 * hand: every row, place and source line comes from compareReleases() and Session.source(); the
 * two reports are what `hexvero compare --report report.md|report.html` writes for the same pair.
 * Run after `npm run build`; `--check` fails when the committed page is out of date.
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectReleaseSources,
  compareReleases,
  renderReleaseReport,
  renderReleaseReportHtml,
  Session,
} from "../packages/core/dist/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "site", "demo");
const check = process.argv.includes("--check");

const session = new Session();
const a = await session.open(join(root, "examples", "notesdesk-1.4.0.asar"));
const b = await session.open(join(root, "examples", "notesdesk-1.5.0.asar"));
const r = await compareReleases(session, a.id, b.id);
const report = renderReleaseReport(r);
const reportHtml = renderReleaseReportHtml(r, await collectReleaseSources(session, r));

const esc = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
const name = (t) => t.info.path.split(/[\\/]/).pop();

/** Source lines around each place that has a line, keyed for the page's <details>. */
const excerpts = new Map();
for (const row of r.changes)
  for (const p of row.where) {
    if (p.line === undefined) continue;
    const id = `${p.side}:${p.file}:${p.line}`;
    if (excerpts.has(id)) continue;
    const w = await session.source(p.side === "a" ? a.id : b.id, p.file, p.line, 3);
    excerpts.set(id, w);
  }

const SIGN = { added: "+", removed: "−", changed: "~", unknown: "?" };
const place = (p) => {
  const label = `${p.file}${p.line === undefined ? "" : `:${p.line}`}`;
  const w = excerpts.get(`${p.side}:${p.file}:${p.line}`);
  const role = p.role ? `<span class="role">${esc(p.role)}</span> ` : "";
  if (!w) return `<span class="place">${role}<code>${esc(label)}</code></span>`;
  const lines = w.lines
    .map(
      (text, i) =>
        `<span class="ln${w.start + i === p.line ? " hit" : ""}"><i>${w.start + i}</i>${esc(text) || " "}</span>`,
    )
    .join("");
  return `<details class="place">${""}<summary>${role}<code>${esc(label)}</code></summary><pre class="src">${lines}</pre></details>`;
};

const groups = new Map();
for (const row of r.changes)
  groups.set(row.collection, [...(groups.get(row.collection) ?? []), row]);
const rows = [...groups]
  .map(
    ([collection, list]) => `
      <h3><code>${esc(collection)}</code></h3>
      <ul class="changes">${list
        .map(
          (row) => `
        <li class="change ${row.change}">
          <span class="sign" aria-hidden="true">${SIGN[row.change]}</span>
          <div>
            <div><span class="word">${row.change}</span> <code class="key">${esc(row.key)}</code>${
              row.basis ? ` <span class="tag">${esc(row.basis)}</span>` : ""
            }</div>${
              row.fields?.length
                ? `<ul class="fields">${row.fields
                    .map(
                      (f) =>
                        `<li><code>${esc(f.field)}</code> <code>${esc(JSON.stringify(f.before))}</code> → <code>${esc(JSON.stringify(f.after))}</code></li>`,
                    )
                    .join("")}</ul>`
                : ""
            }
            <div class="places"><span class="side">in ${row.where[0]?.side === "a" ? "1.4.0" : "1.5.0"}</span> ${row.where
              .slice(0, 4)
              .map(place)
              .join(" ")}</div>
          </div>
        </li>`,
        )
        .join("")}
      </ul>`,
  )
  .join("");

const windows = r.overview.windowChanges
  .map(
    (w) =>
      `<li><code>${esc(w.window)}</code> <code>${esc(w.setting)}</code> ${esc(w.before)} → ${esc(w.after)} <span class="tag">${esc(w.direction)}</span></li>`,
  )
  .join("");
const limits = [
  ...r.limitations.a.map((l) => ["1.4.0", l]),
  ...r.limitations.b.map((l) => ["1.5.0", l]),
]
  .map(([side, l]) => `<li>${side}: ${esc(l.message)} <code>${esc(l.code)}</code></li>`)
  .join("");

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="dark light" />
    <title>Example comparison · hexvero</title>
    <meta name="description" content="A real hexvero comparison of two builds of an example Electron app: what changed, the file and line of each change, and what could not be established. Static page; it does not analyze files." />
    <link rel="icon" href="../logo.svg" type="image/svg+xml" />
    <link rel="canonical" href="https://maximilianfeix.github.io/hexvero/demo/" />
    <meta property="og:image" content="https://maximilianfeix.github.io/hexvero/social-preview.png" />
    <link rel="stylesheet" href="../site.css" />
  </head>
  <body>
    <div class="wrap">
      <header>
        <a class="mark" href="../"><img src="../logo-mark.svg" width="26" height="26" alt="" />hexvero</a>
        <nav><a href="../">Home</a><a href="report.html">report.html</a><a href="report.md">report.md</a><a href="https://github.com/maximilianfeix/hexvero">GitHub</a></nav>
      </header>
      <p class="banner" role="note"><strong>Example output.</strong> This page was generated by hexvero ${esc(r.hexvero)} from the two example builds in <a href="https://github.com/maximilianfeix/hexvero/tree/main/examples"><code>examples/</code></a>. It is static: it cannot open or analyze your files. To run the same thing on your machine: <code>npx hexvero demo</code>.</p>
      <h1 class="page">What changed: ${esc(name(r.a))} → ${esc(name(r.b))}</h1>
      <p class="sub">Two builds of NotesDesk, a small Electron app written for these examples. Both were read statically; neither was run. Open a place to see the lines it was read from.</p>
      <section>
        <h2>Window settings to review</h2>
        <ul class="plain">${windows}</ul>
        <p class="note">Whether a change matters depends on what the window loads. This is a fact to review, not a verdict.</p>
      </section>
      <section>
        <h2>Changes</h2>
        ${rows}
      </section>
      <section>
        <h2>Not established</h2>
        <ul class="plain">${limits}
          <li>Absence from a list means hexvero did not find it in the files it read, not that the app cannot do it. Nothing here was observed running.</li>
        </ul>
      </section>
      <section>
        <h2>Reproduce</h2>
        <pre class="cmd"><code>npx hexvero demo
npx hexvero compare hexvero-demo/notesdesk-1.4.0.asar hexvero-demo/notesdesk-1.5.0.asar --report report.md
npx hexvero ui --demo --open</code></pre>
        <p class="note">The reports of this comparison: <a href="report.html">report.html</a> (one offline page with the source lines of both builds) and <a href="report.md">report.md</a>.</p>
      </section>
      <footer><a href="../">hexvero</a> · <a href="https://github.com/maximilianfeix/hexvero">GitHub</a> · MIT</footer>
    </div>
  </body>
</html>
`;

const files = { "index.html": html, "report.md": report, "report.html": reportHtml };
if (check) {
  const stale = Object.entries(files).filter(([f, text]) => {
    try {
      return readFileSync(join(out, f), "utf8") !== text;
    } catch {
      return true;
    }
  });
  if (stale.length) {
    console.error(
      `site/demo is out of date (${stale.map(([f]) => f).join(", ")}); run node scripts/build-site-demo.mjs`,
    );
    process.exit(1);
  }
  console.log("site/demo is up to date");
} else {
  mkdirSync(out, { recursive: true });
  for (const [f, text] of Object.entries(files)) writeFileSync(join(out, f), text);
  console.log(`wrote site/demo (${r.changes.length} changes, ${excerpts.size} source excerpts)`);
}
