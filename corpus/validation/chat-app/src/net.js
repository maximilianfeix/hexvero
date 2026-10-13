// Addresses and small helpers shared by the renderer scripts.
// MIT licensed, written for this corpus.

export const API_ROOT = "https://api.chat.example/v2";
export const GATEWAY_URL = "wss://gateway.chat.example/socket";

// Shown in the help line of the window. Nothing requests it.
export const HELP_URL = "https://help.chat.example/faq";

/** A lookup table for avatars already downloaded. Its fetch() reads a Map. */
export const avatarCache = {
  entries: new Map(),
  fetch(key) {
    return this.entries.get(key) ?? null;
  },
  open(mode, key) {
    this.entries.set(key, mode);
  },
};

/** Request headers. Headers has get/set/delete, like a store. */
export function jsonHeaders(token) {
  const headers = new Headers();
  headers.set("Content-Type", "application/json");
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return headers;
}
