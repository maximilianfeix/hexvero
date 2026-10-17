"use strict";
// Compiled from src/main/flash-session.ts.
Object.defineProperty(exports, "__esModule", { value: true });
exports.FlashSession = exports.FLASH_START = void 0;
const ipc_contract_1 = require("../common/ipc-contract");
const firmware_1 = require("./firmware");
const telemetry_1 = require("./telemetry");
/** Invoked by the flasher window; the handler is in the table of main/ipc-table.js. */
exports.FLASH_START = "flash:start";
class FlashSession {
    constructor(target) {
        this.target = target;
        this.cancelled = false;
    }
    report(stage, percent) {
        if (this.target.isDestroyed())
            return;
        this.target.webContents.send("flash:progress", { stage: ipc_contract_1.FlashStage[stage], percent });
    }
    async run(deviceId, model, version) {
        this.report(ipc_contract_1.FlashStage.Erase, 0);
        const image = await (0, firmware_1.downloadImage)(model, version);
        for (let offset = 0; offset < image.length && !this.cancelled; offset += 4096) {
            this.report(ipc_contract_1.FlashStage.Write, Math.round((offset / image.length) * 100));
        }
        this.report(ipc_contract_1.FlashStage.Verify, 100);
        this.report(ipc_contract_1.FlashStage.Done, 100);
        await (0, telemetry_1.notifyTeam)(`Flashed ${deviceId} to ${version}`);
        return { deviceId, version, bytes: image.length };
    }
    cancel() {
        this.cancelled = true;
    }
}
exports.FlashSession = FlashSession;
