/**
 * Two kinds of indirection that hide a fact from a scanner that only reads literals:
 *
 * 1. Another name for a known object: `const { ipcMain: bus } = require("electron")`,
 *    `const ipc = ipcRenderer`, `const request = fetch`. Minifiers produce this for every import.
 * 2. A string that is written once and used by name: `const SAVE = "doc:save"`,
 *    `const CH = { SAVE: "doc:save" }`, `module.exports = { SAVE: … }` in another module.
 *
 * Both are resolved here on the token stream, without evaluating anything. Names are resolved
 * with their scope: a parameter or local variable of the same name hides an alias, so a short
 * minified name that means `ipcMain` at the top of a file is not taken for it inside a function
 * that declares its own `n`. Where the tracking is unsure it declares a name too often, which
 * loses an alias and never invents one.
 */
import type { Val } from "./resolve.js";
import type { Token } from "./scan.js";

const is = (t: Token | undefined, type: Token["type"], value?: string): boolean =>
  !!t && t.type === type && (value === undefined || t.value === value);
const text = (t: Token | undefined): string | null =>
  t && (t.type === "string" || (t.type === "template" && !t.value.includes("${"))) ? t.value : null;

const NO_NAMES: ReadonlySet<string> = new Set();

interface Scope {
  /** Allocated when the scope declares something; most scopes declare nothing tracked. */
  names: Set<string> | null;
  aliases: Map<string, string> | null;
  /** Bracket depth the scope was opened at. */
  depth: number;
  /** An arrow function with an expression body ends with its expression, not with a brace. */
  expression: boolean;
  /** A function body (or the file): where a `var` declared in any block inside it belongs. */
  fn: boolean;
}

/**
 * For every identifier that is another name for one of `targets`, the index of the token and the
 * name it stands for. An identifier that is itself a target and is not hidden maps to itself.
 */
export function resolveAliases(
  tokens: Token[],
  targets: ReadonlySet<string>,
  /**
   * Names declared at the top level of this file (e.g. helper functions) whose uses are wanted
   * too. Unlike a target, such a name is hidden by any inner declaration of the same name.
   */
  own: ReadonlySet<string> = new Set(),
): Map<number, string> {
  const out = new Map<number, string>();
  const stack: Scope[] = [{ names: null, aliases: null, depth: 0, expression: false, fn: true }];
  let depth = 0;
  // Deeper nesting than any real program has: beyond it no further scope is opened and its
  // names are declared in the enclosing one, which can only hide an alias, never invent one.
  const MAX_SCOPES = 5000;
  let work = Math.max(2_000_000, tokens.length * 8);
  /** Parameter names waiting for the brace that opens their function body. */
  let pending: { names: Set<string>; at: number; fn: boolean } | null = null;
  const top = (): Scope => stack[stack.length - 1]!;
  /**
   * Per name, the live declarations from outermost to innermost: what the name means in each
   * scope that declares it (null: an ordinary local). The innermost one decides, so a lookup
   * costs the same however deeply the code is nested.
   */
  const live = new Map<string, Array<string | null>>();
  // Only names that can mean something are tracked: the file's own names and every name that is
  // bound to a target somewhere in the file. A declaration of any other name hides nothing that
  // is looked up, so it is ignored. That keeps the bookkeeping to a handful of names per file.
  const tracked = new Set<string>(own);
  // A name bound to a target, or to a name that is itself bound to one (`n = t` after
  // `{ ipcRenderer: t }`, as minifiers write it). Chains are followed a few links deep.
  const bound = new Set<string>();
  let sources: ReadonlySet<string> = targets;
  // Places where an identifier stands in one of the binding shapes below: found once, so later
  // rounds look only at these instead of the whole file.
  const sites: number[] = [];
  for (let k = 0; k < tokens.length; k++) {
    if (tokens[k]!.type !== "ident") continue;
    const next = tokens[k + 1];
    const before = tokens[k - 1];
    if (
      ((is(next, "punct", ":") || is(next, "ident", "as")) && is(tokens[k + 2], "ident")) ||
      (is(before, "punct", "=") && is(tokens[k - 2], "ident")) ||
      (is(before, "punct", ".") && is(tokens[k - 3], "punct", "=") && is(tokens[k - 4], "ident"))
    )
      sites.push(k);
  }
  for (let round = 0; round < 4; round++) {
    const added = new Set<string>();
    const add = (name: string): void => {
      // `bound` and not `tracked` decides: one of the file's own names (an import) is tracked
      // from the start and may still be the first link of a chain.
      if (!bound.has(name)) added.add(name);
      bound.add(name);
      tracked.add(name);
    };
    for (const k of sites) {
      const t = tokens[k]!;
      if (!sources.has(t.value)) continue;
      const next = tokens[k + 1];
      const renamed = tokens[k + 2];
      // `{ target: name }`, `target as name`
      if ((is(next, "punct", ":") || is(next, "ident", "as")) && is(renamed, "ident"))
        add(renamed!.value);
      // `name = target`, `name = x.target`
      if (is(tokens[k - 1], "punct", "=") && is(tokens[k - 2], "ident")) add(tokens[k - 2]!.value);
      if (
        is(tokens[k - 1], "punct", ".") &&
        is(tokens[k - 3], "punct", "=") &&
        is(tokens[k - 4], "ident")
      )
        add(tokens[k - 4]!.value);
    }
    if (added.size === 0) break;
    sources = added;
  }
  // No name is bound to a target and the file has no names of its own: a target can then only
  // be meant by its own name, which callers assume anyway.
  if (tracked.size === 0) return out;
  const interesting = new Set<string>([
    ...tracked,
    ...targets,
    "function",
    "const",
    "let",
    "var",
    "as",
  ]);
  const declare = (scope: Scope, name: string, alias: string | null): void => {
    if (!tracked.has(name)) return;
    const had = (scope.aliases?.has(name) ?? false) || (scope.names?.has(name) ?? false);
    if (alias) {
      scope.names?.delete(name);
      (scope.aliases ??= new Map()).set(name, alias);
    } else (scope.names ??= new Set()).add(name);
    const entries = live.get(name);
    // Declarations are only ever added to the innermost scope, so the last entry is this scope's.
    if (had && entries?.length) entries[entries.length - 1] = alias;
    else if (entries) entries.push(alias);
    else live.set(name, [alias]);
  };
  /** The top-level declaration of one of the file's own names is the name itself, not a local. */
  const ownHere = (name: string): boolean => own.has(name) && stack.length === 1;
  const open = (names: ReadonlySet<string>, expression: boolean, fn: boolean): void => {
    const scope: Scope = { names: null, aliases: null, depth, expression, fn };
    if (stack.length >= MAX_SCOPES) {
      for (const name of names) if (!targets.has(name)) declare(top(), name, null);
      return;
    }
    stack.push(scope);
    for (const name of names) if (!targets.has(name)) declare(scope, name, null);
  };
  /** `var` belongs to the whole function: it is declared in every scope up to the function's. */
  const declareVar = (name: string, alias: string | null): void => {
    for (let i = stack.length - 1; i >= 0; i--) {
      declare(stack[i]!, name, alias);
      if (stack[i]!.fn) break;
    }
  };
  const close = (): void => {
    const scope = stack.pop()!;
    if (!scope.names && !scope.aliases) return;
    for (const name of [...(scope.names ?? []), ...(scope.aliases?.keys() ?? [])]) {
      const entries = live.get(name);
      entries?.pop();
      if (entries?.length === 0) live.delete(name);
    }
  };
  const lookup = (name: string): string | null => {
    const entries = live.get(name);
    if (entries?.length) return entries[entries.length - 1]!;
    return targets.has(name) || own.has(name) ? name : null;
  };
  /** Identifiers between an opening parenthesis and its match; `end` is the closing index. */
  const idents = (start: number): { names: Set<string>; end: number } => {
    const names = new Set<string>();
    let d = 0;
    let k = start;
    for (; k < tokens.length && k < start + 400; k++) {
      const t = tokens[k]!;
      if (t.type === "punct") {
        if (t.value === "(" || t.value === "[" || t.value === "{") d++;
        else if (t.value === ")" || t.value === "]" || t.value === "}") {
          d--;
          if (d === 0) break;
        }
      } else if (t.type === "ident" && tracked.has(t.value)) names.add(t.value);
    }
    return { names, end: k };
  };

  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k]!;
    if (t.type === "punct") {
      const v = t.value;
      if (v === "{" || v === "(" || v === "[") {
        if (v === "{") {
          open(
            pending && pending.at === k ? pending.names : NO_NAMES,
            false,
            !!pending && pending.at === k && pending.fn,
          );
          pending = null;
        }
        depth++;
      } else if (v === "}" || v === ")" || v === "]") {
        depth--;
        // An expression-bodied arrow ends where its enclosing bracket closes.
        while (stack.length > 1 && top().expression && top().depth > depth) close();
        if (v === "}") {
          while (stack.length > 1 && top().expression) close();
          if (stack.length > 1 && top().depth === depth) close();
        } else if (v === ")" && is(tokens[k + 1], "punct", "{") && !pending) {
          // `name(a, b) {`, `catch (e) {`, `for (const x of y) {`: whatever is named in the
          // parentheses may be a binding of the block that follows.
          let from = k;
          for (let d = 0; from >= 0 && from > k - 400; from--) {
            const p = tokens[from]!;
            if (p.type !== "punct") continue;
            if (p.value === ")") d++;
            else if (p.value === "(") {
              d--;
              if (d === 0) break;
            }
          }
          if (from >= 0 && is(tokens[from], "punct", "("))
            pending = {
              names: idents(from).names,
              at: k + 1,
              // `if (…) {`, `for (…) {` open a block; `name(…) {` opens a method body
              fn: !(
                is(tokens[from - 1], "ident") &&
                /^(if|for|while|switch|catch|with)$/.test(tokens[from - 1]!.value)
              ),
            };
        }
      } else if (v === "=>") {
        const before = tokens[k - 1];
        let names = new Set<string>();
        if (is(before, "ident") && tracked.has(before!.value)) names.add(before!.value);
        else if (is(before, "punct", ")")) {
          let from = k - 1;
          for (let d = 0; from >= 0 && from > k - 400; from--) {
            const p = tokens[from]!;
            if (p.type !== "punct") continue;
            if (p.value === ")") d++;
            else if (p.value === "(") {
              d--;
              if (d === 0) break;
            }
          }
          if (from >= 0) names = idents(from).names;
        }
        if (is(tokens[k + 1], "punct", "{")) pending = { names, at: k + 1, fn: true };
        else open(names, true, true);
      } else if ((v === "," || v === ";") && top().expression && top().depth === depth) {
        while (stack.length > 1 && top().expression && top().depth === depth) close();
      }
      continue;
    }
    // Nearly every identifier is neither a keyword that declares nor a name that is tracked.
    if (t.type !== "ident" || !interesting.has(t.value)) continue;
    const next = tokens[k + 1];
    const prev = tokens[k - 1];

    if (t.value === "function") {
      let at = k + 1;
      if (is(tokens[at], "punct", "*")) at++;
      if (is(tokens[at], "ident")) {
        if (!targets.has(tokens[at]!.value) && !ownHere(tokens[at]!.value))
          declare(top(), tokens[at]!.value, null);
        at++;
      }
      if (is(tokens[at], "punct", "(")) {
        const params = idents(at);
        if (is(tokens[params.end + 1], "punct", "{"))
          pending = { names: params.names, at: params.end + 1, fn: true };
      }
      continue;
    }
    if (t.value === "const" || t.value === "let" || t.value === "var") {
      // One declaration list: `a = 1, { b: c } = d, e`. Every identifier in a binding position
      // is declared; aliases are recognised by what stands on the right.
      // `var` is hoisted to its function; `let` and `const` stay in their block.
      const put = (name: string, alias: string | null): void =>
        t.value === "var" ? declareVar(name, alias) : declare(top(), name, alias);
      let d = 0;
      for (let j = k + 1; j < tokens.length && j < k + 2000; j++) {
        // Declarations that never end are each read to the limit. Past a total that no real
        // file reaches, nothing is resolved at all: no alias is better than a wrong one.
        if (work-- <= 0) return new Map();
        const u = tokens[j]!;
        if (u.type === "punct") {
          if (u.value === "{" || u.value === "(" || u.value === "[") d++;
          else if (u.value === "}" || u.value === ")" || u.value === "]") {
            if (d === 0) break;
            d--;
          } else if (u.value === ";" && d === 0) break;
          else if (u.value === "=" && d === 0) {
            // Skip the initializer up to the next top-level comma of this list.
            const name = tokens[j - 1];
            const value = tokens[j + 1];
            const after = tokens[j + 2];
            if (is(name, "ident") && is(value, "ident")) {
              // `x = ipcRenderer` and `x = y.ipcRenderer`, not followed by a call or a member.
              const direct =
                !is(after, "punct", ".") && !is(after, "punct", "(") ? lookup(value!.value) : null;
              const member =
                is(after, "punct", ".") &&
                is(tokens[j + 3], "ident") &&
                targets.has(tokens[j + 3]!.value) &&
                !is(tokens[j + 4], "punct", ".") &&
                !is(tokens[j + 4], "punct", "(")
                  ? tokens[j + 3]!.value
                  : null;
              // `x = require("electron").ipcRenderer`: the member of the module itself.
              const required =
                value!.value === "require" &&
                is(after, "punct", "(") &&
                tokens[j + 3]?.type === "string" &&
                /^electron(\/|$)/.test(tokens[j + 3]!.value) &&
                is(tokens[j + 4], "punct", ")") &&
                is(tokens[j + 5], "punct", ".") &&
                is(tokens[j + 6], "ident") &&
                targets.has(tokens[j + 6]!.value) &&
                !is(tokens[j + 7], "punct", ".") &&
                !is(tokens[j + 7], "punct", "(")
                  ? tokens[j + 6]!.value
                  : null;
              const target = direct ?? member ?? required;
              if (target) put(name!.value, target);
            }
            let e = 0;
            // bounded like the declaration itself, so repeated unclosed initializers stay linear
            for (j++; j < tokens.length && j < k + 2000; j++) {
              const w = tokens[j]!;
              if (w.type !== "punct") continue;
              if (w.value === "{" || w.value === "(" || w.value === "[") e++;
              else if (w.value === "}" || w.value === ")" || w.value === "]") {
                if (e === 0) break;
                e--;
              } else if ((w.value === "," || w.value === ";") && e === 0) break;
            }
            if (!is(tokens[j], "punct", ",")) break;
          }
          continue;
        }
        if (u.type !== "ident" || u.value === "of" || u.value === "in") {
          if (u.type === "ident" && d === 0) break;
          continue;
        }
        // `{ ipcMain: bus }`: the binding is `bus`, and it is another name for ipcMain.
        if (d > 0 && is(tokens[j + 1], "punct", ":")) {
          const local = tokens[j + 2];
          if (targets.has(u.value) && is(local, "ident")) {
            put(local!.value, u.value);
            j += 2;
          }
          continue;
        }
        // A target's own name is never recorded as an ordinary local: `const { ipcRenderer } =
        // require("electron")` declares exactly the object that is looked for.
        if (!top().aliases?.has(u.value) && !targets.has(u.value) && !ownHere(u.value))
          put(u.value, null);
      }
      continue;
    }
    // `import { ipcMain as bus } from "electron"`: the name belongs to the scope around the
    // import's braces, not to the braces.
    if (t.value === "as" && is(prev, "ident") && targets.has(prev!.value) && is(next, "ident")) {
      const outer =
        stack.length > 1 && top().depth === depth - 1 ? stack[stack.length - 2]! : top();
      (outer.aliases ??= new Map()).set(next!.value, prev!.value);
      const entries = live.get(next!.value);
      if (entries) entries.unshift(prev!.value);
      else live.set(next!.value, [prev!.value]);
      continue;
    }
    // One of the file's own names, wherever it is used (a constant is used as an argument).
    if (own.has(t.value) && !is(prev, "punct", ".") && !is(prev, "punct", "?.")) {
      // It may at the same time be another name for a target (`{ ipcMain: bus }` imports `bus`).
      const meaning = lookup(t.value);
      if (meaning) out.set(k, meaning);
      continue;
    }
    // A use: only identifiers that start a member access or a call matter to callers.
    if (
      !is(prev, "punct", ".") &&
      !is(prev, "punct", "?.") &&
      (is(next, "punct", ".") || is(next, "punct", "(") || is(next, "punct", "?."))
    ) {
      const target = lookup(t.value);
      if (target) out.set(k, target);
    }
  }
  return out;
}

