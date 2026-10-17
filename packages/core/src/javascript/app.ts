import { lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, posix, relative, sep } from "node:path";
import { readRegularFile } from "../binary/file.js";
import { openAsar, openAsarFile, readUnpacked, type AsarArchive } from "../formats/asar.js";
import type { Finding, Limitation } from "../model.js";
import { AnalysisError } from "../model.js";
import { Constants, resolveAliases } from "./aliases.js";
import { type AmbientFacts, collectAmbient, resolveAmbient } from "./ambient.js";
import { findCandidates, resolvePending, type Candidate } from "./candidates.js";
import { type Binding, ExpressionResolver, type ModuleHost, type Val } from "./resolve.js";
import {
  ALIAS_TARGETS,
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
import { linkWrappers, type ReadModule, type WrapperFacts } from "./wrappers.js";

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
  const hide = (window: number | null, upTo: number): void => {
    if (window === null) return;
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
    /** `webPreferences: NAME` or the shorthand `webPreferences`, with the name at n. */
    const namedPrefs = (n: number): void => {
      if (
        !followAt(n, window, inherited, depth, at, "prefs") &&
        !passedTo(n, window, depth, at, "prefs")
      )
        hide(window, EVERYWHERE); // an import, or a parameter not every caller fills in
    };
    // Objects that are named, spread or returned by a helper inside belong to the same window.
    for (let k = open + 1; k < end; k++) {
      const t = tokens[k]!;
      const next = tokens[k + 1];
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
        namedPrefs(k);
      } else if (
        t.type === "ident" &&
        t.value === "webPreferences" &&
        is(k + 1, ":") &&
        tokens[k + 2]?.type === "ident"
      ) {
        const name = tokens[k + 2]!.value;
        if (is(k + 3, ",") || is(k + 3, "}")) namedPrefs(k + 2);
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
      let c = k + 1;
      if (tokens[c]?.type === "ident" && is(c + 1, ".") && tokens[c + 2]?.type === "ident") c += 2;
      const ctor = tokens[c];
      if (ctor?.type !== "ident" || !is(c + 1, "(")) continue;
      if (!WINDOW_CLASSES.has(aliases.get(c) ?? ctor.value)) continue;
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

const ASSIGNMENT_OPERATORS = new Set([
  "=",
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "**=",
  "<<=",
  ">>=",
  ">>>=",
  "&=",
  "|=",
  "^=",
  "&&=",
  "||=",
  "??=",
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
  const count = (name: string, at: number, block: false | "name" | "pattern" = false): void => {
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
  // Every write of a name: `r = …`, `r ||= …`, `r++`. A write counts against a declaration only
  // where it resolves to the same binding (below), so a local of that name elsewhere is no write.
  const writes = new Map<string, number[]>();
  for (let k = 0; k + 1 < tokens.length; k++) {
    const t = tokens[k]!;
    if (t.type !== "ident" || is(k - 1, ".") || is(k - 1, "?.")) continue;
    const next = tokens[k + 1]!;
    const written =
      (next.type === "punct" && ASSIGNMENT_OPERATORS.has(next.value)) ||
      is(k - 1, "++") ||
      is(k - 1, "--") ||
      is(k + 1, "++") ||
      is(k + 1, "--");
    if (!written) continue;
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
  let truncated = cut;
  let budget = BRIDGE_WALK_BUDGET;
  const is = (i: number, value: string): boolean =>
    tokens[i]?.type === "punct" && tokens[i]!.value === value;
  /** Named objects whose later `name.member = …` assignments were already collected. */
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
    /**
     * The object literals the exposed value at `k` is made of, and the token after it: `{…}`, a
     * name declared as `const x = {…}` in this file, `Object.freeze(…)` (also `seal`,
     * `preventExtensions`) around one of those, or `Object.assign(a, b, …)` of them. Null when
     * any part is something else, so nothing is claimed for a value that is not read whole.
     */
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
      if (is(k + 1, ")") || is(k + 1, ",")) {
        // A loop variable or a parameter is not the object some other line declares under the
        // same name: `for (const [t, n] of Object.entries(u)) exposeInMainWorld(t, n)`.
        if (boundLocally(i, v.value)) return null;
        const named = objectOf(v.value);
        return named < 0 ? null : { opens: [named], next: k + 1 };
      }
      return null;
    };
    const value = simple ? valueOpens(at + 2, 0) : null;
    // `exposeInMainWorld("api", value,)`: a trailing comma, as formatters write it.
    const opens =
      value &&
      (value.next === -1 || is(value.next, ")") || (is(value.next, ",") && is(value.next + 1, ")")))
        ? value.opens
        : null;
    if (!opens) {
      push(null, null, t.line);
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
      continue;
    }
    /** One member, from token `from` to `end` (its `,` or `}`), of the object at `objectOpen`. */
    const readMember = (from: number, end: number, level: number, objectOpen: number): void => {
      let s = from;
      if (s >= end) return;
      const first = tokens[s]!;
      if (is(s, "...")) {
        // `...libraryApi` with `const libraryApi = {…}` in this file: its members, in place
        const spread = tokens[s + 1];
        const base =
          spread?.type === "ident" && s + 2 === end && level < 3 ? objectOf(spread.value) : -1;
        if (base !== -1 && base !== objectOpen) {
          if (!walk(base, level + 1)) truncated = true;
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
      const name =
        nameToken.type === "ident" || nameToken.type === "number"
          ? nameToken.value
          : textOf(nameToken);
      if (name === null) return push(null, null, first.line);
      // `{ ipcRenderer }`, `ipc: ipcRenderer`, `api.ipc = ipcRenderer`: the value itself
      if (s === from && s + 1 === end && nameToken.type === "ident") expose(name, s, end);
      else if (s === from && (is(s + 1, ":") || is(s + 1, "="))) expose(name, s + 2, end);
      const channels = new Set<string>();
      const refs: Array<NonNullable<BridgeMember["channelRef"]>> = [];
      // `on(CH, f)` and `off(CH, f)` in one member name one channel
      const addRef = (ref: NonNullable<BridgeMember["channelRef"]>): void => {
        if (!refs.some((r) => JSON.stringify(r) === JSON.stringify(ref))) refs.push(ref);
      };
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
        first.line,
        only && refs.length === 1 ? refs[0] : undefined,
      );
    };
    /** Walks the members of the object literal at `objectOpen`; spreads of named objects inside. */
    const walk = (objectOpen: number, level: number): boolean => {
      let start = objectOpen + 1;
      const flush = (end: number): void => {
        const from = start;
        start = end + 1;
        readMember(from, end, level, objectOpen);
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
    for (const open of opens) if (!walk(open, 0)) truncated = true;
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
          readMember(k + 2, end, 0, -1);
        }
    }
  }
  return { members, exposures, truncated };
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
        if (--work < 0) return null;
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
        if (--work < 0) return null;
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
        if (--work < 0) return "unknown";
        // a function inside may return something of its own: not decided here
        if (ident(j) === "function" || is(j, "=>")) return "unknown";
        if (ident(j) !== "return") continue;
        // the returned value runs to the `;` or the `}` that ends the statement
        let stop = j + 1;
        for (let d = 0; stop < fn.end; stop++) {
          if (--work < 0) return "unknown";
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
  /** The files that were read only up to the token budget (the first 200). */
  partialFiles: string[];
}

/** Bump when the facts change shape or a detector changes what it reads. */
export const JS_SCAN_SCHEMA = 18;

/**
 * Everything read from the files scanned so far. It is plain JSON, so a scan can be stored and
 * continued later; the analysis result is assembled from it.
 */
export interface JsScanFacts {
  schema: number;
  /** Paths already processed, in scan order. A file is processed exactly once. */
  scanned: string[];
  skippedFiles: string[];
  /** Files whose reading stopped at the token budget: what follows the cut is not known. */
  truncatedFiles: string[];
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
  navigationHandlers: NavigationHandler[];
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
  /** Limitations that belong to single files (e.g. a token budget that ran out). */
  limitations: Limitation[];
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

export function asarTree(bytes: Uint8Array, name: string): FileTree {
  return archiveTree(openAsar(bytes), name);
}

export function asarTreeFromFile(path: string): FileTree {
  return archiveTree(openAsarFile(path), path);
}

function archiveTree(archive: AsarArchive, name: string): FileTree {
  // Electron keeps files marked unpacked in `<archive>.unpacked/` beside the archive; an archive
  // known only by a name (an upload) has no such directory, and those files stay unread.
  const onDisk = isAbsolute(name);
  return {
    kind: "asar",
    root: name,
    files: archive.files.map((f) => ({
      path: f.path,
      size: f.size,
      ...(f.unpacked ? { unpacked: true } : {}),
    })),
    read: (path, maxBytes = 64 << 20) => {
      const file = archive.find(path);
      if (!file) throw new AnalysisError("not_found", `${path} not in archive`);
      if (file.unpacked) {
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
  bridge: ReturnType<typeof bridgeMembers> | null;
  navigation: NavigationHandler[] | null;
}

export function readFileTokens(
  path: string,
  source: string,
  /**
   * Receives the file's token stream, so the scan can evaluate the file again on the same tokens
   * (and the resolver tables built for them) instead of tokenizing it a second time.
   */
  keep?: (tokens: Token[]) => void,
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
  let bridge: ReturnType<typeof bridgeMembers> | null = null;
  let navigation: NavigationHandler[] | null = null;
  const scan = scanJavaScript(source, {
    onTokens: (tokens, truncated, context) => {
      keep?.(tokens);
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
        ambient = collectAmbient(tokens, context.aliases);
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
          const asOptions =
            (is(k - 1, "(") &&
              is(k + 1, ")") &&
              // `new BrowserWindow(name)`, `new electron.BrowserWindow(name)`
              (tokens[k - 3]?.value === "new" ||
                (is(k - 3, ".") && tokens[k - 5]?.value === "new")) &&
              WINDOW_CLASSES.has(tokens[k - 2]?.value ?? "")) ||
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
      )
        for (let k = 0; k + 2 < tokens.length; k++) {
          const t = tokens[k]!;
          const colon = tokens[k + 1]!;
          if (t.type !== "ident" || colon.type !== "punct" || colon.value !== ":") continue;
          if (t.value === "preload") preloadsAt.add(t.start);
          else if (BOOLEAN_KEYS.has(t.value)) {
            const key = t.value as Exclude<PreferenceKey, "preload">;
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
            if (value !== null && ends) settingsAt.push({ key, value, start: t.start });
            else {
              // Not a literal: the value is decided at run time. The expression is kept, up
              // to the `,` or `}` that ends the property, so a reader sees what decides it.
              let nested = 0;
              let end = k + 2;
              for (; end < tokens.length && end < k + 60; end++) {
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
      // Endpoints, storage and URL literals: only where the text can contain one at all.
      if (CAN_HOLD_CANDIDATES.test(source)) {
        candidates = findCandidates(tokens, source, undefined, context.aliases, context.constants);
      }
      if (/setWindowOpenHandler|will-navigate|will-frame-navigate/.test(source))
        navigation = navigationHandlers(
          tokens,
          path,
          new Set(ranges.flatMap((r) => (r.window !== null && r.name ? [r.name] : []))),
          new ExpressionResolver(tokens, context.constants),
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
    bridge,
    navigation,
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
  const moduleResolver = (path: string, text: string, scanned?: Token[] | null): ReadModule => {
    const cached = modulesRead.get(path);
    if (cached) return cached;
    // The scan's own tokens of the file when it has them: the same stream (same tokenizer, same
    // limit), and the resolver tables built on it during the scan are shared, not built again.
    const tokens = scanned ?? tokenize(text).tokens;
    const constants = new Constants(tokens);
    const made = {
      tokens,
      constants,
      resolver: new ExpressionResolver(tokens, constants, path, host),
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
    /** The file's tokens when this thread tokenized it (not when a worker did). */
    let scanned: Token[] | null = null;
    const tokenFacts =
      options.prepared?.get(file.path) ??
      readFileTokens(file.path, source, (tokens) => (scanned = tokens));
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
      if (cand.clientsSkipped && facts.limitations.length < 200)
        facts.limitations.push({
          code: "client_calls_skipped",
          message: `${file.path}: more than 2,000 calls of HTTP client modules (node:https, node:http, Electron's net) were checked; the further ones give no endpoint rows.`,
        });
      if (cand.wrappersSkipped && facts.limitations.length < 200)
        facts.limitations.push({
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
    if (scan.wrappersCapped && facts.limitations.length < 200)
      facts.limitations.push({
        code: "ipc_wrappers_capped",
        message: `${file.path}: the search for calls of IPC wrapper methods ran out of its budget; calls of them after that are missing.`,
      });
    if (scan.truncated && facts.truncatedFiles.length < 200) facts.truncatedFiles.push(file.path);
    if (scan.truncated && facts.limitations.length < 200)
      facts.limitations.push({
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
        // a caller whose options cannot be read may set any key
        if (partial) for (const key of ["preload", ...BOOLEAN_KEYS]) read.unknown.add(key);
        const window = r.window;
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
      if (facts.limitations.length < 200)
        facts.limitations.push({
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
      // A change to a followed object concerns the windows that take options from such an
      // object; a window whose options are all written in place cannot be changed that way.
      const computedKeys = new Set<string>(where?.viaName.has(r.window) ? mutated : []);
      for (const key of evaluated.get(r.window) ?? []) computedKeys.add(key);
      if (hiddenUpTo !== undefined)
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
        ...(hiddenUpTo === undefined ? {} : { opaque: true as const }),
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
      ...(scan.evaluated ? { evaluated: scan.evaluated } : {}),
      ...(scan.unevaluated ? { unevaluated: scan.unevaluated } : {}),
      ...(scan.wrappers ? { wrappers: scan.wrappers } : {}),
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
    skippedFiles: [...facts.skippedFiles],
    partialFiles: [...(facts.truncatedFiles ?? [])],
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
  const bridgeExposures = facts.bridgeExposures ?? [];
  const navigation = facts.navigationHandlers ?? [];
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
        `${outside.length} are stored outside the archive in its .unpacked directory, which was not found next to it (e.g. ${outside.slice(0, 3).join(", ")})`,
      );
    limitations.push({
      code: "js_files_skipped",
      message: `${skipped} files were not read: ${parts.join("; ")}.`,
    });
  }

  // Calls of wrapper classes and objects that another module defines (wrappers.ts): read in the
  // modules that import one, now that every module's exports are known. Nothing is read again
  // when no module exports a wrapper.
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
  const linked = linkWrappers({
    modules,
    edges,
    resolve: (from, specifier) => resolveSpecifier(from, specifier, known),
    open: openModule,
  });
  if (linked.capped.length)
    limitations.push({
      code: "ipc_wrappers_capped",
      message: `${linked.capped.length} file(s) that use IPC wrappers of other modules were not read to the end for calls of them (a budget or the file limit of 200): ${linked.capped.slice(0, 5).join(", ")}${linked.capped.length > 5 ? " …" : ""}.`,
    });
  for (const [file, rows] of linked.rows) {
    const m = moduleById.get(file);
    if (!m) continue;
    const resolver = openModule(file)?.resolver;
    const have = new Set(m.ipc.map((u) => JSON.stringify(u)));
    for (const { usage, arg, unread } of rows) {
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
      if (u.wrapper) {
        if (lookedUpEvaluated) u.resolution = { method: "evaluated", lines: [] };
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
    const stateOf = (key: CoreKey): SettingState => {
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
    return {
      ...w,
      ...states,
      preload: typeof preload?.value === "string" ? preload.value : null,
      ...windowEffects(
        states,
        major,
        facts.enableSandbox === "always" ? true : facts.enableSandbox === "maybe" ? "maybe" : false,
      ),
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
        /^(electron\.(ipc|context-bridge|bridge-exposure|navigation|preload)|js\.(endpoints|storage|minified))$/.test(
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
