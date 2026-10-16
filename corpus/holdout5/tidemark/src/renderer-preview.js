// Preview page. Receives rendered HTML from the main process through window.preview.

const ASSET_CDN = "https://cdn.tidemark.example/preview";
const THEME_KEY = "preview.theme";

const content = document.getElementById("content");
const status = document.getElementById("status");

async function applyTheme(theme) {
  const res = await fetch(`${ASSET_CDN}/themes/${encodeURIComponent(theme)}.css`);
  document.getElementById("theme").textContent = res.ok ? await res.text() : "";
  localStorage.setItem(THEME_KEY, theme);
}

window.preview.onRender((html) => {
  content.innerHTML = html;
  status.textContent = `Updated ${new Date().toLocaleTimeString()}`;
});

window.preview.onPong((info) => {
  status.textContent = info.editorOpen ? "Connected to the editor" : "The editor is closed";
});

document.getElementById("theme-picker").addEventListener("change", (event) => {
  applyTheme(event.target.value);
});

const saved = localStorage.getItem(THEME_KEY) ?? "paper";
document.getElementById("theme-picker").value = saved;
applyTheme(saved);
window.preview.ping();
