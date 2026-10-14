// Script of the settings window (index.html#settings).
// MIT licensed, written for this corpus.

const $ = (id) => document.getElementById(id);

async function loadAccount() {
  const response = await fetch("https://api.inkwell.example/v1/account", { credentials: "include" });
  return response.ok ? response.json() : null;
}

function signOut() {
  return fetch("https://api.inkwell.example/v1/session", { method: "DELETE", credentials: "include" });
}

function selectTab(name) {
  localStorage.setItem("inkwell.settingsTab", name);
  for (const tab of document.querySelectorAll("[data-tab]")) tab.hidden = tab.dataset.tab !== name;
}

async function start() {
  document.body.classList.add("settings");
  selectTab(localStorage.getItem("inkwell.settingsTab") ?? "editor");

  const settings = await window.inkwell.getSettings();
  $("font-size").value = settings["editor.fontSize"];
  $("unsafe-plugins").checked = settings["plugins.unsafe"];
  window.inkwell.onSettingsChanged((key, value) => {
    if (key === "editor.fontSize") $("font-size").value = value;
  });

  $("font-size").addEventListener("change", (event) =>
    window.inkwell.setSetting("editor.fontSize", Number(event.target.value)),
  );
  $("unsafe-plugins").addEventListener("change", (event) =>
    window.inkwell.setSetting("plugins.unsafe", event.target.checked),
  );
  $("tabs").addEventListener("click", (event) => event.target.dataset.open && selectTab(event.target.dataset.open));

  const account = await loadAccount();
  $("account").textContent = account ? account.email : "Not signed in";
  $("sign-out").addEventListener("click", async () => {
    await signOut();
    $("account").textContent = "Not signed in";
  });
}

if (location.hash === "#settings") window.addEventListener("DOMContentLoaded", start);
