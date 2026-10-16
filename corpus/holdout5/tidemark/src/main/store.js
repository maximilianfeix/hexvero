"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { app } = require("electron");

// Two JSON files in the user data folder: the settings and every local draft by id.
const SETTINGS_FILE = "tidemark-settings.json";
const DRAFTS_FILE = "tidemark-drafts.json";
const DEFAULT_SETTINGS = { project: "", repo: "", theme: "paper", token: "", telemetry: false };

const filePath = (name) => path.join(app.getPath("userData"), name);

function readJson(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath(name), "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(name, value) {
  fs.mkdirSync(app.getPath("userData"), { recursive: true });
  fs.writeFileSync(filePath(name), JSON.stringify(value, null, 2));
}

const settings = {
  read: () => ({ ...DEFAULT_SETTINGS, ...readJson(SETTINGS_FILE, {}) }),
  write(patch) {
    const next = { ...settings.read(), ...patch };
    writeJson(SETTINGS_FILE, next);
    return next;
  },
};

const drafts = {
  all: () => readJson(DRAFTS_FILE, {}),
  get: (id) => drafts.all()[id] ?? null,
  put(release) {
    const all = drafts.all();
    all[release.id] = { ...release, savedAt: new Date().toISOString() };
    writeJson(DRAFTS_FILE, all);
    return all[release.id];
  },
  remove(id) {
    const all = drafts.all();
    delete all[id];
    writeJson(DRAFTS_FILE, all);
  },
};

module.exports = { settings, drafts };
