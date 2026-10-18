/**
 * A small, bounded resolver for the string an expression stands for, used where the fast scan
 * found an IPC call whose channel is not a literal or a constant: `PREFIX + "tick"`,
 * `` `${NS}:list` ``, `ns("projects")("list")`, a helper's parameter bound at its call sites,
 * the elements of an array or `Map` that a loop or `forEach` registers.
 *
 * It evaluates nothing at run time and follows only what is written: string literals, the file's
 * constants, `+` between strings, templates, calls of functions of the file whose body is one
 * expression, and parameters whose every binding can be read. When any part of an expression
 * cannot be read the result is null; a value is never guessed. Work is bounded (depth, values,
 * call sites), so no input makes it slow, and it runs only for calls the fast scan left open.
 *
 * Function bodies are read by a small abstract evaluation, never by running them. The subset it
 * reads, exactly (anything else stops the evaluation with a reason, see `reason`):
 *
 * - statements: `const|let|var` declarations (names and destructuring patterns), `return`,
 *   nested blocks, nested `function` declarations (read where they are called), `;`, and
 *   expression statements that are an assignment or `LIST.forEach(callback)`;
 * - assignments: `x = …` and `x += …` to a variable of the same block, `o.k = …` and
 *   `o[k] = …` only on an object or array literal the function itself created (never on a
 *   parameter, a global or anything another function returned);
 * - finite iteration: `for (const x of LIST)`, `for (const k in OBJECT)`, `LIST.forEach(cb)`,
 *   `LIST.map(cb)` and `Object.fromEntries(LIST)`, over lists and objects whose every element is
 *   read, at most MAX_ITERATIONS times;
 * - string operations: templates, `+`, `concat`, `toLowerCase`, `toUpperCase`, `slice` with
 *   number literals, `split` and `join` with a string argument, `replace` and `replaceAll`
 *   with a string or a simple regular expression literal (one level of characters, classes and
 *   escapes, each with at most one `?`, `*` or `+`; no groups, alternatives or backreferences)
 *   and a string without `$` or a callback that is itself in this subset.
 *
 * Values the code computes at run time (`Math.random()`, `process.env`, `await fetch(…)`) stay
 * unknown. Nothing of the analyzed code is executed: no eval, Function, vm, import or require of
 * it, and no subprocess. A simple regular expression literal is applied as data, to strings of
 * bounded length.
 */
import type { Constants } from "./aliases.js";
import type { Token } from "./scan.js";
import {
  ASSIGNMENT_OPERATORS,
  bindingAt,
  chainEnd,
  declaredAt,
  keyOrLabelAt,
  patternSourceAt,
  shadowedAt,
  writesMember,
  writesName,
} from "./writes.js";

/** How a value was obtained, from the most direct to the most indirect. */
export type ResolveMethod =
  | "concatenation"
  | "template"
  | "call"
  | "parameter"
  | "element"
  /** read by evaluating a function body (see the subset above) */
  | "evaluated";

export interface ResolvedValues {
  values: string[];
  method: ResolveMethod;
  /** Lines of the call sites or elements a parameter was bound at, when that is how. */
  lines: number[];
  /** Some bindings (call sites) could not be read: the values are not all there are. */
  partial: boolean;
  /** Partial because a function has more call sites than are read (MAX_SITES). */
  cut?: true;
}

/** The call sites of a wrapper function and what each passes (see `wrapperCalls`). */
export interface WrapperCalls {
  /** The function, or `Class.method`. */
  name: string;
  /** `at`: the token of the function or method name at the call; `values`: null when unread. */
  sites: Array<{ at: number; values: string[] | null }>;
  /** More call sites than are read (MAX_SITES): keys passed at the others are not listed. */
  capped?: true;
}

/** Where a literal value is written. */
export interface ValueSource {
  file: string;
  line: number;
}

/** What an expression is known to be; null anywhere means "not known". */
export type Val =
  /** `ref`: the value is a reference marker for another module's name, which members extend. */
  | {
      kind: "str";
      values: string[];
      src?: ValueSource;
      ref?: { specifier: string; property: string };
    }
  | { kind: "bool"; value: boolean; src: ValueSource }
  /** `undefined`: a parameter nobody passed, a key a closed object does not have. */
  | { kind: "undef" }
  /** A function of the module `res` reads; its tokens are that module's. */
  | { kind: "fn"; def: FnDef; env: Env; res: ExpressionResolver }
  /** `more`: the literal has more elements than are read, so it is not known whole. */
  | { kind: "arr"; elems: Array<Val | null>; line: number; more?: true }
  /**
   * An object literal, with spreads applied in order. `open`: a spread of something unknown came
   * after some keys, so keys not listed may still be there (and earlier ones were set to null).
   */
  | { kind: "obj"; props: Map<string, Val | null>; open?: boolean }
  | { kind: "map"; entries: Array<[Val | null, Val | null]>; line: number }
  /** Another module's exports (`require("./x")`, CommonJS `exports` of this one). */
  | { kind: "ns"; resolver: ExpressionResolver }
  /** `require("./x")` when the other module cannot be read here: members become references. */
  | { kind: "nsref"; specifier: string }
  /**
   * A module a bundler wrapped into this file (esbuild's `__commonJS`): its members are what its
   * body assigns to `exports.NAME`.
   */
  | {
      kind: "cjs";
      exports: string;
      module: string | null;
      body: [number, number];
      /** Passed through an interop helper (`__toESM`): its `default` is the module itself. */
      interop?: true;
    }
  /**
   * Only in an environment: a variable an evaluated body declared whose value is not known, so a
   * read of it is unknown instead of falling through to a binding of the same name outside.
   */
  | { kind: "unknown" };

/** Finds the resolver of another module of the application, for imports. */
export interface ModuleHost {
  load(from: string, specifier: string): ExpressionResolver | null;
}

type Env = Map<string, Val>;

type Param =
  | { kind: "name"; name: string; fallback?: [number, number] }
  /** property -> local name; `defaults`: `{ sandbox = true }`, the default's tokens per local */
  | {
      kind: "object";
      props: Map<string, string>;
      defaults?: Map<string, [number, number]>;
      /** `{ a, ...more }`: the local that receives every other property of the argument. */
      rest?: string;
    }
  | { kind: "array"; names: Array<string | null> };

export interface FnDef {
  name: string | null;
  /** Class the function is a method of. */
  owner: string | null;
  params: Param[];
  /** Index of `(` of the parameter list, or of the lone parameter of `p => …`. */
  paramsAt: number;
  /** Body: a block `{…}` (start is the brace) or an expression. */
  body: [number, number];
  block: boolean;
  /** For a callback: the token of the method it is passed to (`forEach`), and its receiver. */
  calledBy: { method: string; receiverEnd: number } | null;
  /** A method or function-valued key of an object literal: called as `obj.name(…)`, never bare. */
  member?: true;
  /** An arrow function: it has no `this` of its own. */
  arrow?: true;
  /** A `static` method of a class: `this` in it is the class, not an instance. */
  static?: true;
}

const MAX_VALUES = 64;
/** Words after which `(` groups an expression rather than calling something. */
const GROUPING_WORDS = new Set([
  "return",
  "typeof",
  "void",
  "await",
  "yield",
  "case",
  "in",
  "of",
  "delete",
  "throw",
  "else",
  "do",
  "new",
  "instanceof",
]);
/**
 * Functions read per file. Electron Fiddle's renderer bundle has 25,113 (its storage wrapper
 * class comes after the first 20,000); the tables grow with this number, so it stays bounded.
 */
const MAX_FUNCTIONS = 60_000;
const MAX_DEPTH = 10;
/** Call sites read per function; past them its bindings are partial (see `sitesCapped`). */
const MAX_SITES = 64;
/** Rounds of one loop, `forEach` or `map`, and keys an evaluated object may get. */
const MAX_ITERATIONS = 256;
/** Statements one evaluated body may run, loops counted per round. */
const MAX_STATEMENTS = 4000;
/** Longest string a string operation is applied to or builds. */
const MAX_STRING = 1000;
/** Blocks, loop bodies and callbacks one evaluation may be inside at once. */
const MAX_NESTING = 64;
const UNKNOWN: Val = { kind: "unknown" };
/** Methods that change the list or map they are called on. */
const MUTATORS = /^(push|pop|shift|unshift|splice|set|delete|clear|fill|copyWithin|sort|reverse)$/;
/** Built-in functions a list method may be given that change nothing of an element. */
const READ_ONLY_CALLBACKS: ReadonlySet<string> = new Set([
  "String",
  "Boolean",
  "Number",
  "parseInt",
  "parseFloat",
  "encodeURIComponent",
  "decodeURIComponent",
  "encodeURI",
  "decodeURI",
]);
/** Words that make what follows them in a loop round conditional (see `conditionalBefore`). */
const CONTROL_WORDS: ReadonlySet<string> = new Set([
  "if",
  "else",
  "continue",
  "break",
  "return",
  "throw",
  "switch",
  "case",
  "for",
  "while",
  "do",
  "try",
]);
const CONTROL_PUNCT: ReadonlySet<string> = new Set(["?", "&&", "||", "??"]);
/** The tokens that assign to what is before them: `=` and every compound assignment. */
const ASSIGNS = ASSIGNMENT_OPERATORS;
/** Names whose value exists only at run time; reading one says so in the reason. */
const RUNTIME = new Set([
  "Math",
  "Date",
  "process",
  "fetch",
  "await",
  "crypto",
  "performance",
  "navigator",
  "window",
  "document",
  "localStorage",
  "sessionStorage",
  "globalThis",
]);
/** Words that start a statement: a line that begins with one ends the expression before it. */
const STATEMENT_WORDS = new Set([
  "const",
  "let",
  "var",
  "function",
  "class",
  "if",
  "for",
  "while",
  "do",
  "return",
  "switch",
  "try",
  "throw",
  "export",
  "import",
]);

/**
 * A regular expression literal of the simple form the evaluation applies: characters, escapes
 * and character classes, at most one of them with a `?`, `*` or `+`, optionally anchored, flags
 * `g` and `i` only. Null for anything else (groups, alternatives, backreferences, lookarounds), so no
 * pattern that can backtrack badly is ever built.
 */
export function simpleRegex(literal: string): RegExp | null {
  const m = /^\/(.+)\/([a-z]*)$/s.exec(literal);
  if (!m) return null;
  const [, body, flags] = m as unknown as [string, string, string];
  if (!/^[gi]*$/.test(flags) || new Set(flags).size !== flags.length) return null;
  const ATOM =
    /^(?:\[\^?(?:\\[^\n]|[^\\\][])+\]|\\[dDwWsS\\/.\-_:^$*+?()[\]{}|]|[^\\[\](){}|*+?^$])([*+?])?/;
  let rest = body;
  if (rest.startsWith("^")) rest = rest.slice(1);
  if (rest.endsWith("$") && !rest.endsWith("\\$")) rest = rest.slice(0, -1);
  // At most one quantified atom: without groups, that keeps a match linear per start position,
  // so a replace is at most quadratic in the (bounded) string. `a*a*…b` is refused.
  let quantified = 0;
  for (let atoms = 0; rest.length; atoms++) {
    const a = ATOM.exec(rest);
    if (!a || atoms >= 32) return null;
    // the quantifier is its own group, so an escaped `\?` or `\\` before it is still counted
    if (a[1] !== undefined && ++quantified > 1) return null;
    rest = rest.slice(a[0].length);
  }
  try {
    return new RegExp(body, flags);
  } catch {
    return null;
  }
}

/**
 * Every concatenation of one string of each part, or null when there would be more than
 * MAX_VALUES of them or one longer than MAX_STRING (callers say "too many values").
 */
const product = (parts: string[][]): string[] | null => {
  let out = [""];
  for (const part of parts) {
    const next: string[] = [];
    for (const a of out)
      for (const b of part) {
        if (a.length + b.length > MAX_STRING) return null;
        next.push(a + b);
      }
    if (next.length > MAX_VALUES) return null;
    out = next;
  }
  return out;
};

/** An array-index key (ordered first by JavaScript) or `__proto__`: not modeled. */
const unordered = (key: string): boolean =>
  key === "__proto__" || (/^(0|[1-9]\d{0,9})$/.test(key) && Number(key) < 2 ** 32 - 1);

/** Every local name a parameter list binds. */
function paramNames(params: Param[]): string[] {
  const out: string[] = [];
  for (const p of params) {
    if (p.kind === "name" && p.name) out.push(p.name);
    else if (p.kind === "object") {
      out.push(...p.props.values());
      if (p.rest) out.push(p.rest);
    } else if (p.kind === "array") for (const n of p.names) if (n) out.push(n);
  }
  return out;
}

/** What a resolver derives from a file's tokens alone; built once per token array. */
interface Structure {
  /** Names bound to `URL` or to the `url` module (see `urlConstructor`). */
  urlNames: { classes: Map<string, number>; modules: Map<string, number> } | null;
  match: Int32Array;
  opener: Int32Array;
  defs: FnDef[] | null;
  /** First plain block function per name, and every function by the token of its parameters. */
  defsByName: Map<string, FnDef> | null;
  defsByParams: Map<number, FnDef> | null;
  /**
   * Per function and name: its declarations and writes in the body. `scope`: for a `const`,
   * `let` or `class` of an inner block, the token range it is visible in (null: the function's).
   */
  declCache: Map<
    string,
    Array<{ j: number; weight: number; init: boolean; scope: [number, number] | null }>
  >;
  topDecls: Map<string, [number, number] | null> | null;
  /** The same declarations before later writes are taken into account (see `binding`). */
  topDeclsLoose: Map<string, [number, number] | null> | null;
  /** Names a member of which is written through another name for them (`const U = T; U.a = …`). */
  writtenThrough: Set<string> | null;
  topPatterns: Map<string, { key: string; from: [number, number] } | null>;
  classes: Array<{ name: string; start: number; end: number }> | null;
  /** Positions of every identifier by name. */
  names: Map<string, number[]> | null;
  depths: Int32Array | null;
  innermost: Int32Array | null;
  /** For every token, the innermost bracket it is in (-1: none). */
  parents: Int32Array | null;
  /** What the module exports by name (see `exportValue`). */
  exportIndex: Map<string, [number, number]> | null;
  /** Webpack module functions by key (see `webpackModule`). */
  moduleTable: Map<string, FnDef | null> | null;
  /** Plain `function NAME(…) {…}` declarations by name (see `nestedFunction`). */
  fnDecls: Map<string, FnDef[]> | null;
  /** Functions by the names their parameters bind (see `paramAround`). */
  paramDefs: Map<string, FnDef[]> | null;
  /** Names assigned as a member somewhere in the file (see `memberWritten`). */
  memberWrites: Map<string, boolean>;
  /** Member names written through a string key (`x["k"] = …`, defineProperty, Object.assign). */
  stringWrites: Set<string> | null;
}

const structures = new WeakMap<Token[], Structure>();

/**
 * Positions of every identifier by name for these tokens, when a resolver has already built the
 * index (null otherwise: a caller then walks the tokens itself rather than pay for building it).
 */
export function builtIdentifierIndex(
  tokens: Token[],
): ReadonlyMap<string, readonly number[]> | null {
  return structures.get(tokens)?.names ?? null;
}

export class ExpressionResolver {
  private readonly match: Int32Array;
  /** For a closing bracket, its opening one. */
  private readonly opener: Int32Array;
  /** Indexes of the file's tokens, shared with every other resolver of the same tokens. */
  private readonly s: Structure;
  /** Method used by the outermost resolution, set while resolving. */
  private method: ResolveMethod = "concatenation";
  private lines = new Set<number>();
  private partial = false;
  /** Set with `partial` when the cause is the call-site cap (see `sitesCapped`). */
  private cut = false;
  private readonly siteCache = new Map<FnDef, number[]>();
  /** Functions with more call sites than MAX_SITES: the sites listed are not all there are. */
  private readonly sitesCapped = new Set<FnDef>();
  private readonly literalOwners = new Map<FnDef, string | null>();
  private readonly bindingCaches = [
    new Map<FnDef, { envs: Env[] | null; partial: boolean; cut?: boolean; lines: number[] }>(),
    new Map<FnDef, { envs: Env[] | null; partial: boolean; cut?: boolean; lines: number[] }>(),
  ];
  /** The bindings read so far, apart for the strict reading (see `strict`). */
  private get bindingCache(): Map<
    FnDef,
    { envs: Env[] | null; partial: boolean; cut?: boolean; lines: number[] }
  > {
    return this.bindingCaches[this.strict ? 1 : 0]!;
  }
  /**
   * Set while a table built into IPC is read (bridge members, routes, a list a callback reads
   * through a parameter): a literal table that is aliased, passed to something that may write
   * it, or changed in any way the evaluation cannot follow, is not read (see `escapes`).
   */
  private strict = 0;

  /** Runs `read` with the strict reading of tables (see `strict`). */
  private strictly<T>(read: () => T): T {
    this.strict++;
    try {
      return read();
    } finally {
      this.strict--;
    }
  }
  private readonly newSites = new Map<string, Array<{ name: string; open: number }>>();
  /**
   * Token visits for scanning function bodies and call sites, for the whole file. When it is used
   * up, the slow path stops resolving: no value is better than an unbounded search.
   */
  private work = 3_000_000;
  private budget = 20_000;
  /** Why the current evaluation stopped, when it stopped for a reason of the subset. */
  private why: string | null = null;
  /** Functions being evaluated: a call of one of them again is a cycle. */
  private readonly active = new Set<FnDef>();
  /** Statements run in the current question, across every body it evaluates. */
  private statements = 0;
  /**
   * Steps of function-body evaluation left for the whole file (expressions read and statements
   * run inside evaluated bodies). Each question has its own budget too; this one keeps a file
   * with thousands of evaluated declarations linear. Used up, bodies are no longer evaluated.
   */
  private bodyWork = 500_000;
  /** How many bodies are being evaluated right now (nested calls). */
  private inBody = 0;
  /** Blocks and loop bodies the statement being run is in, inside its own function. */
  private blocks = 0;
  /** An expression that may have had effects could not be read in the current question. */
  private effectUnknown = false;

  constructor(
    private readonly tokens: Token[],
    private readonly constants: Constants,
    /** The module's path in the application, for sources and imports. */
    readonly file = "",
    private readonly host: ModuleHost | null = null,
    /**
     * Without a host: how to write a string that another module defines, so the caller can fill
     * it in once that module is known (endpoint detection writes its reference markers).
     */
    private readonly reference: ((specifier: string, property: string) => string) | null = null,
    /**
     * Gaps: a part of a template or concatenation that cannot be read becomes `${…}` instead of
     * making the whole value unknown (endpoint detection reports such templates as templates).
     */
    private readonly gaps = false,
    /**
     * With `reference`: a name or `NAME.KEY` the file's constants name as another module's
     * (`const { Channels } = require("./c")`, then `Channels.SAVE`) is read as a reference to it,
     * as the fast scan reads a channel argument (IPC route tables).
     */
    private readonly constantRefs = false,
  ) {
    let shared = structures.get(tokens);
    if (!shared) {
      const match = new Int32Array(tokens.length).fill(-1);
      const opener = new Int32Array(tokens.length).fill(-1);
      const open: number[] = [];
      for (let j = 0; j < tokens.length; j++) {
        const p = tokens[j]!;
        if (p.type !== "punct") continue;
        if (p.value === "{" || p.value === "(" || p.value === "[") open.push(j);
        else if (p.value === "}" || p.value === ")" || p.value === "]") {
          const at = open.pop();
          if (at !== undefined) {
            match[at] = j;
            opener[j] = at;
          }
        }
      }
      shared = {
        match,
        opener,
        defs: null,
        defsByName: null,
        defsByParams: null,
        declCache: new Map(),
        topDecls: null,
        topDeclsLoose: null,
        writtenThrough: null,
        topPatterns: new Map(),
        classes: null,
        names: null,
        depths: null,
        innermost: null,
        parents: null,
        exportIndex: null,
        moduleTable: null,
        fnDecls: null,
        paramDefs: null,
        memberWrites: new Map(),
        stringWrites: null,
        urlNames: null,
      };
      structures.set(tokens, shared);
    }
    this.s = shared;
    this.match = shared.match;
    this.opener = shared.opener;
  }

  /**
   * Why the last question (`resolveArgument`, `valueAt`, `topValue`) got no value, when the
   * evaluation of a function body stopped: an unsupported form, too many values, the depth or
   * work limit, a cycle, or a value that exists only at run time. Null when it simply had
   * nothing to read.
   */
  get reason(): string | null {
    return this.why;
  }

  /** Set while `keyWith` evaluates: top-level names declared in a list are read too. */
  private listedValues = false;

  /** Records the first reason of a question and gives up on the value. */
  private stop(why: string): null {
    this.why ??= why;
    return null;
  }

  /** Starts a question: the budgets and the reason are its own. */
  private begin(budget: number): void {
    this.budget = budget;
    this.why = null;
    this.statements = 0;
    this.effectUnknown = false;
  }

  private is(k: number, type: Token["type"], value?: string): boolean {
    const t = this.tokens[k];
    return !!t && t.type === type && (value === undefined || t.value === value);
  }

  private punct(k: number, value: string): boolean {
    return this.is(k, "punct", value);
  }

  /**
   * End (exclusive) of the expression that starts at k: the next `,` `;` or closing bracket, or a
   * line that starts with a statement word after a complete value (code without semicolons).
   */
  private exprEnd(k: number): number {
    const limit = Math.min(this.tokens.length, k + 2000);
    for (let j = k; j < limit; j++) {
      const p = this.tokens[j]!;
      if (p.type !== "punct") {
        if (
          j > k &&
          p.type === "ident" &&
          STATEMENT_WORDS.has(p.value) &&
          p.line !== this.tokens[j - 1]!.line &&
          this.endsValue(j - 1)
        )
          return j;
        continue;
      }
      if (p.value === "{" || p.value === "(" || p.value === "[") {
        const m = this.match[j]!;
        if (m === -1) return limit;
        j = m;
      } else if (p.value === "}" || p.value === ")" || p.value === "]") return j;
      else if (p.value === "," || p.value === ";") return j;
    }
    return limit;
  }

  /**
   * The end of the one argument of the call whose parentheses are at `open` and `close`: before
   * a trailing comma (`Object.fromEntries(list,)`, as formatters write a call over several
   * lines), else `close`.
   */
  private lastArgEnd(open: number, close: number): number {
    return close - 1 > open && this.punct(close - 1, ",") ? close - 1 : close;
  }

  /**
   * The values the argument at token k can have, or null. The argument ends at the next
   * top-level `,` or `)`.
   */
  resolveArgument(k: number): ResolvedValues | null {
    // the reading 0.9.8 had: a table passed to a function whose body is not read is taken as it
    // is written (the new readers read strictly, see `strict`)
    return this.guarded(null, () => this.resolveArgumentIn(k));
  }

  /**
   * Runs one question; an exception inside the evaluation (a stack overflow on input deeper than
   * the limits foresee, a string too long) ends the question with that reason instead of ending
   * the analysis of the file.
   */
  private guarded<T>(fallback: T, question: () => T): T {
    try {
      return question();
    } catch (error) {
      this.why = `evaluation failed: ${error instanceof Error ? error.name : "error"}`;
      this.inBody = 0;
      this.active.clear();
      return fallback;
    }
  }

  private resolveArgumentIn(k: number): ResolvedValues | null {
    if (this.work <= 0) return null;
    this.method = "concatenation";
    this.lines = new Set();
    this.partial = false;
    this.cut = false;
    this.begin(20_000);
    const end = this.exprEnd(k);
    const direct = this.evalRange(k, end, new Map(), 0);
    const read = direct?.kind === "str" ? this.result(direct.values) : null;
    // With gaps, a parameter in the expression became a gap; its bindings may fill it in.
    if (read && !(this.gaps && read.values.some((v) => v.includes("${…}")))) return read;
    // The expression uses a parameter of the function it is in: read every binding of it.
    const bound = this.throughParameters(k, end, 0);
    return bound ? this.result(bound) : read;
  }

  /**
   * The calls of a wrapper: the expression at k (a storage key) reads a parameter of the named
   * function or method around it, and each call site of that function in this file binds it.
   * One entry per call site, with the method name token there and the values its arguments give
   * the expression, whole (null: that call site cannot be read, or only with a gap). For a
   * method, a call on `this` counts only inside the same class. Null when the expression reads
   * no parameter, the parameter is
   * assigned in the body, or no call site is found. Bounded like `resolveArgument`: at most
   * MAX_SITES call sites, MAX_VALUES values per site, and one work budget per question.
   */
  wrapperCalls(k: number): WrapperCalls | null {
    return this.guarded(null, () => this.wrapperCallsIn(k));
  }

  /**
   * The wrapper the expression at k (a storage key) is in: the named function or method around
   * it whose parameters it reads, none of them assigned in the body (see `wrapperCalls`). Null
   * otherwise.
   */
  private wrapperOf(k: number): { def: FnDef; used: Set<string> } | null {
    const end = this.exprEnd(k);
    const def = this.enclosing(k);
    if (!def || def.name === null || def.calledBy) return null;
    const used = new Set<string>();
    for (let j = k; j < end; j++)
      if (
        this.is(j, "ident") &&
        !this.punct(j - 1, ".") &&
        this.paramIndex(def, this.tokens[j]!.value) !== -1
      )
        used.add(this.tokens[j]!.value);
    if (!used.size) return null;
    for (const name of used)
      for (const j of this.occurrences(name, def.body[0], def.body[1]))
        if (
          !this.punct(j - 1, ".") &&
          ((this.punct(j + 1, "=") && !this.punct(j + 2, "=")) || this.changes(j))
        )
          return null;
    return { def, used };
  }

  /**
   * For the cross-module stage: the wrapper the expression at k is in, when the expression reads
   * exactly one of its parameters, a plain name (not a pattern), and nothing else of the
   * function's own (`this`); with that parameter's index. Null otherwise.
   */
  keyParameter(k: number): { def: FnDef; index: number } | null {
    return this.guarded(null, () => {
      if (this.work <= 0) return null;
      this.begin(20_000);
      const found = this.wrapperOf(k);
      if (!found || found.used.size !== 1) return null;
      const end = this.exprEnd(k);
      for (let j = k; j < end; j++) if (this.is(j, "ident", "this")) return null;
      const name = [...found.used][0]!;
      const index = found.def.params.findIndex((p) => p.kind === "name" && p.name === name);
      return index === -1 ? null : { def: found.def, index };
    });
  }

  /**
   * The expression at k (a key inside the wrapper def) with parameter `index` of def bound to
   * `value` and every other parameter unknown: its whole values, or null when any value it can
   * take is not whole (a gap, an empty string) or it cannot be read. Bounded like `wrapperCalls`.
   */
  keyWith(k: number, def: FnDef, index: number, value: string): string[] | null {
    return this.guarded(null, () => {
      if (this.work <= 0) return null;
      this.begin(20_000);
      const args: Array<Val | null> = def.params.map(() => null);
      args[index] = { kind: "str", values: [value] };
      const env: Env = new Map();
      this.bind(def.params, args, env);
      this.listedValues = true;
      let v: Val | null;
      try {
        v = this.evalRange(k, this.exprEnd(k), env, 1);
      } finally {
        this.listedValues = false;
      }
      if (v?.kind !== "str" || v.ref || !v.values.length) return null;
      if (v.values.some((x) => x === "" || x.includes("${…}") || x.includes("\u0001"))) return null;
      return v.values.slice(0, MAX_VALUES);
    });
  }

  private wrapperCallsIn(k: number): WrapperCalls | null {
    if (this.work <= 0) return null;
    this.begin(20_000);
    const end = this.exprEnd(k);
    const found = this.wrapperOf(k);
    if (!found) return null;
    const { def } = found;
    const sites = this.callSites(def);
    if (!sites.length) return null;
    const out: WrapperCalls["sites"] = [];
    for (const open of sites) {
      const close = this.match[open]!;
      if (close === -1) continue;
      const values: string[] = [];
      let unread = false;
      for (const caller of this.callerEnvs(open, close, 0)) {
        const env: Env = new Map();
        this.bind(def.params, this.list(open, close, caller, 1), env);
        const v = this.evalRange(k, end, env, 1);
        // Only whole keys: a gap may be a part of the wrapper's own text that is not read (a
        // prefix constant), and `${…}theme` would then stand for a key no build has.
        const read =
          v?.kind === "str" ? v.values.filter((x) => x !== "" && !x.includes("${…}")) : [];
        if (!read.length) unread = true;
        for (const x of read) if (values.length < MAX_VALUES && !values.includes(x)) values.push(x);
      }
      out.push({ at: open - 1, values: unread && !values.length ? null : values });
    }
    const holder = def.owner ?? (def.member ? this.literalOwner(def) : null);
    if (!out.length) return null;
    return {
      name: holder ? `${holder}.${def.name}` : def.name!,
      sites: out,
      ...(this.sitesCapped.has(def) ? { capped: true as const } : {}),
    };
  }

  private result(values: string[]): ResolvedValues | null {
    const unique = [...new Set(values)].filter((v) => v.length > 0);
    if (!unique.length) return null;
    return {
      values: unique,
      method: this.method,
      lines: [...this.lines].toSorted((a, b) => a - b),
      partial: this.partial,
      ...(this.cut ? { cut: true as const } : {}),
    };
  }

  private note(method: ResolveMethod): void {
    const order: ResolveMethod[] = ["concatenation", "template", "call", "parameter", "element"];
    if (order.indexOf(method) > order.indexOf(this.method)) this.method = method;
  }

  /**
   * The IPC object a class field holds, for `this.FIELD.method(` at k (k is FIELD): assigned in
   * the class as `this.FIELD = ipcMain` (or another name for it), or from a constructor parameter
   * that every `new Class(…)` of the file passes ipcMain to.
   */
  fieldOwner(k: number, aliases: Map<number, string>, targets: ReadonlySet<string>): string | null {
    const field = this.tokens[k]?.value;
    if (!field) return null;
    const cls = this.classRanges().find((c) => k > c.start && k < c.end);
    if (!cls) return null;
    // The answer depends on the class, the field and the two tables only, not on k: one reading
    // of the class body per field (a class that calls `this.ipc.on(…)` a hundred times).
    if (this.fieldOwners?.aliases !== aliases || this.fieldOwners.targets !== targets)
      this.fieldOwners = { aliases, targets, owners: new Map() };
    const key = `${cls.start}\u0000${field}`;
    const known = this.fieldOwners.owners.get(key);
    if (known !== undefined) return known;
    const owner = this.fieldOwnerIn(cls, field, aliases, targets);
    this.fieldOwners.owners.set(key, owner);
    return owner;
  }

