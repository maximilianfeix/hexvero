"use strict";
// One import for the main process: channel names, addresses and menu labels.

const channels = require("./channels");
const endpoints = require("./endpoints");

// Menu labels keyed by message id. The ids look like "area:item"; they are only looked up here.
const MESSAGES = Object.freeze({
  "menu:file": "File",
  "menu:file.subscribe": "Subscribe to Podcast…",
  "menu:file.refresh": "Refresh All Feeds",
  "menu:playback": "Playback",
  "menu:playback.toggle": "Play/Pause",
  "menu:help": "Help",
  "menu:help.guide": "Driftwood Guide",
  "menu:help.status": "Service Status",
  "menu:help.prefs": "Where Are the Preferences?",
});

const t = (id) => MESSAGES[id] ?? id;

module.exports = { ...channels, ...endpoints, t };
