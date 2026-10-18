import { existsSync, lstatSync, readFileSync } from "node:fs";
import { isStreamName, isSymlink, writeFileNoFollow, type WriteFileOptions } from "./safeWrite.js";
import { resolve as resolvePath } from "node:path";
import {
  analyzeTarget,
  type AnalyzeOptions,
  type AnyAnalysis,
  type AnalysisData,
  type JsScanRequest,
} from "./analyzers/dispatch.js";
import { analyzeInWorker } from "./analyzers/worker.js";
import {
  recoverBundle,
  recoverSourceMap,
  type RecoveryResult,
  type OpenedCheck,
  type WriteGuard,
} from "./javascript/recover.js";
import {
  compareItems,
  positionalFields,
  type CompareCompleteness,
  type CompareOptions,
  type CompareResult,
  type SideCoverage,
  storageSlot,
  type UnresolvedFamily,
} from "./compare.js";
import { UnknownsLedger } from "./unknowns.js";
import { pageOf, type CollectionPage, type CollectionQuery } from "./paging.js";

export type { CollectionPage, CollectionQuery } from "./paging.js";
import { disassembleEvm, evmBytesFrom } from "./formats/evm.js";
import { classifyString, extractStrings } from "./binary/strings.js";
import { AnalysisError, type Limitation, type TargetInfo } from "./model.js";
import { interfaceMap } from "./javascript/interfaces.js";
import { loadTarget, type LoadedTarget } from "./target.js";
import { CORE_VERSION } from "./version.js";
import { sourceWindow, type SourceWindow } from "./source.js";

export interface TargetRecord {
  id: string;
  info: TargetInfo;
  openedAt: string;
  analyzed: boolean;
}

const hasItems = (counts: Record<string, number>, name: string): boolean => (counts[name] ?? 0) > 0;

/**
 * Lists of a JavaScript application that the scan does not read: the runtime comes from the
 * build's binary and metadata, so a partial scan or an unreadable file leaves it whole.
 */
const NOT_FROM_SCAN = new Set(["runtime"]);

/** One collection both targets have, as `Session.compareAll` counts it. */
export interface CollectionComparison {
  collection: string;
  /** Field the items were matched by; null when matched by their full content. */
  key: string | null;
  added: number;
  removed: number;
  changed: number;
  /** Matched items whose only differences are addresses or lines. */
  relocated: number;
  /** Found on one side in a file the other side did not read. */
  unknown: number;
  unchanged: number;
  totals: { a: number; b: number };
  /** True iff `!completeness.complete`: kept for callers that read only this flag. */
  partial: boolean;
  /** How much of both sides was compared and what keeps the result from being whole. */
  completeness: CompareCompleteness;
}

export interface CompareAllResult {
  /** Collections with items on at least one side, in the order the first target lists them. */
  collections: CollectionComparison[];
  /** Collections only one target has (with items). */
  onlyA: string[];
  onlyB: string[];
  /** A JavaScript application read only in part: items in unread files are unknown, not gone. */
  partialScan: { a: boolean; b: boolean };
  /**
   * Windows present in both builds whose derived settings changed what their pages may do. A
   * change here is a fact to review, not a finding: whether it matters depends on what the window
   * loads.
   */
  windowChanges: WindowChange[];
}

export interface WindowChange {
  /** `file::windowName`, as the windows comparison matches them. */
  window: string;
  setting:
    | "nodeIntegrationInEffect"
    | "contextIsolationInEffect"
    | "sandboxInEffect"
    | "pageRequire";
  before: string;
  after: string;
  /** `unclear` when either side is unknown. */
  direction: "more permissive" | "less permissive" | "unclear";
}

/** For each derived window setting, the values under which a page can do more. */
const PERMISSIVE: Record<WindowChange["setting"], readonly string[]> = {
  nodeIntegrationInEffect: ["on", "default on"],
  contextIsolationInEffect: ["off", "default off"],
  sandboxInEffect: ["off", "default off"],
  pageRequire: ["yes", "yes by default"],
};

/** One collection of two targets compared, as `Session.compareCollection` returns it. */
export interface CollectionDiff {
  diff: CompareResult;
  /**
   * A bounded preview of each side (its first 2,000 items) for callers that print items. The
   * comparison itself covers every item within `COMPARE_BUDGET`; see `diff.completeness`.
   */
  left: CollectionPage;
  right: CollectionPage;
}

/** What `compareCollection` compares per side at most; beyond it the result says `budget`. */
export interface CompareBudget {
  items: number;
  /** UTF-8 bytes of the items serialized as JSON. */
  bytes: number;
}

export const COMPARE_BUDGET: Readonly<CompareBudget> = { items: 200_000, bytes: 256 << 20 };

/** The first items of `items` that fit `budget`. */
function withinBudget(items: readonly unknown[], budget: CompareBudget): readonly unknown[] {
  const limit = Math.min(items.length, Math.max(0, budget.items));
  let bytes = 0;
  for (let i = 0; i < limit; i++) {
    bytes += Buffer.byteLength(JSON.stringify(items[i], jsonReplacer) ?? "null");
    if (bytes > budget.bytes) return items.slice(0, i);
  }
  return limit === items.length ? items : items.slice(0, limit);
}

const jsonReplacer = (_key: string, value: unknown): unknown =>
  typeof value === "bigint" ? value.toString() : value;

