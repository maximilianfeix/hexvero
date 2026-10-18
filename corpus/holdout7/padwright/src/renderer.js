import { browse, GALLERY_API, recent, remember, share } from "./renderer/gallery.js";
import { lastDevice, render, save, selectDevice, state } from "./renderer/keymap-view.js";
import { Keys, prefs } from "./renderer/settings-store.js";

const api = window.padwright;
const $ = (selector) => document.querySelector(selector);

// 2.x cached keymaps in the page; the device is the source of truth since 3.0.
window.localStorage.removeItem("padwright.legacyKeymapCache");

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  prefs.set(Keys.THEME, theme);
}

async function refreshDevices() {
  const devices = await api.listDevices();
  const list = $("#devices");
  list.replaceChildren(
    ...devices.map((device) => {
      const item = document.createElement("li");
      item.textContent = `${device.model} (${device.id}) · fw ${device.firmware}`;
      item.addEventListener("click", () => selectDevice(device.id));
      return item;
    }),
  );
  return devices;
}

async function checkForUpdate(device) {
  const settings = await api.getSettings();
  const release = await api.checkFirmware(device.model, settings.firmwareTrack);
  if (release && release.version !== device.firmware) {
    $("#update").hidden = false;
    $("#update-version").textContent = release.version;
    $("#update").onclick = () => api.openFlasher(device.id);
  }
}

async function showGallery(model) {
  const layouts = await browse(model);
  $("#gallery").replaceChildren(
    ...layouts.map((layout) => {
      const card = document.createElement("article");
      card.textContent = `${layout.name} by ${layout.author}`;
      card.addEventListener("click", () => {
        state.layers = layout.layers;
        remember(layout.id);
        render();
      });
      return card;
    }),
  );
  $("#recent-count").textContent = String(recent().length);
}

async function start() {
  applyTheme(prefs.get(Keys.THEME, "system"));
  $("#gallery-base").textContent = GALLERY_API;
  $("#theme").addEventListener("change", (event) => applyTheme(event.target.value));
  $("#save").addEventListener("click", () => save());
  $("#share").addEventListener("click", async () => {
    const name = $("#layout-name").value.trim();
    if (name) await share("pad-12", name, state.layers);
  });
  $("#forget-recent").addEventListener("click", () => prefs.clear(Keys.RECENT_LAYOUTS));
  $("#repeat").addEventListener("change", (event) =>
    api.setSettings({ repeatDelayMs: Number(event.target.value) }),
  );

  api.onDeviceAttached(async (device) => {
    await refreshDevices();
    await checkForUpdate(device);
    await showGallery(device.model);
  });

  const devices = await refreshDevices();
  const remembered = devices.find((device) => device.id === lastDevice());
  if (remembered) await selectDevice(remembered.id);
  api.track("app.opened", { mac: api.isMac });
}

window.addEventListener("DOMContentLoaded", start);
