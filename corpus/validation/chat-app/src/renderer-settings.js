// Script of the settings dialog. The dialog runs with Node integration and no preload script,
// so it gets ipcRenderer from Electron itself.
// MIT licensed, written for this corpus.

const inDialog = location.hash === "#settings" && typeof window.require === "function";
const { ipcRenderer } = inDialog ? window.require("electron") : { ipcRenderer: null };

function signOutEverywhere() {
  const xhr = new XMLHttpRequest();
  xhr.open("DELETE", "https://api.chat.example/v2/session");
  xhr.addEventListener("load", () => ipcRenderer.invoke("auth:sign-out"));
  xhr.send();
}

function ping(target, payload) {
  // the address comes from the caller
  return navigator.sendBeacon(target, payload);
}

function wire() {
  document.getElementById("settings").hidden = false;
  document.documentElement.lang = ipcRenderer.sendSync("app:locale");

  document.getElementById("save").addEventListener("click", () => {
    ipcRenderer.once("settings:saved", () => window.close());
    ipcRenderer.send("settings:save", { zoom: Number(localStorage.getItem("ui.zoom-draft") ?? 1) });
  });
  document.getElementById("reset").addEventListener("click", async () => {
    const zoom = await ipcRenderer.invoke("settings:reset");
    localStorage.setItem("ui.zoom-draft", String(zoom));
  });
  document.getElementById("sign-out").addEventListener("click", signOutEverywhere);

  ipcRenderer.on("presence:update", (_event, presence) => {
    document.title = presence.online ? "Settings" : "Settings (offline)";
    if (presence.pingUrl) ping(presence.pingUrl, "seen");
  });
}

if (ipcRenderer) window.addEventListener("DOMContentLoaded", wire);