export interface CompareCollectionOptions {
  /** Identity field; undefined picks one (see `compareItems`). */
  key?: string | undefined;
  ignore?: readonly string[] | undefined;
  /** Count differences in position fields (addresses, lines) as changes. */
  strict?: boolean | undefined;
  /** Resource limit per side (default `COMPARE_BUDGET`); for tests and callers with less room. */
  budget?: CompareBudget | undefined;
  /** See `CompareOptions.onOneSided`. */
  onOneSided?: CompareOptions["onOneSided"];
}

export interface StringsQuery extends CollectionQuery {
  minLength?: number;
  utf16?: boolean;
  tag?: string;
}

interface TaggedString {
  offset: number;
  encoding: "ascii" | "utf16le";
  value: string;
  tags: string[];
}

interface Pending {
  controller: AbortController;
  waiters: number;
  promise: Promise<AnyAnalysis>;
}

interface Entry {
  record: TargetRecord;
  loaded: LoadedTarget;
  analysis?: AnyAnalysis;
  pending?: Pending;
  /** Options for the next analysis run only (a continued scan). */
  next?: AnalyzeOptions;
  strings?: { key: string; items: TaggedString[] };
  collections?: Record<string, unknown[]>;
}

/**
 * Holds opened targets and their analyses so every surface (CLI, MCP, HTTP)
 * can address them by a stable id derived from the content hash.
 */
export class Session {
  private readonly entries = new Map<string, Entry>();
  /** Material open questions recorded during investigations; exported with analyses. */
  readonly unknowns = new UnknownsLedger();

  constructor(
    private readonly options: {
      maxTargets?: number;
      maxBytes?: number;
      /**
       * Run analyses in a worker thread so servers stay responsive, honour the timeout and the
       * abort signal, and survive a parser that exhausts memory. Without it, analysis runs on the
       * caller's thread: a timeout is not enforced and cancellation only releases the waiter.
       */
      worker?: boolean;
      analysisTimeoutMs?: number;
      /** V8 old-space cap for the analysis worker in MiB (default 2048). */
      maxWorkerHeapMb?: number;
    } = {},
  ) {}

  list(): TargetRecord[] {
    return [...this.entries.values()].map((e) => e.record);
  }

  async open(path: string): Promise<TargetRecord> {
    const loaded = await loadTarget(path, this.options.maxBytes);
    return this.register(loaded);
  }

  register(loaded: LoadedTarget): TargetRecord {
    // An app found inside a packaged build is a target of its own: the build adds facts (a
    // bundle's Info.plist and executable) that the same archive opened alone does not have.
    const { container } = loaded.info;
    const id = container
      ? `c_${hashText(`${container.path}\0${container.entry}\0${loaded.info.sha256}`)}`
      : loaded.info.format === "directory"
        ? `d_${hashText(loaded.info.path)}`
        : `t_${loaded.info.sha256.slice(0, 12)}`;
    const existing = this.entries.get(id);
    if (existing) return existing.record;
    const max = this.options.maxTargets ?? 32;
    if (this.entries.size >= max) {
      const oldest = this.entries.keys().next().value;
      if (oldest) this.entries.delete(oldest);
    }
    const record: TargetRecord = {
      id,
      info: loaded.info,
      openedAt: new Date().toISOString(),
      analyzed: false,
    };
    this.entries.set(id, { record, loaded });
    return record;
  }

  close(id: string): boolean {
    return this.entries.delete(id);
  }

  get(id: string): TargetRecord {
    return this.entry(id).record;
  }

  private entry(id: string): Entry {
    const e = this.entries.get(id);
    if (!e) throw new AnalysisError("not_found", `No open target ${id}; call open first`, { id });
    return e;
  }

  /**
   * Analyzes once per target. Concurrent callers share the running analysis;
   * each caller can cancel its own wait, and the worker is stopped only when
   * nobody is waiting any more.
   */
  async analyze(id: string, signal?: AbortSignal): Promise<AnyAnalysis> {
    const e = this.entry(id);
    if (e.analysis) return e.analysis;
    if (signal?.aborted)
      throw new AnalysisError("cancelled", "Analysis cancelled by the caller", {
        path: e.loaded.info.path,
      });
    if (!e.pending) {
      const controller = new AbortController();
      const run = this.options.worker
        ? analyzeInWorker(e.loaded, {
            ...(this.options.analysisTimeoutMs
              ? { timeoutMs: this.options.analysisTimeoutMs }
              : {}),
            maxOldGenerationSizeMb: this.options.maxWorkerHeapMb ?? 2048,
            signal: controller.signal,
            ...(e.next ? { analyze: e.next } : {}),
          })
        : analyzeTarget(e.loaded, e.next ?? {});
      delete e.next;
      const pending: Pending = { controller, waiters: 0, promise: run };
      pending.promise = run.then(
        (analysis) => {
          if (e.pending === pending) delete e.pending;
          e.analysis = analysis;
          e.record.analyzed = true;
          return analysis;
        },
        (error: unknown) => {
          if (e.pending === pending) delete e.pending;
          throw error;
        },
      );
      e.pending = pending;
    }
    const pending = e.pending;
    pending.waiters++;
    const release = (): void => {
      pending.waiters--;
      if (pending.waiters === 0 && !e.analysis) pending.controller.abort();
    };
    if (!signal) {
      try {
        return await pending.promise;
      } finally {
        release();
      }
    }
    return new Promise<AnyAnalysis>((resolve, reject) => {
      const onAbort = (): void => {
        release();
        reject(
          new AnalysisError("cancelled", "Analysis cancelled by the caller", {
            path: e.loaded.info.path,
          }),
        );
      };
      signal.addEventListener("abort", onAbort, { once: true });
      pending.promise.then(
        (analysis) => {
          signal.removeEventListener("abort", onAbort);
          if (!signal.aborted) {
            release();
            resolve(analysis);
          }
        },
        (error: unknown) => {
          signal.removeEventListener("abort", onAbort);
          if (!signal.aborted) {
            release();
            reject(error);
          }
        },
      );
    });
  }

