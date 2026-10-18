"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SyncState = exports.MessageToWebApp = void 0;
var MessageToWebApp;
(function (MessageToWebApp) {
    MessageToWebApp["TimerTick"] = "timer-tick";
    MessageToWebApp["TimerDone"] = "timer-done";
    MessageToWebApp["SyncStatus"] = "sync-status";
    MessageToWebApp["UpdateAvailable"] = "update-available";
    MessageToWebApp["ConsoleLog"] = "console-log";
})(MessageToWebApp || (exports.MessageToWebApp = MessageToWebApp = {}));
var SyncState;
(function (SyncState) {
    SyncState[SyncState["Idle"] = 0] = "Idle";
    SyncState[SyncState["Pulling"] = 1] = "Pulling";
    SyncState[SyncState["Pushing"] = 2] = "Pushing";
    SyncState[SyncState["SignedOut"] = 3] = "SignedOut";
    SyncState[SyncState["Failed"] = 4] = "Failed";
})(SyncState || (exports.SyncState = SyncState = {}));
