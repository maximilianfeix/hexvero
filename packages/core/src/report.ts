import { createHash } from "node:crypto";
import {
  compareItems,
  canonical,
  positionalFields,
  type CompareCompleteness,
  type FieldChange,
  type UnknownItem,
} from "./compare.js";
import { AnalysisError, type Limitation, type TargetInfo } from "./model.js";
import type { CompareAllResult, Session, TargetRecord } from "./session.js";
import { CORE_VERSION } from "./version.js";

/** A place a fact was read from. `line` is absent where the parser records none. */
export interface Place {
  side: "a" | "b";
  file: string;
  line?: number;
  /**
   * What sits there when it is not the item itself: the `handler` of an interface member, a
   * `sender` or `receiver` on a channel, the module a window setting is `definedIn`.
   */
  role?: "handler" | "sender" | "receiver" | "definedIn";
}

/** One difference between two builds, with the places that show it. */
export interface ChangeRow {
  /** Stable id: sha256 hex (first 16) of `${collection}\0${change}\0${identityKey}`; no lines. */
  id: string;
  collection: string;
  change: "added" | "removed" | "changed" | "unknown";
  key: string;
  /**
   * Where the item was read: in b for added and changed items, in a for removed ones; `[]` when
   * the item names no position (never an invented line).
   */
  where: Place[];
  /** For changed rows: where the item was read in a (before). `where` keeps the b side. */
  whereBefore?: Place[];
  /**
   * How the item was read, as the parser says it: `literal`, `inferred` (built from a pattern
   * or a computed part), `link direct` / `resolved` / `unresolved` for interface rows. Absent
   * when the item carries no such field.
   */
  basis?: string;
  fields?: FieldChange[];
  /** For `unknown`: why neither added nor removed could be said. */
  reason?: string;
  /**
   * For `interfaces` rows: the windows that load the member and the channel it uses, as the
   * item in that build names them, so a report can draw window → member → channel → handler.
   */
  trace?: { windows: string[]; channel: string | null };
}

export interface ReleaseComparison {
  hexvero: string;
  a: TargetRecord;
  b: TargetRecord;
  overview: CompareAllResult;
  /**
   * Differences of the collections worth reading, interface collections first: the rows
   * [page.offset, page.offset + page.limit) of all of them.
   */
  changes: ChangeRow[];
  /** Collections not all of whose rows are on this page, with how many are and how many exist. */
  cut: Array<{ collection: string; shown: number; total: number }>;
  /** How complete the comparison of each collection is, including those only one build has. */
  completeness: Record<string, CompareCompleteness>;
  /** Rows are paged per comparison: `changes` holds rows [offset, offset + limit). */
  page: {
    offset: number;
    limit: number;
    total: number;
    next: number | null;
  };
  limitations: { a: Limitation[]; b: Limitation[] };
  /**
   * Set when both builds have the same name (two `app.asar`, two `.app`): names that tell them
   * apart (`buildLabels`), for titles and headers.
   */
  labels?: { a: string; b: string };
}

export interface ReleaseComparisonOptions {
  /** First row to return (default 0). */
  offset?: number | undefined;
  /** Rows to return (default 200, at most 5,000). */
  limit?: number | undefined;
  /** Older name of `limit`. */
  maxRows?: number | undefined;
}

export const DEFAULT_RELEASE_ROWS = 200;
export const MAX_RELEASE_ROWS = 5000;

/** The stable id of a row (C3): no line or position goes into it. */
export function changeRowId(collection: string, change: ChangeRow["change"], key: string): string {
  return createHash("sha256").update(`${collection}\0${change}\0${key}`).digest("hex").slice(0, 16);
}

/**
 * Ids for rows, unique within one comparison. Rows that share collection, change and key (an
 * identity that repeats, or two labels that read the same, such as a part that is absent and a
 * part that is the text "null") are numbered in the order of `order`, the item's content
 * without positions, so the numbering does not depend on where the items sit or in which order
 * they were listed. The first keeps the C3 formula, so a row that does not repeat keeps its id;
 * the n-th (n ≥ 1) hashes `${collection}\0${change}\0${key}\0${n}`.
 */
