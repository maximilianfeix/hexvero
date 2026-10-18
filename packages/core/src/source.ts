import { realpathSync, statSync } from "node:fs";
import { readRegularFile } from "./binary/file.js";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { openAsar, openAsarFile, readUnpacked, type AsarArchive } from "./formats/asar.js";
import { AnalysisError } from "./model.js";
import { fileStamp, type LoadedTarget } from "./target.js";

/** A few lines of one source file around the line a fact was read from. */
export interface SourceWindow {
  file: string;
  /** The line asked for (1-based). */
  line: number;
  /** Line number of `lines[0]`. */
  start: number;
  lines: string[];
  /** Lines in the whole file. */
  totalLines: number;
  /** Lines longer than 400 characters were cut; their full length is listed here. */
  cut: Array<{ line: number; length: number }>;
}

/** Files above this size are not shown. */
export const MAX_SOURCE_BYTES = 8 << 20;
const MAX_LINE = 400;
const MAX_CONTEXT = 60;

/**
 * Reads lines `line - context … line + context` of `file` inside a JavaScript application target
 * (an ASAR archive or a directory). Only files the analysis read are served (`readFiles`), so a
 * caller cannot use this to read anything else on the machine; directory paths are resolved and
 * must stay inside the target. The text is returned as data: callers render it, never run it.
 */
export function sourceWindow(
  loaded: LoadedTarget,
  readFiles: ReadonlySet<string> | ReadonlyMap<string, number>,
  file: string,
  line: number,
  context = 12,
): SourceWindow {
  if (!readFiles.has(file))
    throw new AnalysisError(
      "not_found",
      `${file} is not a file this analysis read; only those can be shown`,
    );
  if (!Number.isInteger(line) || line < 1)
    throw new AnalysisError("invalid_input", "line must be a positive integer");
  const around = Math.min(Math.max(0, Math.floor(context)), MAX_CONTEXT);
  const bytes = readTargetFile(loaded, file);
  // With the sizes the analysis read (a map), a file of another size is another file: a directory
  // edited, or an unpacked file replaced, since the analysis.
  const analyzed = readFiles instanceof Map ? readFiles.get(file) : undefined;
  if (analyzed !== undefined && analyzed !== bytes.length) throw changed(file, file);
  const all = new TextDecoder("utf-8", { fatal: false }).decode(bytes).split(/\r?\n/);
  const start = Math.max(1, Math.min(line, all.length) - around);
  const end = Math.min(all.length, line + around);
  const cut: SourceWindow["cut"] = [];
  const lines = all.slice(start - 1, end).map((text, i) => {
    if (text.length <= MAX_LINE) return text;
    cut.push({ line: start + i, length: text.length });
    return text.slice(0, MAX_LINE);
  });
  return { file, line, start, lines, totalLines: all.length, cut };
}

/**
 * The parsed header of each archive, kept for the target's lifetime: an HTML report reads up to
 * 200 windows, and parsing the header of a 100,000-entry archive for each one took seconds.
 */
const archives = new WeakMap<LoadedTarget, AsarArchive>();

/** The refusal when a target's file is not the one the analysis read. */
const changed = (name: string, path: string): AnalysisError =>
  new AnalysisError(
    "invalid_input",
    `${name} changed on disk since it was analyzed; open it again`,
    {
      reason: "changed_on_disk",
      path,
    },
  );

function readTargetFile(loaded: LoadedTarget, file: string): Uint8Array {
  const { info } = loaded;
  if (info.format === "asar") {
    // An archive read from disk on demand must still be the one that was opened and analyzed.
    if (loaded.lazy && loaded.stamp !== undefined) {
      let now = "";
      try {
        now = fileStamp(statSync(info.path));
      } catch {
        // gone: as changed as it gets
      }
      if (now !== loaded.stamp) throw changed(basename(info.path), info.path);
    }
    let archive = archives.get(loaded);
    if (!archive) {
      archive = loaded.lazy ? openAsarFile(info.path) : openAsar(loaded.bytes);
      archives.set(loaded, archive);
    }
    const entry = archive.find(file);
    if (!entry) throw new AnalysisError("not_found", `${file} not in archive`);
    if (entry.size > MAX_SOURCE_BYTES)
      throw new AnalysisError("too_large", `${file} is ${entry.size} bytes; not shown`);
    // An unpacked entry lives in `<archive>.unpacked/`, read with the same confinement as a scan.
    if (entry.unpacked && loaded.unpacked) {
      const bytes = Object.hasOwn(loaded.unpacked, file) ? loaded.unpacked[file] : undefined;
      if (!bytes) throw new AnalysisError("not_found", `${file} was not taken from the archive`);
      if (bytes.length > MAX_SOURCE_BYTES)
        throw new AnalysisError("too_large", `${file} is ${bytes.length} bytes; not shown`);
      return bytes;
    }
    if (entry.unpacked && isAbsolute(info.path))
      return readUnpacked(info.path, entry, MAX_SOURCE_BYTES);
    return archive.read(entry, MAX_SOURCE_BYTES);
  }
  if (info.format === "directory") {
    const root = realpathSync(info.path);
    const full = join(info.path, ...file.split("/"));
    if (relative(info.path, full).startsWith(".."))
      throw new AnalysisError("invalid_input", `${file} escapes the target`);
    const real = realpathSync(full);
    if (real !== root && !real.startsWith(root + sep))
      throw new AnalysisError("invalid_input", `${file} resolves outside the target`);
    return readRegularFile(real, MAX_SOURCE_BYTES, file);
  }
  throw new AnalysisError(
    "invalid_input",
    "Source lines are available for Electron archives and application directories",
  );
}
