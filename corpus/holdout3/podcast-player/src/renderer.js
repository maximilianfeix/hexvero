// Library window of Driftwood. The same page shows the guide when it is opened as
// index.html#help; the help window has no preload, so window.driftwood is missing there.

const API = "https://api.driftwood.example/v1";
const VIEW_KEY = "driftwood:view";
const LAST_SEARCH_KEY = "driftwood.lastSearch";
const DB_NAME = "driftwood-episodes";
const DB_VERSION = 3;

const bridge = window.driftwood;
const $ = (selector) => document.querySelector(selector);
const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
};

let shows = [];
let selectedShow = null;

// ---------------------------------------------------------------------------------------------
// Guide

function showGuide() {
  document.title = "Driftwood Guide";
  document.body.innerHTML = `
    <article class="guide">
      <h1>Driftwood Guide</h1>
      <p>Paste a feed address into the search box, or pick a show from the directory.</p>
      <p>Space plays or pauses; Cmd/Ctrl+R refreshes every feed.</p>
      <p>Trouble? The <a href="https://status.driftwood.example">service status page</a> knows.</p>
    </article>`;
}

// ---------------------------------------------------------------------------------------------
// Views and remembered state

function setView(view) {
  document.body.dataset.view = view;
  localStorage.setItem(VIEW_KEY, view);
  for (const tab of document.querySelectorAll("[data-tab]")) {
    tab.classList.toggle("active", tab.dataset.tab === view);
  }
}

function restoreView() {
  setView(localStorage.getItem(VIEW_KEY) ?? "shows");
}

function restoreSearch() {
  const last = localStorage.getItem(LAST_SEARCH_KEY);
  if (last) $("#search").value = last;
}

// ---------------------------------------------------------------------------------------------
// Requests

async function searchDirectory(term) {
  localStorage.setItem(LAST_SEARCH_KEY, term);
  const params = new URLSearchParams({ q: term, media: "podcast" });
  const res = await fetch(`${API}/search?${params}`);
  if (!res.ok) throw new Error(`search answered ${res.status}`);
  return (await res.json()).results;
}

let trendingTag = null;
async function loadTrending() {
  const headers = { accept: "application/json" };
  if (trendingTag) headers["if-none-match"] = trendingTag;
  const res = await fetch("https://api.driftwood.example/v1/trending", { headers });
  if (res.status === 304) return null;
  trendingTag = res.headers.get("etag");
  return (await res.json()).shows;
}

async function sendFeedback(text) {
  await fetch(`${API}/feedback`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, platform: bridge.platform }),
  });
}

// ---------------------------------------------------------------------------------------------
// Episode cache (IndexedDB), so that the list shows at once on the next start

function openEpisodeDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("episodes")) {
        db.createObjectStore("episodes", { keyPath: "guid" }).createIndex("show", "feedUrl");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function cacheEpisodes(feedUrl, episodes) {
  const db = await openEpisodeDb();
  const tx = db.transaction("episodes", "readwrite");
  for (const episode of episodes) tx.objectStore("episodes").put({ ...episode, feedUrl });
  await new Promise((resolve) => (tx.oncomplete = resolve));
  db.close();
}

// ---------------------------------------------------------------------------------------------
// Rendering

function renderShows() {
  const list = $("#shows");
  list.replaceChildren(
    ...shows.map((show) =>
      el(
        "li",
        { className: show.feedUrl === selectedShow ? "selected" : "", onclick: () => selectShow(show.feedUrl) },
        el("span", { className: "title", textContent: show.title }),
        el("span", { className: "count", textContent: String(show.episodes) }),
      ),
    ),
  );
}

async function selectShow(feedUrl) {
  selectedShow = feedUrl;
  renderShows();
  const episodes = await bridge.listEpisodes(feedUrl);
  cacheEpisodes(feedUrl, episodes).catch(() => {});
  $("#episodes").replaceChildren(
    ...episodes.map((episode) =>
      el(
        "li",
        { className: episode.played ? "played" : "" },
        el("span", { textContent: episode.title }),
        el("span", { className: "duration", textContent: bridge.formatDuration(episode.duration) }),
        el("button", { textContent: "Play", onclick: () => playEpisode(episode) }),
        el("button", { textContent: "Download", onclick: () => startDownload(episode) }),
      ),
    ),
  );
}

function playEpisode(episode) {
  bridge.play({ ...episode, showId: shows.find((s) => s.feedUrl === selectedShow)?.id });
  bridge.markPlayed(selectedShow, episode.guid);
  // Other parts of the page (the history panel) listen for this DOM event.
  document.dispatchEvent(new CustomEvent("episode:selected", { detail: episode.guid }));
}

const downloadRows = new Map();
async function startDownload(episode) {
  const id = await bridge.download(episode);
  const row = el("li", { textContent: `${episode.title}: starting` });
  row.append(el("button", { textContent: "Cancel", onclick: () => bridge.cancelDownload(id) }));
  downloadRows.set(id, row);
  $("#downloads").append(row);
}

function showProgress({ id, received, total, done, error }) {
  const row = downloadRows.get(id);
  if (!row) return;
  if (error) row.firstChild.textContent = `failed: ${error}`;
  else if (done) row.firstChild.textContent = "done";
  else row.firstChild.textContent = total ? `${Math.round((received / total) * 100)}%` : `${received} bytes`;
}

function showAlert(alert) {
  const banner = el("div", { className: `alert ${alert.level ?? "info"}`, textContent: alert.text });
  $("#alerts").append(banner);
  setTimeout(() => banner.remove(), 8000);
}

async function reload() {
  const { shows: list, directory } = await bridge.listShows();
  shows = list;
  renderShows();
  $("#directory").replaceChildren(...directory.map((show) => el("li", { textContent: show.title })));
}

// ---------------------------------------------------------------------------------------------
// Start

async function start() {
  if (!bridge || location.hash === "#help") {
    showGuide();
    return;
  }
  restoreView();
  restoreSearch();
  $("#search").placeholder = "https://example.com/feed.xml or a show name";

  bridge.onLibraryChanged(() => reload());
  bridge.onDownloadProgress(showProgress);
  bridge.onAlert(showAlert);
  bridge.onPlaybackState((state) => {
    $("#now-playing").textContent = state.episode ? state.episode.title : "Nothing playing";
  });
  bridge.onMenuCommand((command) => {
    if (command === "subscribe") $("#search").focus();
    if (command === "refresh") bridge.refreshAll();
  });

  $("#search-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const term = $("#search").value.trim();
    if (/^https?:\/\//.test(term)) {
      await bridge.subscribe(term);
      return;
    }
    const results = await searchDirectory(term);
    $("#results").replaceChildren(
      ...results.map((r) => el("li", { textContent: r.title, onclick: () => bridge.subscribe(r.feedUrl) })),
    );
  });
  $("#unsubscribe").addEventListener("click", () => selectedShow && bridge.unsubscribe(selectedShow));
  $("#feedback-form").addEventListener("submit", (event) => {
    event.preventDefault();
    sendFeedback($("#feedback").value);
  });
  $("#help").addEventListener("click", () => bridge.openHelp());
  for (const tab of document.querySelectorAll("[data-tab]")) {
    tab.addEventListener("click", () => setView(tab.dataset.tab));
  }

  const speed = await bridge.getSetting("speed");
  $("#speed").value = String(speed);
  $("#speed").addEventListener("change", (e) => bridge.setSetting("speed", Number(e.target.value)));

  await reload();
  const trending = await loadTrending();
  if (trending) $("#trending").replaceChildren(...trending.map((s) => el("li", { textContent: s.title })));
}

start();
