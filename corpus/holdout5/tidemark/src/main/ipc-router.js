"use strict";
const { ipcMain } = require("electron");

/**
 * A thin wrapper around ipcMain. Every invoke handler answers { ok, value } or { ok, error }
 * instead of rejecting, and everything registered can be removed again in one call.
 */
class IpcRouter {
  constructor(name) {
    this.name = name;
    this.channels = new Set();
  }

  handle(channel, fn) {
    this.channels.add(channel);
    ipcMain.handle(channel, async (_event, ...args) => {
      try {
        return { ok: true, value: await fn(...args) };
      } catch (err) {
        console.error(`[${this.name}] ${channel} failed:`, err);
        return { ok: false, error: err.message };
      }
    });
  }

  on(channel, fn) {
    this.channels.add(channel);
    ipcMain.on(channel, (event, ...args) => fn(event, ...args));
  }

  dispose() {
    for (const channel of this.channels) {
      ipcMain.removeHandler(channel);
      ipcMain.removeAllListeners(channel);
    }
    this.channels.clear();
  }
}

module.exports = { IpcRouter };
