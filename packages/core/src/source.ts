import { readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { openAsar, openAsarFile } from "./formats/asar.js";
import { AnalysisError } from "./model.js";
import type { LoadedTarget } from "./target.js";

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
  readFiles: ReadonlySet<string>,
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

function readTargetFile(loaded: LoadedTarget, file: string): Uint8Array {
  const { info } = loaded;
  if (info.format === "asar") {
    const archive = loaded.lazy ? openAsarFile(info.path) : openAsar(loaded.bytes);
    const entry = archive.find(file);
    if (!entry) throw new AnalysisError("not_found", `${file} not in archive`);
    if (entry.size > MAX_SOURCE_BYTES)
      throw new AnalysisError("too_large", `${file} is ${entry.size} bytes; not shown`);
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
    const size = statSync(real).size;
    if (size > MAX_SOURCE_BYTES)
      throw new AnalysisError("too_large", `${file} is ${size} bytes; not shown`);
    return new Uint8Array(readFileSync(real));
  }
  throw new AnalysisError(
    "invalid_input",
    "Source lines are available for Electron archives and application directories",
  );
}
