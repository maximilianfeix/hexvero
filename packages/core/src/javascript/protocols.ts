/**
 * Custom protocols, the `protocols` collection:
 *
 * - `handler`: `protocol.handle(scheme, …)`, `protocol.registerFileProtocol` /
 *   `registerHttpProtocol` / `registerStringProtocol` / `registerBufferProtocol` /
 *   `registerStreamProtocol` and the `intercept…Protocol` methods, on Electron's `protocol` or a
 *   session's (`ses.protocol`);
 * - `privileged`: each scheme of `protocol.registerSchemesAsPrivileged([{ scheme, privileges }])`
 *   with the privileges written as literals;
 * - `default-client`: `app.setAsDefaultProtocolClient(scheme)`, which makes the operating
 *   system hand the app URLs of that scheme from anywhere (a browser, another program).
 *
 * The receiver is proven to be Electron's `protocol` or `app` by scope where it can be; a method
 * of these names on another receiver gives a row with `targetKind: "unknown"`, except `handle`,
 * which many objects have (`ipcMain.handle`): it counts only on `protocol` or `X.protocol`. What a
 * handler serves (and whether it checks the path it is asked for) is not read. Nothing is run.
 */
import type { Constants } from "./aliases.js";
import type { ExpressionResolver } from "./resolve.js";
import type { Token } from "./scan.js";
import { FileReader, keepRows, MAX_SECURITY_ROWS_PER_FILE } from "./security.js";

export interface ProtocolRow {
  kind: "handler" | "privileged" | "default-client";
  /** The method as written (`handle`, `registerFileProtocol`, `registerSchemesAsPrivileged` …). */
  method: string;
  /**
   * `protocol`: Electron's protocol module by scope; `session`: `X.protocol` (a session's);
   * `app`: Electron's app by scope; `unknown`: a method of this name on a receiver not read as one
   * of these.
   */
  targetKind: "protocol" | "session" | "app" | "unknown";
  /** The receiver as written, shortened. */
  target: string;
  /** The scheme as written; null when it is not a literal. */
  scheme: string | null;
  /**
   * For `privileged`: each privilege written in the scheme's `privileges` object, true or false
   * as a literal, null when its value is not read; null when the object itself is not read (a
   * name, a spread, a computed key). Privileges not written are off (Electron's default).
   */
  privileges?: Record<string, boolean | null> | null;
  evidence: string;
  file: string;
  line: number;
}

/** Privileges of `CustomScheme.privileges` (Electron's protocol API). */
export const PRIVILEGES = [
  "standard",
  "secure",
  "bypassCSP",
  "allowServiceWorkers",
  "supportFetchAPI",
  "corsEnabled",
  "stream",
  "codeCache",
] as const;

const HANDLER_METHODS = new Set([
  "handle",
  "registerFileProtocol",
  "registerHttpProtocol",
  "registerStringProtocol",
  "registerBufferProtocol",
  "registerStreamProtocol",
  "interceptFileProtocol",
  "interceptHttpProtocol",
  "interceptStringProtocol",
  "interceptBufferProtocol",
  "interceptStreamProtocol",
]);

/** A protocols row the cap may drop: a handler (nothing a rule reads). */
export const harmlessProtocol = (r: ProtocolRow): boolean => r.kind === "handler";

