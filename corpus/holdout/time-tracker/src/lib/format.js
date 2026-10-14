// Formatting helpers used by all three processes.
// MIT licensed, written for this corpus.

const pad = (n) => String(n).padStart(2, "0");

/** 3723000 -> "1:02:03" */
export function formatDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 3600)}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
}

export function formatMoney(amount, currency = "EUR") {
  return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(amount);
}

/** ISO week of a date as "2026-W07". */
export function isoWeek(date) {
  const day = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  day.setUTCDate(day.getUTCDate() + 4 - (day.getUTCDay() || 7));
  const yearStart = Date.UTC(day.getUTCFullYear(), 0, 1);
  return `${day.getUTCFullYear()}-W${pad(Math.ceil(((day - yearStart) / 86400000 + 1) / 7))}`;
}
