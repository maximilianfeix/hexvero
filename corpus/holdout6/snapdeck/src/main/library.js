"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { app, shell } = require("electron");
const { ShareClient } = require("./services");

const INDEX_FILE = "snapdeck-library.json";
const indexPath = () => path.join(app.getPath("userData"), INDEX_FILE);
const shotsDir = () => path.join(app.getPath("pictures"), "Snapdeck");
const cache = new Map();

function readIndex() {
  try {
    return JSON.parse(fs.readFileSync(indexPath(), "utf8"));
  } catch {
    return { shots: [] };
  }
}

function writeIndex(index) {
  fs.writeFileSync(indexPath(), JSON.stringify(index, null, 2));
  cache.clear();
}

function list() {
  return readIndex().shots;
}

function get(id) {
  if (cache.has(id)) return cache.get(id);
  const shot = readIndex().shots.find((s) => s.id === id);
  if (shot) cache.set(id, shot);
  return shot;
}

function save(shot) {
  const index = readIndex();
  const at = index.shots.findIndex((s) => s.id === shot.id);
  const next = { ...index.shots[at], ...shot, updatedAt: Date.now() };
  if (at === -1) index.shots.unshift(next);
  else index.shots[at] = next;
  writeIndex(index);
  return next;
}

/** Writes a new capture next to the others and adds it to the index. */
function addCapture(png, region) {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  fs.mkdirSync(shotsDir(), { recursive: true });
  const file = path.join(shotsDir(), `${id}.png`);
  fs.writeFileSync(file, png);
  return save({ id, file, title: "", folder: "inbox", region, createdAt: Date.now() });
}

async function remove(id) {
  const index = readIndex();
  const shot = index.shots.find((s) => s.id === id);
  if (!shot) return false;
  if (shot.shareId) await new ShareClient().revoke(shot.shareId);
  index.shots = index.shots.filter((s) => s.id !== id);
  writeIndex(index);
  fs.rmSync(shot.file, { force: true });
  return true;
}

function reveal(id) {
  const shot = get(id);
  if (shot) shell.showItemInFolder(shot.file);
}

module.exports = { list, get, save, addCapture, remove, reveal };