  /**
   * Reads more of a JavaScript application than the first analysis did: the next batch, every
   * unread file, or the files under given paths. The stored scan state decides what is unread,
   * so nothing is read twice. If the run fails or is cancelled, the target falls back to the last
   * stored state on the next `analyze`.
   */
  async continueAnalysis(
    id: string,
    request: JsScanRequest,
    signal?: AbortSignal,
  ): Promise<AnyAnalysis> {
    const e = this.entry(id);
    if (e.pending) await e.pending.promise.catch(() => undefined);
    delete e.analysis;
    delete e.collections;
    e.record.analyzed = false;
    e.next = { js: request } satisfies AnalyzeOptions;
    return this.analyze(id, signal);
  }

  /**
   * For a JavaScript application whose analysis has not read every file: how much it has read.
   * Null when the analysis is complete or the target is something else. Whatever is derived
   * from such an analysis (a page, a comparison) covers the scanned part only and must say so.
   * With `collection`: null as well for a list the scan does not read (`runtime`), which is
   * whole however much of the JavaScript was read.
   */
  async partial(
    id: string,
    collection?: string,
  ): Promise<{ scanned: number; total: number; remaining: number; skipped: number } | null> {
    if (collection !== undefined && NOT_FROM_SCAN.has(collection)) return null;
    const analysis = await this.analyze(id);
    if (analysis.data.kind !== "javascript-app" || analysis.data.app.coverage.complete) return null;
    const { scanned, total, remaining, skipped } = analysis.data.app.coverage;
    return { scanned, total, remaining, skipped };
  }

  /**
   * Which files a JavaScript application's analysis read, for `compareItems`: an item that sits
   * in a file the other side did not read is unknown there, not added or removed. Null for other
   * targets, whose analyses are whole.
   */
  async coverage(id: string): Promise<SideCoverage | null> {
    const analysis = await this.analyze(id);
    if (analysis.data.kind === "javascript") {
      // One script: nothing to place by file, but a value it could not resolve may be any item.
      const unresolved = new Unresolved();
      const { script, bundle } = analysis.data;
      for (const u of script.ipc)
        if (u.channel === null)
          unresolved.add(u.api.startsWith("contextBridge.") ? "bridge" : "ipc", "*");
      for (const row of [...bundle.endpoints, ...bundle.urls])
        if (computedValue(row.value)) unresolved.add("endpoint", "*");
      for (const row of bundle.storage)
        if (computedValue(row.value)) unresolved.add("storage", "*");
      unresolved.fromLimitations(analysis.limitations);
      return { complete: true, read: new Set(), unreadable: new Set(), unresolved: unresolved.map };
    }
    if (analysis.data.kind !== "javascript-app") return null;
    const { app } = analysis.data;
    const unresolved = new Unresolved();
    for (const m of app.modules)
      for (const u of m.ipc)
        if (u.channel === null)
          unresolved.add(u.api.startsWith("contextBridge.") ? "bridge" : "ipc", m.id);
    // A member whose object could not be read, or whose channel is a constant never found. A
    // member that simply forwards no literal channel is itself known and hides no other member.
    for (const b of app.contextBridge)
      if (b.member === null || (b.channel === null && b.channelRef))
        unresolved.add("bridge", b.file);
    // an exposure kept without its name's scope read to the end may be another binding there
    for (const x of app.bridgeExposures ?? []) if (x.undecided) unresolved.add("bridge", x.file);
    for (const w of app.webPreferences) if (w.value === null) unresolved.add("window", w.file);
    for (const w of app.windows ?? [])
      if ([w.nodeIntegration, w.contextIsolation, w.sandbox].includes("computed"))
        unresolved.add("window", w.file);
    for (const row of [...app.endpoints, ...app.urls])
      if (computedValue(row.value)) unresolved.add("endpoint", row.file);
    // per file and kind: an unread sessionStorage key cannot be a localStorage key
    for (const row of app.storage)
      if (computedValue(row.value)) unresolved.add("storage", storageSlot(row.file, row.kind));
    unresolved.fromLimitations(analysis.limitations);
    return {
      complete: app.coverage.complete,
      read: new Set(app.modules.map((m) => m.id)),
      unreadable: new Set([
        ...(app.coverage.skippedFiles ?? []),
        ...(app.coverage.partialFiles ?? []),
      ]),
      unresolved: unresolved.map,
    };
  }