  private fieldOwners: {
    aliases: Map<number, string>;
    targets: ReadonlySet<string>;
    owners: Map<string, string | null>;
  } | null = null;

  private fieldOwnerIn(
    cls: { name: string; start: number; end: number },
    field: string,
    aliases: Map<number, string>,
    targets: ReadonlySet<string>,
  ): string | null {
    const owners = new Set<string>();
    for (let j = cls.start; j < cls.end; j++) {
      if (
        !this.is(j, "ident", "this") ||
        !this.punct(j + 1, ".") ||
        !this.is(j + 2, "ident", field) ||
        !this.punct(j + 3, "=") ||
        this.punct(j + 4, "=")
      )
        continue;
      const v = j + 4;
      const end = this.exprEnd(v);
      if (end !== v + 1 || !this.is(v, "ident")) return null; // assigned something else
      const name = this.tokens[v]!.value;
      const direct = aliases.get(v) ?? (targets.has(name) ? name : null);
      if (direct && targets.has(direct)) {
        owners.add(direct);
        continue;
      }
      // a constructor parameter
      const ctor = this.functions().find(
        (d) => d.owner === cls.name && d.name === "constructor" && d.body[0] <= j && j < d.body[1],
      );
      const index = ctor ? this.paramIndex(ctor, name) : -1;
      if (!ctor || index === -1) return null;
      let seen = 0;
      // `new NAME(` in source order, from the name index instead of a walk over every token
      for (const p of this.positions(cls.name)) {
        const n = p - 1;
        if (n < 0 || n + 2 >= this.tokens.length) continue;
        if (!this.is(n, "ident", "new") || !this.punct(n + 2, "(")) continue;
        const at = this.argStart(n + 2, this.match[n + 2]!, index);
        if (at === null || !this.is(at, "ident")) return null;
        const passed =
          aliases.get(at) ?? (targets.has(this.tokens[at]!.value) ? this.tokens[at]!.value : null);
        if (!passed || !targets.has(passed)) return null;
        owners.add(passed);
        seen++;
      }
      if (!seen) return null;
    }
    return owners.size === 1 ? [...owners][0]! : null;
  }

  /**
   * For the identifier at k that is a parameter of the named function around it: the token at
   * which the matching argument starts at each call site of that function. Null when it is no
   * parameter, the function has no readable call sites, or one of them passes fewer arguments.
   */
  argumentsFor(k: number): number[] | null {
    const name = this.tokens[k]?.value;
    const def = this.enclosing(k);
    if (!name || !def || def.name === null) return null;
    const index = def.params.findIndex((p) => p.kind === "name" && p.name === name);
    if (index === -1) return null;
    const sites = this.callSites(def);
    if (!sites.length || this.sitesCapped.has(def)) return null;
    const out: number[] = [];
    for (const open of sites) {
      const at = this.argStart(open, this.match[open]!, index);
      if (at === null) return null;
      out.push(at);
    }
    return out;
  }

  /** What the expression starting at token k is, as far as it can be read; null if not at all. */
  valueAt(k: number): Val | null {
    this.begin(20_000);
    return this.guarded(null, () => this.evalRange(k, this.exprEnd(k), new Map(), 0));
  }

  /**
   * The value of a name declared at the top of the file (`const NAME = …` or, in a declaration
   * list, `, NAME = …` with its initializer at `at`), when nothing assigns or changes it later.
   */
  topValue(name: string, at?: number): Val | null {
    if (this.work <= 0) return null;
    this.begin(20_000);
    return this.guarded(null, () => this.topValueIn(name, at));
  }

  private topValueIn(name: string, at?: number): Val | null {
    const decl = this.topDeclarations().get(name);
    if (decl === null) return null;
    if (decl)
      return this.unlessChanged(
        name,
        decl[0] - 2,
        this.evalRange(decl[0], decl[1], new Map(), 0),
        0,
        this.tokens.length,
        null,
      );
    // `var a = 1, NAME = …`, as minifiers write declarations
    if (at === undefined || this.writtenElsewhere(name, at - 2)) return null;
    return this.unlessChanged(
      name,
      at - 2,
      this.evalRange(at, this.exprEnd(at), new Map(), 0),
      0,
      this.tokens.length,
      null,
    );
  }

  /** The value, unless it is an object or a list the code may change after building it. */
  private unlessChanged(
    name: string,
    decl: number,
    value: Val | null,
    from: number,
    to: number,
    owner: FnDef | null,
  ): Val | null {
    if (value && (value.kind === "obj" || value.kind === "arr" || value.kind === "map"))
      if (this.escapes(name, decl, from, to, owner))
        return this.stop("the value may be changed after it was built");
    return value;
  }

  /**
   * For a value built by code (a call, an IIFE): whether the name declared at `decl` is used in
   * [from, to) in a way that may change it after it was built: aliased, passed to a function,
   * `delete`d, written with `+=`/`++`. Reading a key, exporting it, `Object.freeze`,
   * `Object.keys/values/entries` and `typeof` are fine. Only for computed values: a literal
   * table keeps the rules it had.
   */
  private escapes(
    name: string,
    decl: number,
    from: number,
    to: number,
    owner: FnDef | null = null,
  ): boolean {
    const init = decl + 2;
    const computed =
      this.punct(init, "(") ||
      (this.is(init, "ident") && (this.punct(init + 1, "(") || this.punct(init + 1, ".")));
    // the readers of tables built into IPC (`strict`): a literal table too, as an alias, a
    // function that writes its parameter or anything unknown it is passed to may change it
    if (!computed && !this.strict) return false;
    return this.changedIn(name, decl, from, to, owner, 0);
  }

  /** Whether a use of the name in [from, to) (not the one at `decl`) may change its value. */
  private changedIn(
    name: string,
    decl: number,
    from: number,
    to: number,
    owner: FnDef | null,
    depth: number,
  ): boolean {
    for (const j of this.occurrences(name, from, to)) {
      if (j === decl || this.punct(j - 1, ".") || this.punct(j - 1, "?.")) continue;
      // another binding of the same name: a declaration, or a use inside a function that has
      // its own parameter or declaration of it
      if (/^(const|let|var|function|class)$/.test(this.tokens[j - 1]?.value ?? "")) continue;
      if (this.boundBetween(j, name, owner)) continue;
      // no use of this binding: a parameter, a `catch` binding or a pattern element of its own
      // (`function h(T)`, `(a, T) => a`, `const { a: T } = o`), an object key, a class member, a
      // label (`T: for (;;) { break T }`), or a use inside a function that binds the name again
      if (bindingAt(this.tokens, j) || keyOrLabelAt(this.tokens, j)) continue;
      if (shadowedAt(this.tokens, j, name)) continue;
      if (this.is(j - 1, "ident", "delete")) return true;
      if (this.punct(j - 1, "++") || this.punct(j - 1, "--")) return true;
      // read only: `typeof T`, `...T`, `for (… of T)`, `k in T`, a call of it `T(…)`
      if (/^(typeof|of|in)$/.test(this.tokens[j - 1]?.value ?? "") || this.punct(j - 1, "..."))
        continue;
      if (this.punct(j + 1, "(")) continue;
      // a write through the whole chain of members (`list[0].channel = …`, `T.a.b += …`,
      // `[T.a] = …`), a mutating method on a member (`list[0].push(…)`), `Object.assign(T.a, …)`
      if (this.writesAt(j)) return true;
      // a key read, unless it is written
      let after = -1;
      if ((this.punct(j + 1, ".") || this.punct(j + 1, "?.")) && this.is(j + 2, "ident"))
        after = j + 3;
      else if (this.punct(j + 1, "[") && this.match[j + 1] !== -1) after = this.match[j + 1]! + 1;
      if (after !== -1) {
        const t = this.tokens[after];
        if (
          t?.type === "punct" &&
          /^(?:=|\+\+|--|[-+*/%&|^]=|\*\*=|<<=|>>>?=|&&=|\|\|=|\?\?=)$/.test(t.value)
        )
          return true;
        // a method called on it may change it (`T.push(…)`); reading a member and calling it
        // with the key's own value is a read only when that member is a string of the table
        if (
          this.punct(after, "(") &&
          this.is(j + 2, "ident") &&
          MUTATORS.test(this.tokens[j + 2]!.value)
        )
          return true;
        continue;
      }
      // what only tests or compares it, and the source of a destructuring
      if (this.testedAt(j) || patternSourceAt(this.tokens, j)) continue;
      if (this.exportedAt(j)) continue;
      // handed on as a value that goes nowhere that can write it: `const L = [T]` with L
      // unchanged, `return T` from a function whose every result only feeds reads
      if (
        depth < 3 &&
        this.handedOnAt(
          j,
          (alias, at) => alias !== name && !this.changedIn(alias, at, from, to, owner, depth + 1),
        )
      )
        continue;
      if (this.externalConstructorArgument(j)) continue;
      if (this.assignSource(j)) continue;
      // `Object.freeze(T)`, `console.info("x", T)`, `JSON.stringify(T)`, …: a whole argument of a
      // function known to only read it
      if (this.readOnlyArgument(j)) continue;
      // `${T}` in a template: turned into a string, read only
      if (
        this.tokens[j - 1]?.type === "template" &&
        this.tokens[j - 1]!.value.endsWith("${…}") &&
        this.tokens[j + 1]?.type === "template"
      )
        continue;
      // `const X2 = T;`, `const y = T || {}`, `const z = x ? T : null`: another name for it,
      // which changes it only where that name is changed
      const alias = depth < 3 ? this.aliasAt(j) : null;
      if (alias !== null) {
        if (
          alias.name !== name &&
          !this.changedIn(alias.name, alias.at, from, to, owner, depth + 1)
        )
          continue;
        return true;
      }
      // an argument of a function of this file that only reads that parameter
      const arg = this.localCallArgument(j);
      if (arg && depth < 3) {
        const p = arg.def.params[arg.index];
        if (
          p?.kind === "name" &&
          p.name &&
          !this.changedIn(p.name, -1, arg.def.body[0], arg.def.body[1], arg.def, depth + 1)
        )
          continue;
      }
      return true;
    }
    return false;
  }

  /**
   * The name at j is only tested or compared: `!T`, `T === x` (also `==`, `!=`, `!==`, `<`, `>`,
   * `<=`, `>=`, `instanceof`), `case T:`, or a whole operand of the condition of `if (…)` /
   * `while (…)` (`if (T)`, `if (T && T.A)`).
   */
  private testedAt(j: number): boolean {
    const before = this.tokens[j - 1];
    const after = this.tokens[j + 1];
    const COMPARE = /^(===|!==|==|!=|<|>|<=|>=)$/;
    if (before?.type === "punct" && (before.value === "!" || COMPARE.test(before.value)))
      return true;
    if (after?.type === "punct" && COMPARE.test(after.value)) return true;
    if (this.is(j + 1, "ident", "instanceof")) return true;
    if (this.is(j - 1, "ident", "case") && this.punct(j + 1, ":")) return true;
    // a statement that only tests it, as minifiers write `if`: `T && f()`, `T || g()`, `T ? a() : b()`
    if (
      (!before || (before.type === "punct" && /^(;|\{|\})$/.test(before.value))) &&
      after?.type === "punct" &&
      /^(&&|\|\||\?\?|\?)$/.test(after.value)
    )
      return true;
    // a whole operand of a condition
    if (
      !(before?.type === "punct" && /^(\(|&&|\|\||\?\?)$/.test(before.value)) ||
      !(after?.type === "punct" && /^(\)|&&|\|\||\?\?)$/.test(after.value))
    )
      return false;
    let open = j - 1;
    for (let guard = 0; guard < 64 && open >= 0 && !this.punct(open, "("); guard++) {
      const t = this.tokens[open]!;
      if (t.type === "punct" && (t.value === ")" || t.value === "]" || t.value === "}")) {
        open = this.opener[open]! - 1;
        continue;
      }
      if (
        t.type === "punct" &&
        (t.value === "[" || t.value === "{" || t.value === ";" || t.value === ",")
      )
        return false;
      open--;
    }
    return this.punct(open, "(") && /^(if|while)$/.test(this.tokens[open - 1]?.value ?? "");
  }

  /**
   * The name at j handed on as a value that goes nowhere that can write it: an element of an
   * array or object literal bound to a declaration (`const L = [T]`, `const W = { x: T }`) that
   * `unchanged` says is not changed, or `return T` from a named function whose every call's
   * result is discarded, destructured, or bound to a declaration `unchanged` accepts. Anything
   * else (`[T][0].A = …`, `get().A = …`, `Object.assign(get(), …)`, a container passed to a
   * call, a function handed around) may write it.
   */
  private handedOnAt(j: number, unchanged: (name: string, at: number) => boolean): boolean {
    if (this.is(j - 1, "ident", "return")) {
      const whole =
        this.punct(j + 1, ";") ||
        this.punct(j + 1, "}") ||
        (this.tokens[j + 1]?.line ?? 0) > this.tokens[j]!.line;
      return whole && this.resultsUnchanged(j, unchanged);
    }
    const before = this.tokens[j - 1];
    const after = this.tokens[j + 1];
    if (!(before?.type === "punct" && after?.type === "punct")) return false;
    let open = -1;
    if (/^(\[|,)$/.test(before.value) && /^(,|\])$/.test(after.value))
      open = this.containerOf(j, "[");
    else if (/^(\{|,|:)$/.test(before.value) && /^(,|\})$/.test(after.value))
      open = this.containerOf(j, "{");
    if (open < 0) return false;
    const close = this.match[open]!;
    if (close < 0) return false;
    // `const L = [T];`, `var W = { x: T }, …`: the container under a name of its own
    if (!this.punct(open - 1, "=") || !declaredAt(this.tokens, open - 2)) return false;
    if (!this.valueEndsAt(close + 1, close)) return false;
    return unchanged(this.tokens[open - 2]!.value, open - 2);
  }

