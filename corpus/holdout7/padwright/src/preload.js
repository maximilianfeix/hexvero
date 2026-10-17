"use strict";
// Compiled from src/preload.ts. Runs unsandboxed (see main/windows.js) so it can require its
// client and the channel contract.
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
const ipc_contract_1 = require("./common/ipc-contract");
const ipc_client_1 = require("./preload/ipc-client");
function createApi(client) {
    return {
        isMac: process.platform === "darwin",
        listDevices: () => client.invoke(ipc_contract_1.Channel.ListDevices),
        readKeymap: (deviceId) => client.invoke(ipc_contract_1.Channel.ReadKeymap, { deviceId }),
        writeKeymap: (deviceId, layers) => client.invoke(ipc_contract_1.Channel.WriteKeymap, {
            deviceId,
            layers,
            checksum: layers.flat().length,
        }),
        getSettings: () => client.invoke(ipc_contract_1.Channel.GetSettings),
        setSettings: (patch) => client.invoke(ipc_contract_1.Channel.SetSettings, patch),
        checkFirmware: (model, track) => client.invoke(ipc_contract_1.Channel.CheckFirmware, { model, channel: track }),
        openFlasher: (deviceId) => client.send(ipc_contract_1.Channel.OpenFlasher, { deviceId }),
        onDeviceAttached: (listener) => client.subscribe(ipc_contract_1.Channel.DeviceAttached, listener),
        track: (name, props = {}) => client.send("telemetry:event", { name, props }),
    };
}
electron_1.contextBridge.exposeInMainWorld("padwright", createApi(new ipc_client_1.IpcClient("padwright")));
