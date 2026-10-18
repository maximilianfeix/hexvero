/**
 * IPC wrappers that are classes or objects: a method that passes one of its parameters on, whole,
 * as the channel of an IPC call,
 *
 *     class IpcMainManager { handle(channel, fn) { ipcMain.removeHandler(channel); ipcMain.handle(channel, fn) } }
 *     export const ipcMainManager = new IpcMainManager();
 *     ipcMainManager.handle(IpcEvents.GET_FILES, …)          // in another module
 *
 * and the calls of that method on an instance of the class. A call is read where it is made, with
 * the channel its argument names, and recorded as an IPC row of the method's IPC API with
 * `via: "wrapper"` and `wrapper: "<Class>.<method>"`.
 *
 * An instance is recognised only through what is written: `new C(…)`, a name or a property key
 * of the file bound to one (declared once, never assigned anything else), `this` inside the
 * class, a chain of methods that return `this`, a parameter whose every readable call site passes
 * one, and the same across modules through `require`/`import`, re-exports and the module wrappers
 * of webpack and esbuild. A method that does anything else with its parameter before the call
 * (`ns + ":" + name`, an assignment to it) is no wrapper; a receiver that cannot be traced to an
 * instance gives no row. Nothing is evaluated or run; every search is bounded.
 */
import type { Constants, Resolved } from "./aliases.js";
import type { ExpressionResolver, FnDef } from "./resolve.js";
import type { Candidate } from "./candidates.js";
import type { IpcUsage, Token } from "./scan.js";

/**
 * An IPC call on a parameter of a function or method, `ipc.handle(C.GET, …)` inside
 * `register(ipc) { … }`: the parameter is ipcMain (or ipcRenderer) when every call site passes it.
 * The channel is read at the call inside, as the scan reads one.
 */
export interface ObjectCall {
  /** `handle`, `on`, `send`, … */
  method: string;
  line: number;
  channel: string | null;
  channelRef?: IpcUsage["channelRef"];
  /** For a call that sends: the payload shape (see `IpcUsage.args`). */
  args?: string;
  /**
   * The call looks like IPC: the parameter's name says `ipc`, or the method is one only IPC
   * objects have (`handle`, `handleOnce`, `invoke`, `sendSync`). Only such functions are offered
   * to other modules (`facts`); one in a module another module imports that does not look like
   * IPC gives no rows (its calls there are not read).
   */
  ipcLike?: true;
}

/** Methods only IPC objects have, of those read on a parameter. */
const IPC_ONLY_METHODS: ReadonlySet<string> = new Set([
  "handle",
  "handleOnce",
  "invoke",
  "sendSync",
]);

/** One IPC call a wrapper method makes with one of its parameters, whole, as the channel. */
export interface Forward {
  api: string;
  /** The parameter that is the channel (with `object`: the parameter that is the IPC object). */
  index: number;
  /**
   * Not a channel: parameter `index` is the IPC object, and this is the call made on it. Such a
   * forward gives no row at a call of the method; the call sites decide what the object is
   * (`WrapperReader.objectSites`).
   */
  object?: ObjectCall;
  /**
   * A storage key instead of a channel (`api` is then the storage kind): the token where the
   * key expression of the storage call inside the method starts, which reads parameter `index`,
   * and what the storage call does.
   */
  key?: { at: number; op?: "read" | "write" | "delete" };
}

/** A call of a key-forwarding wrapper method on a proven instance of its class. */
export interface KeyCall {
  /** Token of the method name at the call. */
  at: number;
  /** Token where the argument for the forwarded parameter starts. */
  arg: number;
  forward: Forward & { key: NonNullable<Forward["key"]> };
  cls: WrapperClass;
  /** `label.method`, as the row's `via`. */
  via: string;
}

export interface WrapperClass {
  /** `name@token`: unique in its file. */
  id: string;
  name: string;
  /** The module the class is defined in; "" for the file being read. */
  file: string;
  methods: Record<string, Forward[]>;
  /** Methods that return `this`, so that `r.a(…).b(…)` is one instance. */
  chain: string[];
}

/** What a module keeps for the cross-file stage: its wrappers and the export keys naming one. */
export interface WrapperFacts {
  classes: Array<Omit<WrapperClass, "file">>;
  /** export key (`""`: `module.exports` itself) -> a wrapper class, or an instance of one */
  exports: Record<string, { kind: "cls" | "inst"; id: string }>;
  /** Export keys of plain functions with a parameter used as the IPC object (`ObjectCall`). */
  fns?: string[];
}

/**
 * Which call sites of functions and methods with an IPC object parameter the cross-file stage may
 * have missed: of methods (calls on instances; an importer not read, or the reading budget used
 * up), of plain functions (also: more calls of other modules' functions than are read).
 */
export interface ObjectsCut {
  methods: boolean;
  fns: boolean;
}

/**
 * A call site of a function or method with a parameter used as the IPC object, and what it
 * passes for it: `ipcMain`, `ipcRenderer`, or null (something else, or not read).
 */
export interface ObjectSite {
  /** The module that defines the function; "" for the file being read. */
  home: string;
  /** `<class id>.<method>`, or `fn@<token>` for a plain function. */
  key: string;
  index: number;
  /** Where the call is: `<file>:<token>` ("" for the file being read). */
  site: string;
  target: string | null;
}

/** What an expression is, as far as wrappers are concerned. */
export type WrapperValue =
  | { kind: "cls" | "inst"; cls: WrapperClass; label: string }
  /** The prototype of a wrapper class (`C.prototype`, `Object.getPrototypeOf(inst)`). */
  | { kind: "proto"; cls: WrapperClass }
  | { kind: "fn"; def: FnDef }
  /** An export of another module that is no wrapper, maybe a function: read there if needed. */
  | { kind: "xfn"; file: string; key: string }
  /** Another module's exports (`require("./x")`, `import * as x`). */
  | { kind: "module"; specifier: string }
  /**
   * A bundler's module object in this file (`i(76675)`, `require_x()`): its members are keys.
   * `callee`: the function called, for `require_x()`.
   */
  | { kind: "bundle"; callee?: string }
  /** ipcMain or ipcRenderer itself (`target`), or another name for it. */
  | { kind: "ipc"; target: string };

/**
 * A function or method of a file with a parameter used as the IPC object, the calls made on it,
 * and the call sites the file itself has (see `WrapperReader.objectSites`). The application stage
 * adds the call sites of other modules and gives the calls as IPC rows of ipcMain (or
 * ipcRenderer) only when every call site passes that object.
 */
export interface ParamIpc {
  /** `<class id>.<method>` or `fn@<token>`, as `ObjectSite.key`. */
  key: string;
  /** `Class.method` or the function's name, as the rows' `wrapper`. */
  label: string;
  index: number;
  calls: ObjectCall[];
  sites: Array<{ site: string; target: string | null }>;
}

/** A row the reader found, with the token of its channel argument. */
export interface WrapperRow {
  usage: IpcUsage;
  arg: number;
  /** The argument names no channel the scan can read: for the resolver. */
  unread: boolean;
  /** Token of the method name at the call. */
  at: number;
}

/** Resolves another module's export for the cross-file stage. */
export type ExternalLookup = (specifier: string, key: string) => WrapperValue | null;

const MAX_SITES = 64;
/** Work for reading the functions with an IPC object parameter of one file, and their calls. */
const OBJECT_WORK = 400_000;
/** Work for reading the receivers of member writes in one file (`replacements`). */
const REPLACEMENT_WORK = 200_000;
/** Work of the replacement scan of one application: tokens of the files opened plus receivers. */
const REPLACEMENT_APP_WORK = 3_000_000;
/** Tokens of an argument of a key-forwarding wrapper call the resolver reads, at most. */
const MAX_ARGUMENT_TOKENS = 64;
/** Calls of key-forwarding wrappers read per file. */
export const MAX_KEY_CALLS_PER_FILE = 256;
const MAX_KEY_POSITIONS = 2000;
const MAX_DEPTH = 12;

/**
 * The channel an argument names, only when the argument is that literal or name and nothing more
 * (`"win:" + id` is not the channel `win:`). The same rule as the scanner's.
 */
export function channelArg(tokens: Token[], constants: Constants, k: number): Resolved {
  if (tokens[k]?.type === "template") return constants.resolveArg(k);
  const named = constants.resolve(k);
  if (named === null) return null;
  let end = k + 1;
  while (
    tokens[end]?.type === "punct" &&
    tokens[end]!.value === "." &&
    tokens[end + 1]?.type === "ident"
  )
    end += 2;
  const next = tokens[end];
  return next?.type === "punct" && (next.value === "," || next.value === ")") ? named : null;
}

/** A method of a wrapper class, as a key across readers. */
const methodKey = (cls: WrapperClass, method: string): string =>
  `${cls.file}\u0000${cls.id}\u0000${method}`;

/** A wrapper method another module replaces (see `WrapperReader.replacements`). */
export interface Replaced {
  /** `Class.method`. */
  via: string;
  file: string;
  line: number;
  /** Not a write proven on the wrapper: a receiver not read within the replacement budget there. */
  budget?: true;
}

const same = (a: WrapperValue, b: WrapperValue): boolean => {
  if (a.kind !== b.kind) return false;
  if ((a.kind === "cls" || a.kind === "inst") && (b.kind === "cls" || b.kind === "inst"))
    return a.cls.id === b.cls.id && a.cls.file === b.cls.file;
  if (a.kind === "proto" && b.kind === "proto")
    return a.cls.id === b.cls.id && a.cls.file === b.cls.file;
  if (a.kind === "fn" && b.kind === "fn") return a.def === b.def;
  if (a.kind === "xfn" && b.kind === "xfn") return a.file === b.file && a.key === b.key;
  if (a.kind === "module" && b.kind === "module") return a.specifier === b.specifier;
  if (a.kind === "ipc" && b.kind === "ipc") return a.target === b.target;
  return a.kind === "bundle" && b.kind === "bundle" && a.callee === b.callee;
};

/** A minifier's name says nothing; the export key it is reached through says more. */
const labelled = (v: WrapperValue, key: string): WrapperValue =>
  (v.kind === "cls" && key) || (v.kind === "inst" && v.label.length <= 2 && key)
    ? { ...v, label: key }
    : v;

export class WrapperReader {
  readonly classes: WrapperClass[] = [];
  /** The `{` of a class body or wrapper object literal -> its wrapper. */
  private readonly byStart = new Map<number, WrapperClass>();
  private readonly keyCache = new Map<string, WrapperValue | null>();
  private readonly siteCache = new Map<FnDef, number[]>();
  private readonly seeds = new Map<FnDef, Map<number, WrapperValue[]>>();
  /** Receivers that are chains of calls, by their bounds: a long chain is read link by link once. */
  private readonly chains = new Map<string, WrapperValue[]>();
  /** Channel arguments of the IPC calls inside wrapper methods (the calls of the method carry the channels). */
  readonly inner = new Set<number>();
  /** Token visits left for this file: used up, nothing more is read (and `capped` says so). */
  private work = 400_000;

  /** The work budget ran out: calls of wrappers in this file may be missing. */
  get capped(): boolean {
    return this.work <= 0;
  }

  constructor(
    private readonly tokens: Token[],
    private readonly r: ExpressionResolver,
    private readonly constants: Constants,
    private readonly external: ExternalLookup | null = null,
    private readonly file = "",
    /** `ipcMain` or `ipcRenderer` when the identifier at k is (another name for) one; else null. */
    private readonly ipcAt: ((k: number) => string | null) | null = null,
  ) {}

  private is(k: number, type: Token["type"], value?: string): boolean {
    const t = this.tokens[k];
    return !!t && t.type === type && (value === undefined || t.value === value);
  }

  private punct(k: number, value: string): boolean {
    return this.is(k, "punct", value);
  }

  /**
   * Wrapper methods some module of the application replaces (cross-file stage, `replacements`),
   * as `methodKey(cls, method)`: a call of one may call that other function, and gives no row.
   */
  replaced: ReadonlySet<string> = new Set();

  /**
   * Reads the writes of this file that replace a method of its own wrapper classes
   * (`replacements`) and counts those methods as replaced, as the cross-file stage does for
   * writes in other modules: `Svc.prototype.register = function …`, `t.register = () => {}`,
   * `w.handle = () => {}` on an instance. A call of one then gives no row in this file either.
   * One past the budget counts as replaced as well. Returns the methods, with the write.
   */
  readOwnReplacements(): Array<{ via: string; at: number }> {
    if (!this.classes.length) return [];
    const found = this.replacements();
    if (!found.length) return [];
    const replaced = new Set(this.replaced);
    for (const { cls, method } of found) replaced.add(methodKey(cls, method));
    this.replaced = replaced;
    return found.map(({ cls, method, at }) => ({ via: `${cls.name}.${method}`, at }));
  }

