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
import type { Token } from "./scan.js";

const is = (t: Token | undefined, type: Token["type"], value?: string): boolean =>
  !!t && t.type === type && (value === undefined || t.value === value);
const text = (t: Token | undefined): string | null =>
  t && (t.type === "string" || (t.type === "template" && !t.value.includes("${"))) ? t.value : null;

interface Scope {
  names: Set<string>;
  aliases: Map<string, string>;
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
  const stack: Scope[] = [
    { names: new Set(), aliases: new Map(), depth: 0, expression: false, fn: true },
  ];
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
  for (let round = 0; round < 4; round++) {
    const added = new Set<string>();
    const add = (name: string): void => {
      // `bound` and not `tracked` decides: one of the file's own names (an import) is tracked
      // from the start and may still be the first link of a chain.
      if (!bound.has(name)) added.add(name);
      bound.add(name);
      tracked.add(name);
    };
    for (let k = 0; k < tokens.length; k++) {
      const t = tokens[k]!;
      if (t.type !== "ident" || !sources.has(t.value)) continue;
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
  const declare = (scope: Scope, name: string, alias: string | null): void => {
    if (!tracked.has(name)) return;
    const had = scope.aliases.has(name) || scope.names.has(name);
    if (alias) {
      scope.names.delete(name);
      scope.aliases.set(name, alias);
    } else scope.names.add(name);
    const entries = live.get(name);
    // Declarations are only ever added to the innermost scope, so the last entry is this scope's.
    if (had && entries?.length) entries[entries.length - 1] = alias;
    else if (entries) entries.push(alias);
    else live.set(name, [alias]);
  };
  /** The top-level declaration of one of the file's own names is the name itself, not a local. */
  const ownHere = (name: string): boolean => own.has(name) && stack.length === 1;
  const open = (names: Set<string>, expression: boolean, fn: boolean): void => {
    const scope: Scope = { names: new Set(), aliases: new Map(), depth, expression, fn };
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
    for (const name of [...scope.names, ...scope.aliases.keys()]) {
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
            pending && pending.at === k ? pending.names : new Set(),
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
    if (t.type !== "ident") continue;
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
        if (!top().aliases.has(u.value) && !targets.has(u.value) && !ownHere(u.value))
          put(u.value, null);
      }
      continue;
    }
    // `import { ipcMain as bus } from "electron"`: the name belongs to the scope around the
    // import's braces, not to the braces.
    if (t.value === "as" && is(prev, "ident") && targets.has(prev!.value) && is(next, "ident")) {
      const outer =
        stack.length > 1 && top().depth === depth - 1 ? stack[stack.length - 2]! : top();
      outer.aliases.set(next!.value, prev!.value);
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
  | { value: string; via: "literal" | "constant" }
  | { ref: { specifier: string; property: string } }
  | null;

/** String constants and tables of string constants declared in one file. */
export class Constants {
  private readonly strings = new Map<string, string | null>();
  private readonly tables = new Map<string, Map<string, string>>();
  private readonly requires = new Map<string, string>();
  /** `import { A as B } from "x"` and `const { A: B } = require("x")`: B is A of module x. */
  private readonly imported = new Map<string, { specifier: string; property: string }>();
  private readonly tableKeys = new Map<string, string[]>();
  /**
   * What other modules can refer to: `module.exports = { K: "v" }`, `exports.K = "v"`,
   * `export const K = "v"`, and for an exported table of strings one entry per `TABLE.KEY`.
   */
  readonly exported: Record<string, string> = {};
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
      }
      if (parameter.length > 2) names.add(parameter);
      spans.push([k, argumentsEnd]);
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
      const announced =
        is(next, "punct", "=") &&
        is(tokens[k + 2], "ident", "void") &&
        tokens[k + 3]?.value === "0";
      const rebound =
        (is(next, "punct", "=") && !is(tokens[k + 2], "punct", "=") && !announced) ||
        (!property &&
          !is(next, "punct", ".") &&
          !is(next, "punct", ";") &&
          !(next && next.line !== t.line) &&
          (is(next, "punct", ",") ||
            is(next, "punct", ")") ||
            is(next, "punct", "}") ||
            is(next, "punct", ":")));
      if (rebound) this.enums.set(t.value, null);
    }
  }

  /**
   * The value of `Enum.MEMBER` or `anything.Enum.MEMBER` used as an argument at token `k`.
   * The object in front of the enum name is whatever the module was imported as and is not
   * looked at: the enum name and the member decide.
   */
  private enumMember(k: number): string | null {
    const tokens = this.tokens;
    if (!this.enums.size || tokens[k]?.type !== "ident") return null;
    const chain = [tokens[k]!.value];
    let at = k + 1;
    while (chain.length < 3 && is(tokens[at], "punct", ".") && is(tokens[at + 1], "ident")) {
      chain.push(tokens[at + 1]!.value);
      at += 2;
    }
    if (chain.length < 2 || (!is(tokens[at], "punct", ",") && !is(tokens[at], "punct", ")")))
      return null;
    const [name, member] = chain.slice(-2) as [string, string];
    return this.enums.get(name)?.get(member) ?? null;
  }

  constructor(private readonly tokens: Token[]) {
    this.readEnums();
    const wrappers = new Map<string, Map<string, string>>();
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
      if (
        (t.value === "import" || /^(const|let|var)$/.test(t.value)) &&
        is(tokens[k + 1], "punct", "{")
      )
        this.bindings(k + 1);
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
        if (wrapper) wrappers.set(wrapper.name, table);
        else {
          for (const [key, v] of table) this.exported[key] = v;
          // `module.exports = { CHANNELS, API_ROOT }`: this file's own constants, by name
          for (const key of this.keys(at, true)) this.export(key);
        }
        continue;
      }
      if (
        t.value === "exports" &&
        is(tokens[k + 1], "punct", ".") &&
        is(tokens[k + 2], "ident") &&
        is(tokens[k + 3], "punct", "=")
      ) {
        const v = text(tokens[k + 4]);
        if (v !== null && !wrapper) this.exported[tokens[k + 2]!.value] = v;
        continue;
      }
      if (!eq || is(tokens[k - 1], "punct", ".")) continue;
      const declared = is(tokens[k - 1], "ident") && /^(const|let|var)$/.test(tokens[k - 1]!.value);
      const listed = is(tokens[k - 1], "punct", ",");
      if (!declared && !listed) continue;
      const exportedHere = declared && is(tokens[k - 2], "ident", "export");
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
  }

