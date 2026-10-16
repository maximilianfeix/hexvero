/**
 * Diff of one collection between two targets. Items are matched by an identity
 * field: the caller's `key`, or the first common field that is present and
 * distinct on both sides (`name`, `channel`, `id`, `path`, …), or the whole item
 * as JSON when nothing fits. Matched items whose content differs are `changed`
 * with the paths that differ.
 *
 * Nothing is ignored by default. Two mechanisms can set a difference aside:
 * - `positional`: fields that hold a position in the file for this kind of
 *   collection (a symbol's `value`, a section's `offset`). A difference there is
 *   `relocated` only when both sides look like an address or a number; a `value`
 *   that changes from "old" to "new" is always a content change.
 * - `ignore`: fields the caller explicitly excludes, whatever they contain.
 * Both are echoed in the result, with samples of what was set aside.
 */

export interface FieldChange {
  field: string;
  before: unknown;
  after: unknown;
}

export interface ChangedItem {
  key: string;
  fields: FieldChange[];
  before: unknown;
  after: unknown;
}

export interface CompareOptions {
  /** Identity field (`a+b` for a composite); undefined picks one, null forces full-content matching. */
  key?: string | null | undefined;
  /** Collection name, used to pick a composite identity such as `type+name` for methods. */
  collection?: string | undefined;
  /** Fields excluded from change detection unconditionally (default: none). */
  ignore?: readonly string[] | undefined;
  /** Position fields: differences count as relocation only when both values look like addresses. */
  positional?: readonly string[] | undefined;
  /**
   * What each side read, for collections whose items name the file they come from (`file` or
   * `module`). An item found on one side only is `added` or `removed` only if the other side
   * read that file; otherwise nothing is known about it there and it is `unknown`.
   */
  coverage?: { a?: SideCoverage | null; b?: SideCoverage | null } | undefined;
  /**
   * Sides whose list is only the first part of the collection (a page cut at a size limit). An
   * item found on the other side only may sit in the part that was not compared, so it is
   * `unknown`, never `added` or `removed`.
   */
  cut?: { a?: boolean; b?: boolean } | undefined;
  /**
   * Called with each item found on one side only, as it is listed in `added`, `removed` or
   * `unknown` (same order per list), so a caller can tell apart items that share a label.
   */
  onOneSided?: ((item: unknown, change: "added" | "removed" | "unknown") => void) | undefined;
  /** Items that exist per side when `left`/`right` are only a part (see `cut`); default: their lengths. */
  total?: { a: number; b: number } | undefined;
}

/** A collection family whose values can be unresolved in a file (see `SideCoverage.unresolved`). */
export type UnresolvedFamily = "ipc" | "bridge" | "window" | "endpoint" | "storage";

/** The family of each collection whose one-sided items an unresolved value can explain. */
export const COLLECTION_FAMILY: Readonly<Record<string, UnresolvedFamily>> = {
  ipcChannels: "ipc",
  ipc: "ipc",
  interfaces: "ipc",
  contextBridge: "bridge",
  windows: "window",
  webPreferences: "window",
  endpoints: "endpoint",
  urls: "endpoint",
  storage: "storage",
};

/** Machine codes of `CompareCompleteness.gaps`, in the order they are listed. */
export const COMPLETENESS_GAPS = [
  "budget",
  "scan_partial",
  "files_unread",
  "files_unreadable",
  "values_unresolved",
  "item_truncated",
] as const;

/** How much of both sides a comparison covers, and what keeps it from being whole. */
export interface CompareCompleteness {
  /** Items compared per side and items that exist per side. */
  compared: { a: number; b: number };
  total: { a: number; b: number };
  /** True only when both sides were compared whole AND no coverage gap applies to the result. */
  complete: boolean;
  /** Machine codes, stable: "budget" | "scan_partial" | "files_unread" | "files_unreadable"
   *  | "values_unresolved" | "item_truncated". Empty when complete. */
  gaps: string[];
}

