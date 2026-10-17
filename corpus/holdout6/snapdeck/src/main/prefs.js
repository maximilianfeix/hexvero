"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { app } = require("electron");
const { Channels } = require("../shared/channels");

const DEFAULTS = Object.freeze({ format: "png", webhookUrl: "", copyAfterCapture: true });

/** Preferences kept as one JSON file in userData. */
class PrefsService {
  constructor(fileName) {
    this.fileName = fileName;
  }

  get file() {
    return path.join(app.getPath("userData"), this.fileName);
  }

  read() {
    try {
      return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(this.file, "utf8")) };
    } catch {
      return { ...DEFAULTS };
    }
  }

  write(patch) {
    const next = { ...this.read(), ...patch };
    fs.writeFileSync(this.file, JSON.stringify(next, null, 2));
    return next;
  }

  /** Attaches the preference channels to ipcMain (passed in, so tests can hand in a fake). */
  register(ipc) {
    ipc.handle(Channels.PREFS_GET, () => this.read());
    ipc.handle(Channels.PREFS_SET, (_event, patch) => this.write(patch));
  }
}

module.exports = new PrefsService("snapdeck-prefs.json");