  /** The token at k ends a declaration's value that ended at `last`: `;`, `,`, `}`, a line break. */
  private valueEndsAt(k: number, last: number): boolean {
    const t = this.tokens[k];
    if (!t) return true;
    if (t.type === "punct" && /^(;|,|\})$/.test(t.value)) return true;
    return (
      t.line > this.tokens[last]!.line && !(t.type === "punct" && /^(\.|\[|\(|\?\.)$/.test(t.value))
    );
  }

  /** Call sites of a function read for `handedOnAt` before it gives up. */
  private static readonly MAX_RESULT_SITES = 32;

  /**
   * The function around the `return` at j has a name, and every use of the name is a call whose
   * result is discarded, destructured (`const { A } = get()`), or bound to a declaration that
   * `unchanged` accepts (`const r = get()`).
   */
  private resultsUnchanged(j: number, unchanged: (name: string, at: number) => boolean): boolean {
    const def = this.enclosing(j);
    if (!def?.name || def.calledBy) return false;
    const name = def.name;
    let sites = 0;
    for (const o of this.positions(name)) {
      // the function's own name: `function get(`, `get() {`, `const get = …`
      if (o === def.paramsAt - 1 || (declaredAt(this.tokens, o) && this.punct(o + 1, "=")))
        continue;
      if (this.is(o - 1, "ident", "function")) continue;
      if (++sites > ExpressionResolver.MAX_RESULT_SITES || this.work-- <= 0) return false;
      if (!this.punct(o + 1, "(")) return false;
      const close = this.match[o + 1]!;
      if (close < 0) return false;
      const start =
        this.punct(o - 1, ".") || this.punct(o - 1, "?.") ? this.receiverStart(o - 1) : o;
      if (start === null) return false;
      // discarded: `get();`
      const lead = this.tokens[start - 1];
      if (
        (!lead || (lead.type === "punct" && /^(;|\{|\})$/.test(lead.value))) &&
        this.valueEndsAt(close + 1, close)
      )
        continue;
      if (!this.punct(start - 1, "=") || !this.valueEndsAt(close + 1, close)) return false;
      // `const { A } = get()`: destructured, read only
      if (this.punct(start - 2, "}") || this.punct(start - 2, "]")) {
        const opened = this.opener[start - 2]!;
        if (opened > 0 && /^(const|let|var)$/.test(this.tokens[opened - 1]?.value ?? "")) continue;
        return false;
      }
      // `const r = get()`: r must be unchanged
      if (!declaredAt(this.tokens, start - 2)) return false;
      if (!unchanged(this.tokens[start - 2]!.value, start - 2)) return false;
    }
    return true;
  }

  /** The bracket of the kind `[` or `{` that holds the element at j directly, or -1. */
  private containerOf(j: number, kind: "[" | "{"): number {
    for (let i = j - 1, steps = 0; i >= 0 && steps < 4000; i--, steps++) {
      const t = this.tokens[i]!;
      if (t.type !== "punct") continue;
      if (t.value === ")" || t.value === "]" || t.value === "}") {
        i = this.opener[i]!;
        if (i === -1) return -1;
      } else if (t.value === "(" || t.value === "[" || t.value === "{")
        return t.value === kind ? i : -1;
    }
    return -1;
  }

  /**
   * The name at j is the value, or a whole branch of the value, of a declaration: `const X2 = T`,
   * `const y = T || {}`, `const z = x ? T : null`. The declared name and its token, or null.
   */
  private aliasAt(j: number): { name: string; at: number } | null {
    const before = this.tokens[j - 1];
    const after = this.tokens[j + 1];
    if (!(before?.type === "punct" && /^(=|\|\||&&|\?\?|\?|:)$/.test(before.value))) return null;
    if (
      after &&
      !(after.type === "punct" && /^(;|,|\|\||&&|\?\?|:|\})$/.test(after.value)) &&
      after.line === this.tokens[j]!.line
    )
      return null;
    // back to the `=` of the declaration, within the same brackets
    for (let i = j - 1, steps = 0; i >= 1 && steps < 64; i--, steps++) {
      const t = this.tokens[i]!;
      if (t.type === "punct" && (t.value === ")" || t.value === "]" || t.value === "}")) {
        const o = this.opener[i]!;
        if (o === -1) return null;
        i = o;
        continue;
      }
      if (t.type === "punct" && /^(;|,|\(|\[|\{)$/.test(t.value)) return null;
      if (t.type === "punct" && t.value === "=") {
        const declared = this.tokens[i - 1];
        if (declared?.type !== "ident" || !declaredAt(this.tokens, i - 1)) return null;
        return { name: declared.value, at: i - 1 };
      }
    }
    return null;
  }

  /**
   * The name at j is a whole argument of a call known to only read its arguments: `console.*`,
   * `JSON.stringify`, `String`, `Array.isArray`, `Object.freeze` / `isFrozen` / `keys` /
   * `entries` / `values`.
   */
  private readOnlyArgument(j: number): boolean {
    if (!(this.punct(j - 1, "(") || this.punct(j - 1, ","))) return false;
    if (!(this.punct(j + 1, ",") || this.punct(j + 1, ")"))) return false;
    // the `(` of the call: back over the arguments before it
    let open = j - 1;
    for (let guard = 0; this.punct(open, ",") && guard < 32; guard++) {
      let i = open - 1;
      for (let steps = 0; i >= 0 && steps < 400; steps++, i--) {
        const t = this.tokens[i]!;
        if (t.type !== "punct") continue;
        if (t.value === ")" || t.value === "]" || t.value === "}") {
          i = this.opener[i]!;
          if (i === -1) return false;
        } else if (t.value === "(" || t.value === "," || t.value === "[" || t.value === "{") break;
      }
      open = i;
    }
    if (!this.punct(open, "(")) return false;
    const name = this.tokens[open - 1];
    if (name?.type !== "ident") return false;
    if (this.punct(open - 2, ".") && this.is(open - 3, "ident") && !this.punct(open - 4, ".")) {
      const base = this.tokens[open - 3]!.value;
      if (base === "console") return true;
      if (base === "JSON") return name.value === "stringify";
      if (base === "Array") return name.value === "isArray";
      if (base === "Object")
        return /^(freeze|isFrozen|isSealed|isExtensible|keys|entries|values|getOwnPropertyNames|getOwnPropertyDescriptors|getOwnPropertySymbols)$/.test(
          name.value,
        );
      return false;
    }
    // `String(T)`, `structuredClone(T)` (a copy: the table itself is not changed)
    return /^(String|structuredClone)$/.test(name.value) && !this.punct(open - 2, ".");
  }

  /** A whole argument after the first of `Object.assign(target, …)`: read, never written. */
  private assignSource(j: number): boolean {
    if (!this.punct(j - 1, ",") || !(this.punct(j + 1, ",") || this.punct(j + 1, ")")))
      return false;
    let i = j - 1;
    for (let steps = 0; i >= 0 && steps < 2000; steps++, i--) {
      const t = this.tokens[i]!;
      if (t.type !== "punct") continue;
      if (t.value === ")" || t.value === "]" || t.value === "}") {
        const o = this.opener[i]!;
        if (o === -1) return false;
        i = o;
      } else if (t.value === "(") break;
      else if (t.value === "[" || t.value === "{" || t.value === ";") return false;
    }
    return (
      this.punct(i, "(") &&
      this.is(i - 1, "ident", "assign") &&
      this.punct(i - 2, ".") &&
      this.is(i - 3, "ident", "Object")
    );
  }

  /**
   * For a name at j that is a whole argument of a plain call `f(…, NAME, …)` of a function f
   * declared once in this file: that function and the argument's index.
   */
  private localCallArgument(j: number): { def: FnDef; index: number } | null {
    if (!(this.punct(j - 1, "(") || this.punct(j - 1, ","))) return null;
    if (!(this.punct(j + 1, ",") || this.punct(j + 1, ")"))) return null;
    let index = 0;
    let i = j - 1;
    for (let steps = 0; i >= 0 && steps < 2000; steps++, i--) {
      const t = this.tokens[i]!;
      if (t.type !== "punct") continue;
      if (t.value === ")" || t.value === "]" || t.value === "}") {
        const o = this.opener[i]!;
        if (o === -1) return null;
        i = o;
      } else if (t.value === ",") index++;
      else if (t.value === "(") break;
      else if (t.value === "[" || t.value === "{" || t.value === ";") return null;
    }
    if (!this.punct(i, "(") || !this.is(i - 1, "ident") || this.punct(i - 2, ".")) return null;
    if (this.is(i - 2, "ident", "new")) return null;
    const callee = this.tokens[i - 1]!.value;
    const defs = this.functions().filter((d) => d.name === callee && d.owner === null && !d.member);
    if (defs.length !== 1 || defs[0]!.paramsAt === i) return null;
    return { def: defs[0]!, index };
  }

  /**
   * Whether the token at j is inside the arguments of `new X(…)` (also nested in object literals
   * there), with X not a class or function of this file: `new BrowserWindow({ webPreferences:
   * prefs })`. A constructor of a library (Electron's windows) reads its options; one written
   * here could change them, so that use stays an escape.
   */
  private externalConstructorArgument(j: number): boolean {
    let i = j - 1;
    for (let levels = 0, steps = 0; i >= 0 && levels < 8 && steps < 4000; steps++) {
      const t = this.tokens[i]!;
      if (t.type === "punct") {
        if (t.value === ")" || t.value === "]" || t.value === "}") {
          const o = this.opener[i]!;
          if (o === -1) return false;
          i = o - 1;
          continue;
        }
        if (t.value === ";") return false;
        if (t.value === "(" || t.value === "[" || t.value === "{") {
          if (t.value === "{" && (this.punct(i - 1, "=>") || this.punct(i - 1, ")"))) return false;
          if (t.value === "(" && this.is(i - 1, "ident")) {
            const ctor = this.tokens[i - 1]!.value;
            const named = this.is(i - 2, "ident", "new")
              ? ctor
              : this.punct(i - 2, ".") && this.is(i - 4, "ident", "new")
                ? ctor
                : null;
            if (named === null) return false;
            const local =
              this.classRanges().some((c) => c.name === named) ||
              this.functions().some((d) => d.name === named);
            return !local;
          }
          levels++;
        }
      }
      i--;
    }
    return false;
  }

  /** Whether a function around j, inside `owner` (or anywhere), binds the name itself. */
  private boundBetween(j: number, name: string, owner: FnDef | null): boolean {
    for (let d = this.enclosing(j), guard = 0; d && d !== owner && guard < 20; guard++) {
      if (this.paramIndex(d, name) !== -1 || this.declarationIn(d, name, j)) return true;
      d = this.enclosing(d.paramsAt - 1);
    }
    return false;
  }

  /**
   * Whether the name at j is exported as it is: `export { T }`, `export default T`,
   * `exports.K = T`, `module.exports = T`, an entry of `X.exports = { … }`.
   */
  private exportedAt(j: number): boolean {
    if (this.is(j - 1, "ident", "default") && this.is(j - 2, "ident", "export")) return true;
    if (this.punct(j - 1, "=") && this.is(j - 2, "ident") && this.punct(j - 3, ".")) {
      if (this.is(j - 2, "ident", "exports")) return true;
      if (this.is(j - 4, "ident", "exports")) return true;
    }
    if (!(this.punct(j + 1, ",") || this.punct(j + 1, "}") || this.is(j + 1, "ident", "as")))
      return false;
    // the object or list the entry is in
    let open = j - 1;
    if (this.punct(open, ":") && (this.is(open - 1, "ident") || this.is(open - 1, "string")))
      open -= 2;
    for (let steps = 0; open >= 0 && steps < 4000; steps++) {
      if (this.punct(open, "{")) break;
      if (this.punct(open, "}") || this.punct(open, ")") || this.punct(open, "]")) {
        const o = this.opener[open]!;
        if (o === -1) return false;
        open = o - 1;
        continue;
      }
      if (this.punct(open, "(") || this.punct(open, "[") || this.punct(open, ";")) return false;
      open--;
    }
    if (!this.punct(open, "{")) return false;
    if (this.is(open - 1, "ident", "export")) return true;
    return (
      this.punct(open - 1, "=") &&
      this.is(open - 2, "ident", "exports") &&
      this.punct(open - 3, ".")
    );
  }

  /** Whether the name is assigned, changed or written to anywhere but at token `decl`. */
  private writtenElsewhere(name: string, decl: number): boolean {
    // written through another name for it (`var c = {…}, o = c; o.A = …`)
    this.topDeclarations();
    if (this.s.writtenThrough?.has(name)) return true;
    for (const j of this.positions(name)) {
      if (j === decl || this.punct(j - 1, ".")) continue;
      if ((this.punct(j + 1, "=") && !this.punct(j + 2, "=")) || this.changes(j)) return true;
      if (this.writesAt(j)) return true;
    }
    return false;
  }

  /**
   * Whether the use of a name at k (not after a `.`) writes to what it holds: a member or element
   * of it, at any depth (`T.k = …`, `T[k] += …`, `R[0].channel = …`, `T.a.b++`), `delete T.k`,
   * a mutating method (`push`, `splice`, `set`, …) on it or on a member of it,
   * `Object.assign` / `defineProperty` / `defineProperties` / `setPrototypeOf` and
   * `Reflect.set` / `defineProperty` / `deleteProperty` / `setPrototypeOf` with it as the target,
   * and, for a list, a member write to a loop variable or callback parameter that runs over it
   * (`for (const r of R) r.channel = …`, `R.forEach((r) => { r.kind = … })`). An assignment to
   * the name itself is not looked at here.
   */
  private writesAt(k: number, element = false): boolean {
    const tokens = this.tokens;
    if (this.is(k - 1, "ident", "delete")) return true;
    // `T.a = …`, `T.a += …`, `T[k]++`, `[T.a] = …`, `({ k: T.a } = …)`, `for (T.a of …)`
    if (writesMember(tokens, k) !== null) return true;
    if (
      this.punct(k - 1, "(") &&
      this.is(k - 2, "ident") &&
      /^(assign|defineProperty|defineProperties|setPrototypeOf|set|deleteProperty)$/.test(
        tokens[k - 2]!.value,
      ) &&
      this.punct(k - 3, ".") &&
      (this.is(k - 4, "ident", "Object") || this.is(k - 4, "ident", "Reflect")) &&
      // the target itself or a member of it: `Object.assign(R[0], …)`, `Reflect.set(T.a, …)`
      (this.punct(chainEnd(tokens, k), ",") || this.punct(chainEnd(tokens, k), ")"))
    )
      return true;
    let j = k + 1;
    let members = 0;
    for (let guard = 0; guard < 32; guard++) {
      if ((this.punct(j, ".") || this.punct(j, "?.")) && this.is(j + 1, "ident")) {
        // `T.push(…)`, `T.splice?.(0, 1)`, `T[0].list.push(…)`
        if (
          MUTATORS.test(tokens[j + 1]!.value) &&
          (this.punct(j + 2, "(") || (this.punct(j + 2, "?.") && this.punct(j + 3, "(")))
        )
          return true;
        j += 2;
        members++;
      } else if (this.punct(j, "?.") && this.punct(j + 1, "[") && this.match[j + 1] !== -1) {
        j = this.match[j + 1]! + 1;
        members++;
      } else if (this.punct(j, "[") && this.match[j] !== -1) {
        j = this.match[j]! + 1;
        members++;
      } else break;
    }
    if (members > 0) {
      const t = tokens[j];
      if (t?.type === "punct" && ASSIGNS.has(t.value)) return true;
      if (
        this.punct(j, "++") ||
        this.punct(j, "--") ||
        this.punct(k - 1, "++") ||
        this.punct(k - 1, "--")
      )
        return true;
    }
    if (element) return false;
    // `for (const r of R) …`: the loop variable is each element; also over `R.entries()` and
    // `R.values()`, where it is a name in the pattern (`for (const [i, r] of R.entries())`)
    const listed =
      this.punct(k + 1, ".") &&
      /^(entries|values)$/.test(tokens[k + 2]?.value ?? "") &&
      this.punct(k + 3, "(") &&
      this.punct(k + 4, ")")
        ? k + 5
        : k + 1;
    if (this.is(k - 1, "ident", "of") && this.punct(listed, ")")) {
      const close = listed;
      const open = this.opener[close]!;
      if (open > 0 && this.is(open - 1, "ident", "for")) {
        let v = open + 1;
        if (/^(const|let|var)$/.test(tokens[v]?.value ?? "")) v++;
        const names: string[] = [];
        if (this.is(v, "ident") && v + 1 === k - 1) names.push(tokens[v]!.value);
        else if ((this.punct(v, "[") || this.punct(v, "{")) && this.match[v] === k - 2)
          for (let p = v + 1; p < k - 2; p++)
            if (this.is(p, "ident") && !this.punct(p + 1, ":")) names.push(tokens[p]!.value);
        const end = this.punct(close + 1, "{") ? this.match[close + 1]! : this.exprEnd(close + 1);
        for (const name of names) if (this.writesMember(name, close + 1, end)) return true;
      }
    }
    // `R.forEach((r) => …)`, `R.map(function (r) { … })`: the parameter is each element
    if (
      this.punct(k + 1, ".") &&
      this.is(k + 2, "ident") &&
      /^(forEach|map|filter|find|findLast|some|every|reduce|flatMap)$/.test(tokens[k + 2]!.value) &&
      this.punct(k + 3, "(")
    ) {
      const close = this.match[k + 3]!;
      let p = k + 4;
      if (this.is(p, "ident", "async")) p++;
      if (this.is(p, "ident", "function")) {
        p++;
        if (this.is(p, "ident")) p++;
      }
      // the element is the first parameter (the second of `reduce`)
      const second = tokens[k + 2]!.value === "reduce";
      let name: string | null = null;
      if (this.is(p, "ident") && this.punct(p + 1, "=>") && !second) name = tokens[p]!.value;
      else if (this.punct(p, "(")) {
        const at = second ? p + 3 : p + 1;
        if (this.is(at, "ident") && (!second || this.punct(p + 2, ","))) name = tokens[at]!.value;
      }
      if (name !== null && close !== -1 && this.writesMember(name, p, close)) return true;
      // `R.forEach(tweak)`: a function of this file that writes its parameter, or a callee
      // that is not read
      if (this.is(k + 4, "ident") && this.punct(k + 5, ")") && !second) {
        const callee = tokens[k + 4]!.value;
        if (!READ_ONLY_CALLBACKS.has(callee) && this.calleeWritesFirst(callee)) return true;
      }
    }
    return false;
  }

  /**
   * Whether the function declared as `function NAME(p, …) { … }` in this file writes a member of
   * its first parameter; true when there is no such single declaration to read.
   */
  private calleeWritesFirst(name: string): boolean {
    let found: number | null = null;
    for (const j of this.positions(name)) {
      if (!this.is(j - 1, "ident", "function") || !this.punct(j + 1, "(")) continue;
      if (found !== null) return true;
      found = j;
    }
    if (found === null) return true;
    const open = found + 1;
    const close = this.match[open]!;
    if (close === -1 || !this.punct(close + 1, "{")) return true;
    if (close === open + 1) return false;
    if (!this.is(open + 1, "ident")) return true;
    const end = this.match[close + 1]!;
    return end === -1 || this.writesMember(this.tokens[open + 1]!.value, close + 1, end);
  }

  /**
   * A member write (see `writesAt`) to the name anywhere in [from, to), also through another
   * name for it there (`const x = r; x.channel = …`), a few links deep.
   */
  private writesMember(name: string, from: number, to: number, links = 0): boolean {
    for (const j of this.occurrences(name, from, to)) {
      if (this.work-- <= 0) return true;
      if (this.punct(j - 1, ".") || this.punct(j - 1, "?.")) continue;
      if (this.writesAt(j, true)) return true;
      // `const x = r;`, `x = r,`: x is the same object
      if (
        this.punct(j - 1, "=") &&
        this.is(j - 2, "ident") &&
        !this.punct(j - 3, ".") &&
        (this.punct(j + 1, ";") ||
          this.punct(j + 1, ",") ||
          this.punct(j + 1, ")") ||
          this.punct(j + 1, "}"))
      ) {
        if (links >= 3) return true;
        if (this.writesMember(this.tokens[j - 2]!.value, j + 1, to, links + 1)) return true;
      }
    }
    return false;
  }

  /**
   * The values of the expression at token k for each way the function around it is called:
   * one value when it uses no parameter of that function, one per readable call site when it
   * does. `partial`: a call site could not be read, so its value is not among them.
   */
  valuesAt(k: number): { values: Val[]; partial: boolean } {
    return this.guarded({ values: [], partial: true }, () => this.valuesAtIn(k));
  }

  private valuesAtIn(k: number): { values: Val[]; partial: boolean } {
    if (this.work <= 0) return { values: [], partial: true };
    this.begin(40_000);
    this.partial = false;
    this.cut = false;
    const end = this.exprEnd(k);
    const def = this.enclosing(k);
    const usesParameter =
      def !== null &&
      def.name !== null &&
      (() => {
        for (let j = k; j < end; j++)
          if (
            this.is(j, "ident") &&
            !this.punct(j - 1, ".") &&
            this.paramIndex(def, this.tokens[j]!.value) !== -1
          )
            return true;
        return false;
      })();
    if (!usesParameter) {
      const v = this.evalRange(k, end, new Map(), 0);
      return { values: v ? [v] : [], partial: false };
    }
    const envs = this.bindings(def!, 0) ?? [];
    const values: Val[] = [];
    let partial = envs.length === 0;
    for (const env of envs) {
      const v = this.evalRange(k, end, env, 1);
      if (v) values.push(v);
      else partial = true;
    }
    return { values, partial: partial || this.partial };
  }

  /**
   * The value this module exports under a name: `exports.NAME = …` (the last assignment that is
   * not `void 0`), `module.exports = { NAME: … }`, `export const NAME = …`, `export function NAME`.
   */
  exportValue(name: string, depth: number): Val | null {
    if (depth > MAX_DEPTH) return null;
    if (!this.s.exportIndex) {
      const index = new Map<string, [number, number]>();
      const tokens = this.tokens;
      for (let k = 0; k + 3 < tokens.length; k++) {
        const t = tokens[k]!;
        if (t.type !== "ident") continue;
        let at = -1;
        // exports.NAME = / module.exports.NAME =
        if (t.value === "exports" && !this.punct(k - 1, ".") && this.punct(k + 1, ".")) at = k + 2;
        else if (
          t.value === "module" &&
          this.punct(k + 1, ".") &&
          this.is(k + 2, "ident", "exports") &&
          this.punct(k + 3, ".")
        )
          at = k + 4;
        if (
          at !== -1 &&
          this.is(at, "ident") &&
          this.punct(at + 1, "=") &&
          !this.punct(at + 2, "=")
        ) {
          const value = at + 2;
          const isVoid = this.is(value, "ident", "void") && this.tokens[value + 1]?.value === "0";
          if (!isVoid) index.set(tokens[at]!.value, [value, this.exprEnd(value)]);
          continue;
        }
        // module.exports = { … }
        if (
          t.value === "module" &&
          this.punct(k + 1, ".") &&
          this.is(k + 2, "ident", "exports") &&
          this.punct(k + 3, "=") &&
          this.punct(k + 4, "{")
        ) {
          const close = this.match[k + 4]!;
          for (let j = k + 5; j < close;) {
            const key = this.tokens[j]!;
            const end = Math.min(this.exprEnd(j), close);
            if (key.type === "ident" && this.punct(j + 1, ":")) index.set(key.value, [j + 2, end]);
            else if (key.type === "ident" && end === j + 1) index.set(key.value, [j, j + 1]);
            j = end + 1;
          }
          continue;
        }
        // export const NAME = … / export function NAME
        if (t.value === "export") {
          if (
            /^(const|let|var)$/.test(tokens[k + 1]?.value ?? "") &&
            this.is(k + 2, "ident") &&
            this.punct(k + 3, "=")
          )
            index.set(tokens[k + 2]!.value, [k + 4, this.exprEnd(k + 4)]);
          else if (this.is(k + 1, "ident", "function") && this.is(k + 2, "ident"))
            index.set(tokens[k + 2]!.value, [k + 2, k + 3]);
        }
      }
      this.s.exportIndex = index;
    }
    const range = this.s.exportIndex.get(name);
    if (!range) return null;
    return this.evalRange(range[0], range[1], new Map(), depth + 1);
  }

  /** Name of the innermost named function around token k. */
  enclosingName(k: number): string | null {
    return this.enclosing(k)?.name ?? null;
  }

  private positions(name: string): number[] {
    if (!this.s.names) {
      const names = new Map<string, number[]>();
      for (let k = 0; k < this.tokens.length; k++) {
        const t = this.tokens[k]!;
        if (t.type !== "ident") continue;
        const list = names.get(t.value);
        if (list) list.push(k);
        else names.set(t.value, [k]);
      }
      this.s.names = names;
    }
    return this.s.names.get(name) ?? [];
  }

  /** Positions of `name` in [from, to), by binary search over the name index. */
  private occurrences(name: string, from: number, to: number): number[] {
    const all = this.positions(name);
    let lo = 0;
    let hi = all.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (all[mid]! < from) lo = mid + 1;
      else hi = mid;
    }
    const out: number[] = [];
    for (let i = lo; i < all.length && all[i]! < to; i++) out.push(all[i]!);
    this.work -= out.length + 1;
    return out;
  }

  /** `NAME = new cls(` sites of the file, with the index of the `(`. */
  private instancesOf(cls: string): Array<{ name: string; open: number }> {
    let found = this.newSites.get(cls);
    if (!found) {
      found = [];
      for (const k of this.positions(cls))
        if (
          this.is(k - 1, "ident", "new") &&
          this.punct(k + 1, "(") &&
          this.punct(k - 2, "=") &&
          this.is(k - 3, "ident")
        )
          found.push({ name: this.tokens[k - 3]!.value, open: k + 1 });
      this.newSites.set(cls, found);
    }
    return found;
  }

  // ---------- expressions ----------

  /**
   * The value of [start, end). Inside an evaluated body, an expression that cannot be read and
   * may have effects (a call, an assignment, `++`, `delete`, `new`, `await`) marks the question:
   * what it did is not known, so the body stops after the statement (see `run`).
   */
  private evalRange(start: number, end: number, env: Env, depth: number): Val | null {
    const v = this.evalRangeIn(start, end, env, depth);
    if (v === null && this.inBody > 0 && !this.effectUnknown && this.mayHaveEffects(start, end))
      this.effectUnknown = true;
    return v;
  }

  /** Whether evaluating [start, end) may change something: a call, an assignment, `delete`, … */
  private mayHaveEffects(start: number, end: number): boolean {
    this.bodyWork -= end - start;
    for (let j = start; j < end; j++) {
      const t = this.tokens[j]!;
      if (t.type === "ident") {
        if (/^(delete|new|await|yield|import)$/.test(t.value)) return true;
        continue;
      }
      if (t.type !== "punct") continue;
      if (t.value === "(") {
        const before = this.tokens[j - 1];
        if (j === start || !before) continue;
        // a call: `f(`, `a.b(`, `f()(`, `a[0](`, a tagged template's function
        if (
          (before.type === "ident" &&
            !/^(function|if|for|while|switch|catch|return|typeof|void|of|in|instanceof|case|else|do|throw)$/.test(
              before.value,
            )) ||
          (before.type === "punct" && (before.value === ")" || before.value === "]")) ||
          before.type === "template"
        )
          return true;
      } else if (
        t.value === "=" ||
        t.value === "++" ||
        t.value === "--" ||
        /^(?:[-+*/%&|^]|\*\*|<<|>>>?|&&|\|\||\?\?)=$/.test(t.value)
      )
        return true;
    }
    return false;
  }

  private evalRangeIn(start: number, end: number, env: Env, depth: number): Val | null {
    if (start >= end) return null;
    if (this.budget-- <= 0 || (this.inBody && this.bodyWork-- <= 0)) return this.stop("work limit");
    if (depth > MAX_DEPTH) return this.stop("depth limit");
    // ( … ) around the whole range, in a loop: deep parentheses must not grow the stack
    while (this.punct(start, "(") && this.match[start] === end - 1) {
      start++;
      end--;
      if (start >= end) return null;
      if (this.budget-- <= 0) return this.stop("work limit");
    }
    // `!0`, `!1`: what minifiers write for true and false
    if (
      end === start + 2 &&
      this.punct(start, "!") &&
      this.tokens[start + 1]?.type === "number" &&
      /^[01]$/.test(this.tokens[start + 1]!.value)
    )
      return {
        kind: "bool",
        value: this.tokens[start + 1]!.value === "0",
        src: { file: this.file, line: this.tokens[start]!.line },
      };
    // an arrow function: `(a) => …`, `a => …`
    if (
      (this.punct(start, "(") && this.punct(this.match[start]! + 1, "=>")) ||
      (this.is(start, "ident") && this.punct(start + 1, "=>"))
    )
      return this.arrowAt(start, env);
    // `a ?? b`: b when a is undefined, a when a is known to be something else
    for (let j = start; j < end; j++) {
      const t = this.tokens[j]!;
      if (t.type !== "punct") continue;
      if ((t.value === "(" || t.value === "[" || t.value === "{") && this.match[j]! !== -1) {
        j = this.match[j]!;
        continue;
      }
      if (t.value === "?" || t.value === "||" || t.value === "&&") break;
      if (t.value === "??") {
        // operands at the same depth, as the parts of a `+` are
        const left = this.evalRange(start, j, env, depth);
        if (left?.kind === "undef") return this.evalRange(j + 1, end, env, depth);
        return left;
      }
    }
    // split at top-level `+`; any other top-level operator makes the value unknown
    const parts: Array<[number, number]> = [];
    let from = start;
    for (let j = start; j < end; j++) {
      const t = this.tokens[j]!;
      if (t.type === "punct") {
        if ((t.value === "(" || t.value === "[" || t.value === "{") && this.match[j]! !== -1) {
          j = this.match[j]!;
          continue;
        }
        if (t.value === "+") {
          parts.push([from, j]);
          from = j + 1;
        } else if (t.value !== "." && t.value !== "?.") return null;
      }
    }
    parts.push([from, end]);
    if (parts.length === 1) return this.evalOperand(start, end, env, depth);
    const strings: string[][] = [];
    let known = 0;
    for (const [a, b] of parts) {
      const v = this.evalOperand(a, b, env, depth);
      if (v?.kind === "str") {
        strings.push(v.values);
        known++;
      } else if (this.gaps) strings.push(["${…}"]);
      else return null;
    }
    if (!known) return null;
    const values = product(strings);
    if (!values) return this.stop("too many values");
    this.note("concatenation");
    return { kind: "str", values };
  }

  private evalOperand(start: number, end: number, env: Env, depth: number): Val | null {
    const t = this.tokens[start];
    if (!t) return null;
    if (t.type === "string") {
      const text: Val = { kind: "str", values: [t.value], src: { file: this.file, line: t.line } };
      // `"a_b".split("_")`: methods of the literal itself
      return end === start + 1 ? text : this.chain(text, start + 1, end, env, depth);
    }
    if (t.type === "template") return this.evalTemplate(start, end, env, depth);
    if (t.type === "punct" && t.value === "[") {
      const close = this.match[start]!;
      if (close === -1 || close >= end) return null;
      const cut = { more: false };
      const elems = this.list(start, close, env, depth, cut);
      const arr: Val = cut.more
        ? { kind: "arr", elems, line: t.line, more: true }
        : { kind: "arr", elems, line: t.line };
      // `[…].map(…)`: methods of the list itself
      return close === end - 1 ? arr : this.chain(arr, close + 1, end, env, depth);
    }
    if (t.type === "punct" && t.value === "{") {
      const close = this.match[start]!;
      if (close !== end - 1) return null;
      return this.object(start, close, env, depth);
    }
    if (t.type === "punct" && t.value === "(") {
      // an arrow function value: `(a, b) => …`
      const close = this.match[start]!;
      if (close === -1) return null;
      if (this.punct(close + 1, "=>")) return this.arrowAt(start, env);
      // `(a, b)`: the last expression, as compilers write `(0, ns.fn)(…)`; then members and calls
      let last = start + 1;
      for (let j = start + 1; j < close; j = Math.min(this.exprEnd(j), close) + 1) last = j;
      const inner = this.evalRange(last, Math.min(this.exprEnd(last), close), env, depth + 1);
      return this.chain(inner, close + 1, end, env, depth);
    }
    if (t.type !== "ident") return null;
    if (this.is(start + 1, "punct", "=>")) return this.arrowAt(start, env);
    if ((t.value === "true" || t.value === "false") && end === start + 1)
      return { kind: "bool", value: t.value === "true", src: { file: this.file, line: t.line } };
    if (
      (t.value === "undefined" && end === start + 1) ||
      (t.value === "void" && end === start + 2 && this.tokens[start + 1]?.value === "0")
    )
      return { kind: "undef" };
    // `function (a) { … }` as a value, as `forEach` and `map` callbacks are written
    if (t.value === "function") {
      const p = this.is(start + 1, "ident") ? start + 2 : start + 1;
      const fn = this.punct(p, "(") ? this.arrowAt(p, env) : null;
      return fn?.kind === "fn" && fn.def.body[1] === end ? fn : null;
    }
    // `Object.fromEntries(LIST)`: an object of the list's `[key, value]` pairs
    if (
      t.value === "Object" &&
      this.punct(start + 1, ".") &&
      this.is(start + 2, "ident", "fromEntries") &&
      this.punct(start + 3, "(")
    ) {
      const close = this.match[start + 3]!;
      if (close === -1 || close >= end) return null;
      const list = this.evalRange(start + 4, this.lastArgEnd(start + 3, close), env, depth + 1);
      if (list?.kind !== "arr" || list.more)
        return this.stop("Object.fromEntries of a list that is not known whole");
      const props = new Map<string, Val | null>();
      for (const e of list.elems) {
        const key = e?.kind === "arr" ? this.oneString(e.elems[0] ?? null) : null;
        if (key === null || e?.kind !== "arr") return this.stop("a computed key is not known");
        if (unordered(key)) return this.stop("a key JavaScript orders or treats apart");
        // a repeated key keeps its first place, as in JavaScript
        props.set(key, e.elems.length > 1 ? (e.elems[1] ?? null) : { kind: "undef" });
      }
      this.note("evaluated");
      return this.chain({ kind: "obj", props }, close + 1, end, env, depth);
    }
    // `new URL(path, base)`: the address the URL constructor builds, when both are known
    const urlOpen = t.value === "new" ? this.urlConstructor(start + 1) : -1;
    if (urlOpen !== -1) {
      const close = this.match[urlOpen]!;
      if (close === -1 || close >= end) return null;
      const [path, base] = this.list(urlOpen, close, env, depth);
      if (path?.kind !== "str" || (base && base.kind !== "str")) return null;
      const out: string[] = [];
      // A gap in the path (`boards/${…}`) is carried through as a placeholder when gaps are
      // shown; a gap in the base decides the origin, so the address stays unknown.
      // Letters and underscores only: the URL parser neither encodes nor strips them.
      const GAP = "__hexvero_gap__";
      for (const p of path.values)
        for (const b of base?.kind === "str" ? base.values : [undefined]) {
          if (b?.includes("${…}") || (p + (b ?? "")).includes("\u0001")) return null;
          if (p.includes("${…}") && (!this.gaps || p.includes(GAP))) return null;
          // A gap before any `/` may be a whole address of its own (`${host}/x`): its origin is
          // not known.
          if (p.includes("${…}") && !p.split("${…}")[0]!.includes("/")) return null;
          try {
            const href = new URL(p.replaceAll("${…}", GAP), b).href;
            // The placeholder must survive as written, as often as it was put in, and only in
            // the path: anything else is not this address.
            const count = (text: string): number => text.split(GAP).length - 1;
            const url = new URL(href);
            if (count(href) !== count(p.replaceAll("${…}", GAP)) || count(url.origin)) return null;
            const back = href.replaceAll(GAP, "${…}");
            out.push(back);
          } catch {
            return null;
          }
        }
      return this.chain({ kind: "str", values: out }, close + 1, end, env, depth);
    }
    if (t.value === "new" && this.is(start + 1, "ident", "Map") && this.punct(start + 2, "(")) {
      const close = this.match[start + 2]!;
      if (close !== end - 1) return null;
      const arg = this.evalRange(start + 3, close, env, depth + 1);
      if (arg?.kind !== "arr") return null;
      const entries: Array<[Val | null, Val | null]> = arg.elems.map((e) =>
        e?.kind === "arr" && e.elems.length === 2 ? [e.elems[0]!, e.elems[1]!] : [null, null],
      );
      return { kind: "map", entries, line: t.line };
    }
    // Object.entries(x), Object.keys(x), Object.values(x) of an object that is fully known
    if (
      t.value === "Object" &&
      this.punct(start + 1, ".") &&
      this.is(start + 2, "ident") &&
      /^(entries|keys|values)$/.test(this.tokens[start + 2]!.value) &&
      this.punct(start + 3, "(")
    ) {
      const close = this.match[start + 3]!;
      if (close === -1 || close >= end) return null;
      const o = this.evalRange(start + 4, this.lastArgEnd(start + 3, close), env, depth + 1);
      if (o?.kind !== "obj" || o.open) return null;
      const how = this.tokens[start + 2]!.value;
      const elems: Array<Val | null> = [...o.props].map(([key, v]) =>
        how === "keys"
          ? { kind: "str", values: [key] }
          : how === "values"
            ? v
            : { kind: "arr", elems: [{ kind: "str", values: [key] }, v], line: t.line },
      );
      return this.chain({ kind: "arr", elems, line: t.line }, close + 1, end, env, depth);
    }
    // a bundler's interop helper passes a module on: `__toESM(require_x())`, minified `S(E())`
    if (
      this.punct(start + 1, "(") &&
      (t.value === "__toESM" ||
        (this.is(start + 2, "ident") &&
          this.punct(start + 3, "(") &&
          this.punct(start + 4, ")") &&
          this.punct(start + 5, ")"))) &&
      this.helper(t.value) === "interop"
    ) {
      const close = this.match[start + 1]!;
      if (close === -1 || close >= end) return null;
      const firstEnd = Math.min(this.exprEnd(start + 2), close);
      const arg = this.evalRange(start + 2, firstEnd, env, depth + 1);
      // The helper's `default` is the module's `module.exports` when its second argument (node
      // mode, `__toESM(m, 1)`) is true, or when the module does not mark itself as an ES module
      // (no `__esModule`, no `__toCommonJS`, no `default` anywhere). A second argument that is
      // not a literal leaves a marked module's `default` unknown.
      const mode = firstEnd < close ? this.literalTruth(firstEnd + 1, close) : false;
      let wrapped: Val | null = arg;
      if (arg?.kind === "cjs") {
        if (mode === true || !this.marksEsModule(arg)) wrapped = { ...arg, interop: true };
        else if (mode === null) return null;
      }
      return this.chain(wrapped, close + 1, end, env, depth);
    }
    // `i(76675)`: webpack's require of a module of this file's module table
    if (
      this.punct(start + 1, "(") &&
      this.tokens[start + 2]?.type === "number" &&
      this.punct(start + 3, ")")
    ) {
      const mod = this.webpackModule(start, t.value, this.tokens[start + 2]!.value);
      if (mod) return this.chain(mod, start + 4, end, env, depth);
    }
    // `require_x()`: a module the bundler wrapped into this file
    if (this.punct(start + 1, "(") && this.punct(start + 2, ")")) {
      const mod = this.wrappedModule(t.value);
      if (mod) return this.chain(mod, start + 3, end, env, depth);
    }
    // Object.freeze(x), Object.seal(x)
    if (
      t.value === "Object" &&
      this.punct(start + 1, ".") &&
      (this.is(start + 2, "ident", "freeze") || this.is(start + 2, "ident", "seal")) &&
      this.punct(start + 3, "(")
    ) {
      const close = this.match[start + 3]!;
      if (close !== end - 1) return null;
      return this.evalRange(start + 4, this.lastArgEnd(start + 3, close), env, depth + 1);
    }
    // `Object.assign({…}, a, b, …)`: a new object, the sources' keys laid over it from left to
    // right as spreads are. Only with an object literal as the target: an object the code holds
    // elsewhere is changed by the call, and what else reads it is not followed.
    if (
      t.value === "Object" &&
      this.punct(start + 1, ".") &&
      this.is(start + 2, "ident", "assign") &&
      this.punct(start + 3, "(") &&
      this.punct(start + 4, "{")
    )
      return this.assignCall(start + 3, end, env, depth);
    // `require("./x")`: that module's exports, when it is a module of the application
    if (
      t.value === "require" &&
      this.punct(start + 1, "(") &&
      this.tokens[start + 2]?.type === "string" &&
      this.punct(start + 3, ")") &&
      (this.host || this.reference)
    ) {
      const specifier = this.tokens[start + 2]!.value;
      if (!this.host) return this.chain({ kind: "nsref", specifier }, start + 4, end, env, depth);
      const other = this.host.load(this.file, specifier);
      return this.chain(other ? { kind: "ns", resolver: other } : null, start + 4, end, env, depth);
    }
    // `path.join(__dirname, "preload.js")`, `path_1.default.resolve(…)`: the script a preload
    // path names is its last path-like literal, as the scan reads `preload:` anywhere.
    if (
      this.punct(end - 1, ")") &&
      this.opener[end - 1]! > start &&
      /^(join|resolve)$/.test(this.tokens[this.opener[end - 1]! - 1]?.value ?? "") &&
      this.punct(this.opener[end - 1]! - 2, ".")
    ) {
      const open = this.opener[end - 1]!;
      let last: Token | null = null;
      for (let j = open + 1; j < end - 1; j = Math.min(this.exprEnd(j), end - 1) + 1) {
        const a = this.tokens[j]!;
        if (a.type === "string" && this.exprEnd(j) === j + 1) last = a;
      }
      if (last && /\.(c|m)?js$/.test(last.value))
        return {
          kind: "str",
          values: [last.value.replace(/^.*[\\/]/, "")],
          src: { file: this.file, line: last.line },
        };
    }
    // `Enum.MEMBER` or `module.Enum.MEMBER`, a member of a compiled TypeScript string enum of
    // this file (the rules of `Constants.enumAt`); a name bound in the evaluation is that instead
    if (!env.has(t.value) && this.punct(start + 1, ".")) {
      const member = this.constants.enumAt(start, end, (name) => this.moduleBinding(start, name));
      if (member !== null) return { kind: "str", values: [member] };
    }
    // `Channels.SAVE` of another module, as the fast scan reads it: a reference
    if (this.constantRefs && this.reference && !env.has(t.value)) {
      let last = start;
      while (this.punct(last + 1, ".") && this.is(last + 2, "ident")) last += 2;
      if (last + 1 === end && !this.enclosingParam(start, t.value)) {
        const named = this.constants.resolve(start, end);
        if (named && "ref" in named && !named.ref.before && !named.ref.after)
          return {
            kind: "str",
            values: [this.reference(named.ref.specifier, named.ref.property)],
            ref: { specifier: named.ref.specifier, property: named.ref.property },
          };
      }
    }
    // name, name.prop, name(args), name(args)(args), name.prop(args)
    // `T[k]` with a computed key reads a table by a key the evaluation found: the table is read
    // strictly (see `strict`), so an alias, an unread callee or a deeper write that may change
    // it leaves it unknown, whichever reader asks.
    // A key named by a constant of the file (`T[KEY]`) is read as a literal key is.
    const key = this.tokens[start + 2];
    const computedKey =
      this.punct(start + 1, "[") &&
      !(key?.type === "string" && this.punct(start + 3, "]")) &&
      !(key?.type === "ident" && this.punct(start + 3, "]") && !env.has(key.value));
    let value =
      computedKey && !this.strict
        ? this.strictly(() => this.lookup(t.value, start, env, depth))
        : this.lookup(t.value, start, env, depth);
    let j = start + 1;
    // a member of a top-level table of this file: `CH.SAVE`
    if (value === null && this.punct(j, ".") && this.is(j + 1, "ident") && j + 2 === end) {
      const member = this.constants.memberOf(t.value, this.tokens[j + 1]!.value, start);
      return member === null ? null : { kind: "str", values: [member] };
    }
    return this.chain(value, j, end, env, depth);
  }

  /** Members and calls after a value: `.a`, `["a"]`, `(…)`, up to `end`. */
  private chain(start: Val | null, from: number, end: number, env: Env, depth: number): Val | null {
    let value = start;
    let j = from;
    while (j < end) {
      if (value === null) return null;
      // a method of a known string or list, from the evaluation subset
      if (
        (this.punct(j, ".") || this.punct(j, "?.")) &&
        this.is(j + 1, "ident") &&
        this.punct(j + 2, "(") &&
        ((value.kind === "str" && !value.ref) || value.kind === "arr")
      ) {
        const close = this.match[j + 2]!;
        if (close === -1 || close >= end) return null;
        value = this.builtin(value, this.tokens[j + 1]!.value, j + 2, close, env, depth);
        j = close + 1;
      } else if ((this.punct(j, ".") || this.punct(j, "?.")) && this.is(j + 1, "ident")) {
        value = this.member(value, this.tokens[j + 1]!.value, depth);
        j += 2;
      } else if (
        this.punct(j, "[") &&
        this.tokens[j + 1]?.type === "string" &&
        this.punct(j + 2, "]")
      ) {
        value = this.member(value, this.tokens[j + 1]!.value, depth);
        j += 3;
      } else if (this.punct(j, "[") && value.kind === "obj") {
        // `T[k]` with a key the evaluation knows as one whole string (a loop variable bound to
        // one key of a table): that member. Any other key is not read.
        const close = this.match[j]!;
        if (close === -1 || close >= end || close === j + 1) return null;
        const key = this.oneString(this.evalRange(j + 1, close, env, depth + 1));
        if (key === null) return null;
        value = this.member(value, key, depth);
        j = close + 1;
      } else if (this.punct(j, "(")) {
        const close = this.match[j]!;
        if (close === -1 || close >= end) return null;
        value = this.call(value, j, close, env, depth);
        j = close + 1;
      } else return null;
    }
    return value;
  }

  private evalTemplate(start: number, end: number, env: Env, depth: number): Val | null {
    const parts: string[][] = [];
    let j = start;
    while (j < end) {
      const t = this.tokens[j]!;
      if (t.type !== "template") return null;
      const dynamic = t.value.endsWith("${…}");
      parts.push([dynamic ? t.value.slice(0, -4) : t.value]);
      j++;
      if (!dynamic) break;
      // the substitution runs to the next template token at this level
      let k = j;
      while (k < end && this.tokens[k]!.type !== "template") {
        const p = this.tokens[k]!;
        if (p.type === "punct" && (p.value === "(" || p.value === "[" || p.value === "{")) {
          const m = this.match[k]!;
          if (m === -1) return null;
          k = m;
        }
        k++;
      }
      const v = this.evalRange(j, k, env, depth + 1);
      if (v?.kind === "str") parts.push(v.values);
      else if (this.gaps) parts.push(["${…}"]);
      else return null;
      j = k;
    }
    const values = product(parts);
    if (!values) return this.stop("too many values");
    if (parts.length > 1) this.note("template");
    // `` `${a}:${b}`.toLowerCase() ``: methods of the template's string
    return j === end
      ? { kind: "str", values }
      : this.chain({ kind: "str", values }, j, end, env, depth);
  }

  /**
   * Elements of `[ … ]` or arguments of `( … )` between open and close, at most 256; `cut` says
   * when there were more.
   */
  private list(
    open: number,
    close: number,
    env: Env,
    depth: number,
    cut?: { more: boolean },
  ): Array<Val | null> {
    const out: Array<Val | null> = [];
    let from = open + 1;
    while (from < close && out.length < 256) {
      const end = Math.min(this.exprEnd(from), close);
      out.push(end > from ? this.evalRange(from, end, env, depth + 1) : null);
      from = end + 1;
    }
    if (cut && from < close) cut.more = true;
    return out;
  }

  /** The token ranges of the arguments between `(` at open and `)` at close. */
  private argRanges(open: number, close: number): Array<[number, number]> {
    const out: Array<[number, number]> = [];
    for (let from = open + 1; from < close && out.length < 16;) {
      const end = Math.min(this.exprEnd(from), close);
      out.push([from, end]);
      from = end + 1;
    }
    return out;
  }

  /** `Object.assign({…}, …)` with `(` at open, ending at `end`; see evalOperand. */
  private assignCall(open: number, end: number, env: Env, depth: number): Val | null {
    const close = this.match[open]!;
    if (close !== end - 1) return null;
    const targetEnd = this.match[open + 1]!;
    if (targetEnd === -1 || this.exprEnd(open + 1) !== targetEnd + 1) return null;
    const target = this.object(open + 1, targetEnd, env, depth + 1);
    if (target.kind !== "obj") return null;
    const props = new Map(target.props);
    let unknown = target.open === true;
    for (let from = targetEnd + 2; from < close;) {
      const to = Math.min(this.exprEnd(from), close);
      if (to <= from) return null;
      // as `...source` in an object literal: something unknown may write any key here
      const source = this.evalRange(from, to, env, depth + 1);
      if (source?.kind === "obj") {
        if (source.open) {
          for (const key of props.keys()) props.set(key, null);
          unknown = true;
        }
        for (const [key, v] of source.props) props.set(key, v);
      } else if (source?.kind !== "undef") {
        for (const key of props.keys()) props.set(key, null);
        unknown = true;
      }
      if (props.size > 256) return this.stop("too many keys");
      from = to + 1;
    }
    this.note("evaluated");
    return unknown ? { kind: "obj", props, open: true } : { kind: "obj", props };
  }

  private object(open: number, close: number, env: Env, depth: number): Val {
    const props = new Map<string, Val | null>();
    let unknown = false;
    let k = open + 1;
    while (k < close && props.size < 256) {
      const t = this.tokens[k]!;
      const end = Math.min(this.exprEnd(k), close);
      if (this.punct(k, "...")) {
        // `...x`: x's keys at this place. Something unknown may write any key, so every key
        // before it is unknown, and keys not listed may exist.
        const spread = this.evalRange(k + 1, end, env, depth + 1);
        if (spread?.kind === "obj") {
          if (spread.open) {
            for (const key of props.keys()) props.set(key, null);
            unknown = true;
          }
          for (const [key, v] of spread.props) props.set(key, v);
        } else if (spread?.kind !== "undef") {
          for (const key of props.keys()) props.set(key, null);
          unknown = true;
        }
        k = end + 1;
        continue;
      }
      const key = t.type === "ident" ? t.value : t.type === "string" ? t.value : null;
      // an integer-like key is ordered before the others and `__proto__` sets the prototype:
      // the order and the keys of such an object are not modeled
      if (key !== null && unordered(key)) unknown = true;
      if (key !== null && this.punct(k + 1, ":")) {
        // a repeated key keeps its first place, as in JavaScript
        props.set(key, this.evalRange(k + 2, end, env, depth + 1));
      } else if (key !== null && end === k + 1) {
        props.set(key, this.lookup(key, k, env, depth + 1));
      } else if (key !== null) {
        // a method or a computed value; `get NAME()`, `set NAME()`, `async NAME()` name NAME
        // (`get()` is a method named get). Any other accessor or async member (`get [k]()`,
        // `async *gen()`, `get 1()`) is not named here: it may be any key, also one written
        // before, which it then replaces.
        const accessor =
          (key === "get" || key === "set" || key === "async") && !this.punct(k + 1, "(");
        const after = this.tokens[k + 1];
        const named =
          (after?.type === "ident" || after?.type === "string") && this.punct(k + 2, "(");
        if (!accessor) props.set(key, null);
        else if (named) props.set(after.value, null);
        else {
          for (const earlier of props.keys()) props.set(earlier, null);
          unknown = true;
        }
      } else if (t.type === "number") unknown = true;
      else {
        // `[name]: …`: the key it evaluates to, when that is one string; any other computed key
        // (or `*gen()`) may be any key, also one written before, which it then replaces
        const bracket = this.punct(k, "[") ? this.match[k]! : -1;
        // `[NAME]` with NAME a loop variable, a `catch` binding or a parameter this evaluation
        // has no value for: not a constant of the same name further out
        const inner = this.tokens[k + 1];
        const shadowed =
          bracket === k + 2 &&
          inner?.type === "ident" &&
          !env.has(inner.value) &&
          (() => {
            const near = this.boundAround(k + 1, inner.value);
            return (
              near !== null &&
              (near.kind === "param" ||
                !near.site ||
                !this.punct(near.site.name + 1, "=") ||
                this.is(near.site.name + 2, "ident", "of") ||
                this.is(near.site.name + 1, "ident", "of") ||
                this.is(near.site.name + 1, "ident", "in"))
            );
          })();
        const name =
          bracket > k && !shadowed ? this.evalRange(k + 1, bracket, env, depth + 1) : null;
        const single =
          name?.kind === "str" && name.values.length === 1 && !name.values[0]!.includes("${")
            ? name.values[0]!
            : null;
        if (single !== null && !unordered(single) && this.punct(bracket + 1, ":"))
          props.set(single, this.evalRange(bracket + 2, end, env, depth + 1));
        else {
          for (const earlier of props.keys()) props.set(earlier, null);
          unknown = true;
        }
      }
      k = end + 1;
    }
    // more keys than are read: the ones not listed are not known to be absent
    if (k < close) unknown = true;
    return unknown ? { kind: "obj", props, open: true } : { kind: "obj", props };
  }

  /**
   * `value.property`. `depth`: how deep the question already is, so another module's export is
   * read with the room that is left (without it, with the fixed room of a top-level read).
   */
  private member(value: Val, property: string, depth?: number): Val | null {
    if (value.kind === "obj") {
      if (value.props.has(property)) return value.props.get(property) ?? null;
      return value.open ? null : { kind: "undef" };
    }
    // Room for the export's own name to be followed to its declaration and through a wrapper
    // such as `Object.freeze(…)`: `module.exports = { secureDefaults }`.
    if (value.kind === "ns")
      return value.resolver.exportValue(property, Math.min(depth ?? MAX_DEPTH, MAX_DEPTH - 4));
    if (value.kind === "nsref" && this.reference)
      return { kind: "str", values: [this.reference(value.specifier, property)] };
    if (value.kind === "cjs" && value.interop && property === "default") {
      const { interop: _interop, ...mod } = value;
      return mod;
    }
    if (value.kind === "cjs")
      return this.wrappedExport(value, property, Math.min(depth ?? MAX_DEPTH, MAX_DEPTH - 2));
    // `links.upload` where links is another module's object: a reference to that key
    if (value.kind === "str" && value.ref && this.reference) {
      const ref = { specifier: value.ref.specifier, property: `${value.ref.property}.${property}` };
      return { kind: "str", values: [this.reference(ref.specifier, ref.property)], ref };
    }
    return null;
  }

  /**
   * A module a bundler wrapped into this file: `var require_x = __commonJS({ "path"(exports) { … } })`
   * as esbuild writes it, or `var E = y(c => { … })` once minified. Null when name is not one.
   */
  /**
   * For the wrapper reader: the module a bundler wrapped under `name` (`var require_x =
   * __commonJS({…})`, minified `var E = y((e, t) => {…})`, also in a declaration list), as its
   * body and the names of its `exports` and `module` parameters. Null when it is none.
   */
  bundledModule(
    name: string,
  ): { exports: string; module: string | null; body: [number, number] } | null {
    const mod = this.guarded(null, () => {
      const top = this.topDeclarations().get(name);
      const listed = top ? null : this.topListed(name);
      return this.wrappedModule(name, top ?? listed ?? null);
    });
    return mod?.kind === "cjs"
      ? { exports: mod.exports, module: mod.module, body: mod.body }
      : null;
  }

  private wrappedModule(name: string, at?: [number, number] | null): Val | null {
    const decl = at === undefined ? this.topDeclarations().get(name) : at;
    if (!decl) return null;
    const k = decl[0];
    if (
      !this.is(k, "ident") ||
      !this.punct(k + 1, "(") ||
      this.helper(this.tokens[k]!.value) !== "wrapper"
    )
      return null;
    let param = -1;
    let open = -1;
    if (this.punct(k + 2, "{")) {
      // `{ "path"(exports, module) { … } }`
      const key = this.tokens[k + 3];
      if (!key || (key.type !== "string" && key.type !== "ident") || !this.punct(k + 4, "("))
        return null;
      param = k + 5;
      open = this.match[k + 4]! + 1;
    } else if (this.is(k + 2, "ident") && this.punct(k + 3, "=>")) {
      param = k + 2;
      open = k + 4;
    } else if (this.punct(k + 2, "(") && this.punct(this.match[k + 2]! + 1, "=>")) {
      param = k + 3;
      open = this.match[k + 2]! + 2;
    }
    if (param === -1 || !this.is(param, "ident") || !this.punct(open, "{")) return null;
    const close = this.match[open]!;
    if (close === -1) return null;
    const module =
      this.punct(param + 1, ",") && this.is(param + 2, "ident")
        ? this.tokens[param + 2]!.value
        : null;
    return { kind: "cjs", exports: this.tokens[param]!.value, module, body: [open, close] };
  }

  /** The key of a webpack module function, `{ 76675(e, n, i) { … } }` or `{ 76675: (e, n, i) => … }`. */
  private moduleKey(def: FnDef): string | null {
    const before = this.tokens[def.paramsAt - 1];
    if (before?.type === "number" && def.member) return before.value;
    if (this.punct(def.paramsAt - 1, ":") && this.tokens[def.paramsAt - 2]?.type === "number")
      return this.tokens[def.paramsAt - 2]!.value;
    return null;
  }

  /**
   * `req(id)` at k, where `req` is the third parameter of the webpack module function around k
   * (webpack's require): the module of the file's table under that key, as a wrapped module whose
   * second parameter is its exports. Null when the key is not in the table once.
   */
  private webpackModule(k: number, name: string, id: string): Val | null {
    const b = this.binding(k, name);
    if (b?.kind !== "param" || b.index !== 2 || this.moduleKey(b.def) === null) return null;
    if (!this.s.moduleTable) {
      const table = new Map<string, FnDef | null>();
      for (const d of this.functions()) {
        const key = this.moduleKey(d);
        if (key !== null && d.block) table.set(key, table.has(key) ? null : d);
      }
      this.s.moduleTable = table;
    }
    const def = this.s.moduleTable.get(id);
    if (!def) return null;
    const param = (i: number): string | null => {
      const p = def.params[i];
      return p?.kind === "name" ? p.name : null;
    };
    return {
      kind: "cjs",
      exports: param(1) ?? "",
      module: param(0),
      body: [def.body[0], def.body[1] - 1],
    };
  }

  /** Bundler helpers, recognised by what their code does so that minified names count too. */
  private readonly helperKinds = new Map<string, "wrapper" | "interop" | null>();
  private helper(name: string): "wrapper" | "interop" | null {
    const known = this.helperKinds.get(name);
    if (known !== undefined) return known;
    let kind: "wrapper" | "interop" | null = null;
    if (name === "__commonJS") kind = "wrapper";
    else if (name === "__toESM" || name === "__toCommonJS") kind = "interop";
    else {
      const decl = this.topDeclarations().get(name);
      if (decl && decl[1] - decl[0] < 200) {
        let exportsBox = false;
        let esModule = false;
        let defaultKey = false;
        for (let j = decl[0]; j < decl[1]; j++) {
          // `(e = { exports: {} }).exports`: the module object a CommonJS wrapper creates
          if (
            this.is(j, "ident", "exports") &&
            this.punct(j + 1, ":") &&
            this.punct(j + 2, "{") &&
            this.punct(j + 3, "}")
          )
            exportsBox = true;
          if (this.is(j, "ident", "__esModule") && this.punct(j - 1, ".")) esModule = true;
          if (this.is(j, "string", "default")) defaultKey = true;
        }
        kind = exportsBox ? "wrapper" : esModule && defaultKey ? "interop" : null;
      }
    }
    this.helperKinds.set(name, kind);
    return kind;
  }

  /** `exports.NAME = <expr>` assigned once in the wrapped module's body (`= void 0` aside). */
  /** Whether a wrapped module may say it is an ES module, so its `default` is its own export. */
  /** The truth of a literal in [from, to): `1`, `0`, `true`, `false`, `!0`, `!1`; null otherwise. */
  private literalTruth(from: number, to: number): boolean | null {
    const t = this.tokens[from];
    if (!t) return null;
    if (to === from + 1) {
      if (t.type === "number") return Number(t.value) !== 0;
      if (this.is(from, "ident", "true")) return true;
      if (this.is(from, "ident", "false")) return false;
      return null;
    }
    if (to === from + 2 && this.punct(from, "!") && this.tokens[from + 1]?.type === "number")
      return Number(this.tokens[from + 1]!.value) === 0;
    return null;
  }

  private readonly esModules = new Map<number, boolean>();
  private marksEsModule(mod: Extract<Val, { kind: "cjs" }>): boolean {
    const known = this.esModules.get(mod.body[0]);
    if (known !== undefined) return known;
    let marks = false;
    for (let j = mod.body[0]; j < mod.body[1] && !marks; j++) {
      const t = this.tokens[j]!;
      marks =
        (t.type === "ident" || t.type === "string") &&
        (t.value === "__esModule" || t.value === "__toCommonJS" || t.value === "default");
    }
    this.esModules.set(mod.body[0], marks);
    return marks;
  }

  private wrappedExport(
    mod: Extract<Val, { kind: "cjs" }>,
    property: string,
    depth: number,
  ): Val | null {
    let found: [number, number] | null = null;
    for (const j of this.occurrences(mod.exports, mod.body[0], mod.body[1])) {
      if (this.punct(j - 1, ".") || !this.punct(j + 1, ".") || !this.is(j + 2, "ident", property))
        continue;
      if (!this.punct(j + 3, "=") || this.punct(j + 4, "=")) continue;
      const at = j + 4;
      // the declaration esbuild writes first: `exports.A = exports.B = void 0`
      if (this.is(at, "ident", "void")) continue;
      if (this.is(at, "ident", mod.exports) && this.punct(at + 1, ".") && this.punct(at + 3, "="))
        continue;
      if (found) return null;
      found = [at, this.exprEnd(at)];
    }
    if (found) return this.evalRange(found[0], found[1], new Map(), depth);
    // `module.exports = { … }`, assigned once
    if (!mod.module) return null;
    let whole: [number, number] | null = null;
    for (const j of this.occurrences(mod.module, mod.body[0], mod.body[1])) {
      if (this.punct(j - 1, ".") || !this.punct(j + 1, ".") || !this.is(j + 2, "ident", "exports"))
        continue;
      if (!this.punct(j + 3, "=") || this.punct(j + 4, "=")) continue;
      if (whole) return null;
      whole = [j + 4, this.exprEnd(j + 4)];
    }
    const value = whole ? this.evalRange(whole[0], whole[1], new Map(), depth) : null;
    return value ? this.member(value, property, depth) : null;
  }

  private call(callee: Val, open: number, close: number, env: Env, depth: number): Val | null {
    if (callee.kind !== "fn") return null;
    if (depth >= MAX_DEPTH) return this.stop("depth limit");
    // the file's evaluation budget is used up: do not even read the arguments
    if (callee.res.bodyWork <= 0 && !callee.res.simpleBody(callee.def))
      return this.stop("work limit");
    const args = this.list(open, close, env, depth);
    const out = this.across(callee.res, () => callee.res.apply(callee, args, depth));
    if (out) this.note("call");
    return out;
  }

  /** Runs a question on another module's resolver and keeps its reason when it gives up. */
  private across<T>(other: ExpressionResolver, run: () => T): T {
    if (other === this) return run();
    other.why = null;
    const out = run();
    if (other.why) this.why ??= other.why;
    return out;
  }

  /** Calls a function of this module with argument values (from any module). */
  apply(callee: Extract<Val, { kind: "fn" }>, args: Array<Val | null>, depth: number): Val | null {
    if (depth >= MAX_DEPTH) return this.stop("depth limit");
    if (this.budget-- <= 0) return this.stop("work limit");
    if (this.active.has(callee.def)) return this.stop("cycle");
    if (this.asyncOrGenerator(callee.def))
      return this.stop("an async function or a generator returns a promise or an iterator");
    const inner = new Map(callee.env);
    if (!this.bind(callee.def.params, args, inner)) return null;
    this.active.add(callee.def);
    try {
      return this.evalBody(callee.def, inner, depth + 1);
    } finally {
      this.active.delete(callee.def);
    }
  }

  /**
   * Runs a callback of this module for what it does (a `forEach` round): true when every
   * statement of it is in the subset. `fresh`: the objects the evaluation created, the only ones
   * it may write to.
   */
  runFn(
    callee: Extract<Val, { kind: "fn" }>,
    args: Array<Val | null>,
    depth: number,
    fresh: Set<Val>,
  ): boolean {
    if (depth >= MAX_DEPTH) return !!this.stop("depth limit");
    if (this.active.has(callee.def)) return !!this.stop("cycle");
    if (this.asyncOrGenerator(callee.def))
      return !!this.stop("an async function or a generator as a callback");
    const inner = new Map(callee.env);
    this.bind(callee.def.params, args, inner);
    const own = new Set(paramNames(callee.def.params));
    const [start, end] = callee.def.body;
    this.active.add(callee.def);
    try {
      const outer = this.blocks;
      this.blocks = 0;
      try {
        return callee.def.block
          ? this.run(start + 1, end - 1, inner, own, fresh, depth) !== null
          : this.run(start, end, inner, own, fresh, depth) !== null;
      } finally {
        this.blocks = outer;
      }
    } finally {
      this.active.delete(callee.def);
    }
  }

  /** Binds parameters to argument values; false when a pattern cannot be bound. */
  private bind(params: Param[], args: Array<Val | null>, env: Env): boolean {
    params.forEach((p, i) => {
      const passed = i < args.length;
      let a = args[i] ?? null;
      if (p.kind === "name") {
        // a parameter nobody passed: its default, or undefined
        if (!passed)
          a = p.fallback
            ? this.evalRange(p.fallback[0], p.fallback[1], new Map(env), 1)
            : { kind: "undef" };
        // a value not known is still this parameter's: a read of it must not fall through to a
        // binding of the same name outside (`const SB = "sandbox"; function f(SB) { [SB]: … }`)
        env.set(p.name, a ?? UNKNOWN);
      } else if (p.kind === "object") {
        for (const [prop, local] of p.props) {
          let v = a ? this.member(a, prop) : null;
          // a key the argument does not have (or no argument): the pattern's default
          const fallback = p.defaults?.get(local);
          if (fallback && (!passed || v?.kind === "undef"))
            v = this.evalRange(fallback[0], fallback[1], new Map(env), 1);
          env.set(local, v ?? UNKNOWN);
        }
        // `...more`: the argument's other properties; nothing passed gives an empty object
        if (p.rest) {
          if (!passed || a?.kind === "undef") env.set(p.rest, { kind: "obj", props: new Map() });
          else if (a?.kind === "obj")
            env.set(p.rest, {
              kind: "obj",
              props: new Map([...a.props].filter(([key]) => !p.props.has(key))),
              ...(a.open ? { open: true } : {}),
            });
        }
      } else {
        const elems = a?.kind === "arr" ? a.elems : [];
        p.names.forEach((n, j) => {
          if (n) env.set(n, elems[j] ?? UNKNOWN);
        });
      }
    });
    return true;
  }

  /**
   * `async function`, `async (…) =>`, `async name(…) {`, `function*`, `*name(…) {`: what a call
   * returns is a promise or an iterator, not the value of the body.
   */
  private asyncOrGenerator(def: FnDef): boolean {
    for (let j = def.paramsAt - 1; j >= def.paramsAt - 3 && j >= 0; j--)
      if (this.is(j, "ident", "async") || this.punct(j, "*")) return true;
    return false;
  }

  /** The end of the expression of a body that is `{ return <expr>; }` and nothing else, or -1. */
  private returnOnly(def: FnDef): number {
    const [start, end] = def.body;
    if (!def.block || !this.is(start + 1, "ident", "return")) return -1;
    const exprEnd = this.exprEnd(start + 2);
    return (
      this.punct(exprEnd, ";")
        ? exprEnd + 1 === end - 1 || exprEnd + 1 === end
        : exprEnd === end - 1
    )
      ? exprEnd
      : -1;
  }

  /** Whether a call of def is read without running statements: an expression or a lone return. */
  private simpleBody(def: FnDef): boolean {
    return !def.block || this.returnOnly(def) !== -1;
  }

  private evalBody(def: FnDef, env: Env, depth: number): Val | null {
    const [start, end] = def.body;
    if (!def.block) return this.evalRange(start, end, env, depth);
    // `{ return <expr>; }`: read directly
    const exprEnd = this.returnOnly(def);
    if (exprEnd !== -1) return this.evalRange(start + 2, exprEnd, env, depth);
    // any other body: its statements, in the evaluation subset
    const outer = this.blocks;
    this.blocks = 0;
    let ran: ReturnType<typeof this.run>;
    try {
      ran = this.run(start + 1, end - 1, env, new Set(paramNames(def.params)), new Set(), depth);
    } finally {
      this.blocks = outer;
    }
    if (!ran) return null;
    this.note("evaluated");
    return ran.returned ? ran.value : { kind: "undef" };
  }

  // ---------- statements (the evaluation subset, see the top of the file) ----------

  /**
   * Runs the statements in [from, to): null when one is outside the subset (the reason says
   * which), else whether a `return` ran and its value. `own`: the variables this block declares,
   * the only ones it may assign. `fresh`: the objects the evaluation created, the only ones it may
   * write keys to.
   */
  private run(
    from: number,
    to: number,
    env: Env,
    own: Set<string>,
    fresh: Set<Val>,
    depth: number,
  ): { returned: boolean; value: Val | null } | null {
    if (this.inBody >= MAX_NESTING) return this.stop("depth limit");
    this.inBody++;
    try {
      return this.runIn(from, to, env, own, fresh, depth);
    } finally {
      this.inBody--;
    }
  }

  private runIn(
    from: number,
    to: number,
    env: Env,
    own: Set<string>,
    fresh: Set<Val>,
    depth: number,
  ): { returned: boolean; value: Val | null } | null {
    let k = from;
    const unread = "an expression that may have effects could not be read";
    while (k < to) {
      if (this.effectUnknown) return this.stop(unread);
      if (++this.statements > MAX_STATEMENTS || this.budget-- <= 0 || this.bodyWork-- <= 0)
        return this.stop("work limit");
      const t = this.tokens[k]!;
      if (t.type === "punct" && t.value === ";") {
        k++;
        continue;
      }
      // a directive: `"use strict";`
      if (t.type === "string" && (this.punct(k + 1, ";") || k + 1 >= to)) {
        k++;
        continue;
      }
      if (t.type === "punct" && t.value === "{") {
        const close = this.match[k]!;
        if (close === -1 || close >= to) return this.stop("unsupported statement: block");
        this.blocks++;
        const inner = (() => {
          try {
            return this.run(k + 1, close, new Map(env), new Set(), fresh, depth);
          } finally {
            this.blocks--;
          }
        })();
        if (!inner || inner.returned) return inner;
        k = close + 1;
        continue;
      }
      if (t.type === "ident" && t.value === "return") {
        // `return` ends at the line end without a value (automatic semicolon insertion)
        if (k + 1 >= to || this.punct(k + 1, ";") || this.tokens[k + 1]!.line !== t.line)
          return { returned: true, value: { kind: "undef" } };
        const parts = this.sequence(k + 1, to);
        for (const [a, b] of parts.slice(0, -1))
          if (!this.effect(a, b, env, own, fresh, depth)) return null;
        const [a, b] = parts[parts.length - 1]!;
        const value = this.evalRange(a, b, env, depth);
        if (this.effectUnknown) return this.stop(unread);
        return { returned: true, value };
      }
      // `var` in a block belongs to the whole function, which this evaluation does not model
      if (t.type === "ident" && t.value === "var" && this.blocks > 0)
        return this.stop("var inside a block");
      if (t.type === "ident" && (t.value === "const" || t.value === "let" || t.value === "var")) {
        const next = this.declare(k + 1, to, env, own, fresh, depth);
        if (next === null) return null;
        k = next;
        continue;
      }
      if (t.type === "ident" && t.value === "function") {
        // a nested declaration: read where it is called (see `nestedFunction`)
        const fn =
          this.is(k + 1, "ident") && this.punct(k + 2, "(") ? this.arrowAt(k + 2, env) : null;
        if (fn?.kind !== "fn" || !fn.def.block) return this.stop("unsupported statement: function");
        k = fn.def.body[1];
        continue;
      }
      if (t.type === "ident" && t.value === "for") {
        const r = this.loop(k, to, env, fresh, depth);
        if (!r || r.returned) return r;
        k = r.next;
        continue;
      }
      if (t.type === "ident" && STATEMENT_WORDS.has(t.value))
        return this.stop(`unsupported statement: ${t.value}`);
      // an expression statement, possibly a comma sequence
      const parts = this.sequence(k, to);
      const end = parts[parts.length - 1]![1];
      if (end === k) return this.stop("unsupported statement: expression");
      for (const [a, b] of parts) if (!this.effect(a, b, env, own, fresh, depth)) return null;
      k = end;
    }
    if (this.effectUnknown) return this.stop(unread);
    return { returned: false, value: null };
  }

  /** The comma-separated expressions of the statement at k: their ranges, to its end. */
  private sequence(k: number, to: number): Array<[number, number]> {
    const out: Array<[number, number]> = [];
    let from = k;
    for (;;) {
      const end = this.stmtEnd(from, to);
      out.push([from, end]);
      if (!this.punct(end, ",") || end >= to || out.length > 64) return out;
      from = end + 1;
    }
  }

  /**
   * End of the expression at k inside a body: the next `,` `;` or closing bracket at its level,
   * or a line break after a complete value before a new one (code without semicolons).
   */
  private stmtEnd(k: number, to: number): number {
    for (let j = k; j < to; j++) {
      const p = this.tokens[j]!;
      if (
        j > k &&
        p.type !== "punct" &&
        p.line !== this.tokens[j - 1]!.line &&
        !(p.type === "ident" && /^(in|of|instanceof)$/.test(p.value)) &&
        this.endsValue(j - 1)
      )
        return j;
      if (p.type !== "punct") continue;
      if (p.value === "{" || p.value === "(" || p.value === "[") {
        const m = this.match[j]!;
        if (m === -1 || m >= to) return to;
        j = m;
      } else if (p.value === ";" || p.value === "," || p.value === "}" || p.value === ")") return j;
      else if (p.value === "]") return j;
    }
    return to;
  }

  /** Whether the token at j can end a value (so a line break after it may end the statement). */
  private endsValue(j: number): boolean {
    const t = this.tokens[j];
    if (!t) return false;
    if (t.type === "punct") return /^(\)|\]|\}|\+\+|--)$/.test(t.value);
    return !(
      t.type === "ident" &&
      /^(return|typeof|void|new|delete|await|yield|in|of|instanceof|case|throw|else|do)$/.test(
        t.value,
      )
    );
  }

  /**
   * `const|let|var` declarators from k: each name gets its value (or the unknown marker), and an
   * object or array literal becomes a fresh object of the evaluation. The index after them.
   */
  private declare(
    k: number,
    to: number,
    env: Env,
    own: Set<string>,
    fresh: Set<Val>,
    depth: number,
  ): number | null {
    for (let guard = 0; guard < 64; guard++) {
      let end: number;
      if (this.is(k, "ident")) {
        const name = this.tokens[k]!.value;
        if (this.punct(k + 1, "=")) {
          end = this.stmtEnd(k + 2, to);
          const v = this.evalRange(k + 2, end, env, depth);
          env.set(name, v ?? UNKNOWN);
          if (v && this.literalAt(k + 2, end)) fresh.add(v);
        } else {
          end = k + 1;
          env.set(name, { kind: "undef" });
        }
        own.add(name);
      } else if ((this.punct(k, "{") || this.punct(k, "[")) && this.match[k] !== -1) {
        // a destructuring pattern
        const close = this.match[k]!;
        if (!this.punct(close + 1, "=")) return this.stop("unsupported declaration");
        end = this.stmtEnd(close + 2, to);
        const v = this.evalRange(close + 2, end, env, depth);
        const param = this.parseParams(k - 1, close + 1)[0];
        if (!param) return this.stop("unsupported declaration");
        for (const name of paramNames([param])) {
          env.set(name, UNKNOWN);
          own.add(name);
        }
        if (v) this.bind([param], [v], env);
      } else return this.stop("unsupported declaration");
      if (!this.punct(end, ",")) return this.punct(end, ";") ? end + 1 : end;
      k = end + 1;
    }
    return this.stop("unsupported declaration");
  }

  /** Whether [start, end) is exactly an object or array literal. */
  private literalAt(start: number, end: number): boolean {
    return (this.punct(start, "{") || this.punct(start, "[")) && this.match[start] === end - 1;
  }

  /**
   * `for (const PATTERN of LIST) BODY` and `for (const KEY in OBJECT) BODY` over values read
   * whole: the body once per element, in a scope of its own.
   */
  private loop(
    k: number,
    to: number,
    env: Env,
    fresh: Set<Val>,
    depth: number,
  ): { returned: true; value: Val | null } | { returned: false; next: number } | null {
    const open = k + 1;
    const close = this.punct(open, "(") ? this.match[open]! : -1;
    if (close === -1 || close >= to) return this.stop("unsupported loop");
    let p = open + 1;
    if (!this.is(p, "ident") || !/^(const|let|var)$/.test(this.tokens[p]!.value))
      return this.stop("unsupported loop");
    p++;
    const patternEnd =
      (this.punct(p, "[") || this.punct(p, "{")) && this.match[p] !== -1
        ? this.match[p]! + 1
        : p + 1;
    const of = this.is(patternEnd, "ident", "of");
    if (!of && !this.is(patternEnd, "ident", "in"))
      return this.stop("unsupported loop: only for…of and for…in");
    const param = this.parseParams(p - 1, patternEnd)[0];
    const list = this.evalRange(patternEnd + 1, close, env, depth);
    const rounds = this.rounds(list, of ? "of" : "in");
    if (!rounds || !param) return null;
    const block = this.punct(close + 1, "{");
    const bodyEnd = block ? this.match[close + 1]! : this.stmtEnd(close + 1, to);
    if (bodyEnd === -1 || bodyEnd > to) return this.stop("unsupported loop");
    for (const element of rounds) {
      const scope: Env = new Map(env);
      this.bind([param], [element], scope);
      const own = new Set(paramNames([param]));
      this.blocks++;
      let r: ReturnType<typeof this.run>;
      try {
        r = block
          ? this.run(close + 2, bodyEnd, scope, own, fresh, depth)
          : this.run(close + 1, bodyEnd, scope, own, fresh, depth);
      } finally {
        this.blocks--;
      }
      if (!r) return null;
      if (r.returned) return { returned: true, value: r.value };
    }
    this.note("evaluated");
    const next = block ? bodyEnd + 1 : this.punct(bodyEnd, ";") ? bodyEnd + 1 : bodyEnd;
    return { returned: false, next };
  }

  /** The values a loop runs over: every element of a list read whole, or the keys of an object. */
  private rounds(list: Val | null, how: "of" | "in"): Array<Val> | null {
    let out: Array<Val | null> | null = null;
    if (how === "in")
      out =
        list?.kind === "obj" && !list.open
          ? [...list.props.keys()].map((key) => ({ kind: "str", values: [key] }))
          : null;
    else if (list?.kind === "arr" && list.more) return this.stop("too many values");
    else if (list?.kind === "arr") out = list.elems;
    else if (list?.kind === "map")
      out = list.entries.map(([a, b]) => ({ kind: "arr", elems: [a, b], line: list.line }));
    if (!out || out.some((e) => e === null))
      return this.stop("iteration over values that are not known");
    if (out.length > MAX_ITERATIONS) return this.stop("too many values");
    return out as Val[];
  }

  /**
   * One expression statement: an assignment (`x = …`, `x += …`, `o.k = …`, `o[k] = …`) or
   * `LIST.forEach(callback)`. False when it is anything else.
   */
  private effect(
    start: number,
    end: number,
    env: Env,
    own: Set<string>,
    fresh: Set<Val>,
    depth: number,
  ): boolean {
    let k = start;
    let e = end;
    while (this.punct(k, "(") && this.match[k] === e - 1) {
      k++;
      e--;
    }
    let at = -1;
    for (let j = k; j < e; j++) {
      const p = this.tokens[j]!;
      if (p.type !== "punct") continue;
      if ((p.value === "{" || p.value === "(" || p.value === "[") && this.match[j] !== -1) {
        j = this.match[j]!;
        continue;
      }
      if (p.value === "=" || p.value === "+=") {
        if (at !== -1) return !!this.stop("unsupported assignment: a chain");
        at = j;
      } else if (
        /^(?:[-*/%&|^]|\*\*|<<|>>>?|&&|\|\||\?\?)=$/.test(p.value) ||
        /^(\+\+|--)$/.test(p.value)
      )
        return !!this.stop("unsupported assignment");
    }
    if (at === -1) return this.forEachStatement(k, e, env, fresh, depth);
    const plus = this.tokens[at]!.value === "+=";
    const value = this.evalRange(at + 1, e, env, depth);
    // `x = …` to a variable of this block
    if (at === k + 1 && this.is(k, "ident")) {
      const name = this.tokens[k]!.value;
      if (!own.has(name)) return !!this.stop("assignment to a variable outside its block");
      const before = env.get(name);
      const next = plus
        ? before?.kind === "str" && value?.kind === "str"
          ? product([before.values, value.values])
          : null
        : null;
      if (plus && before?.kind === "str" && value?.kind === "str" && !next)
        return !!this.stop("too many values");
      env.set(name, plus ? (next ? { kind: "str", values: next } : UNKNOWN) : (value ?? UNKNOWN));
      return true;
    }
    // `o.k = …` or `o[k] = …` on an object the evaluation created
    if (!this.is(k, "ident") || plus) return !!this.stop("unsupported assignment");
    const target = env.get(this.tokens[k]!.value);
    let key: string | null = null;
    if (this.punct(k + 1, ".") && this.is(k + 2, "ident") && at === k + 3)
      key = this.tokens[k + 2]!.value;
    else if (this.punct(k + 1, "[") && this.match[k + 1] === at - 1) {
      key = this.oneString(this.evalRange(k + 2, at - 1, env, depth));
      if (key === null) return !!this.stop("a computed key is not known");
    } else return !!this.stop("unsupported assignment");
    if (target?.kind !== "obj" || !fresh.has(target))
      return !!this.stop("a write to an object the function did not create");
    if (!target.props.has(key) && target.props.size >= MAX_ITERATIONS)
      return !!this.stop("too many values");
    if (unordered(key)) return !!this.stop("a key JavaScript orders or treats apart");
    // a key written again keeps its place, as in JavaScript
    target.props.set(key, value);
    return true;
  }

  /** `LIST.forEach(callback)` as a statement: the callback once per element read whole. */
  private forEachStatement(
    k: number,
    e: number,
    env: Env,
    fresh: Set<Val>,
    depth: number,
  ): boolean {
    const open = this.punct(e - 1, ")") ? this.opener[e - 1]! : -1;
    if (
      open <= k + 1 ||
      !this.is(open - 1, "ident", "forEach") ||
      !(this.punct(open - 2, ".") || this.punct(open - 2, "?."))
    )
      return !!this.stop("unsupported statement: expression");
    const list = this.evalRange(k, open - 2, env, depth);
    const ranges = this.argRanges(open, e - 1);
    const cb =
      ranges.length === 1 ? this.evalRange(ranges[0]![0], ranges[0]![1], env, depth + 1) : null;
    if (cb?.kind !== "fn") return !!this.stop("a forEach callback that is not known");
    // a Map's forEach passes the value first, then the key
    const rounds =
      list?.kind === "map"
        ? this.rounds(list, "of")?.map((pair) =>
            pair.kind === "arr" ? pair.elems.toReversed() : [],
          )
        : this.rounds(list, "of")?.map((element) => [element]);
    if (!rounds) return false;
    for (const args of rounds)
      if (!this.across(cb.res, () => cb.res.runFn(cb, args, depth + 1, fresh))) return false;
    this.note("evaluated");
    return true;
  }

  /** The one string a value is, or null (several values, a gap, a reference, not a string). */
  private oneString(v: Val | null): string | null {
    return v?.kind === "str" && !v.ref && v.values.length === 1 && !v.values[0]!.includes("${…}")
      ? v.values[0]!
      : null;
  }

  /** A method of a known list or string, from the subset; anything else stops with a reason. */
  private builtin(
    value: Extract<Val, { kind: "str" } | { kind: "arr" }>,
    method: string,
    open: number,
    close: number,
    env: Env,
    depth: number,
  ): Val | null {
    if (depth >= MAX_DEPTH) return this.stop("depth limit");
    const ranges = this.argRanges(open, close);
    const arg = (i: number): Val | null =>
      ranges[i] ? this.evalRange(ranges[i]![0], ranges[i]![1], env, depth + 1) : null;
    if (value.kind === "arr") {
      if (value.more) return this.stop("too many values");
      if (method === "map") {
        const cb = ranges.length === 1 ? arg(0) : null;
        if (cb?.kind !== "fn") return this.stop("a map callback that is not known");
        if (value.elems.length > MAX_ITERATIONS) return this.stop("too many values");
        const elems = value.elems.map((e) =>
          e === null ? null : this.across(cb.res, () => cb.res.apply(cb, [e], depth + 1)),
        );
        this.note("evaluated");
        return { kind: "arr", elems, line: value.line };
      }
      if (method === "join") {
        const sep = ranges.length ? this.oneString(arg(0)) : ",";
        if (sep === null || ranges.length > 1) return this.stop("join with a separator not known");
        const parts: string[][] = [];
        for (const [i, e] of value.elems.entries()) {
          if (e?.kind !== "str" || e.ref) return this.stop("join of elements not known");
          if (i) parts.push([sep]);
          parts.push(e.values);
        }
        const values = product(parts);
        return values ? { kind: "str", values } : this.stop("too many values");
      }
      return this.stop(`unsupported list method: ${method}`);
    }
    if (value.values.some((v) => v.includes("${…}") || v.length > MAX_STRING))
      return this.stop("a string that is not known whole");
    const each = (fn: (text: string) => string | null): Val | null => {
      const out: string[] = [];
      for (const v of value.values) {
        const x = fn(v);
        if (x === null) return null;
        if (x.length > MAX_STRING) return this.stop("too many values");
        out.push(x);
      }
      return { kind: "str", values: [...new Set(out)] };
    };
    switch (method) {
      case "toLowerCase":
      case "toUpperCase":
        if (ranges.length) return this.stop(`unsupported string method: ${method} with arguments`);
        return each((v) => (method === "toLowerCase" ? v.toLowerCase() : v.toUpperCase()));
      case "concat": {
        const parts = [value.values];
        for (let i = 0; i < ranges.length; i++) {
          const v = arg(i);
          if (v?.kind !== "str" || v.ref) return this.stop("an argument of concat is not known");
          parts.push(v.values);
        }
        const values = product(parts);
        return values ? { kind: "str", values } : this.stop("too many values");
      }
      case "slice": {
        const n = ranges.map(([a, b]) => this.integer(a, b));
        if (!n.length || n.length > 2 || n.some((x) => x === null))
          return this.stop("slice with arguments that are not number literals");
        return each((v) => v.slice(n[0]!, n[1] ?? undefined));
      }
      case "split": {
        const sep = ranges.length === 1 ? this.oneString(arg(0)) : null;
        if (sep === null || value.values.length !== 1)
          return this.stop("split of a string or by a separator not known");
        const parts = value.values[0]!.split(sep);
        if (parts.length > MAX_ITERATIONS) return this.stop("too many values");
        return {
          kind: "arr",
          elems: parts.map((x) => ({ kind: "str", values: [x] })),
          line: this.tokens[open]!.line,
        };
      }
      case "replace":
      case "replaceAll":
        return this.replace(value.values, method, ranges, env, depth);
      default:
        return this.stop(`unsupported string method: ${method}`);
    }
  }

  /** An integer literal, possibly negative, that is all of [a, b). */
  private integer(a: number, b: number): number | null {
    const neg = this.punct(a, "-");
    const t = this.tokens[neg ? a + 1 : a];
    if (t?.type !== "number" || b !== (neg ? a + 2 : a + 1) || !/^\d{1,6}$/.test(t.value))
      return null;
    return (neg ? -1 : 1) * Number(t.value);
  }

  /** `s.replace(pattern, replacement)` and `replaceAll` for patterns and replacements of the subset. */
  private replace(
    values: string[],
    method: "replace" | "replaceAll",
    ranges: Array<[number, number]>,
    env: Env,
    depth: number,
  ): Val | null {
    if (ranges.length !== 2) return this.stop(`${method} with other than two arguments`);
    const [[pa, pb], [ra, rb]] = ranges as [[number, number], [number, number]];
    let pattern: string | RegExp;
    if (pb === pa + 1 && this.tokens[pa]!.type === "regex") {
      const re = simpleRegex(this.tokens[pa]!.value);
      if (!re) return this.stop("unsupported regular expression");
      if (method === "replaceAll" && !re.global)
        return this.stop("replaceAll with a regular expression that is not global");
      pattern = re;
    } else {
      const text = this.oneString(this.evalRange(pa, pb, env, depth + 1));
      if (text === null) return this.stop(`the pattern of ${method} is not known`);
      pattern = text;
    }
    const r = this.evalRange(ra, rb, env, depth + 1);
    const fixed = this.oneString(r);
    let replacement: (match: string) => string | null;
    if (fixed !== null && !fixed.includes("$")) replacement = () => fixed;
    else if (r?.kind === "fn")
      replacement = (match) =>
        this.oneString(
          this.across(r.res, () => r.res.apply(r, [{ kind: "str", values: [match] }], depth + 1)),
        );
    else return this.stop(`the replacement of ${method} is not a string without $ or a callback`);
    const out: string[] = [];
    for (const v of values) {
      let failed = false;
      let count = 0;
      const each = (match: string): string => {
        this.bodyWork--;
        const x = failed || ++count > MAX_ITERATIONS ? null : replacement(match);
        if (x === null) failed = true;
        return x ?? "";
      };
      // every application costs the evaluation work in proportion to the string
      this.bodyWork -= v.length;
      this.budget -= Math.ceil(v.length / 16);
      if (this.bodyWork <= 0 || this.budget <= 0) return this.stop("work limit");
      const done =
        method === "replace"
          ? typeof pattern === "string"
            ? v.replace(pattern, each)
            : v.replace(pattern, each)
          : typeof pattern === "string"
            ? v.replaceAll(pattern, each)
            : v.replaceAll(pattern, each);
      if (failed) return this.stop(`the replacement of ${method} has no known value`);
      if (done.length > MAX_STRING) return this.stop("too many values");
      out.push(done);
    }
    return { kind: "str", values: [...new Set(out)] };
  }

  // ---------- names ----------

  private lookup(name: string, k: number, env: Env, depth: number): Val | null {
    const bound = env.get(name);
    if (bound) return bound.kind === "unknown" ? null : bound;
    if (name === "this") return null;
    // a `const` of the function around k, declared once before k: its initializer, read with
    // the same bindings
    const local = this.localConst(k, name);
    if (local) {
      const around = this.enclosing(local[0]);
      const v = this.evalRange(local[0], local[1], env, depth + 1);
      return around
        ? this.unlessChanged(name, local[0] - 2, v, around.body[0], around.body[1], around)
        : v;
    }
    // `var { KEY: NAME } = <expr>` in a function around k (a module a bundler wrapped)
    const pattern = this.localPattern(k, name);
    if (pattern) {
      const whole = this.evalRange(pattern.from[0], pattern.from[1], new Map(), depth + 1);
      return whole ? this.member(whole, pattern.key, depth + 1) : null;
    }
    // `function NAME(…) {…}` declared once in a function around k (a module a bundler wrapped)
    const nested = this.nestedFunction(k, name);
    if (nested) return { kind: "fn", def: nested, env: new Map(), res: this };
    const constant = this.constants.stringOf(name, k);
    if (constant !== null) return { kind: "str", values: [constant] };
    if (depth >= MAX_DEPTH) return null;
    // Only names declared once at the top of the file and never assigned again are followed;
    // a name that is also a parameter or local of the function around k is that one instead.
    if (this.enclosingParam(k, name) || this.declaredLocally(k, name)) return null;
    // nor one a block at the top of the file declares around k (`{ const NAME = … }`, `if`,
    // `for (const NAME of …)`, `switch`), nor a `catch (NAME)` around k
    if (this.innerDeclared(null, name, k) || this.catchBinds(k, name)) return null;
    const decl = this.topDeclarations().get(name);
    if (decl)
      return this.unlessChanged(
        name,
        decl[0] - 2,
        this.evalRange(decl[0], decl[1], new Map(), depth + 1),
        0,
        this.tokens.length,
        null,
      );
    // `var a = 1, NAME = h(require_x())` at the top of the file, as minifiers write the
    // modules a bundle wraps: that module (only a module; other values keep their own rules).
    // Not where gaps are shown: a key or address with a gap read from such a module is not
    // claimed by the bundle when the other builds read it whole.
    // In a wrapper's key (`keyWith`), also a string or a function declared so, as `topValue`
    // reads a declaration in a list: `var U = "tidemark.", l = (t) => `${U}${t}``.
    if (!this.gaps && !this.topDeclarations().has(name)) {
      const listed = this.topListed(name);
      if (listed && !this.writtenElsewhere(name, listed[0] - 2)) {
        // a table written as a literal, `var a = …, T = { k: "x:y" }` as minifiers join the
        // declarations of a file: read as `const T = {…}` would be (never written anywhere)
        const literal =
          this.punct(listed[0], "{") ||
          this.punct(listed[0], "[") ||
          (this.is(listed[0], "ident", "Object") &&
            this.punct(listed[0] + 1, ".") &&
            this.is(listed[0] + 2, "ident", "freeze") &&
            this.punct(listed[0] + 4, "{"));
        const mod = this.evalRange(listed[0], listed[1], new Map(), depth + 1);
        if (mod?.kind === "cjs") return mod;
        if (literal && (mod?.kind === "obj" || mod?.kind === "arr"))
          return this.unlessChanged(name, listed[0] - 2, mod, 0, this.tokens.length, null);
        if (this.listedValues && (mod?.kind === "str" || mod?.kind === "fn"))
          return this.unlessChanged(name, listed[0] - 2, mod, 0, this.tokens.length, null);
      }
    }
    // a name another module defines, in a scan of this file alone: say so instead of nothing
    if (
      !this.host &&
      !this.reference &&
      (this.constants.importOf(name, k) || this.constants.requireOf(name, k))
    )
      return this.stop(`a function or value of another module, not followed here: ${name}`);
    // `var { NAME } = <expr>` or `var { KEY: NAME } = <expr>` at the top of the file
    const part = this.topPattern(name);
    if (part) {
      const whole = this.evalRange(part.from[0], part.from[1], new Map(), depth + 1);
      return whole ? this.member(whole, part.key, depth + 1) : null;
    }
    // CommonJS: `exports.X` and `module.exports.X` of this module
    if (name === "exports" && !this.topDeclarations().has(name))
      return { kind: "ns", resolver: this };
    if (name === "module" && !this.topDeclarations().has(name))
      return {
        kind: "obj",
        props: new Map([["exports", { kind: "ns", resolver: this }]]),
        open: true,
      };
    // a name another module defines, written as a reference to be filled in later
    if (!this.host && this.reference) {
      const imported = this.constants.importOf(name, k);
      if (imported)
        return {
          kind: "str",
          values: [this.reference(imported.specifier, imported.property)],
          ref: imported,
        };
      const required = this.constants.requireOf(name, k);
      if (required) return { kind: "nsref", specifier: required };
    }
    // a name another module of the application defines
    if (this.host) {
      const imported = this.constants.importOf(name, k);
      if (imported) {
        const other = this.host.load(this.file, imported.specifier);
        if (!other) return null;
        const [head, ...rest] = imported.property.split(".");
        let v = other.exportValue(head!, depth + 1);
        for (const p of rest) v = v ? this.member(v, p, depth + 1) : null;
        return v;
      }
      const required = this.constants.requireOf(name, k);
      if (required) {
        const other = this.host.load(this.file, required);
        return other ? { kind: "ns", resolver: other } : null;
      }
    }
    const fn = this.namedFunction(name);
    if (fn && this.topDeclarations().has(name) === false && this.depthAt(fn.paramsAt) === 0)
      return { kind: "fn", def: fn, env: new Map(), res: this };
    if (RUNTIME.has(name)) return this.stop(`runtime value: ${name}`);
    return null;
  }

  /**
   * The function a name means at k when a function around k declares it with
   * `function NAME(…) {…}`, once and nothing else under that name there.
   */
  private nestedFunction(k: number, name: string): FnDef | null {
    if (!this.s.fnDecls) {
      const byName = new Map<string, FnDef[]>();
      for (const d of this.functions())
        if (
          d.name !== null &&
          d.owner === null &&
          d.block &&
          !d.member &&
          this.is(d.paramsAt - 1, "ident", d.name) &&
          this.is(d.paramsAt - 2, "ident", "function")
        ) {
          const list = byName.get(d.name);
          if (list) list.push(d);
          else byName.set(d.name, [d]);
        }
      this.s.fnDecls = byName;
    }
    const candidates = this.s.fnDecls.get(name);
    if (!candidates) return null;
    for (let d = this.enclosing(k), guard = 0; d && guard < 20; guard++) {
      const declared = this.declarationIn(d, name, k);
      if (declared) {
        if (declared.range) return null; // a const, let or var
        const here = candidates.filter((f) => this.enclosing(f.paramsAt) === d);
        let declarations = 0;
        for (const j of this.occurrences(name, d.body[0], d.body[1])) {
          if (this.punct(j - 1, ".")) continue;
          const before = this.tokens[j - 1];
          if (before?.type === "ident" && /^(const|let|var|function|class)$/.test(before.value))
            declarations++;
          else if ((this.punct(j + 1, "=") && !this.punct(j + 2, "=")) || this.changes(j))
            return null;
        }
        return here.length === 1 && declarations === 1 ? here[0]! : null;
      }
      d = this.enclosing(d.paramsAt - 1);
    }
    return null;
  }

  private namedFunction(name: string): FnDef | undefined {
    if (!this.s.defsByName) {
      const byName = new Map<string, FnDef>();
      for (const d of this.functions())
        if (d.name !== null && d.owner === null && d.block && !d.member && !byName.has(d.name))
          byName.set(d.name, d);
      this.s.defsByName = byName;
    }
    return this.s.defsByName.get(name);
  }

  private arrowAt(k: number, env: Env): Val | null {
    if (!this.s.defsByParams) {
      const byParams = new Map<number, FnDef>();
      for (const d of this.functions()) if (!byParams.has(d.paramsAt)) byParams.set(d.paramsAt, d);
      this.s.defsByParams = byParams;
    }
    const def = this.s.defsByParams.get(k);
    return def ? { kind: "fn", def, env, res: this } : null;
  }

  /** Bracket depth (all kinds) at token k, from the start of the file; computed once. */
  private depthAt(k: number): number {
    if (!this.s.depths) this.bracketTables();
    return this.s.depths![k] ?? 0;
  }

  /**
   * Two tables of the file's brackets, built together in one pass on first use of either:
   * `depths`, the bracket depth (all kinds) at each token counted from the start of the file
   * (every closing bracket counts, so it can go below 0), and `parents`, the innermost open
   * bracket around each token (-1: none; a closing bracket with none open is passed over).
   */
  private bracketTables(): void {
    const tokens = this.tokens;
    const n = tokens.length;
    const depths = new Int32Array(n);
    const parents = new Int32Array(n);
    const open: number[] = [];
    let top = -1;
    let d = 0;
    for (let j = 0; j < n; j++) {
      depths[j] = d;
      parents[j] = top;
      const p = tokens[j]!;
      if (p.type !== "punct") continue;
      const v = p.value;
      if (v === "{" || v === "(" || v === "[") {
        d++;
        open.push(j);
        top = j;
      } else if (v === "}" || v === ")" || v === "]") {
        d--;
        if (open.length) {
          open.pop();
          top = open.length ? open[open.length - 1]! : -1;
        }
      }
    }
    this.s.depths = depths;
    this.s.parents = parents;
  }

  /** `const|let|var NAME = <expr>` at depth 0, declared once and not assigned elsewhere. */
  private topDeclarations(): Map<string, [number, number] | null> {
    if (this.s.topDecls) return this.s.topDecls;
    const decls = new Map<string, [number, number] | null>();
    const assigned = new Set<string>();
    /** Names a member of which is written, and the names each is another name for. */
    const memberWritten = new Set<string>();
    const aliasesOf = new Map<string, string[]>();
    const through = new Set<string>();
    this.s.writtenThrough = through;
    let d = 0;
    const tokens = this.tokens;
    for (let k = 0; k < tokens.length; k++) {
      const t = tokens[k]!;
      if (t.type === "punct") {
        if (t.value === "{" || t.value === "(" || t.value === "[") d++;
        else if (t.value === "}" || t.value === ")" || t.value === "]") d--;
        continue;
      }
      if (t.type !== "ident") continue;
      const declaring =
        (t.value === "const" || t.value === "let" || t.value === "var") &&
        this.is(k + 1, "ident") &&
        this.punct(k + 2, "=");
      if (declaring && d === 0) {
        const name = tokens[k + 1]!.value;
        decls.set(name, decls.has(name) ? null : [k + 3, this.exprEnd(k + 3)]);
        k += 2;
        continue;
      }
      // A later assignment `NAME = …`, a write to a property or an element (`NAME.KEY = …`,
      // `NAME[k] = …`, `NAME[0].p = …`, `delete NAME.k`), a call that changes it (`push`,
      // `set`, `Object.assign(NAME, …)`, `Object.defineProperty(NAME, …)`), or a write to the
      // members of a loop variable that runs over it: the declaration no longer says what the
      // name holds.
      if (this.punct(k - 1, ".")) continue;
      const prev = tokens[k - 1];
      const declares = prev?.type === "ident" && /^(const|let|var)$/.test(prev.value);
      // a plain `NAME = …` in any scope (not a parameter default or class field), any other
      // write where it is not to a local of the same name
      if (
        writesName(tokens, k) &&
        ((this.punct(k + 1, "=") && !declares) || !shadowedAt(tokens, k, t.value))
      )
        assigned.add(t.value);
      else if (this.writesAt(k)) {
        assigned.add(t.value);
        memberWritten.add(t.value);
      }
      // `const U = T;`: a write through U writes T
      if (
        this.punct(k - 1, "=") &&
        declaredAt(tokens, k - 2) &&
        (this.punct(k + 1, ";") ||
          this.punct(k + 1, ",") ||
          (tokens[k + 1]?.line ?? Infinity) > t.line)
      ) {
        const list = aliasesOf.get(tokens[k - 2]!.value) ?? [];
        list.push(t.value);
        aliasesOf.set(tokens[k - 2]!.value, list);
      }
    }
    for (let round = 0; round < 3; round++)
      for (const [alias, targets] of aliasesOf)
        if (memberWritten.has(alias))
          for (const target of targets) {
            through.add(target);
            // a table or list: a string constant cannot be written through a member
            const range = decls.get(target);
            if (range && (this.punct(range[0], "{") || this.punct(range[0], "[")))
              assigned.add(target);
            memberWritten.add(target);
          }
    this.s.topDeclsLoose = new Map(decls);
    for (const name of assigned) if (decls.has(name)) decls.set(name, null);
    this.s.topDecls = decls;
    return decls;
  }

  /**
   * NAME bound by an object pattern at depth 0, `var { KEY: NAME } = <expr>` or `var { NAME } = …`,
   * declared once and not assigned again: the key it reads and the expression it reads it from.
   */
  private topPattern(name: string): { key: string; from: [number, number] } | null {
    const cached = this.s.topPatterns.get(name);
    if (cached !== undefined) return cached;
    let found: { key: string; from: [number, number] } | null = null;
    let bound = 0;
    const all = this.positions(name);
    // a name used this often (a minifier's one-letter local) is not worth the scan
    if (all.length > 4000) bound = 2;
    else
      for (const j of all) {
        if (this.punct(j - 1, ".")) continue;
        // a later write: the pattern no longer says what the name holds
        if ((this.punct(j + 1, "=") && !this.punct(j + 2, "=")) || this.changes(j)) {
          bound += 2;
          continue;
        }
        if (!this.punct(j + 1, ",") && !this.punct(j + 1, "}")) continue;
        const renamed = this.punct(j - 1, ":") && this.is(j - 2, "ident");
        if (!renamed && !this.punct(j - 1, "{") && !this.punct(j - 1, ",")) continue;
        // the brace the name is in, and what comes before it: `var {`, or `, {` of a declarator list
        let open = j - 1;
        while (open > 0 && open > j - 400 && !(this.punct(open, "{") && this.match[open]! > j))
          open--;
        if (!this.punct(open, "{")) continue;
        const close = this.match[open]!;
        if (!this.punct(close + 1, "=") || this.punct(close + 2, "=")) continue;
        if (!(this.is(open - 1, "ident") && /^(const|let|var)$/.test(this.tokens[open - 1]!.value)))
          if (!this.punct(open - 1, ",")) continue;
        // outside every function, and not nested in another pattern or brackets
        if (this.enclosing(open) || this.depthAt(open) !== 0) continue;
        bound++;
        found = {
          key: renamed ? this.tokens[j - 2]!.value : name,
          from: [close + 2, this.exprEnd(close + 2)],
        };
      }
    const result = bound === 1 && !this.topDeclarations().has(name) ? found : null;
    this.s.topPatterns.set(name, result);
    return result;
  }

  // ---------- functions ----------

  private parseParams(open: number, close: number): Param[] {
    const params: Param[] = [];
    let k = open + 1;
    while (k < close) {
      const end = Math.min(this.exprEnd(k), close);
      const t = this.tokens[k]!;
      if (t.type === "ident")
        params.push(
          this.punct(k + 1, "=")
            ? { kind: "name", name: t.value, fallback: [k + 2, end] }
            : { kind: "name", name: t.value },
        );
      else if (t.type === "punct" && t.value === "{") {
        const props = new Map<string, string>();
        const defaults = new Map<string, [number, number]>();
        let rest: string | undefined;
        const m = this.match[k]!;
        for (let j = k + 1; j < m; j++) {
          if (this.punct(j, "...") && this.is(j + 1, "ident")) {
            rest = this.tokens[j + 1]!.value;
            j++;
            continue;
          }
          if (!this.is(j, "ident")) continue;
          let local: string | null = null;
          if (this.punct(j + 1, ":") && this.is(j + 2, "ident")) {
            local = this.tokens[j + 2]!.value;
            props.set(this.tokens[j]!.value, local);
            j += 2;
          } else if (this.punct(j - 1, "{") || this.punct(j - 1, ",")) {
            local = this.tokens[j]!.value;
            props.set(local, local);
          }
          // `name = <default>` up to the next `,` or the closing brace
          if (local !== null && this.punct(j + 1, "=") && !this.punct(j + 2, "=")) {
            const until = Math.min(this.exprEnd(j + 2), m);
            defaults.set(local, [j + 2, until]);
            j = until - 1;
          }
        }
        params.push({
          kind: "object",
          props,
          ...(defaults.size ? { defaults } : {}),
          ...(rest ? { rest } : {}),
        });
      } else if (t.type === "punct" && t.value === "[") {
        const names: Array<string | null> = [];
        const m = this.match[k]!;
        let slot: string | null = null;
        for (let j = k + 1; j <= m; j++) {
          if (this.punct(j, ",") || j === m) {
            names.push(slot);
            slot = null;
          } else if (this.is(j, "ident") && slot === null) slot = this.tokens[j]!.value;
        }
        params.push({ kind: "array", names });
      } else params.push({ kind: "name", name: "" });
      k = end + 1;
    }
    return params;
  }

  private classRanges(): Array<{ name: string; start: number; end: number }> {
    if (this.s.classes) return this.s.classes;
    const out: Array<{ name: string; start: number; end: number }> = [];
    for (let k = 0; k + 2 < this.tokens.length; k++) {
      if (!this.is(k, "ident", "class")) continue;
      // `class Name {`, or `var Name = class {` as bundlers write it (the variable names it)
      // or `exports.Name = class {`, as tsc writes an exported class expression
      const name =
        this.is(k + 1, "ident") && !this.is(k + 1, "ident", "extends")
          ? this.tokens[k + 1]!.value
          : this.punct(k - 1, "=") && this.is(k - 2, "ident")
            ? this.tokens[k - 2]!.value
            : null;
      if (name === null) continue;
      let open = k + 1;
      while (open < this.tokens.length && open < k + 20 && !this.punct(open, "{")) open++;
      const close = this.match[open] ?? -1;
      if (this.punct(open, "{") && close !== -1) out.push({ name, start: open, end: close });
    }
    this.s.classes = out;
    return out;
  }

  /** `{ key: <function at k>` or `, key: <function at k>`: the key, for functions as object values. */
  private memberKey(k: number): string | null {
    let at = k;
    if (this.is(at - 1, "ident", "async")) at--;
    if (!this.punct(at - 1, ":") || !this.is(at - 2, "ident")) return null;
    return this.punct(at - 3, "{") || this.punct(at - 3, ",") ? this.tokens[at - 2]!.value : null;
  }

  /** Every function of the file with its parameters and body. */
  private functions(): FnDef[] {
    if (this.s.defs) return this.s.defs;
    const defs: FnDef[] = [];
    const tokens = this.tokens;
    // A method belongs to the class whose body is the innermost bracket around its name: a
    // method of an object literal inside a method (`m() { const o = { save(z) {…} } }`) is not
    // one of the class, nor is a method of a class nested in it.
    const classStarts = new Map(this.classRanges().map((c) => [c.start, c.name]));
    this.innermostBlock(0, null); // builds the table of brackets
    const parents = this.s.parents!;
    const classAt = (k: number): string | null => classStarts.get(parents[k]!) ?? null;
    for (let k = 0; k < tokens.length && defs.length < MAX_FUNCTIONS; k++) {
      const t = tokens[k]!;
      // function NAME ( … ) {   /   function ( … ) {
      if (t.type === "ident" && t.value === "function") {
        let p = k + 1;
        if (this.punct(p, "*")) p++;
        const name = this.is(p, "ident") ? tokens[p]!.value : null;
        if (name !== null) p++;
        if (!this.punct(p, "(")) continue;
        const close = this.match[p]!;
        if (close === -1 || !this.punct(close + 1, "{")) continue;
        const assigned =
          name === null && this.punct(k - 1, "=") && this.is(k - 2, "ident")
            ? tokens[k - 2]!.value
            : name === null
              ? this.memberKey(k)
              : null;
        const keyed = name === null && assigned !== null && !this.punct(k - 1, "=");
        defs.push({
          ...(keyed ? { member: true as const } : {}),
          name: name ?? assigned,
          owner: null,
          params: this.parseParams(p, close),
          paramsAt: p,
          body: [close + 1, (this.match[close + 1] ?? close + 1) + 1],
          block: true,
          calledBy: this.calledBy(k),
        });
        continue;
      }
      // ( … ) => …   /   p => …
      const arrowParams =
        this.punct(k, "(") && this.match[k] !== -1 && this.punct(this.match[k]! + 1, "=>");
      const loneParam = t.type === "ident" && this.punct(k + 1, "=>") && !this.punct(k - 1, ")");
      if (arrowParams || loneParam) {
        const close = arrowParams ? this.match[k]! : k;
        const arrow = close + 1;
        const block = this.punct(arrow + 1, "{");
        const body: [number, number] = block
          ? [arrow + 1, (this.match[arrow + 1] ?? arrow + 1) + 1]
          : [arrow + 1, this.exprEnd(arrow + 1)];
        let start = k;
        if (this.is(k - 1, "ident", "async")) start = k - 1;
        const assigned =
          this.punct(start - 1, "=") && this.is(start - 2, "ident")
            ? tokens[start - 2]!.value
            : this.memberKey(start);
        const keyed = assigned !== null && !this.punct(start - 1, "=");
        defs.push({
          ...(keyed ? { member: true as const } : {}),
          arrow: true,
          name: assigned,
          owner: null,
          params: arrowParams ? this.parseParams(k, close) : [{ kind: "name", name: t.value }],
          paramsAt: k,
          body,
          block,
          calledBy: this.calledBy(start),
        });
        continue;
      }
      // a method with a string or number key, as bundlers write module wrappers:
      // `{ "src/a.js"(exports) { … } }` (esbuild), `{ 76675(e, n, i) { … } }` (webpack 5)
      if (
        (t.type === "string" || t.type === "number") &&
        this.punct(k + 1, "(") &&
        (this.punct(k - 1, "{") || this.punct(k - 1, ","))
      ) {
        const close = this.match[k + 1]!;
        if (close !== -1 && this.punct(close + 1, "{"))
          defs.push({
            member: true,
            name: null,
            owner: null,
            params: this.parseParams(k + 1, close),
            paramsAt: k + 1,
            body: [close + 1, (this.match[close + 1] ?? close + 1) + 1],
            block: true,
            calledBy: null,
          });
        continue;
      }
      // a method in a class body: NAME ( … ) {
      if (t.type === "ident" && this.punct(k + 1, "(") && !this.punct(k - 1, ".")) {
        const close = this.match[k + 1]!;
        if (close === -1 || !this.punct(close + 1, "{")) continue;
        const owner = classAt(k);
        const prev = tokens[k - 1];
        // outside a class: a shorthand method of an object literal, `{ getJson(url) { … }, … }`
        if (owner === null) {
          const member =
            prev?.type === "punct"
              ? prev.value === "{" || prev.value === ","
              : prev?.type === "ident" &&
                /^(async|get|set)$/.test(prev.value) &&
                (this.punct(k - 2, "{") || this.punct(k - 2, ","));
          if (!member || /^(if|for|while|switch|catch|function|with)$/.test(t.value)) continue;
          defs.push({
            member: true,
            name: t.value,
            owner: null,
            params: this.parseParams(k + 1, close),
            paramsAt: k + 1,
            body: [close + 1, (this.match[close + 1] ?? close + 1) + 1],
            block: true,
            calledBy: null,
          });
          continue;
        }
        const starts =
          !prev ||
          (prev.type === "punct" &&
            (prev.value === "{" || prev.value === "}" || prev.value === ";")) ||
          (prev.type === "ident" && /^(static|async|get|set)$/.test(prev.value));
        if (!starts || /^(if|for|while|switch|catch|function|with)$/.test(t.value)) continue;
        const isStatic =
          this.is(k - 1, "ident", "static") ||
          (/^(async|get|set)$/.test(prev?.type === "ident" ? prev.value : "") &&
            this.is(k - 2, "ident", "static"));
        defs.push({
          ...(isStatic ? { static: true as const } : {}),
          name: t.value,
          owner,
          params: this.parseParams(k + 1, close),
          paramsAt: k + 1,
          body: [close + 1, (this.match[close + 1] ?? close + 1) + 1],
          block: true,
          calledBy: null,
        });
      }
    }
    this.s.defs = defs;
    return defs;
  }

  /** For a function written as an argument: `recv.method(<here>`. */
  private calledBy(start: number): FnDef["calledBy"] {
    if (!this.punct(start - 1, "(")) return null;
    let open = start - 1;
    // `list.forEach((e => { … }))`: the callback in parentheses of its own, as terser writes it
    if (
      this.punct(open - 1, "(") &&
      !this.is(open - 2, "ident", "function") &&
      this.match[open - 1] !== -1 &&
      this.match[open - 1] === this.match[open]! + 1 &&
      !this.punct(this.match[open]! - 1, "=>")
    )
      open--;
    if (!this.is(open - 1, "ident") || !this.punct(open - 2, ".")) return null;
    return { method: this.tokens[open - 1]!.value, receiverEnd: open - 2 };
  }

  /** The innermost function whose body holds token k; one table for the file, built once. */
  private enclosing(k: number): FnDef | null {
    if (!this.s.innermost) {
      const defs = this.functions();
      const n = this.tokens.length;
      const table = new Int32Array(n).fill(-1);
      // The smallest body around each token wins (equal bodies: the earlier function). Bodies
      // nest, so one sweep with a stack of the open bodies gives it in linear time; a body that
      // overlaps another without nesting is written over the part it covers, as larger-first
      // filling did. Writing each body whole made a deep nesting of functions quadratic.
      const order = defs
        .map((_, i) => i)
        .filter((i) => defs[i]!.body[1] > defs[i]!.body[0])
        .toSorted(
          (a, b) =>
            defs[a]!.body[0] - defs[b]!.body[0] ||
            // the same start: the larger body first, so the smaller is on top of the stack
            defs[b]!.body[1] - defs[a]!.body[1] ||
            b - a,
        );
      const stack: number[] = [];
      let next = 0;
      for (let at = 0; at < n; at++) {
        while (stack.length && defs[stack.at(-1)!]!.body[1] <= at) stack.pop();
        while (next < order.length && defs[order[next]!]!.body[0] <= at) {
          const i = order[next++]!;
          if (defs[i]!.body[1] > at) {
            // keep the stack ordered by end: a body that outlives the one on top is no nested one
            const end = defs[i]!.body[1];
            const top = stack.length ? defs[stack.at(-1)!]!.body[1] : Infinity;
            if (end <= top) stack.push(i);
            else {
              // an overlapping body: insert it below the ones that end before it
              let place = stack.length;
              while (place > 0 && defs[stack[place - 1]!]!.body[1] < end) place--;
              stack.splice(place, 0, i);
            }
          }
        }
        if (stack.length) table[at] = stack.at(-1)!;
      }
      this.s.innermost = table;
    }
    const i = this.s.innermost[k] ?? -1;
    return i === -1 ? null : this.functions()[i]!;
  }

  private paramIndex(def: FnDef, name: string): number {
    return def.params.findIndex(
      (p) =>
        (p.kind === "name" && p.name === name) ||
        (p.kind === "object" && [...p.props.values()].includes(name)) ||
        (p.kind === "array" && p.names.includes(name)),
    );
  }

  private enclosingParam(k: number, name: string): boolean {
    for (let d = this.enclosing(k), guard = 0; d && guard < 20; guard++) {
      if (this.paramIndex(d, name) !== -1) return true;
      d = this.enclosing(d.paramsAt - 1);
    }
    return false;
  }

  /**
   * Whether a function around k declares or assigns the name itself (`const P = …`, `P = …`,
   * a nested `function P`): then the top-level declaration is not what k means, and nothing is
   * read for it.
   */
  private declaredLocally(k: number, name: string): boolean {
    for (let d = this.enclosing(k), guard = 0; d && guard < 20; guard++) {
      for (const j of this.occurrences(name, d.body[0], d.body[1])) {
        if (this.punct(j - 1, ".")) continue;
        const before = this.tokens[j - 1];
        if (
          (before?.type === "ident" && /^(const|let|var|function|class)$/.test(before.value)) ||
          (this.punct(j + 1, "=") && !this.punct(j + 2, "="))
        )
          return true;
      }
      d = this.enclosing(d.paramsAt - 1);
    }
    return false;
  }

  /** `const NAME = …` once in the innermost function around k that declares NAME, before k. */
  /**
   * NAME at k is bound to a module object: in the innermost function around k that binds NAME
   * (no function in between has a parameter of that name), NAME is declared once as
   * `NAME = r(<number>)` with r a parameter of that function (webpack's require), `require("…")`,
   * or `h(require_x())` (esbuild's interop around a wrapped module), and never assigned again.
   * The declaration stands before k, or k is inside a function nested in the one that declares
   * NAME (webpack modules define functions before `const r = n(…)`; they run later).
   */
  moduleBinding(k: number, name: string): boolean {
    if (this.catchBinds(k, name)) return false;
    const own = this.enclosing(k);
    for (let d = own, guard = 0; d && guard < 20; guard++) {
      if (this.paramIndex(d, name) !== -1) return false;
      const decl = this.declarationIn(d, name, k);
      if (decl)
        return (
          !!decl.range && (decl.range[0] - 2 < k || d !== own) && this.moduleInit(decl.range, d)
        );
      d = this.enclosing(d.paramsAt - 1);
    }
    const top = this.topDeclarations().get(name);
    return !!top && (top[0] - 2 < k || own !== null) && this.moduleInit(top, null);
  }

  private moduleInit([a, b]: [number, number], d: FnDef | null): boolean {
    const t = this.tokens;
    if (!this.is(a, "ident") || !this.punct(a + 1, "(")) return false;
    // `r(123)` with r the module function's require parameter, `require("./x")`
    if (b === a + 4 && this.punct(a + 3, ")")) {
      if (t[a + 2]?.type === "number") return !!d && this.paramIndex(d, t[a]!.value) !== -1;
      return t[a]!.value === "require" && t[a + 2]?.type === "string";
    }
    // `__toESM(require_x())`, also with esbuild's node-mode argument
    return (
      this.is(a + 2, "ident") &&
      t[a + 2]!.value.startsWith("require_") &&
      this.punct(a + 3, "(") &&
      this.punct(a + 4, ")") &&
      (this.punct(a + 5, ")") || (this.punct(a + 5, ",") && this.punct(a + 7, ")"))) &&
      this.match[a + 1] === b - 1
    );
  }

  private localConst(k: number, name: string): [number, number] | null {
    for (let d = this.enclosing(k), guard = 0; d && guard < 20; guard++) {
      const decl = this.declarationIn(d, name, k);
      if (decl) return decl.range && decl.range[0] - 2 < k ? decl.range : null;
      d = this.enclosing(d.paramsAt - 1);
    }
    return null;
  }

  /**
   * The name at j is written there (see `writesName`): `x += …`, `x++`, `--x`, `[x] = …`,
   * `({ x } = …)`, `for (x of …)`, and a plain `x = …` that is no declaration.
   */
  private changes(j: number): boolean {
    return writesName(this.tokens, j);
  }

  /**
   * How `name` is declared directly in the body of d: null when it is not, otherwise the
   * initializer of its single `const`, `let` or `var` that is never assigned again (null range
   * for anything else).
   */
  private declarationIn(
    d: FnDef,
    name: string,
    k: number,
  ): { range: [number, number] | null } | null {
    const key = `${d.paramsAt}:${name}`;
    let entries = this.s.declCache.get(key);
    if (!entries) {
      entries = [];
      for (const j of this.occurrences(name, d.body[0], d.body[1])) {
        if (this.punct(j - 1, ".")) continue;
        const before = this.tokens[j - 1];
        if (before?.type === "ident" && /^(const|let|var|function|class)$/.test(before.value)) {
          // `let` and `var` too: a later assignment counts twice, so the name is not followed
          const init = /^(const|let|var)$/.test(before.value) && this.punct(j + 1, "=");
          const blockScoped = /^(const|let|class)$/.test(before.value);
          entries.push({ j, weight: 1, init, scope: blockScoped ? this.blockScope(j, d) : null });
        } else if (
          this.punct(j - 1, ",") &&
          this.punct(j + 1, "=") &&
          !this.punct(j + 2, "=") &&
          this.inDeclarationList(j)
        )
          // `var a = 1, NAME = …`, as minifiers write declarations
          entries.push({ j, weight: 1, init: true, scope: null });
        else if ((this.punct(j + 1, "=") && !this.punct(j + 2, "=")) || this.changes(j))
          entries.push({ j, weight: 2, init: false, scope: null });
        // a member or element written (`T.A = …`, `T.A += …`, `T.push(…)`), as at the top
        // (`topDeclarations`): the declaration no longer says what the name holds. The query
        // of a URL (`url.searchParams.set(…)`, `url.search = …`) is no part of an address read.
        else if (
          !(
            this.punct(j + 1, ".") &&
            /^(searchParams|search|hash)$/.test(this.tokens[j + 2]?.value ?? "")
          ) &&
          this.writesAt(j)
        )
          entries.push({ j, weight: 2, init: false, scope: null });
      }
      this.s.declCache.set(key, entries);
    }
    // a declaration of an inner block counts only for a use inside that block
    let at = -1;
    let declared = 0;
    for (const e of entries) {
      if (e.scope && !(e.scope[0] < k && k < e.scope[1])) continue;
      declared += e.weight;
      if (e.init) at = e.j;
    }
    if (!declared) return null;
    return {
      range:
        declared === 1 && at >= 0 ? ([at + 2, this.exprEnd(at + 2)] as [number, number]) : null,
    };
  }

  /**
   * Where a `const`, `let` or `class` declared at j is visible: null at the function's own block
   * level, else the block it is in (for a `for (…)` header, the header and the loop body).
   */
  private blockScope(j: number, d: FnDef | null): [number, number] | null {
    const start = d ? d.body[0] : -1;
    for (let i = j - 1, steps = 0; i > start && steps < 20_000; i--, steps++) {
      const t = this.tokens[i]!;
      if (t.type !== "punct") continue;
      if (t.value === ")" || t.value === "]" || t.value === "}") {
        const o = this.opener[i]!;
        if (o === -1) return [i, i];
        i = o;
      } else if (t.value === "{" || t.value === "[") return [i, this.match[i]!];
      else if (t.value === "(") {
        const close = this.match[i]!;
        if (!this.is(i - 1, "ident", "for") || close === -1) return [i, close];
        const body = this.punct(close + 1, "{") ? this.match[close + 1]! : this.exprEnd(close + 1);
        return [i, Math.max(close, body)];
      }
    }
    return null;
  }

  /** Whether the name at j (after a `,`) is a declarator of a `const`, `let` or `var` list. */
  private inDeclarationList(j: number): boolean {
    for (let i = j - 1, steps = 0; i >= 0 && steps < 4000; i--, steps++) {
      const t = this.tokens[i]!;
      if (t.type === "punct") {
        if (t.value === ")" || t.value === "]" || t.value === "}") {
          const o = this.opener[i]!;
          if (o === -1) return false;
          i = o;
        } else if (t.value === "(" || t.value === "[" || t.value === "{" || t.value === ";")
          return false;
      } else if (t.type === "ident" && /^(const|let|var)$/.test(t.value)) return true;
      else if (
        t.type === "ident" &&
        STATEMENT_WORDS.has(t.value) &&
        // `var s = class {…}, i = new s`: a class or function expression is no statement
        !(
          (t.value === "class" || t.value === "function") &&
          (this.punct(i - 1, "=") || this.punct(i - 1, ",") || this.punct(i - 1, "("))
        )
      )
        return false;
    }
    return false;
  }

  /** Names read in [start, end) that are parameters of the function around k. */
  private throughParameters(start: number, end: number, depth: number): string[] | null {
    if (depth > 3) return null;
    // the innermost function around the expression that declares one of the names it reads
    let def = this.enclosing(start);
    const used = new Set<string>();
    // what the expression reads, with the initializers of local consts it reads
    const reads: Array<[number, number]> = [[start, end]];
    for (let r = 0; r < reads.length && r < 8; r++)
      for (let j = reads[r]![0]; j < reads[r]![1]; j++) {
        if (!this.is(j, "ident") || this.punct(j - 1, ".")) continue;
        const local = this.localConst(j, this.tokens[j]!.value);
        if (local && !reads.some(([a]) => a === local[0])) reads.push(local);
      }
    for (let guard = 0; def && guard < 8; guard++) {
      for (const [a, b] of reads)
        for (let j = a; j < b; j++)
          if (
            this.is(j, "ident") &&
            !this.punct(j - 1, ".") &&
            (this.paramIndex(def, this.tokens[j]!.value) !== -1 ||
              (this.tokens[j]!.value === "this" && def.owner !== null))
          )
            used.add(this.tokens[j]!.value);
      if (used.size) break;
      def = this.enclosing(def.paramsAt - 1);
    }
    if (!def) return this.throughLoop(start, end, depth);
    if (!used.size) return this.throughLoop(start, end, depth);
    // a round of a `forEach` / `map` callback: a call after a condition, `continue` or `return`
    // in it is not made in every round
    if (def.calledBy && def.name === null && this.conditionalBefore(def.body[0], start))
      return null;
    // a parameter the function assigns to (`channel = "x:" + channel`) no longer holds what the
    // call sites pass: not read
    for (const name of used) {
      if (name === "this") continue;
      for (const j of this.occurrences(name, def.body[0], def.body[1]))
        if (
          !this.punct(j - 1, ".") &&
          ((this.punct(j + 1, "=") && !this.punct(j + 2, "=")) || this.changes(j))
        )
          return null;
    }
    const envs = this.bindings(def, depth);
    if (!envs?.length) return null;
    const values: string[] = [];
    for (const env of envs) {
      const v = this.evalRange(start, end, env, depth + 1);
      // A call site whose argument cannot be read adds nothing; the result then says it is
      // partial, so the caller keeps the call as unresolved as well.
      if (v?.kind !== "str") {
        this.partial = true;
        continue;
      }
      values.push(...v.values);
      if (values.length > MAX_VALUES) return null;
    }
    return values.length ? values : null;
  }

  /** `for (const r of LIST) … r.channel …`: one value per element of a readable list. */
  private throughLoop(start: number, end: number, depth: number): string[] | null {
    const loop = this.loopEnvs(start, end, depth);
    if (!loop) return null;
    // a call after a condition, `continue`, `break` or `return` is not made in every round
    if (this.conditionalBefore(loop.body, start)) return null;
    const values: string[] = [];
    for (const env of loop.envs) {
      const v = this.evalRange(start, end, env, depth + 1);
      if (v?.kind !== "str") return null;
      values.push(...v.values);
    }
    this.note("element");
    this.lines.add(loop.line);
    return values;
  }

  /**
   * The innermost `for (const PATTERN of LIST)` whose body holds [start, end): one environment
   * per element of LIST, its pattern bound to the element. Null when there is no such loop, it is
   * another kind of loop, or LIST is not read whole (also when LIST reads a parameter of the
   * function the loop is in, and a binding of that is not read).
   */
  private loopEnvs(
    start: number,
    end: number,
    depth: number,
  ): { envs: Env[]; line: number; at: number; body: number } | null {
    for (let j = start - 1; j >= 0 && j > start - 4000; j--) {
      // the walk back is charged to the file's work, so the questions together stay bounded
      if (this.work-- <= 0) return null;
      if (!this.is(j, "ident", "for") || !this.punct(j + 1, "(")) continue;
      const close = this.match[j + 1]!;
      if (close === -1) continue;
      const bodyEnd = this.punct(close + 1, "{") ? this.match[close + 1]! : this.exprEnd(close + 1);
      if (!(close < start && end <= bodyEnd + 1)) continue;
      let p = j + 2;
      if (this.is(p, "ident", "const") || this.is(p, "ident", "let") || this.is(p, "ident", "var"))
        p++;
      const patternEnd = this.punct(p, "[") || this.punct(p, "{") ? this.match[p]! + 1 : p + 1;
      if (!this.is(patternEnd, "ident", "of")) return null;
      const params = this.parseParams(p - 1, patternEnd);
      // parseParams expects `( … )`; fake the bounds around the single pattern
      const param = params[0];
      if (!param) return null;
      const envs: Env[] = [];
      // the list may read a parameter of the function the loop is in: once per binding of it
      const outer = this.envsFor(patternEnd + 1, patternEnd + 1, close, depth + 1, true);
      for (const caller of outer) {
        // read strictly (see `strict`): a list an alias, an unread callee or a deeper write
        // may change is not read, as for the readers of tables built into IPC
        const list = this.strictly(() => this.evalRange(patternEnd + 1, close, caller, depth + 1));
        if (!list) return null;
        // a list longer than is read: the rounds read are not all there are
        if (list.kind === "arr" && list.more) this.partial = true;
        const elems =
          list.kind === "arr"
            ? list.elems
            : list.kind === "map"
              ? list.entries.map(([a, b]) => ({
                  kind: "arr" as const,
                  elems: [a, b],
                  line: list.line,
                }))
              : null;
        if (!elems?.length) return null;
        for (const e of elems) {
          if (!e) return null;
          const env: Env = new Map(caller);
          this.bind([param], [e], env);
          envs.push(env);
        }
      }
      return { envs, line: this.tokens[patternEnd + 1]!.line, at: j, body: close + 1 };
    }
    return null;
  }

  /**
   * For token k inside a loop over a readable list, `for (const … of LIST)` or a `LIST.forEach` /
   * `map` callback around it (the innermost of the two): per element of LIST, in order, the value
   * of each of the ranges with the loop's variables bound to that element. Null when k is in
   * neither, or LIST (or any element of it) is not read whole.
   */
  perElement(
    k: number,
    ranges: ReadonlyArray<[number, number]>,
  ): { rows: Array<Array<Val | null>>; line: number } | null {
    return this.guarded(null, () => this.strictly(() => this.perElementIn(k, ranges)));
  }

  private perElementIn(
    k: number,
    ranges: ReadonlyArray<[number, number]>,
  ): { rows: Array<Array<Val | null>>; line: number } | null {
    {
      if (this.work <= 0) return null;
      this.begin(20_000);
      let cb = this.enclosing(k);
      for (let guard = 0; cb && guard < 4 && !(cb.calledBy && cb.name === null); guard++) {
        this.work--;
        cb = this.enclosing(cb.paramsAt - 1);
      }
      if (cb && !(cb.calledBy && cb.name === null)) cb = null;
      const end = Math.max(...ranges.map(([, b]) => b), k + 1);
      this.partial = false;
      this.cut = false;
      const loop = this.loopEnvs(k, end, 0);
      let envs: Env[] | null;
      let line: number;
      if (cb && (!loop || cb.paramsAt > loop.at)) {
        // a call after a condition, `continue`, `break` or `return` in the round is not made
        // in every round
        if (this.conditionalBefore(cb.body[0], k)) return null;
        envs = this.bindings(cb, 0);
        const receiver = this.receiverStart(cb.calledBy!.receiverEnd);
        line = this.tokens[receiver ?? cb.paramsAt]!.line;
      } else {
        if (loop && this.conditionalBefore(loop.body, k)) return null;
        envs = loop?.envs ?? null;
        line = loop?.line ?? 0;
      }
      if (!envs?.length || envs.length > MAX_ITERATIONS || this.partial) return null;
      const rows = envs.map((env) => ranges.map(([a, b]) => this.evalRange(a, b, env, 1)));
      return { rows, line };
    }
  }

  /**
   * Whether anything in [from, to) may skip what follows in the same round or make it
   * conditional: `if`, `else`, `continue`, `break`, `return`, `throw`, `switch`, `case`, a
   * nested loop, `try`, `?`, `&&`, `||`, `??`. A round with any of them is not read.
   */
  private conditionalBefore(from: number, to: number): boolean {
    for (let j = Math.max(0, from); j < to; j++) {
      if (this.work-- <= 0) return true;
      const t = this.tokens[j]!;
      if (
        t.type === "ident"
          ? CONTROL_WORDS.has(t.value)
          : t.type === "punct" && CONTROL_PUNCT.has(t.value)
      )
        return true;
    }
    return false;
  }

  /**
   * For `NAME[KEY] = VALUE` at k (k is NAME) run once per element of a readable list: in a
   * `for (… of LIST)` around it, or in the body of a `LIST.forEach(cb)` / `map` callback (not in a
   * function nested deeper), with NAME not bound by that callback. Per element, the key (one whole
   * string) and the value. Null when the statement is no such assignment or any round is not
   * read.
   */
  loopAssignments(k: number): Array<{ key: string; value: Val | null }> | null {
    return this.guarded(null, () => this.strictly(() => this.loopAssignmentsIn(k)));
  }

  private loopAssignmentsIn(k: number): Array<{ key: string; value: Val | null }> | null {
    if (this.work <= 0) return null;
    this.begin(20_000);
    const name = this.tokens[k];
    if (name?.type !== "ident" || !this.punct(k + 1, "[")) return null;
    const close = this.match[k + 1]!;
    if (close === -1 || !this.punct(close + 1, "=") || this.punct(close + 2, "=")) return null;
    const valueEnd = this.exprEnd(close + 2);
    this.partial = false;
    this.cut = false;
    let envs: Env[] | null = null;
    const def = this.enclosing(k);
    if (def?.calledBy && def.name === null) {
      if (paramNames(def.params).includes(name.value) || this.declaredLocally(k, name.value))
        return null;
      // a write after a condition, `continue` or `return` is not made in every round
      if (this.conditionalBefore(def.body[0], k)) return null;
      envs = this.bindings(def, 0);
    } else {
      const loop = this.loopEnvs(k, valueEnd, 0);
      if (loop && this.conditionalBefore(loop.body, k)) return null;
      envs = loop?.envs ?? null;
      // `api["open"] = …`, `api[KEY] = …` outside any loop: the one key it names, as `api.open`
      if (!loop && !this.insideLoop(k)) {
        const key = this.oneString(this.evalRange(k + 2, close, new Map(), 1));
        return key === null
          ? null
          : [{ key, value: this.evalRange(close + 2, valueEnd, new Map(), 1) }];
      }
    }
    if (!envs?.length || envs.length > MAX_ITERATIONS || this.partial) return null;
    const out: Array<{ key: string; value: Val | null }> = [];
    for (const env of envs) {
      const key = this.oneString(this.evalRange(k + 2, close, env, 1));
      if (key === null) return null;
      out.push({ key, value: this.evalRange(close + 2, valueEnd, env, 1) });
    }
    return out;
  }

  /** Whether a `for`, `while` or `do` loop of the function around k has k in its body. */
  private insideLoop(k: number): boolean {
    const own = this.enclosing(k);
    for (let j = k - 1; j >= 0 && j > k - 4000; j--) {
      if (this.work-- <= 0) return true;
      const t = this.tokens[j]!;
      if (t.type !== "ident") continue;
      if (own && j < own.body[0]) return false;
      if (t.value === "do" && this.punct(j + 1, "{")) {
        if (this.match[j + 1]! > k) return true;
      } else if ((t.value === "for" || t.value === "while") && this.punct(j + 1, "(")) {
        const head = this.match[j + 1]!;
        if (head === -1) continue;
        const end = this.punct(head + 1, "{") ? this.match[head + 1]! : this.exprEnd(head + 1);
        if (head < k && k <= end) return true;
      }
    }
    return false;
  }

  /**
   * The object the expression at k builds, as members that each forward to one call: read whole
   * (a closed object, every key known), and every member a function of this file whose body is
   * exactly one call `<receiver>.<method>(<channel>, …)` (an expression body or `{ return …; }`),
   * `receiver` true for the receiver's tokens and the method one of `methods`. Per member, the
   * method and the channel's values in the function's environment (null when they are not read).
   * Null when any of that does not hold.
   */
  forwardingMembers(
    k: number,
    receiver: (from: number, to: number) => boolean,
    methods: ReadonlySet<string>,
  ): Array<{ member: string; method: string; channels: string[] | null }> | null {
    return this.guarded(null, () =>
      this.strictly(() => {
        if (this.work <= 0) return null;
        this.begin(20_000);
        const v = this.evalRange(k, this.exprEnd(k), new Map(), 0);
        if (v?.kind !== "obj" || v.open || !v.props.size) return null;
        const out: Array<{ member: string; method: string; channels: string[] | null }> = [];
        for (const [member, fn] of v.props) {
          const call = this.forwardCall(fn, receiver, methods);
          if (!call) return null;
          out.push({ member, ...call });
        }
        return out;
      }),
    );
  }

  /** See `forwardingMembers`: one function value. Public for the loop-built members. */
  forwardCall(
    fn: Val | null,
    receiver: (from: number, to: number) => boolean,
    methods: ReadonlySet<string>,
  ): { method: string; channels: string[] | null } | null {
    if (fn?.kind !== "fn" || fn.res !== this) return null;
    const { def } = fn;
    if (this.asyncOrGenerator(def)) return null;
    let [from, to] = def.body;
    if (def.block) {
      const end = this.returnOnly(def);
      if (end === -1) return null;
      from += 2;
      to = end;
    }
    // `<receiver>.<method>(…)` and nothing after the call's `)`
    if (!this.punct(to - 1, ")")) return null;
    const open = this.opener[to - 1]!;
    if (open <= from + 2 || !this.is(open - 1, "ident") || !this.punct(open - 2, ".")) return null;
    const method = this.tokens[open - 1]!.value;
    if (!methods.has(method) || !receiver(from, open - 2)) return null;
    const first = this.argStart(open, to - 1, 0);
    if (first === null || this.punct(first, "...")) return { method, channels: null };
    const v = this.evalRange(first, Math.min(this.exprEnd(first), to - 1), fn.env, 1);
    const channels =
      v?.kind === "str" && !v.ref && v.values.length && !v.values.some((x) => x.includes("${…}"))
        ? v.values
        : null;
    return { method, channels };
  }

  /** Every environment the function's parameters are bound to: its call sites, or the list a callback runs over. */
  private bindings(def: FnDef, depth: number): Env[] | null {
    // Computed once per function: its call sites do not change between questions.
    const cached = this.bindingCache.get(def);
    if (cached) {
      if (cached.partial) this.partial = true;
      if (cached.cut) this.cut = true;
      for (const line of cached.lines) this.lines.add(line);
      if (cached.envs) this.note(def.calledBy && def.name === null ? "element" : "parameter");
      return cached.envs;
    }
    if (this.work <= 0) return null;
    const partialBefore = this.partial;
    const cutBefore = this.cut;
    const linesBefore = new Set(this.lines);
    this.partial = false;
    this.cut = false;
    const envs = this.bindingsUncached(def, depth);
    this.bindingCache.set(def, {
      envs,
      partial: this.partial,
      cut: this.cut,
      lines: [...this.lines].filter((l) => !linesBefore.has(l)),
    });
    this.partial = this.partial || partialBefore;
    this.cut = this.cut || cutBefore;
    return envs;
  }

  private bindingsUncached(def: FnDef, depth: number): Env[] | null {
    // a callback of `LIST.forEach((x, i) => …)` or `MAP.forEach((value, key) => …)`
    if (def.calledBy && def.name === null) {
      if (def.calledBy.method !== "forEach" && def.calledBy.method !== "map") return null;
      const receiver = this.receiverStart(def.calledBy.receiverEnd);
      if (receiver === null) return null;
      const envs: Env[] = [];
      // The list may read a parameter of the function the call is in (`Object.entries(table)`
      // in `function invokers(table)`): once per binding of that function. The callback's own
      // environment keeps those bindings, so its body reads them too.
      const outer = this.envsFor(receiver, receiver, def.calledBy.receiverEnd, depth + 1, true);
      for (const caller of outer) {
        // read strictly, as `loopEnvs` reads a loop's list (see `strict`)
        const list = this.strictly(() =>
          this.evalRange(receiver, def.calledBy!.receiverEnd, caller, depth + 1),
        );
        if (!list) return null;
        // a list longer than is read: the rounds read are not all there are
        if (list.kind === "arr" && list.more) this.partial = true;
        if (list.kind === "arr") {
          for (const e of list.elems) {
            if (!e) return null;
            const env: Env = new Map(caller);
            this.bind(def.params, [e], env);
            envs.push(env);
          }
        } else if (list.kind === "map") {
          for (const [key, value] of list.entries) {
            if (!key) return null;
            const env: Env = new Map(caller);
            this.bind(def.params, [value ?? { kind: "str", values: [] }, key], env);
            envs.push(env);
          }
        } else return null;
        if (outer.length > 1 && envs.length > MAX_ITERATIONS) return null;
      }
      this.note("element");
      this.lines.add(this.tokens[receiver]!.line);
      return envs;
    }
    // `(function (t) { … })(x)` and minified `async function (t) { … }(x)`: an anonymous function
    // called where it is written has that one call site
    const iife = def.name === null && !def.calledBy ? this.immediateCall(def) : -1;
    if (def.name === null && iife === -1) return null;
    const sites = iife !== -1 ? [iife] : this.callSites(def);
    if (!sites.length) return null;
    // the calls past MAX_SITES bind it too: what the listed ones give is not every value
    if (this.sitesCapped.has(def)) this.partial = this.cut = true;
    const envs: Env[] = [];
    for (const open of sites) {
      const close = this.match[open]!;
      // The arguments are read where the call is: inside another function, with that
      // function's own bindings (its parameters and `this` at each of its call sites).
      for (const caller of this.callerEnvs(open, close, depth)) {
        const args = this.list(open, close, caller, depth + 1);
        const env: Env = new Map();
        this.bind(def.params, args, env);
        // a method: `this` is the instance the call is made on, when its construction is read
        if (def.owner) {
          const self = this.is(open - 3, "ident", "this")
            ? (caller.get("this") ?? null)
            : this.instanceAt(open - 3, def.owner, depth + 1);
          if (self) env.set("this", self);
        }
        envs.push(env);
        if (envs.length > MAX_VALUES) return envs;
      }
      this.lines.add(this.tokens[open]!.line);
    }
    this.note("parameter");
    return envs;
  }

  /**
   * The environments a call's arguments are read in: one empty environment when the call reads
   * nothing of the function around it, else that function's bindings. A caller whose bindings
   * cannot be read makes the result partial.
   */
  private callerEnvs(open: number, close: number, depth: number): Env[] {
    return this.envsFor(open, open - 3, close, depth);
  }

  /**
   * The environments the expression in [from, to) is read in, inside the function around `at`:
   * one empty environment when it reads nothing of that function (its parameters, `this`, or a
   * local const built from them), else that function's bindings. A function whose bindings
   * cannot be read makes the result partial.
   */
  private envsFor(at: number, from: number, to: number, depth: number, strict = false): Env[] {
    const caller = this.enclosing(at);
    if (!caller || depth > 3) return [new Map()];
    const close = to;
    let reads = false;
    for (let j = from; j < close && !reads; j++) {
      const t = this.tokens[j];
      if (t?.type !== "ident" || this.punct(j - 1, ".")) continue;
      if ((t.value === "this" && caller.owner) || this.paramIndex(caller, t.value) !== -1)
        reads = true;
      const local = this.localConst(j, t.value);
      if (local)
        for (let m = local[0]; m < local[1] && !reads; m++)
          if (this.is(m, "ident") && this.paramIndex(caller, this.tokens[m]!.value) !== -1)
            reads = true;
    }
    if (!reads) return [new Map()];
    const outer = strict
      ? this.strictly(() => this.bindings(caller, depth + 1))
      : this.bindings(caller, depth + 1);
    if (!outer?.length) {
      this.partial = true;
      return [new Map()];
    }
    return outer;
  }

  /**
   * The instance a method call is made on, where `receiverEnd` is the token before `.method`:
   * `x` with `x = new C(…)` once in the file, `new C(…)` itself, or a chain of calls on one
   * instance (`new C(…).a(…).b(…)`, methods that `return this`).
   */
  private instanceAt(receiverEnd: number, cls: string, depth: number): Val | null {
    if (depth > MAX_DEPTH) return null;
    const t = this.tokens[receiverEnd];
    if (!t) return null;
    if (t.type === "ident" && t.value !== "this") {
      const sites = this.instancesOf(cls).filter((x) => x.name === t.value);
      // assigned twice: which instance is meant is not read
      return sites.length === 1 ? this.construct(cls, sites[0]!.open, depth) : null;
    }
    if (t.type === "punct" && t.value === ")") {
      const open = this.opener[receiverEnd]!;
      if (open === -1) return null;
      if (this.is(open - 1, "ident", cls) && this.is(open - 2, "ident", "new"))
        return this.construct(cls, open, depth);
      // `….method(…)` before: the same instance when that method returns `this`
      if (this.is(open - 1, "ident") && this.punct(open - 2, ".")) {
        const method = this.functions().find(
          (d) => d.owner === cls && d.name === this.tokens[open - 1]!.value,
        );
        if (method && this.returnsThis(method)) return this.instanceAt(open - 3, cls, depth + 1);
      }
    }
    return null;
  }

  private returnsThis(def: FnDef): boolean {
    for (let j = def.body[0]; j < def.body[1]; j++)
      if (
        this.is(j, "ident", "return") &&
        this.is(j + 1, "ident", "this") &&
        (this.punct(j + 2, ";") || this.punct(j + 2, "}"))
      )
        return true;
    return false;
  }

  /** `new cls(args)` at `open`: fields the constructor assigns, and the class's methods. */
  private construct(cls: string, open: number, depth: number): Val | null {
    const range = this.classRanges().find((c) => c.name === cls);
    if (!range) return null;
    const close = this.match[open]!;
    if (close === -1) return null;
    const args = this.list(open, close, new Map(), depth + 1);
    const props = new Map<string, Val | null>();
    const self: Val = { kind: "obj", props, open: true };
    const ctor = this.functions().find((d) => d.owner === cls && d.name === "constructor");
    // fields assigned anywhere in the class but the constructor are not known
    const elsewhere = new Set<string>();
    for (let j = range.start; j < range.end; j++)
      if (
        this.is(j, "ident", "this") &&
        this.punct(j + 1, ".") &&
        this.is(j + 2, "ident") &&
        this.punct(j + 3, "=") &&
        !this.punct(j + 4, "=") &&
        !(ctor && ctor.body[0] <= j && j < ctor.body[1])
      )
        elsewhere.add(this.tokens[j + 2]!.value);
    if (ctor) {
      const env: Env = new Map([["this", self]]);
      this.bind(ctor.params, args, env);
      for (let j = ctor.body[0]; j < ctor.body[1]; j++) {
        if (
          !this.is(j, "ident", "this") ||
          !this.punct(j + 1, ".") ||
          !this.is(j + 2, "ident") ||
          !this.punct(j + 3, "=") ||
          this.punct(j + 4, "=")
        )
          continue;
        const field = this.tokens[j + 2]!.value;
        // only a statement of the constructor's own block, not one inside a condition or loop
        // (with braces, or a single statement after `if (…)`, `else`, a loop header)
        const before = this.tokens[j - 1];
        const guarded =
          (before?.type === "punct" && before.value === ")") ||
          (before?.type === "ident" && /^(else|do)$/.test(before.value));
        if (guarded || this.depthAt(j) !== this.depthAt(ctor.body[0]) + 1) {
          props.set(field, null);
          continue;
        }
        props.set(
          field,
          elsewhere.has(field) ? null : this.evalRange(j + 4, this.exprEnd(j + 4), env, depth + 1),
        );
      }
    }
    for (const d of this.functions())
      if (d.owner === cls && d.name && d.name !== "constructor" && !props.has(d.name))
        props.set(d.name, { kind: "fn", def: d, env: new Map([["this", self]]), res: this });
    return self;
  }

  private argStart(open: number, close: number, index: number): number | null {
    let from = open + 1;
    for (let i = 0; from < close; i++) {
      if (i === index) return from;
      from = Math.min(this.exprEnd(from), close) + 1;
    }
    return null;
  }

  /** Start of the receiver expression that ends at `end` (exclusive): `a.b`, `list`, `[…]`, `x()`. */
  private receiverStart(end: number): number | null {
    let j = end - 1;
    for (let guard = 0; j >= 0 && guard < 50; guard++) {
      const t = this.tokens[j]!;
      if (t.type === "punct" && (t.value === ")" || t.value === "]")) {
        const open = this.opener[j]!;
        if (open === -1) return null;
        j = open;
        if (this.is(j - 1, "ident") && t.value === ")") j--;
        if (t.value === "]" && !this.is(j - 1, "ident") && !this.punct(j - 1, ")")) return j;
      }
      if (
        this.punct(j - 1, ".") &&
        (this.is(j - 2, "ident") || this.punct(j - 2, ")") || this.punct(j - 2, "]"))
      ) {
        j -= 2;
        continue;
      }
      return this.tokens[j]?.type === "ident" || this.punct(j, "[") ? j : null;
    }
    return null;
  }

  /**
   * Calls of the function: `name(` for a plain function; for a method, `this.name(` inside its
   * class and `x.name(` where x is a `new Class(…)` of the file, also in a chain of such calls.
   */
  /**
   * The name of the object literal def is a method of, for `const NAME = { … }` outside every
   * function and declared once; null otherwise.
   */
  private literalOwner(def: FnDef): string | null {
    const cached = this.literalOwners.get(def);
    if (cached !== undefined) return cached;
    let owner: string | null = null;
    // walk back from the parameters to the brace the member is in, over earlier members
    let j = def.paramsAt - 1;
    for (let steps = 0; j >= 0 && steps < 200; steps++, j--) {
      const t = this.tokens[j]!;
      if (t.type !== "punct") continue;
      if (t.value === "}" || t.value === ")" || t.value === "]") {
        j = this.opener[j]!;
        if (j === -1) break;
        continue;
      }
      if (t.value === "(" || t.value === "[" || t.value === ";") break;
      if (t.value === "{") {
        const name = this.tokens[j - 2];
        // `const NAME = {`, or `var a = 1, NAME = {` as minifiers write it
        if (
          this.punct(j - 1, "=") &&
          name?.type === "ident" &&
          ((this.is(j - 3, "ident") && /^(const|let|var)$/.test(this.tokens[j - 3]!.value)) ||
            (this.punct(j - 3, ",") && this.inDeclarationList(j - 2))) &&
          !this.enclosing(j) &&
          this.declaredOnce(name.value)
        )
          owner = name.value;
        break;
      }
    }
    this.literalOwners.set(def, owner);
    return owner;
  }

  /**
   * NAME is declared once with const, let or var and never assigned again (its members may change:
   * `prefs.set(…)` on a helper object is a call, not a write).
   */
  private declaredOnce(name: string): boolean {
    let declared = 0;
    for (const j of this.positions(name)) {
      if (this.punct(j - 1, ".")) continue;
      const before = this.tokens[j - 1];
      if (
        (before?.type === "ident" && /^(const|let|var|function|class)$/.test(before.value)) ||
        (this.punct(j - 1, ",") &&
          this.punct(j + 1, "=") &&
          !this.punct(j + 2, "=") &&
          this.depthAt(j) === 0 &&
          this.inDeclarationList(j))
      )
        declared++;
      else if ((this.punct(j + 1, "=") && !this.punct(j + 2, "=")) || this.changes(j)) return false;
    }
    return declared === 1;
  }

  /** A parameter, local, `catch (…)` or block declaration of NAME around k binds it there. */
  private shadowed(k: number, name: string): boolean {
    return (
      this.enclosingParam(k, name) ||
      this.declaredLocally(k, name) ||
      this.catchBinds(k, name) ||
      this.innerDeclared(null, name, k)
    );
  }

  /** def is the one binding of its name: `function NAME`, `const NAME = …`, declared once. */
  private plainName(def: FnDef): boolean {
    for (let j = def.paramsAt - 1; j >= 0 && j >= def.paramsAt - 4; j--)
      if (this.is(j, "ident", def.name!))
        return !this.punct(j - 1, ".") && this.declaredOnce(def.name!);
    return false;
  }

  /**
   * `this` at k is an instance of def's class: k is inside def's class body, and the innermost
   * function around k that is no arrow is a method of that body, or lies outside the class (k is
   * in a field initializer, `x = this.retrieve(…)`). Inside a plain `function` or a method of an
   * object literal, `this` is something else.
   */
  private thisIsOwner(k: number, def: FnDef): boolean {
    this.innermostBlock(0, null);
    const parents = this.s.parents!;
    const body = parents[def.paramsAt - 1]!;
    const close = body === -1 ? -1 : this.match[body]!;
    if (body === -1 || close === -1 || k <= body || k >= close) return false;
    let f = this.enclosing(k);
    for (let guard = 0; f?.arrow && guard < 64; guard++) f = this.enclosing(f.paramsAt - 1);
    // a field initializer: `this` is an instance, or the class in a `static` field
    if (!f || f.body[0] < body) return this.staticMember(k, body) === !!def.static;
    return f.owner === def.owner && parents[f.paramsAt - 1] === body && !!f.static === !!def.static;
  }

  /**
   * Whether the class member around k (k inside the class body that opens at `body`) is written
   * `static …`: the member's first token, found by walking back over the body's own tokens to the
   * `;`, `}` or `{` before it. Unknown (a member longer than the walk) counts as static, so no
   * instance call is read from it.
   */
  private staticMember(k: number, body: number): boolean {
    const parents = this.s.parents!;
    let p = k;
    for (let guard = 0; parents[p] !== body && guard < 256; guard++) p = parents[p]!;
    if (parents[p] !== body) return true;
    for (let j = p - 1, steps = 0; j > body; j--, steps++) {
      if (steps > 4000) return true;
      if (parents[j] !== body) continue;
      if (this.punct(j, ";") || this.punct(j, "}")) return this.is(j + 1, "ident", "static");
    }
    return this.is(body + 1, "ident", "static");
  }

  /**
   * A member named NAME is assigned somewhere in the file: `x.NAME = …`, `x["NAME"] = …`
   * (also `A.prototype.NAME = …`), `Object.defineProperty(x, "NAME", …)`, or a key NAME of an
   * object literal passed to `Object.assign(…)`, with a value that may be a function (see
   * `assigns`). Then `x.NAME(…)` may call that instead of a
   * method or object-literal function of the name, and its calls are not read. The positions of
   * the name per name, and one pass over the file's strings for all names, kept.
   */
  private memberWritten(name: string): boolean {
    const known = this.s.memberWrites.get(name);
    if (known !== undefined) return known;
    this.innermostBlock(0, null); // builds the table of brackets
    const parents = this.s.parents!;
    // `= <value>` where the value may be a function. A literal, an object or array literal or
    // `!0` is none, so `e.save = "save"` (an enum) is no other `save` to call; nor is
    // `R.save = new R(…)`, a class's own static instance (Monaco's icons, as Fiddle ships them).
    // `new` of anything else (`new Proxy(f, {})`, `new Function(…)`) may be callable.
    const assigns = (j: number, receiver: number): boolean => {
      if (!this.punct(j, "=")) return false;
      const v = this.tokens[j + 1];
      if (!v) return false;
      if (v.type === "string" || v.type === "number" || v.type === "template") return false;
      if (v.type === "ident" && v.value === "new")
        return !(
          this.is(receiver, "ident") &&
          this.is(j + 2, "ident", this.tokens[receiver]!.value) &&
          this.punct(j + 3, "(")
        );
      if (v.type === "ident" && /^(true|false|null|void|undefined)$/.test(v.value)) return false;
      return !(v.type === "punct" && /^(\{|\[|!|-)$/.test(v.value));
    };
    const inAssign = (j: number): boolean => {
      const brace = parents[j]!;
      if (brace === -1 || !this.punct(brace, "{")) return false;
      const call = parents[brace]!;
      return (
        call > 2 &&
        this.punct(call, "(") &&
        this.is(call - 1, "ident", "assign") &&
        this.punct(call - 2, ".") &&
        this.is(call - 3, "ident", "Object")
      );
    };
    let found = false;
    for (const j of this.positions(name)) {
      if (this.punct(j - 1, ".") && assigns(j + 1, j - 2)) found = true;
      // `{ NAME: …`, `{ NAME, …`, `{ NAME(…) {…}` as an argument of Object.assign
      else if (
        (this.punct(j - 1, "{") || this.punct(j - 1, ",")) &&
        (this.punct(j + 1, ":") ||
          this.punct(j + 1, ",") ||
          this.punct(j + 1, "}") ||
          this.punct(j + 1, "(")) &&
        inAssign(j)
      )
        found = true;
      if (found) break;
    }
    // names written through a string key: one pass over the file for all names
    if (!this.s.stringWrites) {
      const written = new Set<string>();
      for (let j = 0; j < this.tokens.length; j++) {
        const t = this.tokens[j]!;
        if (t.type !== "string" || written.has(t.value)) continue;
        if (
          (this.punct(j - 1, "[") && this.punct(j + 1, "]") && assigns(j + 2, j - 2)) ||
          (this.punct(j - 1, ",") &&
            this.is(j - 4, "ident", "defineProperty") &&
            this.punct(j - 5, ".")) ||
          (this.punct(j - 1, ",") &&
            this.is(j - 4, "ident", "set") &&
            this.punct(j - 5, ".") &&
            this.is(j - 6, "ident", "Reflect")) ||
          (this.punct(j + 1, ":") && inAssign(j))
        )
          written.add(t.value);
      }
      this.s.stringWrites = written;
    }
    if (this.s.stringWrites.has(name)) found = true;
    this.s.memberWrites.set(name, found);
    return found;
  }

  /**
   * The `(` of the call of an anonymous function that is called where it is written:
   * `function (…) {…}(…)`, `(function (…) {…})(…)`, `((…) => {…})(…)`, also `async`. -1 otherwise.
   */
  private immediateCall(def: FnDef): number {
    const end = def.body[1];
    if (!def.arrow && this.punct(end, "(") && !this.is(def.paramsAt - 2, "ident", "default"))
      return end;
    if (!this.punct(end, ")") || !this.punct(end + 1, "(")) return -1;
    let start = def.arrow ? def.paramsAt : def.paramsAt - 1;
    if (this.is(start - 1, "ident", "async")) start--;
    if (this.opener[end] !== start - 1) return -1;
    // The `(` must group the function, not open a call it is an argument of:
    // `foo(function (u) {…})("x")` calls what foo returns, not the function.
    const before = this.tokens[start - 2];
    if (
      before &&
      ((before.type === "ident" && !GROUPING_WORDS.has(before.value)) ||
        before.type === "string" ||
        before.type === "template" ||
        before.type === "number" ||
        (before.type === "punct" &&
          (before.value === ")" ||
            before.value === "]" ||
            before.value === "." ||
            before.value === "?.")))
    )
      return -1;
    return end + 1;
  }

  /**
   * Names the URL class is bound to besides `URL`: `import { URL as X } from "node:url"`,
   * `const { URL: X } = require("url")`. Module objects of `url` are in `urlModules`
   * (`new url.URL(…)`, esbuild's `new import_node_url.URL(…)`). Computed once per resolver.
   */

  /** At k, after `new`: the `(` of a URL constructor call, or -1. */
  private urlConstructor(k: number): number {
    if (this.is(k, "ident", "URL") && this.punct(k + 1, "(")) return k + 1;
    if (!this.is(k, "ident")) return -1;
    if (!this.s.urlNames) {
      const classes = new Map<string, number>();
      const modules = new Map<string, number>();
      const t = this.tokens;
      const urlSpec = (j: number): boolean =>
        t[j]?.type === "string" && /^(node:)?url$/.test(t[j]!.value);
      for (let j = 0; j + 4 < t.length; j++) {
        // `X = require("url")`, `X = f(require("url"))`
        if (this.is(j, "ident", "require") && this.punct(j + 1, "(") && urlSpec(j + 2)) {
          if (this.punct(j - 1, "=") && this.is(j - 2, "ident"))
            modules.set(t[j - 2]!.value, j - 2);
          else if (this.punct(j - 1, "(") && this.is(j - 2, "ident") && this.punct(j - 3, "="))
            modules.set(t[j - 4]?.type === "ident" ? t[j - 4]!.value : "", j - 4);
          else if (this.punct(j - 1, "=") && this.punct(j - 2, "}")) {
            // `{ URL: X } = require("url")`
            const open = this.opener[j - 2]!;
            for (let m = open + 1; open !== -1 && m < j - 2; m++)
              if (this.is(m, "ident", "URL") && this.punct(m + 1, ":") && this.is(m + 2, "ident"))
                classes.set(t[m + 2]!.value, open);
          }
        }
        // `import { URL as X } from "url"`, `import * as X from "url"`
        if (this.is(j, "ident", "import")) {
          let m = j + 1;
          if (this.punct(m, "*") && this.is(m + 1, "ident", "as") && this.is(m + 2, "ident")) {
            if (this.is(m + 3, "ident", "from") && urlSpec(m + 4)) modules.set(t[m + 2]!.value, j);
            continue;
          }
          if (this.is(m, "ident") && this.punct(m + 1, ",")) m += 2;
          if (!this.punct(m, "{")) continue;
          const close = this.match[m]!;
          if (close === -1 || !this.is(close + 1, "ident", "from") || !urlSpec(close + 2)) continue;
          for (let n = m + 1; n < close; n++)
            if (
              this.is(n, "ident", "URL") &&
              this.is(n + 1, "ident", "as") &&
              this.is(n + 2, "ident")
            )
              classes.set(t[n + 2]!.value, j);
        }
      }
      modules.delete("");
      this.s.urlNames = { classes, modules };
    }
    const name = this.tokens[k]!.value;
    // the name must mean that import where it is used, not a parameter or local of the name
    const classDecl = this.s.urlNames.classes.get(name);
    if (classDecl !== undefined && this.punct(k + 1, "("))
      return this.refersTo(k, name, classDecl) ? k + 1 : -1;
    const moduleDecl = this.s.urlNames.modules.get(name);
    if (
      moduleDecl !== undefined &&
      this.refersTo(k, name, moduleDecl) &&
      this.punct(k + 1, ".") &&
      this.is(k + 2, "ident", "URL") &&
      this.punct(k + 3, "(")
    )
      return k + 3;
    return -1;
  }

  /** Declarations of each name in the file and the range each is visible in (`bindingSites`). */
  private readonly bindingTables = new Map<
    string,
    Array<{ name: number; word: number; from: number; to: number }>
  >();
  /** Per name: the name tokens of its binding sites (see `writesTo`). */
  private readonly bindingNames = new Map<string, Set<number>>();
  /** Per name: binding ranges sorted by start, with the three furthest-reaching of each prefix. */
  private readonly coverTables = new Map<
    string,
    {
      sites: Array<{ name: number; word: number; from: number; to: number }>;
      from: number[];
      top: Array<[number, number, number]>;
    }
  >();

  /**
   * Every declaration of `name` in the file: `const|let|var|function|class NAME`, a name in a
   * destructuring pattern of `const|let|var` (`{ a, NAME }`, `{ k: NAME }`, `[NAME]`, nested),
   * `for (const NAME of …)`. `word`: the declaring keyword's token; `from`/`to`: the range the
   * declaration is visible in (its block, a `for` statement, or for `var` and `function` the
   * function around it, or the whole file). Computed once per name, linear in its occurrences.
   */
  private bindingSites(
    name: string,
  ): Array<{ name: number; word: number; from: number; to: number }> {
    const cached = this.bindingTables.get(name);
    if (cached) return cached;
    const out: Array<{ name: number; word: number; from: number; to: number }> = [];
    this.bindingTables.set(name, out);
    this.innermostBlock(0, null); // builds the table of brackets
    const parents = this.s.parents!;
    const n = this.tokens.length;
    const declaring = (j: number): boolean =>
      this.is(j, "ident") && /^(const|let|var|function|class)$/.test(this.tokens[j]!.value);
    for (const j of this.positions(name)) {
      if (this.punct(j - 1, ".") || this.punct(j - 1, "?.")) continue;
      let word = declaring(j - 1) ? j - 1 : -1;
      if (word === -1 && !this.punct(j + 1, ":")) {
        let p = parents[j] ?? -1;
        for (
          let steps = 0;
          p >= 0 && steps < 6 && (this.punct(p, "{") || this.punct(p, "["));
          steps++
        ) {
          if (
            declaring(p - 1) &&
            !this.is(p - 1, "ident", "function") &&
            !this.is(p - 1, "ident", "class")
          ) {
            word = p - 1;
            break;
          }
          p = parents[p] ?? -1;
        }
      }
      if (word === -1) continue;
      const kind = this.tokens[word]!.value;
      let range: [number, number];
      const own = kind === "function" ? this.functionWithParamsAt(j + 1) : null;
      if (own && !this.declarationStart(word)) {
        // `const g = function https() {…}`: the name is bound inside that function only
        range = [j + 1, own.body[1]];
      } else if (kind === "var" || kind === "function") {
        const d = this.enclosing(word);
        range = d ? [d.body[0], d.body[1]] : [0, n];
      } else range = this.innermostBlock(word, null) ?? [0, n];
      out.push({ name: j, word, from: range[0], to: range[1] });
    }
    return out;
  }

  /** The `function` (or `async function`) at k starts a statement: a declaration, not an expression. */
  private declarationStart(k: number): boolean {
    const at = this.is(k - 1, "ident", "async") ? k - 1 : k;
    const before = this.tokens[at - 1];
    return (
      !before ||
      (before.type === "punct" &&
        (before.value === ";" || before.value === "{" || before.value === "}")) ||
      (before.type === "ident" && (before.value === "export" || before.value === "default"))
    );
  }

  /**
   * k stands in the parameter list of a function (a default value, `function f(https, a =
   * https.get(…))`) that has a parameter of the name: that parameter is meant there.
   */
  private parameterListBinds(k: number, name: string): boolean {
    this.innermostBlock(0, null);
    const parents = this.s.parents!;
    let p = parents[k] ?? -1;
    for (let steps = 0; p >= 0 && steps < 32; steps++) {
      if (this.punct(p, "(")) {
        const d = this.functionWithParamsAt(p);
        if (d && this.paramIndex(d, name) !== -1) return true;
      }
      p = parents[p] ?? -1;
    }
    return false;
  }

  /** A declaration of the name other than `decl` (its name or pattern token) is visible at k. */
  private covered(k: number, name: string, decl: number): boolean {
    // One table per name: the sites in order of where they start, and for each prefix the three
    // sites that reach furthest. The furthest-reaching site that is not `decl` decides; a decl
    // matching all three (never in practice) is answered by a walk over the sites.
    let table = this.coverTables.get(name);
    if (!table) {
      const sites = this.bindingSites(name).toSorted((a, b) => a.from - b.from);
      const top: Array<[number, number, number]> = [];
      let best: [number, number, number] = [-1, -1, -1];
      for (let i = 0; i < sites.length; i++) {
        const to = sites[i]!.to;
        const reach = (x: number): number => (x === -1 ? -Infinity : sites[x]!.to);
        if (to > reach(best[0])) best = [i, best[0], best[1]];
        else if (to > reach(best[1])) best = [best[0], i, best[1]];
        else if (to > reach(best[2])) best = [best[0], best[1], i];
        top.push(best);
      }
      table = { sites, from: sites.map((b) => b.from), top };
      this.coverTables.set(name, table);
    }
    let lo = 0;
    let hi = table.from.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (table.from[mid]! <= k) lo = mid + 1;
      else hi = mid;
    }
    if (lo === 0) return false;
    const other = (b: { name: number; word: number }): boolean =>
      b.name !== decl && b.word !== decl - 1;
    for (const i of table.top[lo - 1]!) {
      if (i === -1) return false;
      const b = table.sites[i]!;
      if (other(b)) return b.to >= k;
    }
    for (let i = 0; i < lo; i++) {
      const b = table.sites[i]!;
      if (other(b) && b.to >= k) return true;
    }
    return false;
  }

  /**
   * The name at k refers to the declaration at `decl` (its name token, or the token after the
   * keyword of a destructuring pattern, or an `import`): k is inside the function around `decl`
   * (or `decl` is at the top of the file), no function between them has a parameter of that
   * name, no `catch` binds it, and no other declaration of the name (also in a destructuring
   * pattern or a `for … of` head) is visible at k. Tables are built once per name, so a file with
   * many calls stays linear.
   */
  refersTo(k: number, name: string, decl: number): boolean {
    if (this.catchBinds(k, name) || this.parameterListBinds(k, name)) return false;
    const home = this.enclosing(decl);
    for (let d = this.enclosing(k), guard = 0; d !== home; guard++) {
      if (!d || guard >= 64) return false;
      if (this.paramIndex(d, name) !== -1) return false;
      d = this.enclosing(d.paramsAt - 1);
    }
    return !this.covered(k, name, decl);
  }

  /**
   * How the name at k is bound around it: `param` (a parameter of a function around k, also in a
   * parameter list k stands in), `local` (a declaration, pattern, `for … of` head or `catch`
   * visible at k; `site` is the innermost such declaration, absent for `catch`), or null.
   */
  boundAround(
    k: number,
    name: string,
  ): { kind: "param" } | { kind: "local"; site?: { name: number; word: number } } | null {
    if (this.parameterListBinds(k, name)) return { kind: "param" };
    for (let d = this.enclosing(k), guard = 0; d && guard < 64; guard++) {
      if (this.paramIndex(d, name) !== -1) return { kind: "param" };
      d = this.enclosing(d.paramsAt - 1);
    }
    if (this.catchBinds(k, name)) return { kind: "local" };
    if (!this.covered(k, name, -2)) return null;
    let best: { name: number; word: number; from: number; to: number } | null = null;
    for (const b of this.bindingSites(name))
      if (b.from <= k && k <= b.to && (!best || b.from >= best.from)) best = b;
    return best ? { kind: "local", site: { name: best.name, word: best.word } } : { kind: "local" };
  }

  /**
   * The token at j writes to the declaration at `decl`: an assignment (`NAME = …`, `NAME += …`,
   * `NAME++`) that is no declaration, parameter default, class field or pattern binding of its
   * own, where the name means that declaration.
   */
  writesTo(j: number, name: string, decl: number): boolean {
    return this.assignsName(j, name) && this.refersTo(j, name, decl);
  }

  /**
   * The token at j is an assignment of the name (`NAME = …`, `NAME += …`, `NAME++`) that is no
   * declaration, parameter default, class field or pattern binding of its own; which binding it
   * writes is not asked.
   */
  assignsName(j: number, name: string): boolean {
    if (this.punct(j - 1, ".") || this.punct(j - 1, "?.")) return false;
    const after = this.tokens[j + 1];
    const before = this.tokens[j - 1];
    const writes =
      (after?.type === "punct" &&
        (ASSIGNMENT_OPERATORS.has(after.value) || after.value === "++" || after.value === "--")) ||
      (before?.type === "punct" && (before.value === "++" || before.value === "--"));
    if (!writes) return false;
    if (before?.type === "ident" && /^(const|let|var)$/.test(before.value)) return false;
    let names = this.bindingNames.get(name);
    if (!names) {
      names = new Set(this.bindingSites(name).map((b) => b.name));
      this.bindingNames.set(name, names);
    }
    if (names.has(j)) return false;
    this.innermostBlock(0, null);
    const p = this.s.parents![j] ?? -1;
    // a parameter default (`function f(https = x)`)
    if (p >= 0 && this.punct(p, "(") && this.functionWithParamsAt(p)) return false;
    // a class field (`class A { https = 1 }`)
    if (p >= 0 && this.punct(p, "{") && this.classRanges().some((c) => c.start === p)) return false;
    // `var a = 1, https = x`: a declaration list
    if (this.punct(j - 1, ",")) {
      for (let m = j - 2, depth = 0; m >= 0 && m > j - 400; m--) {
        const t = this.tokens[m]!;
        if (t.type === "punct") {
          if (t.value === ")" || t.value === "]" || t.value === "}") depth++;
          else if (t.value === "(" || t.value === "[" || t.value === "{") {
            if (depth === 0) break;
            depth--;
          } else if (depth === 0 && t.value === ";") break;
        } else if (depth === 0 && t.type === "ident" && /^(const|let|var)$/.test(t.value))
          return false;
      }
    }
    return true;
  }

  private callSites(def: FnDef): number[] {
    const cached = this.siteCache.get(def);
    if (cached) return cached;
    const out: number[] = [];
    this.siteCache.set(def, out);
    // a method or an object literal's function whose name is also assigned as a member
    if ((def.owner || def.member) && this.memberWritten(def.name!)) return out;
    const tokens = this.tokens;
    const instances = new Set<string>(
      def.owner ? this.instancesOf(def.owner).map((x) => x.name) : [],
    );
    let plain: boolean | null = null;
    // `function NAME(…) {…}` declared inside another function (the body of a module a bundler
    // wrapped, an inner helper): called where the name is bound to it, which the scope says
    const nested =
      !def.owner &&
      !def.member &&
      !def.arrow &&
      this.is(def.paramsAt - 2, "ident", "function") &&
      this.enclosing(def.paramsAt - 1) !== null;
    // One site past the cap is looked for, so a function called more often is known to be.
    for (const k of this.positions(def.name!)) {
      if (out.length > MAX_SITES) break;
      if (!this.is(k, "ident", def.name!) || !this.punct(k + 1, "(") || k + 1 === def.paramsAt)
        continue;
      if (nested) {
        if (this.punct(k - 1, ".") || this.is(k - 1, "ident", "function")) continue;
        const b = this.binding(k, def.name!);
        if (b?.kind === "function" && b.def === def) out.push(k + 1);
        continue;
      }
      // a parameter or local of the same name at the call hides the function
      if (!def.owner && this.shadowed(k, def.name!)) continue;
      const before = this.punct(k - 1, ".");
      if (!def.owner) {
        // a method of an object literal: `http.getJson(…)` for `const http = { getJson(url) {…} }`
        if (before) {
          const literal = def.member ? this.literalOwner(def) : null;
          // a parameter or local of the same name around the call is another object
          if (
            literal &&
            this.is(k - 2, "ident", literal) &&
            !this.punct(k - 3, ".") &&
            !this.shadowed(k - 2, literal)
          )
            out.push(k + 1);
          continue;
        }
        if (def.member || this.is(k - 1, "ident", "function")) continue;
        // `name(…)` is a call of def only when def is what the name is bound to, once: not
        // `exports.name = function …` (a property, not a binding), nor a name assigned again
        if (plain === null) plain = this.plainName(def);
        if (plain) out.push(k + 1);
        continue;
      }
      if (!before) continue;
      const receiver = tokens[k - 2];
      if (receiver?.type === "ident" && receiver.value === "this") {
        if (this.thisIsOwner(k - 2, def)) out.push(k + 1);
        continue;
      }
      // a `static` method is called on the class, never on an instance
      if (def.static) continue;
      if (receiver?.type === "ident" && instances.has(receiver.value)) {
        out.push(k + 1);
        continue;
      }
      // a chain: `r.handle(…).handle(…)` or `new Router().handle(…)`
      if (receiver?.type === "punct" && receiver.value === ")") {
        const open = this.opener[k - 2]!;
        if (
          open !== -1 &&
          this.is(open - 1, "ident", def.owner) &&
          this.is(open - 2, "ident", "new")
        )
          out.push(k + 1);
        else if (open !== -1 && this.is(open - 1, "ident", def.name!) && out.includes(open))
          out.push(k + 1);
      }
    }
    if (out.length > MAX_SITES) {
      out.length = MAX_SITES;
      this.sitesCapped.add(def);
    }
    return out;
  }

  // ---------- scopes, for the wrapper reader (wrappers.ts); nothing here evaluates ----------

  /** The innermost function whose body holds token k. */
  functionAt(k: number): FnDef | null {
    return this.enclosing(k);
  }

  /**
   * False when the file has more functions than are read (MAX_FUNCTIONS): scopes past them are
   * not known, and a caller that relies on them must not take its answers as proven.
   */
  readsAllFunctions(): boolean {
    return this.functions().length < MAX_FUNCTIONS;
  }

  /** The function around def; null at the top of the file. */
  outerOf(def: FnDef): FnDef | null {
    return this.enclosing(def.paramsAt - 1);
  }

  /** The function whose parameters start at token k (`(` of the list, or a lone arrow parameter). */
  functionWithParamsAt(k: number): FnDef | null {
    if (!this.s.defsByParams) {
      const byParams = new Map<number, FnDef>();
      for (const d of this.functions()) if (!byParams.has(d.paramsAt)) byParams.set(d.paramsAt, d);
      this.s.defsByParams = byParams;
    }
    return this.s.defsByParams.get(k) ?? null;
  }

  /** The innermost bracket open around token k (for a bracket, the one around it), or -1. */
  bracketAround(k: number): number {
    if (!this.s.parents) this.bracketTables();
    return this.s.parents![k] ?? -1;
  }

  /** The bracket that closes the one at k, or -1. */
  closeOf(k: number): number {
    return this.match[k] ?? -1;
  }

  /** The bracket that opens the one that closes at k, or -1. */
  openOf(k: number): number {
    return this.opener[k] ?? -1;
  }

  /** Where the expression that starts at k ends (exclusive): the next top-level `,`, `;` or closing bracket. */
  endOf(k: number): number {
    return this.exprEnd(k);
  }

  /** The token at which argument `index` of the call whose `(` is at `open` starts. */
  argumentAt(open: number, index: number): number | null {
    const close = this.match[open] ?? -1;
    return close === -1 ? null : this.argStart(open, close, index);
  }

  /** Start of the receiver expression that ends at `end` (exclusive). */
  receiverAt(end: number): number | null {
    return this.receiverStart(end);
  }

  /** Positions of the identifier `name` in [from, to). */
  namePositions(name: string, from = 0, to = this.tokens.length): number[] {
    return this.occurrences(name, from, to);
  }

  /** Bracket depth (all kinds) at token k. */
  depthOf(k: number): number {
    return this.depthAt(k);
  }

  /**
   * Whether a function whose parameter list names NAME holds token k, in that list or in its
   * body: k is then that parameter or within its reach, whatever `binding` could tell.
   */
  paramAround(k: number, name: string): boolean {
    if (!this.s.paramDefs) {
      const byName = new Map<string, FnDef[]>();
      for (const d of this.functions())
        for (const n of paramNames(d.params)) {
          const list = byName.get(n) ?? [];
          list.push(d);
          byName.set(n, list);
        }
      this.s.paramDefs = byName;
    }
    for (const d of this.s.paramDefs.get(name) ?? [])
      if (d.paramsAt <= k && k <= d.body[1]) return true;
    return false;
  }

  /** The file's classes: `class Name {` and `var Name = class {`, with the bounds of the body. */
  classesOf(): ReadonlyArray<{ name: string; start: number; end: number }> {
    return this.classRanges();
  }

  /** The class def is a method of: the innermost class whose body holds it directly. */
  classOfMethod(def: FnDef): { name: string; start: number; end: number } | null {
    if (def.owner === null) return null;
    let best: { name: string; start: number; end: number } | null = null;
    for (const c of this.classRanges())
      if (c.start < def.paramsAt && def.paramsAt < c.end && (!best || c.start > best.start))
        best = c;
    if (!best || this.depthAt(def.paramsAt - 1) !== this.depthAt(best.start) + 1) return null;
    return best;
  }

  /** The methods written directly in the body of a class. */
  methodsIn(range: { start: number; end: number }): FnDef[] {
    return this.functions().filter(
      (d) =>
        d.owner !== null &&
        d.paramsAt > range.start &&
        d.paramsAt < range.end &&
        this.classOfMethod(d)?.start === range.start,
    );
  }

  /** The object literal a member def is written in: the `{` of the literal, and its name if any. */
  objectOfMember(def: FnDef): number | null {
    if (!def.member) return null;
    let j = def.paramsAt - 1;
    for (let steps = 0; j >= 0 && steps < 400; steps++, j--) {
      const t = this.tokens[j]!;
      if (t.type !== "punct") continue;
      if (t.value === "}" || t.value === ")" || t.value === "]") {
        j = this.opener[j]!;
        if (j === -1) return null;
        continue;
      }
      if (t.value === "{") return j;
      if (t.value === "(" || t.value === "[" || t.value === ";") return null;
    }
    return null;
  }

  /**
   * Whether NAME is assigned as a member anywhere in the file (`x.NAME = f`, `x["NAME"] = f`,
   * `Object.assign(x, { NAME })`, `Object.defineProperty(x, "NAME", …)`): `x.NAME(…)` may then
   * call that other function.
   */
  memberAssigned(name: string): boolean {
    return this.memberWritten(name);
  }

  /** Whether the method returns `this` (and so can be chained: `r.a(…).b(…)`). */
  returnsSelf(def: FnDef): boolean {
    return this.returnsThis(def);
  }

  /**
   * What the identifier `name` at token k is bound to, by scope: a parameter of a function around
   * k, a `const|let|var` declared once in a function around k (or at the top of the file) and
   * never assigned again, a function or class declared once there, or a name taken from an object
   * pattern (`var { KEY: NAME } = <expr>`). Null when the binding is not one of these, is declared
   * more than once, or is not in the file. `despiteWrites`: the declaration also when the name
   * is assigned or changed after it (the caller reads those writes itself).
   */
  /**
   * Whether the file's work budget is used up. A null from `binding` then means "not read", not
   * "no binding": a caller must not take it as an answer.
   */
  exhausted(): boolean {
    return this.work <= 0;
  }

  binding(k: number, name: string, despiteWrites = false): Binding | null {
    // the scans below are charged to the file's work budget; used up, nothing is bound
    if (this.work <= 0) return null;
    // `catch (NAME)` around k: a binding none of the scans below knows
    if (this.catchBinds(k, name)) return null;
    for (let d = this.enclosing(k), guard = 0; d && guard < 20; guard++) {
      if (this.work <= 0) return null;
      // a declaration of an inner block around k shadows the parameters as well
      if (this.innerDeclared(d, name, k)) {
        const declared = this.directDeclaration(d, name, k, despiteWrites);
        return declared && declared !== "ambiguous" ? declared : null;
      }
      const index = d.params.findIndex((p) => paramNames([p]).includes(name));
      if (index !== -1)
        return d.params[index]!.kind === "name" ? { kind: "param", def: d, index } : null;
      const declared = this.directDeclaration(d, name, k, despiteWrites);
      if (declared) return declared === "ambiguous" ? null : declared;
      d = this.enclosing(d.paramsAt - 1);
    }
    // a `const`, `let` or `class` of a block at the top of the file, around k
    if (this.innerDeclared(null, name, k)) {
      const declared = this.directDeclaration(null, name, k, despiteWrites);
      return declared && declared !== "ambiguous" ? declared : null;
    }
    this.topDeclarations();
    const top = despiteWrites ? this.s.topDeclsLoose! : this.topDeclarations();
    const decl = top.get(name);
    if (decl) return { kind: "value", range: decl };
    if (top.has(name)) return null;
    const listed = this.topListed(name);
    if (listed !== undefined) return listed ? { kind: "value", range: listed } : null;
    const part = this.topPattern(name);
    if (part) return { kind: "pattern", key: part.key, from: part.from };
    const fn = this.namedFunction(name);
    if (fn && this.depthAt(fn.paramsAt) === 0 && !this.enclosing(fn.paramsAt))
      return { kind: "function", def: fn };
    return this.classIn(null, name);
  }

  /**
   * How NAME is declared directly in the body of d (not in a function nested in it): once, with
   * a value, as a function or as a class, and never written again (a write in a nested function
   * counts unless that function binds the name itself). "ambiguous" for anything else; null when
   * d does not declare it.
   */
  private readonly directCache = new Map<string, Declarations>();
  private readonly listedCache = new Map<string, [number, number] | null | undefined>();

  /** Whether a `catch (…)` whose parameter names NAME has a block around token k. */
  private catchBinds(k: number, name: string): boolean {
    this.innermostBlock(k, null); // builds the table of brackets
    let p = this.s.parents![k] ?? -1;
    for (let steps = 0; p > 0 && steps < 256; steps++) {
      if (this.punct(p, "{") && this.punct(p - 1, ")")) {
        const open = this.opener[p - 1]!;
        if (open > 0 && this.is(open - 1, "ident", "catch"))
          for (let j = open + 1; j < p - 1; j++) if (this.is(j, "ident", name)) return true;
      }
      p = this.s.parents![p]!;
    }
    // deeper than that: not known
    return p > 0;
  }

  /**
   * The block a declaration at j is visible in, as `blockScope` reads it, from the innermost open
   * bracket around j (one table for the file, built once): null at d's own level, a `for (…)`
   * header with its body, else the bracket's extent.
   */
  private innermostBlock(j: number, d: FnDef | null): [number, number] | null {
    if (!this.s.parents) this.bracketTables();
    const p = this.s.parents![j]!;
    if (p === -1 || (d && p <= d.body[0])) return null;
    const close = this.match[p]!;
    if (this.punct(p, "(") && this.is(p - 1, "ident", "for") && close !== -1) {
      const body = this.punct(close + 1, "{") ? this.match[close + 1]! : this.exprEnd(close + 1);
      return [p, Math.max(close, body)];
    }
    return [p, close];
  }

  /** Whether a declaration of NAME in an inner block of d (null: the top level) is visible at k. */
  private innerDeclared(d: FnDef | null, name: string, k: number): boolean {
    const v = this.visibleAt(d, name, k);
    return v === "deep" || v.inner.length > 0;
  }

  private declarationsOf(d: FnDef | null, name: string): Declarations {
    const key = `${d ? d.paramsAt : -1}:${name}`;
    let found = this.directCache.get(key);
    if (!found) {
      found = this.directDeclarationsIn(d, name);
      this.directCache.set(key, found);
    }
    return found;
  }

  /**
   * The declarations of NAME in d visible at k: those of d's own level, and those of the blocks
   * around k, found by walking up the brackets around k (at most 64; "deep" beyond).
   */
  private visibleAt(
    d: FnDef | null,
    name: string,
    k: number,
  ): { whole: DeclEntry[]; inner: DeclEntry[] } | "deep" {
    const found = this.declarationsOf(d, name);
    const inner: DeclEntry[] = [];
    if (found.byOpen.size) {
      this.innermostBlock(k, d); // builds the table of brackets
      let p = this.s.parents![k]!;
      for (let steps = 0; p !== -1 && (!d || p > d.body[0]); steps++) {
        if (steps >= 64) return "deep";
        for (const e of found.byOpen.get(p) ?? [])
          if (e.scope![0] < k && k < e.scope![1]) inner.push(e);
        p = this.s.parents![p]!;
      }
    }
    return { whole: found.whole, inner };
  }

  private directDeclaration(
    d: FnDef | null,
    name: string,
    k: number,
    despiteWrites = false,
  ): Binding | "ambiguous" | null {
    const v = this.visibleAt(d, name, k);
    if (v === "deep") return "ambiguous";
    // a declaration of an inner block counts only for a use inside that block
    const visible = [...v.whole, ...v.inner];
    if (!visible.length) return null;
    return visible.length === 1 && (despiteWrites || !this.declarationsOf(d, name).written)
      ? visible[0]!.binding
      : "ambiguous";
  }

  /**
   * The declarations of NAME directly in the body of d (not in a function nested in it), each
   * with the block it is visible in (null: the whole body), and whether the name is written
   * anywhere besides (a write in a nested function counts unless that function binds the name
   * itself). A `var`, a function declaration or a declarator list inside an inner block is read
   * as ambiguous everywhere in d.
   */
  private directDeclarationsIn(d: FnDef | null, name: string): Declarations {
    const whole: DeclEntry[] = [];
    const byOpen = new Map<number, DeclEntry[]>();
    let written = false;
    // a declaration at the body's own level needs no search for its block
    const level = d ? this.depthAt(d.body[0]) + 1 : 0;
    const add = (binding: Binding | "ambiguous", at: number, blockScoped: boolean): void => {
      const scope = this.depthAt(at) === level ? null : this.innermostBlock(at, d);
      // a `for (let x …) …` without a block body: not followed (where it ends is not indexed)
      const loose =
        scope !== null && this.punct(scope[0], "(") && !this.punct(this.match[scope[0]]! + 1, "{");
      if (!scope || !blockScoped || loose)
        whole.push({ binding: scope ? "ambiguous" : binding, scope: null });
      else {
        // a `for (let x …) { … }`: also visible in the body block
        const opens = this.punct(scope[0], "(")
          ? [scope[0], this.match[scope[0]]! + 1]
          : [scope[0]];
        for (const o of opens) {
          const list = byOpen.get(o) ?? [];
          list.push({ binding, scope });
          byOpen.set(o, list);
        }
      }
    };
    const [from, to] = d ? d.body : [0, this.tokens.length];
    for (const j of this.occurrences(name, from, to)) {
      if (this.work <= 0)
        return { whole: [{ binding: "ambiguous", scope: null }], byOpen, written };
      if (this.punct(j - 1, ".")) continue;
      const inner = this.enclosing(j);
      const before = this.tokens[j - 1];
      const assigns = (this.punct(j + 1, "=") && !this.punct(j + 2, "=")) || this.changes(j);
      if (inner !== d) {
        if (assigns && !this.bindsBetween(inner, d, name)) written = true;
        continue;
      }
      const word = before?.type === "ident" ? before.value : null;
      if (word === "const" || word === "let" || word === "var")
        add(
          this.punct(j + 1, "=")
            ? { kind: "value", range: [j + 2, this.exprEnd(j + 2)] }
            : "ambiguous",
          j,
          word !== "var",
        );
      else if (word === "function") {
        const def = this.functionWithParamsAt(j + 1);
        add(def ? { kind: "function", def } : "ambiguous", j, false);
      } else if (word === "class") {
        const range = this.classRanges().find((c) => this.classKeyword(c.start) === j - 1);
        add(range ? { kind: "class", ...range } : "ambiguous", j, true);
      } else if (
        this.punct(j - 1, ",") &&
        this.punct(j + 1, "=") &&
        !this.punct(j + 2, "=") &&
        this.inDeclarationList(j)
      )
        add({ kind: "value", range: [j + 2, this.exprEnd(j + 2)] }, j, false);
      else if (this.patternAt(j, d)) {
        const part = this.patternAt(j, d)!;
        add(part.binding, part.open, part.blockScoped);
      } else if (assigns) written = true;
    }
    return { whole, byOpen, written };
  }

  /**
   * NAME at j as a binding of an object pattern of a declaration (`const { KEY: NAME } = …`,
   * also in a declarator list), with the `{` of the pattern; null when it is none.
   */
  private patternAt(
    j: number,
    d: FnDef | null,
  ): { binding: Binding; open: number; blockScoped: boolean } | null {
    if (!this.punct(j + 1, ",") && !this.punct(j + 1, "}")) return null;
    const renamed = this.punct(j - 1, ":") && this.is(j - 2, "ident");
    if (!renamed && !this.punct(j - 1, "{") && !this.punct(j - 1, ",")) return null;
    let open = j - 1;
    while (
      open > (d ? d.body[0] : 0) &&
      open > j - 400 &&
      !(this.punct(open, "{") && this.match[open]! > j)
    )
      open--;
    if (!this.punct(open, "{")) return null;
    const close = this.match[open]!;
    if (!this.punct(close + 1, "=") || this.punct(close + 2, "=")) return null;
    const word = this.is(open - 1, "ident") ? this.tokens[open - 1]!.value : null;
    const listed = this.punct(open - 1, ",") && this.inDeclarationList(open);
    if (!(word && /^(const|let|var)$/.test(word)) && !listed) return null;
    return {
      binding: {
        kind: "pattern",
        key: renamed ? this.tokens[j - 2]!.value : this.tokens[j]!.value,
        from: [close + 2, this.exprEnd(close + 2)],
      },
      open,
      // a declarator list's keyword is not looked up: inside an inner block it is ambiguous
      blockScoped: word === "const" || word === "let",
    };
  }

  /** Whether a function from `inner` out to (not including) `outer` binds NAME itself. */
  private bindsBetween(inner: FnDef | null, outer: FnDef | null, name: string): boolean {
    for (let x = inner, guard = 0; x && x !== outer && guard < 20; guard++) {
      if (this.bindsOwn(x, name)) return true;
      x = this.enclosing(x.paramsAt - 1);
    }
    return false;
  }

  private readonly ownCache = new Map<string, boolean>();

  /** Whether x binds NAME itself: a parameter, or a declaration directly in its body. Cached. */
  private bindsOwn(x: FnDef, name: string): boolean {
    const key = `${x.paramsAt}:${name}`;
    const cached = this.ownCache.get(key);
    if (cached !== undefined) return cached;
    let own = x.params.some((p) => paramNames([p]).includes(name));
    if (!own)
      for (const j of this.occurrences(name, x.body[0], x.body[1])) {
        const before = this.tokens[j - 1];
        if (
          this.enclosing(j) === x &&
          ((before?.type === "ident" && /^(const|let|var|function|class)$/.test(before.value)) ||
            (this.punct(j - 1, ",") && this.punct(j + 1, "=") && this.inDeclarationList(j)))
        ) {
          own = true;
          break;
        }
      }
    this.ownCache.set(key, own);
    return own;
  }

  /** NAME bound by an object pattern of a declaration in the innermost function around k that binds it. */
  private localPattern(k: number, name: string): { key: string; from: [number, number] } | null {
    for (let d = this.enclosing(k), guard = 0; d && guard < 20; guard++) {
      if (d.params.some((p) => paramNames([p]).includes(name))) return null;
      const part = this.directDeclaration(d, name, k);
      if (part) return part !== "ambiguous" && part.kind === "pattern" ? part : null;
      if (this.declarationIn(d, name, k)) return null;
      d = this.enclosing(d.paramsAt - 1);
    }
    return null;
  }

  /** `class NAME {` declared once directly in d (null: at the top of the file). */
  private classIn(d: FnDef | null, name: string): Binding | null {
    const found = this.classRanges().filter(
      (c) =>
        c.name === name &&
        this.enclosing(c.start) === d &&
        this.is(this.classKeyword(c.start), "ident", "class") &&
        this.is(this.classKeyword(c.start) + 1, "ident", name),
    );
    return found.length === 1 ? { kind: "class", ...found[0]! } : null;
  }

  /** The `class` token before the body that opens at `open` (within the 20 tokens classRanges looks at). */
  private classKeyword(open: number): number {
    for (let j = open - 1; j >= 0 && j > open - 21; j--) if (this.is(j, "ident", "class")) return j;
    return -1;
  }

  /**
   * `var a = 1, NAME = …` at the top of the file, as minifiers write declarations: the
   * initializer when NAME is declared so once and never assigned again; null when it is declared
   * or assigned otherwise too; undefined when it is not declared so at all.
   */
  private topListed(name: string): [number, number] | null | undefined {
    if (this.listedCache.has(name)) return this.listedCache.get(name);
    const found = this.topListedIn(name);
    this.listedCache.set(name, found);
    return found;
  }

  private topListedIn(name: string): [number, number] | null | undefined {
    const all = this.positions(name);
    this.work -= Math.min(all.length, 4001);
    if (all.length > 4000) return undefined;
    let at = -1;
    let declared = 0;
    for (const j of all) {
      if (this.punct(j - 1, ".")) continue;
      if (
        this.punct(j - 1, ",") &&
        this.punct(j + 1, "=") &&
        !this.punct(j + 2, "=") &&
        this.depthAt(j) === 0 &&
        this.inDeclarationList(j)
      ) {
        declared++;
        at = j;
      } else if (
        (this.punct(j + 1, "=") && !this.punct(j + 2, "=") && this.enclosing(j) === null) ||
        (this.changes(j) && this.enclosing(j) === null)
      )
        declared += 2;
    }
    if (!declared) return undefined;
    return declared === 1 ? [at + 2, this.exprEnd(at + 2)] : null;
  }

  /**
   * NAME bound by an object pattern of a declaration directly in d (`var { KEY: NAME } = …`,
   * also in a declarator list): undefined when there is none, null when there are several.
   */
}

/** A declaration of a name in a function, with the block it is visible in (null: all of it). */
interface DeclEntry {
  binding: Binding | "ambiguous";
  scope: [number, number] | null;
}

/** The declarations of a name directly in one function: of its own level, and by inner block. */
interface Declarations {
  whole: DeclEntry[];
  /** Keyed by the `{` (or `for (`) that opens the block they are visible in. */
  byOpen: Map<number, DeclEntry[]>;
  written: boolean;
}

/** What a name is bound to where it is used (see `ExpressionResolver.binding`). */
export type Binding =
  | { kind: "param"; def: FnDef; index: number }
  | { kind: "value"; range: [number, number] }
  | { kind: "function"; def: FnDef }
  | { kind: "class"; name: string; start: number; end: number }
  | { kind: "pattern"; key: string; from: [number, number] };
