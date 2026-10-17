/**
 * Network endpoints, storage accesses and URL literals read from a JavaScript token stream.
 *
 * One implementation for standalone bundles and for every file of an application. It works on
 * tokens, so a call inside a comment or a string is never seen. A row's `evidence` says how its
 * value was obtained (a different scale from the confirmed/inferred of a finding):
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
import { Constants, resolveAliases } from "./aliases.js";
import { ExpressionResolver, type WrapperCalls } from "./resolve.js";
import type { Token } from "./scan.js";

const OWN_TARGETS: ReadonlySet<string> = new Set(["fetch", "localStorage", "sessionStorage"]);

/**
 * A part of a value that is a constant of another module is written into the value as a
 * reference between these marks until that module is known; `resolvePending` replaces it.
 */
const REF_OPEN = "\u0001";
/** What an address resolved from an expression must start with: a scheme, an absolute path, or a
 * reference to another module's constant (filled in later). */
// eslint-disable-next-line no-control-regex
const ADDRESS_START = /^(?:[a-z][a-z0-9+.-]*:\/\/|\/(?!\/)|\u0001)/i;
const REF_SPLIT = "\u0002";
// eslint-disable-next-line no-control-regex
const REF = /\u0001([^\u0001\u0002]*)\u0002([^\u0001\u0002]*)\u0001/g;
/** How a value read through the resolver was obtained: a template when part of it is a gap. */
const resolvedEvidence = (v: string): CandidateEvidence =>
  v.includes("${…}") ? "template" : "inferred";

/**
 * Fills in the cross-module constants of a row, or marks them unknown. Returns a row without
 * references; the stored row is left as it is, so a later run can resolve what this one cannot.
 */
export function resolvePending<T extends Candidate>(
  row: T,
  lookup: (specifier: string, property: string) => string | null,
): T {
  if (row.value === null || !row.value.includes(REF_OPEN)) return row;
  let unknown = false;
  const value = row.value.replace(REF, (_all, specifier: string, property: string) => {
    const found = lookup(specifier, property);
    if (found === null) unknown = true;
    return found ?? "${…}";
  });
  if (value.replaceAll("${…}", "") === "")
    return { ...row, value: null, evidence: "unknown", expression: "<expression>" };
  return {
    ...row,
    value,
    evidence: unknown ? "template" : row.evidence === "literal" ? "inferred" : row.evidence,
  };
}

export type CandidateEvidence = "literal" | "template" | "inferred" | "unknown";

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
  evidence: CandidateEvidence;
  line: number;
  /** 1-based column of the call; what makes a position usable in a minified one-line file. */
  column: number;
  /** HTTP method when the call states one. */
  method?: string;
  /** What a storage access does. */
  op?: "read" | "write" | "delete";
  /** The unread argument, for `unknown` rows: an identifier name or `<expression>`. */
  expression?: string;
  /**
   * A storage key read at a call of a wrapper (`this.save(KEY, v)` for a method whose
   * `localStorage.setItem(key, …)` takes its parameter): the wrapper, `name` or `Class.method`.
   * The row's position is then that call, not the storage call inside the wrapper.
   */
  via?: string;
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
  /**
   * The file has more functions than storage wrappers are followed for (MAX_WRAPPER_FUNCTIONS):
   * keys passed through a wrapper there are not read at each call. The caller reports it.
   */
  wrappersSkipped?: true;
}

/**
 * Functions (`function` and `=>`) a file may have for storage wrappers to be followed in it. The
 * resolver's tables grow with the functions of a file; Electron Fiddle's renderer bundle has
 * about 15,400 such tokens (25,113 functions with methods).
 */
const MAX_WRAPPER_FUNCTIONS = 50_000;

