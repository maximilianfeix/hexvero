/**
 * Three Electron security settings read from a file's tokens, each a collection of its own:
 *
 * - `openExternal`: calls of `shell.openExternal(url)`, with the receiver proven to be Electron's
 *   `shell` by scope and the URL argument read as a literal, inferred (its start, or one of a few
 *   known values) or unknown.
 * - `permissionHandlers`: `setPermissionRequestHandler` / `setPermissionCheckHandler` on a
 *   session, with whether the handler grants every request unconditionally.
 * - `csp` (header rows): a `Content-Security-Policy` header written in a response-header
 *   listener (`webRequest.onHeadersReceived`) or anywhere else in the code.
 *
 * `cspMetaRows` reads `<meta http-equiv="Content-Security-Policy">` from an HTML file. Nothing
 * is run; a comment or a string is never a call. See docs/electron-findings.md ("Links opened
 * outside the app", "Permission handlers", "Content Security Policy").
 */
import type { Constants } from "./aliases.js";
import type { ExpressionResolver, FnDef } from "./resolve.js";
import type { Token } from "./scan.js";
import { numericLiteral } from "./switches.js";

export interface OpenExternalRow {
  /**
   * `shell`: the receiver is Electron's shell by scope; `unknown`: a method of this name on a
   * receiver that is not read as it (a parameter, a property of something not read, a call).
   */
  targetKind: "shell" | "unknown";
  /** The receiver as written, shortened. */
  target: string;
  /**
   * `literal`: the URL is one string read whole; `inferred`: only its start (a template or a
   * concatenation that begins with a literal) or a short list of possible values is known;
   * `unknown`: nothing of it is read.
   */
  argumentKind: "literal" | "inferred" | "unknown";
  /** The URL (literal), its known start (inferred from a prefix), or null. */
  argument: string | null;
  /** For `inferred` from a list of possible values: those values (at most 8). */
  values?: string[];
  /** The URL scheme, lowercased without `:`, when the known part names one; else null. */
  scheme: string | null;
  evidence: string;
  file: string;
  line: number;
}

export interface PermissionHandlerRow {
  /** `request`: setPermissionRequestHandler; `check`: setPermissionCheckHandler. */
  kind: "request" | "check";
  /**
   * `session`: the receiver is a session of Electron's `session` module read by scope
   * (`session.defaultSession`, `session.fromPartition(…)`, a name bound to one);
   * `webContents`: `X.webContents.session`; `unknown`: any other receiver.
   */
  targetKind: "session" | "webContents" | "unknown";
  /** `default`, `partition:<name>`, `path:<path>`, or null when the session is not named. */
  session: string | null;
  /**
   * `always`: a grant (`callback(true)`, `return true`) stands unconditionally in the handler's
   * own body, or the handler is cleared with `null` (Electron then grants every request);
   * `conditional`: a literal grant behind a condition, after a return or in a nested function;
   * `computed`: the handler passes or returns a value that is not a literal (a check hexvero does
   * not evaluate), and no literal grant; `never`: every answer is a literal refusal, or there is
   * none; `unknown`: the handler is not a function literal written there, or its callback is
   * handed on, stored or behind a rest parameter.
   */
  grants: "always" | "conditional" | "computed" | "never" | "unknown";
  /** The receiver as written, shortened. */
  target: string;
  evidence: string;
  file: string;
  line: number;
}

export interface CspRow {
  /** `meta`: `<meta http-equiv>` in an HTML file; `header`: a response header written in code. */
  kind: "meta" | "header";
  /**
   * For `header`: `onHeadersReceived` when the header is written in a function passed to
   * `X.webRequest.onHeadersReceived(…)`; `other` when it is a header key anywhere else (a
   * `protocol.handle` response, a server of the app, a request): whether it reaches the app's
   * pages is not read.
   */
  via?: "onHeadersReceived" | "other";
  /** `Content-Security-Policy-Report-Only`: reported, not enforced. */
  reportOnly?: boolean;
  /**
   * Why a header may not apply although it stands in an `onHeadersReceived` listener: the
   * receiver is not read as a session, the key is behind a condition or in a nested function,
   * or a spread after it in the same object may replace it.
   */
  doubt?: string;
  /**
   * For `meta`: the tag stands after the document's head ended (`</head>`, `<body>`, another
   * element or text): browsers apply a `<meta>` policy only in `<head>`, so whether it applies is
   * unknown.
   */
  outsideHead?: boolean;
  /** The policy as written (several header values joined with `, `), or null when not read. */
  policy: string | null;
  /**
   * Weaknesses of the policy by the rules in docs/electron-findings.md; empty when none of them
   * applies; null when the policy is not read.
   */
  weaknesses: string[] | null;
  evidence: string;
  file: string;
  line: number;
}

const WORK = 2_000_000;
export const MAX_SECURITY_ROWS_PER_FILE = 200;
const INTEROP = new Set([
  "__toESM",
  "__importStar",
  "__importDefault",
  "_interopRequireWildcard",
  "_interopRequireDefault",
  "__toCommonJS",
]);
const CONDITIONS = new Set([
  "if",
  "else",
  "for",
  "while",
  "do",
  "switch",
  "case",
  "default",
  "try",
  "catch",
]);
const BRANCH = new Set(["&&", "||", "??", "?", ":", "?.", "&&=", "||=", "??="]);
const KEYWORDS = new Set([
  "if",
  "else",
  "return",
  "throw",
  "case",
  "default",
  "do",
  "try",
  "typeof",
  "void",
  "delete",
  "new",
  "in",
  "of",
  "instanceof",
  "await",
  "yield",
  "var",
  "let",
  "const",
]);
/** A token a statement can end with, for automatic semicolon insertion. */
const endsValue = (t: Token): boolean =>
  t.type === "string" ||
  t.type === "number" ||
  t.type === "template" ||
  t.type === "regex" ||
  (t.type === "ident" && !KEYWORDS.has(t.value)) ||
  (t.type === "punct" &&
    (t.value === ")" || t.value === "]" || t.value === "++" || t.value === "--"));
/** A token a new statement can start with after a line break (no `(`, `[` or template). */
const startsStatement = (t: Token): boolean =>
  t.type === "ident" || t.type === "string" || t.type === "number";
const GLOBALS = new Set(["window", "globalThis", "self"]);

export const short = (text: string): string => (text.length > 80 ? `${text.slice(0, 80)}…` : text);

/**
 * Keeps rows up to `max` so that the cap only ever drops rows `harmless` says are harmless: any
 * other row takes the place of the last harmless one kept. True when a row was dropped.
 */
export function keepRows<T>(
  kept: T[],
  incoming: readonly T[],
  max: number,
  harmless: (row: T) => boolean,
): boolean {
  let dropped = false;
  for (const row of incoming) {
    if (kept.length < max) {
      kept.push(row);
      continue;
    }
    dropped = true;
    if (harmless(row)) continue;
    const at = kept.findLastIndex(harmless);
    if (at < 0) continue;
    kept.splice(at, 1);
    kept.push(row);
  }
  return dropped;
}

/** An openExternal row the cap may drop: its URL is a literal. */
export const harmlessOpenExternal = (r: OpenExternalRow): boolean => r.argumentKind === "literal";
/** A permission handler row the cap may drop: one that never grants. */
export const harmlessPermission = (r: PermissionHandlerRow): boolean => r.grants === "never";
/** A CSP row the cap may drop: none (every policy decides whether one is missing or weak). */
export const harmlessCsp = (): boolean => false;

/**
 * Token helpers and the scope reading shared by the readers of one file: which names are
 * Electron's module and its members (`shell`, `session`). Every step is charged to one bounded
 * budget; past it nothing more is proven and `capped` is set.
 */
export class FileReader {
  work = WORK;
  capped = false;
  private readonly webpackElectron = new Set<string>();
  private readonly importedModule = new Set<string>();

  constructor(
    readonly tokens: Token[],
    readonly resolver: ExpressionResolver,
    readonly constants: Constants,
  ) {
    // webpack modules that are Electron itself: `91288(e){e.exports=require("electron")}`, and
    // namespace imports: `import * as X from "electron"`, `import X from "electron"`
    for (let j = 0; j < tokens.length; j++) {
      const t = tokens[j]!;
      if (t.type !== "string" || t.value !== "electron") continue;
      if (this.is(j - 1, "(") && this.ident(j - 2) === "require" && this.is(j + 1, ")")) {
        if (this.is(j - 3, "=") && this.ident(j - 4) === "exports" && this.dot(j - 5))
          for (let q = j - 6; q >= 0 && q > j - 30; q--)
            if (tokens[q]!.type === "number" && (this.is(q + 1, ":") || this.is(q + 1, "("))) {
              this.webpackElectron.add(tokens[q]!.value);
              break;
            }
      } else if (this.ident(j - 1) === "from") {
        const k = j - 2;
        if (this.ident(k) && this.ident(k - 1) === "as" && this.is(k - 2, "*"))
          this.importedModule.add(this.ident(k)!);
        else if (this.ident(k) && this.ident(k - 1) === "import")
          this.importedModule.add(this.ident(k)!);
      }
    }
  }