/** Which files an analysis read. */
export interface SideCoverage {
  /** Every file was read; a file not in `read` then does not exist on this side. */
  complete: boolean;
  read: ReadonlySet<string>;
  /** Files that exist but were passed over (too large, not decodable) or read only in part. */
  unreadable: ReadonlySet<string>;
  /** Files (module ids) where a value of this collection family could not be resolved,
   *  e.g. an IPC call whose channel is not a literal. "*" = somewhere, file unknown. */
  unresolved: ReadonlyMap<UnresolvedFamily, ReadonlySet<string>>;
}

/** An item present on one side whose file the other side did not read. */
export interface UnknownItem {
  key: string;
  /** The side the item was found on. */
  side: "a" | "b";
  file: string;
  reason:
    | "file not read on the other side"
    | "file could not be read on the other side"
    | "the other side was read only in part"
    | "the other side was compared only in part"
    | "the other side has values there that could not be resolved";
}

export interface CompareResult {
  /** Field used as identity, or null when items were matched by their full content. */
  key: string | null;
  /** Set when the caller named a key that no item on either side carries. */
  keyMissing: boolean;
  /** Fields the caller excluded from change detection. */
  ignored: string[];
  /** Position fields whose address-like differences were classified as relocation. */
  positional: string[];
  /** Up to 20 relocated items with the position fields that moved, so nothing is set aside unseen. */
  relocatedSample: ChangedItem[];
  /** Item identities (keys) only present on the right side; duplicates listed once per extra item. */
  added: string[];
  removed: string[];
  /**
   * Items found on one side only, in a file the other side did not read: neither added nor
   * removed. Empty unless the caller passed `coverage` or `cut`.
   */
  unknown: UnknownItem[];
  changed: ChangedItem[];
  /** Matched items that differ only in ignored fields. */
  relocated: number;
  unchanged: number;
  /** Identities shared by more than one item on a side; those items are matched by content. */
  duplicateKeys: number;
  /**
   * Items of windows that have no name of their own (`#2`: the second window of the file). They
   * are matched by that position, so a window added before them pairs different windows.
   */
  matchedByPosition: number;
  compared: { a: number; b: number };
  /** Whether both sides were compared whole and nothing the coverage says leaves room for doubt. */
  completeness: CompareCompleteness;
}

/** Formats whose collections carry file positions (addresses, offsets) next to content. */
const NATIVE_FORMATS = new Set(["elf", "pe", "macho", "macho-fat", "wasm"]);

/** Position fields per collection of a native binary. `size` is content and never listed. */
const POSITION_FIELDS: Record<string, readonly string[]> = {
  symbols: ["value"],
  exports: ["value", "rva"],
  sections: ["address", "offset", "rva", "vaddr", "fileOffset", "rawOffset", "virtualAddress"],
  segments: ["offset", "vaddr", "paddr", "vmaddr", "fileoff", "fileOffset"],
  slices: ["offset"],
  methods: ["rva", "implementation"], // .NET method bodies (rva), Objective-C IMPs (implementation)
  swiftSymbols: ["value"],
};

/**
 * Position fields for `collection` when both targets are native binaries; empty otherwise, so
 * an Electron setting or a manifest entry named `value` is never treated as an address.
 */
/**
 * Source-line collections: the line a fact was read from moves whenever code above it changes,
 * so it is a position, not content. These names exist for JavaScript applications only.
 */
const SOURCE_LINE_FIELDS: Record<string, readonly string[]> = {
  contextBridge: ["line"],
  interfaces: ["line"],
  ipc: ["line"],
  webPreferences: ["line", "window"],
  windows: ["line", "window"],
  endpoints: ["line", "column"],
  storage: ["line", "column"],
  urls: ["line", "column"],
  routes: ["line", "column"],
};

/**
 * Source lines nested inside an item, as [field, line field]: the `line` of each end of an
 * interface row, the call-site `lines` of a resolved IPC channel. With the line rules on, those
 * are positions too.
 */
