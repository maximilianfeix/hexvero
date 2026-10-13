/**
 * Network endpoints, storage accesses and URL literals read from a JavaScript token stream.
 *
 * One implementation for standalone bundles and for every file of an application. It works on
 * tokens, so a call inside a comment or a string is never seen. A row says how its value was
 * obtained:
 *
 * - `literal`: the argument is a string literal at the call.
 * - `template`: part of the value is known and the rest is an expression (`${…}`).
 * - `inferred`: the value was reached through a same-file constant, or the call is recognised
 *   by its shape only (an unknown object with an HTTP-verb method and an absolute URL).
 * - `unknown`: there is a call, but its argument is an expression that cannot be read here; the
 *   row has `value: null` and names the expression.
 *
 * A URL that merely occurs as a string is not an endpoint. Those go to `urls`.
 */
import { resolveAliases } from "./aliases.js";
import type { Token } from "./scan.js";

const FETCH_ONLY: ReadonlySet<string> = new Set(["fetch"]);

export type CandidateConfidence = "literal" | "template" | "inferred" | "unknown";

export interface Candidate {
  /** The URL, key or name; null when the argument could not be read. */
  value: string | null;
  kind:
    | "fetch"
    | "http-client"
    | "xhr"
    | "websocket"
    | "event-source"
    | "beacon"
    | "url-literal"
    | "path-literal"
    | "route"
    | "localStorage"
    | "sessionStorage"
    | "indexedDB"
    | "cache"
    | "cookie"
    | "electron-store";
  confidence: CandidateConfidence;
  line: number;
  /** 1-based column of the call; what makes a position usable in a minified one-line file. */
  column: number;
  /** HTTP method when the call states one. */
  method?: string;
  /** What a storage access does. */
  op?: "read" | "write" | "delete";
  /** The unread argument, for `unknown` rows: an identifier name or `<expression>`. */
  expression?: string;
  /** How many times the same kind and value occur in this file (first position is reported). */
  count: number;
}

export interface Candidates {
  endpoints: Candidate[];
  routes: Candidate[];
  storage: Candidate[];
  urls: Candidate[];
  /** True when a list hit its cap; the caller reports it as a limitation. */
  truncated: boolean;
}

