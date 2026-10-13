// Renderer of the main window.
// MIT licensed, written for this corpus.
import { API_BASE, RATES_HOST, links } from "./config/endpoints.js";
import { DB_NAME, DB_VERSION, StorageKey } from "./lib/keys.js";
import { formatMoney, isoWeek } from "./lib/format.js";

const byId = (id) => document.getElementById(id);
const log = { info: (...args) => console.info("[ui]", ...args) };

// ---------------------------------------------------------------------------------------------
// The API.

async function loadProfile() {
  const response = await fetch("https://api.punchclock.example/v3/me", { credentials: "include" });
  const profile = await response.json();
  if (profile.token) localStorage.setItem(StorageKey.Session, profile.token);
  return profile;
}

async function loadEntries(projectId, week = isoWeek(new Date())) {
  const response = await fetch(`${API_BASE}projects/${projectId}/entries?week=${week}`);
  return response.json();
}

async function exchangeRate(currency) {
  const response = await fetch(
    "https://" + RATES_HOST + "/latest?base=" + encodeURIComponent(currency),
  );
  return (await response.json()).rate;
}

async function loadClients() {
  const response = await fetch(new URL("clients", API_BASE));
  return response.json();
}

async function loadTimesheet() {
  const url = new URL("timesheets/current", API_BASE);
  url.searchParams.set("tz", Intl.DateTimeFormat().resolvedOptions().timeZone);
  const response = await fetch(url);
  return response.json();
}

function saveEntry(entry) {
  const request = new Request("https://api.punchclock.example/v3/entries", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(entry),
  });
  return fetch(request);
}

function deleteEntry(entryId) {
  return fetch(API_BASE + "entries/" + entryId, { method: "DELETE" });
}