  /**
   * Every item of a collection, for comparisons inside core (`compareCollection`, the release
   * report). Adapters page with `collection` instead; this list is not bounded.
   */
  async items(id: string, name: string): Promise<readonly unknown[]> {
    const all = await this.collectionTable(id);
    const items = all[name];
    if (!items)
      throw new AnalysisError(
        "invalid_input",
        `Unknown collection "${name}"; available: ${Object.keys(all).join(", ")}`,
        { available: Object.keys(all) },
      );
    return items;
  }

  /** Names of the list-like collections available for this target after analysis. */
  private async collectionTable(id: string): Promise<Record<string, unknown[]>> {
    const analysis = await this.analyze(id);
    const e = this.entry(id);
    e.collections ??= collectionsOf(analysis, e.loaded);
    return e.collections;
  }

  async collections(id: string): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const [name, items] of Object.entries(await this.collectionTable(id)))
      out[name] = items.length;
    return out;
  }

  /**
   * Diff of one collection of two targets. Every item of both sides is compared, up to
   * `COMPARE_BUDGET` per side; past it the result says `budget` in `diff.completeness`, and an
   * item found on one side only while the other side was cut is `unknown`, not added or removed.
   * So is an item in a file the other side did not read, or in a file where the other side has
   * a value of the same kind it could not resolve. `left`/`right` are a bounded preview.
   */
  async compareCollection(
    idA: string,
    idB: string,
    name: string,
    options: CompareCollectionOptions = {},
  ): Promise<CollectionDiff> {
    const [left, right] = await Promise.all([
      this.collection(idA, name, { limit: 2000, maxBytes: 64 << 20 }),
      this.collection(idB, name, { limit: 2000, maxBytes: 64 << 20 }),
    ]);
    const [allA, allB] = await Promise.all([this.items(idA, name), this.items(idB, name)]);
    const budget = options.budget ?? COMPARE_BUDGET;
    const [partA, partB] = [withinBudget(allA, budget), withinBudget(allB, budget)];
    const diff = compareItems(partA, partB, {
      key: options.key,
      collection: name,
      ignore: options.ignore ?? [],
      positional: options.strict
        ? []
        : positionalFields(name, [this.get(idA).info.format, this.get(idB).info.format]),
      // what the JavaScript scan read says nothing about a list read from elsewhere
      coverage: NOT_FROM_SCAN.has(name)
        ? undefined
        : { a: await this.coverage(idA), b: await this.coverage(idB) },
      cut: { a: partA.length < allA.length, b: partB.length < allB.length },
      total: { a: allA.length, b: allB.length },
      onOneSided: options.onOneSided,
    });
    return { diff, left, right };
  }

  /**
   * Counts of added, removed, changed, relocated and unchanged items for every collection the two
   * targets share: the overview before diffing one collection. Every item is compared within
   * `COMPARE_BUDGET`; `completeness` says what was compared and why a result is not whole.
   */
  async compareAll(idA: string, idB: string): Promise<CompareAllResult> {
    const [countsA, countsB] = await Promise.all([this.collections(idA), this.collections(idB)]);
    const collections: CollectionComparison[] = [];
    for (const name of Object.keys(countsA)) {
      if (!(name in countsB) || (countsA[name] === 0 && countsB[name] === 0)) continue;
      const { diff } = await this.compareCollection(idA, idB, name);
      collections.push({
        collection: name,
        key: diff.key,
        added: diff.added.length,
        removed: diff.removed.length,
        changed: diff.changed.length,
        relocated: diff.relocated,
        unknown: diff.unknown.length,
        unchanged: diff.unchanged,
        totals: { ...diff.completeness.total },
        partial: !diff.completeness.complete,
        completeness: diff.completeness,
      });
    }
    const windowChanges: WindowChange[] = [];
    if (collections.some((c) => c.collection === "windows" && c.changed > 0)) {
      const { diff } = await this.compareCollection(idA, idB, "windows");
      for (const item of diff.changed)
        for (const f of item.fields) {
          if (!(f.field in PERMISSIVE)) continue;
          const setting = f.field as WindowChange["setting"];
          const [before, after] = [String(f.before), String(f.after)];
          const open = (v: string): boolean => PERMISSIVE[setting].includes(v);
          windowChanges.push({
            window: item.key,
            setting,
            before,
            after,
            direction:
              before === "unknown" || after === "unknown"
                ? "unclear"
                : open(after) && !open(before)
                  ? "more permissive"
                  : open(before) && !open(after)
                    ? "less permissive"
                    : "unclear",
          });
        }
    }
    return {
      collections,
      windowChanges,
      onlyA: Object.keys(countsA).filter((n) => hasItems(countsA, n) && !(n in countsB)),
      onlyB: Object.keys(countsB).filter((n) => hasItems(countsB, n) && !(n in countsA)),
      partialScan: { a: (await this.partial(idA)) !== null, b: (await this.partial(idB)) !== null },
    };
  }

  /**
   * Lines around `line` of a file a JavaScript application's analysis read, so a fact's
   * `file:line` can be opened. Other files and other targets are refused.
   */
  async source(id: string, file: string, line: number, context?: number): Promise<SourceWindow> {
    const analysis = await this.analyze(id);
    if (analysis.data.kind !== "javascript-app")
      throw new AnalysisError(
        "invalid_input",
        "Source lines are available for Electron archives and application directories",
      );
    const read = new Map(analysis.data.app.modules.map((m) => [m.id, m.size]));
    return sourceWindow(this.entry(id).loaded, read, file, line, context);
  }

  async collection(id: string, name: string, query: CollectionQuery = {}): Promise<CollectionPage> {
    const all = await this.collectionTable(id);
    const items = all[name];
    if (!items) {
      throw new AnalysisError(
        "invalid_input",
        `Unknown collection "${name}"; available: ${Object.keys(all).join(", ")}`,
        { available: Object.keys(all) },
      );
    }
    return pageOf(name, items, query);
  }

  strings(
    id: string,
    query: StringsQuery = {},
  ): CollectionPage<{
    offset: number;
    encoding: string;
    value: string;
    /** Full length when `value` was cut (values longer than 4096 characters). */
    length?: number;
    tags: string[];
  }> {
    const e = this.entry(id);
    if (e.loaded.info.format === "directory")
      throw new AnalysisError("invalid_input", "Strings are extracted from files, not directories");
    const minLength = query.minLength ?? 4;
    const key = `${minLength}:${query.utf16 ? 1 : 0}`;
    if (!e.strings || e.strings.key !== key) {
      const extracted = extractStrings(e.loaded.bytes, {
        minLength,
        utf16: query.utf16 ?? false,
        max: 200_000,
      });
      e.strings = {
        key,
        items: extracted.map((x) => ({ ...x, tags: classifyString(x.value) })),
      };
    }
    let items = e.strings.items;
    if (query.tag) items = items.filter((s) => s.tags.includes(query.tag!));
    return pageOf("strings", items, query) as CollectionPage<(typeof items)[number]>;
  }

  /** Whole-file contents for in-memory targets (empty for lazy ones). */
  rawBytes(id: string): Uint8Array {
    return this.entry(id).loaded.bytes;
  }
  bytes(
    id: string,
    offset: number,
    length: number,
  ): {
    offset: number;
    length: number;
    hex: string;
    ascii: string;
    total: number;
  } {
    const e = this.entry(id);
    const total = e.loaded.bytes.length;
    if (offset < 0 || offset > total)
      throw new AnalysisError("invalid_input", `offset ${offset} outside 0..${total}`);
    const take = Math.max(0, Math.min(length, 65536, total - offset));
    const slice = e.loaded.bytes.subarray(offset, offset + take);
    let ascii = "";
    for (const b of slice) ascii += b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : ".";
    return {
      offset,
      length: take,
      hex: Buffer.from(slice).toString("hex"),
      ascii,
      total,
    };
  }

  /** Writes recoverable sources (bundle modules or source-map originals) into a new directory. */
  async recover(
    id: string,
    outputDir: string,
    options: { guard?: WriteGuard | undefined; check?: OpenedCheck | undefined } = {},
  ): Promise<RecoveryResult> {
    const analysis = await this.analyze(id);
    const e = this.entry(id);
    const text = (): string => new TextDecoder().decode(e.loaded.bytes);
    // A link whose target is missing: creating the directory would fail with EEXIST or create it
    // wherever the link points. Refuse it as input instead.
    if (isSymlink(outputDir) && !existsSync(outputDir))
      throw new AnalysisError(
        "invalid_input",
        `${resolvePath(outputDir)} is a symbolic link to a missing location; choose a new directory`,
        { outputDir: resolvePath(outputDir) },
      );
    if (analysis.data.kind === "javascript")
      return recoverBundle(text(), outputDir, undefined, options.guard, options.check);
    if (analysis.data.kind === "source-map")
      return recoverSourceMap(text(), outputDir, options.guard, options.check);
    throw new AnalysisError(
      "invalid_input",
      `recover needs a single JavaScript bundle file or a source map; this target is ${analysis.data.kind}.${
        analysis.data.kind === "javascript-app"
          ? " For an app or .asar, page its modules (hexvero collection <path> modules) and recover one bundle file."
          : ""
      }`,
      { kind: analysis.data.kind },
    );
  }

  /**
   * Writes the complete analysis as JSON. Refuses to replace an existing file unless `overwrite`
   * is set, so an agent steered by target content cannot clobber arbitrary files by accident.
   */
  async export(
    id: string,
    destination: string,
    options: {
      overwrite?: boolean | undefined;
      /** Replace an existing file only when it is an earlier hexvero export (MCP sets this). */
      onlyReplaceExports?: boolean | undefined;
      /** Passed to writeFileNoFollow: re-check a write policy right before and after opening. */
      beforeOpen?: WriteFileOptions["beforeOpen"];
      afterOpen?: WriteFileOptions["afterOpen"];
    } = {},
  ): Promise<{ path: string; bytes: number }> {
    // `-` and /dev/stdout-like names are written as they are, for the CLI only: an MCP export
    // (onlyReplaceExports) is always a regular file inside the write roots.
    if (options.onlyReplaceExports && isStreamName(destination))
      throw new AnalysisError("invalid_input", `${destination} is a stream; an export is a file`, {
        path: destination,
      });
    const path = isStreamName(destination) ? destination : resolvePath(destination);
    const notAnExport = `exists and is not an earlier hexvero export; it is not replaced`;
    const inspect = (head: string): string | null =>
      /^\{\s*"hexvero":\s*1\b/.test(head) ? null : notAnExport;
    // Checked before the analysis so a refusal is quick; the write below checks again on the
    // opened file, which is what counts. (The CLI may write to /dev/stdout, itself a link.)
    if (options.onlyReplaceExports && isSymlink(path))
      throw new AnalysisError(
        "invalid_input",
        `${path} is a symbolic link; hexvero does not write through one`,
        { path, code: "ELOOP" },
      );
    if (options.overwrite && options.onlyReplaceExports && existsSync(path)) {
      const head = lstatSync(path).isFile() ? readFileSync(path, "utf8").slice(0, 64) : "";
      if (inspect(head))
        throw new AnalysisError("invalid_input", `${path} ${notAnExport}`, { path });
    }
    const analysis = await this.analyze(id);
    const text = JSON.stringify(
      {
        hexvero: 1,
        generator: { name: "@hexvero/core", version: CORE_VERSION },
        exportedAt: new Date().toISOString(),
        // Analyses that stopped short (a size cap, a partial scan, an unreadable part) say so here,
        // so a reader cannot take a short result for a whole one without reading `limitations`.
        complete: analysis.limitations.length === 0,
        incomplete: [...new Set(analysis.limitations.map((l) => l.code))],
        // Fields that differ between two exports of the same input; everything else is the same
        // byte for byte.
        volatile: ["exportedAt", "target.openedAt", "analysis.durationMs"],
        target: this.get(id),
        analysis,
        unknowns: this.unknowns.list({ targetId: id, limit: 1000 }).items,
      },
      replacer,
      2,
    ).concat("\n");
    try {
      await writeFileNoFollow(path, text, {
        overwrite: options.overwrite,
        inspect: options.onlyReplaceExports ? inspect : undefined,
        beforeOpen: options.beforeOpen,
        afterOpen: options.afterOpen,
      });
    } catch (error) {
      if (error instanceof AnalysisError) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "EACCES" || code === "EISDIR" || code === "EPERM")
        throw new AnalysisError("invalid_input", `cannot write ${path} (${code})`, { path, code });
      throw error;
    }
    return { path, bytes: Buffer.byteLength(text) };
  }
}

