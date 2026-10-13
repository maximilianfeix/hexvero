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

/** Something the analyzer could not establish; results stay honest about it. */
export interface Limitation {
  code: string;
  message: string;
}

export interface TargetInfo {
  path: string;
  size: number;
  sha256: string;
  format: FormatId;
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