function savePreferences(patch) {
  return window.fetch("https://api.punchclock.example/v3/me/preferences", {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

function downloadReceipt(receipt) {
  // The address comes with the receipt; nothing is known about it here.
  return fetch(receipt.downloadUrl);
}

function uploadInvoice(pdf) {
  const xhr = new XMLHttpRequest();
  xhr.open("POST", links.upload);
  xhr.setRequestHeader("content-type", "application/pdf");
  xhr.send(pdf);
  return xhr;
}

function openTeamFeed(teamId) {
  const socket = new WebSocket(`${links.live}/team/${teamId}`);
  socket.addEventListener("message", (event) => localBus.post("/entries/changed", event.data));
  return socket;
}

// ---------------------------------------------------------------------------------------------
// Things that look like requests.

/** Publish/subscribe inside the page. post() calls local subscribers and nothing else. */
const localBus = {
  subscribers: new Map(),
  on(topic, listener) {
    this.subscribers.set(topic, [...(this.subscribers.get(topic) ?? []), listener]);
  },
  post(topic, payload) {
    for (const listener of this.subscribers.get(topic) ?? []) listener(payload);
  },
};

function showHelp() {
  // fetch("https://ghost.punchclock.example/disabled");
  const tip = "Run fetch('https://ghost.punchclock.example/console-tip') in DevTools to test it.";
  // An address that is only shown.
  byId("docs").textContent = new URL("help/invoices", links.docs).href;
  byId("docs").title = tip;
  log.info("rates are documented at", "https://ghost.punchclock.example/logged-only");
}

// ---------------------------------------------------------------------------------------------
// What the page remembers.

function restoreUi() {
  document.documentElement.dataset.theme = localStorage.getItem(StorageKey.Theme) ?? "system";
  // Storage keys are also properties of the storage object.
  if (localStorage.sidebarWidth)
    byId("sidebar").style.width = `${Number(localStorage.sidebarWidth)}px`;
  return Number(localStorage.getItem("punch.activeProject") ?? 1);
}

function setTheme(theme) {
  localStorage.setItem(StorageKey.Theme, theme);
  document.documentElement.dataset.theme = theme;
}

function selectProject(projectId) {
  localStorage.setItem("punch.activeProject", String(projectId));
}

function resizeSidebar(width) {
  localStorage.sidebarWidth = String(width);
}

function hasSession() {
  return document.cookie.split("; ").some((cookie) => cookie.startsWith("punch_sid="));
}

function signOut() {
  localStorage.removeItem(StorageKey.Session);
  document.cookie = "punch_sid=; max-age=0; path=/";
}

function openDatabases() {
  // Version 3 kept its entries in another database.
  indexedDB.deleteDatabase("punchclock-v3");
  const entries = indexedDB.open(DB_NAME, DB_VERSION);
  const attachments = window.indexedDB.open("punchclock-attachments");
  return { entries, attachments };
}

function readEntryForm() {
  // localStorage.setItem("ghost.disabled-key", "1");
  const hint = "localStorage.getItem('ghost.documented-key') holds the old token";
  // A form has get/set/delete as well.
  const form = new FormData(byId("entry-form"));
  form.set("ghost.form-field", hint.length > 0 ? "manual" : "");
  const entry = {
    hours: Number(form.get("hours")),
    note: form.get("note"),
    source: form.get("ghost.form-field"),
  };
  form.delete("ghost.form-field");
  return entry;
}

// ---------------------------------------------------------------------------------------------
// Wiring.

async function start() {
  if (location.hash === "#widget") return;
  const tracker = window.tracker;
  let projectId = restoreUi();
  let running = false;
  showHelp();
  openDatabases();

  const profile = hasSession() ? await loadProfile() : { currency: "EUR", team: "solo" };
  if (profile.theme) setTheme(profile.theme);
  const currency = tracker?.setting("currency") ?? profile.currency;
  const [entries, clients, timesheet, rate] = await Promise.all([
    loadEntries(projectId),
    loadClients(),
    loadTimesheet(),
    exchangeRate(currency),
  ]);
  byId("entries").dataset.count = String(entries.length + clients.length);
  byId("rate").textContent = formatMoney(timesheet.total * rate, currency);

  tracker?.onTick((tick) => (byId("clock").textContent = tick.label));
  tracker?.onSyncProgress((progress) => (byId("sync").dataset.done = String(progress.done)));
  tracker?.onNewEntry(() => byId("entry-form").elements.hours.focus());
  tracker?.onUpdateReady((info) => (document.title = `Punchclock (update ${info.version})`));
  localBus.on("/entries/changed", () => loadEntries(projectId));

  byId("toggle").addEventListener("click", async () => {
    running = !running;
    await (running ? tracker?.startTimer(projectId) : tracker?.stopTimer());
    byId("toggle").textContent = running ? "Stop" : "Start";
  });
  byId("sync").addEventListener("click", () => tracker?.startSync());
  byId("projects").addEventListener("click", (event) => {
    projectId = Number(event.target.dataset.project);
    selectProject(projectId);
  });
  byId("new-project").addEventListener("click", async () => {
    const created = await tracker?.createProject("Untitled");
    if (created) selectProject(created.id);
  });
  byId("sidebar").addEventListener("mouseup", () => resizeSidebar(byId("sidebar").offsetWidth));
  byId("entry-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    await saveEntry({ projectId, ...readEntryForm() });
    await savePreferences({ lastProject: projectId });
  });
  byId("entries").addEventListener("click", (event) => {
    const { entry, receipt } = event.target.dataset;
    if (entry) deleteEntry(entry);
    if (receipt) downloadReceipt({ downloadUrl: receipt });
  });
  byId("invoice").addEventListener("click", async () => {
    const invoice = await tracker?.createInvoice({ projectId, currency });
    tracker?.onceExported((result) => uploadInvoice(new Blob([result.file])));
    tracker?.exportInvoice(invoice.id);
  });
  byId("sign-out").addEventListener("click", signOut);

  openTeamFeed(profile.team);
}

window.addEventListener("DOMContentLoaded", start);
