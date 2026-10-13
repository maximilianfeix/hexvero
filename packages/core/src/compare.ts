/**
 * Diff of one collection between two targets. Items are matched by an identity
 * field: the caller's `key`, or the first common field that is present and
 * distinct on both sides (`name`, `channel`, `id`, `path`, …), or the whole item
 * as JSON when nothing fits. Matched items whose content differs are `changed`
 * with the fields that differ; fields that move between any two builds anyway
 * (addresses, offsets) are ignored unless the caller says otherwise, so a symbol
 * whose address moved is `relocated`, not changed.
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
  /** Identity field; undefined picks one, null forces full-content matching. */
  key?: string | null | undefined;
  /** Fields whose differences do not count as a change (default: VOLATILE_FIELDS). */
  ignore?: readonly string[] | undefined;
}

export interface CompareResult {
  /** Field used as identity, or null when items were matched by their full content. */
  key: string | null;
  /** Set when the caller named a key that no item on either side carries. */
  keyMissing: boolean;
  /** Fields excluded from change detection. */
  ignored: string[];
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

/** Fields that differ between any two builds without meaning anything changed. */
export const VOLATILE_FIELDS = [
  "address",
  "value",
  "offset",
  "rva",
  "vaddr",
  "paddr",
  "fileOffset",
  "start",
  "end",
] as const;

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

const typedKey = (v: unknown): string => (typeof v === "number" ? `n:${v}` : `s:${String(v)}`);

/**
 * First candidate field that is a string or number on at least 90% of the items of each side
 * and distinct on at least 99% of them, so `name` on symbols wins but `selector` on Objective-C
 * methods (one `init` per class) does not.
 */
export function detectKey(left: readonly unknown[], right: readonly unknown[]): string | null {
  const sides = [left.filter(isRecord), right.filter(isRecord)];
  if (sides.every((s) => s.length === 0)) return null;
  for (const field of KEY_CANDIDATES) {
    let ok = true;
    for (const side of sides) {
      if (side.length === 0) continue;
      const values = side
        .map((o) => o[field])
        .filter((v) => typeof v === "string" || typeof v === "number");
      if (values.length < side.length * 0.9) {
        ok = false;
        break;
      }
      if (new Set(values.map(typedKey)).size < values.length * 0.99) {
        ok = false;
        break;
      }
    }
    if (ok) return field;
  }
  return null;
}

export function compareItems(
  left: readonly unknown[],
  right: readonly unknown[],
  options: CompareOptions = {},
): CompareResult {
  const ignored = [...(options.ignore ?? VOLATILE_FIELDS)];
  let field: string | null = options.key === undefined ? detectKey(left, right) : options.key;
  let keyMissing = false;
  if (field !== null) {
    const carries = (item: unknown): boolean => isRecord(item) && field !== null && field in item;
    if (![...left, ...right].some(carries)) {
      keyMissing = true;
      field = null;
    }
  }
  const keyOf = (item: unknown): [typed: string, shown: string] =>
    field !== null && isRecord(item) && field in item
      ? [typedKey(item[field]), String(item[field])]
      : [`j:${canonical(item)}`, canonical(item)];
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
  const stripped = (item: unknown): string => {
    if (!isRecord(item)) return canonical(item);
    const copy: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(item)) if (!ignored.includes(k)) copy[k] = v;
    return canonical(copy);
  };
  const l = group(left);
  const r = group(right);
  const added: string[] = [];
  const removed: string[] = [];
  const changed: ChangedItem[] = [];
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
      // duplicate identities: a multiset diff of the content, counted per item
      duplicateKeys++;
      const a = new Map<string, number>();
      for (const it of items) a.set(stripped(it), (a.get(stripped(it)) ?? 0) + 1);
      const b = new Map<string, number>();
      for (const it of other.items) b.set(stripped(it), (b.get(stripped(it)) ?? 0) + 1);
      for (const [c, n] of a) {
        const m = b.get(c) ?? 0;
        unchanged += Math.min(n, m);
        for (let i = m; i < n; i++) removed.push(shown);
      }
      for (const [c, m] of b) {
        const n = a.get(c) ?? 0;
        for (let i = n; i < m; i++) added.push(shown);
      }
      continue;
    }
    const before = items[0];
    const after = other.items[0];
    if (stripped(before) === stripped(after)) {
      if (canonical(before) === canonical(after)) unchanged++;
      else relocated++;
      continue;
    }
    const fields: FieldChange[] = [];
    if (isRecord(before) && isRecord(after)) {
      for (const f of [...new Set([...Object.keys(before), ...Object.keys(after)])].toSorted())
        if (!ignored.includes(f) && canonical(before[f]) !== canonical(after[f]))
          fields.push({ field: f, before: before[f], after: after[f] });
    }
    changed.push({ key: shown, fields, before, after });
  }
  for (const [typed, { shown, items }] of r)
    if (!l.has(typed)) for (let i = 0; i < items.length; i++) added.push(shown);
  return {
    key: field,
    keyMissing,
    ignored,
    added,
    removed,
    changed,
    relocated,
    unchanged,
    duplicateKeys,
    compared: { a: left.length, b: right.length },
  };
}
