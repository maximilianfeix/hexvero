// Editor page of Tidemark. It reaches the main process only through window.tidemark (preload.js).
import { createDraft, addEntry, removeEntry, groupBySection, SECTIONS } from "./renderer/state.js";
import { local, session } from "./renderer/web-store.js";
import { loadContributors } from "./renderer/contributors.js";

const api = window.tidemark;
const $ = (selector) => document.querySelector(selector);

// Listed in the About panel. It describes how the editor is hardened; it configures nothing.
const HARDENING = { contextIsolation: true, nodeIntegration: false, sandbox: true };

const LAST_PROJECT = "lastProject";
const FONT_SIZE = "fontSize";
const CURSOR = "cursor";
const DEFAULT_FONT_SIZE = 15;

let current = createDraft();
let dirty = false;
let previewOpen = false;

function setDirty(value) {
  if (dirty === value) return;
  dirty = value;
  api.markDirty(value);
}

function changed() {
  setDirty(true);
  if (previewOpen) api.updatePreview(current);
  // The word count and the outline listen for this DOM event.
  window.dispatchEvent(new CustomEvent("release:changed", { detail: { id: current.id } }));
}

function renderEntries() {
  const groups = groupBySection(current.entries);
  const root = $("#entries");
  root.replaceChildren();
  for (const section of SECTIONS) {
    const items = groups[section] ?? [];
    if (items.length === 0) continue;
    const heading = document.createElement("h3");
    heading.textContent = section;
    root.append(heading);
    for (const entry of items) {
      const row = document.createElement("div");
      row.className = "entry";
      row.draggable = true;
      row.textContent = entry.text;
      row.addEventListener("dragstart", (event) => {
        event.dataTransfer.setData("text/markdown", `- ${entry.text}`);
      });
      const drop = document.createElement("button");
      drop.textContent = "×";
      drop.addEventListener("click", () => {
        current = removeEntry(current, entry.id);
        renderEntries();
        changed();
      });
      row.append(drop);
      root.append(row);
    }
  }
}

function render() {
  $("#version").value = current.version ?? "";
  $("#title").value = current.title ?? "";
  renderEntries();
}

async function refreshList() {
  const releases = await api.listReleases();
  $("#releases").replaceChildren(
    ...releases.map((release) => {
      const item = document.createElement("li");
      item.dataset.id = release.id;
      item.textContent = `${release.version || "unversioned"} — ${release.title || "Untitled"}`;
      return item;
    }),
  );
}

async function open(id) {
  current = (await api.loadRelease(id)) ?? createDraft();
  setDirty(false);
  render();
  session.set(CURSOR, 0);
}

async function save() {
  current = await api.saveRelease(current);
  setDirty(false);
  await refreshList();
}

async function removeDraft() {
  if (!confirm(`Delete the draft ${current.version || "without a version"}?`)) return;
  await api.deleteRelease(current.id);
  current = createDraft();
  render();
  await refreshList();
}

async function exportAs(format) {
  const html = format === "html";
  const text = html ? await api.exportHtml(current.id) : await api.exportMarkdown(current.id);
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([text], { type: html ? "text/html" : "text/markdown" }));
  link.download = `${current.version || "release"}.${html ? "html" : "md"}`;
  link.click();
  URL.revokeObjectURL(link.href);
}

// Links in entries are checked before publishing; the addresses are whatever the author wrote.
async function checkLinks() {
  const hrefs = current.entries.flatMap((entry) => entry.text.match(/https?:\/\/\S+/g) ?? []);
  const broken = [];
  for (const href of hrefs) {
    try {
      await fetch(href, { method: "HEAD", mode: "no-cors" });
    } catch {
      broken.push(href);
    }
  }
  return broken;
}

async function publish() {
  await save();
  const broken = await checkLinks();
  if (broken.length > 0 && !confirm(`${broken.length} link(s) did not answer. Publish anyway?`)) {
    return;
  }
  const stop = api.onPublishProgress(({ stage, percent }) => {
    $("#progress").value = percent;
    $("#status").textContent = stage;
  });
  try {
    await api.publish(current.id);
  } finally {
    stop();
  }
}

function applyFontSize(size) {
  document.documentElement.style.setProperty("--editor-font", `${size}px`);
}

async function showAbout() {
  const info = await api.appInfo();
  $("#about-version").textContent = info.update
    ? `${info.version} (version ${info.update} is available)`
    : info.version;
  $("#about-hardening").replaceChildren(
    ...Object.entries(HARDENING).map(([name, on]) => {
      const item = document.createElement("li");
      item.textContent = `${name}: ${on ? "on" : "off"}`;
      return item;
    }),
  );
  $("#api-hint").textContent = "Releases are published to https://api.tidemark.example/v2";
  $("#about").showModal();
}

async function start() {
  const settings = await api.getSettings();
  applyFontSize(Number(local.get(FONT_SIZE)) || DEFAULT_FONT_SIZE);
  $("#project").value = local.get(LAST_PROJECT) ?? settings.project ?? "";
  if (settings.repo) {
    loadContributors(settings.repo)
      .then((names) => {
        $("#contributors").textContent = names.join(", ");
      })
      .catch(() => {});
  }
  await refreshList();
  const cursor = Number(session.get(CURSOR) ?? 0);
  $("#entry-text").setSelectionRange(cursor, cursor);

  $("#releases").addEventListener("click", (event) => {
    const id = event.target.closest("li")?.dataset.id;
    if (id) open(id);
  });
  $("#project").addEventListener("change", async (event) => {
    local.set(LAST_PROJECT, event.target.value);
    await api.setSettings({ project: event.target.value });
    await refreshList();
  });
  $("#version").addEventListener("input", (event) => {
    current = { ...current, version: event.target.value };
    changed();
  });
  $("#title").addEventListener("input", (event) => {
    current = { ...current, title: event.target.value };
    changed();
  });
  $("#add-entry").addEventListener("submit", (event) => {
    event.preventDefault();
    const text = $("#entry-text").value.trim();
    if (!text) return;
    current = addEntry(current, $("#entry-section").value, text);
    $("#entry-text").value = "";
    renderEntries();
    changed();
  });
  $("#entry-text").addEventListener("keyup", (event) => {
    session.set(CURSOR, event.target.selectionStart);
  });
  $("#font-size").addEventListener("change", (event) => {
    local.set(FONT_SIZE, event.target.value);
    applyFontSize(event.target.value);
  });
  $("#font-reset").addEventListener("click", () => {
    local.remove(FONT_SIZE);
    applyFontSize(DEFAULT_FONT_SIZE);
  });
  $("#save").addEventListener("click", save);
  $("#delete").addEventListener("click", removeDraft);
  $("#export-md").addEventListener("click", () => exportAs("markdown"));
  $("#export-html").addEventListener("click", () => exportAs("html"));
  $("#publish").addEventListener("click", publish);
  $("#preview").addEventListener("click", () => {
    previewOpen = true;
    api.openPreview();
    api.updatePreview(current);
  });
  $("#about-open").addEventListener("click", showAbout);
  window.addEventListener("error", (event) => {
    api.sendDiagnostics({ message: event.message, platform: api.platform, at: Date.now() });
  });
  render();
}

start();