const MAX_PER_LIST = 2000;
const HTTP_VERBS = new Set(["get", "post", "put", "delete", "patch", "head", "options", "request"]);
/** Objects whose verb methods are HTTP requests by definition of the library. */
const HTTP_CLIENTS = new Set(["axios", "got", "ky", "superagent", "needle", "$http"]);
const GLOBALS = new Set(["window", "globalThis", "self", "net"]);
const STORAGE_OPS: Record<string, Candidate["op"]> = {
  getItem: "read",
  setItem: "write",
  removeItem: "delete",
};
const STORE_OPS: Record<string, Candidate["op"]> = {
  get: "read",
  has: "read",
  set: "write",
  delete: "delete",
};
const ABSOLUTE = /^(https?|wss?):\/\/[^\s"'<>]{3,}/i;

const is = (t: Token | undefined, type: Token["type"], value?: string): boolean =>
  !!t && t.type === type && (value === undefined || t.value === value);

interface Read {
  value: string | null;
  confidence: CandidateConfidence;
  expression?: string;
}

export function findCandidates(
  tokens: Token[],
  source: string,
  /** Called once per new row with the token it was read at, e.g. to attach a module id. */
  onRow?: (row: Candidate, at: Token) => void,
  /** Other names for `fetch`, by token index (see aliases.ts); computed here when not given. */
  aliases: Map<number, string> = resolveAliases(tokens, FETCH_ONLY),
): Candidates {
  const out: Candidates = { endpoints: [], routes: [], storage: [], urls: [], truncated: false };
  const seen = new Map<string, Candidate>();

  // Line starts are only needed when something is found; most files have no candidates.
  let lineStarts: number[] | null = null;
  const columnOf = (t: Token): number => {
    if (!lineStarts) {
      lineStarts = [0];
      for (let i = source.indexOf("\n"); i !== -1; i = source.indexOf("\n", i + 1))
        lineStarts.push(i + 1);
    }
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid]! <= t.start) lo = mid;
      else hi = mid - 1;
    }
    return t.start - lineStarts[lo]! + 1;
  };

  // `const NAME = "text"` declared exactly once in the file: the only aliasing that is followed.
  let constants: Map<string, string | null> | null = null;
  const constantOf = (name: string): string | null => {
    if (!constants) {
      constants = new Map();
      for (let k = 0; k + 3 < tokens.length; k++) {
        const t = tokens[k]!;
        if (t.type !== "ident" || (t.value !== "const" && t.value !== "let" && t.value !== "var"))
          continue;
        const id = tokens[k + 1]!;
        if (id.type !== "ident" || !is(tokens[k + 2], "punct", "=")) continue;
        const v = tokens[k + 3]!;
        const end = tokens[k + 4];
        const plain =
          (v.type === "string" || (v.type === "template" && !v.value.includes("${"))) &&
          (!end || is(end, "punct", ";") || is(end, "punct", ",") || end.type === "ident");
        // A second declaration of the same name makes the value ambiguous.
        constants.set(id.value, constants.has(id.value) || !plain ? null : v.value);
      }
    }
    return constants.get(name) ?? null;
  };

  /** Reads the argument that starts at token k: a literal, a template, a constant, or `a + b`. */
  const read = (k: number): Read | null => {
    const first = tokens[k];
    if (!first || is(first, "punct", ")")) return null;
    let value = "";
    let confidence: CandidateConfidence = "literal";
    let j = k;
    for (let parts = 0; parts < 6; parts++) {
      const t = tokens[j];
      if (!t) break;
      if (t.type === "string") value += t.value;
      else if (t.type === "template") {
        // A template with expressions arrives as: text, the expression's tokens, text, … The
        // text pieces are joined; an expression that is one known constant is filled in.
        let piece: Token = t;
        let at = j;
        for (let pieces = 0; pieces < 12; pieces++) {
          const dynamic = piece.value.endsWith("${…}");
          value += dynamic ? piece.value.slice(0, -"${…}".length) : piece.value;
          if (!dynamic) break;
          const expr = tokens[at + 1];
          const direct = expr?.type === "ident" && tokens[at + 2]?.type === "template";
          const known = direct ? constantOf(expr.value) : null;
          if (known !== null) {
            value += known;
            if (confidence === "literal") confidence = "inferred";
          } else {
            value += "${…}";
            confidence = "template";
          }
          let nextPiece = -1;
          for (let m = at + 1; m < tokens.length && m < at + 60; m++)
            if (tokens[m]!.type === "template") {
              nextPiece = m;
              break;
            }
          if (nextPiece === -1) return { value, confidence: "template" };
          at = nextPiece;
          piece = tokens[at]!;
        }
        j = at;
      } else if (
        t.type === "ident" &&
        !is(tokens[j + 1], "punct", ".") &&
        !is(tokens[j + 1], "punct", "(")
      ) {
        const known = constantOf(t.value);
        if (known !== null) {
          value += known;
          if (confidence === "literal") confidence = "inferred";
        } else if (parts === 0 && !is(tokens[j + 1], "punct", "+"))
          return { value: null, confidence: "unknown", expression: t.value };
        else {
          value += "${…}";
          confidence = "template";
        }
      } else if (parts === 0)
        return { value: null, confidence: "unknown", expression: "<expression>" };
      else {
        value += "${…}";
        return { value, confidence: "template" };
      }
      if (!is(tokens[j + 1], "punct", "+")) break;
      j += 2;
    }
    return { value, confidence };
  };
  /** A value with no fixed text at all (only `${…}`) says nothing: it is an unread argument. */
  const readArg = (k: number): Read | null => {
    const r = read(k);
    if (r && r.value !== null && r.value.replaceAll("${…}", "") === "")
      return { value: null, confidence: "unknown", expression: "<expression>" };
    return r;
  };

  const push = (
    list: Candidate[],
    kind: Candidate["kind"],
    r: Read,
    t: Token,
    extra: { method?: string; op?: Candidate["op"] } = {},
  ): void => {
    const key = `${list === out.endpoints ? "e" : list === out.storage ? "s" : list === out.urls ? "u" : "r"}\u0000${kind}\u0000${r.value ?? `?${r.expression}`}\u0000${extra.method ?? ""}\u0000${extra.op ?? ""}`;
    const existing = seen.get(key);
    if (existing) {
      existing.count++;
      return;
    }
    if (list.length >= MAX_PER_LIST) {
      out.truncated = true;
      return;
    }
    const row: Candidate = {
      value: r.value,
      kind,
      confidence: r.confidence,
      line: t.line,
      column: columnOf(t),
      ...(extra.method ? { method: extra.method } : {}),
      ...(extra.op ? { op: extra.op } : {}),
      ...(r.expression ? { expression: r.expression } : {}),
      count: 1,
    };
    seen.set(key, row);
    list.push(row);
    onRow?.(row, t);
  };

  // Variables that hold an electron-store instance; only looked for when the package is named.
  // The class is whatever `require("electron-store")` was bound to (minifiers rename it), or
  // the `.default` of a bundler's interop object.
  const stores = new Set<string>();
  if (source.includes("electron-store") || source.includes("electron-settings")) {
    const classes = new Set<string>(["Store", "ElectronStore"]);
    const interop = new Set<string>();
    for (let k = 0; k + 5 < tokens.length; k++) {
      if (!is(tokens[k], "ident") || !is(tokens[k + 1], "punct", "=")) continue;
      const direct = is(tokens[k + 2], "ident", "require") ? k + 2 : -1;
      const wrapped =
        is(tokens[k + 2], "ident") &&
        is(tokens[k + 3], "punct", "(") &&
        is(tokens[k + 4], "ident", "require")
          ? k + 4
          : -1;
      const req = direct !== -1 ? direct : wrapped;
      if (req === -1 || !is(tokens[req + 1], "punct", "(")) continue;
      const spec = tokens[req + 2];
      if (spec?.type !== "string" || !/^electron-(store|settings)$/.test(spec.value)) continue;
      (wrapped !== -1 ? interop : classes).add(tokens[k]!.value);
    }
    for (let k = 0; k + 3 < tokens.length; k++) {
      if (
        !is(tokens[k], "ident") ||
        !is(tokens[k + 1], "punct", "=") ||
        !is(tokens[k + 2], "ident", "new")
      )
        continue;
      const ctor = tokens[k + 3]!;
      if (ctor.type !== "ident") continue;
      if (
        classes.has(ctor.value) ||
        (interop.has(ctor.value) &&
          is(tokens[k + 4], "punct", ".") &&
          is(tokens[k + 5], "ident", "default"))
      )
        stores.add(tokens[k]!.value);
    }
  }

  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k]!;
    if (t.type === "string") {
      if (t.value.length < 300) {
        if (ABSOLUTE.test(t.value))
          push(out.urls, "url-literal", { value: t.value, confidence: "literal" }, t);
        else if (/^\/(api|graphql|v\d+|rest|rpc)\b/.test(t.value) && !/\s/.test(t.value))
          push(out.urls, "path-literal", { value: t.value, confidence: "literal" }, t);
      }
      continue;
    }
    if (t.type !== "ident") continue;
    const prev = tokens[k - 1];
    const called = is(tokens[k + 1], "punct", "(");
    const member = is(prev, "punct", ".") || is(prev, "punct", "?.");

    if (t.value === "fetch" && called) {
      // `x.fetch(` is some object's own method unless x is the global object.
      if (member && !(is(tokens[k - 2], "ident") && GLOBALS.has(tokens[k - 2]!.value))) continue;
      // `function fetch(` and `async fetch(` declare a function; they do not call one.
      if (is(prev, "ident", "function") || is(prev, "ident", "async") || is(prev, "punct", "*"))
        continue;
      const r = readArg(k + 2);
      if (r) push(out.endpoints, "fetch", r, t);
    } else if (called && !member && aliases.get(k) === "fetch") {
      // Another name for fetch (`const request = fetch`): a request, but known by inference.
      const r = readArg(k + 2);
      if (r)
        push(
          out.endpoints,
          "fetch",
          { ...r, confidence: r.confidence === "literal" ? "inferred" : r.confidence },
          t,
        );
    } else if (HTTP_VERBS.has(t.value) && member && called) {
      const owner = tokens[k - 2];
      const client = is(owner, "ident") && HTTP_CLIENTS.has(owner!.value);
      const r = readArg(k + 2);
      if (!r || r.value === null) continue;
      // An unknown object with a verb method is only taken for a request when the URL is
      // absolute: `router.get("/users", handler)` and `map.get("/x")` are not requests.
      if (
        client ? /^(https?:)?\//i.test(r.value) || ABSOLUTE.test(r.value) : ABSOLUTE.test(r.value)
      )
        push(
          out.endpoints,
          "http-client",
          client ? r : { ...r, confidence: r.confidence === "template" ? "template" : "inferred" },
          t,
          t.value === "request" ? {} : { method: t.value.toUpperCase() },
        );
    } else if (t.value === "axios" && called && !member) {
      const r = readArg(k + 2);
      if (r && r.value !== null) push(out.endpoints, "http-client", r, t);
    } else if (t.value === "open" && member && called) {
      // XMLHttpRequest: open("METHOD", url). indexedDB.open is handled by its owner below.
      const method = tokens[k + 2];
      if (
        is(method, "string") &&
        /^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)$/i.test(method!.value) &&
        is(tokens[k + 3], "punct", ",")
      ) {
        const r = readArg(k + 4);
        if (r) push(out.endpoints, "xhr", r, t, { method: method!.value.toUpperCase() });
      }
    } else if (
      (t.value === "WebSocket" || t.value === "EventSource") &&
      is(prev, "ident", "new") &&
      called
    ) {
      const r = readArg(k + 2);
      if (r) push(out.endpoints, t.value === "WebSocket" ? "websocket" : "event-source", r, t);
    } else if (t.value === "sendBeacon" && member && called) {
      const r = readArg(k + 2);
      if (r) push(out.endpoints, "beacon", r, t, { method: "POST" });
    } else if (t.value === "localStorage" || t.value === "sessionStorage") {
      const next = tokens[k + 2];
      if (is(tokens[k + 1], "punct", ".") && is(next, "ident") && is(tokens[k + 3], "punct", "(")) {
        const op = STORAGE_OPS[next!.value];
        if (!op) continue;
        const r = readArg(k + 4);
        if (r) push(out.storage, t.value, r, t, { op });
      } else if (is(tokens[k + 1], "punct", "[") && is(tokens[k + 3], "punct", "]")) {
        const r = readArg(k + 2);
        if (r)
          push(out.storage, t.value, r, t, {
            op: is(tokens[k + 4], "punct", "=") ? "write" : "read",
          });
      }
    } else if (
      (t.value === "indexedDB" || t.value === "caches") &&
      is(tokens[k + 1], "punct", ".") &&
      is(tokens[k + 2], "ident", "open") &&
      is(tokens[k + 3], "punct", "(")
    ) {
      const r = readArg(k + 4);
      if (r) push(out.storage, t.value === "caches" ? "cache" : "indexedDB", r, t);
    } else if (t.value === "cookie" && member && is(tokens[k - 2], "ident", "document")) {
      push(out.storage, "cookie", { value: "document.cookie", confidence: "literal" }, t, {
        op: is(tokens[k + 1], "punct", "=") ? "write" : "read",
      });
    } else if (
      stores.has(t.value) &&
      is(tokens[k + 1], "punct", ".") &&
      is(tokens[k + 2], "ident") &&
      is(tokens[k + 3], "punct", "(")
    ) {
      const op = STORE_OPS[tokens[k + 2]!.value];
      if (!op) continue;
      const r = readArg(k + 4);
      // The variable is taken for a store because of how it was created, so never `literal`.
      if (r)
        push(
          out.storage,
          "electron-store",
          { ...r, confidence: r.confidence === "literal" ? "inferred" : r.confidence },
          t,
          { op },
        );
    } else if (t.value === "path" && is(tokens[k + 1], "punct", ":")) {
      const v = tokens[k + 2];
      if (
        v &&
        (v.type === "string" || (v.type === "template" && !v.value.includes("${"))) &&
        v.value.startsWith("/") &&
        v.value.length < 120 &&
        !/\s/.test(v.value)
      )
        push(out.routes, "route", { value: v.value, confidence: "literal" }, t);
    }
  }
  return out;
}