const NESTED_LINE_FIELDS: Record<string, ReadonlyArray<readonly [string, string]>> = {
  interfaces: [["ends", "line"]],
  ipc: [["resolution", "lines"]],
  // the place in another module a window's setting was read from
  webPreferences: [["definedIn", "line"]],
};

/**
 * Fields that only restate, in words, what other fields of the same item already say. A change
 * in them is never a change of its own, and they are not listed as ignored on request.
 */
const DERIVED_FIELDS: Record<string, readonly string[]> = {
  windows: ["basis"],
  // hexvero's explanation of `link` (which blind spots the analysis has): it changes whenever a
  // limitation appears anywhere, while the row itself stays the same; `link` carries the fact
  interfaces: ["reason"],
};

/**
 * Positions in a capture: a HAR request's `index` is where it sits in the log, so two captures
 * of the same requests in another order differ there only. Only HAR targets have `requests`.
 */
const CAPTURE_POSITION_FIELDS: Record<string, readonly string[]> = {
  requests: ["index"],
};

export function positionalFields(collection: string, formats: readonly string[]): string[] {
  // `endpoints` also exists for HAR captures; their rows have no line or column, so the rule
  // has nothing to act on there.
  const lines = SOURCE_LINE_FIELDS[collection] ?? CAPTURE_POSITION_FIELDS[collection];
  if (lines) return [...lines];
  if (formats.length === 0 || !formats.every((f) => NATIVE_FORMATS.has(f))) return [];
  return [...(POSITION_FIELDS[collection] ?? [])];
}

/**
 * Only a number or a `0x…` literal can be a position. Plain text, decimal strings, null and a
 * field present on one side only are content, so "10" → "11" or null → "new" stay changes.
 */
function addressLike(v: unknown): boolean {
  return (
    typeof v === "number" ||
    typeof v === "bigint" ||
    (typeof v === "string" && /^0x[0-9a-fA-F]{1,16}$/.test(v))
  );
}

/** Identity made of several fields for collections whose single fields repeat by nature. */
const COMPOSITE_KEYS: Record<string, readonly string[][]> = {
  methods: [
    ["type", "name"],
    ["class", "name"],
    ["class", "selector"],
  ],
  columns: [["table", "name"]],
  // The same call may occur twice in a file; those repeats are matched as a multiset, and the
  // line is a position (below), so a call that only moved is not reported as removed and added.
  // A single file's rows have no `module`: the API and the channel are the identity there.
  ipc: [
    ["module", "api", "channel"],
    ["api", "channel"],
  ],
  // A file may configure several windows. The variable a window is assigned to tells their
  // settings apart and stays the same when code moves or a window is added before it; the
  // window number is the fallback for an analysis without names.
  webPreferences: [
    ["file", "windowName", "key"],
    ["file", "window", "key"],
    ["file", "key"],
    ["file", "key", "line"],
  ],
  windows: [["file", "windowName"]],
  cil: [["method", "offset"]],
  contextBridge: [["api", "member"]],
  interfaces: [["file", "api", "member"]],
  // The same URL or key in two files is two facts; without a file (a single bundle) it is one.
  endpoints: [
    ["file", "kind", "value"],
    ["kind", "value"],
  ],
  storage: [
    ["file", "kind", "value", "op"],
    ["kind", "value", "op"],
    ["kind", "value"],
  ],
  urls: [["file", "value"], ["value"]],
  // hexvero's own findings: what it found and where, not how the title words it ("… in the
  // scanned part" is added when a scan is partial), so a reworded title is a change
  findings: [["kind", "location"], ["kind"]],
};

/** Paths (dotted, up to three levels) at which two values differ. */
function diffPaths(
  before: unknown,
  after: unknown,
  prefix: string,
  depth: number,
  out: FieldChange[],
): void {
  if (canonical(before) === canonical(after)) return;
  if (depth < 3 && isRecord(before) && isRecord(after)) {
    for (const k of [...new Set([...Object.keys(before), ...Object.keys(after)])].toSorted())
      diffPaths(before[k], after[k], prefix ? `${prefix}.${k}` : k, depth + 1, out);
    return;
  }
  out.push({ field: prefix, before, after });
}