export function rowIds(
  rows: ReadonlyArray<{
    collection: string;
    change: ChangeRow["change"];
    key: string;
    order: string;
  }>,
): string[] {
  const groups = new Map<string, number[]>();
  rows.forEach((row, i) => {
    const group = `${row.collection}\0${row.change}\0${row.key}`;
    const list = groups.get(group);
    if (list) list.push(i);
    else groups.set(group, [i]);
  });
  const ids: string[] = [];
  for (const [group, members] of groups) {
    const sorted = members.toSorted((x, y) => {
      const [ox, oy] = [rows[x]!.order, rows[y]!.order];
      return ox < oy ? -1 : ox > oy ? 1 : x - y;
    });
    sorted.forEach((i, n) => {
      ids[i] =
        n === 0
          ? changeRowId(rows[i]!.collection, rows[i]!.change, rows[i]!.key)
          : createHash("sha256").update(`${group}\0${n}`).digest("hex").slice(0, 16);
    });
  }
  return ids;
}

/** An item's content without its position fields, the order of rows that share a key. */
function contentOrder(item: unknown, positional: readonly string[]): string {
  if (!isItem(item)) return canonical(item);
  const copy: Item = {};
  for (const [k, v] of Object.entries(item)) if (!positional.includes(k)) copy[k] = v;
  return canonical(copy);
}

/** What a page can reach first, then what the app talks to, then everything else. */
const ORDER = [
  "interfaces",
  "contextBridge",
  "ipcChannels",
  // a call whose payload shape changed (the only `ipc` rows listed)
  "ipc",
  "windows",
  "bridgeExposures",
  "navigationHandlers",
  "remoteEnabled",
  "switches",
  "permissionHandlers",
  "openExternal",
  "csp",
  "dangerousCalls",
  "webPreferences",
  "endpoints",
  "storage",
  "urls",
  // the Electron runtime of a packaged build: versions, fuses, integrity, support
  "runtime",
];
/**
 * Not listed row by row: findings restate the lists in sentences, `ipc` repeats `ipcChannels`
 * call by call (except a call whose payload shape changed, see below), `modules` and `edges`
 * change with every edit.
 */
const SUMMARY_ONLY = new Set(["findings", "ipc", "modules", "edges", "limitations"]);
/** What hexvero writes about a build (its findings, what it could not read), not app content. */
const HEXVERO_OWN = new Set(["findings", "limitations"]);

const rank = (name: string): number => {
  const i = ORDER.indexOf(name);
  return i === -1 ? ORDER.length : i;
};

type Item = Record<string, unknown>;
const isItem = (v: unknown): v is Item => typeof v === "object" && v !== null && !Array.isArray(v);

const differs = (c: CompareAllResult["collections"][number]): boolean =>
  Boolean(c.added || c.removed || c.changed || c.unknown);

/** IPC calls by channel, for the places of a channel row. */
function callsByChannel(ipc: readonly unknown[]): Map<string, Item[]> {
  const out = new Map<string, Item[]>();
  for (const call of ipc) {
    if (!isItem(call) || typeof call["channel"] !== "string") continue;
    const list = out.get(call["channel"]);
    if (list) list.push(call);
    else out.set(call["channel"], [call]);
  }
  return out;
}

/** The places an item names: its own file and line, the ends of an interface row. */
function placesOf(item: unknown, side: "a" | "b", ipc: ReadonlyMap<string, Item[]>): Place[] {
  if (!isItem(item)) return [];
  const out: Place[] = [];
  // an IPC call names its file as `module`
  const file =
    typeof item["file"] === "string"
      ? item["file"]
      : typeof item["module"] === "string" && typeof item["api"] === "string"
        ? item["module"]
        : undefined;
  const line = typeof item["line"] === "number" ? item["line"] : undefined;
  if (file) out.push(line === undefined ? { side, file } : { side, file, line });
  else if (typeof item["location"] === "string") {
    const m = /^(.+?):(\d+)$/.exec(item["location"]);
    out.push(m ? { side, file: m[1]!, line: Number(m[2]) } : { side, file: item["location"] });
  }
  const defined = item["definedIn"];
  if (isItem(defined) && typeof defined["file"] === "string")
    out.push({
      side,
      file: defined["file"],
      ...(typeof defined["line"] === "number" ? { line: defined["line"] } : {}),
      role: "definedIn",
    });
  if (Array.isArray(item["ends"]))
    for (const end of item["ends"])
      if (isItem(end) && typeof end["file"] === "string")
        out.push({
          side,
          file: end["file"],
          ...(typeof end["line"] === "number" ? { line: end["line"] } : {}),
          role: "handler",
        });
  // A channel row names files only; the calls on that channel carry the lines.
  if (typeof item["channel"] === "string" && !file && Array.isArray(item["senders"]))
    for (const call of ipc.get(item["channel"]) ?? [])
      // a call whose method is not read (`ipcMain[route.kind](…)`) is neither end
      if (typeof call["module"] === "string" && !String(call["api"]).endsWith(".[unknown]"))
        out.push({
          side,
          file: call["module"],
          ...(typeof call["line"] === "number" ? { line: call["line"] } : {}),
          role: /^ipcMain\b|\.(on|once|handle|handleOnce)$/.test(String(call["api"]))
            ? "receiver"
            : "sender",
        });
  return out;
}