const replacer = (_key: string, value: unknown): unknown =>
  typeof value === "bigint" ? value.toString() : value;

function hashText(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0).toString(16).padStart(8, "0");
}

interface ObjcLike {
  classes: Array<{
    name: string;
    swiftName: string | null;
    superClass: string | null;
    methods: Array<{ name: string; kind: string; types: string; implementation: string | null }>;
    protocols: string[];
    isSwift: boolean;
    ivars: Array<Record<string, unknown>>;
    properties: unknown[];
  }>;
  protocols: Array<{ name: string }>;
  categories: unknown[];
}

function addObjc(
  out: Record<string, unknown[]>,
  objc: ObjcLike | undefined,
  swiftSymbols: unknown[] | undefined,
): void {
  if (objc) {
    out["classes"] = objc.classes.map((c) => ({
      name: c.name,
      swiftName: c.swiftName,
      superClass: c.superClass,
      methods: c.methods.length,
      ivars: c.ivars.length,
      properties: c.properties.length,
      protocols: c.protocols,
      swift: c.isSwift,
    }));
    out["methods"] = objc.classes.flatMap((c) =>
      c.methods.map((m) => ({
        class: c.name,
        kind: m.kind,
        selector: m.name,
        types: m.types,
        implementation: m.implementation,
      })),
    );
    out["ivars"] = objc.classes.flatMap((c) => c.ivars.map((v) => ({ class: c.name, ...v })));
    out["protocols"] = objc.protocols;
    out["categories"] = objc.categories;
  }
  if (swiftSymbols?.length) out["swiftSymbols"] = swiftSymbols;
}

