import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";
import { openAsar, openAsarFile, type AsarArchive } from "../formats/asar.js";
import type { Finding, Limitation } from "../model.js";
import { AnalysisError } from "../model.js";
import {
  scanJavaScript,
  tokenize,
  type IpcUsage,
  type ModuleReference,
  type Token,
} from "./scan.js";
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

/** One member a preload script exposes to the page through contextBridge. */
export interface BridgeMember {
  /** The key the API is exposed under: `window.<api>`. */
  api: string;
  /** Member name, or null when the exposed value is not an object literal hexvero can read. */
  member: string | null;
  /** IPC channel the member forwards to, when it is a string literal in the member's body. */
  channel: string | null;
  world: "main" | "isolated";
  file: string;
  line: number;
}

/** What one source file exposes, and whether a cap or an unclosed literal cut the reading short. */
export interface BridgeScan {
  members: BridgeMember[];
  truncated: boolean;
}

const MAX_BRIDGE_PER_FILE = 500;
const MAX_BRIDGE = 2000;
/** Tokens walked inside exposed objects per file; keeps repeated or unclosed calls linear. */
const BRIDGE_WALK_BUDGET = 400_000;
const BRIDGE_MODIFIERS = new Set(["async", "get", "set", "static"]);
const CHANNEL_CALLS = new Set([
  "invoke",
  "send",
  "sendSync",
  "sendToHost",
  "postMessage",
  "on",
  "once",
  "addListener",
]);
const textOf = (t: Token | undefined): string | null =>
  t && (t.type === "string" || (t.type === "template" && !t.value.includes("${"))) ? t.value : null;

/**
 * Reads `contextBridge.exposeInMainWorld("api", { a: …, b() {…} })` calls from one source file,
 * on the token stream, so comments, strings, regex and template literals cannot be mistaken for
 * code. An object passed by name is followed to its `const x = {…}` in the same file. What cannot
 * be read as a member (spread, computed key, a value built elsewhere) is a row with member null.
 */
