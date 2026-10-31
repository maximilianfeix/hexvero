/**
 * Process-wide security settings an Electron main process writes in code (`switches`): Chromium
 * command-line switches (`app.commandLine.appendSwitch` / `appendArgument`), certificate errors
 * accepted in a `certificate-error` handler, a custom `setCertificateVerifyProc`, and writes of
 * `ELECTRON_DISABLE_SECURITY_WARNINGS`. Literal-first: a name or value is known only where it is
 * a literal or a constant the resolver reads; anything else is said to be unknown. Read from
 * tokens, so a comment or a string is never a call. Nothing is run. See docs/electron-findings.md
 * ("Command-line switches and certificate checks").
 */
import type { Constants } from "./aliases.js";
import type { ExpressionResolver, FnDef } from "./resolve.js";
import type { Token } from "./scan.js";
import { ASSIGNMENT_OPERATORS } from "./writes.js";

export interface SwitchRow {
  /**
   * `switch`: appendSwitch(name[, value]); `argument`: appendArgument(arg); `certificate-error`:
   * a handler that accepts certificate errors; `certificate-verify-proc`: setCertificateVerifyProc;
   * `security-warnings`: a write of ELECTRON_DISABLE_SECURITY_WARNINGS.
   */
  kind:
    | "switch"
    | "argument"
    | "certificate-error"
    | "certificate-verify-proc"
    | "security-warnings";
  /** The switch name without leading dashes, or the argument; null when it is not a literal or constant. */
  name: string | null;
  /** The switch value or the value written, when read; null otherwise (see `valueRead`). */
  value: string | null;
  /** `none`: no value is passed; `literal`: `value` holds it; `unknown`: it is not read. */
  valueRead?: "none" | "literal" | "unknown";
  /**
   * True: a switch on the list in docs/electron-findings.md, or certificate errors accepted;
   * false: known and not on it; null: whether it is cannot be told (name or value not read).
   */
  dangerous: boolean | null;
  /** Why the row is dangerous (or may be), in words. */
  reason?: string;
  /**
   * For `certificate-error` and `certificate-verify-proc`: `always` when the accepting call
   * (`callback(true)`, `callback(0)`) stands unconditionally in the handler's own body;
   * `conditional` when it is behind a condition, after a return, or in a nested function;
   * `never` when every call passes a literal that rejects; `unknown` when the handler or an
   * argument is not read.
   */
  accepts?: "always" | "conditional" | "never" | "unknown";
  /** For `certificate-error`: the handler calls preventDefault() on its event parameter. */
  preventsDefault?: boolean;
  /** `app`, a webContents, a session, or `unknown` (a receiver not read as one of them). */
  targetKind: "app" | "webContents" | "session" | "process" | "window" | "unknown";
  /** The receiver as written, shortened. */
  target: string;
  /** The call or write as written, shortened. */
  evidence: string;
  file: string;
  line: number;
}

/**
 * Switches that weaken a security boundary, each with the reason docs/electron-findings.md cites
 * from Electron's or Chromium's switch documentation.
 */
export const DANGEROUS_SWITCHES: ReadonlyMap<string, string> = new Map([
  ["ignore-certificate-errors", "ignores certificate related errors"],
  [
    "ignore-certificate-errors-spki-list",
    "ignores certificate errors for the listed public key hashes",
  ],
  ["allow-insecure-localhost", "ignores TLS/SSL errors on localhost"],
  ["disable-web-security", "turns off the same-origin policy"],
  ["allow-running-insecure-content", "lets HTTPS pages run scripts and styles from HTTP URLs"],
  ["no-sandbox", "turns off the Chromium sandbox for every process type"],
  ["disable-gpu-sandbox", "turns off the GPU process sandbox"],
  ["disable-site-isolation-trials", "turns off site isolation"],
  ["remote-debugging-port", "opens remote debugging over HTTP on a port"],
  ["remote-debugging-pipe", "opens remote debugging over stdio pipes"],
  ["unsafely-treat-insecure-origin-as-secure", "treats the given insecure origins as secure"],
  ["disable-setuid-sandbox", "turns off the setuid sandbox on Linux"],
  ["allow-file-access-from-files", "lets file:// URLs read other file:// URLs"],
]);
/** Chromium features whose listing in `disable-features` turns site isolation off (lowercased). */
const ISOLATION_FEATURES = new Set(["isolateorigins", "siteperprocess", "site-per-process"]);

/**
 * A switch as written, normalized for the danger check: trimmed, leading dashes stripped, split at
 * the first `=` (`"--ignore-certificate-errors=true"`). `name` keeps its case; `key` is lowercased.
 */
export function splitSwitch(raw: string): { name: string; key: string; inline: string | null } {
  const bare = raw.trim().replace(/^-+/, "");
  const eq = bare.indexOf("=");
  const name = eq < 0 ? bare : bare.slice(0, eq);
  return { name, key: name.toLowerCase(), inline: eq < 0 ? null : bare.slice(eq + 1) };
}

/**
 * Whether a switch is on the dangerous list, by its normalized name and its value. A name with
 * characters no Chromium switch has (after lowercasing: outside a-z, 0-9 and `-`) is never read as
 * safe: `dangerous: null`. `disable-features` is dangerous when its value lists an isolation
 * feature (split on commas, trimmed, compared case-insensitively); unknown when the value is not
 * read.
 */
