"use strict";
const path = require("node:path");
const { app, BrowserWindow } = require("electron");

// Shared by the windows that show release content.
const BASE_PREFS = Object.freeze({
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webSecurity: true,
});

const appFile = (name) => path.join(app.getAppPath(), name);

let editorWindow = null;
let helpWindow = null;

function createEditorWindow() {
  // The editor preload requires shared/channels.js, so it cannot run sandboxed.
  // webSecurity stays off until local release images are served by a protocol handler.
  const webPreferences = Object.assign({}, BASE_PREFS, {
    preload: appFile("preload.js"),
    sandbox: false,
    webSecurity: false,
  });
  editorWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    title: "Tidemark",
    show: false,
    webPreferences,
  });
  editorWindow.once("ready-to-show", () => editorWindow.show());
  editorWindow.on("closed", () => {
    editorWindow = null;
  });
  editorWindow.loadFile("index.html");
  return editorWindow;
}

class PreviewWindow {
  webPreferences = { ...BASE_PREFS, preload: appFile("preload-preview.js") };
  win = null;

  open(parent) {
    if (this.current) {
      this.win.focus();
      return this.win;
    }
    this.win = new BrowserWindow({
      width: 720,
      height: 900,
      parent: parent ?? undefined,
      title: "Preview",
      webPreferences: this.webPreferences,
    });
    this.win.on("closed", () => {
      this.win = null;
    });
    this.win.loadFile("preview.html");
    return this.win;
  }

  get current() {
    return this.win && !this.win.isDestroyed() ? this.win : null;
  }
}

const previewWindow = new PreviewWindow();

function openHelp() {
  if (helpWindow) {
    helpWindow.focus();
    return;
  }
  helpWindow = new BrowserWindow({
    width: 560,
    height: 640,
    resizable: false,
    title: "Markdown help",
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  helpWindow.on("closed", () => {
    helpWindow = null;
  });
  helpWindow.loadFile("help.html");
}

module.exports = {
  createEditorWindow,
  openHelp,
  previewWindow,
  editor: () => editorWindow,
  preview: () => previewWindow.current,
};
