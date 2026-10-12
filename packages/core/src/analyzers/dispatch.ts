import { parseApk, type ApkInfo } from "../formats/apk.js";
import { parseEvm, type EvmInfo } from "../formats/evm.js";
import { parseHar, type HarInfo } from "../formats/har.js";
import { parsePlist, type PlistValue } from "../formats/plist.js";
import { inspectSqlite, type SqliteInfo } from "../formats/sqlite.js";
import { parseWasm, type WasmInfo } from "../formats/wasm.js";
import { openZip, type ZipEntry } from "../formats/zip.js";
import {
  analyzeJavaScriptTree,
  asarTree,
  directoryTree,
  type JsAppInfo,
} from "../javascript/app.js";
import { scanJavaScript, type ScanResult } from "../javascript/scan.js";
import {
  summarizeSourceMap,
  type SourceMapSummary,
} from "../javascript/sourcemap.js";
import {
  AnalysisError,
  type Analysis,
  type Finding,
  type Limitation,
} from "../model.js";
import type { LoadedTarget } from "../target.js";
import { analyzeBinary, type BinaryData } from "./binary.js";

type Strip<T> = Omit<T, "findings" | "limitations">;

export type AnalysisData =
  | { kind: "binary"; binary: BinaryData }
  | { kind: "wasm"; wasm: Strip<WasmInfo> }
  | { kind: "evm"; evm: Strip<EvmInfo> }
  | { kind: "sqlite"; sqlite: Strip<SqliteInfo> }
  | { kind: "plist"; plist: PlistValue }
  | { kind: "har"; har: Strip<HarInfo> }
  | { kind: "apk"; apk: Strip<ApkInfo> }
  | { kind: "zip"; zip: { entries: ZipEntry[]; comment: string } }
  | { kind: "javascript-app"; app: Strip<JsAppInfo> }
  | { kind: "javascript"; script: ScanResult }
  | { kind: "source-map"; map: SourceMapSummary }
  | { kind: "json"; json: { topLevelKeys: string[]; bytes: number } }
  | { kind: "unknown"; preview: string };

export type AnyAnalysis = Analysis<AnalysisData>;

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

/** Routes a loaded target to the matching analyzer and normalizes the result shape. */
export async function analyzeTarget(
  target: LoadedTarget,
): Promise<AnyAnalysis> {
  const started = performance.now();
  const { info, bytes } = target;
  const findings: Finding[] = [];
  const limitations: Limitation[] = [];
  const strip = <T extends { findings: Finding[]; limitations: Limitation[] }>(
    parsed: T,
  ): Strip<T> => {
    const { findings: f, limitations: l, ...rest } = parsed;
    findings.push(...f);
    limitations.push(...l);
    return rest;
  };
  const done = (summary: string, data: AnalysisData): AnyAnalysis => ({
    target: info,
    summary,
    data,
    findings,
    limitations,
    durationMs: Math.round(performance.now() - started),
  });

  switch (info.format) {
    case "elf":
    case "pe":
    case "macho":
    case "macho-fat": {
      const result = analyzeBinary(target);
      return { ...result, data: { kind: "binary", binary: result.data } };
    }
    case "wasm": {
      const wasm = strip(parseWasm(bytes));
      return done(
        `WebAssembly module: ${wasm.functionCount} functions, ${wasm.imports.length} imports, ${wasm.exports.length} exports`,
        { kind: "wasm", wasm },
      );
    }
    case "evm-hex": {
      const evm = strip(parseEvm(bytes));
      return done(
        `EVM bytecode: ${evm.byteLength} bytes, ${evm.instructionCount} instructions, ${evm.selectors.length} selectors`,
        { kind: "evm", evm },
      );
    }
    case "sqlite": {
      const sqlite = strip(await inspectSqlite(info.path));
      return done(
        `SQLite database: ${sqlite.tables.length} tables/views, ${sqlite.indexes.length} indexes`,
        { kind: "sqlite", sqlite },
      );
    }
    case "plist-binary":
    case "plist-xml": {
      const plist = parsePlist(bytes);
      const keys =
        plist && typeof plist === "object" && !Array.isArray(plist)
          ? Object.keys(plist).length
          : 0;
      return done(
        `Property list (${
          info.format === "plist-binary" ? "binary" : "XML"
        }) with ${keys} top-level keys`,
        { kind: "plist", plist },
      );
    }
    case "apk": {
      const apk = strip(parseApk(bytes));
      return done(
        `Android APK ${apk.package} ${apk.versionName}, ${apk.components.length} components, ${apk.permissions.length} permissions`,
        { kind: "apk", apk },
      );
    }
    case "zip": {
      const zip = openZip(bytes);
      return done(`ZIP archive with ${zip.entries.length} entries`, {
        kind: "zip",
        zip: { entries: zip.entries, comment: zip.comment },
      });
    }
    case "asar": {
      const app = strip(analyzeJavaScriptTree(asarTree(bytes, info.path)));
      return done(
        `Electron ASAR: ${app.modules.length} JavaScript modules, ${app.ipcChannels.length} IPC channels`,
        { kind: "javascript-app", app },
      );
    }
    case "directory": {
      const app = strip(analyzeJavaScriptTree(directoryTree(info.path)));
      return done(
        `Directory: ${app.totals.files} files, ${app.modules.length} JavaScript modules${
          app.electron ? " (Electron)" : ""
        }`,
        { kind: "javascript-app", app },
      );
    }
    case "javascript": {
      const script = scanJavaScript(decode(bytes));
      if (script.truncated)
        limitations.push({
          code: "scan_truncated",
          message: "Token budget exhausted.",
        });
      return done(
        `JavaScript (${script.moduleSystem}): ${script.references.length} references, ${script.exports.length} exports${
          script.minified ? ", minified" : ""
        }`,
        { kind: "javascript", script },
      );
    }
    case "json": {
      const text = decode(bytes);
      if (
        info.path.endsWith(".map") ||
        /"mappings"\s*:/.test(text.slice(0, 1 << 20))
      ) {
        try {
          const map = summarizeSourceMap(text);
          return done(
            `Source map for ${map.file ?? "?"}: ${map.sources.length} sources`,
            { kind: "source-map", map },
          );
        } catch {
          /* fall through to HAR/JSON */
        }
      }
      if (/"log"\s*:/.test(text.slice(0, 4096))) {
        const har = strip(parseHar(bytes));
        return done(
          `HAR capture: ${har.entries.length} requests to ${har.hosts.length} hosts`,
          { kind: "har", har },
        );
      }
      try {
        const parsed = JSON.parse(text) as unknown;
        const topLevelKeys =
          parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? Object.keys(parsed).slice(0, 100)
            : [];
        return done(`JSON document (${bytes.length} bytes)`, {
          kind: "json",
          json: { topLevelKeys, bytes: bytes.length },
        });
      } catch {
        throw new AnalysisError(
          "malformed",
          "File looks like JSON but does not parse",
        );
      }
    }
    default:
      limitations.push({
        code: "unknown_format",
        message:
          "No parser recognized this file; strings and byte windows are still available.",
      });
      return done(`Unrecognized format (${bytes.length} bytes)`, {
        kind: "unknown",
        preview: Buffer.from(bytes.subarray(0, 64)).toString("hex"),
      });
  }
}