export function judgeSwitch(
  key: string,
  valueRead: "none" | "literal" | "unknown",
  value: string | null,
): { dangerous: boolean | null; reason?: string } {
  if (!/^[a-z0-9-]+$/.test(key))
    return {
      dangerous: null,
      reason: "the switch name has characters a Chromium switch does not have",
    };
  const listed = DANGEROUS_SWITCHES.get(key);
  if (listed) return { dangerous: true, reason: listed };
  if (key !== "disable-features") return { dangerous: false };
  if (valueRead === "unknown")
    return {
      dangerous: null,
      reason:
        "the disabled features are not read; IsolateOrigins or SitePerProcess may be among them",
    };
  const off = (value ?? "")
    .split(",")
    .map((f) => f.trim())
    // `*IsolateOrigins`, `IsolateOrigins<Trial`, `IsolateOrigins:param/value` name the feature too
    .filter((f) =>
      ISOLATION_FEATURES.has(
        f
          .replace(/^\*/, "")
          .replace(/[<:].*$/, "")
          .trim()
          .toLowerCase(),
      ),
    );
  return off.length
    ? { dangerous: true, reason: `turns off site isolation features: ${off.join(", ")}` }
    : { dangerous: false };
}

/**
 * Keeps rows up to `max` so that the cap only ever drops rows known to be harmless: a row that is
 * dangerous or undecided takes the place of the last harmless one kept. True when a row was
 * dropped.
 */
export function keepSwitchRows(
  kept: SwitchRow[],
  incoming: readonly SwitchRow[],
  max: number,
): boolean {
  let dropped = false;
  for (const row of incoming) {
    if (kept.length < max) {
      kept.push(row);
      continue;
    }
    dropped = true;
    if (row.dangerous === false) continue;
    const harmless = kept.findLastIndex((r) => r.dangerous === false);
    if (harmless < 0) continue;
    kept.splice(harmless, 1);
    kept.push(row);
  }
  return dropped;
}

export const MAX_SWITCHES_PER_FILE = 200;
const MAX_PER_FILE = MAX_SWITCHES_PER_FILE;
const WORK = 2_000_000;
const LISTEN = new Set(["on", "once", "addListener", "prependListener", "prependOnceListener"]);
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
const BRANCH = new Set(["&&", "||", "??", "?", ":", "?."]);

/**
 * A numeric literal as written (`10`, `0x1f`, `1e3`): its number; null for a BigInt, a literal
 * with separators, or one that cannot be parsed, which is never read as a definite value.
 */
export function numericLiteral(raw: string): number | null {
  // a BigInt (`0n`) is no number Electron's callback takes, and a separated literal (`1_0`) is
  // not taken as written: neither gives a definite answer
  if (raw.endsWith("n") || raw.includes("_")) return null;
  const plain = raw;
  // a legacy octal (`010`) is another number than Number() reads; zero or not is the same
  const n = /^0[0-7]+$/.test(plain) ? Number.parseInt(plain, 8) : Number(plain);
  return Number.isNaN(n) ? null : n;
}

const paramName = (def: FnDef, i: number): string | null => {
  const p = def.params[i];
  return p?.kind === "name" && p.name ? p.name : null;
};

const short = (text: string): string => (text.length > 80 ? `${text.slice(0, 80)}…` : text);

