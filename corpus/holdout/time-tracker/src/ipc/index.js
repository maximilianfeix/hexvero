// One import path for everything IPC.
// MIT licensed, written for this corpus.
import { Channel } from "./channels.js";

export * from "./channels.js";
export { Push } from "./events.js";

/** The one synchronous channel, under the name older call sites use. */
export const ConfigSync = Channel.ConfigGetSync;
