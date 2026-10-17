"use strict";
const { Menu, BrowserWindow, shell } = require("electron");
const { Channels } = require("../shared/channels");

const DOCS_URL = "https://docs.snapdeck.example/shortcuts";

/** Menu items act on whichever window has focus; its page decides what the command means. */
function sendCommand(command) {
  const win = BrowserWindow.getFocusedWindow();
  if (win) win.webContents.send(Channels.MENU_COMMAND, command);
}

function buildMenu() {
  return Menu.buildFromTemplate([
    {
      label: "File",
      submenu: [
        {
          id: "capture:region",
          label: "Capture Region",
          accelerator: "CmdOrCtrl+Shift+2",
          click: () => sendCommand("capture"),
        },
        { label: "Save", accelerator: "CmdOrCtrl+S", click: () => sendCommand("save") },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { label: "Undo Annotation", accelerator: "CmdOrCtrl+Z", click: () => sendCommand("undo") },
        { role: "copy" },
        { role: "paste" },
      ],
    },
    {
      label: "Help",
      submenu: [{ label: "Keyboard Shortcuts", click: () => shell.openExternal(DOCS_URL) }],
    },
  ]);
}

module.exports = { buildMenu };