  /** The line of token k. */
  lineOf(k: number): number {
    return this.tokens[k]?.line ?? 0;
  }

  private isReplaced(cls: WrapperClass, method: string): boolean {
    return this.replaced.size > 0 && this.replaced.has(methodKey(cls, method));
  }

  /**
   * Writes in this file that replace or remove a method of a known wrapper class (cross-file
   * stage), on a receiver proven to be the class, its prototype or an instance of it: see
   * docs/electron-findings.md for the list of forms. A write to the export a wrapper is reached
   * through (`m.store = …` with `m = require("./store")`) makes every method of it unknown. A
   * write to any other object (`srv.handle = f`) is none. With the token of the write. The
   * receivers are read within the work budget; one that is not read to the end counts for every
   * class with that method.
   */
  replacements(
    limit = REPLACEMENT_WORK,
  ): Array<{ cls: WrapperClass; method: string; at: number; budget?: true }> {
    // a budget of its own, so that the calls read later have theirs
    const saved = this.work;
    this.work = limit;
    try {
      return this.replacementsIn();
    } finally {
      this.replacementWork = limit - Math.max(0, this.work);
      this.work = saved;
    }
  }

  /** The work the last `replacements` used. */
  replacementWork = 0;

  private replacementsIn(): Array<{
    cls: WrapperClass;
    method: string;
    at: number;
    budget?: true;
  }> {
    const out: Array<{ cls: WrapperClass; method: string; at: number; budget?: true }> = [];
    const { r, tokens } = this;
    const methods = new Set<string>();
    for (const cls of this.classes) for (const m of Object.keys(cls.methods)) methods.add(m);
    if (!methods.size) return out;
    const add = (
      classes: WrapperClass[],
      method: string | null,
      at: number,
      budget = false,
    ): void => {
      for (const cls of classes)
        for (const m of method === null ? Object.keys(cls.methods) : [method])
          if (Object.hasOwn(cls.methods, m) && !out.some((o) => o.cls === cls && o.method === m))
            out.push({ cls, method: m, at, ...(budget ? { budget: true as const } : {}) });
    };
    /** The wrapper classes the receiver in [start, end) is, its prototype or an instance of. */
    const owners = (start: number, end: number): WrapperClass[] | "budget" => {
      if (this.work <= 0) return "budget";
      const found = this.receiverValues(start, end).flatMap((v) =>
        v.kind === "inst" ? [v.cls] : [],
      );
      const v = this.valueOf(start, end);
      if (v?.kind === "cls" || v?.kind === "proto") found.push(v.cls);
      return this.work <= 0 && !found.length ? "budget" : found;
    };
    /** A method of this name of any class, when a receiver could not be read to the end. */
    const anyOf = (method: string | null): WrapperClass[] =>
      this.classes.filter((c) => method === null || Object.hasOwn(c.methods, method));
    /** The export of a module object the member at k of the receiver [start, k - 1) names. */
    const exportAt = (start: number, k: number): WrapperValue | null => {
      const base = this.valueOf(start, k - 1);
      return base?.kind === "module" || base?.kind === "bundle"
        ? this.member(base, this.tokens[k]!.value)
        : null;
    };
    /** Whether the token at k (a member) is a target that is written: `=`, `+=`, `++`, `delete`, a pattern. */
    const written = (k: number, start: number): boolean => {
      const after = tokens[k + 1];
      if (after?.type === "punct") {
        if (after.value === "=") return true;
        if (/^[^=!<>]+=$/.test(after.value) || after.value === "++" || after.value === "--")
          return true;
      }
      const before = tokens[start - 1];
      if (before?.type === "ident" && before.value === "delete") return true;
      if (before?.type === "punct" && (before.value === "++" || before.value === "--")) return true;
      // a target of a destructuring assignment or of `for (… of|in …)`
      if (after?.type === "ident" && (after.value === "of" || after.value === "in")) {
        const open = this.container(start);
        return open !== -1 && this.punct(open, "(") && this.is(open - 1, "ident", "for");
      }
      if (!(after?.type === "punct" && /^[,\]}]$/.test(after.value))) return false;
      for (let open = this.container(start), guard = 0; open !== -1 && guard < 16; guard++) {
        if (!this.punct(open, "[") && !this.punct(open, "{")) return false;
        const close = r.closeOf(open);
        if (close === -1) return false;
        if (this.punct(close + 1, "=")) {
          const word = tokens[open - 1];
          return !(word?.type === "ident" && /^(const|let|var)$/.test(word.value));
        }
        open = this.container(open);
      }
      return false;
    };
    const touch = (start: number, k: number, method: string, at: number): void => {
      const classes = owners(start, k - 1);
      if (classes === "budget")
        return add(anyOf(methods.has(method) ? method : null), method, at, true);
      if (methods.has(method)) add(classes, method, at);
      // the export itself replaced: `m.store = new Proxy(…)`, `m.Store = class {…}`
      const v = exportAt(start, k);
      if (v?.kind === "inst" || v?.kind === "cls") add([v.cls], null, at);
    };
    for (let j = 1; j < tokens.length; j++) {
      const t = tokens[j]!;
      // `R.NAME …` written (a call `Object.assign(…)` is read below)
      if (
        t.type === "ident" &&
        this.punct(j - 1, ".") &&
        !(this.punct(j + 1, "(") && /^(Object|Reflect)$/.test(tokens[j - 2]?.value ?? ""))
      ) {
        if (!/[=+-]|^[,\]}]$/.test(tokens[j + 1]?.value ?? "") && !this.is(j + 1, "ident")) {
          // fast path: only `delete R.NAME`, `++R.NAME` remain, read below
          const start0 = methods.has(t.value) ? r.receiverAt(j - 1) : null;
          if (start0 !== null && written(j, start0)) touch(start0, j, t.value, j);
          continue;
        }
        const start = r.receiverAt(j - 1);
        if (start !== null && written(j, start)) touch(start, j, t.value, j);
        continue;
      }
      // `R["NAME"] …` written
      if (t.type === "string" && this.punct(j - 1, "[") && this.punct(j + 1, "]")) {
        const start = r.receiverAt(j - 1);
        if (start !== null && written(j + 1, start)) {
          const classes = owners(start, j - 1);
          if (classes === "budget") add(anyOf(t.value), t.value, j, true);
          else add(classes, t.value, j);
        }
        continue;
      }
      // a computed member written: `R[name] = f`
      if (t.type === "punct" && t.value === "[" && j > 0 && !this.punct(j - 1, "(")) {
        const close = r.closeOf(j);
        if (close === -1 || tokens[j + 1]?.type === "string") continue;
        const before = tokens[j - 1];
        if (
          !(before?.type === "ident" || (before?.type === "punct" && /^[)\]]$/.test(before.value)))
        )
          continue;
        if (!this.punct(close + 1, "=") && !/^[^=!<>]+=$/.test(tokens[close + 1]?.value ?? ""))
          continue;
        const start = r.receiverAt(j);
        if (start === null) continue;
        const classes = owners(start, j);
        if (classes === "budget") add(anyOf(null), null, j, true);
        else add(classes, null, j);
        continue;
      }
      // `Object.assign(R, {…})`, `Object.defineProperty(R, "NAME", …)`, `Reflect.set(R, "NAME", …)`,
      // `Object.setPrototypeOf(R, …)`, `Reflect.deleteProperty(R, "NAME")`
      if (t.type !== "ident" || !this.punct(j + 1, "(") || !this.punct(j - 1, ".")) continue;
      const on = tokens[j - 2];
      if (on?.type !== "ident" || (on.value !== "Object" && on.value !== "Reflect")) continue;
      const fn = `${on.value}.${t.value}`;
      const named =
        /^(Object\.defineProperty|Reflect\.defineProperty|Reflect\.set|Reflect\.deleteProperty)$/.test(
          fn,
        );
      const keyed = /^(Object\.assign|Object\.defineProperties)$/.test(fn);
      const whole = /^(Object|Reflect)\.setPrototypeOf$/.test(fn);
      if (!named && !keyed && !whole) continue;
      const first = r.argumentAt(j + 1, 0);
      if (first === null || this.punct(first, ")")) continue;
      const read = owners(first, r.endOf(first));
      const classes = read === "budget" ? anyOf(null) : read;
      if (!classes.length) continue;
      if (whole || read === "budget") {
        add(classes, null, j, read === "budget");
        continue;
      }
      if (named) {
        const second = r.argumentAt(j + 1, 1);
        const key = second === null ? undefined : tokens[second];
        // a name computed at run time may be any method
        if (key?.type === "string" && r.endOf(second!) === second! + 1) add(classes, key.value, j);
        else add(classes, null, j);
        continue;
      }
      for (let index = 1; index < 16; index++) {
        const arg = r.argumentAt(j + 1, index);
        if (arg === null || this.punct(arg, ")")) break;
        if (!this.punct(arg, "{")) {
          // an object built elsewhere may hold any method
          add(classes, null, j);
          continue;
        }
        const close = r.closeOf(arg);
        for (let k = arg + 1; k < close; k++) {
          const x = tokens[k]!;
          if (x.type === "punct" && /^[([{]$/.test(x.value)) {
            k = r.closeOf(k);
            if (k === -1) break;
            continue;
          }
          if (x.type === "punct" && x.value === "...") add(classes, null, j);
          else if (
            (x.type === "ident" || x.type === "string") &&
            methods.has(x.value) &&
            (this.punct(k - 1, "{") || this.punct(k - 1, ","))
          )
            add(classes, x.value, j);
        }
      }
    }
    return out;
  }

  /** Known wrappers of another module (cross-file stage): reachable as classes of this reader. */
  adopt(cls: WrapperClass): void {
    if (!this.classes.includes(cls)) this.classes.push(cls);
  }

  /**
   * Finds the file's wrapper methods from its IPC calls whose channel argument is a lone name:
   * `{ api, arg }` with `arg` the token of that name.
   */
  findClasses(calls: ReadonlyArray<{ api: string; arg: number }>): void {
    const { r } = this;
    for (const { api, arg } of calls) {
      const param = this.tokens[arg]!.value;
      // the function around the call whose parameter it is (also through callbacks in the method)
      let def = r.functionAt(arg);
      let index = -1;
      for (let guard = 0; def && guard < 4; guard++) {
        index = def.params.findIndex((p) => p.kind === "name" && p.name === param);
        if (index !== -1) break;
        if (this.declares(def, param)) {
          def = null;
          break;
        }
        def = r.outerOf(def);
      }
      if (!def || index === -1) continue;
      if (this.declares(def, param, true)) continue;
      if (this.register(def, { api, index })) this.inner.add(arg);
    }
    this.findChains();
  }

  /**
   * Finds the file's storage-key wrapper methods: a storage call whose key expression (at `at`)
   * reads one parameter of the method or object-literal function around it, unchanged in the
   * body (the resolver's rule for in-file wrappers). A method whose name is also assigned as a
   * member in the file (`x.get = f`) is none: `x.get(…)` may call that other function.
   */
  findKeyWrappers(
    keys: ReadonlyArray<{ at: number; kind: string; op?: "read" | "write" | "delete" }>,
  ): void {
    for (const { at, kind, op } of keys) {
      if (this.work-- <= 0) break;
      const found = this.r.keyParameter(at);
      if (!found || found.def.name === null || this.r.memberAssigned(found.def.name)) continue;
      this.register(found.def, {
        api: kind,
        index: found.index,
        key: { at, ...(op ? { op } : {}) },
      });
    }
    this.findChains();
  }

  /** Records def as a wrapper method with the forward; false when def is no method of a class or object. */
  private register(def: FnDef, forward: Forward): boolean {
    const { r } = this;
    if (def.name === null || /^(constructor|__proto__)$/.test(def.name)) return false;
    // a `static` method is called on the class, never on an instance: no wrapper method
    if (def.static) return false;
    let start: number | null = null;
    let name = "";
    if (def.owner !== null && !def.arrow) {
      const range = r.classOfMethod(def);
      if (range) {
        start = range.start;
        name = range.name;
      }
    } else if (def.member) {
      start = r.objectOfMember(def);
      if (start !== null) {
        const named =
          this.punct(start - 1, "=") && this.is(start - 2, "ident") && !this.punct(start - 3, ".");
        name = named ? this.tokens[start - 2]!.value : "object";
      }
    }
    if (start === null) return false;
    let cls = this.byStart.get(start);
    if (!cls) {
      cls = {
        id: `${name}@${start}`,
        name,
        file: this.file,
        methods: {},
        chain: [],
      };
      this.byStart.set(start, cls);
      this.classes.push(cls);
    }
    const forwards = Object.hasOwn(cls.methods, def.name) ? cls.methods[def.name]! : [];
    if (
      !forwards.some(
        (f) =>
          f.api === forward.api &&
          f.index === forward.index &&
          f.key?.at === forward.key?.at &&
          f.object?.line === forward.object?.line &&
          f.object?.channel === forward.object?.channel &&
          JSON.stringify(f.object?.channelRef) === JSON.stringify(forward.object?.channelRef),
      )
    )
      forwards.push(forward);
    cls.methods[def.name] = forwards;
    return true;
  }

  /** Methods of the file's own classes that return `this`. */
  private findChains(): void {
    for (const cls of this.classes) {
      if (cls.file !== this.file) continue;
      const range = this.r.classesOf().find((c) => c.start === this.startOf(cls));
      if (!range) continue;
      for (const m of this.r.methodsIn(range))
        if (m.name && this.r.returnsSelf(m) && !cls.chain.includes(m.name)) cls.chain.push(m.name);
    }
  }

  private startOf(cls: WrapperClass): number {
    return Number(cls.id.slice(cls.id.lastIndexOf("@") + 1));
  }

  /**
   * Whether the body of def declares the name (`const|let|var name`) or, with `assigns`, writes
   * to it (`name = …`, `name += …`, `name++`): then the parameter is not passed on unchanged.
   */
  private declares(def: FnDef, name: string, assigns = false): boolean {
    for (const j of this.r.namePositions(name, def.body[0], def.body[1])) {
      if (this.work-- <= 0) break;
      if (this.punct(j - 1, ".")) continue;
      const before = this.tokens[j - 1];
      if (before?.type === "ident" && /^(const|let|var|function|class)$/.test(before.value))
        return true;
      if (!assigns) continue;
      const after = this.tokens[j + 1];
      if (
        (after?.type === "punct" && /^([^=!<>]*=|\+\+|--)$/.test(after.value)) ||
        (before?.type === "punct" && (before.value === "++" || before.value === "--"))
      )
        return true;
      // `for (ipc of …)`, `for (ipc in …)`: bound again in each round
      if (
        (this.is(j + 1, "ident", "of") || this.is(j + 1, "ident", "in")) &&
        this.punct(j - 1, "(") &&
        this.is(j - 2, "ident", "for")
      )
        return true;
      // `({ ipc } = …)`, `[ipc] = …`, `({ a: ipc } = …)`: a destructuring assignment
      if (
        this.punct(j - 1, "[") ||
        this.punct(j - 1, ",") ||
        this.punct(j - 1, "{") ||
        this.punct(j - 1, ":")
      ) {
        const open = this.container(j);
        const close = open === -1 ? -1 : this.r.closeOf(open);
        const word = this.tokens[open - 1];
        if (
          close !== -1 &&
          (this.punct(open, "{") || this.punct(open, "[")) &&
          this.punct(close + 1, "=") &&
          !(word?.type === "ident" && /^(const|let|var)$/.test(word.value))
        )
          return true;
      }
    }
    return false;
  }

  // ---------- values ----------

  /** The start of the value of an assignment chain in [start, end): `n.A = n.B = new C` -> `new C`. */
  private assigned(start: number, end: number): number {
    let at = start;
    for (let j = start; j < end; j++) {
      const t = this.tokens[j]!;
      if (t.type !== "punct") continue;
      if (t.value === "(" || t.value === "[" || t.value === "{") {
        const close = this.r.closeOf(j);
        if (close === -1 || close >= end) return at;
        j = close;
      } else if (t.value === "=") at = j + 1;
    }
    return at;
  }

  /** What the expression in [start, end) is. */
  valueOf(start: number, end: number, depth = 0): WrapperValue | null {
    if (depth > MAX_DEPTH || this.work-- <= 0 || start >= end) return null;
    const { r } = this;
    start = this.assigned(start, end);
    if (start >= end) return null;
    // `(X)`, `(0, X.K)`
    if (this.punct(start, "(") && r.closeOf(start) === end - 1) {
      if (this.is(start + 1, "number") && this.punct(start + 2, ","))
        return this.valueOf(start + 3, end - 1, depth + 1);
      return this.valueOf(start + 1, end - 1, depth + 1);
    }
    if (this.is(start, "ident", "new")) {
      // `new (require("./store").Store)(…)`
      if (this.punct(start + 1, "(")) {
        const group = r.closeOf(start + 1);
        if (group === -1 || !this.punct(group + 1, "(") || r.closeOf(group + 1) !== end - 1)
          return null;
        const callee = this.valueOf(start + 2, group, depth + 1);
        return callee?.kind === "cls"
          ? { kind: "inst", cls: callee.cls, label: callee.label }
          : null;
      }
      let e = start + 1;
      while (e < end && (this.is(e, "ident") || this.punct(e, "."))) e++;
      if (e < end && !(this.punct(e, "(") && r.closeOf(e) === end - 1)) return null;
      const callee = this.valueOf(start + 1, e, depth + 1);
      return callee?.kind === "cls" ? { kind: "inst", cls: callee.cls, label: callee.label } : null;
    }
    if (this.is(start, "ident", "class")) {
      for (let j = start + 1; j < end && j < start + 21; j++)
        if (this.punct(j, "{")) {
          const cls = this.byStart.get(j);
          return cls && r.closeOf(j) === end - 1 ? { kind: "cls", cls, label: cls.name } : null;
        }
      return null;
    }
    if (this.punct(start, "{")) {
      const cls = this.byStart.get(start);
      return cls && r.closeOf(start) === end - 1 ? { kind: "inst", cls, label: cls.name } : null;
    }
    // a function expression
    for (let j = start; j < end && j < start + 4; j++) {
      const def = r.functionWithParamsAt(j);
      if (def && (def.body[1] === end || def.body[1] === end + 1)) return { kind: "fn", def };
    }
    if (end === start + 1 && this.is(start, "ident")) return this.nameValue(start, depth + 1);
    // `require("./x")`
    if (
      this.is(start, "ident", "require") &&
      this.punct(start + 1, "(") &&
      this.is(start + 2, "string") &&
      this.punct(start + 3, ")") &&
      end === start + 4
    )
      return { kind: "module", specifier: this.tokens[start + 2]!.value };
    // a call: `i(76675)` (webpack), `require_x()` (esbuild), `__toESM(require_x())` (interop)
    if (this.is(start, "ident") && this.punct(start + 1, "(") && r.closeOf(start + 1) === end - 1) {
      if (end === start + 3) return { kind: "bundle", callee: this.tokens[start]!.value };
      if (end === start + 4 && this.is(start + 2, "number")) return { kind: "bundle" };
      const first = start + 2;
      const inner = this.valueOf(first, Math.min(r.endOf(first), end - 1), depth + 1);
      return inner?.kind === "bundle" || inner?.kind === "module" ? inner : null;
    }
    // `Object.getPrototypeOf(inst)`
    if (
      this.is(start, "ident", "Object") &&
      this.punct(start + 1, ".") &&
      this.is(start + 2, "ident", "getPrototypeOf") &&
      this.punct(start + 3, "(") &&
      r.closeOf(start + 3) === end - 1
    ) {
      const inner = this.valueOf(start + 4, end - 1, depth + 1);
      return inner?.kind === "inst" ? { kind: "proto", cls: inner.cls } : null;
    }
    // `<base>.K`
    if (end - start >= 3 && this.punct(end - 2, ".") && this.is(end - 1, "ident")) {
      const key = this.tokens[end - 1]!.value;
      if (end - 2 === start + 1 && this.is(start, "ident", "this")) return this.keyValue(key);
      const base = this.valueOf(start, end - 2, depth + 1);
      // `C.prototype`, `inst.__proto__`, `inst.constructor`
      if (key === "prototype" && base?.kind === "cls") return { kind: "proto", cls: base.cls };
      if (key === "__proto__" && base?.kind === "inst") return { kind: "proto", cls: base.cls };
      if (key === "constructor" && base?.kind === "inst")
        return { kind: "cls", cls: base.cls, label: base.label };
      return this.member(base, key);
    }
    return null;
  }

  private member(base: WrapperValue | null, key: string): WrapperValue | null {
    if (base?.kind === "bundle") {
      const v = this.keyValue(key);
      return v ? labelled(v, key) : null;
    }
    if (base?.kind === "module") return this.external?.(base.specifier, key) ?? null;
    return null;
  }

  /** What the identifier at k is bound to. */
  private nameValue(k: number, depth: number): WrapperValue | null {
    if (depth > MAX_DEPTH) return null;
    const name = this.tokens[k]!.value;
    if (name === "this") return null;
    // `const s = new Store(); s.set(…)`: the resolver takes a call of a mutator (`set`, `push`)
    // for a change of what the name holds; for an instance the binding stays, unless the name
    // is assigned anywhere in the file
    let b = this.r.binding(k, name);
    if (!b) {
      const loose = this.r.binding(k, name, true);
      if (loose && !this.assignedAnywhere(name)) b = loose;
    }
    if (b)
      switch (b.kind) {
        case "param":
          return null;
        case "value":
          return this.valueOf(b.range[0], b.range[1], depth + 1);
        case "function":
          return { kind: "fn", def: b.def };
        case "class": {
          const cls = this.byStart.get(b.start);
          return cls ? { kind: "cls", cls, label: cls.name } : null;
        }
        case "pattern":
          return this.member(this.valueOf(b.from[0], b.from[1], depth + 1), b.key);
      }
    // no binding the resolver can read: a parameter, local, pattern, `for … of` head or `catch`
    // of the name around k is something else than the import
    const imported = this.constants.importOf(name, k);
    const required = imported ? null : this.constants.requireOf(name, k);
    if (!imported && !required) return null;
    if (this.r.boundAround(k, name)) return null;
    if (imported) return this.external?.(imported.specifier, imported.property) ?? null;
    return { kind: "module", specifier: required! };
  }

  private readonly assignedCache = new Map<string, boolean>();

  /**
   * Whether the name is assigned anywhere in the file, in any scope: `NAME = …`, `NAME += …`,
   * `NAME++`, or as part of a destructuring assignment (`[NAME] = …`, `({ NAME } = …)`). Counted
   * against the work budget; used up, the name counts as assigned.
   */
  private assignedAnywhere(name: string): boolean {
    const known = this.assignedCache.get(name);
    if (known !== undefined) return known;
    let found = false;
    for (const j of this.r.namePositions(name)) {
      if (this.work-- <= 0) {
        found = true;
        break;
      }
      if (this.punct(j - 1, ".") || this.punct(j - 1, "?.")) continue;
      const before = this.tokens[j - 1];
      const after = this.tokens[j + 1];
      if (before?.type === "ident" && /^(const|let|var)$/.test(before.value)) continue;
      if (
        (after?.type === "punct" && /^([^=!<>]*=|\+\+|--)$/.test(after.value)) ||
        (before?.type === "punct" && (before.value === "++" || before.value === "--"))
      ) {
        found = true;
        break;
      }
      if (this.punct(j - 1, "[") || this.punct(j - 1, ",") || this.punct(j - 1, "{")) {
        const open = this.container(j);
        const close = open === -1 ? -1 : this.r.closeOf(open);
        const word = this.tokens[open - 1];
        if (
          close !== -1 &&
          this.punct(close + 1, "=") &&
          !(word?.type === "ident" && /^(const|let|var)$/.test(word.value))
        ) {
          found = true;
          break;
        }
      }
    }
    this.assignedCache.set(name, found);
    return found;
  }

  /** The `(`, `[` or `{` that holds token j, or -1. */
  private container(j: number): number {
    for (let i = j - 1, steps = 0; i >= 0 && steps < 400; i--, steps++) {
      const t = this.tokens[i]!;
      if (t.type !== "punct") continue;
      if (t.value === ")" || t.value === "]" || t.value === "}") {
        i = this.r.openOf(i);
        if (i === -1) return -1;
      } else if (t.value === "(" || t.value === "[" || t.value === "{") return i;
    }
    return -1;
  }

  /**
   * What the property key K of this file is: every definition of it (`.K = v`, `K: v`, `{ K }`,
   * `export const K`, `export { a as K }`, a class field `K = v`) must say the same, and say
   * something; `.K = void 0` (TypeScript's export hoisting) says nothing. `""` is the module's
   * `module.exports = v` itself, `"default"` its `export default v`.
   */
  keyValue(key: string): WrapperValue | null {
    const cached = this.keyCache.get(key);
    if (cached !== undefined) return cached;
    // Read at depth 0, so that the cached answer does not depend on where it was asked first;
    // keys within keys are bounded by their own nesting.
    if (this.keyNesting >= 8) return null;
    this.keyNesting++;
    try {
      return this.keyValueIn(key);
    } finally {
      this.keyNesting--;
    }
  }

  private keyNesting = 0;

  private keyValueIn(key: string): WrapperValue | null {
    const depth = 0;
    this.keyCache.set(key, null); // a cycle reads as nothing
    let found: WrapperValue | null = null;
    let ok = true;
    const visit = (v: WrapperValue | null): void => {
      if (!v) ok = false;
      else if (!found) found = v;
      else if (!same(found, v)) ok = false;
    };
    const { r } = this;
    /** `void 0`, TypeScript's export hoisting, says nothing about the key. */
    const valueAfter = (at: number): void => {
      if (this.is(at, "ident", "void") && this.is(at + 1, "number")) return;
      visit(this.valueOf(at, r.endOf(at), depth + 1));
    };
    const name = key === "" ? "exports" : key;
    const all = r.namePositions(name);
    if (all.length > MAX_KEY_POSITIONS) return null;
    for (const j of all) {
      if (this.work-- <= 0) break;
      if (!ok) break;
      if (key === "" || key === "default") {
        if (key === "" && this.punct(j - 1, ".") && this.punct(j + 1, "=")) valueAfter(j + 2);
        else if (key === "default" && this.is(j - 1, "ident", "export") && !this.punct(j + 1, ","))
          valueAfter(j + 1);
        continue;
      }
      // `.K = value`
      if (this.punct(j - 1, ".") && this.punct(j + 1, "=")) {
        valueAfter(j + 2);
        continue;
      }
      if (this.punct(j - 1, ".") || this.punct(j - 1, "?.")) continue;
      // an entry of an object literal (not of a pattern or an import list)
      if (
        (this.punct(j - 1, "{") || this.punct(j - 1, ",")) &&
        (this.punct(j + 1, ":") || this.punct(j + 1, ",") || this.punct(j + 1, "}"))
      ) {
        const open = this.container(j);
        if (open === -1 || !this.punct(open, "{")) continue;
        const close = r.closeOf(open);
        if (close === -1 || this.punct(close + 1, "=") || this.is(open - 1, "ident", "import"))
          continue;
        // a pattern in a parameter list: `function f({ K }) {`
        const around = this.container(open);
        if (around !== -1 && this.punct(around, "(") && r.functionWithParamsAt(around)) continue;
        if (this.is(close + 1, "ident", "from")) {
          // `export { K } from "./x"`
          if (this.is(open - 1, "ident", "export") && this.is(close + 2, "string"))
            visit(this.external?.(this.tokens[close + 2]!.value, key) ?? null);
          continue;
        }
        if (this.punct(j + 1, ":")) valueAfter(j + 2);
        else visit(this.nameValue(j, depth + 1));
        continue;
      }
      // `export { a as K }`, `export { a as K } from "./x"`
      if (this.is(j - 1, "ident", "as") && this.is(j - 2, "ident")) {
        const open = this.container(j);
        if (open === -1 || !this.is(open - 1, "ident", "export")) continue;
        const close = r.closeOf(open);
        if (this.is(close + 1, "ident", "from") && this.is(close + 2, "string"))
          visit(this.external?.(this.tokens[close + 2]!.value, this.tokens[j - 2]!.value) ?? null);
        else visit(this.nameValue(j - 2, depth + 1));
        continue;
      }
      // `export const K = …`, `export class K`, `export function K`
      if (
        this.is(j - 1, "ident") &&
        /^(const|let|var|class|function)$/.test(this.tokens[j - 1]!.value) &&
        this.is(j - 2, "ident", "export")
      ) {
        visit(this.nameValue(j, depth + 1));
        continue;
      }
      // a class field: `K = value` directly in a class body
      if (
        this.punct(j + 1, "=") &&
        (this.punct(j - 1, ";") ||
          this.punct(j - 1, "{") ||
          this.punct(j - 1, "}") ||
          this.is(j - 1, "ident", "static"))
      ) {
        const body = r
          .classesOf()
          .find((c) => c.start < j && j < c.end && r.depthOf(j) === r.depthOf(c.start) + 1);
        if (body) valueAfter(j + 2);
      }
    }
    const result = ok ? found : null;
    this.keyCache.set(key, result);
    return result;
  }

  // ---------- receivers ----------

  /** The wrapper class of the method `this` means at k, when that is a method of one. */
  private thisClass(k: number): WrapperClass | null {
    let def = this.r.functionAt(k);
    while (def?.arrow) def = this.r.outerOf(def);
    if (!def || def.owner === null) return null;
    const range = this.r.classOfMethod(def);
    return range ? (this.byStart.get(range.start) ?? null) : null;
  }

  /** The instances of wrappers the receiver expression in [start, end) can be. */
  receiverValues(start: number, end: number, depth = 0): WrapperValue[] {
    if (depth > 4 || this.work-- <= 0) return [];
    // ipcMain, another name for it, `electron.ipcMain`: only while call sites of functions with
    // an IPC object parameter are read (`objectSites`, `passes`)
    if (this.readingObjects) {
      const target = this.ipcOf(start, end);
      if (target) return [{ kind: "ipc", target }];
    }
    if (end === start + 1 && this.is(start, "ident", "this")) {
      const cls = this.thisClass(start);
      return cls ? [{ kind: "inst", cls, label: cls.name }] : [];
    }
    if (end === start + 1 && this.is(start, "ident")) {
      const b = this.r.binding(start, this.tokens[start]!.value);
      if (b?.kind === "param") return this.paramValues(b.def, b.index, depth + 1);
    }
    // a chain: `<receiver>.m(…)` is the same instance when m returns `this`; any length, each
    // link read once
    if (this.punct(end - 1, ")")) {
      const open = this.r.openOf(end - 1);
      if (open > start + 1 && this.is(open - 1, "ident") && this.punct(open - 2, ".")) {
        const key = `${start}:${end}`;
        const known = this.chains.get(key);
        if (known) return known;
        const method = this.tokens[open - 1]!.value;
        const out = this.receiverValues(start, open - 2, depth).filter(
          (v) => v.kind === "inst" && v.cls.chain.includes(method),
        );
        this.chains.set(key, out);
        return out;
      }
    }
    let v = this.valueOf(start, end, depth + 1);
    // `const r = require("./router")` with `module.exports = new Router()` there
    if (v?.kind === "module")
      v = this.external?.(v.specifier, "") ?? this.external?.(v.specifier, "default") ?? null;
    // `var store = require_singleton()` in one bundle: what every `module.exports = …` of the
    // file says, when they all say the same
    else if (v?.kind === "bundle" && this.keyCallsOnly) v = this.keyValue("");
    // while call sites of IPC object parameters are read: what that one module's body assigns
    // to its `module.exports`
    else if (v?.kind === "bundle" && v.callee && this.readingObjects)
      v = this.bundleExport(v.callee);
    return v?.kind === "inst" ? [v] : [];
  }

  /** What a parameter of def can be: what its every readable call site passes, or a seed. */
  private paramValues(def: FnDef, index: number, depth: number): WrapperValue[] {
    // a parameter the function assigns (`s = new Map()`) is not what the callers pass
    const p = def.params[index];
    if (p?.kind !== "name" || this.declares(def, p.name, true)) return [];
    // a call of another module passes something that is no instance for it
    if (this.opaque.get(def)?.has(index)) return [];
    const seeded = this.seeds.get(def)?.get(index);
    if (seeded) return seeded;
    const out: WrapperValue[] = [];
    for (const open of this.callSitesOf(def)) {
      const arg = this.r.argumentAt(open, index);
      if (arg === null) continue;
      for (const v of this.receiverValues(arg, this.r.endOf(arg), depth + 1))
        if (!out.some((o) => same(o, v))) out.push(v);
    }
    return out;
  }

  /** Parameters some call of another module passes something else than an instance for. */
  private readonly opaque = new Map<FnDef, Set<number>>();

  /** What another module passes for parameter `index` of def (cross-file stage); none: not an instance. */
  seed(def: FnDef, index: number, values: WrapperValue[]): void {
    if (!values.length) {
      const set = this.opaque.get(def) ?? new Set<number>();
      set.add(index);
      this.opaque.set(def, set);
      this.chains.clear();
      return;
    }
    const by = this.seeds.get(def) ?? new Map<number, WrapperValue[]>();
    const have = by.get(index) ?? [];
    for (const v of values) if (!have.some((h) => same(h, v))) have.push(v);
    by.set(index, have);
    this.seeds.set(def, by);
    this.chains.clear();
  }

  /**
   * The `(` of every call of def in the file: by its name, through the keys it is exported or
   * passed on under (`module.exports = { register: register2 }`), and through the names an object
   * pattern takes it under (`var { register } = require_x()`, minified `{register:F}=Y()`).
   */
  private callSitesOf(def: FnDef): number[] {
    const cached = this.siteCache.get(def);
    if (cached) return cached;
    const out: number[] = [];
    this.siteCache.set(def, out);
    if (def.name === null) return out;
    const { r } = this;
    const add = (open: number): void => {
      if (out.length < MAX_SITES && !out.includes(open)) out.push(open);
    };
    const names = new Set<string>(def.member ? [] : [def.name]);
    const keys = new Set<string>();
    // A function declared inside another one (a module a bundler wraps) is visible only in that
    // function's body: its name is looked for there, not in the whole file, where a minifier
    // reuses the same short name thousands of times.
    const outer = def.member || def.owner ? null : r.outerOf(def);
    const [from, to] = outer ? outer.body : [0, this.tokens.length];
    for (const j of r.namePositions(def.name, from, to)) {
      if (this.work-- <= 0) break;
      if (
        this.punct(j - 1, ":") &&
        this.is(j - 2, "ident") &&
        (this.punct(j - 3, "{") || this.punct(j - 3, ","))
      )
        keys.add(this.tokens[j - 2]!.value);
      else if (this.punct(j - 1, "=") && this.is(j - 2, "ident") && this.punct(j - 3, "."))
        keys.add(this.tokens[j - 2]!.value);
      else if (
        (this.punct(j - 1, "{") || this.punct(j - 1, ",")) &&
        (this.punct(j + 1, ",") || this.punct(j + 1, "}"))
      )
        keys.add(def.name);
    }
    for (const key of keys) {
      const v = this.keyValue(key);
      if (v?.kind !== "fn" || v.def !== def) continue;
      for (const j of r.namePositions(key)) {
        if (this.work-- <= 0) break;
        if (this.punct(j - 1, ".") && this.punct(j + 1, "(")) add(j + 1);
        else if (this.punct(j - 1, ".") && this.punct(j + 1, ")") && this.punct(j + 2, "("))
          add(j + 2); // `(0, x.K)(…)`
        else if (
          (this.punct(j - 1, "{") || this.punct(j - 1, ",")) &&
          this.punct(j + 1, ":") &&
          this.is(j + 2, "ident")
        )
          names.add(this.tokens[j + 2]!.value);
        else if (
          (this.punct(j - 1, "{") || this.punct(j - 1, ",")) &&
          (this.punct(j + 1, ",") || this.punct(j + 1, "}"))
        )
          names.add(key);
      }
    }
    for (const name of names)
      for (const j of name === def.name ? r.namePositions(name, from, to) : r.namePositions(name)) {
        if (this.work-- <= 0) break;
        if (out.length >= MAX_SITES) break;
        if (!this.punct(j + 1, "(") || this.punct(j - 1, ".") || j + 1 === def.paramsAt) continue;
        if (this.is(j - 1, "ident", "function")) continue;
        const v = this.nameValue(j, 1);
        if (v?.kind === "fn" && v.def === def) add(j + 1);
      }
    return out;
  }

  // ---------- IPC object parameters ----------

  /** Set while call sites of IPC object parameters are read: `ipcMain` is a value then. */
  private readingObjects = false;
  /**
   * Token visits left for reading IPC object parameters, their own budget: that reading never
   * takes from what the wrapper rows of the file may use.
   */
  private objectWork = OBJECT_WORK;

  /** The reading of IPC object parameters ran out of its budget: call sites may be missing. */
  get objectsCapped(): boolean {
    return this.objectWork <= 0;
  }

  /** Runs `read` on the budget of IPC object parameters. */
  private onObjectBudget<T>(read: () => T): T {
    const saved = this.work;
    this.work = this.objectWork;
    try {
      return read();
    } finally {
      this.objectWork = this.work;
      this.work = saved;
    }
  }
  /** Plain functions of this file with a parameter used as the IPC object, by parameter. */
  private readonly objectFns = new Map<FnDef, Map<number, ObjectCall[]>>();
  /** What calls of other modules pass for an IPC object parameter (cross-file stage). */
  private readonly objectSeeds = new Map<
    FnDef,
    Map<number, Array<{ site: string; target: string | null }>>
  >();

  /** `ipcMain` / `ipcRenderer` when [start, end) is one as such: a name or `x.ipcMain`. */
  private ipcOf(start: number, end: number): string | null {
    if (!this.ipcAt || end <= start || end - start > 9 || !this.is(end - 1, "ident")) return null;
    for (let j = start; j < end - 1; j += 2)
      if (!this.is(j, "ident") || !this.punct(j + 1, ".")) return null;
    // a parameter named so is what its callers pass (read as a parameter instead)
    if (end === start + 1 && this.r.paramAround(start, this.tokens[start]!.value)) return null;
    return this.ipcAt(end - 1);
  }

  /** What the body of the module a bundler wrapped as `callee` assigns to `module.exports`. */
  private bundleExport(callee: string): WrapperValue | null {
    const mod = this.r.bundledModule(callee);
    if (!mod?.module) return null;
    let found: WrapperValue | null = null;
    for (const j of this.r.namePositions(mod.module, mod.body[0], mod.body[1])) {
      if (this.work-- <= 0) return null;
      if (
        this.punct(j - 1, ".") ||
        !this.punct(j + 1, ".") ||
        !this.is(j + 2, "ident", "exports") ||
        !this.punct(j + 3, "=") ||
        this.punct(j + 4, "=")
      )
        continue;
      const v = this.valueOf(j + 4, this.r.endOf(j + 4), 1);
      if (!v || (found && !same(found, v))) return null;
      found = v;
    }
    return found;
  }

  /**
   * Finds the functions and methods whose parameter is used as the IPC object: `at` is the token
   * of the parameter's name in `P.method(…)`, `call` what that call is. A parameter the body
   * writes to is none; a function that is not named (a callback) is none.
   */
  findObjectParams(found: ReadonlyArray<{ at: number; call: ObjectCall }>): void {
    this.onObjectBudget(() => this.findObjectParamsIn(found));
  }

  private findObjectParamsIn(found: ReadonlyArray<{ at: number; call: ObjectCall }>): void {
    for (const { at, call } of found) {
      if (this.work-- <= 0) break;
      const name = this.tokens[at]!.value;
      const b = this.r.binding(at, name);
      if (b?.kind !== "param") continue;
      const { def, index } = b;
      if (def.params[index]?.kind !== "name" || def.name === null) continue;
      if (this.declares(def, name, true)) continue;
      const forward: Forward = {
        api: call.method,
        index,
        object:
          /ipc/i.test(name) || IPC_ONLY_METHODS.has(call.method)
            ? { ...call, ipcLike: true }
            : call,
      };
      if ((def.owner !== null && !def.arrow) || def.member) {
        this.register(def, forward);
        continue;
      }
      if (def.owner !== null || def.static) continue;
      const by = this.objectFns.get(def) ?? new Map<number, ObjectCall[]>();
      const calls = by.get(index) ?? [];
      calls.push(forward.object!);
      by.set(index, calls);
      this.objectFns.set(def, by);
    }
    this.findChains();
  }

  /**
   * Every function and method of this file with an IPC object parameter, with the call sites
   * this file has (`objectSites`), for the scan's facts.
   */
  paramIpc(): ParamIpc[] {
    const sites = this.objectSites();
    const out: ParamIpc[] = [];
    const add = (key: string, label: string, index: number, calls: ObjectCall[]): void => {
      out.push({
        key,
        label,
        index,
        calls,
        sites: sites
          .filter((x) => x.home === this.file && x.key === key && x.index === index)
          .map(({ site, target }) => ({ site, target })),
      });
    };
    for (const cls of this.classes) {
      if (cls.file !== this.file) continue;
      for (const [method, forwards] of Object.entries(cls.methods)) {
        const byIndex = new Map<number, ObjectCall[]>();
        for (const f of forwards)
          if (f.object) byIndex.set(f.index, [...(byIndex.get(f.index) ?? []), f.object]);
        for (const [index, calls] of byIndex)
          add(`${cls.id}.${method}`, `${cls.name}.${method}`, index, calls);
      }
    }
    for (const [def, by] of this.objectFns)
      for (const [index, calls] of by) add(`fn@${def.paramsAt}`, def.name!, index, calls);
    return out;
  }

  /** The plain functions with IPC object parameters, with their calls (for the scan's facts). */
  objectFunctions(): Array<{ key: string; label: string; index: number; calls: ObjectCall[] }> {
    const out: Array<{ key: string; label: string; index: number; calls: ObjectCall[] }> = [];
    for (const [def, by] of this.objectFns)
      for (const [index, calls] of by)
        out.push({ key: `fn@${def.paramsAt}`, label: def.name!, index, calls });
    return out;
  }

  /** What a call of another module passes for an IPC object parameter of def (cross-file stage). */
  seedObject(def: FnDef, index: number, site: string, target: string | null): void {
    const by =
      this.objectSeeds.get(def) ??
      new Map<number, Array<{ site: string; target: string | null }>>();
    const list = by.get(index) ?? [];
    if (!list.some((x) => x.site === site)) list.push({ site, target });
    by.set(index, list);
    this.objectSeeds.set(def, by);
  }

  /**
   * The uses of a plain function of this file other than a call by its name and an export of it:
   * `reg.call(…)` (with the `(` of that call), `reg.apply(…)`, `reg.bind(…)`, `forEach(reg)`,
   * `setTimeout(reg, …)`, `const f = reg`. Each may call it with something else.
   */
  private otherUses(def: FnDef): Array<{ at: number; call: number | null }> {
    const out: Array<{ at: number; call: number | null }> = [];
    if (def.name === null) return out;
    const { r } = this;
    const outer = r.outerOf(def);
    const [from, to] = outer ? outer.body : [0, this.tokens.length];
    for (const j of r.namePositions(def.name, from, to)) {
      if (this.work-- <= 0) break;
      if (this.punct(j - 1, ".") || this.punct(j - 1, "?.")) continue;
      if (this.is(j - 1, "ident", "function") || j + 1 === def.paramsAt) continue;
      if (this.punct(j + 1, "(")) continue; // a call by name: `callSitesOf`
      // a key of an object literal, `{ reg: … }`, or the name's own declaration
      if (this.punct(j + 1, ":") && (this.punct(j - 1, "{") || this.punct(j - 1, ","))) continue;
      if (this.is(j - 1, "ident") && /^(const|let|var|class)$/.test(this.tokens[j - 1]!.value))
        continue;
      if (this.exportUse(j)) continue;
      const b = r.binding(j, def.name);
      if (b && !(b.kind === "function" && b.def === def)) continue;
      const call =
        this.punct(j + 1, ".") && this.is(j + 2, "ident", "call") && this.punct(j + 3, "(")
          ? j + 3
          : null;
      out.push({ at: j, call });
    }
    return out;
  }

  /**
   * The use of a name at j exports it, as such: `module.exports = reg`, `exports.K = reg`,
   * `module.exports = { reg, K: reg }`, `export { reg }`, `export default reg`.
   */
  private exportUse(j: number): boolean {
    if (this.is(j - 1, "ident", "default") && this.is(j - 2, "ident", "export")) return true;
    if (this.punct(j - 1, "=") && this.is(j - 2, "ident") && this.punct(j - 3, ".")) {
      const holder = this.tokens[j - 4];
      return (
        this.tokens[j - 2]!.value === "exports" ||
        (holder?.type === "ident" && (holder.value === "exports" || holder.value === "module"))
      );
    }
    const inObject =
      (this.punct(j - 1, "{") || this.punct(j - 1, ",") || this.punct(j - 1, ":")) &&
      (this.punct(j + 1, ",") || this.punct(j + 1, "}") || this.is(j + 1, "ident", "as"));
    if (!inObject) return false;
    const open = this.container(j);
    if (open === -1 || !this.punct(open, "{")) return false;
    if (this.is(open - 1, "ident", "export")) return true;
    return (
      this.punct(open - 1, "=") &&
      this.is(open - 2, "ident", "exports") &&
      (this.punct(open - 3, ".") || !this.punct(open - 3, "."))
    );
  }

  /** `ipcMain` / `ipcRenderer` when the argument from `arg` is one, as far as it is read. */
  private objectTarget(arg: number): string | null {
    const values = this.receiverValues(arg, this.r.endOf(arg));
    const targets = new Set(values.map((v) => (v.kind === "ipc" ? v.target : null)));
    return values.length && targets.size === 1 && !targets.has(null) ? [...targets][0]! : null;
  }

  /**
   * The call sites of the methods and functions with IPC object parameters this reader knows,
   * and what each passes. Methods: calls on a proven instance of the class (as `rows` reads
   * them; a method another module replaces gives none). Plain functions of this file: their call
   * sites here, and what other modules pass (seeded). With `onlySeeded`: only calls on a
   * parameter another module passes an instance for, and only the seeded calls of functions.
   */
  objectSites(onlySeeded = false): ObjectSite[] {
    return this.onObjectBudget(() => this.objectSitesIn(onlySeeded));
  }

  private objectSitesIn(onlySeeded: boolean): ObjectSite[] {
    const out: ObjectSite[] = [];
    const { r } = this;
    this.readingObjects = true;
    this.chains.clear();
    try {
      const names = new Set<string>();
      for (const cls of this.classes)
        for (const [m, forwards] of Object.entries(cls.methods))
          if (forwards.some((f) => f.object)) names.add(m);
      for (const method of names) {
        for (const j of r.namePositions(method)) {
          if (this.work-- <= 0) return out;
          if (!(this.punct(j - 1, ".") || this.punct(j - 1, "?."))) continue;
          // `inst.register.call(t, ipcMain)` reads its argument after `this`; any other use
          // of the method that is not a call (`.apply`, `.bind`, a callback) passes what it
          // passes unread, which counts as something else
          const direct = this.punct(j + 1, "(");
          const viaCall =
            !direct &&
            this.punct(j + 1, ".") &&
            this.is(j + 2, "ident", "call") &&
            this.punct(j + 3, "(");
          if (!direct && this.punct(j + 1, "=") && !this.punct(j + 2, "=")) continue;
          let start = r.receiverAt(j - 1);
          if (start === null) continue;
          if (this.is(start - 1, "ident", "new")) start--;
          if (onlySeeded) {
            const b =
              start === j - 2 && this.is(start, "ident")
                ? r.binding(start, this.tokens[start]!.value)
                : null;
            if (b?.kind !== "param" || !this.seeds.get(b.def)?.has(b.index)) continue;
          }
          for (const v of this.receiverValues(start, j - 1)) {
            if (v.kind !== "inst" || !Object.hasOwn(v.cls.methods, method)) continue;
            if (this.isReplaced(v.cls, method)) continue;
            const indexes = new Set(
              v.cls.methods[method]!.filter((f) => f.object).map((f) => f.index),
            );
            for (const index of indexes) {
              const arg = direct
                ? r.argumentAt(j + 1, index)
                : viaCall
                  ? r.argumentAt(j + 3, index + 1)
                  : null;
              const target = arg === null || this.punct(arg, ")") ? null : this.objectTarget(arg);
              out.push({
                home: v.cls.file,
                key: `${v.cls.id}.${method}`,
                index,
                site: `${this.file}:${j}`,
                target,
              });
            }
          }
        }
      }
      if (!onlySeeded)
        for (const [def, by] of this.objectFns)
          for (const index of by.keys()) {
            const key = `fn@${def.paramsAt}`;
            for (const open of this.callSitesOf(def)) {
              const arg = r.argumentAt(open, index);
              const target = arg === null || this.punct(arg, ")") ? null : this.objectTarget(arg);
              out.push({ home: this.file, key, index, site: `${this.file}:${open}`, target });
            }
            for (const ref of this.otherUses(def)) {
              // `reg.call(t, ipcMain)`: its argument after `this`; anything else unread
              const arg = ref.call === null ? null : r.argumentAt(ref.call, index + 1);
              const target = arg === null || this.punct(arg, ")") ? null : this.objectTarget(arg);
              out.push({ home: this.file, key, index, site: `${this.file}:${ref.at}`, target });
            }
          }
      // what calls of other modules pass (the stage decides for the functions that have such a
      // parameter; for any other function the seed matches nothing)
      for (const [def, by] of this.objectSeeds)
        for (const [index, seeds] of by)
          for (const seed of seeds)
            out.push({
              home: this.file,
              key: `fn@${def.paramsAt}`,
              index,
              site: seed.site,
              target: seed.target,
            });
    } finally {
      this.readingObjects = false;
      this.chains.clear();
    }
    return out;
  }

  // ---------- results ----------

  /** The methods with a forward that gives rows at its calls (a channel, not an IPC object). */
  private methodNames(): Set<string> {
    const names = new Set<string>();
    for (const cls of this.classes)
      for (const [m, forwards] of Object.entries(cls.methods))
        if (forwards.some((f) => !f.object)) names.add(m);
    return names;
  }

  /**
   * One row per call of a wrapper method on an instance of its wrapper, per IPC call the method
   * makes. With `onlySeeded`, only calls on a parameter another module passes an instance for.
   */
  rows(onlySeeded = false): WrapperRow[] {
    const out: WrapperRow[] = [];
    const { r } = this;
    for (const method of this.methodNames()) {
      for (const j of r.namePositions(method)) {
        if (this.work-- <= 0) break;
        if (this.work <= 0) return out;
        if (!(this.punct(j - 1, ".") || this.punct(j - 1, "?.")) || !this.punct(j + 1, "("))
          continue;
        let start = r.receiverAt(j - 1);
        if (start === null) continue;
        if (this.is(start - 1, "ident", "new")) start--;
        if (onlySeeded) {
          const b =
            start === j - 2 && this.is(start, "ident")
              ? r.binding(start, this.tokens[start]!.value)
              : null;
          if (b?.kind !== "param" || !this.seeds.get(b.def)?.has(b.index)) continue;
        }
        for (const v of this.receiverValues(start, j - 1)) {
          if (v.kind !== "inst" || !Object.hasOwn(v.cls.methods, method)) continue;
          if (this.isReplaced(v.cls, method)) continue;
          for (const { api, index, key, object } of v.cls.methods[method]!) {
            if (key || object) continue;
            const arg = r.argumentAt(j + 1, index);
            if (arg === null || this.punct(arg, ")")) continue;
            const named = channelArg(this.tokens, this.constants, arg);
            const usage: IpcUsage = {
              api,
              channel: named && "value" in named ? named.value : null,
              line: this.tokens[j]!.line,
              via: "wrapper",
              wrapper: `${v.label}.${method}`,
            };
            if (named && "ref" in named) usage.channelRef = named.ref;
            out.push({ usage, arg, unread: !named, at: j });
          }
        }
      }
    }
    return out;
  }

  /**
   * One entry per call of a key-forwarding wrapper method on a proven instance of its class, per
   * storage call the method makes: the same receivers as `rows`. A method name that is assigned
   * as a member in this file (`local.get = f`) gives none. With `onlySeeded`, only calls on a
   * parameter another module passes an instance for. With `skipThis`, no call on `this` (or a
   * chain from it): the resolver's in-file rules decide those (static against instance).
   */
  keyCalls(onlySeeded = false, skipThis = false, max = MAX_KEY_CALLS_PER_FILE): KeyCall[] {
    this.keyCallsOnly = true;
    this.chains.clear();
    try {
      const out = this.keyCallsIn(onlySeeded, skipThis, max);
      if (out.length > max || this.work <= 0) this.keyCallsCut = true;
      return out.slice(0, max);
    } finally {
      this.keyCallsOnly = false;
      this.chains.clear();
    }
  }

  /** Set while `keyCalls` reads: a bundle's module object is followed to its `module.exports`. */
  private keyCallsOnly = false;

  /** A `keyCalls` stopped at its limit or at the work budget: calls may be missing. */
  keyCallsCut = false;

  private keyCallsIn(onlySeeded: boolean, skipThis: boolean, max: number): KeyCall[] {
    const out: KeyCall[] = [];
    const { r } = this;
    const names = new Set<string>();
    for (const cls of this.classes)
      for (const [m, forwards] of Object.entries(cls.methods))
        if (forwards.some((f) => f.key)) names.add(m);
    for (const method of names) {
      if (this.r.memberAssigned(method)) continue;
      for (const j of r.namePositions(method)) {
        if (this.work-- <= 0) return out;
        if (!(this.punct(j - 1, ".") || this.punct(j - 1, "?.")) || !this.punct(j + 1, "("))
          continue;
        let start = r.receiverAt(j - 1);
        // `new (require("./store").Store)(…).m(…)`
        if (start === null && this.punct(j - 2, ")")) {
          const call = r.openOf(j - 2);
          const group = this.punct(call - 1, ")") ? r.openOf(call - 1) : -1;
          if (group > 0 && this.is(group - 1, "ident", "new")) start = group - 1;
        }
        if (start === null) continue;
        if (this.is(start - 1, "ident", "new")) start--;
        if (skipThis && this.is(start, "ident", "this")) continue;
        if (onlySeeded) {
          const b =
            start === j - 2 && this.is(start, "ident")
              ? r.binding(start, this.tokens[start]!.value)
              : null;
          if (b?.kind !== "param" || !this.seeds.get(b.def)?.has(b.index)) continue;
        }
        for (const v of this.receiverValues(start, j - 1)) {
          if (v.kind !== "inst" || !Object.hasOwn(v.cls.methods, method)) continue;
          if (this.isReplaced(v.cls, method)) continue;
          for (const forward of v.cls.methods[method]!) {
            if (!forward.key) continue;
            const arg = r.argumentAt(j + 1, forward.index);
            if (arg === null || this.punct(arg, ")")) continue;
            if (out.length > max) return out;
            out.push({
              at: j,
              arg,
              forward: forward as KeyCall["forward"],
              cls: v.cls,
              via: `${v.label}.${method}`,
            });
          }
        }
      }
    }
    return out;
  }

  /**
   * Calls of another module's function that pass an instance of a wrapper (cross-file stage):
   * `registerHandlers(router, windows)` with `router = new IpcRouter(…)`.
   */
  passes(): Array<{
    file: string;
    key: string;
    index: number;
    values: WrapperValue[];
    /** The token of the called name. */
    at: number;
    /** ipcMain or ipcRenderer, when the argument is one. */
    ipc: string | null;
  }> {
    const out: Array<{
      file: string;
      key: string;
      index: number;
      values: WrapperValue[];
      at: number;
      ipc: string | null;
    }> = [];
    const { r, tokens } = this;
    this.passesCapped = false;
    for (let j = 0; j + 1 < tokens.length && this.work > 0; j++) {
      if (out.length >= 256) {
        this.passesCapped = true;
        break;
      }
      if (tokens[j]!.type !== "ident" || !this.punct(j + 1, "(")) continue;
      if (this.is(j - 1, "ident", "function")) continue;
      let callee: WrapperValue | null = null;
      if (!this.punct(j - 1, ".")) callee = this.nameValue(j, 1);
      else {
        const start = r.receiverAt(j - 1);
        if (start !== null) callee = this.valueOf(start, j + 1, 1);
      }
      if (callee?.kind !== "xfn") continue;
      for (let index = 0; index < 6; index++) {
        const arg = r.argumentAt(j + 1, index);
        if (arg === null || this.punct(arg, ")")) break;
        // also what is no instance, so that a parameter some call passes something else for
        // is none (`use(new Store()); use(new Map())`)
        const values = this.receiverValues(arg, r.endOf(arg));
        // and whether it is ipcMain or ipcRenderer, for an IPC object parameter there
        let ipc: string | null = null;
        if (this.ipcAt)
          ipc = this.onObjectBudget(() => {
            this.readingObjects = true;
            try {
              return this.objectTarget(arg);
            } finally {
              this.readingObjects = false;
              this.chains.clear();
            }
          });
        out.push({ file: callee.file, key: callee.key, index, values, at: j, ipc });
      }
    }
    if (this.work <= 0) this.passesCapped = true;
    return out;
  }

  /** The last `passes()` did not read every call: what it found is not all that is passed. */
  passesCapped = false;

  /** The export keys of this file that name one of its wrappers or an instance of one. */
  facts(): WrapperFacts | null {
    // only what another module can use: channel-forwarding wrappers, and functions with an IPC
    // object parameter that look like IPC (see `ObjectCall.ipcLike`)
    const offered = this.classes.filter((c) =>
      Object.values(c.methods).some((forwards) =>
        forwards.some((f) => !f.object || f.object.ipcLike),
      ),
    );
    const offeredFns = [...this.objectFns].some(([, by]) =>
      [...by.values()].some((calls) => calls.some((c) => c.ipcLike)),
    );
    if (!offered.length && !offeredFns) return null;
    const { r, tokens } = this;
    const keys = new Set<string>();
    const names = new Set<string>();
    for (const cls of offered) {
      const start = this.startOf(cls);
      // the name the class or object is bound to
      for (let j = start - 1; j >= 0 && j > start - 21; j--)
        if (this.is(j, "ident", "class")) {
          if (this.is(j + 1, "ident") && !this.is(j + 1, "ident", "extends"))
            names.add(tokens[j + 1]!.value);
          else if (this.punct(j - 1, "=") && this.is(j - 2, "ident"))
            names.add(tokens[j - 2]!.value);
          break;
        }
      if (this.punct(start - 1, "=") && this.is(start - 2, "ident"))
        names.add(tokens[start - 2]!.value);
    }
    // names holding an instance: `x = new C(…)`; and the keys the names are stored under
    const instances = new Set<string>();
    for (const name of names)
      for (const j of r.namePositions(name)) {
        if (this.work-- <= 0) break;
        if (!this.is(j - 1, "ident", "new")) continue;
        const at = j - 1;
        if (this.punct(at - 1, "=") && this.is(at - 2, "ident")) {
          if (this.punct(at - 3, "."))
            keys.add(tokens[at - 2]!.value === "exports" ? "" : tokens[at - 2]!.value);
          else instances.add(tokens[at - 2]!.value);
        } else if (this.punct(at - 1, ":") && this.is(at - 2, "ident"))
          keys.add(tokens[at - 2]!.value);
        else if (this.is(at - 1, "ident", "default") && this.is(at - 2, "ident", "export"))
          keys.add("default");
      }
    for (const name of [...names, ...instances]) {
      keys.add(name);
      for (const j of r.namePositions(name)) {
        if (this.work-- <= 0) break;
        if (this.punct(j - 1, ":") && this.is(j - 2, "ident")) keys.add(tokens[j - 2]!.value);
        else if (this.punct(j - 1, "=") && this.is(j - 2, "ident") && this.punct(j - 3, "."))
          keys.add(tokens[j - 2]!.value === "exports" ? "" : tokens[j - 2]!.value);
        else if (this.is(j - 1, "ident", "default") && this.is(j - 2, "ident", "export"))
          keys.add("default");
        else if (this.is(j + 1, "ident", "as") && this.is(j + 2, "ident"))
          keys.add(tokens[j + 2]!.value);
      }
    }
    const exports: WrapperFacts["exports"] = {};
    for (const key of [...keys].toSorted()) {
      if (key === "__proto__") continue;
      const v = this.keyValue(key);
      if ((v?.kind === "cls" || v?.kind === "inst") && v.cls.file === this.file)
        exports[key] = { kind: v.kind, id: v.cls.id };
    }
    // plain functions with an IPC object parameter, by the keys they are exported under
    const fns: string[] = [];
    for (const [def, by] of this.objectFns) {
      if (![...by.values()].some((calls) => calls.some((c) => c.ipcLike))) continue;
      for (const key of this.exportKeysOf(def)) if (!fns.includes(key)) fns.push(key);
    }
    if (!Object.keys(exports).length && !fns.length) return null;
    return {
      classes: this.classes
        .filter((c) => c.file === this.file)
        .map(({ id, name, methods, chain }) => ({ id, name, methods, chain })),
      exports,
      ...(fns.length ? { fns: fns.toSorted() } : {}),
    };
  }

  /** The export keys of this file that name def (`exportedFunction` of each is def). */
  private exportKeysOf(def: FnDef): string[] {
    return this.onObjectBudget(() => this.exportKeysIn(def));
  }

  private exportKeysIn(def: FnDef): string[] {
    if (def.name === null) return [];
    const { r } = this;
    // a function declared inside another one is named only in that function's body
    const outer = r.outerOf(def);
    const [from, to] = outer ? outer.body : [0, this.tokens.length];
    const keys = new Set<string>();
    // `export function NAME`, `export default function NAME`
    if (this.is(def.paramsAt - 2, "ident", "function")) {
      if (this.is(def.paramsAt - 3, "ident", "export")) keys.add(def.name);
      if (this.is(def.paramsAt - 3, "ident", "default")) keys.add("default");
    }
    for (const j of r.namePositions(def.name, from, to)) {
      if (this.work-- <= 0) break;
      // `{ K: NAME }`, `x.K = NAME` (`module.exports = NAME`: ""), `{ NAME }`, `NAME as K`
      if (this.punct(j - 1, ":") && this.is(j - 2, "ident")) keys.add(this.tokens[j - 2]!.value);
      else if (this.punct(j - 1, "=") && this.is(j - 2, "ident") && this.punct(j - 3, "."))
        keys.add(this.tokens[j - 2]!.value === "exports" ? "" : this.tokens[j - 2]!.value);
      else if (this.is(j + 1, "ident", "as") && this.is(j + 2, "ident"))
        keys.add(this.tokens[j + 2]!.value);
      else if (
        (this.punct(j - 1, "{") || this.punct(j - 1, ",")) &&
        (this.punct(j + 1, ",") || this.punct(j + 1, "}"))
      )
        keys.add(def.name);
    }
    return [...keys].filter((key) => key !== "__proto__" && this.exportedFunction(key) === def);
  }

  /** The function an export key of this file names (cross-file stage). */
  exportedFunction(key: string): FnDef | null {
    const v = this.keyValue(key);
    if (v?.kind === "fn") return v.def;
    // `export function K` / `function K` exported by `module.exports = { K }` reads as the
    // function through keyValue; a top-level function of that name otherwise
    const b = key ? this.r.binding(this.tokens.length - 1, key) : null;
    return b?.kind === "function" ? b.def : null;
  }
}