/** Flattens an analysis into named, pageable lists. Universal entries come first. */
export function collectionsOf(
  analysis: AnyAnalysis,
  loaded: LoadedTarget,
): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {
    findings: analysis.findings,
    limitations: analysis.limitations,
  };
  const d: AnalysisData = analysis.data;
  switch (d.kind) {
    case "binary": {
      const b = d.binary;
      if (b.kind === "elf") {
        out["sections"] = b.elf.sections;
        out["segments"] = b.elf.segments;
        out["symbols"] = b.elf.symbols;
        out["imports"] = b.elf.symbols
          .filter((s) => s.section === "UND" && s.table === "dynsym")
          .map((s) => ({ name: s.name, type: s.type, binding: s.binding }));
        out["exports"] = b.elf.symbols
          .filter((s) => s.section !== "UND" && s.table === "dynsym" && s.binding !== "LOCAL")
          .map((s) => ({
            name: s.name,
            value: s.value,
            size: s.size,
            type: s.type,
          }));
        out["libraries"] = b.elf.needed.map((name) => ({ name }));
      } else if (b.kind === "pe") {
        out["sections"] = b.pe.sections;
        out["imports"] = b.pe.imports.flatMap((i) =>
          i.functions.map((name) => ({ dll: i.dll, name })),
        );
        out["exports"] = b.pe.exports;
        out["libraries"] = b.pe.imports.map((i) => ({
          name: i.dll,
          functions: i.functions.length,
        }));
        if (b.dotnet) {
          out["types"] = b.dotnet.types;
          out["methods"] = b.dotnet.types.flatMap((t) =>
            t.members.map((m) => ({
              type: t.namespace ? `${t.namespace}.${t.name}` : t.name,
              name: m.name,
              flags: m.flags,
              rva: m.rva,
              ilSize: m.il?.size ?? null,
              instructions: m.il?.instructions ?? null,
              calls: m.il?.calls.length ?? null,
              strings: m.il?.strings.length ?? null,
              ilSha256: m.il?.ilSha256 ?? null,
            })),
          );
          out["pinvokes"] = b.dotnet.pinvokes;
          out["calls"] = b.dotnet.types.flatMap((t) =>
            t.members.flatMap((m) =>
              (m.il?.calls ?? []).map((callee) => ({
                from: `${t.namespace ? `${t.namespace}.` : ""}${t.name}::${m.name}`,
                to: callee,
              })),
            ),
          );
          if (b.dotnet.instructions.length) out["cil"] = b.dotnet.instructions;
          out["userStrings"] = b.dotnet.userStrings.map((value) => ({ value }));
          out["assemblyRefs"] = b.dotnet.assemblyRefs;
        }
      } else if (b.kind === "macho") {
        addObjc(out, b.objc, b.swiftSymbols);
        out["segments"] = b.macho.segments;
        out["sections"] = b.macho.segments.flatMap((s) =>
          s.sections.map((x) => ({ segment: s.name, ...x })),
        );
        out["symbols"] = b.macho.symbols;
        out["imports"] = b.macho.symbols
          .filter((s) => s.type === "undefined")
          .map((s) => ({ name: s.name }));
        out["exports"] = b.macho.symbols
          .filter((s) => s.type === "external")
          .map((s) => ({ name: s.name, value: s.value }));
        out["libraries"] = b.macho.dylibs.map((x) => ({
          name: x.path,
          kind: x.kind,
        }));
      } else if (b.kind === "macho-fat") {
        out["slices"] = b.slices.map((s) => ({
          cpu: s.cpu,
          offset: s.offset,
          size: s.size,
          fileType: s.macho.fileType,
          platform: s.macho.platform,
        }));
        const first = b.slices[0];
        if (first) {
          addObjc(out, first.objc, first.swiftSymbols);
          out["symbols"] = first.macho.symbols;
          out["libraries"] = first.macho.dylibs.map((x) => ({
            name: x.path,
            kind: x.kind,
          }));
          out["segments"] = first.macho.segments;
        }
      }
      if ("go" in b && b.go) out["goDependencies"] = b.go.dependencies;
      break;
    }
    case "wasm":
      out["imports"] = d.wasm.imports;
      out["exports"] = d.wasm.exports;
      out["types"] = d.wasm.types.map((signature, index) => ({
        index,
        signature,
      }));
      out["sections"] = d.wasm.sections;
      break;
    case "evm":
      out["selectors"] = d.evm.selectors;
      out["instructions"] = disassembleEvm(evmBytesFrom(loaded.bytes), 50_000);
      out["opcodes"] = Object.entries(d.evm.opcodeHistogram)
        .map(([name, count]) => ({ name, count }))
        .toSorted((a, b) => b.count - a.count);
      break;
    case "sqlite":
      out["tables"] = d.sqlite.tables.map(({ sample: _s, ...t }) => t);
      out["columns"] = d.sqlite.tables.flatMap((t) =>
        t.columns.map((c) => ({ table: t.name, ...c })),
      );
      out["indexes"] = d.sqlite.indexes;
      out["triggers"] = d.sqlite.triggers;
      out["samples"] = d.sqlite.tables.flatMap((t) =>
        t.sample.map((row) => ({ table: t.name, row })),
      );
      break;
    case "har":
      out["requests"] = d.har.entries;
      out["hosts"] = d.har.hosts;
      out["endpoints"] = d.har.apiEndpoints;
      break;
    case "apk":
      out["permissions"] = d.apk.permissions.map((name) => ({ name }));
      out["components"] = d.apk.components;
      out["libraries"] = Object.entries(d.apk.nativeLibraries).flatMap(([abi, libs]) =>
        libs.map((name) => ({ abi, name })),
      );
      out["files"] = d.apk.largestFiles;
      out["classes"] = d.apk.classes;
      out["packages"] = d.apk.packages;
      out["dexFiles"] = d.apk.dexFiles;
      if (d.apk.resourceEntries.length) out["resources"] = d.apk.resourceEntries;
      if (d.apk.flutter) out["dartSnapshots"] = d.apk.flutter.snapshots;
      break;
    case "bundle":
      bundleLists(d.bundle, out);
      break;
    case "zip":
      out["files"] = d.zip.entries;
      break;
    case "jar":
      out["classes"] = d.jar.classes;
      out["packages"] = d.jar.packages;
      out["manifest"] = Object.entries(d.jar.manifest).map(([key, value]) => ({
        key,
        value,
      }));
      break;
    case "java-class":
      out["methods"] = d.javaClass.methods;
      out["fields"] = d.javaClass.fields;
      out["referencedMethods"] = d.javaClass.referencedMethods.map((name) => ({
        name,
      }));
      out["referencedClasses"] = d.javaClass.referencedClasses.map((name) => ({
        name,
      }));
      out["constants"] = d.javaClass.strings.map((value) => ({ value }));
      break;
    case "dex":
      out["classes"] = d.dex.classes;
      out["packages"] = d.dex.packages;
      out["dexStrings"] = d.dex.strings.map((value) => ({ value }));
      break;
    case "javascript-app":
      // the bundle an app was found in: its lists first, as when the bundle is analyzed alone
      if (d.native) bundleLists(d.native, out);
      out["modules"] = d.app.modules.map(({ references: _r, ipc: _i, ...m }) => ({
        ...m,
        references: _r.length,
        ipc: _i.length,
      }));
      out["edges"] = d.app.edges;
      out["externals"] = d.app.externals;
      out["ipcChannels"] = d.app.ipcChannels;
      if (d.app.webPreferences.length) out["webPreferences"] = d.app.webPreferences;
      if (d.app.windows?.length) out["windows"] = d.app.windows;
      if (d.app.contextBridge.length) out["contextBridge"] = d.app.contextBridge;
      if (d.app.contextBridge.length) out["interfaces"] = interfaceMap(d.app, analysis.limitations);
      // Listed whenever there is a bridge (also empty), so a removed exposure compares against
      // the other side's bridge and its unreadable entries instead of a missing list.
      if (d.app.contextBridge.length) out["bridgeExposures"] = d.app.bridgeExposures ?? [];
      // Listed whenever windows or handlers were read, so a handler that is gone is `removed`.
      if (d.app.windows?.length || d.app.navigationHandlers?.length)
        out["navigationHandlers"] = d.app.navigationHandlers ?? [];
      out["ipc"] = d.app.modules.flatMap((m) => m.ipc.map((u) => ({ module: m.id, ...u })));
      if (d.app.endpoints.length) out["endpoints"] = d.app.endpoints;
      if (d.app.storage.length) out["storage"] = d.app.storage;
      if (d.app.urls.length) out["urls"] = d.app.urls;
      out["sourceMaps"] = d.app.sourceMaps;
      // the runtime of a packaged build; an archive or directory alone ships none (no list)
      if (d.runtime?.shipped) out["runtime"] = d.runtime.rows;
      break;
    case "javascript":
      out["references"] = d.script.references;
      out["ipc"] = d.script.ipc;
      out["exports"] = d.script.exports.map((name) => ({ name }));
      if (d.bundle.modules.length) out["bundleModules"] = d.bundle.modules;
      if (d.bundle.endpoints.length) out["endpoints"] = d.bundle.endpoints;
      if (d.bundle.routes.length) out["routes"] = d.bundle.routes;
      if (d.bundle.storage.length) out["storage"] = d.bundle.storage;
      if (d.bundle.urls.length) out["urls"] = d.bundle.urls;
      if (d.bundle.vendors.length) out["vendors"] = d.bundle.vendors.map((name) => ({ name }));
      break;
    case "source-map":
      out["sources"] = d.map.sources.map((path) => ({ path }));
      out["packages"] = d.map.packages;
      break;
    default:
      break;
  }
  return out;
}

