"use strict";
// Formatting of durations and track titles, used by every process.
// Compiled by tsc from src/shared/time.ts (module: commonjs, target: es2022).
// MIT licensed, written for this corpus.
Object.defineProperty(exports, "__esModule", { value: true });
exports.formatTime = formatTime;
exports.formatTotal = formatTotal;
exports.trackLabel = trackLabel;
const pad = (value) => String(value).padStart(2, "0");
/** 245.3 -> "4:05" */
function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0)
        return "0:00";
    const whole = Math.floor(seconds);
    return `${Math.floor(whole / 60)}:${pad(whole % 60)}`;
}
/** Total length of a list of tracks, "3 h 12 min" or "47 min". */
function formatTotal(tracks) {
    const minutes = Math.round(tracks.reduce((sum, track) => sum + (track.duration ?? 0), 0) / 60);
    if (minutes < 60)
        return `${minutes} min`;
    return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}
function trackLabel(track) {
    if (!track)
        return "Nothing playing";
    return track.artist ? `${track.artist} - ${track.title}` : track.title;
}