export function switchRows(
  tokens: Token[],
  file: string,
  resolver: ExpressionResolver,
  constants: Constants,
): { rows: SwitchRow[]; capped: boolean } {
  const rows: SwitchRow[] = [];
  let capped = false;
  let work = WORK;
  const spend = (): boolean => --work >= 0;
  const is = (i: number, v: string): boolean =>
    tokens[i]?.type === "punct" && tokens[i]!.value === v;
  const ident = (i: number): string | null =>
    tokens[i]?.type === "ident" ? tokens[i]!.value : null;
  const dot = (i: number): boolean => is(i, ".") || is(i, "?.");
  const text = (from: number, to: number): string =>
    short(
      tokens
        // at most 80 tokens are joined: the text is cut to 80 characters anyway
        .slice(from, Math.min(to, from + 80))
        .map((x) => (x.type === "string" ? JSON.stringify(x.value) : x.value))
        .join(""),
    );
  const push = (row: SwitchRow): void => {
    // rows past the cap are still read, at the cost of reading them (charged where their tokens
    // are read), so a risky one later in the file replaces a harmless one; no extra charge, which
    // harmless padding could use to hide a dangerous call behind the budget
    if (keepSwitchRows(rows, [row], MAX_PER_FILE)) capped = true;
  };

  // webpack modules that are Electron itself: `91288(e){e.exports=require("electron")}`
  const webpackElectron = new Set<string>();
  /** Namespace imports of electron: `import * as X from "electron"`, `import X from "electron"`. */
  const importedModule = new Set<string>();
  for (let j = 0; j < tokens.length; j++) {
    const t = tokens[j]!;
    if (t.type !== "string" || t.value !== "electron") continue;
    if (is(j - 1, "(") && ident(j - 2) === "require" && is(j + 1, ")")) {
      if (is(j - 3, "=") && ident(j - 4) === "exports" && dot(j - 5))
        for (let q = j - 6; q >= 0 && q > j - 30; q--)
          if (tokens[q]!.type === "number" && (is(q + 1, ":") || is(q + 1, "("))) {
            webpackElectron.add(tokens[q]!.value);
            break;
          }
    } else if (ident(j - 1) === "from") {
      const k = j - 2;
      if (ident(k) && ident(k - 1) === "as" && is(k - 2, "*")) importedModule.add(ident(k)!);
      else if (ident(k) && ident(k - 1) === "import") importedModule.add(ident(k)!);
    }
  }

  /** The tokens [a, b) are an expression for the electron module. */
  const moduleExpr = (a: number, b: number, depth = 0): boolean => {
    let x = a;
    let y = b;
    while (is(y - 1, ";") || is(y - 1, ",")) y--;
    if (ident(x) && INTEROP.has(ident(x)!) && is(x + 1, "(")) {
      const close = resolver.closeOf(x + 1);
      if (close !== y - 1) return false;
      x += 2;
      y = is(close - 2, ",") && tokens[close - 1]?.type === "number" ? close - 2 : close;
    }
    if (
      ident(x) === "require" &&
      is(x + 1, "(") &&
      tokens[x + 2]?.type === "string" &&
      tokens[x + 2]!.value === "electron" &&
      is(x + 3, ")") &&
      x + 4 === y
    )
      return true;
    // webpack: `n(91288)` for a module id that is `require("electron")`
    if (
      ident(x) &&
      is(x + 1, "(") &&
      tokens[x + 2]?.type === "number" &&
      webpackElectron.has(tokens[x + 2]!.value) &&
      is(x + 3, ")") &&
      x + 4 === y
    )
      return true;
    // a lazy getter of it: `X()` with `X = n.cw(function (e) { e.exports = require("electron") })`
    if (ident(x) && x + 3 === y && depth < 8 && spend()) {
      const given = resolver.lazyValueAt(x);
      if (given) return moduleExpr(given[0], given[1], depth + 1);
    }
    // another name of it
    if (ident(x) && x + 1 === y) return moduleName(x, depth + 1);
    return false;
  };
  /** The name at k is bound, by scope, to the electron module. */
  const moduleName = (k: number, depth = 0): boolean => {
    const name = ident(k);
    if (!name || depth > 8 || !spend()) return false;
    if (resolver.boundAround(k, name)?.kind === "param") return false;
    if (constants.requireOf(name, k) === "electron") return true;
    const bound = resolver.binding(k, name, true);
    if (bound?.kind === "value") return moduleExpr(bound.range[0], bound.range[1], depth);
    return bound === null && importedModule.has(name);
  };
  /** The name at k is Electron's `app`: `{ app } = require("electron")`, `import { app }`, `x = electron.app`. */
  const appName = (k: number): boolean => {
    const name = ident(k);
    if (!name || !spend()) return false;
    if (resolver.boundAround(k, name)?.kind === "param") return false;
    const imported = constants.importOf(name, k);
    if (imported?.specifier === "electron" && imported.property === "app") return true;
    const bound = resolver.binding(k, name, true);
    if (bound?.kind === "pattern")
      return bound.key === "app" && moduleExpr(bound.from[0], bound.from[1]);
    if (bound?.kind === "value") {
      const [a, b0] = bound.range;
      let b = b0;
      while (is(b - 1, ";") || is(b - 1, ",")) b--;
      return appExpr(a, b);
    }
    return false;
  };
  /** The tokens [a, b) are `X.app` with X the electron module, or `require("electron").app`. */
  const appExpr = (a: number, b: number): boolean => {
    if (ident(b - 1) !== "app" || !dot(b - 2)) return false;
    if (b - 2 === a + 1 && ident(a)) return moduleName(a);
    return moduleExpr(a, b - 2);
  };
  /** The receiver ending right before the `.` at `d` is Electron's app; its first token or -1. */
  const appBefore = (d: number): number => {
    if (!ident(d - 1)) return -1;
    if (!dot(d - 2)) return appName(d - 1) ? d - 1 : -1;
    if (ident(d - 1) !== "app") return -1;
    // `X.app`, `require("electron").app`, `X().app` (a lazy getter), `(0, X.app)` is not read
    if (ident(d - 3) && !dot(d - 4)) return moduleName(d - 3) ? d - 3 : -1;
    if (is(d - 3, ")")) {
      const open = resolver.openOf(d - 3);
      if (open > 0 && ident(open - 1) && !dot(open - 2) && moduleExpr(open - 1, d - 2))
        return open - 1;
    }
    return -1;
  };
  /** The receiver ending right before the `.` at `d` is `app.commandLine`; its first token or -1. */
  const commandLineBefore = (d: number): number => {
    if (ident(d - 1) === "commandLine" && dot(d - 2)) return appBefore(d - 2);
    // `const cl = app.commandLine; cl.appendSwitch(…)`
    const name = ident(d - 1);
    if (!name || dot(d - 2) || !spend()) return -1;
    if (resolver.boundAround(d - 1, name)?.kind === "param") return -1;
    const bound = resolver.binding(d - 1, name);
    if (bound?.kind !== "value") return -1;
    let [a, b] = bound.range;
    while (is(b - 1, ";") || is(b - 1, ",")) b--;
    return ident(b - 1) === "commandLine" && dot(b - 2) && appBefore(b - 2) === a ? d - 1 : -1;
  };

  /**
   * The receiver of `.appendSwitch` ending right before the `.` (or `[`) at `d`: `app: true` when it
   * is Electron's app.commandLine; `app: false` for any other receiver (a parameter, a
   * `commandLine` of something not read, a destructured `commandLine`, a call); null only for a
   * name bound to an object literal of the file (a look-alike), or its member.
   */
  /**
   * The key `key` of the object literal at `open`: the token its value starts at, `method` for
   * `key() {}`, null when the literal does not have it, `unknown` for a spread, a computed key,
   * a shorthand or an accessor, any of which may give it another value.
   */
  const keyOf = (open: number, key: string): number | "method" | "unknown" | null => {
    const close = resolver.closeOf(open);
    if (close < 0) return "unknown";
    let found: number | "method" | null = null;
    for (let j = open + 1, d = 0; j < close; j++) {
      if (!spend()) return "unknown";
      if (is(j, "{") || is(j, "(") || is(j, "[")) {
        if (d === 0 && is(j, "[") && (is(j - 1, "{") || is(j - 1, ","))) return "unknown";
        d++;
        continue;
      }
      if (is(j, "}") || is(j, ")") || is(j, "]")) {
        d--;
        continue;
      }
      if (d !== 0 || !(is(j - 1, "{") || is(j - 1, ","))) continue;
      if (is(j, "...")) return "unknown";
      const t = tokens[j]!;
      const name = t.type === "ident" || t.type === "string" ? t.value : null;
      if (name === null) continue;
      if ((name === "get" || name === "set" || name === "async") && tokens[j + 1]?.value === key)
        return "unknown";
      if (name !== key) continue;
      if (is(j + 1, ":")) found = j + 2;
      else if (is(j + 1, "(")) found = "method";
      else return "unknown";
    }
    return found;
  };
  /** The receiver from `from` to `d` walks object literals from the one at `open` to its own method. */
  const ownMethod = (open: number, from: number, d: number, method: string): boolean => {
    let cur = open;
    for (let j = from + 2; j < d; j += 2) {
      const v = keyOf(cur, ident(j)!);
      if (typeof v !== "number" || !is(v, "{")) return false;
      cur = v;
    }
    const m = keyOf(cur, method);
    if (m === "method") return true;
    if (typeof m !== "number") return false;
    return (
      ident(m) === "function" ||
      (ident(m) === "async" && ident(m + 1) === "function") ||
      resolver.functionWithParamsAt(m) !== null
    );
  };
  const switchReceiver = (d: number, method: string): { from: number; app: boolean } | null => {
    const proven = commandLineBefore(d);
    if (proven >= 0) return { from: proven, app: true };
    if (!ident(d - 1)) return { from: d - 1, app: false };
    let from = d - 1;
    while (dot(from - 1) && ident(from - 2)) from -= 2;
    const base = ident(from)!;
    if (base === "this" || !spend()) return { from, app: false };
    if (resolver.boundAround(from, base)?.kind === "param") return { from, app: false };
    const bound = resolver.binding(from, base, true);
    // an object literal of the file: no row only when the path through it ends at its own
    // `appendSwitch` function (a look-alike); a member it takes from elsewhere
    // (`{ commandLine: app.commandLine }`), a spread or a computed key may be app's
    if (bound?.kind === "value" && is(bound.range[0], "{"))
      return ownMethod(bound.range[0], from, d, method) ? null : { from, app: false };
    if (bound?.kind === "pattern" && bound.key === "commandLine" && from === d - 1) {
      // `const { commandLine } = app`, `const { app: { commandLine } } = require("electron")`
      let [a, b] = bound.from;
      while (is(b - 1, ";") || is(b - 1, ",")) b--;
      if (appExpr(a, b) || (b === a + 1 && appName(a)) || moduleExpr(a, b))
        return { from, app: true };
    }
    return { from, app: false };
  };

  /** A literal or constant string at [a, b), else null. */
  const stringAt = (a: number, b: number): string | null => {
    if (b === a + 1 && tokens[a]!.type === "string") return tokens[a]!.value;
    if (b === a + 1 && tokens[a]!.type === "template" && !tokens[a]!.value.includes("${"))
      return tokens[a]!.value;
    if (!spend()) return null;
    const v = resolver.valueAt(a);
    if (v?.kind === "str" && v.values.length === 1 && exprEnd(a) === b) return v.values[0]!;
    return null;
  };
  /**
   * The end of the argument starting at a: the `,` or `)` at depth 0; -1 when it is not found
   * within 4,000 tokens or the budget runs out (then the argument is not read, and the file's
   * reading is marked capped).
   */
  const exprEnd = (a: number): number => {
    let j = a;
    for (let d = 0; j < tokens.length && j < a + 4000; j++) {
      if (--work < 0) {
        capped = true;
        return -1;
      }
      const p = tokens[j]!;
      if (p.type !== "punct") continue;
      if (p.value === "(" || p.value === "[" || p.value === "{") d++;
      else if (p.value === ")" || p.value === "]" || p.value === "}") {
        if (d === 0) return j;
        d--;
      } else if (p.value === "," && d === 0) return j;
    }
    return -1;
  };

  /**
   * How the handler `def` uses its parameter `param` (the callback): whether a call passing an
   * accepting literal stands unconditionally in its body.
   */
  const acceptsIn = (
    def: FnDef,
    param: string,
    accepting: (a: number, b: number) => boolean | null,
  ): NonNullable<SwitchRow["accepts"]> => {
    const [b0, b1] = def.body;
    let always = false;
    let conditional = false;
    let unread = false;
    let returned = false;
    for (let j = b0; j <= b1 && j < tokens.length; j++) {
      if (!spend()) return "unknown";
      if ((ident(j) === "return" || ident(j) === "throw") && resolver.functionAt(j) === def)
        returned = true;
      if (ident(j) !== param || dot(j - 1) || is(j + 1, ":")) continue;
      // the handler's own parameter, not one of a nested function of the same name
      let owner = resolver.functionAt(j);
      while (
        owner &&
        owner !== def &&
        !owner.params.some((p) => p.kind === "name" && p.name === param)
      )
        owner = resolver.outerOf(owner);
      if (owner !== def) continue;
      if (!is(j + 1, "(")) {
        // handed on, stored or tested: what happens to it is not read
        unread = true;
        continue;
      }
      const close = resolver.closeOf(j + 1);
      if (close < 0) {
        unread = true;
        continue;
      }
      const end = exprEnd(j + 2);
      if (end < 0) {
        unread = true;
        continue;
      }
      const verdict = accepting(j + 2, Math.min(end, close));
      if (verdict === null) unread = true;
      if (verdict !== true) continue;
      if (returned || resolver.functionAt(j) !== def || !statementLevel(def, j)) conditional = true;
      else always = true;
    }
    return always ? "always" : conditional ? "conditional" : unread ? "unknown" : "never";
  };
  /** The call at j stands at the top of the body of `def`, behind no condition. */
  const statementLevel = (def: FnDef, j: number): boolean => {
    const [b0] = def.body;
    // directly in the body block (or the expression body), not in a nested block or argument
    const around = resolver.bracketAround(j);
    if (def.block ? around !== b0 : around >= b0) return false;
    let d = 0;
    for (let q = j - 1; q > b0 || (!def.block && q === b0); q--) {
      const p = tokens[q]!;
      if (p.type === "punct") {
        if (d === 0 && (p.value === ";" || p.value === "}")) return true;
        if (p.value === ")" || p.value === "]" || p.value === "}") d++;
        else if (p.value === "(" || p.value === "[" || p.value === "{") d--;
        else if (d === 0 && BRANCH.has(p.value)) return false;
      } else if (d === 0 && p.type === "ident" && CONDITIONS.has(p.value)) return false;
    }
    return true;
  };
  /** The handler written at k (a function literal); null when it is something else. */
  /**
   * The plain name of parameter `index` of `def`, read from its tokens; `absent` only when every
   * parameter is a plain name, there are fewer than index + 1 of them, and the body never reads
   * `arguments` (so the callback cannot be reached). Null for anything else: a rest parameter, a
   * pattern or a default up to the index, or a short list with `arguments` in the body.
   */
  const callbackParam = (def: FnDef, index: number): string | "absent" | null => {
    const segments: number[][] = [];
    if (ident(def.paramsAt) && !is(def.paramsAt, "(")) segments.push([def.paramsAt]);
    else if (is(def.paramsAt, "(")) {
      const close = resolver.closeOf(def.paramsAt);
      if (close < 0) return null;
      let current: number[] = [];
      for (let j = def.paramsAt + 1, d = 0; j < close; j++) {
        if (is(j, "(") || is(j, "[") || is(j, "{")) d++;
        else if (is(j, ")") || is(j, "]") || is(j, "}")) d--;
        if (d === 0 && is(j, ",")) {
          segments.push(current);
          current = [];
        } else current.push(j);
      }
      if (current.length) segments.push(current);
    } else return null;
    // a rest parameter at or before the index moves every position after it
    const rest = (seg: number[] | undefined): boolean => seg !== undefined && is(seg[0]!, "...");
    for (let i = 0; i < Math.min(index + 1, segments.length); i++)
      if (rest(segments[i])) return null;
    if (segments.length > index) {
      // `cb` or `cb = fallback`; a pattern at the index is not read
      const seg = segments[index]!;
      const name = ident(seg[0]!);
      return name !== null && (seg.length === 1 || is(seg[1]!, "=")) ? name : null;
    }
    if (segments.some(rest)) return null;
    for (let j = def.body[0]; j <= def.body[1] && j < tokens.length; j++)
      if (ident(j) === "arguments" && !dot(j - 1)) return null;
    return "absent";
  };
  const handlerAt = (k: number): FnDef | null => {
    let j = k;
    // `((e, t) => …)`, as minifiers wrap a function argument
    while (is(j, "(") && is(j + 1, "(") && !resolver.functionWithParamsAt(j) && j < k + 4) j++;
    if (ident(j) === "async") j++;
    if (ident(j) === "function") {
      j++;
      if (ident(j)) j++;
    }
    return resolver.functionWithParamsAt(j);
  };
  /** A number literal or `-literal` at [x, y): its number; null otherwise (a BigInt too). */
  const signedNumber = (x: number, y: number): number | null => {
    const at = y === x + 2 && is(x, "-") ? x + 1 : y === x + 1 ? x : -1;
    if (at < 0 || tokens[at]!.type !== "number") return null;
    const n = numericLiteral(tokens[at]!.value);
    if (n === null) return null;
    return at === x ? n : -n;
  };
  const numberAt = (a: number, b: number): number | null => {
    const direct = signedNumber(a, b);
    if (direct !== null) return direct;
    if (b === a + 1 && ident(a)) {
      const bound = resolver.binding(a, ident(a)!);
      if (bound?.kind === "value") {
        let [x, y] = bound.range;
        while (is(y - 1, ";") || is(y - 1, ",")) y--;
        return signedNumber(x, y);
      }
    }
    return null;
  };
  /** Whether the argument at [a, b) is truthy, as Electron takes it; null when not read. */
  const boolAt = (a: number, b: number, depth = 0): boolean | null => {
    if (b === a + 1 && (ident(a) === "true" || ident(a) === "false")) return ident(a) === "true";
    if (b === a + 1 && (ident(a) === "null" || ident(a) === "undefined")) return false;
    // `!0`, `!1`, `1`, `0n`: what the literal is as a number or bigint; unparsable is not read
    const numeric = (at: number): boolean | null => {
      const n = numericLiteral(tokens[at]!.value);
      return n === null ? null : n !== 0;
    };
    if (b === a + 2 && is(a, "!") && tokens[a + 1]?.type === "number") {
      const v = numeric(a + 1);
      return v === null ? null : !v;
    }
    if (b === a + 1 && tokens[a]!.type === "number") return numeric(a);
    if (b === a + 1 && tokens[a]!.type === "string") return tokens[a]!.value !== "";
    // a constant: `const OK = true`
    if (b === a + 1 && ident(a) && depth < 3 && spend()) {
      const bound = resolver.binding(a, ident(a)!);
      if (bound?.kind === "value") {
        let [x, y] = bound.range;
        while (is(y - 1, ";") || is(y - 1, ",")) y--;
        return boolAt(x, y, depth + 1);
      }
    }
    return null;
  };

  for (let k = 1; k + 2 < tokens.length; k++) {
    const t = tokens[k]!;
    // `x["appendSwitch"](…)`
    const bracketed = t.type === "string" && is(k - 1, "[");
    if (t.type !== "ident" && !bracketed) continue;
    if (work <= 0) {
      // the budget of the reading below is spent: further calls are not read, which is said
      capped = true;
      break;
    }
    const method = t.value;
    // app.commandLine.appendSwitch(name[, value]) / appendArgument(arg), also
    // `app.commandLine["appendSwitch"](…)`
    if (
      (method === "appendSwitch" || method === "appendArgument") &&
      (bracketed || dot(k - 1)) &&
      is(k + 1, bracketed ? "]" : "(") &&
      (!bracketed || is(k + 2, "("))
    ) {
      const open = bracketed ? k + 2 : k + 1;
      const receiver = switchReceiver(k - 1, method);
      if (receiver === null) continue;
      const { from, app } = receiver;
      const close = resolver.closeOf(open);
      if (close < 0) continue;
      const where = app
        ? { targetKind: "app" as const, target: "app.commandLine" }
        : { targetKind: "unknown" as const, target: text(from, k - 1) };
      /** A switch on a receiver not read as app.commandLine: its danger is not known either. */
      const unsure = (j: {
        dangerous: boolean | null;
        reason?: string;
      }): { dangerous: boolean | null; reason?: string } =>
        app || j.dangerous !== true
          ? { dangerous: j.dangerous, ...(j.reason ? { reason: j.reason } : {}) }
          : {
              dangerous: null,
              reason: `${j.reason ?? "a dangerous switch"}, on a receiver not read as Electron's app.commandLine`,
            };
      const nameEnd = exprEnd(open + 1);
      // an argument whose end was not found is not read: never a value read from a cut range
      const raw = nameEnd > open + 1 ? stringAt(open + 1, nameEnd) : null;
      const split = raw === null ? null : splitSwitch(raw);
      const evidence = `${text(from, open + 1)}${text(open + 1, close)})`;
      if (method === "appendArgument") {
        // a positional argument (no leading dash) is no switch
        const sw = split !== null && raw!.trim().startsWith("-") ? split : null;
        const judged =
          raw === null
            ? { dangerous: null, reason: "the argument is not read" }
            : sw === null
              ? { dangerous: false }
              : judgeSwitch(sw.key, sw.inline === null ? "none" : "literal", sw.inline);
        push({
          kind: "argument",
          name: raw,
          value: null,
          ...unsure(judged),
          ...where,
          evidence,
          file,
          line: t.line,
        });
        continue;
      }
      let value: string | null = split?.inline ?? null;
      let valueRead: NonNullable<SwitchRow["valueRead"]> = value === null ? "none" : "literal";
      if (nameEnd < 0) {
        value = null;
        valueRead = "unknown";
      } else if (is(nameEnd, ",") && nameEnd + 1 < close) {
        const end = exprEnd(nameEnd + 1);
        value = end < 0 ? null : stringAt(nameEnd + 1, end);
        valueRead = value === null ? "unknown" : "literal";
      }
      const judged =
        split === null
          ? { dangerous: null, reason: "the switch name is not read" }
          : judgeSwitch(split.key, valueRead, value);
      push({
        kind: "switch",
        name: split === null ? null : split.name,
        value,
        valueRead,
        ...unsure(judged),
        ...where,
        evidence,
        file,
        line: t.line,
      });
      continue;
    }
    // X.on("certificate-error", (event, webContents, url, error, certificate, callback) => …)
    if (
      LISTEN.has(method) &&
      dot(k - 1) &&
      is(k + 1, "(") &&
      tokens[k + 2]?.type === "string" &&
      tokens[k + 2]!.value === "certificate-error" &&
      is(k + 3, ",")
    ) {
      let from = k - 2;
      while (ident(from) && dot(from - 1) && ident(from - 2)) from -= 2;
      const chain = tokens
        .slice(from, k - 1)
        .map((x) => x.value)
        .join("");
      const app = appBefore(k - 1) >= 0;
      const contents = !app && /(^|\.)webContents$|^contents$/.test(chain);
      const def = handlerAt(k + 4);
      // app's callback is the sixth parameter, a webContents' the fifth; for a receiver that is
      // neither as far as it is read, both are asked and the less safe answer is kept
      const indices = app ? [5] : contents ? [4] : [5, 4];
      const ev = def ? paramName(def, 0) : null;
      const answers = indices.map((index): NonNullable<SwitchRow["accepts"]> => {
        if (!def) return "unknown";
        const cb = callbackParam(def, index);
        if (cb === "absent") return "never";
        if (cb === null) return "unknown";
        return acceptsIn(def, cb, (a, b) => boolAt(a, b));
      });
      const accepts = (["always", "conditional", "unknown", "never"] as const).find((x) =>
        answers.includes(x),
      )!;
      const index = indices.length === 1 ? indices[0]! : -1;
      // a handler that never accepts (callback(false), or no callback at all) gives no row
      if (accepts === "never") continue;
      let preventsDefault = false;
      if (def && ev)
        for (let j = def.body[0]; j <= def.body[1] && j + 3 < tokens.length; j++)
          if (ident(j) === ev && dot(j + 1) && ident(j + 2) === "preventDefault" && is(j + 3, "("))
            preventsDefault = true;
      push({
        kind: "certificate-error",
        name: null,
        value: null,
        dangerous: accepts === "unknown" ? null : true,
        reason:
          accepts === "always"
            ? "every certificate error is accepted"
            : accepts === "conditional"
              ? "certificate errors are accepted under a condition"
              : !def
                ? "the handler is not a function written here"
                : index < 0
                  ? "the receiver is not read as app or a webContents"
                  : "what the handler passes to its callback is not read",
        accepts,
        preventsDefault,
        targetKind: app ? "app" : contents ? "webContents" : "unknown",
        target: short(chain),
        evidence: `${text(from, k + 4)}…)`,
        file,
        line: t.line,
      });
      continue;
    }
    // ses.setCertificateVerifyProc((request, callback) => …)
    if (method === "setCertificateVerifyProc" && dot(k - 1) && is(k + 1, "(")) {
      let from = k - 2;
      while (ident(from) && dot(from - 1) && ident(from - 2)) from -= 2;
      if (!ident(from)) from = k - 1;
      const def = is(k + 2, ")") ? null : handlerAt(k + 2);
      const cbParam = def ? callbackParam(def, 1) : null;
      const cb = cbParam === "absent" ? null : cbParam;
      const cleared = is(k + 2, ")") || ident(k + 2) === "null";
      if (cleared) continue;
      const accepts: NonNullable<SwitchRow["accepts"]> =
        def && cb !== null
          ? acceptsIn(def, cb, (a, b) => {
              const n = numberAt(a, b);
              return n === null ? null : n === 0;
            })
          : "unknown";
      push({
        kind: "certificate-verify-proc",
        name: null,
        value: null,
        dangerous: accepts === "unknown" ? null : accepts !== "never",
        reason:
          accepts === "always"
            ? "the proc reports success (0) for every certificate, which also turns off Certificate Transparency checks"
            : accepts === "conditional"
              ? "the proc reports success (0) under a condition"
              : accepts === "never"
                ? "the proc passes only failure or Chromium's result"
                : "what the proc passes to its callback is not read",
        accepts,
        targetKind: "session",
        target: text(from, k - 1),
        evidence: `${text(from, k + 2)}…)`,
        file,
        line: t.line,
      });
      continue;
    }
    // process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = …, window.ELECTRON_DISABLE_SECURITY_WARNINGS = …
    if (method === "ELECTRON_DISABLE_SECURITY_WARNINGS" && is(k - 1, ".")) {
      let at = k + 1;
      if (!(tokens[at]?.type === "punct" && ASSIGNMENT_OPERATORS.has(tokens[at]!.value))) continue;
      const env = ident(k - 2) === "env" && is(k - 3, ".") && ident(k - 4) === "process";
      const global = ["window", "globalThis", "self"].includes(ident(k - 2) ?? "") && !dot(k - 3);
      if (!env && !global) continue;
      if (env && dot(k - 5)) continue;
      at++;
      const end = statementEnd(at);
      const b = end < 0 ? null : boolAt(at, end);
      const s = end < 0 ? null : b === null ? stringAt(at, end) : String(b);
      push({
        kind: "security-warnings",
        name: "ELECTRON_DISABLE_SECURITY_WARNINGS",
        value: s,
        valueRead: s === null ? "unknown" : "literal",
        dangerous: false,
        reason: "turns off Electron's security warnings in the developer console",
        targetKind: env ? "process" : "window",
        target: env ? "process.env" : ident(k - 2)!,
        evidence: text(env ? k - 4 : k - 2, end < 0 ? at + 6 : Math.min(end, at + 6)),
        file,
        line: t.line,
      });
    }
  }
  // `process.env["ELECTRON_DISABLE_SECURITY_WARNINGS"] = …`
  for (let k = 4; k + 2 < tokens.length; k++) {
    const t = tokens[k]!;
    if (t.type !== "string" || t.value !== "ELECTRON_DISABLE_SECURITY_WARNINGS") continue;
    if (work <= 0) {
      capped = true;
      break;
    }
    if (!(is(k - 1, "[") && is(k + 1, "]") && is(k + 2, "="))) continue;
    if (!(ident(k - 2) === "env" && is(k - 3, ".") && ident(k - 4) === "process")) continue;
    const end = statementEnd(k + 3);
    const b = end < 0 ? null : boolAt(k + 3, end);
    const s = end < 0 ? null : b === null ? stringAt(k + 3, end) : String(b);
    push({
      kind: "security-warnings",
      name: "ELECTRON_DISABLE_SECURITY_WARNINGS",
      value: s,
      valueRead: s === null ? "unknown" : "literal",
      dangerous: false,
      reason: "turns off Electron's security warnings in the developer console",
      targetKind: "process",
      target: "process.env",
      evidence: text(k - 4, end < 0 ? k + 8 : Math.min(end, k + 8)),
      file,
      line: t.line,
    });
  }
  // a budget used up anywhere is said, never read as nothing found
  if (work < 0) capped = true;
  return { rows, capped };

  /** The end of the value assigned from a: the `;`, `,` or closing bracket at depth 0. */
  function statementEnd(a: number): number {
    let j = a;
    for (let d = 0; j < tokens.length && j < a + 2000; j++) {
      if (--work < 0) {
        capped = true;
        return -1;
      }
      const p = tokens[j]!;
      if (p.type !== "punct") continue;
      if (p.value === "(" || p.value === "[" || p.value === "{") d++;
      else if (p.value === ")" || p.value === "]" || p.value === "}") {
        if (d === 0) return j;
        d--;
      } else if (d === 0 && (p.value === ";" || p.value === ",")) return j;
    }
    return -1;
  }
}

