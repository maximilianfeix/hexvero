"use strict";
// Addresses of the Cadence services.
// Compiled by tsc from src/shared/endpoints.ts (module: commonjs, target: es2022).
// MIT licensed, written for this corpus.
Object.defineProperty(exports, "__esModule", { value: true });
exports.SUPPORT_URL = exports.STAGING_API_ROOT = exports.LISTEN_ALONG_URL = exports.UPDATE_FEED = exports.LYRICS_API = exports.API_ROOT = void 0;
/** No trailing slash: every path of the API starts with one. */
exports.API_ROOT = "https://api.cadence.example/v2";
exports.LYRICS_API = "https://lyrics.cadence.example/v1";
exports.UPDATE_FEED = "https://updates.cadence.example/stable/latest.json";
exports.LISTEN_ALONG_URL = "wss://together.cadence.example/socket";
/** Used by the beta channel builds only; this build never selects it. */
exports.STAGING_API_ROOT = "https://staging.api.cadence.example/v2";
/** Opened in the system browser from the help menu. */
exports.SUPPORT_URL = "https://cadence.example/support";
