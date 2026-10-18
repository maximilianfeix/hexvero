/**
 * Stored state of a JavaScript application scan, so a large application can be read in several
 * runs (and by several processes) without reading a file twice or losing one.
 *
 * The state is one JSON file per input, named after everything that decides what a scan reads:
 * the content of the input, the scanner's schema and the analyzer's version. A changed input, or
 * another release of hexvero, therefore has a different name and starts from nothing. The file is replaced atomically, so a run that is cancelled or
 * crashes leaves the previous complete state behind, never half of a new one.
 */
import { createHash } from "node:crypto";
import { readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cacheRoot, ensurePrivateDir, pruneCacheSoon } from "../cache.js";
import type { TargetInfo } from "../model.js";
import { CORE_VERSION } from "../version.js";
import { JS_SCAN_SCHEMA, type FileTree, type JsScanFacts } from "./app.js";

const root = (): string => join(cacheRoot(), "scans");

/** Identity of the input for scan purposes; null when it cannot be established. */
export function scanKey(info: TargetInfo, tree: FileTree): string | null {
  // The version is part of the name: a scan stored by another release of the analyzer was read
  // by other code, so after an upgrade the input is read again instead of showing old results.
  const digest = createHash("sha256").update(
    `scan\u0000${JS_SCAN_SCHEMA}\u0000${CORE_VERSION}\u0000`,
  );
  if (tree.kind === "asar") {
    if (!info.sha256) return null;
    digest.update(info.sha256);
    // Unpacked entries are read from `<archive>.unpacked/`, outside the hashed bytes: whether each
    // is there, and its size and time, are part of the input too.
    for (const file of tree.files
      .filter((f) => f.unpacked)
      .toSorted((a, b) => (a.path < b.path ? -1 : 1))) {
      let seen = "absent";
      if (tree.unpackedStamp) seen = tree.unpackedStamp(file.path);
      else
        try {
          const st = statSync(join(`${tree.root}.unpacked`, ...file.path.split("/")));
          seen = `${st.size}\u0000${Math.round(st.mtimeMs)}`;
        } catch {
          // missing or unreadable: recorded as absent, so adding the file later changes the key
        }
      digest.update(`unpacked\u0000${file.path}\u0000${seen}\u0000`);
    }
  } else {
    // A directory has no single content hash: its identity is every file's path, size and
    // modification time. Editing, adding or removing a file changes it.
    digest.update(`${tree.root}\u0000`);
    for (const file of tree.files.toSorted((a, b) => (a.path < b.path ? -1 : 1))) {
      let mtime = 0;
      try {
        mtime = Math.round(statSync(join(tree.root, file.path)).mtimeMs);
      } catch {
        return null;
      }
      digest.update(`${file.path}\u0000${file.size}\u0000${mtime}\u0000`);
    }
  }
  return digest.digest("hex").slice(0, 40);
}

export function loadScan(key: string, tree: FileTree): JsScanFacts | null {
  try {
    const stored = JSON.parse(readFileSync(join(root(), `${key}.json`), "utf8")) as {
      key?: string;
      facts?: JsScanFacts;
    };
    const facts = stored.facts;
    if (stored.key !== key || !facts || facts.schema !== JS_SCAN_SCHEMA) return null;
    // Every list the assembly reads must be there, or a later step fails far from the cause.
    for (const field of [
      "scanned",
      "skippedFiles",
      "modules",
      "edges",
      "webPreferences",
      "contextBridge",
      "endpoints",
      "storage",
      "urls",
      "preloadScripts",
      "limitations",
    ] as const)
      if (!Array.isArray(facts[field])) return null;
    // The scanned list and the results must describe the same files: a file whose results are
    // stored but which counts as unread would be read again and appear twice.
    if (facts.scanned.length !== facts.modules.length + facts.skipped) return null;
    const read = new Set(facts.scanned);
    if (!facts.modules.every((m) => read.has(m.id))) return null;
    // Belt and braces: every stored path must still be a file of this input.
    const known = new Set(tree.files.map((f) => f.path));
    if (!facts.scanned.every((path) => known.has(path))) return null;
    if (new Set(facts.scanned).size !== facts.scanned.length) return null;
    return facts;
  } catch {
    return null;
  }
}

export function saveScan(key: string, facts: JsScanFacts): void {
  const dir = root();
  ensurePrivateDir(dir);
  const final = join(dir, `${key}.json`);
  const temp = `${final}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify({ key, savedAt: new Date().toISOString(), facts }), {
      mode: 0o600,
    });
    renameSync(temp, final);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  pruneCacheSoon();
}

export function dropScan(key: string): void {
  rmSync(join(root(), `${key}.json`), { force: true });
}
