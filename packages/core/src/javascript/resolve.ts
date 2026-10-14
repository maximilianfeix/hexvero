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
 */
import type { Constants } from "./aliases.js";
import type { Token } from "./scan.js";

/** How a value was obtained, from the most direct to the most indirect. */
export type ResolveMethod = "concatenation" | "template" | "call" | "parameter" | "element";

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
  | { kind: "str"; values: string[]; src?: ValueSource }
  | { kind: "bool"; value: boolean; src: ValueSource }
  /** `undefined`: a parameter nobody passed, a key a closed object does not have. */
  | { kind: "undef" }
  /** A function of the module `res` reads; its tokens are that module's. */
  | { kind: "fn"; def: FnDef; env: Env; res: ExpressionResolver }
  | { kind: "arr"; elems: Array<Val | null>; line: number }
  /**
   * An object literal, with spreads applied in order. `open`: a spread of something unknown came
   * after some keys, so keys not listed may still be there (and earlier ones were set to null).
   */
  | { kind: "obj"; props: Map<string, Val | null>; open?: boolean }
  | { kind: "map"; entries: Array<[Val | null, Val | null]>; line: number }
  /** Another module's exports (`require("./x")`, CommonJS `exports` of this one). */
  | { kind: "ns"; resolver: ExpressionResolver };

/** Finds the resolver of another module of the application, for imports. */
export interface ModuleHost {
  load(from: string, specifier: string): ExpressionResolver | null;
}

type Env = Map<string, Val>;

type Param =
  | { kind: "name"; name: string; fallback?: [number, number] }
  | { kind: "object"; props: Map<string, string> } // property -> local name
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
}

const MAX_VALUES = 64;
const MAX_DEPTH = 6;
const MAX_SITES = 64;

const product = (parts: string[][]): string[] | null => {
  let out = [""];
  for (const part of parts) {
    const next: string[] = [];
    for (const a of out) for (const b of part) next.push(a + b);
    if (next.length > MAX_VALUES) return null;
    out = next;
  }
  return out;
};

export class ExpressionResolver {
  private readonly match: Int32Array;
  /** For a closing bracket, its opening one. */
  private readonly opener: Int32Array;
  private defs: FnDef[] | null = null;
  private topDecls: Map<string, [number, number] | null> | null = null;
  private classes: Array<{ name: string; start: number; end: number }> | null = null;
  /** Method used by the outermost resolution, set while resolving. */
  private method: ResolveMethod = "concatenation";
  private lines = new Set<number>();
  private partial = false;
  private budget = 20_000;

  constructor(
    private readonly tokens: Token[],
    private readonly constants: Constants,
    /** The module's path in the application, for sources and imports. */
    readonly file = "",
    private readonly host: ModuleHost | null = null,
  ) {
    this.match = new Int32Array(tokens.length).fill(-1);
    this.opener = new Int32Array(tokens.length).fill(-1);
    const open: number[] = [];
    for (let j = 0; j < tokens.length; j++) {
      const p = tokens[j]!;
      if (p.type !== "punct") continue;
      if (p.value === "{" || p.value === "(" || p.value === "[") open.push(j);
      else if (p.value === "}" || p.value === ")" || p.value === "]") {
        const at = open.pop();
        if (at !== undefined) {
          this.match[at] = j;
          this.opener[j] = at;
        }
      }
    }
  }

  private is(k: number, type: Token["type"], value?: string): boolean {
    const t = this.tokens[k];
    return !!t && t.type === type && (value === undefined || t.value === value);
  }

  private punct(k: number, value: string): boolean {
    return this.is(k, "punct", value);
  }

