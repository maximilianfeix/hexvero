"use strict";
// Compiled from src/main/telemetry.ts.
Object.defineProperty(exports, "__esModule", { value: true });
exports.TELEMETRY_CHANNEL = void 0;
exports.track = track;
exports.notifyTeam = notifyTeam;
const settings_file_1 = require("./settings-file");
/** The channel the preload sends usage events on; registered in main.js. */
exports.TELEMETRY_CHANNEL = "telemetry:event";
const TELEMETRY_ORIGIN = "https://telemetry.padwright.example";
const EVENTS_URL = `${TELEMETRY_ORIGIN}/v2/events`;
async function track(name, props) {
    if (!settings_file_1.settingsFile.read().telemetry)
        return;
    await fetch(EVENTS_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, props, at: new Date().toISOString() }),
    });
}
/** Posts a flash result to the team's own webhook, if one is configured in the settings. */
async function notifyTeam(summary) {
    const { webhookUrl } = settings_file_1.settingsFile.read();
    if (!webhookUrl)
        return;
    await fetch(webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: summary }),
    });
}
