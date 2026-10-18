// Preferences window. It shares preload.js with the main window.
const FEEDBACK_URL = "https://api.gristmill.example/v2/feedback";
const PRIVACY_URL = "https://gristmill.example/privacy";

const $ = (selector) => document.querySelector(selector);

function bindAppearance() {
  const current = window.settingsStore.get("ui.theme") ?? "system";
  for (const radio of document.querySelectorAll("input[name=theme]")) {
    radio.checked = radio.value === current;
    radio.addEventListener("change", () => window.settingsStore.set("ui.theme", radio.value));
  }
  const units = $("#units");
  units.value = window.settingsStore.get("units.system") ?? "metric";
  units.addEventListener("change", () => window.settingsStore.set("units.system", units.value));
}

function bindAccount() {
  const form = $("#sign-in");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const { email, password } = form.elements;
    try {
      await window.sync.signIn(email.value, password.value);
      form.classList.add("signed-in");
    } catch (error) {
      form.querySelector(".error").textContent = String(error.message ?? error);
    }
  });
  $("#sign-out").addEventListener("click", () => {
    window.sync.signOut();
    form.classList.remove("signed-in");
  });
}

function bindFeedback() {
  const form = $("#feedback");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const body = JSON.stringify({ message: form.elements.message.value, platform: navigator.platform });
    const res = await fetch(FEEDBACK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    form.querySelector(".result").textContent = res.ok ? "Thank you!" : "Could not send, try again later.";
  });
  $("#privacy").addEventListener("click", (e) => {
    e.preventDefault();
    window.desktop.openExternal(PRIVACY_URL);
  });
}

bindAppearance();
bindAccount();
bindFeedback();
