"use strict";
// Compiled from src/main/ipc-table.ts. Every renderer-facing channel except the telemetry and
// diagnostics ones (main.js) and flash:cancel (main.js) is registered from this table.
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildTable = buildTable;
exports.registerAll = registerAll;
const electron_1 = require("electron");
const ipc_contract_1 = require("../common/ipc-contract");
const flash_session_1 = require("./flash-session");
const firmware_1 = require("./firmware");
const settings_file_1 = require("./settings-file");
function buildTable(deps) {
    const { bus, windows, sessions } = deps;
    return [
        { channel: ipc_contract_1.Channel.ListDevices, kind: "handle", run: () => bus.list() },
        { channel: ipc_contract_1.Channel.ReadKeymap, kind: "handle", run: ({ deviceId }) => bus.readKeymap(deviceId) },
        {
            channel: ipc_contract_1.Channel.WriteKeymap,
            kind: "handle",
            run: ({ deviceId, layers }) => bus.writeKeymap(deviceId, layers),
        },
        { channel: ipc_contract_1.Channel.GetSettings, kind: "handle", run: () => settings_file_1.settingsFile.read() },
        { channel: ipc_contract_1.Channel.SetSettings, kind: "handle", run: (patch) => settings_file_1.settingsFile.write(patch) },
        {
            channel: ipc_contract_1.Channel.CheckFirmware,
            kind: "handle",
            run: ({ model, channel }) => (0, firmware_1.checkFirmware)(model, channel),
        },
        { channel: ipc_contract_1.Channel.OpenFlasher, kind: "on", run: ({ deviceId }) => windows.openFlasher(deviceId) },
        {
            channel: flash_session_1.FLASH_START,
            kind: "handle",
            run: ({ deviceId, model, version }, event) => {
                const target = electron_1.BrowserWindow.fromWebContents(event.sender);
                const session = new flash_session_1.FlashSession(target);
                sessions.set(deviceId, session);
                return session.run(deviceId, model, version).finally(() => sessions.delete(deviceId));
            },
        },
    ];
}
function registerAll(table) {
    for (const entry of table) {
        if (entry.kind === "handle")
            electron_1.ipcMain.handle(entry.channel, (event, payload) => entry.run(payload ?? {}, event));
        else
            electron_1.ipcMain.on(entry.channel, (event, payload) => entry.run(payload ?? {}, event));
    }
}
