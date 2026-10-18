"use strict";
// Compiled from src/common/ipc-contract.ts by tsc 5 (module: commonjs, target: es2022).
// Shared by the main process and preload.js. preload-flasher.js is sandboxed and cannot
// require this file, so it spells its channel names out.
Object.defineProperty(exports, "__esModule", { value: true });
exports.RESERVED_CHANNELS = exports.FlashStage = exports.Channel = void 0;
var Channel;
(function (Channel) {
    Channel["ListDevices"] = "device:list";
    Channel["DeviceAttached"] = "device:attached";
    Channel["ReadKeymap"] = "keymap:read";
    Channel["WriteKeymap"] = "keymap:write";
    Channel["GetSettings"] = "settings:get";
    Channel["SetSettings"] = "settings:set";
    Channel["CheckFirmware"] = "firmware:check";
    Channel["OpenFlasher"] = "flasher:open";
})(Channel || (exports.Channel = Channel = {}));
var FlashStage;
(function (FlashStage) {
    FlashStage[FlashStage["Erase"] = 0] = "Erase";
    FlashStage[FlashStage["Write"] = 1] = "Write";
    FlashStage[FlashStage["Verify"] = 2] = "Verify";
    FlashStage[FlashStage["Done"] = 3] = "Done";
})(FlashStage || (exports.FlashStage = FlashStage = {}));
// Kept for the macro recorder that was cut from 3.0; nothing registers or sends these.
exports.RESERVED_CHANNELS = ["macro:record", "macro:play"];
