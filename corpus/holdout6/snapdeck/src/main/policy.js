"use strict";
// Development check: warns when a window ends up with weaker settings than the default we want.
// It reads what a window got; it creates no window.

const EXPECTED = { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true };

function auditWindow(win, label) {
  const actual = win.webContents.getLastWebPreferences();
  for (const [key, want] of Object.entries(EXPECTED))
    if (actual[key] !== want) console.warn(`[policy] ${label}: ${key} is ${actual[key]}, expected ${want}`);
}

module.exports = { auditWindow, EXPECTED };
