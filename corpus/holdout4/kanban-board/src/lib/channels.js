"use strict";
// Every channel name is made by defineChannels so that all of them read "<area>:<action>".
// Writing them out by hand gave us "board:Move" next to "board-move" in 1.x.

function camel(action) {
  return action.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
}

/**
 * defineChannels("board", ["list", "move"]) returns { list: "board:list", move: "board:move" }.
 * Actions with a dash get a camel-case key: "sign-in" becomes signIn.
 */
function defineChannels(area, actions) {
  const names = {};
  for (const action of actions) names[camel(action)] = `${area}:${action}`;
  return Object.freeze(names);
}

const board = defineChannels("board", ["list", "move", "archive", "changed"]);
const card = defineChannels("card", ["create", "rename", "remove", "link-preview"]);
const lane = defineChannels("lane", ["collapse", "expand", "reorder"]);
const activity = defineChannels("activity", ["push", "clear"]);
const prefs = defineChannels("prefs", ["load", "save"]);
const auth = defineChannels("auth", ["sign-in", "sign-out"]);

module.exports = { defineChannels, board, card, lane, activity, prefs, auth };
