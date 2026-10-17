import { settings, StorageKey } from "./renderer/settings.js";

const RECENT_COLORS = "annotator.recentColors";
const STICKER_CDN = "https://cdn.snapdeck.example/stickers";

const bridge = window.annotator;
const canvas = document.querySelector("#canvas");
const ctx = canvas.getContext("2d");
const status = document.querySelector("#status");
const refresh = new BroadcastChannel("library:refresh");

let shot = null;
let base = null;
let strokes = [];
let current = null;
let dirty = false;
let tool = sessionStorage.getItem("annotator.activeTool") || "arrow";
let color = settings.get(RECENT_COLORS, ["#ff3b30"])[0];
let width = settings.get(StorageKey.StrokeWidth, 4);

function markDirty(value) {
  if (dirty === value) return;
  dirty = value;
  bridge.setDirty(value);
}

function redraw() {
  if (base) ctx.drawImage(base, 0, 0);
  for (const stroke of strokes) {
    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = stroke.width;
    ctx.beginPath();
    stroke.points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.stroke();
  }
}

function selectTool(name) {
  tool = name;
  sessionStorage.setItem("annotator.activeTool", name);
  for (const el of document.querySelectorAll("[data-tool]")) el.classList.toggle("active", el.dataset.tool === name);
}

function rememberColor(next) {
  color = next;
  const recent = settings.get(RECENT_COLORS, []).filter((c) => c !== next);
  settings.set(RECENT_COLORS, [next, ...recent].slice(0, 8));
}

async function loadStickerPack(pack) {
  const response = await fetch(`${STICKER_CDN}/${encodeURIComponent(pack)}/index.json`);
  if (!response.ok) return [];
  return (await response.json()).stickers;
}

async function save() {
  await bridge.saveShot({ ...shot, title: document.querySelector("#title").value, annotations: strokes });
  markDirty(false);
  refresh.postMessage({ id: shot.id });
  status.textContent = "Saved";
}

async function share() {
  status.textContent = "Uploading…";
  try {
    const { slug } = await bridge.shareShot(shot.id);
    status.textContent = `Shared as ${slug}`;
  } catch (error) {
    status.textContent = error.message;
  }
}

bridge.onShotLoaded(async (loaded) => {
  shot = loaded;
  strokes = loaded.annotations || [];
  const bytes = await bridge.loadImage(shot.file);
  base = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
  canvas.width = base.width;
  canvas.height = base.height;
  document.querySelector("#title").value = shot.title;
  redraw();
});

bridge.onMenuCommand((command) => {
  if (command === "save") save();
  if (command === "undo" && strokes.length) {
    strokes.pop();
    redraw();
    markDirty(true);
  }
});

canvas.addEventListener("pointerdown", (event) => {
  current = { tool, color, width, points: [[event.offsetX, event.offsetY]] };
});
canvas.addEventListener("pointermove", (event) => {
  if (!current) return;
  current.points.push([event.offsetX, event.offsetY]);
  redraw();
});
canvas.addEventListener("pointerup", () => {
  if (!current) return;
  strokes.push(current);
  current = null;
  markDirty(true);
  redraw();
});

for (const el of document.querySelectorAll("[data-tool]")) el.addEventListener("click", () => selectTool(el.dataset.tool));
document.querySelector("#color").addEventListener("change", (event) => rememberColor(event.target.value));
document.querySelector("#width").addEventListener("input", (event) => {
  width = Number(event.target.value);
  settings.set(StorageKey.StrokeWidth, width);
});
document.querySelector("#save").addEventListener("click", save);
document.querySelector("#share").addEventListener("click", share);
document.querySelector("#stickers").addEventListener("change", async (event) => {
  const stickers = await loadStickerPack(event.target.value);
  document.querySelector("#sticker-list").replaceChildren(
    ...stickers.map((s) => Object.assign(document.createElement("button"), { textContent: s.name })),
  );
});

bridge.getPrefs().then((prefs) => {
  document.querySelector("#format").textContent = prefs.format.toUpperCase();
});
selectTool(tool);