export function bridgeMembers(
  source: string | { tokens: Token[]; truncated: boolean },
  file: string,
): BridgeScan {
  const { tokens, truncated: cut } = typeof source === "string" ? tokenize(source) : source;
  const members: BridgeMember[] = [];
  let truncated = cut;
  let budget = BRIDGE_WALK_BUDGET;
  const is = (i: number, value: string): boolean =>
    tokens[i]?.type === "punct" && tokens[i]!.value === value;
  let objects: Map<string, number> | null = null;
  const objectOf = (name: string): number => {
    if (!objects) {
      objects = new Map();
      for (let k = 0; k + 3 < tokens.length; k++) {
        const t = tokens[k]!;
        if (t.type !== "ident" || (t.value !== "const" && t.value !== "let" && t.value !== "var"))
          continue;
        const id = tokens[k + 1]!;
        if (id.type === "ident" && is(k + 2, "=") && is(k + 3, "{") && !objects.has(id.value))
          objects.set(id.value, k + 3);
      }
    }
    return objects.get(name) ?? -1;
  };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.type !== "ident") continue;
    if (t.value !== "exposeInMainWorld" && t.value !== "exposeInIsolatedWorld") continue;
    if (!(is(i - 1, ".") || is(i - 1, "?.")) || !is(i + 1, "(")) continue;
    const world = t.value === "exposeInMainWorld" ? "main" : "isolated";
    const push = (member: string | null, channel: string | null, line: number): void => {
      if (members.length >= MAX_BRIDGE_PER_FILE) truncated = true;
      else members.push({ api, member, channel, world, file, line });
    };
    let at = i + 2;
    if (world === "isolated") {
      // isolated worlds take a world id first
      let depth = 0;
      for (; at < tokens.length && budget > 0; at++, budget--) {
        const p = tokens[at]!;
        if (p.type !== "punct") continue;
        if (p.value === "(" || p.value === "[" || p.value === "{") depth++;
        else if (p.value === ")" || p.value === "]" || p.value === "}") {
          if (depth === 0) break;
          depth--;
        } else if (p.value === "," && depth === 0) break;
      }
      if (!is(at, ",")) continue;
      at++;
    }
    const keyToken = tokens[at];
    const simple = is(at + 1, ",");
    const api =
      (simple ? textOf(keyToken) : null) ??
      (simple && keyToken?.type === "ident" ? `[${keyToken.value}]` : "[computed]");
    let open = -1;
    if (simple) {
      const value = tokens[at + 2];
      if (is(at + 2, "{")) open = at + 2;
      else if (value?.type === "ident" && is(at + 3, ")")) open = objectOf(value.value);
    }
    if (open < 0) {
      push(null, null, t.line);
      continue;
    }
    let start = open + 1;
    const flush = (end: number): void => {
      let s = start;
      start = end + 1;
      if (s >= end) return;
      const first = tokens[s]!;
      if (is(s, "...")) return push(null, null, first.line);
      while (
        s + 1 < end &&
        tokens[s]!.type === "ident" &&
        BRIDGE_MODIFIERS.has(tokens[s]!.value) &&
        !is(s + 1, ":") &&
        !is(s + 1, "(")
      )
        s++;
      if (is(s, "*") && s + 1 < end) s++;
      const nameToken = tokens[s]!;
      const name =
        nameToken.type === "ident" || nameToken.type === "number"
          ? nameToken.value
          : textOf(nameToken);
      if (name === null) return push(null, null, first.line);
      const channels = new Set<string>();
      for (let j = s + 1; j + 4 < end; j++) {
        const callee = tokens[j + 2]!;
        if (
          tokens[j]!.type === "ident" &&
          tokens[j]!.value === "ipcRenderer" &&
          is(j + 1, ".") &&
          callee.type === "ident" &&
          CHANNEL_CALLS.has(callee.value) &&
          is(j + 3, "(")
        ) {
          const channel = textOf(tokens[j + 4]);
          if (channel !== null) channels.add(channel);
        }
      }
      // Two different channels in one member: which one it forwards to is not decidable here.
      push(name, channels.size === 1 ? [...channels][0]! : null, first.line);
    };
    let depth = 0;
    let closed = false;
    for (let k = open; k < tokens.length && budget > 0; k++, budget--) {
      const p = tokens[k]!;
      if (p.type !== "punct") continue;
      if (p.value === "{" || p.value === "(" || p.value === "[") depth++;
      else if (p.value === "}" || p.value === ")" || p.value === "]") {
        depth--;
        if (depth === 0) {
          flush(k);
          closed = true;
          break;
        }
      } else if (p.value === "," && depth === 1) flush(k);
    }
    if (!closed) truncated = true;
  }
  return { members, truncated };
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
  /** What preload scripts expose to pages through contextBridge, member by member. */
  contextBridge: BridgeMember[];
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
  const contextBridge: BridgeMember[] = [];
  let prefsCapped = false;
  let bridgeCapped = false;
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
    const scan = scanJavaScript(source, {
      onTokens: (tokens, truncated) => {
        if (!source.includes("exposeIn")) return;
        const bridge = bridgeMembers({ tokens, truncated }, file.path);
        const room = MAX_BRIDGE - contextBridge.length;
        contextBridge.push(...bridge.members.slice(0, room));
        if (bridge.truncated || bridge.members.length > room) bridgeCapped = true;
      },
    });
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
  if (bridgeCapped)
    limitations.push({
      code: "context_bridge_truncated",
      message: `The contextBridge inventory is incomplete: a file exposes more than ${MAX_BRIDGE_PER_FILE} members, the app more than ${MAX_BRIDGE}, or an exposed object could not be read to its end.`,
    });
  const bridgeUnread = contextBridge.filter((b) => b.member === null).length;
  if (bridgeUnread)
    limitations.push({
      code: "context_bridge_members_unreadable",
      message: `${bridgeUnread} contextBridge ${bridgeUnread === 1 ? "entry is" : "entries are"} not a plain member of an object literal in the same file (a value built elsewhere, a spread or a computed key), so the exposed members are not all listed.`,
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
    if (contextBridge.length) {
      const apis = [...new Set(contextBridge.map((b) => b.api))].map((a) =>
        a.startsWith("[") ? `window${a}` : `window.${a}`,
      );
      // A getter and setter of one name are one member; rows keep both for their lines.
      const seen = new Set<string>();
      const read = contextBridge.filter((b) => {
        if (b.member === null || seen.has(`${b.api}\u0000${b.member}`)) return false;
        seen.add(`${b.api}\u0000${b.member}`);
        return true;
      });
      const unread = contextBridge.filter((b) => b.member === null).length;
      findings.push({
        kind: "electron.context-bridge",
        title: read.length
          ? `${bridgeCapped ? "at least " : ""}${read.length} member${read.length === 1 ? "" : "s"} exposed to pages as ${list(apis, 4)}`
          : `${list(apis, 4)} exposed to pages; members could not be read`,
        detail: read.length
          ? `${list(
              read.map((b) => b.member!),
              8,
            )}${unread ? `; ${unread} more not readable` : ""} (collection contextBridge)`
          : "The exposed value is not an object literal in the same file (collection contextBridge).",
        confidence: read.length && !unread && !bridgeCapped ? "confirmed" : "inferred",
        location: `${contextBridge[0]!.file}:${contextBridge[0]!.line}`,
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
    contextBridge,
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