const MAX_PER_LIST = 2000;
const HTTP_VERBS = new Set(["get", "post", "put", "delete", "patch", "head", "options", "request"]);
/** Objects whose verb methods are HTTP requests by definition of the library. */
const HTTP_CLIENTS = new Set([
  "axios",
  "got",
  "ky",
  "superagent",
  "needle",
  "$http",
  "http",
  "https",
]);
const CLIENT_MODULES = /^(node:)?(https?|axios|got|ky|superagent|needle)$/;
/** Verbs that a map, a set or a header list also has; on an unknown object they prove nothing. */
const LOOKUP_VERBS = new Set(["get", "delete", "head", "options"]);
const GLOBALS = new Set(["window", "globalThis", "self", "net"]);
const STORAGE_OPS: Record<string, Candidate["op"]> = {
  getItem: "read",
  setItem: "write",
  removeItem: "delete",
};
/** Members of the Storage interface itself; any other property of localStorage is a key. */
const STORAGE_MEMBERS = new Set([
  "length",
  "key",
  "clear",
  "getItem",
  "setItem",
  "removeItem",
  "hasOwnProperty",
  "constructor",
  "toString",
  "valueOf",
]);
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
  evidence: CandidateEvidence;
  expression?: string;
  /** Further values the same call takes (one per readable call site of a helper). */
  more?: string[];
  /** Read at a call of this wrapper (see `Candidate.via`). */
  via?: string;
}

