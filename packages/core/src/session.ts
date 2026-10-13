import { writeFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { analyzeTarget, type AnyAnalysis, type AnalysisData } from "./analyzers/dispatch.js";
import { analyzeInWorker } from "./analyzers/worker.js";
import { recoverBundle, recoverSourceMap, type RecoveryResult } from "./javascript/recover.js";
import { UnknownsLedger } from "./unknowns.js";
import { compact } from "./compact.js";
import { disassembleEvm, evmBytesFrom } from "./formats/evm.js";
import { classifyString, extractStrings } from "./binary/strings.js";
import { AnalysisError, page, type Page, type TargetInfo } from "./model.js";
import { loadTarget, type LoadedTarget } from "./target.js";

export interface TargetRecord {
  id: string;
  info: TargetInfo;
  openedAt: string;
  analyzed: boolean;
}

export interface CollectionQuery {
  offset?: number;
  limit?: number;
  /** Case-insensitive substring match against the item's JSON representation. */
  text?: string;
  /** Soft byte budget for the serialized page; items are dropped from the end until it fits. */
  maxBytes?: number;
}

export interface CollectionPage<T = unknown> extends Page<T> {
  collection: string;
  /** Serialized size of this page including its envelope; never above the byte budget. */
  bytes: number;
  /** Set when the first item alone exceeded the budget and was returned in compacted form. */
  itemTruncated?: boolean;
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
    const id =
      loaded.info.format === "directory"
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
      throw new AnalysisError("invalid_input", "Analysis cancelled by the caller", {
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
          })
        : analyzeTarget(e.loaded);
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
          new AnalysisError("invalid_input", "Analysis cancelled by the caller", {
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
  async recover(id: string, outputDir: string): Promise<RecoveryResult> {
    const analysis = await this.analyze(id);
    const e = this.entry(id);
    const text = (): string => new TextDecoder().decode(e.loaded.bytes);
    if (analysis.data.kind === "javascript") return recoverBundle(text(), outputDir);
    if (analysis.data.kind === "source-map") return recoverSourceMap(text(), outputDir);
    throw new AnalysisError(
      "invalid_input",
      `Recovery works on JavaScript bundles and source maps, not ${analysis.data.kind}`,
    );
  }

  /**
   * Writes the complete analysis as JSON. Refuses to replace an existing file unless `overwrite`
   * is set, so an agent steered by target content cannot clobber arbitrary files by accident.
   */
  async export(
    id: string,
    destination: string,
    options: { overwrite?: boolean | undefined } = {},
  ): Promise<{ path: string; bytes: number }> {
    const path = resolvePath(destination);
    const analysis = await this.analyze(id);
    const text = JSON.stringify(
      {
        hexvero: 1,
        exportedAt: new Date().toISOString(),
        target: this.get(id),
        analysis,
        unknowns: this.unknowns.list({ targetId: id, limit: 1000 }).items,
      },
      replacer,
      2,
    );
    try {
      await writeFile(path, text, { flag: options.overwrite ? "w" : "wx" });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST")
        throw new AnalysisError("invalid_input", `${path} exists; pass overwrite to replace it`, {
          path,
        });
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

function pageOf(name: string, items: readonly unknown[], query: CollectionQuery): CollectionPage {
  let filtered = items;
  if (query.text) {
    const needle = query.text.toLowerCase();
    filtered = items.filter((item) =>
      JSON.stringify(item, replacer).toLowerCase().includes(needle),
    );
  }
  const limit = Math.min(Math.max(query.limit ?? 100, 1), 2000);
  const p = page(filtered, query.offset ?? 0, limit);
  // Budgets below 512 bytes cannot hold the envelope plus one compacted item.
  const maxBytes = Math.max(query.maxBytes ?? 256 * 1024, 512);
  // The budget is an upper bound on the serialized page. The envelope is measured with its widest
  // values (every flag true, `bytes` as wide as the budget); an item that alone exceeds the budget
  // is returned in a compacted form with a marker instead of blowing the page.
  const envelope = Buffer.byteLength(
    JSON.stringify({
      collection: name,
      total: p.total,
      offset: p.offset,
      truncated: true,
      bytes: maxBytes,
      items: [],
      itemTruncated: true,
    }),
  );
  let bytes = envelope;
  let keep = 0;
  const kept: unknown[] = [];
  let itemTruncated = false;
  for (const item of p.items) {
    let value = item;
    let size = Buffer.byteLength(JSON.stringify(item, replacer)) + 1;
    if (keep === 0 && bytes + size > maxBytes) {
      value = compactItem(item, maxBytes - bytes - 1);
      size = Buffer.byteLength(JSON.stringify(value, replacer)) + 1;
      itemTruncated = true;
    }
    if (keep > 0 && bytes + size > maxBytes) break;
    bytes += size;
    keep++;
    kept.push(value);
  }
  if (keep < p.items.length) p.truncated = true;
  p.items = kept;
  const out: CollectionPage = { ...p, collection: name, bytes: 0 };
  if (itemTruncated) out.itemTruncated = true;
  // Report the real serialized size (the estimate above is an upper bound); a second pass settles
  // the digit count of the bytes field itself.
  out.bytes = Buffer.byteLength(JSON.stringify(out, replacer));
  out.bytes = Buffer.byteLength(JSON.stringify(out, replacer));
  return out;
}

/** Shrinks one oversized item to fit `budget` bytes: long strings are cut, long arrays sampled. */
function compactItem(item: unknown, budget: number): unknown {
  let maxString = 8192;
  let maxItems = 50;
  for (let i = 0; i < 8; i++) {
    const value = compact(item, { maxString, maxItems });
    if (Buffer.byteLength(JSON.stringify(value, replacer)) <= Math.max(budget, 96)) return value;
    maxString = Math.max(32, maxString >> 2);
    maxItems = Math.max(1, maxItems >> 1);
  }
  // Still too large (an object with very many keys): keep the key names only.
  const value = compact(item, { maxString: 32, maxItems: 1 });
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const keys = Object.keys(value);
    return { keys: keys.slice(0, 50), keyCount: keys.length, note: "item exceeds the page budget" };
  }
  return value;
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
      out["frameworks"] = d.bundle.frameworks.map((name) => ({ name }));
      out["permissions"] = d.bundle.permissions;
      out["helpers"] = d.bundle.helpers.map((name) => ({ name }));
      out["entitlements"] = Object.entries(d.bundle.entitlements ?? {}).map(([key, value]) => ({
        key,
        value,
      }));
      {
        const bin = d.bundle.main?.binary;
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
      out["modules"] = d.app.modules.map(({ references: _r, ipc: _i, ...m }) => ({
        ...m,
        references: _r.length,
        ipc: _i.length,
      }));
      out["edges"] = d.app.edges;
      out["externals"] = d.app.externals;
      out["ipcChannels"] = d.app.ipcChannels;
      out["ipc"] = d.app.modules.flatMap((m) => m.ipc.map((u) => ({ module: m.id, ...u })));
      out["sourceMaps"] = d.app.sourceMaps;
      break;
    case "javascript":
      out["references"] = d.script.references;
      out["ipc"] = d.script.ipc;
      out["exports"] = d.script.exports.map((name) => ({ name }));
      if (d.bundle.modules.length) out["bundleModules"] = d.bundle.modules;
      if (d.bundle.endpoints.length) out["endpoints"] = d.bundle.endpoints;
      if (d.bundle.routes.length) out["routes"] = d.bundle.routes;
      if (d.bundle.storage.length) out["storage"] = d.bundle.storage;
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
