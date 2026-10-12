import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";
import { openAsar } from "../formats/asar.js";
import type { Finding, Limitation } from "../model.js";
import { AnalysisError } from "../model.js";
import { scanJavaScript, type IpcUsage, type ModuleReference } from "./scan.js";
import { summarizeSourceMap } from "./sourcemap.js";

/** Minimal read-only file tree so directories and ASAR archives share one analyzer. */
export interface FileTree {
  kind: "directory" | "asar";
  root: string;
  files: Array<{ path: string; size: number }>;
  read(path: string, maxBytes?: number): Uint8Array;
}

export interface JsModule {
  id: string;
  size: number;
  lines: number;
  moduleSystem: string;
  minified: boolean;
  exports: string[];
  references: ModuleReference[];
  ipc: IpcUsage[];
  sourceMappingUrl: string | null;
  role: "main" | "preload" | "renderer" | "unknown";
}

export interface JsEdge {
  from: string;
  to: string;
  kind: ModuleReference["kind"];
  resolved: boolean;
  line: number;
}

export interface JsAppInfo {
  package: {
    name: string;
    version: string;
    main: string | null;
    description: string;
    dependencies: string[];
    devDependencies: string[];
    scripts: string[];
  } | null;
  electron: {
    version: string | null;
    preloadScripts: string[];
    nodeIntegration: boolean | null;
    contextIsolation: boolean | null;
    sandbox: boolean | null;
    remoteModule: boolean;
  } | null;
  modules: JsModule[];
  edges: JsEdge[];
  externals: Array<{ specifier: string; count: number; builtin: boolean }>;
  ipcChannels: Array<{
    channel: string;
    senders: string[];
    receivers: string[];
  }>;
  sourceMaps: Array<{ file: string; sources: number; packages: string[] }>;
  nativeAddons: string[];
  totals: { files: number; javascript: number; bytes: number; skipped: number };
  findings: Finding[];
  limitations: Limitation[];
}

const JS_EXT = /\.(m?js|cjs|jsx)$/i;
const SKIP_DIRS = new Set([".git", ".hg", ".svn", "__pycache__"]);
const NODE_BUILTINS = new Set([
  "assert",
  "buffer",
  "child_process",
  "cluster",
  "crypto",
  "dgram",
  "dns",
  "events",
  "fs",
  "http",
  "http2",
  "https",
  "net",
  "os",
  "path",
  "perf_hooks",
  "process",
  "querystring",
  "readline",
  "stream",
  "string_decoder",
  "timers",
  "tls",
  "tty",
  "url",
  "util",
  "v8",
  "vm",
  "worker_threads",
  "zlib",
  "electron",
]);

export function directoryTree(
  root: string,
  options: { maxFiles?: number } = {},
): FileTree {
  const maxFiles = options.maxFiles ?? 50_000;
  const files: FileTree["files"] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 32 || files.length >= maxFiles) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (SKIP_DIRS.has(name)) continue;
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full, depth + 1);
      else if (st.isFile()) {
        files.push({
          path: relative(root, full).split(sep).join("/"),
          size: st.size,
        });
        if (files.length >= maxFiles) return;
      }
    }
  };
  walk(root, 0);
  return {
    kind: "directory",
    root,
    files,
    read: (path, maxBytes = 64 << 20) => {
      const full = join(root, ...path.split("/"));
      if (relative(root, full).startsWith(".."))
        throw new AnalysisError("invalid_input", `${path} escapes the root`);
      const size = statSync(full).size;
      if (size > maxBytes)
        throw new AnalysisError("too_large", `${path} is ${size} bytes`);
      return new Uint8Array(readFileSync(full));
    },
  };
}

export function asarTree(bytes: Uint8Array, name: string): FileTree {
  const archive = openAsar(bytes);
  return {
    kind: "asar",
    root: name,
    files: archive.files.map((f) => ({ path: f.path, size: f.size })),
    read: (path, maxBytes) => {
      const file = archive.find(path);
      if (!file) throw new AnalysisError("not_found", `${path} not in archive`);
      return archive.read(file, maxBytes);
    },
  };
}

