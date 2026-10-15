"use strict";
/**
 * IPC channel names shared by the main process and the library window's preload.
 * The mini player's preload runs in the sandbox and cannot require this file; it writes its
 * names out.
 */

class Library {
  static LIST = "library:list";
  static SUBSCRIBE = "library:subscribe";
  static UNSUBSCRIBE = "library:unsubscribe";
  static REFRESH = "library:refresh";
  static CHANGED = "library:changed";
  // Reserved for the OPML import; nothing registers or calls it yet.
  static IMPORT_OPML = "library:import-opml";
}

class Episodes {
  static LIST = "episodes:list";
  static MARK_PLAYED = "episodes:mark-played";
}

// Every download channel starts with this.
const DOWNLOAD_PREFIX = "download:";

const Downloads = Object.freeze({
  START: "download:start",
  PROGRESS: "download:progress",
});

const Playback = Object.freeze({
  PLAY: "playback:play",
  STATE: "playback:state",
});

const Settings = Object.freeze({
  GET: "settings:get",
  SET: "settings:set",
});

const App = Object.freeze({
  TOPICS: "app:topics",
  MENU: "menu:command",
});

module.exports = { Library, Episodes, DOWNLOAD_PREFIX, Downloads, Playback, Settings, App };
