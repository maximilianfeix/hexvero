"use strict";
// Channel names shared by the main process and the editor preload (preload.js).
// preload-preview.js runs sandboxed and cannot require this file; it writes its names out.

const CHANNELS = Object.freeze({
  RELEASES_LIST: "releases:list",
  RELEASE_LOAD: "release:load",
  RELEASE_SAVE: "release:save",
  RELEASE_DELETE: "release:delete",
  SETTINGS_GET: "settings:get",
  SETTINGS_SET: "settings:set",
  PUBLISH_START: "publish:start",
  PUBLISH_PROGRESS: "publish:progress",
  EDITOR_DIRTY: "editor:dirty",
  PREVIEW_OPEN: "preview:open",
  PREVIEW_UPDATE: "preview:update",
  PREVIEW_RENDER: "preview:render",
});

// Every export format has its own invoke channel, export:<format>.
const EXPORT_FORMATS = Object.freeze(["markdown", "html", "json"]);
const exportChannel = (format) => `export:${format}`;

// Kept for the 1.x migration notes. Pull-based sync was removed in 2.0; nothing listens on it.
const LEGACY_SYNC_CHANNEL = "sync:legacy-pull";

module.exports = { CHANNELS, EXPORT_FORMATS, exportChannel, LEGACY_SYNC_CHANNEL };