  spend(): boolean {
    if (--this.work >= 0) return true;
    this.capped = true;
    return false;
  }
  is(i: number, v: string): boolean {
    return this.tokens[i]?.type === "punct" && this.tokens[i]!.value === v;
  }
  ident(i: number): string | null {
    return this.tokens[i]?.type === "ident" ? this.tokens[i]!.value : null;
  }
  dot(i: number): boolean {
    return this.is(i, ".") || this.is(i, "?.");
  }
  /** At most 80 tokens joined, cut to 80 characters. */
  text(from: number, to: number): string {
    return short(
      this.tokens
        .slice(Math.max(0, from), Math.min(to, from + 80))
        .map((x) => (x.type === "string" ? JSON.stringify(x.value) : x.value))
        .join(""),
    );
  }
  /** [a, b) without trailing `;` or `,`. */
  trim(a: number, b: number): [number, number] {
    let y = b;
    while (y > a && (this.is(y - 1, ";") || this.is(y - 1, ","))) y--;
    return [a, y];
  }

  private readonly interop = new Map<string, boolean>();
  /**
   * The name at k is a bundler's interop helper: one of the known names, or (minified) a
   * function of the file whose first 400 tokens read `.__esModule` and name `default`, as
   * esbuild's `__toESM` and Babel's `_interopRequireDefault` do.
   */
  interopHelper(k: number): boolean {
    const name = this.ident(k);
    if (!name) return false;
    if (INTEROP.has(name)) return true;
    const known = this.interop.get(name);
    if (known !== undefined) return known;
    let range: [number, number] | null = null;
    if (this.spend()) {
      const bound = this.resolver.binding(k, name);
      if (bound?.kind === "value") range = bound.range;
      else if (bound?.kind === "function") range = [bound.def.paramsAt, bound.def.body[1]];
    }
    let esModule = false;
    let named = false;
    if (range)
      for (let j = range[0]; j < Math.min(range[1], range[0] + 400); j++) {
        if (!this.spend()) break;
        const t = this.tokens[j]!;
        if (t.type === "ident" && t.value === "__esModule" && this.dot(j - 1)) esModule = true;
        if ((t.type === "ident" || t.type === "string") && t.value === "default") named = true;
      }
    this.interop.set(name, esModule && named);
    return esModule && named;
  }

  /** The tokens [a, b) are an expression for the electron module. */
  moduleExpr(a: number, b0: number, depth = 0): boolean {
    let x = a;
    let [, y] = this.trim(a, b0);
    if (this.ident(x) && this.is(x + 1, "(") && this.interopHelper(x)) {
      const close = this.resolver.closeOf(x + 1);
      if (close !== y - 1) return false;
      x += 2;
      y = this.is(close - 2, ",") && this.tokens[close - 1]?.type === "number" ? close - 2 : close;
    }
    // `window.require("electron")` in a page with Node integration
    if (
      GLOBALS.has(this.ident(x) ?? "") &&
      this.dot(x + 1) &&
      this.ident(x + 2) === "require" &&
      this.resolver.binding(x, this.ident(x)!) === null
    )
      x += 2;
    if (
      this.ident(x) === "require" &&
      this.is(x + 1, "(") &&
      this.tokens[x + 2]?.type === "string" &&
      this.tokens[x + 2]!.value === "electron" &&
      this.is(x + 3, ")") &&
      x + 4 === y
    )
      return true;
    // webpack: `n(91288)` for a module id that is `require("electron")`
    if (
      this.ident(x) &&
      this.is(x + 1, "(") &&
      this.tokens[x + 2]?.type === "number" &&
      this.webpackElectron.has(this.tokens[x + 2]!.value) &&
      this.is(x + 3, ")") &&
      x + 4 === y
    )
      return true;
    // a lazy getter of it: `X()` with `X = n.cw(function (e) { e.exports = require("electron") })`
    if (this.ident(x) && x + 3 === y && depth < 3 && this.spend()) {
      const given = this.resolver.lazyValueAt(x);
      if (given) return this.moduleExpr(given[0], given[1], depth + 1);
    }
    if (this.ident(x) && x + 1 === y) return this.moduleName(x, depth + 1);
    return false;
  }

  /** The name at k is bound, by scope, to the electron module. */
  moduleName(k: number, depth = 0): boolean {
    const name = this.ident(k);
    if (!name || depth > 3 || !this.spend()) return false;
    if (this.resolver.boundAround(k, name)?.kind === "param") return false;
    if (this.constants.requireOf(name, k) === "electron") return true;
    const bound = this.resolver.binding(k, name, true);
    if (bound?.kind === "value") return this.moduleExpr(bound.range[0], bound.range[1], depth);
    return bound === null && this.importedModule.has(name);
  }

  /**
   * The name at k is Electron's `member` by scope: `const { shell } = require("electron")` (also
   * renamed), `import { shell } from "electron"`, `const s = electron.shell`.
   */
  memberName(k: number, member: string, depth = 0): boolean {
    const name = this.ident(k);
    if (!name || depth > 3 || !this.spend()) return false;
    if (this.resolver.boundAround(k, name)?.kind === "param") return false;
    const imported = this.constants.importOf(name, k);
    if (imported?.specifier === "electron" && imported.property === member) return true;
    const bound = this.resolver.binding(k, name, true);
    if (bound?.kind === "pattern")
      return bound.key === member && this.moduleExpr(bound.from[0], bound.from[1]);
    if (bound?.kind === "value") {
      const [a, b] = this.trim(bound.range[0], bound.range[1]);
      return this.memberExpr(a, b, member, depth + 1);
    }
    return false;
  }

  /** The tokens [a, b) are `X.member` (also `X.default.member`) with X the electron module. */
  memberExpr(a: number, b: number, member: string, depth = 0): boolean {
    if (this.ident(b - 1) !== member || !this.dot(b - 2)) return false;
    let end = b - 2;
    // `import_electron.default.shell`: esbuild's default import of the module through __toESM
    if (this.ident(end - 1) === "default" && this.dot(end - 2)) end -= 2;
    if (end === a + 1 && this.ident(a)) return this.moduleName(a, depth);
    return this.moduleExpr(a, end, depth);
  }

  /**
   * The receiver ending right before the `.` (or `[`) at d is Electron's `member`; its first
   * token, or -1.
   */
  memberBefore(d: number, member: string): number {
    if (!this.ident(d - 1)) return -1;
    if (!this.dot(d - 2)) return this.memberName(d - 1, member) ? d - 1 : -1;
    if (this.ident(d - 1) !== member) return -1;
    let end = d - 2;
    if (this.ident(end - 1) === "default" && this.dot(end - 2)) end -= 2;
    // `X.shell`
    if (this.ident(end - 1) && !this.dot(end - 2)) return this.moduleName(end - 1) ? end - 1 : -1;
    // `require("electron").shell`, `n(91288).shell`, `window.require("electron").shell`
    if (this.is(end - 1, ")")) {
      const open = this.resolver.openOf(end - 1);
      if (open <= 0 || !this.ident(open - 1)) return -1;
      let start = open - 1;
      if (this.dot(start - 1) && GLOBALS.has(this.ident(start - 2) ?? "") && !this.dot(start - 3))
        start -= 2;
      else if (this.dot(start - 1)) return -1;
      return this.moduleExpr(start, end) ? start : -1;
    }
    return -1;
  }

  /**
   * The end of the expression starting at a: the `,` or closing bracket at depth 0; -1 when it
   * is not found within 4,000 tokens or the budget runs out (then the expression is not read).
   */
  exprEnd(a: number, stopAtSemicolon = false): number {
    for (let j = a, d = 0; j < this.tokens.length && j < a + 4000; j++) {
      if (!this.spend()) return -1;
      const p = this.tokens[j]!;
      if (p.type !== "punct") continue;
      if (p.value === "(" || p.value === "[" || p.value === "{") d++;
      else if (p.value === ")" || p.value === "]" || p.value === "}") {
        if (d === 0) return j;
        d--;
      } else if (d === 0 && (p.value === "," || (stopAtSemicolon && p.value === ";"))) return j;
    }
    return -1;
  }