const KEY_CANDIDATES = [
  "name",
  "channel",
  "id",
  "path",
  "url",
  "symbol",
  "selector",
  "host",
  "package",
  "class",
  "module",
  "cpu",
  "key",
  "address",
  "offset",
] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** JSON with sorted object keys and bigints as strings, so equality ignores key order. */
export function canonical(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(sortKeys);
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value).toSorted()) out[k] = sortKeys(value[k]);
    return out;
  }
  return value;
}

/**
 * Typed value of a key that may be composite (`type+name`), or undefined when a part is missing.
 * Parts keep their types and are joined unambiguously, so "a::b"+"c" and "a"+"b::c" differ and
 * 1 is not "1".
 */
function keyValue(item: unknown, key: string): string | undefined {
  if (!isRecord(item)) return undefined;
  const names = key.split("+");
  const parts: Array<string | number | null> = [];
  let known = 0;
  for (const part of names) {
    const v = item[part];
    if (typeof v === "string" || typeof v === "number") {
      parts.push(v);
      known++;
    } else if ((v === null || v === undefined) && names.length > 1) {
      // In a composite key one part may be "none" (a bridge entry without a readable member, a
      // request whose URL is unknown, a storage access without an operation): the item is still
      // identified by the parts it has.
      parts.push(null);
    } else return undefined;
  }
  return known ? JSON.stringify(parts) : undefined;
}

/** The same key as people read it: `Type::name`. */
function keyLabel(item: unknown, key: string): string {
  return (
    key
      .split("+")
      // An absent part and a null one are the same identity (see keyValue), and read the same.
      // The text "null" reads the same too although it is another identity; labels are kept as
      // they are, because they feed row ids (C3) and other rows would get new ids. Rows whose
      // labels collide are told apart by `rowIds` in report.ts instead.
      .map((part) => String((item as Record<string, unknown>)[part] ?? null))
      .join("::")
  );
}

/**
 * The label `compareItems` reports an item under (in `added`, `removed`, `changed[].key`) when it
 * matched by `key`, so a caller can find the item behind a reported key again.
 */
export function itemLabel(item: unknown, key: string | null): string {
  return key !== null && keyValue(item, key) !== undefined ? keyLabel(item, key) : canonical(item);
}

/**
 * A key qualifies when it is present on ≥90% of the items of each side and distinct on ≥90%.
 * Some repetition is normal for a real identity (every gcc ELF lists `crtstuff.c` twice and has
 * a few names in both symbol tables; `.ctor` repeats across types) and is handled by multiset
 * matching; a field that mostly repeats (one `init` per class) is no identity.
 */
function qualifies(
  sides: Array<Array<Record<string, unknown>>>,
  key: string,
  /** The key is the collection's known identity, not a guess from the field names. */
  curated = false,
): boolean {
  for (const side of sides) {
    if (side.length === 0) continue;
    const values = side.map((o) => keyValue(o, key)).filter((v) => v !== undefined);
    if (values.length < side.length * 0.9) return false;
    // In a short list one repeated item is already more than a tenth. A known identity keeps its
    // role there as long as most items are distinct; repeats are matched as multisets.
    const distinct = curated && values.length <= 20 ? 0.5 : 0.9;
    if (new Set(values).size < values.length * distinct) return false;
  }
  return true;
}

/**
 * The identity to match items by: a composite key known for this collection (`type+name` for
 * methods, where `.ctor` repeats per type), else the first single candidate field, so `name` on
 * symbols wins but `selector` on Objective-C methods (one `init` per class) does not.
 */
