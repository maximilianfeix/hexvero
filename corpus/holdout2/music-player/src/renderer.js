// Renderer of the main window (and of the about box, index.html#about).
// Built by Vite from src/renderer/main.ts. MIT licensed, written for this corpus.
import { API_ROOT, LISTEN_ALONG_URL } from "./shared/endpoints.js";
import { formatTotal, trackLabel } from "./shared/time.js";
import { ARTWORK_DB, ARTWORK_DB_VERSION, QUEUE_KEY } from "./lib/keys.js";

const $ = (selector) => document.querySelector(selector);
const cadence = window.cadence;

// ---------------------------------------------------------------------------------------------
// A small event emitter for the audio engine. Its events stay inside the page.

class Emitter {
  #listeners = new Map();

  on(event, listener) {
    const list = this.#listeners.get(event) ?? [];
    this.#listeners.set(event, [...list, listener]);
    return () => this.off(event, listener);
  }

  off(event, listener) {
    const list = this.#listeners.get(event) ?? [];
    this.#listeners.set(
      event,
      list.filter((item) => item !== listener),
    );
  }

  emit(event, ...args) {
    for (const listener of this.#listeners.get(event) ?? []) listener(...args);
  }
}

class AudioEngine extends Emitter {
  constructor() {
    super();
    this.audio = new Audio();
    // Read only the header of a file until it is played.
    this.audio.preload = "metadata";
    this.track = null;
    this.audio.addEventListener("ended", () => this.emit("track:ended", this.track));
    this.audio.addEventListener("timeupdate", () =>
      this.emit("time:update", this.audio.currentTime),
    );
  }

  load(track) {
    this.track = track;
    // A local file of the library; nothing leaves the machine.
    this.audio.src = track.path;
  }

  async play() {
    await this.audio.play();
    this.emit("state", this.snapshot());
  }

  pause() {
    this.audio.pause();
    this.emit("state", this.snapshot());
  }

  toggle() {
    return this.audio.paused ? this.play() : this.pause();
  }

  set volume(value) {
    this.audio.volume = Math.min(1, Math.max(0, value));
  }

  snapshot() {
    return { track: this.track, position: this.audio.currentTime, paused: this.audio.paused };
  }
}

// ---------------------------------------------------------------------------------------------
// The Cadence API, behind a small client of our own.

class ApiClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
    this.token = null;
  }

  async request(path, init = {}) {
    const headers = { accept: "application/json", ...init.headers };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    const response = await fetch(`${this.baseUrl}${path}`, { ...init, headers });
    if (!response.ok) throw new Error(`${path} answered ${response.status}`);
    return response.status === 204 ? null : response.json();
  }

  get(path) {
    return this.request(path);
  }

  post(path, body) {
    return this.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  delete(path) {
    return this.request(path, { method: "DELETE" });
  }
}

const api = new ApiClient(API_ROOT);

const loadRecommendations = () => api.get("/me/recommendations");

const topTracks = (artistId) => api.get(`/artists/${encodeURIComponent(artistId)}/top-tracks`);

function scrobble(track, playedAt) {
  return api.post("/scrobbles", { trackId: track.id, playedAt });
}

function setLiked(trackId, liked) {
  return liked ? api.post(`/me/likes/${trackId}`, {}) : api.delete(`/me/likes/${trackId}`);
}

function watchFriends(onUpdate) {
  const source = new EventSource(`${API_ROOT}/live/friends`, { withCredentials: true });
  source.addEventListener("message", (event) => onUpdate(JSON.parse(event.data)));
  return source;
}

function joinListenAlong(sessionId, onTrack) {
  const socket = new WebSocket(`${LISTEN_ALONG_URL}?session=${encodeURIComponent(sessionId)}`);
  socket.addEventListener("message", (event) => onTrack(JSON.parse(event.data)));
  return socket;
}

async function downloadEpisode(episode) {
  // Podcast feeds name their own hosts; the address is whatever the feed says.
  const response = await fetch(episode.enclosureUrl);
  return response.blob();
}

// ---------------------------------------------------------------------------------------------
// Album art, cached in IndexedDB.

function openArtworkDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(ARTWORK_DB, ARTWORK_DB_VERSION);
    request.onupgradeneeded = () => {
      const covers = request.result.createObjectStore("covers", { keyPath: "albumId" });
      covers.createIndex("byAlbum", "albumId");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function coverFor(albumId) {
  const db = await openArtworkDb();
  const cached = await new Promise((resolve) => {
    const get = db.transaction("covers").objectStore("covers").get(albumId);
    get.onsuccess = () => resolve(get.result);
    get.onerror = () => resolve(undefined);
  });
  if (cached) return URL.createObjectURL(cached.blob);
  const response = await fetch(`https://covers.cadence.example/${albumId}/600.jpg`);
  const blob = await response.blob();
  db.transaction("covers", "readwrite").objectStore("covers").put({ albumId, blob });
  return URL.createObjectURL(blob);
}

// ---------------------------------------------------------------------------------------------
// The queue and the equalizer survive a restart; the last error is shown once.

function loadQueue() {
  try {
    return JSON.parse(localStorage.getItem(QUEUE_KEY) ?? "[]");
  } catch {
    return [];
  }
}

function saveQueue(queue) {
  localStorage.setItem(QUEUE_KEY, JSON.stringify(queue.map((track) => track.id)));
}

function applyPreset(name) {
  localStorage.setItem("cadence.eqPreset", name);
  document.body.dataset.eq = name;
}

function restorePreset() {
  applyPreset(localStorage.getItem("cadence.eqPreset") ?? "flat");
}

function reportError(error) {
  localStorage.setItem("cadence.lastError", String(error));
  $("#error").textContent = String(error);
}

function dismissError() {
  localStorage.removeItem("cadence.lastError");
  $("#error").textContent = "";
}

// ---------------------------------------------------------------------------------------------
// Things that only look like requests, storage or IPC.

const memo = new Map();

async function recommendationsOnce() {
  // A Map has get/set as well; this one lives as long as the page.
  if (!memo.has("recommendations")) memo.set("recommendations", await loadRecommendations());
  return memo.get("recommendations");
}

function shareLink(track) {
  // fetch("https://api.cadence.example/v1/legacy-feed") was the 2.x way to share.
  const link = new URL(`/track/${encodeURIComponent(track.id)}`, "https://cadence.example").href;
  $("#share").title = "Paste a link like https://cadence.example/track/123 to share it.";
  return navigator.clipboard.writeText(link);
}

// ---------------------------------------------------------------------------------------------
// Wiring.

async function showAbout() {
  document.body.classList.add("about");
  $("#about-version").textContent = await cadence.getVersion();
}

async function start() {
  if (location.hash === "#mini") return;
  if (location.hash === "#about") return showAbout();

  const engine = new AudioEngine();
  let queue = loadQueue();
  restorePreset();

  const settings = await cadence.getSettings();
  engine.volume = settings.volume;
  cadence.onSettingsChanged((next) => (engine.volume = next.volume));

  const library = await cadence.getTracks();
  $("#library-total").textContent = formatTotal(library);
  const playlists = await cadence.listPlaylists();
  $("#playlists").dataset.count = String(playlists.length);

  engine.on("state", (state) => {
    cadence.reportState(state);
    $("#now-playing").textContent = trackLabel(state.track);
  });
  engine.on("time:update", (position) => ($("#position").textContent = cadence.formatTime(position)));
  engine.on("track:ended", async (track) => {
    await scrobble(track, Date.now()).catch(reportError);
    queue = queue.slice(1);
    saveQueue(queue);
    if (queue[0]) {
      engine.load(queue[0]);
      await engine.play();
    }
  });

  const commands = {
    "play-pause": () => engine.toggle(),
    next: () => engine.emit("track:ended", engine.track),
    previous: () => (engine.audio.currentTime = 0),
  };
  cadence.onMediaKey((action) => commands[action]?.());
  cadence.onCommand((command) => commands[command]?.());
  navigator.mediaSession.setActionHandler("nexttrack", () => commands.next());
  navigator.mediaSession.setActionHandler("previoustrack", () => commands.previous());

  cadence.onScanProgress((progress) => {
    $("#scan").value = progress.total ? progress.done / progress.total : 1;
  });
  $("#add-folder").addEventListener("click", () => cadence.addFolder());
  $("#export").addEventListener("click", () => cadence.exportPlaylist(playlists[0]?.id));
  $("#save-playlist").addEventListener("click", () =>
    cadence.savePlaylist({ id: Date.now(), name: "Queue", trackIds: queue.map((t) => t.id) }),
  );
  $("#mini").addEventListener("click", () => cadence.toggleMiniPlayer());
  $("#minimize").addEventListener("click", () => cadence.minimize());
  $("#maximize").addEventListener("dblclick", () => cadence.toggleMaximize());
  $("#eq").addEventListener("change", (event) => applyPreset(event.target.value));
  $("#volume").addEventListener("input", (event) =>
    cadence.updateSettings({ volume: Number(event.target.value) }),
  );
  $("#error").addEventListener("click", dismissError);
  $("#like").addEventListener("click", (event) =>
    setLiked(engine.track?.id, event.target.getAttribute("aria-pressed") !== "true"),
  );
  $("#share").addEventListener("click", () => engine.track && shareLink(engine.track));
  $("#lyrics").addEventListener("click", async () => {
    const track = engine.track;
    if (track) $("#lyrics-text").textContent = (await cadence.fetchLyrics(track.artist, track.title)) ?? "";
  });
  $("#artist").addEventListener("click", async (event) => {
    const tracks = await topTracks(event.target.dataset.artist);
    $("#artist-tracks").dataset.count = String(tracks.length);
  });
  $("#episodes").addEventListener("click", async (event) => {
    const blob = await downloadEpisode({ enclosureUrl: event.target.dataset.enclosure });
    engine.load({ id: event.target.dataset.enclosure, path: URL.createObjectURL(blob) });
  });

  const recommended = await recommendationsOnce().catch(() => []);
  $("#recommended").dataset.count = String(recommended.length);
  if (recommended[0]?.albumId) $("#cover").src = await coverFor(recommended[0].albumId);
  watchFriends((update) => ($("#friends").textContent = `${update.online} friends listening`));
  if (settings.listenAlongSession) joinListenAlong(settings.listenAlongSession, (track) => engine.load(track));
}

window.addEventListener("DOMContentLoaded", () => start().catch(reportError));