  /** A literal or constant string at [a, b), else null. */
  stringAt(a: number, b: number): string | null {
    const t = this.tokens[a];
    if (!t) return null;
    if (b === a + 1 && t.type === "string") return t.value;
    if (b === a + 1 && t.type === "template" && !t.value.includes("${")) return t.value;
    if (!this.spend()) return null;
    if (!this.namesOwnValues(a, b)) return null;
    const v = this.resolver.valueAt(a);
    if (v?.kind === "str" && v.values.length === 1 && this.exprEnd(a) === b) return v.values[0]!;
    return null;
  }

  /**
   * No name read in [a, b) is a parameter or a local of an enclosing function: the resolver may
   * take such a name for a constant of the same name at the top of the file, so its value is not
   * taken from there. Member names (`x.NAME`) and object keys are not names read.
   */
  namesOwnValues(a: number, b: number): boolean {
    for (let j = a; j < b; j++) {
      if (!this.spend()) return false;
      const name = this.ident(j);
      if (!name || this.dot(j - 1) || KEYWORDS.has(name)) continue;
      if (this.is(j + 1, ":") && (this.is(j - 1, "{") || this.is(j - 1, ","))) continue;
      const around = this.resolver.boundAround(j, name);
      if (around?.kind === "param") return false;
      // a declaration inside a function: only where the binding read is its own value
      if (around?.kind === "local" && this.resolver.functionAt(j)) {
        const bound = this.resolver.binding(j, name);
        if (bound?.kind !== "value") return false;
        const [x, y] = this.trim(bound.range[0], bound.range[1]);
        if (
          this.resolver.functionAt(x) !== null &&
          !(y === x + 1 && this.tokens[x]!.type === "string")
        )
          return false;
      }
    }
    return true;
  }

  /** Whether the expression at [a, b) is truthy, as Electron takes it; null when not read. */
  boolAt(a: number, b: number, depth = 0): boolean | null {
    if (b === a + 1 && (this.ident(a) === "true" || this.ident(a) === "false"))
      return this.ident(a) === "true";
    if (b === a + 1 && (this.ident(a) === "null" || this.ident(a) === "undefined")) return false;
    const numeric = (at: number): boolean | null => {
      const n = numericLiteral(this.tokens[at]!.value);
      return n === null ? null : n !== 0;
    };
    if (b === a + 2 && this.is(a, "!") && this.tokens[a + 1]?.type === "number") {
      const v = numeric(a + 1);
      return v === null ? null : !v;
    }
    if (b === a + 1 && this.tokens[a]?.type === "number") return numeric(a);
    if (b === a + 1 && this.tokens[a]?.type === "string") return this.tokens[a]!.value !== "";
    // an object or array literal is truthy
    if ((this.is(a, "{") || this.is(a, "[")) && this.resolver.closeOf(a) === b - 1) return true;
    if (b === a + 1 && this.ident(a) && depth < 3 && this.spend()) {
      if (this.resolver.boundAround(a, this.ident(a)!)?.kind === "param") return null;
      const bound = this.resolver.binding(a, this.ident(a)!);
      if (bound?.kind === "value") {
        const [x, y] = this.trim(bound.range[0], bound.range[1]);
        return this.boolAt(x, y, depth + 1);
      }
    }
    return null;
  }

  /** The handler written at k (a function literal, also wrapped in parentheses); else null. */
  handlerAt(k: number): FnDef | null {
    let j = k;
    while (
      this.is(j, "(") &&
      this.is(j + 1, "(") &&
      !this.resolver.functionWithParamsAt(j) &&
      j < k + 4
    )
      j++;
    if (this.ident(j) === "async") j++;
    if (this.ident(j) === "function") {
      j++;
      if (this.ident(j)) j++;
    }
    return this.resolver.functionWithParamsAt(j);
  }

  /**
   * The plain name of parameter `index` of `def`; `absent` only when every parameter is a plain
   * name, there are fewer than index + 1, and the body never reads `arguments`. Null for a rest
   * parameter, a pattern at the index, or a short list with `arguments` in the body.
   */
  callbackParam(def: FnDef, index: number): string | "absent" | null {
    const segments: number[][] = [];
    if (this.ident(def.paramsAt) && !this.is(def.paramsAt, "(")) segments.push([def.paramsAt]);
    else if (this.is(def.paramsAt, "(")) {
      const close = this.resolver.closeOf(def.paramsAt);
      if (close < 0) return null;
      let current: number[] = [];
      for (let j = def.paramsAt + 1, d = 0; j < close; j++) {
        if (!this.spend()) return null;
        if (this.is(j, "(") || this.is(j, "[") || this.is(j, "{")) d++;
        else if (this.is(j, ")") || this.is(j, "]") || this.is(j, "}")) d--;
        if (d === 0 && this.is(j, ",")) {
          segments.push(current);
          current = [];
        } else current.push(j);
      }
      if (current.length) segments.push(current);
    } else return null;
    const rest = (seg: number[] | undefined): boolean =>
      seg !== undefined && this.is(seg[0]!, "...");
    for (let i = 0; i < Math.min(index + 1, segments.length); i++)
      if (rest(segments[i])) return null;
    if (segments.length > index) {
      const seg = segments[index]!;
      const name = this.ident(seg[0]!);
      return name !== null && (seg.length === 1 || this.is(seg[1]!, "=")) ? name : null;
    }
    if (segments.some(rest)) return null;
    for (let j = def.body[0]; j <= def.body[1] && j < this.tokens.length; j++) {
      if (!this.spend()) return null;
      if (this.ident(j) === "arguments" && !this.dot(j - 1)) return null;
    }
    return "absent";
  }

  /**
   * The end of the statement starting at a: the `;` at depth 0, the bracket that closes the one
   * around it, or a line break where JavaScript inserts a semicolon; -1 past 4,000 tokens or the
   * budget.
   */
  statementEnd(a: number): number {
    for (let j = a, d = 0; j < this.tokens.length && j < a + 4000; j++) {
      if (!this.spend()) return -1;
      const p = this.tokens[j]!;
      if (p.type === "punct") {
        if (p.value === "(" || p.value === "[" || p.value === "{") d++;
        else if (p.value === ")" || p.value === "]" || p.value === "}") {
          if (d === 0) return j;
          d--;
        } else if (d === 0 && p.value === ";") return j;
      }
      const next = this.tokens[j + 1];
      if (d === 0 && next && next.line > p.line && endsValue(p) && startsStatement(next))
        return j + 1;
    }
    return -1;
  }

  /** The last operand of a comma sequence at [a, b) (all of it when there is no comma). */
  lastOperand(a: number, b: number): number {
    let start = a;
    for (let j = a, d = 0; j < b; j++) {
      if (!this.spend()) return a;
      if (this.is(j, "(") || this.is(j, "[") || this.is(j, "{")) d++;
      else if (this.is(j, ")") || this.is(j, "]") || this.is(j, "}")) d--;
      else if (d === 0 && this.is(j, ",")) start = j + 1;
    }
    return start;
  }

  /**
   * Whether token j runs whenever `def` runs: `always`; `conditional` behind `if`/`else`, a loop
   * body, `case`, `catch`, `?:`, `&&`, `||` or `??`; `unknown` in a nested function (it runs
   * when something else calls it) or where the nesting is not read. A `try` block, a bare block,
   * a comma sequence, parentheses and the arguments of a call run with the statement around
   * them. A statement ends at `;`, at `}`, and at a line break after a value where JavaScript
   * inserts a semicolon (the head of an `if`, `for`, `while` or `with` is not such an end).
   */
  reach(def: FnDef, j: number): "always" | "conditional" | "unknown" {
    if (this.resolver.functionAt(j) !== def) return "unknown";
    const [b0] = def.body;
    let pos = j;
    for (let guard = 0; guard < 512; guard++) {
      const open = this.resolver.bracketAround(pos);
      const top = def.block ? open === b0 : open < b0;
      const stop = top ? (def.block ? b0 : b0 - 1) : open;
      const level = this.levelBefore(stop, pos, !top && this.objectLiteral(open));
      if (level !== "always") return level;
      if (top) return "always";
      if (open < 0 || open < b0) return "unknown";
      const bracket = this.bracketReach(open);
      if (bracket !== "always") return bracket;
      pos = open;
    }
    return "unknown";
  }