/** A string value reached by name, or where to look for it in another module. */
export type Resolved =
  /** `evaluated`: a value of a declaration only an evaluation reads, declared at `line`. */
  | { value: string; via: "literal" | "constant" | "evaluated"; line?: number }
  /** Another module's constant; `before` and `after`: text a template puts around it. */
  | { ref: { specifier: string; property: string; before?: string; after?: string } }
  | null;

/**
 * Reads the value of a declaration that only an evaluation can (see resolve.ts), with the reason
 * when it cannot. Constants never evaluates anything itself.
 */
export interface Evaluator {
  /** The value of a top-level name whose initializer starts at token `at`. */
  name(name: string, at: number): { value: Val | null; reason: string | null };
  /** The value of the expression that starts at token `at`. */
  at(at: number): { value: Val | null; reason: string | null };
}

/** What an evaluated value gives a table: its single-valued string entries, nested as `a.b`. */
interface Flat {
  table: Map<string, string>;
  value: string | null;
}

function one(v: Val | null | undefined): string | null {
  return v?.kind === "str" && !v.ref && v.values.length === 1 && !v.values[0]!.includes("${…}")
    ? v.values[0]!
    : null;
}

function flatten(v: Val | null): Flat {
  const table = new Map<string, string>();
  const walk = (o: Extract<Val, { kind: "obj" }>, prefix: string, depth: number): void => {
    for (const [key, p] of o.props) {
      const entry = one(p);
      if (entry !== null) table.set(`${prefix}${key}`, entry);
      else if (p?.kind === "obj" && depth < 3) walk(p, `${prefix}${key}.`, depth + 1);
    }
  };
  if (v?.kind === "obj") walk(v, "", 0);
  return { table, value: one(v) };
}

/** String constants and tables of string constants declared in one file. */
/** Short-named enum definitions read per file, and token visits to check them (settleScoped). */
const MAX_SCOPED = 256;
const SCOPED_WORK = 1_000_000;

