"use strict";
// Compiled from src/main.ts by tsc 5 (module: commonjs, target: es2022).
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
const ipc_contract_1 = require("./common/ipc-contract");
const device_bus_1 = require("./main/device-bus");
const ipc_table_1 = require("./main/ipc-table");
const menu_1 = require("./main/menu");
const telemetry_1 = require("./main/telemetry");
const windows_1 = require("./main/windows");
const bus = new device_bus_1.DeviceBus();
const sessions = new Map();
const ipc = electron_1.ipcMain;
(0, ipc_table_1.registerAll)((0, ipc_table_1.buildTable)({ bus, windows: windows_1.windows, sessions }));
ipc.on(telemetry_1.TELEMETRY_CHANNEL, (_event, { name, props }) => {
    void (0, telemetry_1.track)(name, props);
});
ipc.on("flash:cancel", (_event, deviceId) => {
    sessions.get(deviceId)?.cancel();
});
ipc.handle("diag:snapshot", () => ({
    versions: process.versions,
    devices: bus.list(),
    flashing: [...sessions.keys()],
    memory: process.memoryUsage(),
}));
bus.on("attach", (device) => {
    windows_1.windows.main?.webContents.send(ipc_contract_1.Channel.DeviceAttached, {
        id: device.id,
        model: device.model,
        firmware: device.firmware,
    });
});
bus.on("detach", (deviceId) => {
    sessions.get(deviceId)?.cancel();
});
electron_1.app.whenReady().then(() => {
    electron_1.Menu.setApplicationMenu((0, menu_1.buildMenu)({ bus, windows: windows_1.windows }));
    windows_1.windows.createMainWindow();
    setTimeout(() => bus.rescan(), 500);
    electron_1.app.on("activate", () => {
        if (electron_1.BrowserWindow.getAllWindows().length === 0)
            windows_1.windows.createMainWindow();
    });
});
electron_1.app.on("window-all-closed", () => {
    if (process.platform !== "darwin")
        electron_1.app.quit();
});
