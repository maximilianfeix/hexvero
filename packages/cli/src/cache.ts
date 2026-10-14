import { cacheEntries, cacheLimits, cacheRoot, pruneCache } from "@hexvero/core";
import { paint, toJson, type Io } from "./format.js";

const mib = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

/** `hexvero cache`: what the cache holds, and pruning or clearing it on request. */
export function cache(
  io: Io,
  options: { prune: boolean; clear: boolean; apply: boolean; json: boolean },
): number {
  const root = cacheRoot();
  const limits = cacheLimits();
  if (options.clear && !options.apply) {
    const entries = cacheEntries();
    const bytes = entries.reduce((sum, e) => sum + e.bytes, 0);
    if (options.json) io.out(toJson({ root, apply: false, wouldRemove: entries.length, bytes }));
    else
      io.out(
        `Would remove ${entries.length} entries (${mib(bytes)}) under ${root}.\n${paint(io, "dim", "Dry run. Re-run with --clear --apply to remove them.")}`,
      );
    return 0;
  }
  if (options.prune || options.clear) {
    const result = pruneCache(options.clear ? { maxAgeMs: 0 } : {});
    if (options.json)
      io.out(
        toJson({
          root,
          removed: result.removed.map((e) => ({ area: e.area, name: e.name, bytes: e.bytes })),
          kept: result.kept,
          bytes: result.bytes,
        }),
      );
    else
      io.out(
        `Removed ${result.removed.length} entries (${mib(result.removed.reduce((s, e) => s + e.bytes, 0))}); ${result.kept} kept, ${mib(result.bytes)} in ${root}.`,
      );
    return 0;
  }
  const entries = cacheEntries();
  const areas = new Map<string, { count: number; bytes: number }>();
  for (const e of entries) {
    const a = areas.get(e.area) ?? { count: 0, bytes: 0 };
    a.count++;
    a.bytes += e.bytes;
    areas.set(e.area, a);
  }
  const total = entries.reduce((sum, e) => sum + e.bytes, 0);
  if (options.json) {
    io.out(
      toJson({
        root,
        bytes: total,
        areas: Object.fromEntries(areas),
        limits: { maxBytes: limits.maxBytes, maxAgeDays: limits.maxAgeMs / 86_400_000 },
      }),
    );
    return 0;
  }
  io.out(`${root}  ${mib(total)}`);
  const what: Record<string, string> = {
    scans: "stored scans of large JavaScript apps",
    graphs: "engine call graphs",
    ghidra: "Ghidra projects",
  };
  for (const [area, label] of Object.entries(what)) {
    const a = areas.get(area);
    io.out(
      `  ${area.padEnd(7)} ${String(a?.count ?? 0).padStart(4)}  ${mib(a?.bytes ?? 0).padStart(10)}  ${paint(io, "dim", label)}`,
    );
  }
  io.out(
    paint(
      io,
      "dim",
      `Kept up to ${mib(limits.maxBytes)} and ${limits.maxAgeMs / 86_400_000} days (HEXVERO_CACHE_MAX_MB, HEXVERO_CACHE_MAX_AGE_DAYS); pruned automatically at most once an hour.`,
    ),
  );
  return 0;
}
