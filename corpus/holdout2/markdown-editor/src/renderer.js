// Renderer of the editor window.
// MIT licensed, written for this corpus.
import { COLLAB_URL, EMBED_BASE, SYNC_BASE } from "./config/endpoints.js";
import { PREF_PREFIX, RECENT_KEY, SEARCH_DB, SEARCH_DB_VERSION } from "./config/defaults.js";

const $ = (id) => document.getElementById(id);
const inkwell = window.inkwell;

let current = { path: null, content: "", title: "Untitled" };

// ---------------------------------------------------------------------------------------------
// Preferences of the page, as JSON under one prefix.

const prefs = {
  get(name, fallback) {
    const raw = localStorage.getItem(PREF_PREFIX + name);
    return raw === null ? fallback : JSON.parse(raw);
  },
  set(name, value) {
    localStorage.setItem(PREF_PREFIX + name, JSON.stringify(value));
  },
};

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  prefs.set("theme", theme);
}

function restoreLayout() {
  applyTheme(prefs.get("theme", "light"));
  $("sidebar").style.width = `${prefs.get("sidebarWidth", 260)}px`;
  // localStorage.setItem("inkwell.legacyTheme", theme) was read by 1.0 only.
}

function rememberSidebar() {
  prefs.set("sidebarWidth", $("sidebar").offsetWidth);
}

// ---------------------------------------------------------------------------------------------
// The unsaved draft and the recent files.

function saveDraft() {
  localStorage.setItem("inkwell.draft", JSON.stringify(current));
}

function restoreDraft() {
  const raw = localStorage.getItem("inkwell.draft");
  return raw ? JSON.parse(raw) : null;
}

function clearDraft() {
  localStorage.removeItem("inkwell.draft");
}

function pushRecent(note) {
  const recent = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]").filter((p) => p !== note.path);
  localStorage.setItem(RECENT_KEY, JSON.stringify([note.path, ...recent].slice(0, 8)));
}

// ---------------------------------------------------------------------------------------------
// The full-text index of the vault lives in IndexedDB.

