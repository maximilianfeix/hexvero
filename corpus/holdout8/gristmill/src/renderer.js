import { bindImport, bindSearch, refreshList, showRecipe } from "./renderer/library-view.js";
import { bindPlanner } from "./renderer/planner.js";
import { ATTRIBUTION, totals } from "./renderer/nutrition.js";

const $ = (selector) => document.querySelector(selector);
const titles = new Map();

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme ?? "system";
}

function showView(view) {
  for (const section of document.querySelectorAll("main > section")) {
    section.hidden = section.id !== view;
  }
  window.settingsStore.set("ui.lastView", view);
}

async function openRecipe(id) {
  await showRecipe($("#recipe"), id);
  showView("recipe");
  const ingredients = [...document.querySelectorAll("#recipe .ingredients li")].map((li) => li.textContent);
  const sum = await totals(ingredients);
  $("#recipe .nutrition").textContent = `${Math.round(sum.kcal)} kcal, ${Math.round(sum.protein)} g protein`;
}

function bindTitleBar() {
  if (window.desktop.isMac) {
    $("#titlebar .controls").hidden = true;
    return;
  }
  $("#titlebar .min").addEventListener("click", () => window.desktop.minimize());
  $("#titlebar .max").addEventListener("click", async () => {
    window.desktop.toggleMaximize();
    $("#titlebar .max").classList.toggle("restore", !(await window.desktop.isMaximized()));
  });
  $("#titlebar .close").addEventListener("click", () => window.desktop.close());
}

function bindTimers() {
  const tray = $("#timers");
  window.gristmillEvents.setTimerTickHandler((_event, { id, remaining }) => {
    let row = tray.querySelector(`[data-timer="${id}"]`);
    if (!row) {
      row = Object.assign(document.createElement("div"), { className: "timer" });
      row.dataset.timer = id;
      const cancel = Object.assign(document.createElement("button"), { textContent: "×" });
      cancel.addEventListener("click", () => {
        window.timers.cancel(id);
        row.remove();
      });
      row.append(document.createElement("span"), cancel);
      tray.append(row);
    }
    row.firstChild.textContent = `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}`;
  });
  window.gristmillEvents.setTimerDoneHandler((_event, { id }) => {
    tray.querySelector(`[data-timer="${id}"]`)?.remove();
  });
}

function bindStatus() {
  const status = $("#sync-status");
  const labels = ["Synced", "Pulling…", "Pushing…", "Not signed in", "Sync failed"];
  window.gristmillEvents.setSyncStatusHandler((_event, { state, message }) => {
    status.textContent = labels[state] ?? "";
    status.title = message ?? "";
  });
  status.addEventListener("click", () => window.sync.now());
  window.gristmillEvents.setUpdateAvailableHandler((_event, { version, notesUrl }) => {
    const banner = $("#update-banner");
    banner.querySelector("span").textContent = `Gristmill ${version} is available.`;
    banner.querySelector("a").onclick = () => window.desktop.openExternal(notesUrl);
    banner.hidden = false;
  });
  window.gristmillEvents.setSettingChangedHandler((_event, key, value) => {
    if (key === "ui.theme") applyTheme(value);
  });
}

async function start() {
  applyTheme(window.settingsStore.get("ui.theme"));
  document.body.dataset.units = window.settingsStore.get("units.system") ?? "metric";
  bindTitleBar();
  bindTimers();
  bindStatus();
  $("footer .attribution").textContent = ATTRIBUTION;
  $("#open-settings").addEventListener("click", () => window.desktop.openSettings());
  $("#open-shopping").addEventListener("click", () => window.desktop.openShoppingList());
  for (const tab of document.querySelectorAll("nav [data-view]")) {
    tab.addEventListener("click", () => showView(tab.dataset.view));
  }
  const list = $("#library ul");
  bindSearch($("#library input[type=search]"), list);
  list.addEventListener("click", (e) => {
    const id = e.target.closest("li")?.dataset.id;
    if (id) openRecipe(id);
  });
  bindImport($("#import-form"), (saved) => {
    titles.set(saved.id, saved.title);
    refreshList(list);
    openRecipe(saved.id);
  });
  for (const r of await window.recipes.list()) titles.set(r.id, r.title);
  await refreshList(list);
  bindPlanner($("#planner .board"), (id) => titles.get(id) ?? "(deleted recipe)");
  showView(window.settingsStore.get("ui.lastView") ?? "library");
}

start();
