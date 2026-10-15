import { parseApk, type ApkInfo } from "../formats/apk.js";
import { analyzeAppBundle, isAppBundle, type BundleInfo } from "../formats/bundle.js";
import { parseEvm, type EvmInfo } from "../formats/evm.js";
import { parseDex, type DexInfo } from "../formats/dex.js";
import { parseHar, type HarInfo } from "../formats/har.js";
import { parseJar, parseJavaClass, type JarInfo, type JavaClassInfo } from "../formats/java.js";
import { parsePlist, type PlistValue } from "../formats/plist.js";
import { inspectSqlite, type SqliteInfo } from "../formats/sqlite.js";
import { parseWasm, type WasmInfo } from "../formats/wasm.js";
import { openZip, type ZipEntry } from "../formats/zip.js";
import {
  analyzeJavaScriptTree,
  asarTree,
  asarTreeFromFile,
  directoryTree,
  type FileTree,
  type JsAppInfo,
  type JsScanFacts,
  plannedReads,
} from "../javascript/app.js";
import { PARALLEL_MIN_BYTES, readTokensInParallel, scanThreads } from "../javascript/tokenPool.js";
import { dropScan, loadScan, saveScan, scanKey } from "../javascript/scanState.js";
import { analyzeBundle, type JsBundleInfo } from "../javascript/bundle.js";
import { scanJavaScript, type ScanResult } from "../javascript/scan.js";
import { summarizeSourceMap, type SourceMapSummary } from "../javascript/sourcemap.js";
import { AnalysisError, type Analysis, type Finding, type Limitation } from "../model.js";
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
  | { kind: "bundle"; bundle: Strip<BundleInfo> }
  | { kind: "zip"; zip: { entries: ZipEntry[]; comment: string } }
  | { kind: "jar"; jar: Strip<JarInfo> }
  | { kind: "java-class"; javaClass: Strip<JavaClassInfo> }
  | { kind: "dex"; dex: Strip<DexInfo> }
  | { kind: "javascript-app"; app: Strip<JsAppInfo> }
  | { kind: "javascript"; script: ScanResult; bundle: Omit<JsBundleInfo, "limitations"> }
  | { kind: "source-map"; map: SourceMapSummary }
  | { kind: "json"; json: { topLevelKeys: string[]; bytes: number } }
  | { kind: "unknown"; preview: string };

export type AnyAnalysis = Analysis<AnalysisData>;

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

/** How far a JavaScript application scan should go; everything else ignores it. */
export interface JsScanRequest {
  /** Read the next batch of unread files. */
  continue?: boolean;
  /** Read every unread file, batch after batch. */
  all?: boolean;
  /** Read unread files under these path prefixes or `*` patterns. */
  include?: readonly string[];
  /** Discard the stored scan of this input and start again. */
  fresh?: boolean;
  /** Files per run or batch (default 5,000). */
  maxJsFiles?: number;
}

export interface AnalyzeOptions {
  js?: JsScanRequest;
}

/**
 * JavaScript an application must hold before a scan finished in one run is stored too. Reading it
 * again would cost seconds (Claude's 47 MiB archive: about 8 s, against 0.3 s from the stored
 * scan), so the next `collection`, `compare` or `export` of the same input reuses it. A small
 * application read in one run still touches no disk.
 */
const STORE_COMPLETE_MIN_BYTES = 1 << 20;

/**
 * Scans a JavaScript application, continuing a stored scan of the same input when there is one.
 * State is stored when it is needed to continue (after a partial run, or once a scan has been
 * continued) and when a large application was read whole in one run.
 */
