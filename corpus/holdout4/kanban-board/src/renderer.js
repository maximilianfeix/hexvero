// The board page. window.lattice and window.cards come from preload.js.
const { lattice, cards } = window;

const FILTER_KEY = "lattice.filter";
const SCROLL_KEY = "lattice.scrollTop";
const OFFLINE_DB = "lattice-offline";
const OFFLINE_DB_VERSION = 3;
const SNAPSHOT_STORE = "snapshots";

// Keyboard commands of this page; the values are command ids, handled in runCommand below.
const KEYMAP = {
  "/": "board:focus-search",
  n: "card:new-inline",
  Escape: "board:clear-selection",
};

const $ = (selector) => document.querySelector(selector);

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

// ---------------------------------------------------------------------------------------------
// A small axios-style client for the template gallery and feedback.

function createClient({ baseURL, headers = {} }) {
  async function request(method, url, body) {
    const res = await fetch(baseURL + url, {
      method,
      headers: body ? { ...headers, "content-type": "application/json" } : headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`${method} ${url} answered ${res.status}`);
    return res.status === 204 ? null : res.json();
  }
  return {
    get: (url) => request("GET", url),
    post: (url, body) => request("POST", url, body),
  };
}

const client = createClient({
  baseURL: "https://api.lattice.example/v1",
  headers: { accept: "application/json", "x-lattice-client": "desktop" },
});

// ---------------------------------------------------------------------------------------------
// Offline copy of the board, so that the page has something to show before main answers.

function openOfflineDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(OFFLINE_DB, OFFLINE_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(SNAPSHOT_STORE)) db.createObjectStore(SNAPSHOT_STORE, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveSnapshot(snapshot) {
  const db = await openOfflineDb();
  db.transaction(SNAPSHOT_STORE, "readwrite").objectStore(SNAPSHOT_STORE).put(snapshot);
}

async function loadSnapshot() {
  const db = await openOfflineDb();
  return new Promise((resolve) => {
    const req = db.transaction(SNAPSHOT_STORE).objectStore(SNAPSHOT_STORE).getAll();
    req.onsuccess = () => resolve(req.result[0] ?? null);
    req.onerror = () => resolve(null);
  });
}

// ---------------------------------------------------------------------------------------------
// Rendering.

const ARCHIVE_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="14" height="14"><path d="M2 3h12v3H2zM3 7h10v6H3z"/></svg>`;

let current = null;

function renderCard(item) {
  const node = el("li", { className: "card", draggable: true, textContent: item.title });
  node.dataset.id = item.id;
  node.addEventListener("dragstart", (e) => e.dataTransfer.setData("text/plain", item.id));
  node.addEventListener("dblclick", async () => {
    const title = prompt("Rename card", item.title);
    if (title) await cards.rename(item.id, title);
  });
  for (const link of item.links) node.append(el("a", { href: link.url, textContent: link.title }));
  return node;
}

function renderLane(l) {
  const list = el("ul", { className: "cards" }, ...l.cards.map(renderCard));
  list.addEventListener("dragover", (e) => e.preventDefault());
  list.addEventListener("drop", async (e) => {
    e.preventDefault();
    const cardId = e.dataTransfer.getData("text/plain");
    const index = [...list.children].findIndex((child) => child.getBoundingClientRect().top > e.clientY);
    await lattice.moveCard(cardId, l.id, index === -1 ? list.children.length : index);
  });
  const toggle = el("button", { className: "collapse", textContent: l.collapsed ? "▸" : "▾" });
  toggle.addEventListener("click", () => (l.collapsed ? lattice.expandLane(l.id) : lattice.collapseLane(l.id)));
  const add = el("button", { className: "add", textContent: "+ Add card" });
  add.addEventListener("click", async () => {
    const title = prompt("Card title");
    if (title) await cards.create(l.id, title);
  });
  return el("section", { className: l.collapsed ? "lane collapsed" : "lane" }, toggle, el("h2", { textContent: l.title }), list, add);
}

function render(snapshot) {
  current = snapshot;
  const filter = sessionStorage.getItem(FILTER_KEY) ?? "";
  const visible = {
    ...snapshot,
    lanes: snapshot.lanes.map((l) => ({ ...l, cards: l.cards.filter((c) => c.title.toLowerCase().includes(filter)) })),
  };
  $("#title").textContent = snapshot.title;
  $("#lanes").replaceChildren(...visible.lanes.map(renderLane));
  const archive = el("button", { className: "archive", title: "Archive board" });
  archive.innerHTML = ARCHIVE_ICON;
  archive.addEventListener("click", () => lattice.archiveBoard(snapshot.id));
  $("#tools").replaceChildren(archive);
  saveSnapshot(snapshot).catch(() => {});
}

// ---------------------------------------------------------------------------------------------
// Other tabs of the same board in the browser version share this channel; the desktop app only
// listens so that a board opened in both stays in step.
const tabs = new BroadcastChannel("lattice-tabs");
tabs.onmessage = (e) => {
  if (e.data?.type === "refresh") lattice.listBoards().then(({ boards }) => render(boards[0]));
};

function runCommand(command) {
  if (command === "board:focus-search") $("#filter").focus();
  else if (command === "card:new-inline") $(".lane .add")?.click();
  else if (command === "board:clear-selection") document.activeElement?.blur();
}

async function loadTemplates() {
  try {
    const { templates } = await client.get("/templates");
    $("#templates").replaceChildren(...templates.map((t) => el("li", { textContent: t.name })));
  } catch {
    $("#templates").replaceChildren(el("li", { textContent: "Templates are offline" }));
  }
}

async function sendFeedback(text) {
  await client.post("/feedback", { text, version: lattice.version });
}

async function start() {
  const offline = await loadSnapshot().catch(() => null);
  if (offline) render(offline);

  const { boards, members } = await lattice.listBoards();
  render(boards[0]);
  $("#members").textContent = members.map((m) => m.name).join(", ");
  lattice.onBoardChanged(render);

  const prefs = await lattice.loadPrefs();
  document.body.dataset.theme = prefs.theme;
  $("#theme").value = prefs.theme;
  $("#theme").addEventListener("change", (e) => lattice.savePrefs({ theme: e.target.value }));

  lattice.onZoom((level) => {
    $("#zoom").textContent = `${Math.round(level * 100)}%`;
    lattice.setZoom(level);
  });

  $("#filter").value = sessionStorage.getItem(FILTER_KEY) ?? "";
  $("#filter").addEventListener("input", (e) => {
    sessionStorage.setItem(FILTER_KEY, e.target.value.toLowerCase());
    if (current) render(current);
  });

  const lanes = $("#lanes");
  lanes.scrollLeft = Number(sessionStorage.getItem(SCROLL_KEY) ?? 0);
  lanes.addEventListener("scroll", () => sessionStorage.setItem(SCROLL_KEY, String(lanes.scrollLeft)));

  $("#link-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const url = $("#link").value.trim();
    if (!url) return;
    const preview = await cards.linkPreview(url);
    $("#link-result").textContent = preview.title;
  });

  $("#sign-in").addEventListener("click", async () => {
    const token = $("#token").value.trim();
    if (token) await lattice.signIn(token);
  });
  $("#sign-out").addEventListener("click", () => lattice.signOut());
  $("#import").addEventListener("click", () => lattice.openImporter());
  $("#feedback-form").addEventListener("submit", (e) => {
    e.preventDefault();
    sendFeedback($("#feedback").value);
  });

  document.addEventListener("keydown", (e) => {
    if (e.target instanceof HTMLInputElement) return;
    const command = KEYMAP[e.key];
    if (command) runCommand(command);
  });

  loadTemplates();
}

start();
