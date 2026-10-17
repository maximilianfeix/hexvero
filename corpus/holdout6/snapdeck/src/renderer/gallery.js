const GALLERY_API = "https://gallery.snapdeck.example/api";
const TRENDING_URL = `${GALLERY_API}/trending?window=week`;
const SHARE_PAGE = "https://share.snapdeck.example/s/";

const memo = new Map();

/** The public gallery's trending captures, fetched once per window. */
export async function loadTrending() {
  if (memo.has("trending")) return memo.get("trending");
  const response = await fetch(TRENDING_URL, { headers: { accept: "application/json" } });
  if (!response.ok) return [];
  const items = await response.json();
  memo.set("trending", items);
  return items;
}

/** The address people open to see a shared capture; shown and copied, never fetched here. */
export const shareUrl = (slug) => `${SHARE_PAGE}${encodeURIComponent(slug)}`;
