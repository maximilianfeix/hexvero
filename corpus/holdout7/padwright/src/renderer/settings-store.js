// UI preferences that stay in this browser profile. Device settings live in the main process.
export const Keys = Object.freeze({
  THEME: "padwright.theme",
  LAST_DEVICE: "padwright.lastDevice",
  RECENT_LAYOUTS: "padwright.recentLayouts",
});

export const prefs = {
  get(key, fallback = null) {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return fallback;
    try {
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    window.localStorage.setItem(key, JSON.stringify(value));
  },
  clear(key) {
    window.localStorage.removeItem(key);
  },
};