async function scanApplication(
  info: LoadedTarget["info"],
  tree: FileTree,
  request: JsScanRequest = {},
): Promise<JsAppInfo> {
  const key = scanKey(info, tree);
  if (key && request.fresh) dropScan(key);
  const stored = key ? loadScan(key, tree) : null;
  const advancing = !!(request.continue || request.all || request.include?.length);
  let last: JsScanFacts | null = null;
  // The state is a convenience for continuing later. Where it cannot be written (a read-only
  // cache directory, a full disk) the analysis itself stands, and says what was not kept.
  let notSaved: string | null = null;
  const save = (facts: JsScanFacts): void => {
    if (!key) return;
    try {
      saveScan(key, facts);
    } catch (error) {
      notSaved ??= error instanceof Error ? error.message : String(error);
    }
  };
  const run = {
    ...(stored ? { resume: stored } : {}),
    // A stored scan is shown as it stands unless the caller asks to read more.
    ...(stored && !advancing ? { maxJsFiles: 0 } : {}),
    ...(request.maxJsFiles !== undefined && !(stored && !advancing)
      ? { maxJsFiles: request.maxJsFiles }
      : {}),
    ...(request.all ? { all: true } : {}),
    ...(request.include?.length ? { include: request.include } : {}),
  };
  // Large applications: the files of this run are tokenized ahead in worker threads. The scan
  // merges in its own order and reads anything missing itself, so the result does not change.
  const planned = plannedReads(tree, run);
  const threads = scanThreads();
  const prepared =
    threads > 0 && planned.reduce((sum, f) => sum + f.size, 0) >= PARALLEL_MIN_BYTES
      ? await readTokensInParallel(
          planned.map((f) => ({
            path: f.path,
            size: f.size,
            read: () => {
              try {
                return decode(tree.read(f.path, 16 << 20));
              } catch {
                return null;
              }
            },
          })),
          threads,
        )
      : undefined;
  const app = analyzeJavaScriptTree(tree, {
    ...run,
    ...(prepared ? { prepared } : {}),
    onFacts: (facts) => {
      // In `all` mode every finished batch is stored at once, so a timeout or a kill costs one
      // batch at most and the next run continues from there.
      if (request.all) save(facts);
      last = facts;
    },
  });
  const large = (): boolean =>
    tree.files.reduce((sum, f) => sum + (/\.[cm]?js$/i.test(f.path) ? f.size : 0), 0) >=
    STORE_COMPLETE_MIN_BYTES;
  if (
    key &&
    last &&
    !request.all &&
    (advancing || (!stored && (!app.coverage.complete || large())))
  )
    save(last);
  if (notSaved)
    app.limitations.push({
      code: "scan_state_not_saved",
      message: `The scan state could not be stored (${notSaved}). This result is complete as reported, but a later run cannot continue from it; set HEXVERO_CACHE_DIR to a writable directory.`,
    });
  return app;
}

/** Routes a loaded target to the matching analyzer; parser bounds errors become `malformed` results. */
export async function analyzeTarget(
  target: LoadedTarget,
  options: AnalyzeOptions = {},
): Promise<AnyAnalysis> {
  try {
    return await analyzeTargetUnsafe(target, options);
  } catch (error) {
    if (error instanceof RangeError || error instanceof TypeError) {
      throw new AnalysisError("malformed", `${target.info.format}: ${error.message}`, {
        format: target.info.format,
      });
    }
    throw error;
  }
}

