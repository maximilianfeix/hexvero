"use strict";
// Defaults every secondary window starts from.
// Compiled by tsc from src/main/window-options.ts (module: commonjs, target: es2022).
// MIT licensed, written for this corpus.
Object.defineProperty(exports, "__esModule", { value: true });
exports.BASE_WEB_PREFERENCES = void 0;
exports.windowOptions = windowOptions;
exports.BASE_WEB_PREFERENCES = {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    spellcheck: false,
};
/**
 * Merges a window's own options over the defaults. webPreferences are merged key by key, so a
 * window names only the preferences in which it differs.
 */
function windowOptions(overrides = {}) {
    return {
        show: false,
        backgroundColor: "#121212",
        autoHideMenuBar: true,
        ...overrides,
        webPreferences: {
            ...exports.BASE_WEB_PREFERENCES,
            ...overrides.webPreferences,
        },
    };
}