  /** The tokens (stop, pos) of one bracket level, read back to the start of the statement. */
  private levelBefore(
    stop: number,
    pos: number,
    object = false,
  ): "always" | "conditional" | "unknown" {
    let d = 0;
    for (let q = pos - 1; q > stop; q--) {
      if (!this.spend()) return "unknown";
      const p = this.tokens[q]!;
      const next = this.tokens[q + 1]!;
      // a line break after a value ends a statement (automatic semicolon insertion)
      if (d === 0 && next.line > p.line && endsValue(p) && startsStatement(next)) {
        if (p.type === "punct" && p.value === ")") {
          const o = this.resolver.openOf(q);
          if (o < 0) return "unknown";
          if (/^(if|for|while|with)$/.test(this.ident(o - 1) ?? "")) return "conditional";
        }
        return "always";
      }
      if (p.type === "punct") {
        if (d === 0 && (p.value === ";" || p.value === "}")) return "always";
        // a `,` (a comma sequence, the arguments of a call, an array, a declaration list, the
        // properties of an object) evaluates what is before it whole, branches included, and
        // then what is after it: nothing before it guards j
        if (d === 0 && p.value === ",") return "always";
        // in an object literal the `:` after a key is no branch
        if (object && d === 0 && p.value === ":" && this.isKeyColon(q, stop)) continue;
        if (p.value === ")" || p.value === "]" || p.value === "}") d++;
        else if (p.value === "(" || p.value === "[" || p.value === "{") d--;
        else if (d === 0 && BRANCH.has(p.value)) return "conditional";
      } else if (d === 0 && p.type === "ident" && CONDITIONS.has(p.value) && p.value !== "try")
        // a `try` block runs as far as nothing in it throws first
        return "conditional";
    }
    return "always";
  }

  /** The `{` at `open` starts an object literal (not a block or a function body). */
  objectLiteral(open: number): boolean {
    if (!this.is(open, "{")) return false;
    const before = this.tokens[open - 1];
    if (!before) return false;
    if (before.type === "ident") return before.value === "return";
    return before.type === "punct" && !["{", ";", "}", ")", "=>"].includes(before.value);
  }

  /** The `:` at q, in the object literal opened at `open`, follows a property key. */
  private isKeyColon(q: number, open: number): boolean {
    const key = this.tokens[q - 1];
    if (!key) return false;
    // `key:`, `"key":`, `[computed]:` right after `{` or `,`
    if (this.is(q - 1, "]")) {
      const o = this.resolver.openOf(q - 1);
      return o > open && (this.is(o - 1, ",") || o - 1 === open);
    }
    return (
      (key.type === "ident" || key.type === "string" || key.type === "number") &&
      (this.is(q - 2, ",") || q - 2 === open)
    );
  }

  /** Whether what stands in the bracket at `open` runs with the statement around it. */
  private bracketReach(open: number): "always" | "conditional" | "unknown" {
    if (!this.is(open, "{")) return "always";
    const before = this.tokens[open - 1];
    if (!before) return "always";
    if (before.type === "ident") {
      if (before.value === "try" || before.value === "finally") return "always";
      if (CONDITIONS.has(before.value)) return "conditional";
      // `return {…}`, `case x: {…}` is read on the level around
      return before.value === "return" ? "always" : "unknown";
    }
    if (before.type !== "punct") return "unknown";
    if (before.value === ")") {
      const o = this.resolver.openOf(open - 1);
      if (o < 0) return "unknown";
      const word = this.ident(o - 1);
      if (word && /^(if|for|while|switch|catch|with)$/.test(word)) return "conditional";
      // a function's body: another function (not read as `def`'s own)
      return "unknown";
    }
    if (before.value === "=>") return "unknown";
    // a bare block (`{ { cb(true) } }`) or an object literal: run in place
    return "always";
  }

  /** The token j stands at the top of the body of `def`, behind no condition. */
  statementLevel(def: FnDef, j: number): boolean {
    const [b0] = def.body;
    const around = this.resolver.bracketAround(j);
    if (def.block ? around !== b0 : around >= b0) return false;
    let d = 0;
    for (let q = j - 1; q > b0 || (!def.block && q === b0); q--) {
      if (!this.spend()) return false;
      const p = this.tokens[q]!;
      if (p.type === "punct") {
        if (d === 0 && (p.value === ";" || p.value === "}")) return true;
        if (p.value === ")" || p.value === "]" || p.value === "}") d++;
        else if (p.value === "(" || p.value === "[" || p.value === "{") d--;
        else if (d === 0 && BRANCH.has(p.value)) return false;
      } else if (d === 0 && p.type === "ident" && CONDITIONS.has(p.value)) return false;
    }
    return true;
  }

  /**
   * The key `key` of the object literal at `open`: the token its value starts at, `method` for
   * `key() {}`, null when the literal does not have it, `unknown` for a spread, a computed key,
   * a shorthand or an accessor, any of which may give it another value.
   */
  keyOf(open: number, key: string): number | "method" | "unknown" | null {
    const close = this.resolver.closeOf(open);
    if (close < 0) return "unknown";
    let found: number | "method" | null = null;
    for (let j = open + 1, d = 0; j < close; j++) {
      if (!this.spend()) return "unknown";
      if (this.is(j, "{") || this.is(j, "(") || this.is(j, "[")) {
        if (d === 0 && this.is(j, "[") && (this.is(j - 1, "{") || this.is(j - 1, ",")))
          return "unknown";
        d++;
        continue;
      }
      if (this.is(j, "}") || this.is(j, ")") || this.is(j, "]")) {
        d--;
        continue;
      }
      if (d !== 0 || !(this.is(j - 1, "{") || this.is(j - 1, ","))) continue;
      if (this.is(j, "...")) return "unknown";
      const t = this.tokens[j]!;
      const name = t.type === "ident" || t.type === "string" ? t.value : null;
      if (name === null) continue;
      if (
        (name === "get" || name === "set" || name === "async") &&
        this.tokens[j + 1]?.value === key
      )
        return "unknown";
      if (name !== key) continue;
      if (this.is(j + 1, ":")) found = j + 2;
      else if (this.is(j + 1, "(")) found = "method";
      else return "unknown";
    }
    return found;
  }

  /**
   * The receiver from `from` to the `.` at `d` is a name bound to an object literal of the file,
   * and the path through it ends at the literal's own function `method`: a look-alike.
   */
  ownLiteralMethod(from: number, d: number, method: string): boolean {
    const base = this.ident(from);
    if (!base || base === "this" || !this.spend()) return false;
    if (this.resolver.boundAround(from, base)?.kind === "param") return false;
    const bound = this.resolver.binding(from, base, true);
    if (bound?.kind !== "value" || !this.is(bound.range[0], "{")) return false;
    let cur = bound.range[0];
    for (let j = from + 2; j < d; j += 2) {
      const v = this.keyOf(cur, this.ident(j) ?? "");
      if (typeof v !== "number" || !this.is(v, "{")) return false;
      cur = v;
    }
    const m = this.keyOf(cur, method);
    if (m === "method") return true;
    if (typeof m !== "number") return false;
    return (
      this.ident(m) === "function" ||
      (this.ident(m) === "async" && this.ident(m + 1) === "function") ||
      this.resolver.functionWithParamsAt(m) !== null
    );
  }

  /** The first token of the receiver chain `a.b.c` ending before the `.` at d (or d - 1). */
  chainStart(d: number): number {
    let from = d - 1;
    if (!this.ident(from)) return from;
    while (this.dot(from - 1) && this.ident(from - 2)) from -= 2;
    return from;
  }
}

/** The scheme of a URL as a WHATWG parser reads its start; null when the text names none. */
export function schemeOf(text: string): string | null {
  // leading C0 controls and spaces are dropped, tabs and line breaks anywhere
  let start = 0;
  while (start < text.length && text.charCodeAt(start) <= 0x20) start++;
  const flat = text.slice(start).replace(/[\t\n\r]/g, "");
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(flat);
  return m ? m[1]!.toLowerCase() : null;
}