  /** Every name this file declares a constant, a table or an import under. */
  names(): string[] {
    return [
      ...this.strings.keys(),
      ...this.tables.keys(),
      ...this.tableKeys.keys(),
      ...this.requires.keys(),
      ...this.imported.keys(),
    ];
  }

  private sees(k: number | undefined, name: string): boolean {
    return k === undefined || this.visible === null || this.visible.get(k) === name;
  }

  /** Makes a constant or a table of this file known to other modules. */
  private export(name: string): void {
    const value = this.strings.get(name);
    if (value) this.exported[name] = value;
    for (const [key, v] of this.tables.get(name) ?? []) this.exported[`${name}.${key}`] = v;
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

  /** A string constant of this file, as used at token k. */
  stringOf(name: string, k?: number): string | null {
    return this.sees(k, name) && !this.reassigned.has(name)
      ? (this.strings.get(name) ?? null)
      : null;
  }

  /** The property names of an object literal declared under this name. */
  keysOf(name: string, k?: number): string[] {
    return this.sees(k, name) ? (this.tableKeys.get(name) ?? []) : [];
  }

  /** `key: "text"` pairs at the top level of the object literal that opens at `open`. */
  private object(open: number): Map<string, string> {
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
  resolve(k: number): Resolved {
    const tokens = this.tokens;
    const t = tokens[k];
    const literal = text(t);
    if (literal !== null) return { value: literal, via: "literal" };
    const member = this.enumMember(k);
    if (member !== null) return { value: member, via: "constant" };
    if (!t || t.type !== "ident" || !this.sees(k, t.value)) return null;
    const next = tokens[k + 1];
    if (is(next, "punct", ".") && is(tokens[k + 2], "ident")) {
      const end = tokens[k + 3];
      if (!is(end, "punct", ",") && !is(end, "punct", ")")) return null;
      const property = tokens[k + 2]!.value;
      if (this.reassigned.has(t.value) || this.reassigned.has(`${t.value}.${property}`))
        return null;
      const value = this.tables.get(t.value)?.get(property);
      if (value !== undefined) return { value, via: "constant" };
      const specifier = this.requires.get(t.value);
      if (specifier) return { ref: { specifier, property } };
      // a table imported by name: `const { CHANNELS } = require("./names")`, then CHANNELS.SAVE
      const table = this.imported.get(t.value);
      return table
        ? { ref: { specifier: table.specifier, property: `${table.property}.${property}` } }
        : null;
    }
    if (!is(next, "punct", ",") && !is(next, "punct", ")")) return null;
    if (this.reassigned.has(t.value)) return null;
    const value = this.strings.get(t.value);
    if (value) return { value, via: "constant" };
    const ref = this.imported.get(t.value);
    return ref ? { ref } : null;
  }
}
