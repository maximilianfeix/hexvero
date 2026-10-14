import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, normalize, resolve, sep } from "node:path";
import { AnalysisError } from "../model.js";
import { analyzeBundle, type JsBundleInfo } from "./bundle.js";
import { parseSourceMapJson } from "./sourcemap.js";

export interface RecoveredFile {
  path: string;
  bytes: number;
  origin: "bundle-module" | "source-map";
  moduleId?: string;
}

export interface RecoveryResult {
  outputDir: string;
  written: RecoveredFile[];
  skipped: Array<{ name: string; reason: string }>;
  manifest: string;
}

/** Turns a bundle path or map source name into a safe relative file path inside the output directory. */
export function safeRelativePath(name: string, fallback: string): string {
  let clean = name
    .replace(/^webpack:\/\/\/?/, "")
    .replace(/^[a-z]+:\/\//i, "")
    .replace(/\?.*$/, "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^(\.\.\/)+/, "")
    .replace(/\/(\.\.?)(?=\/|$)/g, "/")
    .replace(/^\/+/, "")
    .replace(/[^\w./@+-]/g, "_");
  clean = normalize(clean).split(sep).join("/");
  if (!clean || clean === "." || clean.startsWith("..")) clean = fallback;
  if (!/\.[a-z0-9]{1,8}$/i.test(clean)) clean += ".js";
  return clean;
}

function prepareOutput(outputDir: string): string {
  const absolute = resolve(outputDir);
  if (existsSync(absolute)) {
    if (!statSync(absolute).isDirectory())
      throw new AnalysisError("invalid_input", `${absolute} exists and is not a directory`);
    if (readdirSync(absolute).length > 0) {
      throw new AnalysisError(
        "invalid_input",
        `${absolute} exists and is not empty; choose a new directory`,
        { outputDir: absolute },
      );
    }
  }
  mkdirSync(absolute, { recursive: true });
  return absolute;
}

/** Allocates unique relative paths: case-insensitive, no file/directory prefix conflicts, bounded segment length. */
class PathAllocator {
  private readonly taken = new Set<string>();
  private readonly dirs = new Set<string>();
  constructor(reserved: string[]) {
    for (const r of reserved) this.taken.add(r.toLowerCase());
  }
  allocate(preferred: string, fallback: string): string | null {
    const segments = preferred
      .split("/")
      .map((seg) => (seg.length > 120 ? `${seg.slice(0, 100)}-${hash(seg)}` : seg));
    const base = segments.join("/");
    for (let attempt = 0; attempt < 50; attempt++) {
      const candidate = attempt === 0 ? base : base.replace(/(\.[a-z0-9]+)$/i, `.${attempt}$1`);
      const key = candidate.toLowerCase();
      const parents: string[] = [];
      const parts = key.split("/");
      for (let i = 1; i < parts.length; i++) parents.push(parts.slice(0, i).join("/"));
      const conflict =
        this.taken.has(key) || this.dirs.has(key) || parents.some((p) => this.taken.has(p));
      if (conflict) continue;
      this.taken.add(key);
      for (const p of parents) this.dirs.add(p);
      return candidate;
    }
    return preferred === fallback ? null : this.allocate(fallback, fallback);
  }
}

function hash(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0).toString(16);
}

function writeInside(root: string, relative: string, content: string | Uint8Array): number {
  const target = resolve(root, relative);
  if (!target.startsWith(root + sep))
    throw new AnalysisError("invalid_input", `refusing to write outside ${root}: ${relative}`);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, { flag: "wx" });
  return Buffer.byteLength(content);
}

