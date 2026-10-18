"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.isRendererStoreKey = exports.store = void 0;
const electron_store_1 = __importDefault(require("electron-store"));
const schema = {
    window: {
        type: "object",
        properties: {
            bounds: { type: "object" },
        },
    },
    ui: {
        type: "object",
        properties: {
            theme: { enum: ["system", "light", "dark"], default: "system" },
            lastView: { type: "string", default: "library" },
            fontScale: { type: "number", default: 1 },
        },
        default: {},
    },
    units: {
        type: "object",
        properties: {
            system: { enum: ["metric", "us"], default: "metric" },
        },
        default: {},
    },
    sync: {
        type: "object",
        properties: {
            token: { type: ["string", "null"] },
            lastPulledAt: { type: "number", default: 0 },
        },
        default: {},
    },
    shopping: {
        type: "object",
        properties: {
            items: { type: "array", default: [] },
        },
        default: {},
    },
};
const migrations = {
    ">=1.4.0": (store) => {
        // 1.3 kept a single top-level "measurement" ("metric" | "imperial").
        const legacy = store.get("measurement");
        if (legacy !== undefined) {
            store.set("units.system", legacy === "imperial" ? "us" : "metric");
            store.delete("measurement");
        }
    },
};
exports.store = new electron_store_1.default({ schema, migrations, clearInvalidConfig: true });
// Keys a renderer may read or write through the store bridge (ipc/store-bridge.ts).
const RENDERER_KEYS = new Set(["ui.theme", "ui.lastView", "ui.fontScale", "units.system"]);
const isRendererStoreKey = (key) => typeof key === "string" && RENDERER_KEYS.has(key);
exports.isRendererStoreKey = isRendererStoreKey;
