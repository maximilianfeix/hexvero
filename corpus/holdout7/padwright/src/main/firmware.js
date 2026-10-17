"use strict";
// Compiled from src/main/firmware.ts.
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkFirmware = checkFirmware;
exports.downloadImage = downloadImage;
const https = require("node:https");
const electron_1 = require("electron");
const FEED_BASE = "https://firmware.padwright.example/feed";
const DOWNLOAD_BASE = "https://dl.padwright.example/firmware";
// The beta feed moved behind the account login in 3.0; kept for the release script.
const BETA_FEED = "https://beta.firmware.padwright.example/feed/beta.json";
/** Reads the release feed of one track ("stable" or "beta") with node:https. */
function checkFirmware(model, track) {
    const feedUrl = `${FEED_BASE}/${track}.json`;
    return new Promise((resolve, reject) => {
        const req = https.get(feedUrl, { headers: { "x-padwright-client": "desktop/3.2" } }, (res) => {
            let body = "";
            res.setEncoding("utf8");
            res.on("data", (chunk) => (body += chunk));
            res.on("end", () => {
                try {
                    const feed = JSON.parse(body);
                    resolve(feed.releases.find((r) => r.model === model) ?? null);
                }
                catch (err) {
                    reject(err);
                }
            });
        });
        req.on("error", reject);
    });
}
/** Downloads a firmware image through Electron's net module (it honours the system proxy). */
function downloadImage(model, version) {
    return new Promise((resolve, reject) => {
        const request = electron_1.net.request({
            method: "GET",
            url: `${DOWNLOAD_BASE}/${encodeURIComponent(model)}/${version}.bin`,
        });
        const chunks = [];
        request.on("response", (response) => {
            response.on("data", (chunk) => chunks.push(chunk));
            response.on("end", () => resolve(Buffer.concat(chunks)));
        });
        request.on("error", reject);
        request.end();
    });
}