/** `shell.openExternal(url)` calls of a file. */
export function openExternalRows(
  tokens: Token[],
  file: string,
  resolver: ExpressionResolver,
  constants: Constants,
): { rows: OpenExternalRow[]; capped: boolean } {
  const r = new FileReader(tokens, resolver, constants);
  const rows: OpenExternalRow[] = [];
  let capped = false;
  const push = (row: OpenExternalRow): void => {
    if (keepRows(rows, [row], MAX_SECURITY_ROWS_PER_FILE, harmlessOpenExternal)) capped = true;
  };
  /** What is known of the URL argument at [a, b). */
  const argument = (
    a: number,
    b: number,
  ): Pick<OpenExternalRow, "argumentKind" | "argument" | "scheme" | "values"> => {
    const unknown = { argumentKind: "unknown" as const, argument: null, scheme: null };
    if (b <= a) return unknown;
    const whole = r.stringAt(a, b);
    if (whole !== null)
      return { argumentKind: "literal", argument: whole, scheme: schemeOf(whole) };
    const t = tokens[a]!;
    // `https://example.com/${path}`: the part before the first substitution
    let prefix: string | null = null;
    let head = -1;
    if (t.type === "template" && t.value.includes("${")) {
      prefix = t.value.split("${")[0]!;
      head = templateEnd(a, b);
    }
    // `"https://example.com/" + path`
    else if (t.type === "string") {
      prefix = t.value;
      head = a + 1;
    }
    // only where the URL is that operand alone or the first of a chain of `+` operands: any
    // other operator (`&&`, `||`, `??`, `?:`, a comparison), a member or call on it, or a
    // comma may give a value that does not start with it
    if (prefix && head > a && plusChain(head, b)) {
      const scheme = schemeOf(prefix);
      return {
        argumentKind: "inferred",
        argument: prefix,
        // a scheme is known only when its colon is in the known part
        scheme,
      };
    }
    // `flag ? "https://a" : "https://b"`: both branches read
    const branches = ternaryStrings(a, b);
    if (branches) {
      const schemes = new Set(branches.map(schemeOf));
      return {
        argumentKind: "inferred",
        argument: null,
        values: branches,
        scheme: schemes.size === 1 ? [...schemes][0]! : null,
      };
    }
    if (r.spend() && r.namesOwnValues(a, b)) {
      const v = resolver.valueAt(a);
      if (v?.kind === "str" && v.values.length > 1 && v.values.length <= 8 && r.exprEnd(a) === b) {
        const schemes = new Set(v.values.map(schemeOf));
        return {
          argumentKind: "inferred",
          argument: null,
          values: [...v.values],
          scheme: schemes.size === 1 ? [...schemes][0]! : null,
        };
      }
    }
    return unknown;
  };

  /**
   * The token after the template that starts at a (its pieces and substitutions), within
   * [a, b); -1 when its end is not found there.
   */
  function templateEnd(a: number, b: number): number {
    let depth = 0;
    for (let j = a + 1; j < b; j++) {
      if (!r.spend()) return -1;
      const x = tokens[j]!;
      if (x.type === "punct" && (x.value === "(" || x.value === "[" || x.value === "{")) depth++;
      else if (x.type === "punct" && (x.value === ")" || x.value === "]" || x.value === "}"))
        depth--;
      else if (depth === 0 && x.type === "template" && !x.value.includes("${")) return j + 1;
    }
    return -1;
  }
  /** `c ? x : y` at [a, b) with x and y strings read whole (each also a ternary); else null. */
  function ternaryStrings(a: number, b: number, depth = 0): string[] | null {
    if (depth > 3) return null;
    let q = -1;
    let colon = -1;
    let nested = 0;
    for (let j = a, d = 0; j < b; j++) {
      if (!r.spend()) return null;
      const x = tokens[j]!;
      if (x.type !== "punct") continue;
      if (x.value === "(" || x.value === "[" || x.value === "{") d++;
      else if (x.value === ")" || x.value === "]" || x.value === "}") d--;
      else if (d === 0 && x.value === "?") {
        if (q < 0) q = j;
        else nested++;
      } else if (d === 0 && x.value === ":" && q >= 0) {
        if (nested > 0) nested--;
        else if (colon < 0) colon = j;
      }
    }
    if (q < 0 || colon < 0) return null;
    const side = (x: number, y: number): string[] | null => {
      const one = r.stringAt(x, y);
      return one !== null ? [one] : ternaryStrings(x, y, depth + 1);
    };
    const left = side(q + 1, colon);
    const right = left && side(colon + 1, b);
    if (!left || !right) return null;
    // more values than are kept is not read: never a list cut short, whose scheme could hide one
    const all = [...new Set([...left, ...right])];
    return all.length > 8 ? null : all;
  }
  /** [from, b) is empty or `+ operand + operand …` with no other operator at depth 0. */
  function plusChain(from: number, b: number): boolean {
    if (from === b) return true;
    if (!r.is(from, "+")) return false;
    let depth = 0;
    let operand = false;
    for (let j = from; j < b; j++) {
      if (!r.spend()) return false;
      const x = tokens[j]!;
      if (x.type === "punct") {
        if (x.value === "(" || x.value === "[" || x.value === "{") {
          depth++;
          operand = true;
          continue;
        }
        if (x.value === ")" || x.value === "]" || x.value === "}") {
          depth--;
          continue;
        }
        if (depth > 0) continue;
        if (x.value === "+" && !r.is(j + 1, "+") && !r.is(j + 1, "=")) {
          // a `+` with no operand before it is a unary plus: not a concatenation
          if (j > from && !operand) return false;
          operand = false;
          continue;
        }
        if ((x.value === "." || x.value === "?.") && operand) continue;
        return false;
      }
      if (depth > 0) continue;
      if (
        x.type === "ident" &&
        /^(in|instanceof|typeof|void|delete|await|yield|new)$/.test(x.value)
      )
        return false;
      operand = true;
    }
    return operand;
  }

  for (let k = 1; k + 1 < tokens.length; k++) {
    const t = tokens[k]!;
    const bracketed = t.type === "string" && r.is(k - 1, "[") && r.is(k + 1, "]");
    if ((t.type !== "ident" && !bracketed) || t.value !== "openExternal") continue;
    if (r.work <= 0) {
      capped = true;
      break;
    }
    const after = bracketed ? k + 2 : k + 1;
    // `shell.openExternal(u)`, `shell.openExternal?.(u)`
    const open = r.is(after, "(")
      ? after
      : r.is(after, "?.") && r.is(after + 1, "(")
        ? after + 1
        : -1;
    if (open < 0) {
      // a reference that is not called here (`const o = shell.openExternal`, `.call`, `.bind`,
      // `(0, e.shell.openExternal)(u)`, `{ openExternal: o } = shell`): on Electron's shell a row
      // whose URL is not read
      let start = -1;
      if (bracketed || r.dot(k - 1)) start = r.memberBefore(k - 1, "shell");
      else if (r.is(k + 1, ":") && (r.is(k - 1, "{") || r.is(k - 1, ","))) {
        const o = resolver.bracketAround(k);
        const c = o < 0 ? -1 : resolver.closeOf(o);
        if (c > 0 && r.is(c + 1, "=") && !r.is(c + 2, "=")) {
          const end = r.exprEnd(c + 2, true);
          if (end > c + 2) {
            const [a, b] = r.trim(c + 2, end);
            if ((b === a + 1 && r.memberName(a, "shell")) || r.memberExpr(a, b, "shell")) start = k;
          }
        }
      }
      if (start < 0) continue;
      push({
        targetKind: "shell",
        target: "shell",
        argumentKind: "unknown",
        argument: null,
        scheme: null,
        evidence: `${r.text(start, k + 1)} (not called here: its URL is not read)`,
        file,
        line: t.line,
      });
      continue;
    }
    let from: number;
    let shell: boolean;
    if (bracketed || r.dot(k - 1)) {
      // `X.openExternal(…)` / `X["openExternal"](…)`
      const d = k - 1;
      const proven = r.memberBefore(d, "shell");
      if (proven >= 0) {
        from = proven;
        shell = true;
      } else {
        from = r.chainStart(d);
        // a function of an object literal of the file: a look-alike, no row
        if (r.ident(from) && r.ownLiteralMethod(from, d, "openExternal")) continue;
        shell = false;
      }
    } else {
      // `openExternal(url)` with `const { openExternal } = shell` or
      // `const { shell: { openExternal } } = require("electron")` is not followed; a function of
      // the app named openExternal is no call of Electron's
      const bound = r.spend() ? resolver.binding(k, "openExternal", true) : null;
      if (bound?.kind !== "pattern" || bound.key !== "openExternal") continue;
      const [a, b] = r.trim(bound.from[0], bound.from[1]);
      shell = (b === a + 1 && r.memberName(a, "shell")) || r.memberExpr(a, b, "shell");
      if (!shell) continue;
      from = k;
    }
    const close = resolver.closeOf(open);
    if (close < 0) continue;
    const end = r.is(open + 1, ")") ? open + 1 : r.exprEnd(open + 1);
    push({
      targetKind: shell ? "shell" : "unknown",
      target: shell ? "shell" : r.text(from, k - 1),
      ...(end < 0
        ? { argumentKind: "unknown", argument: null, scheme: null }
        : argument(open + 1, end)),
      evidence: `${r.text(from, open + 1)}${r.text(open + 1, close)})`,
      file,
      line: t.line,
    });
  }
  if (r.capped) capped = true;
  return { rows, capped };
}

