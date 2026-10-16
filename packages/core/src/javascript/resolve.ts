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
  | { kind: "cjs"; exports: string; module: string | null; body: [number, number] }
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

interface FnDef {
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
}

const MAX_VALUES = 64;
const MAX_DEPTH = 10;
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
const MUTATORS = /^(push|unshift|splice|set|delete|clear|fill|copyWithin|sort|reverse)$/;
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
    /^(?:\[\^?(?:\\[^\n]|[^\\\][])+\]|\\[dDwWsS\\/.\-_:^$*+?()[\]{}|]|[^\\[\](){}|*+?^$])[*+?]?/;
  let rest = body;
  if (rest.startsWith("^")) rest = rest.slice(1);
  if (rest.endsWith("$") && !rest.endsWith("\\$")) rest = rest.slice(0, -1);
  // At most one quantified atom: without groups, that keeps a match linear per start position,
  // so a replace is at most quadratic in the (bounded) string. `a*a*…b` is refused.
  let quantified = 0;
  for (let atoms = 0; rest.length; atoms++) {
    const a = ATOM.exec(rest);
    if (!a || atoms >= 32) return null;
    if (/[*+?]$/.test(a[0]) && !a[0].endsWith("\\?") && ++quantified > 1) return null;
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
  match: Int32Array;
  opener: Int32Array;
  defs: FnDef[] | null;
  /** First plain block function per name, and every function by the token of its parameters. */
  defsByName: Map<string, FnDef> | null;
  defsByParams: Map<number, FnDef> | null;
  declCache: Map<string, { range: [number, number] | null } | null>;
  topDecls: Map<string, [number, number] | null> | null;
  topPatterns: Map<string, { key: string; from: [number, number] } | null>;
  classes: Array<{ name: string; start: number; end: number }> | null;
  /** Positions of every identifier by name. */
  names: Map<string, number[]> | null;
  depths: Int32Array | null;
  innermost: Int32Array | null;
}