/**
 * Electron's command-line switches in `package.json` scripts (Electronegativity's
 * CUSTOM_ARGUMENTS_JSON_CHECK and SECURITY_WARNINGS_DISABLED_JSON_CHECK): a `--switch` after an
 * `electron` command word in a script, and an `ELECTRON_DISABLE_SECURITY_WARNINGS=…` assignment.
 * Rows are `switch` / `security-warnings` rows of `package.json` (target `scripts.<name>`), judged
 * as the code's switches are. A script is text a developer runs, not code of the shipped app: the
 * rows say what the app is started with when that script runs. Nothing is run.
 */
export function scriptSwitchRows(text: string): SwitchRow[] {
  let scripts: unknown;
  try {
    scripts = (JSON.parse(text) as { scripts?: unknown }).scripts;
  } catch {
    return [];
  }
  if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) return [];
  const rows: SwitchRow[] = [];
  for (const [name, command] of Object.entries(scripts as Record<string, unknown>)) {
    if (typeof command !== "string" || rows.length >= MAX_SWITCHES_PER_FILE) continue;
    // the line of the script's key, for the place; 1 when it cannot be found
    const at = text.indexOf(JSON.stringify(name));
    const line = at < 0 ? 1 : text.slice(0, at).split("\n").length;
    const target = `scripts.${name}`;
    const evidence = `${name}: ${command.length > 120 ? `${command.slice(0, 120)}…` : command}`;
    // commands split at `&&`, `||`, `;` and `|`; words at whitespace, quotes dropped
    for (const part of command.split(/&&|\|\||;|\|/)) {
      const words =
        part.match(/"[^"]*"|'[^']*'|\S+/g)?.map((w) => w.replace(/^["']|["']$/g, "")) ?? [];
      for (const word of words) {
        const env = /^ELECTRON_DISABLE_SECURITY_WARNINGS=(.*)$/.exec(word);
        if (env)
          rows.push({
            kind: "security-warnings",
            name: "ELECTRON_DISABLE_SECURITY_WARNINGS",
            value: env[1]!,
            valueRead: "literal",
            dangerous: false,
            reason: "turns off Electron's security warnings in the developer console",
            targetKind: "process",
            target,
            evidence,
            file: "package.json",
            line,
          });
      }
      const start = words.findIndex((w) => /(^|[\\/])electron(\.exe|\.cmd)?$/i.test(w));
      if (start < 0) continue;
      for (const word of words.slice(start + 1)) {
        if (!word.startsWith("-") || word === "--") continue;
        const { name: switchName, key, inline } = splitSwitch(word);
        if (!switchName) continue;
        const valueRead = inline === null ? "none" : "literal";
        rows.push({
          kind: "switch",
          name: switchName,
          value: inline,
          valueRead,
          ...judgeSwitch(key, valueRead, inline),
          targetKind: "process",
          target,
          evidence,
          file: "package.json",
          line,
        });
      }
    }
  }
  return rows;
}
