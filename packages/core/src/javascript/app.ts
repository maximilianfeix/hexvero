import { createHash } from "node:crypto";
import { lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, posix, relative, sep } from "node:path";
import { readRegularFile } from "../binary/file.js";
import { openAsar, openAsarFile, readUnpacked, type AsarArchive } from "../formats/asar.js";
import type { Finding, Limitation } from "../model.js";
import { AnalysisError, NOTHING_MISSING } from "../model.js";
import { Constants, resolveAliases } from "./aliases.js";
import {
  ASSIGNMENT_OPERATORS,
  chainEnd,
  declaredAt as declaredHere,
  writesMember,
  writesName,
  writtenByCallAt,
} from "./writes.js";
import { type AmbientFacts, collectAmbient, resolveAmbient } from "./ambient.js";
import { findCandidates, resolvePending, type Candidate } from "./candidates.js";
import {
  type Binding,
  type FnDef,
  builtIdentifierIndex,
  ExpressionResolver,
  type ModuleHost,
  negatedNumber,
  type Val,
} from "./resolve.js";
import {
  ALIAS_TARGETS,
  IPC_APIS,
  evaluatorFor,
  scanJavaScript,
  tokenize,
  type ScanContext,
  type ScanResult,
  type IpcUsage,
  type ModuleReference,
  type Token,
} from "./scan.js";
import { summarizeSourceMap } from "./sourcemap.js";
import { keepSwitchRows, MAX_SWITCHES_PER_FILE, switchRows, type SwitchRow } from "./switches.js";
export type { SwitchRow } from "./switches.js";
import {
  cspHeaderRows,
  cspMetaRows,
  harmlessCsp,
  harmlessOpenExternal,
  harmlessPermission,
  keepRows,
  MAX_META_PER_FILE,
  MAX_SECURITY_ROWS_PER_FILE,
  openExternalRows,
  permissionHandlerRows,
  type CspRow,
  type OpenExternalRow,
  type PermissionHandlerRow,
} from "./security.js";
export type { CspRow, OpenExternalRow, PermissionHandlerRow } from "./security.js";
import { dangerousCallRows, harmlessDangerousCall, type DangerousCallRow } from "./dangerous.js";
export type { DangerousCallRow } from "./dangerous.js";

/** HTML files read for `<meta http-equiv="Content-Security-Policy">`, and their bytes. */
const MAX_HTML_FILES = 2000;
const MAX_HTML_BYTES = 64 << 20;

/** A dangerous `switches` row in the words of the finding's title. */
const unsafeSwitchLabel = (r: SwitchRow): string =>
  r.kind === "switch" || r.kind === "argument"
    ? `--${(r.name ?? "").replace(/^-+/, "")}${r.value !== null ? `=${r.value}` : ""}`
    : r.kind === "certificate-error"
      ? `certificate errors accepted${r.accepts === "conditional" ? " under a condition" : ""}`
      : `custom certificate verification (${r.accepts === "always" ? "accepts every certificate" : "accepts some"})`;

/** A file that contains none of these has no `switches` row. */
const SWITCH_PROBE =
  /appendSwitch|appendArgument|certificate-error|setCertificateVerifyProc|ELECTRON_DISABLE_SECURITY_WARNINGS/;
import {
  keyCallRows,
  linkKeyWrappers,
  MAX_KEY_CALLS_PER_FILE,
  type Replaced,
  linkWrappers,
  channelArg,
  factsFor,
  type ParamIpc,
  type ReadModule,
  type WrapperFacts,
  WrapperReader,
} from "./wrappers.js";

/** A module for one cross-file wrapper stage, with the facts of that stage only. */
function withFacts(m: JsModule, wrappers: WrapperFacts | undefined): JsModule {
  const { wrappers: _all, ...rest } = m;
  return wrappers ? { ...rest, wrappers } : rest;
}

/** The objects a parameter used as the IPC object may be (see `ParamIpc`). */
const IPC_OBJECTS: ReadonlySet<string> = new Set(["ipcMain", "ipcRenderer"]);
/** `ipcMain` or `ipcRenderer` by its own name, as the scan reads a call on one. */
const ipcName = (t: Token | undefined): string | null =>
  t?.type === "ident" && IPC_OBJECTS.has(t.value) ? t.value : null;

/**
 * The IPC rows of functions and methods with a parameter used as the IPC object: per function,
 * every call site this module and other modules have (`sites`, keyed by the defining module, the
 * function's key and the parameter), and only when there is one and every one passes the same
 * object (ipcMain or ipcRenderer). One that passes anything else, or is not read, makes the
 * function no IPC. A call the object has no such method for (`ipcRenderer.handle`) gives none.
 */
export function paramIpcRows(
  modules: ReadonlyArray<Pick<JsModule, "id" | "ipc" | "paramIpc" | "wrappers">>,
  linked: ReadonlyMap<
    string,
    ReadonlyArray<{ home: string; key: string; index: number; site: string; target: string | null }>
  >,
  /**
   * The cross-module search may have missed calls (`linkWrappers`): of methods, of plain
   * functions. A function or method another module may call is then undecided.
   */
  cut: { methods: boolean; fns: boolean } = { methods: false, fns: false },
  /** Modules another module imports: their functions may be called there. */
  imported: ReadonlySet<string> = new Set(),
): void {
  const all = new Map<
    string,
    { m: (typeof modules)[number]; e: ParamIpc; sites: Map<string, string | null> }
  >();
  for (const m of modules)
    for (const e of m.paramIpc ?? []) {
      // a function another module may call, when not every module was read for calls of it
      if (
        e.key.startsWith("fn@")
          ? cut.fns && m.wrappers?.fns?.length
          : cut.methods && Object.keys(m.wrappers?.exports ?? {}).length
      )
        continue;
      // other modules are read only for what looks like IPC: in a module another one imports,
      // anything else may be called there with any object, unread
      if (imported.has(m.id) && !e.calls.some((c) => c.ipcLike)) continue;
      all.set(`${m.id}\u0000${e.key}\u0000${e.index}`, {
        m,
        e,
        // this file's own sites are written `:<token>`
        sites: new Map(
          e.sites.map((x) => [x.site.startsWith(":") ? `${m.id}${x.site}` : x.site, x.target]),
        ),
      });
    }
  for (const [file, sites] of linked)
    for (const x of sites) {
      const home = x.home || file;
      const entry = all.get(`${home}\u0000${x.key}\u0000${x.index}`);
      if (!entry) continue;
      entry.sites.set(x.site.startsWith(":") ? `${file}${x.site}` : x.site, x.target);
    }
  for (const { m, e, sites } of all.values()) {
    const targets = new Set(sites.values());
    if (targets.size !== 1 || targets.has(null)) continue;
    const target = [...targets][0]!;
    for (const call of e.calls) {
      const api = `${target}.${call.method}`;
      if (!IPC_APIS.has(api)) continue;
      m.ipc.push({
        api,
        channel: call.channel,
        line: call.line,
        via: "parameter",
        wrapper: e.label,
        ...(call.channelRef ? { channelRef: call.channelRef } : {}),
        ...(call.args !== undefined && target === "ipcRenderer" ? { args: call.args } : {}),
      });
    }
    m.ipc.sort((x, y) => x.line - y.line);
  }
}

/** Minimal read-only file tree so directories and ASAR archives share one analyzer. */
export interface FileTree {
  kind: "directory" | "asar";
  root: string;
  /** `unpacked`: an ASAR entry stored in `<archive>.unpacked/` beside the archive. */
  files: Array<{ path: string; size: number; unpacked?: boolean }>;
  read(path: string, maxBytes?: number): Uint8Array;
  /** Symbolic links that pointed outside the root and were therefore not followed. */
  skippedLinks?: string[];
  /** Set when the listing itself is incomplete, with the reason: later files are unknown. */
  truncated?: string;
  /**
   * For an archive whose unpacked files were handed over in memory (taken from a ZIP): what
   * identifies the unpacked file at `path` (a hash of its bytes, or `absent`), for the scan key.
   */
  unpackedStamp?: (path: string) => string;
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
  /** Names the file passes on from other modules, and `export *` sources (see aliases.ts). */
  reexports?: Record<string, { specifier: string; property: string }>;
  starExports?: string[];
  /** Every `module.exports = require("…")` of the file, for replacements of wrapper methods. */
  looseStarExports?: string[];
  /** Keys of `constants` whose values were read by evaluating the file's code (resolve.ts). */
  evaluated?: string[];
  /** Exported names an evaluation of the file's code could not read, with the reason. */
  unevaluated?: Record<string, string>;
  /**
   * IPC names the file defines for other files, and its calls on names it does not bind that are
   * still waiting for a definition (see `ambient.ts`).
   */
  ambient?: AmbientFacts;
  /** Wrapper classes and objects the file exports, for calls in other files (wrappers.ts). */
  wrappers?: WrapperFacts;
  /** Storage-key wrapper classes and objects the file exports, for calls in other files. */
  keyWrappers?: WrapperFacts;
  /** Functions and methods with a parameter used as the IPC object (see wrappers.ts). */
  paramIpc?: ParamIpc[];
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

/** A short comma list that says how many it left out, as `(N more)`: not `list`'s `… and N more`. */
function some(items: string[], max: number): string {
  return items.length > max
    ? `${items.slice(0, max).join(", ")} (${items.length - max} more)`
    : items.join(", ");
}

/**
 * The places a limitation applies to, as `at file:line` (`file:1` for a whole file), which
 * `Unresolved.fromLimitations` (session.ts) reads; past `max` the rest is counted (`… and N
 * more`), and the limitation then applies anywhere.
 */
function atPlaces(at: string[], max: number): string {
  return list(
    at.map((p) => `at ${p}`),
    max,
  );
}

/** What may follow `object.key` when the key is only read. */
const READ_FOLLOWERS = new Set([
  ")",
  ",",
  ";",
  "}",
  "]",
  "?",
  ":",
  "&&",
  "||",
  "??",
  "===",
  "!==",
  "==",
  "!=",
  "<",
  ">",
  "<=",
  ">=",
]);

/** Where a reply was read and what it sends: rows carry no column. */
const lineAndChannel = (u: IpcUsage): string => `${u.line}\0${u.channel}`;

/** The settings that decide what a page's scripts and its preload can reach. */
const CORE_KEYS = ["nodeIntegration", "contextIsolation", "sandbox"] as const;
type CoreKey = (typeof CORE_KEYS)[number];
/** Further boolean settings read as written; each has a finding of its own or none. */
const OTHER_KEYS = [
  "webSecurity",
  "allowRunningInsecureContent",
  "webviewTag",
  "nodeIntegrationInSubFrames",
  "nodeIntegrationInWorker",
  "enableRemoteModule",
] as const;
const BOOLEAN_KEYS: ReadonlySet<string> = new Set([...CORE_KEYS, ...OTHER_KEYS]);
const isCoreKey = (key: string): key is CoreKey => (CORE_KEYS as readonly string[]).includes(key);
export type PreferenceKey = "preload" | CoreKey | (typeof OTHER_KEYS)[number];

/** One BrowserWindow setting as written in the source: the evidence behind the Electron flags. */
export interface WebPreference {
  key: PreferenceKey;
  /** The literal written in the code; null when the value is computed at run time. */
  value: string | boolean | null;
  /** The expression in place of a literal (`!isDev`, `options.sandbox`), shortened. */
  computed?: string;
  file: string;
  line: number;
  /**
   * Which window of the file the setting belongs to, counted in source order from 1; null when
   * the setting sits in a `webPreferences` object that is not part of a window constructor call
   * (returned by a helper, or used to override a child window's options).
   */
  window: number | null;
  /**
   * A name for the window that survives code moving and windows being added before it: the
   * variable the constructor call is assigned to (`promptWindow = new BrowserWindow(…)`), with
   * `#2`, `#3` appended when a file assigns several windows to the same name; `#<window>` when
   * the call is not assigned; null where `window` is null. `compare` matches settings by it.
   */
  windowName: string | null;
  /**
   * Where the value is written when that is not the window's own constructor call: a defaults
   * object in another module, read by following the window's options (`resolve.ts`). `file` and
   * `line` then name the window, so the setting stays with it.
   */
  definedIn?: { file: string; line: number };
}

/**
 * How a setting stands for one window: its literal, computed at run time, absent from the code,
 * or `conflicting` when two different literals are written for the window in places whose order
 * of effect cannot be read (two separate objects), so neither is taken.
 */
export type SettingState = boolean | "computed" | "conflicting" | "not written";

/**
 * What holds for a window. `on`/`off`: decided by what the code writes. `default on`/`default
 * off`: the setting is not written, and this is Electron's default for the version package.json
 * asks for. That version is a statement of the application's own metadata, not the runtime that
 * is shipped, so a default is an assumption and never reads as a fact. `unknown`: computed, or
 * not written with no version named.
 */
export type Effect = "on" | "off" | "default on" | "default off" | "unknown";

/**
 * One window with its core settings side by side, and what follows from them together, by
 * Electron's documented rules (docs/electron-findings.md). This describes the configuration, not
 * the behaviour of a running app.
 */
export interface WindowSummary {
  file: string;
  window: number;
  windowName: string;
  line: number;
  nodeIntegration: SettingState;
  contextIsolation: SettingState;
  sandbox: SettingState;
  preload: string | null;
  nodeIntegrationInEffect: Effect;
  contextIsolationInEffect: Effect;
  sandboxInEffect: Effect;
  /**
   * Whether the page's own scripts get Node's `require`. `… by default` rests on a default of the
   * version package.json names, see `Effect`.
   */
  pageRequire: "yes" | "no" | "yes by default" | "no by default" | "unknown";
  webSecurity: SettingState;
  allowRunningInsecureContent: SettingState;
  /**
   * Whether the same-origin policy holds for the window's pages. Its default, on, is the same in
   * every Electron version, so `default on` needs no version from package.json.
   */
  webSecurityInEffect: Effect;
  /**
   * Whether an https page may run content loaded over http: off by default in every version,
   * and on where `webSecurity: false` is written and this setting is not (WebPreferences).
   */
  allowRunningInsecureContentInEffect: Effect;
  /** The rule each derived value rests on. */
  basis: string;
}

/** A state from which no value can be taken. */
const noValue = (state: SettingState): state is "computed" | "conflicting" =>
  state === "computed" || state === "conflicting";

/** Text taken from the analyzed file, bounded before it goes into a message. */
const short = (text: string): string => (text.length > 80 ? `${text.slice(0, 80)}…` : text);

/** The major version in a package.json range such as `^38.0.0`; null when it names none. */
export function electronMajor(range: string | null | undefined): number | null {
  const m = /^[\^~>=v\s]*(\d+)(?:\.|\s|$)/.exec(range ?? "");
  return m ? Number(m[1]) : null;
}

/**
 * The derived columns of a window. Sources, all electronjs.org: breaking changes (5.0
 * nodeIntegration off, 12.0 contextIsolation on and `require()` in a page only with
 * nodeIntegration on and contextIsolation off, 20.0 sandbox on unless nodeIntegration is on or
 * sandbox is false), the WebPreferences structure, and the sandbox tutorial (app.enableSandbox
 * overrides `sandbox: false`). `major` is the version package.json asks for, or null.
 */
export function windowEffects(
  w: Pick<WindowSummary, "nodeIntegration" | "contextIsolation" | "sandbox">,
  major: number | null,
  enableSandbox: boolean | "maybe",
): Pick<
  WindowSummary,
  | "nodeIntegrationInEffect"
  | "contextIsolationInEffect"
  | "sandboxInEffect"
  | "pageRequire"
  | "basis"
> {
  const basis: string[] = [];
  const byDefault = (name: string, since: number): Effect => {
    if (major === null) {
      basis.push(`${name} not written: on by default since Electron ${since}, version not known`);
      return "unknown";
    }
    const on = major >= since;
    basis.push(
      `${name} not written: ${on ? "on" : "off"} by default in Electron ${major}, the version package.json asks for (on since ${since}); the shipped runtime was not checked`,
    );
    return on ? "default on" : "default off";
  };
  // nodeIntegration was on by default before Electron 5 and is off since.
  let node: Effect;
  if (typeof w.nodeIntegration === "boolean") node = w.nodeIntegration ? "on" : "off";
  else if (noValue(w.nodeIntegration)) {
    node = "unknown";
    basis.push(`nodeIntegration is ${w.nodeIntegration}`);
  } else if (major === null) {
    node = "unknown";
    basis.push("nodeIntegration not written: off by default since Electron 5, version not known");
  } else {
    node = major < 5 ? "default on" : "default off";
    basis.push(
      `nodeIntegration not written: ${major < 5 ? "on" : "off"} by default in Electron ${major}, the version package.json asks for (off since 5); the shipped runtime was not checked`,
    );
  }
  let isolation: Effect;
  if (typeof w.contextIsolation === "boolean") {
    isolation = w.contextIsolation ? "on" : "off";
    basis.push("contextIsolation as written");
  } else if (noValue(w.contextIsolation)) {
    isolation = "unknown";
    basis.push(`contextIsolation is ${w.contextIsolation}`);
  } else isolation = byDefault("contextIsolation", 12);
  let sandbox: Effect;
  // Both written: the documentation says Node integration disables the sandbox, and does not
  // say what an explicit `sandbox: true` next to it does. Nothing is claimed for that pair.
  const contested = w.nodeIntegration === true && (w.sandbox === true || enableSandbox === true);
  if (contested) {
    sandbox = "unknown";
    basis.push(
      `nodeIntegration: true and ${w.sandbox === true ? "sandbox: true" : "app.enableSandbox()"} are both written; Electron's documentation does not say which decides`,
    );
  } else if (enableSandbox === true) {
    sandbox = "on";
    basis.push("app.enableSandbox() is called, which overrides per-window settings");
  } else if (node === "on") {
    sandbox = "off";
    basis.push("nodeIntegration: true disables the sandbox");
  } else if (typeof w.sandbox === "boolean") {
    sandbox = w.sandbox ? "on" : "off";
    basis.push("sandbox as written");
  } else if (noValue(w.sandbox) || noValue(w.nodeIntegration)) {
    sandbox = "unknown";
    basis.push(
      noValue(w.sandbox) ? `sandbox is ${w.sandbox}` : `nodeIntegration is ${w.nodeIntegration}`,
    );
  } else sandbox = byDefault("sandbox", 20);
  if (enableSandbox === "maybe" && sandbox !== "on") {
    sandbox = "unknown";
    basis.push(
      "app.enableSandbox() is called inside a function or behind a condition; whether it runs was not read",
    );
  }
  // A page gets require() only with Node integration on AND context isolation off. The answer
  // is as certain as its least certain part: `by default` when either rests on a default.
  let pageRequire: WindowSummary["pageRequire"];
  if (node === "off") pageRequire = "no";
  else if (node === "unknown") pageRequire = isolation === "on" ? "no" : "unknown";
  else if (node === "default off") pageRequire = isolation === "on" ? "no" : "no by default";
  else if (isolation === "on") pageRequire = "no";
  else if (isolation === "unknown") pageRequire = "unknown";
  else if (isolation === "default on") pageRequire = "no by default";
  else pageRequire = node === "on" && isolation === "off" ? "yes" : "yes by default";
  // If the sandbox does decide for that pair, the renderer has no Node at all.
  if (contested && pageRequire !== "no") pageRequire = "unknown";
  return {
    nodeIntegrationInEffect: node,
    contextIsolationInEffect: isolation,
    sandboxInEffect: sandbox,
    pageRequire,
    basis: basis.join("; "),
  };
}

/**
 * The web security columns of a window, from Electron's WebPreferences structure: `webSecurity`
 * defaults to true, `allowRunningInsecureContent` to false, and `webSecurity: false` sets
 * `allowRunningInsecureContent` to true when the code does not write it. Neither default changed
 * between versions. `basis` explains each value that is not a default.
 */
export function webSecurityEffects(
  w: Pick<WindowSummary, "webSecurity" | "allowRunningInsecureContent">,
): Pick<WindowSummary, "webSecurityInEffect" | "allowRunningInsecureContentInEffect"> & {
  basis: string[];
} {
  const basis: string[] = [];
  let web: Effect;
  if (typeof w.webSecurity === "boolean") {
    web = w.webSecurity ? "on" : "off";
    basis.push(`webSecurity: ${String(w.webSecurity)} as written`);
  } else if (noValue(w.webSecurity)) {
    web = "unknown";
    basis.push(`webSecurity is ${w.webSecurity}`);
  } else web = "default on";
  let insecure: Effect;
  if (typeof w.allowRunningInsecureContent === "boolean") {
    insecure = w.allowRunningInsecureContent ? "on" : "off";
    basis.push(`allowRunningInsecureContent: ${String(w.allowRunningInsecureContent)} as written`);
  } else if (noValue(w.allowRunningInsecureContent)) {
    insecure = "unknown";
    basis.push(`allowRunningInsecureContent is ${w.allowRunningInsecureContent}`);
  } else if (web === "off") {
    insecure = "on";
    basis.push("allowRunningInsecureContent not written: webSecurity: false turns it on");
  } else if (web === "unknown") {
    insecure = "unknown";
    basis.push(
      "allowRunningInsecureContent not written: it follows webSecurity, which is not known",
    );
  } else insecure = "default off";
  return { webSecurityInEffect: web, allowRunningInsecureContentInEffect: insecure, basis };
}

/** A stretch of source that holds a window's options, and which window it is. */
interface WindowRange {
  start: number;
  end: number;
  window: number | null;
  name: string | null;
  /**
   * For a base object (`inherited`): the place in the window's own options where it is applied,
   * the `...` of a spread or the helper call. JavaScript lets the later of two writes of a key
   * win, so a base applied after a key replaces it, and one applied before is replaced.
   */
  at: number | null;
  /**
   * The object is a base the window's own options are laid over (a spread object, or what a
   * helper function returns): a key written directly for the window replaces the same key here.
   */
  inherited: boolean;
}

const WINDOW_CLASSES = new Set(["BrowserWindow", "BrowserView", "WebContentsView"]);

/**
 * The class a `new` at k constructs and the `(` of its arguments: `new C(`, `new X.C(`, and with
 * the callee in parentheses, as bundlers write a member of a lazily loaded module:
 * `new (X.C)(`, `new (X().C)(` (webpack 5's `new (le().BrowserWindow)(t)`). Null for any other
 * callee. Whether C is a window class is the caller's to read.
 */
function windowCallee(tokens: readonly Token[], k: number): { ctor: number; open: number } | null {
  const is = (i: number, v: string): boolean =>
    tokens[i]?.type === "punct" && tokens[i]!.value === v;
  const ident = (i: number): boolean => tokens[i]?.type === "ident";
  if (tokens[k]?.type !== "ident" || tokens[k]!.value !== "new") return null;
  let c = k + 1;
  if (ident(c)) {
    if (is(c + 1, ".") && ident(c + 2)) c += 2;
    return is(c + 1, "(") ? { ctor: c, open: c + 1 } : null;
  }
  if (!is(c, "(") || !ident(c + 1)) return null;
  // `(X)`, `(X.C)`, `(X().C)`
  let j = c + 1;
  if (is(j + 1, "(") && is(j + 2, ")")) j += 2;
  if (is(j + 1, ".") && ident(j + 2)) j += 2;
  if (!is(j + 1, ")")) return null;
  const close = j + 1;
  // `(X()).C(`: esbuild's minified print of `new (X().C)(…)`, the same construction
  if (is(close + 1, ".") && ident(close + 2))
    return j > c + 1 && is(close + 3, "(") ? { ctor: close + 2, open: close + 3 } : null;
  return ident(j) && is(close + 1, "(") ? { ctor: j, open: close + 1 } : null;
}

/** The class constructed by the `new` whose arguments open at `open` (see `windowCallee`), or -1. */
function windowCalleeBefore(tokens: readonly Token[], open: number): number {
  // `new C(`, `new X.C(`, `new (X.C)(`, `new (X().C)(`: the `new` is 2 to 8 tokens before
  for (let k = open - 2; k >= 0 && k >= open - 8; k--) {
    const callee = windowCallee(tokens, k);
    if (callee) return callee.open === open ? callee.ctor : -1;
  }
  return -1;
}

/**
 * Where window options are written in a file: the argument of every `new BrowserWindow(…)`, a
 * `webPreferences` object passed to it by name or spread into it, and any other object under a
 * `webPreferences` key. A setting outside these is not a window setting, however near it is.
 */
/** Past every place of a file: an options value that cannot be followed hides every key. */
const EVERYWHERE = Number.MAX_SAFE_INTEGER;

/** The ranges of a file, and what could not be followed while locating them. */
interface WindowRanges {
  ranges: WindowRange[];
  /**
   * Names of objects that were followed to their declaration as window options, each with the
   * first token of the initializers it was followed to (-1: an imported name).
   */
  traced: Map<string, number[]>;
  /** Windows whose options come, in part, from such a named object. */
  viaName: Set<number>;
  /**
   * Windows whose options take a value that could not be followed (a parameter, a call, a
   * conditional, a spread of something unknown), with the place up to which keys written for
   * the window may be replaced by it. A key the code writes after that place stands.
   */
  opaque: Map<number, number>;
  /**
   * Bases that are a member of another module (`windowConfig.secureDefaults` with
   * `windowConfig = require("./config/windows")`), applied at a place of a window's options.
   * They are looked up once every module is known; until then nothing is claimed for them.
   */
  externals: ExternalBase[];
  /** Every place per window where something unreadable was applied (`opaque` is the last). */
  hides: Map<number, number[]>;
  /**
   * Per window, the place of the last write of the whole `webPreferences` key in the window's
   * own options (`webPreferences: {…}`, `webPreferences: prefs`, the shorthand `{ webPreferences
   * }`) whose object could be followed. When it comes after every place in `opaque`, nothing
   * unreadable can reach a setting: the later key replaces whatever a spread before it brought.
   */
  wholePrefs: Map<number, number>;
}

/**
 * One argument of `Object.assign(…)` as window options: an object of this file (`open`), another
 * module's (`external`), or neither (`open` -1, no `external`): something that may write any key.
 */
interface PlanStep {
  open: number;
  at: number;
  /** Names followed to reach the object, with the initializer each was followed to. */
  follows: Array<{ name: string; decl: number }>;
  external?: { specifier: string; property: string; expr: number };
}

/** What a name is bound to where it is used (see `declOf` in `windowRanges`). */
type Declared = number | "pattern" | "other" | null;

/** A window base exported by another module, applied at `at` (a source offset). */
interface ExternalBase {
  window: number;
  at: number;
  /** Source offset of the expression (`windowConfig.secureDefaults`), to evaluate it later. */
  expr: number;
  /**
   * `prefs`: the base is a webPreferences object (an argument of `webPreferences:
   * Object.assign(…)`); `options`: it is laid over a window's options or an object whose level
   * is decided where it is applied.
   */
  level: "options" | "prefs";
  specifier: string;
  property: string;
}

function windowRanges(
  tokens: Token[],
  aliases: Map<number, string>,
  /** Built on first use: reads a factory's parameter from the arguments at its call sites. */
  resolver: () => ExpressionResolver,
  /**
   * For `X.prop` at token k with `X = require("…")`, or a name at k imported from another
   * module (`const { X } = require("…")`, `import { X } from "…"`): the module and the member;
   * else null.
   */
  externalOf: (k: number) => { specifier: string; property: string } | null = () => null,
  /** The string a name at k is a constant of (`const NI = "nodeIntegration"`), else null. */
  stringAt: (k: number) => string | null = () => null,
): WindowRanges & { declOf: (k: number) => Declared } {
  const traced = new Map<string, Set<number>>();
  const viaName = new Set<number>();
  const follow = (name: string, decl: number, window: number | null): void => {
    // what an object that belongs to no window holds decides no window's settings
    if (window === null) return;
    let decls = traced.get(name);
    if (!decls) traced.set(name, (decls = new Set()));
    decls.add(decl);
    viaName.add(window);
  };
  const opaque = new Map<number, number>();
  /** Every place something unreadable was applied, per window; `opaque` holds the last one. */
  const hides = new Map<number, number[]>();
  /** How often something unreadable was applied, per window (not capped, unlike `hides`). */
  const hideCount = new Map<number, number>();
  const wholePrefs = new Map<number, number>();
  const hide = (window: number | null, upTo: number): void => {
    if (window === null) return;
    hideCount.set(window, (hideCount.get(window) ?? 0) + 1);
    opaque.set(window, Math.max(opaque.get(window) ?? -1, upTo));
    const places = hides.get(window) ?? [];
    if (places.length < 200) places.push(upTo);
    hides.set(window, places);
  };
  const externals: ExternalBase[] = [];
  /** A base of another module at k (`X.prop`, an imported name), as a whole argument or spread operand: recorded instead of hidden. */
  const external = (
    k: number,
    window: number | null,
    at: number,
    given?: { specifier: string; property: string; expr: number },
    level: ExternalBase["level"] | null = "options",
  ): boolean => {
    if (window === null || level === null) return false;
    const ref = given ?? (k >= 0 ? externalOf(k) : null);
    if (!ref || externals.length >= 200) return false;
    externals.push({ window, at, expr: given ? given.expr : tokens[k]!.start, level, ...ref });
    // Unread until every module is known: hidden like an unknown spread for now.
    hide(window, at);
    return true;
  };
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
  /**
   * What the name at k is bound to where it is used, by scope (`ExpressionResolver.binding`,
   * also when it is written later: those writes are read by the caller): the first token of the
   * initializer of its declaration, `pattern` for a name taken from an object pattern or an
   * import, `other` for a parameter, function or class, null when that is not known.
   */
  const declOf = (k: number): Declared => {
    const t = tokens[k];
    if (t?.type !== "ident") return null;
    // a parameter (or a default value) in the parameter list of a function that has one of the
    // name: `(t, n) => …` right after `new BrowserWindow(t)` declares another `t`
    if (resolver().parameterListBinds(k, t.value)) return "other";
    const bound = resolver().binding(k, t.value, true);
    if (!bound) return resolver().paramAround(k, t.value) ? "other" : null;
    if (bound.kind === "value") return bound.range[0];
    return bound.kind === "pattern" ? "pattern" : "other";
  };
  /**
   * An initializer as window options: an object literal, `Object.freeze({…})` around one, or
   * `Object.assign(…)` (`assign`: `open` is the call's `(`).
   */
  const shapeAt = (init: number): { open: number; assign: boolean } | null => {
    if (is(init, "{")) return { open: init, assign: false };
    if (
      tokens[init]?.type === "ident" &&
      tokens[init]!.value === "Object" &&
      is(init + 1, ".") &&
      is(init + 3, "(")
    ) {
      const method = tokens[init + 2]?.value;
      if (method === "freeze" && is(init + 4, "{")) return { open: init + 4, assign: false };
      if (method === "assign") return { open: init + 3, assign: true };
    }
    return null;
  };
  /** The object the name at k is declared as, by scope; null when it is something else. */
  const objectAt = (k: number): { open: number; assign: boolean; decl: number } | null => {
    const decl = declOf(k);
    if (typeof decl !== "number") return null;
    const shape = shapeAt(decl);
    return shape ? { ...shape, decl } : null;
  };
  /**
   * Follows a name at k used as window options, applied at `at` (null: in place), at `level`:
   * an object of this file, or an `Object.assign(…)` of them. False when it is neither (nothing
   * is recorded then). `this.NAME` is never followed: a field of an object can be changed in
   * more ways than a reading of the file's text sees (`Object.assign(this, …)`, `Reflect.set`,
   * a computed key, an alias of a nested object, a prototype), so its settings are not known.
   */
  const followAt = (
    k: number,
    window: number | null,
    inherited: boolean,
    depth: number,
    at: number | null,
    level: ExternalBase["level"] | null,
  ): boolean => {
    if (tokens[k]?.value === "this") return false;
    const named = objectAt(k);
    if (!named) return false;
    if (named.assign) {
      if (!assignedVia(named.open, window, depth, at, level)) return false;
    } else add(named.open, window, inherited, depth + 1, at, level);
    follow(tokens[k]!.value, named.decl, window);
    return true;
  };
  /**
   * `Object.assign(target, a, b, …)` read as `{ ...a, ...b }`: each argument is a base applied at
   * its own place in the call, so a later one wins over an earlier one, as in JavaScript. Applied
   * at `at` (a spread of the name), every argument is applied there. False when the call cannot
   * be read at all.
   */
  const assignedVia = (
    open: number,
    window: number | null,
    depth: number,
    at: number | null,
    level: ExternalBase["level"] | null,
  ): boolean => {
    const plan = planOfCall(open, depth);
    if (!plan) return false;
    // What comes before an argument that cannot be read may be replaced by it, key by key: it
    // is not taken as a window's setting at all.
    const unread = plan.findLastIndex((step) => step.open === -1 && !step.external);
    for (const [index, step] of plan.entries()) {
      const place = at ?? step.at;
      for (const f of step.follows) follow(f.name, f.decl, window);
      if (index < unread) continue;
      if (step.open === -1) {
        if (!step.external || !external(-1, window, place, step.external, level))
          hide(window, place);
        continue;
      }
      add(step.open, window, true, depth + 1, place, level);
    }
    return true;
  };
  /**
   * The steps of the `Object.assign(…)` call whose `(` is at `open`: an object of this file per
   * argument, another module's base, or an argument that cannot be read (`open` -1 without
   * `external`), which may write any key at its place. Null when the call is too deep or broken.
   */
  const planOfCall = (open: number, depth: number): PlanStep[] | null => {
    if (depth > 3) return null;
    const end = close(open);
    if (end === -1) return null;
    const plan: PlanStep[] = [];
    let from = open + 1;
    while (from < end) {
      let to = from;
      for (let d = 0; to < end; to++) {
        const p = tokens[to]!;
        if (p.type !== "punct") continue;
        if (p.value === "{" || p.value === "(" || p.value === "[") d++;
        else if (p.value === "}" || p.value === ")" || p.value === "]") d--;
        else if (p.value === "," && d === 0) break;
      }
      const first = tokens[from]!;
      // Just before the argument, inside the call: every argument is then applied in the same
      // enclosing object or block, one after the other.
      const at = first.start - 1;
      const unread: PlanStep = { open: -1, at, follows: [] };
      if (is(from, "{") && close(from) === to - 1) plan.push({ open: from, at, follows: [] });
      else if (first.type === "ident" && first.value === "this") plan.push(unread);
      else if (
        first.type === "ident" &&
        to === from + 3 &&
        is(from + 1, ".") &&
        tokens[from + 2]?.type === "ident" &&
        externalOf(from)
      )
        plan.push({
          open: -1,
          at,
          follows: [],
          external: { ...externalOf(from)!, expr: first.start },
        });
      else if (first.type === "ident" && to === from + 1) {
        const named = objectAt(from);
        const follows = named ? [{ name: first.value, decl: named.decl }] : [];
        if (named && !named.assign) plan.push({ open: named.open, at, follows });
        else if (named) {
          const inner = planOfCall(named.open, depth + 1);
          plan.push(
            ...(inner
              ? inner.map((step) => ({ ...step, at, follows: [...step.follows, ...follows] }))
              : [unread]),
          );
        } else {
          // an imported name: evaluated with the other module once every module is known
          const ref = declOf(from) !== "other" ? externalOf(from) : null;
          plan.push(
            ref
              ? {
                  open: -1,
                  at,
                  follows: [{ name: first.value, decl: -1 }],
                  external: { ...ref, expr: first.start },
                }
              : unread,
          );
        }
      } else plan.push(unread);
      from = to + 1;
    }
    return plan;
  };
  /**
   * `...extra` or `new BrowserWindow(options)` where the name is a parameter of the function
   * around it: the object literals its callers pass. False when any caller passes something else.
   */
  const passedTo = (
    k: number,
    window: number | null,
    depth: number,
    at: number | null,
    level: ExternalBase["level"] | null,
  ): boolean => {
    if (declOf(k) !== "other") return false;
    const sites = resolver().argumentsFor(k);
    if (!sites?.length) return false;
    const objects: number[] = [];
    for (const site of sites) {
      if (!is(site, "{")) return false;
      const end = close(site);
      if (end === -1 || !(is(end + 1, ",") || is(end + 1, ")"))) return false;
      objects.push(site);
    }
    for (const site of objects) {
      // `webPreferences: helper({ … })` lays the argument over what the helper returns already;
      // it is the same object, and is not placed a second time.
      const start = tokens[site]!.start;
      if (ranges.some((r) => r.window === window && start >= r.start && start < r.end)) continue;
      add(site, window, true, depth + 1, at ?? start, level);
    }
    return true;
  };
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
          // `return ({ … })`
          if (
            tokens[j]!.type === "ident" &&
            tokens[j]!.value === "return" &&
            is(j + 1, "(") &&
            is(j + 2, "{")
          ) {
            returned.set(t.value, j + 2);
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
  /** The `{` right around token k inside [open, end), or -1. */
  const braceAround = (k: number, open: number): number => {
    for (let d = 0, j = k - 1; j >= open && j > k - 20_000; j--) {
      const p = tokens[j]!;
      if (p.type !== "punct") continue;
      if (p.value === "}" || p.value === ")" || p.value === "]") d++;
      else if (p.value === "{" || p.value === "(" || p.value === "[") {
        if (d === 0) return p.value === "{" ? j : -1;
        d--;
      }
    }
    return -1;
  };
  /**
   * Whether the object literal at `brace` is an argument of `webPreferences: Object.assign(…)`
   * (the call's `(` right around it).
   */
  const assignArgumentOfPrefs = (brace: number): boolean => {
    if (!is(brace - 1, "(") && !is(brace - 1, ",")) return false;
    for (let d = 0, j = brace - 1; j >= 0 && j > brace - 20_000; j--) {
      const p = tokens[j]!;
      if (p.type !== "punct") continue;
      if (p.value === "}" || p.value === ")" || p.value === "]") d++;
      else if (p.value === "{" || p.value === "(" || p.value === "[") {
        if (d > 0) {
          d--;
          continue;
        }
        return (
          p.value === "(" &&
          tokens[j - 1]?.value === "assign" &&
          is(j - 2, ".") &&
          tokens[j - 3]?.value === "Object" &&
          is(j - 4, ":") &&
          tokens[j - 5]?.value === "webPreferences"
        );
      }
    }
    return false;
  };
  /** Whether the object literal at `brace` writes the key `name` as an own key, at its top. */
  const writesOwn = (brace: number, name: string): boolean => {
    const end = close(brace);
    for (let d = 0, j = brace + 1; j < end; j++) {
      const p = tokens[j]!;
      if (p.type === "punct" && (p.value === "{" || p.value === "(" || p.value === "[")) d++;
      else if (p.type === "punct" && (p.value === "}" || p.value === ")" || p.value === "]")) d--;
      else if (
        d === 0 &&
        (p.type === "ident" || p.type === "string") &&
        p.value === name &&
        (is(j - 1, "{") || is(j - 1, ",")) &&
        (is(j + 1, ":") || (p.type === "ident" && (is(j + 1, ",") || is(j + 1, "}"))))
      )
        return true;
    }
    return false;
  };
  let work = 400_000;
  const add = (
    open: number,
    window: number | null,
    inherited = false,
    depth = 0,
    at: number | null = null,
    /** What the object is: a window's options, its webPreferences, or not known (null). */
    level: ExternalBase["level"] | null = "options",
  ): void => {
    if (ranges.length >= 2000 || work <= 0) return;
    const end = close(open);
    if (end === -1) {
      work -= 20_000;
      return;
    }
    work -= end - open;
    ranges.push({
      start: tokens[open]!.start,
      end: tokens[end]!.end,
      window,
      name: window === null ? null : (names.get(window) ?? `#${window}`),
      inherited,
      at,
    });
    if (depth >= 3) return;
    // the object itself: `{`, or the one a constructor's `(` holds
    const root = is(open, "(") && is(open + 1, "{") ? open + 1 : open;
    /** The level of an object that holds token k: this one's, a webPreferences value's, or none. */
    const levelAt = (k: number): ExternalBase["level"] | null => {
      const brace = braceAround(k, open);
      if (brace === root) return level;
      return is(brace - 1, ":") && tokens[brace - 2]?.value === "webPreferences" ? "prefs" : null;
    };
    /**
     * The window's own options, read in place: a `webPreferences` key written at their top level
     * replaces the whole object, whatever was spread into the options before it.
     */
    const own = window !== null && depth === 0 && !inherited && at === null;
    /** `webPreferences: NAME` or the shorthand `webPreferences`, with the name at n. */
    const namedPrefs = (n: number, key: number): void => {
      const before = window === null ? 0 : (hideCount.get(window) ?? 0);
      if (
        !followAt(n, window, inherited, depth, at, "prefs") &&
        !passedTo(n, window, depth, at, "prefs")
      ) {
        hide(window, EVERYWHERE); // an import, or a parameter not every caller fills in
        return;
      }
      if (!own || braceAround(key, open) !== root) return;
      // The followed object lies elsewhere in the text: what it could not read itself (a spread
      // in its declaration, an argument of a caller) is applied here, where the key is written.
      if ((hideCount.get(window!) ?? 0) > before) hide(window, tokens[key]!.start);
      else wholePrefs.set(window!, tokens[key]!.start);
    };
    // Objects that are named, spread or returned by a helper inside belong to the same window.
    for (let k = open + 1; k < end; k++) {
      const t = tokens[k]!;
      const next = tokens[k + 1];
      // A member of a window's options that may write the key `webPreferences` without the
      // reading naming it: `"webPreferences": …`, `[key]: …`, a method or an accessor. It may
      // replace every setting written before it, as an unknown spread may: a whole
      // `webPreferences` before it decides nothing. Plain `name: value`, the shorthand, a spread
      // (read below) and another quoted or numbered key do not.
      if (
        window !== null &&
        level === "options" &&
        (k - 1 === root || is(k - 1, ",")) &&
        braceAround(k, open) === root
      ) {
        const plain =
          is(k, "}") || // after a trailing comma
          is(k, "...") ||
          // `__proto__: x` sets the prototype, which never replaces an own key
          (t.type === "ident" && (is(k + 1, ":") || is(k + 1, ",") || is(k + 1, "}"))) ||
          ((t.type === "string" || t.type === "number") &&
            t.value !== "webPreferences" &&
            is(k + 1, ":"));
        if (!plain) {
          wholePrefs.delete(window);
          hide(window, at ?? t.start);
        }
      }
      // A computed key in a webPreferences object whose name is not read (`[process.env.K]:
      // false`) may write any setting, and replaces whatever the object wrote for that key
      // before it: the keys before it are not known. `["sandbox"]` and `[NI]` with NI a string
      // constant are read as the key they name. At a level decided elsewhere it may be either.
      // The same for an accessor, method or generator under such a key (`get [k]() {…}`,
      // `async [k]() {}`, `*[k]() {}`), and in an object literal that is a later argument of
      // `webPreferences: Object.assign({…}, { [k]: true })`.
      const memberStart = is(k - 1, "{") || is(k - 1, ",");
      let bracket = -1;
      if (memberStart && is(k, "[")) bracket = k;
      else if (memberStart && is(k, "*") && is(k + 1, "[")) bracket = k + 1;
      else if (
        memberStart &&
        t.type === "ident" &&
        (t.value === "get" || t.value === "set" || t.value === "async")
      ) {
        if (is(k + 1, "[")) bracket = k + 1;
        else if (is(k + 1, "*") && is(k + 2, "[")) bracket = k + 2;
      }
      if (window !== null && bracket !== -1) {
        const brace = braceAround(k, open);
        const prefsHere =
          brace === root
            ? level === "prefs" || level === null
            : brace !== -1 &&
              ((is(brace - 1, ":") && tokens[brace - 2]?.value === "webPreferences") ||
                assignArgumentOfPrefs(brace));
        const inner = tokens[bracket + 1];
        const read =
          is(bracket + 2, "]") &&
          (inner?.type === "string" || (inner?.type === "ident" && stringAt(bracket + 1) !== null));
        if (prefsHere && !read) hide(window, at ?? t.start);
      }
      // `__proto__: x` replaces no own key, but Electron reads the options by property access,
      // so a key the literal does not write is taken from x. In a window's options that matters
      // for `webPreferences` unless the literal writes its own; in a webPreferences object every
      // key it does not write may come from x, while the ones it writes stand.
      // Quoted, too: `"__proto__": x` sets the prototype as well; only `["__proto__"]` does not.
      if (
        (t.type === "ident" || t.type === "string") &&
        t.value === "__proto__" &&
        is(k + 1, ":") &&
        (is(k - 1, "{") || is(k - 1, ","))
      ) {
        const brace = braceAround(k, open);
        const kind =
          brace === root
            ? level
            : is(brace - 1, ":") && tokens[brace - 2]?.value === "webPreferences"
              ? "prefs"
              : "other";
        if (kind === "options") {
          if (!writesOwn(brace, "webPreferences")) hide(window, EVERYWHERE);
        } else if (kind === "prefs") hide(window, at ?? tokens[brace]!.start);
        else if (kind === null) hide(window, EVERYWHERE); // a level decided elsewhere
      }
      if (is(k, "...")) {
        const place = at ?? t.start;
        // `...name`, `...helper()`, `...this.name`; anything else (`...(dev ? a : b)`,
        // `...opts.prefs`), or a name that is not an object of this file, may write any key at
        // this place.
        const simple = next?.type === "ident" && !is(k + 2, ".") && !is(k + 2, "[");
        const field =
          next?.type === "ident" &&
          next.value === "this" &&
          is(k + 2, ".") &&
          tokens[k + 3]?.type === "ident" &&
          (is(k + 4, ",") || is(k + 4, "}"));
        if (simple && is(k + 2, "(")) {
          const base = returnedBy(next.value);
          if (base !== -1) add(base, window, true, depth + 1, place, levelAt(k));
          else hide(window, place);
        } else if (simple || field) {
          if (
            !followAt(k + 1, window, true, depth, place, levelAt(k)) &&
            !(simple && passedTo(k + 1, window, depth, place, levelAt(k))) &&
            !(
              simple &&
              declOf(k + 1) !== "other" &&
              external(k + 1, window, place, undefined, levelAt(k)) &&
              (follow(next.value, -1, window), true)
            )
          )
            hide(window, place);
        } else if (
          !(
            next?.type === "ident" &&
            is(k + 2, ".") &&
            (is(k + 4, ",") || is(k + 4, "}")) &&
            external(k + 1, window, place, undefined, levelAt(k))
          )
        )
          hide(window, place);
      } else if (
        t.type === "ident" &&
        t.value === "webPreferences" &&
        (is(k + 1, ",") || is(k + 1, "}")) &&
        (is(k - 1, "{") || is(k - 1, ",")) &&
        braceAround(k, open) === root
      ) {
        // the shorthand `{ webPreferences }`: the variable of that name, in scope here
        namedPrefs(k, k);
      } else if (
        t.type === "ident" &&
        t.value === "webPreferences" &&
        is(k + 1, ":") &&
        tokens[k + 2]?.type === "ident"
      ) {
        const name = tokens[k + 2]!.value;
        if (is(k + 3, ",") || is(k + 3, "}")) namedPrefs(k + 2, k);
        else if (
          name === "this" &&
          is(k + 3, ".") &&
          tokens[k + 4]?.type === "ident" &&
          (is(k + 5, ",") || is(k + 5, "}"))
        ) {
          // `webPreferences: this.prefs`, a field the class gives the object
          if (!followAt(k + 2, window, inherited, depth, at, "prefs")) hide(window, EVERYWHERE);
        } else if (is(k + 3, "(")) {
          // `webPreferences: helper({ … })`: what the helper returns is the base, its argument
          // (inside this range already) is laid over it.
          const result = returnedBy(name);
          // Applied at the very start of the argument object, so the argument's own keys,
          // which are laid over what the helper returns, come after it in the same object.
          const applied = is(k + 4, "{") ? tokens[k + 4]!.start + 1 : tokens[k + 2]!.start;
          if (result !== -1) add(result, window, true, depth + 1, at ?? applied, "prefs");
          else hide(window, EVERYWHERE);
        } else if (
          name === "Object" &&
          is(k + 3, ".") &&
          tokens[k + 4]?.type === "ident" &&
          tokens[k + 4]!.value === "assign" &&
          is(k + 5, "(")
        ) {
          // `webPreferences: Object.assign({}, BASE, { … })`: the arguments are laid over each
          // other from left to right, as `name = Object.assign(…)` is read.
          const plan = planOfCall(k + 5, depth);
          if (!plan) hide(window, EVERYWHERE);
          else {
            // An object literal argument lies inside this range already, and its keys belong to
            // its own braces. The named bases are placed into those same braces, before the
            // literal's keys when they come before it in the call and after them otherwise, so
            // the later of two writes of a key wins, as in JavaScript.
            const inside = (step: PlanStep): boolean => {
              if (step.open === -1) return false;
              const start = tokens[step.open]!.start;
              return ranges.some((r) => r.window === window && start >= r.start && start < r.end);
            };
            const literal = plan.filter(inside).at(-1);
            for (const step of plan) {
              const place = !literal
                ? step.at
                : step.at < tokens[literal.open]!.start
                  ? tokens[literal.open]!.start + 1
                  : tokens[close(literal.open)]!.start;
              for (const f of step.follows) follow(f.name, f.decl, window);
              if (step.open === -1) {
                if (
                  !step.external ||
                  window === null ||
                  !external(-1, window, at ?? place, step.external, "prefs")
                )
                  hide(window, at ?? place);
                continue;
              }
              if (inside(step)) continue;
              add(step.open, window, true, depth + 1, at ?? place, "prefs");
            }
          }
        } else hide(window, EVERYWHERE); // `webPreferences: options.prefs`, `a ? b : c`
      } else if (
        own &&
        t.type === "ident" &&
        t.value === "webPreferences" &&
        is(k + 1, ":") &&
        is(k + 2, "{") &&
        braceAround(k, open) === root
      ) {
        // `webPreferences: {…}` written in place: what it cannot read lies inside it, after this
        wholePrefs.set(window!, t.start);
      } else if (
        t.type === "ident" &&
        t.value === "webPreferences" &&
        is(k + 1, ":") &&
        !is(k + 2, "{")
      ) {
        // `webPreferences: dev ? {…} : {…}`, `webPreferences: (…)`: not an object written here
        hide(window, EVERYWHERE);
      }
    }
  };
  let count = 0;
  const names = new Map<number, string>();
  const named = new Map<string, number>();
  /** `webPreferences: {…}` objects outside any window's options, read once every window is. */
  const loose: number[] = [];
  for (let k = 0; k + 2 < tokens.length; k++) {
    const t = tokens[k]!;
    if (t.type !== "ident") continue;
    if (t.value === "new") {
      // `new BrowserWindow(`, `new electron.BrowserWindow(`, or a renamed binding of it
      const callee = windowCallee(tokens, k);
      if (!callee) continue;
      const ctor = tokens[callee.ctor]!;
      if (!WINDOW_CLASSES.has(aliases.get(callee.ctor) ?? ctor.value)) continue;
      // `c + 1` is the `(` of the arguments below
      const c = callee.open - 1;
      const window = ++count;
      // `name = new BrowserWindow(…)`, also after `const` or `this.`
      const target = is(k - 1, "=") ? tokens[k - 2] : undefined;
      if (target?.type === "ident") {
        const seen = (named.get(target.value) ?? 0) + 1;
        named.set(target.value, seen);
        names.set(window, seen === 1 ? target.value : `${target.value}#${seen}`);
      }
      const first = tokens[c + 2];
      if (
        // `new BrowserWindow(this.options)` with `options = {…}` a field of the class
        first?.type === "ident" &&
        first.value === "this" &&
        is(c + 3, ".") &&
        tokens[c + 4]?.type === "ident" &&
        is(c + 5, ")")
      ) {
        if (!followAt(c + 2, window, false, -1, null, "options")) hide(window, EVERYWHERE);
      } else if (first?.type === "ident" && is(c + 3, ")")) {
        // `new BrowserWindow(options)` with the options object declared elsewhere
        if (
          !followAt(c + 2, window, false, -1, null, "options") &&
          !passedTo(c + 2, window, 0, null, "options")
        )
          hide(window, EVERYWHERE); // an import, or a parameter not every caller fills in
      } else if (!is(c + 2, "{") && !is(c + 2, ")")) {
        // `new BrowserWindow(dev ? {…} : {…})`, `new BrowserWindow(makeOptions())`
        hide(window, EVERYWHERE);
      }
      add(c + 1, window);
    } else if (t.value === "webPreferences" && is(k + 1, ":") && is(k + 2, "{")) loose.push(k + 2);
  }
  // A `webPreferences: {…}` that is not part of a window's options; one met before the window
  // that takes it (an options object assigned in a constructor, read by a method below) is.
  for (const open of loose) {
    const start = tokens[open]!.start;
    if (!ranges.some((r) => start >= r.start && start < r.end)) add(open, null);
  }
  return {
    ranges,
    traced: new Map([...traced].map(([name, decls]) => [name, [...decls]])),
    viaName,
    opaque,
    externals,
    hides,
    wholePrefs,
    declOf,
  };
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
  channelRef?: { specifier: string; property: string; before?: string; after?: string };
  /**
   * Internal, never in the result: the value is another module's export (`property` `*`: its
   * namespace, `default`: its default export), read once modules are known (`linkBridgeValues`).
   */
  valueRef?: { specifier: string; property: string };
  /** Internal, never in the result: the member's value as tokens, for calls of other modules' wrappers. */
  body?: [number, number];
  /**
   * The member passes its first parameter on, whole, as the channel of this IPC method (a generic
   * forwarder, `invoke: (channel, ...a) => ipcRenderer.invoke(channel, ...a)`): the channels are
   * the ones page scripts pass (`ipc` rows `via: "bridge"`). See `BridgeForwarder`.
   */
  forwards?: string;
  /** For a forwarder whose body admits only these channels (`if (!LIST.includes(channel)) return`). */
  allowed?: string[];
  /** For a forwarder whose body admits only channels with this prefix (`channel.startsWith("x:")`). */
  prefix?: string;
  /** For a forwarder that uses the channel in a way that was not read as a check (`validate(channel)`). */
  guard?: "unknown";
}

/**
 * A member (or a member of a nested object literal, `ipcRenderer.sendMessage`) of an exposed
 * object that passes its first parameter on, whole and unwritten, as the channel of one IPC
 * method of ipcRenderer, read in the preload: the page's calls of `window.<api>.<path>(channel, …)`
 * are then the IPC (R1). A guard read in the body is kept: `allowed` (an array or Set of strings
 * the channel must be in), `prefix` (a `startsWith` the channel must pass), or `guard: unknown`
 * when the parameter is used otherwise as well (`validate(channel)`, a log).
 */
export interface BridgeForwarder {
  api: string;
  path: string;
  /** `ipcRenderer.invoke`, `ipcRenderer.on`, … */
  method: string;
  allowed?: string[];
  prefix?: string;
  guard?: "unknown";
  /**
   * Every check read (`allowed`, `prefix`) is the exit-first form, `if (!check) return|throw`
   * before every call. Only then does a channel the check refuses surely not reach the call when
   * the channel is also used otherwise (`guard`); a check around the call (`if (check) { … }`,
   * `check && call`, `check ? call : other`) leaves the other path, which may forward it.
   */
  exitFirst?: true;
  file: string;
  line: number;
}

/**
 * A value of this file that another file exposes (cross-module bridge objects, R3): an object
 * literal read member by member (`open`), or one member's value (`value`), under `api` and with
 * the member names prefixed by `prefix` (`auth` gives `auth.loginRequest`).
 */
export interface VirtualExposure {
  api: string;
  world: "main" | "isolated";
  prefix: string | null;
  /** The `{` of an object literal to read. */
  open?: number;
  /** One member named `prefix` whose value is the expression [from, to). */
  value?: [number, number];
  /**
   * The export of this file of that name (`default`, `*` for the namespace), found here: an
   * object literal gives its members, any other value one member named `prefix`.
   */
  export?: string;
  /** The line of the exposing call, for an entry that cannot be read. */
  line: number;
}

/**
 * A privileged object or function handed to the page as it is through contextBridge: the value
 * of an exposed member (or the whole exposed value) is `ipcRenderer`, one of its methods as a
 * reference, `shell`, the `electron` module, a Node module object (`fs`, `child_process`, …),
 * `process` or `require`. A member that wraps such a value in a function of its own is not one.
 * See docs/electron-findings.md ("Privileged objects exposed through contextBridge").
 */
export interface BridgeExposure {
  /** The key the API is exposed under: `window.<api>`. */
  api: string;
  /** The member whose value it is; null when the exposed value as a whole is the object. */
  member: string | null;
  /** What it is: `ipcRenderer`, `ipcRenderer.on`, `shell`, `electron`, `fs`, `process`, … */
  exposed: string;
  /** The value as written (shortened), e.g. `o.ipcRenderer.send` in a minified bundle. */
  evidence: string;
  world: "main" | "isolated";
  file: string;
  line: number;
  /**
   * Set when the scope of the name could not be read to the end (see `Undecided`): the row is
   * kept rather than dropped, and the limitation `bridge_exposures_undecided` names it.
   */
  undecided?: Undecided;
}

/** What one source file exposes, and whether a cap or an unclosed literal cut the reading short. */
export interface BridgeScan {
  /** For a virtual exposure of an export: the file does not define that export where it is read. */
  unfound?: true;
  /** Generic forwarders among the members, also of nested object literals (R1). */
  forwarders?: BridgeForwarder[];
  members: BridgeMember[];
  /** Members (or whole values) that are a privileged object itself, not a wrapper around it. */
  exposures: BridgeExposure[];
  truncated: boolean;
}

/** Members of the `electron` module whose object handed to a page is a privileged API. */
const PRIVILEGED_ELECTRON = new Set(["ipcRenderer", "shell"]);
/**
 * Node modules whose object handed to a page gives it file, process, network or code access.
 * Helpers that only compute or inform (`path`, `url`, `util`, `events`, `os`, …) are not listed.
 */
const PRIVILEGED_BUILTINS = new Set([
  "fs",
  "fs/promises",
  "child_process",
  "net",
  "dgram",
  "http",
  "https",
  "http2",
  "tls",
  "vm",
  "worker_threads",
  "cluster",
  "module",
  "process",
]);

/**
 * Members of a privileged Node module that only inform, so handing one to a page by reference
 * (`fs.statSync`, `process.env`) is not this observation. Every other member is reported:
 * reading every acting member of every module is not possible, so the list is of the harmless
 * ones, and a module without an entry has none. The module object itself is always reported.
 */
const HARMLESS_MEMBERS: Readonly<Partial<Record<string, RegExp>>> = {
  fs: /^(stat|statSync|lstat|lstatSync|exists|existsSync|access|accessSync|constants|realpath|realpathSync)$/,
  "fs/promises": /^(stat|lstat|access|constants|realpath)$/,
  process: /^(env|versions|platform|arch|version|pid|cwd|uptime)$/,
};

/** `electron`, a privileged Node module (without `node:`), or null for any other specifier. */
function privilegedModule(specifier: string): string | null {
  if (specifier === "electron") return "electron";
  const bare = specifier.replace(/^node:/, "");
  return PRIVILEGED_BUILTINS.has(bare) ? bare : null;
}

/** One binding's identity, as the resolver gives it. */
const idOf = (b: Binding | null): string | null => {
  if (!b) return null;
  switch (b.kind) {
    case "value":
      return `v${b.range[0]}`;
    case "pattern":
      return `p${b.from[0]}:${b.key}`;
    case "param":
      return `a${b.def.paramsAt}:${b.index}`;
    case "function":
      return `f${b.def.paramsAt}`;
    case "class":
      return `c${b.start}`;
  }
};

/**
 * Why an exposure is listed without the scope of its name read to the end: `budget`, the
 * resolver's work budget for the file ran out; `scope`, two declarations in one function (or more
 * than are kept) leave open which one is meant; `writes`, more writes of the name than are kept.
 */
export type Undecided = "budget" | "scope" | "writes";
/** What a name stands for, flagged when that rests on a part that was not decided. */
interface Meaning {
  meaning: string;
  undecided?: Undecided;
}
/** Declarations and writes kept per name for the scope reading. */
const MAX_PLACES = 200;

/**
 * What names of one file stand for, as far as privileged objects go: `electron`, `ipcRenderer`,
 * `shell` or a Node module (`fs`). Read from declarations on the token stream:
 * `x = require("electron")`, `x = __toESM(require("fs"))`, `{ ipcRenderer: r } = require(…)`,
 * `import { shell as s } from "electron"`, `import * as fs from "fs"`, `y = x.ipcRenderer` and
 * `y = x`. Which declaration a use means is read by scope (`ExpressionResolver.binding`): a local
 * or parameter of the same name elsewhere changes nothing, and a write counts only where it
 * resolves to the same binding. Where the scope cannot be read, only a name the file declares
 * once is taken. `declared` holds every name declared at all, so `process` and `require` are taken
 * as the globals only where the file declares (or writes) no such name.
 */
function privilegedBindings(
  tokens: Token[],
  resolver: () => ExpressionResolver,
): {
  /** What the name at token `at` stands for there, by scope; null when it is nothing privileged. */
  meaningAt: (name: string, at: number) => Meaning | null;
  declared: Map<string, number>;
} {
  const is = (i: number, value: string): boolean =>
    tokens[i]?.type === "punct" && tokens[i]!.value === value;
  const ident = (i: number): string | null =>
    tokens[i]?.type === "ident" ? tokens[i]!.value : null;
  const declared = new Map<string, number>();
  /** Where each name is declared (its token), for the scope reading below. */
  const declaredAt = new Map<string, number[]>();
  /**
   * Declarations by `const` or `let`, visible only in their block; `pattern` for a name of a
   * destructuring pattern, whose own `{` is no block.
   */
  const blockScoped = new Map<number, "name" | "pattern">();
  /**
   * Declarations in token order, recorded during the walk and kept below only for the names that
   * can matter (`relevant`): a bundle declares hundreds of thousands of names, and keeping places
   * for every one of them was most of the cost of this reading.
   */
  const events: Array<string | number | false> = [];
  const count = (name: string, at: number, block: false | "name" | "pattern" = false): void => {
    events.push(name, at, block);
  };
  const keep = (name: string, at: number, block: false | "name" | "pattern"): void => {
    if (block) blockScoped.set(at, block);
    declared.set(name, (declared.get(name) ?? 0) + 1);
    const places = declaredAt.get(name) ?? [];
    if (places.length < MAX_PLACES) places.push(at);
    declaredAt.set(name, places);
  };
  /** `require("S")` at i: the privileged meaning of S and the token after `)`; else null. */
  const requireAt = (i: number): { meaning: string | null; next: number } | null =>
    ident(i) === "require" && is(i + 1, "(") && tokens[i + 2]?.type === "string" && is(i + 3, ")")
      ? { meaning: privilegedModule(tokens[i + 2]!.value), next: i + 4 }
      : null;
  /** The right-hand side at i: a module, a wrapped module, a name, or a member of one. */
  type Rhs = { kind: "module"; meaning: string | null } | { kind: "path"; path: string[] };
  const rhsAt = (i: number): Rhs | null => {
    const direct = requireAt(i);
    if (direct) {
      if (is(direct.next, ".") && ident(direct.next + 1) && !is(direct.next + 2, ".")) {
        const member = ident(direct.next + 1)!;
        return {
          kind: "module",
          meaning: direct.meaning === "electron" && PRIVILEGED_ELECTRON.has(member) ? member : null,
        };
      }
      return { kind: "module", meaning: direct.meaning };
    }
    // `__toESM(require("fs"))`, `l(require("fs"))`, as bundlers write a default import
    if (ident(i) && is(i + 1, "(")) {
      const inner = requireAt(i + 2);
      if (inner && (is(inner.next, ")") || (is(inner.next, ",") && is(inner.next + 2, ")"))))
        return { kind: "module", meaning: inner.meaning };
      return null;
    }
    const path: string[] = [];
    let k = i;
    while (ident(k) && path.length < 3) {
      path.push(ident(k)!);
      if (!is(k + 1, ".")) break;
      k += 2;
    }
    return path.length ? { kind: "path", path } : null;
  };
  /** `name = rhs` declarations: the name's token and where the initializer starts. */
  const simple: Array<{ name: string; at: number; init: number; rhs: Rhs }> = [];
  const patterns: Array<{ entries: Array<[string, string, number]>; init: number; rhs: Rhs }> = [];
  const imports: Array<[string, string, number]> = [];
  for (let k = 0; k + 2 < tokens.length; k++) {
    const t = tokens[k]!;
    const declares =
      (t.type === "ident" && (t.value === "const" || t.value === "let" || t.value === "var")) ||
      (t.type === "punct" && t.value === ",");
    if (t.type === "ident" && (t.value === "function" || t.value === "class") && ident(k + 1))
      count(ident(k + 1)!, k + 1);
    if (t.type === "ident" && t.value === "import") {
      // import X from "S" | import * as X from "S" | import X, { a, b as c } from "S" | import { … }
      let j = k + 1;
      const local: Array<[string, string | null, number]> = [];
      if (ident(j) && ident(j) !== "from" && !is(j, "*") && !is(j, "{")) {
        local.push([ident(j)!, null, j]);
        j++;
        if (is(j, ",")) j++;
      }
      if (is(j, "*") && ident(j + 1) === "as" && ident(j + 2)) {
        local.push([ident(j + 2)!, null, j + 2]);
        j += 3;
      } else if (is(j, "{")) {
        for (j++; j < tokens.length && j < k + 4000 && !is(j, "}"); j++) {
          const name = ident(j);
          if (!name) continue;
          if (ident(j + 1) === "as" && ident(j + 2)) {
            local.push([ident(j + 2)!, name, j + 2]);
            j += 2;
          } else local.push([name, name, j]);
        }
        j++;
      }
      if (ident(j) === "from" && tokens[j + 1]?.type === "string") {
        const spec = privilegedModule(tokens[j + 1]!.value);
        for (const [name, member, at] of local) {
          count(name, at);
          if (!spec) continue;
          if (member === null) imports.push([name, spec, at]);
          else if (spec === "electron" && PRIVILEGED_ELECTRON.has(member))
            imports.push([name, member, at]);
        }
      }
      continue;
    }
    // A loop variable (`for (const ipcRenderer of …)`) is not counted here: it binds only inside
    // its loop, which the scope check where the value is written reads.
    if (!declares) continue;
    // `let ipcRenderer;`: a declaration without a value (after the keyword only; after a comma
    // the same shape is an argument list)
    if (t.type === "ident" && ident(k + 1) && (is(k + 2, ";") || is(k + 2, ","))) {
      count(ident(k + 1)!, k + 1, (t.value === "const" || t.value === "let") && "name");
      continue;
    }
    if (ident(k + 1) && is(k + 2, "=") && !is(k + 3, "=")) {
      count(ident(k + 1)!, k + 1, (t.value === "const" || t.value === "let") && "name");
      const rhs = rhsAt(k + 3);
      if (rhs) simple.push({ name: ident(k + 1)!, at: k + 1, init: k + 3, rhs });
      continue;
    }
    if (!is(k + 1, "{")) continue;
    // `{ ipcRenderer, shell: s } = …`: one level of a destructuring pattern
    const entries: Array<[string, string, number]> = [];
    let j = k + 2;
    let d = 0;
    // as long as a real pattern gets: an `electron` pattern cut short would drop its names
    for (; j < tokens.length && j < k + 4000; j++) {
      if (is(j, "{") || is(j, "[") || is(j, "(")) d++;
      else if (is(j, "}") || is(j, "]") || is(j, ")")) {
        if (d === 0) break;
        d--;
      } else if (d === 0 && ident(j) && (is(j - 1, "{") || is(j - 1, ","))) {
        const key = ident(j)!;
        if (is(j + 1, ":") && ident(j + 2)) {
          entries.push([key, ident(j + 2)!, j + 2]);
          j += 2;
        } else entries.push([key, key, j]);
      }
    }
    // only a pattern that is assigned declares: `f("api", { ipc: r })` is an object argument
    if (!is(j, "}") || !is(j + 1, "=") || is(j + 2, "=")) continue;
    for (const [, local, at] of entries)
      count(local, at, (t.value === "const" || t.value === "let") && "pattern");
    const rhs = rhsAt(j + 2);
    if (rhs) patterns.push({ entries, init: j + 2, rhs });
  }
  // The names whose declarations and writes can be asked for below: `process` and `require`
  // (their `declared` entries), and every name the rounds further down could record as privileged,
  // read here by name alone (no scope), in the same order and for as many rounds, so it holds every
  // name those rounds record. Declarations and writes of all other names are never asked for.
  const relevant = new Set<string>(["process", "require"]);
  for (const [name] of imports) relevant.add(name);
  const from = (rhs: Rhs): boolean =>
    rhs.kind === "module" ? rhs.meaning !== null : relevant.has(rhs.path[0]!);
  for (let round = 0; round < 8; round++) {
    let grew = false;
    for (const { name, rhs } of simple)
      if (!relevant.has(name) && from(rhs)) {
        relevant.add(name);
        grew = true;
      }
    for (const { entries, rhs } of patterns) {
      if (!from(rhs)) continue;
      for (const [key, local] of entries)
        if (PRIVILEGED_ELECTRON.has(key) && !relevant.has(local)) {
          relevant.add(local);
          grew = true;
        }
    }
    if (!grew) break;
  }
  for (let e = 0; e < events.length; e += 3)
    if (relevant.has(events[e] as string))
      keep(
        events[e] as string,
        events[e + 1] as number,
        events[e + 2] as false | "name" | "pattern",
      );
  // Every write of a name: `r = …`, `r ||= …`, `r++`. A write counts against a declaration only
  // where it resolves to the same binding (below), so a local of that name elsewhere is no write.
  const writes = new Map<string, number[]>();
  // With the file's identifier index already built, only the places of the relevant names are
  // visited, in token order (the tokens the walk would stop at); else, or for names used too
  // often, the walk.
  const index = builtIdentifierIndex(tokens);
  let visit: number[] | null = null;
  if (index) {
    visit = [];
    for (const name of relevant) for (const k of index.get(name) ?? []) visit.push(k);
    if (visit.length > tokens.length >> 4) visit = null;
    else visit.sort((a, b) => a - b);
  }
  for (let i = 0; visit ? i < visit.length : i + 1 < tokens.length; i++) {
    const k = visit ? visit[i]! : i;
    if (k + 1 >= tokens.length) continue;
    const t = tokens[k]!;
    if (t.type !== "ident") continue;
    const next = tokens[k + 1]!;
    // the shape of a write first, the name only then
    const written =
      (next.type === "punct" && ASSIGNMENT_OPERATORS.has(next.value)) ||
      is(k - 1, "++") ||
      is(k - 1, "--") ||
      is(k + 1, "++") ||
      is(k + 1, "--") ||
      writesName(tokens, k);
    if (!written || !relevant.has(t.value) || is(k - 1, ".") || is(k - 1, "?.")) continue;
    const places = writes.get(t.value) ?? [];
    if (places.length < MAX_PLACES) places.push(k);
    writes.set(t.value, places);
  }
  /** Privileged declarations per name: the name's token and what it stands for. */
  /** `id`: the binding the resolver gives the declaration (`idOf`), known from its shape. */
  const privileged = new Map<string, Array<{ at: number; id?: string } & Meaning>>();
  const recorded = new Set<number>();
  /** Answers per binding; cleared whenever a declaration is recorded, as an answer may change. */
  const byBinding = new Map<string, Meaning | null>();
  const add = (name: string, at: number, m: Meaning, id?: string): boolean => {
    if (recorded.has(at)) return false;
    recorded.add(at);
    const decls = privileged.get(name) ?? [];
    decls.push({
      meaning: m.meaning,
      ...(m.undecided ? { undecided: m.undecided } : {}),
      at,
      ...(id ? { id } : {}),
    });
    privileged.set(name, decls);
    byBinding.clear();
    return true;
  };
  for (const [name, m, at] of imports) add(name, at, { meaning: m });
  const ids = new Map<string, string | null>();
  /**
   * Where the scope cannot be read to the end, the exposure is kept and flagged, never dropped:
   * the token rule (the name's privileged declarations; several of different meaning are named
   * together).
   */
  const undecided = (decls: Array<{ at: number } & Meaning>, why: Undecided): Meaning => ({
    meaning: [...new Set(decls.map((d) => d.meaning))].toSorted().join(" or "),
    undecided: why,
  });
  /** One answer, flagged when it rests on a part that was not decided. */
  const flag = (m: Meaning, why: Undecided | undefined): Meaning => {
    const undecidedWhy = m.undecided ?? why;
    return undecidedWhy ? { meaning: m.meaning, undecided: undecidedWhy } : { meaning: m.meaning };
  };
  /**
   * Read by blocks and functions where the resolver does not bind the name (its own reading of the top
   * level gave up, e.g. over a name used thousands of times): the declaration a position sees is
   * the one of the innermost function around it that declares the name.
   */
  /** The scope of a declaration depends only on its position: read once (a walk of up to 50,000 tokens). */
  const scopes = new Map<number, [number, number]>();
  const byFunctions = (
    name: string,
    decls: Array<{ at: number } & Meaning>,
    at: number,
    r: ExpressionResolver,
  ): Meaning | null => {
    const all = declaredAt.get(name) ?? [];
    const capped = all.length >= MAX_PLACES;
    /**
     * Where the declaration at p is visible: its block for `const`/`let` (the innermost `{` open
     * around it: a declaration cannot stand in an object literal), else its function.
     */
    const scopeOf = (p: number): [number, number] => {
      let known = scopes.get(p);
      if (!known) scopes.set(p, (known = readScope(p)));
      return known;
    };
    const readScope = (p: number): [number, number] => {
      const kind = blockScoped.get(p);
      if (kind) {
        let skip = kind === "pattern";
        for (let j = p - 1, d = 0; j >= 0 && j > p - 50_000; j--) {
          const t = tokens[j]!;
          if (t.type !== "punct") continue;
          if (t.value === "}" || t.value === ")" || t.value === "]") d++;
          // an open `(` around it (`for (let i …)`) is passed: the block decides
          else if (t.value === "(" || t.value === "[") d = Math.max(0, d - 1);
          else if (t.value === "{") {
            if (d > 0) d--;
            else if (skip) skip = false;
            else {
              const close = r.closeOf(j);
              return [j, close < 0 ? tokens.length : close];
            }
          }
        }
      }
      const f = r.functionAt(p);
      return f ? [f.body[0], f.body[1]] : [-1, tokens.length];
    };
    /** The declaration visible at pos, or "tie" when two in one scope leave it open. */
    const visible = (pos: number): number | "tie" => {
      let depth = -2;
      let found: number | "tie" = -1;
      for (const p of all) {
        const [start, end] = scopeOf(p);
        if (!(start <= pos && pos <= end)) continue;
        if (start > depth) [depth, found] = [start, p];
        else if (start === depth) found = "tie";
      }
      return found;
    };
    const seen = visible(at);
    if (seen === "tie" || capped) return undecided(decls, "scope");
    const decl = decls.find((d) => d.at === seen);
    if (!decl) return null;
    let why: Undecided | undefined =
      (writes.get(name) ?? []).length >= MAX_PLACES ? "writes" : undefined;
    for (const w of writes.get(name) ?? []) {
      if (w === decl.at || r.paramAround(w, name)) continue;
      const v = visible(w);
      if (v === "tie") why ??= "scope";
      else if (v === decl.at) return null;
    }
    return flag(decl, why);
  };
  const meaningAt = (name: string, at: number): Meaning | null => {
    const decls = privileged.get(name);
    if (!decls) return null;
    const r = resolver();
    const bound = r.binding(at, name, true);
    // used up: a null is no answer, and the exposure is kept
    if (!bound && r.exhausted()) return undecided(decls, "budget");
    const here = idOf(bound);
    if (here === null) return byFunctions(name, decls, at, r);
    // the same binding gives the same answer at every use: read once
    const key = `${name}\u0000${here}`;
    const known = byBinding.get(key);
    if (known !== undefined) return known;
    let budget = false;
    const idAt = (pos: number): string | null => {
      const k = `${name}\u0000${pos}`;
      if (!ids.has(k)) {
        const b = r.binding(pos, name, true);
        if (!b && r.exhausted()) {
          budget = true;
          return null;
        }
        ids.set(k, idOf(b));
      }
      return ids.get(k)!;
    };
    const match = decls.find((d) => d.id === here || (d.id === undefined && idAt(d.at) === here));
    let answer: Meaning | null;
    if (!match) {
      // The use is bound to a declaration of known shape that is none of these: decided. Only a
      // declaration whose binding is not known (an import) may still be the one meant.
      const open = decls.some((d) => d.id === undefined && idAt(d.at) === null);
      answer = budget ? undecided(decls, "budget") : open ? byFunctions(name, decls, at, r) : null;
    } else {
      // Written again where the same binding is meant (`let r = ipcRenderer; r = {…}`): it may
      // be anything where it is used. A write that resolves to no binding is not counted; one
      // the budget left unread keeps the exposure, flagged.
      let why: Undecided | undefined =
        (writes.get(name) ?? []).length >= MAX_PLACES ? "writes" : undefined;
      answer = match;
      for (const w of writes.get(name) ?? []) {
        if (w === match.at) continue;
        const id = idAt(w);
        if (id === here) {
          answer = null;
          break;
        }
        if (budget) why ??= "budget";
      }
      if (answer) answer = flag(answer, why);
    }
    byBinding.set(key, answer);
    return answer;
  };
  const ofPath = (path: string[], at: number): Meaning | null => {
    const base = meaningAt(path[0]!, at);
    if (!base) return null;
    // `__toESM(require("fs")).default`, `import_electron.default`: the module itself
    const rest = path[1] === "default" ? path.slice(2) : path.slice(1);
    if (rest.length === 0) return base;
    if (rest.length === 1 && base.meaning === "electron" && PRIVILEGED_ELECTRON.has(rest[0]!))
      return flag({ meaning: rest[0]! }, base.undecided);
    return null;
  };
  // Rounds up to a fixed point: `const ipc = r` after `{ ipcRenderer: r } = require("electron")`.
  for (let round = 0; round < 8; round++) {
    let grew = false;
    const set = (name: string, at: number, m: Meaning | null, id: string): void => {
      if (m && add(name, at, m, id)) grew = true;
    };
    for (const { name, at, init, rhs } of simple)
      set(
        name,
        at,
        rhs.kind === "module"
          ? rhs.meaning
            ? { meaning: rhs.meaning }
            : null
          : ofPath(rhs.path, init),
        `v${init}`,
      );
    for (const { entries, init, rhs } of patterns) {
      const source =
        rhs.kind === "module"
          ? rhs.meaning
            ? { meaning: rhs.meaning }
            : null
          : ofPath(rhs.path, init);
      if (source?.meaning !== "electron") continue;
      for (const [key, local, at] of entries)
        if (PRIVILEGED_ELECTRON.has(key))
          set(local, at, flag({ meaning: key }, source.undecided), `p${init}:${key}`);
    }
    if (!grew) break;
  }
  // `process = …` or `require = …` anywhere: then no longer the global
  for (const name of ["process", "require"])
    if (writes.has(name)) declared.set(name, Math.max(2, declared.get(name) ?? 0));
  return { meaningAt, declared };
}

/** One key per binding (see `ExpressionResolver.binding`): equal keys are the same binding. */
const bindingKey = (b: Binding): string =>
  b.kind === "param"
    ? `p${b.def.paramsAt}:${b.index}`
    : b.kind === "value"
      ? `v${b.range[0]}`
      : b.kind === "function"
        ? `f${b.def.paramsAt}`
        : b.kind === "class"
          ? `c${b.start}`
          : `o${b.from[0]}:${b.key}`;

const MAX_BRIDGE_PER_FILE = 500;
const MAX_BRIDGE = 2000;
/** Tokens walked inside exposed objects per file; keeps repeated or unclosed calls linear. */
const BRIDGE_WALK_BUDGET = 400_000;
/** Charged per `api[…]` occurrence of a step-by-step object, before anything is read for it. */
/** Array methods that call their callback before they return. */
const SYNC_CALLBACKS: ReadonlySet<string> = new Set([
  "forEach",
  "map",
  "filter",
  "find",
  "findIndex",
  "findLast",
  "findLastIndex",
  "some",
  "every",
  "reduce",
  "reduceRight",
  "flatMap",
]);
const BRIDGE_STEP_COST = 8;
/** Charged per `api[k] = …` whose scope and loop rounds are read. */
const BRIDGE_ROUND_COST = 2000;
/** ipcRenderer methods that take a listener off a channel: no IPC of their own in a forwarder. */
const REMOVE_METHODS: ReadonlySet<string> = new Set([
  "removeListener",
  "off",
  "removeAllListeners",
]);
/** Tokens of a member's value kept for calls of other modules' wrappers (`BridgeMember.body`). */
const MAX_BODY_TOKENS = 4000;
/** Calls that only read the object handed to them (`Object.freeze(api)`, `JSON.stringify(api)`). */
const READ_ONLY_CALLS: ReadonlySet<string> = new Set([
  "freeze",
  "isFrozen",
  "keys",
  "values",
  "entries",
  "stringify",
  "String",
  "Boolean",
  "log",
  "warn",
  "error",
  "info",
  "debug",
]);
/** `auth` and `loginRequest` give `auth.loginRequest`. */
const qualify = (prefix: string | null, name: string): string =>
  prefix === null ? name : `${prefix}.${name}`;
/** Helpers bundlers wrap a `require` in; the module object stays what it is. */
const REQUIRE_INTEROP = new Set([
  "__toESM",
  "__importStar",
  "__importDefault",
  "_interopRequireWildcard",
  "_interopRequireDefault",
]);
/** Charged per `api.x = …` that is read as a member (a write to another binding is not). */
const BRIDGE_SCOPE_COST = 8;
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
  /** Values of this file exposed by another one: read instead of the file's own exposures. */
  virtuals?: readonly VirtualExposure[],
): BridgeScan {
  const { tokens, truncated: cut } = typeof source === "string" ? tokenize(source) : source;
  const context: ScanContext =
    typeof source !== "string" && source.context
      ? source.context
      : (() => {
          const constants = new Constants(tokens);
          let resolver: ExpressionResolver | null = null;
          constants.useEvaluator(
            evaluatorFor(
              tokens,
              constants,
              () => resolver,
              (r) => (resolver = r),
            ),
          );
          return { aliases: resolveAliases(tokens, ALIAS_TARGETS), constants, wrappers: new Map() };
        })();
  const members: BridgeMember[] = [];
  const forwarders: BridgeForwarder[] = [];
  let truncated = cut;
  let unfound = false;
  let budget = BRIDGE_WALK_BUDGET;
  const is = (i: number, value: string): boolean =>
    tokens[i]?.type === "punct" && tokens[i]!.value === value;
  /** Exposures (name and call) whose earlier `name.member = …` assignments were collected. */
  const stepwise = new Set<string>();
  let resolver: ExpressionResolver | null = null;
  /**
   * The channel a plain name or table entry (`BOARD.list`) at k stands for when the file's
   * constants cannot say, read by the bounded resolver: a table a bundled module exports, or one a
   * registry function builds. One value or nothing; parameters and other expressions are not read.
   */
  const nameValue = (k: number): { value: string; via: "evaluated" } | null => {
    let end = k;
    if (tokens[end]?.type !== "ident") return null;
    while (is(end + 1, ".") && tokens[end + 2]?.type === "ident" && end < k + 8) end += 2;
    if (!is(end + 1, ",") && !is(end + 1, ")")) return null;
    if (budget <= 0) return null;
    resolver ??= new ExpressionResolver(tokens, context.constants);
    const found = resolver.resolveArgument(k);
    if (!found || found.partial || found.values.length !== 1) return null;
    if (found.method === "parameter" || found.method === "element") return null;
    return { value: found.values[0]!, via: "evaluated" };
  };
  /** The tokens [from, to) are `ipcRenderer` as such: another name for it, or `x.ipcRenderer`. */
  const isRenderer = (from: number, to: number): boolean => {
    if (to <= from || to - from > 9 || tokens[to - 1]?.type !== "ident") return false;
    for (let j = from; j < to - 1; j += 2)
      if (tokens[j]?.type !== "ident" || !is(j + 1, ".")) return false;
    return (context.aliases.get(to - 1) ?? tokens[to - 1]!.value) === "ipcRenderer";
  };
  /**
   * The members of an object the expression at k builds (`Object.fromEntries(…)`, a call of a
   * function of the file that returns one), read by the bounded resolver: only when it is read
   * whole and each member is a function whose body is one call of an ipcRenderer method (see
   * `ExpressionResolver.forwardingMembers`). Null otherwise.
   */
  const forwarded = (k: number): Array<{ member: string; channel: string | null }> | null => {
    if (budget <= 0) return null;
    resolver ??= new ExpressionResolver(tokens, context.constants);
    budget -= 2000;
    const found = resolver.forwardingMembers(k, isRenderer, CHANNEL_CALLS);
    return found
      ? found.map((f) => ({
          member: f.member,
          channel: f.channels?.length === 1 ? f.channels[0]! : null,
        }))
      : null;
  };
  let objects: Map<string, number> | null = null;
  const objectOf = (name: string): number => {
    if (!objects) {
      objects = new Map();
      // `const api = {`, and in a declaration list (as minifiers write it) `, api = {`. A name
      // declared more than once in the file (any value; minifiers reuse short names in every
      // function) is not followed: which of them the call sees is not decided here.
      const declared = new Map<string, number>();
      for (let k = 0; k + 3 < tokens.length; k++) {
        const t = tokens[k]!;
        const declares =
          (t.type === "ident" && (t.value === "const" || t.value === "let" || t.value === "var")) ||
          (t.type === "punct" && t.value === ",");
        if (!declares) continue;
        const id = tokens[k + 1]!;
        if (id.type !== "ident" || !is(k + 2, "=")) continue;
        declared.set(id.value, (declared.get(id.value) ?? 0) + 1);
        if (is(k + 3, "{") && !objects.has(id.value)) objects.set(id.value, k + 3);
      }
      for (const [id, count] of declared) if (count > 1) objects.delete(id);
    }
    return objects.get(name) ?? -1;
  };
  /** `import X from "s"` (default) and `import * as X from "s"` (namespace) of this file, by name. */
  let importForms: Map<string, { specifier: string; property: string; at: number } | null> | null =
    null;
  const importFormOf = (
    name: string,
  ): { specifier: string; property: string; at: number } | null => {
    if (!importForms) {
      importForms = new Map();
      for (let k = 0; k + 3 < tokens.length; k++) {
        if (tokens[k]!.type !== "ident" || tokens[k]!.value !== "import") continue;
        let j = k + 1;
        const add = (at: number, property: string): void => {
          const n = tokens[at]!.value;
          importForms!.set(n, importForms!.has(n) ? null : { specifier: "", property, at });
        };
        const found: Array<[number, string]> = [];
        if (tokens[j]?.type === "ident" && tokens[j]!.value !== "type") {
          found.push([j, "default"]);
          j++;
          if (is(j, ",")) j++;
        }
        if (is(j, "*") && tokens[j + 1]?.value === "as" && tokens[j + 2]?.type === "ident") {
          found.push([j + 2, "*"]);
          j += 3;
        }
        if (!found.length || tokens[j]?.value !== "from" || tokens[j + 1]?.type !== "string")
          continue;
        const specifier = tokens[j + 1]!.value;
        for (const [at, property] of found) {
          add(at, property);
          const v = importForms.get(tokens[at]!.value);
          if (v) v.specifier = specifier;
        }
      }
    }
    return importForms.get(name) ?? null;
  };
  let requires: boolean | null = null;
  /** Whether the file calls `require` at all (else no name of it can hold a required module). */
  const hasRequire = (): boolean =>
    (requires ??= tokens.some((x) => x.type === "ident" && x.value === "require"));
  /** The specifier of `require("s")` (or a bundler's interop around it) in [a, b), or null. */
  const requireIn = (a: number, b: number): string | null => {
    let x = a;
    let y = b;
    if (tokens[x]?.type === "ident" && REQUIRE_INTEROP.has(tokens[x]!.value) && is(x + 1, "(")) {
      const close = (resolver ??= new ExpressionResolver(tokens, context.constants)).closeOf(x + 1);
      if (close !== y - 1) return null;
      x += 2;
      // `__toESM(require("x"), 1)`
      y = is(close - 2, ",") && tokens[close - 1]?.type === "number" ? close - 2 : close;
    }
    return tokens[x]?.value === "require" &&
      is(x + 1, "(") &&
      tokens[x + 2]?.type === "string" &&
      is(x + 3, ")") &&
      x + 4 === y
      ? tokens[x + 2]!.value
      : null;
  };
  /** Whether a name (at any of its positions in the file) is written, or its members are. */
  const writtenNames = new Map<string, boolean>();
  const writtenAnywhere = (name: string): boolean => {
    const known = writtenNames.get(name);
    if (known !== undefined) return known;
    resolver ??= new ExpressionResolver(tokens, context.constants);
    const sites = resolver.namePositions(name);
    budget -= sites.length * BRIDGE_SCOPE_COST;
    const written = sites.some(
      (j) =>
        !is(j - 1, ".") &&
        (writesName(tokens, j) || writesMember(tokens, j) !== null || writtenByCallAt(tokens, j)),
    );
    writtenNames.set(name, written);
    return written;
  };
  /**
   * The value at k is another module's export: `X` with `import { X }`, `import X` (default) or
   * `import * as X` (namespace); `X` with `const X = require("s")` (its exports); `X.P` and
   * `X.default` on such a module object, as tsc and esbuild write an import. Null for anything
   * else, also for a name that a parameter or local binds where it is used, or that is written.
   */
  const moduleValueRef = (k: number): { specifier: string; property: string } | null => {
    const t = tokens[k];
    if (t?.type !== "ident" || is(k - 1, ".") || budget <= 0) return null;
    const ends = (j: number): boolean => is(j, ")") || is(j, ",") || is(j, "}") || is(j, ";");
    const member =
      is(k + 1, ".") && tokens[k + 2]?.type === "ident" && ends(k + 3)
        ? tokens[k + 2]!.value
        : null;
    if (member === null && !ends(k + 1)) return null;
    // the cheap tables first: most names are no import of a module of the application
    const named = context.constants.importOf(t.value, k);
    const form = named ? null : importFormOf(t.value);
    const required = named || form ? null : context.constants.requireOf(t.value, k);
    // a package's or another unread module's value is followed too, to be named as not read
    // (#235); electron and Node's built-ins hold no member that passes a channel on
    if (named && !bridgeValueSource(named.specifier)) return null;
    if (form && !bridgeValueSource(form.specifier)) return null;
    if (required !== null && !bridgeValueSource(required)) return null;
    // `const x_1 = __importDefault(require("./x"))` (tsc) is read from the declaration
    if (!named && !form && required === null && !hasRequire()) return null;
    resolver ??= new ExpressionResolver(tokens, context.constants);
    const r = resolver;
    if (r.paramAround(k, t.value)) return null;
    const bound = r.binding(k, t.value);
    let base: { specifier: string; property: string } | null = null;
    if (bound) {
      if (bound.kind !== "value") return null;
      const spec = requireIn(bound.range[0], bound.range[1]);
      if (spec === null) return null;
      base = { specifier: spec, property: "*" };
    } else {
      if (r.boundAround(k, t.value)?.kind === "param") return null;
      base = named ?? (form?.specifier ? form : null);
      // `const X = require("s")` that the resolver does not bind (declared in a list)
      if (base === null && required !== null) base = { specifier: required, property: "*" };
      if (base === null) return null;
      if (writtenAnywhere(t.value)) return null;
    }
    if (!bridgeValueSource(base.specifier)) return null;
    if (member === null) return { specifier: base.specifier, property: base.property };
    // a member of a module object: the export of that name
    return base.property === "*" ? { specifier: base.specifier, property: member } : null;
  };
  /**
   * What the name at k holds in this file: a `const` object literal nothing writes (its `{`), or
   * the tokens of a function or of a value (`makeInvoker("x")`). Null for a parameter, a pattern,
   * a class, a name written after its declaration, or none.
   */
  const localValue = (k: number): { object?: number; from: number; to: number } | null => {
    const t = tokens[k];
    if (t?.type !== "ident" || budget <= 0) return null;
    resolver ??= new ExpressionResolver(tokens, context.constants);
    const r = resolver;
    const bound = r.binding(k, t.value);
    if (!bound) return null;
    if (bound.kind === "function") return { from: bound.def.paramsAt, to: bound.def.body[1] };
    if (bound.kind !== "value") return null;
    const [a, b] = bound.range;
    let open = -1;
    if (is(a, "{") && r.closeOf(a) === b - 1) open = a;
    else if (
      tokens[a]?.value === "Object" &&
      is(a + 1, ".") &&
      tokens[a + 2]?.value === "freeze" &&
      is(a + 3, "(") &&
      is(a + 4, "{") &&
      r.closeOf(a + 4) === b - 2
    )
      open = a + 4;
    if (open === -1) return { from: a, to: b };
    // an object some code changes, directly or through another name or a call, is not read as written
    return writtenAnywhere(t.value) || escapes(t.value, 0)
      ? null
      : { object: open, from: a, to: b };
  };
  /**
   * The getters esbuild's `__export(target, { k: () => v })` defines on an empty object, as it writes
   * `import * as NS`: each getter's name and value. Null when the name is no such target;
   * `unknown` when it is used in some other way that may add members (another call, a write).
   */
  const exportGetters = (
    name: string,
  ): Array<{ name: string; value: [number, number]; line: number }> | "unknown" | null => {
    resolver ??= new ExpressionResolver(tokens, context.constants);
    const r = resolver;
    let found: Array<{ name: string; value: [number, number]; line: number }> | null = null;
    for (const j of r.namePositions(name)) {
      if (is(j - 1, ".") || declaredHere(tokens, j)) continue;
      if (writesName(tokens, j) || writesMember(tokens, j) !== null || writtenByCallAt(tokens, j))
        return "unknown";
      const arg = (is(j - 1, "(") || is(j - 1, ",")) && (is(j + 1, ",") || is(j + 1, ")"));
      if (!arg) continue;
      // `__export(name, { … })`: the helper defines a getter per key (`get: all[name]`)
      const helper = is(j - 1, "(") && tokens[j - 2]?.type === "ident" ? j - 2 : -1;
      if (helper === -1 || !is(j + 1, ",") || !is(j + 2, "{") || found) return "unknown";
      const def = r.binding(helper, tokens[helper]!.value);
      const range =
        def?.kind === "value"
          ? def.range
          : def?.kind === "function"
            ? ([def.def.paramsAt, def.def.body[1]] as [number, number])
            : null;
      if (!range || range[1] - range[0] > 80) return "unknown";
      let getter = false;
      for (let q = range[0]; q + 3 < range[1]; q++)
        if (tokens[q]!.value === "get" && is(q + 1, ":") && is(q + 3, "[")) getter = true;
      if (!getter) return "unknown";
      const close = r.closeOf(j + 2);
      if (close === -1) return "unknown";
      found = [];
      for (let q = j + 3; q < close;) {
        // `k: () => v,`
        const key = tokens[q];
        if (
          !(key?.type === "ident" || key?.type === "string") ||
          !is(q + 1, ":") ||
          !is(q + 2, "(") ||
          !is(q + 3, ")") ||
          !is(q + 4, "=>")
        )
          return "unknown";
        let e = q + 5;
        for (let d = 0; e < close; e++) {
          if (is(e, "(") || is(e, "[") || is(e, "{")) d++;
          else if (is(e, ")") || is(e, "]") || is(e, "}")) d--;
          else if (d === 0 && is(e, ",")) break;
        }
        found.push({ name: key.value, value: [q + 5, e], line: key.line });
        q = e + 1;
      }
    }
    return found;
  };
  /**
   * The object literal a function of the file returns, when it has one return and that is
   * `return {…}` as its last statement (or `=> ({…})`): its `{`. -1 otherwise.
   */
  const returnedObject = (k: number): number => {
    const t = tokens[k];
    if (t?.type !== "ident" || budget <= 0) return -1;
    resolver ??= new ExpressionResolver(tokens, context.constants);
    const r = resolver;
    const bound = r.binding(k, t.value);
    let def = bound?.kind === "function" ? bound.def : null;
    if (bound?.kind === "value") def = r.functionAt(bound.range[0] + 1) ?? null;
    if (!def || def.name !== t.value) return -1;
    const [b0, b1] = def.body;
    if (!def.block)
      return is(b0, "(") && is(b0 + 1, "{") && r.closeOf(b0 + 1) === r.closeOf(b0) - 1
        ? b0 + 1
        : -1;
    let open = -1;
    budget -= b1 - b0;
    for (let j = b0 + 1; j < b1; j++) {
      if (tokens[j]!.type !== "ident" || tokens[j]!.value !== "return") continue;
      if (r.functionAt(j)?.paramsAt !== def.paramsAt) continue;
      if (open !== -1 || !is(j + 1, "{")) return -1;
      const close = r.closeOf(j + 1);
      if (close === -1) return -1;
      // the body's `}` is at b1 - 1
      const after = is(close + 1, ";") ? close + 2 : close + 1;
      if (after !== b1 - 1) return -1;
      open = j + 1;
    }
    return open;
  };
  /**
   * Where this file defines its export `property`: the value's tokens, or for `*` (the namespace
   * an `import * as` or a whole `require` gives) every named export, or `module.exports = …`
   * itself. Forms: `export const|let|var P = …`, `export function P`, `export default …`,
   * `export { L as P }`, `exports.P = …` / `module.exports.P = …` (tsc's `exports.P = void 0`
   * says nothing), `module.exports = …` (also for `default`, as a CommonJS module is imported),
   * and a key of `module.exports = { P: v }`. Null when the export is not found, is defined
   * twice, or (for `*`) the file also re-exports another module (`export *`, `__exportStar`,
   * `Object.defineProperty(exports, …)`), so its names are not all known.
   */
  const exportValue = (
    property: string,
  ):
    | { value: [number, number] }
    | { names: Array<{ name: string; value: [number, number] }> }
    | null => {
    resolver ??= new ExpressionResolver(tokens, context.constants);
    const r = resolver;
    const ident = (j: number, v?: string): boolean =>
      tokens[j]?.type === "ident" && (v === undefined || tokens[j]!.value === v);
    const valueEnd = (a: number): number => {
      if (is(a, "{") || is(a, "[")) {
        const c = r.closeOf(a);
        return c === -1 ? -1 : c + 1;
      }
      return r.endOf(a);
    };
    const named = new Map<string, Array<[number, number]>>();
    let whole: Array<[number, number]> = [];
    let defaults: Array<[number, number]> = [];
    let open = false;
    const add = (name: string, a: number, b: number): void => {
      if (b <= a) return;
      named.set(name, [...(named.get(name) ?? []), [a, b]]);
    };
    budget -= tokens.length;
    for (let j = 0; j < tokens.length; j++) {
      const t = tokens[j]!;
      if (t.type !== "ident") continue;
      if (t.value === "export" && !is(j - 1, ".")) {
        if (ident(j + 1, "default")) {
          const a = ident(j + 2, "async") ? j + 3 : j + 2;
          if (ident(a, "function") || ident(a, "class")) {
            const def = r.functionAt(a + 2) ?? r.functionAt(a + 3);
            if (def && ident(a, "function")) defaults.push([def.paramsAt, def.body[1]]);
            else open = true;
          } else defaults.push([j + 2, valueEnd(j + 2)]);
        } else if (ident(j + 1, "const") || ident(j + 1, "let") || ident(j + 1, "var")) {
          if (ident(j + 2) && is(j + 3, "=")) add(tokens[j + 2]!.value, j + 2, j + 3);
          else open = true;
        } else if (
          ident(j + 1, "function") ||
          (ident(j + 1, "async") && ident(j + 2, "function"))
        ) {
          const n = ident(j + 1, "async") ? j + 3 : j + 2;
          if (ident(n)) add(tokens[n]!.value, n, n + 1);
        } else if (ident(j + 1, "class") && ident(j + 2)) add(tokens[j + 2]!.value, j + 2, j + 3);
        else if (is(j + 1, "*")) open = true;
        else if (is(j + 1, "{")) {
          const close = r.closeOf(j + 1);
          if (close === -1) {
            open = true;
            continue;
          }
          // `export { a } from "./b"` passes another module's names on: not followed here
          if (ident(close + 1, "from")) {
            open = true;
            continue;
          }
          for (let q = j + 2; q < close; q++) {
            if (!ident(q) || !(is(q - 1, "{") || is(q - 1, ","))) continue;
            const renamed =
              ident(q + 1, "as") && (ident(q + 2) || tokens[q + 2]?.type === "string");
            const name = renamed ? tokens[q + 2]!.value : tokens[q]!.value;
            if (name === "default") defaults.push([q, q + 1]);
            else add(name, q, q + 1);
          }
        }
        continue;
      }
      // `exports.P = …`, `module.exports.P = …`, `module.exports = …`
      if (t.value !== "exports" || is(j - 1, "?.")) continue;
      const viaModule = is(j - 1, ".") && ident(j - 2, "module") && !is(j - 3, ".");
      if (is(j - 1, ".") && !viaModule) continue;
      if (is(j + 1, "=") && !is(j + 2, "=")) {
        // `module.exports = …`; a bare `exports = …` rebinds the name and exports nothing
        if (viaModule) whole.push([j + 2, valueEnd(j + 2)]);
        else open = true;
        continue;
      }
      if (!is(j + 1, ".") || !ident(j + 2)) {
        // handed to a call: `Object.defineProperty(exports, "P", …)`, `__exportStar(m, exports)`
        const esModule = ident(j - 2, "defineProperty") && tokens[j + 2]?.value === "__esModule";
        if ((is(j + 1, ",") || is(j + 1, ")")) && !esModule) open = true;
        continue;
      }
      if (!is(j + 3, "=") || is(j + 4, "=")) continue;
      // tsc's export hoisting: `exports.a = exports.b = void 0`
      let v = j + 4;
      while (ident(v, "exports") && is(v + 1, ".") && ident(v + 2) && is(v + 3, "=")) v += 4;
      if (ident(v, "void")) continue;
      const name = tokens[j + 2]!.value;
      if (name === "__esModule") continue;
      if (name === "default") defaults.push([j + 4, valueEnd(j + 4)]);
      else add(name, j + 4, valueEnd(j + 4));
    }
    // `export const P = …` was recorded at its name: the value follows `=`
    const valueOf = ([a, b]: [number, number]): [number, number] =>
      b === a + 1 &&
      is(a + 1, "=") &&
      tokens[a - 1]?.type === "ident" &&
      /^(const|let|var)$/.test(tokens[a - 1]!.value)
        ? [a + 2, valueEnd(a + 2)]
        : b === a + 1 && (ident(a - 1, "function") || ident(a - 1, "class"))
          ? (() => {
              const def = r.functionAt(a + 1);
              return def
                ? ([def.paramsAt, def.body[1]] as [number, number])
                : ([a, a + 1] as [number, number]);
            })()
          : [a, b];
    whole = whole.filter(([, b]) => b !== -1);
    defaults = defaults.filter(([, b]) => b !== -1);
    // a name of the file that is written after its declaration, or a key of `exports` written
    // again (`exports.api.extra = f`), is not read as written
    const changed = (name: string, defs: Array<[number, number]>): boolean => {
      const declared = defs.some(
        ([a, b]) =>
          b === a + 1 && (is(a + 1, "=") || ident(a - 1, "function") || ident(a - 1, "class")),
      );
      if (declared && (writtenAnywhere(name) || escapes(name, 0))) return true;
      let writes = 0;
      for (const j of r.namePositions("exports")) {
        if (is(j - 1, ".") && !ident(j - 2, "module")) continue;
        // tsc's export hoisting `exports.a = exports.b = void 0` declares, it writes nothing
        let v = j;
        while (ident(v, "exports") && is(v + 1, ".") && ident(v + 2) && is(v + 3, "=")) v += 4;
        if (v > j && ident(v, "void")) continue;
        const marker = is(j + 1, ",") && tokens[j + 2]?.value === "__esModule";
        if (writesMember(tokens, j) === name || (writtenByCallAt(tokens, j) && !marker)) writes++;
      }
      return writes > (declared ? 0 : 1);
    };
    if (property === "*") {
      if (whole.length === 1 && !named.size) return { value: whole[0]! };
      if (whole.length || open) return null;
      const names: Array<{ name: string; value: [number, number] }> = [];
      for (const [name, defs] of named) {
        if (defs.length !== 1 || changed(name, defs)) return null;
        names.push({ name, value: valueOf(defs[0]!) });
      }
      return { names };
    }
    if (property === "default") {
      const all = [...defaults, ...whole];
      if (whole.length && named.size) return null;
      return all.length === 1 && !named.has("default") ? { value: valueOf(all[0]!) } : null;
    }
    const defs = named.get(property) ?? [];
    if (defs.length === 1 && !whole.length)
      return changed(property, defs) ? null : { value: valueOf(defs[0]!) };
    // a key of `module.exports = { P: v }`
    if (!defs.length && whole.length === 1 && is(whole[0]![0], "{")) {
      const [a, b] = whole[0]!;
      for (let q = a + 1; q < b - 1; q++) {
        if (!(is(q - 1, "{") || is(q - 1, ","))) continue;
        if (tokens[q]?.value !== property) continue;
        if (is(q + 1, ",") || is(q + 1, "}")) return { value: [q, q + 1] };
        if (is(q + 1, ":")) return { value: [q + 2, r.endOf(q + 2)] };
      }
    }
    return null;
  };
  /**
   * The member value in [from, end) as a generic forwarder: a function whose first parameter is
   * the whole first argument of every ipcRenderer call in it and is never written there, with one
   * IPC method besides the removal ones (`removeListener`, `off`, `removeAllListeners`), or a
   * reference `ipcRenderer.send` (also `.bind(ipcRenderer)`). Null for anything else.
   */
  /**
   * The token at j is Electron's ipcRenderer: a name for it (`ipcRenderer`, a minifier's `e` from
   * `{ ipcRenderer: e }`), or `X.ipcRenderer` with X the electron module (`electron_1`,
   * `import_electron`, a minifier's `o = require("electron")`).
   */
  const rendererAt = (j: number): boolean => {
    const t = tokens[j];
    if (t?.type !== "ident" || (context.aliases.get(j) ?? t.value) !== "ipcRenderer") return false;
    if (!is(j - 1, ".") && !is(j - 1, "?.")) return true;
    const x = tokens[j - 2];
    if (x?.type !== "ident" || is(j - 3, ".") || is(j - 3, "?.")) return false;
    if (context.constants.requireOf(x.value, j - 2) === "electron") return true;
    const form = importFormOf(x.value);
    if (form?.specifier === "electron" && form.property === "*") return true;
    resolver ??= new ExpressionResolver(tokens, context.constants);
    const bound = resolver.binding(j - 2, x.value);
    return bound?.kind === "value" && requireIn(bound.range[0], bound.range[1]) === "electron";
  };
  const forwarderOf = (
    from: number,
    end: number,
  ): Omit<BridgeForwarder, "api" | "path" | "file" | "line"> | null => {
    if (budget <= 0 || end - from > MAX_BODY_TOKENS) return null;
    // `send: ipcRenderer.send`, `send: ipcRenderer.send.bind(ipcRenderer)`
    {
      // `X.ipcRenderer.send` as well: start at the ipcRenderer token
      const k = is(from + 1, ".") && rendererAt(from + 2) ? from + 2 : from;
      if (
        rendererAt(k) &&
        is(k + 1, ".") &&
        tokens[k + 2]?.type === "ident" &&
        CHANNEL_CALLS.has(tokens[k + 2]!.value) &&
        (k + 3 === end || (is(k + 3, ".") && tokens[k + 4]?.value === "bind" && is(k + 5, "(")))
      )
        return { method: `ipcRenderer.${tokens[k + 2]!.value}` };
    }
    resolver ??= new ExpressionResolver(tokens, context.constants);
    const r = resolver;
    let def: FnDef | null = null;
    for (let j = from; j < Math.min(end, from + 6) && !def; j++) def = r.functionWithParamsAt(j);
    if (!def || def.body[1] > end + 1) return null;
    const p = def.params[0];
    if (p?.kind !== "name") return null;
    const param = p.name;
    const [b0, b1] = def.body;
    budget -= b1 - b0;
    const methods = new Set<string>();
    /** The ipcRenderer calls of the body: the token of `ipcRenderer`. */
    const calls: number[] = [];
    /** The `(` of each of those calls. */
    const callOpen: number[] = [];
    /** The tokens of the parameter as the channel argument of those calls. */
    const args = new Set<number>();
    let other = false;
    let allowed: string[] | undefined;
    let prefix: string | undefined;
    /** Whether the last check `enforced` accepted was the exit-first form; all of them, below. */
    let exitForm = false;
    let allExitFirst = true;
    for (let j = b0; j < b1; j++) {
      const t = tokens[j]!;
      if (t.type !== "ident") continue;
      if (
        rendererAt(j) &&
        (is(j + 1, ".") || is(j + 1, "?.")) &&
        tokens[j + 2]?.type === "ident" &&
        is(j + 3, "(")
      ) {
        const m = tokens[j + 2]!.value;
        // every IPC call takes the parameter, whole, as its channel
        if (!(tokens[j + 4]?.value === param && (is(j + 5, ",") || is(j + 5, ")")))) return null;
        if (!REMOVE_METHODS.has(m)) {
          if (!CHANNEL_CALLS.has(m)) return null;
          methods.add(m);
        }
        // the call starts at its receiver chain (`electron_1.ipcRenderer.send`)
        let callAt = j;
        while (is(callAt - 1, ".") && tokens[callAt - 2]?.type === "ident") callAt -= 2;
        calls.push(callAt);
        callOpen.push(j + 3);
        args.add(j + 4);
        j += 4;
      }
    }
    if (methods.size !== 1) return null;
    const first = Math.min(...calls);
    const last = Math.max(...calls);
    /**
     * Whether the check that spans [from, to) (`LIST.includes(ch)`, `ch.startsWith("x:")`) is
     * enforced before every IPC call, in one of these shapes only: `if (!check) return|throw …`
     * (also `{ return …` / `{ throw …`) before the calls, at the body's own level;
     * `if (check) { … }` or `if (check) call` with every call inside; `check && call`. A bare,
     * inverted or unrelated check is none.
     */
    const enforced = (at: number, to: number): boolean => {
      if (r.functionAt(at)?.paramsAt !== def!.paramsAt) return false;
      /** A statement that starts at k sits directly in the body (no block, loop, switch or try around it). */
      const direct = (k: number): boolean => {
        if (!def!.block) return k === b0;
        if (r.bracketAround(k) !== b0) return false;
        // a statement of its own, not the body of a loop or condition without braces
        // (`for (…) if (…) return;`, `else if`, `do if`)
        return is(k - 1, "{") || is(k - 1, ";") || is(k - 1, "}");
      };
      /** The end of the statement whose expression ends at the `)` of the call opened at `open`. */
      const endsAfter = (open: number): boolean => {
        const close = r.closeOf(open);
        return close !== -1 && (is(close + 1, ";") || is(close + 1, "}") || close + 1 === b1);
      };
      /** An exit that leaves the function without any IPC call: `return;`, `throw …;`, `{ …; return; }`. */
      const exits = (k: number): boolean => {
        if (tokens[k]?.value === "return") return is(k + 1, ";") || is(k + 1, "}");
        if (tokens[k]?.value === "throw") {
          const stop = r.endOf(k + 1);
          return stop < first;
        }
        if (!is(k, "{")) return false;
        const close = r.closeOf(k);
        if (close === -1 || close > first) return false;
        // statements that do not use the channel may come first (Element: `console.error(…); return;`)
        let leaves = false;
        for (let q = k + 1; q < close; q++) {
          if (tokens[q]!.type === "ident" && tokens[q]!.value === param) return false;
          if (r.bracketAround(q) !== k) continue;
          // only a statement of this block of its own: after `;`, the block's `{` or a `}` that
          // closes a statement's block; not the body of `if (…)`, `while (…)`, `else`, `do`
          const starts = q === k + 1 || is(q - 1, ";") || is(q - 1, "}");
          if (!starts) continue;
          if (tokens[q]!.value === "return" && (is(q + 1, ";") || is(q + 1, "}"))) leaves = true;
          if (tokens[q]!.value === "throw") leaves = true;
        }
        return leaves;
      };
      // `if (!check) return;` before every call
      exitForm = false;
      if (is(at - 1, "!") && is(at - 2, "(") && tokens[at - 3]?.value === "if") {
        exitForm =
          direct(at - 3) && is(to, ")") && r.closeOf(at - 2) === to && to < first && exits(to + 1);
        return exitForm;
      }
      if (is(at - 1, "!")) return false;
      // `if (check) { … every call … }`, `if (check) call;`
      if (is(at - 1, "(") && tokens[at - 2]?.value === "if" && is(to, ")")) {
        if (!direct(at - 2) || r.closeOf(at - 1) !== to) return false;
        const c = to + 1;
        if (is(c, "{")) {
          const close = r.closeOf(c);
          return close !== -1 && first > c && last < close;
        }
        // `if (check) call;`, also `if (check) return call;` as esbuild writes the early exit
        const at0 = tokens[c]?.value === "return" ? c + 1 : c;
        return calls.length === 1 && first === at0 && endsAfter(callOpen[0]!);
      }
      // `check ? call : other` as minifiers write `if (check) return call; return other`: the
      // arrow's body or a `return` of the body's own level, the one call between `?` and `:`
      if (is(to, "?")) {
        const value = def!.block ? tokens[at - 1]?.value === "return" && direct(at - 1) : at === b0;
        const close = callOpen.length === 1 ? r.closeOf(callOpen[0]!) : -1;
        return (
          value && calls.length === 1 && first === to + 1 && close !== -1 && is(close + 1, ":")
        );
      }
      // `check && call;` as minifiers write the `if`, a statement of its own (or the arrow's body)
      const statement = def!.block ? direct(at) && (is(at - 1, "{") || is(at - 1, ";")) : at === b0;
      return (
        statement &&
        is(to, "&&") &&
        calls.length === 1 &&
        first === to + 1 &&
        endsAfter(callOpen[0]!)
      );
    };
    for (let j = b0; j < b1; j++) {
      const t = tokens[j]!;
      if (t.type !== "ident" || t.value !== param || is(j - 1, ".") || is(j - 1, "?.")) continue;
      // the channel argument of an IPC call
      if (args.has(j)) continue;
      // the parameter itself, not one of an inner function of the same name
      const own = r.binding(j, param);
      if (own?.kind !== "param" || own.def.paramsAt !== def.paramsAt) continue;
      // the declaration of an inner function's parameter of the same name (`(ch) => …`)
      const around = r.bracketAround(j);
      const inner =
        r.functionWithParamsAt(j) ?? (around >= 0 ? r.functionWithParamsAt(around) : null);
      if (inner && inner.paramsAt !== def.paramsAt) continue;
      if (writesName(tokens, j)) return null;
      // `if (!LIST.includes(channel)) return;`, `ALLOWED.has(channel)`: a list of strings of the file
      if (
        is(j - 1, "(") &&
        is(j + 1, ")") &&
        (tokens[j - 2]?.value === "includes" || tokens[j - 2]?.value === "has") &&
        (is(j - 3, ".") || is(j - 3, "?."))
      ) {
        const strings = stringList(j - 4);
        if (strings && !allowed && enforced(j - 4, j + 2)) {
          allowed = strings;
          allExitFirst &&= exitForm;
          continue;
        }
      }
      // `if (!channel.startsWith("x:")) throw …`, also `channel?.startsWith`
      if (
        (is(j + 1, ".") || is(j + 1, "?.")) &&
        tokens[j + 2]?.value === "startsWith" &&
        is(j + 3, "(") &&
        textOf(tokens[j + 4]) !== null &&
        is(j + 5, ")") &&
        prefix === undefined &&
        enforced(j, j + 6)
      ) {
        prefix = textOf(tokens[j + 4])!;
        allExitFirst &&= exitForm;
        continue;
      }
      other = true;
    }
    return {
      method: `ipcRenderer.${[...methods][0]!}`,
      ...(allowed ? { allowed } : {}),
      ...(prefix !== undefined ? { prefix } : {}),
      ...(other ? { guard: "unknown" as const } : {}),
      ...((allowed || prefix !== undefined) && allExitFirst ? { exitFirst: true as const } : {}),
    };
  };
  /** The strings of the array (or `new Set([…])`) the name ending at k holds, when it is a `const` nothing writes. */
  const stringList = (k: number): string[] | null => {
    if (tokens[k]?.type !== "ident" || is(k - 1, ".")) return null;
    resolver ??= new ExpressionResolver(tokens, context.constants);
    const bound = resolver.binding(k, tokens[k]!.value);
    if (bound?.kind !== "value" || writtenAnywhere(tokens[k]!.value)) return null;
    // `L.includes = …`, `Array.prototype.includes = …`: the check may say anything
    if (
      tokens.some(
        (x, q) =>
          (x.value === "includes" || x.value === "has") &&
          x.type === "ident" &&
          (is(q - 1, ".") || is(q - 1, "?.")) &&
          (is(q + 1, "=") || is(q + 1, "??=") || is(q + 1, "||=")),
      )
    )
      return null;
    // every other use is a check: `L.includes(x)`, `L.has(x)`; anything else may change it
    // (`S.add(…)`, `L.push(…)`, handed to a function)
    const decl = bound.range[0] - 2;
    for (const j of resolver.namePositions(tokens[k]!.value)) {
      if (j === decl || is(j - 1, ".")) continue;
      const m = tokens[j + 2]?.value;
      if (
        !(
          (is(j + 1, ".") || is(j + 1, "?.")) &&
          (m === "includes" || m === "has") &&
          is(j + 3, "(")
        )
      )
        return null;
    }
    let [a, b] = bound.range;
    if (tokens[a]?.value === "new" && tokens[a + 1]?.value === "Set" && is(a + 2, "(")) {
      a += 3;
      b -= 1;
    }
    if (!is(a, "[") || resolver.closeOf(a) !== b - 1) return null;
    const out: string[] = [];
    for (let j = a + 1; j < b - 1; j += 2) {
      const v = textOf(tokens[j]);
      if (v === null || !(is(j + 1, ",") || j + 1 === b - 1)) return null;
      out.push(v);
    }
    return out;
  };
  /** The forwarders among the members of the object literal at `open`, by path (three levels). */
  const forwardersIn = (
    open: number,
    path: string,
    level: number,
    line: number,
    api: string,
  ): void => {
    if (level > 3 || budget <= 0) return;
    resolver ??= new ExpressionResolver(tokens, context.constants);
    const close = resolver.closeOf(open);
    if (close === -1) return;
    let start = open + 1;
    for (let k = open + 1, d = 0; k <= close; k++) {
      if (k < close && (is(k, "(") || is(k, "[") || is(k, "{"))) {
        d++;
        continue;
      }
      if (k < close && (is(k, ")") || is(k, "]") || is(k, "}"))) {
        d--;
        continue;
      }
      if (k < close && !(d === 0 && is(k, ","))) continue;
      const from = start;
      start = k + 1;
      let s = from;
      while (s < k && BRIDGE_MODIFIERS.has(tokens[s]!.value) && !is(s + 1, ":") && !is(s + 1, "("))
        s++;
      const name = tokens[s]?.type === "ident" ? tokens[s]!.value : textOf(tokens[s]);
      if (name === null || s >= k) continue;
      const value = is(s + 1, ":") ? s + 2 : s + 1;
      const sub = `${path}.${name}`;
      if (is(value, "{") && resolver.closeOf(value) === k - 1) {
        forwardersIn(value, sub, level + 1, tokens[s]!.line, api);
        continue;
      }
      const f = forwarderOf(is(s + 1, ":") ? s + 2 : s, k);
      if (f && forwarders.length < MAX_BRIDGE_PER_FILE)
        forwarders.push({ api, path: sub, ...f, file, line: tokens[s]!.line ?? line });
    }
  };
  /**
   * The object a name of the file holds may be changed through something else: another name for
   * it that is written (`const p = platform; p.a = …`, a few names deep), or a function it is
   * handed to (`patch(api)`) other than the few that only read.
   */
  const escapes = (name: string, depth: number): boolean => {
    // past the depth or the budget nothing is proven: the object may escape
    if (depth > 3 || budget <= 0) return true;
    resolver ??= new ExpressionResolver(tokens, context.constants);
    const r = resolver;
    /** The name at k is a global (or the file binds nothing of that name there). */
    const unbound = (k: number): boolean =>
      tokens[k]?.type === "ident" &&
      r.binding(k, tokens[k]!.value, true) === null &&
      !r.paramAround(k, tokens[k]!.value);
    for (const j of r.namePositions(name)) {
      budget -= BRIDGE_SCOPE_COST;
      if (budget <= 0) return true;
      if (is(j - 1, ".") || is(j - 1, "?.")) continue;
      const ends =
        is(j + 1, ";") ||
        is(j + 1, ",") ||
        is(j + 1, ")") ||
        is(j + 1, "}") ||
        j + 1 >= tokens.length;
      // `X = name`: X is another name for it
      if (is(j - 1, "=") && tokens[j - 2]?.type === "ident" && !is(j - 3, ".") && ends) {
        const other = tokens[j - 2]!.value;
        if (other !== name && (writtenAnywhere(other) || escapes(other, depth + 1))) return true;
        continue;
      }
      // a value of an object or array literal (`{ k: name }`, `{ name }`, `[name]`), or a
      // part of `a || name`, `a ?? name`, `c ? name : d` on the right of an assignment: another
      // object holds it now, except the module's own exports (`module.exports = { name }`)
      const around = r.bracketAround(j);
      if (
        around >= 0 &&
        (is(around, "{") || is(around, "[")) &&
        (is(j - 1, ":") || is(j - 1, "{") || is(j - 1, "[") || is(j - 1, ",")) &&
        (ends || is(j + 1, "]"))
      ) {
        const exportsObject =
          is(around, "{") &&
          is(around - 1, "=") &&
          (tokens[around - 2]?.value === "exports" ||
            (is(around - 3, ".") && tokens[around - 4]?.value === "exports"));
        const exportDefault =
          is(around, "{") &&
          tokens[around - 1]?.value === "default" &&
          tokens[around - 2]?.value === "export";
        // a key of a destructuring pattern or of an import/export list is no value
        const listOrPattern =
          is(around, "{") &&
          (tokens[around - 1]?.value === "export" ||
            tokens[around - 1]?.value === "import" ||
            is(r.closeOf(around) + 1, "=") ||
            tokens[r.closeOf(around) + 1]?.value === "from");
        if (exportsObject || exportDefault || listOrPattern) continue;
        // the outermost literal it sits in (`{ a: { platform } }`)
        let top = around;
        for (let guard = 0; guard < 8; guard++) {
          const up = r.bracketAround(top);
          if (
            up < 0 ||
            !(is(up, "{") || is(up, "[")) ||
            !(is(top - 1, ":") || is(top - 1, ",") || is(top - 1, "{") || is(top - 1, "["))
          )
            break;
          top = up;
        }
        // exposed as it is: `contextBridge.exposeInMainWorld("api", { platform })`
        const call = r.bracketAround(top);
        if (
          call >= 0 &&
          is(call, "(") &&
          (tokens[call - 1]?.value === "exposeInMainWorld" ||
            tokens[call - 1]?.value === "exposeInIsolatedWorld") &&
          (is(call - 2, ".") || is(call - 2, "?.")) &&
          (context.aliases.get(call - 3) ?? tokens[call - 3]?.value) === "contextBridge"
        )
          continue;
        // held by an object of the file under a name (`var ipc = { auth: auth_default }`): an
        // escape only when that holder may change or escape itself
        const holder =
          is(top - 1, "=") && tokens[top - 2]?.type === "ident" && !is(top - 3, ".")
            ? tokens[top - 2]!.value
            : null;
        if (holder === null || holder === name) return true;
        if (writtenAnywhere(holder) || escapes(holder, depth + 1)) return true;
        continue;
      }
      if (
        is(j - 1, "||") ||
        is(j - 1, "??") ||
        is(j - 1, "?") ||
        (is(j - 1, ":") && !is(around, "{"))
      )
        return true;
      // handed to a call
      if ((is(j - 1, "(") || is(j - 1, ",")) && (is(j + 1, ")") || is(j + 1, ","))) {
        const open = is(j - 1, "(") ? j - 1 : around;
        if (!is(open, "(")) continue;
        const callee = tokens[open - 1];
        if (callee?.type !== "ident") return true;
        const member = is(open - 2, ".") || is(open - 2, "?.");
        const owner = member ? open - 3 : -1;
        // `contextBridge.exposeInMainWorld(…, name)` on a proven contextBridge
        if (
          member &&
          (callee.value === "exposeInMainWorld" || callee.value === "exposeInIsolatedWorld") &&
          (context.aliases.get(owner) ?? tokens[owner]?.value) === "contextBridge"
        )
          continue;
        // the few calls that only read, on the global they belong to
        if (READ_ONLY_CALLS.has(callee.value)) {
          if (!member && unbound(open - 1) && !/^(log|warn|error|info|debug)$/.test(callee.value))
            continue;
          if (
            member &&
            /^(Object|JSON|console)$/.test(tokens[owner]?.value ?? "") &&
            !is(owner - 1, ".") &&
            unbound(owner)
          )
            continue;
        }
        return true;
      }
    }
    return false;
  };
  /** The opening bracket that matches the closing one at `close`, or -1. */
  const openOf = (close: number): number => {
    for (let d = 0, j = close; j >= 0 && j > close - 4000; j--) {
      const p = tokens[j]!;
      if (p.type !== "punct") continue;
      if (p.value === ")" || p.value === "]" || p.value === "}") d++;
      else if (p.value === "(" || p.value === "[" || p.value === "{") {
        d--;
        if (d === 0) return j;
      }
    }
    return -1;
  };
  const names = (from: number, to: number, name: string): boolean => {
    for (let j = from; j < to; j++)
      if (tokens[j]!.type === "ident" && tokens[j]!.value === name) return true;
    return false;
  };
  /**
   * Whether `name`, used by the call at token `call`, is bound by a loop or a function the call
   * sits in: the header of a `for` right before the call's statement (`for (…) stmt`) or before a
   * block around it, or the parameters of an enclosing function. Such a name is another binding
   * than a declaration elsewhere in the file under the same name.
   */
  const boundLocally = (call: number, name: string): boolean => {
    let sameStatement = true;
    for (let j = call - 1; j >= 0 && j > call - 50_000; j--) {
      const p = tokens[j]!;
      if (p.type !== "punct") continue;
      if (p.value === ";") sameStatement = false;
      else if (p.value === ")") {
        const open = openOf(j);
        if (open < 0) return false;
        const before = tokens[open - 1];
        if (
          sameStatement &&
          before?.type === "ident" &&
          before.value === "for" &&
          names(open, j, name)
        )
          return true;
        j = open;
      } else if (p.value === "]" || p.value === "}") {
        const open = openOf(j);
        if (open < 0) return false;
        j = open;
      } else if (p.value === "{") {
        // The block around the call: a loop body or a function body when a header precedes it.
        if (is(j - 1, "=>")) {
          if (tokens[j - 2]?.type === "ident" && tokens[j - 2]!.value === name) return true;
          if (is(j - 2, ")")) {
            const open = openOf(j - 2);
            if (open >= 0 && names(open, j - 2, name)) return true;
          }
        } else if (is(j - 1, ")")) {
          const open = openOf(j - 1);
          if (open >= 0 && names(open, j - 1, name)) return true;
        }
        sameStatement = false;
      }
    }
    return false;
  };
  const exposures: BridgeExposure[] = [];
  let bindings: ReturnType<typeof privilegedBindings> | null = null;
  /**
   * The privileged object the value from token `from` to `end` (exclusive) is, as a whole: a
   * path such as `ipcRenderer`, `o.ipcRenderer.send` or `require("fs")`, optionally a method of
   * one with `.bind(…)`. Anything else (a function, a call, an object, a property of an object
   * of the file) is null: a wrapper around a privileged object is not that object.
   */
  /**
   * Whether `name` at `from` is another binding than the file's declaration: a parameter or loop
   * variable around the value or around the exposing call (`for (const ipcRenderer of …)`,
   * `forEach(ipcRenderer => …)`, `catch (ipcRenderer)`).
   */
  const shadowed = (call: number, from: number, name: string): boolean => {
    if (boundLocally(call, name) || boundLocally(from, name)) return true;
    resolver ??= new ExpressionResolver(tokens, context.constants);
    return resolver.paramAround(from, name) || resolver.paramAround(call, name);
  };
  const privileged = (
    call: number,
    from: number,
    end: number,
    depth = 0,
  ): { what: string; undecided?: Undecided } | null => {
    if (from >= end || end - from > 40) return null;
    let stop = end;
    // `ipcRenderer.on.bind(ipcRenderer)`: the method itself, bound
    let bound = false;
    if (is(stop - 1, ")")) {
      const open = openOf(stop - 1);
      if (open > from + 2 && tokens[open - 1]?.value === "bind" && is(open - 2, ".")) {
        stop = open - 2;
        bound = true;
      }
    }
    bindings ??= privilegedBindings(
      tokens,
      () => (resolver ??= new ExpressionResolver(tokens, context.constants)),
    );
    const { declared } = bindings;
    let k = from;
    let base: string | null = null;
    let open: Undecided | undefined;
    const first = tokens[k];
    if (first?.type !== "ident") return null;
    if (
      first.value === "require" &&
      is(k + 1, "(") &&
      tokens[k + 2]?.type === "string" &&
      is(k + 3, ")")
    ) {
      if (declared.has("require")) return null;
      base = privilegedModule(tokens[k + 2]!.value);
      k += 4;
    } else if (is(k + 1, "(") && is(k + 2, ")")) {
      // `electron().ipcRenderer` with `electron` a lazy getter of the module
      // (`ExpressionResolver.lazyValueAt`): what the getter gives, read as written there
      resolver ??= new ExpressionResolver(tokens, context.constants);
      const given = depth < 3 ? resolver.lazyValueAt(k) : null;
      const inner = given ? privileged(call, given[0], given[1], depth + 1) : null;
      if (!inner || inner.what.includes(".")) return null;
      base = inner.what;
      open = inner.undecided;
      k += 3;
    } else {
      const name = first.value;
      const global =
        (name === "process" || name === "require") && !declared.has(name) && k + 1 === stop;
      const meant = bindings.meaningAt(name, from);
      base = meant?.meaning ?? null;
      open = meant?.undecided;
      // a parameter or loop variable where the value is written is another binding (asked only
      // for a name that means something, as the walk back is the costly part)
      if ((global || base) && shadowed(call, from, name)) return null;
      if (global) return bound ? null : { what: name };
      k += 1;
    }
    if (!base) return null;
    const path: string[] = [];
    while (k < stop) {
      if (!is(k, ".") || tokens[k + 1]?.type !== "ident") return null;
      path.push(tokens[k + 1]!.value);
      k += 2;
    }
    // `import_electron.default.ipcRenderer`, `cp.default`: a bundler's default import is the
    // module itself
    if (path[0] === "default") path.shift();
    if (path.length > 2) return null;
    let what = base;
    let member: string | null = null;
    for (const p of path) {
      if (what === "electron" && member === null && PRIVILEGED_ELECTRON.has(p)) what = p;
      else if (member === null && what !== "electron") member = p;
      else return null;
    }
    // a Node module's member unless it only informs (`fs.statSync`, `process.env`)
    if (member !== null && HARMLESS_MEMBERS[what]?.test(member)) return null;
    if (bound && member === null) return null;
    const exposed = member === null ? what : `${what}.${member}`;
    return open ? { what: exposed, undecided: open } : { what: exposed };
  };
  /** The value text as written, bounded. */
  const evidenceOf = (from: number, end: number): string =>
    short(
      tokens
        .slice(from, end)
        .map((x) => (x.type === "string" ? JSON.stringify(x.value) : x.value))
        .join(""),
    );
  /**
   * The statement token j stands in, walking back at its own bracket level over a comma sequence:
   * `head` null when it is a statement of its own (after `;`, `{`, `}` or at the start), else the
   * `)` of the `if`/`for`/`while`/`with` header or the `else`/`do` it is the body of (or -1 for
   * anything else that may make it conditional: a label or `case`). `loop`: that head is a loop.
   */
  const statementOf = (j: number): { head: number | null; loop: boolean } => {
    for (let p = j - 1, guard = 0; guard < 4000; p--, guard++) {
      const x = tokens[p];
      if (!x) return { head: null, loop: false };
      if (x.type === "ident" && (x.value === "else" || x.value === "do"))
        return { head: p, loop: x.value === "do" };
      if (x.type !== "punct") continue;
      if (x.value === ";" || x.value === "{" || x.value === "}") return { head: null, loop: false };
      if (x.value === ":") return { head: -1, loop: false };
      if (x.value === ")" || x.value === "]") {
        const open = openOf(p);
        if (open < 0) return { head: -1, loop: false };
        const word = tokens[open - 1];
        if (x.value === ")" && word?.type === "ident" && /^(if|for|while|with)$/.test(word.value))
          return { head: p, loop: word.value === "for" || word.value === "while" };
        p = open;
      } else if (x.value === "(" || x.value === "[") return { head: -1, loop: false };
    }
    return { head: -1, loop: false };
  };
  /**
   * How the binding the name at k (used by the exposing call at `call`) is assigned as a whole
   * besides its declaration (`api = …`, `api ||= …`; the resolver's `writesTo`): `none`, the
   * name token of the write whose object literal it holds at the call, or `unknown`. A write is
   * taken only when it is provably the value at the call: every write of the name is in the
   * call's function body before the call, and the last one is `name = {…}` in the call's own
   * block, so nothing between them is conditional.
   */
  const assignedWhole = (k: number, name: string, call: number): "none" | "unknown" | number => {
    resolver ??= new ExpressionResolver(tokens, context.constants);
    const r = resolver;
    const bound = r.binding(k, name, true);
    // A declaration in a list the resolver does not read (`var { a } = x, api = {…}`, as
    // minifiers write it): the file's only declaration of the name, when no parameter around
    // the use or the call has it.
    const listed =
      bound === null && !r.paramAround(k, name) && !r.paramAround(call, name) ? objectOf(name) : -1;
    if (bound?.kind !== "value" && listed < 0) return bound === null ? "unknown" : "none";
    const init = bound?.kind === "value" ? bound.range[0] : listed;
    const decl = is(init - 1, "=") && tokens[init - 2]?.value === name ? init - 2 : -1;
    if (decl === -1) return "unknown";
    const sites = r.namePositions(name);
    budget -= sites.length * BRIDGE_SCOPE_COST;
    const writes = sites.filter((j) => j !== decl && r.writesTo(j, name, decl));
    if (!writes.length) return "none";
    const fn = (j: number): number => r.functionAt(j)?.paramsAt ?? -1;
    const last = writes.at(-1)!;
    if (
      fn(decl) !== fn(call) ||
      writes.some((j) => j > call || fn(j) !== fn(call)) ||
      !is(last + 1, "=") ||
      !is(last + 2, "{") ||
      r.bracketAround(last) !== r.bracketAround(call) ||
      // a statement of its own (or a part of a comma sequence that is one, as minifiers join
      // statements), not the body of `if (…)`, `else` or a loop without braces
      statementOf(last).head !== null
    )
      return "unknown";
    return last;
  };
  const exposure = (i: number, virtual?: VirtualExposure): void => {
    const t = tokens[i]!;
    const world = virtual ? virtual.world : t.value === "exposeInMainWorld" ? "main" : "isolated";
    const push = (
      member: string | null,
      channel: string | null,
      line: number,
      channelRef?: BridgeMember["channelRef"],
      extra?: Pick<BridgeMember, "valueRef" | "body">,
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
          ...(extra?.valueRef ? { valueRef: extra.valueRef } : {}),
          ...(extra?.body ? { body: extra.body } : {}),
        });
    };
    /** Records the value from `from` to `end` when it is a privileged object as it is. */
    const expose = (member: string | null, from: number, end: number): void => {
      // Every exposure is a member too, so past this cap the member cap has already marked the
      // file's inventory as cut (`context_bridge_truncated`).
      if (exposures.length >= MAX_BRIDGE_PER_FILE) return;
      const found = privileged(i, from, end);
      if (!found) return;
      exposures.push({
        api,
        member,
        exposed: found.what,
        evidence: evidenceOf(from, end),
        world,
        file,
        line: tokens[from]!.line,
        ...(found.undecided ? { undecided: found.undecided } : {}),
      });
    };
    let at = i + 2;
    if (world === "isolated" && !virtual) {
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
      if (!is(at, ",")) return;
      at++;
    }
    const keyToken = tokens[at];
    const simple = is(at + 1, ",");
    const apiName =
      simple && keyToken?.type === "ident" ? context.constants.stringOf(keyToken.value, at) : null;
    const api = virtual
      ? virtual.api
      : ((simple ? textOf(keyToken) : null) ??
        apiName ??
        (simple && keyToken?.type === "ident" ? `[${keyToken.value}]` : "[computed]"));
    /**
     * The object literals the exposed value at `k` is made of, and the token after it: `{…}`, a
     * name declared as `const x = {…}` in this file, `Object.freeze(…)` (also `seal`,
     * `preventExtensions`) around one of those, or `Object.assign(a, b, …)` of them. Null when
     * any part is something else, so nothing is claimed for a value that is not read whole.
     */
    /** Where the exposed name was last assigned a new object before the call (see assignedWhole). */
    let replacedAt = -1;
    const valueOpens = (k: number, level: number): { opens: number[]; next: number } | null => {
      if (level > 3 || budget <= 0) return null;
      const v = tokens[k];
      if (is(k, "{")) {
        let d = 0;
        for (let e = k; e < tokens.length && budget > 0; e++, budget--) {
          const p = tokens[e]!;
          if (p.type !== "punct") continue;
          if (p.value === "{" || p.value === "(" || p.value === "[") d++;
          else if (p.value === "}" || p.value === ")" || p.value === "]") {
            d--;
            if (d === 0) return { opens: [k], next: e + 1 };
          }
        }
        // An object that never closes, or a walk that ran out of budget: what it holds so far is
        // read, and the result says it was cut (`next` -1: nothing follows).
        truncated = true;
        return { opens: [k], next: -1 };
      }
      if (v?.type !== "ident") return null;
      if (
        v.value === "Object" &&
        is(k + 1, ".") &&
        tokens[k + 2]?.type === "ident" &&
        is(k + 3, "(")
      ) {
        const method = tokens[k + 2]!.value;
        if (method === "freeze" || method === "seal" || method === "preventExtensions") {
          const inner = valueOpens(k + 4, level + 1);
          if (inner?.next === -1) return inner;
          return inner && is(inner.next, ")") ? { opens: inner.opens, next: inner.next + 1 } : null;
        }
        if (method === "assign") {
          const opens: number[] = [];
          let e = k + 4;
          for (;;) {
            const part = valueOpens(e, level + 1);
            if (!part) return null;
            opens.push(...part.opens);
            if (part.next === -1) return { opens, next: -1 };
            if (is(part.next, ")")) return { opens, next: part.next + 1 };
            if (!is(part.next, ",")) return null;
            e = part.next + 1;
          }
        }
        return null;
      }
      // `createApi(new IpcClient("x"))`: a function of the file whose one return is an object
      // literal; its members are read as written there
      if (is(k + 1, "(")) {
        resolver ??= new ExpressionResolver(tokens, context.constants);
        const close = resolver.closeOf(k + 1);
        if (close === -1 || boundLocally(i, v.value)) return null;
        const returned = returnedObject(k);
        return returned === -1 ? null : { opens: [returned], next: close + 1 };
      }
      if (is(k + 1, ")") || is(k + 1, ",")) {
        // A loop variable or a parameter is not the object some other line declares under the
        // same name: `for (const [t, n] of Object.entries(u)) exposeInMainWorld(t, n)`.
        if (boundLocally(i, v.value)) return null;
        const named = objectOf(v.value);
        if (named < 0) return null;
        // `let api = {…}; …; api = { only }`: the object declared is not the one exposed, but
        // the one the last write gives it, when that is proven; otherwise the entry is unreadable.
        const whole = assignedWhole(k, v.value, i);
        if (whole === "unknown") return null;
        if (whole === "none") return { opens: [named], next: k + 1 };
        if (level === 0) replacedAt = whole;
        return { opens: [whole + 2], next: k + 1 };
      }
      return null;
    };
    const value = virtual ? null : simple ? valueOpens(at + 2, 0) : null;
    // `exposeInMainWorld("api", value,)`: a trailing comma, as formatters write it.
    const opens = virtual
      ? []
      : value &&
          (value.next === -1 ||
            is(value.next, ")") ||
            (is(value.next, ",") && is(value.next + 1, ")")))
        ? value.opens
        : null;
    // `exposeInMainWorld("api", Object.fromEntries(…))`, or a name declared as such: members
    // built from a table, when every one forwards to an ipcRenderer call
    const built = !virtual && simple && !opens && value === null ? forwarded(at + 2) : null;
    if (built) {
      for (const b of built) push(b.member, b.channel, t.line);
      return;
    }
    if (!opens) {
      // `exposeInMainWorld("api", X)` with X another module's export: read once modules are known
      const ref = simple ? moduleValueRef(at + 2) : null;
      push(null, null, t.line, undefined, ref ? { valueRef: ref } : undefined);
      // `exposeInMainWorld("ipc", ipcRenderer)`: the value as a whole, up to the call's end;
      // also under a key that is not read (`exposeInMainWorld(prefix + "ipc", ipcRenderer)`)
      let start = simple ? at + 2 : -1;
      for (let j = at, d = 0; start < 0 && j < tokens.length && j < at + 400; j++) {
        if (is(j, "(") || is(j, "[") || is(j, "{")) d++;
        else if (is(j, ")") || is(j, "]") || is(j, "}")) {
          if (d === 0) break;
          d--;
        } else if (d === 0 && is(j, ",")) start = j + 1;
      }
      if (start >= 0) {
        let end = start;
        for (let d = 0; end < tokens.length && end < start + 60; end++) {
          const p = tokens[end]!;
          if (p.type !== "punct") continue;
          if (p.value === "(" || p.value === "[" || p.value === "{") d++;
          else if (p.value === ")" || p.value === "]" || p.value === "}") {
            if (d === 0) break;
            d--;
          } else if (p.value === "," && d === 0) break;
        }
        if (is(end, ")") || (is(end, ",") && is(end + 1, ")"))) expose(null, start, end);
      }
      return;
    }
    /** One member, from token `from` to `end` (its `,` or `}`), of the object at `objectOpen`. */
    const readMember = (
      from: number,
      end: number,
      level: number,
      objectOpen: number,
      prefix: string | null = null,
    ): void => {
      let s = from;
      if (s >= end) return;
      const first = tokens[s]!;
      if (is(s, "...")) {
        // `...libraryApi` with `const libraryApi = {…}` in this file: its members, in place
        const spread = tokens[s + 1];
        // `...Library` with `import * as Library from "./library"`: read once modules are known
        const ref = s + 2 === end ? moduleValueRef(s + 1) : null;
        if (ref) return push(null, null, first.line, undefined, { valueRef: ref });
        const base =
          spread?.type === "ident" && s + 2 === end && level < 3 ? objectOf(spread.value) : -1;
        // `var library_exports = {}; __export(library_exports, { openDialog: () => openDialog })`,
        // as esbuild writes `import * as Library`: the getters are the members
        const getters = base !== -1 && is(base + 1, "}") ? exportGetters(spread!.value) : null;
        if (getters === "unknown") return push(null, null, first.line);
        if (getters) {
          for (const g of getters)
            if (!memberValue(qualify(prefix, g.name), g.value, g.line, level + 1))
              push(qualify(prefix, g.name), null, g.line);
          return;
        }
        if (base !== -1 && base !== objectOpen) {
          if (!walk(base, level + 1, prefix)) truncated = true;
          return;
        }
        // `...invokers(TABLE)`, `...Object.fromEntries(…)`: members built from a table
        const spreadBuilt = base === -1 && s + 1 < end ? forwarded(s + 1) : null;
        if (spreadBuilt) {
          for (const b of spreadBuilt) push(b.member, b.channel, first.line);
          return;
        }
        return push(null, null, first.line);
      }
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
      const bare =
        nameToken.type === "ident" || nameToken.type === "number"
          ? nameToken.value
          : textOf(nameToken);
      if (bare === null) return push(null, null, first.line);
      const name = qualify(prefix, bare);
      // `{ ipcRenderer }`, `ipc: ipcRenderer`, `api.ipc = ipcRenderer`: the value itself
      if (s === from && s + 1 === end && nameToken.type === "ident") expose(name, s, end);
      else if (s === from && (is(s + 1, ":") || is(s + 1, "="))) expose(name, s + 2, end);
      // `{ auth }`, `auth: authApi`: a name of the file or an import, read for what it holds
      const valueAt =
        s === from && s + 1 === end && nameToken.type === "ident"
          ? s
          : s === from && is(s + 1, ":") && s + 3 === end
            ? s + 2
            : -1;
      if (valueAt !== -1 && memberValue(name, [valueAt, valueAt + 1], first.line, level)) return;
      // `auth: auth_1.default`, `platform: m.platform`: a member of a module object
      if (s === from && is(s + 1, ":") && s + 5 === end && is(s + 3, ".")) {
        const ref = moduleValueRef(s + 2);
        if (ref) return push(name, null, first.line, undefined, { valueRef: ref });
      }
      // a generic forwarder (R1), here or in a nested object literal
      const valueStart = is(s + 1, ":") ? s + 2 : s;
      let generic: ReturnType<typeof forwarderOf> = null;
      if (is(valueStart, "{") && openOf(end - 1) === valueStart)
        forwardersIn(valueStart, name, level + 1, first.line, api);
      else generic = forwarderOf(valueStart, end);
      if (generic && forwarders.length < MAX_BRIDGE_PER_FILE)
        forwarders.push({ api, path: name, ...generic, file, line: first.line });
      pushChannels(name, s + 1, end, first.line, generic);
    };
    /** The channel of the IPC calls in [from, end), when they name exactly one: the member's row. */
    const pushChannels = (
      name: string,
      from: number,
      end: number,
      line: number,
      generic: ReturnType<typeof forwarderOf> = null,
    ): void => {
      const channels = new Set<string>();
      const refs: Array<NonNullable<BridgeMember["channelRef"]>> = [];
      // `on(CH, f)` and `off(CH, f)` in one member name one channel
      const addRef = (ref: NonNullable<BridgeMember["channelRef"]>): void => {
        if (!refs.some((r) => JSON.stringify(r) === JSON.stringify(ref))) refs.push(ref);
      };
      let calls = false;
      for (let j = from; j + 2 < end; j++) {
        // a call: `client.invoke(…)`, `makeInvoker("x")`, `(0, ipc_1.makeInvoker)("x")`
        if (!calls && is(j + 1, "(") && (tokens[j]!.type === "ident" || is(j, ")"))) calls = true;
        const callee = tokens[j + 2]!;
        if (
          tokens[j]!.type === "ident" &&
          (context.aliases.get(j) ?? tokens[j]!.value) === "ipcRenderer" &&
          is(j + 1, ".") &&
          callee.type === "ident" &&
          CHANNEL_CALLS.has(callee.value) &&
          is(j + 3, "(")
        ) {
          const channelName = context.constants.resolveArg(j + 4) ?? nameValue(j + 4);
          if (channelName && "value" in channelName) channels.add(channelName.value);
          else if (channelName && "ref" in channelName) addRef(channelName.ref);
        } else if (
          tokens[j]!.type === "ident" &&
          is(j + 1, "(") &&
          context.methodCalls?.().get(j)?.api.startsWith("ipcRenderer.")
        ) {
          // a method of a wrapper class or object that forwards an argument as the channel
          const arg = context.methodCalls().get(j)!.arg;
          const channelName = context.constants.resolveArg(arg) ?? nameValue(arg);
          if (channelName && "value" in channelName) channels.add(channelName.value);
          else if (channelName && "ref" in channelName) addRef(channelName.ref);
        } else if (
          tokens[j]!.type === "ident" &&
          is(j + 1, "(") &&
          context.aliases.get(j) === tokens[j]!.value &&
          context.wrappers.get(tokens[j]!.value)?.startsWith("ipcRenderer.")
        ) {
          // a helper of the file that forwards its first argument as the channel
          const channelName = context.constants.resolveArg(j + 2) ?? nameValue(j + 2);
          if (channelName && "value" in channelName) channels.add(channelName.value);
          else if (channelName && "ref" in channelName) addRef(channelName.ref);
        }
      }
      // Two different channels in one member: which one it forwards to is not decidable here.
      const only = channels.size + refs.length === 1;
      push(
        name,
        only && channels.size === 1 ? [...channels][0]! : null,
        line,
        only && refs.length === 1 ? refs[0] : undefined,
        // a call of a method another module's wrapper may make the member's call (filled in
        // once modules are known); none was read here
        !channels.size && !refs.length && calls && end - from <= MAX_BODY_TOKENS
          ? { body: [from, end] }
          : undefined,
      );
      const row = members.at(-1);
      if (generic && row?.member === name && row.channel === null) {
        row.forwards = generic.method;
        if (generic.allowed) row.allowed = generic.allowed;
        if (generic.prefix !== undefined) row.prefix = generic.prefix;
        if (generic.guard) row.guard = generic.guard;
      }
    };
    /**
     * A member whose value is the name at [k, k + 1) (or, from another module, any expression):
     * an import is read once modules are known; a `const` object literal of the file that nothing
     * writes gives its members under `name.` (three levels at most); a function of the file, or a
     * `const` whose value is a function or a call, gives the channel of the calls in it. False when
     * it is none of these (the caller reads the value as written).
     */
    const memberValue = (
      name: string,
      [k, to]: [number, number],
      line: number,
      level: number,
    ): boolean => {
      if (to !== k + 1 || tokens[k]?.type !== "ident") {
        if (to <= k) return false;
        // an expression of another module's export: as a member's value is read
        pushChannels(name, k, to, line);
        return true;
      }
      const ref = moduleValueRef(k);
      if (ref) {
        push(name, null, line, undefined, { valueRef: ref });
        return true;
      }
      const local = localValue(k);
      if (!local) return false;
      if (local.object !== undefined) {
        if (level >= 3) return false;
        if (!walk(local.object, level + 1, name)) truncated = true;
        return true;
      }
      const generic = forwarderOf(local.from, local.to);
      if (generic && forwarders.length < MAX_BRIDGE_PER_FILE)
        forwarders.push({ api, path: name, ...generic, file, line });
      pushChannels(name, local.from, local.to, line, generic);
      return true;
    };
    /** Walks the members of the object literal at `objectOpen`; spreads of named objects inside. */
    const walk = (objectOpen: number, level: number, prefix: string | null = null): boolean => {
      let start = objectOpen + 1;
      const flush = (end: number): void => {
        const from = start;
        start = end + 1;
        readMember(from, end, level, objectOpen, prefix);
      };
      let depth = 0;
      for (let k = objectOpen; k < tokens.length && budget > 0; k++, budget--) {
        const p = tokens[k]!;
        if (p.type !== "punct") continue;
        if (p.value === "{" || p.value === "(" || p.value === "[") depth++;
        else if (p.value === "}" || p.value === ")" || p.value === "]") {
          depth--;
          if (depth === 0) {
            flush(k);
            return true;
          }
        } else if (p.value === "," && depth === 1) flush(k);
      }
      return false;
    };
    if (virtual) {
      /** A value of this file under the virtual's prefix: its members, or one member. */
      const valueIn = (prefix: string | null, [a, b]: [number, number]): void => {
        if (is(a, "{") && openOf(b - 1) === a) {
          if (!walk(a, 0, prefix)) truncated = true;
        } else if (prefix === null) {
          // the whole exposed value: an object of the file by name, else not read
          const local = b === a + 1 ? localValue(a) : null;
          if (local?.object !== undefined) {
            if (!walk(local.object, 0, null)) truncated = true;
          } else {
            const ref = b === a + 1 ? moduleValueRef(a) : null;
            push(null, null, virtual.line, undefined, ref ? { valueRef: ref } : undefined);
          }
        } else if (!memberValue(prefix, [a, b], tokens[a]?.line ?? virtual.line, 0))
          pushChannels(prefix, a, b, tokens[a]?.line ?? virtual.line);
      };
      if (virtual.export !== undefined) {
        const found = exportValue(virtual.export);
        if (!found) unfound = true;
        else if ("value" in found) valueIn(virtual.prefix, found.value);
        else
          for (const { name, value: exported } of found.names)
            valueIn(qualify(virtual.prefix, name), exported);
      } else if (virtual.open !== undefined) {
        if (!walk(virtual.open, 0, virtual.prefix)) truncated = true;
      } else if (virtual.value) valueIn(virtual.prefix, virtual.value);
      return;
    }
    for (const open of opens) if (!walk(open, 0)) truncated = true;
    // An object put together in steps: `api.onChange = (fn) => …` after `const api = {…}`.
    const objectName =
      simple && tokens[at + 2]?.type === "ident" && is(at + 3, ")") ? tokens[at + 2]!.value : null;
    // contextBridge copies the object when it is exposed: only what is written before the call,
    // in the same function body, is a member. A write after it (also one of a second exposure of
    // the same object) is not exposed; a write inside another function (a callback, a helper
    // that may run before the call) cannot be placed, and is one unreadable entry.
    const stepKey = `${objectName}\u0000${i}`;
    if (objectName && !stepwise.has(stepKey)) {
      stepwise.add(stepKey);
      budget -= tokens.length;
      resolver ??= new ExpressionResolver(tokens, context.constants);
      const r = resolver;
      const callDef = r.functionAt(i);
      const callFunction = callDef?.paramsAt ?? -1;
      let unplaced = false;
      /**
       * The function a write at k is in, past the callbacks of array methods there
       * (`Object.keys(T).forEach((k) => { api[k] = … })`), which run where they are written: its
       * `paramsAt`, -1 at the top of the file, or null for a function guard could not climb.
       */
      const homeOf = (k: number): FnDef | null | undefined => {
        let d = r.functionAt(k);
        for (let guard = 0; d && d.paramsAt !== callFunction; guard++) {
          if (guard > 8 || !d.calledBy || !SYNC_CALLBACKS.has(d.calledBy.method)) return d;
          d = r.outerOf(d);
        }
        return d;
      };
      /**
       * Where a function of the top of the file runs, when every use of it is there: a function
       * declared (`function setup() {…}`, `const go = () => {…}`) whose every other mention is at
       * the top, not inside a function (`at` the first mention, `last` the last; `direct`: every
       * one is a call `go()`; else it is handed on, `setTimeout(later)`, and runs later), or a
       * function written in place at the top (a
       * listener `window.addEventListener("DOMContentLoaded", () => {…})`, an IIFE): it runs from
       * where it is written, at once or later (`registered`). Null otherwise.
       */
      const runsAt = (def: FnDef): { at: number; last: number; direct: boolean } | null => {
        if (r.outerOf(def)) return null;
        const name = def.name;
        const declared =
          name !== null &&
          (tokens[def.paramsAt - 2]?.value === "function" ||
            (is(def.paramsAt - 1, "=") && tokens[def.paramsAt - 2]?.value === name));
        if (!declared) return { at: def.paramsAt, last: def.paramsAt, direct: false };
        const uses = r
          .namePositions(name)
          .filter((j) => j !== def.paramsAt - 1 && j !== def.paramsAt - 2 && !is(j - 1, "."));
        if (!uses.length || uses.some((j) => r.functionAt(j))) return null;
        return { at: uses[0]!, last: uses.at(-1)!, direct: uses.every((j) => is(j + 1, "(")) };
      };
      /** A function written where it is called: `(function () {…})()`, `(() => {…})()`. */
      const iife = (def: FnDef): boolean => {
        const end = def.body[1];
        return is(end, "(") || (is(end, ")") && is(end + 1, "("));
      };
      /** Where the exposure happens at the top of the file, when its function runs from there. */
      const exposedFrom = callDef ? runsAt(callDef) : null;
      /** The loop bodies around the call (`for (…) { … }`, `while`, `do`), as [open, close]. */
      const loops: Array<[number, number]> = [];
      for (let p = r.bracketAround(i), guard = 0; p > 0 && guard < 64; guard++) {
        if (callDef && p <= callDef.paramsAt) break;
        if (is(p, "{")) {
          const head = is(p - 1, ")") ? r.openOf(p - 1) : -1;
          const word = head > 0 ? tokens[head - 1]?.value : tokens[p - 1]?.value;
          if (word === "for" || word === "while" || word === "do") loops.push([p, r.closeOf(p)]);
        }
        p = r.bracketAround(p);
      }
      {
        // `for (…) a(), expose(…), api.x = …;` and `for (…) if (c) expose(…);`: a loop without
        // braces whose body is the statement the call stands in
        let from = i;
        for (let guard = 0; guard < 8; guard++) {
          const { head, loop } = statementOf(from);
          if (head === null || head < 0) break;
          if (loop) {
            let end = i;
            for (let d = 0; end < tokens.length && end < i + 20_000; end++) {
              const x = tokens[end]!;
              if (x.type !== "punct") continue;
              if (x.value === "(" || x.value === "[" || x.value === "{") d++;
              else if (x.value === ")" || x.value === "]" || x.value === "}") {
                if (d === 0) break;
                d--;
              } else if (x.value === ";" && d === 0) break;
            }
            loops.push([head, end]);
            break;
          }
          from = is(head, ")") ? openOf(head) - 1 : head;
        }
      }
      /** `before`: a member; `after`: not exposed; `elsewhere`: cannot be placed. */
      // A write before the name was given the exposed object went to the object it held then.
      const placeOf = (k: number): "before" | "after" | "elsewhere" => {
        // a write in the loop the exposure is in may run before it in a later round
        if (loops.some(([open, close]) => k > open && k < close)) return "elsewhere";
        const home = homeOf(k);
        const homeAt = home?.paramsAt ?? -1;
        if (homeAt === callFunction) return k < i && k > replacedAt ? "before" : "after";
        // the exposure runs from the top of the file: a write at the top, before that place
        if (exposedFrom && homeAt === -1) {
          if (k < exposedFrom.at && k > replacedAt) return "before";
          // between two calls (`if (a) expose(); api.c = …; if (!a) expose();`): exposed by the
          // later one, or not, as the conditions decide
          if (k < exposedFrom.last) return "elsewhere";
          return exposedFrom.direct ? "after" : "elsewhere";
        }
        // a write in a function that runs from the top before the exposure (`setup()` called
        // there, an IIFE); after it, or in any other function, it cannot be placed
        if (home && (callFunction === -1 || exposedFrom)) {
          const ran = runsAt(home);
          const until = exposedFrom ? exposedFrom.at : i;
          if (ran && ran.at < until && ran.at > replacedAt && (ran.direct || iife(home)))
            return "before";
        }
        return "elsewhere";
      };
      const unreadable = (k: number): void => {
        if (unplaced) return;
        unplaced = true;
        push(null, null, tokens[k]!.line);
      };
      /**
       * Whether the name at k is the binding the exposed object is (`same`), another one (a
       * parameter or local of the same name, as minifiers reuse short names), or not decided.
       */
      const exposedAt = at + 2;
      let exposed: Binding | null | undefined;
      const sameObject = (k: number): "same" | "other" | "unknown" => {
        resolver ??= new ExpressionResolver(tokens, context.constants);
        // the object is written to member by member, so its declaration is read despite writes
        exposed ??= resolver.binding(exposedAt, objectName, true);
        const here = resolver.binding(k, objectName, true);
        if (!exposed || !here) return "unknown";
        return bindingKey(exposed) === bindingKey(here) ? "same" : "other";
      };
      if (budget <= 0) truncated = true;
      else
        for (let k = 0; k + 3 < tokens.length; k++) {
          // `api[name] = (...a) => ipcRenderer.invoke(channel, ...a)` once per entry of a table
          // a loop runs over: one member per key; anything else there is an unreadable entry
          if (
            tokens[k]!.type === "ident" &&
            tokens[k]!.value === objectName &&
            !is(k - 1, ".") &&
            is(k + 1, "[")
          ) {
            // every occurrence is charged before anything is read for it: many `x[…]` stay
            // linear, and past the budget the object's inventory is marked as cut
            if (budget <= 0) {
              truncated = true;
              break;
            }
            budget -= BRIDGE_STEP_COST;
            resolver ??= new ExpressionResolver(tokens, context.constants);
            // the bracket's match from the resolver's table, not a walk
            const close = resolver.closeOf(k + 1);
            if (close === -1 || !is(close + 1, "=") || is(close + 2, "=")) continue;
            // only a write to the exposed object itself (the scope reading is charged to the
            // resolver's own work; a write to another binding of the name costs no more here)
            const which = sameObject(k);
            if (which === "unknown" && resolver.exhausted()) {
              truncated = true;
              break;
            }
            if (which !== "same") continue;
            const place = placeOf(k);
            if (place === "after") continue;
            if (place === "elsewhere") {
              unreadable(k);
              continue;
            }
            budget -= BRIDGE_ROUND_COST;
            if (budget <= 0) {
              truncated = true;
              break;
            }
            const rounds = resolver.loopAssignments(k);
            if (!rounds) push(null, null, tokens[k]!.line);
            else
              for (const { key, value: round } of rounds) {
                const call = resolver.forwardCall(round, isRenderer, CHANNEL_CALLS);
                push(key, call?.channels?.length === 1 ? call.channels[0]! : null, tokens[k]!.line);
              }
            continue;
          }
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
          // a write to another binding of the same name (`function (e) { e.A = 1 }` in a file
          // whose exposed object is a `const e` elsewhere) is no member; the scope is read
          // within the resolver's own work; only a write that stays a member is charged here
          const which = sameObject(k);
          if (which === "other") continue;
          const place = placeOf(k);
          if (place === "after") continue;
          if (place === "elsewhere") {
            unreadable(k);
            continue;
          }
          budget -= BRIDGE_SCOPE_COST;
          if (budget <= 0) {
            truncated = true;
            break;
          }
          readMember(k + 2, end, 0, -1);
        }
    }
  };
  if (virtuals) for (const v of virtuals) exposure(v.open ?? v.value?.[0] ?? 0, v);
  else
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i]!;
      if (t.type !== "ident") continue;
      if (t.value !== "exposeInMainWorld" && t.value !== "exposeInIsolatedWorld") continue;
      if (!(is(i - 1, ".") || is(i - 1, "?.")) || !is(i + 1, "(")) continue;
      exposure(i);
    }
  return {
    members,
    exposures,
    truncated,
    ...(unfound ? { unfound: true as const } : {}),
    ...(forwarders.length ? { forwarders } : {}),
  };
}

/** Modules opened for bridge values of other modules, per analysis. */
const MAX_BRIDGE_MODULES = 64;
/** Rounds of following a bridge value into another module (`auth` in `ipc` in the preload). */
const MAX_BRIDGE_DEPTH = 3;
/** Importers of one module checked for writes to the exported value. */
const MAX_BRIDGE_IMPORTERS = 64;

/**
 * Reads the contextBridge entries whose value is another module's export (`valueRef`) in that
 * module, with the member rules of `bridgeMembers` there, and puts its members in their place
 * (`contextBridge` is changed in place). An entry stays as it is, and is named in `unread`, when
 * the module is not among the files (a package, a file outside the app), cannot be read, does not
 * define the export once, when a module that imports it may change it (a write to the export's
 * members or a call of `Object.assign` and the like on it), or past the limits; `capped` when a
 * read was cut. Nothing is run.
 */
function linkBridgeValues(input: {
  contextBridge: BridgeMember[];
  edges: readonly JsEdge[];
  resolve(from: string, specifier: string): string | null;
  read(path: string): string;
  open(path: string): ReadModule | null;
}): {
  unread: string[];
  /**
   * Where the members of `unread` would be, as `file:line`: the exposing entry and, when it was
   * located, the module that defines the value (`file:1`).
   */
  unreadAt: string[];
  /**
   * An entry of `unread` whose module was not located or lies deeper than is read: its members
   * may be in any file, so `unreadAt` is not where they all are.
   */
  unreadAnywhere: boolean;
  exposures: BridgeExposure[];
  forwarders: BridgeForwarder[];
  capped: boolean;
} {
  const { contextBridge } = input;
  const unread: string[] = [];
  const unreadAt: string[] = [];
  let unreadAnywhere = false;
  const exposures: BridgeExposure[] = [];
  const forwarders: BridgeForwarder[] = [];
  let capped = false;
  if (!contextBridge.some((b) => b.valueRef))
    return { unread, unreadAt, unreadAnywhere, exposures, forwarders, capped };
  const sources = new Map<
    string,
    { tokens: Token[]; truncated: boolean; context: ScanContext } | null
  >();
  const source = (
    path: string,
  ): { tokens: Token[]; truncated: boolean; context: ScanContext } | null => {
    if (!sources.has(path)) {
      let got: { tokens: Token[]; truncated: boolean; context: ScanContext } | null = null;
      if (sources.size < MAX_BRIDGE_MODULES)
        try {
          scanJavaScript(input.read(path), {
            onTokens: (tokens, truncated, context) => {
              got = { tokens, truncated, context };
            },
          });
        } catch {
          got = null;
        }
      // past the limit the value is named in `unread`, not a cut inventory
      sources.set(path, got);
    }
    return sources.get(path) ?? null;
  };
  /** Whether a module importing `target` (other than `except`) writes the export `property`. */
  const writtenElsewhere = new Map<string, boolean>();
  const changedByImporters = (target: string, property: string, except: string): boolean => {
    const key = `${target}\u0000${property}\u0000${except}`;
    const known = writtenElsewhere.get(key);
    if (known !== undefined) return known;
    const importers = [
      ...new Set(input.edges.filter((e) => e.resolved && e.to === target).map((e) => e.from)),
    ].filter((f) => f !== except && f !== target);
    let written = importers.length > MAX_BRIDGE_IMPORTERS;
    for (const file of importers.slice(0, MAX_BRIDGE_IMPORTERS)) {
      if (written) break;
      const m = input.open(file);
      if (!m) {
        written = true;
        break;
      }
      const { tokens, constants } = m;
      // `import * as base from "./base"`: its members are the module's exports
      const namespaces = new Set<string>();
      for (let j = 0; j + 5 < tokens.length; j++)
        if (
          tokens[j]!.value === "import" &&
          tokens[j + 1]!.value === "*" &&
          tokens[j + 2]!.value === "as" &&
          tokens[j + 4]!.value === "from" &&
          tokens[j + 5]!.type === "string" &&
          input.resolve(file, tokens[j + 5]!.value) === target
        )
          namespaces.add(tokens[j + 3]!.value);
      for (let j = 0; j < tokens.length && !written; j++) {
        const t = tokens[j]!;
        if (t.type !== "ident") continue;
        const member = writesMember(tokens, j);
        if (member === null && !writtenByCallAt(tokens, j)) continue;
        if (namespaces.has(t.value) && tokens[j - 1]?.value !== ".") {
          written =
            property === "*" ||
            property === "default" ||
            member === property ||
            member === "*" ||
            member === null;
          continue;
        }
        const named = constants.importOf(t.value, j);
        if (named && input.resolve(file, named.specifier) === target) {
          if (named.property === property) written = true;
          continue;
        }
        const whole = constants.requireOf(t.value, j);
        if (whole && input.resolve(file, whole) === target)
          written =
            property === "*" || property === "default" || member === property || member === "*";
      }
    }
    writtenElsewhere.set(key, written);
    return written;
  };
  for (let round = 0; round <= MAX_BRIDGE_DEPTH; round++) {
    const pending = contextBridge.filter((b) => b.valueRef);
    if (!pending.length) break;
    const replaced = new Map<BridgeMember, BridgeMember[]>();
    for (const b of pending) {
      const ref = b.valueRef!;
      delete b.valueRef;
      const named = `${ref.property === "*" ? "the exports" : ref.property === "default" ? "the default export" : ref.property} of "${ref.specifier}" (from ${b.file}:${b.line})`;
      const target = input.resolve(b.file, ref.specifier);
      const at = (): void => {
        for (const place of [`${b.file}:${b.line}`, ...(target ? [`${target}:1`] : [])])
          if (!unreadAt.includes(place)) unreadAt.push(place);
      };
      if (round === MAX_BRIDGE_DEPTH) {
        unread.push(`${named}: more than ${MAX_BRIDGE_DEPTH} modules deep`);
        // the module the members are in is further down, so they may be in any file
        unreadAnywhere = true;
        continue;
      }
      if (!target) {
        unread.push(`${named}: not among the files read`);
        // the other build may locate it in a file of its own, so they may be in any file
        unreadAnywhere = true;
        continue;
      }
      if (changedByImporters(target, ref.property, b.file)) {
        unread.push(`${named}: another module that imports ${target} may change it`);
        at();
        continue;
      }
      const src = source(target);
      if (!src) {
        unread.push(
          `${named}: ${target} could not be read${sources.size >= MAX_BRIDGE_MODULES ? ` (or more than ${MAX_BRIDGE_MODULES} modules were opened)` : ""}`,
        );
        at();
        continue;
      }
      const scan = bridgeMembers(src, target, [
        { api: b.api, world: b.world, prefix: b.member, export: ref.property, line: b.line },
      ]);
      if (scan.unfound) {
        unread.push(`${named}: ${target} does not define it once where it can be read`);
        at();
        continue;
      }
      if (scan.truncated) capped = true;
      exposures.push(...scan.exposures);
      forwarders.push(...(scan.forwarders ?? []));
      replaced.set(b, scan.members);
    }
    if (!replaced.size) continue;
    const next: BridgeMember[] = [];
    for (const b of contextBridge) next.push(...(replaced.get(b) ?? [b]));
    if (next.length > MAX_BRIDGE) capped = true;
    contextBridge.length = 0;
    contextBridge.push(...next.slice(0, MAX_BRIDGE));
  }
  return { unread, unreadAt, unreadAnywhere, exposures, forwarders, capped };
}

/** Page scripts read for calls of generic bridge forwarders, per analysis. */
const MAX_BRIDGE_CALL_FILES = 200;
/** Tokens of those page scripts, in all. */
const BRIDGE_CALL_WORK = 5_000_000;
/** Calls of generic forwarders read per file. */
const MAX_BRIDGE_CALLS_PER_FILE = 2000;
/** Objects a page script reaches globals through. */
const GLOBAL_HOSTS = new Set(["window", "globalThis", "self"]);
/** Work charged for reading the scope of one use of an alias of the bridge. */
const BRIDGE_BINDING_COST = 64;

/**
 * The page scripts' calls of generic forwarders a preload exposes (R1): `window.api.invoke("x")`,
 * `globalThis.api.invoke("x")`, `api.invoke("x")` where the file binds no `api`, `const X =
 * window.api; X.invoke("x")`, `const { api } = window; api.invoke("x")`, `const { invoke } =
 * window.api; invoke("x")`, and the same with `?.` and nested members (`window.electron
 * .ipcRenderer.sendMessage("x")`). One row per call in the calling file, with the forwarded IPC
 * method as `api`, `via: "bridge"`, `member` and the channel the first argument names. Read in
 * the files that are not main-process files and do not expose the api themselves. A path that
 * the preloads expose differently (another method, another check) gives no rows and is named in
 * `ambiguous`.
 */
function bridgeCallRows(input: {
  forwarders: readonly BridgeForwarder[];
  contextBridge: readonly BridgeMember[];
  modules: readonly JsModule[];
  text(path: string): string | null;
  open(path: string): ReadModule | null;
  resolve(from: string, specifier: string): string | null;
}): {
  rows: Map<string, IpcUsage[]>;
  ambiguous: string[];
  /** The page scripts read that name an api of an `ambiguous` path: where its calls are. */
  ambiguousFiles: string[];
  capped: string[];
  unread: string[];
  unreadFiles: string[];
  writes: string[];
} {
  const rows = new Map<string, IpcUsage[]>();
  const ambiguous: string[] = [];
  const ambiguousApis = new Set<string>();
  const capped: string[] = [];
  if (!input.forwarders.length)
    return {
      rows,
      ambiguous,
      ambiguousFiles: [],
      capped,
      unread: [],
      unreadFiles: [],
      writes: [],
    };
  // one forwarder per api and path, the same in every preload that exposes it
  const byPath = new Map<string, BridgeForwarder | null>();
  const sig = (f: BridgeForwarder): string =>
    JSON.stringify([f.method, f.allowed ?? null, f.prefix ?? null, f.guard ?? null, !!f.exitFirst]);
  for (const f of input.forwarders) {
    const key = `${f.api}\u0000${f.path}`;
    const have = byPath.get(key);
    if (have === undefined) byPath.set(key, f);
    else if (have !== null && sig(have) !== sig(f)) byPath.set(key, null);
  }
  for (const [key, f] of byPath) {
    const [api, path] = key.split("\u0000") as [string, string];
    // another preload exposes the member under the same name without forwarding it
    // another preload (or a part of this exposure) gives the api something else at that path: a
    // plain member, a member whose value holds it (`ipcRenderer` for `ipcRenderer.send`), or a
    // value that was not read (`build(ipcRenderer)`, a spread), which may hold anything
    const plain = input.contextBridge.some(
      (b) =>
        b.api === api &&
        f !== null &&
        (b.member === null ||
          (b.file !== f.file &&
            ((b.member === path && !b.forwards) || path.startsWith(`${b.member}.`)))),
    );
    if (f === null || plain) {
      byPath.set(key, null);
      ambiguous.push(`window.${api}.${path}`);
      ambiguousApis.add(api);
    }
  }
  const apis = [...new Set(input.forwarders.map((f) => f.api))].filter((a) =>
    /^[A-Za-z_$][\w$]*$/.test(a),
  );
  const exposing = new Set(input.contextBridge.map((b) => b.file));
  for (const f of input.forwarders) exposing.add(f.file);
  let work = BRIDGE_CALL_WORK;
  let files = 0;
  // The page scripts, and the writes in them that may give an exposed api another value as a
  // global (`window.api = …`, `window["api"] = …`, `Object.assign(window, { api })`,
  // `Object.defineProperty(window, "api", …)`, a classic script's top-level `var api = …` or an
  // unbound `api = …`): which pages load a script is not read, so every page row stays and each
  // such write is named. Worker scripts (`new Worker("w.js")`, located from the calling file),
  // files that take ipcMain from electron and files with a `with` statement are not read, and
  // named.
  const unread: string[] = [];
  /** The files of `unread` whose page calls are not read (a worker that was not located has none). */
  const unreadFiles: string[] = [];
  const workers = new Set<string>();
  const pages: Array<{ m: JsModule; named: string[]; read: ReadModule }> = [];
  const writes: string[] = [];
  const replace = (file: string, what: string): void => {
    const note = `${what} in ${file}`;
    if (!writes.includes(note)) writes.push(note);
  };
  for (const m of input.modules) {
    const text = m.role === "main" || exposing.has(m.id) ? null : input.text(m.id);
    if (text === null) continue;
    for (const w of text.matchAll(
      /new\s+(?:Shared)?Worker\s*\(\s*(?:new\s+URL\s*\(\s*)?["'`]([^"'`]+)["'`]/g,
    )) {
      const spec = w[1]!;
      const target = input.resolve(
        m.id,
        spec.startsWith(".") || spec.startsWith("/") ? spec : `./${spec}`,
      );
      if (target) workers.add(target);
      else
        unread.push(
          `${spec} (a worker script named in ${m.id} that was not located: its calls may be read as a page's)`,
        );
    }
    const named = apis.filter((a) => text.includes(a));
    if (!named.length) continue;
    if (files >= MAX_BRIDGE_CALL_FILES || work <= 0) {
      capped.push(m.id);
      continue;
    }
    files++;
    const read = input.open(m.id);
    if (!read) continue;
    work -= read.tokens.length;
    const { tokens, resolver: r } = read;
    const is = (k: number, v: string): boolean =>
      tokens[k]?.type === "punct" && tokens[k]!.value === v;
    // a file that takes ipcMain from electron runs in the main process
    if (takesIpcMain(tokens)) {
      unread.push(`${m.id} (takes ipcMain from electron)`);
      unreadFiles.push(m.id);
      continue;
    }
    pages.push({ m, named, read });
    // a CommonJS or ES module keeps its top-level names to itself; only a classic script's are globals
    const moduleScoped = tokens.some(
      (t, k) =>
        t.type === "ident" &&
        (((t.value === "require" || t.value === "import") && tokens[k + 1]?.value === "(") ||
          (t.value === "export" && !is(k - 1, ".")) ||
          (t.value === "import" &&
            (tokens[k + 1]?.type === "string" ||
              tokens[k + 1]?.type === "ident" ||
              is(k + 1, "{") ||
              is(k + 1, "*")))),
    );
    for (const api of named)
      for (const j of r.namePositions(api)) {
        work--;
        const host =
          GLOBAL_HOSTS.has(tokens[j - 2]?.value ?? "") &&
          r.binding(j - 2, tokens[j - 2]!.value, true) === null;
        // `window.api = …`, `window.api.m = …`
        if (host && (is(j - 1, ".") || is(j - 1, "?.")) && writesMember(tokens, j - 2) === api) {
          replace(m.id, `window.${api} written`);
          continue;
        }
        if (is(j - 1, ".") || is(j - 1, "?.") || moduleScoped) continue;
        // a classic script's own global: declared at its top, or assigned where nothing binds it
        const before = tokens[j - 1]?.value;
        const declares =
          before === "var" ||
          before === "let" ||
          before === "const" ||
          before === "function" ||
          before === "class";
        // `var api;` alone gives the global no value (an existing one stays)
        const valued = before === "function" || before === "class" || is(j + 1, "=");
        const alias =
          is(j + 1, "=") &&
          GLOBAL_HOSTS.has(tokens[j + 2]?.value ?? "") &&
          is(j + 3, ".") &&
          tokens[j + 4]?.value === api;
        if (declares && valued && r.functionAt(j) === null && r.bracketAround(j) === -1 && !alias)
          replace(m.id, `${api} declared at the top of a script`);
        else if (
          !declares &&
          writesName(tokens, j) &&
          r.binding(j, api, true) === null &&
          !r.paramAround(j, api)
        )
          replace(m.id, `${api} assigned as a global`);
      }
    // `window["api"] = …`, `Object.assign(window, { api })`, `Object.defineProperty(window, "api", …)`
    for (let j = 0; j + 3 < tokens.length; j++) {
      const t = tokens[j]!;
      if (t.type !== "ident" || !GLOBAL_HOSTS.has(t.value) || is(j - 1, ".")) continue;
      if (r.binding(j, t.value, true) !== null) continue;
      if (
        is(j + 1, "[") &&
        tokens[j + 2]?.type === "string" &&
        is(j + 3, "]") &&
        writesMember(tokens, j) !== null &&
        named.includes(tokens[j + 2]!.value)
      )
        replace(m.id, `${t.value}["${tokens[j + 2]!.value}"] written`);
      if (is(j - 1, "(") && writtenByCallAt(tokens, j)) {
        // the keys the call can give the global: a literal, or (unknown) every api
        const close = r.closeOf(j - 1);
        const keys = new Set<string>();
        let open = close === -1;
        for (let q = j + 1; q < close; q++)
          if (tokens[q]!.type === "string" || tokens[q]!.type === "ident")
            keys.add(tokens[q]!.value);
          else if (is(q, "...") || is(q, "[")) open = true;
        for (const api of named)
          if (open || keys.has(api))
            replace(m.id, `${t.value} changed by ${tokens[j - 2]?.value ?? "a call"}`);
      }
    }
  }
  for (const { m, named: all, read } of pages) {
    const named = all;
    if (!named.length) continue;
    if (workers.has(m.id)) {
      unread.push(`${m.id} (a worker script: no bridge there)`);
      unreadFiles.push(m.id);
      continue;
    }
    const { tokens, constants, resolver: r } = read;
    // `with (obj) { api.m() }` may be `obj.api`: such a file is not read
    if (
      tokens.some(
        (t, k) => t.type === "ident" && t.value === "with" && tokens[k + 1]?.value === "(",
      )
    ) {
      unread.push(`${m.id} (a with statement: a name may be a member of its object)`);
      unreadFiles.push(m.id);
      continue;
    }
    const is = (k: number, v: string): boolean =>
      tokens[k]?.type === "punct" && tokens[k]!.value === v;
    const dot = (k: number): boolean => is(k, ".") || is(k, "?.");
    const ident = (k: number): string | null =>
      tokens[k]?.type === "ident" ? tokens[k]!.value : null;
    /** The name at k is a global of the page here: no binding, import or parameter of it. */
    const global = (k: number): boolean => {
      const n = ident(k);
      if (n === null || dot(k - 1)) return false;
      return (
        r.binding(k, n, true) === null &&
        r.boundAround(k, n) === null &&
        constants.importOf(n, k) === null &&
        constants.requireOf(n, k) === null
      );
    };
    /** `window.api` (also `globalThis`, `self`, with `?.`) ending at k, whose host is a global. */
    const hosted = (k: number): boolean =>
      dot(k - 1) && GLOBAL_HOSTS.has(ident(k - 2) ?? "") && global(k - 2);
    const out: IpcUsage[] = [];
    const seen = new Set<number>();
    /** A call of a forwarder through the chain that starts after `base` (the api), with `prefix` members read already. */
    const readCall = (api: string, base: number, prefix: string[]): void => {
      if (seen.has(base)) return;
      seen.add(base);
      if (out.length >= MAX_BRIDGE_CALLS_PER_FILE) {
        if (!capped.includes(m.id)) capped.push(m.id);
        return;
      }
      const path = [...prefix];
      let j = base + 1;
      while (dot(j) && ident(j + 1) && path.length < 4) {
        path.push(ident(j + 1)!);
        j += 2;
      }
      // `x.m?.("ch")`
      const open = is(j, "(") ? j : is(j, "?.") && is(j + 1, "(") ? j + 1 : -1;
      if (open === -1 || !path.length) return;
      const f = byPath.get(`${api}\u0000${path.join(".")}`);
      if (!f) return;
      const arg = open + 1;
      if (is(arg, ")")) return;
      const channelArgOf = channelArg(tokens, constants, arg);
      let channels: Array<string | null> = [];
      let ref: IpcUsage["channelRef"];
      if (channelArgOf && "value" in channelArgOf) channels = [channelArgOf.value];
      else if (channelArgOf && "ref" in channelArgOf) {
        channels = [null];
        ref = channelArgOf.ref;
      } else {
        const found = r.resolveArgument(arg);
        channels = found && !found.partial && found.values.length ? found.values : [null];
      }
      for (const channel of channels) {
        const usage: IpcUsage = {
          api: f.method,
          channel,
          line: tokens[base]!.line,
          via: "bridge",
          member: `${api}.${path.join(".")}`,
        };
        if (ref) usage.channelRef = ref;
        if (channel !== null && (f.allowed || f.prefix !== undefined || f.guard)) {
          const ok =
            (f.allowed === undefined || f.allowed.includes(channel)) &&
            (f.prefix === undefined || channel.startsWith(f.prefix));
          // with other uses of the channel (`guard`), a refused channel surely stops only at an
          // exit-first check; around the call, the other path may forward it (#221 review)
          usage.allowed = !ok
            ? f.guard && !f.exitFirst
              ? "unknown"
              : "no"
            : f.guard
              ? "unknown"
              : "yes";
        }
        out.push(usage);
      }
    };
    /** Locals that hold the api or a member of it, read once per name after the api names. */
    const locals = new Map<
      string,
      Array<{
        decl: number;
        api: string;
        prefix: string[];
        pattern?: string;
        from?: number;
        value?: [number, number];
      }>
    >();
    const addLocal = (
      name: string,
      decl: number,
      how: {
        api: string;
        prefix: string[];
        pattern?: string;
        from?: number;
        value?: [number, number];
      },
    ): void => {
      const held = locals.get(name) ?? [];
      if (held.length < 64) held.push({ decl, ...how });
      locals.set(name, held);
    };
    for (const api of named) {
      const positions = r.namePositions(api);
      // a write of the api in the file (`window.api = …`, `api = …`): what it holds is not the bridge
      // (writes that replace the global are read above, per page)
      for (const j of positions) {
        if (hosted(j) || global(j)) {
          readCall(api, j, []);
          continue;
        }
        if (dot(j - 1)) continue;
        // `const X = window.api`, `const { api } = window`, `const { invoke } = window.api`
        const b = r.binding(j, api);
        if (
          b?.kind === "pattern" &&
          b.key === api &&
          b.from[1] === b.from[0] + 1 &&
          GLOBAL_HOSTS.has(ident(b.from[0]) ?? "") &&
          global(b.from[0])
        )
          readCall(api, j, []);
      }
      // `const { api: e } = window`, as minifiers write it: the local is the api
      for (const j of positions) {
        if (!(is(j - 1, "{") || is(j - 1, ","))) continue;
        const local =
          is(j + 1, ":") && ident(j + 2) ? j + 2 : is(j + 1, ",") || is(j + 1, "}") ? j : -1;
        if (local === -1) continue;
        const open = r.bracketAround(j);
        const close = open >= 0 && is(open, "{") ? r.closeOf(open) : -1;
        if (close === -1 || !is(close + 1, "=") || !GLOBAL_HOSTS.has(ident(close + 2) ?? ""))
          continue;
        if (!global(close + 2) || dot(close + 3)) continue;
        addLocal(ident(local)!, local, { api, prefix: [], pattern: api, from: close + 2 });
      }
      // aliases: `X = window.api` and patterns of members `{ invoke: call } = window.api`
      for (const j of positions) {
        if (!hosted(j) || !is(j - 3, "=") || ident(j - 4) === null || dot(j - 5)) continue;
        if (
          !(
            is(j + 1, ";") ||
            is(j + 1, ",") ||
            is(j + 1, ")") ||
            tokens[j + 1]?.line !== tokens[j]!.line
          )
        )
          continue;
        addLocal(ident(j - 4)!, j - 4, { api, prefix: [], value: [j - 2, j + 1] });
      }
      for (const j of positions) {
        if (!hosted(j) || !is(j - 3, "=") || !is(j - 4, "}")) continue;
        // `const { invoke, send: s } = window.api`: each local is a member of the api
        const close = j - 4;
        const openAt = r.openOf(close);
        if (openAt < 0) continue;
        for (let q = openAt + 1; q < close; q++) {
          if (!(is(q - 1, "{") || is(q - 1, ","))) continue;
          const key = ident(q) ?? textOf(tokens[q]);
          if (key === null) continue;
          const local =
            is(q + 1, ":") && ident(q + 2) ? q + 2 : is(q + 1, ",") || q + 1 === close ? q : -1;
          if (local === -1) continue;
          addLocal(ident(local)!, local, { api, prefix: [key], pattern: key, from: j - 2 });
        }
      }
    }
    // each local name once: its uses, each bound by scope to one of its declarations
    for (const [name, decls] of locals) {
      for (const k of r.namePositions(name)) {
        // every use costs a scope reading: charged, so many aliases stay bounded
        work -= BRIDGE_BINDING_COST;
        if (work <= 0) {
          if (!capped.includes(m.id)) capped.push(m.id);
          break;
        }
        if (dot(k - 1) || decls.some((d) => d.decl === k)) continue;
        const bound = r.binding(k, name);
        if (!bound) continue;
        for (const d of decls) {
          const match =
            d.value !== undefined
              ? bound.kind === "value" &&
                bound.range[0] === d.value[0] &&
                bound.range[1] === d.value[1]
              : bound.kind === "pattern" && bound.key === d.pattern && bound.from[0] === d.from;
          if (match) readCall(d.api, k, d.prefix);
        }
      }
    }
    if (out.length) rows.set(m.id, out);
  }
  const ambiguousFiles = pages
    .filter((p) => p.named.some((a) => ambiguousApis.has(a)))
    .map((p) => p.m.id);
  return { rows, ambiguous, ambiguousFiles, capped, unread, unreadFiles, writes };
}

/**
 * The file takes ipcMain from electron: `require("electron").ipcMain`, `const { ipcMain } =
 * require("electron")`, `import { ipcMain } from "electron"`, `electron.ipcMain` with `electron`
 * bound to `require("electron")` (also through an interop helper). A comment or a string that
 * names it is none.
 */
function takesIpcMain(tokens: readonly Token[]): boolean {
  const is = (k: number, v: string): boolean =>
    tokens[k]?.type === "punct" && tokens[k]!.value === v;
  const electronVars = new Set<string>();
  for (let k = 0; k + 3 < tokens.length; k++)
    if (
      tokens[k]!.value === "require" &&
      tokens[k]!.type === "ident" &&
      is(k + 1, "(") &&
      tokens[k + 2]?.type === "string" &&
      tokens[k + 2]!.value === "electron"
    ) {
      // `x = require("electron")`, `x = __toESM(require("electron"))`
      let at = k - 1;
      if (is(at, "(") && tokens[at - 1]?.type === "ident" && tokens[at - 1]!.value !== "require")
        at -= 2;
      if (is(at, "=") && tokens[at - 1]?.type === "ident") electronVars.add(tokens[at - 1]!.value);
      if ((is(k + 4, ".") || is(k + 4, "?.")) && tokens[k + 5]?.value === "ipcMain") return true;
    }
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k]!;
    if (t.type !== "ident" || t.value !== "ipcMain") continue;
    if ((is(k - 1, ".") || is(k - 1, "?.")) && electronVars.has(tokens[k - 2]?.value ?? ""))
      return true;
    if (is(k - 1, "{") || is(k - 1, ",")) {
      let close = k + 1;
      while (close < tokens.length && close < k + 200 && !is(close, "}")) close++;
      const spec =
        tokens[close + 1]?.value === "from"
          ? tokens[close + 2]
          : is(close + 1, "=") && tokens[close + 2]?.value === "require"
            ? tokens[close + 4]
            : undefined;
      if (spec?.type === "string" && spec.value === "electron") return true;
    }
  }
  return false;
}

/**
 * A navigation or new-window handler registered on a webContents: `setWindowOpenHandler(…)`, or a
 * listener for `will-navigate` / `will-frame-navigate`. Whether it checks anything is not read.
 */
export interface NavigationHandler {
  kind: "setWindowOpenHandler" | "will-navigate" | "will-frame-navigate";
  /**
   * Whose webContents: the window's name as `windows` gives it (`win` for
   * `win.webContents.setWindowOpenHandler`), `app` for a handler inside
   * `app.on("web-contents-created", …)`, else the receiver as written.
   */
  target: string;
  /** `window`: a window located in this file; `app`: every webContents; else as written. */
  targetKind: "window" | "app" | "webContents";
  /**
   * The window's name or `app`; null for `targetKind: webContents`. With `kind` and `targetKind`
   * this is the row's identity in a comparison, so a receiver a minifier renames is no change.
   */
  window: string | null;
  /**
   * For `setWindowOpenHandler`: `deny` or `allow` only when every return of the handler is an
   * object literal whose `action` is that string literal; else `unknown`.
   */
  returns?: "deny" | "allow" | "unknown";
  /** The receiver and call as written, shortened. */
  evidence: string;
  file: string;
  line: number;
}

const NAVIGATION_EVENTS = new Set(["will-navigate", "will-frame-navigate"]);
const LISTEN_METHODS = new Set(["on", "once", "addListener", "prependListener"]);
const MAX_NAVIGATION_PER_FILE = 200;
const NAVIGATION_WALK_BUDGET = 2_000_000;
const MAX_CONTENTS_CREATED = 50;

/**
 * What a navigation handler or a remote `enable` call is registered on, read the same way for
 * both: the windows of the file by name, `app` inside a `web-contents-created` callback, else the
 * receiver as written. One work budget for every bracket walk of the file.
 */
function contentsTargets(
  tokens: Token[],
  windowNames: ReadonlySet<string>,
  resolver?: ExpressionResolver,
) {
  const is = (i: number, value: string): boolean =>
    tokens[i]?.type === "punct" && tokens[i]!.value === value;
  const ident = (i: number): string | null =>
    tokens[i]?.type === "ident" ? tokens[i]!.value : null;
  // One budget for every bracket walk of the file: unclosed or repeated handlers stay linear. A
  // walk past it finds no end, so its handler `returns` unknown.
  let work = NAVIGATION_WALK_BUDGET;
  /** The matching closing bracket of the opening one at `open`, or -1. */
  const closeOf = (open: number): number => {
    for (let d = 0, j = open; j < tokens.length && j < open + 200_000; j++) {
      if (--work < 0) return -1;
      const p = tokens[j]!;
      if (p.type !== "punct") continue;
      if (p.value === "(" || p.value === "[" || p.value === "{") d++;
      else if (p.value === ")" || p.value === "]" || p.value === "}") {
        d--;
        if (d === 0) return j;
      }
    }
    return -1;
  };
  /** The parameters and body of a function written at `k`: `(a, b) => …`, `a => …`, `function (a) {…}`. */
  const fnAt = (
    k: number,
  ): { params: string[]; paramsAt: number; body: number; end: number } | null => {
    let j = k;
    if (ident(j) === "async") j++;
    if (ident(j) === "function") {
      j++;
      if (ident(j)) j++;
    }
    const params: string[] = [];
    const paramsAt = j;
    if (is(j, "(")) {
      const close = closeOf(j);
      if (close < 0) return null;
      for (let p = j + 1; p < close; p++)
        if (ident(p) && (is(p - 1, "(") || is(p - 1, ","))) params.push(ident(p)!);
        else if (ident(p) === null && (is(p - 1, "(") || is(p - 1, ","))) params.push("");
      j = close + 1;
    } else if (ident(j) && is(j + 1, "=>")) {
      params.push(ident(j)!);
      j++;
    } else return null;
    if (is(j, "=>")) j++;
    if (is(j, "{")) {
      const end = closeOf(j);
      return end < 0 ? null : { params, paramsAt, body: j, end };
    }
    // an expression body: up to the `,` or `)` that ends the argument
    let end = j;
    for (let d = 0; end < tokens.length && end < j + 2000; end++) {
      const p = tokens[end]!;
      if (p.type !== "punct") continue;
      if (p.value === "(" || p.value === "[" || p.value === "{") d++;
      else if (p.value === ")" || p.value === "]" || p.value === "}") {
        if (d === 0) break;
        d--;
      } else if (p.value === "," && d === 0) break;
    }
    return { params, paramsAt, body: j, end: end - 1 };
  };
  // `app.on("web-contents-created", (event, contents) => { … })`: the callback's extent and the
  // name of the webContents parameter
  const created: Array<{ start: number; end: number; name: string; paramsAt: number }> = [];
  for (let k = 0; k + 4 < tokens.length && created.length < MAX_CONTENTS_CREATED; k++) {
    if (
      !(is(k, ".") && LISTEN_METHODS.has(ident(k + 1) ?? "") && is(k + 2, "(")) ||
      tokens[k + 3]?.type !== "string" ||
      tokens[k + 3]!.value !== "web-contents-created" ||
      !is(k + 4, ",")
    )
      continue;
    const fn = fnAt(k + 5);
    if (fn && fn.params[1])
      created.push({ start: fn.body, end: fn.end, name: fn.params[1], paramsAt: fn.paramsAt });
  }
  /** The receiver chain ending right before the `.` at `dot`: its first token index. */
  const receiverStart = (dot: number): number => {
    let j = dot - 1;
    if (!ident(j)) return -1;
    while (is(j - 1, ".") && ident(j - 2)) j -= 2;
    return j;
  };
  /** Whose webContents the receiver from `from` to the `.` at `dot` is. */
  const targetOf = (
    from: number,
    dot: number,
  ): Pick<NavigationHandler, "target" | "targetKind" | "window"> => {
    const chain: string[] = [];
    for (let j = from; j < dot; j += 2) chain.push(ident(j)!);
    const asWritten = {
      target: short(chain.join(".")),
      targetKind: "webContents" as const,
      window: null,
    };
    if (chain.length === 1) {
      const name = chain[0]!;
      const inside = created.find((c) => c.name === name && from > c.start && from < c.end);
      // the callback's own parameter, not one of a function inside it of the same name
      const bound = inside && resolver ? resolver.binding(from, name, true) : null;
      if (
        inside &&
        (!resolver || (bound?.kind === "param" && bound.def.paramsAt === inside.paramsAt))
      )
        return { target: "app", targetKind: "app", window: "app" };
      return asWritten;
    }
    if (chain.at(-1) !== "webContents") return asWritten;
    const owner = chain.at(-2)!;
    if (!windowNames.has(owner)) return asWritten;
    // `win.webContents`: `win` must be the file's window there, not a parameter or another local
    // of that name. A member chain (`this.mainWindow.webContents`) is matched by its name.
    if (chain.length === 2 && resolver) {
      if (resolver.paramAround(from, owner)) return asWritten;
      const bound = resolver.binding(from, owner, true);
      if (bound && bound.kind !== "value") return asWritten;
      if (bound?.kind === "value" && ident(bound.range[0]) !== "new") return asWritten;
    }
    return { target: owner, targetKind: "window", window: owner };
  };
  /** One step of the budget; false once it is used up. */
  const spend = (): boolean => --work >= 0;
  return { is, ident, closeOf, fnAt, receiverStart, targetOf, spend };
}

/**
 * Reads navigation and new-window handlers from one file's tokens, so a name in a comment or a
 * string is no call. `windowNames` are the names of the windows located in the same file.
 */
export function navigationHandlers(
  tokens: Token[],
  file: string,
  windowNames: ReadonlySet<string>,
  /** Scope of names: a parameter or local of the window's name is another binding. */
  resolver?: ExpressionResolver,
): NavigationHandler[] {
  const out: NavigationHandler[] = [];
  const { is, ident, closeOf, fnAt, receiverStart, targetOf, spend } = contentsTargets(
    tokens,
    windowNames,
    resolver,
  );
  /** `deny`/`allow` when every return of the handler at `k` is `{ action: "<that>" … }`. */
  const returnsOf = (k: number): NonNullable<NavigationHandler["returns"]> => {
    const fn = fnAt(k);
    if (!fn) return "unknown";
    /** The `action` literal of the object literal at `open`, or null. */
    const actionOf = (open: number): string | null => {
      const close = closeOf(open);
      if (close < 0) return null;
      let found: string | null = null;
      for (let j = open + 1, d = 0; j < close; j++) {
        if (!spend()) return null;
        const key = d === 0 && (is(j - 1, "{") || is(j - 1, ","));
        // A spread or a computed key after the action may replace it (`{ action: "deny",
        // ...extra }`, `[k]: "allow"`); one before it is replaced by it.
        if (key && (is(j, "...") || is(j, "[")) && found !== null) return null;
        if (is(j, "{") || is(j, "(") || is(j, "[")) d++;
        else if (is(j, "}") || is(j, ")") || is(j, "]")) d--;
        else if (key) {
          const t = tokens[j]!;
          const plain =
            (t.type === "ident" || t.type === "string" || t.type === "number") && is(j + 1, ":");
          if (!plain) {
            // An accessor, a method or a generator (`get action() {}`, `action() {}`, `*m() {}`):
            // one named action is not a literal that was read, and any of them after the action
            // may replace it. A shorthand of another name (`{ action: "deny", url }`) cannot.
            const named =
              t.value === "action" ||
              ((t.value === "get" || t.value === "set" || t.value === "async" || is(j, "*")) &&
                tokens[j + 1]?.value === "action");
            const shorthand = t.type === "ident" && (is(j + 1, ",") || j + 1 === close);
            if (named || (found !== null && !shorthand)) return null;
            continue;
          }
          if (t.value !== "action") continue;
          const v = tokens[j + 2];
          // the later of two literal keys wins, as in JavaScript; anything else is not read
          if (!is(j + 1, ":") || v?.type !== "string" || !(is(j + 3, ",") || j + 3 === close))
            return null;
          found = v.value;
        }
      }
      return found;
    };
    /**
     * The `action` of the value from `start` to `stop` (inclusive): an object literal, or the last
     * part of a comma sequence (`open(url), { action: "deny" }`, as minifiers write it).
     */
    const valueAction = (start: number, stop: number): string | null => {
      let last = start;
      for (let j = start, d = 0; j <= stop; j++) {
        if (!spend()) return null;
        if (is(j, "{") || is(j, "(") || is(j, "[")) d++;
        else if (is(j, "}") || is(j, ")") || is(j, "]")) d--;
        else if (d === 0 && is(j, ",")) last = j + 1;
      }
      return is(last, "{") && closeOf(last) === stop ? actionOf(last) : null;
    };
    const values = new Set<string | null>();
    if (!is(fn.body, "{")) {
      // `() => ({ action: "deny" })`, `() => (open(url), { action: "deny" })`
      if (is(fn.body, "(") && closeOf(fn.body) === fn.end)
        values.add(valueAction(fn.body + 1, fn.end - 1));
      else return "unknown";
    } else {
      for (let j = fn.body + 1; j < fn.end; j++) {
        if (!spend()) return "unknown";
        // a function inside may return something of its own: not decided here
        if (ident(j) === "function" || is(j, "=>")) return "unknown";
        if (ident(j) !== "return") continue;
        // the returned value runs to the `;` or the `}` that ends the statement
        let stop = j + 1;
        for (let d = 0; stop < fn.end; stop++) {
          if (!spend()) return "unknown";
          if (is(stop, "{") || is(stop, "(") || is(stop, "[")) d++;
          else if (is(stop, "}") || is(stop, ")") || is(stop, "]")) {
            if (d === 0) break;
            d--;
          } else if (d === 0 && is(stop, ";")) break;
        }
        values.add(stop > j + 1 ? valueAction(j + 1, stop - 1) : null);
      }
      // without a return the handler gives undefined: not a literal that was read
      if (!values.size) return "unknown";
      // A path that ends without a return gives undefined too: the last statement of the body
      // must be a return (`if (ok) return { action: "deny" };` alone is not read as deny).
      let last = -1;
      for (let j = fn.body + 1, d = 0, next = fn.body + 1; j < fn.end; j++) {
        if (j === next && !is(j, ";")) last = j;
        if (is(j, "{") || is(j, "(") || is(j, "[")) d++;
        else if (is(j, "}") || is(j, ")") || is(j, "]")) {
          d--;
          if (d === 0 && is(j, "}")) next = j + 1;
        } else if (d === 0 && is(j, ";")) next = j + 1;
        else if (j === next && is(j, ";")) next = j + 1;
      }
      if (last === -1 || ident(last) !== "return") return "unknown";
    }
    if (values.size !== 1) return "unknown";
    const [only] = [...values];
    return only === "deny" || only === "allow" ? only : "unknown";
  };
  for (let k = 1; k + 2 < tokens.length && out.length < MAX_NAVIGATION_PER_FILE; k++) {
    if (!is(k, ".") && !is(k, "?.")) continue;
    const method = ident(k + 1);
    if (!method || !is(k + 2, "(")) continue;
    let kind: NavigationHandler["kind"] | null = null;
    if (method === "setWindowOpenHandler") kind = "setWindowOpenHandler";
    else if (
      LISTEN_METHODS.has(method) &&
      tokens[k + 3]?.type === "string" &&
      NAVIGATION_EVENTS.has(tokens[k + 3]!.value) &&
      is(k + 4, ",")
    )
      kind = tokens[k + 3]!.value as NavigationHandler["kind"];
    if (!kind) continue;
    const from = receiverStart(k);
    if (from < 0) continue;
    const { target, targetKind, window } = targetOf(from, k);
    const call =
      kind === "setWindowOpenHandler"
        ? `${tokens
            .slice(from, k + 2)
            .map((x) => x.value)
            .join("")}(…)`
        : `${tokens
            .slice(from, k + 2)
            .map((x) => x.value)
            .join("")}(${JSON.stringify(kind)}, …)`;
    out.push({
      kind,
      target,
      targetKind,
      window,
      ...(kind === "setWindowOpenHandler" ? { returns: returnsOf(k + 3) } : {}),
      evidence: short(call),
      file,
      line: tokens[k + 1]!.line,
    });
  }
  return out;
}

/**
 * `@electron/remote` turned on for a webContents (`remoteEnabled`): `require("@electron/remote/main")`
 * (also `import`, and what bundlers write for either) bound to a name R, then `R.enable(contents)`
 * or `R.initialize()`; a file that loads `@electron/remote` itself (a renderer or preload that
 * uses it). See docs/electron-findings.md ("Remote module turned on").
 */
export interface RemoteEnable {
  /** `enable`: R.enable(X); `initialize`: R.initialize(); `use`: a file loads @electron/remote. */
  kind: "enable" | "initialize" | "use";
  /**
   * For `enable`: whose webContents, as `navigationHandlers` names it (`win` for
   * `win.webContents`, `app` inside `web-contents-created`, else the argument as written). Null
   * for the other kinds.
   */
  target: string | null;
  /**
   * `window`, `app`, `webContents` (another receiver), or `unknown`: the argument is a parameter
   * of the function the call is in, so which webContents it gets is decided by its callers.
   */
  targetKind: "window" | "app" | "webContents" | "unknown" | null;
  /** The window's name or `app`; null otherwise. Part of the row's identity in a comparison. */
  window: string | null;
  /** The call or the load as written, shortened. */
  evidence: string;
  file: string;
  line: number;
}

const REMOTE_MAIN = new Set(["@electron/remote/main", "@electron/remote/main/index.js"]);
const REMOTE_RENDERER = new Set(["@electron/remote", "@electron/remote/renderer"]);
/** Interop helpers bundlers and compilers wrap a `require` in: the module stays what it is. */
const INTEROP = new Set([
  "__toESM",
  "__importStar",
  "__importDefault",
  "_interopRequireWildcard",
  "_interopRequireDefault",
  "__toCommonJS",
]);
const MAX_REMOTE_PER_FILE = 200;
/** Names one webpack module id of @electron/remote/main is required under, per file. */
const MAX_WEBPACK_NAMES = 64;

/**
 * Reads `@electron/remote` from one file's tokens: the names its main module is bound to, the
 * `enable` and `initialize` calls on them, and loads of the renderer module. A name counts only
 * where it is that binding by scope (a parameter or another local of the same name is not it),
 * and only when nothing writes it after its declaration. Nothing is run.
 */
export function remoteEnables(
  tokens: Token[],
  file: string,
  windowNames: ReadonlySet<string>,
  resolver: ExpressionResolver,
): { rows: RemoteEnable[]; capped: boolean } {
  const rows: RemoteEnable[] = [];
  let capped = false;
  const { is, ident, closeOf, targetOf, spend } = contentsTargets(tokens, windowNames, resolver);
  const text = (from: number, to: number): string =>
    short(
      tokens
        .slice(from, to)
        .map((x) => (x.type === "string" ? JSON.stringify(x.value) : x.value))
        .join(""),
    );
  const push = (row: RemoteEnable): void => {
    if (rows.length >= MAX_REMOTE_PER_FILE) capped = true;
    else rows.push(row);
  };
  /** Namespace names: name -> the token of its declaration (the name itself). */
  const modules = new Map<string, number[]>();
  /** Names bound to one function of the module (`const { enable } = require(…)`), with its method. */
  const functions = new Map<string, Array<{ at: number; method: string }>>();
  const addModule = (name: number): void => {
    const v = tokens[name]!.value;
    const at = modules.get(v);
    if (at) at.push(name);
    else modules.set(v, [name]);
  };
  const addFunction = (name: number, method: string): void => {
    if (method !== "enable" && method !== "initialize") return;
    const v = tokens[name]!.value;
    const at = functions.get(v);
    if (at) at.push({ at: name, method });
    else functions.set(v, [{ at: name, method }]);
  };
  /** webpack's `name = n(<id>)` positions by module id, built on first use. */
  let webpackRequires: Map<string, number[]> | null = null;
  /** `{ enable, initialize: init }` from `open`: each binding with the key it takes. */
  const pattern = (open: number, close: number, add: (name: number, key: string) => void): void => {
    for (let j = open + 1; j < close; j++) {
      if (!(is(j - 1, "{") || is(j - 1, ","))) continue;
      const key = ident(j) ?? (tokens[j]?.type === "string" ? tokens[j]!.value : null);
      if (key === null) continue;
      if ((is(j + 1, ",") || j + 1 === close) && ident(j)) add(j, key);
      else if (is(j + 1, ":") && ident(j + 2) && (is(j + 3, ",") || j + 3 === close))
        add(j + 2, key);
      // `import { enable as e }`
      else if (ident(j + 1) === "as" && ident(j + 2) && (is(j + 3, ",") || j + 3 === close))
        add(j + 2, key);
    }
  };
  const calls: Array<{ method: string; at: number; open: number; from: number }> = [];
  for (let j = 0; j < tokens.length; j++) {
    const t = tokens[j]!;
    if (t.type !== "string") continue;
    const main = REMOTE_MAIN.has(t.value);
    const renderer = REMOTE_RENDERER.has(t.value);
    if (!main && !renderer) continue;
    const required = is(j - 1, "(") && ident(j - 2) === "require" && is(j + 1, ")");
    const imported = ident(j - 1) === "from";
    // `import "@electron/remote"` or `import("@electron/remote")`
    const bare =
      (ident(j - 1) === "import" && !is(j + 1, ".")) ||
      (is(j - 1, "(") && ident(j - 2) === "import");
    if (!required && !imported && !bare) continue;
    if (renderer) {
      // one row per file that loads it, whatever entry it takes
      if (rows.some((x) => x.kind === "use")) continue;
      push({
        kind: "use",
        target: null,
        targetKind: null,
        window: null,
        evidence: required
          ? `require(${JSON.stringify(t.value)})`
          : `import … ${JSON.stringify(t.value)}`,
        file,
        line: t.line,
      });
      continue;
    }
    if (required) {
      // `require("@electron/remote/main").enable(…)`
      if ((is(j + 2, ".") || is(j + 2, "?.")) && ident(j + 3) && is(j + 4, "(")) {
        calls.push({ method: ident(j + 3)!, at: j + 3, open: j + 4, from: j - 2 });
        continue;
      }
      // the expression the require stands for: `require(…)` or `__toESM(require(…))`
      let start = j - 2;
      let end = j + 2;
      if (is(start - 1, "(") && INTEROP.has(ident(start - 2) ?? "") && is(end, ")")) {
        start -= 2;
        end++;
      }
      // webpack: `12: (e) => { e.exports = require("@electron/remote/main") }` and later
      // `var a = n(12)`: the name the module id is required under
      if (
        is(start - 1, "=") &&
        ident(start - 2) === "exports" &&
        is(start - 3, ".") &&
        ident(start - 4)
      ) {
        let id: string | null = null;
        for (let q = start - 5; q >= 0 && q > start - 24; q--)
          if (tokens[q]!.type === "number" && is(q + 1, ":")) {
            id = tokens[q]!.value;
            break;
          }
        if (id !== null) {
          if (webpackRequires === null) {
            // `name = n(<id>)`, every one, read once for the file
            webpackRequires = new Map();
            for (let q = 2; q + 3 < tokens.length; q++)
              if (
                tokens[q + 2]?.type === "number" &&
                is(q + 1, "(") &&
                is(q + 3, ")") &&
                ident(q) &&
                is(q - 1, "=") &&
                ident(q - 2)
              ) {
                const at = webpackRequires.get(tokens[q + 2]!.value) ?? [];
                at.push(q - 2);
                webpackRequires.set(tokens[q + 2]!.value, at);
              }
          }
          const names = webpackRequires.get(id) ?? [];
          for (const n of names.slice(0, MAX_WEBPACK_NAMES)) addModule(n);
          if (names.length > MAX_WEBPACK_NAMES) capped = true;
        }
        continue;
      }
      if (is(start - 1, "=") && ident(start - 2)) {
        addModule(start - 2);
        continue;
      }
      // `const { enable } = require(…)`
      if (is(start - 1, "=") && is(start - 2, "}")) {
        let open = start - 2;
        for (let d = 0; open >= 0 && open > start - 400; open--) {
          if (is(open, "}")) d++;
          else if (is(open, "{") && --d === 0) break;
        }
        if (open >= 0 && is(open, "{")) pattern(open, start - 2, (n, key) => addFunction(n, key));
      }
      continue;
    }
    if (!imported) continue;
    // `import R from`, `import * as R from`, `import { enable } from`, `import R, { enable } from`
    let k = j - 2;
    if (ident(k) && ident(k - 1) === "as" && is(k - 2, "*")) {
      addModule(k);
      continue;
    }
    if (is(k, "}")) {
      let open = k;
      while (open > 0 && open > k - 400 && !is(open, "{")) open--;
      if (is(open, "{")) {
        pattern(open, k, (n, key) => addFunction(n, key));
        k = open - 1;
        if (is(k, ",")) k--;
      }
    }
    if (ident(k) && ident(k - 1) === "import") addModule(k);
  }
  /** The name at k is the binding declared at one of `decls` by scope, and nothing writes it. */
  const bindsTo = (k: number, name: string, decls: number[]): boolean => {
    const around = resolver.boundAround(k, name);
    const decl =
      around === null
        ? decls.length === 1
          ? decls[0]!
          : -1
        : around.kind === "local" && around.site && decls.includes(around.site.name)
          ? around.site.name
          : -1;
    if (decl === -1) return false;
    for (const j of resolver.namePositions(name)) {
      if (!spend()) return false;
      if (j !== decl && resolver.writesTo(j, name, decl)) return false;
    }
    return true;
  };
  for (const [name, decls] of modules)
    for (const k of resolver.namePositions(name)) {
      if (!spend()) break;
      if (decls.includes(k) || is(k - 1, ".") || is(k - 1, "?.")) continue;
      if (!(is(k + 1, ".") || is(k + 1, "?.")) || !ident(k + 2)) continue;
      // `R.default.enable(…)`: a default import as `__importDefault` hands it over
      const at = ident(k + 2) === "default" && is(k + 3, ".") && ident(k + 4) ? k + 4 : k + 2;
      // `R.enable(…)`, or `(0, R.enable)(…)` as tsc and esbuild write a call of an import
      let open = at + 1;
      let from = k;
      if (is(k - 1, ",") && tokens[k - 2]?.value === "0" && is(k - 3, "(") && is(at + 1, ")")) {
        open = at + 2;
        from = k - 3;
      }
      if (!is(open, "(")) continue;
      if (!bindsTo(k, name, decls)) continue;
      calls.push({ method: ident(at)!, at, open, from });
    }
  for (const [name, decls] of functions)
    for (const k of resolver.namePositions(name)) {
      if (!spend()) break;
      if (decls.some((d) => d.at === k) || is(k - 1, ".") || is(k - 1, "?.") || !is(k + 1, "("))
        continue;
      const around = resolver.boundAround(k, name);
      const decl =
        around?.kind === "local" && around.site
          ? decls.find((d) => d.at === around.site!.name)
          : around === null && decls.length === 1
            ? decls[0]
            : undefined;
      if (!decl || !bindsTo(k, name, [decl.at])) continue;
      calls.push({ method: decl.method, at: k, open: k + 1, from: k });
    }
  for (const call of calls.toSorted((a, b) => a.at - b.at)) {
    if (call.method !== "enable" && call.method !== "initialize") continue;
    const close = closeOf(call.open);
    const evidence = `${text(call.from, call.open)}(${close > call.open + 1 ? "…" : ""})`;
    const line = tokens[call.at]!.line;
    if (call.method === "initialize") {
      push({
        kind: "initialize",
        target: null,
        targetKind: null,
        window: null,
        evidence,
        file,
        line,
      });
      continue;
    }
    // the argument: a chain of names (`win.webContents`, `this.win.webContents`, `contents`)
    const from = call.open + 1;
    let end = from;
    while (ident(end) && (is(end + 1, ".") || is(end + 1, "?."))) end += 2;
    const chain = ident(end) !== null && close === end + 1;
    let target: Pick<RemoteEnable, "target" | "targetKind" | "window">;
    if (!chain)
      target = {
        target: close > from ? text(from, close) : "",
        targetKind: close > from ? "webContents" : "unknown",
        window: null,
      };
    else if (
      end === from &&
      ident(from) !== "this" &&
      resolver.boundAround(from, ident(from)!)?.kind === "param"
    ) {
      // a parameter: which webContents it is depends on the callers (not followed)
      const named = targetOf(from, end + 1);
      target =
        named.targetKind === "app"
          ? named
          : { target: ident(from)!, targetKind: "unknown", window: null };
    } else target = targetOf(from, end + 1);
    push({ kind: "enable", ...target, evidence, file, line });
  }
  return { rows, capped };
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
  /** One row per window with its core settings and what follows from them together. */
  windows: WindowSummary[];
  /** What preload scripts expose to pages through contextBridge, member by member. */
  contextBridge: BridgeMember[];
  /** Exposed members (or values) that are a privileged object itself, not a wrapper. */
  bridgeExposures: BridgeExposure[];
  /** setWindowOpenHandler and will-navigate / will-frame-navigate handlers, with file and line. */
  navigationHandlers: NavigationHandler[];
  /** `@electron/remote` turned on (`enable`, `initialize`) or loaded (`use`), with file and line. */
  remoteEnabled: RemoteEnable[];
  /** Command-line switches, accepted certificate errors, verify procs, security warnings off. */
  switches: SwitchRow[];
  /** `shell.openExternal` calls, with how much of the URL is read. */
  openExternal: OpenExternalRow[];
  /** setPermissionRequestHandler / setPermissionCheckHandler, with whether they grant all. */
  permissionHandlers: PermissionHandlerRow[];
  /** Content Security Policies: `<meta http-equiv>` in HTML files and headers written in code. */
  csp: CspRow[];
  /** executeJavaScript, executeJavaScriptInIsolatedWorld and insertCSS calls. */
  dangerousCalls: DangerousCallRow[];
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
  /** The files that were passed over (the first 200); nothing is known about their contents. */
  skippedFiles: string[];
  /** Files read only up to the token budget, all of them; they count as scanned. */
  partial: number;
  /** The files that were read only up to the token budget (the first 200). */
  partialFiles: string[];
  /**
   * More files were passed over or read in part than `skippedFiles` and `partialFiles` name:
   * any read file may then be one of them.
   */
  filesUnlisted: boolean;
}

/** Bump when the facts change shape or a detector changes what it reads. */
export const JS_SCAN_SCHEMA = 42;

/**
 * Everything read from the files scanned so far. It is plain JSON, so a scan can be stored and
 * continued later; the analysis result is assembled from it.
 */
export interface JsScanFacts {
  schema: number;
  /** Paths already processed, in scan order. A file is processed exactly once. */
  scanned: string[];
  skippedFiles: string[];
  /** Files whose reading stopped at the token budget (the first 200): what follows the cut is not known. */
  truncatedFiles: string[];
  /** Every file whose reading stopped at the token budget, also those past the 200 named. */
  truncated?: number;
  skipped: number;
  bytes: number;
  modules: JsModule[];
  edges: JsEdge[];
  externals: Record<string, number>;
  webPreferences: WebPreference[];
  /** Every window constructor call that was located, also one that writes no setting. */
  windows: Array<{
    file: string;
    window: number;
    windowName: string;
    line: number;
    /**
     * Keys whose value for this window is not what the code next to it says: the options take
     * something that could not be followed, or the followed object is assigned to later.
     */
    computed?: string[];
    /** The options take a value that could not be followed. */
    opaque?: true;
  }>;
  /**
   * `app.enableSandbox()`: `always` when it is a statement at the top of a file, `maybe` when it
   * sits inside a function or behind a condition, false when no such call was read.
   */
  enableSandbox: "always" | "maybe" | false;
  contextBridge: BridgeMember[];
  bridgeExposures: BridgeExposure[];
  /** Generic forwarders of the exposed objects (R1), for the page scripts' calls of them. */
  bridgeForwarders?: BridgeForwarder[];
  navigationHandlers: NavigationHandler[];
  remoteEnabled?: RemoteEnable[];
  switches?: SwitchRow[];
  openExternal?: OpenExternalRow[];
  permissionHandlers?: PermissionHandlerRow[];
  /** CSP header rows read from JavaScript (meta rows are read from HTML at the end of a run). */
  cspHeaders?: CspRow[];
  dangerousCalls?: DangerousCallRow[];
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
  /** A file had more calls on undeclared names than are kept for cross-file resolution. */
  ambientCapped: boolean;
  /** A file or the app had more navigation handlers than are kept. */
  navigationCapped?: boolean;
  /** A file had more `@electron/remote` rows than are kept. */
  remoteCapped?: boolean;
  /** A file or the app had more `switches` rows than are kept. */
  switchesCapped?: boolean;
  openExternalCapped?: boolean;
  permissionHandlersCapped?: boolean;
  cspCapped?: boolean;
  dangerousCallsCapped?: boolean;
  /** Files with more calls of their own storage wrappers than are read, and the first five. */
  keyCallsCapped?: number;
  keyCallsCappedFiles?: string[];
  /**
   * Limitations that belong to single files (e.g. a token budget that ran out), at most
   * MAX_FILE_LIMITATIONS and always one of each code (see `fileLimitation`).
   */
  limitations: Limitation[];
  /** Per code, the files whose limitation of that code is not in `limitations`. */
  limitationsUnlisted?: Record<string, number>;
}

export function emptyJsScanFacts(): JsScanFacts {
  return {
    schema: JS_SCAN_SCHEMA,
    scanned: [],
    skippedFiles: [],
    truncatedFiles: [],
    skipped: 0,
    bytes: 0,
    modules: [],
    edges: [],
    externals: {},
    webPreferences: [],
    windows: [],
    enableSandbox: false,
    contextBridge: [],
    bridgeExposures: [],
    navigationHandlers: [],
    remoteEnabled: [],
    switches: [],
    openExternal: [],
    permissionHandlers: [],
    cspHeaders: [],
    dangerousCalls: [],
    endpoints: [],
    storage: [],
    urls: [],
    preloadScripts: [],
    flags: { nodeIntegration: null, contextIsolation: null, sandbox: null, remoteModule: false },
    electronSeen: false,
    prefsCapped: false,
    bridgeCapped: false,
    candidatesCapped: false,
    ambientCapped: false,
    limitations: [],
  };
}

const MAX_CANDIDATES = 5000;
/** Per-file limitations kept one by one; past it, one more of each code still is. */
const MAX_FILE_LIMITATIONS = 200;
/** Files named in `skippedFiles` and `truncatedFiles`; past it they are counted only. */
const MAX_NAMED_FILES = 200;

/**
 * Records a limitation of one file. Past MAX_FILE_LIMITATIONS it is counted instead, except the
 * first of its code: a code is never missing because others filled the list (BLIND_SPOTS and
 * UNRESOLVED_LIMITATIONS read the codes), and the count says how many are not listed.
 */
function fileLimitation(facts: JsScanFacts, file: string, limitation: Limitation): void {
  if (
    facts.limitations.length < MAX_FILE_LIMITATIONS ||
    !facts.limitations.some((l) => l.code === limitation.code)
  ) {
    facts.limitations.push(limitation);
    return;
  }
  // a file counts once per code (`wrapper_method_replaced` may come for IPC and for storage)
  let counted = unlistedFiles.get(facts);
  if (!counted) unlistedFiles.set(facts, (counted = new Set()));
  const key = `${limitation.code}\u0000${file}`;
  if (
    counted.has(key) ||
    facts.limitations.some((l) => l.code === limitation.code && l.message.startsWith(`${file}: `))
  )
    return;
  counted.add(key);
  const unlisted = (facts.limitationsUnlisted ??= {});
  unlisted[limitation.code] = (unlisted[limitation.code] ?? 0) + 1;
}
/** The files counted in `limitationsUnlisted`, per scan state (a file is read once per scan). */
const unlistedFiles = new WeakMap<JsScanFacts, Set<string>>();
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
      // The resolved file is the one read, through one descriptor that refuses non-files.
      return readRegularFile(real, maxBytes, path);
    },
  };
}

/**
 * `unpacked`: the files the archive keeps in `<archive>.unpacked/`, by path, when they come from
 * somewhere other than a directory beside the archive (a ZIP the archive was read from).
 */
export function asarTree(
  bytes: Uint8Array,
  name: string,
  unpacked?: Readonly<Record<string, Uint8Array>>,
): FileTree {
  return archiveTree(openAsar(bytes), name, unpacked);
}

export function asarTreeFromFile(path: string): FileTree {
  return archiveTree(openAsarFile(path), path);
}

function archiveTree(
  archive: AsarArchive,
  name: string,
  unpacked?: Readonly<Record<string, Uint8Array>>,
): FileTree {
  // Electron keeps files marked unpacked in `<archive>.unpacked/` beside the archive; an archive
  // known only by a name (an upload) has no such directory, and those files stay unread unless
  // they were handed over with it.
  const onDisk = isAbsolute(name) && !unpacked;
  return {
    kind: "asar",
    root: name,
    files: archive.files.map((f) => ({
      path: f.path,
      size: f.size,
      ...(f.unpacked ? { unpacked: true } : {}),
    })),
    ...(unpacked
      ? {
          unpackedStamp: (path: string) => {
            const bytes = Object.hasOwn(unpacked, path) ? unpacked[path] : undefined;
            return bytes ? createHash("sha256").update(bytes).digest("hex") : "absent";
          },
        }
      : {}),
    read: (path, maxBytes = 64 << 20) => {
      const file = archive.find(path);
      if (!file) throw new AnalysisError("not_found", `${path} not in archive`);
      if (file.unpacked) {
        if (unpacked) {
          const bytes = Object.hasOwn(unpacked, path) ? unpacked[path] : undefined;
          if (!bytes)
            throw new AnalysisError(
              "not_found",
              `${path} is stored outside the archive (unpacked) and was not taken from the ZIP`,
              { unpacked: true },
            );
          if (bytes.length > maxBytes)
            throw new AnalysisError(
              "too_large",
              `${path} is ${bytes.length} bytes (limit ${maxBytes})`,
            );
          return bytes;
        }
        if (!onDisk)
          throw new AnalysisError("not_found", `${path} is stored outside the archive (unpacked)`, {
            unpacked: true,
          });
        return readUnpacked(name, file, maxBytes);
      }
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

/**
 * Whether a contextBridge value imported from `specifier` is followed (`valueRef`): every module
 * but electron's own and Node's built-ins, which cannot carry a member that passes a channel on to
 * IPC. A package or a module not among the files read is then named in context_bridge_module_unread
 * (#235) instead of reading as a member that forwards nothing.
 */
function bridgeValueSource(specifier: string): boolean {
  if (specifier === "electron" || specifier.startsWith("electron/")) return false;
  const bare = specifier.startsWith("node:") ? specifier.slice(5) : specifier;
  return !NODE_BUILTINS.has(bare.split("/")[0]!);
}

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

const jsFilesOf = (tree: FileTree): FileTree["files"] =>
  tree.files.filter((f) => JS_EXT.test(f.path) && !f.path.includes("node_modules/"));

/** The entry file, then shallow paths before deep ones, then by path. */
function scanOrder(files: FileTree["files"], main: string | null): FileTree["files"] {
  const mainPath = main ? posix.normalize(main) : null;
  return files.toSorted(
    (a, b) =>
      Number(b.path === mainPath) - Number(a.path === mainPath) ||
      pathDepth(a.path) - pathDepth(b.path) ||
      (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  );
}

/**
 * The files `analyzeJavaScriptTree` will read with these options, by the same order and budgets,
 * so their tokens can be read ahead in worker threads. Only sizes decide here; a file that turns
 * out unreadable during the scan can shift the end of a run, and whatever this list misses or
 * has in excess is read by the scan itself or ignored.
 */
export function plannedReads(
  tree: FileTree,
  options: {
    maxJsFiles?: number;
    maxFileBytes?: number;
    maxTotalBytes?: number;
    resume?: JsScanFacts;
    include?: readonly string[];
    all?: boolean;
  } = {},
): FileTree["files"] {
  const maxJsFiles = options.maxJsFiles ?? 5000;
  const maxFileBytes = options.maxFileBytes ?? 16 << 20;
  const maxTotalBytes = options.maxTotalBytes ?? 256 << 20;
  let main: string | null = null;
  if (tree.files.some((f) => f.path === "package.json")) {
    try {
      main = (JSON.parse(decode(tree.read("package.json"))) as PackageJson).main ?? null;
    } catch {
      main = null;
    }
  }
  const done = new Set(options.resume?.schema === JS_SCAN_SCHEMA ? options.resume.scanned : []);
  const wanted = options.include?.length ? pathMatcher(options.include) : null;
  const batch = Number.isFinite(maxJsFiles) && maxJsFiles >= 1 ? Math.floor(maxJsFiles) : 5000;
  const runFiles = options.all ? Number.POSITIVE_INFINITY : maxJsFiles === 0 ? 0 : batch;
  const out: FileTree["files"] = [];
  let taken = 0;
  let runBytes = 0;
  for (const file of scanOrder(jsFilesOf(tree), main)) {
    if (done.has(file.path) || (wanted && !wanted(file.path))) continue;
    if (taken >= runFiles) break;
    if (
      !options.all &&
      taken > 0 &&
      file.size <= maxFileBytes &&
      runBytes + file.size > maxTotalBytes
    )
      break;
    taken++;
    if (file.size > maxFileBytes) continue;
    runBytes += file.size;
    out.push(file);
  }
  return out;
}

/** Index of the token that starts at a source offset, by binary search; -1 if none does. */
function tokenAtOffset(tokens: Token[], offset: number): number {
  let lo = 0;
  let hi = tokens.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const start = tokens[mid]!.start;
    if (start === offset) return mid;
    if (start < offset) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

/**
 * The settings an evaluated options object gives a window: literal values with where they are
 * written, and the keys that cannot be read (null values, or not listed in an open object).
 * Null when the options or their webPreferences are not known at all.
 */
function optionSettings(options: Val | null): {
  settings: Array<{ key: string; value: string | boolean; src: { file: string; line: number } }>;
  unknown: Set<string>;
} | null {
  if (options?.kind !== "obj") return null;
  const unknown = new Set<string>();
  const settings: Array<{
    key: string;
    value: string | boolean;
    src: { file: string; line: number };
  }> = [];
  const keys = ["preload", ...BOOLEAN_KEYS];
  const prefs = options.props.has("webPreferences")
    ? options.props.get("webPreferences")
    : options.open
      ? null
      : ({ kind: "undef" } as const);
  if (prefs === null || prefs === undefined) return null;
  if (prefs.kind === "undef") return { settings, unknown };
  if (prefs.kind !== "obj") return null;
  for (const key of keys) {
    if (!prefs.props.has(key)) {
      if (prefs.open) unknown.add(key);
      continue;
    }
    const v = prefs.props.get(key) ?? null;
    if (v?.kind === "bool" && key !== "preload") settings.push({ key, value: v.value, src: v.src });
    else if (v?.kind === "str" && key === "preload" && v.values.length === 1 && v.src)
      settings.push({ key, value: v.values[0]!.replace(/^[\\/]+/, ""), src: v.src });
    else if (v?.kind !== "undef") unknown.add(key);
  }
  return { settings, unknown };
}

/** A setting written as `key: value` in an options object, at a source offset. */
type SettingAt = {
  key: Exclude<PreferenceKey, "preload">;
  value: boolean | null;
  computed?: string;
  start: number;
};

/**
 * What one file's tokens say before anything is merged into the application's facts: no caps,
 * no shared state. The same source gives the same result here or in a worker thread
 * (`tokenPool.ts`), so a parallel scan merges exactly what a sequential one would.
 */
export interface FileTokenFacts {
  scan: ScanResult;
  ambient: ReturnType<typeof collectAmbient> | null;
  located: WindowRanges | null;
  ranges: WindowRange[];
  mutated: string[];
  sandboxCall: "always" | "maybe" | null;
  settingsAt: SettingAt[];
  preloadsAt: number[];
  braces: Array<[number, number]>;
  preferenceObjects: Array<[number, number]>;
  candidates: ReturnType<typeof findCandidates> | null;
  /** Storage-key wrappers the file exports (wrappers.ts), from its storage calls with an open key. */
  keyWrappers: WrapperFacts | null;
  bridge: ReturnType<typeof bridgeMembers> | null;
  navigation: NavigationHandler[] | null;
  remote: { rows: RemoteEnable[]; capped: boolean } | null;
  switches?: { rows: SwitchRow[]; capped: boolean } | null;
  openExternal?: { rows: OpenExternalRow[]; capped: boolean } | null;
  permissionHandlers?: { rows: PermissionHandlerRow[]; capped: boolean } | null;
  cspHeaders?: { rows: CspRow[]; capped: boolean } | null;
  dangerousCalls?: { rows: DangerousCallRow[]; capped: boolean } | null;
  /** Methods of the file's storage wrappers the file replaces (`Class.method:line`, at most 20). */
  keyReplaced?: string[];
  /** Writes that may replace one of them were not all read within the budget. */
  keyUnchecked?: true;
}

export function readFileTokens(
  path: string,
  source: string,
  /**
   * Receives the file's token stream, so the scan can evaluate the file again on the same tokens
   * (and the resolver tables built for them) instead of tokenizing it a second time, and the
   * scan's constants of the file, whose tables a second reading shares (`withoutEvaluator`).
   */
  keep?: (tokens: Token[], constants: Constants) => void,
  /** Tokens read of the file (default 2,000,000, the tokenizer's); a test hook. */
  maxTokens?: number,
): FileTokenFacts {
  let ranges: WindowRange[] = [];
  let located: WindowRanges | null = null;
  /** Keys of a followed options object that are assigned after its declaration. */
  const mutated = new Set<string>();
  let sandboxCall: "always" | "maybe" | null = null;
  // Settings are read from tokens, so text in a comment or a string is never a setting.
  const settingsAt: SettingAt[] = [];
  const preloadsAt = new Set<number>();
  /** Every `{ … }` of the file as [start, end) offsets, in source order; filled when needed. */
  let braces: Array<[number, number]> = [];
  /** For an object that is the value of a `webPreferences:` property: where that key stands. */
  const preferenceObjects = new Map<number, number>();
  let ambient: ReturnType<typeof collectAmbient> | null = null;
  let candidates: ReturnType<typeof findCandidates> | null = null;
  let keyWrappers: WrapperFacts | null = null;
  /** Methods of the file's storage wrappers the file replaces, as `Class.method:line`. */
  let ownKeyReplaced: string[] | null = null;
  /** Writes that may replace such a method were not all read within the budget. */
  let ownKeyUnchecked = false;
  let bridge: ReturnType<typeof bridgeMembers> | null = null;
  let navigation: NavigationHandler[] | null = null;
  let remote: { rows: RemoteEnable[]; capped: boolean } | null = null;
  let switches: { rows: SwitchRow[]; capped: boolean } | null = null;
  let openExternal: { rows: OpenExternalRow[]; capped: boolean } | null = null;
  let permissionHandlers: { rows: PermissionHandlerRow[]; capped: boolean } | null = null;
  let cspHeaders: { rows: CspRow[]; capped: boolean } | null = null;
  let dangerousCalls: { rows: DangerousCallRow[]; capped: boolean } | null = null;
  const scan = scanJavaScript(source, {
    ...(maxTokens === undefined ? {} : { maxTokens }),
    onTokens: (tokens, truncated, context) => {
      keep?.(tokens, context.constants);
      let keyResolver: ExpressionResolver | null = null;
      /**
       * The string a computed key `[NAME]` names: only where NAME at k is bound (by scope, the
       * resolver's `binding`) to one declaration `NAME = "…"` with a string literal that is never
       * assigned again. A parameter, a loop variable, a pattern or a `catch` binding of the same
       * name is another binding, whatever the file's constants say: its key is not read.
       */
      const constantKey = (k: number): string | null => {
        const t = tokens[k];
        if (t?.type !== "ident") return null;
        const value = context.constants.stringOf(t.value, k);
        if (value === null) return null;
        keyResolver ??= new ExpressionResolver(tokens, context.constants);
        const r = keyResolver;
        // declared once where k sees it, with a value, and never assigned again
        const bound = r.binding(k, t.value);
        if (bound?.kind !== "value") return null;
        // and no nearer binding `binding` does not see (`for (const SB of …)`, `catch (SB)`)
        const near = r.boundAround(k, t.value);
        if (near && (near.kind !== "local" || near.site?.name !== bound.range[0] - 2)) return null;
        const [from, to] = bound.range;
        const init = tokens[from];
        return to === from + 1 && init?.type === "string" && init.value === value ? value : null;
      };
      if (source.includes("enableSandbox")) {
        // Read from tokens, so a comment or a string is no call. Only a statement at the top
        // of the file that no condition guards is certain to run.
        let depth = 0;
        for (let k = 0; k < tokens.length; k++) {
          const t = tokens[k]!;
          if (t.type === "punct") {
            if (t.value === "{" || t.value === "(" || t.value === "[") depth++;
            else if (t.value === "}" || t.value === ")" || t.value === "]") depth--;
            continue;
          }
          if (
            t.type !== "ident" ||
            t.value !== "enableSandbox" ||
            tokens[k - 1]?.value !== "." ||
            tokens[k + 1]?.value !== "("
          )
            continue;
          // back to the start of the statement: nothing but `app.` may stand before the call
          const owner = tokens[k - 2];
          const before = tokens[k - 3];
          const plain =
            depth === 0 &&
            owner?.type === "ident" &&
            (!before ||
              before.line !== owner.line ||
              (before.type === "punct" && (before.value === ";" || before.value === "}")));
          if (plain) sandboxCall = "always";
          else sandboxCall ??= "maybe";
        }
      }
      if (
        /ipcMain|ipcRenderer|\.(on|once|handle|handleOnce|send|invoke|sendSync|sendToHost|postMessage)\(|\b(window|self|globalThis|global)\.[\w$]+\s*=[^=]/.test(
          source,
        )
      )
        ambient = collectAmbient(tokens, context.aliases, source);
      if (/webPreferences|BrowserWindow|BrowserView|WebContentsView/.test(source)) {
        let resolver: ExpressionResolver | null = null;
        const { declOf, ...where } = windowRanges(
          tokens,
          context.aliases,
          () => (resolver ??= new ExpressionResolver(tokens, context.constants)),
          (k) => {
            const name = tokens[k];
            if (name?.type !== "ident") return null;
            if (!(tokens[k + 1]?.type === "punct" && tokens[k + 1]!.value === "."))
              return context.constants.importOf(name.value, k);
            const member = tokens[k + 2];
            if (member?.type !== "ident") return null;
            const specifier = context.constants.requireOf(name.value, k);
            return specifier ? { specifier, property: member.value } : null;
          },
          constantKey,
        );
        located = where;
        ranges = located.ranges;
        // `prefs.sandbox = false`, `prefs["sandbox"] = false`, `Object.assign(prefs, …)` on an
        // object that was followed as window options: what the declaration says no longer
        // holds, so the key reads as computed.
        const traced = new Map([...located.traced].map(([name, decls]) => [name, new Set(decls)]));
        const is = (i: number, value: string): boolean =>
          tokens[i]?.type === "punct" && tokens[i]!.value === value;
        const everyKey = (): void => {
          for (const key of BOOLEAN_KEYS) mutated.add(key);
          mutated.add("preload");
        };
        /** Whether the bracket right around token k opens the body of a class. */
        const classBodyAround = (k: number): boolean => {
          for (let d = 0, j = k - 1; j >= 0 && j > k - 20_000; j--) {
            const p = tokens[j]!;
            if (p.type !== "punct") continue;
            if (p.value === "}" || p.value === ")" || p.value === "]") d++;
            else if (p.value === "{" || p.value === "(" || p.value === "[") {
              if (d > 0) {
                d--;
                continue;
              }
              return (
                p.value === "{" &&
                (resolver ??= new ExpressionResolver(tokens, context.constants))
                  .classesOf()
                  .some((c) => c.start === j)
              );
            }
          }
          return false;
        };
        /** NAME at k as an entry of a declaration's pattern or an import: `{ NAME } = …`, `{ NAME } from`. */
        const inPattern = (k: number): boolean => {
          const entry =
            is(k - 1, "{") ||
            is(k - 1, ",") ||
            (is(k - 1, ":") && tokens[k - 2]?.type === "ident") ||
            tokens[k - 1]?.value === "as";
          if (!entry || !(is(k + 1, ",") || is(k + 1, "}"))) return false;
          for (let d = 0, j = k + 1; j < tokens.length && j < k + 400; j++) {
            if (is(j, "{") || is(j, "(") || is(j, "[")) d++;
            else if (is(j, ")") || is(j, "]")) d--;
            else if (is(j, "}")) {
              if (d === 0)
                return (is(j + 1, "=") && !is(j + 2, "=")) || tokens[j + 1]?.value === "from";
              d--;
            }
            if (d < 0) return false;
          }
          return false;
        };
        for (let k = 0; traced.size && k + 1 < tokens.length; k++) {
          const t = tokens[k]!;
          if (t.type !== "ident" || !traced.has(t.value) || is(k - 1, ".")) continue;
          // a key of an object literal (`{ webPreferences: … }`) is not a use of the name
          if (is(k + 1, ":") && (is(k - 1, "{") || is(k - 1, ","))) continue;
          // nor is a field of a class body (`webPreferences = { … }` in `class W { … }`)
          if (is(k + 1, "=") && !is(k + 2, "=") && classBodyAround(k)) continue;
          const decls = traced.get(t.value)!;
          // Another binding of the same name (a parameter, a declaration in another function, as
          // minifiers reuse short names) is another object. Where the binding is not known, the
          // use counts.
          const bound = declOf(k);
          if (bound === "other") continue;
          if (typeof bound === "number" && !decls.has(bound)) continue;
          if (bound === "pattern" && !decls.has(-1)) continue;
          // Not known (`var t; … t = {…}`, a variable declared without a value), but outside the
          // scope of every declaration that was followed (`NAME = {…}`): another variable of the
          // same name, as webpack's runtime reuses `t` (`n.cw = e => { var t; … t = {exports: {}} }`).
          if (
            bound === null &&
            [...decls].every(
              (d) =>
                d >= 2 &&
                is(d - 1, "=") &&
                tokens[d - 2]?.value === t.value &&
                !(resolver ??= new ExpressionResolver(tokens, context.constants)).refersTo(
                  k,
                  t.value,
                  d - 2,
                ),
            )
          )
            continue;
          // The declaration that was followed, or the pattern or import that binds the name.
          if (is(k + 1, "=") && !is(k + 2, "=") && decls.has(k + 2)) continue;
          if (decls.has(-1) && inPattern(k)) continue;
          // A source of `Object.assign(target, …, name, …)`: read, not changed. Only the first
          // argument, the target, is written to.
          if (is(k - 1, ",") && (is(k + 1, ",") || is(k + 1, ")"))) {
            let open = -1;
            for (let d = 0, j = k - 1; j >= 0 && j > k - 2000; j--) {
              const p = tokens[j]!;
              if (p.type !== "punct") continue;
              if (p.value === ")" || p.value === "]" || p.value === "}") d++;
              else if (p.value === "(" || p.value === "[" || p.value === "{") {
                if (d === 0) {
                  open = p.value === "(" ? j : -1;
                  break;
                }
                d--;
              }
            }
            if (
              open > 3 &&
              tokens[open - 1]?.value === "assign" &&
              is(open - 2, ".") &&
              tokens[open - 3]?.value === "Object"
            )
              continue;
          }
          // Its use as options: `new X(name)` for a window class, and `webPreferences: name`
          // or `...name` INSIDE the options of a located window. The same shapes anywhere
          // else (`tweak({ webPreferences: name })`, `const copy = { ...name }`, which shares
          // the nested objects) hand the object on, and what happens to it there is not read.
          const inWindow = ranges.some(
            (r) => r.window !== null && t.start >= r.start && t.start < r.end,
          );
          const isWindowClass = (ctor: number): boolean =>
            ctor >= 0 && WINDOW_CLASSES.has(context.aliases.get(ctor) ?? tokens[ctor]!.value);
          const asOptions =
            (is(k - 1, "(") &&
              is(k + 1, ")") &&
              // `new BrowserWindow(name)`, `new electron.BrowserWindow(name)`, also under the
              // short name a minifier gives the class (`new n(t)`), `new (X().BrowserWindow)(name)`
              isWindowClass(windowCalleeBefore(tokens, k - 1))) ||
            (inWindow &&
              ((is(k - 1, ":") && tokens[k - 2]?.value === "webPreferences") ||
                is(k - 1, "...") ||
                // the shorthand `{ webPreferences }`
                (t.value === "webPreferences" &&
                  (is(k - 1, "{") || is(k - 1, ",")) &&
                  (is(k + 1, ",") || is(k + 1, "}")))));
          if (asOptions) continue;
          // A write to one key: `name.key =`, `name.webPreferences.key =`, `name["key"] =`.
          let at = k + 1;
          if (is(at, ".") && tokens[at + 1]?.value === "webPreferences") at += 2;
          const key = is(at, ".")
            ? tokens[at + 1]?.type === "ident"
              ? tokens[at + 1]!.value
              : null
            : is(at, "[") && tokens[at + 1]?.type === "string" && is(at + 2, "]")
              ? tokens[at + 1]!.value
              : null;
          const after = is(at, ".") ? at + 2 : at + 3;
          // a member written by a pattern or a loop head (`[name.key] = …`, `for (name.key of …)`),
          // or written with an operator the next lines do not tell from a read
          if (writesMember(tokens, k) !== null) {
            // one key when the chain ends right after it; a deeper or computed write may be any
            if (key === null || key === "webPreferences" || chainEnd(tokens, k) !== after)
              everyKey();
            else mutated.add(key);
            continue;
          }
          if (key !== null && is(after, "=") && !is(after + 1, "=")) {
            // `name.webPreferences = other` replaces every key
            if (key === "webPreferences") everyKey();
            else mutated.add(key);
            continue;
          }
          // A plain read of one key changes nothing. Only what is certainly a read counts as
          // one: the key followed by the end of an expression or by a comparison or logical
          // operator. `name.key ||= x`, `name.key += 1`, `name.key++` and anything else that is
          // not on this list is a write.
          const follower = tokens[after];
          const reads =
            key !== null &&
            tokens[k - 1]?.value !== "delete" &&
            tokens[k - 1]?.value !== "++" &&
            tokens[k - 1]?.value !== "--" &&
            (!follower || (follower.type === "punct" && READ_FOLLOWERS.has(follower.value)));
          if (reads) continue;
          if (key !== null && !is(after, ".") && !is(after, "[") && !is(after, "(")) {
            mutated.add(key);
            continue;
          }
          // Anything else may change the object in a way that is not read here: a second
          // assignment to the name, a deeper or computed write, `delete`, the object handed to
          // a function (`Object.assign(name, …)`, `tweak(name)`), a method called on it.
          everyKey();
        }
        const open: number[] = [];
        const pairs: Array<[number, number]> = [];
        for (const t of tokens) {
          if (t.type !== "punct") continue;
          if (t.value === "{") {
            open.push(pairs.length);
            pairs.push([t.start, Number.MAX_SAFE_INTEGER]);
          } else if (t.value === "}" && open.length) pairs[open.pop()!]![1] = t.end;
        }
        for (let k = 2; k < tokens.length; k++)
          if (
            is(k, "{") &&
            is(k - 1, ":") &&
            tokens[k - 2]!.type === "ident" &&
            tokens[k - 2]!.value === "webPreferences"
          )
            preferenceObjects.set(tokens[k]!.start, tokens[k - 2]!.start);
        braces = pairs;
      }
      if (
        /nodeIntegration|contextIsolation|sandbox|preload|webSecurity|allowRunningInsecureContent|webviewTag|enableRemoteModule/.test(
          source,
        )
      ) {
        const isP = (i: number, value: string): boolean =>
          tokens[i]?.type === "punct" && tokens[i]!.value === value;
        /** The `{` right around each token (-1: none), for the forms read only in a settings object. */
        const enclosing = new Int32Array(tokens.length).fill(-1);
        const stack: number[] = [];
        for (let k = 0; k < tokens.length; k++) {
          enclosing[k] = stack.length ? stack.at(-1)! : -1;
          const p = tokens[k]!;
          if (p.type !== "punct") continue;
          if (p.value === "{" || p.value === "(" || p.value === "[")
            stack.push(p.value === "{" ? k : -1);
          else if ((p.value === "}" || p.value === ")" || p.value === "]") && stack.length)
            stack.pop();
        }
        /**
         * Whether the object around token k may be a webPreferences object: not the value of
         * another key (`inner: {…}`; a factory's `return {…}` may be one). A quoted or computed
         * key, an accessor or a method is read as a setting only there; plain `name: value` keys
         * are read as before.
         */
        const settingsObject = (k: number): boolean => {
          const b = enclosing[k]!;
          if (b < 0) return false;
          if (isP(b - 1, ":")) return tokens[b - 2]?.value === "webPreferences";
          return true;
        };
        for (let k = 0; k + 2 < tokens.length; k++) {
          const t = tokens[k]!;
          const colon = tokens[k + 1]!;
          /** The key of a member that starts at k, and the token its value starts at. */
          let name: string | null = null;
          let valueAt = k + 2;
          /** `get sandbox() {…}`, `nodeIntegration() {…}`: the value is not read here. */
          let accessor = false;
          const member = (isP(k - 1, "{") || isP(k - 1, ",")) && settingsObject(k);
          /** `get [NI]() {…}`, `async ["sandbox"]() {}`, `*[NI]() {}`: the bracket, else -1. */
          let accessorBracket = -1;
          if (member) {
            let m = k;
            if (
              t.type === "ident" &&
              (t.value === "get" || t.value === "set" || t.value === "async")
            )
              m++;
            if (isP(m, "*")) m++;
            if (m > k && isP(m, "[") && isP(m + 2, "]") && isP(m + 3, "(")) accessorBracket = m;
            else if (
              m > k &&
              (tokens[m]?.type === "ident" || tokens[m]?.type === "string") &&
              isP(m + 1, "(")
            ) {
              // `*sandbox() {}`, `async *nodeIntegration() {}` (`get x()` is read below)
              if (isP(k, "*") || (isP(k + 1, "*") && t.value === "async")) {
                name = tokens[m]!.value;
                accessor = true;
                valueAt = m + 1;
              }
            }
          }
          if (accessorBracket !== -1) {
            const inner = tokens[accessorBracket + 1]!;
            name =
              inner.type === "string"
                ? inner.value
                : inner.type === "ident"
                  ? constantKey(accessorBracket + 1)
                  : null;
            accessor = true;
            valueAt = accessorBracket + 3;
          } else if (accessor) {
            // read above
          } else if (t.type === "ident" && colon.type === "punct" && colon.value === ":")
            name = t.value;
          else if (member && t.type === "string" && isP(k + 1, ":")) {
            // `"nodeIntegration": true`, which a minifier writes unquoted
            name = t.value;
          } else if (member && isP(k, "[") && isP(k + 2, "]") && isP(k + 3, ":")) {
            // `[NI]: true` with `NI = "nodeIntegration"` a constant, or `["sandbox"]: …`; a
            // key that cannot be read is handled where the window's options are located.
            const inner = tokens[k + 1]!;
            name =
              inner.type === "string"
                ? inner.value
                : inner.type === "ident"
                  ? constantKey(k + 1)
                  : null;
            valueAt = k + 4;
          } else if (
            member &&
            t.type === "ident" &&
            (t.value === "get" || t.value === "set" || t.value === "async") &&
            (tokens[k + 1]?.type === "ident" || tokens[k + 1]?.type === "string") &&
            isP(k + 2, "(")
          ) {
            name = tokens[k + 1]!.value;
            accessor = true;
            valueAt = k + 2;
          } else if (member && (t.type === "ident" || t.type === "string") && isP(k + 1, "(")) {
            name = t.value;
            accessor = true;
            valueAt = k + 1;
          }
          if (accessor) {
            // a method only when a body follows the parameters: `f(a, sandbox(x))` is a call
            let close = valueAt;
            for (let d = 0; close < tokens.length && close < valueAt + 200; close++) {
              if (isP(close, "(")) d++;
              else if (isP(close, ")") && --d === 0) break;
            }
            if (!isP(close + 1, "{")) name = null;
          }
          if (name === null || !tokens[valueAt]) continue;
          if (name === "preload") {
            // `preload: …` and `"preload": …` (read where the text says so, see below)
            if (t.type === "ident" && valueAt === k + 2 && !accessor) preloadsAt.add(t.start);
            else if (t.type === "string" && valueAt === k + 2 && !accessor)
              preloadsAt.add(t.start + 1);
            else if (isP(k, "[") && tokens[k + 1]?.type === "string" && valueAt === k + 4)
              preloadsAt.add(tokens[k + 1]!.start + 1);
          } else if (BOOLEAN_KEYS.has(name) && accessor) {
            // A getter or method decides the value when the window reads it: not a literal.
            settingsAt.push({
              key: name as Exclude<PreferenceKey, "preload">,
              value: null,
              computed: `${t.value === name ? "" : `${t.value} `}${name}() {…}`,
              start: t.start,
            });
          } else if (BOOLEAN_KEYS.has(name)) {
            const key = name as Exclude<PreferenceKey, "preload">;
            const v = tokens[valueAt]!;
            const n = tokens[valueAt + 1];
            // true, false, and what minifiers and obfuscators write for them: !0, !1, !0x0
            const value =
              v.type === "ident" && (v.value === "true" || v.value === "false")
                ? v.value === "true"
                : v.type === "punct" && v.value === "!" && n?.type === "number"
                  ? negatedNumber(n.value)
                  : null;
            // `sandbox: true && flag` is not the setting `true`: the value must end there.
            const after = tokens[v.type === "ident" ? valueAt + 1 : valueAt + 2];
            const ends =
              !after || (after.type === "punct" && (after.value === "," || after.value === "}"));
            if (value !== null && ends) settingsAt.push({ key, value, start: t.start });
            else {
              // Not a literal: the value is decided at run time. The expression is kept, up
              // to the `,` or `}` that ends the property, so a reader sees what decides it.
              let nested = 0;
              let end = valueAt;
              for (; end < tokens.length && end < valueAt + 58; end++) {
                const p = tokens[end]!;
                if (p.type !== "punct") continue;
                if (p.value === "(" || p.value === "[" || p.value === "{") nested++;
                else if (p.value === ")" || p.value === "]" || p.value === "}") {
                  if (nested === 0) break;
                  nested--;
                } else if (p.value === "," && nested === 0) break;
              }
              const computed = source
                .slice(v.start, tokens[end - 1]?.end ?? v.end)
                .replace(/\s+/g, " ")
                .slice(0, 80);
              settingsAt.push({ key, value: null, computed, start: t.start });
            }
          }
        }
      }
      // Endpoints, storage and URL literals: only where the text can contain one at all.
      if (CAN_HOLD_CANDIDATES.test(source)) {
        candidates = findCandidates(tokens, source, undefined, context.aliases, context.constants);
        // Storage wrappers: the ones other modules may call (only an exported class or object
        // counts), and calls of the file's own ones on proven instances (one bundle: esbuild,
        // webpack) that the resolver's in-file reading did not give. One reader for both.
        if (candidates.openKeys?.length) {
          const resolver = new ExpressionResolver(tokens, context.constants);
          const reader = new WrapperReader(tokens, resolver, context.constants);
          reader.findKeyWrappers(candidates.openKeys);
          if (reader.classes.length) {
            if (/export|module\.exports|exports\./.test(source)) keyWrappers = reader.facts();
            // A method of such a wrapper the file replaces, in any form the stage across modules
            // reads (`({ a: local.get } = …)`, `local.get ??= f`, `Object.assign(local, o)`,
            // `Reflect.set(local, k, f)`): its calls give no row in the file either.
            // Read only where a call of such a method in the file gives a row.
            let calls = reader.keyCalls(false, true);
            const through = new Set(
              reader.classes.flatMap((c) => Object.keys(c.methods).map((m) => `${c.name}.${m}`)),
            );
            if (calls.length || candidates.storage.some((r) => r.via && through.has(r.via))) {
              const own = reader.readOwnReplacements();
              if (own.unchecked) ownKeyUnchecked = true;
              if (own.found.length) {
                ownKeyReplaced = [
                  ...new Set(own.found.map((x) => `${x.via}:${reader.lineOf(x.at)}`)),
                ].slice(0, 20);
                // the rows the resolver's own reading gave through such a method go as well
                const gone = new Set(own.found.map((x) => x.via));
                candidates.storage = candidates.storage.filter((r) => !r.via || !gone.has(r.via));
                calls = reader.keyCalls(false, true);
              }
            }
            if (reader.keyCallsCut) candidates.keyCallsCapped = true;
            if (calls.length) {
              const unknownKinds = new Set<string>(
                candidates.storage.filter((r) => r.value === null).map((r) => r.kind),
              );
              addOwnKeyRows(
                candidates,
                keyCallRows(
                  { source, tokens, constants: context.constants, resolver },
                  calls,
                  () => null,
                  null,
                  { unknownKinds: new Set(unknownKinds) },
                ),
              );
            }
          }
        }
        delete candidates.openKeys;
      }
      if (/setWindowOpenHandler|will-navigate|will-frame-navigate/.test(source))
        navigation = navigationHandlers(
          tokens,
          path,
          new Set(ranges.flatMap((r) => (r.window !== null && r.name ? [r.name] : []))),
          new ExpressionResolver(tokens, context.constants),
        );
      if (source.includes("@electron/remote"))
        remote = remoteEnables(
          tokens,
          path,
          new Set(ranges.flatMap((r) => (r.window !== null && r.name ? [r.name] : []))),
          new ExpressionResolver(tokens, context.constants),
        );
      if (SWITCH_PROBE.test(source))
        switches = switchRows(
          tokens,
          path,
          new ExpressionResolver(tokens, context.constants),
          context.constants,
        );
      if (source.includes("openExternal"))
        openExternal = openExternalRows(
          tokens,
          path,
          new ExpressionResolver(tokens, context.constants),
          context.constants,
        );
      if (/setPermission(Request|Check)Handler/.test(source))
        permissionHandlers = permissionHandlerRows(
          tokens,
          path,
          new ExpressionResolver(tokens, context.constants),
          context.constants,
        );
      if (/content-security-policy/i.test(source))
        cspHeaders = cspHeaderRows(
          tokens,
          path,
          new ExpressionResolver(tokens, context.constants),
          context.constants,
        );
      if (/executeJavaScript|insertCSS/.test(source))
        dangerousCalls = dangerousCallRows(
          tokens,
          path,
          new ExpressionResolver(tokens, context.constants),
          context.constants,
        );
      if (!source.includes("exposeIn")) return;
      bridge = bridgeMembers({ tokens, truncated, context }, path);
    },
  });
  return {
    scan,
    ambient,
    located,
    ranges,
    mutated: [...mutated],
    sandboxCall,
    settingsAt,
    preloadsAt: [...preloadsAt],
    braces,
    preferenceObjects: [...preferenceObjects],
    candidates,
    keyWrappers,
    ...(ownKeyReplaced ? { keyReplaced: ownKeyReplaced } : {}),
    ...(ownKeyUnchecked ? { keyUnchecked: true as const } : {}),
    bridge,
    navigation,
    switches,
    openExternal,
    permissionHandlers,
    cspHeaders,
    dangerousCalls,
    remote,
  };
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
    /** Token facts already read for some files (in worker threads); the rest is read here. */
    prepared?: ReadonlyMap<string, FileTokenFacts>;
    /** Files scanned so far in this run (and "linking" once they are), for a progress line. */
    onProgress?: (phase: "scanning" | "linking", done: number, total: number) => void;
    /** Budgets of the analysis, for tests that reach one with a small input. */
    budgets?: {
      /** Work of the wrapper replacement scan of the application (default 3,000,000). */
      replacementAppWork?: number;
      /** Tokens read per file (default 2,000,000); applies to the files read on this thread. */
      fileTokens?: number;
    };
  } = {},
): JsAppInfo {
  const maxJsFiles = options.maxJsFiles ?? 5000;
  const replacementBudget =
    options.budgets?.replacementAppWork === undefined
      ? {}
      : { replacementAppWork: options.budgets.replacementAppWork };
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
  const jsFiles = jsFilesOf(tree);
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
  // Stored with the scan: a cap met in an earlier run still limits the result of a later one.
  let ambientCapped = facts.ambientCapped;
  /** Writes the running counters back, so `facts` is a complete, storable state. */
  const sync = (): JsScanFacts => {
    facts.bytes = bytes;
    facts.skipped = skipped;
    facts.electronSeen = electronSeen;
    facts.prefsCapped = prefsCapped;
    facts.bridgeCapped = bridgeCapped;
    facts.ambientCapped = ambientCapped;
    facts.externals = Object.fromEntries(externals);
    facts.preloadScripts = [...preloadScripts];
    return facts;
  };

  // A fixed order: the entry file, then shallow paths before deep ones, then by path. Entry
  // points and preloads sit near the root, so the first batch sees them; and because the order
  // depends on nothing but the file list, a continued scan takes up exactly where it stopped.
  const ordered = scanOrder(jsFiles, pkg?.main ?? null);
  const done = new Set(facts.scanned);
  const wanted = options.include?.length ? pathMatcher(options.include) : null;
  const todo = ordered.filter((f) => !done.has(f.path) && (!wanted || wanted(f.path)));
  // 0 is meaningful (show a stored scan without reading); anything else is at least one file.
  const batch = Number.isFinite(maxJsFiles) && maxJsFiles >= 1 ? Math.floor(maxJsFiles) : 5000;
  const runFiles = options.all ? Number.POSITIVE_INFINITY : maxJsFiles === 0 ? 0 : batch;
  let runBytes = 0;
  let taken = 0;

  // Modules read again for following window options across files, each tokenized once.
  const modulesRead = new Map<string, ReadModule | null>();
  const host: ModuleHost = {
    load: (from, specifier) => {
      const target = resolveSpecifier(from, specifier, known);
      if (!target) return null;
      if (!modulesRead.has(target)) {
        try {
          modulesRead.set(target, moduleResolver(target, decode(tree.read(target, maxFileBytes))));
        } catch {
          modulesRead.set(target, null);
        }
      }
      return modulesRead.get(target)?.resolver ?? null;
    },
  };
  const moduleResolver = (
    path: string,
    text: string,
    scanned?: { tokens: Token[]; constants: Constants } | null,
  ): ReadModule => {
    const cached = modulesRead.get(path);
    if (cached) return cached;
    // The scan's own tokens of the file when it has them: the same stream (same tokenizer, same
    // limit), and the resolver tables built on it during the scan are shared, not built again;
    // so are the scan's constants, read as a fresh `Constants` of those tokens would read them.
    const tokens = scanned?.tokens ?? tokenize(text).tokens;
    const constants = scanned ? scanned.constants.withoutEvaluator() : new Constants(tokens);
    let names: Map<number, string> | null = null;
    const made: ReadModule = {
      source: text,
      tokens,
      constants,
      resolver: new ExpressionResolver(tokens, constants, path, host),
      // another name for ipcMain or ipcRenderer, read once and only when asked
      ipcAt: (k) => {
        names ??= /ipcMain|ipcRenderer/.test(text)
          ? resolveAliases(tokens, IPC_OBJECTS)
          : new Map<number, string>();
        return names.get(k) ?? ipcName(tokens[k]);
      },
    };
    modulesRead.set(path, made);
    return made;
  };

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
    options.onProgress?.("scanning", taken, Math.min(todo.length, runFiles));
    if (file.size > maxFileBytes) {
      skipped++;
      if (facts.skippedFiles.length < MAX_NAMED_FILES) facts.skippedFiles.push(file.path);
      continue;
    }
    let source: string;
    try {
      source = decode(tree.read(file.path, maxFileBytes));
    } catch {
      skipped++;
      if (facts.skippedFiles.length < MAX_NAMED_FILES) facts.skippedFiles.push(file.path);
      continue;
    }
    runBytes += file.size;
    bytes += file.size;
    /** The file's tokens when this thread tokenized it (not when a worker did). */
    let scanned: { tokens: Token[]; constants: Constants } | null = null;
    const tokenFacts =
      options.prepared?.get(file.path) ??
      readFileTokens(
        file.path,
        source,
        (tokens, constants) => (scanned = { tokens, constants }),
        options.budgets?.fileTokens,
      );
    const { scan, located, ranges, sandboxCall, settingsAt, braces } = tokenFacts;
    const ambient = tokenFacts.ambient;
    const mutated = new Set(tokenFacts.mutated);
    const preloadsAt = new Set(tokenFacts.preloadsAt);
    const preferenceObjects = new Map(tokenFacts.preferenceObjects);
    /** The start of the innermost object or block that holds the offset. */
    const objectAt = (offset: number): number => {
      let inner = -1;
      for (const [start, end] of braces) {
        if (start > offset) break;
        if (offset < end) inner = start;
      }
      return inner;
    };
    const cand = tokenFacts.candidates;
    if (cand) {
      if (cand.truncated) facts.candidatesCapped = true;
      if (cand.clientsSkipped)
        fileLimitation(facts, file.path, {
          code: "client_calls_skipped",
          message: `${file.path}: more than 2,000 calls of HTTP client modules (node:https, node:http, Electron's net) were checked; the further ones give no endpoint rows.`,
        });
      if (cand.clientWritesSkipped)
        fileLimitation(facts, file.path, {
          code: "client_writes_skipped",
          message: `${file.path}: more writes of HTTP client names (or bindings made from clients) than are checked (2,000 writes, 32,000 questions), or more functions than the resolver reads (60,000); requests on a name written past that point are unknown rows, also where the address is a literal.`,
        });
      if (cand.keyCallsCapped) {
        facts.keyCallsCapped = (facts.keyCallsCapped ?? 0) + 1;
        if ((facts.keyCallsCappedFiles ??= []).length < 5)
          facts.keyCallsCappedFiles.push(file.path);
      }
      if (cand.wrappersSkipped)
        fileLimitation(facts, file.path, {
          code: "storage_wrappers_skipped",
          message: `${file.path}: the file has more functions than storage wrappers are followed for (50,000); keys passed through a wrapper there are not read at each call (no rows with via).`,
        });
      for (const [from, to] of [
        [cand.endpoints, facts.endpoints],
        [cand.storage, facts.storage],
        [cand.urls, facts.urls],
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
    const bridge = tokenFacts.bridge;
    if (bridge) {
      const room = MAX_BRIDGE - contextBridge.length;
      contextBridge.push(...bridge.members.slice(0, room));
      if (bridge.truncated || bridge.members.length > room) bridgeCapped = true;
      const exposures = (facts.bridgeExposures ??= []);
      const left = MAX_BRIDGE - exposures.length;
      exposures.push(...(bridge.exposures ?? []).slice(0, left));
      if ((bridge.exposures ?? []).length > left) bridgeCapped = true;
      if (bridge.forwarders?.length) {
        const kept = (facts.bridgeForwarders ??= []);
        const room2 = MAX_BRIDGE - kept.length;
        kept.push(...bridge.forwarders.slice(0, room2));
        if (bridge.forwarders.length > room2) bridgeCapped = true;
      }
    }
    if (tokenFacts.navigation?.length) {
      const handlers = (facts.navigationHandlers ??= []);
      const left = MAX_PREFS - handlers.length;
      handlers.push(...tokenFacts.navigation.slice(0, left));
      if (
        tokenFacts.navigation.length > left ||
        tokenFacts.navigation.length >= MAX_NAVIGATION_PER_FILE
      )
        facts.navigationCapped = true;
    }
    if (tokenFacts.remote) {
      const rows = (facts.remoteEnabled ??= []);
      const left = MAX_PREFS - rows.length;
      rows.push(...tokenFacts.remote.rows.slice(0, left));
      if (tokenFacts.remote.capped || tokenFacts.remote.rows.length > left)
        facts.remoteCapped = true;
    }
    if (tokenFacts.switches) {
      // past the cap only rows known to be harmless are dropped (keepSwitchRows)
      const rows = (facts.switches ??= []);
      if (keepSwitchRows(rows, tokenFacts.switches.rows, MAX_PREFS) || tokenFacts.switches.capped)
        facts.switchesCapped = true;
    }
    // past the caps only rows known to be harmless are dropped (keepRows)
    if (tokenFacts.openExternal) {
      const rows = (facts.openExternal ??= []);
      if (
        keepRows(rows, tokenFacts.openExternal.rows, MAX_PREFS, harmlessOpenExternal) ||
        tokenFacts.openExternal.capped
      )
        facts.openExternalCapped = true;
    }
    if (tokenFacts.permissionHandlers) {
      const rows = (facts.permissionHandlers ??= []);
      if (
        keepRows(rows, tokenFacts.permissionHandlers.rows, MAX_PREFS, harmlessPermission) ||
        tokenFacts.permissionHandlers.capped
      )
        facts.permissionHandlersCapped = true;
    }
    if (tokenFacts.cspHeaders) {
      const rows = (facts.cspHeaders ??= []);
      if (
        keepRows(rows, tokenFacts.cspHeaders.rows, MAX_PREFS, harmlessCsp) ||
        tokenFacts.cspHeaders.capped
      )
        facts.cspCapped = true;
    }
    if (tokenFacts.dangerousCalls) {
      const rows = (facts.dangerousCalls ??= []);
      if (
        keepRows(rows, tokenFacts.dangerousCalls.rows, MAX_PREFS, harmlessDangerousCall) ||
        tokenFacts.dangerousCalls.capped
      )
        facts.dangerousCallsCapped = true;
    }
    if (tokenFacts.keyReplaced)
      fileLimitation(facts, file.path, {
        code: "wrapper_method_replaced",
        message: `${file.path}: ${tokenFacts.keyReplaced.length} method(s) of storage wrappers of the file are replaced in the file by a member write on the class, its prototype or an instance (or one whose receiver was not read within the budget), so their calls there give no storage rows through them: ${tokenFacts.keyReplaced.join(", ")}.`,
      });
    if (scan.wrappersUnchecked || tokenFacts.keyUnchecked)
      fileLimitation(facts, file.path, {
        code: "wrapper_replacements_unchecked",
        message: `${file.path}: the writes in the file that may replace a method of its own ${scan.wrappersUnchecked && tokenFacts.keyUnchecked ? "IPC and storage" : scan.wrappersUnchecked ? "IPC" : "storage"} wrappers were not all read: a computed member write on the class, its prototype or an instance (\`this[key] = value\`), which may replace a method, or a write past the replacement budget of the file (200,000 steps); calls of those methods in the file are read without that check, so a method replaced there would not be seen.`,
      });
    if (scan.wrappersReplaced)
      fileLimitation(facts, file.path, {
        code: "wrapper_method_replaced",
        message: `${file.path}: ${scan.wrappersReplaced.length} method(s) of IPC wrappers of the file are replaced in the file by a member write on the class, its prototype or an instance (or one whose receiver was not read within the budget), so their calls there are not read (no IPC rows through them): ${scan.wrappersReplaced.join(", ")}.`,
      });
    if (scan.wrappersUndecided)
      fileLimitation(facts, file.path, {
        code: "ipc_wrapper_param_undecided",
        message: `${file.path}: for ${scan.wrappersUndecided.length} channel-forwarding helper(s) of the file it could not be decided whether a nearer declaration of the parameter's name hides the parameter where it is passed on to IPC (a nesting too deep to read); their calls are read as passing their first argument on as the channel, which may be wrong: ${scan.wrappersUndecided.map((w) => `${w.slice(0, w.lastIndexOf(":"))} at ${file.path}:${w.slice(w.lastIndexOf(":") + 1)}`).join(", ")}.`,
      });
    if (scan.wrappersCapped)
      fileLimitation(facts, file.path, {
        code: "ipc_wrappers_capped",
        message: `${file.path}: the search for calls of IPC wrapper methods ran out of its budget, or a function that takes ipcMain or ipcRenderer as a parameter is called at more places than are read (64); calls of them past that are missing.`,
      });
    if (scan.truncated) {
      facts.truncated = (facts.truncated ?? facts.truncatedFiles.length) + 1;
      if (facts.truncatedFiles.length < MAX_NAMED_FILES) facts.truncatedFiles.push(file.path);
    }
    if (scan.truncated)
      fileLimitation(facts, file.path, {
        code: "scan_truncated",
        message: `${file.path}: token budget exhausted; references after the cut are missing.`,
      });
    const open = ambient as ReturnType<typeof collectAmbient> | null;
    if (open?.ipc.length) {
      scan.ipc.push(...open.ipc);
      scan.ipc.sort((x, y) => x.line - y.line);
    }
    if (open?.truncated) ambientCapped = true;
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
    /** Lines of `webPreferences` objects no located window takes (see windowsOf). */
    const unattached = new Set<number>();
    const windowsOf = (
      index: number,
    ): Array<{
      window: number | null;
      windowName: string | null;
      inherited: boolean;
      order: number;
      scope: number;
      group: number | null;
      groupOrder: number;
    }> => {
      if (ranges.length) {
        // The innermost range decides which window it is; a helper used by two windows has one
        // range per window with the same extent, and the setting then counts for each.
        // A range that belongs to a window comes before one that belongs to none: an options
        // object declared above its `new BrowserWindow(options)` is met first as a bare
        // `webPreferences: {…}`, and its settings are still that window's.
        let best: WindowRange | undefined;
        for (const bound of [true, false]) {
          for (const r of ranges)
            if (
              (r.window !== null) === bound &&
              index >= r.start &&
              index < r.end &&
              (!best || r.end - r.start < best.end - best.start)
            )
              best = r;
          if (best) break;
        }
        if (!best) return [];
        // A `webPreferences: {…}` that no window of this file takes, in a file whose windows
        // were located (a table of refused settings, a manifest check): not a window's setting.
        // It is named in a limitation instead, so it is not lost.
        if (best.window === null && ranges.some((r) => r.window !== null))
          unattached.add(lineAt(best.start));
        const { start, end } = best;
        const same = ranges.filter((r) => r.start === start && r.end === end);
        // Where the write takes effect in the window's own options, at two levels.
        // Key level: the object the key is written into, and the place of the write: its own,
        // or where its base object is applied. Object level: a `webPreferences: {…}` is itself
        // one write of the key `webPreferences` into the options (`group`) at the place of that
        // key (`groupOrder`); a later such write, or a base spread later that brings its own
        // `webPreferences`, replaces the whole earlier object.
        const inner = objectAt(index);
        const placed = (
          r: WindowRange,
        ): { order: number; scope: number; group: number | null; groupOrder: number } => {
          if (r.at !== null && preferenceObjects.has(inner)) {
            // inside the base's own `webPreferences`: the base replaces that whole object
            return { scope: inner, order: index, group: objectAt(r.at), groupOrder: r.at };
          }
          const order = r.at ?? index;
          const scope = objectAt(order);
          const key = preferenceObjects.get(scope);
          return key === undefined
            ? { scope, order, group: null, groupOrder: 0 }
            : { scope, order, group: objectAt(key), groupOrder: key };
        };
        return [
          ...new Map(
            same.map((r) => [
              r.window,
              { window: r.window, windowName: r.name, inherited: r.inherited, ...placed(r) },
            ]),
          ).values(),
        ];
      }
      const before = source.slice(Math.max(0, index - WINDOW_CONTEXT), index);
      return /webPreferences|BrowserWindow|BrowserView|WebContentsView/.test(before)
        ? [
            {
              window: null,
              windowName: null,
              inherited: false,
              order: index,
              scope: index,
              group: null,
              groupOrder: 0,
            },
          ]
        : [];
    };
    // Settings of this file first; what a window overrides is dropped before they are kept.
    type Written = WebPreference & {
      inherited: boolean;
      order: number;
      scope: number;
      group: number | null;
      groupOrder: number;
    };
    const found: Written[] = [];
    const record = (pref: Written): boolean => {
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
      // `preload: …`, `"preload": …` and `["preload"]: …` (preloadsAt holds the place after
      // the quote)
      const m = /^preload(?:["']\]?)?\s*:\s*/.exec(source.slice(at, at + 24));
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
    settings: for (const { key, value, computed, start } of settingsAt)
      for (const w of windowsOf(start))
        if (
          !record({
            key,
            value,
            ...(computed === undefined ? {} : { computed }),
            file: file.path,
            line: lineAt(start),
            ...w,
          })
        )
          break settings;
    // Windows whose options could not be followed by ranges: evaluate the options expression,
    // across modules if need be. What it reads replaces the rows of that window; keys it cannot
    // read stay computed.
    const evaluated = new Map<number, Set<string>>();
    const opaque = (located as WindowRanges | null)?.opaque;
    if (opaque?.size) {
      const own = moduleResolver(file.path, source, scanned);
      const tokens = own.tokens;
      for (const r of ranges) {
        if (r.window === null || r.inherited || r.at !== null || !opaque.has(r.window)) continue;
        const paren = tokenAtOffset(tokens, r.start);
        if (paren === -1 || tokens[paren]!.value !== "(") continue;
        // one value, or one per call of the function the window is created in
        const { values, partial } = own.resolver.valuesAt(paren + 1);
        const reads = values.map(optionSettings);
        if (!reads.length || reads.some((x) => x === null)) continue;
        const read = {
          settings: reads.flatMap((x) => x!.settings),
          unknown: new Set(reads.flatMap((x) => [...x!.unknown])),
        };
        const window = r.window;
        // A caller whose options cannot be read may set any key, unless a whole `webPreferences`
        // is written after every place such options are applied: then they reach no setting.
        const whole = (located as WindowRanges).wholePrefs.get(window);
        const replaced = whole !== undefined && whole > opaque.get(window)!;
        if (partial && !replaced)
          for (const key of ["preload", ...BOOLEAN_KEYS]) read.unknown.add(key);
        const windowLine = lineAt(r.start);
        // Where the evaluation cannot read a key, the rows as written stay, and the key is not
        // known for the window, unless the code writes it after the last place that could not
        // be followed: then it stands, as for every located window below.
        const hiddenUpTo = opaque.get(window)!;
        const standing = found
          .filter((o) => o.window === window && o.order > hiddenUpTo && read.unknown.has(o.key))
          .map((o) => o.key);
        const readKeys = new Set(read.settings.map((x) => x.key));
        for (let i = found.length - 1; i >= 0; i--)
          if (
            found[i]!.window === window &&
            (!read.unknown.has(found[i]!.key) || readKeys.has(found[i]!.key))
          )
            found.splice(i, 1);
        for (const key of standing) read.unknown.delete(key);
        let order = 0;
        const seen = new Set<string>();
        for (const { key, value, src } of read.settings) {
          const id = `${key}\u0000${String(value)}\u0000${src.file}:${src.line}`;
          if (seen.has(id)) continue;
          seen.add(id);
          record({
            key: key as PreferenceKey,
            value,
            file: file.path,
            line: src.file === file.path ? src.line : windowLine,
            ...(src.file === file.path ? {} : { definedIn: src }),
            window,
            windowName: r.name,
            inherited: false,
            order: order++,
            scope: -1 - window,
            group: null,
            groupOrder: 0,
          });
        }
        evaluated.set(window, read.unknown);
        // still named as not followed when one of the calls could not be read
        if (!partial) opaque.delete(window);
      }
    }
    // Bases another module exports (`Object.assign({}, windowConfig.secureDefaults, {…})`,
    // `...windowConfig.secureDefaults`): evaluated across modules and applied where they stand,
    // so the later of two writes of a key in the same object wins. A base that cannot be read
    // whole may write any key from its place on, as an unknown spread does.
    // Only for windows that are still not known once their whole options were evaluated above.
    const externalBases = ((located as WindowRanges | null)?.externals ?? []).filter((e) =>
      located!.opaque.has(e.window),
    );
    if (externalBases.length) {
      const own = moduleResolver(file.path, source, scanned);
      for (const ext of externalBases) {
        const at = tokenAtOffset(own.tokens, ext.expr);
        const { values, partial } =
          at === -1 ? { values: [], partial: true } : own.resolver.valuesAt(at);
        // A base applied inside a `webPreferences` object, or given there, holds the settings
        // themselves; one laid over a window's options holds them under `webPreferences`.
        const prefsLevel = ext.level === "prefs" || preferenceObjects.has(objectAt(ext.at));
        const reads = values.map((v) =>
          optionSettings(
            prefsLevel && v ? { kind: "obj", props: new Map([["webPreferences", v]]) } : v,
          ),
        );
        const read = reads.length === 1 && !partial ? reads[0] : null;
        if (!read || read.unknown.size) continue;
        // Read whole: this place no longer hides anything; the window stays hidden only up to
        // the last other place that does.
        const left = [...(located!.hides.get(ext.window) ?? [])];
        const index = left.indexOf(ext.at);
        if (index !== -1) left.splice(index, 1);
        located!.hides.set(ext.window, left);
        if (left.length) located!.opaque.set(ext.window, Math.max(...left));
        else located!.opaque.delete(ext.window);
        const name = ranges.find((r) => r.window === ext.window && !r.inherited)?.name ?? null;
        const scope = objectAt(ext.at);
        const groupKey = preferenceObjects.get(scope);
        const line = lineAt(ext.at);
        for (const { key, value, src } of read.settings)
          if (
            !record({
              key: key as PreferenceKey,
              value,
              file: file.path,
              line: src.file === file.path ? src.line : line,
              ...(src.file === file.path ? {} : { definedIn: src }),
              window: ext.window,
              windowName: name,
              inherited: true,
              order: ext.at,
              scope,
              group: groupKey === undefined ? null : objectAt(groupKey),
              groupOrder: groupKey ?? 0,
            })
          )
            break;
      }
    }
    // A `webPreferences: {…}` that no window of this file takes (a table of refused settings, a
    // manifest check) is not a window's setting, once every window's options are known. While a
    // window's options are not, such an object may be them, and its rows stay (window null).
    const windowsKnown =
      !(located as WindowRanges | null)?.opaque.size &&
      !(mutated.size && (located as WindowRanges | null)?.viaName.size);
    if (unattached.size && windowsKnown) {
      for (let i = found.length - 1; i >= 0; i--) if (found[i]!.window === null) found.splice(i, 1);
      fileLimitation(facts, file.path, {
        code: "webpreferences_unattached",
        message: `${file.path}: ${unattached.size === 1 ? "a webPreferences object" : `${unattached.size} webPreferences objects`} at line ${[...unattached].slice(0, 10).join(", ")}${unattached.size > 10 ? " …" : ""} that no window in the file takes (its settings are not listed as a window's).`,
      });
    }
    // Every located window, so one that writes no setting at all is still a row.
    for (const r of ranges) {
      if (r.window === null || r.inherited || facts.windows.length >= MAX_PREFS) continue;
      if (facts.windows.some((w) => w.file === file.path && w.window === r.window)) continue;
      const where = located as WindowRanges | null;
      const hiddenUpTo = where?.opaque.get(r.window);
      // A whole `webPreferences` written after every place that could not be followed decides
      // every setting: `{ ...display.bounds, webPreferences }` takes nothing of the spread's.
      const whole = where?.wholePrefs.get(r.window);
      const replaced = hiddenUpTo !== undefined && whole !== undefined && whole > hiddenUpTo;
      // A change to a followed object concerns the windows that take options from such an
      // object; a window whose options are all written in place cannot be changed that way.
      const computedKeys = new Set<string>(where?.viaName.has(r.window) ? mutated : []);
      for (const key of evaluated.get(r.window) ?? []) computedKeys.add(key);
      if (hiddenUpTo !== undefined && !replaced)
        // What could not be followed may write any key; a key the code writes for the window
        // after that place stands, every other one is not known.
        for (const key of ["preload", ...BOOLEAN_KEYS])
          if (!found.some((o) => o.window === r.window && o.key === key && o.order > hiddenUpTo))
            computedKeys.add(key);
      facts.windows.push({
        file: file.path,
        window: r.window,
        windowName: r.name ?? `#${r.window}`,
        line: lineAt(r.start),
        ...(computedKeys.size ? { computed: [...computedKeys] } : {}),
        // the settings are all known when a whole `webPreferences` replaced what was not read
        ...(hiddenUpTo === undefined || replaced ? {} : { opaque: true as const }),
      });
    }
    if (sandboxCall === "always") facts.enableSandbox = "always";
    else if (sandboxCall === "maybe" && facts.enableSandbox !== "always")
      facts.enableSandbox = "maybe";
    // A literal the evaluation of a window's options has placed (a base spread into a helper's
    // `webPreferences`, an override passed to it) is that window's row; the same line without a
    // window would list the one write twice. A window that is not fully known keeps its
    // computed keys, so nothing it may take is hidden by this.
    const placedLines = new Set(
      found
        .filter((o) => o.window !== null && o.definedIn === undefined)
        .map((o) => `${o.key}\u0000${String(o.value)}\u0000${o.line}`),
    );
    for (let i = found.length - 1; i >= 0; i--) {
      const o = found[i]!;
      if (o.window === null && placedLines.has(`${o.key}\u0000${String(o.value)}\u0000${o.line}`))
        found.splice(i, 1);
    }
    for (const { inherited: _inherited, order, scope, group, groupOrder, ...pref } of found) {
      if (pref.window !== null) {
        // A whole `webPreferences` object that a later write of that key replaces: gone with
        // everything in it (`{ ...base, webPreferences: {…} }` keeps nothing of the base's).
        if (
          group !== null &&
          found.some(
            (o) => o.window === pref.window && o.group === group && o.groupOrder > groupOrder,
          )
        )
          continue;
        // The same key written twice into ONE object, directly or through a base that is spread
        // into it: the later write wins, as in JavaScript (`{ sandbox: true, ...base }` takes
        // the base's value). Writes in two separate objects of a window are both kept: which of
        // them takes effect cannot be read, and dropping one could hide the unsafe value.
        if (
          found.some(
            (o) =>
              o.window === pref.window &&
              o.key === pref.key &&
              o.scope === scope &&
              o.order > order,
          )
        )
          continue;
      }
      webPreferences.push(pref);
      if (pref.key === "preload") preloadScripts.add(String(pref.value));
      // Where windows could be located, an object that belongs to none of them (a base that is
      // spread and overridden, options only handed to a function) does not speak for the app.
      else if (
        isCoreKey(pref.key) &&
        typeof pref.value === "boolean" &&
        (pref.window !== null || !ranges.some((r) => r.window !== null))
      ) {
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
      ...(scan.reexports ? { reexports: scan.reexports } : {}),
      ...(scan.starExports ? { starExports: scan.starExports } : {}),
      ...(scan.looseStarExports ? { looseStarExports: scan.looseStarExports } : {}),
      ...(scan.evaluated ? { evaluated: scan.evaluated } : {}),
      ...(scan.unevaluated ? { unevaluated: scan.unevaluated } : {}),
      ...(scan.wrappers ? { wrappers: scan.wrappers } : {}),
      ...(tokenFacts.keyWrappers ? { keyWrappers: tokenFacts.keyWrappers } : {}),
      ...(scan.paramIpc ? { paramIpc: scan.paramIpc } : {}),
      ...(open && (open.facts.defines || open.facts.calls || open.facts.replies)
        ? { ambient: open.facts }
        : {}),
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
  options.onProgress?.("linking", taken, taken);
  options.onFacts?.(sync());
  for (const limitation of facts.limitations) limitations.push(limitation);
  for (const [code, count] of Object.entries(facts.limitationsUnlisted ?? {}))
    limitations.push({
      code,
      message: `${count} more ${count === 1 ? "file has" : "files have"} this limitation (${code}); they are not listed one by one (the per-file list keeps ${MAX_FILE_LIMITATIONS} entries).`,
    });
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
    skippedFiles: [...facts.skippedFiles],
    partial: facts.truncated ?? facts.truncatedFiles.length,
    partialFiles: [...facts.truncatedFiles],
    filesUnlisted:
      skipped > facts.skippedFiles.length || (facts.truncated ?? 0) > facts.truncatedFiles.length,
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
  const moduleById = new Map(modules.map((m) => [m.id, m]));
  const openModule = (path: string): ReadModule | null => {
    if (!modulesRead.has(path)) {
      try {
        modulesRead.set(path, moduleResolver(path, decode(tree.read(path, maxFileBytes))));
      } catch {
        modulesRead.set(path, null);
      }
    }
    return modulesRead.get(path) ?? null;
  };

  // Bridge objects another module defines (`exposeInMainWorld("ipc", ipc)` with `export const ipc
  // = { auth, platform }` there): each entry whose value is another module's export is read in
  // that module, by the same member rules, a few modules deep. See docs/electron-findings.md.
  const bridgeLinks = linkBridgeValues({
    contextBridge,
    edges,
    resolve: (from, specifier) => resolveSpecifier(from, specifier, known),
    read: (path) => decode(tree.read(path, maxFileBytes)),
    open: openModule,
  });
  if (bridgeLinks.capped) bridgeCapped = true;
  if (bridgeLinks.forwarders.length)
    (facts.bridgeForwarders ??= []).push(
      ...bridgeLinks.forwarders.slice(
        0,
        Math.max(0, MAX_BRIDGE - (facts.bridgeForwarders?.length ?? 0)),
      ),
    );
  const linkedExposures = (facts.bridgeExposures ??= []);
  linkedExposures.push(
    ...bridgeLinks.exposures.slice(0, Math.max(0, MAX_BRIDGE - linkedExposures.length)),
  );
  // The page scripts' calls of generic forwarders (R1): rows in the calling files.
  const bridgeCalls = bridgeCallRows({
    forwarders: facts.bridgeForwarders ?? [],
    contextBridge,
    modules,
    text: (path) => {
      try {
        return decode(tree.read(path, maxFileBytes));
      } catch {
        return null;
      }
    },
    open: openModule,
    resolve: (from, specifier) => resolveSpecifier(from, specifier, known),
  });
  for (const [file, made] of bridgeCalls.rows) {
    const m = moduleById.get(file);
    if (!m) continue;
    // `const { ipcRenderer } = window; ipcRenderer.invoke("x")` also reads, by its name, as a
    // direct call of Electron's ipcRenderer: the call through the bridge replaces that row
    for (const u of made) {
      const same = m.ipc.findIndex(
        (x) =>
          x.api === u.api &&
          x.channel === u.channel &&
          x.line === u.line &&
          (x.via === undefined || x.via === "alias") &&
          !x.member,
      );
      if (same !== -1) m.ipc.splice(same, 1);
    }
    m.ipc.push(...made);
    m.ipc.sort((x, y) => x.line - y.line);
  }
  if (bridgeCalls.ambiguous.length)
    limitations.push({
      code: "bridge_forwarder_ambiguous",
      message: `${bridgeCalls.ambiguous.length} exposed member(s) pass their channel on, but the preloads that expose them do not do it the same way (another IPC method or another check), so which one a page script reaches is not known and its calls give no IPC rows: ${some(bridgeCalls.ambiguous, 5)}. ${
        bridgeCalls.ambiguousFiles.length
          ? `The page scripts read that name ${bridgeCalls.ambiguous.length === 1 ? "its api are" : "their apis are"} ${atPlaces(
              bridgeCalls.ambiguousFiles.map((f) => `${f}:1`),
              10,
            )}.`
          : `No page script read names ${bridgeCalls.ambiguous.length === 1 ? "its api" : "their apis"}. ${NOTHING_MISSING}`
      }`,
    });
  if (bridgeCalls.unread.length)
    limitations.push({
      code: "bridge_calls_unread",
      message: `${bridgeCalls.unread.length} file(s) were not read for page calls of exposed members that pass their channel on: ${some(bridgeCalls.unread, 5)}.${
        bridgeCalls.unreadFiles.length
          ? ` The calls not read are ${atPlaces(
              bridgeCalls.unreadFiles.map((f) => `${f}:1`),
              10,
            )}.`
          : ` Their calls are read as a page's. ${NOTHING_MISSING}`
      }`,
    });
  if (bridgeCalls.writes.length)
    limitations.push({
      code: "bridge_global_written",
      message: `${bridgeCalls.writes.length} write(s) of an exposed api as a global may replace the bridge on the pages that load them; the page rows are listed as read: ${list(bridgeCalls.writes, 5)}.`,
    });
  if (bridgeCalls.capped.length)
    limitations.push({
      code: "bridge_calls_capped",
      message: `${bridgeCalls.capped.length} page script(s) were not read for calls of exposed members that pass their channel on (more than ${MAX_BRIDGE_CALL_FILES} files, ${BRIDGE_CALL_WORK} tokens, or ${MAX_BRIDGE_CALLS_PER_FILE} calls in one file), so their IPC through those members is missing ${atPlaces(
        bridgeCalls.capped.map((f) => `${f}:1`),
        10,
      )}.`,
    });
  if (bridgeLinks.unread.length)
    limitations.push({
      code: "context_bridge_module_unread",
      message: `${bridgeLinks.unread.length} contextBridge ${bridgeLinks.unread.length === 1 ? "value comes" : "values come"} from another module whose export could not be read, so ${bridgeLinks.unread.length === 1 ? "its" : "their"} members are not listed: ${some(bridgeLinks.unread, 5)}. ${bridgeLinks.unreadAnywhere ? "The module of one of them was not located or lies deeper than is read, so the members not listed may be in any file." : `The members not listed are ${atPlaces(bridgeLinks.unreadAt, 10)}.`}`,
    });
  if (bridgeCapped)
    limitations.push({
      code: "context_bridge_truncated",
      message: `The contextBridge inventory is incomplete: a file exposes more than ${MAX_BRIDGE_PER_FILE} members, the app more than ${MAX_BRIDGE}, or an exposed object could not be read to its end.`,
    });
  const bridgeExposures = facts.bridgeExposures ?? [];
  const navigation = facts.navigationHandlers ?? [];
  const remote = facts.remoteEnabled ?? [];
  const switchList = facts.switches ?? [];
  const openExternalList = facts.openExternal ?? [];
  const permissionList = facts.permissionHandlers ?? [];
  const dangerousList = facts.dangerousCalls ?? [];
  // CSP <meta> tags of the app's HTML files (outside node_modules), read whole on every run: they
  // are few and small, and a continued scan would otherwise need them stored
  const cspList: CspRow[] = [...(facts.cspHeaders ?? [])];
  let cspCapped = facts.cspCapped ?? false;
  const htmlUnread: string[] = [];
  {
    let htmlBytes = 0;
    let htmlFiles = 0;
    for (const f of tree.files) {
      if (!/\.html?$/i.test(f.path) || f.path.includes("node_modules/")) continue;
      if (
        htmlFiles >= MAX_HTML_FILES ||
        f.size > maxFileBytes ||
        htmlBytes + f.size > MAX_HTML_BYTES
      ) {
        htmlUnread.push(f.path);
        continue;
      }
      htmlFiles++;
      htmlBytes += f.size;
      let text: string;
      try {
        text = decode(tree.read(f.path, maxFileBytes));
      } catch {
        htmlUnread.push(f.path);
        continue;
      }
      if (!/content-security-policy/i.test(text)) continue;
      const meta = cspMetaRows(text, f.path);
      if (keepRows(cspList, meta.rows, MAX_PREFS, harmlessCsp) || meta.capped) cspCapped = true;
    }
  }
  if (facts.openExternalCapped)
    limitations.push({
      code: "open_external_truncated",
      message: `More shell.openExternal calls exist than the ${MAX_SECURITY_ROWS_PER_FILE} per file / ${MAX_PREFS} in total that are recorded, or a file's reading of them ran out of its budget (collection openExternal); only calls with a literal URL were dropped.`,
    });
  if (facts.permissionHandlersCapped)
    limitations.push({
      code: "permission_handlers_truncated",
      message: `More permission handlers exist than the ${MAX_SECURITY_ROWS_PER_FILE} per file / ${MAX_PREFS} in total that are recorded, or a file's reading of them ran out of its budget (collection permissionHandlers); only handlers that never grant were dropped.`,
    });
  if (cspCapped)
    limitations.push({
      code: "csp_truncated",
      message: `More Content-Security-Policy rows exist than the ${MAX_SECURITY_ROWS_PER_FILE} per JavaScript file, ${MAX_META_PER_FILE} per HTML file or ${MAX_PREFS} in total that are recorded, or a file's reading of them ran out of its budget (collection csp).`,
    });
  if (facts.dangerousCallsCapped)
    limitations.push({
      code: "dangerous_calls_truncated",
      message: `More executeJavaScript / insertCSS calls exist than the ${MAX_SECURITY_ROWS_PER_FILE} per file / ${MAX_PREFS} in total that are recorded, or a file's reading of them ran out of its budget (collection dangerousCalls); only calls with literal code were dropped.`,
    });
  if (htmlUnread.length)
    limitations.push({
      code: "html_unread",
      message: `${htmlUnread.length} HTML file(s) were not read for Content-Security-Policy <meta> tags (more than ${MAX_HTML_FILES} files or ${MAX_HTML_BYTES >> 20} MiB of HTML, a file over ${maxFileBytes >> 20} MiB, or unreadable): ${list(htmlUnread, 5)} (collection csp).`,
    });
  // An unreadable entry whose value is itself a privileged object is established as such; any
  // other one may expose anything, which is said rather than reading "none exposed".
  const unestablished = contextBridge.filter(
    (b) =>
      b.member === null &&
      !bridgeExposures.some(
        (x) => x.member === null && x.file === b.file && x.line === b.line && x.api === b.api,
      ),
  ).length;
  const bridgeUnread = contextBridge.filter((b) => b.member === null).length;
  if (bridgeUnread)
    limitations.push({
      code: "context_bridge_members_unreadable",
      message: `${bridgeUnread} contextBridge ${bridgeUnread === 1 ? "entry is" : "entries are"} not a plain member of an object literal in the same file (a value built elsewhere, a spread or a computed key), so the exposed members are not all listed.${unestablished ? ` Whether ${unestablished === 1 ? "it exposes" : "they expose"} a privileged object directly (collection bridgeExposures) is not established.` : ""}`,
    });
  const undecidedExposures = bridgeExposures.filter((x) => x.undecided);
  if (undecidedExposures.length)
    limitations.push({
      code: "bridge_exposures_undecided",
      message: `${undecidedExposures.length} of the bridgeExposures ${undecidedExposures.length === 1 ? "row is" : "rows are"} listed although the scope of the exposed name could not be read to the end (field undecided: budget = the file's resolver budget ran out, scope = two declarations in one function, writes = more writes than are kept): ${list(
        undecidedExposures.map((x) => `${x.exposed} at ${x.file}:${x.line} (${x.undecided})`),
        5,
      )}. Such a row may be another binding of the same name; it is kept so that no exposure is dropped.`,
    });
  if (facts.remoteCapped)
    limitations.push({
      code: "remote_enabled_truncated",
      message: `More @electron/remote calls exist than the ${MAX_REMOTE_PER_FILE} per file / ${MAX_PREFS} in total that are recorded, or a webpack module of it is required under more than ${MAX_WEBPACK_NAMES} names in one file (collection remoteEnabled).`,
    });
  if (facts.switchesCapped)
    limitations.push({
      code: "switches_truncated",
      message: `More command-line switch and certificate rows exist than the ${MAX_SWITCHES_PER_FILE} per file / ${MAX_PREFS} in total that are recorded, or a file's reading of them ran out of its budget (collection switches).`,
    });
  if (facts.navigationCapped)
    limitations.push({
      code: "navigation_handlers_truncated",
      message: `More navigation handlers exist than the ${MAX_NAVIGATION_PER_FILE} per file / ${MAX_PREFS} in total that are recorded.`,
    });
  if (prefsCapped)
    limitations.push({
      code: "web_preferences_truncated",
      message: `More BrowserWindow settings exist than the ${MAX_PREFS_PER_FILE} per file / ${MAX_PREFS} in total that are recorded.`,
    });
  if (skipped) {
    // Name the reason: an unpacked entry whose `.unpacked` directory is missing is not "too large".
    const unpacked = new Set(tree.files.filter((f) => f.unpacked).map((f) => f.path));
    const outside = facts.skippedFiles.filter((f) => unpacked.has(f));
    const other = facts.skippedFiles.filter((f) => !unpacked.has(f));
    const parts: string[] = [];
    if (other.length || outside.length < skipped)
      parts.push(
        `${skipped - outside.length} exceed the per-file size limit or could not be decoded${other.length ? ` (e.g. ${other.slice(0, 3).join(", ")})` : ""}`,
      );
    if (outside.length)
      parts.push(
        tree.unpackedStamp
          ? `${outside.length} are stored outside the archive in its .unpacked directory and were not taken from the ZIP it came from (missing there, a link, or past the size limits; e.g. ${outside.slice(0, 3).join(", ")})`
          : `${outside.length} are stored outside the archive in its .unpacked directory, which was not found next to it (e.g. ${outside.slice(0, 3).join(", ")})`,
      );
    limitations.push({
      code: "js_files_skipped",
      message: `${skipped} files were not read: ${parts.join("; ")}.`,
    });
  }

  // Calls of wrapper classes and objects that another module defines (wrappers.ts): read in the
  // modules that import one, now that every module's exports are known. Nothing is read again
  // when no module exports a wrapper.
  const linked = linkWrappers({
    // the channel-forwarding wrappers only: this stage reads what it read before IPC object
    // parameters existed, within the same budgets
    modules: modules.map((m) => withFacts(m, factsFor(m.wrappers, false))),
    edges,
    resolve: (from, specifier) => resolveSpecifier(from, specifier, known),
    open: openModule,
    ...replacementBudget,
  });
  // Parameters used as the IPC object: a stage of its own, with its own budgets (what it could
  // not read leaves the functions another module may call undecided, see `paramIpcRows`); rows
  // once every call site, here and elsewhere, is known.
  const objectLinked = modules.some((m) => factsFor(m.wrappers, true))
    ? linkWrappers({
        modules: modules.map((m) => withFacts(m, factsFor(m.wrappers, true))),
        edges,
        resolve: (from, specifier) => resolveSpecifier(from, specifier, known),
        open: openModule,
        ...replacementBudget,
      })
    : null;
  // a cut in that stage leaves functions undecided (no rows): said, with the files
  const objectCapped = (objectLinked?.capped ?? []).filter((f) => !linked.capped.includes(f));
  if (objectCapped.length)
    limitations.push({
      code: "ipc_wrappers_capped",
      message: `${objectCapped.length} file(s) were not read to the end for calls of functions and methods of other modules that take ipcMain or ipcRenderer as a parameter (a budget or the file limit of 200), so those functions give no IPC rows: ${objectCapped.slice(0, 5).join(", ")}${objectCapped.length > 5 ? " …" : ""}.`,
    });
  paramIpcRows(
    modules,
    objectLinked?.sites ?? new Map(),
    objectLinked?.objectsCut ?? { methods: false, fns: false },
    new Set(edges.filter((e) => e.resolved && e.from !== e.to).map((e) => e.to)),
  );
  if (linked.capped.length)
    limitations.push({
      code: "ipc_wrappers_capped",
      message: `${linked.capped.length} file(s) that use IPC wrappers of other modules were not read to the end for calls of them (a budget or the file limit of 200): ${linked.capped.slice(0, 5).join(", ")}${linked.capped.length > 5 ? " …" : ""}.`,
    });
  /** The rows of wrapper calls per file, by the token of the method name (bridge member bodies). */
  const wrapperCallsAt = new Map<string, Array<{ at: number; usages: IpcUsage[] }>>();
  for (const [file, rows] of linked.rows) {
    const m = moduleById.get(file);
    if (!m) continue;
    const resolver = openModule(file)?.resolver;
    const have = new Set(m.ipc.map((u) => JSON.stringify(u)));
    const calls = wrapperCallsAt.get(file) ?? [];
    wrapperCallsAt.set(file, calls);
    for (const { usage, arg, unread, at } of rows) {
      let made: IpcUsage[] = [usage];
      if (unread && resolver) {
        // the argument read across modules, as the window options are
        const found = resolver.resolveArgument(arg);
        if (found)
          made = [
            ...(found.partial ? [usage] : []),
            ...found.values.map((channel): IpcUsage => ({
              ...usage,
              channel,
              resolution: { method: found.method, lines: found.lines },
            })),
          ];
        else if (resolver.reason) usage.reason = `evaluation stopped: ${resolver.reason}`;
      }
      calls.push({ at, usages: made });
      for (const u of made) {
        const key = JSON.stringify(u);
        if (have.has(key)) continue;
        have.add(key);
        m.ipc.push(u);
      }
    }
    m.ipc.sort((x, y) => x.line - y.line);
    if (m.role !== "main" && m.ipc.some((u) => u.via === "wrapper" && u.api.startsWith("ipcMain.")))
      m.role = "main";
  }

  // `ipcMain` bound to a module of the app (`import * as ipcMain from "./ipc-main"`): the call is
  // that module's function. When the module is read and exports a channel-forwarding function of
  // the method's name, its row at the call (above) replaces the direct one; otherwise the direct
  // row stays, as the module may hand Electron's object on (`export { ipcMain } from "electron"`).
  for (const m of modules) {
    if (!m.ipc.some((u) => u.appModule)) continue;
    m.ipc = m.ipc.filter((u) => {
      const spec = u.appModule;
      if (!spec) return true;
      delete u.appModule;
      const target = resolveSpecifier(m.id, spec, known);
      const method = u.api.slice(u.api.indexOf(".") + 1);
      const forwarder = target ? moduleById.get(target)?.wrappers?.forwarders?.[method] : undefined;
      if (forwarder === undefined || !target) return true;
      // only where the row through the forwarder was given for this very call
      const label = `${target.replace(/\.(m?js|cjs|jsx)$/, "")}.${method}`;
      return !m.ipc.some(
        (w) =>
          w.via === "wrapper" &&
          w.wrapper === label &&
          w.line === u.line &&
          w.api === u.api &&
          w.channel === u.channel,
      );
    });
  }

  // Channel names that are constants of another module: looked up now that modules are known.
  // A reference stays in place while its module is unread, so a continued scan resolves it later.
  // A name may be passed on through index modules (`export { A as B } from`, `module.exports =
  // { B: x.A }`, `export *`): followed a few modules deep, never in a circle.
  /** Set by `lookUp` when the value it found was read by evaluating the other module's code. */
  let lookedUpEvaluated = false;
  /** Why the other module could not read the name a reference points to, when it said. */
  const whyUnread = (
    from: string,
    ref: { specifier: string; property: string },
  ): { file: string; reason: string } | null => {
    const target = resolveSpecifier(from, ref.specifier, known);
    const m = target ? moduleById.get(target) : undefined;
    const head = ref.property.split(".")[0]!;
    const reason = m?.unevaluated?.[ref.property] ?? m?.unevaluated?.[head];
    return m && reason ? { file: m.id, reason } : null;
  };
  const lookUp = (
    from: string,
    ref: { specifier: string; property: string },
    depth = 0,
  ): string | null => {
    if (depth > 5) return null;
    if (depth === 0) lookedUpEvaluated = false;
    const target = resolveSpecifier(from, ref.specifier, known);
    const m = target ? moduleById.get(target) : undefined;
    if (!m) return null;
    const own = m.constants?.[ref.property];
    if (own !== undefined) {
      if (m.evaluated?.includes(ref.property)) lookedUpEvaluated = true;
      return own;
    }
    // `TABLE.KEY` where TABLE itself is passed on
    const dot = ref.property.indexOf(".");
    const head = dot === -1 ? ref.property : ref.property.slice(0, dot);
    const passed = m.reexports?.[ref.property] ?? m.reexports?.[head];
    if (passed) {
      const property =
        passed === m.reexports?.[ref.property]
          ? passed.property
          : `${passed.property}${ref.property.slice(dot)}`;
      const found = lookUp(m.id, { specifier: passed.specifier, property }, depth + 1);
      if (found !== null) return found;
    }
    for (const specifier of m.starExports ?? []) {
      const found = lookUp(m.id, { specifier, property: ref.property }, depth + 1);
      if (found !== null) return found;
    }
    return null;
  };
  for (const m of modules)
    for (const u of m.ipc) {
      if (u.channel !== null || !u.channelRef) continue;
      const found = lookUp(m.id, u.channelRef);
      if (found === null) {
        const why = whyUnread(m.id, u.channelRef);
        if (why) u.reason = `evaluation stopped in ${why.file}: ${why.reason}`;
        continue;
      }
      u.channel = `${u.channelRef.before ?? ""}${found}${u.channelRef.after ?? ""}`;
      // a call of a wrapper method stays one (its `wrapper` says which)
      if (u.wrapper || u.via === "bridge") {
        if (lookedUpEvaluated) u.resolution = { method: "evaluated", lines: [] };
      } else if (u.via === "resolved" && u.resolution?.method === "element") {
        // read per element of a route list: it stays that, with the list's line
      } else if (lookedUpEvaluated) {
        u.via = "resolved";
        u.resolution = { method: "evaluated", lines: [] };
      } else u.via = "constant";
      delete u.channelRef;
    }
  for (const b of contextBridge) {
    if (b.channel !== null || !b.channelRef) continue;
    const found = lookUp(b.file, b.channelRef);
    if (found === null) continue;
    b.channel = `${b.channelRef.before ?? ""}${found}${b.channelRef.after ?? ""}`;
    delete b.channelRef;
  }
  // A member whose call is a method of another module's wrapper (`client.invoke(Channel.List)`
  // with `client` an IpcClient made in place): the channel of the rows those calls gave, when
  // they name exactly one.
  for (const b of contextBridge) {
    const body = b.body;
    delete b.body;
    if (!body || b.channel !== null || b.channelRef || b.member === null) continue;
    const channels = new Set<string>();
    let unknown = false;
    for (const call of wrapperCallsAt.get(b.file) ?? []) {
      if (call.at < body[0] || call.at >= body[1]) continue;
      for (const u of call.usages) {
        let channel = u.channel;
        if (channel === null && u.channelRef) {
          const found = lookUp(b.file, u.channelRef);
          if (found !== null)
            channel = `${u.channelRef.before ?? ""}${found}${u.channelRef.after ?? ""}`;
        }
        if (channel === null) unknown = true;
        else channels.add(channel);
      }
    }
    if (!unknown && channels.size === 1) b.channel = [...channels][0]!;
  }

  // IPC calls on names another file defines, now that the files are known.
  const ambientResult = resolveAmbient(
    modules,
    new Set(edges.filter((e) => e.resolved).map((e) => e.to)),
  );
  for (const m of modules) {
    if (m.role !== "main" && m.ipc.some((u) => u.via === "global" && u.api.startsWith("ipcMain.")))
      m.role = "main";
    // Replies and port transfers count only in a file that uses Electron's IPC: it has IPC rows
    // by now, or it loads the electron module. The scanner reads a reply inside a listener on a
    // written-out `ipcMain` itself; rows carry no column and minified code has everything on one
    // line, so those are matched as a multiset of (line, channel) and only as many are dropped
    // as the scanner already has.
    const replies = m.ambient?.replies;
    if (!replies?.length) continue;
    const usesIpc =
      m.ipc.length > 0 || m.references.some((r) => /^electron(\/|$)/.test(r.specifier));
    if (!usesIpc) continue;
    const have = new Map<string, number>();
    for (const u of m.ipc)
      if (u.api === "event.sender.send")
        have.set(lineAndChannel(u), (have.get(lineAndChannel(u)) ?? 0) + 1);
    for (const u of replies) {
      const left = u.api === "event.sender.send" ? (have.get(lineAndChannel(u)) ?? 0) : 0;
      if (left > 0) have.set(lineAndChannel(u), left - 1);
      else m.ipc.push(u);
    }
    m.ipc.sort((x, y) => x.line - y.line);
    delete m.ambient!.replies;
  }
  if (ambientResult.unresolvedTotal) {
    const sample = ambientResult.unresolved
      .slice(0, 5)
      .map((u) => `${short(u.name)}.${u.method}("${short(u.channel)}") at ${u.file}:${u.line}`)
      .join(", ");
    const more = ambientResult.unresolvedTotal - Math.min(5, ambientResult.unresolved.length);
    limitations.push({
      code: "ipc_receiver_unresolved",
      message: `${ambientResult.unresolvedTotal} call(s) that look like IPC are on a name that could not be traced to ipcMain or ipcRenderer and are not listed: ${sample}${more ? ` … and ${more} more` : ""}.`,
    });
  }
  // Calls on an IPC object whose channel is a parameter or a computed value: listed without a
  // channel, and said so, because the channel list is then not the whole picture.
  const channelless = modules.flatMap((m) =>
    m.ipc
      // a reference to another module stays open while that module may still be read, unless
      // the module was read and said why it could not read the name
      .filter(
        (u) =>
          u.channel === null && (!u.channelRef || u.reason) && !u.api.startsWith("contextBridge."),
      )
      .map((u) => `${u.api} at ${m.id}:${u.line}${u.reason ? ` (${u.reason})` : ""}`),
  );
  if (channelless.length)
    limitations.push({
      code: "ipc_channel_unresolved",
      message: `${channelless.length} IPC call(s) pass a channel that is not a literal or a constant that could be followed (a parameter, a computed value). They are in the collection ipc without a channel: ${channelless.slice(0, 5).join(", ")}${channelless.length > 5 ? ` … and ${channelless.length - 5} more` : ""}.`,
    });
  if (ambientCapped)
    limitations.push({
      code: "ipc_open_calls_capped",
      message:
        "A file has more calls on undeclared names than are kept for cross-file resolution; IPC through a name defined in another file may be missing there.",
    });

  // Storage keys passed to a wrapper class or object another module defines (wrappers.ts):
  // read at each call in the modules that import it, with the key the provider's own key
  // expression gives for the argument. A call whose argument or key cannot be read is an unknown
  // row at the call. Nothing is read when no module exports such a wrapper.
  const keyLinked = linkedKeyRows(
    linkKeyWrappers({
      modules: modules.map((m) => ({
        id: m.id,
        exports: m.exports,
        ...(m.keyWrappers ? { wrappers: m.keyWrappers } : {}),
        ...(m.reexports ? { reexports: m.reexports } : {}),
        ...(m.starExports ? { starExports: m.starExports } : {}),
        ...(m.looseStarExports ? { looseStarExports: m.looseStarExports } : {}),
      })),
      edges,
      resolve: (from, specifier) => resolveSpecifier(from, specifier, known),
      open: openModule,
      ...replacementBudget,
    }),
    openModule,
    (from, ref) => lookUp(from, ref),
  );
  const keyRows = keyLinked.rows;
  // One entry for every reason storage keys through wrappers were not all read.
  if (facts.keyCallsCapped || keyLinked.capped) {
    const parts: string[] = [];
    if (facts.keyCallsCapped)
      parts.push(
        `${facts.keyCallsCapped} file(s) have more calls of their own storage wrappers than the ${MAX_KEY_CALLS_PER_FILE} per file that are read, or the reader's work budget ran out (${(facts.keyCallsCappedFiles ?? []).join(", ")}${facts.keyCallsCapped > (facts.keyCallsCappedFiles ?? []).length ? " …" : ""})`,
      );
    if (keyLinked.capped) parts.push(`calls of wrappers of other modules: ${keyLinked.capped}`);
    limitations.push({
      code: "storage_wrappers_capped",
      message: `${parts.join("; ")}. Keys passed through the further calls are not read at each call.`,
    });
  }
  // Modules whose replacements of IPC wrapper methods were not checked (the budget ran out).
  if (linked.unchecked.length)
    limitations.push({
      code: "wrapper_replacements_unchecked",
      message: `${linked.unchecked.length} module(s) that import an IPC wrapper were not checked for replacements of its methods within the replacement budget of the application (${list(linked.unchecked, 5)}); calls of IPC wrapper methods are read without that check, so a method replaced there would not be seen.`,
    });
  // Wrapper methods another module replaces: their calls give no row.
  const replaced = [...linked.replaced, ...keyLinked.replaced];
  if (replaced.length)
    limitations.push({
      code: "wrapper_method_replaced",
      message: `${replaced.length} wrapper method(s) are replaced by a member write on the class, its prototype or an instance, or a write there whose receiver was not read within the replacement budget, so their calls in other modules are not read (no IPC or storage rows through them): ${list(
        replaced.map((x) =>
          x.budget
            ? x.line
              ? `${x.via}: a member write not read within the replacement budget (of the file, or what was left of the application's) at ${x.file}:${x.line}`
              : `${x.via}: ${x.file} imports it and was not read within the replacement budget of the application`
            : `${x.via} at ${x.file}:${x.line}`,
        ),
        5,
      )}.`,
    });

  // Endpoints and storage keys with a part that is a constant of another module.
  const finished = (rows: AppCandidate[]): AppCandidate[] =>
    rows.map((row) =>
      resolvePending(row, (specifier, property) => lookUp(row.file, { specifier, property })),
    );
  const endpoints = finished(facts.endpoints);
  const storage = finished(keyRows.length ? [...facts.storage, ...keyRows] : facts.storage);

  // IPC channel matching
  const channels = new Map<string, { senders: Set<string>; receivers: Set<string> }>();
  for (const m of modules) {
    for (const u of m.ipc) {
      if (!u.channel || u.api.startsWith("contextBridge.")) continue;
      const entry = channels.get(u.channel) ?? {
        senders: new Set(),
        receivers: new Set(),
      };
      channels.set(u.channel, entry);
      // `ipcMain[route.kind](…)` with a kind that is not read: the channel, but neither end
      if (u.api.endsWith(".[unknown]")) continue;
      const receiving = /\.(on|once|handle|handleOnce)$/.test(u.api);
      (receiving ? entry.receivers : entry.senders).add(m.id);
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

  /**
   * The app-wide flag of a setting: the least safe literal written for any window. A safe value
   * stands only if no window leaves the setting open; where one does (a computed value, options
   * that could not be followed, an object assigned to later), the flag is null, not "safe".
   */
  const appWide = (key: CoreKey): boolean | null => {
    const value = flags[key];
    const safe = key !== "nodeIntegration";
    if (value !== safe) return value;
    const open =
      webPreferences.some((p) => p.key === key && p.value === null) ||
      (facts.windows ?? []).some((w) => w.computed?.includes(key));
    return open ? null : value;
  };
  const electron =
    electronSeen || electronVersion || tree.kind === "asar"
      ? {
          version: electronVersion,
          preloadScripts: [...preloadScripts],
          nodeIntegration: appWide("nodeIntegration"),
          contextIsolation: appWide("contextIsolation"),
          sandbox: appWide("sandbox"),
          remoteModule: flags.remoteModule,
        }
      : null;

  // A setting a window was evaluated to take from another module (`definedIn`, a factory's
  // defaults) is the same fact as the unattached row read at that place of that module: the row
  // without a window is dropped, so the setting is not reported twice, once without its window.
  const claimed = new Set(
    webPreferences
      .filter((p) => p.window !== null && p.definedIn)
      .map((p) => `${p.definedIn!.file}\u0000${p.definedIn!.line}\u0000${p.key}`),
  );
  if (claimed.size)
    for (let i = webPreferences.length - 1; i >= 0; i--) {
      const p = webPreferences[i]!;
      if (p.window === null && claimed.has(`${p.file}\u0000${p.line}\u0000${p.key}`))
        webPreferences.splice(i, 1);
    }
  // One row per window: what is written, and what follows from the settings together.
  const major = electronMajor(electronVersion);
  const windows: WindowSummary[] = (facts.windows ?? []).map((w) => {
    // One row per key is left where the order of writes could be read. Several rows with
    // different values are writes in separate objects: neither is taken.
    const stateOf = (
      key: CoreKey | "webSecurity" | "allowRunningInsecureContent",
    ): SettingState => {
      if (w.computed?.includes(key)) return "computed";
      const rows = webPreferences.filter(
        (x) => x.file === w.file && x.window === w.window && x.key === key,
      );
      if (!rows.length) return "not written";
      if (rows.some((p) => typeof p.value !== "boolean")) return "computed";
      const values = new Set(rows.map((p) => p.value));
      return values.size === 1 ? (rows[0]!.value as boolean) : "conflicting";
    };
    const states = {
      nodeIntegration: stateOf("nodeIntegration"),
      contextIsolation: stateOf("contextIsolation"),
      sandbox: stateOf("sandbox"),
    };
    const preload = webPreferences.findLast(
      (x) => x.file === w.file && x.window === w.window && x.key === "preload",
    );
    const web = {
      webSecurity: stateOf("webSecurity"),
      allowRunningInsecureContent: stateOf("allowRunningInsecureContent"),
    };
    const { basis: webBasis, ...webEffects } = webSecurityEffects(web);
    const effects = windowEffects(
      states,
      major,
      facts.enableSandbox === "always" ? true : facts.enableSandbox === "maybe" ? "maybe" : false,
    );
    return {
      ...w,
      ...states,
      preload: typeof preload?.value === "string" ? preload.value : null,
      ...effects,
      ...web,
      ...webEffects,
      basis: [effects.basis, ...webBasis].join("; "),
    };
  });
  const opaqueWindows = facts.windows.filter((w) => w.opaque);
  if (opaqueWindows.length)
    limitations.push({
      code: "window_options_unresolved",
      message: `${opaqueWindows.length} window(s) take options that could not be followed (a parameter, a call, a condition, a spread of something not declared in the file), so settings not written after that are not known and read as computed: ${opaqueWindows
        .slice(0, 5)
        .map((w) => `${w.windowName} at ${w.file}:${w.line}`)
        .join(", ")}${opaqueWindows.length > 5 ? ` … and ${opaqueWindows.length - 5} more` : ""}.`,
    });
  const computedPrefs = webPreferences.filter((w) => w.value === null);
  if (computedPrefs.length)
    limitations.push({
      code: "webpreferences_computed",
      message: `${computedPrefs.length} window setting(s) are computed at run time, so their value is not known: ${computedPrefs
        .slice(0, 5)
        .map((w) => `${w.key} at ${w.file}:${w.line} (${w.computed})`)
        .join(", ")}${computedPrefs.length > 5 ? ` … and ${computedPrefs.length - 5} more` : ""}.`,
    });

  /** `file:line` of the first place a setting was read with the given value. */
  const where = (key: WebPreference["key"], value?: boolean): string | undefined => {
    const hit = webPreferences.find(
      (w) => w.key === key && (value === undefined || w.value === value),
    );
    return hit ? `${hit.file}:${hit.line}` : undefined;
  };
  if (electron) {
    if (electron.nodeIntegration === true) {
      // What the flag means depends on the other settings of the same window, so the detail is
      // chosen from that window's row, never from another window's (docs/electron-findings.md).
      // The window where page scripts get require() is reported before one where they do not.
      const rank = { yes: 0, "yes by default": 1, unknown: 2, "no by default": 3, no: 4 } as const;
      const row = windows
        .filter((w) => w.nodeIntegration === true || w.nodeIntegration === "conflicting")
        .toSorted((x, y) => rank[x.pageRequire] - rank[y.pageRequire])[0];
      const sandboxNote = "Node integration keeps the renderer out of the Chromium sandbox.";
      const detail =
        row?.pageRequire === "yes"
          ? "contextIsolation is off for the same window: page scripts can require Node modules, so script injection there becomes code execution."
          : row?.pageRequire === "no"
            ? `contextIsolation is on for the same window, so page scripts do not get require(). ${sandboxNote}`
            : row?.pageRequire === "yes by default"
              ? `contextIsolation is not written for the same window and is off by default in the Electron version package.json asks for (${electronVersion}): if that is the runtime, page scripts can require Node modules. ${sandboxNote}`
              : row?.pageRequire === "no by default"
                ? `contextIsolation is not written for the same window. It is on by default in the Electron version package.json asks for (${electronVersion}), and then page scripts do not get require(); the shipped runtime was not checked. ${sandboxNote}`
                : `Whether page scripts get require() depends on contextIsolation of the same window, which is not known here (computed, or not written with the Electron version unknown). ${sandboxNote}`;
      const pref =
        row &&
        webPreferences.findLast(
          (w) => w.file === row.file && w.window === row.window && w.key === "nodeIntegration",
        );
      findings.push({
        kind: "electron.node-integration",
        title: "nodeIntegration: true in a BrowserWindow",
        detail,
        confidence: "inferred",
        location: pref ? `${pref.file}:${pref.line}` : where("nodeIntegration", true),
      });
    }
    const defaultRequire = windows.find(
      (w) => w.nodeIntegration === "not written" && w.pageRequire === "yes by default",
    );
    if (defaultRequire)
      findings.push({
        kind: "electron.node-integration-default",
        title: "nodeIntegration is not written and on by default before Electron 5",
        detail: `package.json asks for Electron ${electronVersion}. If that is the runtime, page scripts of this window can require Node modules; the shipped runtime was not checked.`,
        confidence: "inferred",
        location: `${defaultRequire.file}:${defaultRequire.line}`,
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
    const written = (key: PreferenceKey, value: boolean): WebPreference | undefined =>
      webPreferences.find((w) => w.key === key && w.value === value);
    const at = (p: WebPreference): string => `${p.file}:${p.line}`;
    const noWebSecurity = written("webSecurity", false);
    if (noWebSecurity)
      findings.push({
        kind: "electron.web-security",
        title: "webSecurity: false in a BrowserWindow",
        detail:
          "Turns off the same-origin policy for the window and allows insecure content unless allowRunningInsecureContent is set otherwise.",
        confidence: "inferred",
        location: at(noWebSecurity),
      });
    const insecureContent = written("allowRunningInsecureContent", true);
    if (insecureContent)
      findings.push({
        kind: "electron.insecure-content",
        title: "allowRunningInsecureContent: true in a BrowserWindow",
        detail: "An https page may run scripts, styles or plugins loaded from http URLs.",
        confidence: "inferred",
        location: at(insecureContent),
      });
    const webview = written("webviewTag", true);
    if (webview)
      findings.push({
        kind: "electron.webview-tag",
        title: "webviewTag: true in a BrowserWindow",
        detail:
          "The <webview> tag is enabled; a preload script configured on a <webview> runs with Node integration.",
        confidence: "inferred",
        location: at(webview),
      });
    if (electron.remoteModule)
      findings.push({
        kind: "electron.remote",
        title: "Uses the remote module",
        confidence: "confirmed",
      });
    const enables = remote.filter((r) => r.kind === "enable");
    const uses = remote.filter((r) => r.kind === "use");
    if (enables.length || uses.length) {
      const whose = (r: RemoteEnable): string =>
        r.targetKind === "window"
          ? `window ${r.window}`
          : r.targetKind === "app"
            ? "every webContents (web-contents-created)"
            : r.targetKind === "unknown"
              ? `a webContents passed in as ${r.target} (callers not followed)`
              : `${r.target || "an argument that is not read"}`;
      const first = enables[0] ?? uses[0]!;
      const read = `${coverage.scanned} of ${coverage.total} JavaScript files read`;
      findings.push({
        kind: "electron.remote-enabled",
        title: enables.length
          ? `@electron/remote enabled for ${list([...new Set(enables.map(whose))], 4)}`
          : `@electron/remote is loaded; enable not found in the files read`,
        detail: `${list(
          [...enables, ...uses].map((r) => `${r.evidence} at ${r.file}:${r.line}`),
          4,
        )} (collection remoteEnabled). A page whose webContents is enabled reaches main-process modules and objects through the remote module, which Electron's security guide advises against.${enables.length ? "" : ` No enable call was found: ${read}, and one written through code hexvero does not follow is not seen.`}`,
        confidence: "inferred",
        location: `${first.file}:${first.line}`,
      });
    }
    const unsafe = switchList.filter((r) => r.dangerous === true);
    if (unsafe.length) {
      findings.push({
        kind: "electron.unsafe-switch",
        title: `Security checks weakened process-wide: ${list([...new Set(unsafe.map(unsafeSwitchLabel))], 4)}`,
        detail: `${list(
          unsafe.map((r) => `${r.evidence} at ${r.file}:${r.line}`),
          4,
        )} (collection switches). ${list([...new Set(unsafe.flatMap((r) => (r.reason ? [r.reason] : [])))], 4)}.`,
        confidence: "inferred",
        location: `${unsafe[0]!.file}:${unsafe[0]!.line}`,
      });
    }
    const unfixed = openExternalList.filter(
      (r) => r.targetKind === "shell" && r.argumentKind !== "literal",
    );
    if (unfixed.length) {
      findings.push({
        kind: "electron.open-external",
        title: `shell.openExternal with a URL that is not a literal: ${unfixed.length} call(s)`,
        detail: `${list(
          unfixed.map((r) => `${r.evidence} at ${r.file}:${r.line}`),
          4,
        )} (collection openExternal). Electron's security guide, section 15: do not use shell.openExternal with untrusted content; whether the code checks the URL before the call is not read.`,
        confidence: "inferred",
        location: `${unfixed[0]!.file}:${unfixed[0]!.line}`,
      });
    }
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
        // Calls that could not be traced, or whose channel could not be read, exist: the list
        // is then not known to be complete.
        confidence: ambientResult.unresolvedTotal || channelless.length ? "inferred" : "confirmed",
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
    if (bridgeExposures.length) {
      const named = (x: BridgeExposure): string => {
        const api = x.api.startsWith("[") ? `window${x.api}` : `window.${x.api}`;
        return `${x.member === null ? api : `${api}.${x.member}`} (${x.exposed})`;
      };
      const first = bridgeExposures[0]!;
      findings.push({
        kind: "electron.bridge-exposure",
        title:
          bridgeExposures.length === 1
            ? `${first.exposed} exposed to pages as it is through contextBridge: ${named(first)}`
            : `${bridgeExposures.length} privileged objects exposed to pages as they are through contextBridge: ${list(bridgeExposures.map(named), 4)}`,
        detail: `${list(
          bridgeExposures.map((x) => `${x.evidence} at ${x.file}:${x.line}`),
          4,
        )}. Electron's security guide: "You should not directly expose Electron's APIs, especially IPC, to untrusted web content in your preload scripts." Page scripts get the object or method itself, not a function that narrows its use (collection bridgeExposures).`,
        // the value is read as written; that the name is electron's or Node's is read from the
        // file's declarations, not from a run
        confidence: "inferred",
        location: `${first.file}:${first.line}`,
      });
    }
    if (navigation.length || (facts.windows ?? []).length) {
      const opens = navigation.filter((h) => h.kind === "setWindowOpenHandler");
      const navs = navigation.filter((h) => h.kind !== "setWindowOpenHandler");
      const targets = (rows: NavigationHandler[], withReturns: boolean): string =>
        list(
          [
            ...new Set(
              rows.map((h) =>
                withReturns ? `${h.target}, returns ${h.returns ?? "unknown"}` : h.target,
              ),
            ),
          ],
          4,
        );
      const read = `${coverage.scanned} of ${coverage.total} JavaScript files read`;
      const firstRow = navigation[0];
      const firstWindow = (facts.windows ?? [])[0];
      findings.push({
        kind: "electron.navigation",
        title: `${
          opens.length
            ? `setWindowOpenHandler for ${targets(opens, true)}`
            : "no setWindowOpenHandler found in the files read"
        }; ${
          navs.length
            ? `${[...new Set(navs.map((h) => h.kind))].join("/")} listener for ${targets(navs, false)}`
            : "no will-navigate or will-frame-navigate listener found in the files read"
        }`,
        detail: `Read from the code (collection navigationHandlers); whether a handler checks the URL or the sender is not read, and "returns deny" or "returns allow" is said only where the returned action is a literal. A handler that is not found may still exist: ${read}, and one registered through code hexvero does not follow (a computed event name, a helper that is handed the webContents) is not seen. Electron's security guide, sections 13 and 14: limit navigation with will-navigate, and register a window open handler to "deny any unexpected window creation".`,
        confidence: "inferred",
        location: firstRow
          ? `${firstRow.file}:${firstRow.line}`
          : firstWindow
            ? `${firstWindow.file}:${firstWindow.line}`
            : undefined,
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
      title: `${nativeAddons.length} native ${nativeAddons.length === 1 ? "addon" : "addons"} (.node)`,
      detail: nativeAddons.slice(0, 5).join(", "),
      confidence: "confirmed",
    });
  const minified = modules.filter((m) => m.minified).length;
  if (minified)
    findings.push({
      kind: "js.minified",
      title: `${minified} minified ${minified === 1 ? "bundle" : "bundles"}`,
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
        /^(electron\.(ipc|context-bridge|bridge-exposure|navigation|preload|remote-enabled)|js\.(endpoints|storage|minified))$/.test(
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
    windows,
    contextBridge,
    bridgeExposures,
    navigationHandlers: navigation,
    remoteEnabled: remote,
    switches: switchList,
    openExternal: openExternalList,
    permissionHandlers: permissionList,
    csp: cspList,
    dangerousCalls: dangerousList,
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

/** Storage rows of an application, at most. */
const MAX_KEY_CALLS = 2000;

/**
 * The storage rows of the calls `linkKeyWrappers` found (see `keyCallRows`), in file order.
 */
function linkedKeyRows(
  linked: ReturnType<typeof linkKeyWrappers>,
  open: (path: string) => ReadModule | null,
  lookUp: (from: string, ref: { specifier: string; property: string }) => string | null,
): { rows: AppCandidate[]; capped: string | null; replaced: Replaced[] } {
  const out: AppCandidate[] = [];
  const keys = new Map<string, string[] | null>();
  let capped = linked.capped.length > 0;
  for (const [file, calls] of [...linked.rows].toSorted(([a], [b]) => (a < b ? -1 : 1))) {
    if (out.length >= MAX_KEY_CALLS) {
      capped = true;
      break;
    }
    const caller = open(file);
    if (!caller) continue;
    const rows = keyCallRows(
      caller,
      calls,
      (f) => open(f),
      (ref) => lookUp(file, ref),
      {
        keys,
      },
    );
    for (const row of rows) {
      if (out.length >= MAX_KEY_CALLS) {
        capped = true;
        break;
      }
      const { unread: _, ...plain } = row;
      out.push({ file, ...plain });
    }
  }
  return {
    rows: out,
    capped: capped
      ? `a budget, the limit of 200 calling files${linked.capped.length ? ` (${linked.capped.slice(0, 5).join(", ")}${linked.capped.length > 5 ? " …" : ""})` : ""}, or the limit of ${MAX_KEY_CALLS} rows`
      : null,
    replaced: linked.replaced,
  };
}

/** Where a row stands, with its kind and op. */
const placeOf = (r: Candidate): string => `${r.line}:${r.column}\u0000${r.kind}\u0000${r.op ?? ""}`;

/**
 * Rows of calls of a file's own storage wrappers read through wrappers.ts, added where the
 * file's rows do not have them already (the same position, kind, op and key). An unknown row is
 * added only when the file has no unknown row of that kind yet: the unread row of the storage
 * call inside the wrapper already says that a key of that kind is not known in the file.
 */
function addOwnKeyRows(
  candidates: ReturnType<typeof findCandidates>,
  rows: ReturnType<typeof keyCallRows>,
): void {
  const have = new Set(candidates.storage.map((r) => `${placeOf(r)}\u0000${r.value ?? ""}`));
  const unknownKinds = new Set(
    candidates.storage.filter((r) => r.value === null).map((r) => r.kind),
  );
  const placed = new Set(candidates.storage.map(placeOf));
  for (const { unread, ...row } of rows) {
    if (candidates.storage.length >= 2000) {
      candidates.truncated = true;
      return;
    }
    if (unread) {
      if (unknownKinds.has(row.kind) || placed.has(placeOf(row))) continue;
      unknownKinds.add(row.kind);
    } else if (have.has(`${placeOf(row)}\u0000${row.value}`)) continue;
    have.add(`${placeOf(row)}\u0000${row.value ?? ""}`);
    candidates.storage.push(row);
  }
}
