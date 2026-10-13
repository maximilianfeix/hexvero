import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";
import { openAsar, openAsarFile, type AsarArchive } from "../formats/asar.js";
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
  /** Symbolic links that pointed outside the root and were therefore not followed. */
  skippedLinks?: string[];
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

/** How far back a setting may be from `webPreferences` / `BrowserWindow` to count as a window option. */
const WINDOW_CONTEXT = 1500;
const MAX_PREFS_PER_FILE = 200;
const MAX_PREFS = 2000;

/** The expression after `preload:` up to the `,`, `}` or line end that closes it, at most 300 characters. */
function preloadExpression(source: string, start: number): string {
  let depth = 0;
  let i = start;
  const end = Math.min(source.length, start + 300);
  for (; i < end; i++) {
    const c = source[i]!;
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (c === "}") {
      if (depth === 0) break;
      depth--;
    } else if (depth <= 0 && (c === "," || c === "\n")) break;
    if (depth < 0) break;
  }
  return source.slice(start, i);
}

/** A short comma list that says how many items it left out instead of cutting silently. */
function list(items: string[], max: number): string {
  return items.length > max
    ? `${items.slice(0, max).join(", ")} … and ${items.length - max} more`
    : items.join(", ");
}

/** One BrowserWindow setting as written in the source: the evidence behind the Electron flags. */
export interface WebPreference {
  key: "preload" | "nodeIntegration" | "contextIsolation" | "sandbox";
  value: string | boolean;
  file: string;
  line: number;
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
  /** BrowserWindow settings as written in the sources, each with file and line. */
  webPreferences: WebPreference[];
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

export function directoryTree(root: string, options: { maxFiles?: number } = {}): FileTree {
  const maxFiles = options.maxFiles ?? 50_000;
  const files: FileTree["files"] = [];
  const skippedLinks: string[] = [];
  const realRoot = realpathSync(root);
  const inside = (real: string): boolean => real === realRoot || real.startsWith(realRoot + sep);
  const visitedDirs = new Set<string>([realRoot]);
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
        st = lstatSync(full);
        if (st.isSymbolicLink()) {
          // Follow a link only when its target stays inside the root (pnpm/workspace layouts);
          // anything pointing outside is recorded and never read.
          const real = realpathSync(full);
          if (!inside(real)) {
            if (skippedLinks.length < 200)
              skippedLinks.push(relative(root, full).split(sep).join("/"));
            continue;
          }
          st = statSync(real);
          if (st.isDirectory()) {
            if (visitedDirs.has(real)) continue;
            visitedDirs.add(real);
          }
        }
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
    ...(skippedLinks.length ? { skippedLinks } : {}),
    read: (path, maxBytes = 64 << 20) => {
      const full = join(root, ...path.split("/"));
      if (relative(root, full).startsWith(".."))
        throw new AnalysisError("invalid_input", `${path} escapes the root`);
      // Resolve every component: an intermediate directory link may leave the root too.
      const real = realpathSync(full);
      if (!inside(real))
        throw new AnalysisError(
          "invalid_input",
          `${path} resolves outside the root and is not read`,
        );
      const size = statSync(real).size;
      if (size > maxBytes) throw new AnalysisError("too_large", `${path} is ${size} bytes`);
      return new Uint8Array(readFileSync(full));
    },
  };
}

export function asarTree(bytes: Uint8Array, name: string): FileTree {
  return archiveTree(openAsar(bytes), name);
}

export function asarTreeFromFile(path: string): FileTree {
  return archiveTree(openAsarFile(path), path);
}