/**
 * The facts of a module for one of the two cross-file stages: the channel-forwarding wrappers
 * only (`objects: false`, the stage of 0.9.8), or only what has a parameter used as the IPC object
 * (`objects: true`). The two stages run apart, each with its own budgets.
 */
export function factsFor(
  facts: WrapperFacts | undefined,
  objects: boolean,
): WrapperFacts | undefined {
  if (!facts) return undefined;
  const classes: WrapperFacts["classes"] = [];
  for (const cls of facts.classes) {
    const methods: Record<string, Forward[]> = {};
    for (const [m, forwards] of Object.entries(cls.methods)) {
      const kept = forwards.filter((f) => (objects ? !!f.object?.ipcLike : !f.object));
      if (kept.length) methods[m] = kept;
    }
    if (Object.keys(methods).length) classes.push({ ...cls, methods });
  }
  const ids = new Set(classes.map((c) => c.id));
  const exports: WrapperFacts["exports"] = {};
  for (const [key, e] of Object.entries(facts.exports)) if (ids.has(e.id)) exports[key] = e;
  const fns = objects ? (facts.fns ?? []) : [];
  if (!Object.keys(exports).length && !fns.length) return undefined;
  return { classes, exports, ...(fns.length ? { fns } : {}) };
}

/** A module as the cross-file stage reads it. */ /** A module as the cross-file stage reads it. */
export interface WrapperModule {
  id: string;
  /** The names the module exports itself (scan.ts), not through `export *`. */
  exports?: readonly string[];
  wrappers?: WrapperFacts;
  reexports?: Record<string, { specifier: string; property: string }>;
  starExports?: string[];
  /** Every `module.exports = require("…")`, also uncertain ones: read for replacements only. */
  looseStarExports?: string[];
}