export class Constants {
  private readonly strings = new Map<string, string | null>();
  private readonly tables = new Map<string, Map<string, string>>();
  private readonly requires = new Map<string, string>();
  /** `import { A as B } from "x"` and `const { A: B } = require("x")`: B is A of module x. */
  private readonly imported = new Map<string, { specifier: string; property: string }>();
  private readonly tableKeys = new Map<string, string[]>();
  /** What a bundler's module wrapper exports: strings, and tables under their export names. */
  private readonly wrapperStrings = new Map<string, Map<string, string>>();
  private readonly wrapperTables = new Map<string, Map<string, Map<string, string>>>();
  /** `var channels = require_channels()`: the wrapper a name holds the exports of. */
  private readonly wrapperOf = new Map<string, string>();
  /** `const T = [[a, f], …]` and `const T = new Map([[a, f], …])`: where the list opens. */
  private readonly pairLists = new Map<string, number>();
  /**
   * What other modules can refer to: `module.exports = { K: "v" }`, `exports.K = "v"`,
   * `export const K = "v"`, and for an exported table of strings one entry per `TABLE.KEY`.
   */
  readonly exported: Record<string, string> = {};
  /**
   * Names this file passes on from another module without a literal of its own:
   * `module.exports = { SAVE: ch.SAVE }`, `exports.OPEN = names.OPEN`,
   * `export { OPEN_DOC as OPEN } from "./channels"`. Looked up there by the application scan.
   */
  readonly reexported: Record<string, { specifier: string; property: string }> = {};
  /** `export * from "./x"`: every name of x is a name of this file. */
  readonly starExports: string[] = [];
  /** Export entries whose value is a name, settled once the whole file is read. */
  private readonly exportNames: Array<{ key: string; at: number }> = [];
  /**
   * Names declared at the top whose value only an evaluation reads (`const B = make(…)`,
   * `Object.fromEntries(…)`): where the initializer starts; null when declared twice.
   */
  private readonly computedAt = new Map<string, number | null>();
  private evaluator: Evaluator | null = null;
  private readonly computedCache = new Map<string, (Flat & { line: number }) | null>();
  private readonly computedReasons = new Map<string, string>();
  /** Exports of names, and of calls, that only an evaluation reads; settled by `useEvaluator`. */
  private readonly exportRequests: Array<{ key: string; name: string }> = [];
  private readonly exportCalls: Array<{ key: string; at: number }> = [];
  /** `module.exports = make(…)`: where the call starts. */
  private wholeExportCall = -1;
  /** Exported keys whose values an evaluation read. */
  readonly evaluated: string[] = [];
  /** Exported names an evaluation could not read, with the reason. */
  readonly unevaluated: Record<string, string> = {};
  /**
   * Token indexes at which a name means its top-level declaration (the result of
   * `resolveAliases` with `names()` as the file's own names). While it is null, every use counts.
   */
  visible: Map<number, string> | null = null;
  /** Names and `TABLE.KEY` entries that are assigned after their declaration. */
  private readonly reassigned = new Set<string>();
  private readonly exportsName = "exports";
  /**
   * Compiled TypeScript string enums, by enum name: `(function (E) { E.A = "a"; E["B"] = "b" })(E
   * || (exports.E = E = {}))`, also as minifiers write it. Null marks a name that two enums of the
   * file share with different contents: nothing is resolved through it.
   */
  private readonly enums = new Map<string, Map<string, string> | null>();
  /** `(E || (exports.K = E = {}))`: the CommonJS export key of an enum, by enum name (tsc's emit). */
  private readonly enumExports = new Map<string, string>();
  /**
   * Enums under a minifier's one- or two-letter name (`var i; (function (e) { … })(i || (i = {}))`
   * in a webpack module): known only inside the block that declares the name, and only where the
   * name means nothing else anywhere in that block (it is read as `i.MEMBER` and nothing else).
   */
  private readonly scopedEnums = new Map<
    string,
    Array<{ members: Map<string, string>; from: number; to: number }>
  >();
  /** Short-named enum definitions waiting for `settleScoped` (at most MAX_SCOPED). */
  private readonly pendingScoped: Array<{
    name: string;
    members: Map<string, string>;
    k: number;
    end: number;
  }> = [];

  /** Reads the compiled string enums of the file into `enums`. */
  private readEnums(): void {
    const tokens = this.tokens;
    /** Token ranges of the enum definitions themselves. */
    const spans: Array<[number, number]> = [];
    for (let k = 0; k + 6 < tokens.length; k++) {
      if (
        !is(tokens[k], "ident", "function") ||
        !is(tokens[k + 1], "punct", "(") ||
        !is(tokens[k + 2], "ident") ||
        !is(tokens[k + 3], "punct", ")") ||
        !is(tokens[k + 4], "punct", "{")
      )
        continue;
      const parameter = tokens[k + 2]!.value;
      const members = new Map<string, string>();
      let j = k + 5;
      // `E.A = "a"` or `E["A"] = "a"`, separated by `,` or `;`, and nothing else in the body
      for (; j + 4 < tokens.length && members.size < 5000;) {
        if (!is(tokens[j], "ident", parameter)) break;
        let key: string | null = null;
        let at = j + 1;
        if (is(tokens[at], "punct", ".") && is(tokens[at + 1], "ident")) {
          key = tokens[at + 1]!.value;
          at += 2;
        } else if (
          is(tokens[at], "punct", "[") &&
          tokens[at + 1]?.type === "string" &&
          is(tokens[at + 2], "punct", "]")
        ) {
          key = tokens[at + 1]!.value;
          at += 3;
        }
        const value = text(tokens[at + 1]);
        if (key === null || !is(tokens[at], "punct", "=") || value === null) break;
        members.set(key, value);
        j = at + 2;
        if (is(tokens[j], "punct", ",") || is(tokens[j], "punct", ";")) j++;
      }
      if (!members.size || !is(tokens[j], "punct", "}")) continue;
      // The call that follows names the enum: `(E || (E = {}))`, `(i || (n.IpcEvents = i = {}))`
      let open = j + 1;
      if (is(tokens[open], "punct", ")")) open++;
      if (!is(tokens[open], "punct", "(")) continue;
      const names = new Set<string>();
      const short = new Set<string>();
      let argumentsEnd = open + 1;
      for (let a = open + 1, depth = 1; a < tokens.length && a < open + 24 && depth > 0; a++) {
        argumentsEnd = a;
        const t = tokens[a]!;
        if (t.type === "punct") {
          if (t.value === "(") depth++;
          else if (t.value === ")") depth--;
          continue;
        }
        // A one- or two-letter name is a minifier's local: it means something else in every
        // other function of the bundle, so the enum is not known by it.
        if (t.type === "ident" && is(tokens[a + 1], "punct", "=") && t.value.length > 2)
          names.add(t.value);
        else if (
          t.type === "ident" &&
          is(tokens[a + 1], "punct", "=") &&
          !is(tokens[a - 1], "punct", ".") &&
          is(tokens[a + 2], "punct", "{")
        )
          short.add(t.value);
        // `exports.K = E = {}`: tsc's CommonJS export of the enum
        if (
          t.type === "ident" &&
          t.value === this.exportsName &&
          !is(tokens[a - 1], "punct", ".") &&
          is(tokens[a + 1], "punct", ".") &&
          is(tokens[a + 2], "ident") &&
          is(tokens[a + 3], "punct", "=") &&
          is(tokens[a + 4], "ident")
        )
          this.enumExports.set(tokens[a + 4]!.value, tokens[a + 2]!.value);
      }
      if (parameter.length > 2) names.add(parameter);
      spans.push([k, argumentsEnd]);
      for (const name of short)
        if (this.pendingScoped.length < MAX_SCOPED)
          this.pendingScoped.push({ name, members, k, end: argumentsEnd });
      for (const name of names) {
        const known = this.enums.get(name);
        if (known === undefined) {
          this.enums.set(name, members);
          continue;
        }
        if (known === null) continue;
        // The same enum compiled into two modules is one enum: equal members, equal values.
        // Anything else under one name is two enums, and a member of one must not be resolved
        // where the other is in scope.
        const same =
          known.size === members.size && [...members].every(([key, v]) => known.get(key) === v);
        if (!same) this.enums.set(name, null);
      }
      k = j;
    }
    this.settleScoped();
    if (!this.enums.size) return;
    // The enum's name must mean the enum everywhere in the file. Outside the definitions, any
    // other binding of the name (a declaration with a value, an assignment, a parameter, a
    // destructured or imported name) makes it ambiguous, and nothing is resolved through it:
    // a local `const Channels = { SAVE: "other" }` must not be read through the enum's table.
    let span = 0;
    for (let k = 0; k < tokens.length; k++) {
      while (span < spans.length && spans[span]![1] < k) span++;
      if (span < spans.length && k >= spans[span]![0]) continue;
      const t = tokens[k]!;
      if (t.type !== "ident" || this.enums.get(t.value) == null) continue;
      const next = tokens[k + 1];
      const property = is(tokens[k - 1], "punct", ".");
      // `x.Name = void 0` is how compiled modules announce the export before defining it;
      // `var Name;` is the declaration TypeScript emits in front of the enum.
      // tsc announces all exports of a module in one chain, `x.A = x.Name = x.B = void 0`;
      // followed for at most 64 links, so a long chain costs no more than that per enum name.
      let announced = false;
      if (is(next, "punct", "="))
        for (let at = k + 2, links = 0; links < 64; links++) {
          if (is(tokens[at], "ident", "void") && tokens[at + 1]?.value === "0") {
            announced = true;
            break;
          }
          if (
            !is(tokens[at], "ident") ||
            !is(tokens[at + 1], "punct", ".") ||
            !is(tokens[at + 2], "ident") ||
            !is(tokens[at + 3], "punct", "=")
          )
            break;
          at += 4;
        }
      const rebound =
        (is(next, "punct", "=") && !is(tokens[k + 2], "punct", "=") && !announced) ||
        (!property &&
          // `() => Name,` returns the name; it binds nothing
          !is(tokens[k - 1], "punct", "=>") &&
          !is(next, "punct", ".") &&
          !is(next, "punct", ";") &&
          !(next && next.line !== t.line) &&
          // `Name:` is an object key or a ternary branch, never a new binding of Name
          (is(next, "punct", ",") || is(next, "punct", ")") || is(next, "punct", "}")));
      if (rebound) this.enums.set(t.value, null);
    }
  }

