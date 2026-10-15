"use strict";
// The options every Lattice window starts from. main.js creates the windows.

const DEFAULT_WEB_PREFERENCES = Object.freeze({
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webSecurity: true,
});

const DEFAULT_FRAME = Object.freeze({
  width: 1280,
  height: 820,
  minWidth: 720,
  minHeight: 480,
  show: false,
  backgroundColor: "#f4f1ea",
});

/**
 * makeWindow({ preload, sandbox, ...more }, frame) returns options for new BrowserWindow().
 * Everything in `more` is spread over the default web preferences, so a caller can change any
 * of them; sandbox stays on unless the caller passes sandbox: false.
 */
function makeWindow({ preload, sandbox, ...more } = {}, frame = {}) {
  return {
    ...DEFAULT_FRAME,
    ...frame,
    webPreferences: {
      ...DEFAULT_WEB_PREFERENCES,
      ...more,
      preload,
      sandbox: sandbox ?? DEFAULT_WEB_PREFERENCES.sandbox,
    },
  };
}

module.exports = { makeWindow, DEFAULT_WEB_PREFERENCES };
