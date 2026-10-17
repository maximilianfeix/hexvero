"use strict";
const { app, shell } = require("electron");

// Pages may link to these; everything else that tries to open or navigate is dropped.
const ALLOWED_EXTERNAL = ["https://snapdeck.example/", "https://docs.snapdeck.example/"];

function lockNavigation() {
  app.on("web-contents-created", (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      if (ALLOWED_EXTERNAL.some((prefix) => url.startsWith(prefix))) shell.openExternal(url);
      return { action: "deny" };
    });
    contents.on("will-navigate", (event, url) => {
      if (!url.startsWith("file://")) event.preventDefault();
    });
  });
}

module.exports = { lockNavigation };
