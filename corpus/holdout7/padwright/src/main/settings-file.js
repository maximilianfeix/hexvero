"use strict";
// Compiled from src/main/settings-file.ts.
Object.defineProperty(exports, "__esModule", { value: true });
exports.settingsFile = void 0;
const fs = require("node:fs");
const path = require("node:path");
const electron_1 = require("electron");
const SETTINGS_NAME = "padwright-settings.json";
const DEFAULTS = { firmwareTrack: "stable", telemetry: true, webhookUrl: "", repeatDelayMs: 220 };
function settingsPath() {
    return path.join(electron_1.app.getPath("userData"), SETTINGS_NAME);
}
exports.settingsFile = {
    read() {
        try {
            return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(settingsPath(), "utf8")) };
        }
        catch {
            return { ...DEFAULTS };
        }
    },
    write(patch) {
        const next = { ...this.read(), ...patch };
        fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2));
        return next;
    },
};