export function detectKey(
  left: readonly unknown[],
  right: readonly unknown[],
  collection?: string,
): string | null {
  const sides = [left.filter(isRecord), right.filter(isRecord)];
  if (sides.every((s) => s.length === 0)) return null;
  for (const fields of (collection && COMPOSITE_KEYS[collection]) || []) {
    const key = fields.join("+");
    // A part that no item has (an older analysis without the field) rules the key out.
    const everywhere = [...sides[0]!, ...sides[1]!];
    if (fields.some((part) => !everywhere.some((item) => (item[part] ?? null) !== null))) continue;
    if (qualifies(sides, key, true)) return key;
  }
  for (const field of KEY_CANDIDATES) if (qualifies(sides, field)) return field;
  return null;
}

function tally(list: unknown[], by: (x: unknown) => string): Map<string, unknown[]> {
  const m = new Map<string, unknown[]>();
  for (const it of list) {
    const k = by(it);
    const bucket = m.get(k);
    if (bucket) bucket.push(it);
    else m.set(k, [it]);
  }
  return m;
}

/** Multiset pairing of two lists under an equivalence; returns the matched count and both rests. */
function pair(
  as: unknown[],
  bs: unknown[],
  by: (x: unknown) => string,
): [matched: number, restA: unknown[], restB: unknown[]] {
  const ma = tally(as, by);
  const mb = tally(bs, by);
  let matched = 0;
  const restA: unknown[] = [];
  const restB: unknown[] = [];
  for (const [c, items] of ma) {
    const n = Math.min(items.length, mb.get(c)?.length ?? 0);
    matched += n;
    restA.push(...items.slice(n));
  }
  for (const [c, items] of mb)
    restB.push(...items.slice(Math.min(items.length, ma.get(c)?.length ?? 0)));
  return [matched, restA, restB];
}

/**
 * The files an item comes from: its `file` or `module`, or every file a summary row names
 * (`senders` and `receivers` of an IPC channel, `modules`, `files`). Empty when the item names
 * none.
 */
function filesOf(item: unknown): string[] {
  if (!isRecord(item)) return [];
  const single = item["file"] ?? item["module"];
  if (typeof single === "string") return [single];
  const out: string[] = [];
  for (const field of ["senders", "receivers", "modules", "files"]) {
    const list = item[field];
    if (Array.isArray(list)) for (const f of list) if (typeof f === "string") out.push(f);
  }
  return out;
}