/** A module read again for the cross-file stage. */
export interface ReadModule {
  /** The text the tokens were read from (for columns). */
  source?: string;
  tokens: Token[];
  constants: Constants;
  resolver: ExpressionResolver;
  /** `ipcMain` / `ipcRenderer` when the identifier at k is (another name for) one. */
  ipcAt?: (k: number) => string | null;
}

/**
 * Calls of wrappers across modules: in the modules that import a module defining a wrapper (or
 * one that passes its exports on), calls on instances that module exports or on instances made
 * from its classes; and calls on a parameter of another module's function that such a module
 * passes an instance for. Returns rows per module id; nothing is read when no module exports a
 * wrapper.
 */
export function linkWrappers(input: {
  modules: readonly WrapperModule[];
  edges: ReadonlyArray<{ from: string; to: string; resolved: boolean }>;
  resolve(from: string, specifier: string): string | null;
  open(path: string): ReadModule | null;
  maxFiles?: number;
}): {
  rows: Map<string, WrapperRow[]>;
  /** Calls of functions and methods with an IPC object parameter, and what each passes. */
  sites: Map<string, ObjectSite[]>;
  /** Which of those calls may be missing (see `ObjectsCut`). */
  objectsCut: ObjectsCut;
  capped: string[];
  replaced: Replaced[];
  unchecked: string[];
} {
  type Found = { row: WrapperRow; site?: never } | { site: ObjectSite; row?: never };
  const linked = linkWrapperCalls<Found>({
    ...input,
    // past the replacement budget, IPC calls are read without the check (as before it existed)
    keepPastBudget: true,
    read: (reader, onlySeeded) => [
      ...reader.rows(onlySeeded).map((row) => ({ row })),
      ...reader.objectSites(onlySeeded).map((site) => ({ site })),
    ],
    same: (x, y) =>
      x.row && y.row
        ? x.row.at === y.row.at && x.row.usage.api === y.row.usage.api
        : !!x.site &&
          !!y.site &&
          x.site.site === y.site.site &&
          x.site.key === y.site.key &&
          x.site.index === y.site.index &&
          x.site.home === y.site.home,
    keyOf: (x) =>
      x.row
        ? `r\u0000${x.row.at}\u0000${x.row.usage.api}`
        : `s\u0000${x.site.site}\u0000${x.site.key}\u0000${x.site.index}\u0000${x.site.home}`,
  });
  const rows = new Map<string, WrapperRow[]>();
  const sites = new Map<string, ObjectSite[]>();
  for (const [file, found] of linked.rows) {
    const r = found.flatMap((f) => (f.row ? [f.row] : []));
    const s = found.flatMap((f) => (f.site ? [f.site] : []));
    if (r.length) rows.set(file, r);
    if (s.length) sites.set(file, s);
  }
  return { ...linked, rows, sites };
}