/** The lists of a macOS or iOS bundle: frameworks, permissions, helpers, entitlements, code. */
function bundleLists(
  bundle: Extract<AnalysisData, { kind: "bundle" }>["bundle"],
  out: Record<string, unknown[]>,
): void {
  out["frameworks"] = bundle.frameworks.map((name) => ({ name }));
  out["permissions"] = bundle.permissions;
  out["helpers"] = bundle.helpers.map((name) => ({ name }));
  out["entitlements"] = Object.entries(bundle.entitlements ?? {}).map(([key, value]) => ({
    key,
    value,
  }));
  const bin = bundle.main?.binary;
  const macho =
    bin?.kind === "macho"
      ? bin.macho
      : bin?.kind === "macho-fat"
        ? bin.slices[0]?.macho
        : undefined;
  if (macho) {
    out["libraries"] = macho.dylibs.map((x) => ({
      name: x.path,
      kind: x.kind,
    }));
    out["symbols"] = macho.symbols;
  }
}

/** A value read only in part: unknown, or built at run time (`${…}`). */
const computedValue = (value: string | null): boolean => value === null || value.includes("${");

/** Limitations that say values of a family exist somewhere that are not in its list. */
export const UNRESOLVED_LIMITATIONS: Readonly<Record<string, UnresolvedFamily>> = {
  ipc_receiver_unresolved: "ipc",
  ipc_open_calls_capped: "ipc",
  context_bridge_truncated: "bridge",
  context_bridge_members_unreadable: "bridge",
  web_preferences_truncated: "window",
  candidates_truncated: "endpoint",
};

/** The files per family where a value could not be resolved (`SideCoverage.unresolved`). */
class Unresolved {
  readonly map = new Map<UnresolvedFamily, Set<string>>();

  add(family: UnresolvedFamily, file: string): void {
    const files = this.map.get(family);
    if (files) files.add(file);
    else this.map.set(family, new Set([file]));
  }

  /**
   * Families a limitation names. Its message lists the first places as `at file:line`; when it
   * lists only some (`… and N more`) or none, the rest may be anywhere: `*`.
   */
  fromLimitations(limitations: readonly Limitation[]): void {
    for (const l of limitations) {
      const family = UNRESOLVED_LIMITATIONS[l.code];
      if (!family) continue;
      if (l.code === "candidates_truncated") this.add("storage", "*");
      const files = [...l.message.matchAll(/ at (.+?):\d+(?=, | …|\.$|$)/g)].map((m) => m[1]!);
      for (const f of files) this.add(family, f);
      if (files.length === 0 || / … and \d+ more/.test(l.message)) this.add(family, "*");
    }
  }
}
