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
  changed: ChangedItem[];
  /** Matched items that differ only in ignored fields. */
  relocated: number;
  unchanged: number;
  /** Identities shared by more than one item on a side; those items are matched by content. */
  duplicateKeys: number;
  compared: { a: number; b: number };
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
  webPreferences: ["line"],
  endpoints: ["line", "column"],
  storage: ["line", "column"],
  urls: ["line", "column"],
  routes: ["line", "column"],
};

export function positionalFields(collection: string, formats: readonly string[]): string[] {
  // `endpoints` also exists for HAR captures; their rows have no line or column, so the rule
  // has nothing to act on there.
  const lines = SOURCE_LINE_FIELDS[collection];
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
  ipc: [["module", "api", "channel", "line"]],
  webPreferences: [
    ["file", "key"],
    ["file", "key", "line"],
  ],
  cil: [["method", "offset"]],
  contextBridge: [["api", "member"]],
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
  const parts: Array<string | number> = [];
  for (const part of key.split("+")) {
    const v = item[part];
    if (typeof v !== "string" && typeof v !== "number") return undefined;
    parts.push(v);
  }
  return JSON.stringify(parts);
}

/** The same key as people read it: `Type::name`. */
function keyLabel(item: unknown, key: string): string {
  return key
    .split("+")
    .map((part) => String((item as Record<string, unknown>)[part]))
    .join("::");
}

/**
 * A key qualifies when it is present on ≥90% of the items of each side and distinct on ≥90%.
 * Some repetition is normal for a real identity (every gcc ELF lists `crtstuff.c` twice and has
 * a few names in both symbol tables; `.ctor` repeats across types) and is handled by multiset
 * matching; a field that mostly repeats (one `init` per class) is no identity.
 */
function qualifies(sides: Array<Array<Record<string, unknown>>>, key: string): boolean {
  for (const side of sides) {
    if (side.length === 0) continue;
    const values = side.map((o) => keyValue(o, key)).filter((v) => v !== undefined);
    if (values.length < side.length * 0.9) return false;
    if (new Set(values).size < values.length * 0.9) return false;
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
    if (qualifies(sides, key)) return key;
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

export function compareItems(
  left: readonly unknown[],
  right: readonly unknown[],
  options: CompareOptions = {},
): CompareResult {
  const ignored = [...(options.ignore ?? [])];
  const positional = [...(options.positional ?? [])].filter((f) => !ignored.includes(f));
  let field: string | null =
    options.key === undefined ? detectKey(left, right, options.collection) : options.key;
  let keyMissing = false;
  if (field !== null) {
    const key = field;
    if (![...left, ...right].some((item) => keyValue(item, key) !== undefined)) {
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
  /** The item without caller-ignored fields; position fields stay, they are judged per pair. */
  const content = (item: unknown): string => {
    if (!isRecord(item)) return canonical(item);
    const copy: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(item)) if (!ignored.includes(k)) copy[k] = v;
    return canonical(copy);
  };
  /** Content with address-like position fields removed, for matching items that only moved. */
  const withoutPositions = (item: unknown): string => {
    if (!isRecord(item)) return canonical(item);
    const copy: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(item))
      if (!ignored.includes(k) && !(positional.includes(k) && addressLike(v))) copy[k] = v;
    return canonical(copy);
  };
  const l = group(left);
  const r = group(right);
  const added: string[] = [];
  const removed: string[] = [];
  const changed: ChangedItem[] = [];
  const relocatedSample: ChangedItem[] = [];
  let unchanged = 0;
  let relocated = 0;
  let duplicateKeys = 0;
  for (const [typed, { shown, items }] of l) {
    const other = r.get(typed);
    if (!other) {
      for (let i = 0; i < items.length; i++) removed.push(shown);
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
      for (let i = 0; i < goneA.length; i++) removed.push(shown);
      for (let i = 0; i < goneB.length; i++) added.push(shown);
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
    if (isRecord(before) && isRecord(after)) {
      for (const f of [...new Set([...Object.keys(before), ...Object.keys(after)])].toSorted()) {
        if (ignored.includes(f) || canonical(before[f]) === canonical(after[f])) continue;
        if (positional.includes(f) && addressLike(before[f]) && addressLike(after[f]))
          moved.push({ field: f, before: before[f], after: after[f] });
        else diffPaths(before[f], after[f], f, 1, fields);
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
    if (!l.has(typed)) for (let i = 0; i < items.length; i++) added.push(shown);
  return {
    key: field,
    keyMissing,
    ignored,
    positional,
    added,
    removed,
    changed,
    relocated,
    relocatedSample,
    unchanged,
    duplicateKeys,
    compared: { a: left.length, b: right.length },
  };
}
