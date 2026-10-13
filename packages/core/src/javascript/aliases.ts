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
}

/**
 * For every identifier that is another name for one of `targets`, the index of the token and the
 * name it stands for. An identifier that is itself a target and is not hidden maps to itself.
 */
export function resolveAliases(tokens: Token[], targets: ReadonlySet<string>): Map<number, string> {
  const out = new Map<number, string>();
  const stack: Scope[] = [{ names: new Set(), aliases: new Map(), depth: 0, expression: false }];
  let depth = 0;
  // Deeper nesting than any real program has: beyond it no further scope is opened and its
  // names are declared in the enclosing one, which can only hide an alias, never invent one.
  const MAX_SCOPES = 5000;
  /** Parameter names waiting for the brace that opens their function body. */
  let pending: { names: Set<string>; at: number } | null = null;
  const top = (): Scope => stack[stack.length - 1]!;
  /**
   * Per name, the live declarations from outermost to innermost: what the name means in each
   * scope that declares it (null: an ordinary local). The innermost one decides, so a lookup
   * costs the same however deeply the code is nested.
   */
  const live = new Map<string, Array<string | null>>();
  const declare = (scope: Scope, name: string, alias: string | null): void => {
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
  const open = (names: Set<string>, expression: boolean): void => {
    const scope: Scope = { names: new Set(), aliases: new Map(), depth, expression };
    if (stack.length >= MAX_SCOPES) {
      for (const name of names) if (!targets.has(name)) declare(top(), name, null);
      return;
    }
    stack.push(scope);
    for (const name of names) if (!targets.has(name)) declare(scope, name, null);
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
    return targets.has(name) ? name : null;
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
      } else if (t.type === "ident") names.add(t.value);
    }
    return { names, end: k };
  };

  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k]!;
    if (t.type === "punct") {
      const v = t.value;
      if (v === "{" || v === "(" || v === "[") {
        if (v === "{") {
          open(pending && pending.at === k ? pending.names : new Set(), false);
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
            pending = { names: idents(from).names, at: k + 1 };
        }
      } else if (v === "=>") {
        const before = tokens[k - 1];
        let names = new Set<string>();
        if (is(before, "ident")) names.add(before!.value);
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
        if (is(tokens[k + 1], "punct", "{")) pending = { names, at: k + 1 };
        else open(names, true);
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
        if (!targets.has(tokens[at]!.value)) declare(top(), tokens[at]!.value, null);
        at++;
      }
      if (is(tokens[at], "punct", "(")) {
        const params = idents(at);
        if (is(tokens[params.end + 1], "punct", "{"))
          pending = { names: params.names, at: params.end + 1 };
      }
      continue;
    }
    if (t.value === "const" || t.value === "let" || t.value === "var") {
      // One declaration list: `a = 1, { b: c } = d, e`. Every identifier in a binding position
      // is declared; aliases are recognised by what stands on the right.
      let d = 0;
      for (let j = k + 1; j < tokens.length && j < k + 2000; j++) {
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
              const target = direct ?? member;
              if (target) declare(top(), name!.value, target);
            }
            let e = 0;
            for (j++; j < tokens.length; j++) {
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
          const bound = tokens[j + 2];
          if (targets.has(u.value) && is(bound, "ident")) {
            declare(top(), bound!.value, u.value);
            j += 2;
          }
          continue;
        }
        // A target's own name is never recorded as an ordinary local: `const { ipcRenderer } =
        // require("electron")` declares exactly the object that is looked for.
        if (!top().aliases.has(u.value) && !targets.has(u.value)) declare(top(), u.value, null);
      }
      continue;
    }
    // `import { ipcMain as bus } from "electron"`
    if (t.value === "as" && is(prev, "ident") && targets.has(prev!.value) && is(next, "ident")) {
      declare(top(), next!.value, prev!.value);
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
  /** `module.exports = { K: "v" }`, `exports.K = "v"`, `export const K = "v"` of this file. */
  readonly exported: Record<string, string> = {};

  constructor(private readonly tokens: Token[]) {
    const wrappers = new Map<string, Map<string, string>>();
    /** A bundler's module wrapper being read: `var W = helper({ "file.js"(exports, module) {`. */
    let wrapper: { name: string; until: number } | null = null;
    for (let k = 0; k < tokens.length; k++) {
      if (wrapper && k > wrapper.until) wrapper = null;
      const t = tokens[k]!;
      if (t.type !== "ident") continue;
      const eq = is(tokens[k + 1], "punct", "=");
      const value = tokens[k + 2];
      if (
        eq &&
        is(tokens[k - 1], "punct", ".") &&
        t.value === "exports" &&
        is(value, "punct", "{")
      ) {
        // `module.exports = { … }` or, in a wrapper, `<param>.exports = { … }`
        const table = this.object(k + 2);
        if (wrapper) wrappers.set(wrapper.name, table);
        else for (const [key, v] of table) this.exported[key] = v;
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
        if (declared && is(tokens[k - 2], "ident", "export")) this.exported[t.value] = literal;
      } else if (is(value, "punct", "{")) {
        const table = this.object(k + 2);
        if (table.size) this.tables.set(t.value, table);
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
          wrapper = { name: t.value, until: end };
        }
      }
    }
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

  /** The string the argument at token k stands for: a literal, a constant, or a table entry. */
  resolve(k: number): Resolved {
    const tokens = this.tokens;
    const t = tokens[k];
    const literal = text(t);
    if (literal !== null) return { value: literal, via: "literal" };
    if (!t || t.type !== "ident") return null;
    const next = tokens[k + 1];
    if (is(next, "punct", ".") && is(tokens[k + 2], "ident")) {
      const end = tokens[k + 3];
      if (!is(end, "punct", ",") && !is(end, "punct", ")")) return null;
      const property = tokens[k + 2]!.value;
      const value = this.tables.get(t.value)?.get(property);
      if (value !== undefined) return { value, via: "constant" };
      const specifier = this.requires.get(t.value);
      return specifier ? { ref: { specifier, property } } : null;
    }
    if (!is(next, "punct", ",") && !is(next, "punct", ")")) return null;
    const value = this.strings.get(t.value);
    return value ? { value, via: "constant" } : null;
  }
}
