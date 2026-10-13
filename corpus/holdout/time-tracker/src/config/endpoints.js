// Where the application talks to. Every address is defined here or written out at its call.
// MIT licensed, written for this corpus.

/** Ends in a slash so that relative paths can be resolved against it. */
export const API_BASE = "https://api.punchclock.example/v3/";

/** Exchange rates are served from their own host. */
export const RATES_HOST = "rates.punchclock.example";

export const STATUS_URL = "https://status.punchclock.example/api/v2/summary.json";

export const links = {
  upload: "https://files.punchclock.example/invoices",
  live: "wss://live.punchclock.example",
  updates: "https://updates.punchclock.example",
  // Shown to the user or handed to the system browser. The application never requests these.
  docs: "https://docs.punchclock.example/",
  pricing: "https://punchclock.example/pricing",
  // The staging API. Nothing selects it.
  staging: "https://staging-api.punchclock.example/v3/",
};
