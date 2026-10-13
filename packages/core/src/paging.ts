import { compact } from "./compact.js";
import { AnalysisError, page, type Page } from "./model.js";

/**
 * Paging contract (the one layer the byte budget is defined on):
 *
 * - `maxBytes` bounds the UTF-8 size of `JSON.stringify(page)`, the collection page object with
 *   its envelope (`collection`, `total`, `offset`, `truncated`, `bytes`, `next`, …). It does not
 *   include what a transport adds around it (MCP wraps the page as a JSON string inside a
 *   JSON-RPC message, which escapes quotes and backslashes).
 * - Valid budgets are integers from MIN_PAGE_BYTES to MAX_PAGE_BYTES. Anything else is rejected
 *   with `invalid_input`; a budget is never raised or lowered silently. `limit` and `offset` must
 *   be finite; `limit` is clamped to 1 … MAX_PAGE_ITEMS and an offset past the end yields an
 *   empty final page.
 * - A page that has items to return always returns at least one, so `next` (the offset of the
 *   following page, or null at the end) always advances. An item that does not fit even alone is
 *   returned in a reduced form: first a structural compaction (long strings cut, long arrays
 *   sampled), otherwise a `{ $truncated, $bytes, $preview }` placeholder. The page then carries
 *   `itemTruncated: true` and `itemBytes`, the size of the full item.
 * - To read such an item in full: request it alone (`offset` = its index, `limit` 1) with
 *   `maxBytes` ≥ `itemBytes` + 512, or export the analysis to a file.
 * - `bytes` is the exact serialized size of the returned page.
 */

export const MIN_PAGE_BYTES = 512;
export const DEFAULT_PAGE_BYTES = 256 * 1024;
export const MAX_PAGE_BYTES = 64 * 1024 * 1024;
export const MAX_PAGE_ITEMS = 2000;

export interface CollectionQuery {
  offset?: number;
  limit?: number;
  /** Case-insensitive substring match against the item's JSON representation. */
  text?: string;
  /** Upper bound for the UTF-8 size of the serialized page (512 … 64 MiB, default 256 KiB). */
  maxBytes?: number;
}

export interface CollectionPage<T = unknown> extends Page<T> {
  collection: string;
  /** Exact UTF-8 size of `JSON.stringify(page)`; never above the requested budget. */
  bytes: number;
  /** Offset of the next page, or null when this page reaches the end. */
  next: number | null;
  /** Set when the first item alone exceeded the budget and was returned in reduced form. */
  itemTruncated?: boolean;
  /** UTF-8 size of that item in full; request it with maxBytes ≥ itemBytes + 512 or export. */
  itemBytes?: number;
}

const replacer = (_key: string, value: unknown): unknown =>
  typeof value === "bigint" ? value.toString() : value;

const sizeOf = (value: unknown): number =>
  Buffer.byteLength(JSON.stringify(value, replacer) ?? "null");

