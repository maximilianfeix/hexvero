"use strict";
const path = require("node:path");
const { app, BrowserWindow, ipcMain } = require("electron");
const { Channels } = require("../shared/channels");
const library = require("./library");

const appFile = (name) => path.join(app.getAppPath(), name);

const SECURE_DEFAULTS = Object.freeze({
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
});

/** Options for a document window: prefs are merged over SECURE_DEFAULTS, extra over the frame. */
function windowOptions(preload, prefs = {}, extra = {}) {
  return {
    width: 1100,
    height: 760,
    show: false,
    backgroundColor: "#1d1f24",
    ...extra,
    webPreferences: { ...SECURE_DEFAULTS, preload: appFile(preload), ...prefs },
  };
}

let libraryWindow = null;
const annotators = new Map();

function openLibrary() {
  libraryWindow = new BrowserWindow(windowOptions("preload-library.js", {}, { title: "Snapdeck" }));
  libraryWindow.loadFile("library.html");
  libraryWindow.once("ready-to-show", () => libraryWindow.show());
  libraryWindow.on("closed", () => {
    libraryWindow = null;
  });
  return libraryWindow;
}

function openAnnotator(id) {
  const existing = annotators.get(id);
  if (existing) {
    existing.focus();
    return existing;
  }
  const shot = library.get(id);
  // The annotator preload reads the PNG with fs, which a sandboxed preload cannot do.
  const options = windowOptions("preload-annotator.js", { sandbox: false }, { width: 1280, height: 860 });
  const annotatorWindow = new BrowserWindow(options);
  annotators.set(id, annotatorWindow);
  annotatorWindow.loadFile("annotator.html");
  annotatorWindow.webContents.once("did-finish-load", () => {
    annotatorWindow.webContents.send(Channels.SHOT_LOADED, shot);
  });
  annotatorWindow.once("ready-to-show", () => annotatorWindow.show());
  annotatorWindow.on("closed", () => annotators.delete(id));
  return annotatorWindow;
}

/** The see-through window over one display in which a region is picked. */
function openOverlay(display) {
  const webPreferences = {
    preload: appFile("preload-overlay.js"),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    // The magnifier draws the file:// frame into a canvas and reads it back with
    // getImageData; with web security on, the canvas is tainted and that throws.
    webSecurity: false,
  };
  const overlayWindow = new BrowserWindow({
    ...display.bounds,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences,
  });
  overlayWindow.loadFile("overlay.html");
  return overlayWindow;
}

/** Shows unsaved annotations in the title bar (the dot on macOS). */
function watchAnnotators() {
  ipcMain.on(Channels.ANNOTATOR_DIRTY, (event, dirty) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) win.setDocumentEdited(Boolean(dirty));
  });
}

module.exports = { openLibrary, openAnnotator, openOverlay, watchAnnotators, windowOptions };
