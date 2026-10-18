/**
 * Shared result model. Every analyzer returns an `Analysis<T>` whose `data`
 * is format specific, while `target`, `limitations` and `findings` are common.
 */

export type Confidence = "confirmed" | "inferred";

export interface Finding {
  /** Stable machine-readable kind, e.g. "go.buildinfo" or "pe.clr". */
  kind: string;
  title: string;
  detail?: string | undefined;
  confidence: Confidence;
  /** Byte offset or address that supports the finding, when it has one. */
  location?: string | undefined;
}

/**
 * The sentence a file-scoped limitation (session.ts, FILE_SCOPED_LIMITATIONS) ends with when its
 * emitter has established that nothing is missing because of it: it then applies in no file. Any
 * other such limitation that names no file applies in every file.
 */
export const NOTHING_MISSING = "No page calls are missing.";

/** Something the analyzer could not establish; results stay honest about it. */
export interface Limitation {
  code: string;
  message: string;
}

export interface TargetInfo {
  /** The file or directory that was read: for a packaged build, the Electron app inside it. */
  path: string;
  size: number;
  sha256: string;
  format: FormatId;
  /**
   * Set when the path given was a packaged build (a macOS `.app`, a Windows/Linux install
   * directory, a ZIP of either) and `path` is the Electron application found inside it.
   */
  container?: TargetContainer;
  /**
   * Set when the build holds an Electron app that was not read (a link out of the bundle, an
   * entry a ZIP holds twice, an archive that is not one): the target is the build as it is.
   */
  appNotRead?: { entry: string; reason: string };
}

export interface TargetContainer {
  /** The path as given: the bundle, install directory or archive. */
  path: string;
  format: "directory" | "zip";
  /** The application inside it, relative, with `/` separators (`Contents/Resources/app.asar`). */
  entry: string;
  layout: "macos" | "windows-linux";
  /** What else was there and why `entry` was read (Electron's search order). */
  note?: string;
  /** Why the pick may not be what Electron runs (a fuse hexvero does not read). */
  warning?: string;
}

export interface Analysis<T> {
  target: TargetInfo;
  summary: string;
  data: T;
  findings: Finding[];
  limitations: Limitation[];
  durationMs: number;
}

export type FormatId =
  | "elf"
  | "pe"
  | "macho"
  | "macho-fat"
  | "wasm"
  | "zip"
  | "apk"
  | "jar"
  | "java-class"
  | "dex"
  | "sqlite"
  | "asar"
  | "plist-binary"
  | "plist-xml"
  | "json"
  | "javascript"
  | "evm-hex"
  | "directory"
  | "unknown";

/** A bounded page of a list; callers paginate instead of receiving everything. */
export interface Page<T> {
  items: T[];
  total: number;
  offset: number;
  truncated: boolean;
}

export function page<T>(items: readonly T[], offset = 0, limit = 200): Page<T> {
  const start = Math.max(0, Math.min(offset, items.length));
  const slice = items.slice(start, start + Math.max(0, limit));
  return {
    items: slice,
    total: items.length,
    offset: start,
    truncated: start + slice.length < items.length,
  };
}

export class AnalysisError extends Error {
  constructor(
    readonly code:
      | "unsupported_format"
      | "malformed"
      | "not_found"
      | "too_large"
      | "cancelled"
      | "provider_unavailable"
      | "invalid_input",
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "AnalysisError";
  }
}