  /** End (exclusive) of the expression that starts at k: the next `,` `;` or closing bracket. */
  private exprEnd(k: number): number {
    const limit = Math.min(this.tokens.length, k + 2000);
    for (let j = k; j < limit; j++) {
      const p = this.tokens[j]!;
      if (p.type !== "punct") continue;
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
    this.method = "concatenation";
    this.lines = new Set();
    this.partial = false;
    this.budget = 20_000;
    const end = this.exprEnd(k);
    const direct = this.evalRange(k, end, new Map(), 0);
    if (direct?.kind === "str") return this.result(direct.values);
    // The expression uses a parameter of the function it is in: read every binding of it.
    const bound = this.throughParameters(k, end, 0);
    return bound ? this.result(bound) : null;
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
    this.budget = 20_000;
    return this.evalRange(k, this.exprEnd(k), new Map(), 0);
  }

  /**
   * The values of the expression at token k for each way the function around it is called:
   * one value when it uses no parameter of that function, one per readable call site when it
   * does. `partial`: a call site could not be read, so its value is not among them.
   */
  valuesAt(k: number): { values: Val[]; partial: boolean } {
    this.budget = 40_000;
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

  // ---------- expressions ----------

  private evalRange(start: number, end: number, env: Env, depth: number): Val | null {
    if (this.budget-- <= 0 || depth > MAX_DEPTH || start >= end) return null;
    // ( … ) around the whole range
    if (this.punct(start, "(") && this.match[start] === end - 1)
      return this.evalRange(start + 1, end - 1, env, depth);
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
    for (const [a, b] of parts) {
      const v = this.evalOperand(a, b, env, depth);
      if (v?.kind !== "str") return null;
      strings.push(v.values);
    }
    const values = product(strings);
    if (!values) return null;
    this.note("concatenation");
    return { kind: "str", values };
  }

  private evalOperand(start: number, end: number, env: Env, depth: number): Val | null {
    const t = this.tokens[start];
    if (!t) return null;
    if (t.type === "string")
      return end === start + 1
        ? { kind: "str", values: [t.value], src: { file: this.file, line: t.line } }
        : null;
    if (t.type === "template") return this.evalTemplate(start, end, env, depth);
    if (t.type === "punct" && t.value === "[") {
      const close = this.match[start]!;
      if (close !== end - 1) return null;
      return { kind: "arr", elems: this.list(start, close, env, depth), line: t.line };
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
      this.host
    ) {
      const other = this.host.load(this.file, this.tokens[start + 2]!.value);
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
      if ((this.punct(j, ".") || this.punct(j, "?.")) && this.is(j + 1, "ident")) {
        value = this.member(value, this.tokens[j + 1]!.value);
        j += 2;
      } else if (
        this.punct(j, "[") &&
        this.tokens[j + 1]?.type === "string" &&
        this.punct(j + 2, "]")
      ) {
        value = this.member(value, this.tokens[j + 1]!.value);
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
      if (v?.kind !== "str") return null;
      parts.push(v.values);
      j = k;
    }
    if (j !== end) return null;
    const values = product(parts);
    if (!values) return null;
    if (parts.length > 1) this.note("template");
    return { kind: "str", values };
  }

  /** Elements of `[ … ]` or arguments of `( … )` between open and close. */
  private list(open: number, close: number, env: Env, depth: number): Array<Val | null> {
    const out: Array<Val | null> = [];
    let from = open + 1;
    while (from < close && out.length < 256) {
      const end = Math.min(this.exprEnd(from), close);
      out.push(end > from ? this.evalRange(from, end, env, depth + 1) : null);
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
    return unknown ? { kind: "obj", props, open: true } : { kind: "obj", props };
  }

  private member(value: Val, property: string): Val | null {
    if (value.kind === "obj") {
      if (value.props.has(property)) return value.props.get(property) ?? null;
      return value.open ? null : { kind: "undef" };
    }
    if (value.kind === "ns") return value.resolver.exportValue(property, MAX_DEPTH - 2);
    return null;
  }

  private call(callee: Val, open: number, close: number, env: Env, depth: number): Val | null {
    if (callee.kind !== "fn" || depth >= MAX_DEPTH) return null;
    const args = this.list(open, close, env, depth);
    const out = callee.res.apply(callee, args, depth);
    if (out) this.note("call");
    return out;
  }

  /** Calls a function of this module with argument values (from any module). */
  apply(callee: Extract<Val, { kind: "fn" }>, args: Array<Val | null>, depth: number): Val | null {
    if (depth >= MAX_DEPTH || this.budget-- <= 0) return null;
    const inner = new Map(callee.env);
    if (!this.bind(callee.def.params, args, inner)) return null;
    return this.evalBody(callee.def, inner, depth + 1);
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
          const v = a ? this.member(a, prop) : null;
          if (v) env.set(local, v);
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

  private evalBody(def: FnDef, env: Env, depth: number): Val | null {
    const [start, end] = def.body;
    if (!def.block) return this.evalRange(start, end, env, depth);
    // `{ return <expr>; }` and nothing else
    if (!this.is(start + 1, "ident", "return")) return null;
    const exprEnd = this.exprEnd(start + 2);
    if (
      !(this.punct(exprEnd, ";")
        ? exprEnd + 1 === end - 1 || exprEnd + 1 === end
        : exprEnd === end - 1)
    )
      return null;
    return this.evalRange(start + 2, exprEnd, env, depth);
  }

  // ---------- names ----------

  private lookup(name: string, k: number, env: Env, depth: number): Val | null {
    const bound = env.get(name);
    if (bound) return bound;
    if (name === "this") return null;
    // a `const` of the function around k, declared once before k: its initializer, read with
    // the same bindings
    const local = this.localConst(k, name);
    if (local) return this.evalRange(local[0], local[1], env, depth + 1);
    const constant = this.constants.stringOf(name, k);
    if (constant !== null) return { kind: "str", values: [constant] };
    if (depth >= MAX_DEPTH) return null;
    // Only names declared once at the top of the file and never assigned again are followed;
    // a name that is also a parameter or local of the function around k is that one instead.
    if (this.enclosingParam(k, name) || this.declaredLocally(k, name)) return null;
    const decl = this.topDeclarations().get(name);
    if (decl) return this.evalRange(decl[0], decl[1], new Map(), depth + 1);
    // CommonJS: `exports.X` and `module.exports.X` of this module
    if (name === "exports" && !this.topDeclarations().has(name))
      return { kind: "ns", resolver: this };
    if (name === "module" && !this.topDeclarations().has(name))
      return {
        kind: "obj",
        props: new Map([["exports", { kind: "ns", resolver: this }]]),
        open: true,
      };
    // a name another module of the application defines
    if (this.host) {
      const imported = this.constants.importOf(name, k);
      if (imported) {
        const other = this.host.load(this.file, imported.specifier);
        if (!other) return null;
        const [head, ...rest] = imported.property.split(".");
        let v = other.exportValue(head!, depth + 1);
        for (const p of rest) v = v ? this.member(v, p) : null;
        return v;
      }
      const required = this.constants.requireOf(name, k);
      if (required) {
        const other = this.host.load(this.file, required);
        return other ? { kind: "ns", resolver: other } : null;
      }
    }
    const fn = this.functions().find((d) => d.name === name && d.owner === null && d.block);
    if (fn && this.topDeclarations().has(name) === false && this.depthAt(fn.paramsAt) === 0)
      return { kind: "fn", def: fn, env: new Map(), res: this };
    return null;
  }

  private arrowAt(k: number, env: Env): Val | null {
    const def = this.functions().find((d) => d.paramsAt === k);
    return def ? { kind: "fn", def, env, res: this } : null;
  }

  private depths: Int32Array | null = null;
  /** Bracket depth (all kinds) at token k, from the start of the file; computed once. */
  private depthAt(k: number): number {
    if (!this.depths) {
      const depths = new Int32Array(this.tokens.length);
      let d = 0;
      for (let j = 0; j < this.tokens.length; j++) {
        depths[j] = d;
        const p = this.tokens[j]!;
        if (p.type !== "punct") continue;
        if (p.value === "{" || p.value === "(" || p.value === "[") d++;
        else if (p.value === "}" || p.value === ")" || p.value === "]") d--;
      }
      this.depths = depths;
    }
    return this.depths[k] ?? 0;
  }

  /** `const|let|var NAME = <expr>` at depth 0, declared once and not assigned elsewhere. */
  private topDeclarations(): Map<string, [number, number] | null> {
    if (this.topDecls) return this.topDecls;
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
          /^(push|unshift|splice|set|delete|clear|fill|copyWithin|sort|reverse)$/.test(
            tokens[k + 2]!.value,
          ) &&
          this.punct(k + 3, "(")) ||
        (this.punct(k + 1, "[") &&
          this.match[k + 1] !== -1 &&
          this.punct(this.match[k + 1]! + 1, "=") &&
          !this.punct(this.match[k + 1]! + 2, "="))
      )
        assigned.add(t.value);
    }
    for (const name of assigned) if (decls.has(name)) decls.set(name, null);
    this.topDecls = decls;
    return decls;
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
        const m = this.match[k]!;
        for (let j = k + 1; j < m; j++) {
          if (!this.is(j, "ident")) continue;
          if (this.punct(j + 1, ":") && this.is(j + 2, "ident")) {
            props.set(this.tokens[j]!.value, this.tokens[j + 2]!.value);
            j += 2;
          } else if (this.punct(j - 1, "{") || this.punct(j - 1, ","))
            props.set(this.tokens[j]!.value, this.tokens[j]!.value);
        }
        params.push({ kind: "object", props });
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
    if (this.classes) return this.classes;
    const out: Array<{ name: string; start: number; end: number }> = [];
    for (let k = 0; k + 2 < this.tokens.length; k++) {
      if (!this.is(k, "ident", "class") || !this.is(k + 1, "ident")) continue;
      let open = k + 2;
      while (open < this.tokens.length && open < k + 20 && !this.punct(open, "{")) open++;
      const close = this.match[open] ?? -1;
      if (this.punct(open, "{") && close !== -1)
        out.push({ name: this.tokens[k + 1]!.value, start: open, end: close });
    }
    this.classes = out;
    return out;
  }

  /** Every function of the file with its parameters and body. */
  private functions(): FnDef[] {
    if (this.defs) return this.defs;
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
            : null;
        defs.push({
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
            : null;
        defs.push({
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
      // a method in a class body: NAME ( … ) {
      if (t.type === "ident" && this.punct(k + 1, "(") && !this.punct(k - 1, ".")) {
        const close = this.match[k + 1]!;
        if (close === -1 || !this.punct(close + 1, "{")) continue;
        const owner = classAt(k);
        if (owner === null) continue;
        const prev = tokens[k - 1];
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
    this.defs = defs;
    return defs;
  }

  /** For a function written as an argument: `recv.method(<here>`. */
  private calledBy(start: number): FnDef["calledBy"] {
    if (!this.punct(start - 1, "(")) return null;
    const open = start - 1;
    if (!this.is(open - 1, "ident") || !this.punct(open - 2, ".")) return null;
    return { method: this.tokens[open - 1]!.value, receiverEnd: open - 2 };
  }

  private enclosing(k: number): FnDef | null {
    let best: FnDef | null = null;
    for (const d of this.functions())
      if (
        d.body[0] <= k &&
        k < d.body[1] &&
        (!best || d.body[1] - d.body[0] < best.body[1] - best.body[0])
      )
        best = d;
    return best;
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
      for (let j = d.body[0]; j < d.body[1]; j++) {
        if (!this.is(j, "ident", name) || this.punct(j - 1, ".")) continue;
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
      let found: [number, number] | null = null;
      let declared = 0;
      for (let j = d.body[0]; j < d.body[1]; j++) {
        if (!this.is(j, "ident", name) || this.punct(j - 1, ".")) continue;
        const before = this.tokens[j - 1];
        if (before?.type === "ident" && /^(const|let|var|function|class)$/.test(before.value)) {
          declared++;
          if (before.value === "const" && this.punct(j + 1, "=") && j < k)
            found = [j + 2, this.exprEnd(j + 2)];
        } else if (this.punct(j + 1, "=") && !this.punct(j + 2, "=")) declared += 2;
      }
      if (declared) return declared === 1 ? found : null;
      d = this.enclosing(d.paramsAt - 1);
    }
    return null;
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
      const args = this.list(open, close, new Map(), depth + 1);
      // an argument that is itself a parameter of the caller: follow one level further
      const env: Env = new Map();
      for (let i = 0; i < def.params.length; i++) {
        if (args[i] === null || args[i] === undefined) {
          const argStart = this.argStart(open, close, i);
          if (argStart === null) continue;
          const deeper = this.throughParameters(
            argStart,
            Math.min(this.exprEnd(argStart), close),
            depth + 1,
          );
          if (deeper) args[i] = { kind: "str", values: deeper };
        }
      }
      this.bind(def.params, args, env);
      // a method: `this` is the instance the call is made on, when its construction is read
      if (def.owner) {
        const self = this.instanceAt(open - 3, def.owner, depth + 1);
        if (self) env.set("this", self);
      }
      envs.push(env);
      this.lines.add(this.tokens[open]!.line);
    }
    this.note("parameter");
    return envs;
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
      let site = -1;
      for (let k = 0; k + 3 < this.tokens.length; k++)
        if (
          this.is(k, "ident", t.value) &&
          this.punct(k + 1, "=") &&
          this.is(k + 2, "ident", "new") &&
          this.is(k + 3, "ident", cls) &&
          this.punct(k + 4, "(")
        ) {
          if (site !== -1) return null; // assigned twice: which instance is not read
          site = k + 4;
        }
      return site === -1 ? null : this.construct(cls, site, depth);
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
  private callSites(def: FnDef): number[] {
    const out: number[] = [];
    const tokens = this.tokens;
    const instances = new Set<string>();
    if (def.owner)
      for (let k = 0; k + 3 < tokens.length; k++)
        if (
          this.is(k, "ident") &&
          this.punct(k + 1, "=") &&
          this.is(k + 2, "ident", "new") &&
          this.is(k + 3, "ident", def.owner)
        )
          instances.add(tokens[k]!.value);
    for (let k = 0; k + 1 < tokens.length && out.length < MAX_SITES; k++) {
      if (!this.is(k, "ident", def.name!) || !this.punct(k + 1, "(") || k + 1 === def.paramsAt)
        continue;
      // a parameter or local of the same name at the call hides the function
      if (!def.owner && (this.enclosingParam(k, def.name!) || this.declaredLocally(k, def.name!)))
        continue;
      const before = this.punct(k - 1, ".");
      if (!def.owner) {
        if (before || this.is(k - 1, "ident", "function")) continue;
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