  /**
   * Records the enums under a short name for the block around each definition, where the name
   * means the enum everywhere in that block: declared with `var name;` and otherwise only read as
   * `name.MEMBER`. One pass finds the blocks and one the positions of the names; the check of the
   * positions in each block is charged to one budget per file (SCOPED_WORK), so many such
   * definitions stay linear.
   */
  private settleScoped(): void {
    const pending = this.pendingScoped;
    if (!pending.length) return;
    const tokens = this.tokens;
    // the innermost `{` around each definition, and where it closes (-1 / length: the top level)
    const opens = new Int32Array(pending.length).fill(-1);
    const closes = new Int32Array(pending.length).fill(tokens.length);
    const order = pending.map((_, i) => i).toSorted((a, b) => pending[a]!.k - pending[b]!.k);
    const stack: number[] = [];
    const waiting = new Map<number, number[]>(); // `{` index -> definitions inside it
    let next = 0;
    for (let j = 0; j < tokens.length; j++) {
      while (next < order.length && pending[order[next]!]!.k === j) {
        const i = order[next++]!;
        const open = stack.at(-1) ?? -1;
        opens[i] = open;
        if (open !== -1) waiting.set(open, [...(waiting.get(open) ?? []), i]);
      }
      const t = tokens[j]!;
      if (t.type !== "punct") continue;
      if (t.value === "{") stack.push(j);
      else if (t.value === "}") {
        const open = stack.pop();
        if (open !== undefined) for (const i of waiting.get(open) ?? []) closes[i] = j;
      }
    }
    const names = new Set(pending.map((p) => p.name));
    const positions = new Map<string, number[]>();
    for (let j = 0; j < tokens.length; j++) {
      const t = tokens[j]!;
      if (t.type !== "ident" || !names.has(t.value)) continue;
      const list = positions.get(t.value);
      if (list) list.push(j);
      else positions.set(t.value, [j]);
    }
    let work = SCOPED_WORK;
    for (let i = 0; i < pending.length && work > 0; i++) {
      const { name, members, k, end } = pending[i]!;
      const open = opens[i]!;
      const close = closes[i]!;
      // an unclosed block: which one it is is not known
      if (open !== -1 && close === tokens.length) continue;
      const all = positions.get(name) ?? [];
      let lo = 0;
      let hi = all.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (all[mid]! <= open) lo = mid + 1;
        else hi = mid;
      }
      let declared = false;
      let valid = true;
      for (let p = lo; p < all.length && all[p]! < close; p++) {
        if (--work <= 0) {
          valid = false;
          break;
        }
        const j = all[p]!;
        if (j >= k && j <= end) continue;
        if (is(tokens[j - 1], "punct", ".")) continue;
        if (
          is(tokens[j - 1], "ident", "var") &&
          (is(tokens[j + 1], "punct", ";") || is(tokens[j + 1], "punct", ","))
        ) {
          if (declared) valid = false;
          declared = true;
        } else if (
          !(
            is(tokens[j + 1], "punct", ".") &&
            is(tokens[j + 2], "ident") &&
            !is(tokens[j + 3], "punct", "=")
          )
        )
          valid = false; // a parameter, a declaration, a write, a bare use
        if (!valid) break;
      }
      if (!valid || !declared) continue;
      const list = this.scopedEnums.get(name) ?? [];
      list.push({ members, from: open, to: close });
      this.scopedEnums.set(name, list);
    }
  }

  /** A member of an enum known under a short name in the block around token k. */
  private scopedMember(name: string, member: string, k: number): string | null {
    for (const e of this.scopedEnums.get(name) ?? [])
      if (k > e.from && k < e.to) return e.members.get(member) ?? null;
    return null;
  }

  /**
   * The value of `Enum.MEMBER` or `anything.Enum.MEMBER` used as an argument at token `k`.
   * The object in front of the enum name is whatever the module was imported as and is not
   * looked at: the enum name and the member decide.
   */
  private enumMember(k: number, endAt?: number): string | null {
    const tokens = this.tokens;
    if ((!this.enums.size && !this.scopedEnums.size) || tokens[k]?.type !== "ident") return null;
    const chain = [tokens[k]!.value];
    let at = k + 1;
    while (chain.length < 3 && is(tokens[at], "punct", ".") && is(tokens[at + 1], "ident")) {
      chain.push(tokens[at + 1]!.value);
      at += 2;
    }
    if (
      chain.length < 2 ||
      (endAt === undefined
        ? !is(tokens[at], "punct", ",") && !is(tokens[at], "punct", ")")
        : at !== endAt)
    )
      return null;
    const [name, member] = chain.slice(-2) as [string, string];
    return (
      this.enums.get(name)?.get(member) ??
      (chain.length === 2 && this.scopedEnums.size ? this.scopedMember(name, member, k) : null)
    );
  }

  /**
   * The value of `Enum.MEMBER` or `anything.Enum.MEMBER` when that chain is exactly the tokens
   * [k, end): for the resolver, which reads expressions of any extent (an argument bound at a
   * call site, a key inside a wrapper). The same rules as `enumMember`.
   */
  enumAt(k: number, end: number): string | null {
    return this.enumMember(k, end);
  }

  constructor(private readonly tokens: Token[]) {
    this.readEnums();
    const wrappers = this.wrapperStrings;
    /** A bundler's module wrapper being read: `var W = helper({ "file.js"(exports, module) {`. */
    let wrapper: { name: string; until: number; depth: number } | null = null;
    // Only declarations at the top level of the file, or of a module inside a bundler's wrapper,
    // are constants of the file. A `const e = "x"` in some function is that function's own, and
    // in minified code the same short name means something else a few lines on.
    let depth = 0;
    for (let k = 0; k < tokens.length; k++) {
      if (wrapper && k > wrapper.until) wrapper = null;
      const t = tokens[k]!;
      if (t.type === "punct") {
        // `var a = 1, { Library: r } = p()`: a pattern in a declaration list, as minifiers write it
        if (
          t.value === "," &&
          is(tokens[k + 1], "punct", "{") &&
          (wrapper ? depth <= wrapper.depth + 2 : depth === 0)
        )
          this.bindings(k + 1);
        if (t.value === "{") depth++;
        else if (t.value === "}") depth--;
        continue;
      }
      if (t.type !== "ident") continue;
      // A value assigned again anywhere is no constant: `CH = "b"`, `TABLE.KEY = "z"`.
      if (!is(tokens[k - 1], "punct", ".")) {
        const before = tokens[k - 1];
        const declares =
          (is(before, "ident") && /^(const|let|var)$/.test(before!.value)) ||
          is(before, "punct", ",");
        if (is(tokens[k + 1], "punct", "=") && !declares) this.reassigned.add(t.value);
        if (
          is(tokens[k + 1], "punct", ".") &&
          is(tokens[k + 2], "ident") &&
          is(tokens[k + 3], "punct", "=") &&
          this.exportsName !== t.value
        )
          this.reassigned.add(`${t.value}.${tokens[k + 2]!.value}`);
      }
      if (wrapper ? depth > wrapper.depth + 2 : depth !== 0) continue;
      // `class Channels { static SAVE = "doc:save" }`: a table of its static string fields.
      if (t.value === "class" && is(tokens[k + 1], "ident") && !is(tokens[k - 1], "punct", ".")) {
        const name = tokens[k + 1]!.value;
        const table = this.staticTable(k + 2);
        if (table.size && !this.tables.has(name) && !this.strings.has(name)) {
          this.tables.set(name, table);
          if (is(tokens[k - 1], "ident", "export")) this.export(name);
        }
        continue;
      }
      if (t.value === "export" && !wrapper) {
        if (is(tokens[k + 1], "punct", "*") && is(tokens[k + 2], "ident", "from")) {
          const specifier = text(tokens[k + 3]);
          if (specifier !== null) this.starExports.push(specifier);
        } else if (is(tokens[k + 1], "punct", "{")) this.esmExportList(k + 1);
      }
      if (
        (t.value === "import" || /^(const|let|var)$/.test(t.value)) &&
        is(tokens[k + 1], "punct", "{")
      )
        this.bindings(k + 1);
      // `import config from "./config.js"`: the module's exports under one name, as `require`
      // gives them for a CommonJS module.
      if (
        t.value === "import" &&
        !wrapper &&
        is(tokens[k + 1], "ident") &&
        is(tokens[k + 2], "ident", "from") &&
        text(tokens[k + 3]) !== null &&
        !this.requires.has(tokens[k + 1]!.value)
      )
        this.requires.set(tokens[k + 1]!.value, text(tokens[k + 3])!);
      const eq = is(tokens[k + 1], "punct", "=");
      const value = tokens[k + 2];
      // `module.exports = Object.freeze({ … })`: the object is what counts
      const frozen =
        is(value, "ident", "Object") &&
        is(tokens[k + 3], "punct", ".") &&
        is(tokens[k + 4], "ident", "freeze") &&
        is(tokens[k + 5], "punct", "(") &&
        is(tokens[k + 6], "punct", "{")
          ? k + 6
          : -1;
      if (
        eq &&
        is(tokens[k - 1], "punct", ".") &&
        t.value === "exports" &&
        (is(value, "punct", "{") || frozen !== -1)
      ) {
        // `module.exports = { … }` or, in a wrapper, `<param>.exports = { … }`
        const at = frozen !== -1 ? frozen : k + 2;
        const table = this.object(at);
        if (wrapper) {
          wrappers.set(wrapper.name, table);
          // `module.exports = { Library: Library2 }` with `var Library2 = class {…}` or `{…}`
          const tables = new Map<string, Map<string, string>>();
          for (const [key, local] of this.namedEntries(at)) {
            const found = this.tables.get(local);
            const string = this.strings.get(local);
            if (found) tables.set(key, found);
            else if (typeof string === "string" && !table.has(key)) table.set(key, string);
          }
          // `module.exports = { ...channels, ...require_endpoints() }`: another wrapper's exports
          for (const other of this.spreadWrappers(at)) {
            for (const [key, v] of this.wrapperStrings.get(other) ?? [])
              if (!table.has(key)) table.set(key, v);
            for (const [key, v] of this.wrapperTables.get(other) ?? [])
              if (!tables.has(key)) tables.set(key, v);
          }
          if (tables.size) this.wrapperTables.set(wrapper.name, tables);
        } else {
          for (const [key, v] of table) this.exported[key] = v;
          // `module.exports = { CHANNELS, API_ROOT }`: this file's own constants, by name
          for (const key of this.keys(at, true)) this.export(key);
          this.collectExportNames(at);
          this.spreadExports(at);
        }
        continue;
      }
      // `module.exports = make(…)`: read once an evaluator is known
      if (
        eq &&
        !wrapper &&
        t.value === "exports" &&
        is(tokens[k - 1], "punct", ".") &&
        is(tokens[k - 2], "ident", "module") &&
        is(value, "ident") &&
        value!.value !== "require" &&
        (is(tokens[k + 3], "punct", "(") || is(tokens[k + 3], "punct", "."))
      )
        this.wholeExportCall = k + 2;
      if (
        t.value === "exports" &&
        is(tokens[k + 1], "punct", ".") &&
        is(tokens[k + 2], "ident") &&
        is(tokens[k + 3], "punct", "=")
      ) {
        const v = text(tokens[k + 4]);
        if (v !== null && !wrapper) this.exported[tokens[k + 2]!.value] = v;
        // `exports.Channels = { Save: "doc:save" }`: one entry per `Channels.Save`
        else if (!wrapper && is(tokens[k + 4], "punct", "{"))
          for (const [key, entry] of this.object(k + 4))
            this.exported[`${tokens[k + 2]!.value}.${key}`] = entry;
        else if (!wrapper && is(tokens[k + 4], "ident"))
          this.exportNames.push({ key: tokens[k + 2]!.value, at: k + 4 });
        continue;
      }
      if (!eq || is(tokens[k - 1], "punct", ".")) continue;
      const declared = is(tokens[k - 1], "ident") && /^(const|let|var)$/.test(tokens[k - 1]!.value);
      const listed = is(tokens[k - 1], "punct", ",");
      if (!declared && !listed) continue;
      const exportedHere = declared && is(tokens[k - 2], "ident", "export");
      // `const B = make(…)`, `var a = 1, B = Object.fromEntries(…)`: read by an evaluation
      if (
        !wrapper &&
        depth === 0 &&
        ((is(value, "ident") &&
          !/^(require|class|new|function|async|await|typeof|void|import)$/.test(value!.value) &&
          (is(tokens[k + 3], "punct", "(") || is(tokens[k + 3], "punct", "."))) ||
          // `(() => { … })()`, `(function () { … })()`
          is(value, "punct", "("))
      ) {
        this.computedAt.set(t.value, this.computedAt.has(t.value) ? null : k + 2);
        if (exportedHere) this.exportRequests.push({ key: t.value, name: t.value });
      }
      const literal = text(value);
      const after = tokens[k + 3];
      if (
        literal !== null &&
        (!after ||
          !is(after, "punct") ||
          after.value === ";" ||
          after.value === "," ||
          after.value === "}")
      ) {
        // A second declaration of the name makes it ambiguous.
        this.strings.set(t.value, this.strings.has(t.value) ? null : literal);
        if (exportedHere) this.export(t.value);
      } else if (is(value, "punct", "{") || frozen !== -1) {
        const at = frozen !== -1 ? frozen : k + 2;
        const table = this.object(at);
        if (table.size) this.tables.set(t.value, table);
        const keys = this.keys(at);
        if (keys.length) this.tableKeys.set(t.value, keys);
        if (exportedHere) this.export(t.value);
      } else if (is(value, "ident", "class")) {
        // `var Library2 = class { static LIST = "…" }`, as bundlers write a class
        const table = this.staticTable(k + 3);
        if (table.size && !this.tables.has(t.value)) this.tables.set(t.value, table);
      } else if (
        (declared || listed) &&
        (is(value, "punct", "[") ||
          (is(value, "ident", "new") &&
            is(tokens[k + 3], "ident", "Map") &&
            is(tokens[k + 4], "punct", "(") &&
            is(tokens[k + 5], "punct", "[")))
      ) {
        // A second declaration of the name makes it ambiguous.
        this.pairLists.set(
          t.value,
          this.pairLists.has(t.value) ? -1 : is(value, "punct", "[") ? k + 2 : k + 5,
        );
      } else if (exportedHere && is(value, "ident") && !is(tokens[k + 3], "punct", "(")) {
        // `export const ConfigSync = Channel.ConfigGetSync`: settled with the export lists
        this.exportNames.push({ key: t.value, at: k + 2 });
      } else if (
        is(value, "ident", "require") &&
        is(tokens[k + 3], "punct", "(") &&
        text(tokens[k + 4]) !== null
      ) {
        this.requires.set(t.value, text(tokens[k + 4])!);
      } else if (is(value, "ident") && is(tokens[k + 3], "punct", "(")) {
        if (is(tokens[k + 4], "punct", ")")) {
          // `var CH = require_channels()`: the table a wrapper exported
          const table = wrappers.get(value!.value);
          if (table) this.tables.set(t.value, table);
          if (wrappers.has(value!.value)) this.wrapperOf.set(t.value, value!.value);
        } else if (!wrapper) {
          // `var W = helper({ "file.js"(exports, module) { … } })`, or minified
          // `var W = h((e, m) => { … })`: remember the wrapper until the call closes
          let d = 0;
          let end = k + 3;
          for (; end < tokens.length; end++) {
            const p = tokens[end]!;
            if (p.type !== "punct") continue;
            if (p.value === "{" || p.value === "(" || p.value === "[") d++;
            else if (p.value === "}" || p.value === ")" || p.value === "]") {
              d--;
              if (d === 0) break;
            }
          }
          wrapper = { name: t.value, until: end, depth };
        }
      }
    }
    this.esmInterop();
    this.settleExports();
  }

  /**
   * esbuild's ES-module interop in a CommonJS bundle:
   *
   *   var TIMER_PREFIX, Channel;                        // declared without a value at the top,
   *   var init_channels = __esm({ "…"() { TIMER_PREFIX = "timer:"; Channel = {…}; } });  // set once
   *   __export(ipc_exports, { Channel: () => Channel }); // the module's namespace
   *   var { Channel: Channel2 } = (init_ipc(), __toCommonJS(ipc_exports));  // another module's import
   *
   * A name declared bare and assigned exactly once becomes a constant, and a name destructured
   * from a namespace object means the name the namespace hands out.
   */
  private esmInterop(): void {
    const tokens = this.tokens;
    // `var A, B;` at depth 0
    const bare = new Set<string>();
    let depth = 0;
    for (let k = 0; k < tokens.length; k++) {
      const t = tokens[k]!;
      if (t.type === "punct") {
        if (t.value === "{" || t.value === "(" || t.value === "[") depth++;
        else if (t.value === "}" || t.value === ")" || t.value === "]") depth--;
        continue;
      }
      if (depth !== 0 || t.type !== "ident" || t.value !== "var") continue;
      let j = k + 1;
      const names: string[] = [];
      while (
        is(tokens[j], "ident") &&
        (is(tokens[j + 1], "punct", ",") || is(tokens[j + 1], "punct", ";"))
      ) {
        names.push(tokens[j]!.value);
        if (is(tokens[j + 1], "punct", ";")) break;
        j += 2;
      }
      if (is(tokens[j + 1], "punct", ";")) for (const n of names) bare.add(n);
    }
    if (!bare.size) return;
    // their assignments: exactly one each, never declared again
    const assignments = new Map<string, number[]>();
    for (let k = 1; k + 1 < tokens.length; k++) {
      const t = tokens[k]!;
      if (t.type !== "ident" || !bare.has(t.value) || is(tokens[k - 1], "punct", ".")) continue;
      if (!is(tokens[k + 1], "punct", "=") || is(tokens[k + 2], "punct", "=")) continue;
      const before = tokens[k - 1];
      if (is(before, "ident") && /^(const|let|var)$/.test(before!.value)) continue;
      const list = assignments.get(t.value) ?? [];
      list.push(k + 2);
      assignments.set(t.value, list);
    }
    const single = [...assignments].filter(([, at]) => at.length === 1);
    const settle = (name: string, at: number): boolean => {
      // declared with a value somewhere as well: ambiguous, left alone
      if (this.strings.has(name) || this.tables.has(name)) return true;
      const value = tokens[at];
      const frozen =
        is(value, "ident", "Object") &&
        is(tokens[at + 1], "punct", ".") &&
        is(tokens[at + 2], "ident", "freeze") &&
        is(tokens[at + 3], "punct", "(") &&
        is(tokens[at + 4], "punct", "{")
          ? at + 4
          : -1;
      const literal = text(value);
      if (literal !== null && !is(tokens[at + 1], "punct", "+")) this.strings.set(name, literal);
      else if (is(value, "punct", "{") || frozen !== -1) {
        const table = this.object(frozen !== -1 ? frozen : at);
        if (!table.size) return false;
        this.tables.set(name, table);
      } else if (
        is(value, "ident") &&
        is(tokens[at + 1], "punct", ".") &&
        is(tokens[at + 2], "ident") &&
        this.tables.get(value!.value)?.has(tokens[at + 2]!.value)
      )
        // `ConfigSync = Channel.ConfigGetSync`, once Channel is known
        this.strings.set(name, this.tables.get(value!.value)!.get(tokens[at + 2]!.value)!);
      else return false;
      this.reassigned.delete(name);
      return true;
    };
    // values first, then names that read another one's key
    const left = single.filter(([name, [at]]) => !settle(name, at!));
    for (const [name, [at]] of left) settle(name, at!);
    // `__export(ns, { KEY: () => LOCAL, … })`: what a namespace object hands out
    const namespaces = new Map<string, Map<string, string>>();
    for (let k = 0; k + 4 < tokens.length; k++) {
      if (
        !is(tokens[k], "ident") ||
        !is(tokens[k + 1], "punct", "(") ||
        !is(tokens[k + 2], "ident") ||
        !is(tokens[k + 3], "punct", ",") ||
        !is(tokens[k + 4], "punct", "{")
      )
        continue;
      const entries = new Map<string, string>();
      let j = k + 5;
      while (
        is(tokens[j], "ident") &&
        is(tokens[j + 1], "punct", ":") &&
        is(tokens[j + 2], "punct", "(") &&
        is(tokens[j + 3], "punct", ")") &&
        is(tokens[j + 4], "punct", "=>") &&
        is(tokens[j + 5], "ident")
      ) {
        entries.set(tokens[j]!.value, tokens[j + 5]!.value);
        j += 6;
        if (is(tokens[j], "punct", ",")) j++;
      }
      if (entries.size && is(tokens[j], "punct", "}"))
        namespaces.set(tokens[k + 2]!.value, entries);
    }
    if (!namespaces.size) return;
    // `var { KEY: LOCAL2 } = (init_x(), __toCommonJS(ns))` or `= __toCommonJS(ns)`
    for (let k = 0; k + 2 < tokens.length; k++) {
      if (!is(tokens[k], "ident") || !/^(const|let|var)$/.test(tokens[k]!.value)) continue;
      if (!is(tokens[k + 1], "punct", "{")) continue;
      let close = k + 2;
      while (close < tokens.length && close < k + 400 && !is(tokens[close], "punct", "}")) close++;
      if (!is(tokens[close + 1], "punct", "=")) continue;
      // the namespace: the last identifier inside `__toCommonJS( … )` of the initializer
      let ns: string | null = null;
      for (let j = close + 2; j < close + 16 && j + 2 < tokens.length; j++)
        if (
          is(tokens[j], "punct", "(") &&
          is(tokens[j + 1], "ident") &&
          is(tokens[j + 2], "punct", ")") &&
          namespaces.has(tokens[j + 1]!.value)
        )
          ns = tokens[j + 1]!.value;
      const entries = ns ? namespaces.get(ns)! : null;
      if (!entries) continue;
      for (let j = k + 2; j < close; j++) {
        if (!is(tokens[j], "ident")) continue;
        const renamed = is(tokens[j + 1], "punct", ":") && is(tokens[j + 2], "ident");
        const local = renamed ? tokens[j + 2]!.value : tokens[j]!.value;
        const source = entries.get(tokens[j]!.value);
        if (source !== undefined && source !== local) {
          const value = this.reassigned.has(source) ? undefined : this.strings.get(source);
          if (value) this.strings.set(local, value);
          const table = this.tables.get(source);
          if (table) this.tables.set(local, table);
          const members = this.enums.get(source);
          if (members) this.enums.set(local, members);
        }
        if (renamed) j += 2;
      }
    }
  }

  /** `KEY: X.Y`, `KEY: NAME` and shorthand `NAME` entries of the exported object at `open`. */
  private collectExportNames(open: number): void {
    const tokens = this.tokens;
    let d = 0;
    for (let k = open; k < tokens.length && k < open + 4000; k++) {
      const t = tokens[k]!;
      if (t.type === "punct") {
        if (t.value === "{" || t.value === "(" || t.value === "[") d++;
        else if (t.value === "}" || t.value === ")" || t.value === "]") {
          d--;
          if (d === 0) break;
        }
        continue;
      }
      if (d !== 1 || !(is(tokens[k - 1], "punct", "{") || is(tokens[k - 1], "punct", ",")))
        continue;
      const key = t.type === "ident" ? t.value : text(t);
      if (key === null) continue;
      if (is(tokens[k + 1], "punct", ":") && is(tokens[k + 2], "ident"))
        this.exportNames.push({ key, at: k + 2 });
      else if (
        t.type === "ident" &&
        (is(tokens[k + 1], "punct", ",") || is(tokens[k + 1], "punct", "}"))
      )
        this.exportNames.push({ key, at: k });
    }
  }

  /** `export { A, B as C } [from "x"]` at `open`. */
  private esmExportList(open: number): void {
    const tokens = this.tokens;
    let close = open + 1;
    while (close < tokens.length && close < open + 400 && !is(tokens[close], "punct", "}")) close++;
    const specifier = is(tokens[close + 1], "ident", "from") ? text(tokens[close + 2]) : null;
    for (let k = open + 1; k < close; k++) {
      const name = tokens[k]!;
      if (name.type !== "ident") continue;
      const renamed = is(tokens[k + 1], "ident", "as") && is(tokens[k + 2], "ident");
      const key = renamed ? tokens[k + 2]!.value : name.value;
      if (specifier !== null) this.reexported[key] = { specifier, property: name.value };
      else this.exportNames.push({ key, at: k });
      if (renamed) k += 2;
    }
  }

  /** Settles export entries that name something: a constant here, or a name of another module. */
  private settleExports(): void {
    const tokens = this.tokens;
    // `export var Push;` followed by the enum's definition, as tsc compiles an exported enum
    for (let k = 0; k + 3 < tokens.length; k++) {
      if (
        !is(tokens[k], "ident", "export") ||
        !is(tokens[k + 1], "ident") ||
        !/^(var|let)$/.test(tokens[k + 1]!.value) ||
        !is(tokens[k + 2], "ident") ||
        !is(tokens[k + 3], "punct", ";")
      )
        continue;
      const name = tokens[k + 2]!.value;
      for (const [key, v] of this.enums.get(name) ?? []) this.exported[`${name}.${key}`] = v;
    }
    // `(E || (exports.E = E = {}))`, as tsc compiles an exported enum to CommonJS
    for (const [name, exportKey] of this.enumExports)
      for (const [key, v] of this.enums.get(name) ?? []) this.exported[`${exportKey}.${key}`] = v;
    for (const { key, at } of this.exportNames) {
      if (key in this.exported) continue;
      const name = tokens[at]!.value;
      const member =
        is(tokens[at + 1], "punct", ".") && is(tokens[at + 2], "ident")
          ? tokens[at + 2]!.value
          : null;
      const end = tokens[at + (member === null ? 1 : 3)];
      if (
        end &&
        !is(end, "punct", ",") &&
        !is(end, "punct", "}") &&
        !is(end, "punct", ";") &&
        end.line === tokens[at]!.line
      ) {
        // `exports.B = make(…)`, `{ B: Object.fromEntries(…) }`: read by an evaluation
        if (is(end, "punct", "(") || is(tokens[at + 1], "punct", "."))
          this.exportCalls.push({ key, at });
        continue;
      }
      if (member === null) {
        const value = this.reassigned.has(name) ? null : this.strings.get(name);
        if (value) this.exported[key] = value;
        else if (this.imported.has(name)) this.reexported[key] = this.imported.get(name)!;
        else if (this.tables.has(name) && !this.reassigned.has(name))
          for (const [entry, v] of this.tables.get(name)!) this.exported[`${key}.${entry}`] = v;
        else this.exportRequests.push({ key, name });
        continue;
      }
      const local = this.tables.get(name)?.get(member);
      if (local !== undefined) this.exported[key] = local;
      else if (this.requires.has(name))
        this.reexported[key] = { specifier: this.requires.get(name)!, property: member };
      else if (this.imported.has(name)) {
        const table = this.imported.get(name)!;
        this.reexported[key] = {
          specifier: table.specifier,
          property: `${table.property}.${member}`,
        };
      }
    }
  }

  /** Every name this file declares a constant, a table or an import under. */
  names(): string[] {
    return [
      ...this.strings.keys(),
      ...this.tables.keys(),
      ...this.tableKeys.keys(),
      ...this.pairLists.keys(),
      ...this.requires.keys(),
      ...this.imported.keys(),
      ...[...this.computedAt].filter(([, at]) => at !== null).map(([name]) => name),
    ];
  }

  /**
   * Lets the file's names whose value only an evaluation reads be read through `evaluator`, and
   * settles the exports of such names. Called once, right after construction.
   */
  useEvaluator(evaluator: Evaluator): void {
    this.evaluator = evaluator;
    this.computedCache.clear();
    const put = (key: string, flat: Flat): void => {
      const entries: Array<[string, string]> = [...flat.table].map(([sub, v]) => [
        `${key}.${sub}`,
        v,
      ]);
      if (flat.value !== null) entries.push([key, flat.value]);
      for (const [full, v] of entries) {
        if (full in this.exported) continue;
        this.exported[full] = v;
        this.evaluated.push(full);
      }
    };
    for (const { key, name } of this.exportRequests) {
      if (!this.computedAt.get(name)) continue;
      const found = this.computed(name);
      if (found) put(key, found);
      else if (this.computedReasons.has(name))
        this.unevaluated[key] = this.computedReasons.get(name)!;
    }
    for (const { key, at } of this.exportCalls) {
      const { value, reason } = evaluator.at(at);
      const flat = flatten(value);
      if (flat.table.size || flat.value !== null) put(key, flat);
      else if (reason) this.unevaluated[key] = reason;
    }
    if (this.wholeExportCall >= 0) {
      const flat = flatten(evaluator.at(this.wholeExportCall).value);
      for (const [key, v] of flat.table)
        if (!(key in this.exported)) {
          this.exported[key] = v;
          this.evaluated.push(key);
        }
    }
  }

  /** The table or string an evaluation reads for a computed top-level name; cached. */
  private computed(name: string): (Flat & { line: number }) | null {
    const cached = this.computedCache.get(name);
    if (cached !== undefined) return cached;
    const at = this.computedAt.get(name);
    let out: (Flat & { line: number }) | null = null;
    if (
      this.evaluator &&
      at !== undefined &&
      at !== null &&
      !this.reassigned.has(name) &&
      !this.strings.has(name) &&
      !this.tables.has(name)
    ) {
      const { value, reason } = this.evaluator.name(name, at);
      const flat = flatten(value);
      if (flat.table.size || flat.value !== null) out = { ...flat, line: this.tokens[at]!.line };
      else if (reason) this.computedReasons.set(name, reason);
    }
    this.computedCache.set(name, out);
    return out;
  }

  private sees(k: number | undefined, name: string): boolean {
    return k === undefined || this.visible === null || this.visible.get(k) === name;
  }

  /** Makes a constant or a table of this file known to other modules. */
  private export(name: string): void {
    const value = this.strings.get(name);
    if (value) this.exported[name] = value;
    for (const [key, v] of this.tables.get(name) ?? []) this.exported[`${name}.${key}`] = v;
    if (!value && !this.tables.has(name)) this.exportRequests.push({ key: name, name });
  }

  /** A destructuring pattern at `open`, if it takes names from another module. */
  private bindings(open: number): void {
    const tokens = this.tokens;
    let close = open + 1;
    while (close < tokens.length && close < open + 400 && !is(tokens[close], "punct", "}")) {
      if (is(tokens[close], "punct", "{")) return;
      close++;
    }
    // `} from "x"` or `} = require("x")`
    const specifier = is(tokens[close + 1], "ident", "from")
      ? text(tokens[close + 2])
      : is(tokens[close + 1], "punct", "=") &&
          is(tokens[close + 2], "ident", "require") &&
          is(tokens[close + 3], "punct", "(")
        ? text(tokens[close + 4])
        : null;
    // `var { Library } = require_channels()`: the names a bundler's module wrapper exports
    const wrapperCall =
      is(tokens[close + 1], "punct", "=") &&
      is(tokens[close + 2], "ident") &&
      is(tokens[close + 3], "punct", "(") &&
      is(tokens[close + 4], "punct", ")")
        ? tokens[close + 2]!.value
        : null;
    if (specifier === null && wrapperCall !== null) {
      const strings = this.wrapperStrings.get(wrapperCall);
      const tables = this.wrapperTables.get(wrapperCall);
      if (!strings && !tables) return;
      for (let k = open + 1; k < close; k++) {
        const name = tokens[k]!;
        if (name.type !== "ident") continue;
        const renamed = is(tokens[k + 1], "punct", ":") && is(tokens[k + 2], "ident");
        const local = renamed ? tokens[k + 2]!.value : name.value;
        const table = tables?.get(name.value);
        const value = strings?.get(name.value);
        if (table && !this.tables.has(local)) this.tables.set(local, table);
        else if (value !== undefined) {
          // The same name for the same text (the wrapper's own `var KEY = "…"`) is no ambiguity.
          const known = this.strings.get(local);
          this.strings.set(local, known === undefined || known === value ? value : null);
        }
        if (renamed) k += 2;
      }
      return;
    }
    if (specifier === null) return;
    for (let k = open + 1; k < close; k++) {
      const name = tokens[k]!;
      if (name.type !== "ident") continue;
      const renamed =
        (is(tokens[k + 1], "ident", "as") || is(tokens[k + 1], "punct", ":")) &&
        is(tokens[k + 2], "ident");
      this.imported.set(renamed ? tokens[k + 2]!.value : name.value, {
        specifier,
        property: name.value,
      });
      if (renamed) k += 2;
    }
  }

  /** Where the value of a name imported from another module is to be looked up. */
  importOf(name: string, k?: number): { specifier: string; property: string } | null {
    return this.sees(k, name) ? (this.imported.get(name) ?? null) : null;
  }

  /** The module a name was bound to with `const NAME = require("…")`, as used at token k. */
  requireOf(name: string, k?: number): string | null {
    return this.sees(k, name) ? (this.requires.get(name) ?? null) : null;
  }

  /** A string constant of this file, as used at token k. */
  stringOf(name: string, k?: number): string | null {
    return this.sees(k, name) && !this.reassigned.has(name)
      ? (this.strings.get(name) ?? null)
      : null;
  }

  /** The string value of `NAME.PROPERTY` in a table of this file, as used at token k. */
  memberOf(name: string, property: string, k?: number): string | null {
    if (k !== undefined && this.scopedEnums.size) {
      const scoped = this.scopedMember(name, property, k);
      if (scoped !== null) return scoped;
    }
    if (
      !this.sees(k, name) ||
      this.reassigned.has(name) ||
      this.reassigned.has(`${name}.${property}`)
    )
      return null;
    return this.tables.get(name)?.get(property) ?? null;
  }

  /**
   * The first element of every pair in `const T = [[a, f], …]` or `new Map([[a, f], …])`, each
   * resolved as an argument would be (null where it is not a literal or a constant). Empty when
   * `name` is no such list here, or a list that is not made of pairs only.
   */
  pairFirsts(name: string, k?: number): Resolved[] {
    const open = this.sees(k, name) ? (this.pairLists.get(name) ?? -1) : -1;
    if (open < 0 || this.reassigned.has(name)) return [];
    const tokens = this.tokens;
    const out: Resolved[] = [];
    let d = 0;
    for (let j = open; j < tokens.length && j < open + 20_000; j++) {
      const t = tokens[j]!;
      if (t.type !== "punct") {
        if (d === 1) return []; // an element that is not a pair
        continue;
      }
      if (t.value === "{" || t.value === "(" || t.value === "[") {
        d++;
        if (d === 2 && t.value === "[") {
          if (out.length >= 1000) return out;
          out.push(this.resolve(j + 1));
        } else if (d === 2) return [];
      } else if (t.value === "}" || t.value === ")" || t.value === "]") {
        d--;
        if (d === 0) return out;
      }
    }
    return [];
  }

  /** The property names of an object literal declared under this name. */
  keysOf(name: string, k?: number): string[] {
    return this.sees(k, name) ? (this.tableKeys.get(name) ?? []) : [];
  }

  /** `key: "text"` pairs at the top level of the object literal that opens at `open`. */
  private object(open: number, depth = 0): Map<string, string> {
    const table = new Map<string, string>();
    const tokens = this.tokens;
    let d = 0;
    for (let k = open; k < tokens.length && k < open + 4000; k++) {
      const t = tokens[k]!;
      if (t.type === "punct") {
        if (t.value === "{" || t.value === "(" || t.value === "[") d++;
        else if (t.value === "}" || t.value === ")" || t.value === "]") {
          d--;
          if (d === 0) break;
        }
        continue;
      }
      if (d !== 1 || !is(tokens[k + 1], "punct", ":")) continue;
      const key = t.type === "ident" ? t.value : text(t);
      // a nested group: `settings: { get: "settings:get" }` is the entry `settings.get`
      if (key !== null && is(tokens[k + 2], "punct", "{") && depth < 3) {
        for (const [inner, v] of this.object(k + 2, depth + 1)) table.set(`${key}.${inner}`, v);
        continue;
      }
      const v = text(tokens[k + 2]);
      const after = tokens[k + 3];
      if (key !== null && v !== null && (is(after, "punct", ",") || is(after, "punct", "}")))
        table.set(key, v);
    }
    return table;
  }

  /**
   * Property names at the top level of the object literal that opens at `open`: those written
   * with a value (`key: …`, `key() {…}`), or with `shorthand` those written as a bare name.
   */
  /** Wrappers whose exports are spread into the object literal at `open`, in order. */
  private spreadWrappers(open: number): string[] {
    const tokens = this.tokens;
    const out: string[] = [];
    let d = 0;
    for (let k = open; k < tokens.length && k < open + 4000; k++) {
      const t = tokens[k]!;
      if (t.type !== "punct") continue;
      if (t.value === "{" || t.value === "(" || t.value === "[") d++;
      else if (t.value === "}" || t.value === ")" || t.value === "]") {
        d--;
        if (d === 0) break;
      } else if (d === 1 && t.value === "..." && is(tokens[k + 1], "ident")) {
        const name = tokens[k + 1]!.value;
        if (is(tokens[k + 2], "punct", "(") && is(tokens[k + 3], "punct", ")")) {
          if (this.wrapperStrings.has(name)) out.push(name);
        } else {
          const held = this.wrapperOf.get(name);
          if (held) out.push(held);
        }
      }
    }
    return out;
  }

  /** Static string fields of the class body that opens at or after token `from`. */
  private staticTable(from: number): Map<string, string> {
    const tokens = this.tokens;
    let open = from;
    while (open < tokens.length && open < from + 50 && !is(tokens[open], "punct", "{")) open++;
    const table = new Map<string, string>();
    let d = 0;
    for (let j = open; j < tokens.length && j < open + 20_000; j++) {
      const p = tokens[j]!;
      if (p.type === "punct") {
        if (p.value === "{" || p.value === "(" || p.value === "[") d++;
        else if (p.value === "}" || p.value === ")" || p.value === "]") {
          d--;
          if (d === 0) break;
        }
        continue;
      }
      if (d !== 1 || p.value !== "static" || !is(tokens[j + 1], "ident")) continue;
      if (!is(tokens[j + 2], "punct", "=")) continue;
      const v = text(tokens[j + 3]);
      const end = tokens[j + 4];
      if (v !== null && (!end || is(end, "punct", ";") || is(end, "punct", "}")))
        table.set(tokens[j + 1]!.value, v);
    }
    return table;
  }

  /** `key: name` entries at the top level of the object literal that opens at `open`. */
  private namedEntries(open: number): Array<[string, string]> {
    const tokens = this.tokens;
    const out: Array<[string, string]> = [];
    let d = 0;
    for (let k = open; k < tokens.length && k < open + 4000; k++) {
      const t = tokens[k]!;
      if (t.type === "punct") {
        if (t.value === "{" || t.value === "(" || t.value === "[") d++;
        else if (t.value === "}" || t.value === ")" || t.value === "]") {
          d--;
          if (d === 0) break;
        }
        continue;
      }
      if (d !== 1 || !(is(tokens[k - 1], "punct", "{") || is(tokens[k - 1], "punct", ",")))
        continue;
      const key = t.type === "ident" ? t.value : text(t);
      if (key === null) continue;
      if (is(tokens[k + 1], "punct", ":") && is(tokens[k + 2], "ident")) {
        const after = tokens[k + 3];
        if (is(after, "punct", ",") || is(after, "punct", "}"))
          out.push([key, tokens[k + 2]!.value]);
      } else if (is(tokens[k + 1], "punct", ",") || is(tokens[k + 1], "punct", "}"))
        out.push([key, key]);
    }
    return out;
  }

  /**
   * `module.exports = { ...channels, ...require("./endpoints") }` with `channels` required from a
   * module: everything that module exports is exported here too, like `export * from`.
   */
  private spreadExports(open: number): void {
    const tokens = this.tokens;
    let d = 0;
    for (let k = open; k < tokens.length && k < open + 4000; k++) {
      const t = tokens[k]!;
      if (t.type !== "punct") continue;
      if (t.value === "{" || t.value === "(" || t.value === "[") d++;
      else if (t.value === "}" || t.value === ")" || t.value === "]") {
        d--;
        if (d === 0) break;
      } else if (d === 1 && t.value === "...") {
        const name = tokens[k + 1];
        const end = (at: number): boolean =>
          is(tokens[at], "punct", ",") || is(tokens[at], "punct", "}");
        let specifier: string | null = null;
        if (is(name, "ident", "require") && is(tokens[k + 2], "punct", "(") && end(k + 5))
          specifier = text(tokens[k + 3]);
        else if (is(name, "ident") && end(k + 2))
          specifier = this.requires.get(name!.value) ?? null;
        if (specifier !== null && !this.starExports.includes(specifier))
          this.starExports.push(specifier);
      }
    }
  }

  private keys(open: number, shorthand = false): string[] {
    const tokens = this.tokens;
    const out: string[] = [];
    let d = 0;
    for (let k = open; k < tokens.length && k < open + 4000; k++) {
      const t = tokens[k]!;
      if (t.type === "punct") {
        if (t.value === "{" || t.value === "(" || t.value === "[") d++;
        else if (t.value === "}" || t.value === ")" || t.value === "]") {
          d--;
          if (d === 0) break;
        }
        continue;
      }
      if (d !== 1) continue;
      const start = is(tokens[k - 1], "punct", "{") || is(tokens[k - 1], "punct", ",");
      const key = t.type === "ident" ? t.value : text(t);
      if (!start || key === null) continue;
      const follows = tokens[k + 1];
      const wanted = shorthand
        ? is(follows, "punct", ",") || is(follows, "punct", "}")
        : is(follows, "punct", ":") || is(follows, "punct", "(");
      if (wanted) out.push(key);
    }
    return out;
  }

  /** The string the argument at token k stands for: a literal, a constant, or a table entry. */
  /**
   * `resolve` for an argument, also when it is a template around one name: `${PREFIX}tick` with
   * PREFIX a constant here (the whole channel) or of another module (a reference with the text
   * around it).
   */
  resolveArg(k: number): Resolved {
    const tokens = this.tokens;
    const head = tokens[k];
    if (head?.type !== "template" || !head.value.endsWith("${…}")) return this.resolve(k);
    const before = head.value.slice(0, -"${…}".length);
    let end = k + 2;
    while (is(tokens[end], "punct", ".") && is(tokens[end + 1], "ident")) end += 2;
    const tail = tokens[end];
    if (
      before.includes("${…}") ||
      tail?.type !== "template" ||
      tail.value.includes("${…}") ||
      !(is(tokens[end + 1], "punct", ",") || is(tokens[end + 1], "punct", ")"))
    )
      return null;
    const inner = this.resolve(k + 1, end);
    if (inner === null) return null;
    return "value" in inner
      ? {
          value: `${before}${inner.value}${tail.value}`,
          via: inner.via === "evaluated" ? "evaluated" : "constant",
          ...(inner.line === undefined ? {} : { line: inner.line }),
        }
      : { ref: { ...inner.ref, before, after: tail.value } };
  }

  resolve(k: number, endAt?: number): Resolved {
    const tokens = this.tokens;
    /** The token after the name: `,` or `)` of an argument list, or the given end. */
    const closes = (j: number): boolean =>
      endAt !== undefined
        ? j === endAt
        : is(tokens[j], "punct", ",") || is(tokens[j], "punct", ")");
    const t = tokens[k];
    const literal = text(t);
    if (literal !== null) return { value: literal, via: "literal" };
    const member = this.enumMember(k);
    if (member !== null) return { value: member, via: "constant" };
    if (!t || t.type !== "ident" || !this.sees(k, t.value)) return null;
    const next = tokens[k + 1];
    if (is(next, "punct", ".") && is(tokens[k + 2], "ident")) {
      // `T.KEY`, or a nested group `T.group.KEY`
      let last = k + 2;
      while (is(tokens[last + 1], "punct", ".") && is(tokens[last + 2], "ident") && last < k + 8)
        last += 2;
      if (!closes(last + 1)) return null;
      const parts: string[] = [];
      for (let j = k + 2; j <= last; j += 2) parts.push(tokens[j]!.value);
      const property = parts.join(".");
      if (this.reassigned.has(t.value) || this.reassigned.has(`${t.value}.${property}`))
        return null;
      const value = this.tables.get(t.value)?.get(property);
      if (value !== undefined) return { value, via: "constant" };
      const computed = this.computed(t.value);
      const read = computed?.table.get(property);
      if (read !== undefined) return { value: read, via: "evaluated", line: computed!.line };
      const specifier = this.requires.get(t.value);
      if (specifier) return { ref: { specifier, property } };
      // a table imported by name: `const { CHANNELS } = require("./names")`, then CHANNELS.SAVE
      const table = this.imported.get(t.value);
      return table
        ? { ref: { specifier: table.specifier, property: `${table.property}.${property}` } }
        : null;
    }
    if (!closes(k + 1)) return null;
    if (this.reassigned.has(t.value)) return null;
    const value = this.strings.get(t.value);
    if (value) return { value, via: "constant" };
    const computed = this.computed(t.value);
    if (computed?.value) return { value: computed.value, via: "evaluated", line: computed.line };
    const ref = this.imported.get(t.value);
    return ref ? { ref } : null;
  }
}
