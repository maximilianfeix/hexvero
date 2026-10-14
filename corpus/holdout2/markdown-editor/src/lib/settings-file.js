// The application's settings: one JSON file in the user data folder, written on every change.
// MIT licensed, written for this corpus.
"use strict";

const fs = require("node:fs");
const path = require("node:path");

class SettingsFile {
  constructor(file, defaults) {
    this.file = file;
    this.data = { ...defaults };
    try {
      Object.assign(this.data, JSON.parse(fs.readFileSync(file, "utf8")));
    } catch {
      // First start, or a damaged file: the defaults apply.
    }
  }

  get(key) {
    return this.data[key];
  }

  set(key, value) {
    this.data[key] = value;
    this.flush();
  }

  all() {
    return { ...this.data };
  }

  flush() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }
}

module.exports = { SettingsFile };
