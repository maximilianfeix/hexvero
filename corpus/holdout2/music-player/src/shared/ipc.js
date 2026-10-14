"use strict";
// Channel names shared by the main process and the preload script.
// Compiled by tsc from src/shared/ipc.ts (module: commonjs, target: es2022).
// MIT licensed, written for this corpus.
Object.defineProperty(exports, "__esModule", { value: true });
exports.Channels = exports.MINI_ARTWORK = exports.PLAYER_STATE = exports.PLAYER_STATE_CHANGED = void 0;
/** Renderer -> main: the playback state changed (track, position, paused). */
exports.PLAYER_STATE_CHANGED = "player:state-changed";
/** Main -> mini player: the same state, forwarded. */
exports.PLAYER_STATE = "player:state";
/** Mini player -> main: artwork of the current track, as a data URL. */
exports.MINI_ARTWORK = "mini:get-artwork";
exports.Channels = {
    SettingsGet: "settings:get",
    SettingsSet: "settings:set",
    SettingsChanged: "settings:changed",
    PlaylistsList: "playlists:list",
    PlaylistsSave: "playlists:save",
    // Smart playlists were cut from 3.0; the name stays so that old types still compile.
    PlaylistsSmart: "playlists:smart",
};
