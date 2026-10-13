import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";
import { openAsar, openAsarFile, type AsarArchive } from "../formats/asar.js";
import type { Finding, Limitation } from "../model.js";
import { AnalysisError } from "../model.js";
import { Constants, resolveAliases } from "./aliases.js";
import { findCandidates, resolvePending, type Candidate } from "./candidates.js";
import {
  ALIAS_TARGETS,
  scanJavaScript,
  tokenize,
  type ScanContext,
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
  /** Set when the listing itself is incomplete, with the reason: later files are unknown. */
  truncated?: string;
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
  /** String constants the file exports, kept so other files' channel names can be resolved. */
  constants?: Record<string, string>;
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
  /**
   * Which window of the file the setting belongs to, counted in source order from 1; null when
   * the setting sits in a `webPreferences` object that is not part of a window constructor call
   * (returned by a helper, or used to override a child window's options).
   */
  window: number | null;
}

/** A stretch of source that holds a window's options, and which window it is. */
interface WindowRange {
  start: number;
  end: number;
  window: number | null;
  /**
   * The object is a base the window's own options are laid over (a spread object, or what a
   * helper function returns): a key written directly for the window replaces the same key here.
   */
  inherited: boolean;
}

const WINDOW_CLASSES = new Set(["BrowserWindow", "BrowserView", "WebContentsView"]);

/**
 * Where window options are written in a file: the argument of every `new BrowserWindow(…)`, a
 * `webPreferences` object passed to it by name or spread into it, and any other object under a
 * `webPreferences` key. A setting outside these is not a window setting, however near it is.
 */
