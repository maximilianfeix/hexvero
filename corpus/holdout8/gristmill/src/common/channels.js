"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.IPC_CHANNELS = void 0;
// Requests from a renderer to the main process. Pushes from the main process to a
// renderer are in messages.ts (MessageToWebApp).
exports.IPC_CHANNELS = {
    RECIPES_LIST: "recipes:list",
    RECIPES_GET: "recipes:get",
    RECIPES_SAVE: "recipes:save",
    RECIPES_DELETE: "recipes:delete",
    RECIPES_RENAME: "recipes:rename",
    RECIPES_IMPORT: "recipes:import-url",
    RECIPES_EXPORT_PDF: "recipes:export-pdf",
    SHOPPING_ADD: "shopping:add-recipe",
    SHOPPING_OPEN: "shopping:open",
    SETTINGS_OPEN: "settings:open",
    SYNC_SIGN_IN: "sync:sign-in",
    SYNC_SIGN_OUT: "sync:sign-out",
    SYNC_NOW: "sync:now",
    TIMER_START: "timer:start",
    TIMER_CANCEL: "timer:cancel",
    STORE_GET: "store:get",
    STORE_SET: "store:set",
};