/** An interface item's windows and channel, when it names them (strings only, as read). */
function traceOf(item: unknown): ChangeRow["trace"] {
  if (!isItem(item)) return undefined;
  const windows = Array.isArray(item["windows"])
    ? item["windows"].filter((w): w is string => typeof w === "string")
    : [];
  const channel = typeof item["channel"] === "string" ? item["channel"] : null;
  return windows.length || channel !== null ? { windows, channel } : undefined;
}

function basisOf(item: unknown): string | undefined {
  if (!isItem(item)) return undefined;
  if (typeof item["evidence"] === "string") return item["evidence"];
  if (typeof item["link"] === "string") return `link ${item["link"]}`;
  if (typeof item["confidence"] === "string") return item["confidence"];
  return undefined;
}

/** The row window an options object asks for; anything not a finite number is refused. */
function pageWindow(options: ReleaseComparisonOptions): { offset: number; limit: number } {
  const limit = options.limit ?? options.maxRows ?? DEFAULT_RELEASE_ROWS;
  const offset = options.offset ?? 0;
  for (const [field, value] of [
    ["limit", limit],
    ["offset", offset],
  ] as const)
    if (!Number.isFinite(value) || value < 0)
      throw new AnalysisError("invalid_input", `${field} must be a non-negative number`, {
        [field]: String(value),
      });
  return {
    offset: Math.floor(offset),
    limit: Math.min(Math.max(Math.floor(limit), 1), MAX_RELEASE_ROWS),
  };
}

/**
 * Compares two builds and returns the differences with the places they were read from: the
 * overview of `compareAll`, then for every collection with differences its added, removed,
 * changed and unknown items, interface collections first. Built from the same whole-collection
 * comparison as `compareCollection`, so it says nothing the per-collection comparison does not.
 * Rows are paged: `changes` is the window `options` asks for, `page` says where it sits.
 */
