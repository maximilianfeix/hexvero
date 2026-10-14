// A deliberately small markdown renderer for the preview: headings, emphasis, code, links,
// lists and paragraphs. Plug-ins can replace it.
// MIT licensed, written for this corpus.
"use strict";

const escapeHtml = (text) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function inline(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
}

function renderMarkdown(source) {
  const html = [];
  let list = false;
  let code = null;
  for (const line of source.split("\n")) {
    if (line.startsWith("```")) {
      if (code === null) code = [];
      else {
        html.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
        code = null;
      }
      continue;
    }
    if (code !== null) {
      code.push(line);
      continue;
    }
    const item = /^\s*[-*] (.*)$/.exec(line);
    if (item) {
      if (!list) html.push("<ul>");
      list = true;
      html.push(`<li>${inline(item[1])}</li>`);
      continue;
    }
    if (list) {
      html.push("</ul>");
      list = false;
    }
    const heading = /^(#{1,6}) (.*)$/.exec(line);
    if (heading) html.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`);
    else if (line.trim()) html.push(`<p>${inline(line)}</p>`);
  }
  if (list) html.push("</ul>");
  return html.join("\n");
}

/** The first heading of a note, or its file name. */
function titleOf(source, fallback) {
  const heading = /^# (.*)$/m.exec(source);
  return heading ? heading[1].trim() : fallback;
}

module.exports = { renderMarkdown, titleOf };