interface PackageJson {
  name?: string;
  version?: string;
  main?: string;
  description?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

function resolveSpecifier(
  from: string,
  specifier: string,
  known: Set<string>,
): string | null {
  if (!specifier.startsWith(".") && !specifier.startsWith("/")) return null;
  const base = posix
    .normalize(posix.join(posix.dirname(from), specifier))
    .replace(/^\.\//, "");
  const candidates = [
    base,
    `${base}.js`,
    `${base}.mjs`,
    `${base}.cjs`,
    `${base}.jsx`,
    `${base}/index.js`,
    `${base}/index.mjs`,
    `${base}/index.cjs`,
  ];
  return candidates.find((c) => known.has(c)) ?? null;
}

export function analyzeJavaScriptTree(
  tree: FileTree,
  options: {
    maxJsFiles?: number;
    maxFileBytes?: number;
    maxTotalBytes?: number;
  } = {},
): JsAppInfo {
  const maxJsFiles = options.maxJsFiles ?? 5000;
  const maxFileBytes = options.maxFileBytes ?? 16 << 20;
  const maxTotalBytes = options.maxTotalBytes ?? 256 << 20;
  const findings: Finding[] = [];
  const limitations: Limitation[] = [];

  let pkg: JsAppInfo["package"] = null;
  let electronVersion: string | null = null;
  const pkgEntry = tree.files.find((f) => f.path === "package.json");
  if (pkgEntry) {
    try {
      const raw = JSON.parse(decode(tree.read("package.json"))) as PackageJson;
      pkg = {
        name: raw.name ?? "",
        version: raw.version ?? "",
        main: raw.main ?? null,
        description: raw.description ?? "",
        dependencies: Object.keys(raw.dependencies ?? {}),
        devDependencies: Object.keys(raw.devDependencies ?? {}),
        scripts: Object.keys(raw.scripts ?? {}),
      };
      electronVersion =
        raw.dependencies?.["electron"] ??
        raw.devDependencies?.["electron"] ??
        null;
    } catch (error) {
      limitations.push({
        code: "package_json_invalid",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const jsFiles = tree.files.filter(
    (f) => JS_EXT.test(f.path) && !f.path.includes("node_modules/"),
  );
  const known = new Set(jsFiles.map((f) => f.path));
  const modules: JsModule[] = [];
  const edges: JsEdge[] = [];
  const externals = new Map<string, number>();
  let bytes = 0;
  let skipped = 0;
  let electronSeen = false;
  const preloadScripts = new Set<string>();
  const flags = {
    nodeIntegration: null as boolean | null,
    contextIsolation: null as boolean | null,
    sandbox: null as boolean | null,
    remoteModule: false,
  };

  for (const file of jsFiles.slice(0, maxJsFiles)) {
    if (file.size > maxFileBytes || bytes + file.size > maxTotalBytes) {
      skipped++;
      continue;
    }
    let source: string;
    try {
      source = decode(tree.read(file.path, maxFileBytes));
    } catch {
      skipped++;
      continue;
    }
    bytes += file.size;
    const scan = scanJavaScript(source);
    if (scan.truncated)
      limitations.push({
        code: "scan_truncated",
        message: `${file.path}: token budget exhausted; references after the cut are missing.`,
      });
    let role: JsModule["role"] = "unknown";
    const usesElectron = scan.references.some(
      (r) => r.specifier === "electron",
    );
    if (usesElectron) electronSeen = true;
    if (
      scan.ipc.some((i) => i.api.startsWith("ipcMain.")) ||
      /BrowserWindow|app\.whenReady|app\.on\(/.test(source)
    )
      role = "main";
    else if (scan.ipc.some((i) => i.api.startsWith("contextBridge.")))
      role = "preload";
    else if (
      scan.ipc.some((i) => i.api.startsWith("ipcRenderer.")) ||
      /document\.|window\./.test(source.slice(0, 50_000))
    )
      role = "renderer";
    if (pkg?.main && posix.normalize(pkg.main) === file.path) role = "main";
    for (const m of source.matchAll(
      /preload\s*:\s*[^,}\n]*?['"`]([^'"`]+)['"`]/g,
    ))
      preloadScripts.add(m[1]!);
    for (const m of source.matchAll(
      /preload\s*:\s*path\.join\([^)]*['"`]([^'"`]+\.c?js)['"`]\)/g,
    ))
      preloadScripts.add(m[1]!);
    const bool = (key: string): boolean | null => {
      const m = new RegExp(`${key}\\s*:\\s*(true|false)`).exec(source);
      return m ? m[1] === "true" : null;
    };
    for (const key of [
      "nodeIntegration",
      "contextIsolation",
      "sandbox",
    ] as const) {
      const v = bool(key);
      if (v !== null)
        flags[key] =
          key === "nodeIntegration"
            ? (flags[key] ?? false) || v
            : (flags[key] ?? true) && v;
    }
    if (
      /@electron\/remote|require\(['"]electron['"]\)\.remote|enableRemoteModule\s*:\s*true/.test(
        source,
      )
    )
      flags.remoteModule = true;

    modules.push({
      id: file.path,
      size: file.size,
      lines: scan.lines,
      moduleSystem: scan.moduleSystem,
      minified: scan.minified,
      exports: scan.exports,
      references: scan.references,
      ipc: scan.ipc,
      sourceMappingUrl: scan.sourceMappingUrl,
      role,
    });
    for (const ref of scan.references) {
      if (ref.dynamic) {
        edges.push({
          from: file.path,
          to: ref.specifier,
          kind: ref.kind,
          resolved: false,
          line: ref.line,
        });
        continue;
      }
      const target = resolveSpecifier(file.path, ref.specifier, known);
      if (target)
        edges.push({
          from: file.path,
          to: target,
          kind: ref.kind,
          resolved: true,
          line: ref.line,
        });
      else if (ref.specifier.startsWith("."))
        edges.push({
          from: file.path,
          to: ref.specifier,
          kind: ref.kind,
          resolved: false,
          line: ref.line,
        });
      else {
        const name = ref.specifier.startsWith("@")
          ? ref.specifier.split("/").slice(0, 2).join("/")
          : ref.specifier.split("/")[0]!.replace(/^node:/, "");
        externals.set(name, (externals.get(name) ?? 0) + 1);
      }
    }
  }
  if (jsFiles.length > maxJsFiles)
    limitations.push({
      code: "js_files_truncated",
      message: `Scanned ${maxJsFiles} of ${jsFiles.length} JavaScript files.`,
    });
  if (skipped)
    limitations.push({
      code: "js_files_skipped",
      message: `${skipped} files skipped for exceeding size budgets.`,
    });

  // IPC channel matching
  const channels = new Map<
    string,
    { senders: Set<string>; receivers: Set<string> }
  >();
  for (const m of modules) {
    for (const u of m.ipc) {
      if (!u.channel || u.api.startsWith("contextBridge.")) continue;
      const entry = channels.get(u.channel) ?? {
        senders: new Set(),
        receivers: new Set(),
      };
      const receiving = /\.(on|once|handle|handleOnce)$/.test(u.api);
      (receiving ? entry.receivers : entry.senders).add(m.id);
      channels.set(u.channel, entry);
    }
  }
  const ipcChannels = [...channels]
    .map(([channel, c]) => ({
      channel,
      senders: [...c.senders],
      receivers: [...c.receivers],
    }))
    .toSorted((a, b) => a.channel.localeCompare(b.channel));

  // Source maps and native addons
  const sourceMaps: JsAppInfo["sourceMaps"] = [];
  for (const f of tree.files
    .filter((x) => x.path.endsWith(".map") && x.size < 32 << 20)
    .slice(0, 200)) {
    try {
      const s = summarizeSourceMap(decode(tree.read(f.path)));
      sourceMaps.push({
        file: f.path,
        sources: s.sources.length,
        packages: s.packages.slice(0, 10).map((p) => p.name),
      });
    } catch {
      /* not a source map */
    }
  }
  const nativeAddons = tree.files
    .filter((f) => f.path.endsWith(".node"))
    .map((f) => f.path);

  const electron =
    electronSeen || electronVersion || tree.kind === "asar"
      ? {
          version: electronVersion,
          preloadScripts: [...preloadScripts],
          nodeIntegration: flags.nodeIntegration,
          contextIsolation: flags.contextIsolation,
          sandbox: flags.sandbox,
          remoteModule: flags.remoteModule,
        }
      : null;

  if (electron) {
    if (electron.nodeIntegration === true)
      findings.push({
        kind: "electron.node-integration",
        title: "nodeIntegration: true in a BrowserWindow",
        detail: "Renderer code can require Node modules; XSS becomes RCE.",
        confidence: "inferred",
      });
    if (electron.contextIsolation === false)
      findings.push({
        kind: "electron.context-isolation",
        title: "contextIsolation: false",
        confidence: "inferred",
      });
    if (electron.remoteModule)
      findings.push({
        kind: "electron.remote",
        title: "Uses the remote module",
        confidence: "confirmed",
      });
    if (ipcChannels.length)
      findings.push({
        kind: "electron.ipc",
        title: `${ipcChannels.length} IPC channels`,
        detail: ipcChannels
          .slice(0, 8)
          .map((c) => c.channel)
          .join(", "),
        confidence: "confirmed",
      });
    if (preloadScripts.size)
      findings.push({
        kind: "electron.preload",
        title: `${preloadScripts.size} preload scripts`,
        detail: [...preloadScripts].join(", "),
        confidence: "inferred",
      });
  }
  if (sourceMaps.length)
    findings.push({
      kind: "js.source-maps",
      title: `${sourceMaps.length} source maps shipped (original sources recoverable)`,
      confidence: "confirmed",
    });
  if (nativeAddons.length)
    findings.push({
      kind: "js.native-addons",
      title: `${nativeAddons.length} native addons (.node)`,
      detail: nativeAddons.slice(0, 5).join(", "),
      confidence: "confirmed",
    });
  const minified = modules.filter((m) => m.minified).length;
  if (minified)
    findings.push({
      kind: "js.minified",
      title: `${minified} minified bundles`,
      confidence: "inferred",
    });
  const unresolved = edges.filter(
    (e) => !e.resolved && e.kind !== "dynamic-import",
  ).length;
  if (unresolved)
    limitations.push({
      code: "unresolved_references",
      message: `${unresolved} relative or dynamic references could not be resolved to files.`,
    });

  return {
    package: pkg,
    electron,
    modules,
    edges,
    externals: [...externals]
      .map(([specifier, count]) => ({
        specifier,
        count,
        builtin: NODE_BUILTINS.has(specifier),
      }))
      .toSorted((a, b) => b.count - a.count),
    ipcChannels,
    sourceMaps,
    nativeAddons,
    totals: {
      files: tree.files.length,
      javascript: modules.length,
      bytes,
      skipped,
    },
    findings,
    limitations,
  };
}