function windowRanges(tokens: Token[], aliases: Map<number, string>): WindowRange[] {
  const ranges: WindowRange[] = [];
  const is = (i: number, value: string): boolean =>
    tokens[i]?.type === "punct" && tokens[i]!.value === value;
  const close = (open: number): number => {
    let d = 0;
    for (let k = open; k < tokens.length && k < open + 20_000; k++) {
      const p = tokens[k]!;
      if (p.type !== "punct") continue;
      if (p.value === "{" || p.value === "(" || p.value === "[") d++;
      else if (p.value === "}" || p.value === ")" || p.value === "]") {
        d--;
        if (d === 0) return k;
      }
    }
    return -1;
  };
  let declared: Map<string, number> | null = null;
  const objectOf = (name: string): number => {
    if (!declared) {
      declared = new Map();
      for (let k = 0; k + 2 < tokens.length; k++)
        if (
          tokens[k]!.type === "ident" &&
          is(k + 1, "=") &&
          is(k + 2, "{") &&
          !declared.has(tokens[k]!.value)
        )
          declared.set(tokens[k]!.value, k + 2);
    }
    return declared.get(name) ?? -1;
  };
  /** The object literal a function of this file returns: `function f() { return {…} }`, `f = () => ({…})`. */
  /**
   * The object literal a function of this file returns: `function f() { return {…} }`,
   * `f = () => ({…})`. Function declarations are indexed once, however many are asked for.
   */
  let returned: Map<string, number> | null = null;
  const returnedBy = (name: string): number => {
    if (!returned) {
      returned = new Map();
      for (let k = 0; k + 3 < tokens.length; k++) {
        const t = tokens[k]!;
        if (t.type !== "ident" || returned.has(t.value)) continue;
        const isDeclaration =
          (tokens[k - 1]?.type === "ident" &&
            tokens[k - 1]!.value === "function" &&
            is(k + 1, "(")) ||
          (is(k + 1, "=") &&
            !is(k - 1, ".") &&
            (is(k + 2, "(") || (tokens[k + 2]?.type === "ident" && is(k + 3, "=>"))));
        if (!isDeclaration) continue;
        for (let j = k + 1; j + 2 < tokens.length && j < k + 300; j++) {
          if (tokens[j]!.type === "ident" && tokens[j]!.value === "return" && is(j + 1, "{")) {
            returned.set(t.value, j + 1);
            break;
          }
          if (is(j, "=>") && is(j + 1, "(") && is(j + 2, "{")) {
            returned.set(t.value, j + 2);
            break;
          }
        }
      }
    }
    return returned.get(name) ?? -1;
  };
  let work = 400_000;
  const add = (open: number, window: number | null, inherited = false, depth = 0): void => {
    if (ranges.length >= 2000 || work <= 0) return;
    const end = close(open);
    if (end === -1) {
      work -= 20_000;
      return;
    }
    work -= end - open;
    ranges.push({ start: tokens[open]!.start, end: tokens[end]!.end, window, inherited });
    if (depth >= 3) return;
    // Objects that are named, spread or returned by a helper inside belong to the same window.
    for (let k = open + 1; k < end; k++) {
      const t = tokens[k]!;
      const next = tokens[k + 1];
      if (is(k, "...") && next?.type === "ident") {
        const at = is(k + 2, "(") ? returnedBy(next.value) : objectOf(next.value);
        if (at !== -1) add(at, window, true, depth + 1);
      } else if (
        t.type === "ident" &&
        t.value === "webPreferences" &&
        is(k + 1, ":") &&
        tokens[k + 2]?.type === "ident"
      ) {
        const name = tokens[k + 2]!.value;
        if (is(k + 3, ",") || is(k + 3, "}")) {
          const at = objectOf(name);
          if (at !== -1) add(at, window, inherited, depth + 1);
        } else if (is(k + 3, "(")) {
          // `webPreferences: helper({ … })`: what the helper returns is the base, its argument
          // (inside this range already) is laid over it.
          const at = returnedBy(name);
          if (at !== -1) add(at, window, true, depth + 1);
        }
      }
    }
  };
  let count = 0;
  for (let k = 0; k + 2 < tokens.length; k++) {
    const t = tokens[k]!;
    if (t.type !== "ident") continue;
    if (t.value === "new") {
      // `new BrowserWindow(`, `new electron.BrowserWindow(`, or a renamed binding of it
      let c = k + 1;
      if (tokens[c]?.type === "ident" && is(c + 1, ".") && tokens[c + 2]?.type === "ident") c += 2;
      const ctor = tokens[c];
      if (ctor?.type !== "ident" || !is(c + 1, "(")) continue;
      if (!WINDOW_CLASSES.has(aliases.get(c) ?? ctor.value)) continue;
      const window = ++count;
      // `new BrowserWindow(options)` with the options object declared elsewhere
      const first = tokens[c + 2];
      if (first?.type === "ident" && is(c + 3, ")")) {
        const at = objectOf(first.value);
        if (at !== -1) add(at, window);
      }
      add(c + 1, window);
    } else if (t.value === "webPreferences" && is(k + 1, ":") && is(k + 2, "{")) {
      const start = tokens[k + 2]!.start;
      // Already inside a window's range: nothing to add.
      if (!ranges.some((r) => start >= r.start && start < r.end)) add(k + 2, null);
    }
  }
  return ranges;
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
  /** A channel named by a constant of another module, until that module has been read. */
  channelRef?: { specifier: string; property: string };
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
  source: string | { tokens: Token[]; truncated: boolean; context?: ScanContext },
  file: string,
): BridgeScan {
  const { tokens, truncated: cut } = typeof source === "string" ? tokenize(source) : source;
  const context: ScanContext =
    typeof source !== "string" && source.context
      ? source.context
      : {
          aliases: resolveAliases(tokens, ALIAS_TARGETS),
          constants: new Constants(tokens),
          wrappers: new Map(),
        };
  const members: BridgeMember[] = [];
  let truncated = cut;
  let budget = BRIDGE_WALK_BUDGET;
  const is = (i: number, value: string): boolean =>
    tokens[i]?.type === "punct" && tokens[i]!.value === value;
  /** Named objects whose later `name.member = …` assignments were already collected. */
  const stepwise = new Set<string>();
  let objects: Map<string, number> | null = null;
  const objectOf = (name: string): number => {
    if (!objects) {
      objects = new Map();
      // `const api = {`, and in a declaration list (as minifiers write it) `, api = {`
      for (let k = 0; k + 3 < tokens.length; k++) {
        const t = tokens[k]!;
        const declares =
          (t.type === "ident" && (t.value === "const" || t.value === "let" || t.value === "var")) ||
          (t.type === "punct" && t.value === ",");
        if (!declares) continue;
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
    const push = (
      member: string | null,
      channel: string | null,
      line: number,
      channelRef?: BridgeMember["channelRef"],
    ): void => {
      if (members.length >= MAX_BRIDGE_PER_FILE) truncated = true;
      else
        members.push({
          api,
          member,
          channel,
          world,
          file,
          line,
          ...(channelRef ? { channelRef } : {}),
        });
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
    const apiName =
      simple && keyToken?.type === "ident" ? context.constants.stringOf(keyToken.value, at) : null;
    const api =
      (simple ? textOf(keyToken) : null) ??
      apiName ??
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
      const refs: Array<NonNullable<BridgeMember["channelRef"]>> = [];
      for (let j = s + 1; j + 2 < end; j++) {
        const callee = tokens[j + 2]!;
        if (
          tokens[j]!.type === "ident" &&
          (context.aliases.get(j) ?? tokens[j]!.value) === "ipcRenderer" &&
          is(j + 1, ".") &&
          callee.type === "ident" &&
          CHANNEL_CALLS.has(callee.value) &&
          is(j + 3, "(")
        ) {
          const channelName = context.constants.resolve(j + 4);
          if (channelName && "value" in channelName) channels.add(channelName.value);
          else if (channelName && "ref" in channelName) refs.push(channelName.ref);
        } else if (
          tokens[j]!.type === "ident" &&
          is(j + 1, "(") &&
          context.aliases.get(j) === tokens[j]!.value &&
          context.wrappers.get(tokens[j]!.value)?.startsWith("ipcRenderer.")
        ) {
          // a helper of the file that forwards its first argument as the channel
          const channelName = context.constants.resolve(j + 2);
          if (channelName && "value" in channelName) channels.add(channelName.value);
          else if (channelName && "ref" in channelName) refs.push(channelName.ref);
        }
      }
      // Two different channels in one member: which one it forwards to is not decidable here.
      const only = channels.size + refs.length === 1;
      push(
        name,
        only && channels.size === 1 ? [...channels][0]! : null,
        first.line,
        only && refs.length === 1 ? refs[0] : undefined,
      );
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
    // An object put together in steps: `api.onChange = (fn) => …` after `const api = {…}`.
    const objectName =
      simple && tokens[at + 2]?.type === "ident" && is(at + 3, ")") ? tokens[at + 2]!.value : null;
    if (objectName && !stepwise.has(objectName)) {
      stepwise.add(objectName);
      budget -= tokens.length;
      if (budget <= 0) truncated = true;
      else
        for (let k = 0; k + 3 < tokens.length; k++) {
          if (
            tokens[k]!.type !== "ident" ||
            tokens[k]!.value !== objectName ||
            is(k - 1, ".") ||
            !is(k + 1, ".") ||
            tokens[k + 2]!.type !== "ident" ||
            !is(k + 3, "=")
          )
            continue;
          let end = k + 4;
          for (let d = 0; end < tokens.length && end < k + 2000; end++) {
            const p = tokens[end]!;
            if (p.type !== "punct") continue;
            if (p.value === "{" || p.value === "(" || p.value === "[") d++;
            else if (p.value === "}" || p.value === ")" || p.value === "]") {
              if (d === 0) break;
              d--;
            } else if (p.value === ";" && d === 0) break;
          }
          start = k + 2;
          flush(end);
        }
    }
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
  /** Network calls read from the sources, each with file, line and column. */
  endpoints: AppCandidate[];
  /** Storage accesses (web storage, IndexedDB, cookies, electron-store) with their keys. */
  storage: AppCandidate[];
  /** URLs that occur as plain strings. Not endpoints: nothing shows they are requested. */
  urls: AppCandidate[];
  /** How much of the application's JavaScript this analysis has read. */
  coverage: JsCoverage;
  totals: { files: number; javascript: number; bytes: number; skipped: number };
  findings: Finding[];
  limitations: Limitation[];
}

/** An endpoint, storage access or URL literal with the file it was read from. */
export interface AppCandidate extends Candidate {
  file: string;
}

export interface JsCoverage {
  /** JavaScript files of the application (node_modules excluded). */
  total: number;
  /** Files read so far, over all runs that were continued. */
  scanned: number;
  /** Files not read yet. Zero means every list below covers the whole application. */
  remaining: number;
  /** Files that were passed over for exceeding the per-file size limit; they count as scanned. */
  skipped: number;
  complete: boolean;
  /** True when this result continues an earlier, stored scan of the same input. */
  resumed: boolean;
  /** The fixed order files are taken in, so a continued scan never repeats or omits a file. */
  order: "entry file, then path depth, then path";
  /** The first files that are still unread, in scan order. */
  nextFiles: string[];
}

/** Bump when the facts change shape or a detector changes what it reads. */
export const JS_SCAN_SCHEMA = 1;

/**
 * Everything read from the files scanned so far. It is plain JSON, so a scan can be stored and
 * continued later; the analysis result is assembled from it.
 */
export interface JsScanFacts {
  schema: number;
  /** Paths already processed, in scan order. A file is processed exactly once. */
  scanned: string[];
  skippedFiles: string[];
  skipped: number;
  bytes: number;
  modules: JsModule[];
  edges: JsEdge[];
  externals: Record<string, number>;
  webPreferences: WebPreference[];
  contextBridge: BridgeMember[];
  endpoints: AppCandidate[];
  storage: AppCandidate[];
  urls: AppCandidate[];
  preloadScripts: string[];
  flags: {
    nodeIntegration: boolean | null;
    contextIsolation: boolean | null;
    sandbox: boolean | null;
    remoteModule: boolean;
  };
  electronSeen: boolean;
  prefsCapped: boolean;
  bridgeCapped: boolean;
  candidatesCapped: boolean;
  /** Limitations that belong to single files (e.g. a token budget that ran out). */
  limitations: Limitation[];
}

export function emptyJsScanFacts(): JsScanFacts {
  return {
    schema: JS_SCAN_SCHEMA,
    scanned: [],
    skippedFiles: [],
    skipped: 0,
    bytes: 0,
    modules: [],
    edges: [],
    externals: {},
    webPreferences: [],
    contextBridge: [],
    endpoints: [],
    storage: [],
    urls: [],
    preloadScripts: [],
    flags: { nodeIntegration: null, contextIsolation: null, sandbox: null, remoteModule: false },
    electronSeen: false,
    prefsCapped: false,
    bridgeCapped: false,
    candidatesCapped: false,
    limitations: [],
  };
}

const MAX_CANDIDATES = 5000;
/** Every detector of candidates.ts needs one of these in the source to report anything. */
const CAN_HOLD_CANDIDATES =
  /https?:|wss?:|fetch|Storage|indexedDB|cookie|caches|axios|\.(get|post|put|patch|delete|head|options|request|open)\(|sendBeacon|EventSource|WebSocket|path\s*:|electron-store|["'`]\/(api|graphql|v\d|rest|rpc)/;
const pathDepth = (path: string): number => path.split("/").length;

/** `src/**`, `renderer/` or `*.min.js`: a path prefix, or a pattern with `*` wildcards. */
function pathMatcher(patterns: readonly string[]): (path: string) => boolean {
  const tests = patterns.slice(0, 32).map((p) => {
    if (!p.includes("*"))
      return (path: string): boolean =>
        path === p || path.startsWith(p.endsWith("/") ? p : `${p}/`);
    const parts = p.slice(0, 512).split("*");
    // The parts between the stars are found left to right, each at its first possible place:
    // linear in the path, however many stars there are (a regular expression is not).
    return (path: string): boolean => {
      const first = parts[0]!;
      const last = parts[parts.length - 1]!;
      if (!path.startsWith(first)) return false;
      let at = first.length;
      for (let i = 1; i < parts.length - 1; i++) {
        const found = path.indexOf(parts[i]!, at);
        if (found === -1) return false;
        at = found + parts[i]!.length;
      }
      return path.length - last.length >= at && path.endsWith(last);
    };
  });
  return (path) => tests.some((t) => t(path));
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
  // Dependencies are listed (native addons are found there) but do not use up the limit: an
  // application's own files must not go unlisted because node_modules came first.
  let own = 0;
  let truncated: string | undefined;
  const atLimit = (): boolean => own >= maxFiles || files.length >= maxFiles * 4;
  const walk = (dir: string, depth: number): void => {
    if (depth > 32) {
      truncated ??= "The directory is nested deeper than 32 levels.";
      return;
    }
    if (atLimit()) {
      truncated ??= `The directory has more than ${maxFiles} files of its own, or more than ${maxFiles * 4} in all.`;
      return;
    }
    let entries: string[];
    try {
      // The application's own directories before its dependencies.
      entries = readdirSync(dir).toSorted(
        (a, b) => Number(a === "node_modules") - Number(b === "node_modules") || (a < b ? -1 : 1),
      );
    } catch {
      return;
    }
    for (const name of entries) {
      if (SKIP_DIRS.has(name)) continue;
      const entry = join(dir, name);
      let st;
      try {
        st = lstatSync(entry);
        if (st.isSymbolicLink()) {
          // Follow a link only when its target stays inside the root (pnpm/workspace layouts);
          // anything pointing outside is recorded and never read.
          const real = realpathSync(entry);
          if (!inside(real)) {
            if (skippedLinks.length < 200)
              skippedLinks.push(relative(root, entry).split(sep).join("/"));
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
      if (st.isDirectory()) walk(entry, depth + 1);
      else if (st.isFile()) {
        const path = relative(root, entry).split(sep).join("/");
        files.push({ path, size: st.size });
        if (!path.includes("node_modules/")) own++;
        if (atLimit()) {
          truncated ??= `The directory has more than ${maxFiles} files of its own.`;
          return;
        }
      }
    }
  };
  walk(root, 0);
  return {
    kind: "directory",
    root,
    files,
    ...(skippedLinks.length ? { skippedLinks } : {}),
    ...(truncated ? { truncated } : {}),
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
    /** Files read in one run (default 5,000). With `all`, the size of one batch. */
    maxJsFiles?: number;
    maxFileBytes?: number;
    /** Source bytes read in one run (default 256 MiB); what is over stays unread, not skipped. */
    maxTotalBytes?: number;
    /** Facts of an earlier run on the same input; files in it are not read again. */
    resume?: JsScanFacts;
    /** Read only unread files whose path matches one of these prefixes or `*` patterns. */
    include?: readonly string[];
    /** Read every unread file, batch after batch, ignoring the per-run budgets. */
    all?: boolean;
    /** Receives the facts after every batch and at the end, to store them. */
    onFacts?: (facts: JsScanFacts) => void;
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
  const facts: JsScanFacts =
    options.resume && options.resume.schema === JS_SCAN_SCHEMA
      ? options.resume
      : emptyJsScanFacts();
  const resumed = facts.scanned.length > 0;
  const { modules, edges, webPreferences, contextBridge, flags } = facts;
  const externals = new Map<string, number>(Object.entries(facts.externals));
  const preloadScripts = new Set<string>(facts.preloadScripts);
  let bytes = facts.bytes;
  let skipped = facts.skipped;
  let electronSeen = facts.electronSeen;
  /** Every webPreferences-style setting read from source, with the place it was read. */
  let prefsCapped = facts.prefsCapped;
  let bridgeCapped = facts.bridgeCapped;
  /** Writes the running counters back, so `facts` is a complete, storable state. */
  const sync = (): JsScanFacts => {
    facts.bytes = bytes;
    facts.skipped = skipped;
    facts.electronSeen = electronSeen;
    facts.prefsCapped = prefsCapped;
    facts.bridgeCapped = bridgeCapped;
    facts.externals = Object.fromEntries(externals);
    facts.preloadScripts = [...preloadScripts];
    return facts;
  };

  // A fixed order: the entry file, then shallow paths before deep ones, then by path. Entry
  // points and preloads sit near the root, so the first batch sees them; and because the order
  // depends on nothing but the file list, a continued scan takes up exactly where it stopped.
  const mainPath = pkg?.main ? posix.normalize(pkg.main) : null;
  const ordered = jsFiles.toSorted(
    (a, b) =>
      Number(b.path === mainPath) - Number(a.path === mainPath) ||
      pathDepth(a.path) - pathDepth(b.path) ||
      (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  );
  const done = new Set(facts.scanned);
  const wanted = options.include?.length ? pathMatcher(options.include) : null;
  const todo = ordered.filter((f) => !done.has(f.path) && (!wanted || wanted(f.path)));
  // 0 is meaningful (show a stored scan without reading); anything else is at least one file.
  const batch = Number.isFinite(maxJsFiles) && maxJsFiles >= 1 ? Math.floor(maxJsFiles) : 5000;
  const runFiles = options.all ? Number.POSITIVE_INFINITY : maxJsFiles === 0 ? 0 : batch;
  let runBytes = 0;
  let taken = 0;

  for (const file of todo) {
    if (taken >= runFiles) break;
    // Over the budget of this run: the file stays unread and a continued scan takes it.
    // The first file of a run is always taken, so a file larger than the budget cannot stall it.
    if (
      !options.all &&
      taken > 0 &&
      file.size <= maxFileBytes &&
      runBytes + file.size > maxTotalBytes
    )
      break;
    if (options.all && taken > 0 && taken % batch === 0) options.onFacts?.(sync());
    facts.scanned.push(file.path);
    taken++;
    if (file.size > maxFileBytes) {
      skipped++;
      if (facts.skippedFiles.length < 200) facts.skippedFiles.push(file.path);
      continue;
    }
    let source: string;
    try {
      source = decode(tree.read(file.path, maxFileBytes));
    } catch {
      skipped++;
      if (facts.skippedFiles.length < 200) facts.skippedFiles.push(file.path);
      continue;
    }
    runBytes += file.size;
    bytes += file.size;
    let ranges: WindowRange[] = [];
    // Settings are read from tokens, so text in a comment or a string is never a setting.
    const settingsAt: Array<{
      key: "nodeIntegration" | "contextIsolation" | "sandbox";
      value: boolean;
      start: number;
    }> = [];
    const preloadsAt = new Set<number>();
    const scan = scanJavaScript(source, {
      onTokens: (tokens, truncated, context) => {
        if (/webPreferences|BrowserWindow|BrowserView|WebContentsView/.test(source))
          ranges = windowRanges(tokens, context.aliases);
        if (/nodeIntegration|contextIsolation|sandbox|preload/.test(source))
          for (let k = 0; k + 2 < tokens.length; k++) {
            const t = tokens[k]!;
            const colon = tokens[k + 1]!;
            if (t.type !== "ident" || colon.type !== "punct" || colon.value !== ":") continue;
            if (t.value === "preload") preloadsAt.add(t.start);
            else if (
              t.value === "nodeIntegration" ||
              t.value === "contextIsolation" ||
              t.value === "sandbox"
            ) {
              const v = tokens[k + 2]!;
              const n = tokens[k + 3];
              // true, false, and what minifiers write for them: !0 and !1
              const value =
                v.type === "ident" && (v.value === "true" || v.value === "false")
                  ? v.value === "true"
                  : v.type === "punct" &&
                      v.value === "!" &&
                      n?.type === "number" &&
                      /^[01]$/.test(n.value)
                    ? n.value === "0"
                    : null;
              // `sandbox: true && flag` is not the setting `true`: the value must end there.
              const after = tokens[v.type === "ident" ? k + 3 : k + 4];
              const ends =
                !after || (after.type === "punct" && (after.value === "," || after.value === "}"));
              if (value !== null && ends) settingsAt.push({ key: t.value, value, start: t.start });
            }
          }
        // Endpoints, storage and URL literals: only where the text can contain one at all.
        if (CAN_HOLD_CANDIDATES.test(source)) {
          const found = findCandidates(
            tokens,
            source,
            undefined,
            context.aliases,
            context.constants,
          );
          if (found.truncated) facts.candidatesCapped = true;
          for (const [from, to] of [
            [found.endpoints, facts.endpoints],
            [found.storage, facts.storage],
            [found.urls, facts.urls],
          ] as const) {
            for (const row of from) {
              if (to.length >= MAX_CANDIDATES) {
                facts.candidatesCapped = true;
                break;
              }
              to.push({ file: file.path, ...row });
            }
          }
        }
        if (!source.includes("exposeIn")) return;
        const bridge = bridgeMembers({ tokens, truncated, context }, file.path);
        const room = MAX_BRIDGE - contextBridge.length;
        contextBridge.push(...bridge.members.slice(0, room));
        if (bridge.truncated || bridge.members.length > room) bridgeCapped = true;
      },
    });
    if (scan.truncated && facts.limitations.length < 200)
      facts.limitations.push({
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
    // Where the options of a window could be located in the code (`ranges`), a setting counts
    // only inside them. Only a file where none could be located falls back to nearness.
    const windowsOf = (index: number): Array<{ window: number | null; inherited: boolean }> => {
      if (ranges.length) {
        // The innermost range decides which window it is; a helper used by two windows has one
        // range per window with the same extent, and the setting then counts for each.
        let best: WindowRange | undefined;
        for (const r of ranges)
          if (
            index >= r.start &&
            index < r.end &&
            (!best || r.end - r.start < best.end - best.start)
          )
            best = r;
        if (!best) return [];
        const { start, end } = best;
        const same = ranges.filter((r) => r.start === start && r.end === end);
        return [
          ...new Map(
            same.map((r) => [r.window, { window: r.window, inherited: r.inherited }]),
          ).values(),
        ];
      }
      const before = source.slice(Math.max(0, index - WINDOW_CONTEXT), index);
      return /webPreferences|BrowserWindow|BrowserView|WebContentsView/.test(before)
        ? [{ window: null, inherited: false }]
        : [];
    };
    // Settings of this file first; what a window overrides is dropped before they are kept.
    const found: Array<WebPreference & { inherited: boolean }> = [];
    const record = (pref: WebPreference & { inherited: boolean }): boolean => {
      if (found.length >= MAX_PREFS_PER_FILE || webPreferences.length + found.length >= MAX_PREFS) {
        prefsCapped = true;
        return false;
      }
      found.push(pref);
      return true;
    };
    // `preload: <expression>`: the script is the last path-like string literal of the expression
    // (`path.join(__dirname, "dist", "preload.js")`, `__dirname + "/preload.js"`). The expression
    // is read from a bounded window, so no input makes this scan slow.
    preloads: for (
      let at = source.indexOf("preload");
      at !== -1;
      at = source.indexOf("preload", at + 7)
    ) {
      const m = /^preload\s*:\s*/.exec(source.slice(at, at + 24));
      const windows = m && preloadsAt.has(at) ? windowsOf(at) : [];
      if (!m || /[\w$.]/.test(source[at - 1] ?? "") || !windows.length) continue;
      let expression = preloadExpression(source, at + m[0].length);
      // `preload: PRELOAD` with the path built in a constant: read the constant's initializer.
      const constant = /^\s*([A-Za-z_$][\w$]*)\s*[,}]?\s*$/.exec(expression)?.[1];
      if (constant) {
        const initializer = new RegExp(
          `(?:\\b(?:const|let|var)\\s+|,\\s*)${constant.replace(/\$/g, "\\$")}\\s*=(?!=)\\s*`,
        ).exec(source);
        if (initializer)
          expression = preloadExpression(source, initializer.index + initializer[0].length);
      }
      const literals = [...expression.matchAll(/(['"`])((?:(?!\1)[^\\\n])*)\1/g)].map((x) => x[2]!);
      const script = literals.toReversed().find((v) => /\.(c|m)?[jt]s$/.test(v));
      if (!script) continue;
      const value = script.replace(/^\$\{[^}]*\}/, "").replace(/^[\\/]+/, "");
      for (const w of windows)
        if (!record({ key: "preload", value, file: file.path, line: lineAt(at), ...w }))
          break preloads;
    }
    settings: for (const { key, value, start } of settingsAt)
      for (const w of windowsOf(start))
        if (!record({ key, value, file: file.path, line: lineAt(start), ...w })) break settings;
    for (const { inherited, ...pref } of found) {
      // A key written for the window itself replaces the same key of a base object.
      if (
        inherited &&
        pref.window !== null &&
        found.some((o) => !o.inherited && o.window === pref.window && o.key === pref.key)
      )
        continue;
      webPreferences.push(pref);
      if (pref.key === "preload") preloadScripts.add(String(pref.value));
      // Where windows could be located, an object that belongs to none of them (a base that is
      // spread and overridden, options only handed to a function) does not speak for the app.
      else if (pref.window !== null || !ranges.some((r) => r.window !== null)) {
        // the least safe value seen in any window decides the app-wide flag
        const v = pref.value === true;
        flags[pref.key] =
          pref.key === "nodeIntegration"
            ? (flags[pref.key] ?? false) || v
            : (flags[pref.key] ?? true) && v;
      }
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
      ...(scan.constants ? { constants: scan.constants } : {}),
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
  options.onFacts?.(sync());
  for (const limitation of facts.limitations) limitations.push(limitation);
  const scannedNow = new Set(facts.scanned);
  const remainingFiles = ordered.filter((f) => !scannedNow.has(f.path));
  const coverage: JsCoverage = {
    total: ordered.length,
    scanned: ordered.length - remainingFiles.length,
    remaining: remainingFiles.length,
    skipped,
    // Complete means every file was read: none left for later, none passed over, none unlisted.
    complete: remainingFiles.length === 0 && skipped === 0 && !tree.truncated,
    resumed,
    order: "entry file, then path depth, then path",
    nextFiles: remainingFiles.slice(0, 5).map((f) => f.path),
  };
  if (tree.truncated)
    limitations.push({
      code: "directory_truncated",
      message: `${tree.truncated} Files beyond that are not listed, so they are neither analyzed nor counted.`,
    });
  if (coverage.remaining > 0)
    limitations.push({
      code: "js_files_truncated",
      message: `Scanned ${coverage.scanned} of ${coverage.total} JavaScript files; ${coverage.remaining} are unread, so every list and count here covers only the scanned part. Continue the analysis to read more.`,
    });
  if (facts.candidatesCapped)
    limitations.push({
      code: "candidates_truncated",
      message: `More endpoints, storage accesses or URLs exist than the ${MAX_CANDIDATES} per list recorded.`,
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
      message: `${skipped} files were not read because they exceed the per-file size limit or could not be decoded (e.g. ${facts.skippedFiles.slice(0, 3).join(", ")}).`,
    });

  // Channel names that are constants of another module: looked up now that modules are known.
  // A reference stays in place while its module is unread, so a continued scan resolves it later.
  const moduleById = new Map(modules.map((m) => [m.id, m]));
  const lookUp = (from: string, ref: { specifier: string; property: string }): string | null => {
    const target = resolveSpecifier(from, ref.specifier, known);
    return (target ? moduleById.get(target)?.constants?.[ref.property] : undefined) ?? null;
  };
  for (const m of modules)
    for (const u of m.ipc) {
      if (u.channel !== null || !u.channelRef) continue;
      const channel = lookUp(m.id, u.channelRef);
      if (channel === null) continue;
      u.channel = channel;
      u.via = "constant";
      delete u.channelRef;
    }
  for (const b of contextBridge) {
    if (b.channel !== null || !b.channelRef) continue;
    const channel = lookUp(b.file, b.channelRef);
    if (channel === null) continue;
    b.channel = channel;
    delete b.channelRef;
  }

  // Endpoints and storage keys with a part that is a constant of another module.
  const finished = (rows: AppCandidate[]): AppCandidate[] =>
    rows.map((row) =>
      resolvePending(row, (specifier, property) => lookUp(row.file, { specifier, property })),
    );
  const endpoints = finished(facts.endpoints);
  const storage = finished(facts.storage);

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
  for (const [rows, kind, noun, collection] of [
    [endpoints, "js.endpoints", "network endpoint", "endpoints"],
    [storage, "js.storage", "storage key", "storage"],
  ] as const) {
    if (!rows.length) continue;
    const values = [...new Set(rows.filter((r) => r.value !== null).map((r) => r.value!))];
    const unread = rows.filter((r) => r.value === null).length;
    const first = rows[0]!;
    findings.push({
      kind,
      title: values.length
        ? `${values.length} ${noun}${values.length === 1 ? "" : "s"} read from the code`
        : `${unread} ${noun} call${unread === 1 ? "" : "s"} with a value that could not be read`,
      detail: `${values.length ? list(values, 6) : ""}${
        values.length && unread ? `; ${unread} more with an unreadable value` : ""
      } (collection ${collection})`.trim(),
      // Confirmed only when every value stands as a literal at its call.
      confidence: rows.every((r) => r.evidence === "literal") ? "confirmed" : "inferred",
      location: `${first.file}:${first.line}`,
    });
  }
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

  // Counts of a scan that has not read everything are counts of the scanned part, and are
  // worded and rated as such.
  if (!coverage.complete)
    for (const finding of findings)
      if (
        /^(electron\.(ipc|context-bridge|preload)|js\.(endpoints|storage|minified))$/.test(
          finding.kind,
        )
      ) {
        finding.title = `${finding.title} in the scanned part (${coverage.scanned} of ${coverage.total} files)`;
        finding.confidence = "inferred";
      }

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
    endpoints,
    storage,
    urls: facts.urls,
    coverage,
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