/** Writes every delimited bundle module as its own file plus a manifest with ids, names, requires and exports. */
export function recoverBundle(
  source: string,
  outputDir: string,
  info: JsBundleInfo = analyzeBundle(source),
): RecoveryResult {
  const root = prepareOutput(outputDir);
  const manifestPath = "hexvero-bundle.json";
  const written: RecoveredFile[] = [];
  const skipped: RecoveryResult["skipped"] = [];
  const allocator = new PathAllocator([manifestPath]);
  const fileOf: Array<string | null> = [];
  info.modules.forEach((m, index) => {
    const fallback = `modules/module-${m.id.replace(/[^\w.-]/g, "_")}.${index}.js`;
    const relative = allocator.allocate(
      safeRelativePath(m.name ?? `modules/module-${m.id}`, fallback),
      fallback,
    );
    if (!relative) {
      fileOf.push(null);
      skipped.push({ name: m.name ?? m.id, reason: "no unique path" });
      return;
    }
    const header = `// hexvero: module ${m.id}${m.name ? ` (${m.name})` : ""} from bytes ${m.start}-${m.end}\n// requires: ${m.requires.join(", ") || "-"}\n// exports: ${m.exports.join(", ") || "-"}\n`;
    const body = source.slice(m.start, m.end);
    const factory = m.factory === "method" ? `function ${body}` : body;
    const text =
      m.factory === "hoisted"
        ? // a section of a scope-hoisted bundle: as written, with names shared with the others
          `${header}// scope-hoisted: names may be defined in another section of the bundle\n${body}`
        : `${header}module.exports = ${factory};\n`;
    try {
      const bytes = writeInside(root, relative, text);
      written.push({ path: relative, bytes, origin: "bundle-module", moduleId: m.id });
      fileOf.push(relative);
    } catch (error) {
      fileOf.push(null);
      skipped.push({
        name: m.name ?? m.id,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  });
  const manifest = {
    hexvero: 1,
    bundler: info.bundler,
    chunkIds: info.chunkIds,
    entryIds: info.entryIds,
    ...(info.chunks ? { chunks: info.chunks } : {}),
    modules: info.modules.map((m, index) => ({
      id: m.id,
      name: m.name,
      file: fileOf[index] ?? null,
      requires: m.requires,
      exports: m.exports,
      size: m.size,
    })),
    endpoints: info.endpoints,
    routes: info.routes,
    storage: info.storage,
  };
  writeInside(root, manifestPath, JSON.stringify(manifest, null, 2));
  return { outputDir: root, written, skipped, manifest: manifestPath };
}

/** Writes the original sources embedded in a source map (`sourcesContent`) back to disk. */
export function recoverSourceMap(mapText: string, outputDir: string): RecoveryResult {
  const map = parseSourceMapJson(mapText);
  const root = prepareOutput(outputDir);
  const manifestPath = "hexvero-sources.json";
  const written: RecoveredFile[] = [];
  const skipped: RecoveryResult["skipped"] = [];
  const sources = Array.isArray(map.sources) ? map.sources : [];
  const contents = Array.isArray(map.sourcesContent) ? map.sourcesContent : [];
  const allocator = new PathAllocator([manifestPath]);
  sources.forEach((name, index) => {
    const content = contents[index];
    const label = typeof name === "string" ? name : `source-${index}`;
    if (typeof content !== "string") {
      skipped.push({ name: label, reason: "no sourcesContent" });
      return;
    }
    const fallback = `source-${index}.js`;
    const relative = allocator.allocate(
      safeRelativePath(
        map.sourceRoot && typeof name === "string" ? `${map.sourceRoot}/${name}` : label,
        fallback,
      ),
      fallback,
    );
    if (!relative) {
      skipped.push({ name: label, reason: "no unique path" });
      return;
    }
    try {
      written.push({
        path: relative,
        bytes: writeInside(root, relative, content),
        origin: "source-map",
      });
    } catch (error) {
      skipped.push({ name: label, reason: error instanceof Error ? error.message : String(error) });
    }
  });
  const manifest = {
    hexvero: 1,
    file: map.file ?? null,
    sources: sources.length,
    written: written.length,
    skipped,
  };
  writeInside(root, manifestPath, JSON.stringify(manifest, null, 2));
  return { outputDir: root, written, skipped, manifest: manifestPath };
}