export function pageOf(
  name: string,
  items: readonly unknown[],
  query: CollectionQuery = {},
): CollectionPage {
  const maxBytes = query.maxBytes ?? DEFAULT_PAGE_BYTES;
  if (!Number.isInteger(maxBytes) || maxBytes < MIN_PAGE_BYTES || maxBytes > MAX_PAGE_BYTES)
    throw new AnalysisError(
      "invalid_input",
      `maxBytes must be an integer between ${MIN_PAGE_BYTES} and ${MAX_PAGE_BYTES}`,
      { maxBytes, min: MIN_PAGE_BYTES, max: MAX_PAGE_BYTES },
    );
  let filtered = items;
  if (query.text) {
    const needle = query.text.toLowerCase();
    filtered = items.filter((item) =>
      (JSON.stringify(item, replacer) ?? "").toLowerCase().includes(needle),
    );
  }
  for (const [field, value] of [
    ["limit", query.limit],
    ["offset", query.offset],
  ] as const)
    if (value !== undefined && !Number.isFinite(value))
      throw new AnalysisError("invalid_input", `${field} must be a finite number`, {
        [field]: String(value),
      });
  const limit = Math.min(Math.max(Math.floor(query.limit ?? 100), 1), MAX_PAGE_ITEMS);
  const p = page(filtered, Math.max(0, Math.floor(query.offset ?? 0)), limit);

  // Upper bound for the envelope: every optional field present with its widest value.
  const widest = Number.MAX_SAFE_INTEGER;
  const reserve = sizeOf({
    items: [],
    total: p.total,
    offset: p.offset,
    truncated: false,
    collection: name,
    bytes: widest,
    next: widest,
    itemTruncated: true,
    itemBytes: widest,
  });
  const room = maxBytes - reserve;
  const kept: unknown[] = [];
  let used = 0;
  let itemTruncated = false;
  let itemBytes = 0;
  for (const item of p.items) {
    const size = sizeOf(item) + (kept.length ? 1 : 0); // comma between items
    if (used + size <= room) {
      kept.push(item);
      used += size;
      continue;
    }
    if (kept.length > 0) break;
    // The first item does not fit alone: reduce it so the page still makes progress.
    const reduced = reduceItem(item, room);
    if (reduced === undefined)
      throw new AnalysisError(
        "invalid_input",
        `maxBytes ${maxBytes} cannot hold one item of "${name}"; use at least ${reserve + MIN_PLACEHOLDER}`,
        { maxBytes, required: reserve + MIN_PLACEHOLDER },
      );
    kept.push(reduced);
    used += sizeOf(reduced);
    itemTruncated = true;
    itemBytes = sizeOf(item);
    break;
  }
  const end = p.offset + kept.length;
  const out: CollectionPage = {
    items: kept,
    total: p.total,
    offset: p.offset,
    truncated: end < p.total,
    collection: name,
    bytes: 0,
    next: end < p.total ? end : null,
  };
  if (itemTruncated) {
    out.itemTruncated = true;
    out.itemBytes = itemBytes;
  }
  out.bytes = exactBytes(out);
  if (out.bytes > maxBytes)
    throw new AnalysisError("malformed", "internal error: page exceeded its byte budget", {
      bytes: out.bytes,
      maxBytes,
    });
  return out;
}

/** Size of the page including its own `bytes` field: the digit count is solved, not iterated. */
function exactBytes(out: CollectionPage): number {
  const base = sizeOf({ ...out, bytes: 0 }) - 1;
  for (let digits = 1; digits <= 16; digits++)
    if (String(base + digits).length === digits) return base + digits;
  return base + 16;
}

const MIN_PLACEHOLDER = sizeOf({ $truncated: true, $bytes: Number.MAX_SAFE_INTEGER, $preview: "" });

/**
 * A form of `item` whose JSON is at most `budget` bytes, or undefined when not even the empty
 * placeholder fits. Every candidate is measured after serialization, so UTF-8 width, JSON
 * escaping, long keys and deep nesting cannot push it over.
 */
export function reduceItem(item: unknown, budget: number): unknown {
  if (budget < MIN_PLACEHOLDER) return undefined;
  for (const [maxString, maxItems, maxDepth] of [
    [8192, 50, 6],
    [2048, 20, 5],
    [512, 8, 4],
    [128, 4, 3],
    [48, 2, 2],
  ] as const) {
    const value = compact(item, { maxString, maxItems, maxDepth });
    if (sizeOf(value) <= budget) return value;
  }
  const full = JSON.stringify(item, replacer) ?? "null";
  const placeholder = (chars: number): { $truncated: true; $bytes: number; $preview: string } => {
    let cut = Math.min(chars, full.length);
    // never split a surrogate pair
    if (cut > 0 && cut < full.length && /[\uD800-\uDBFF]/.test(full[cut - 1]!)) cut--;
    return { $truncated: true, $bytes: Buffer.byteLength(full), $preview: full.slice(0, cut) };
  };
  let lo = 0;
  let hi = Math.min(full.length, budget);
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (sizeOf(placeholder(mid)) <= budget) lo = mid;
    else hi = mid - 1;
  }
  const result = placeholder(lo);
  return sizeOf(result) <= budget ? result : undefined;
}