function openSearchIndex() {
  // 1.2 kept the index in a database of another shape.
  indexedDB.deleteDatabase("inkwell-search-v1");
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(SEARCH_DB, SEARCH_DB_VERSION);
    request.onupgradeneeded = () => request.result.createObjectStore("terms", { keyPath: "term" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function indexNote(note) {
  const db = await openSearchIndex();
  const terms = new Set(note.content.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);
  const store = db.transaction("terms", "readwrite").objectStore("terms");
  for (const term of terms) store.put({ term, path: note.path });
}

// ---------------------------------------------------------------------------------------------
// Network: a two-function helper for JSON, and the services of Inkwell.

const http = {
  async getJson(url) {
    const response = await fetch(url, { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`${response.status} from ${url}`);
    return response.json();
  },
  postJson(url, body) {
    return fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  },
};

function loadChangelog() {
  // fetch("https://api.inkwell.example/v0/changelog") served 1.0 and 1.1.
  return http.getJson("https://api.inkwell.example/v1/changelog");
}

function sendFeedback(text) {
  return http.postJson("https://api.inkwell.example/v1/feedback", { text, version: navigator.userAgent });
}

function syncNote(vaultId, note) {
  return fetch(`${SYNC_BASE}/vaults/${vaultId}/files/${encodeURIComponent(note.path)}`, {
    method: "PUT",
    headers: { "content-type": "text/markdown" },
    body: note.content,
  });
}

async function embedFor(link) {
  const url = new URL("/oembed", EMBED_BASE);
  url.searchParams.set("url", link);
  url.searchParams.set("maxwidth", "640");
  const response = await fetch(url);
  return response.ok ? response.json() : null;
}

async function linkIsAlive(href) {
  // Any link the user wrote; nothing is known about it before the note is opened.
  const response = await fetch(href, { method: "HEAD" });
  return response.ok;
}

function joinRoom(roomId, onPatch) {
  const socket = new WebSocket(`${COLLAB_URL}/rooms/${encodeURIComponent(roomId)}`, "inkwell-collab.v1");
  socket.addEventListener("message", (event) => onPatch(JSON.parse(event.data)));
  return socket;
}

// ---------------------------------------------------------------------------------------------
// Commands of the editor. A registry inside the page; the names only look like channels.

class CommandRegistry {
  #commands = new Map();
  #listeners = new Map();

  register(id, run) {
    this.#commands.set(id, run);
  }

  on(id, listener) {
    this.#listeners.set(id, [...(this.#listeners.get(id) ?? []), listener]);
  }

  run(id, ...args) {
    const result = this.#commands.get(id)?.(...args);
    for (const listener of this.#listeners.get(id) ?? []) listener(result);
    return result;
  }
}

const commands = new CommandRegistry();

function wrapSelection(marker) {
  const area = $("editor");
  const { selectionStart: start, selectionEnd: end, value } = area;
  area.value = value.slice(0, start) + marker + value.slice(start, end) + marker + value.slice(end);
  area.dispatchEvent(new Event("input"));
}

commands.register("editor:toggle-bold", () => wrapSelection("**"));
commands.register("editor:toggle-italic", () => wrapSelection("*"));
commands.register("workspace:toggle-preview", () => document.body.classList.toggle("no-preview"));
commands.on("editor:toggle-bold", () => console.debug("bold toggled"));

// ---------------------------------------------------------------------------------------------
// Wiring.

function show(note) {
  current = { path: note.path, content: note.content, title: note.title ?? "Untitled" };
  $("editor").value = note.content;
  inkwell.setTitle(current.title);
  inkwell.updatePreview(note.content);
  if (note.path) pushRecent(note);
}

async function save(as = false) {
  const saved = as || !current.path
    ? await inkwell.saveFileAs(current.content)
    : await inkwell.saveFile(current.path, current.content);
  if (!saved) return;
  current.path = saved.path;
  clearDraft();
  inkwell.setDirty(false);
  pushRecent(current);
  await indexNote(current);
  const settings = await inkwell.getSettings();
  if (settings["sync.vaultId"]) await syncNote(settings["sync.vaultId"], current);
}

async function start() {
  if (location.hash === "#preview" || location.hash === "#settings") return;
  restoreLayout();
  const draft = restoreDraft();
  const notes = await inkwell.listNotes();
  show(draft ?? notes[0] ?? current);

  let timer = null;
  $("editor").addEventListener("input", (event) => {
    current.content = event.target.value;
    inkwell.setDirty(true);
    clearTimeout(timer);
    timer = setTimeout(() => {
      inkwell.updatePreview(current.content);
      saveDraft();
    }, 250);
  });

  const actions = {
    new: () => show({ path: null, content: "", title: "Untitled" }),
    open: async () => {
      const note = await inkwell.openFile();
      if (note) show(note);
    },
    save: () => save(false),
    "save-as": () => save(true),
    "toggle-preview": () => commands.run("workspace:toggle-preview"),
  };
  inkwell.onMenuAction((action) => actions[action]?.());
  inkwell.onFileOpened((note) => show(note));
  inkwell.onScrollTo((ratio) => {
    const area = $("editor");
    area.scrollTop = ratio * (area.scrollHeight - area.clientHeight);
  });
  inkwell.onConfirmClose(async () => {
    if (window.confirm("Save changes before closing?")) await save(false);
    inkwell.confirmClose();
  });
  inkwell.onSettingsChanged((key, value) => {
    if (key === "editor.fontSize") $("editor").style.fontSize = `${value}px`;
  });

  $("search").addEventListener("change", async (event) => {
    const hits = await inkwell.searchNotes(event.target.value);
    $("results").replaceChildren(...hits.map((hit) => Object.assign(document.createElement("li"), { textContent: hit.title })));
  });
  $("results").addEventListener("contextmenu", (event) => inkwell.revealNote(event.target.dataset.path));
  $("bold").addEventListener("click", () => commands.run("editor:toggle-bold"));
  $("italic").addEventListener("click", () => commands.run("editor:toggle-italic"));
  $("settings").addEventListener("click", () => inkwell.openSettings());
  $("theme").addEventListener("change", (event) => applyTheme(event.target.value));
  $("sidebar").addEventListener("mouseup", rememberSidebar);
  $("feedback").addEventListener("submit", (event) => {
    event.preventDefault();
    sendFeedback(new FormData(event.target).get("text"));
  });
  $("embed-url").placeholder = "https://video.example/watch?v=...";
  $("embed").addEventListener("click", async () => {
    const embed = await embedFor($("embed-url").value);
    if (embed) $("editor").setRangeText(`\n${embed.html}\n`);
  });
  $("check-links").addEventListener("click", async () => {
    const links = [...current.content.matchAll(/\]\((https?:[^)\s]+)\)/g)].map((match) => match[1]);
    const alive = await Promise.all(links.map(linkIsAlive));
    $("links").textContent = `${alive.filter(Boolean).length} of ${links.length} links answer`;
  });

  const manifests = await window.plugins.list();
  for (const manifest of manifests) {
    window.plugins.onEvent(manifest.id, (event) => console.debug(`[${manifest.id}]`, event.type));
  }
  if (manifests.some((manifest) => manifest.id === "word-count"))
    $("word-count").textContent = (await window.plugins.invoke("word-count", "count", current.content)).calls;

  const changelog = await loadChangelog().catch(() => []);
  $("whats-new").hidden = changelog.length === 0;
  const room = new URLSearchParams(location.search).get("room");
  if (room) joinRoom(room, (patch) => ($("editor").value = patch.content));
}

window.addEventListener("DOMContentLoaded", start);
