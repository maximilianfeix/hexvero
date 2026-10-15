"use strict";
// Addresses the main process talks to.

const API_ROOT = "https://api.driftwood.example/v1";

module.exports = {
  API_ROOT,
  DIRECTORY_URL: `${API_ROOT}/directory/top`,
  ARTWORK_CDN: "https://img.driftwood.example",
  ALERTS_SOCKET: "wss://push.driftwood.example/alerts",
  STATUS_PAGE: "https://status.driftwood.example",
  // Kept for the 1.x migration notes; no request uses it.
  LEGACY_API: "https://api.driftwood.example/v0",
};
