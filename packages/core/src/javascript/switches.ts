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
]);
/** Chromium features whose listing in `disable-features` turns site isolation off. */
const ISOLATION_FEATURES = new Set(["IsolateOrigins", "SitePerProcess", "site-per-process"]);

export const MAX_SWITCHES_PER_FILE = 200;
const MAX_PER_FILE = MAX_SWITCHES_PER_FILE;
const WORK = 400_000;
const LISTEN = new Set(["on", "once", "addListener", "prependListener"]);
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

const paramName = (def: FnDef, i: number): string | null => {
  const p = def.params[i];
  return p?.kind === "name" ? p.name : null;
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
        .slice(from, to)
        .map((x) => (x.type === "string" ? JSON.stringify(x.value) : x.value))
        .join(""),
    );
  const push = (row: SwitchRow): void => {
    if (rows.length >= MAX_PER_FILE) capped = true;
    else rows.push(row);
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
  const moduleExpr = (a: number, b: number): boolean => {
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
    // another name of it
    if (ident(x) && x + 1 === y) return moduleName(x, 1);
    return false;
  };
  /** The name at k is bound, by scope, to the electron module. */
  const moduleName = (k: number, depth = 0): boolean => {
    const name = ident(k);
    if (!name || depth > 3 || !spend()) return false;
    if (resolver.boundAround(k, name)?.kind === "param") return false;
    if (constants.requireOf(name, k) === "electron") return true;
    const bound = resolver.binding(k, name, true);
    if (bound?.kind === "value") return moduleExpr(bound.range[0], bound.range[1]);
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
    // `X.app`, `require("electron").app`, `(0, X.app)` is not read
    if (ident(d - 3) && !dot(d - 4)) return moduleName(d - 3) ? d - 3 : -1;
    if (is(d - 3, ")")) {
      const open = resolver.openOf(d - 3);
      if (open > 0 && ident(open - 1) === "require" && moduleExpr(open - 1, d - 2)) return open - 1;
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
  /** The end of the argument starting at a: the `,` or `)` at depth 0. */
  const exprEnd = (a: number): number => {
    let j = a;
    for (let d = 0; j < tokens.length && j < a + 4000; j++) {
      const p = tokens[j]!;
      if (p.type !== "punct") continue;
      if (p.value === "(" || p.value === "[" || p.value === "{") d++;
      else if (p.value === ")" || p.value === "]" || p.value === "}") {
        if (d === 0) return j;
        d--;
      } else if (p.value === "," && d === 0) return j;
    }
    return j;
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
  const numberAt = (a: number, b: number): number | null => {
    if (b === a + 1 && tokens[a]!.type === "number") return Number(tokens[a]!.value);
    if (b === a + 2 && is(a, "-") && tokens[a + 1]!.type === "number")
      return -Number(tokens[a + 1]!.value);
    if (b === a + 1 && ident(a)) {
      const bound = resolver.binding(a, ident(a)!);
      if (bound?.kind === "value") {
        let [x, y] = bound.range;
        while (is(y - 1, ";") || is(y - 1, ",")) y--;
        if (y === x + 1 && tokens[x]!.type === "number") return Number(tokens[x]!.value);
        if (y === x + 2 && is(x, "-") && tokens[x + 1]!.type === "number")
          return -Number(tokens[x + 1]!.value);
      }
    }
    return null;
  };
  const boolAt = (a: number, b: number): boolean | null => {
    if (b === a + 1 && (ident(a) === "true" || ident(a) === "false")) return ident(a) === "true";
    if (b === a + 2 && is(a, "!") && tokens[a + 1]?.type === "number")
      return tokens[a + 1]!.value === "0";
    return null;
  };

  for (let k = 1; k + 2 < tokens.length; k++) {
    const t = tokens[k]!;
    if (t.type !== "ident") continue;
    if (work <= 0) {
      // the budget of the reading below is spent: further calls are not read, which is said
      capped = true;
      break;
    }
    const method = t.value;
    // app.commandLine.appendSwitch(name[, value]) / appendArgument(arg)
    if (
      (method === "appendSwitch" || method === "appendArgument") &&
      dot(k - 1) &&
      is(k + 1, "(")
    ) {
      const from = commandLineBefore(k - 1);
      if (from < 0) continue;
      const close = resolver.closeOf(k + 1);
      if (close < 0) continue;
      const nameEnd = exprEnd(k + 2);
      const raw = nameEnd > k + 2 ? stringAt(k + 2, nameEnd) : null;
      const name = raw === null ? null : raw.replace(/^-+/, "");
      const evidence = `${text(from, k + 2)}${text(k + 2, close)})`;
      if (method === "appendArgument") {
        const sw = name !== null && raw!.startsWith("-") ? name.split("=")[0]! : null;
        const reason = sw !== null ? DANGEROUS_SWITCHES.get(sw) : undefined;
        push({
          kind: "argument",
          name: raw,
          value: null,
          dangerous: raw === null ? null : reason !== undefined,
          ...(reason ? { reason } : raw === null ? { reason: "the argument is not read" } : {}),
          targetKind: "app",
          target: "app.commandLine",
          evidence,
          file,
          line: t.line,
        });
        continue;
      }
      let value: string | null = null;
      let valueRead: NonNullable<SwitchRow["valueRead"]> = "none";
      if (is(nameEnd, ",") && nameEnd + 1 < close) {
        const end = exprEnd(nameEnd + 1);
        value = stringAt(nameEnd + 1, end);
        valueRead = value === null ? "unknown" : "literal";
      }
      let dangerous: boolean | null = null;
      let reason: string | undefined = name === null ? "the switch name is not read" : undefined;
      if (name !== null) {
        reason = DANGEROUS_SWITCHES.get(name);
        dangerous = reason !== undefined;
        if (name === "disable-features") {
          if (valueRead === "literal") {
            const off = value!.split(",").filter((f) => ISOLATION_FEATURES.has(f.trim()));
            dangerous = off.length > 0;
            if (off.length) reason = `turns off site isolation features: ${off.join(", ")}`;
          } else if (valueRead === "unknown") {
            dangerous = null;
            reason =
              "the disabled features are not read; IsolateOrigins or SitePerProcess may be among them";
          }
        }
      }
      push({
        kind: "switch",
        name,
        value,
        valueRead,
        dangerous,
        ...(reason ? { reason } : {}),
        targetKind: "app",
        target: "app.commandLine",
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
        const cb = paramName(def, index);
        if (cb === null) return def.params.length > index ? "unknown" : "never";
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
      const cb = def ? paramName(def, 1) : null;
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
      const b = boolAt(at, end);
      const s = b === null ? stringAt(at, end) : String(b);
      push({
        kind: "security-warnings",
        name: "ELECTRON_DISABLE_SECURITY_WARNINGS",
        value: s,
        valueRead: s === null ? "unknown" : "literal",
        dangerous: false,
        reason: "turns off Electron's security warnings in the developer console",
        targetKind: env ? "process" : "window",
        target: env ? "process.env" : ident(k - 2)!,
        evidence: text(env ? k - 4 : k - 2, Math.min(end, at + 6)),
        file,
        line: t.line,
      });
    }
  }
  // `process.env["ELECTRON_DISABLE_SECURITY_WARNINGS"] = …`
  for (let k = 4; k + 2 < tokens.length; k++) {
    const t = tokens[k]!;
    if (t.type !== "string" || t.value !== "ELECTRON_DISABLE_SECURITY_WARNINGS") continue;
    if (!(is(k - 1, "[") && is(k + 1, "]") && is(k + 2, "="))) continue;
    if (!(ident(k - 2) === "env" && is(k - 3, ".") && ident(k - 4) === "process")) continue;
    const end = statementEnd(k + 3);
    const b = boolAt(k + 3, end);
    const s = b === null ? stringAt(k + 3, end) : String(b);
    push({
      kind: "security-warnings",
      name: "ELECTRON_DISABLE_SECURITY_WARNINGS",
      value: s,
      valueRead: s === null ? "unknown" : "literal",
      dangerous: false,
      reason: "turns off Electron's security warnings in the developer console",
      targetKind: "process",
      target: "process.env",
      evidence: text(k - 4, Math.min(end, k + 8)),
      file,
      line: t.line,
    });
  }
  return { rows, capped };

  /** The end of the value assigned from a: the `;`, `,` or closing bracket at depth 0. */
  function statementEnd(a: number): number {
    let j = a;
    for (let d = 0; j < tokens.length && j < a + 2000; j++) {
      const p = tokens[j]!;
      if (p.type !== "punct") continue;
      if (p.value === "(" || p.value === "[" || p.value === "{") d++;
      else if (p.value === ")" || p.value === "]" || p.value === "}") {
        if (d === 0) return j;
        d--;
      } else if (d === 0 && (p.value === ";" || p.value === ",")) return j;
    }
    return j;
  }
}
