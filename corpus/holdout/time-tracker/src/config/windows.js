// Window geometry, and the web preferences every window has to start from.
// MIT licensed, written for this corpus.
"use strict";

const secureDefaults = Object.freeze({
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
});

module.exports = {
  secureDefaults,
  main: { width: 1180, height: 760, minWidth: 720, show: false, title: "Punchclock" },
  widget: {
    width: 260,
    height: 96,
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
  },
  invoice: { width: 820, height: 1060, title: "Invoice preview" },
};
