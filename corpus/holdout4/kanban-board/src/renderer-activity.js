// The activity feed, docked on the right of the board window. window.feed comes from
// preload-activity.js.
const { feed } = window;

const EVENTS_ROOT = "https://events.lattice.example/v1";
const COLLAPSED_KEY = "activity.collapsed";
const MAX_ENTRIES = 200;

const list = document.querySelector("#entries");
const formatter = new Intl.RelativeTimeFormat(feed.locale, { numeric: "auto" });

const LABELS = {
  move: (e) => `moved a card (${e.cardId})`,
  create: (e) => `added “${e.title}”`,
  remove: () => "removed a card",
  reorder: () => "reordered the lanes",
  archive: () => "archived a board",
  import: (e) => `imported ${e.count} cards`,
  "signed-in": () => "signed in to sync",
  "sync-online": () => "sync is online",
  "sync-offline": () => "sync is offline",
  cleared: () => "cleared the feed",
  remote: (e) => `${e.who} ${e.what}`,
};

function ago(at) {
  const minutes = Math.round((at - Date.now()) / 60000);
  return Math.abs(minutes) < 60 ? formatter.format(minutes, "minute") : formatter.format(Math.round(minutes / 60), "hour");
}

function add(entry) {
  if (entry.kind === "cleared") list.replaceChildren();
  const label = (LABELS[entry.kind] ?? (() => entry.kind))(entry);
  const item = document.createElement("li");
  item.textContent = `${label} · ${ago(entry.at)}`;
  list.prepend(item);
  while (list.children.length > MAX_ENTRIES) list.lastElementChild.remove();
}

feed.onPush(add);

// Changes made by teammates arrive from the events service.
const since = Date.now() - 24 * 3600 * 1000;
const source = new EventSource(`${EVENTS_ROOT}/stream?since=${since}`);
source.addEventListener("card", (e) => {
  const data = JSON.parse(e.data);
  add({ kind: "remote", who: data.member, what: data.summary, at: data.at });
});
source.onerror = () => add({ kind: "sync-offline", at: Date.now() });

const panel = document.querySelector("#panel");
panel.classList.toggle("collapsed", localStorage.getItem(COLLAPSED_KEY) === "1");
document.querySelector("#collapse").addEventListener("click", () => {
  const collapsed = panel.classList.toggle("collapsed");
  localStorage.setItem(COLLAPSED_KEY, collapsed ? "1" : "0");
});

document.querySelector("#clear").addEventListener("click", () => feed.clear());
