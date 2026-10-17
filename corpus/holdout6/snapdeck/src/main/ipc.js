"use strict";
const { ipcMain } = require("electron");
const { Channels } = require("../shared/channels");
const library = require("./library");
const capture = require("./capture");
const services = require("./services");

// Requests from the library window. kind is the ipcMain method to register with:
// "handle" for request/response, "on" for fire-and-forget messages.
const ROUTES = [
  { channel: Channels.LIBRARY_LIST, kind: "handle", fn: () => library.list() },
  { channel: Channels.LIBRARY_DELETE, kind: "handle", fn: (_event, id) => library.remove(id) },
  { channel: Channels.LIBRARY_REVEAL, kind: "on", fn: (_event, id) => library.reveal(id) },
  { channel: Channels.CAPTURE_START, kind: "on", fn: () => capture.start() },
  // "library:export" comes with the zip exporter; it is not routed yet.
];

/** Registers fn so that the renderer gets { ok, value } or { ok: false, error }, never a rejection. */
function handleSafe(channel, fn) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return { ok: true, value: await fn(...args) };
    } catch (error) {
      return { ok: false, error: String(error && error.message ? error.message : error) };
    }
  });
}

function registerRoutes() {
  for (const route of ROUTES) ipcMain[route.kind](route.channel, route.fn);
  handleSafe(Channels.SHOT_SAVE, (shot) => library.save(shot));
  handleSafe(Channels.SHOT_SHARE, (id) => services.shareShot(id));
}

module.exports = { registerRoutes, ROUTES };