export function compareItems(
  left: readonly unknown[],
  right: readonly unknown[],
  options: CompareOptions = {},
): CompareResult {
  const ignored = [...(options.ignore ?? [])];
  const derived = (options.collection && DERIVED_FIELDS[options.collection]) || [];
  const positional = [...(options.positional ?? [])].filter((f) => !ignored.includes(f));
  let field: string | null =
    options.key === undefined ? detectKey(left, right, options.collection) : options.key;
  let keyMissing = false;
  if (field !== null) {
    const key = field;
    // A key is missing when no item has a value for it, or, for a composite key, when one of
    // its parts exists on no item at all (a part may be empty on single items, never on all).
    const everywhere = [...left, ...right];
    const absentPart = key
      .split("+")
      .some((part) => !everywhere.some((item) => isRecord(item) && (item[part] ?? null) !== null));
    if (absentPart || !everywhere.some((item) => keyValue(item, key) !== undefined)) {
      keyMissing = true;
      field = null;
    }
  }
  const keyOf = (item: unknown): [typed: string, shown: string] => {
    const value = field === null ? undefined : keyValue(item, field);
    // No key value: the item is its own identity, minus the fields that only say where it sits,
    // so an entry that merely moved is still the same entry.
    if (value === undefined || field === null)
      return [`j:${withoutPositions(item)}`, canonical(item)];
    return [`k:${value}`, keyLabel(item, field)];
  };
  const group = (items: readonly unknown[]): Map<string, { shown: string; items: unknown[] }> => {
    const m = new Map<string, { shown: string; items: unknown[] }>();
    for (const item of items) {
      const [typed, shown] = keyOf(item);
      const g = m.get(typed);
      if (g) g.items.push(item);
      else m.set(typed, { shown, items: [item] });
    }
    return m;
  };
  const nested =
    (positional.includes("line") && options.collection && NESTED_LINE_FIELDS[options.collection]) ||
    [];
  /** The item with the lines of its nested entries removed, when those count as positions. */
  const strip = (item: unknown): unknown => {
    if (!isRecord(item) || nested.length === 0) return item;
    const copy: Record<string, unknown> = { ...item };
    const drop = (entry: unknown, name: string): unknown => {
      if (!isRecord(entry)) return entry;
      const rest = { ...entry };
      delete rest[name];
      return rest;
    };
    for (const [f, line] of nested) {
      const value = copy[f];
      copy[f] = Array.isArray(value) ? value.map((e) => drop(e, line)) : drop(value, line);
    }
    return copy;
  };
  /** The item without caller-ignored fields; position fields stay, they are judged per pair. */
  const content = (raw: unknown): string => {
    const item = strip(raw);
    if (!isRecord(item)) return canonical(item);
    const copy: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(item))
      if (!ignored.includes(k) && !derived.includes(k)) copy[k] = v;
    return canonical(copy);
  };
  /** Content with address-like position fields removed, for matching items that only moved. */
  const withoutPositions = (raw: unknown): string => {
    const item = strip(raw);
    if (!isRecord(item)) return canonical(item);
    const copy: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(item))
      if (
        !ignored.includes(k) &&
        !derived.includes(k) &&
        !(positional.includes(k) && addressLike(v))
      )
        copy[k] = v;
    return canonical(copy);
  };
  const l = group(left);
  const r = group(right);
  const added: string[] = [];
  const removed: string[] = [];
  const unknown: UnknownItem[] = [];
  const family =
    options.collection === undefined ? undefined : COLLECTION_FAMILY[options.collection];
  /** Records an item found on `side` only: removed/added when the other side read its file. */
  const oneSided = (item: unknown, shown: string, side: "a" | "b"): void => {
    // classify records the item in exactly one list: unknown, or removed/added by its side
    const before = unknown.length;
    classify(item, shown, side);
    options.onOneSided?.(
      item,
      unknown.length > before ? "unknown" : side === "a" ? "removed" : "added",
    );
  };
  const classify = (item: unknown, shown: string, side: "a" | "b"): void => {
    if (side === "a" ? options.cut?.b : options.cut?.a) {
      unknown.push({
        key: shown,
        side,
        file: filesOf(item)[0] ?? "",
        reason: "the other side was compared only in part",
      });
      return;
    }
    const other = side === "a" ? options.coverage?.b : options.coverage?.a;
    if (other) {
      const files = filesOf(item);
      const unreadable = files.find((f) => other.unreadable.has(f));
      if (unreadable !== undefined) {
        unknown.push({
          key: shown,
          side,
          file: unreadable,
          reason: "file could not be read on the other side",
        });
        return;
      }
      if (!other.complete) {
        const unread = files.find((f) => !other.read.has(f));
        // An item that names no file at all cannot be placed: with the other side read only in
        // part, nothing is known about it there.
        if (unread !== undefined || files.length === 0) {
          unknown.push({
            key: shown,
            side,
            file: unread ?? "",
            reason:
              unread === undefined
                ? "the other side was read only in part"
                : "file not read on the other side",
          });
          return;
        }
      }
      // The other side read the file, but a value of this family there could not be resolved
      // (an IPC channel built at run time): the item may well be that value.
      const hidden = family === undefined ? undefined : other.unresolved.get(family);
      if (hidden && hidden.size > 0) {
        const there = hidden.has("*") ? (files[0] ?? "") : files.find((f) => hidden.has(f));
        if (there !== undefined) {
          unknown.push({
            key: shown,
            side,
            file: there,
            reason: "the other side has values there that could not be resolved",
          });
          return;
        }
      }
    }
    (side === "a" ? removed : added).push(shown);
  };
  const changed: ChangedItem[] = [];
  const relocatedSample: ChangedItem[] = [];
  let unchanged = 0;
  let relocated = 0;
  let duplicateKeys = 0;
  for (const [typed, { shown, items }] of l) {
    const other = r.get(typed);
    if (!other) {
      for (const item of items) oneSided(item, shown, "a");
      continue;
    }
    if (items.length > 1 || other.items.length > 1) {
      // Duplicate identities cannot be paired one to one: match exact content first, then content
      // without address-like position fields (those count as relocated), the rest is added/removed.
      duplicateKeys++;
      const [same, restA, restB] = pair(items, other.items, content);
      const [moved, goneA, goneB] = pair(restA, restB, withoutPositions);
      unchanged += same;
      relocated += moved;
      // Which duplicate moved where cannot be told apart, so the sample names the identity only.
      if (moved > 0 && relocatedSample.length < 20)
        relocatedSample.push({ key: shown, fields: [], before: restA, after: restB });
      for (const item of goneA) oneSided(item, shown, "a");
      for (const item of goneB) oneSided(item, shown, "b");
      continue;
    }
    const before = items[0];
    const after = other.items[0];
    if (content(before) === content(after)) {
      unchanged++;
      continue;
    }
    const fields: FieldChange[] = [];
    const moved: FieldChange[] = [];
    const [sb, sa] = [strip(before), strip(after)];
    if (isRecord(sb) && isRecord(sa)) {
      for (const f of [...new Set([...Object.keys(sb), ...Object.keys(sa)])].toSorted()) {
        if (ignored.includes(f) || derived.includes(f)) continue;
        if (canonical(sb[f]) === canonical(sa[f])) continue;
        if (positional.includes(f) && addressLike(sb[f]) && addressLike(sa[f]))
          moved.push({ field: f, before: sb[f], after: sa[f] });
        else diffPaths(sb[f], sa[f], f, 1, fields);
      }
    }
    if (fields.length === 0 && moved.length > 0) {
      relocated++;
      if (relocatedSample.length < 20)
        relocatedSample.push({ key: shown, fields: moved, before, after });
      continue;
    }
    changed.push({ key: shown, fields, before, after });
  }
  for (const [typed, { shown, items }] of r)
    if (!l.has(typed)) for (const item of items) oneSided(item, shown, "b");
  return {
    key: field,
    keyMissing,
    ignored,
    positional,
    added,
    removed,
    unknown,
    changed,
    relocated,
    relocatedSample,
    unchanged,
    duplicateKeys,
    matchedByPosition: field?.split("+").includes("windowName")
      ? [...left, ...right].filter(
          (item) => isRecord(item) && /^#\d+$/.test(String(item["windowName"] ?? "")),
        ).length
      : 0,
    compared: { a: left.length, b: right.length },
    completeness: completenessOf(left.length, right.length, options, family, unknown),
  };
}

function completenessOf(
  a: number,
  b: number,
  options: CompareOptions,
  family: UnresolvedFamily | undefined,
  unknown: readonly UnknownItem[],
): CompareCompleteness {
  const total = options.total ?? { a, b };
  const sides = [options.coverage?.a, options.coverage?.b].filter(
    (c): c is SideCoverage => c !== null && c !== undefined,
  );
  const found = new Set<string>();
  if (options.cut?.a || options.cut?.b || a < total.a || b < total.b) found.add("budget");
  if (sides.some((c) => !c.complete)) found.add("scan_partial");
  if (
    unknown.some(
      (u) =>
        u.reason === "file not read on the other side" ||
        u.reason === "the other side was read only in part",
    )
  )
    found.add("files_unread");
  if (sides.some((c) => c.unreadable.size > 0)) found.add("files_unreadable");
  if (family !== undefined && sides.some((c) => (c.unresolved.get(family)?.size ?? 0) > 0))
    found.add("values_unresolved");
  const gaps = COMPLETENESS_GAPS.filter((g) => found.has(g));
  return { compared: { a, b }, total, complete: gaps.length === 0, gaps };
}
