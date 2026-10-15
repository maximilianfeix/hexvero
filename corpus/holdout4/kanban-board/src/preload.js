"use strict";
// Preload of the board window (not sandboxed: it requires ./lib/channels.js).
const { contextBridge, ipcRenderer } = require("electron");
const { board, card, lane, prefs, auth } = require("./lib/channels");

// main.js puts --lattice-window=<token> on this window's command line; the zoom channel is
// named after the token.
const tokenArg = process.argv.find((arg) => arg.startsWith("--lattice-window="));
const zoomChannel = `zoom:${tokenArg ? tokenArg.slice(tokenArg.indexOf("=") + 1) : "none"}`;

function subscribe(channel, listener) {
  const wrapped = (_event, payload) => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

// Reading a property of cardRemote gives a function that invokes the card channel of the same
// name: cardRemote.rename invokes card.rename.
const cardRemote = new Proxy(
  {},
  {
    get(_target, member) {
      const channel = card[member];
      if (!channel) throw new Error(`no card channel for ${String(member)}`);
      return (...args) => ipcRenderer.invoke(channel, ...args);
    },
  },
);

contextBridge.exposeInMainWorld("lattice", {
  version: "2.3.0",
  listBoards: () => ipcRenderer.invoke(board.list),
  moveCard: (cardId, toLane, index) => ipcRenderer.invoke(board.move, cardId, toLane, index),
  archiveBoard: (boardId) => ipcRenderer.invoke(board.archive, boardId),
  onBoardChanged: (listener) => subscribe(board.changed, listener),
  collapseLane: (laneId) => ipcRenderer.send(lane.collapse, laneId),
  expandLane: (laneId) => ipcRenderer.send(lane.expand, laneId),
  reorderLanes: (order) => ipcRenderer.send(lane.reorder, null, order),
  loadPrefs: () => ipcRenderer.invoke(prefs.load),
  savePrefs: (patch) => ipcRenderer.invoke(prefs.save, patch),
  signIn: (token) => ipcRenderer.invoke(auth.signIn, token),
  signOut: () => ipcRenderer.invoke(auth.signOut),
  openImporter: () => ipcRenderer.send("import:open"),
  onZoom: (listener) => subscribe(zoomChannel, listener),
  setZoom: (level) => ipcRenderer.send(zoomChannel, level),
});

contextBridge.exposeInMainWorld("cards", {
  create: cardRemote.create,
  rename: cardRemote.rename,
  remove: cardRemote.remove,
  linkPreview: cardRemote.linkPreview,
});