/**
 * Calls of key-forwarding wrappers (storage keys) across modules: the same stage as
 * `linkWrappers`, over the modules' `keyWrappers` facts.
 */
export function linkKeyWrappers(input: {
  modules: readonly WrapperModule[];
  edges: ReadonlyArray<{ from: string; to: string; resolved: boolean }>;
  resolve(from: string, specifier: string): string | null;
  open(path: string): ReadModule | null;
  maxFiles?: number;
}): {
  rows: Map<string, KeyCall[]>;
  capped: string[];
  replaced: Replaced[];
  unchecked: string[];
} {
  return linkWrapperCalls({
    ...input,
    read: (reader, onlySeeded) => reader.keyCalls(onlySeeded),
    same: (x, row) => x.at === row.at && x.forward === row.forward,
  });
}

function linkWrapperCalls<R>(input: {
  modules: readonly WrapperModule[];
  edges: ReadonlyArray<{ from: string; to: string; resolved: boolean }>;
  resolve(from: string, specifier: string): string | null;
  open(path: string): ReadModule | null;
  maxFiles?: number;
  read(reader: WrapperReader, onlySeeded: boolean): R[];
  same(a: R, b: R): boolean;
  /** A key that is equal exactly when `same` holds: rows are then told apart in constant time. */
  keyOf?(row: R): string;
  /**
   * Past the replacement budget, keep the calls (and name the modules not checked) instead of
   * counting every method as replaced.
   */
  keepPastBudget?: boolean;
}): {
  rows: Map<string, R[]>;
  capped: string[];
  replaced: Replaced[];
  unchecked: string[];
  objectsCut: ObjectsCut;
} {
  const out = new Map<string, R[]>();
  const objectsCut: ObjectsCut = { methods: false, fns: false };
  const capped: string[] = [];
  const byId = new Map(input.modules.map((m) => [m.id, m]));
  const providers = new Set(
    input.modules
      .filter(
        (m) => m.wrappers && (Object.keys(m.wrappers.exports).length || m.wrappers.fns?.length),
      )
      .map((m) => m.id),
  );
  const replaced = new Set<string>();
  const replacedAt: Replaced[] = [];
  const unchecked: string[] = [];
  if (!providers.size) return { rows: out, capped, replaced: replacedAt, unchecked, objectsCut };
  // classes of other modules, one object per class so that identity holds across readers
  const known = new Map<string, WrapperClass>();
  const classOf = (file: string, id: string): WrapperClass | null => {
    const key = `${file}\0${id}`;
    const have = known.get(key);
    if (have) return have;
    const c = byId.get(file)?.wrappers?.classes.find((x) => x.id === id);
    if (!c) return null;
    const made: WrapperClass = { ...c, file };
    known.set(key, made);
    return made;
  };
  /** The star exports of m; with `loose`, also the uncertain whole re-exports. */
  const starsOf = (m: WrapperModule, loose: boolean): string[] =>
    loose && m.looseStarExports?.length
      ? [...new Set([...(m.starExports ?? []), ...m.looseStarExports])]
      : (m.starExports ?? []);
  const lookup =
    (from: string, loose = false) =>
    (specifier: string, key: string, depth = 0): WrapperValue | null => {
      if (depth > 4) return null;
      const target = input.resolve(from, specifier);
      const m = target ? byId.get(target) : undefined;
      if (!m) return null;
      const e =
        m.wrappers?.exports[key] ?? (key === "default" ? m.wrappers?.exports[""] : undefined);
      if (e) {
        const cls = classOf(m.id, e.id);
        if (cls) return labelled({ kind: e.kind, cls, label: cls.name }, key);
      }
      const passed = m.reexports?.[key];
      if (passed) {
        const v = lookup(m.id, loose)(passed.specifier, passed.property, depth + 1);
        if (v) return v;
      }
      const stars = starsOf(m, loose);
      // for replacements: any source that gives a wrapper (reading too much only blocks more)
      if (loose && key)
        for (const star of stars) {
          const v = lookup(m.id, true)(star, key, depth + 1);
          if (v && v.kind !== "xfn") return v;
        }
      // the module's own export of the name wins over `export *`; a name that two `export *`
      // sources give is ambiguous (ECMAScript leaves it out), and none counts
      if (key && m.exports?.includes(key)) return { kind: "xfn", file: m.id, key };
      if (key && key !== "default" && stars.length) {
        let found: WrapperValue | null = null;
        let sources = 0;
        for (const star of stars) {
          const starTarget = input.resolve(m.id, star);
          const t = starTarget ? byId.get(starTarget) : undefined;
          // a star source that cannot be read may export the name as well
          if (!t) return null;
          const v = lookup(m.id, loose)(star, key, depth + 1);
          if (!v) continue;
          if (v.kind === "xfn" && !exportsName(t, key, depth + 1)) continue;
          sources++;
          found = v;
        }
        if (sources > 1) return null;
        if (found) return found;
      }
      return key ? { kind: "xfn", file: m.id, key } : null;
    };
  /** Whether module m exports the name, itself or passed on (a few modules deep). */
  const exportsName = (m: WrapperModule, key: string, depth: number): boolean => {
    if (depth > 4) return true;
    if (m.exports?.includes(key) || m.reexports?.[key] || m.wrappers?.exports[key]) return true;
    for (const star of m.starExports ?? []) {
      const target = input.resolve(m.id, star);
      const t = target ? byId.get(target) : undefined;
      if (!t || exportsName(t, key, depth + 1)) return true;
    }
    return false;
  };
  // modules that pass a provider's exports on are providers as well; for replacements also
  // through an uncertain whole re-export
  const looseProviders = new Set(providers);
  for (let round = 0; round < 3; round++)
    for (const e of input.edges) {
      const m = byId.get(e.from);
      if (!e.resolved) continue;
      if (providers.has(e.to) && (m?.reexports || m?.starExports?.length)) providers.add(e.from);
      if (
        looseProviders.has(e.to) &&
        (m?.reexports || m?.starExports?.length || m?.looseStarExports?.length)
      )
        looseProviders.add(e.from);
    }
  // by path: sizes change from build to build, paths rarely do
  const allImporters = [
    ...new Set(input.edges.filter((e) => e.resolved && providers.has(e.to)).map((e) => e.from)),
  ].toSorted();
  const importers = allImporters.slice(0, input.maxFiles ?? 200);
  capped.push(...allImporters.slice(importers.length));
  // importers not read at all: what they pass is not known for either kind
  if (importers.length < allImporters.length) objectsCut.methods = objectsCut.fns = true;
  const readers = new Map<string, WrapperReader | null>();
  const readerOf = (file: string): WrapperReader | null => {
    if (readers.has(file)) return readers.get(file)!;
    const read = input.open(file);
    const reader = read
      ? new WrapperReader(
          read.tokens,
          read.resolver,
          read.constants,
          lookup(file),
          file,
          read.ipcAt ?? null,
        )
      : null;
    if (reader) reader.replaced = replaced;
    readers.set(file, reader);
    return reader;
  };
  const keys = new Map<string, Set<string>>();
  const add = (file: string, rows: R[]): void => {
    if (!rows.length) return;
    const list = out.get(file) ?? [];
    const keyOf = input.keyOf;
    if (keyOf) {
      const seen = keys.get(file) ?? new Set<string>();
      for (const row of rows) {
        const key = keyOf(row);
        if (seen.has(key)) continue;
        seen.add(key);
        list.push(row);
      }
      keys.set(file, seen);
    } else for (const row of rows) if (!list.some((x) => input.same(x, row))) list.push(row);
    out.set(file, list);
  };
  // every class a provider exports is a class the importers can reach
  const everyClass: WrapperClass[] = [];
  for (const id of providers)
    for (const c of byId.get(id)?.wrappers?.classes ?? []) {
      const cls = classOf(id, c.id);
      if (cls) everyClass.push(cls);
    }
  const passes: Array<{
    file: string;
    key: string;
    index: number;
    values: WrapperValue[];
    at: number;
    ipc: string | null;
    from: string;
  }> = [];
  // Methods replaced from another module (`Store.prototype.get = f`, `s.get = f` on an instance
  // there): read in every module that imports a provider, and in the providers, before any call
  // is read. A write to another object of the same method name is none.
  // (no module calls a provider's wrappers: nothing to read)
  if (!importers.length) return { rows: out, capped, replaced: replacedAt, unchecked, objectsCut };
  const looseImporters = input.edges
    .filter((e) => e.resolved && looseProviders.has(e.to))
    .map((e) => e.from);
  // One budget for the whole application (tokens of the files opened, plus the work of reading
  // receivers): a file past it is not read, and every method of the wrappers it imports counts
  // as replaced (flagged), as a write there may replace any of them.
  let left = REPLACEMENT_APP_WORK;
  /** The wrapper modules file reaches through its imports (and re-exports), a few deep. */
  const reached = (file: string): Set<string> => {
    const seen = new Set<string>();
    const walk = (from: string, depth: number): void => {
      if (depth > 6) return;
      for (const e of input.edges) {
        if (e.from !== from || !e.resolved || !looseProviders.has(e.to) || seen.has(e.to)) continue;
        seen.add(e.to);
        walk(e.to, depth + 1);
      }
    };
    walk(file, 0);
    return seen;
  };
  // the modules that define wrappers, then the rest, each by path: an order that a file
  // growing between two builds does not change
  const defining = [...looseProviders].filter((f) => byId.get(f)?.wrappers).toSorted();
  const order = [
    ...defining,
    ...[...new Set([...looseProviders, ...looseImporters])]
      .filter((f) => !defining.includes(f))
      .toSorted(),
  ];
  for (const file of order) {
    if (left <= 0 && input.keepPastBudget) {
      unchecked.push(file);
      continue;
    }
    if (left <= 0) {
      const ids = reached(file);
      if (looseProviders.has(file)) ids.add(file);
      for (const cls of everyClass) {
        if (!ids.has(cls.file)) continue;
        for (const method of Object.keys(cls.methods)) {
          const key = methodKey(cls, method);
          if (replaced.has(key)) continue;
          replaced.add(key);
          replacedAt.push({ via: `${cls.name}.${method}`, file, line: 0, budget: true });
        }
      }
      continue;
    }
    const read = input.open(file);
    if (!read) continue;
    left -= read.tokens.length;
    // a reader of its own: its lookup follows the uncertain whole re-exports too
    const reader = new WrapperReader(
      read.tokens,
      read.resolver,
      read.constants,
      lookup(file, true),
      file,
    );
    for (const cls of everyClass) reader.adopt(cls);
    const found = reader.replacements(Math.max(1, Math.min(REPLACEMENT_WORK, left)));
    left -= reader.replacementWork;
    for (const { cls, method, at, budget } of found) {
      if (budget && input.keepPastBudget) {
        if (!unchecked.includes(file)) unchecked.push(file);
        continue;
      }
      const key = methodKey(cls, method);
      if (replaced.has(key)) continue;
      replaced.add(key);
      replacedAt.push({
        via: `${cls.name}.${method}`,
        file,
        line: reader.lineOf(at),
        ...(budget ? { budget: true as const } : {}),
      });
    }
  }
  /** Every method of every wrapper the file reaches is replaced: no call there gives a row. */
  const allReplaced = (file: string): boolean => {
    const ids = reached(file);
    return everyClass.every(
      (cls) =>
        !ids.has(cls.file) ||
        Object.keys(cls.methods).every((m) => replaced.has(methodKey(cls, m))),
    );
  };
  let passesCut = false;
  for (const file of importers) {
    if (replaced.size && allReplaced(file)) continue;
    const reader = readerOf(file);
    if (!reader) continue;
    for (const cls of everyClass) reader.adopt(cls);
    add(file, input.read(reader, false));
    passes.push(...reader.passes().map((p) => ({ ...p, from: file })));
    if (reader.passesCapped) {
      passesCut = true;
      if (!capped.includes(file)) capped.push(file);
    }
  }
  // a call not read may pass something else: then no parameter is taken for an instance
  if (passesCut) passes.length = 0;
  if (passesCut) objectsCut.fns = true;
  const objectSeeded = new Set<string>();
  for (const pass of passes) {
    const reader = readerOf(pass.file);
    if (!reader) continue;
    const def = reader.exportedFunction(pass.key);
    if (!def) continue;
    for (const cls of everyClass) reader.adopt(cls);
    reader.seed(def, pass.index, pass.values);
    // a function of that module with an IPC object parameter: what this call passes for it
    if (byId.get(pass.file)?.wrappers?.fns?.includes(pass.key)) {
      reader.seedObject(def, pass.index, `${pass.from}:${pass.at}`, pass.ipc);
      objectSeeded.add(pass.file);
    }
  }
  for (const file of new Set([
    ...passes.filter((p) => p.values.length).map((p) => p.file),
    ...objectSeeded,
  ])) {
    const reader = readers.get(file);
    if (reader) add(file, input.read(reader, true));
  }
  for (const [file, reader] of readers) {
    if ((reader?.capped || reader?.keyCallsCut || reader?.objectsCapped) && !capped.includes(file))
      capped.push(file);
    if (reader?.objectsCapped) objectsCut.methods = objectsCut.fns = true;
  }
  return { rows: out, capped, replaced: replacedAt, unchecked, objectsCut };
}

