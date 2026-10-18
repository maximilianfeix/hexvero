import { Keys, prefs } from "./settings-store.js";

// Public layout gallery. The base is also shown in the footer as plain text.
export const GALLERY_API = "https://share.padwright.example/api";
const cache = new Map();

export async function browse(model) {
  if (cache.has(model)) return cache.get(model);
  const res = await fetch(`${GALLERY_API}/layouts?model=${encodeURIComponent(model)}&sort=top`);
  if (!res.ok) throw new Error(`gallery: ${res.status}`);
  const layouts = await res.json();
  cache.set(model, layouts);
  return layouts;
}

export async function share(model, name, layers) {
  const res = await fetch(`${GALLERY_API}/layouts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, name, layers }),
  });
  return res.json();
}

export function remember(layoutId) {
  const recent = prefs.get(Keys.RECENT_LAYOUTS, []).filter((id) => id !== layoutId);
  prefs.set(Keys.RECENT_LAYOUTS, [layoutId, ...recent].slice(0, 8));
}

export function recent() {
  return prefs.get(Keys.RECENT_LAYOUTS, []);
}