const structures = new WeakMap<Token[], Structure>();

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
  private readonly siteCache = new Map<FnDef, number[]>();
  private readonly literalOwners = new Map<FnDef, string | null>();
  private readonly bindingCache = new Map<
    FnDef,
    { envs: Env[] | null; partial: boolean; lines: number[] }
  >();
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
        topPatterns: new Map(),
        classes: null,
        names: null,
        depths: null,
        innermost: null,
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
   * The values the argument at token k can have, or null. The argument ends at the next
   * top-level `,` or `)`.
   */
  resolveArgument(k: number): ResolvedValues | null {
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

  private result(values: string[]): ResolvedValues | null {
    const unique = [...new Set(values)].filter((v) => v.length > 0);
    if (!unique.length) return null;
    return {
      values: unique,
      method: this.method,
      lines: [...this.lines].toSorted((a, b) => a - b),
      partial: this.partial,
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
      for (let n = 0; n + 2 < this.tokens.length; n++) {
        if (
          !this.is(n, "ident", "new") ||
          !this.is(n + 1, "ident", cls.name) ||
          !this.punct(n + 2, "(")
        )
          continue;
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
    if (!sites.length) return null;
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
    if (decl) return this.evalRange(decl[0], decl[1], new Map(), 0);
    // `var a = 1, NAME = …`, as minifiers write declarations
    if (at === undefined || this.writtenElsewhere(name, at - 2)) return null;
    return this.evalRange(at, this.exprEnd(at), new Map(), 0);
  }

  /** Whether the name is assigned, changed or written to anywhere but at token `decl`. */
  private writtenElsewhere(name: string, decl: number): boolean {
    for (const j of this.positions(name)) {
      if (j === decl || this.punct(j - 1, ".")) continue;
      if ((this.punct(j + 1, "=") && !this.punct(j + 2, "=")) || this.changes(j)) return true;
      if (
        this.punct(j + 1, ".") &&
        this.is(j + 2, "ident") &&
        ((this.punct(j + 3, "=") && !this.punct(j + 4, "=")) ||
          (MUTATORS.test(this.tokens[j + 2]!.value) && this.punct(j + 3, "(")))
      )
        return true;
      if (
        this.punct(j + 1, "[") &&
        this.match[j + 1] !== -1 &&
        this.punct(this.match[j + 1]! + 1, "=") &&
        !this.punct(this.match[j + 1]! + 2, "=")
      )
        return true;
      if (this.punct(j - 1, "(") && this.is(j - 2, "ident", "assign")) return true;
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

  private exportIndex: Map<string, [number, number]> | null = null;
  /**
   * The value this module exports under a name: `exports.NAME = …` (the last assignment that is
   * not `void 0`), `module.exports = { NAME: … }`, `export const NAME = …`, `export function NAME`.
   */
  exportValue(name: string, depth: number): Val | null {
    if (depth > MAX_DEPTH) return null;
    if (!this.exportIndex) {
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
      this.exportIndex = index;
    }
    const range = this.exportIndex.get(name);
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

  private evalRange(start: number, end: number, env: Env, depth: number): Val | null {
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
      const list = this.evalRange(start + 4, close, env, depth + 1);
      if (list?.kind !== "arr" || list.more)
        return this.stop("Object.fromEntries of a list that is not known whole");
      const props = new Map<string, Val | null>();
      for (const e of list.elems) {
        const key = e?.kind === "arr" ? this.oneString(e.elems[0] ?? null) : null;
        if (key === null || e?.kind !== "arr") return this.stop("a computed key is not known");
        props.delete(key);
        props.set(key, e.elems.length > 1 ? (e.elems[1] ?? null) : { kind: "undef" });
      }
      this.note("evaluated");
      return this.chain({ kind: "obj", props }, close + 1, end, env, depth);
    }
    // `new URL(path, base)`: the address the URL constructor builds, when both are known
    if (t.value === "new" && this.is(start + 1, "ident", "URL") && this.punct(start + 2, "(")) {
      const close = this.match[start + 2]!;
      if (close === -1 || close >= end) return null;
      const [path, base] = this.list(start + 2, close, env, depth);
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
      const o = this.evalRange(start + 4, close, env, depth + 1);
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
      const arg = this.evalRange(
        start + 2,
        Math.min(this.exprEnd(start + 2), close),
        env,
        depth + 1,
      );
      return this.chain(arg, close + 1, end, env, depth);
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
      return this.evalRange(start + 4, close, env, depth + 1);
    }
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
    // name, name.prop, name(args), name(args)(args), name.prop(args)
    let value = this.lookup(t.value, start, env, depth);
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
      if (key !== null && this.punct(k + 1, ":")) {
        props.delete(key); // a later write moves the key, as in JavaScript it replaces it
        props.set(key, this.evalRange(k + 2, end, env, depth + 1));
      } else if (key !== null && end === k + 1) {
        props.delete(key);
        props.set(key, this.lookup(key, k, env, depth + 1));
      } else if (key !== null) props.set(key, null); // a method or a computed value
      else unknown = true; // a computed key: `[name]: …`
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
  private wrappedModule(name: string): Val | null {
    const decl = this.topDeclarations().get(name);
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
    const inner = new Map(callee.env);
    this.bind(callee.def.params, args, inner);
    const own = new Set(paramNames(callee.def.params));
    const [start, end] = callee.def.body;
    this.active.add(callee.def);
    try {
      return callee.def.block
        ? this.run(start + 1, end - 1, inner, own, fresh, depth) !== null
        : this.run(start, end, inner, own, fresh, depth) !== null;
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
        if (a) env.set(p.name, a);
      } else if (p.kind === "object") {
        for (const [prop, local] of p.props) {
          let v = a ? this.member(a, prop) : null;
          // a key the argument does not have (or no argument): the pattern's default
          const fallback = p.defaults?.get(local);
          if (fallback && (!passed || v?.kind === "undef"))
            v = this.evalRange(fallback[0], fallback[1], new Map(env), 1);
          if (v) env.set(local, v);
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
      } else if (a?.kind === "arr") {
        const elems = a.elems;
        p.names.forEach((n, j) => {
          const v = elems[j];
          if (n && v) env.set(n, v);
        });
      }
    });
    return true;
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
    const ran = this.run(
      start + 1,
      end - 1,
      env,
      new Set(paramNames(def.params)),
      new Set(),
      depth,
    );
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
    while (k < to) {
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
        const inner = this.run(k + 1, close, new Map(env), new Set(), fresh, depth);
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
        return { returned: true, value: this.evalRange(a, b, env, depth) };
      }
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
      const r = block
        ? this.run(close + 2, bodyEnd, scope, own, fresh, depth)
        : this.run(close + 1, bodyEnd, scope, own, fresh, depth);
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
    target.props.delete(key);
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
        const x = failed || ++count > MAX_ITERATIONS ? null : replacement(match);
        if (x === null) failed = true;
        return x ?? "";
      };
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
    if (local) return this.evalRange(local[0], local[1], env, depth + 1);
    // `function NAME(…) {…}` declared once in a function around k (a module a bundler wrapped)
    const nested = this.nestedFunction(k, name);
    if (nested) return { kind: "fn", def: nested, env: new Map(), res: this };
    const constant = this.constants.stringOf(name, k);
    if (constant !== null) return { kind: "str", values: [constant] };
    if (depth >= MAX_DEPTH) return null;
    // Only names declared once at the top of the file and never assigned again are followed;
    // a name that is also a parameter or local of the function around k is that one instead.
    if (this.enclosingParam(k, name) || this.declaredLocally(k, name)) return null;
    const decl = this.topDeclarations().get(name);
    if (decl) return this.evalRange(decl[0], decl[1], new Map(), depth + 1);
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

  private fnDecls: Map<string, FnDef[]> | null = null;
  /**
   * The function a name means at k when a function around k declares it with
   * `function NAME(…) {…}`, once and nothing else under that name there.
   */
  private nestedFunction(k: number, name: string): FnDef | null {
    if (!this.fnDecls) {
      const byName = new Map<string, FnDef[]>();
      for (const d of this.functions())
        if (
          d.name !== null &&
          d.owner === null &&
          d.block &&
          !d.member &&
          this.is(d.paramsAt - 1, "ident", d.name) &&
          this.is(d.paramsAt - 2, "ident", "function")
        )
          byName.set(d.name, [...(byName.get(d.name) ?? []), d]);
      this.fnDecls = byName;
    }
    const candidates = this.fnDecls.get(name);
    if (!candidates) return null;
    for (let d = this.enclosing(k), guard = 0; d && guard < 20; guard++) {
      const declared = this.declarationIn(d, name);
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
    if (!this.s.depths) {
      const depths = new Int32Array(this.tokens.length);
      let d = 0;
      for (let j = 0; j < this.tokens.length; j++) {
        depths[j] = d;
        const p = this.tokens[j]!;
        if (p.type !== "punct") continue;
        if (p.value === "{" || p.value === "(" || p.value === "[") d++;
        else if (p.value === "}" || p.value === ")" || p.value === "]") d--;
      }
      this.s.depths = depths;
    }
    return this.s.depths[k] ?? 0;
  }

  /** `const|let|var NAME = <expr>` at depth 0, declared once and not assigned elsewhere. */
  private topDeclarations(): Map<string, [number, number] | null> {
    if (this.s.topDecls) return this.s.topDecls;
    const decls = new Map<string, [number, number] | null>();
    const assigned = new Set<string>();
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
      // A later assignment `NAME = …`, a write to a property (`NAME.KEY = …`, `NAME[k] = …`),
      // or a call that changes a list or map (`push`, `set`, `Object.assign(NAME, …)`): the
      // declaration no longer says what the name holds.
      if (
        t.value === "assign" &&
        this.is(k - 2, "ident", "Object") &&
        this.punct(k + 1, "(") &&
        this.is(k + 2, "ident")
      )
        assigned.add(tokens[k + 2]!.value);
      if (this.punct(k - 1, ".")) continue;
      const prev = tokens[k - 1];
      const declares = prev?.type === "ident" && /^(const|let|var)$/.test(prev.value);
      if (this.punct(k + 1, "=") && !this.punct(k + 2, "=") && !declares) assigned.add(t.value);
      else if (
        (this.punct(k + 1, ".") &&
          this.is(k + 2, "ident") &&
          this.punct(k + 3, "=") &&
          !this.punct(k + 4, "=")) ||
        (this.punct(k + 1, ".") &&
          this.is(k + 2, "ident") &&
          MUTATORS.test(tokens[k + 2]!.value) &&
          this.punct(k + 3, "(")) ||
        (this.punct(k + 1, "[") &&
          this.match[k + 1] !== -1 &&
          this.punct(this.match[k + 1]! + 1, "=") &&
          !this.punct(this.match[k + 1]! + 2, "="))
      )
        assigned.add(t.value);
    }
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
        // a later assignment: the pattern no longer says what the name holds
        if (this.punct(j + 1, "=") && !this.punct(j + 2, "=")) {
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
      const name =
        this.is(k + 1, "ident") && !this.is(k + 1, "ident", "extends")
          ? this.tokens[k + 1]!.value
          : this.punct(k - 1, "=") && this.is(k - 2, "ident") && !this.punct(k - 3, ".")
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
    const classes = this.classRanges();
    const classAt = (k: number): string | null => {
      for (const c of classes) if (k > c.start && k < c.end) return c.name;
      return null;
    };
    for (let k = 0; k < tokens.length && defs.length < 20_000; k++) {
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
      // a method with a string key, as bundlers write module wrappers: `{ "src/a.js"(exports) { … } }`
      if (
        t.type === "string" &&
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
        defs.push({
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
    const open = start - 1;
    if (!this.is(open - 1, "ident") || !this.punct(open - 2, ".")) return null;
    return { method: this.tokens[open - 1]!.value, receiverEnd: open - 2 };
  }

  /** The innermost function whose body holds token k; one table for the file, built once. */
  private enclosing(k: number): FnDef | null {
    if (!this.s.innermost) {
      const defs = this.functions();
      const table = new Int32Array(this.tokens.length).fill(-1);
      // larger bodies first, so a nested body overwrites the function around it
      const order = defs
        .map((_, i) => i)
        .toSorted(
          (a, b) =>
            defs[b]!.body[1] - defs[b]!.body[0] - (defs[a]!.body[1] - defs[a]!.body[0]) ||
            // equal sizes: the earlier function is written last and wins, as the scan did
            b - a,
        );
      for (const i of order) {
        const [from, to] = defs[i]!.body;
        table.fill(i, Math.max(0, from), Math.min(this.tokens.length, to));
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
  private localConst(k: number, name: string): [number, number] | null {
    for (let d = this.enclosing(k), guard = 0; d && guard < 20; guard++) {
      const decl = this.declarationIn(d, name);
      if (decl) return decl.range && decl.range[0] - 2 < k ? decl.range : null;
      d = this.enclosing(d.paramsAt - 1);
    }
    return null;
  }

  /** `x += …`, `x++`, `--x` and the like at the name at j. */
  private changes(j: number): boolean {
    const after = this.tokens[j + 1];
    const before = this.tokens[j - 1];
    return (
      (after?.type === "punct" &&
        (after.value === "++" || after.value === "--" || /^[^=!<>]+=$/.test(after.value))) ||
      (before?.type === "punct" && (before.value === "++" || before.value === "--"))
    );
  }

  /**
   * How `name` is declared directly in the body of d: null when it is not, otherwise the
   * initializer of its single `const`, `let` or `var` that is never assigned again (null range
   * for anything else).
   */
  private declarationIn(d: FnDef, name: string): { range: [number, number] | null } | null {
    const key = `${d.paramsAt}:${name}`;
    const cached = this.s.declCache.get(key);
    if (cached !== undefined) return cached;
    let at = -1;
    let declared = 0;
    for (const j of this.occurrences(name, d.body[0], d.body[1])) {
      if (this.punct(j - 1, ".")) continue;
      const before = this.tokens[j - 1];
      if (before?.type === "ident" && /^(const|let|var|function|class)$/.test(before.value)) {
        declared++;
        // `let` and `var` too: a later assignment counts twice below, so the name is not followed
        if (/^(const|let|var)$/.test(before.value) && this.punct(j + 1, "=")) at = j;
      } else if (
        this.punct(j - 1, ",") &&
        this.punct(j + 1, "=") &&
        !this.punct(j + 2, "=") &&
        this.inDeclarationList(j)
      ) {
        // `var a = 1, NAME = …`, as minifiers write declarations
        declared++;
        at = j;
      } else if ((this.punct(j + 1, "=") && !this.punct(j + 2, "=")) || this.changes(j))
        declared += 2;
    }
    const result = !declared
      ? null
      : {
          range:
            declared === 1 && at >= 0 ? ([at + 2, this.exprEnd(at + 2)] as [number, number]) : null,
        };
    this.s.declCache.set(key, result);
    return result;
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
      else if (t.type === "ident" && STATEMENT_WORDS.has(t.value)) return false;
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
    for (let j = start - 1; j >= 0 && j > start - 4000; j--) {
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
      const list = this.evalRange(patternEnd + 1, close, new Map(), depth + 1);
      if (!param || !list) return null;
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
      const values: string[] = [];
      for (const e of elems) {
        if (!e) return null;
        const env: Env = new Map();
        this.bind([param], [e], env);
        const v = this.evalRange(start, end, env, depth + 1);
        if (v?.kind !== "str") return null;
        values.push(...v.values);
      }
      this.note("element");
      this.lines.add(this.tokens[patternEnd + 1]!.line);
      return values;
    }
    return null;
  }

  /** Every environment the function's parameters are bound to: its call sites, or the list a callback runs over. */
  private bindings(def: FnDef, depth: number): Env[] | null {
    // Computed once per function: its call sites do not change between questions.
    const cached = this.bindingCache.get(def);
    if (cached) {
      if (cached.partial) this.partial = true;
      for (const line of cached.lines) this.lines.add(line);
      if (cached.envs) this.note(def.calledBy && def.name === null ? "element" : "parameter");
      return cached.envs;
    }
    if (this.work <= 0) return null;
    const partialBefore = this.partial;
    const linesBefore = new Set(this.lines);
    this.partial = false;
    const envs = this.bindingsUncached(def, depth);
    this.bindingCache.set(def, {
      envs,
      partial: this.partial,
      lines: [...this.lines].filter((l) => !linesBefore.has(l)),
    });
    this.partial = this.partial || partialBefore;
    return envs;
  }

  private bindingsUncached(def: FnDef, depth: number): Env[] | null {
    // a callback of `LIST.forEach((x, i) => …)` or `MAP.forEach((value, key) => …)`
    if (def.calledBy && def.name === null) {
      if (def.calledBy.method !== "forEach" && def.calledBy.method !== "map") return null;
      const receiver = this.receiverStart(def.calledBy.receiverEnd);
      if (receiver === null) return null;
      const list = this.evalRange(receiver, def.calledBy.receiverEnd, new Map(), depth + 1);
      if (!list) return null;
      const envs: Env[] = [];
      if (list.kind === "arr") {
        for (const e of list.elems) {
          if (!e) return null;
          const env: Env = new Map();
          this.bind(def.params, [e], env);
          envs.push(env);
        }
      } else if (list.kind === "map") {
        for (const [key, value] of list.entries) {
          if (!key) return null;
          const env: Env = new Map();
          this.bind(def.params, [value ?? { kind: "str", values: [] }, key], env);
          envs.push(env);
        }
      } else return null;
      this.note("element");
      this.lines.add(this.tokens[receiver]!.line);
      return envs;
    }
    if (def.name === null) return null;
    const sites = this.callSites(def);
    if (!sites.length) return null;
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
    const caller = this.enclosing(open);
    if (!caller || depth > 3) return [new Map()];
    let reads = false;
    for (let j = open - 3; j < close && !reads; j++) {
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
    const outer = this.bindings(caller, depth + 1);
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
        if (
          this.punct(j - 1, "=") &&
          name?.type === "ident" &&
          !this.punct(j - 3, ".") &&
          this.is(j - 3, "ident") &&
          /^(const|let|var)$/.test(this.tokens[j - 3]!.value) &&
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
      if (before?.type === "ident" && /^(const|let|var|function|class)$/.test(before.value))
        declared++;
      else if ((this.punct(j + 1, "=") && !this.punct(j + 2, "=")) || this.changes(j)) return false;
    }
    return declared === 1;
  }

  private callSites(def: FnDef): number[] {
    const cached = this.siteCache.get(def);
    if (cached) return cached;
    const out: number[] = [];
    this.siteCache.set(def, out);
    const tokens = this.tokens;
    const instances = new Set<string>(
      def.owner ? this.instancesOf(def.owner).map((x) => x.name) : [],
    );
    for (const k of this.positions(def.name!)) {
      if (out.length >= MAX_SITES) break;
      if (!this.is(k, "ident", def.name!) || !this.punct(k + 1, "(") || k + 1 === def.paramsAt)
        continue;
      // a parameter or local of the same name at the call hides the function
      if (!def.owner && (this.enclosingParam(k, def.name!) || this.declaredLocally(k, def.name!)))
        continue;
      const before = this.punct(k - 1, ".");
      if (!def.owner) {
        // a method of an object literal: `http.getJson(…)` for `const http = { getJson(url) {…} }`
        if (before) {
          const literal = def.member ? this.literalOwner(def) : null;
          if (literal && this.is(k - 2, "ident", literal) && !this.punct(k - 3, "."))
            out.push(k + 1);
          continue;
        }
        if (def.member || this.is(k - 1, "ident", "function")) continue;
        out.push(k + 1);
        continue;
      }
      if (!before) continue;
      const receiver = tokens[k - 2];
      if (
        receiver?.type === "ident" &&
        (instances.has(receiver.value) || receiver.value === "this")
      ) {
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
    return out;
  }
}