const PERMISSION_METHODS: ReadonlyMap<string, PermissionHandlerRow["kind"]> = new Map([
  ["setPermissionRequestHandler", "request"],
  ["setPermissionCheckHandler", "check"],
]);

/** The strongest of several answers, in the order a grant matters. */
const GRANT_ORDER: ReadonlyArray<PermissionHandlerRow["grants"]> = [
  "always",
  "unknown",
  "conditional",
  "computed",
  "never",
];

/**
 * Which session the receiver ending right before the `.` at d is: `session.defaultSession`,
 * `session.fromPartition("p")`, a name bound to one of these, `X.webContents.session`.
 */
function sessionBefore(
  r: FileReader,
  d: number,
  depth = 0,
): { targetKind: PermissionHandlerRow["targetKind"]; session: string | null } {
  const none = { targetKind: "unknown" as const, session: null };
  if (depth > 2 || !r.spend()) return none;
  // `….defaultSession`
  if (r.ident(d - 1) === "defaultSession" && r.dot(d - 2))
    return r.memberBefore(d - 2, "session") >= 0
      ? { targetKind: "session", session: "default" }
      : none;
  // `….fromPartition("p")`, `….fromPath("/p")`
  if (r.is(d - 1, ")")) {
    const open = r.resolver.openOf(d - 1);
    const method = r.ident(open - 1);
    if ((method === "fromPartition" || method === "fromPath") && r.dot(open - 2)) {
      if (r.memberBefore(open - 2, "session") < 0) return none;
      const end = r.exprEnd(open + 1);
      const name = end < 0 ? null : r.stringAt(open + 1, end);
      return {
        targetKind: "session",
        session: `${method === "fromPartition" ? "partition" : "path"}:${name ?? "?"}`,
      };
    }
    return none;
  }
  // `win.webContents.session`, `contents.session`
  if (r.ident(d - 1) === "session" && r.dot(d - 2)) {
    if (r.ident(d - 3) === "webContents" && r.dot(d - 4))
      return { targetKind: "webContents", session: null };
    return none;
  }
  // `const ses = session.defaultSession; ses.setPermissionRequestHandler(…)`
  const name = r.ident(d - 1);
  if (!name || r.dot(d - 2)) return none;
  if (r.resolver.boundAround(d - 1, name)?.kind === "param") return none;
  const bound = r.resolver.binding(d - 1, name);
  if (bound?.kind !== "value") return none;
  const [a, b] = r.trim(bound.range[0], bound.range[1]);
  if (b <= a + 1) return none;
  // the bound expression is itself a receiver: read it as if a `.` followed it
  const inner = sessionBefore(r, b, depth + 1);
  // only when the whole expression is that receiver
  return inner.targetKind !== "unknown" && receiverStart(r, b) === a ? inner : none;
}

/** The first token of the member chain or call ending before d (`a.b(c).d`). */
function receiverStart(r: FileReader, d: number): number {
  let j = d - 1;
  for (let guard = 0; guard < 64 && j >= 0; guard++) {
    if (r.is(j, ")") || r.is(j, "]")) {
      const open = r.resolver.openOf(j);
      if (open < 0) return -1;
      j = open - 1;
      if (!r.ident(j)) return -1;
      continue;
    }
    if (!r.ident(j)) return -1;
    if (r.dot(j - 1)) {
      j -= 2;
      continue;
    }
    return j;
  }
  return -1;
}

/** `setPermissionRequestHandler` / `setPermissionCheckHandler` calls of a file. */
export function permissionHandlerRows(
  tokens: Token[],
  file: string,
  resolver: ExpressionResolver,
  constants: Constants,
): { rows: PermissionHandlerRow[]; capped: boolean } {
  const r = new FileReader(tokens, resolver, constants);
  const rows: PermissionHandlerRow[] = [];
  let capped = false;
  const push = (row: PermissionHandlerRow): void => {
    if (keepRows(rows, [row], MAX_SECURITY_ROWS_PER_FILE, harmlessPermission)) capped = true;
  };
  const strongest = (
    answers: Array<PermissionHandlerRow["grants"]>,
  ): PermissionHandlerRow["grants"] => GRANT_ORDER.find((g) => answers.includes(g)) ?? "never";

  /** A request handler: what it passes to its callback (parameter `param`). */
  const callbackGrants = (def: FnDef, param: string): PermissionHandlerRow["grants"] => {
    const answers: Array<PermissionHandlerRow["grants"]> = [];
    // where the first `return` or `throw` statement of the handler ends: a grant after it may be
    // skipped, a grant inside it (`return callback(true)`) is not
    let returnEnd = Number.POSITIVE_INFINITY;
    for (let j = def.body[0]; j <= def.body[1] && j < tokens.length; j++) {
      if (!r.spend()) return "unknown";
      if (
        (r.ident(j) === "return" || r.ident(j) === "throw") &&
        resolver.functionAt(j) === def &&
        returnEnd === Number.POSITIVE_INFINITY
      ) {
        const end = r.statementEnd(j + 1);
        returnEnd = end < 0 ? j : end;
      }
      // an object key of that name is no use of the parameter; `c ? callback : f` is
      if (
        r.ident(j) !== param ||
        r.dot(j - 1) ||
        (r.is(j + 1, ":") && (r.is(j - 1, "{") || r.is(j - 1, ",")))
      )
        continue;
      // the handler's own parameter, not one of a nested function of the same name
      let owner = resolver.functionAt(j);
      while (
        owner &&
        owner !== def &&
        !owner.params.some((p) => p.kind === "name" && p.name === param)
      )
        owner = resolver.outerOf(owner);
      if (owner !== def) continue;
      if (!r.is(j + 1, "(")) {
        // handed on, stored or tested: what happens to it is not read
        answers.push("unknown");
        continue;
      }
      const close = resolver.closeOf(j + 1);
      const end = close < 0 ? -1 : r.is(j + 2, ")") ? j + 2 : r.exprEnd(j + 2);
      if (end < 0) {
        answers.push("unknown");
        continue;
      }
      // `callback()` passes undefined: a refusal
      const verdict = end === j + 2 ? false : r.boolAt(j + 2, Math.min(end, close));
      if (verdict === false) answers.push("never");
      else if (verdict === null) answers.push("computed");
      else {
        // a grant after a return may be skipped; one in a nested function runs when that is
        // called (not read); one behind a condition is conditional
        const reach = r.reach(def, j);
        answers.push(reach === "always" && returnEnd < j ? "conditional" : reach);
      }
    }
    return answers.length ? strongest(answers) : "never";
  };

  /** A check handler: what it returns. */
  const returnGrants = (def: FnDef): PermissionHandlerRow["grants"] => {
    if (!def.block) {
      let [a, b] = def.body;
      // `() => (true)`
      while (r.is(a, "(") && resolver.closeOf(a) === b - 1) [a, b] = [a + 1, b - 1];
      // `(log(p), !0)`: the value is the last operand of the sequence
      const v = r.boolAt(r.lastOperand(a, b), b);
      return v === true ? "always" : v === false ? "never" : "computed";
    }
    const answers: Array<PermissionHandlerRow["grants"]> = [];
    let returned = false;
    for (let j = def.body[0]; j <= def.body[1] && j < tokens.length; j++) {
      if (!r.spend()) return "unknown";
      const word = r.ident(j);
      if ((word !== "return" && word !== "throw") || resolver.functionAt(j) !== def) continue;
      if (word === "throw") {
        returned = true;
        continue;
      }
      // `return` then a line break returns undefined (automatic semicolon insertion)
      const bare =
        r.is(j + 1, ";") || r.is(j + 1, "}") || (tokens[j + 1]?.line ?? 0) > tokens[j]!.line;
      const end = bare ? j + 1 : r.statementEnd(j + 1);
      if (end < 0) {
        answers.push("unknown");
        returned = true;
        continue;
      }
      // `return log(p), !0`: the value is the last operand of the sequence
      const verdict = bare ? false : r.boolAt(r.lastOperand(j + 1, end), end);
      if (verdict === false) answers.push("never");
      else if (verdict === null) answers.push("computed");
      else {
        const reach = r.reach(def, j);
        answers.push(reach === "always" && returned ? "conditional" : reach);
      }
      // only a return every path reaches ends the reading of later ones as unconditional
      returned = true;
    }
    return answers.length ? strongest(answers) : "never";
  };

  for (let k = 1; k + 1 < tokens.length; k++) {
    const t = tokens[k]!;
    const bracketed = t.type === "string" && r.is(k - 1, "[") && r.is(k + 1, "]");
    if (t.type !== "ident" && !bracketed) continue;
    const kind = PERMISSION_METHODS.get(t.value);
    if (!kind || !(bracketed || r.dot(k - 1))) continue;
    if (r.work <= 0) {
      capped = true;
      break;
    }
    const after = bracketed ? k + 2 : k + 1;
    // `ses.setPermissionRequestHandler?.(…)` is a call as well
    const open = r.is(after, "(")
      ? after
      : r.is(after, "?.") && r.is(after + 1, "(")
        ? after + 1
        : -1;
    if (open < 0) continue;
    const d = k - 1;
    // `session.fromPartition("p").setPermissionRequestHandler(…)`: the call is part of it
    const from = r.is(d - 1, ")") ? receiverStart(r, d) : r.chainStart(d);
    if (r.ident(from) && r.ownLiteralMethod(from, d, t.value)) continue;
    const where = sessionBefore(r, d);
    const close = resolver.closeOf(open);
    if (close < 0) continue;
    let grants: PermissionHandlerRow["grants"];
    const end = r.is(open + 1, ")") ? open + 1 : r.exprEnd(open + 1);
    if (end === open + 1 || (end === open + 2 && r.ident(open + 1) === "null"))
      // cleared: Electron's default answers every request and check with a grant
      grants = "always";
    else {
      const def = r.handlerAt(open + 1);
      if (!def) grants = "unknown";
      else if (kind === "request") {
        const cb = r.callbackParam(def, 2);
        grants = cb === "absent" ? "never" : cb === null ? "unknown" : callbackGrants(def, cb);
      } else grants = returnGrants(def);
    }
    push({
      kind,
      targetKind: where.targetKind,
      session: where.session,
      grants,
      target: r.text(from < 0 ? d - 1 : from, d),
      evidence: `${r.text(Math.max(0, from), open + 1)}${r.text(open + 1, Math.min(close, open + 12))}${close > open + 12 ? "…" : ""})`,
      file,
      line: t.line,
    });
  }
  if (r.capped) capped = true;
  return { rows, capped };
}

