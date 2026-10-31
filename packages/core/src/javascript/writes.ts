/**
 * What counts as a write, on the token stream: one definition for every reader that has to know
 * whether a name or a member keeps the value it was declared with (issue #198).
 *
 * A name is written by an assignment of any kind (`=` and every compound assignment, `+=` to
 * `??=`), by `++` and `--` before or after it, as a target of an array or object pattern
 * (`[CH] = …`, `({ CH } = …)`, `({ k: CH } = …)`, at any depth), and as the head of
 * `for (CH of …)` / `for (CH in …)`. Its own declaration (`const|let|var CH = …`, also in a list
 * `var a = 1, CH = 2` and in a declaration pattern `const { CH } = …`), a parameter default
 * (`function f(CH = 1)`) and a class field (`class A { CH = 1 }`) are no writes of it.
 *
 * A member is written the same ways through a chain of members and elements from a name:
 * `T.A += …`, `T["A"]++`, `[T.A] = …`, `for (T.A of …)`, `delete T.A`.
 *
 * The bracket structure and the declaration lists of a token array are read in one pass and kept
 * for the array, so each question afterwards costs a few token looks.
 */
import type { Token } from "./scan.js";

/** `=` and the compound assignments: what `/^([-+*\/%&|^]|\*\*|<<|>>>?|&&|\|\||\?\?)?=$/` matches. */
export const ASSIGNMENT_OPERATORS: ReadonlySet<string> = new Set([
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

/** The token is `=` or a compound assignment. */
export const assignmentAt = (tokens: readonly Token[], k: number): boolean => {
  const t = tokens[k];
  return t !== undefined && t.type === "punct" && ASSIGNMENT_OPERATORS.has(t.value);
};

/** The token is `++` or `--`. */
export const stepAt = (tokens: readonly Token[], k: number): boolean => {
  const t = tokens[k];
  return t !== undefined && t.type === "punct" && (t.value === "++" || t.value === "--");
};

const punct = (tokens: readonly Token[], k: number, value: string): boolean => {
  const t = tokens[k];
  return t !== undefined && t.type === "punct" && t.value === value;
};
const ident = (tokens: readonly Token[], k: number, value?: string): boolean => {
  const t = tokens[k];
  return t !== undefined && t.type === "ident" && (value === undefined || t.value === value);
};

const DECLARES = /^(const|let|var)$/;
/** Words after which no expression ends: a line break after one continues the statement. */
const OPERATOR_WORDS = new Set([
  "in",
  "of",
  "instanceof",
  "typeof",
  "void",
  "delete",
  "new",
  "await",
  "yield",
  "return",
  "throw",
  "case",
]);
/** Words before `(` that open no parameter list (`if (…) {`). */
const CONTROL_WORDS =
  /^(if|while|for|switch|catch|with|return|typeof|void|delete|await|yield|in|of)$/;

/** Bracket structure and declaration lists of one token array. */
interface Shape {
  /** The matching bracket of each bracket token; -1 for every other token and an unmatched one. */
  match: Int32Array;
  /** The innermost open bracket around each token; -1 at the top. */
  parent: Int32Array;
  /** Bit 1: a name declared by `const|let|var` (also in a list); bit 2: a declaration pattern's opener. */
  flags: Uint8Array;
  /** The names each scope declares, built when first asked (see `shadowedAt`). */
  scopes: Map<number, Set<string>> | null;
  /** The parameter names of each function body, by its `{`, as they are asked for. */
  params: Map<number, ReadonlySet<string>>;
  /** `shadowedAt` answers by the bracket around the write and the name. */
  shadowed: Map<string, boolean>;
}

const DECLARED = 1;
const DECLARED_PATTERN = 2;

const shapes = new WeakMap<readonly Token[], Shape>();

/** A token after which an expression may have ended, so a line break there may end a statement. */
const ends = (t: Token): boolean =>
  t.type === "string" ||
  t.type === "number" ||
  t.type === "regex" ||
  (t.type === "ident" && !OPERATOR_WORDS.has(t.value) && !DECLARES.test(t.value)) ||
  (t.type === "punct" && (t.value === ")" || t.value === "]" || t.value === "}"));
/** Words that join two expressions: a line break before one continues the statement. */
const BINARY_WORDS = new Set(["in", "of", "instanceof"]);
/**
 * A token that starts a new statement after a line break that ended one: no binary operator.
 * `return`, `throw`, `await`, `typeof` and the like cannot continue an expression that ended.
 */
const starts = (t: Token): boolean =>
  t.type === "string" ||
  t.type === "number" ||
  (t.type === "ident" && !BINARY_WORDS.has(t.value)) ||
  (t.type === "punct" && (t.value === "++" || t.value === "--"));

function shapeOf(tokens: readonly Token[]): Shape {
  const known = shapes.get(tokens);
  if (known) return known;
  const n = tokens.length;
  const match = new Int32Array(n).fill(-1);
  const parent = new Int32Array(n).fill(-1);
  const flags = new Uint8Array(n);
  const stack: number[] = [];
  /**
   * Per bracket depth: 0 outside a declaration list, 1 where the next token is a declared name
   * or pattern (after `const|let|var` or a `,` of the list), 2 inside the list elsewhere.
   */
  const state: number[] = [0];
  for (let i = 0; i < n; i++) {
    const t = tokens[i]!;
    const d = stack.length;
    parent[i] = d ? stack[d - 1]! : -1;
    const prev = tokens[i - 1];
    // a line break that ends the statement (no `;` written) ends the declaration list too
    if (state[d] === 2 && prev && prev.line < t.line && ends(prev) && starts(t)) state[d] = 0;
    if (t.type === "punct") {
      const v = t.value;
      if (v === "(" || v === "[" || v === "{") {
        if (state[d] === 1) {
          if (v !== "(") flags[i] = flags[i]! | DECLARED_PATTERN;
          state[d] = 2;
        }
        stack.push(i);
        state[d + 1] = 0;
        continue;
      }
      if (v === ")" || v === "]" || v === "}") {
        const open = stack.pop();
        if (open !== undefined) {
          match[open] = i;
          match[i] = open;
          parent[i] = parent[open]!;
        }
        state[d] = 0;
        continue;
      }
      if (state[d] !== 0) {
        if (v === ",") state[d] = 1;
        else if (v === ";") state[d] = 0;
        else if (state[d] === 1) state[d] = 0;
      }
      continue;
    }
    if (t.type === "ident" && !punct(tokens, i - 1, ".") && !punct(tokens, i - 1, "?.")) {
      if (DECLARES.test(t.value) && !(state[d] === 1)) {
        state[d] = 1;
        continue;
      }
      if (state[d] === 1) {
        flags[i] = flags[i]! | DECLARED;
        state[d] = 2;
        continue;
      }
    }
    if (state[d] === 1) state[d] = 0;
  }
  const shape: Shape = {
    match,
    parent,
    flags,
    scopes: null,
    params: new Map(),
    shadowed: new Map(),
  };
  shapes.set(tokens, shape);
  return shape;
}

/** Ancestors looked at for a function or block around a write (`shadowedAt`). */
const MAX_ANCESTORS = 64;

/**
 * The write of NAME at k is to another binding than the one declared at the top of the file
 * (false when there is none there): k lies in a
 * function whose parameters name it (`function f(d) { d++ }`, `d => { d++ }`), or in a block or
 * function that declares it with `const|let|var` (`function f() { let d = 0; … d++ }`, as
 * minifiers reuse short names). Only what is certain counts: an arrow function with an
 * expression body, a pattern parameter or a `catch` binding is not looked into, and the write
 * then counts as one of the top-level name.
 */
export function shadowedAt(tokens: readonly Token[], k: number, name: string): boolean {
  const shape = shapeOf(tokens);
  const { parent } = shape;
  const scopes = (shape.scopes ??= scopesOf(tokens, shape));
  // only a name declared at the top of the file is told from its locals: a constant declared in
  // a function (a bundler's module wrapper) counts every write of the name
  if (!scopes.get(-1)?.has(name)) return false;
  // the answer depends only on the bracket around k: kept per bracket and name
  const key = `${parent[k]}\u0000${name}`;
  const known = shape.shadowed.get(key);
  if (known !== undefined) return known;
  let found = false;
  for (let open = parent[k]!, g = 0; open >= 0 && g < MAX_ANCESTORS; g++, open = parent[open]!) {
    // `let`/`const` of the block, `var` of the function body, the head of `for (let …) { … }`
    if (
      scopes.get(open)?.has(name) ||
      (punct(tokens, open, "{") && paramsOf(tokens, shape, open).has(name))
    ) {
      found = true;
      break;
    }
  }
  shape.shadowed.set(key, found);
  return found;
}

const NO_NAMES: ReadonlySet<string> = new Set();

/**
 * The names the parameters of the function whose body opens at `open` bind directly:
 * `d => { … }`, `(a, d) => { … }`, `function (d) { … }`, `m(d) { … }`; none for any other brace,
 * and none past MAX_PARAMS tokens. Kept per body, so each list is read once.
 */
function paramsOf(tokens: readonly Token[], shape: Shape, open: number): ReadonlySet<string> {
  const known = shape.params.get(open);
  if (known) return known;
  const { match, parent } = shape;
  let names = NO_NAMES;
  if (punct(tokens, open - 1, "=>") && ident(tokens, open - 2))
    names = new Set([tokens[open - 2]!.value]);
  else {
    const close = open - (punct(tokens, open - 1, "=>") ? 2 : 1);
    const params = punct(tokens, close, ")") ? match[close]! : -1;
    const head =
      params >= 0 && (paramsAt(tokens, params, close) || ident(tokens, params - 1, "catch"));
    if (head && close - params <= MAX_PARAMS) {
      const found = new Set<string>();
      for (let p = params + 1; p < close; p++)
        if (
          ident(tokens, p) &&
          parent[p] === params &&
          (punct(tokens, p - 1, "(") || punct(tokens, p - 1, ",") || punct(tokens, p - 1, "...")) &&
          (punct(tokens, p + 1, ",") || punct(tokens, p + 1, ")") || punct(tokens, p + 1, "="))
        )
          found.add(tokens[p]!.value);
      if (found.size) names = found;
    }
  }
  shape.params.set(open, names);
  return names;
}

/** Tokens of a parameter list looked through for a parameter (`shadowedAt`); longer: not read. */
const MAX_PARAMS = 256;

/**
 * The names each scope declares with `const|let|var`, by the token that opens it (-1: the top of
 * the file): a block for `let`/`const`, the function body for `var`, and both the head and the
 * braced body of `for (let …)`.
 */
function scopesOf(tokens: readonly Token[], shape: Shape): Map<number, Set<string>> {
  const { match, parent, flags } = shape;
  const scopes = new Map<number, Set<string>>();
  const add = (open: number, name: string): void => {
    const set = scopes.get(open);
    if (set) set.add(name);
    else scopes.set(open, new Set([name]));
  };
  for (let d = 0; d < tokens.length; d++) {
    // the names a declaration pattern binds (`const { a: T } = o`), with the pattern's keyword
    if ((flags[d]! & DECLARED_PATTERN) !== 0) {
      const close = match[d]!;
      const word = tokens[d - 1];
      const isVar = word?.type === "ident" && word.value === "var";
      let scope = parent[d]!;
      if (scope >= 0 && isVar) scope = varScope(tokens, shape, scope);
      if (scope === UNKNOWN_SCOPE || close < 0 || close - d > MAX_PARAMS) continue;
      if (scope >= 0 && punct(tokens, scope, "(")) continue;
      for (let p = d + 1; p < close; p++)
        if (ident(tokens, p) && bindingAt(tokens, p)) add(scope, tokens[p]!.value);
      continue;
    }
    if ((flags[d]! & DECLARED) === 0) continue;
    const name = tokens[d]!.value;
    let scope = parent[d]!;
    if (scope < 0) {
      add(-1, name);
      continue;
    }
    if (punct(tokens, scope, "(")) {
      add(scope, name);
      const body = match[scope]! + 1;
      if (punct(tokens, body, "{")) add(body, name);
      continue;
    }
    if (ident(tokens, d - 1, "var")) {
      // up to the function body around it; at the top of the file it is the file's. Past a
      // brace that may be a function body not recognized as one (`[k]() {`, `static {`, a class
      // body) it is not registered anywhere: its writes then count for the top-level name.
      scope = varScope(tokens, shape, scope);
      if (scope === UNKNOWN_SCOPE) continue;
    }
    add(scope, name);
  }
  return scopes;
}

const UNKNOWN_SCOPE = -2;

/**
 * The scope a `var` inside the bracket `scope` belongs to: the function body around it, -1 for
 * the top of the file, UNKNOWN_SCOPE past a brace that may be a function's or a class's body
 * without being recognized as one, or past MAX_ANCESTORS brackets.
 */
function varScope(tokens: readonly Token[], shape: Shape, scope: number): number {
  const { parent } = shape;
  for (let g = 0; g < MAX_ANCESTORS; g++) {
    if (scope < 0) return -1;
    if (functionBody(tokens, scope)) return scope;
    if (punct(tokens, scope, "{") && uncertainBody(tokens, scope)) return UNKNOWN_SCOPE;
    scope = parent[scope]!;
  }
  return UNKNOWN_SCOPE;
}

/**
 * A brace that is no plain block or object, and no function body `functionBody` recognizes:
 * after `)` (an unrecognized head), `static {`, a class body.
 */
function uncertainBody(tokens: readonly Token[], open: number): boolean {
  if (ident(tokens, open - 1, "static") || classBodyAt(tokens, open)) return true;
  if (!punct(tokens, open - 1, ")")) return false;
  // the block of `if (…)`, `while (…)`, `for (…)`, `switch (…)`, `with (…)`, `catch (…)`
  const head = shapeOf(tokens).match[open - 1]!;
  return !(head > 0 && /^(if|while|for|switch|with|catch)$/.test(tokens[head - 1]?.value ?? ""));
}

/**
 * `if (x) { var CH = "b" }` at the top of the file: a `var` with a value inside a block (no
 * function) declares the top-level name again, which assigns it.
 */
function redeclaresVar(tokens: readonly Token[], j: number): boolean {
  const shape = shapeOf(tokens);
  if (!ident(tokens, j - 1, "var") || !punct(tokens, j + 1, "=")) return false;
  const scope = shape.parent[j]!;
  return scope >= 0 && varScope(tokens, shape, scope) === -1;
}

/** The brace at `open` is the body of a function: `(…) {`, `(…) => {`, `x => {`. */
function functionBody(tokens: readonly Token[], open: number): boolean {
  if (!punct(tokens, open, "{")) return false;
  if (punct(tokens, open - 1, "=>")) return true;
  if (!punct(tokens, open - 1, ")")) return false;
  const params = shapeOf(tokens).match[open - 1]!;
  return params >= 0 && paramsAt(tokens, params, open - 1);
}

/** The bracket that matches the one at k, or -1. */
export const closeOf = (tokens: readonly Token[], k: number): number =>
  shapeOf(tokens).match[k] ?? -1;

/** Whether the parenthesis at `open` is a parameter list: `(…) =>`, `function f(…)`, `m(…) {`. */
function paramsAt(tokens: readonly Token[], open: number, close: number): boolean {
  if (punct(tokens, close + 1, "=>")) return true;
  if (ident(tokens, open - 1, "function")) return true;
  if (ident(tokens, open - 1) && ident(tokens, open - 2, "function")) return true;
  // a method (`save(a = 1) { … }`, `[k]() { … }`, `"x.js"(exports, module) { … }`), not a
  // control statement (`if (…) {`); its brace on the line of the `)`: a call followed by a
  // block on the next line (`foo(CH = 1)⏎{ }`) is no method
  if (!punct(tokens, close + 1, "{") || tokens[close + 1]!.line !== tokens[close]!.line)
    return false;
  const before = tokens[open - 1];
  if (!before) return false;
  if (before.type === "ident") return !CONTROL_WORDS.test(before.value);
  return before.type === "string" || before.type === "number" || punct(tokens, open - 1, "]");
}

/** Whether the brace at `open` is a class body: `class A {`, `class A extends B.C {`. */
function classBodyAt(tokens: readonly Token[], open: number): boolean {
  let k = open - 1;
  for (let guard = 0; guard < 16 && k >= 0; guard++, k--) {
    const t = tokens[k]!;
    if (t.type === "ident") {
      if (t.value === "class") return true;
      continue;
    }
    if (t.type === "punct" && t.value === ".") continue;
    return false;
  }
  return false;
}

/**
 * The target [from, to) (a name or a member chain) is an element of a pattern that is assigned
 * to: `[T] = …`, `({ T } = …)`, `({ k: T.A } = …)`, at any depth, or the head of a pattern of
 * `for (… of|in …)`. A declaration pattern (`const [T] = …`) and a parameter pattern are none.
 */
function patternTarget(tokens: readonly Token[], from: number, to: number): boolean {
  const { match, parent, flags } = shapeOf(tokens);
  let start = from;
  let end = to;
  for (let guard = 0; guard < 64; guard++) {
    const open = elementIn(tokens, start, end);
    if (open < 0) return false;
    const close = match[open]!;
    // the container: the outermost pattern, or an element of the one around it
    if ((flags[open]! & DECLARED_PATTERN) !== 0) return false;
    const outer = parent[open]!;
    const next = tokens[close + 1];
    const assigned = next?.type === "punct" && next.value === "=";
    const forHead =
      punct(tokens, open - 1, "(") &&
      (ident(tokens, open - 2, "for") ||
        (ident(tokens, open - 2, "await") && ident(tokens, open - 3, "for"))) &&
      (ident(tokens, close + 1, "of") || ident(tokens, close + 1, "in"));
    if (forHead) return true;
    if (assigned) {
      // a parameter default (`function f([a] = [])`) binds a parameter
      if (outer >= 0 && punct(tokens, outer, "(") && paramsAt(tokens, outer, match[outer]!))
        return false;
      // an element with a default inside a pattern (`[[a] = []] = …`): look further out
      if (elementOf(tokens, open, outer)) {
        start = open;
        end = close + 1;
        continue;
      }
      return true;
    }
    if (!elementOf(tokens, open, outer)) return false;
    start = open;
    end = close + 1;
  }
  // nested deeper than any real pattern: taken for a write, which loses a value, never invents one
  return true;
}

/**
 * The `[` or `{` around the target [from, to) when the target stands where an element of a
 * pattern would there (`[T]`, `{ T }`, `{ k: T }`, `{ ...T }`, with a default or not; `k`
 * itself is a key); -1 otherwise.
 */
function elementIn(tokens: readonly Token[], from: number, to: number): number {
  const { match, parent } = shapeOf(tokens);
  const open = parent[from]!;
  if (open < 0 || match[open]! < 0) return -1;
  const before = tokens[from - 1];
  const after = tokens[to];
  if (!before || !after || before.type !== "punct" || after.type !== "punct") return -1;
  if (punct(tokens, open, "[")) {
    // `T[k]`, `f()[0]`: an element read, no array pattern
    if (memberBracket(tokens, open)) return -1;
    if (!/^(\[|,|\.\.\.)$/.test(before.value) || !/^(,|\]|=)$/.test(after.value)) return -1;
  } else if (punct(tokens, open, "{")) {
    if (!/^(\{|,|:|\.\.\.)$/.test(before.value) || !/^(,|\}|=)$/.test(after.value)) return -1;
    if (before.value !== ":" && before.value !== "..." && to - from > 1) return -1;
  } else return -1;
  return open;
}

/**
 * The name at j is one a declaration's pattern binds, at any depth: `const { k: T = 1 } = …`,
 * `let [a, T = 2] = …`, `var { a: { T } } = …`, also after a `,` of a declarator list. A `=`
 * after it gives a default; it writes no other binding of the name.
 */
export function declaredPatternName(tokens: readonly Token[], j: number): boolean {
  const t = tokens[j];
  if (!t || t.type !== "ident" || punct(tokens, j - 1, ".") || punct(tokens, j - 1, "?."))
    return false;
  const { match, parent, flags } = shapeOf(tokens);
  let start = j;
  let end = j + 1;
  for (let guard = 0; guard < 64; guard++) {
    const open = elementIn(tokens, start, end);
    if (open < 0) return false;
    if ((flags[open]! & DECLARED_PATTERN) !== 0) return true;
    if (!elementOf(tokens, open, parent[open]!)) return false;
    start = open;
    end = match[open]! + 1;
  }
  return false;
}

/**
 * The name at j is a field of the class body around it, `class A { T = 1 }`, `static T = 1`
 * (not a name assigned in a field's value, `class A { a = T = 1 }`): no variable is written.
 */
export function classFieldAt(tokens: readonly Token[], j: number): boolean {
  if (!punct(tokens, j + 1, "=") || punct(tokens, j + 2, "=")) return false;
  const { parent } = shapeOf(tokens);
  const open = parent[j]!;
  if (open < 0 || !punct(tokens, open, "{") || !classBodyAt(tokens, open)) return false;
  const before = tokens[j - 1];
  if (!before) return false;
  if (before.type === "punct") return /^(\{|;|\})$/.test(before.value);
  // `static T = 1`, or a field after one that ended without `;`
  return (before.type === "ident" && before.value === "static") || before.line < tokens[j]!.line;
}

/** The bracket at `open` stands where an element of a pattern `outer` would: `[[a]]`, `{ k: [a] }`. */
function elementOf(tokens: readonly Token[], open: number, outer: number): boolean {
  if (outer < 0) return false;
  const before = tokens[open - 1];
  if (!before || before.type !== "punct") return false;
  if (punct(tokens, outer, "[")) return /^(\[|,|\.\.\.)$/.test(before.value);
  if (punct(tokens, outer, "{")) return before.value === ":" || before.value === "...";
  return false;
}

/**
 * The name at j (an identifier not after `.`) is written there: assigned with any operator,
 * stepped with `++`/`--`, a target of a pattern that is assigned, or the head of
 * `for (… of|in …)`. Its declaration, a parameter default and a class field are no writes.
 */
export function writesName(tokens: readonly Token[], j: number): boolean {
  const t = tokens[j];
  if (!t || t.type !== "ident") return false;
  // only these neighbours can start a write (every case below needs one): asked first, as most
  // names in a file are followed by `(`, `;` or an operator
  if (!stepAt(tokens, j - 1) && !NAME_WRITE_NEXT.has(nextShape(tokens, j))) return false;
  if (punct(tokens, j - 1, ".") || punct(tokens, j - 1, "?.")) return false;
  const { parent, match, flags } = shapeOf(tokens);
  if ((flags[j]! & DECLARED) !== 0) return redeclaresVar(tokens, j);
  // `(CH) += …`, `((CH))++`: the name in parentheses is the target
  const [from, to] = grouped(tokens, j, j + 1);
  if (to !== j + 1) {
    if (memberAt(tokens, to)) return false;
    return (
      assignmentAt(tokens, to) ||
      (stepAt(tokens, to) && tokens[to]!.line === tokens[to - 1]!.line) ||
      stepAt(tokens, from - 1) ||
      forHeadAt(tokens, from, to) ||
      patternTarget(tokens, from, to)
    );
  }
  const after = tokens[j + 1];
  if (stepAt(tokens, j - 1)) return true;
  if (after && after.type === "punct") {
    if ((after.value === "++" || after.value === "--") && after.line === t.line) return true;
    if (ASSIGNMENT_OPERATORS.has(after.value)) {
      if (after.value !== "=") return true;
      const open = parent[j]!;
      if (open >= 0 && punct(tokens, open, "(") && paramsAt(tokens, open, match[open]!))
        return !(punct(tokens, j - 1, "(") || punct(tokens, j - 1, ","));
      if (open >= 0 && punct(tokens, open, "{") && classBodyAt(tokens, open)) return false;
      if (open >= 0 && (punct(tokens, open, "{") || punct(tokens, open, "["))) {
        // a default in a pattern (`{ T = 1 } = …` writes T, `const { T = 1 } = …` declares it)
        if (
          /^(\{|,|\[|:|\.\.\.)$/.test(tokens[j - 1]?.value ?? "") &&
          tokens[j - 1]!.type === "punct"
        )
          return patternTarget(tokens, j, j + 1) || !inPattern(tokens, open);
      }
      return true;
    }
  }
  if (forHeadAt(tokens, j, j + 1)) return true;
  return patternTarget(tokens, j, j + 1);
}

/** The `[` at `open` follows an expression: it reads an element or a computed member. */
function memberBracket(tokens: readonly Token[], open: number): boolean {
  const before = tokens[open - 1];
  return before !== undefined && ends(before);
}

/** The bracket at `open` (`{` or `[`) is part of a pattern (declared or assigned). */
function inPattern(tokens: readonly Token[], open: number): boolean {
  const { match, parent, flags } = shapeOf(tokens);
  if (punct(tokens, open, "[") && memberBracket(tokens, open)) return false;
  for (let o = open, guard = 0; o >= 0 && guard < 64; guard++) {
    if ((flags[o]! & DECLARED_PATTERN) !== 0) return true;
    if (punct(tokens, match[o]! + 1, "=")) return true;
    const outer = parent[o]!;
    if (outer < 0 || !(punct(tokens, outer, "[") || punct(tokens, outer, "{"))) return false;
    o = outer;
  }
  return false;
}

/** `for (T of …)`, `for (T.A in …)`: the target [from, to) is the head of a loop, undeclared. */
function forHeadAt(tokens: readonly Token[], from: number, to: number): boolean {
  if (!punct(tokens, from - 1, "(")) return false;
  const loop =
    ident(tokens, from - 2, "for") ||
    (ident(tokens, from - 2, "await") && ident(tokens, from - 3, "for"));
  return loop && (ident(tokens, to, "of") || ident(tokens, to, "in"));
}

/**
 * The end (exclusive) of the chain of members and elements after the name at j: `T.a`, `T?.a`,
 * `T[k]`, `T.a[0].b`. j + 1 when there is none; a call ends the chain.
 */
export function chainEnd(tokens: readonly Token[], j: number): number {
  return chainFrom(tokens, j + 1);
}

/** The end of a chain of members and elements that starts at k (k itself when none does). */
function chainFrom(tokens: readonly Token[], from: number): number {
  const { match } = shapeOf(tokens);
  let k = from;
  for (let guard = 0; guard < 64; guard++) {
    if ((punct(tokens, k, ".") || punct(tokens, k, "?.")) && ident(tokens, k + 1)) k += 2;
    else if (punct(tokens, k, "?.") && punct(tokens, k + 1, "[") && match[k + 1]! > 0)
      k = match[k + 1]! + 1;
    else if (punct(tokens, k, "[") && match[k]! > 0) k = match[k]! + 1;
    else break;
  }
  return k;
}

/**
 * The member chain from the name at j is written (see the head of this file): what is written,
 * as the first member's key (`T.A.b = …` writes `A`; `T["A"]++` too), `*` when the key is not
 * written as a literal (`T[k] = …`), null when nothing of it is written there.
 */
export function writesMember(tokens: readonly Token[], j: number): string | null {
  // a chain or a parenthesis must follow the name
  if (!MEMBER_WRITE_NEXT.has(nextShape(tokens, j))) return null;
  if (punct(tokens, j - 1, ".") || punct(tokens, j - 1, "?.")) return null;
  // the chain, also through parentheses: `(T).A = …`, `(T.A) = …`, `((T).A).b++`
  let start = j;
  let end = chainEnd(tokens, j);
  let members = end !== j + 1;
  for (let guard = 0; guard < 16; guard++) {
    const [from, to] = grouped(tokens, start, end);
    if (to === end) break;
    start = from;
    end = chainFrom(tokens, to);
    if (end !== to) members = true;
  }
  if (!members) return null;
  const written =
    assignmentAt(tokens, end) ||
    (stepAt(tokens, end) && tokens[end]!.line === tokens[end - 1]!.line) ||
    stepAt(tokens, start - 1) ||
    ident(tokens, start - 1, "delete") ||
    forHeadAt(tokens, start, end) ||
    patternTarget(tokens, start, end);
  if (!written) return null;
  return firstKey(tokens, j);
}

/**
 * The token after j as the shape tables below read it: a punctuator's value, `of` / `in` for
 * those words, anything else as nothing a write can start with.
 */
const nextShape = (tokens: readonly Token[], j: number): string => {
  const t = tokens[j + 1];
  if (!t) return "";
  if (t.type === "punct") return t.value;
  return t.type === "ident" && (t.value === "of" || t.value === "in") ? t.value : "";
};
/** What may follow a name that is written: an operator, a step, a pattern's or group's end, a loop head. */
const NAME_WRITE_NEXT: ReadonlySet<string> = new Set([
  ...ASSIGNMENT_OPERATORS,
  "++",
  "--",
  ")",
  ",",
  "]",
  "}",
  "of",
  "in",
]);
/** What may follow a name whose member is written: a member, an element, a group's end. */
const MEMBER_WRITE_NEXT: ReadonlySet<string> = new Set([".", "?.", "[", ")"]);

/** A member or an element starts at k: `.a`, `?.a`, `[…]`. */
const memberAt = (tokens: readonly Token[], k: number): boolean =>
  punct(tokens, k, ".") || punct(tokens, k, "?.") || punct(tokens, k, "[");

/**
 * [from, to) widened over the parentheses that only group it: `(CH)`, `((T.A))`. A call's or a
 * control statement's parenthesis (`f(CH)`, `if (CH)`) is none.
 */
function grouped(tokens: readonly Token[], from: number, to: number): [number, number] {
  const { match } = shapeOf(tokens);
  for (let guard = 0; guard < 16; guard++) {
    if (!punct(tokens, to, ")") || match[to] !== from - 1) break;
    const before = tokens[from - 2];
    const call =
      before !== undefined &&
      ((before.type === "ident" && !OPERATOR_WORDS.has(before.value)) ||
        (before.type === "punct" && (before.value === ")" || before.value === "]")) ||
        before.type === "template");
    if (call) break;
    from--;
    to++;
  }
  return [from, to];
}

/** The key of the first member after the name at j: `T.A` and `T["A"]` give `A`, `T[k]` gives `*`. */
export function firstKey(tokens: readonly Token[], j: number): string {
  let k = j + 1;
  while (punct(tokens, k, ")")) k++;
  if (punct(tokens, k, "?.")) k++;
  if (punct(tokens, k, ".") && ident(tokens, k + 1)) return tokens[k + 1]!.value;
  if (ident(tokens, k) && punct(tokens, k - 1, "?.")) return tokens[k]!.value;
  if (punct(tokens, k, "[")) {
    const key = tokens[k + 1];
    if (key && (key.type === "string" || key.type === "number") && punct(tokens, k + 2, "]"))
      return key.value;
    if (key && key.type === "template" && !key.value.includes("${") && punct(tokens, k + 2, "]"))
      return key.value;
  }
  return "*";
}

/**
 * The name at j binds a name of its own there, so it is no use of another binding: a
 * declaration, a parameter (`function h(T)`, `(a, T) => a`, `T => …`), a `catch (T)` binding,
 * or an element of a pattern in a declaration or a parameter list (`const { a: T } = o`,
 * `function g({ T })`, `function h([T])`).
 */
export function bindingAt(tokens: readonly Token[], j: number): boolean {
  const { parent, match, flags } = shapeOf(tokens);
  if ((flags[j]! & DECLARED) !== 0) return true;
  if (!ident(tokens, j)) return false;
  if (punct(tokens, j + 1, "=>") && !punct(tokens, j - 1, ".")) return true;
  let from = j;
  let to = j + 1;
  for (let guard = 0; guard < 64; guard++) {
    const open = parent[from]!;
    if (open < 0) return false;
    const before = tokens[from - 1];
    const after = tokens[to];
    if (!before || !after || before.type !== "punct" || after.type !== "punct") return false;
    if (punct(tokens, open, "(")) {
      if (!/^(\(|,|\.\.\.)$/.test(before.value) || !/^(,|\)|=)$/.test(after.value)) return false;
      const close = match[open]!;
      return close >= 0 && (paramsAt(tokens, open, close) || ident(tokens, open - 1, "catch"));
    }
    if (punct(tokens, open, "[")) {
      if (memberBracket(tokens, open)) return false;
      if (!/^(\[|,|\.\.\.)$/.test(before.value) || !/^(,|\]|=)$/.test(after.value)) return false;
    } else if (punct(tokens, open, "{")) {
      if (!/^(\{|,|:|\.\.\.)$/.test(before.value) || !/^(,|\}|=)$/.test(after.value)) return false;
      if (before.value !== ":" && before.value !== "..." && to - from > 1) return false;
    } else return false;
    if ((flags[open]! & DECLARED_PATTERN) !== 0) return true;
    from = open;
    to = match[open]! + 1;
  }
  return false;
}

/**
 * The name at j is no use of a binding at all: a key of an object literal or pattern
 * (`{ T: 2 }`), a member of a class body (`class K { T = 1; static T() {} }`), a label
 * (`T: for (;;)`) or the label of `break T` / `continue T`.
 */
export function keyOrLabelAt(tokens: readonly Token[], j: number): boolean {
  const { parent } = shapeOf(tokens);
  const before = tokens[j - 1];
  if (ident(tokens, j - 1, "break") || ident(tokens, j - 1, "continue")) return true;
  if (punct(tokens, j + 1, ":")) {
    if (!before) return true;
    if (before.type === "punct" && /^(\{|,|;|\})$/.test(before.value)) return true;
    // a label on a line of its own
    if (before.line < tokens[j]!.line && ends(before)) return true;
  }
  const open = parent[j]!;
  if (open >= 0 && punct(tokens, open, "{") && classBodyAt(tokens, open)) {
    return (
      (before?.type === "punct" && /^(\{|;|\}|\*)$/.test(before.value)) ||
      (before?.type === "ident" && /^(static|get|set|async|accessor)$/.test(before.value))
    );
  }
  return false;
}

/** The name at j is the whole source of a destructuring: `const { A } = T`, `({ A } = T)`. */
export function patternSourceAt(tokens: readonly Token[], j: number): boolean {
  const { match, flags } = shapeOf(tokens);
  if (!punct(tokens, j - 1, "=")) return false;
  const close = j - 2;
  if (!(punct(tokens, close, "}") || punct(tokens, close, "]"))) return false;
  const open = match[close]!;
  if (open < 0) return false;
  const whole =
    /^(;|,|\)|\})$/.test(tokens[j + 1]?.value ?? ";") && tokens[j + 1]?.type !== "string";
  if (!whole) return false;
  return (flags[open]! & DECLARED_PATTERN) !== 0 || punct(tokens, open - 1, "(");
}

/** The token at k stands at the top of the file, inside no bracket. */
export const topLevelAt = (tokens: readonly Token[], k: number): boolean =>
  shapeOf(tokens).parent[k]! < 0;

const WRITERS = /^(assign|defineProperty|defineProperties|setPrototypeOf|set|deleteProperty)$/;

/**
 * The name at k (or the chain from it) is the target of a call that writes it:
 * `Object.assign(T, …)`, `Object.defineProperty(T.a, …)`, `Object.defineProperties(T, …)`,
 * `Object.setPrototypeOf(T, …)`, `Reflect.set(T, …)`, `Reflect.defineProperty(T, …)`,
 * `Reflect.deleteProperty(T, …)`, `Reflect.setPrototypeOf(T, …)`.
 */
export function writtenByCallAt(tokens: readonly Token[], k: number): boolean {
  if (!punct(tokens, k - 1, "(") || !ident(tokens, k - 2) || !WRITERS.test(tokens[k - 2]!.value))
    return false;
  if (!punct(tokens, k - 3, ".")) return false;
  const owner = tokens[k - 4];
  if (!owner || owner.type !== "ident" || !/^(Object|Reflect)$/.test(owner.value)) return false;
  if (owner.value === "Object" && tokens[k - 2]!.value === "set") return false;
  const end = chainEnd(tokens, k);
  return punct(tokens, end, ",") || punct(tokens, end, ")");
}

/** The name at k is declared there by `const|let|var`, also in a list (`var a = 1, k = 2`). */
export const declaredAt = (tokens: readonly Token[], k: number): boolean =>
  (shapeOf(tokens).flags[k]! & DECLARED) !== 0;
