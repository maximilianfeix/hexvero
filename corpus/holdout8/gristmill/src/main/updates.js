"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkForUpdates = checkForUpdates;
const electron_1 = require("electron");
const messages_1 = require("../common/messages");
const UPDATE_FEED = "https://updates.gristmill.example/desktop";
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
function checkForUpdates(getWindow) {
    const retry = (err) => {
        setTimeout(() => checkForUpdates(getWindow), CHECK_EVERY_MS);
        if (err) {
            console.error("Update check failed", err.stack);
        }
    };
    fetch(`${UPDATE_FEED}/${process.platform}-${process.arch}/latest.json`, {
        headers: {
            "X-Gristmill-Version": electron_1.app.getVersion(),
        },
    })
        .then((res) => res.json())
        .then((data) => {
        if (data.version && data.version !== electron_1.app.getVersion()) {
            getWindow()?.webContents.send(messages_1.MessageToWebApp.UpdateAvailable, {
                version: data.version,
                notesUrl: data.notesUrl,
            });
        }
        retry();
    })
        .catch(retry);
}