const CSP_HEADER = "content-security-policy";
const CSP_REPORT_ONLY = "content-security-policy-report-only";

/**
 * Content-Security-Policy header keys written in code: `{ "Content-Security-Policy": [...] }`
 * and `headers["content-security-policy"] = …`, each with whether it stands in a function passed
 * to `X.webRequest.onHeadersReceived(…)`.
 */
export function cspHeaderRows(
  tokens: Token[],
  file: string,
  resolver: ExpressionResolver,
  constants: Constants,
): { rows: CspRow[]; capped: boolean } {
  const r = new FileReader(tokens, resolver, constants);
  const rows: CspRow[] = [];
  let capped = false;
  // functions passed to `….webRequest.onHeadersReceived(…)`, with whether the receiver of
  // `webRequest` is read as a session
  const listeners = new Map<FnDef, { session: string | null; filtered: boolean }>();
  for (let k = 2; k + 1 < tokens.length; k++) {
    if (r.ident(k) !== "onHeadersReceived" || !r.dot(k - 1) || !r.is(k + 1, "(")) continue;
    if (!r.spend()) break;
    if (r.ident(k - 2) !== "webRequest" || !r.dot(k - 3)) continue;
    const close = resolver.closeOf(k + 1);
    if (close < 0) continue;
    const seen = sessionBefore(r, k - 3);
    // the default session is the one windows use unless they name a partition
    const session = seen.targetKind === "session" ? seen.session : null;
    for (let a = k + 2; a < close;) {
      const def = r.handlerAt(a);
      // `onHeadersReceived(filter, listener)`: the listener gets only the responses the filter's
      // URLs match
      if (def) listeners.set(def, { session, filtered: a > k + 2 });
      const end = r.exprEnd(a);
      if (end < 0 || end >= close) break;
      a = end + 1;
    }
  }
  /** The listener whose body holds j (through nested functions), or null. */
  const listenerOf = (j: number): FnDef | null => {
    if (!listeners.size) return null;
    let def = resolver.functionAt(j);
    for (let guard = 0; def && guard < 64; guard++) {
      if (listeners.has(def)) return def;
      def = resolver.outerOf(def);
    }
    return null;
  };
  /** A `...spread` after the key at j in its object literal: a value spread later may replace it. */
  const spreadAfter = (j: number): boolean => {
    const o = resolver.bracketAround(j);
    if (o < 0 || !r.is(o, "{")) return false;
    const c = resolver.closeOf(o);
    for (let x = j + 1, d = 0; x < c; x++) {
      if (!r.spend()) return true;
      if (r.is(x, "(") || r.is(x, "[") || r.is(x, "{")) d++;
      else if (r.is(x, ")") || r.is(x, "]") || r.is(x, "}")) d--;
      else if (d === 0 && r.is(x, "...")) return true;
    }
    return false;
  };
  /** The policy values at [a, b): an array of strings, or one string. */
  const values = (a: number, b: number): string[] | null => {
    if (r.is(a, "[") && resolver.closeOf(a) === b - 1) {
      const out: string[] = [];
      for (let x = a + 1; x < b - 1;) {
        const end = r.exprEnd(x);
        if (end < 0 || end > b - 1) return null;
        const s = r.stringAt(x, end);
        if (s === null) return null;
        out.push(s);
        if (end === b - 1) break;
        x = end + 1;
      }
      return out.length ? out : null;
    }
    const s = r.stringAt(a, b);
    return s === null ? null : [s];
  };
  for (let j = 1; j + 1 < tokens.length; j++) {
    const t = tokens[j]!;
    if (t.type !== "string" && t.type !== "ident") continue;
    const key = t.value.toLowerCase();
    if (key !== CSP_HEADER && key !== CSP_REPORT_ONLY) continue;
    if (r.work <= 0) {
      capped = true;
      break;
    }
    let a: number;
    let b: number;
    if (r.is(j + 1, ":") && (r.is(j - 1, "{") || r.is(j - 1, ","))) {
      // an object key
      a = j + 2;
      b = r.exprEnd(a);
    } else if (t.type === "string" && r.is(j - 1, "[") && r.is(j + 1, "]") && r.is(j + 2, "=")) {
      // `headers["content-security-policy"] = …`
      a = j + 3;
      b = r.exprEnd(a, true);
    } else continue;
    const read = b < 0 ? null : values(a, b);
    // a comma separates policies in a header value (CSP3, "parse a serialized CSP list")
    const policies = read === null ? null : read.flatMap((v) => v.split(","));
    const policy = read === null ? null : read.join(", ");
    const listener = listenerOf(j);
    const doubts: string[] = [];
    if (listener) {
      const seen = listeners.get(listener)!;
      if (seen.session === null) doubts.push("the webRequest receiver is not read as a session");
      else if (seen.session !== "default")
        doubts.push(
          `the listener is on session ${seen.session}, not the default session windows use unless they name a partition`,
        );
      if (seen.filtered)
        doubts.push("the listener has a URL filter, so which responses get the header is not read");
      const reach = r.reach(listener, j);
      if (reach !== "always")
        doubts.push(
          reach === "conditional"
            ? "the header is set behind a condition"
            : "the header is set in a nested function or where its nesting is not read",
        );
      if (spreadAfter(j)) doubts.push("a spread after it in the same object may replace it");
    }
    const row: CspRow = {
      kind: "header",
      via: listener ? "onHeadersReceived" : "other",
      ...(doubts.length ? { doubt: doubts.join("; ") } : {}),
      ...(key === CSP_REPORT_ONLY ? { reportOnly: true } : {}),
      policy,
      weaknesses: policies === null ? null : [...new Set(policies.flatMap(cspWeaknesses))],
      evidence: r.text(j, b < 0 ? j + 6 : Math.min(b, j + 12)),
      file,
      line: t.line,
    };
    if (keepRows(rows, [row], MAX_SECURITY_ROWS_PER_FILE, harmlessCsp)) capped = true;
  }
  if (r.capped) capped = true;
  return { rows, capped };
}

/** Per HTML file at most this many meta rows; more is `csp_truncated`. */
export const MAX_META_PER_FILE = 50;
const RAW_TEXT = ["script", "style", "textarea", "title", "xmp", "noembed", "noframes"];
/** Elements whose content is not applied: a `<meta>` in them sets no policy. */
const INERT = ["template", "noscript"];
/** Start tags that may stand in `<head>`; any other ends it, as in HTML's parser. */
const HEAD_TAGS = new Set([
  "html",
  "head",
  "meta",
  "link",
  "title",
  "style",
  "script",
  "base",
  "noscript",
  "template",
  "basefont",
  "bgsound",
]);