/**
 * The storage rows of calls of key-forwarding wrappers in one module (`caller`): per call, the
 * argument read there (a literal, a constant, with `lookUp` another module's constant, or what
 * the resolver reads through call sites, whole), then the key expression of the wrapper's
 * storage call evaluated in the defining module (`open(cls.file)`, "" for the caller itself)
 * with that value for its parameter. Anything not read whole is an unknown row at the call
 * (`unread: true`), with the argument's name as `expression` when it is one.
 */
export function keyCallRows(
  caller: ReadModule,
  calls: readonly KeyCall[],
  open: (file: string) => ReadModule | null,
  lookUp: ((ref: { specifier: string; property: string }) => string | null) | null,
  options: {
    /**
     * Kinds whose unknown rows the caller drops (it has one already): a call of such a kind whose
     * argument is no literal or constant is passed over instead of read through the resolver.
     * Kinds of the unknown rows made here are added.
     */
    unknownKinds?: Set<string>;
    /** Keys already evaluated, by wrapper module, key token and value (shared across calls). */
    keys?: Map<string, string[] | null>;
  } = {},
): Array<Candidate & { unread?: true }> {
  const { tokens, constants, resolver } = caller;
  const cache = options.keys ?? new Map<string, string[] | null>();
  const out: Array<Candidate & { unread?: true }> = [];
  const seen = new Map<string, Candidate>();
  const source = caller.source;
  const columnOf = (start: number): number =>
    source === undefined ? 1 : start - (source.lastIndexOf("\n", start - 1) + 1) + 1;
  for (const call of [...calls].toSorted((a, b) => a.at - b.at)) {
    // the argument at the call, whole
    let values: string[] | null = null;
    const named = channelArg(tokens, constants, call.arg);
    if (named && "value" in named) values = [named.value];
    else if (named && "ref" in named) {
      const found = !named.ref.before && !named.ref.after && lookUp ? lookUp(named.ref) : null;
      values = found === null ? null : [found];
    } else if (options.unknownKinds?.has(call.forward.api)) continue;
    // a long argument (a call nested in calls) is not followed: an unknown row
    else if (resolver.endOf(call.arg) - call.arg <= MAX_ARGUMENT_TOKENS) {
      const found = resolver.resolveArgument(call.arg);
      if (
        found &&
        !found.partial &&
        found.values.every((v) => v !== "" && !v.includes("${…}") && !v.includes("\u0001"))
      )
        values = found.values;
    }
    // the key the wrapper builds from it, in the defining module
    const provider = call.cls.file === "" ? caller : open(call.cls.file);
    const keys: string[] = [];
    let unread = !values?.length || !provider;
    if (!unread && provider) {
      const at = call.forward.key.at;
      const def = provider.resolver.functionAt(at);
      for (const v of values!) {
        const id = `${call.cls.file}\u0000${at}\u0000${call.forward.index}\u0000${v}`;
        let got = cache.get(id);
        if (got === undefined) {
          got = def ? provider.resolver.keyWith(at, def, call.forward.index, v) : null;
          cache.set(id, got);
        }
        if (!got) {
          unread = true;
          break;
        }
        for (const k of got) if (!keys.includes(k)) keys.push(k);
      }
    }
    const t = tokens[call.at]!;
    const kind = call.forward.api as Candidate["kind"];
    const op = call.forward.key.op;
    const reads: Array<Pick<Candidate, "value" | "evidence" | "expression">> = unread
      ? [
          {
            value: null,
            evidence: "unknown",
            expression:
              tokens[call.arg]?.type === "ident" && resolver.endOf(call.arg) === call.arg + 1
                ? tokens[call.arg]!.value
                : "<expression>",
          },
        ]
      : keys.map((value) => ({ value, evidence: "inferred" as const }));
    for (const r of reads) {
      const id = `${kind}\u0000${r.value ?? `?${r.expression}`}\u0000${op ?? ""}\u0000${call.via}`;
      const have = seen.get(id);
      if (have) {
        have.count++;
        continue;
      }
      const row: Candidate & { unread?: true } = {
        value: r.value,
        kind,
        evidence: r.evidence,
        line: t.line,
        column: columnOf(t.start),
        ...(op ? { op } : {}),
        ...(r.expression ? { expression: r.expression } : {}),
        via: call.via,
        count: 1,
        ...(unread ? { unread: true as const } : {}),
      };
      seen.set(id, row);
      out.push(row);
      if (unread) options.unknownKinds?.add(kind);
    }
  }
  return out;
}