export async function compareReleases(
  session: Session,
  idA: string,
  idB: string,
  options: ReleaseComparisonOptions = {},
): Promise<ReleaseComparison> {
  const window = pageWindow(options);
  const overview = await session.compareAll(idA, idB);
  const completeness: Record<string, CompareCompleteness> = {};
  for (const c of overview.collections) completeness[c.collection] = c.completeness;
  const differing = overview.collections
    .filter(
      (c) => (c.added || c.removed || c.changed || c.unknown) && !SUMMARY_ONLY.has(c.collection),
    )
    .toSorted((x, y) => rank(x.collection) - rank(y.collection));
  const ipcOf = async (id: string): Promise<Map<string, Item[]>> =>
    callsByChannel("ipc" in (await session.collections(id)) ? await session.items(id, "ipc") : []);
  const [ipcA, ipcB] = await Promise.all([ipcOf(idA), ipcOf(idB)]);
  const rows: ChangeRow[] = [];
  /** Per row, the content its id is ordered by when its key repeats. */
  const orders: string[] = [];
  const formats = [session.get(idA).info.format, session.get(idB).info.format];
  type OneSided = "added" | "removed" | "unknown";
  /** The one-sided items of a comparison, per list, in the order the lists name them. */
  const collect = (): {
    items: Record<OneSided, unknown[]>;
    onOneSided: (item: unknown, change: OneSided) => void;
  } => {
    const items: Record<OneSided, unknown[]> = { added: [], removed: [], unknown: [] };
    return { items, onOneSided: (item, change) => items[change].push(item) };
  };
  const add = (
    collection: string,
    change: ChangeRow["change"],
    key: string,
    item: unknown,
    side: "a" | "b",
    extra: Partial<ChangeRow> = {},
  ): void => {
    const basis = basisOf(item);
    const trace = collection === "interfaces" ? traceOf(item) : undefined;
    orders.push(contentOrder(item, positionalFields(collection, formats)));
    rows.push({
      id: "",
      collection,
      change,
      key,
      where: placesOf(item, side, side === "a" ? ipcA : ipcB),
      ...(basis ? { basis } : {}),
      ...(trace ? { trace } : {}),
      ...extra,
    });
  };
  const unknownRows = (
    collection: string,
    unknown: readonly UnknownItem[],
    items: readonly unknown[],
  ): void => {
    unknown.forEach((u, i) =>
      add(collection, "unknown", u.key, items[i], u.side, { reason: u.reason }),
    );
  };
  for (const { collection } of differing) {
    const { items, onOneSided } = collect();
    const { diff } = await session.compareCollection(idA, idB, collection, { onOneSided });
    // each row gets its own item, also when several items share its label
    diff.added.forEach((key, i) => add(collection, "added", key, items.added[i], "b"));
    diff.removed.forEach((key, i) => add(collection, "removed", key, items.removed[i], "a"));
    // the item as read in b, and where its counterpart was read in a
    for (const c of diff.changed)
      add(collection, "changed", c.key, c.after, "b", {
        fields: c.fields,
        whereBefore: placesOf(c.before, "a", ipcA),
      });
    unknownRows(collection, diff.unknown, items.unknown);
  }
  // A call whose payload shape changed (`args`): `ipcChannels` names the channel, not what is
  // sent on it, so these changed calls are listed; the rest of `ipc` stays summary only.
  if (overview.collections.some((c) => c.collection === "ipc" && c.changed)) {
    const { diff } = await session.compareCollection(idA, idB, "ipc");
    for (const c of diff.changed)
      if (c.fields.some((f) => f.field === "args"))
        add("ipc", "changed", c.key, c.after, "b", {
          fields: c.fields,
          whereBefore: placesOf(c.before, "a", ipcA),
        });
  }
  // A list one build does not have at all (the first endpoint, the first storage key): every
  // item is added or removed, unless the other build may hold it where it was not read.
  const [coverageA, coverageB] = await Promise.all([session.coverage(idA), session.coverage(idB)]);
  for (const [side, names] of [
    ["b", overview.onlyB],
    ["a", overview.onlyA],
  ] as const) {
    const id = side === "b" ? idB : idA;
    for (const collection of names.toSorted((x, y) => rank(x) - rank(y))) {
      const all = await session.items(id, collection);
      const { items, onOneSided } = collect();
      const diff = compareItems(side === "a" ? all : [], side === "b" ? all : [], {
        collection,
        positional: positionalFields(collection, formats),
        coverage: { a: coverageA, b: coverageB },
        onOneSided,
      });
      completeness[collection] = diff.completeness;
      if (SUMMARY_ONLY.has(collection)) continue;
      diff.added.forEach((key, i) => add(collection, "added", key, items.added[i], "b"));
      diff.removed.forEach((key, i) => add(collection, "removed", key, items.removed[i], "a"));
      unknownRows(collection, diff.unknown, items.unknown);
    }
  }
  const ids = rowIds(rows.map((row, i) => ({ ...row, order: orders[i]! })));
  rows.forEach((row, i) => (row.id = ids[i]!));
  const ordered = rows
    .map((row, i) => ({ row, i }))
    .toSorted((x, y) => rank(x.row.collection) - rank(y.row.collection) || x.i - y.i)
    .map((x) => x.row);
  const total = ordered.length;
  const offset = Math.min(window.offset, total);
  const changes = ordered.slice(offset, offset + window.limit);
  const end = offset + changes.length;
  const perCollection = (list: readonly ChangeRow[]): Map<string, number> => {
    const m = new Map<string, number>();
    for (const row of list) m.set(row.collection, (m.get(row.collection) ?? 0) + 1);
    return m;
  };
  const shown = perCollection(changes);
  const cut: ReleaseComparison["cut"] = [];
  for (const [collection, count] of perCollection(ordered))
    if ((shown.get(collection) ?? 0) < count)
      cut.push({ collection, shown: shown.get(collection) ?? 0, total: count });
  const [analysisA, analysisB] = await Promise.all([session.analyze(idA), session.analyze(idB)]);
  const names = await buildLabels(session, idA, idB);
  return {
    hexvero: CORE_VERSION,
    a: session.get(idA),
    b: session.get(idB),
    overview,
    changes,
    cut,
    completeness,
    page: { offset, limit: window.limit, total, next: end < total ? end : null },
    limitations: { a: analysisA.limitations, b: analysisB.limitations },
    ...(names.sameName ? { labels: { a: names.a, b: names.b } } : {}),
  };
}

