// Channel names that the main process and the preload script both use, grouped by feature.
// MIT licensed, written for this corpus.
"use strict";

module.exports = {
  settings: {
    get: "settings:get",
    set: "settings:set",
    // Pushed to every page when a setting changes.
    changed: "settings:changed",
  },
  // Export was planned for 1.1 and is not wired up yet.
  exporter: {
    pdf: "export:pdf",
    html: "export:html",
  },
};
