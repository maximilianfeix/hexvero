import type { ChangeRow, CompareCompleteness, Place, ReleaseComparison } from "./api.js";

export type Kind = ChangeRow["change"];
export const KINDS: readonly Kind[] = ["added", "removed", "changed", "unknown"];

/** Lists the overview counts but the change list does not show row by row (as in core). */
const SUMMARY_ONLY = new Set(["findings", "ipc", "modules", "edges", "limitations"]);

/** The filter of the change list, kept in the page query so Back restores it. */
export interface CompareFilter {
  kinds: Kind[];
  lists: string[];
  bases: string[];
  text: string;
}

/** `none` stands for rows whose parser records no basis. */
export const NO_BASIS = "none";

const listOf = (q: URLSearchParams, key: string): string[] =>
  (q.get(key) ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

export function readFilter(q: URLSearchParams): CompareFilter {
  return {
    kinds: listOf(q, "kind").filter((k): k is Kind => (KINDS as readonly string[]).includes(k)),
    lists: listOf(q, "list"),
    bases: listOf(q, "basis"),
    text: q.get("q") ?? "",
  };
}

/** The query keys for a filter; empty parts are `undefined` so `updateQuery` drops them. */
export function filterQuery(f: CompareFilter): Record<string, string | undefined> {
  return {
    kind: f.kinds.length ? f.kinds.join(",") : undefined,
    list: f.lists.length ? f.lists.join(",") : undefined,
    basis: f.bases.length ? f.bases.join(",") : undefined,
    q: f.text || undefined,
  };
}

export const isFiltered = (f: CompareFilter): boolean =>
  f.kinds.length > 0 || f.lists.length > 0 || f.bases.length > 0 || f.text.trim() !== "";

export const toggle = <T>(list: readonly T[], value: T): T[] =>
  list.includes(value) ? list.filter((v) => v !== value) : [...list, value];

export const basisValue = (row: ChangeRow): string => row.basis ?? NO_BASIS;

export function matches(row: ChangeRow, f: CompareFilter): boolean {
  if (f.kinds.length && !f.kinds.includes(row.change)) return false;
  if (f.lists.length && !f.lists.includes(row.collection)) return false;
  if (f.bases.length && !f.bases.includes(basisValue(row))) return false;
  const needle = f.text.trim().toLowerCase();
  if (!needle) return true;
  return (
    row.key.toLowerCase().includes(needle) ||
    [...row.where, ...(row.whereBefore ?? [])].some((p) => p.file.toLowerCase().includes(needle))
  );
}

/** How often each value occurs in the loaded rows, in first-seen order. */
export function tally(
  rows: readonly ChangeRow[],
  of: (row: ChangeRow) => string,
): [string, number][] {
  const m = new Map<string, number>();
  for (const row of rows) m.set(of(row), (m.get(of(row)) ?? 0) + 1);
  return [...m];
}

/** One figure of the summary bar: a count read from the comparison, and the filter it opens. */
export interface SummaryFigure {
  id: "interfaces" | "windows" | "network" | "open";
  label: string;
  count: number;
  /** The parts of `count`, in words. */
  detail: string;
  filter: Partial<CompareFilter>;
}

const changed = (r: ReleaseComparison, names: readonly string[]) => {
  const out = { added: 0, removed: 0, changed: 0, unknown: 0 };
  for (const c of r.overview.collections)
    if (names.includes(c.collection)) {
      out.added += c.added;
      out.removed += c.removed;
      out.changed += c.changed;
      out.unknown += c.unknown;
    }
  return out;
};

const parts = (counts: Record<string, number>): string => {
  const words = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${k}`);
  return words.length ? words.join(" · ") : "no change";
};

const sum = (c: Record<string, number>): number => Object.values(c).reduce((a, b) => a + b, 0);

/**
 * The facts the summary bar shows, from the overview counts (they cover every row, not only the
 * loaded page). No score: counts and the words that make them up.
 */
export function summarize(r: ReleaseComparison): SummaryFigure[] {
  const interfaces = changed(r, ["interfaces"]);
  const network = changed(r, ["endpoints", "urls"]);
  const directions: Record<string, number> = {};
  for (const w of r.overview.windowChanges)
    directions[w.direction] = (directions[w.direction] ?? 0) + 1;
  const reviewed = r.overview.collections.filter((c) => !SUMMARY_ONLY.has(c.collection));
  const unknown = reviewed.reduce((n, c) => n + c.unknown, 0);
  const limitations = r.limitations.a.length + r.limitations.b.length;
  return [
    {
      id: "interfaces",
      label: "Interfaces",
      count: sum(interfaces),
      detail: parts(interfaces),
      filter: { lists: ["interfaces"] },
    },
    {
      id: "windows",
      label: "Window settings",
      count: r.overview.windowChanges.length,
      detail: parts(directions),
      filter: { lists: ["windows", "webPreferences"] },
    },
    {
      id: "network",
      label: "Network targets",
      count: sum(network),
      detail: parts(network),
      filter: { lists: ["endpoints", "urls"] },
    },
    {
      id: "open",
      label: "Unknown or unresolved",
      count: unknown + limitations,
      detail: `${unknown} unknown row${unknown === 1 ? "" : "s"} · ${limitations} limitation${limitations === 1 ? "" : "s"}`,
      filter: { kinds: ["unknown"] },
    },
  ];
}

/** What one side of a change shows in the evidence panel. */
export type Side =
  | { state: "places"; places: Place[] }
  /** The item is not in this build: nothing to show, and that is the fact. */
  | { state: "absent"; why: string }
  /** The item is there but no file or line was recorded for it on this side. */
  | { state: "unrecorded"; why: string };

const unrecorded = (why: string): Side => ({ state: "unrecorded", why });

const placed = (places: Place[], why: string): Side =>
  places.length ? { state: "places", places } : unrecorded(why);

/** The before and after evidence of a row; never a place that was not recorded. */
export function sidesOf(row: ChangeRow): { before: Side; after: Side } {
  const on = (side: "a" | "b") => row.where.filter((p) => p.side === side);
  switch (row.change) {
    case "added":
      return {
        before: { state: "absent", why: "Not in the before build." },
        after: placed(on("b"), "No source position recorded for this item."),
      };
    case "removed":
      return {
        before: placed(on("a"), "No source position recorded for this item."),
        after: { state: "absent", why: "Not in the after build." },
      };
    case "changed":
      return {
        before: row.whereBefore
          ? placed(row.whereBefore, "No source position recorded for this item.")
          : unrecorded(
              "No source position recorded for the before side: this comparison names the after side only.",
            ),
        after: placed(on("b"), "No source position recorded for this item."),
      };
    case "unknown": {
      const side = row.where[0]?.side;
      const missing: Side = {
        state: "unrecorded",
        why: row.reason
          ? `Not found here, and not established as absent: ${row.reason}.`
          : "Not found here, and not established as absent.",
      };
      if (!side)
        return {
          before: unrecorded("No source position recorded for this item."),
          after: unrecorded("No source position recorded for this item."),
        };
      return side === "a"
        ? { before: placed(on("a"), ""), after: missing }
        : { before: missing, after: placed(on("b"), "") };
    }
  }
}

/** The reading behind a row, in words. */
export function basisWords(basis: string | undefined): string {
  switch (basis) {
    case undefined:
      return "The parser records no basis for items of this list.";
    case "literal":
      return "Read as a literal value in the code.";
    case "inferred":
      return "Inferred: built from a pattern or a computed part, not a literal.";
    case "link direct":
      return "The preload member names the channel directly; the main-process handler on that channel was found.";
    case "link resolved":
      return "The channel was resolved through a constant or variable that could be followed to its value.";
    case "link unresolved":
      return "The channel could not be resolved to a value; which handler it reaches is not established.";
    default:
      return `As the parser read it: ${basis}.`;
  }
}

const GAPS: Record<string, string> = {
  budget: "compared up to the size budget; items beyond it were not compared",
  scan_partial: "a build was read only in part; items in unread files are unknown",
  files_unread: "some files were not read",
  files_unreadable: "some files could not be read",
  values_unresolved: "some values could not be resolved (computed at run time)",
  item_truncated: "an item was too large and was shortened",
  collection_missing: "the list is missing from a build, so nothing in it could be compared",
};

export const gapWords = (code: string): string => GAPS[code] ?? `coverage gap: ${code}`;

const n = (v: number): string => v.toLocaleString("en-US");

/** One collection's completeness in a sentence, or null when it was compared whole. */
export function completenessWords(
  c: CompareCompleteness | undefined,
  partialFlag: boolean,
): string | null {
  if (!c)
    return partialFlag ? "Compared in part: the first 2,000 items per side were compared." : null;
  if (c.complete) return null;
  const counts =
    c.compared.a < c.total.a || c.compared.b < c.total.b
      ? ` Compared ${n(c.compared.a)} of ${n(c.total.a)} items before, ${n(c.compared.b)} of ${n(c.total.b)} after.`
      : "";
  const gaps = c.gaps.length ? c.gaps.map(gapWords).join("; ") : "not compared whole";
  return `Incomplete: ${gaps}.${counts}`;
}

/** Words next to the sign, so a change never depends on color alone. */
export const CHANGE: Record<Kind, { sign: string; word: string }> = {
  added: { sign: "+", word: "added" },
  removed: { sign: "−", word: "removed" },
  changed: { sign: "~", word: "changed" },
  unknown: { sign: "?", word: "unknown" },
};

/** What each reviewed collection means, in the reader's terms. */
export const MEANING: Record<string, string> = {
  interfaces: "What pages can call: preload members with their channel and main-process handler",
  contextBridge: "Members the preload script exposes to web content",
  ipcChannels: "IPC channels with their senders and receivers",
  // the only `ipc` rows a comparison lists: calls whose payload shape (`args`) changed
  ipc: "IPC calls whose payload changed: what a call sends on an existing channel",
  windows: "BrowserWindow settings that decide what a page may do",
  bridgeExposures:
    "Privileged objects (ipcRenderer, shell, Node modules) a preload hands to pages as they are, not wrapped",
  navigationHandlers:
    "setWindowOpenHandler and will-navigate handlers as written; whether they check URLs is not read",
  remoteEnabled:
    "@electron/remote enable and initialize calls, and files that load it; whose webContents is named where read",
  switches:
    "Chromium command-line switches, accepted certificate errors, custom certificate verification and security warnings turned off",
  permissionHandlers:
    "Permission request and check handlers of sessions, and whether they grant every request",
  openExternal: "URLs the app opens in the system's default application (shell.openExternal)",
  csp: "Content Security Policies, in HTML <meta> tags and in response headers set in code",
  dangerousCalls:
    "executeJavaScript and insertCSS calls, with whether the code they run in a page is a literal",
  webviews:
    "<webview> tags (HTML, markup in code, elements created in code) with their attributes, and will-attach-webview listeners",
  protocols:
    "Custom protocols: handlers, schemes registered as privileged with their privileges, and schemes the app is the default client of",
  webPreferences: "webPreferences keys as written in the code",
  endpoints: "Network endpoints the code calls",
  storage: "Storage keys the code reads or writes",
  urls: "URL literals in the code",
  runtime:
    "The Electron runtime the build ships: versions, fuses, ASAR integrity, support status (read from the binary)",
};

export const show = (v: unknown): string => (v === undefined ? "not written" : JSON.stringify(v));