/**
 * The summary both reports show: collections that differ in the app, and hexvero's own lists
 * (findings, limitations) that differ because its description of each build did.
 */
export function summaryOf(r: ReleaseComparison): {
  differing: CompareAllResult["collections"];
  own: CompareAllResult["collections"];
} {
  // hexvero's own findings and limitations describe the reading, not the app
  return {
    differing: r.overview.collections.filter((c) => differs(c) && !HEXVERO_OWN.has(c.collection)),
    own: r.overview.collections.filter((c) => differs(c) && HEXVERO_OWN.has(c.collection)),
  };
}

/**
 * One sentence of "Not established": hexvero's own words as strings, text from a target as
 * `{ code }` (an identifier, quoted) or `{ data }` (prose such as a limitation's message). Each
 * renderer quotes the target parts its own way.
 */
export type NotePart = string | { code: string } | { data: string };

/** What the comparison could not establish, as both reports list it. */
export function notEstablished(r: ReleaseComparison): NotePart[][] {
  const notes: NotePart[][] = [];
  const unknown = r.changes.filter((c) => c.change === "unknown").length;
  if (unknown)
    notes.push([
      `${unknown} row(s) shown are unknown: found on one side where the other side did not read the file, or has values there it could not resolve. Neither added nor removed.`,
    ]);
  if (r.overview.partialScan.a || r.overview.partialScan.b)
    notes.push([
      "A JavaScript app was read only in part; items in unread files are unknown, not absent. Run `hexvero analyze <path> --all` on both first.",
    ]);
  for (const [collection, c] of Object.entries(r.completeness).toSorted(
    ([x], [y]) => rank(x) - rank(y),
  ))
    if (!c.complete)
      notes.push([
        `${collection} is not whole (${c.gaps.join(", ")}): compared ${c.compared.a} of ${c.total.a} item(s) in a and ${c.compared.b} of ${c.total.b} in b.`,
      ]);
  for (const [side, list] of [
    ["a", r.limitations.a],
    ["b", r.limitations.b],
  ] as const) {
    for (const l of list.slice(0, 20))
      notes.push([`${side}: `, { code: l.code }, " ", { data: l.message }]);
    if (list.length > 20) notes.push([`${side}: ${list.length - 20} more limitation(s).`]);
  }
  notes.push(
    [
      "Absence from a list means hexvero did not find it in the files it read, not that the app cannot do it.",
    ],
    [
      "Values computed at run time are shown as `${…}` or left out; nothing here was observed running.",
    ],
  );
  return notes;
}

/** The sign and word of each kind of change, as both reports show them. */
export const CHANGE_SIGN: Record<ChangeRow["change"], string> = {
  added: "+",
  removed: "−",
  changed: "~",
  unknown: "?",
};

export const baseName = (path: string): string => path.split(/[\\/]/).pop() ?? path;

/** The name a build was given as: the packaged build for an app found inside one. */
export const targetName = (info: TargetInfo): string => baseName(info.container?.path ?? info.path);

/** True when two names read the same, also in two Unicode spellings (NFC and NFD). */
const sameText = (x: string, y: string): boolean => x.normalize("NFC") === y.normalize("NFC");

const segments = (path: string): string[] => path.split(/[\\/]/).filter(Boolean);

/**
 * Names that tell two builds apart. Their file names when those differ; when both are called the
 * same (two `app.asar`, also in two Unicode spellings), the file name with the app's
 * package.json name and version when those differ, else with as many parent directories as it
 * takes, and as a last resort the start of their sha256.
 */
