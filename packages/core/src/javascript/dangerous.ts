/**
 * Calls that run code or styles in a page, the `dangerousCalls` collection:
 * `executeJavaScript(code)`, `executeJavaScriptInIsolatedWorld(worldId, [{ code }])` and
 * `insertCSS(css)` of a webContents, a frame or `webFrame`, with whether the code is a literal
 * (Electronegativity's DANGEROUS_FUNCTIONS_JS_CHECK). A literal is the app's own code; anything
 * else may carry text from a page, a message or a file into the page's scripts. Whether the code
 * escapes what it builds in is not read. Nothing is run.
 */
import type { Constants } from "./aliases.js";
import type { ExpressionResolver } from "./resolve.js";
import type { Token } from "./scan.js";
import { FileReader, keepRows, MAX_SECURITY_ROWS_PER_FILE, short } from "./security.js";

export interface DangerousCallRow {
  method: "executeJavaScript" | "executeJavaScriptInIsolatedWorld" | "insertCSS";
  /**
   * `webContents`: the receiver is `X.webContents`; `frame`: `X.mainFrame` / `X.focusedFrame` (a
   * WebFrameMain); `webFrame`: Electron's renderer `webFrame` by scope; `unknown`: any other
   * receiver (a parameter, a `<webview>` element, a name not read).
   */
  targetKind: "webContents" | "frame" | "webFrame" | "unknown";
  /** The receiver as written, shortened. */
  target: string;
  /**
   * `literal`: the code is one string read whole (for an isolated world: every source's `code`);
   * `inferred`: only its start is read (a template or a concatenation that begins with a
   * literal); `unknown`: nothing of it is read.
   */
  argumentKind: "literal" | "inferred" | "unknown";
  /** The code (literal, shortened) or its known start (inferred); null when unknown. */
  argument: string | null;
  evidence: string;
  file: string;
  line: number;
}

const METHODS = new Set(["executeJavaScript", "executeJavaScriptInIsolatedWorld", "insertCSS"]);

/** A dangerousCalls row the cap may drop: one whose code is a literal. */
export const harmlessDangerousCall = (r: DangerousCallRow): boolean => r.argumentKind === "literal";

/** executeJavaScript, executeJavaScriptInIsolatedWorld and insertCSS calls of a file. */
export function dangerousCallRows(
  tokens: Token[],
  file: string,
  resolver: ExpressionResolver,
  constants: Constants,
): { rows: DangerousCallRow[]; capped: boolean } {
  const r = new FileReader(tokens, resolver, constants);
  const rows: DangerousCallRow[] = [];
  let capped = false;
  const push = (row: DangerousCallRow): void => {
    if (keepRows(rows, [row], MAX_SECURITY_ROWS_PER_FILE, harmlessDangerousCall)) capped = true;
  };

  /** What is known of the code at [a, b). */
  const code = (a: number, b: number): Pick<DangerousCallRow, "argumentKind" | "argument"> => {
    const unknown = { argumentKind: "unknown" as const, argument: null };
    if (b <= a) return unknown;
    const whole = r.stringAt(a, b);
    if (whole !== null) return { argumentKind: "literal", argument: short(whole) };
    const t = tokens[a]!;
    // `\`foo(${x})\``: the part before the first substitution
    if (t.type === "template" && t.value.endsWith("${…}"))
      return { argumentKind: "inferred", argument: short(t.value.slice(0, -"${…}".length)) };
    // `"foo(" + x + ")"`
    if (t.type === "string" && r.is(a + 1, "+"))
      return { argumentKind: "inferred", argument: short(t.value) };
    return unknown;
  };

  /** The sources of `[{ code }, …]` at [a, b): literal when every `code` is one. */
  const sources = (a: number, b: number): Pick<DangerousCallRow, "argumentKind" | "argument"> => {
    const unknown = { argumentKind: "unknown" as const, argument: null };
    if (!r.is(a, "[") || resolver.closeOf(a) !== b - 1) return unknown;
    const codes: string[] = [];
    let inferred: string | null = null;
    for (let j = a + 1; j < b - 1;) {
      if (!r.spend()) return unknown;
      const end = r.exprEnd(j);
      if (end < 0 || !r.is(j, "{") || resolver.closeOf(j) !== end - 1) return unknown;
      const at = r.keyOf(j, "code");
      if (typeof at !== "number") return unknown;
      const stop = r.exprEnd(at);
      const one = stop < 0 ? unknown : code(at, stop);
      if (one.argumentKind === "unknown") return unknown;
      if (one.argumentKind === "inferred") inferred ??= one.argument;
      else codes.push(one.argument!);
      if (end >= b - 1) break;
      j = end + 1;
    }
    if (inferred !== null) return { argumentKind: "inferred", argument: inferred };
    return codes.length
      ? { argumentKind: "literal", argument: short(codes.join("\n")) }
      : { argumentKind: "literal", argument: "" };
  };

  for (let k = 1; k + 1 < tokens.length; k++) {
    const t = tokens[k]!;
    const bracketed = t.type === "string" && r.is(k - 1, "[") && r.is(k + 1, "]");
    if ((t.type !== "ident" && !bracketed) || !METHODS.has(t.value)) continue;
    if (!(bracketed || r.dot(k - 1))) continue;
    if (r.work <= 0) {
      capped = true;
      break;
    }
    const after = bracketed ? k + 2 : k + 1;
    const open = r.is(after, "(")
      ? after
      : r.is(after, "?.") && r.is(after + 1, "(")
        ? after + 1
        : -1;
    if (open < 0) continue;
    const d = k - 1;
    const from = r.chainStart(d);
    // a function of an object literal of the file: a look-alike, no row
    if (r.ident(from) && r.ownLiteralMethod(from, d, t.value)) continue;
    const close = resolver.closeOf(open);
    if (close < 0) continue;
    let targetKind: DangerousCallRow["targetKind"] = "unknown";
    const last = r.ident(d - 1);
    if (last === "webContents" && r.dot(d - 2)) targetKind = "webContents";
    else if ((last === "mainFrame" || last === "focusedFrame") && r.dot(d - 2))
      targetKind = "frame";
    else if (r.memberBefore(d, "webFrame") >= 0) targetKind = "webFrame";
    // the code: the first argument, or the second (the sources) for an isolated world
    let a = open + 1;
    if (t.value === "executeJavaScriptInIsolatedWorld") {
      const first = r.exprEnd(a);
      a = first > 0 && r.is(first, ",") ? first + 1 : -1;
    }
    const end = a < 0 || r.is(a, ")") ? -1 : r.exprEnd(a);
    const read =
      end < 0
        ? { argumentKind: "unknown" as const, argument: null }
        : t.value === "executeJavaScriptInIsolatedWorld"
          ? sources(a, end)
          : code(a, end);
    push({
      method: t.value as DangerousCallRow["method"],
      targetKind,
      target: r.ident(from) ? r.text(from, d) : "?",
      ...read,
      evidence: `${r.ident(from) ? r.text(from, open + 1) : `…${r.text(d, open + 1)}`}${r.text(open + 1, Math.min(close, open + 12))}${close > open + 12 ? "…" : ""})`,
      file,
      line: t.line,
    });
  }
  if (r.capped) capped = true;
  return { rows, capped };
}
