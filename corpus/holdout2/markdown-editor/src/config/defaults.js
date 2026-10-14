// What every window of Inkwell starts from (a window names only what it changes), and the names
// of what the editor page keeps in its storage.
// MIT licensed, written for this corpus.
"use strict";

const WINDOW_DEFAULTS = {
  show: false,
  backgroundColor: "#fbfaf7",
  titleBarStyle: "hidden",
  trafficLightPosition: { x: 14, y: 14 },
};

const WEB_DEFAULTS = {
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  spellcheck: true,
};

const RECENT_KEY = "inkwell.recent";

/** Every preference of the editor page is stored under this prefix. */
const PREF_PREFIX = "inkwell.";

const SEARCH_DB = "inkwell-search";
const SEARCH_DB_VERSION = 3;

module.exports = {
  WINDOW_DEFAULTS,
  WEB_DEFAULTS,
  RECENT_KEY,
  PREF_PREFIX,
  SEARCH_DB,
  SEARCH_DB_VERSION,
};