export async function buildLabels(
  session: Session,
  idA: string,
  idB: string,
): Promise<{ a: string; b: string; sameName?: true }> {
  const [infoA, infoB] = [session.get(idA).info, session.get(idB).info];
  const [nameA, nameB] = [targetName(infoA), targetName(infoB)];
  if (!sameText(nameA, nameB)) return { a: nameA, b: nameB };
  const pkg = async (id: string): Promise<string | null> => {
    const { data } = await session.analyze(id);
    const p = data.kind === "javascript-app" ? data.app.package : null;
    return p && (p.name || p.version) ? [p.name, p.version].filter(Boolean).join(" ") : null;
  };
  const [pkgA, pkgB] = await Promise.all([pkg(idA), pkg(idB)]);
  if (pkgA && pkgB && !sameText(pkgA, pkgB))
    return { a: `${nameA} (${pkgA})`, b: `${nameB} (${pkgB})`, sameName: true };
  const [pathA, pathB] = [
    segments(infoA.container?.path ?? infoA.path),
    segments(infoB.container?.path ?? infoB.path),
  ];
  for (let n = 2; n <= Math.max(pathA.length, pathB.length); n++) {
    const [tailA, tailB] = [pathA.slice(-n).join("/"), pathB.slice(-n).join("/")];
    if (!sameText(tailA, tailB)) return { a: tailA, b: tailB, sameName: true };
  }
  return {
    a: `${nameA} (sha256 ${infoA.sha256.slice(0, 12) || "directory"})`,
    b: `${nameB} (sha256 ${infoB.sha256.slice(0, 12) || "directory"})`,
    sameName: true,
  };
}
/**
 * Control characters from a target shown as `\u{…}`: an escape sequence must not reach a terminal
 * that prints the report, and the name stays distinguishable from one without it. Bidi marks,
 * embeddings, overrides and isolates, zero-width characters and the BOM are shown the same way
 * (as in the HTML report), so `evil\u{202e}txt.exe` cannot read as `evilexe.txt`.
 */
