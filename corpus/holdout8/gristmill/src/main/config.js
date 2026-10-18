"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.onboardingWinOptions = exports.mainWinOptions = exports.isTesting = exports.isMac = void 0;
const path_1 = __importDefault(require("path"));
exports.isMac = process.platform === "darwin";
const isTesting = () => process.env.GRISTMILL_E2E === "1";
exports.isTesting = isTesting;
exports.mainWinOptions = Object.freeze({
    minWidth: 720,
    minHeight: 480,
    width: 1180,
    height: 760,
    show: false,
    titleBarStyle: "hiddenInset",
    frame: exports.isMac,
    webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: true,
        preload: path_1.default.join(__dirname, "..", "preload.js"),
        ...((0, exports.isTesting)()
            ? undefined
            : {
                // The preload requires ./common/*, which a sandboxed preload cannot do.
                // Sandbox is only turned on in the e2e runs, which use the bundled preload.
                sandbox: false,
            }),
    },
});
// Kept for the first-run tour, which is not shipped yet.
exports.onboardingWinOptions = Object.freeze({
    width: 520,
    height: 640,
    resizable: false,
    webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        preload: path_1.default.join(__dirname, "..", "preload-onboarding.js"),
    },
});
