"use strict";
const { app, net, Notification } = require("electron");

const RELEASES = "https://releases.snapdeck.example";
const FEED_URL = `${RELEASES}/feed/stable.json`;

/** Looks at the release feed once per start and shows a notification for a newer version. */
function checkForUpdates() {
  return new Promise((resolve) => {
    const request = net.request(FEED_URL);
    let body = "";
    request.on("response", (response) => {
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        try {
          const feed = JSON.parse(body);
          if (feed.version !== app.getVersion())
            new Notification({ title: "Snapdeck", body: `Version ${feed.version} is available.` }).show();
          resolve(feed);
        } catch {
          resolve(null);
        }
      });
    });
    request.on("error", () => resolve(null));
    request.end();
  });
}

module.exports = { checkForUpdates, RELEASES };
