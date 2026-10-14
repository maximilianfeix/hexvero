/**
 * The cache under ~/.cache/hexvero (or HEXVERO_CACHE_DIR): stored scans of large JavaScript
 * applications (`scans/`), engine call graphs (`graphs/`) and Ghidra projects (`ghidra/`).
 *
 * It is private and bounded. Directories are made 0700 and files 0600, and directories that an
 * earlier version created more open are tightened when they are used. Pruning removes entries
 * older than the maximum age, then the oldest until the total is under the size budget. It only
 * ever removes what hexvero itself names (see `ENTRY`), never follows a symbolic link, and runs at
 * most once an hour on its own; `hexvero cache --prune` runs it at once.
 */
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function cacheRoot(): string {
  return process.env["HEXVERO_CACHE_DIR"] ?? join(homedir(), ".cache", "hexvero");
}

const MiB = 1024 * 1024;
const DAY = 24 * 60 * 60 * 1000;

export function cacheLimits(): { maxBytes: number; maxAgeMs: number } {
  const mb = Number(process.env["HEXVERO_CACHE_MAX_MB"]);
  const days = Number(process.env["HEXVERO_CACHE_MAX_AGE_DAYS"]);
  return {
    maxBytes: (Number.isFinite(mb) && mb > 0 ? mb : 1024) * MiB,
    maxAgeMs: (Number.isFinite(days) && days > 0 ? days : 30) * DAY,
  };
}

/** What hexvero writes in each part of the cache; nothing else is touched. */
const ENTRY: Record<string, { pattern: RegExp; directory: boolean }> = {
  scans: { pattern: /^[0-9a-f]{16,64}\.json(\.\d+\.\d+\.tmp)?$/, directory: false },
  graphs: { pattern: /^[a-z0-9]+-[0-9a-f]{8,64}(-[0-9a-f]{4,64})?\.json$/, directory: false },
  ghidra: { pattern: /^[0-9a-f]{8,64}$/, directory: true },
};

const owned = (path: string): boolean => {
  if (process.platform === "win32" || typeof process.getuid !== "function") return true;
  try {
    return lstatSync(path).uid === process.getuid();
  } catch {
    return false;
  }
};

/** Creates a cache directory (and the root) private to the user, tightening older ones. */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") return;
  for (const path of new Set([cacheRoot(), dir])) {
    try {
      const s = lstatSync(path);
      if (s.isDirectory() && !s.isSymbolicLink() && owned(path) && (s.mode & 0o077) !== 0)
        chmodSync(path, 0o700);
    } catch {
      /* best effort: the cache works without it */
    }
  }
}

export interface CacheEntry {
  area: string;
  name: string;
  path: string;
  bytes: number;
  modified: number;
}

function sizeOf(path: string, depth = 0): number {
  const s = lstatSync(path);
  if (s.isSymbolicLink()) return 0;
  if (!s.isDirectory()) return s.size;
  if (depth > 20) return 0;
  let total = 0;
  for (const name of readdirSync(path)) total += sizeOf(join(path, name), depth + 1);
  return total;
}

/** Every entry hexvero wrote, oldest first. Anything it does not recognise is left out. */
export function cacheEntries(root = cacheRoot()): CacheEntry[] {
  const out: CacheEntry[] = [];
  for (const [area, { pattern, directory }] of Object.entries(ENTRY)) {
    let names: string[];
    try {
      names = readdirSync(join(root, area));
    } catch {
      continue;
    }
    for (const name of names) {
      if (!pattern.test(name)) continue;
      const path = join(root, area, name);
      try {
        const s = lstatSync(path);
        if (s.isSymbolicLink() || s.isDirectory() !== directory) continue;
        out.push({ area, name, path, bytes: sizeOf(path), modified: s.mtimeMs });
      } catch {
        /* removed meanwhile */
      }
    }
  }
  return out.toSorted((a, b) => a.modified - b.modified);
}

export interface PruneResult {
  removed: CacheEntry[];
  kept: number;
  bytes: number;
}

/** Removes entries older than the maximum age, then the oldest until under the size budget. */
export function pruneCache(
  options: { maxBytes?: number; maxAgeMs?: number; now?: number; root?: string } = {},
): PruneResult {
  const limits = cacheLimits();
  const maxBytes = options.maxBytes ?? limits.maxBytes;
  const maxAgeMs = options.maxAgeMs ?? limits.maxAgeMs;
  const now = options.now ?? Date.now();
  const entries = cacheEntries(options.root);
  let total = entries.reduce((sum, e) => sum + e.bytes, 0);
  const removed: CacheEntry[] = [];
  for (const entry of entries) {
    // A temporary file of an interrupted save is stale after a day; anything after its maximum age.
    const stale =
      now - entry.modified > maxAgeMs ||
      (entry.name.endsWith(".tmp") && now - entry.modified > DAY);
    // Over the budget, the oldest go first, but never what was written within the last hour:
    // a large Ghidra project must not be removed right after it was imported.
    if (!stale && (total <= maxBytes || now - entry.modified < 60 * 60 * 1000)) continue;
    try {
      rmSync(entry.path, { recursive: entry.area === "ghidra", force: true });
      total -= entry.bytes;
      removed.push(entry);
    } catch {
      /* in use or not ours to remove: kept */
    }
  }
  return { removed, kept: entries.length - removed.length, bytes: total };
}

/** Prunes after a write, at most once an hour (a marker file holds the time of the last run). */
export function pruneCacheSoon(): void {
  const root = cacheRoot();
  const marker = join(root, ".last-prune");
  try {
    if (Date.now() - statSync(marker).mtimeMs < 60 * 60 * 1000) return;
  } catch {
    /* never pruned */
  }
  try {
    ensurePrivateDir(root);
    writeFileSync(marker, "", { mode: 0o600 });
    const now = new Date();
    utimesSync(marker, now, now);
    pruneCache();
  } catch {
    /* the cache is a convenience; a failed prune changes no result */
  }
}
