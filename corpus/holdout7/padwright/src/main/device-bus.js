"use strict";
// Compiled from src/main/device-bus.ts. The HID layer is simulated by a loopback transport in
// this build; the real transport speaks the same command names over USB.
Object.defineProperty(exports, "__esModule", { value: true });
exports.DeviceBus = void 0;
const node_events_1 = require("node:events");
class LoopbackTransport {
    constructor() {
        this.log = [];
    }
    send(command, body) {
        this.log.push({ command, body, at: Date.now() });
        return Promise.resolve({ ok: true });
    }
}
class DeviceBus extends node_events_1.EventEmitter {
    constructor(transport = new LoopbackTransport()) {
        super();
        this.transport = transport;
        this.devices = new Map();
        this.keymaps = new Map();
    }
    list() {
        return [...this.devices.values()];
    }
    rescan() {
        const found = [{ id: "pw-0042", model: "pad-12", firmware: "3.1.4" }];
        for (const device of found) {
            if (!this.devices.has(device.id)) {
                this.devices.set(device.id, device);
                this.emit("attach", device);
            }
        }
    }
    readKeymap(deviceId) {
        return this.keymaps.get(deviceId) ?? { layers: [[], [], []] };
    }
    async writeKeymap(deviceId, layers) {
        for (const [index, keys] of layers.entries()) {
            await this.transport.send("layer:set", { deviceId, index, keys });
        }
        await this.transport.send("eeprom:commit", { deviceId });
        this.keymaps.set(deviceId, { layers });
        return { written: layers.length };
    }
    detach(deviceId) {
        if (this.devices.delete(deviceId))
            this.emit("detach", deviceId);
    }
}
exports.DeviceBus = DeviceBus;