export function findCandidates(
  tokens: Token[],
  source: string,
  /** Called once per new row with the token it was read at, e.g. to attach a module id. */
  onRow?: (row: Candidate, at: Token) => void,
  /** Other names for fetch and the storage objects, by token index; computed when not given. */
  aliasesGiven?: Map<number, string>,
  constantsGiven?: Constants,
): Candidates {
  const constants = constantsGiven ?? new Constants(tokens);
  const aliases = aliasesGiven ?? resolveAliases(tokens, OWN_TARGETS, new Set(constants.names()));
  if (!constantsGiven) constants.visible = aliases;
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

  // A name stands for a string when it is a constant of this file, or a constant imported from
  // another module (then a reference is written, to be filled in when that module is known).
  const constantOf = (name: string, k: number): string | null => {
    const local = constants.stringOf(name, k);
    if (local !== null) return local;
    const ref = constants.importOf(name, k);
    return ref ? `${REF_OPEN}${ref.specifier}${REF_SPLIT}${ref.property}${REF_OPEN}` : null;
  };

  /** Reads the argument that starts at token k: a literal, a template, a constant, or `a + b`. */
  const read = (k: number): Read | null => {
    const first = tokens[k];
    if (!first || is(first, "punct", ")")) return null;
    let value = "";
    let evidence: CandidateEvidence = "literal";
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
          const known = direct ? constantOf(expr.value, at + 1) : null;
          if (known !== null) {
            value += known;
            if (evidence === "literal") evidence = "inferred";
          } else {
            value += "${…}";
            evidence = "template";
          }
          let nextPiece = -1;
          for (let m = at + 1; m < tokens.length && m < at + 60; m++)
            if (tokens[m]!.type === "template") {
              nextPiece = m;
              break;
            }
          if (nextPiece === -1) return { value, evidence: "template" };
          at = nextPiece;
          piece = tokens[at]!;
        }
        j = at;
      } else if (
        t.type === "ident" &&
        !is(tokens[j + 1], "punct", ".") &&
        !is(tokens[j + 1], "punct", "(")
      ) {
        const known = constantOf(t.value, j);
        if (known !== null) {
          value += known;
          if (evidence === "literal") evidence = "inferred";
        } else if (parts === 0 && !is(tokens[j + 1], "punct", "+"))
          return { value: null, evidence: "unknown", expression: t.value };
        else {
          value += "${…}";
          evidence = "template";
        }
      } else if (t.type === "ident" && is(tokens[j + 1], "punct", ".")) {
        // `Enum.MEMBER`, `module.Enum.MEMBER`: a member of a compiled TypeScript string enum
        let end = j + 1;
        while (end < j + 7 && is(tokens[end], "punct", ".") && is(tokens[end + 1], "ident"))
          end += 2;
        const member = constants.enumAt(j, end, (name) =>
          (wrapperResolver ??= makeResolver()).moduleBinding(j, name),
        );
        if (member !== null) {
          value += member;
          if (evidence === "literal") evidence = "inferred";
          j = end - 1;
        } else if (parts === 0)
          return { value: null, evidence: "unknown", expression: "<expression>" };
        else {
          value += "${…}";
          return { value, evidence: "template" };
        }
      } else if (parts === 0)
        return { value: null, evidence: "unknown", expression: "<expression>" };
      else {
        value += "${…}";
        return { value, evidence: "template" };
      }
      if (!is(tokens[j + 1], "punct", "+")) break;
      j += 2;
    }
    return { value, evidence };
  };
  // The slow path, for arguments the reader above cannot complete: the bounded resolver of
  // resolve.ts (helpers, API client classes, parameters bound at their call sites). Names from
  // other modules become references, filled in when the application scan knows that module.
  const makeResolver = (): ExpressionResolver =>
    new ExpressionResolver(
      tokens,
      constants,
      "",
      null,
      (specifier, property) => `${REF_OPEN}${specifier}${REF_SPLIT}${property}${REF_OPEN}`,
      true,
    );
  let resolver: ExpressionResolver | null = null;
  let resolved = 0;
  const throughResolver = (k: number, url: boolean): Read | null => {
    if (resolved++ > 32) return null;
    resolver ??= makeResolver();
    // Values from the call sites that could be read are real requests, even when another call
    // site could not be read; a value that is nothing but gaps says nothing and is dropped.
    const found = resolver.resolveArgument(k);
    // For a request, only something shaped like an address counts: a value bound from call sites
    // in library code can be any string (error messages, event names), and that is no endpoint.
    const values = (found?.values ?? []).filter(
      (v) => v.replaceAll("${…}", "") !== "" && (!url || ADDRESS_START.test(v)),
    );
    const [first, ...rest] = values;
    if (first === undefined) return null;
    return {
      value: first,
      evidence: resolvedEvidence(first),
      ...(rest.length ? { more: rest } : {}),
    };
  };
  /** A value with no fixed text at all (only `${…}`) says nothing: it is an unread argument. */
  const readArg = (k: number, url = false): Read | null => {
    const fast = read(k);
    const r =
      fast && (fast.value === null || fast.value.includes("${…}"))
        ? (throughResolver(k, url) ?? fast)
        : fast;
    if (r && r.value !== null && r.value.replaceAll("${…}", "") === "")
      return { value: null, evidence: "unknown", expression: "<expression>" };
    return r;
  };

  const push = (
    list: Candidate[],
    kind: Candidate["kind"],
    r: Read,
    t: Token,
    extra: { method?: string; op?: Candidate["op"] } = {},
  ): void => {
    const key = `${list === out.endpoints ? "e" : list === out.storage ? "s" : list === out.urls ? "u" : "r"}\u0000${kind}\u0000${r.value ?? `?${r.expression}`}\u0000${extra.method ?? ""}\u0000${extra.op ?? ""}\u0000${r.via ?? ""}`;
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
      evidence: r.evidence,
      line: t.line,
      column: columnOf(t),
      ...(extra.method ? { method: extra.method } : {}),
      ...(extra.op ? { op: extra.op } : {}),
      ...(r.expression ? { expression: r.expression } : {}),
      ...(r.via ? { via: r.via } : {}),
      count: 1,
    };
    seen.set(key, row);
    list.push(row);
    onRow?.(row, t);
    for (const value of r.more ?? [])
      push(
        list,
        kind,
        { value, evidence: value.includes("${…}") ? "template" : "inferred" },
        t,
        extra,
      );
  };

  // Storage wrappers: a key that is (or is built from) a parameter of the function or method the
  // storage call is in is read at each call of that function in this file, with the key its
  // arguments give: one row per call site, `via` the wrapper. A call site that cannot be read
  // keeps the unread row of the storage call itself, so nothing unread is hidden.
  // A resolver of its own: its work budget is not the one the endpoint questions used up.
  let wrapperResolver: ExpressionResolver | null = null;
  let wrapperQuestions = 0;
  /** `function` and `=>` tokens of the file, counted at the first wrapper question. */
  let functionTokens = -1;
  const wrappers = new Map<number, WrapperCalls | null>();
  const storageKey = (
    kind: Candidate["kind"],
    k: number,
    t: Token,
    extra: { op?: Candidate["op"] },
    adjust: (r: Read) => Read = (r) => r,
  ): void => {
    const fast = read(k);
    const open = !fast || fast.value === null || fast.value.includes("${…}");
    let calls = wrappers.get(k);
    if (open && calls === undefined && functionTokens === -1) {
      functionTokens = 0;
      for (const x of tokens)
        if (
          (x.type === "ident" && x.value === "function") ||
          (x.type === "punct" && x.value === "=>")
        )
          functionTokens++;
      if (functionTokens > MAX_WRAPPER_FUNCTIONS) out.wrappersSkipped = true;
    }
    if (
      open &&
      calls === undefined &&
      functionTokens <= MAX_WRAPPER_FUNCTIONS &&
      wrapperQuestions++ < 64
    ) {
      wrapperResolver ??= makeResolver();
      calls = wrapperResolver.wrapperCalls(k);
      wrappers.set(k, calls);
    }
    if (!open || !calls) {
      const r = readArg(k);
      if (r) push(out.storage, kind, adjust(r), t, extra);
      return;
    }
    let unread = false;
    for (const site of calls.sites) {
      if (!site.values) {
        unread = true;
        continue;
      }
      for (const value of site.values)
        push(
          out.storage,
          kind,
          adjust({ value, evidence: resolvedEvidence(value), via: calls.name }),
          tokens[site.at]!,
          extra,
        );
    }
    if (!unread || !fast) return;
    push(
      out.storage,
      kind,
      adjust(
        fast.value !== null && fast.value.replaceAll("${…}", "") !== ""
          ? fast
          : { value: null, evidence: "unknown", expression: fast.expression ?? "<expression>" },
      ),
      t,
      extra,
    );
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

  // Names an HTTP client module is bound to (`const h = require("node:https")`, also through a
  // bundler's interop call): their verb methods are requests whatever the name is.
  const clients = new Set<string>();
  if (/require\(|import /.test(source))
    for (let k = 0; k + 4 < tokens.length; k++) {
      if (!is(tokens[k], "ident") || !is(tokens[k + 1], "punct", "=")) continue;
      const req = is(tokens[k + 2], "ident", "require")
        ? k + 2
        : is(tokens[k + 2], "ident") &&
            is(tokens[k + 3], "punct", "(") &&
            is(tokens[k + 4], "ident", "require")
          ? k + 4
          : -1;
      if (req === -1 || !is(tokens[req + 1], "punct", "(")) continue;
      const spec = tokens[req + 2];
      if (spec?.type === "string" && CLIENT_MODULES.test(spec.value)) clients.add(tokens[k]!.value);
    }

  // Variables that hold an XMLHttpRequest: only their open() is a request.
  const xhrs = new Set<string>();
  if (source.includes("XMLHttpRequest"))
    for (let k = 0; k + 3 < tokens.length; k++)
      if (
        is(tokens[k], "ident") &&
        is(tokens[k + 1], "punct", "=") &&
        is(tokens[k + 2], "ident", "new") &&
        is(tokens[k + 3], "ident", "XMLHttpRequest")
      )
        xhrs.add(tokens[k]!.value);

  /** `key: "text"` at the top level of an object literal inside the call that opens at `open`. */
  const option = (open: number, key: string): string | null => {
    let d = 0;
    for (let j = open; j < tokens.length && j < open + 300; j++) {
      const p = tokens[j]!;
      if (p.type === "punct") {
        if (p.value === "(" || p.value === "{" || p.value === "[") d++;
        else if (p.value === ")" || p.value === "}" || p.value === "]") {
          d--;
          if (d === 0) return null;
        }
        continue;
      }
      if (d === 2 && p.type === "ident" && p.value === key && is(tokens[j + 1], "punct", ":")) {
        const v = tokens[j + 2];
        if (v && (v.type === "string" || (v.type === "template" && !v.value.includes("${"))))
          return v.value;
      }
    }
    return null;
  };
  const verb = (open: number): { method?: string } => {
    const m = option(open, "method");
    return m && /^[A-Za-z]{3,7}$/.test(m) ? { method: m.toUpperCase() } : {};
  };

  /** True when the parenthesis at `open` closes right before a `{`: a definition, not a call. */
  const definesMethod = (open: number): boolean => {
    let d = 0;
    for (let j = open; j < tokens.length && j < open + 200; j++) {
      const p = tokens[j]!;
      if (p.type !== "punct") continue;
      if (p.value === "(") d++;
      else if (p.value === ")") {
        d--;
        if (d === 0) return is(tokens[j + 1], "punct", "{");
      }
    }
    return false;
  };

  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k]!;
    if (t.type === "string") {
      if (t.value.length < 300) {
        if (ABSOLUTE.test(t.value))
          push(out.urls, "url-literal", { value: t.value, evidence: "literal" }, t);
        else if (/^\/(api|graphql|v\d+|rest|rpc)\b/.test(t.value) && !/\s/.test(t.value))
          push(out.urls, "path-literal", { value: t.value, evidence: "literal" }, t);
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
      // `{ fetch(key) { … } }` defines a method of that name: a parameter list followed by a body.
      if (definesMethod(k + 1)) continue;
      const r = readArg(k + 2, true);
      if (r) push(out.endpoints, "fetch", r, t, verb(k + 1));
    } else if (called && !member && aliases.get(k) === "fetch") {
      // Another name for fetch (`const request = fetch`): a request, but known by inference.
      const r = readArg(k + 2, true);
      if (r)
        push(
          out.endpoints,
          "fetch",
          { ...r, evidence: r.evidence === "literal" ? "inferred" : r.evidence },
          t,
          verb(k + 1),
        );
    } else if (HTTP_VERBS.has(t.value) && member && called) {
      const owner = tokens[k - 2];
      const client =
        is(owner, "ident") && (HTTP_CLIENTS.has(owner!.value) || clients.has(owner!.value));
      // `net.request({ url: "https://…", method: "POST" })`: the address is an option.
      const url = is(tokens[k + 2], "punct", "{") ? option(k + 1, "url") : null;
      if (url !== null) {
        if (ABSOLUTE.test(url))
          push(out.endpoints, "http-client", { value: url, evidence: "inferred" }, t, verb(k + 1));
        continue;
      }
      const r = readArg(k + 2, true);
      if (!r || r.value === null) continue;
      // An unknown object with a verb method is only taken for a request when the URL is
      // absolute and the verb is not one a collection has too: `router.get("/users", handler)`,
      // `map.get("https://…")` and `headers.delete(…)` are not requests.
      if (
        client
          ? /^(https?:)?\//i.test(r.value) || ABSOLUTE.test(r.value)
          : ABSOLUTE.test(r.value) && !LOOKUP_VERBS.has(t.value)
      )
        push(
          out.endpoints,
          "http-client",
          client ? r : { ...r, evidence: r.evidence === "template" ? "template" : "inferred" },
          t,
          t.value === "request" ? {} : { method: t.value.toUpperCase() },
        );
    } else if (t.value === "axios" && called && !member) {
      const r = readArg(k + 2, true);
      if (r && r.value !== null) push(out.endpoints, "http-client", r, t);
    } else if (t.value === "open" && member && called) {
      // XMLHttpRequest: open("METHOD", url), on a variable that was created as one. Another
      // object's open() with the same arguments is not a request.
      const method = tokens[k + 2];
      if (
        is(tokens[k - 2], "ident") &&
        xhrs.has(tokens[k - 2]!.value) &&
        is(method, "string") &&
        /^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)$/i.test(method!.value) &&
        is(tokens[k + 3], "punct", ",")
      ) {
        const r = readArg(k + 4, true);
        if (r) push(out.endpoints, "xhr", r, t, { method: method!.value.toUpperCase() });
      }
    } else if (
      (t.value === "WebSocket" || t.value === "EventSource") &&
      is(prev, "ident", "new") &&
      called
    ) {
      const r = readArg(k + 2, true);
      if (r) push(out.endpoints, t.value === "WebSocket" ? "websocket" : "event-source", r, t);
    } else if (t.value === "sendBeacon" && member && called) {
      const r = readArg(k + 2, true);
      if (r) push(out.endpoints, "beacon", r, t, { method: "POST" });
    } else if (
      t.value === "localStorage" ||
      t.value === "sessionStorage" ||
      (!member && (aliases.get(k) === "localStorage" || aliases.get(k) === "sessionStorage"))
    ) {
      const kind = (
        t.value === "localStorage" || t.value === "sessionStorage" ? t.value : aliases.get(k)
      ) as "localStorage" | "sessionStorage";
      const next = tokens[k + 2];
      if (is(tokens[k + 1], "punct", ".") && is(next, "ident") && is(tokens[k + 3], "punct", "(")) {
        const op = STORAGE_OPS[next!.value];
        if (!op) continue;
        storageKey(kind, k + 4, t, { op });
      } else if (
        is(tokens[k + 1], "punct", ".") &&
        is(next, "ident") &&
        !is(tokens[k + 3], "punct", "(") &&
        !STORAGE_MEMBERS.has(next!.value)
      ) {
        // `localStorage.sidebarWidth`: the key written as a property
        const assigned = is(tokens[k + 3], "punct", "=");
        push(out.storage, kind, { value: next!.value, evidence: "literal" }, t, {
          op: is(tokens[k - 1], "ident", "delete") ? "delete" : assigned ? "write" : "read",
        });
      } else if (is(tokens[k + 1], "punct", "[") && is(tokens[k + 3], "punct", "]")) {
        storageKey(kind, k + 2, t, {
          op: is(tokens[k + 4], "punct", "=") ? "write" : "read",
        });
      }
    } else if (
      (t.value === "indexedDB" || t.value === "caches") &&
      is(tokens[k + 1], "punct", ".") &&
      is(tokens[k + 2], "ident") &&
      /^(open|deleteDatabase|delete)$/.test(tokens[k + 2]!.value) &&
      is(tokens[k + 3], "punct", "(")
    ) {
      const r = readArg(k + 4);
      if (r)
        push(
          out.storage,
          t.value === "caches" ? "cache" : "indexedDB",
          r,
          t,
          tokens[k + 2]!.value === "open" ? {} : { op: "delete" },
        );
    } else if (t.value === "cookie" && member && is(tokens[k - 2], "ident", "document")) {
      push(out.storage, "cookie", { value: "document.cookie", evidence: "literal" }, t, {
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
      // The variable is taken for a store because of how it was created, so never `literal`.
      storageKey("electron-store", k + 4, t, { op }, (r) => ({
        ...r,
        evidence: r.evidence === "literal" ? "inferred" : r.evidence,
      }));
    } else if (t.value === "path" && is(tokens[k + 1], "punct", ":")) {
      const v = tokens[k + 2];
      if (
        v &&
        (v.type === "string" || (v.type === "template" && !v.value.includes("${"))) &&
        v.value.startsWith("/") &&
        v.value.length < 120 &&
        !/\s/.test(v.value)
      )
        push(out.routes, "route", { value: v.value, evidence: "literal" }, t);
    }
  }
  return out;
}
