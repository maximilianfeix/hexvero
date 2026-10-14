/**
 * Produces a context-friendly projection of an analysis: long arrays keep a
 * sample plus a count, long strings are cut, nested depth is bounded. Callers
 * fetch full lists through paged collections instead.
 */
export interface CompactOptions {
  maxItems?: number;
  maxString?: number;
  maxDepth?: number;
}

export function compact(value: unknown, options: CompactOptions = {}, depth = 0): unknown {
  const maxItems = options.maxItems ?? 8;
  const maxString = options.maxString ?? 300;
  const maxDepth = options.maxDepth ?? 6;
  if (value === null || value === undefined) return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string")
    return value.length > maxString
      ? `${value.slice(0, maxString)}… (+${value.length - maxString} chars)`
      : value;
  if (typeof value !== "object") return value;
  if (depth >= maxDepth) return Array.isArray(value) ? `[${value.length} items]` : "{…}";
  if (Array.isArray(value)) {
    if (value.length <= maxItems) return value.map((v) => compact(v, options, depth + 1));
    return {
      $count: value.length,
      $sample: value.slice(0, maxItems).map((v) => compact(v, options, depth + 1)),
      $note: `${value.length - maxItems} more; use the matching collection to page through all items`,
    };
  }
  if (value instanceof Uint8Array) return `<${value.length} bytes>`;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>))
    out[k] = compact(v, options, depth + 1);
  return out;
}

/**
 * The facts of an analysis without its lists: scalars and small objects stay, a list of
 * records becomes its length (the matching collection pages through it), a short list of plain
 * values stays. This is what an agent reads first; it costs a fraction of `compact`.
 */
export function brief(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return value.length > 200 ? `${value.slice(0, 200)}…` : value;
  if (typeof value !== "object") return value;
  if (value instanceof Uint8Array) return `<${value.length} bytes>`;
  if (Array.isArray(value)) {
    const plain = value.every((v) => v === null || typeof v !== "object");
    return plain && value.length <= 5
      ? value.map((v) => brief(v, depth + 1))
      : { $count: value.length };
  }
  if (depth >= 4) return "{…}";
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>))
    out[k] = brief(v, depth + 1);
  return out;
}