function archiveTree(archive: AsarArchive, name: string): FileTree {
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

function resolveSpecifier(from: string, specifier: string, known: Set<string>): string | null {
  if (!specifier.startsWith(".") && !specifier.startsWith("/")) return null;
  const base = posix.normalize(posix.join(posix.dirname(from), specifier)).replace(/^\.\//, "");
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
      electronVersion = raw.dependencies?.["electron"] ?? raw.devDependencies?.["electron"] ?? null;
    } catch (error) {
      limitations.push({
        code: "package_json_invalid",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (tree.skippedLinks?.length)
    limitations.push({
      code: "symlinks_skipped",
      message: `${tree.skippedLinks.length} symbolic link(s) point outside the analyzed directory and were not followed (e.g. ${tree.skippedLinks[0]}).`,
    });
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
  /** Every webPreferences-style setting read from source, with the place it was read. */
  const webPreferences: WebPreference[] = [];
  let prefsCapped = false;
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
    const usesElectron = scan.references.some((r) => r.specifier === "electron");
    if (usesElectron) electronSeen = true;
    if (
      scan.ipc.some((i) => i.api.startsWith("ipcMain.")) ||
      /BrowserWindow|app\.whenReady|app\.on\(/.test(source)
    )
      role = "main";
    else if (scan.ipc.some((i) => i.api.startsWith("contextBridge."))) role = "preload";
    else if (
      scan.ipc.some((i) => i.api.startsWith("ipcRenderer.")) ||
      /document\.|window\./.test(source.slice(0, 50_000))
    )
      role = "renderer";
    if (pkg?.main && posix.normalize(pkg.main) === file.path) role = "main";
    // Line starts once per file; positions are then found by binary search.
    const lineStarts = [0];
    for (let i = source.indexOf("\n"); i !== -1; i = source.indexOf("\n", i + 1))
      lineStarts.push(i + 1);
    const lineAt = (index: number): number => {
      let lo = 0;
      let hi = lineStarts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (lineStarts[mid]! <= index) lo = mid;
        else hi = mid - 1;
      }
      return lo + 1;
    };
    // A setting counts only where it can belong to a BrowserWindow: near `webPreferences` or
    // `BrowserWindow`. A payment SDK's `{ sandbox: false }` in a renderer file is not Electron's.
    const inWindowOptions = (index: number): boolean => {
      const before = source.slice(Math.max(0, index - WINDOW_CONTEXT), index);
      return /webPreferences|BrowserWindow|BrowserView|WebContentsView/.test(before);
    };
    let settings = 0;
    const record = (pref: WebPreference): boolean => {
      if (settings++ >= MAX_PREFS_PER_FILE || webPreferences.length >= MAX_PREFS) {
        prefsCapped = true;
        return false;
      }
      webPreferences.push(pref);
      return true;
    };
    // `preload: <expression>`: the script is the last path-like string literal of the expression
    // (`path.join(__dirname, "dist", "preload.js")`, `__dirname + "/preload.js"`). The expression
    // is read from a bounded window, so no input makes this scan slow.
    for (let at = source.indexOf("preload"); at !== -1; at = source.indexOf("preload", at + 7)) {
      const m = /^preload\s*:\s*/.exec(source.slice(at, at + 24));
      if (!m || /[\w$.]/.test(source[at - 1] ?? "") || !inWindowOptions(at)) continue;
      const expression = preloadExpression(source, at + m[0].length);
      const literals = [...expression.matchAll(/(['"`])((?:(?!\1)[^\\\n])*)\1/g)].map((x) => x[2]!);
      const script = literals.toReversed().find((v) => /\.(c|m)?[jt]s$/.test(v));
      if (!script) continue;
      const value = script.replace(/^\$\{[^}]*\}/, "").replace(/^[\\/]+/, "");
      preloadScripts.add(value);
      if (!record({ key: "preload", value, file: file.path, line: lineAt(at) })) break;
    }
    for (const m of source.matchAll(
      /\b(nodeIntegration|contextIsolation|sandbox)\s*:\s*(true|false|!0|!1)\b/g,
    )) {
      if (!inWindowOptions(m.index)) continue;
      const key = m[1] as "nodeIntegration" | "contextIsolation" | "sandbox";
      const v = m[2] === "true" || m[2] === "!0";
      if (!record({ key, value: v, file: file.path, line: lineAt(m.index) })) break;
      // the least safe value seen in any window decides the app-wide flag
      flags[key] =
        key === "nodeIntegration" ? (flags[key] ?? false) || v : (flags[key] ?? true) && v;
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
  if (prefsCapped)
    limitations.push({
      code: "web_preferences_truncated",
      message: `More BrowserWindow settings exist than the ${MAX_PREFS_PER_FILE} per file / ${MAX_PREFS} in total that are recorded.`,
    });
  if (skipped)
    limitations.push({
      code: "js_files_skipped",
      message: `${skipped} files skipped for exceeding size budgets.`,
    });

  // IPC channel matching
  const channels = new Map<string, { senders: Set<string>; receivers: Set<string> }>();
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
  const nativeAddons = tree.files.filter((f) => f.path.endsWith(".node")).map((f) => f.path);

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

  /** `file:line` of the first place a setting was read with the given value. */
  const where = (key: WebPreference["key"], value?: boolean): string | undefined => {
    const hit = webPreferences.find(
      (w) => w.key === key && (value === undefined || w.value === value),
    );
    return hit ? `${hit.file}:${hit.line}` : undefined;
  };
  if (electron) {
    if (electron.nodeIntegration === true)
      findings.push({
        kind: "electron.node-integration",
        title: "nodeIntegration: true in a BrowserWindow",
        detail: "Renderer code can require Node modules; XSS becomes RCE.",
        confidence: "inferred",
        location: where("nodeIntegration", true),
      });
    if (electron.contextIsolation === false)
      findings.push({
        kind: "electron.context-isolation",
        title: "contextIsolation: false",
        detail: "Preload and page share one JavaScript world.",
        confidence: "inferred",
        location: where("contextIsolation", false),
      });
    if (electron.sandbox === false)
      findings.push({
        kind: "electron.sandbox",
        title: "sandbox: false in a BrowserWindow",
        detail: "The renderer process runs without the Chromium sandbox.",
        confidence: "inferred",
        location: where("sandbox", false),
      });
    if (electron.remoteModule)
      findings.push({
        kind: "electron.remote",
        title: "Uses the remote module",
        confidence: "confirmed",
      });
    if (ipcChannels.length) {
      // evidence: the first handler registration in the main process
      const first = modules
        .flatMap((m) => m.ipc.map((u) => ({ m, u })))
        .find(({ u }) => u.channel && /\.(on|once|handle|handleOnce)$/.test(u.api));
      findings.push({
        kind: "electron.ipc",
        title: `${ipcChannels.length} IPC channels`,
        detail: `${list(
          ipcChannels.map((c) => c.channel),
          8,
        )} (collections ipcChannels, ipc)`,
        confidence: "confirmed",
        location: first ? `${first.m.id}:${first.u.line}` : undefined,
      });
    }
    if (preloadScripts.size)
      findings.push({
        kind: "electron.preload",
        title: `${preloadScripts.size} preload script${preloadScripts.size === 1 ? "" : "s"}`,
        detail: list([...preloadScripts], 5),
        confidence: "inferred",
        location: where("preload"),
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
  const unresolved = edges.filter((e) => !e.resolved && e.kind !== "dynamic-import").length;
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
    webPreferences,
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