/** Protocol handlers, privileged schemes and default protocol clients of a file. */
export function protocolRows(
  tokens: Token[],
  file: string,
  resolver: ExpressionResolver,
  constants: Constants,
): { rows: ProtocolRow[]; capped: boolean } {
  const r = new FileReader(tokens, resolver, constants);
  const rows: ProtocolRow[] = [];
  let capped = false;
  const push = (row: ProtocolRow): void => {
    if (keepRows(rows, [row], MAX_SECURITY_ROWS_PER_FILE, harmlessProtocol)) capped = true;
  };

  /** The privileges object literal at `open`, key by key; null when it is not read whole. */
  const privilegesAt = (open: number): Record<string, boolean | null> | null => {
    if (!r.is(open, "{")) return null;
    const out: Record<string, boolean | null> = {};
    for (const name of PRIVILEGES) {
      const at = r.keyOf(open, name);
      if (at === "unknown") return null;
      if (at === null) continue;
      if (at === "method") {
        out[name] = null;
        continue;
      }
      const end = r.exprEnd(at);
      out[name] = end < 0 ? null : r.boolAt(at, end);
    }
    return out;
  };

  /** The object literal a name at [a, b) is bound to (`const scheme = { … }`), else -1. */
  const objectOf = (a: number, b: number): number => {
    const name = b === a + 1 ? r.ident(a) : null;
    if (!name || !r.spend()) return -1;
    if (resolver.boundAround(a, name)?.kind === "param") return -1;
    const bound = resolver.binding(a, name);
    if (bound?.kind !== "value") return -1;
    const [x, y] = r.trim(bound.range[0], bound.range[1]);
    return r.is(x, "{") && resolver.closeOf(x) === y - 1 ? x : -1;
  };

  /** The scheme objects of the array at [a, b): an array literal, or a name bound to one. */
  const schemesAt = (a: number, b: number, depth = 0): number[] | null => {
    if (r.is(a, "[") && resolver.closeOf(a) === b - 1) {
      const out: number[] = [];
      for (let j = a + 1; j < b - 1;) {
        if (!r.spend()) return null;
        const end = r.exprEnd(j);
        if (end < 0) return null;
        const object = r.is(j, "{") && resolver.closeOf(j) === end - 1 ? j : objectOf(j, end);
        if (object < 0) return null;
        out.push(object);
        j = r.is(end, ",") ? end + 1 : end;
        if (end >= b - 1) break;
      }
      return out;
    }
    if (b === a + 1 && r.ident(a) && depth < 2 && r.spend()) {
      if (resolver.boundAround(a, r.ident(a)!)?.kind === "param") return null;
      const bound = resolver.binding(a, r.ident(a)!);
      if (bound?.kind !== "value") return null;
      const [x, y] = r.trim(bound.range[0], bound.range[1]);
      return schemesAt(x, y, depth + 1);
    }
    return null;
  };

  for (let k = 1; k + 1 < tokens.length; k++) {
    const t = tokens[k]!;
    const bracketed = t.type === "string" && r.is(k - 1, "[") && r.is(k + 1, "]");
    if (t.type !== "ident" && !bracketed) continue;
    const method = t.value;
    const handler = HANDLER_METHODS.has(method);
    if (
      !handler &&
      method !== "registerSchemesAsPrivileged" &&
      method !== "setAsDefaultProtocolClient"
    )
      continue;
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
    if (r.ident(from) && r.ownLiteralMethod(from, d, method)) continue;
    let targetKind: ProtocolRow["targetKind"] = "unknown";
    if (method === "setAsDefaultProtocolClient") {
      if (r.memberBefore(d, "app") >= 0) targetKind = "app";
    } else if (r.memberBefore(d, "protocol") >= 0) targetKind = "protocol";
    else if (r.ident(d - 1) === "protocol" && r.dot(d - 2)) targetKind = "session";
    // `handle` is a method of many objects: only on a protocol
    if (method === "handle" && targetKind === "unknown") continue;
    const close = resolver.closeOf(open);
    if (close < 0) continue;
    const end = r.is(open + 1, ")") ? open + 1 : r.exprEnd(open + 1);
    const target = r.ident(from) ? r.text(from, d) : "?";
    const evidence = `${r.ident(from) ? r.text(from, open + 1) : `…${r.text(d, open + 1)}`}${r.text(open + 1, Math.min(close, open + 12))}${close > open + 12 ? "…" : ""})`;
    if (method !== "registerSchemesAsPrivileged") {
      push({
        kind: handler ? "handler" : "default-client",
        method,
        targetKind,
        target,
        scheme: end > open + 1 ? r.stringAt(open + 1, end) : null,
        evidence,
        file,
        line: t.line,
      });
      continue;
    }
    const objects = end > open + 1 ? schemesAt(open + 1, end) : null;
    // `registerSchemesAsPrivileged([])` registers none
    if (objects?.length === 0) continue;
    if (!objects) {
      push({
        kind: "privileged",
        method,
        targetKind,
        target,
        scheme: null,
        privileges: null,
        evidence,
        file,
        line: t.line,
      });
      continue;
    }
    for (const o of objects) {
      const at = r.keyOf(o, "scheme");
      const schemeEnd = typeof at === "number" ? r.exprEnd(at) : -1;
      const p = r.keyOf(o, "privileges");
      const pEnd = typeof p === "number" ? r.exprEnd(p) : -1;
      push({
        kind: "privileged",
        method,
        targetKind,
        target,
        scheme: schemeEnd > 0 ? r.stringAt(at as number, schemeEnd) : null,
        // no privileges key: the scheme gets none
        privileges:
          p === null
            ? {}
            : typeof p === "number" && pEnd > 0 && resolver.closeOf(p) === pEnd - 1
              ? privilegesAt(p)
              : null,
        evidence: `${r.text(from < 0 ? d : from, open + 1)}[${r.text(o, Math.min(resolver.closeOf(o) + 1, o + 30))}${resolver.closeOf(o) + 1 > o + 30 ? "…" : ""}])`,
        file,
        // an object of the call's own array, else the call (the object is bound to a name)
        line: o > open && o < close ? tokens[o]!.line : t.line,
      });
    }
  }
  if (r.capped) capped = true;
  return { rows, capped };
}
