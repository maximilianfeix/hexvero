import { writeFile } from "node:fs/promises";
import {
  analyzeTarget,
  type AnyAnalysis,
  type AnalysisData,
} from "./analyzers/dispatch.js";
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
  bytes: number;
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

interface Entry {
  record: TargetRecord;
  loaded: LoadedTarget;
  analysis?: AnyAnalysis;
  strings?: { key: string; items: TaggedString[] };
  collections?: Record<string, unknown[]>;
}

/**
 * Holds opened targets and their analyses so every surface (CLI, MCP, HTTP)
 * can address them by a stable id derived from the content hash.
 */
export class Session {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly options: { maxTargets?: number; maxBytes?: number } = {},
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
    if (!e)
      throw new AnalysisError(
        "not_found",
        `No open target ${id}; call open first`,
        { id },
      );
    return e;
  }

  async analyze(id: string): Promise<AnyAnalysis> {
    const e = this.entry(id);
    if (!e.analysis) {
      e.analysis = await analyzeTarget(e.loaded);
      e.record.analyzed = true;
    }
    return e.analysis;
  }

  /** Names of the list-like collections available for this target after analysis. */
  private async collectionTable(
    id: string,
  ): Promise<Record<string, unknown[]>> {
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

  async collection(
    id: string,
    name: string,
    query: CollectionQuery = {},
  ): Promise<CollectionPage> {
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
    tags: string[];
  }> {
    const e = this.entry(id);
    if (e.loaded.info.format === "directory")
      throw new AnalysisError(
        "invalid_input",
        "Strings are extracted from files, not directories",
      );
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
    return pageOf("strings", items, query) as CollectionPage<
      (typeof items)[number]
    >;
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
      throw new AnalysisError(
        "invalid_input",
        `offset ${offset} outside 0..${total}`,
      );
    const take = Math.max(0, Math.min(length, 65536, total - offset));
    const slice = e.loaded.bytes.subarray(offset, offset + take);
    let ascii = "";
    for (const b of slice)
      ascii += b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : ".";
    return {
      offset,
      length: take,
      hex: Buffer.from(slice).toString("hex"),
      ascii,
      total,
    };
  }

  async export(
    id: string,
    destination: string,
  ): Promise<{ path: string; bytes: number }> {
    const analysis = await this.analyze(id);
    const text = JSON.stringify(
      {
        hexvero: 1,
        exportedAt: new Date().toISOString(),
        target: this.get(id),
        analysis,
      },
      replacer,
      2,
    );
    await writeFile(destination, text);
    return { path: destination, bytes: Buffer.byteLength(text) };
  }
}

const replacer = (_key: string, value: unknown): unknown =>
  typeof value === "bigint" ? value.toString() : value;

function hashText(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++)
    h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0).toString(16).padStart(8, "0");
}

function pageOf(
  name: string,
  items: readonly unknown[],
  query: CollectionQuery,
): CollectionPage {
  let filtered = items;
  if (query.text) {
    const needle = query.text.toLowerCase();
    filtered = items.filter((item) =>
      JSON.stringify(item, replacer).toLowerCase().includes(needle),
    );
  }
  const limit = Math.min(Math.max(query.limit ?? 100, 1), 2000);
  const p = page(filtered, query.offset ?? 0, limit);
  const maxBytes = query.maxBytes ?? 256 * 1024;
  let bytes = 2;
  let keep = 0;
  for (const item of p.items) {
    const size = Buffer.byteLength(JSON.stringify(item, replacer)) + 1;
    if (keep > 0 && bytes + size > maxBytes) break;
    bytes += size;
    keep++;
  }
  if (keep < p.items.length) {
    p.items = p.items.slice(0, keep);
    p.truncated = true;
  }
  return { ...p, collection: name, bytes };
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
          .filter(
            (s) =>
              s.section !== "UND" &&
              s.table === "dynsym" &&
              s.binding !== "LOCAL",
          )
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
            t.methods.map((m) => ({
              type: t.namespace ? `${t.namespace}.${t.name}` : t.name,
              name: m,
            })),
          );
          out["pinvokes"] = b.dotnet.pinvokes;
          out["userStrings"] = b.dotnet.userStrings.map((value) => ({ value }));
          out["assemblyRefs"] = b.dotnet.assemblyRefs;
        }
      } else if (b.kind === "macho") {
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
      out["libraries"] = Object.entries(d.apk.nativeLibraries).flatMap(
        ([abi, libs]) => libs.map((name) => ({ abi, name })),
      );
      out["files"] = d.apk.largestFiles;
      out["classes"] = d.apk.classes;
      out["packages"] = d.apk.packages;
      out["dexFiles"] = d.apk.dexFiles;
      break;
    case "bundle":
      out["frameworks"] = d.bundle.frameworks.map((name) => ({ name }));
      out["permissions"] = d.bundle.permissions;
      out["helpers"] = d.bundle.helpers.map((name) => ({ name }));
      out["entitlements"] = Object.entries(d.bundle.entitlements ?? {}).map(
        ([key, value]) => ({ key, value }),
      );
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
      out["modules"] = d.app.modules.map(
        ({ references: _r, ipc: _i, ...m }) => ({
          ...m,
          references: _r.length,
          ipc: _i.length,
        }),
      );
      out["edges"] = d.app.edges;
      out["externals"] = d.app.externals;
      out["ipcChannels"] = d.app.ipcChannels;
      out["ipc"] = d.app.modules.flatMap((m) =>
        m.ipc.map((u) => ({ module: m.id, ...u })),
      );
      out["sourceMaps"] = d.app.sourceMaps;
      break;
    case "javascript":
      out["references"] = d.script.references;
      out["ipc"] = d.script.ipc;
      out["exports"] = d.script.exports.map((name) => ({ name }));
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
