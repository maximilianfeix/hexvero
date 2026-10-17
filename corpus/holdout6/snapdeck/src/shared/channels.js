"use strict";
// IPC channel names used by the main process and the annotator preload.
// The library and overlay preloads run sandboxed and cannot require this file;
// they spell the names out, so keep both in step.

const LIBRARY = "library:";

const Channels = Object.freeze({
  LIBRARY_LIST: LIBRARY + "list",
  LIBRARY_DELETE: LIBRARY + "delete",
  LIBRARY_REVEAL: LIBRARY + "reveal",
  SHOT_OPEN: "shot:open",
  SHOT_LOADED: "shot:loaded",
  SHOT_SAVE: "shot:save",
  SHOT_SHARE: "shot:share",
  CAPTURE_START: "capture:start",
  // Sent by the 1.x capture helper. The overlay replaced it and nothing listens any more.
  CAPTURE_DONE: "capture:done",
  PREFS_GET: "prefs:get",
  PREFS_SET: "prefs:set",
  MENU_COMMAND: "menu:command",
  ANNOTATOR_DIRTY: "annotator:dirty",
});

module.exports = { Channels, LIBRARY_PREFIX: LIBRARY };
