// Channel names shared by the main process and the preload script.
// MIT licensed, written for this corpus.

/** Everything the timer pushes or accepts starts with this. */
export const TIMER_PREFIX = "timer:";

export const Channel = Object.freeze({
  TimerStart: "timer:start",
  TimerStop: "timer:stop",
  InvoiceExport: "invoice:export",
  SyncProgress: "sync:progress",
  ConfigGetSync: "config:get-sync",
  // Reserved for the archive feature. No code path uses it yet.
  ProjectsArchive: "projects:archive",
});
