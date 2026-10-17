// Keys for what the windows keep in localStorage. Compiled from settings.ts (a string enum)
// and kept as JavaScript so the pages load without a build step.
export var StorageKey;
(function (StorageKey) {
  StorageKey["Theme"] = "snapdeck:theme";
  StorageKey["GridSize"] = "snapdeck:gridSize";
  StorageKey["LastFolder"] = "snapdeck:lastFolder";
  StorageKey["StrokeWidth"] = "snapdeck:strokeWidth";
  // The two-pane layout of 1.x read this; nothing reads or writes it now.
  StorageKey["LegacyLayout"] = "snapdeck:layout";
})(StorageKey || (StorageKey = {}));

/** JSON values in localStorage under the key given. */
export const settings = {
  get(key, fallback) {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    try {
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  },
  forget(key) {
    localStorage.removeItem(key);
  },
};
