// Channel names used on both sides of the process boundary.
// MIT licensed, written for this corpus.
"use strict";

module.exports = Object.freeze({
  SEND_MESSAGE: "chat:send-message",
  HISTORY: "chat:history",
  TYPING: "presence:typing",
  // Planned, not wired up anywhere yet.
  ARCHIVE: "chat:archive",
});
