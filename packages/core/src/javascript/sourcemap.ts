import { AnalysisError } from "../model.js";

export interface SourceMapSummary {
  version: number;
  file: string | null;
  sourceRoot: string | null;
  sources: string[];
  sourcesWithContent: number;
  names: number;
  mappingCount: number;
  /** Original sources grouped by their top-level directory or package. */
  packages: Array<{ name: string; files: number }>;
  isIndexMap: boolean;
}

export interface MappedPosition {
  source: string | null;
  line: number;
  column: number;
  name: string | null;
}

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const LOOKUP = new Int8Array(128).fill(-1);
for (let i = 0; i < BASE64.length; i++) LOOKUP[BASE64.charCodeAt(i)] = i;

/** Decodes one VLQ-encoded segment group; returns the raw deltas. */
export function decodeVlq(segment: string): number[] {
  const out: number[] = [];
  let value = 0;
  let shift = 0;
  for (let i = 0; i < segment.length; i++) {
    const digit = LOOKUP[segment.charCodeAt(i)] ?? -1;
    if (digit < 0) throw new AnalysisError("malformed", `invalid VLQ character ${segment[i]}`);
    value += (digit & 31) * 2 ** shift;
    if (digit & 32) shift += 5;
    else {
      const negative = value & 1;
      value >>>= 1;
      out.push(negative ? -value : value);
      value = 0;
      shift = 0;
    }
  }
  return out;
}

interface RawMap {
  version?: number;
  file?: string;
  sourceRoot?: string;
  sources?: string[];
  sourcesContent?: Array<string | null>;
  names?: string[];
  mappings?: string;
  sections?: unknown[];
}

export function parseSourceMapJson(text: string): RawMap {
  try {
    return JSON.parse(text.replace(/^\)\]\}'\n?/, "")) as RawMap;
  } catch {
    throw new AnalysisError("malformed", "source map is not valid JSON");
  }
}

export function summarizeSourceMap(text: string): SourceMapSummary {
  const map = parseSourceMapJson(text);
  const sources = (map.sources ?? []).map((s) =>
    map.sourceRoot ? `${map.sourceRoot.replace(/\/$/, "")}/${s}` : s,
  );
  const packages = new Map<string, number>();
  for (const s of sources) {
    const clean = s.replace(/^webpack:\/\/\/?/, "").replace(/^\.\//, "");
    const nm = /node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(clean);
    const key = nm ? nm[1]! : (clean.split("/")[0] ?? clean) || "(root)";
    packages.set(key, (packages.get(key) ?? 0) + 1);
  }
  const mappings = map.mappings ?? "";
  let mappingCount = 0;
  for (let i = 0; i < mappings.length; i++)
    if (mappings[i] !== ";" && (i === 0 || mappings[i - 1] === ";" || mappings[i - 1] === ","))
      mappingCount++;
  return {
    version: map.version ?? 0,
    file: map.file ?? null,
    sourceRoot: map.sourceRoot ?? null,
    sources,
    sourcesWithContent: (map.sourcesContent ?? []).filter((c) => typeof c === "string").length,
    names: map.names?.length ?? 0,
    mappingCount,
    packages: [...packages]
      .map(([name, files]) => ({ name, files }))
      .toSorted((a, b) => b.files - a.files),
    isIndexMap: Array.isArray(map.sections),
  };
}

/** Resolves a generated (line, column), both 1-based line / 0-based column, to its original position. */
export function originalPositionFor(
  text: string,
  line: number,
  column: number,
): MappedPosition | null {
  const map = parseSourceMapJson(text);
  const rows = (map.mappings ?? "").split(";");
  const row = rows[line - 1];
  if (row === undefined) return null;
  // Source index, original line and column, and name index accumulate across rows.
  let source = 0;
  let origLine = 0;
  let origCol = 0;
  let name = 0;
  for (let r = 0; r < line - 1; r++) {
    for (const seg of rows[r]!.split(",")) {
      if (!seg) continue;
      const d = decodeVlq(seg);
      if (d.length >= 4) {
        source += d[1]!;
        origLine += d[2]!;
        origCol += d[3]!;
      }
      if (d.length >= 5) name += d[4]!;
    }
  }
  let genCol = 0;
  let best: MappedPosition | null = null;
  for (const seg of row.split(",")) {
    if (!seg) continue;
    const d = decodeVlq(seg);
    genCol += d[0]!;
    if (d.length >= 4) {
      source += d[1]!;
      origLine += d[2]!;
      origCol += d[3]!;
    }
    if (d.length >= 5) name += d[4]!;
    if (genCol > column) break;
    best =
      d.length >= 4
        ? {
            source: map.sources?.[source] ?? null,
            line: origLine + 1,
            column: origCol,
            name: d.length >= 5 ? (map.names?.[name] ?? null) : null,
          }
        : null;
  }
  return best;
}
