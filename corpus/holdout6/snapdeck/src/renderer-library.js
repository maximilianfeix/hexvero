import { settings, StorageKey } from "./renderer/settings.js";
import { loadTrending, shareUrl } from "./renderer/gallery.js";

const api = window.snapdeck;
const grid = document.querySelector("#grid");
const folders = document.querySelector("#folders");
const webhook = document.querySelector("#webhook");
// Annotator windows post here after a save so the grid shows the new title at once.
const refresh = new BroadcastChannel("library:refresh");

function button(label, onClick) {
  const el = document.createElement("button");
  el.textContent = label;
  el.addEventListener("click", onClick);
  return el;
}

function card(shot) {
  const el = document.createElement("figure");
  el.className = "card";
  const img = document.createElement("img");
  img.src = `file://${shot.file}`;
  img.alt = shot.title || "Capture";
  const caption = document.createElement("figcaption");
  caption.textContent = shot.title || new Date(shot.createdAt).toLocaleString();
  if (shot.slug) {
    const link = document.createElement("small");
    link.textContent = shareUrl(shot.slug);
    link.addEventListener("click", () => navigator.clipboard.writeText(link.textContent));
    caption.append(link);
  }
  const actions = document.createElement("div");
  actions.className = "actions";
  actions.append(
    button("Open", () => api.openShot(shot.id)),
    button("Show in folder", () => api.revealShot(shot.id)),
    button("Delete", async () => {
      if (!confirm("Delete this capture?")) return;
      await api.deleteShot(shot.id);
      render();
    }),
  );
  el.append(img, caption, actions);
  el.addEventListener("dragstart", (event) => {
    event.dataTransfer.setData("text/uri-list", `file://${shot.file}`);
  });
  return el;
}

async function render() {
  const shots = await api.listShots();
  const folder = settings.get(StorageKey.LastFolder, "all");
  grid.replaceChildren(...shots.filter((s) => folder === "all" || s.folder === folder).map(card));
  grid.scrollTop = Number(sessionStorage.getItem("library.scrollTop") || 0);
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
}

function applyGrid(size) {
  grid.style.setProperty("--card-size", `${size}px`);
}

async function showTrending() {
  const list = document.querySelector("#trending");
  const items = await loadTrending();
  list.replaceChildren(
    ...items.slice(0, 12).map((item) => {
      const li = document.createElement("li");
      li.textContent = `${item.title} (${item.views} views)`;
      return li;
    }),
  );
}

document.querySelector("#theme").addEventListener("change", (event) => {
  settings.set(StorageKey.Theme, event.target.value);
  applyTheme(event.target.value);
});

document.querySelector("#grid-size").addEventListener("input", (event) => {
  const size = Number(event.target.value);
  settings.set(StorageKey.GridSize, size);
  applyGrid(size);
});

folders.addEventListener("change", () => {
  settings.set(StorageKey.LastFolder, folders.value);
  render();
});

document.querySelector("#reset-view").addEventListener("click", () => {
  settings.forget(StorageKey.LastFolder);
  folders.value = "all";
  render();
});

grid.addEventListener("scroll", () => {
  sessionStorage.setItem("library.scrollTop", String(grid.scrollTop));
});

webhook.addEventListener("change", () => api.setPrefs({ webhookUrl: webhook.value.trim() }));

document.querySelector("#capture").addEventListener("click", () => api.startCapture());

api.onMenuCommand((command) => {
  if (command === "capture") api.startCapture();
});

refresh.addEventListener("message", () => render());

async function start() {
  applyTheme(settings.get(StorageKey.Theme, "system"));
  applyGrid(settings.get(StorageKey.GridSize, 220));
  folders.value = settings.get(StorageKey.LastFolder, "all");
  const prefs = await api.getPrefs();
  webhook.value = prefs.webhookUrl;
  document.querySelector("#version").textContent = `Snapdeck ${api.appVersion()} on ${api.platform}`;
  await render();
  showTrending().catch(() => {});
}

start();