/** `&amp;`, `&quot;`, `&#39;`, `&#x27;` and the like in an attribute value. */
function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,6});?/gi, (all, ref: string) => {
    const lower = ref.toLowerCase();
    if (lower.startsWith("#x")) {
      const n = Number.parseInt(lower.slice(2), 16);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : all;
    }
    if (lower.startsWith("#")) {
      const n = Number.parseInt(lower.slice(1), 10);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : all;
    }
    const named: Record<string, string> = {
      amp: "&",
      quot: '"',
      apos: "'",
      lt: "<",
      gt: ">",
      nbsp: " ",
    };
    return named[lower] ?? all;
  });
}

/**
 * `<meta http-equiv="Content-Security-Policy" content="…">` of an HTML file, read with a
 * tokenizer for tags and attributes: comments and the content of raw-text elements (`<script>`,
 * `<style>`, `<textarea>` …) are skipped, attribute values are read quoted or unquoted, and
 * character references in them are decoded. One pass over the text; nothing else is parsed.
 */
export function cspMetaRows(text: string, file: string): { rows: CspRow[]; capped: boolean } {
  const rows: CspRow[] = [];
  let capped = false;
  let line = 1;
  let counted = 0;
  const lineAt = (offset: number): number => {
    for (; counted < offset; counted++) if (text.charCodeAt(counted) === 10) line++;
    return line;
  };
  const lower = text.toLowerCase();
  let i = 0;
  let inHead = true;
  /** Text other than whitespace between i and lt ends the head. */
  const textBetween = (from: number, to: number): boolean => {
    for (let x = from; x < to; x++) if (!/\s/.test(text[x]!)) return true;
    return false;
  };
  while (i < text.length) {
    const lt = text.indexOf("<", i);
    if (lt < 0) break;
    if (inHead && textBetween(i, lt)) inHead = false;
    if (text.startsWith("<!--", lt)) {
      const end = text.indexOf("-->", lt + 4);
      i = end < 0 ? text.length : end + 3;
      continue;
    }
    // an end tag, a doctype or a processing instruction: up to its `>`
    if (text[lt + 1] === "/" || text[lt + 1] === "!" || text[lt + 1] === "?") {
      // `</head>`, and `</body>`, `</html>`, `</br>` that HTML's parser treats as ending the head
      if (/^<\/(head|body|html|br)[\s/>]/.test(lower.slice(lt, lt + 8))) inHead = false;
      const end = text.indexOf(">", lt + 1);
      i = end < 0 ? text.length : end + 1;
      continue;
    }
    const m = /^<([a-zA-Z][a-zA-Z0-9-]*)/.exec(text.slice(lt, lt + 40));
    if (!m) {
      // a `<` that starts no tag is text
      inHead = false;
      i = lt + 1;
      continue;
    }
    const name = m[1]!.toLowerCase();
    if (!HEAD_TAGS.has(name)) inHead = false;
    // attributes up to the `>` that is not inside a quoted value
    const attrs = new Map<string, string>();
    let j = lt + m[0].length;
    while (j < text.length && text[j] !== ">") {
      const c = text[j]!;
      if (/[\s/]/.test(c)) {
        j++;
        continue;
      }
      let k = j;
      while (k < text.length && !/[\s/>=]/.test(text[k]!)) k++;
      const attr = lower.slice(j, k);
      let value = "";
      let q = k;
      while (q < text.length && /\s/.test(text[q]!)) q++;
      if (text[q] === "=") {
        q++;
        while (q < text.length && /\s/.test(text[q]!)) q++;
        const quote = text[q];
        if (quote === '"' || quote === "'") {
          const close = text.indexOf(quote, q + 1);
          const stop = close < 0 ? text.length : close;
          value = text.slice(q + 1, stop);
          k = close < 0 ? text.length : close + 1;
        } else {
          let e = q;
          while (e < text.length && !/[\s>]/.test(text[e]!)) e++;
          value = text.slice(q, e);
          k = e;
        }
      }
      // the first of two attributes of one name counts, as in HTML
      if (attr && !attrs.has(attr)) attrs.set(attr, decodeEntities(value));
      j = Math.max(k, j + 1);
    }
    i = j + 1;
    // everything after <plaintext> is text
    if (name === "plaintext") break;
    if (RAW_TEXT.includes(name) || INERT.includes(name)) {
      // raw text is no markup; a template's or noscript's content is not applied
      const end = lower.indexOf(`</${name}`, i);
      i = end < 0 ? text.length : end;
      continue;
    }
    if (name !== "meta") continue;
    // HTML compares the keyword ASCII case-insensitively, without trimming
    const equiv = attrs.get("http-equiv")?.toLowerCase();
    // a report-only policy in <meta> is ignored by browsers (CSP3, 6.1.1)
    if (equiv !== CSP_HEADER) continue;
    const policy = attrs.get("content") ?? null;
    if (rows.length >= MAX_META_PER_FILE) {
      capped = true;
      break;
    }
    rows.push({
      kind: "meta",
      ...(inHead ? {} : { outsideHead: true }),
      policy,
      weaknesses: policy === null ? null : cspWeaknesses(policy),
      evidence: short(text.slice(lt, Math.min(j + 1, lt + 200)).replace(/\s+/g, " ")),
      file,
      line: lineAt(lt),
    });
  }
  return { rows, capped };
}

/** Script sources that allow scripts from any host of a scheme, or from anywhere. */
const BROAD_SOURCES = new Set([
  "*",
  "http:",
  "https:",
  "data:",
  "blob:",
  "filesystem:",
  "ws:",
  "wss:",
]);

const broad = (list: readonly string[]): string[] =>
  list.filter((x) => BROAD_SOURCES.has(x) || /^[a-z][a-z0-9+.-]*:\/\/\*$/.test(x));
// a nonce or hash with a value (`'nonce-'` alone is no nonce)
const nonceOrHash = (list: readonly string[]): boolean =>
  list.some((x) => /^'(nonce-[a-z0-9+/_=-]+|sha(256|384|512)-[a-z0-9+/_=-]+)'$/.test(x));

/**
 * Weaknesses of one serialized policy (CSP Level 3, "Parse a serialized CSP"): directives split
 * at `;`, names lowercased, the first of a repeated directive counts. The script directive is
 * `script-src`, else `default-src`. Reported:
 * - no script directive: scripts of any origin and inline scripts run;
 * - `'unsafe-inline'` in it without a nonce or hash (with one, CSP Level 2 browsers ignore it);
 * - `'unsafe-eval'` in it;
 * - `*` or a bare scheme (`https:`, `data:` …) in it;
 * - no `object-src` and no `default-src`, or `object-src` with `*`: plugins of any origin.
 * Anything else (host lists, `'strict-dynamic'`, `report-uri`) is not judged.
 */
export function cspWeaknesses(policy: string): string[] {
  const directives = new Map<string, string[]>();
  for (const part of policy.split(";")) {
    const tokens = part
      .trim()
      .split(/[\t\n\f\r ]+/)
      .filter(Boolean);
    if (!tokens.length) continue;
    const name = tokens[0]!.toLowerCase();
    if (!directives.has(name))
      directives.set(
        name,
        tokens.slice(1).map((x) => x.toLowerCase()),
      );
  }
  const out: string[] = [];
  const scriptName = directives.has("script-src") ? "script-src" : "default-src";
  const script = directives.get(scriptName);
  if (!script) out.push("no script-src or default-src: scripts are not restricted");
  // script-src-elem and script-src-attr take precedence for elements and attributes
  const judged: Array<[string, string[] | undefined]> = [
    [scriptName, script],
    ["script-src-elem", directives.get("script-src-elem")],
    ["script-src-attr", directives.get("script-src-attr")],
  ];
  for (const [name, list] of judged) {
    if (!list) continue;
    // a nonce or hash does not allow an inline event handler attribute
    if (list.includes("'unsafe-inline'") && (name === "script-src-attr" || !nonceOrHash(list)))
      out.push(`${name} allows 'unsafe-inline'`);
    if (list.includes("'unsafe-eval'")) out.push(`${name} allows 'unsafe-eval'`);
    const wide = broad(list);
    if (wide.length) out.push(`${name} allows ${wide.join(" ")}`);
  }
  const object = directives.get("object-src");
  if (!object && !directives.has("default-src"))
    out.push("no object-src or default-src: plugins are not restricted");
  else if (object && broad(object).length) out.push(`object-src allows ${broad(object).join(" ")}`);
  return out;
}
