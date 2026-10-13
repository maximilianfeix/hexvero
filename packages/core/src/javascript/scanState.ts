/**
 * Stored state of a JavaScript application scan, so a large application can be read in several
 * runs (and by several processes) without reading a file twice or losing one.
 *
 * The state is one JSON file per input, named after everything that decides what a scan reads:
 * the content of the input and the scanner's schema. A changed input therefore has a different
 * name and starts from nothing. The file is replaced atomically, so a run that is cancelled or
 * crashes leaves the previous complete state behind, never half of a new one.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TargetInfo } from "../model.js";
import { JS_SCAN_SCHEMA, type FileTree, type JsScanFacts } from "./app.js";

const root = (): string =>
  join(process.env["HEXVERO_CACHE_DIR"] ?? join(homedir(), ".cache", "hexvero"), "scans");

/** Identity of the input for scan purposes; null when it cannot be established. */
export function scanKey(info: TargetInfo, tree: FileTree): string | null {
  const digest = createHash("sha256").update(`scan\u0000${JS_SCAN_SCHEMA}\u0000`);
  if (tree.kind === "asar") {
    if (!info.sha256) return null;
    digest.update(info.sha256);
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
    if (!Array.isArray(facts.scanned) || !Array.isArray(facts.modules)) return null;
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
  mkdirSync(dir, { recursive: true });
  const final = join(dir, `${key}.json`);
  const temp = `${final}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify({ key, savedAt: new Date().toISOString(), facts }));
    renameSync(temp, final);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

export function dropScan(key: string): void {
  rmSync(join(root(), `${key}.json`), { force: true });
}
