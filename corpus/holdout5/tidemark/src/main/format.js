"use strict";
// Pure functions that turn a release draft into the text of an export.

const SECTION_ORDER = ["Added", "Changed", "Fixed", "Removed", "Security"];

const escapeHtml = (text) =>
  String(text).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );

function grouped(release) {
  const bySection = new Map(SECTION_ORDER.map((section) => [section, []]));
  for (const entry of release.entries) {
    if (!bySection.has(entry.section)) bySection.set(entry.section, []);
    bySection.get(entry.section).push(entry.text);
  }
  return [...bySection].filter(([, texts]) => texts.length > 0);
}

function heading(release) {
  const date = (release.savedAt ?? new Date().toISOString()).slice(0, 10);
  return `${release.version || "Unreleased"}${release.title ? ` — ${release.title}` : ""} (${date})`;
}

function toMarkdown(release) {
  const parts = [`## ${heading(release)}`];
  for (const [section, texts] of grouped(release)) {
    parts.push("", `### ${section}`, "", ...texts.map((text) => `- ${text}`));
  }
  return `${parts.join("\n")}\n`;
}

function toHtml(release) {
  const sections = grouped(release).map(
    ([section, texts]) =>
      `<h3>${escapeHtml(section)}</h3><ul>${texts.map((t) => `<li>${escapeHtml(t)}</li>`).join("")}</ul>`,
  );
  return `<article><h2>${escapeHtml(heading(release))}</h2>${sections.join("")}</article>`;
}

const toJson = (release) => JSON.stringify(release, null, 2);

const FORMATTERS = { markdown: toMarkdown, html: toHtml, json: toJson };

module.exports = { FORMATTERS, toHtml };