async function analyzeTargetUnsafe(
  target: LoadedTarget,
  options: AnalyzeOptions,
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
        plist && typeof plist === "object" && !Array.isArray(plist) ? Object.keys(plist).length : 0;
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
    case "jar": {
      const jar = strip(parseJar(bytes));
      return done(
        `Java archive: ${jar.classCount} classes in ${jar.packages.length} packages${
          jar.mainClass ? `, main ${jar.mainClass}` : ""
        }`,
        { kind: "jar", jar },
      );
    }
    case "java-class": {
      const javaClass = strip(parseJavaClass(bytes));
      return done(
        `Java class ${javaClass.name} (Java ${javaClass.version.java}), ${javaClass.methods.length} methods`,
        {
          kind: "java-class",
          javaClass,
        },
      );
    }
    case "dex": {
      const dex = strip(parseDex(bytes));
      return done(
        `DEX ${dex.version}: ${dex.counts.classes} classes, ${dex.counts.methods} methods, ${dex.counts.strings} strings`,
        {
          kind: "dex",
          dex,
        },
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
      const app = strip(
        await scanApplication(
          info,
          target.lazy ? asarTreeFromFile(info.path) : asarTree(bytes, info.path),
          options.js,
        ),
      );
      return done(
        app.coverage.complete
          ? `Electron ASAR: ${app.modules.length} JavaScript modules, ${app.ipcChannels.length} IPC channels`
          : app.coverage.remaining > 0
            ? `Electron ASAR, partial: ${app.coverage.scanned} of ${app.coverage.total} JavaScript files scanned, ${app.ipcChannels.length} IPC channels so far`
            : `Electron ASAR, incomplete: ${app.coverage.skipped} of ${app.coverage.total} JavaScript files could not be read, ${app.ipcChannels.length} IPC channels in the rest`,
        { kind: "javascript-app", app },
      );
    }
    case "directory": {
      if (isAppBundle(info.path)) {
        const bundle = strip(analyzeAppBundle(info.path));
        return done(
          `${
            bundle.platform === "macos" ? "macOS" : "iOS"
          } app ${bundle.name || bundle.bundleId} ${bundle.version} (${bundle.bundleId})${
            bundle.main ? ` · ${bundle.main.summary}` : ""
          }`,
          { kind: "bundle", bundle },
        );
      }
      const app = strip(await scanApplication(info, directoryTree(info.path), options.js));
      return done(
        `Directory: ${app.totals.files} files, ${
          app.coverage.complete
            ? `${app.modules.length} JavaScript modules`
            : app.coverage.remaining > 0
              ? `partial: ${app.coverage.scanned} of ${app.coverage.total} JavaScript files scanned`
              : `incomplete: ${app.modules.length} JavaScript modules read, some files unread or unlisted`
        }${app.electron ? " (Electron)" : ""}`,
        { kind: "javascript-app", app },
      );
    }
    case "javascript": {
      const text = decode(bytes);
      const script = scanJavaScript(text);
      if (script.truncated)
        limitations.push({ code: "scan_truncated", message: "Token budget exhausted." });
      const { limitations: bundleLimits, ...bundle } = analyzeBundle(text);
      limitations.push(...bundleLimits.filter((l) => l.code !== "scan_truncated"));
      // As for an application: a channel that is a parameter or a computed value leaves the row
      // without one, and the channel list is then not the whole picture.
      const channelless = script.ipc.filter(
        (u) => u.channel === null && !u.channelRef && !u.api.startsWith("contextBridge."),
      );
      if (channelless.length)
        limitations.push({
          code: "ipc_channel_unresolved",
          message: `${channelless.length} IPC call(s) pass a channel that is not a literal or a constant that could be followed (a parameter, a computed value). They are in the collection ipc without a channel: ${channelless
            .slice(0, 5)
            .map((u) => `${u.api} at line ${u.line}`)
            .join(", ")}${channelless.length > 5 ? ` … and ${channelless.length - 5} more` : ""}.`,
        });
      if (bundle.bundler) {
        findings.push({
          kind: "js.bundle",
          title: `${bundle.bundler} bundle with ${bundle.modules.length} modules${bundle.hasRuntime ? " and runtime" : ""}`,
          detail:
            bundle.vendors
              .filter((v) => v !== bundle.bundler)
              .slice(0, 8)
              .join(", ") || undefined,
          confidence: "confirmed",
        });
      }
      if (bundle.endpoints.length)
        findings.push({
          kind: "js.endpoints",
          title: `${bundle.endpoints.length} endpoint candidates`,
          detail: bundle.endpoints
            .slice(0, 5)
            .map((e) => e.value)
            .join(", "),
          confidence: "inferred",
        });
      if (bundle.storage.length)
        findings.push({
          kind: "js.storage",
          title: `${bundle.storage.length} client-side storage keys`,
          detail: bundle.storage
            .slice(0, 5)
            .map((e) => `${e.kind}:${e.value}`)
            .join(", "),
          confidence: "confirmed",
        });
      const summary = bundle.bundler
        ? `JavaScript ${bundle.bundler} bundle: ${bundle.modules.length} modules, ${bundle.endpoints.length} endpoint candidates${script.minified ? ", minified" : ""}`
        : `JavaScript (${script.moduleSystem}): ${script.references.length} references, ${script.exports.length} exports${script.minified ? ", minified" : ""}`;
      return done(summary, { kind: "javascript", script, bundle });
    }
    case "json": {
      const text = decode(bytes);
      if (info.path.endsWith(".map") || /"mappings"\s*:/.test(text.slice(0, 1 << 20))) {
        try {
          const map = summarizeSourceMap(text);
          return done(`Source map for ${map.file ?? "?"}: ${map.sources.length} sources`, {
            kind: "source-map",
            map,
          });
        } catch {
          /* fall through to HAR/JSON */
        }
      }
      if (/"log"\s*:/.test(text.slice(0, 4096))) {
        try {
          const har = strip(parseHar(bytes));
          return done(`HAR capture: ${har.entries.length} requests to ${har.hosts.length} hosts`, {
            kind: "har",
            har,
          });
        } catch {
          /* not a HAR after all; fall through to plain JSON */
        }
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
        throw new AnalysisError("malformed", "File looks like JSON but does not parse");
      }
    }
    default:
      limitations.push({
        code: "unknown_format",
        message: "No parser recognized this file; strings and byte windows are still available.",
      });
      return done(`Unrecognized format (${bytes.length} bytes)`, {
        kind: "unknown",
        preview: Buffer.from(bytes.subarray(0, 64)).toString("hex"),
      });
  }
}