export function visibleControls(text: string): string {
  return [...text]
    .map((c) => {
      const n = c.codePointAt(0)!;
      const control =
        (n < 32 && n !== 10 && n !== 13) ||
        (n >= 0x7f && n < 0xa0) ||
        n === 0x061c ||
        (n >= 0x200b && n <= 0x200f) ||
        (n >= 0x2028 && n <= 0x202e) ||
        (n >= 0x2060 && n <= 0x2069) ||
        n === 0xfeff;
      return control ? `\\u{${n.toString(16)}}` : c;
    })
    .join("");
}
/** Text from a target, quoted so it cannot close the code span or start Markdown of its own. */
const code = (text: string): string => {
  // cut first (by code point), then escape: a cut after escaping could split a `\u{…}`
  const flat = visibleControls([...text.replace(/[\r\n]+/g, " ")].slice(0, 300).join(""));
  const longest = Math.max(0, ...(flat.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  const pad = longest ? " " : "";
  return `${fence}${pad}${flat}${pad}${fence}`;
};
/** Prose from a target (a file name, a limitation naming a channel): no Markdown of its own. */
const cell = (text: string): string =>
  visibleControls(text.replace(/[\r\n]+/g, " ")).replace(/[\\`*_[\]<>|]/g, (c) => `\\${c}`);
/**
 * One path a page gains, as a Markdown list item: window → member (place) → channel → handler,
 * then each host whose place is a handler's own file and line. Shared by the release report and
 * `check`'s Markdown; `label` names the member, a host's `label` its host or URL.
 */
export function traceMarkdownLine(
  member: { label: string; where: readonly Place[]; trace?: ChangeRow["trace"] },
  hosts: ReadonlyArray<{ label: string; where: readonly Place[] }>,
): string {
  const at = (p: Place): string => `${p.file}${p.line === undefined ? "" : `:${p.line}`}`;
  const own = member.where.find((p) => p.role === undefined);
  const handlers = member.where.filter((p) => p.role === "handler");
  const steps: string[] = [];
  if (member.trace?.windows.length) steps.push(member.trace.windows.map(code).join(", "));
  steps.push(`${code(member.label)}${own ? ` (${code(at(own))})` : ""}`);
  if (member.trace?.channel) steps.push(code(member.trace.channel));
  for (const h of handlers) steps.push(`handler ${code(at(h))}`);
  for (const host of hosts)
    if (host.where.some((p) => handlers.some((h) => h.file === p.file && h.line === p.line)))
      steps.push(`host ${code(host.label)} on the handler's line`);
  return `- ${steps.join(" → ")}`;
}

/** The note under a list of traces: the host link is read from place, not traced. */
export const TRACE_HOST_NOTE =
  "A host is listed when a new one sits on the same file and line as the handler: an inference from place, not a traced call.";

/** Characters a pasted word must not carry: controls, and bidi and zero-width marks. */
// oxlint-disable-next-line no-control-regex -- finding control characters is the point
const UNSHOWABLE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/;

/**
 * What may go inside double quotes for cmd.exe and PowerShell: an allowlist of ASCII that neither
 * expands nor ends a quoted word in either (PowerShell also reads typographic quotes as quotes).
 */
const WIN32_QUOTABLE = /^[A-Za-z0-9 _.\\/:@+\-()[\]{},=~#]+$/;

/**
 * A word as it can be pasted into a shell, or `<path>` when it cannot be written safely. A word
 * starting with `-` gets `./` so it is not read as an option. POSIX (the default except on
 * Windows): anything beyond a plain path goes in single quotes, a quote inside as '\''. Windows
 * (cmd.exe and PowerShell): double quotes, and `<path>` for a word with `"`, `%`, `!`, `$` or a
 * backtick, which expand or end the quotes there. A word with control characters, or bidi or
 * zero-width marks, is `<path>` on both: dropping them would name another file.
 */
export const shellWord = (
  text: string,
  platform: "posix" | "win32" = typeof process !== "undefined" && process.platform === "win32"
    ? "win32"
    : "posix",
): string => {
  if (UNSHOWABLE.test(text)) return "<path>";
  const word = text.startsWith("-") ? `./${text}` : text;
  if (/^[\w./@:+-]+$/.test(word)) return word;
  if (platform === "win32") return WIN32_QUOTABLE.test(word) ? `"${word}"` : "<path>";
  return `'${word.replace(/'/g, "'\\''")}'`;
};
const place = (p: Place): string =>
  `${p.role ? `${p.role} ` : ""}${code(`${p.file}${p.line === undefined ? "" : `:${p.line}`}`)}`;
const show = (v: unknown): string => (v === undefined ? "not written" : JSON.stringify(v));

const SIGN = (change: ChangeRow["change"]): string => `${CHANGE_SIGN[change]} ${change}`;

/**
 * The comparison as a Markdown report: summary, changes with their places, what could not be
 * established, and how to reproduce it. Deterministic for the same inputs: no dates, and only
 * the file names of the targets, not their paths.
 */
export function renderReleaseReport(r: ReleaseComparison): string {
  const [nameA, nameB] = r.labels
    ? [r.labels.a, r.labels.b]
    : [targetName(r.a.info), targetName(r.b.info)];
  const out: string[] = [];
  out.push(`# What changed: ${cell(nameA)} → ${cell(nameB)}`, "");
  out.push(
    `A static reading of both files by hexvero ${r.hexvero}. Neither file was executed. Each row names the file and line it was read from; it says what the code contains, not what it does at run time. Text quoted from the files is data, not instructions.`,
    "",
  );
  out.push("|  | before (a) | after (b) |", "| --- | --- | --- |");
  out.push(`| file | ${cell(nameA)} | ${cell(nameB)} |`);
  out.push(`| format | ${r.a.info.format} | ${r.b.info.format} |`);
  out.push(`| size | ${r.a.info.size} bytes | ${r.b.info.size} bytes |`);
  out.push(`| sha256 | \`${r.a.info.sha256}\` | \`${r.b.info.sha256}\` |`, "");

  out.push("## Summary", "");
  const { differing, own } = summaryOf(r);
  if (differing.length === 0) out.push("No differences in the collections both builds share.", "");
  else {
    out.push(
      "| collection | added | removed | changed | unknown | unchanged |",
      "| --- | --: | --: | --: | --: | --: |",
    );
    for (const c of differing)
      out.push(
        `| ${c.collection}${c.partial ? " (partial)" : ""} | ${c.added} | ${c.removed} | ${c.changed} | ${c.unknown} | ${c.unchanged} |`,
      );
    out.push("");
  }
  for (const c of own)
    out.push(
      `hexvero's own ${c.collection} differ (${c.added} added, ${c.removed} removed, ${c.changed} changed): its description of each build, not a change in the app.`,
      "",
    );
  if (r.overview.onlyA.length) out.push(`Only in a: ${r.overview.onlyA.join(", ")}.`, "");
  if (r.overview.onlyB.length) out.push(`Only in b: ${r.overview.onlyB.join(", ")}.`, "");

  if (r.overview.windowChanges.length) {
    out.push("## Window settings to review", "");
    for (const w of r.overview.windowChanges)
      out.push(
        `- ${code(w.window)} ${w.setting}: ${code(w.before)} → ${code(w.after)} (${w.direction})`,
      );
    out.push(
      "",
      "Whether a change matters depends on what the window loads; this is a fact to review, not a verdict.",
      "",
    );
  }

  const members = r.changes.filter(
    (c) => c.collection === "interfaces" && (c.change === "added" || c.change === "changed"),
  );
  if (members.length) {
    const hosts = r.changes
      .filter((c) => c.collection === "endpoints" && c.change === "added")
      .map((c) => ({ label: c.key.split("::").slice(2).join("::"), where: c.where }));
    out.push("## New ways pages reach the main process", "");
    for (const row of members)
      out.push(
        traceMarkdownLine(
          { label: row.key.split("::").slice(-2).join("."), where: row.where, trace: row.trace },
          hosts,
        ),
      );
    out.push("", TRACE_HOST_NOTE, "");
  }

  out.push("## Changes", "");
  if (r.page.total === 0) out.push("No row-level changes in the reviewed collections.", "");
  else {
    const range =
      r.page.offset > 0 ? ` (rows ${r.page.offset + 1}–${r.page.offset + r.changes.length})` : "";
    out.push(`${r.changes.length} of ${r.page.total} rows shown${range}.`, "");
  }
  let current = "";
  for (const row of r.changes) {
    if (row.collection !== current) {
      if (current) out.push("");
      current = row.collection;
      out.push(`### ${current}`, "");
    }
    const where = row.where.length
      ? ` — in ${row.where[0]!.side}: ${row.where.slice(0, 6).map(place).join(", ")}${
          row.where.length > 6 ? `, +${row.where.length - 6} more` : ""
        }`
      : "";
    const basis = row.basis ? ` · ${row.basis}` : "";
    out.push(`- **${SIGN(row.change)}** ${code(row.key)}${where}${basis}`);
    for (const f of (row.fields ?? []).slice(0, 6))
      out.push(`  - ${code(f.field)}: ${code(show(f.before))} → ${code(show(f.after))}`);
    if (row.reason) out.push(`  - ${cell(row.reason)}`);
  }
  if (r.changes.length) out.push("");
  for (const c of r.cut) out.push(`- ${c.collection}: ${c.shown} of ${c.total} rows shown.`);
  if (r.cut.length) out.push("");
  if (r.page.next !== null)
    out.push(
      `The other rows: \`hexvero compare <a> <b> --report <file> --offset ${r.page.next} --limit ${r.page.limit}\` (next page), or \`hexvero compare <a> <b> <collection> --json\` for one collection's comparison.`,
      "",
    );
  else if (r.page.offset > 0)
    out.push(`Earlier rows: \`hexvero compare <a> <b> --report <file> --offset 0\`.`, "");

  out.push("## Not established", "");
  const notes = notEstablished(r).map((note) =>
    note
      .map((part) =>
        typeof part === "string" ? part : "code" in part ? code(part.code) : cell(part.data),
      )
      .join(""),
  );
  for (const n of notes) out.push(`- ${n}`);
  out.push("");

  out.push("## Reproduce", "");
  const targets = reproduceTargets(r);
  out.push(
    "```bash",
    `npx hexvero@${r.hexvero} compare ${targets.a} ${targets.b} --report report.md`,
    "```",
    "",
  );
  if (targets.sameName !== undefined) out.push(sameNameNote(r, targets.sameName, cell), "");
  return out.join("\n");
}

/**
 * The two targets as shell words for a reproduce line. Reports hold file names, not directories;
 * when both builds have the same name (two `app.asar`), the names alone would not say which is
 * which, so placeholders stand in and a note says so.
 */
export function reproduceTargets(r: ReleaseComparison): {
  a: string;
  b: string;
  /** Set when both builds have the same file name: the raw name, for the renderer to escape. */
  sameName?: string;
} {
  const [nameA, nameB] = [targetName(r.a.info), targetName(r.b.info)];
  // POSIX on every platform: a report is the same bytes wherever it is written.
  if (!sameText(nameA, nameB))
    return { a: shellWord(nameA, "posix"), b: shellWord(nameB, "posix") };
  return { a: "<before>", b: "<after>", sameName: nameA };
}

/** The note under a reproduce line with placeholders; `quote` escapes the name for the format. */
export function sameNameNote(r: ReleaseComparison, name: string, quote: (s: string) => string) {
  return `Both builds are named ${quote(visibleControls(name))}; pass their paths (sha256 ${r.a.info.sha256.slice(0, 12)}… before, ${r.b.info.sha256.slice(0, 12)}… after).`;
}
