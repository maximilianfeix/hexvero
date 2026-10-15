"use strict";
// Pure functions over a board: { id, title, archived, lanes: [{ id, title, collapsed, cards }] }.
// Nothing here touches Electron, the disk or the network.

const crypto = require("node:crypto");

const newId = (prefix) => `${prefix}_${crypto.randomBytes(5).toString("hex")}`;

function demoBoard() {
  const lane = (title, cards) => ({
    id: newId("lane"),
    title,
    collapsed: false,
    cards: cards.map((text) => ({ id: newId("card"), title: text, links: [] })),
  });
  return {
    id: newId("board"),
    title: "Getting started",
    archived: false,
    lanes: [
      lane("To do", ["Drag me to Doing", "Paste a link into a card"]),
      lane("Doing", ["Import your Trello export"]),
      lane("Done", []),
    ],
  };
}

function summary(board) {
  return {
    id: board.id,
    title: board.title,
    archived: board.archived,
    lanes: board.lanes.map((l) => ({ ...l, count: l.cards.length })),
  };
}

const mapLanes = (board, fn) => ({ ...board, lanes: board.lanes.map(fn) });

function moveCard(board, cardId, toLane, index) {
  let moving = null;
  const without = mapLanes(board, (l) => {
    const found = l.cards.find((c) => c.id === cardId);
    if (found) moving = found;
    return { ...l, cards: l.cards.filter((c) => c.id !== cardId) };
  });
  if (!moving) return board;
  return mapLanes(without, (l) => {
    if (l.id !== toLane) return l;
    const cards = [...l.cards];
    cards.splice(Math.max(0, Math.min(index, cards.length)), 0, moving);
    return { ...l, cards };
  });
}

const setCollapsed = (board, laneId, collapsed) =>
  mapLanes(board, (l) => (l.id === laneId ? { ...l, collapsed } : l));

function reorderLanes(board, order) {
  const byId = new Map(board.lanes.map((l) => [l.id, l]));
  return { ...board, lanes: order.map((id) => byId.get(id)).filter(Boolean) };
}

const addCard = (board, laneId, title) =>
  mapLanes(board, (l) =>
    l.id === laneId ? { ...l, cards: [...l.cards, { id: newId("card"), title, links: [] }] } : l,
  );

const renameCard = (board, cardId, title) =>
  mapLanes(board, (l) => ({
    ...l,
    cards: l.cards.map((c) => (c.id === cardId ? { ...c, title } : c)),
  }));

const removeCard = (board, cardId) =>
  mapLanes(board, (l) => ({ ...l, cards: l.cards.filter((c) => c.id !== cardId) }));

/** Rows from the importer: { list, name }. Unknown lists become new lanes at the end. */
function importRows(board, rows) {
  let next = board;
  for (const row of rows) {
    let target = next.lanes.find((l) => l.title === row.list);
    if (!target) {
      target = { id: newId("lane"), title: row.list, collapsed: false, cards: [] };
      next = { ...next, lanes: [...next.lanes, target] };
    }
    next = addCard(next, target.id, row.name);
  }
  return next;
}

module.exports = {
  demoBoard,
  summary,
  moveCard,
  setCollapsed,
  reorderLanes,
  addCard,
  renameCard,
  removeCard,
  importRows,
};
