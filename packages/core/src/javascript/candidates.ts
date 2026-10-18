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
import { builtIdentifierIndex, ExpressionResolver, type WrapperCalls } from "./resolve.js";
import type { Token } from "./scan.js";
import { ASSIGNMENT_OPERATORS } from "./writes.js";

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
  /** More HTTP client calls than MAX_CLIENT_CALLS were checked; the rest gave no rows. */
  clientsSkipped?: true;
  /**
   * More writes of client names (or bindings made from clients) than are checked, or more
   * functions than the resolver reads: names written past that point give unknown rows.
   */
  clientWritesSkipped?: true;
  /**
   * Storage calls whose key could not be read where it is written (at most MAX_OPEN_KEYS): the
   * token the key starts at, for the wrappers other modules call (wrappers.ts).
   */
  /** More calls of the file's own storage wrappers than are read (app.ts). */
  keyCallsCapped?: true;
  openKeys?: Array<{ at: number; kind: Candidate["kind"]; op?: NonNullable<Candidate["op"]> }>;
}

/** Storage calls with an unread key recorded per file for the cross-module wrapper stage. */
const MAX_OPEN_KEYS = 64;

/** HTTP client calls per file whose binding is checked (see `clients` in findCandidates). */
const MAX_CLIENT_CALLS = 2000;
/** Questions whether a write means a client declaration, per file (see the write loop). */
const MAX_WRITE_QUESTIONS = 16 * MAX_CLIENT_CALLS;
/** Unknown http-client rows per file before further ones are folded into one. */
const MAX_UNKNOWN_CLIENT_ROWS = 200;

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
/**
 * What a module binding is: Node's `http` or `https` (an options object without `protocol`
 * addresses that scheme), Electron (a client through `net`), its `net`, or a request library
 * whose options give the address as `url`.
 */
type Library = "axios" | "got" | "ky" | "superagent" | "needle";
/** `lib`: a request library that is not known to be one of them (a name assigned two of them). */
type ClientModule = "http" | "https" | "electron" | "net" | "lib" | Library;
const LIBRARIES: ReadonlySet<string> = new Set(["axios", "got", "ky", "superagent", "needle"]);
const isLibrary = (m: ClientModule): boolean => m === "lib" || LIBRARIES.has(m);
const clientModule = (spec: Token | undefined): ClientModule | null => {
  if (spec?.type !== "string") return null;
  if (spec.value === "electron") return "electron";
  const m = /^(?:node:)?(https?|axios|got|ky|superagent|needle)$/.exec(spec.value);
  return !m ? null : (m[1] as ClientModule);
};
/**
 * An instance of a request library with its defaults (`axios.create({ baseURL })`,
 * `got.extend({ prefixUrl })`, `ky.create({ prefixUrl })`): `base` the one known base URL,
 * `method` the default method (null: written, not known), `unread` what makes every request of
 * it an unknown row (the defaults could not be read, or the binding is written again).
 */
interface Instance {
  base?: string;
  method?: string | null;
  unread?: string;
  /** The library's defaults are changed in the file (`axios.defaults.baseURL = …`): a relative input is not known. */
  unknownBase?: true;
  /** A superagent agent: its verb methods are requests, it is not called itself. */
  agent?: true;
}
/** What creates an instance of each library. */
const INSTANCE_MAKERS: Record<string, ReadonlySet<string>> = {
  axios: new Set(["create"]),
  got: new Set(["extend"]),
  ky: new Set(["create", "extend"]),
};
/** The option that gives an instance its base URL. */
const BASE_OPTION: Record<string, string> = { axios: "baseURL", got: "prefixUrl", ky: "prefixUrl" };
/**
 * Options that change the address in ways not read here: their call or instance is an unknown
 * row. got before 10 had `baseUrl`; ky 2 renamed `prefixUrl` to `prefix` and added `baseUrl`;
 * `allowAbsoluteUrls` changes whether an absolute URL bypasses the base.
 */
const ADDRESS_OPTIONS: Record<string, readonly string[]> = {
  axios: ["baseURL", "allowAbsoluteUrls", "socketPath", "url"],
  got: ["prefixUrl", "baseUrl", "allowAbsoluteUrls", "url"],
  ky: ["prefixUrl", "prefix", "baseUrl", "url"],
  superagent: [],
  needle: [],
  lib: [],
};
/** Words that start an expression; an argument starting with one is no name. */
const OPERATOR_WORDS = new Set([
  "new",
  "await",
  "typeof",
  "void",
  "function",
  "class",
  "yield",
  "async",
  "delete",
]);
/** Options that change where a request goes and are not read: their row is unknown. */
const ADDRESS_OVERRIDES = ["port", "defaultPort", "socketPath", "lookup", "createConnection"];
/** An unknown row: a request whose address is not read, `expression` saying what was not. */
const unknownRead = (expression: string): Read => ({
  value: null,
  evidence: "unknown",
  expression,
});
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
const WRITE_OPERATORS = ASSIGNMENT_OPERATORS;
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
  /** Read through call sites, and some of them could not be read: the values are not all. */
  partial?: true;
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
      const before = value;
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
          return {
            value: null,
            evidence: "unknown",
            // `new U(…)`, `await x`: an expression, not a name
            expression: OPERATOR_WORDS.has(t.value) ? "<expression>" : t.value,
          };
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
      // `"…".replace(…)`, `` `…`.slice(8) ``, `s[0]`: a method or member of the part makes another
      // string, which may be any address; the part's own text is not the value (#196).
      const after = tokens[j + 1];
      if (is(after, "punct", ".") || is(after, "punct", "?.") || is(after, "punct", "[")) {
        if (parts === 0) return { value: null, evidence: "unknown", expression: "<expression>" };
        return { value: `${before}\${…}`, evidence: "template" };
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
      ...(found!.partial ? { partial: true as const } : {}),
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
    if (open && (out.openKeys ??= []).length < MAX_OPEN_KEYS)
      out.openKeys.push({ at: k, kind, ...(extra.op ? { op: extra.op } : {}) });
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
    // past the call sites read, a key may be anything: said by the unknown row below
    let unread = !!calls.capped;
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
  // bundler's interop call, `import h from "https"`, `import * as h from "https"`): their verb
  // methods are requests whatever the name is. `functions`: a request function bound by name
  // (`const { get } = require("https")`, `import { request as r } from "node:http"`).
  // Electron's module object (`require("electron")`) is a client through its `net` member, and
  // `net` itself when it is bound from it. Each entry keeps the token of its declaration: a call
  // is the module's only where its name means that declaration (`refersTo`), and a name that is
  // assigned again anywhere is no client at all.
  // Webpack modules that only pass a module on (`7(e) { e.exports = require("https") }`, also
  // `7: function (e) {…}` and arrows): their id, and whether that module is a client. An id
  // written twice with different modules is not known.
  let webpackIds: Map<string, ClientModule | "other" | null> | null = null;
  const webpackModule = (id: string): ClientModule | "other" | null | undefined => {
    if (!webpackIds) {
      webpackIds = new Map();
      const scopes = (wrapperResolver ??= makeResolver());
      for (let k = 2; k + 3 < tokens.length; k++) {
        if (
          !is(tokens[k], "ident", "require") ||
          !is(tokens[k + 1], "punct", "(") ||
          tokens[k + 2]?.type !== "string" ||
          !is(tokens[k - 1], "punct", "=") ||
          !is(tokens[k - 2], "ident", "exports") ||
          !is(tokens[k - 3], "punct", ".") ||
          !is(tokens[k - 4], "ident")
        )
          continue;
        const def = scopes.functionAt(k);
        const first = def?.params[0];
        if (!def || first?.kind !== "name" || first.name !== tokens[k - 4]!.value) continue;
        const p = def.paramsAt;
        const key = [p - 1, p - 2, p - 3].find((j) => {
          const x = tokens[j];
          return (
            (x?.type === "number" || x?.type === "string") &&
            (j === p - 1 || is(tokens[j + 1], "punct", ":"))
          );
        });
        if (key === undefined) continue;
        const moduleId = tokens[key]!.value;
        const module = clientModule(tokens[k + 2]) ?? "other";
        const before = webpackIds.get(moduleId);
        webpackIds.set(moduleId, before === undefined || before === module ? module : null);
      }
    }
    return webpackIds.get(id);
  };
  /**
   * The keyword that declares the name at j (`const|let|var NAME = …`, also later in a list),
   * or -1.
   */
  const declarationKeyword = (j: number): number => {
    if (/^(const|let|var)$/.test(tokens[j - 1]?.value ?? ""))
      return tokens[j - 1]!.type === "ident" ? j - 1 : -1;
    if (!is(tokens[j - 1], "punct", ",")) return -1;
    // `var a = r(x), NAME = …`: back over the list at its own depth to the keyword
    for (let m = j - 2, depth = 0; m >= 0 && m > j - 400; m--) {
      const x = tokens[m]!;
      // a line break outside a list's commas may end a statement (ASI)
      if (
        depth === 0 &&
        x.line !== tokens[m + 1]!.line &&
        !is(x, "punct", ",") &&
        !is(tokens[m + 1], "punct", ",")
      )
        return -1;
      if (x.type === "punct") {
        if (x.value === ")" || x.value === "]" || x.value === "}") depth++;
        else if (x.value === "(" || x.value === "[" || x.value === "{") {
          if (depth === 0) return -1;
          depth--;
        } else if (depth === 0 && x.value === ";") return -1;
      } else if (depth === 0 && x.type === "ident" && /^(const|let|var)$/.test(x.value)) return m;
    }
    return -1;
  };
  const declaresAt = (j: number): boolean => declarationKeyword(j) !== -1;
  /** The declaration of the name at j is exported (`export const api = …`). */
  const exported = (j: number): boolean => {
    const kw = declarationKeyword(j);
    return kw !== -1 && is(tokens[kw - 1], "ident", "export");
  };
  /** Positions of every identifier by name (the resolver's index when it is built). */
  let ownNames: Map<string, number[]> | null = null;
  const positionsOf = (name: string): readonly number[] => {
    const built = builtIdentifierIndex(tokens);
    if (built) return built.get(name) ?? [];
    if (!ownNames) {
      ownNames = new Map();
      for (let k = 0; k < tokens.length; k++) {
        const t = tokens[k]!;
        if (t.type !== "ident") continue;
        const list = ownNames.get(t.value);
        if (list) list.push(k);
        else ownNames.set(t.value, [k]);
      }
    }
    return ownNames.get(name) ?? [];
  };
  /**
   * The range of tokens the declaration at `at` can be seen in: the block of a `let`/`const`
   * (found back over at most 4,096 tokens), else the function it is in, else the file. A wider
   * range than the real one only costs questions; `refersTo` still decides.
   */
  const scopeRange = (at: number): [number, number] => {
    const res = (wrapperResolver ??= makeResolver());
    const fn = res.functionAt(at);
    const [start, end] = fn ? fn.body : [0, tokens.length];
    const kw = tokens[at]?.type === "ident" ? declarationKeyword(at) : -1;
    if (kw === -1 || tokens[kw]!.value === "var") return [start, end];
    // the block around the keyword: up the brackets around it to the first brace
    for (let m = res.bracketAround(kw), guard = 0; m >= start && m !== -1 && guard < 256; guard++) {
      if (is(tokens[m], "punct", "{")) {
        const c = res.closeOf(m);
        return c === -1 ? [start, end] : [m, c + 1];
      }
      // a `for (let …)` head or a parenthesis: the function is wide enough
      if (is(tokens[m], "punct", "(")) break;
      m = res.bracketAround(m);
    }
    return [start, end];
  };
  /**
   * Entries indexed by the range their declaration is seen in (`scopeRange`): `around(j)` gives
   * those whose range holds j, at most `limit`, in time of the nesting, not of the entries.
   * Ranges are blocks and function bodies, so they nest.
   */
  const scopeIndex = <T extends { at: number }>(list: readonly T[]) => {
    const items = list
      .map((e) => {
        const [from, to] = scopeRange(e.at);
        return { e, from, to, parent: -1 };
      })
      .toSorted((a, b) => a.from - b.from || b.to - a.to);
    const stack: number[] = [];
    for (let i = 0; i < items.length; i++) {
      while (stack.length && items[stack.at(-1)!]!.to <= items[i]!.from) stack.pop();
      items[i]!.parent = stack.length ? stack.at(-1)! : -1;
      stack.push(i);
    }
    const starts = items.map((x) => x.from);
    return (j: number, limit = Infinity): T[] => {
      let lo = 0;
      let hi = starts.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (starts[mid]! <= j) lo = mid + 1;
        else hi = mid;
      }
      const found: T[] = [];
      for (
        let i = lo - 1, guard = 0;
        i !== -1 && found.length < limit && guard < 100_000;
        guard++
      ) {
        const x = items[i]!;
        if (x.to > j) found.push(x.e);
        i = x.parent;
      }
      return found;
    };
  };
  /**
   * The write at k is of a declaration of the name in the write's own scope that is not one of
   * `entries` (`function f(e) { let o = e; o = o + 1 }`, also a `var` or a `let`/`const` declared
   * after the write, a parameter of the function the write is in): it writes that local, not a
   * client binding further out. False when a client declaration is in the same scope too, or
   * when more than 4,096 positions would have to be looked at.
   */
  let ownLocalWork = 0;
  const ownLocal = (k: number, name: string, entries: ReadonlySet<number>): boolean =>
    localIn(k, name, entries, (wrapperResolver ??= makeResolver()).functionAt(k)) === "local";
  /**
   * What declares the name at k in function `fn` (null: the top of the file): `local` a
   * declaration that is none of `entries`, `client` one of them (or one too many positions to
   * look at), `none` nothing.
   */
  const localIn = (
    k: number,
    name: string,
    entries: ReadonlySet<number>,
    fn: ReturnType<ExpressionResolver["functionAt"]>,
  ): "local" | "client" | "none" => {
    const res = (wrapperResolver ??= makeResolver());
    if (fn && fn.params.some((p) => p.kind === "name" && p.name === name)) return "local";
    const [start, end] = fn ? fn.body : [0, tokens.length];
    const all = positionsOf(name);
    let lo = 0;
    let hi = all.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (all[mid]! < start) lo = mid + 1;
      else hi = mid;
    }
    let local = false;
    for (let i = lo, looked = 0; i < all.length && all[i]! < end; i++) {
      // past the per-file work bound the write takes the questions below instead
      if (looked++ >= 4096 || ownLocalWork++ >= 4_000_000) return "client";
      const p = all[i]!;
      if (p === k) continue;
      const before = tokens[p - 1];
      const named = is(before, "ident", "function") || is(before, "ident", "class");
      if (
        !named &&
        !is(before, "punct", ",") &&
        !(before?.type === "ident" && /^(const|let|var)$/.test(before.value))
      )
        continue;
      if (res.functionAt(p) !== fn) continue;
      const kw = named ? -1 : declarationKeyword(p);
      if (kw === -1 && !named) continue;
      // a `let`/`const`/`class` binds in its block only
      if ((kw !== -1 && tokens[kw]!.value !== "var") || is(before, "ident", "class")) {
        const [from, to] = scopeRange(p);
        if (k < from || k >= to) continue;
      }
      if (entries.has(p)) return "client";
      local = true;
    }
    return local ? "local" : "none";
  };
  /**
   * The name at k is written by a destructuring assignment (`({ api } = o)`, `({ k: api } = o)`,
   * `[api] = l`, nested, with a default or a rest) or a `for (api of …)` / `for (api in …)` head:
   * writes that have no operator after the name. A declaration pattern, a parameter pattern and
   * an object literal are none.
   */
  const patternWrite = (k: number): boolean => {
    const before = tokens[k - 1];
    const after = tokens[k + 1];
    if (
      is(before, "punct", "(") &&
      is(tokens[k - 2], "ident", "for") &&
      (is(after, "ident", "of") || is(after, "ident", "in"))
    )
      return true;
    if (before?.type !== "punct" || !/^(,|\{|\[|:|\.\.\.)$/.test(before.value)) return false;
    if (after?.type !== "punct" || !/^(,|\}|\]|=)$/.test(after.value)) return false;
    if (is(before, "punct", "{") || is(before, "punct", ",")) {
      // `{ key: … }` is a key, not a target
      if (is(after, "punct", ":")) return false;
    }
    const res = (wrapperResolver ??= makeResolver());
    let j = k;
    for (let level = 0; level < 4; level++) {
      // the bracket around j
      const o = res.bracketAround(j);
      const opener = tokens[o];
      if (o < 0 || !opener || (opener.value !== "{" && opener.value !== "[")) return false;
      const c = res.closeOf(o);
      if (c === -1) return false;
      const next = tokens[c + 1];
      // a declaration pattern, also later in a declaration list (`let a = f(), [b] = g()`)
      const declared =
        /^(const|let|var)$/.test(tokens[o - 1]?.value ?? "") ||
        (is(tokens[o - 1], "punct", ",") && declarationKeyword(o) !== -1);
      if (is(next, "punct", "=")) {
        if (declared) return false;
        // a parameter pattern with a default: `function f({ api } = {})`
        const q = res.bracketAround(o);
        if (q !== -1 && is(tokens[q], "punct", "(") && res.functionWithParamsAt(q)) return false;
        return true;
      }
      if (
        (is(next, "ident", "of") || is(next, "ident", "in")) &&
        is(tokens[o - 1], "punct", "(") &&
        is(tokens[o - 2], "ident", "for")
      )
        return true;
      // nested in a larger pattern: the bracket around this one decides
      if (
        !is(next, "punct", ",") &&
        !is(next, "punct", "}") &&
        !is(next, "punct", "]") &&
        !is(next, "punct", "=")
      )
        return false;
      if (declared) return false;
      j = o;
    }
    return false;
  };
  const clients = new Map<
    string,
    Array<{
      module: ClientModule;
      at: number;
      instance?: Instance;
      unread?: string;
      derived?: true;
    }>
  >();
  /** Every name bound to a client module, as 0.9.2 read it: its rule applies where no binding is proven. */
  const legacyClients = new Set<string>();
  /** Declarations of client names that an assignment writes to: no client where they are meant. */
  const reassignedClients = new Map<string, number[]>();
  const functions = new Map<
    string,
    Array<{ module: ClientModule; verb: string; at: number; unread?: string; derived?: true }>
  >();
  if (/require\(|import\b|\.exports\b/.test(source)) {
    const bind = (name: string, module: ClientModule, at: number): void => {
      const list = clients.get(name) ?? [];
      list.push({ module, at });
      clients.set(name, list);
    };
    const named = (local: string, imported: string, module: ClientModule, at: number): void => {
      if (module === "electron") {
        if (imported === "net") bind(local, "net", at);
        return;
      }
      if ((module !== "http" && module !== "https") || !/^(get|request)$/.test(imported)) return;
      const list = functions.get(local) ?? [];
      list.push({ module, verb: imported, at });
      functions.set(local, list);
    };
    /** `{ a, b: c, d as e }` from `open` to `close`: [imported, local] pairs, or null. */
    const pairs = (open: number, close: number, word: ":" | "as"): Array<[string, string]> => {
      const found: Array<[string, string]> = [];
      for (let j = open + 1; j < close; j++) {
        const a = tokens[j]!;
        if (a.type !== "ident") continue;
        const sep =
          word === ":" ? is(tokens[j + 1], "punct", ":") : is(tokens[j + 1], "ident", "as");
        if (sep && is(tokens[j + 2], "ident")) {
          found.push([a.value, tokens[j + 2]!.value]);
          j += 2;
        } else if (is(tokens[j + 1], "punct", ",") || j + 1 === close)
          found.push([a.value, a.value]);
      }
      return found;
    };
    for (let k = 0; k + 3 < tokens.length; k++) {
      const t = tokens[k]!;
      if (t.type !== "ident") continue;
      // `const r = n(7)` in a webpack module, where module 7 passes a client module on
      if (
        is(tokens[k + 1], "punct", "=") &&
        is(tokens[k + 2], "ident") &&
        is(tokens[k + 3], "punct", "(") &&
        tokens[k + 4]?.type === "number" &&
        is(tokens[k + 5], "punct", ")") &&
        (is(tokens[k - 1], "punct", ",") || /^(const|let|var)$/.test(tokens[k - 1]?.value ?? ""))
      ) {
        const module = webpackModule(tokens[k + 4]!.value);
        if (
          module &&
          module !== "other" &&
          (wrapperResolver ??= makeResolver()).moduleBinding(k + 1, t.value)
        )
          bind(t.value, module, k);
        continue;
      }
      if (
        t.value === "require" &&
        is(tokens[k + 1], "punct", "(") &&
        is(tokens[k + 3], "punct", ")")
      ) {
        const module = clientModule(tokens[k + 2]);
        if (!module) continue;
        // `X = require(…)`, `X = f(require(…))`; `X = require(…).member` is that member:
        // `.default` the module (an interop object), Electron's `.net`, `http(s)`'s `.get` and
        // `.request` a request function; anything else (`.create(…)`, see `derive`) no module
        if (is(tokens[k - 1], "punct", "=") && is(tokens[k - 2], "ident")) {
          const member =
            is(tokens[k + 4], "punct", ".") && is(tokens[k + 5], "ident")
              ? tokens[k + 5]!.value
              : null;
          const ends =
            !is(tokens[k + 6], "punct", ".") &&
            !is(tokens[k + 6], "punct", "?.") &&
            !is(tokens[k + 6], "punct", "(") &&
            !is(tokens[k + 6], "punct", "[") &&
            tokens[k + 6]?.type !== "template";
          if (member === null) bind(tokens[k - 2]!.value, module, k - 2);
          else if (ends && member === "default" && module !== "electron")
            bind(tokens[k - 2]!.value, module, k - 2);
          else if (ends) named(tokens[k - 2]!.value, member, module, k - 2);
        } else if (
          is(tokens[k - 1], "punct", "(") &&
          is(tokens[k - 2], "ident") &&
          is(tokens[k - 3], "punct", "=") &&
          is(tokens[k - 4], "ident")
        )
          bind(tokens[k - 4]!.value, module, k - 4);
        else if (is(tokens[k - 1], "punct", "=") && is(tokens[k - 2], "punct", "}")) {
          // `const { get, request: r } = require("https")`
          let open = k - 3;
          while (open > k - 64 && open >= 0 && !is(tokens[open], "punct", "{")) open--;
          if (
            !is(tokens[open], "punct", "{") ||
            !/^(const|let|var)$/.test(tokens[open - 1]?.value ?? "")
          )
            continue;
          for (const [imported, local] of pairs(open, k - 2, ":"))
            named(local, imported, module, open);
        }
        continue;
      }
      if (t.value !== "import" || is(tokens[k - 1], "punct", ".")) continue;
      // `import X from "m"`, `import * as X from "m"`, `import X, { a as b } from "m"`
      let j = k + 1;
      let local: string | null = null;
      if (
        is(tokens[j], "punct", "*") &&
        is(tokens[j + 1], "ident", "as") &&
        is(tokens[j + 2], "ident")
      ) {
        local = tokens[j + 2]!.value;
        j += 3;
      } else if (is(tokens[j], "ident") && tokens[j]!.value !== "from") {
        local = tokens[j]!.value;
        j++;
        if (is(tokens[j], "punct", ",")) j++;
      }
      let open = -1;
      let close = -1;
      if (is(tokens[j], "punct", "{")) {
        open = j;
        while (j < k + 200 && j < tokens.length && !is(tokens[j], "punct", "}")) j++;
        close = j;
        j++;
      }
      if (!is(tokens[j], "ident", "from")) continue;
      const module = clientModule(tokens[j + 1]);
      if (!module) continue;
      if (local !== null) bind(local, module, k);
      if (open !== -1)
        for (const [imported, name] of pairs(open, close, "as")) named(name, imported, module, k);
    }
    // A binding that is assigned again is not known to hold the module: an assignment whose
    // name means that binding (`h = mock`) removes it. A declaration of the name elsewhere, a
    // parameter default or a class field is no assignment; it shadows only where it is visible
    // (`refersTo`). Such a name is still a client by the rule of 0.9.2 (`legacyClients`).
    const declared = new Set([...clients.keys(), ...functions.keys()]);
    for (const name of declared) legacyClients.add(name);
    let writes = 0;
    let writeChecks = 0;
    /** Each name's declarations by the range they are seen in (see `scopeIndex`). */
    const byScope = new Map<
      string,
      (j: number, limit?: number) => Array<{ at: number; module: ClientModule }>
    >();
    const removed = new Set<{ at: number; module: ClientModule }>();
    const entryAts = new Map<string, Set<number>>();
    const changed = new Set<string>();
    // Where the file's identifier index is already built (resolve.ts, shared by every resolver of
    // these tokens), only the places of the declared names are visited, in token order: the same
    // tokens the walk below stops at. Without one, or for names used too often, the walk.
    const index = declared.size ? builtIdentifierIndex(tokens) : null;
    let places: number[] | null = null;
    if (index) {
      places = [];
      for (const name of declared) for (const k of index.get(name) ?? []) places.push(k);
      if (places.length > tokens.length >> 4) places = null;
      else places.sort((a, b) => a - b);
    }
    /**
     * The writes from place `from` on are not checked: every declaration of a name written there
     * counts as written (its calls are unknown rows where they mean it), and the file is flagged.
     */
    const giveUp = (from: number): void => {
      out.clientWritesSkipped = true;
      const unchecked = new Set<string>();
      for (let i = from; places ? i < places.length : i + 1 < tokens.length; i++) {
        const k = places ? places[i]! : i;
        if (k < 1 || k + 1 >= tokens.length) continue;
        const t = tokens[k]!;
        if (t.type !== "ident" || !declared.has(t.value) || unchecked.has(t.value)) continue;
        if (is(tokens[k - 1], "punct", ".") || is(tokens[k - 1], "punct", "?.")) continue;
        const after = tokens[k + 1]!;
        const before = tokens[k - 1]!;
        // a declaration is no write
        if (before.type === "ident" && /^(const|let|var)$/.test(before.value)) continue;
        if (
          (after.type === "punct" &&
            (WRITE_OPERATORS.has(after.value) || after.value === "++" || after.value === "--")) ||
          (before.type === "punct" && (before.value === "++" || before.value === "--")) ||
          patternWrite(k)
        )
          unchecked.add(t.value);
      }
      for (const name of unchecked) {
        const gone = reassignedClients.get(name) ?? [];
        for (const list of [clients.get(name), functions.get(name)])
          for (const c of list ?? []) if (!removed.has(c)) gone.push(c.at);
        reassignedClients.set(name, gone);
        clients.delete(name);
        functions.delete(name);
        changed.delete(name);
      }
    };
    if (declared.size)
      for (let i = places ? 0 : 1; places ? i < places.length : i + 1 < tokens.length; i++) {
        const k = places ? places[i]! : i;
        if (k < 1 || k + 1 >= tokens.length) continue;
        const t = tokens[k]!;
        if (t.type !== "ident") continue;
        const after = tokens[k + 1]!;
        const before = tokens[k - 1]!;
        // the shape of a write first (two token reads), the name only then
        const operator =
          (after.type === "punct" &&
            (WRITE_OPERATORS.has(after.value) || after.value === "++" || after.value === "--")) ||
          (before.type === "punct" && (before.value === "++" || before.value === "--"));
        if (!declared.has(t.value) || is(before, "punct", ".") || is(before, "punct", "?."))
          continue;
        const pattern = !operator && patternWrite(k);
        if (!operator && !pattern) continue;
        const binder = (wrapperResolver ??= makeResolver());
        // a declaration (`let o = e`, also later in a list) writes nothing
        if (operator && is(after, "punct", "=") && declaresAt(k)) continue;
        // a write of a local of the write's own scope: no question, and no part of the budget
        let ats = entryAts.get(t.value);
        if (!ats) {
          ats = new Set(
            [...(clients.get(t.value) ?? []), ...(functions.get(t.value) ?? [])].map((c) => c.at),
          );
          entryAts.set(t.value, ats);
        }
        if (ownLocal(k, t.value, ats)) continue;
        // More writes than are checked, or scopes the resolver does not read (a file with more
        // functions than MAX_FUNCTIONS): the names written from here on are not proven clients,
        // and their calls are unknown rows (limitation `client_writes_skipped`).
        if (writes++ >= MAX_CLIENT_CALLS || !binder.readsAllFunctions()) {
          giveUp(i);
          break;
        }
        // `h = require("http")`: another client module; the binding stays a client (a client
        // of either module, so an options object without `protocol` is not read)
        const another =
          is(after, "punct", "=") &&
          is(tokens[k + 2], "ident", "require") &&
          is(tokens[k + 3], "punct", "(") &&
          is(tokens[k + 5], "punct", ")") &&
          !is(tokens[k + 6], "punct", ".") &&
          !is(tokens[k + 6], "punct", "(") &&
          !is(tokens[k + 6], "punct", "[")
            ? clientModule(tokens[k + 4])
            : null;
        // A write can only mean a declaration in one of the functions around it (or at the top
        // of the file): only those are asked about, through an index of each name's
        // declarations by function, and the questions are bounded too (past the bound, 0.9.2's
        // rule), so many declarations of one name written many times stay linear.
        let around = byScope.get(t.value);
        if (!around) {
          around = scopeIndex([...(clients.get(t.value) ?? []), ...(functions.get(t.value) ?? [])]);
          byScope.set(t.value, around);
        }
        let over = false;
        let matched = false;
        const candidates = around(k);
        for (const c of candidates) {
          if (removed.has(c)) continue;
          if (writeChecks++ >= MAX_WRITE_QUESTIONS) {
            over = true;
            break;
          }
          if (pattern ? !binder.refersTo(k, t.value, c.at) : !binder.writesTo(k, t.value, c.at))
            continue;
          matched = true;
          if (!pattern && another && another !== "electron" && c.module !== "electron") {
            if (c.module !== another) c.module = "lib";
            continue;
          }
          removed.add(c);
          changed.add(t.value);
          const gone = reassignedClients.get(t.value) ?? [];
          gone.push(c.at);
          reassignedClients.set(t.value, gone);
        }
        if (over) {
          giveUp(i);
          break;
        }
        // A write that means no single declaration, though the binding it sees is one of them
        // (`var h = require("https")` declared twice in one scope): any of them may be written.
        if (
          !matched &&
          !(tokens[k - 1]!.type === "ident" && /^(const|let|var)$/.test(tokens[k - 1]!.value))
        ) {
          const b = binder.boundAround(k, t.value);
          const found = b?.kind === "local" ? b.site : undefined;
          // the declaration itself (also in a list or a pattern) writes nothing
          const site =
            found && found.name !== k && (pattern || binder.assignsName(k, t.value))
              ? found
              : undefined;
          // only the declarations in the scope of the one the write sees
          const range = site ? scopeRange(site.name) : null;
          const same = range
            ? candidates.filter((c) => {
                const [from, to] = scopeRange(c.at);
                return from === range[0] && to === range[1];
              })
            : [];
          if (site && same.length > 1 && same.some((c) => c.at === site.name))
            for (const c of same) {
              if (removed.has(c)) continue;
              removed.add(c);
              changed.add(t.value);
              const gone = reassignedClients.get(t.value) ?? [];
              gone.push(c.at);
              reassignedClients.set(t.value, gone);
            }
        }
      }
    for (const name of changed) {
      const c = clients.get(name)?.filter((x) => !removed.has(x)) ?? [];
      const f = functions.get(name)?.filter((x) => !removed.has(x)) ?? [];
      if (c.length) clients.set(name, c);
      else clients.delete(name);
      if (f.length) functions.set(name, f);
      else functions.delete(name);
    }
  }
  /**
   * The file assigns the name where no binding of it is visible (`h = require("https")` and
   * `h = other` on an undeclared global). Only for a name with at most 4,096 positions; past
   * that, false.
   */
  const globalWrites = new Map<string, boolean>();
  const globalWritten = (name: string): boolean => {
    const known = globalWrites.get(name);
    if (known !== undefined) return known;
    const binder = (wrapperResolver ??= makeResolver());
    const all = positionsOf(name);
    // a name used more often (a minifier's short name) is not looked at: the name rule, which
    // reads only an address written at the call, applies as in 0.9.8
    let result = false;
    for (let i = 0; all.length <= 4096 && !result && i < all.length; i++) {
      const p = all[i]!;
      if (is(tokens[p - 1], "punct", ".") || is(tokens[p - 1], "punct", "?.")) continue;
      const after = tokens[p + 1];
      const operator =
        after?.type === "punct" &&
        (WRITE_OPERATORS.has(after.value) || after.value === "++" || after.value === "--");
      if (!operator && !patternWrite(p)) continue;
      if (operator && !binder.assignsName(p, name)) continue;
      // no binding the scope tables see, nor a local the call's functions declare
      if (binder.boundAround(p, name) === null && !localAt(p)) result = true;
    }
    globalWrites.set(name, result);
    return result;
  };
  let reassignQuestions = 0;
  /** Reassigned declarations of each name by the range they are seen in (see `reassignedAt`). */
  const reassignedByScope = new Map<string, (j: number, limit?: number) => Array<{ at: number }>>();
  /** The name at j means a declaration of it that an assignment writes to. */
  const reassignedAt = (j: number, name: string): boolean => {
    const all = reassignedClients.get(name);
    if (!all) return false;
    const binder = (wrapperResolver ??= makeResolver());
    let around = reassignedByScope.get(name);
    if (!around) {
      around = scopeIndex(all.map((at) => ({ at })));
      reassignedByScope.set(name, around);
    }
    for (const { at } of around(j)) {
      // past the budget the declaration meant is not known: taken as written
      if (reassignQuestions++ >= MAX_WRITE_QUESTIONS) {
        out.clientWritesSkipped = true;
        return true;
      }
      if (binder.refersTo(j, name, at)) return true;
    }
    // the binding seen at j is one of them, declared again in its scope (see the write loop)
    const b = binder.boundAround(j, name);
    return b?.kind === "local" && !!b.site && all.includes(b.site.name);
  };
  // Calls checked against the bindings per file; above the cap, client calls are not read
  // (limitation `client_calls_skipped`), so no input makes the check slow.
  let clientChecks = 0;
  const refers = (j: number, at: number): boolean => {
    if (clientChecks++ >= MAX_CLIENT_CALLS) {
      // above the cap, calls are read by 0.9.2's name rule (see the verb branch below)
      out.clientsSkipped = true;
      return false;
    }
    const res = (wrapperResolver ??= makeResolver());
    // a declaration in a function past those the resolver reads (MAX_FUNCTIONS) would look like
    // one of the top of the file: its scope is not known, so it proves nothing
    if (!res.readsAllFunctions() && res.functionAt(at) === null && res.bracketAround(at) !== -1) {
      out.clientWritesSkipped = true;
      return false;
    }
    // a `let`/`const` declared in a block is not seen outside it (`refersTo` asks the function)
    let range = rangeCache.get(at);
    if (!range) rangeCache.set(at, (range = scopeRange(at)));
    if (j < range[0] || j >= range[1]) return false;
    return (wrapperResolver ??= makeResolver()).refersTo(j, tokens[j]!.value, at);
  };
  const rangeCache = new Map<number, [number, number]>();
  const means = (j: number, list: Array<{ at: number }> | undefined): boolean =>
    !!list?.some((c) => refers(j, c.at));
  /**
   * What the declaration at `site` (name token, keyword) is initialised with: `client` for
   * `require("<client module>")` (also through an interop call or a destructuring pattern) or
   * webpack's `n(<id>)` of a module that passes a client module on; `other` for another module;
   * `unknown` for `n(<id>)` of a module this file does not show; null for anything else.
   */
  const moduleKind = (
    site: { name: number; word: number },
    at: number,
  ): "client" | "other" | "unknown" | null => {
    let eq = site.name + 1;
    if (site.word !== site.name - 1) {
      const close = (wrapperResolver ??= makeResolver()).closeOf(site.word + 1);
      if (close === -1) return null;
      eq = close + 1;
    }
    if (!is(tokens[eq], "punct", "=")) return null;
    const a = eq + 1;
    const required = (j: number): boolean =>
      is(tokens[j], "ident", "require") &&
      is(tokens[j + 1], "punct", "(") &&
      tokens[j + 2]?.type === "string" &&
      is(tokens[j + 3], "punct", ")");
    const spec = required(a)
      ? tokens[a + 2]
      : is(tokens[a], "ident") && is(tokens[a + 1], "punct", "(") && required(a + 2)
        ? tokens[a + 4]
        : undefined;
    if (spec) return clientModule(spec) ? "client" : "other";
    // `const r = n(5)` with n the webpack module function's require parameter
    if (
      site.word === site.name - 1 &&
      is(tokens[a], "ident") &&
      is(tokens[a + 1], "punct", "(") &&
      tokens[a + 2]?.type === "number" &&
      is(tokens[a + 3], "punct", ")") &&
      (wrapperResolver ??= makeResolver()).moduleBinding(at, tokens[at]!.value)
    ) {
      const known = webpackModule(tokens[a + 2]!.value);
      return known === "other" ? "other" : known ? "client" : "unknown";
    }
    return null;
  };
  type ClientEntry = {
    module: ClientModule;
    at: number;
    instance?: Instance;
    unread?: string;
    /** Made from another binding (an instance, a function value): no request before it. */
    derived?: true;
  };
  /** The binding of `clients` the name at j means, or null. */
  /** The positions of `name` inside the function the token at `decl` is in (the file at the top). */
  const positionsAround = (
    name: string,
    decl: number,
  ): { all: readonly number[]; from: number; to: number } => {
    const all = positionsOf(name);
    const [start, end] = scopeRange(decl);
    let lo = 0;
    let hi = all.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (all[mid]! < start) lo = mid + 1;
      else hi = mid;
    }
    let to = lo;
    let top = all.length;
    while (to < top) {
      const mid = (to + top) >> 1;
      if (all[mid]! < end) to = mid + 1;
      else top = mid;
    }
    return { all, from: lo, to };
  };
  // Owners of derived bindings, by name and range (built once per name), and a budget for the
  // questions: past it, no owner is proven (and the file is flagged).
  const ownerIndex = new Map<string, (j: number, limit?: number) => ClientEntry[]>();
  let ownerQuestions = 0;
  /** The binding of `clients` the name at j means, or null. */
  const entryAt = (j: number): ClientEntry | null => {
    const name = tokens[j]!.value;
    const list = clients.get(name);
    if (!list) return null;
    const binder = (wrapperResolver ??= makeResolver());
    let around = ownerIndex.get(name);
    if (!around) {
      around = scopeIndex(list);
      ownerIndex.set(name, around);
    }
    for (const c of around(j)) {
      if (ownerQuestions++ >= MAX_WRITE_QUESTIONS) {
        out.clientWritesSkipped = true;
        return null;
      }
      if (binder.refersTo(j, name, c.at)) return c;
    }
    return null;
  };
  /**
   * Every use of the instance declared at `decl` is a request: `NAME.<verb>(…)` or (`callable`)
   * `NAME(…)`. Any other use that means it (`NAME.defaults…`, `NAME.interceptors…`, passed as an
   * argument, assigned, exported) may change where its requests go. At most 4,096 uses are
   * looked at and 64 of them asked about; past that, false.
   */
  const onlyCalled = (name: string, decl: number, callable: boolean): boolean => {
    const { all, from, to } = positionsAround(name, decl);
    if (to - from > 4096) return false;
    let asked = 0;
    for (let i = from; i < to; i++) {
      const p = all[i]!;
      if (p === decl) continue;
      const before = tokens[p - 1];
      const after = tokens[p + 1];
      if (is(before, "punct", ".") || is(before, "punct", "?.")) continue;
      // a key of an object literal or pattern: `{ api: x }`
      if (is(after, "punct", ":") && (is(before, "punct", "{") || is(before, "punct", ",")))
        continue;
      if (
        (is(after, "punct", ".") || is(after, "punct", "?.")) &&
        HTTP_VERBS.has(tokens[p + 2]?.value ?? "") &&
        is(tokens[p + 3], "punct", "(")
      )
        continue;
      if (callable && is(after, "punct", "(")) continue;
      if (asked++ >= 64) return false;
      if ((wrapperResolver ??= makeResolver()).refersTo(p, name, decl)) return false;
    }
    return true;
  };
  /**
   * The library binding `e` has its defaults, interceptors or hooks changed in the file
   * (`axios.defaults.baseURL = …`, also on an interop object, `o.default.defaults`): where its
   * requests go is not known from the call alone.
   */
  const touchedCache = new Map<ClientEntry, boolean>();
  const touched = (e: ClientEntry, name: string): boolean => {
    const known = touchedCache.get(e);
    if (known !== undefined) return known;
    let result = false;
    const { all, from, to } = positionsAround(name, e.at);
    if (to - from > 65_536) result = true;
    let asked = 0;
    for (let i = from; !result && i < to; i++) {
      const p = all[i]!;
      if (is(tokens[p - 1], "punct", ".") || !is(tokens[p + 1], "punct", ".")) continue;
      const m = tokens[p + 2]?.value;
      const member = m === "default" && is(tokens[p + 3], "punct", ".") ? tokens[p + 4]?.value : m;
      if (member !== "defaults" && member !== "interceptors" && member !== "hooks") continue;
      if (asked++ >= 64 || (wrapperResolver ??= makeResolver()).refersTo(p, name, e.at))
        result = true;
    }
    touchedCache.set(e, result);
    return result;
  };
  /**
   * `key: value` pairs at the top level of the object literal that opens at `objectAt`, with the
   * token each value starts at and where it ends. `spread`: the literal has a part that is not
   * read (a spread, a computed key, a method). Null for a literal longer than 300 tokens.
   */
  const literalKeys = (
    objectAt: number,
  ): { keys: Map<string, { at: number; end: number }>; spread: boolean } | null => {
    const close = (wrapperResolver ??= makeResolver()).closeOf(objectAt);
    if (close === -1 || close - objectAt > 300) return null;
    const keys = new Map<string, { at: number; end: number }>();
    let spread = false;
    for (let j = objectAt + 1; j < close;) {
      const end = Math.min(wrapperResolver.endOf(j), close);
      const a = tokens[j]!;
      if ((a.type === "ident" || a.type === "string") && is(tokens[j + 1], "punct", ":"))
        keys.set(a.value, { at: j + 2, end });
      else if (a.type === "ident" && end === j + 1) keys.set(a.value, { at: j, end });
      else spread = true;
      if (end <= j) return null;
      j = end + 1;
    }
    return { keys, spread };
  };
  /** A method written as one string literal at `value`: upper case, or null when it is not one. */
  const methodAt = (value: { at: number; end: number }): string | null => {
    const m = tokens[value.at]!;
    return value.end === value.at + 1 &&
      (m.type === "string" || (m.type === "template" && !m.value.includes("${"))) &&
      /^[A-Za-z]{3,7}$/.test(m.value)
      ? m.value.toUpperCase()
      : null;
  };
  /** One known string at `value`: a literal or a constant, written as nothing else. */
  const oneString = (value: { at: number; end: number }): string | null => {
    if (value.end !== value.at + 1) return null;
    const r = readArg(value.at, true);
    if (!r || r.value === null || r.more || r.partial) return null;
    return r.value.includes("${…}") || r.value.includes(REF_OPEN) ? null : r.value;
  };
  /**
   * The instance the `create`/`extend` call at w makes (`axios.create({ baseURL })`, also on an
   * interop object, `X.default.create(…)`, and on `require("axios")` itself), when the object it
   * is called on is a proven binding of that library. Its defaults are read only from an object
   * literal; anything else makes its requests unknown rows.
   */
  const instanceAt = (
    w: number,
  ): { module: ClientModule; instance: Instance; unread?: string } | null => {
    if (!is(tokens[w - 1], "punct", ".") || !is(tokens[w + 1], "punct", "(")) return null;
    let end = w - 2;
    const viaDefault = is(tokens[end], "ident", "default") && is(tokens[end - 1], "punct", ".");
    if (viaDefault) end -= 2;
    let module: ClientModule | null = null;
    let parent = false;
    if (is(tokens[end], "punct", ")")) {
      if (
        is(tokens[end - 3], "ident", "require") &&
        is(tokens[end - 2], "punct", "(") &&
        !is(tokens[end - 4], "punct", ".")
      )
        module = clientModule(tokens[end - 1]);
    } else if (
      is(tokens[end], "ident") &&
      !is(tokens[end - 1], "punct", ".") &&
      !is(tokens[end - 1], "punct", "?.")
    ) {
      const e = entryAt(end);
      if (e && !(viaDefault && e.instance)) {
        module = e.module;
        // made from an instance, or from a library whose defaults the file changes
        parent = !!e.instance || !!e.unread || touched(e, tokens[end]!.value);
      }
    }
    if (!module || !INSTANCE_MAKERS[module]?.has(tokens[w]!.value)) return null;
    // an instance made from an instance: what it keeps of the first one's defaults is not read
    if (parent) return { module, instance: {}, unread: "<expression>" };
    const open = w + 1;
    const res = (wrapperResolver ??= makeResolver());
    const close = res.closeOf(open);
    if (close === open + 1) return { module, instance: {} };
    if (!is(tokens[open + 1], "punct", "{") || res.closeOf(open + 1) + 1 !== close)
      return { module, instance: {}, unread: "<options>" };
    const lit = literalKeys(open + 1);
    if (!lit || lit.spread) return { module, instance: {}, unread: "<options>" };
    const baseKey = BASE_OPTION[module]!;
    for (const key of ADDRESS_OPTIONS[module] ?? [])
      if (key !== baseKey && lit.keys.has(key))
        return { module, instance: {}, unread: `options.${key}` };
    const instance: Instance = {};
    const m = lit.keys.get("method");
    if (m) instance.method = methodAt(m);
    const b = lit.keys.get(baseKey);
    if (b) {
      const base = oneString(b);
      // the base and the input are joined as text: a query or fragment in the base would swallow
      // the input (got refuses it)
      const usable =
        base !== null && (ABSOLUTE.test(base) || /^\/(?!\/)/.test(base)) && !/[?#]/.test(base);
      if (!usable) return { module, instance, unread: `options.${baseKey}` };
      instance.base = base;
    }
    return { module, instance };
  };

  // Bindings made from a client binding: an instance with its defaults (`const api =
  // axios.create({ baseURL })`, `got.extend({ prefixUrl })`, `ky.create(…)`), a request function
  // held as a value (`const req = https.request`, `const l = net.request`, `const l =
  // E.net.request`, `const { get } = https`) and Electron's `net` taken from the module object
  // (`const { net } = E`). Each must be a declaration (`const|let|var NAME = …`) whose value is
  // that one expression; a name that an assignment writes to gives unknown rows where it is meant.
  /** Writes of each name in token order, without declarations; `pattern`: no operator after it. */
  let writeShapes: Map<string, Array<{ at: number; pattern: boolean }>> | null = null;
  let derivedWrites = 0;
  /**
   * The declaration at `decl` is written again: an assignment, `++`/`--`, a destructuring
   * assignment or a `for (… of|in …)` head that means it. Only writes in the function the
   * declaration is in can; at most 64 of them are asked about per declaration (and
   * MAX_WRITE_QUESTIONS per file), and past that, or where the resolver does not read every
   * function of the file, the declaration counts as written and the file is flagged.
   */
  const writtenAgain = (name: string, decl: number): boolean => {
    const res = (wrapperResolver ??= makeResolver());
    if (!res.readsAllFunctions()) {
      out.clientWritesSkipped = true;
      return true;
    }
    if (!writeShapes) {
      writeShapes = new Map();
      for (let j = 1; j + 1 < tokens.length; j++) {
        const x = tokens[j]!;
        if (x.type !== "ident") continue;
        const before = tokens[j - 1]!;
        if (is(before, "punct", ".") || is(before, "punct", "?.")) continue;
        const after = tokens[j + 1]!;
        const operator =
          (after.type === "punct" &&
            (WRITE_OPERATORS.has(after.value) || after.value === "++" || after.value === "--")) ||
          (before.type === "punct" && (before.value === "++" || before.value === "--"));
        const pattern = !operator && patternWrite(j);
        if (!operator && !pattern) continue;
        // a declaration is no write
        if (operator && is(after, "punct", "=") && declaresAt(j)) continue;
        const list = writeShapes.get(x.value);
        const w = { at: j, pattern };
        if (list) list.push(w);
        else writeShapes.set(x.value, [w]);
      }
    }
    const list = writeShapes.get(name) ?? [];
    const [from, to] = scopeRange(decl);
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid]!.at < from) lo = mid + 1;
      else hi = mid;
    }
    let asked = 0;
    for (let i = lo; i < list.length && list[i]!.at < to; i++) {
      const { at: j, pattern } = list[i]!;
      if (j === decl) continue;
      if (asked++ >= 64 || derivedWrites++ >= MAX_WRITE_QUESTIONS) {
        out.clientWritesSkipped = true;
        return true;
      }
      if (pattern ? res.refersTo(j, name, decl) : res.writesTo(j, name, decl)) return true;
    }
    return false;
  };
  let derived = 0;
  const scopes = (): ExpressionResolver => (wrapperResolver ??= makeResolver());
  const derive = (): void => {
    if (
      !clients.size &&
      !/require\(\s*["'`](?:axios|got|ky|superagent)["'`]\s*\)\s*\./.test(source)
    )
      return;
    for (let k = 1; k + 3 < tokens.length; k++) {
      if (!is(tokens[k + 1], "punct", "=")) continue;
      const v = k + 2;
      const head = tokens[v];
      if (head?.type !== "ident") continue;
      const name = tokens[k]!;
      // `const { get, request: r } = https`, `const { net } = electron`
      if (is(name, "punct", "}")) {
        const open = scopes().openOf(k);
        if (
          open === -1 ||
          !/^(const|let|var)$/.test(tokens[open - 1]?.value ?? "") ||
          scopes().endOf(v) !== v + 1 ||
          !clients.has(head.value)
        )
          continue;
        if (derived++ >= MAX_CLIENT_CALLS) {
          out.clientWritesSkipped = true;
          return;
        }
        const e = entryAt(v);
        if (!e || e.instance || e.unread) continue;
        for (let j = open + 1; j < k;) {
          const end = Math.min(scopes().endOf(j), k);
          const a = tokens[j]!;
          let local = -1;
          if (a.type === "ident" && end === j + 1) local = j;
          else if (
            a.type === "ident" &&
            is(tokens[j + 1], "punct", ":") &&
            is(tokens[j + 2], "ident") &&
            end === j + 3
          )
            local = j + 2;
          if (local !== -1) {
            const unread = writtenAgain(tokens[local]!.value, local) ? "<expression>" : undefined;
            if ((e.module === "http" || e.module === "https") && /^(get|request)$/.test(a.value)) {
              const list = functions.get(tokens[local]!.value) ?? [];
              list.push({
                module: e.module,
                verb: a.value,
                at: local,
                derived: true,
                ...(unread ? { unread } : {}),
              });
              functions.set(tokens[local]!.value, list);
            } else if (e.module === "electron" && a.value === "net") {
              const list = clients.get(tokens[local]!.value) ?? [];
              list.push({ module: "net", at: local, derived: true, ...(unread ? { unread } : {}) });
              clients.set(tokens[local]!.value, list);
            }
          }
          if (end <= j) break;
          j = end + 1;
        }
        continue;
      }
      if (name.type !== "ident" || is(tokens[k - 1], "punct", ".")) continue;
      // the shapes first (token reads only), the bindings only then
      let w = -1;
      let fn: { owner: number; verb: string; net: boolean; via: number } | null = null;
      if (is(tokens[v + 1], "punct", ".") && is(tokens[v + 2], "ident")) {
        const m = tokens[v + 2]!.value;
        if ((m === "create" || m === "extend") && is(tokens[v + 3], "punct", "(")) w = v + 2;
        else if (
          m === "default" &&
          is(tokens[v + 3], "punct", ".") &&
          /^(create|extend)$/.test(tokens[v + 4]?.value ?? "") &&
          is(tokens[v + 5], "punct", "(")
        )
          w = v + 4;
        else if ((m === "request" || m === "get") && clients.has(head.value))
          fn = { owner: v, verb: m, net: false, via: 3 };
        else if (
          m === "default" &&
          is(tokens[v + 3], "punct", ".") &&
          /^(request|get)$/.test(tokens[v + 4]?.value ?? "") &&
          clients.has(head.value)
        )
          fn = { owner: v, verb: tokens[v + 4]!.value, net: false, via: 5 };
        else if (
          m === "net" &&
          is(tokens[v + 3], "punct", ".") &&
          is(tokens[v + 4], "ident", "request") &&
          clients.has(head.value)
        )
          fn = { owner: v, verb: "request", net: true, via: 5 };
      } else if (
        head.value === "require" &&
        is(tokens[v + 1], "punct", "(") &&
        tokens[v + 2]?.type === "string" &&
        is(tokens[v + 3], "punct", ")") &&
        is(tokens[v + 4], "punct", ".")
      ) {
        if (/^(create|extend)$/.test(tokens[v + 5]?.value ?? "") && is(tokens[v + 6], "punct", "("))
          w = v + 5;
        else if (
          is(tokens[v + 5], "ident", "default") &&
          is(tokens[v + 6], "punct", ".") &&
          /^(create|extend)$/.test(tokens[v + 7]?.value ?? "") &&
          is(tokens[v + 8], "punct", "(")
        )
          w = v + 7;
      }
      // a superagent agent: `superagent.agent()`, `require("superagent").agent()`
      let agent = -1;
      if (
        w === -1 &&
        !fn &&
        is(tokens[v + 1], "punct", ".") &&
        is(tokens[v + 2], "ident", "agent") &&
        is(tokens[v + 3], "punct", "(") &&
        is(tokens[v + 4], "punct", ")") &&
        clients.has(head.value)
      )
        agent = v + 5;
      else if (
        head.value === "require" &&
        is(tokens[v + 1], "punct", "(") &&
        is(tokens[v + 2], "string", "superagent") &&
        is(tokens[v + 3], "punct", ")") &&
        is(tokens[v + 4], "punct", ".") &&
        is(tokens[v + 5], "ident", "agent") &&
        is(tokens[v + 6], "punct", "(") &&
        is(tokens[v + 7], "punct", ")")
      )
        agent = v + 8;
      if (agent !== -1) {
        if (scopes().endOf(v) !== agent || !declaresAt(k)) continue;
        if (derived++ >= MAX_CLIENT_CALLS) {
          out.clientWritesSkipped = true;
          return;
        }
        if (head.value !== "require") {
          const e = entryAt(v);
          if (!e || e.module !== "superagent" || e.instance || e.unread) continue;
        }
        const unread =
          writtenAgain(name.value, k) || !onlyCalled(name.value, k, false) || exported(k)
            ? "<expression>"
            : undefined;
        const list = clients.get(name.value) ?? [];
        list.push({
          module: "superagent",
          at: k,
          instance: { agent: true },
          derived: true,
          ...(unread ? { unread } : {}),
        });
        clients.set(name.value, list);
        continue;
      }
      if (w === -1 && !fn) continue;
      // on a name only where the file binds that name to a module
      if (w !== -1 && head.value !== "require" && !clients.has(head.value)) continue;
      // the value must be that expression alone
      const valueEnd = scopes().endOf(v);
      const expected = fn
        ? v + fn.via
        : scopes().closeOf(w + 1) === -1
          ? -2
          : scopes().closeOf(w + 1) + 1;
      if (valueEnd !== expected) continue;
      if (!declaresAt(k)) continue;
      if (derived++ >= MAX_CLIENT_CALLS) {
        out.clientWritesSkipped = true;
        return;
      }
      const unread = writtenAgain(name.value, k) ? "<expression>" : undefined;
      if (fn) {
        const e = entryAt(fn.owner);
        if (!e || e.instance || e.unread) continue;
        const ok = fn.net
          ? e.module === "electron"
          : e.module === "net"
            ? fn.verb === "request" && fn.via === 3
            : e.module === "http" || e.module === "https";
        if (!ok) continue;
        const list = functions.get(name.value) ?? [];
        list.push({
          module: fn.net ? "net" : e.module,
          verb: fn.verb,
          at: k,
          derived: true,
          ...(unread ? { unread } : {}),
        });
        functions.set(name.value, list);
        continue;
      }
      const made = instanceAt(w);
      if (!made) continue;
      const list = clients.get(name.value) ?? [];
      // an instance used otherwise than for requests, or exported, may be changed elsewhere
      const why =
        unread ??
        made.unread ??
        (!onlyCalled(name.value, k, true) || exported(k) ? "<expression>" : undefined);
      list.push({
        module: made.module,
        at: k,
        instance: made.instance,
        derived: true,
        ...(why ? { unread: why } : {}),
      });
      clients.set(name.value, list);
    }
  };
  derive();

  /** What the call at k is a request of, when it is one of the bindings above. */
  /**
   * The bindings of `name` that the name at j can mean: those declared in a function around j or
   * at the top of the file (`refersTo` asks the same). A name declared in many functions is
   * indexed by function once, so a call costs the functions around it, not every declaration.
   */
  const nearIndex = new Map<string, (j: number, limit?: number) => Array<{ at: number }>>();
  const near = <T extends { at: number }>(
    j: number,
    map: Map<string, T[]>,
    tag: string,
    name: string,
  ): T[] | undefined => {
    const list = map.get(name);
    if (!list || list.length <= 8) return list;
    let around = nearIndex.get(tag + name) as ((j: number, limit?: number) => T[]) | undefined;
    if (!around) {
      around = scopeIndex(list);
      nearIndex.set(tag + name, around);
    }
    // no more of them than calls are left to check (each is a check)
    return around(j, MAX_CLIENT_CALLS - clientChecks + 1);
  };
  type ClientHit = { module: ClientModule; verb: string; instance?: Instance; unread?: string };
  /**
   * What a call of `hit` at token `at` is: nothing before a derived binding's declaration (an
   * instance or function value does not exist there yet); a library whose defaults the file
   * changes has a base that is not known.
   */
  const answer = (
    hit: {
      module: ClientModule;
      at: number;
      instance?: Instance;
      unread?: string;
      derived?: true;
    },
    at: number,
    verb: string,
  ): ClientHit | null => {
    if (hit.derived && at < hit.at) return null;
    const instance =
      hit.instance ??
      (isLibrary(hit.module) && touched(hit, tokens[at]!.value)
        ? { unknownBase: true as const }
        : undefined);
    return {
      module: hit.module,
      verb,
      ...(instance ? { instance } : {}),
      ...(hit.unread ? { unread: hit.unread } : {}),
    };
  };
  /**
   * The name at j is a local of the function it stands in that is no client binding: also a
   * declarator later in a list (`var t = [], n = new WeakMap`), which the scope tables do not
   * hold. Then the call is not one of the client.
   */
  const callAts = new Map<string, Set<number>>();
  const localAt = (j: number): boolean => {
    const name = tokens[j]!.value;
    let ats = callAts.get(name);
    if (!ats) {
      ats = new Set(
        [...(clients.get(name) ?? []), ...(functions.get(name) ?? [])].map((c) => c.at),
      );
      callAts.set(name, ats);
    }
    // from the call's function outward, to the one that declares a client of the name
    const res = (wrapperResolver ??= makeResolver());
    let fn = res.functionAt(j);
    for (let guard = 0; guard < 64; guard++) {
      const found = localIn(j, name, ats, fn);
      if (found !== "none") return found === "local";
      if (!fn) return false;
      fn = res.outerOf(fn);
    }
    return false;
  };
  const clientAt = (k: number): ClientHit | null => {
    const t = tokens[k]!;
    if (clientChecks >= MAX_CLIENT_CALLS) {
      // above the cap, calls are read by 0.9.2's name rule
      out.clientsSkipped = true;
      return null;
    }
    // the receiver (or the called name) is a local of the call's own function
    const head =
      !is(tokens[k - 1], "punct", ".") && !is(tokens[k - 1], "punct", "?.")
        ? k
        : is(tokens[k - 2], "ident") && !is(tokens[k - 3], "punct", ".")
          ? k - 2
          : is(tokens[k - 4], "ident") && is(tokens[k - 3], "punct", ".")
            ? k - 4
            : -1;
    if (head !== -1 && (clients.has(tokens[head]!.value) || functions.has(tokens[head]!.value)))
      if (localAt(head)) return null;
    if (!is(tokens[k - 1], "punct", ".") && !is(tokens[k - 1], "punct", "?.")) {
      if (is(tokens[k - 1], "ident", "function")) return null;
      const list = near(k, functions, "f", t.value);
      const hit = list?.find((c) => refers(k, c.at));
      if (hit) return answer(hit, k, hit.verb);
      // a request library or an instance of one called itself: `axios(url)`, `api(url)`
      const libs = near(k, clients, "c", t.value)?.filter(
        (c) => isLibrary(c.module) && !c.instance?.agent,
      );
      const lib = libs?.length ? libs.find((c) => refers(k, c.at)) : undefined;
      return lib ? answer(lib, k, "call") : null;
    }
    const owner = tokens[k - 2];
    // `(0, X.default)(…)`, `X.default(…)`: a bundler's interop object of a library, called
    if (t.value === "default") {
      if (owner?.type !== "ident" || is(tokens[k - 3], "punct", ".")) return null;
      const libs = near(k - 2, clients, "c", owner.value)?.filter(
        (c) => isLibrary(c.module) && !c.instance && !c.unread,
      );
      const lib = libs?.length ? libs.find((c) => refers(k - 2, c.at)) : undefined;
      return lib ? answer(lib, k - 2, "call") : null;
    }
    if (!HTTP_VERBS.has(t.value)) return null;
    // `axios.create({ baseURL }).get(…)`: an instance made where it is used
    if (is(owner, "punct", ")")) {
      const open = (wrapperResolver ??= makeResolver()).openOf(k - 2);
      if (open < 2 || !/^(create|extend)$/.test(tokens[open - 1]?.value ?? "")) return null;
      if (clientChecks++ >= MAX_CLIENT_CALLS) {
        out.clientsSkipped = true;
        return null;
      }
      const made = instanceAt(open - 1);
      return made
        ? {
            module: made.module,
            verb: t.value,
            instance: made.instance,
            ...(made.unread ? { unread: made.unread } : {}),
          }
        : null;
    }
    if (owner?.type !== "ident") return null;
    if (!is(tokens[k - 3], "punct", ".")) {
      const list = near(k - 2, clients, "c", owner.value)?.filter((c) => c.module !== "electron");
      const hit = list?.length ? list.find((c) => refers(k - 2, c.at)) : undefined;
      if (!hit) return null;
      if (hit.module === "net" && t.value !== "request") return null;
      return answer(hit, k - 2, t.value);
    }
    // `X.default.get(…)` (a bundler's interop object), `X.net.request(…)` (Electron)
    const root = tokens[k - 4];
    if (root?.type !== "ident" || is(tokens[k - 5], "punct", ".")) return null;
    const list = near(k - 4, clients, "c", root.value)?.filter((c) => !c.instance && !c.unread);
    if (owner.value === "net" && t.value === "request") {
      const electron = list?.filter((c) => c.module === "electron");
      return electron?.length && means(k - 4, electron) ? { module: "net", verb: "request" } : null;
    }
    if (owner.value !== "default") return null;
    const modules = list?.filter((c) => c.module !== "electron" && c.module !== "net");
    const hit = modules?.length ? modules.find((c) => refers(k - 4, c.at)) : undefined;
    return hit ? answer(hit, k - 4, t.value) : null;
  };

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

  // A request of a client module (see `clients`): the URL is read like a fetch URL, through the
  // resolver when it is a parameter, and a call whose URL cannot be read is an unknown row.
  let optionQuestions = 0;
  /** The address an options object gives (`{ hostname, path, protocol }`), only when every part of it is known. */
  const optionsAddress = (at: number, module: ClientModule): Read => {
    if (optionQuestions++ >= 64) return unknownRead("<options>");
    const v = (wrapperResolver ??= makeResolver()).valueAt(at);
    if (v?.kind !== "obj" || v.open) return unknownRead("<options>");
    /** undefined: not written; null: written, not known as one whole string. */
    const part = (key: string): string | null | undefined => {
      if (!v.props.has(key)) return undefined;
      const p = v.props.get(key);
      if (p?.kind !== "str" || p.values.length !== 1) return null;
      const text = p.values[0]!;
      return text.includes("${…}") || text.includes(REF_OPEN) ? null : text;
    };
    if (v.props.has("url")) {
      // Node's http and https take no `url` option: the request goes elsewhere
      const url = module === "net" || isLibrary(module) ? part("url") : null;
      return url && ABSOLUTE.test(url)
        ? { value: url, evidence: "inferred" }
        : unknownRead("options.url");
    }
    if (isLibrary(module)) return unknownRead("<options>");
    // a port or a socket changes where the request goes; neither is read
    for (const key of ADDRESS_OVERRIDES) if (v.props.has(key)) return unknownRead(`options.${key}`);
    const protocol = part("protocol");
    const scheme = protocol ?? (module === "https" ? "https:" : "http:");
    if (protocol === null || !/^https?:$/.test(scheme)) return unknownRead("options.protocol");
    const key = v.props.has("hostname") ? "hostname" : "host";
    const host = part(key);
    // without a host the request goes to localhost by default: that is not read as an address
    if (!host || !/^[a-z0-9.-]+$/i.test(host) || !/[a-z0-9]/i.test(host))
      return unknownRead(`options.${key === "host" && host === undefined ? "hostname" : key}`);
    const path = part("path");
    if (path === null || (path !== undefined && !path.startsWith("/")))
      return unknownRead("options.path");
    return { value: `${scheme}//${host}${path ?? "/"}`, evidence: "inferred" };
  };
  /**
   * Node's `http(s).request(url, options)` merges the options over the URL: an options object
   * written as the second argument that sets a part of the address replaces that part. The
   * result is read only when every part it sets is known; otherwise the row is unknown. Null:
   * the options change nothing of the address (or there are none written there).
   */
  const ADDRESS_KEYS = ["protocol", "hostname", "host", "path", ...ADDRESS_OVERRIDES];
  const overridden = (at: number, r: Read): Read | null => {
    const end = (wrapperResolver ??= makeResolver()).endOf(at);
    if (!is(tokens[end], "punct", ",") || !is(tokens[end + 1], "punct", "{")) return null;
    const objectAt = end + 1;
    const close = wrapperResolver.closeOf(objectAt);
    // what the literal writes at its top level: keys and spreads
    const keys = new Set<string>();
    let spread = false;
    let d = 0;
    for (let j = objectAt; close !== -1 && j < close; j++) {
      const p = tokens[j]!;
      if (p.type === "punct") {
        if (p.value === "{" || p.value === "(" || p.value === "[") d++;
        else if (p.value === "}" || p.value === ")" || p.value === "]") d--;
        else if (d === 1 && p.value === "...") spread = true;
        continue;
      }
      if (d === 1 && (is(tokens[j - 1], "punct", "{") || is(tokens[j - 1], "punct", ",")))
        keys.add(p.type === "string" ? p.value : p.value);
    }
    const sets = ADDRESS_KEYS.filter((key) => keys.has(key));
    if (!sets.length && !spread) return null;
    if (spread || close === -1) return unknownRead("<options>");
    const found = ADDRESS_OVERRIDES.find((key) => keys.has(key));
    if (found) return unknownRead(`options.${found}`);
    if (optionQuestions++ >= 64) return unknownRead("<options>");
    const v = wrapperResolver.valueAt(objectAt);
    if (v?.kind !== "obj" || v.open) return unknownRead("<options>");
    const part = (key: string): string | null | undefined => {
      if (!v.props.has(key)) return undefined;
      const p = v.props.get(key);
      if (p?.kind !== "str" || p.values.length !== 1) return null;
      const text = p.values[0]!;
      return text.includes("${…}") || text.includes(REF_OPEN) ? null : text;
    };
    for (const key of sets) if (part(key) === null) return unknownRead(`options.${key}`);
    const values: string[] = [];
    for (const value of [r.value!, ...(r.more ?? [])]) {
      if (value.includes("${…}") || value.includes(REF_OPEN))
        return unknownRead(`options.${sets[0]}`);
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        return unknownRead(`options.${sets[0]}`);
      }
      const protocol = part("protocol") ?? url.protocol;
      const given = part("hostname") ?? part("host");
      // Node takes `hostname` and `host` as a bare name; a port is its own option
      if (given !== undefined && given !== null && !/^[a-z0-9.-]+$/i.test(given))
        return unknownRead(`options.${part("hostname") !== undefined ? "hostname" : "host"}`);
      const host = given ?? url.host;
      const path = part("path") ?? `${url.pathname}${url.search}`;
      if (!/^https?:$/.test(protocol)) return unknownRead("options.protocol");
      if (!/^[a-z0-9.-]+(:\d+)?$/i.test(host)) return unknownRead("options.hostname");
      if (!path.startsWith("/")) return unknownRead("options.path");
      values.push(`${protocol}//${host}${path}`);
    }
    const [first, ...rest] = values;
    return { value: first!, evidence: "inferred", ...(rest.length ? { more: rest } : {}) };
  };
  // Unknown client rows per file: past this many, they are folded into one `<expression>` row
  // (with its count), so they cannot crowd known addresses out of the list.
  let unknownClientRows = 0;
  const pushClient = (r: Read, t: Token, method: { method?: string }): void => {
    if (r.value === null && unknownClientRows++ >= MAX_UNKNOWN_CLIENT_ROWS)
      r = { value: null, evidence: "unknown", expression: "<expression>" };
    push(out.endpoints, "http-client", r, t, method);
  };
  /** The argument at a is a function written there: `function …`, `async …`, `(…) =>`, `x =>`. */
  const isFunctionArgument = (a: number): boolean => {
    const x = tokens[a];
    if (!x) return false;
    if (x.type === "ident" && (x.value === "function" || x.value === "async")) return true;
    if (x.type === "ident" && is(tokens[a + 1], "punct", "=>")) return true;
    if (is(x, "punct", "(")) {
      const c = (wrapperResolver ??= makeResolver()).closeOf(a);
      return c !== -1 && is(tokens[c + 1], "punct", "=>");
    }
    return false;
  };
  /**
   * A request of a library (axios, got, ky, superagent, needle) or of an instance of one. The
   * address is the URL argument, or the `url` option of a config object written as the first
   * argument, joined to the instance's base by that library's rule. A config object written at
   * the call that sets an option changing the address (or spreads something) is an unknown row;
   * a config passed as a name is not read (the address is kept, the method is not known).
   */
  const libraryRequest = (
    t: Token,
    open: number,
    module: ClientModule,
    name: string,
    instance: Instance | undefined,
  ): void => {
    const res = (wrapperResolver ??= makeResolver());
    const arg = (i: number): number | null => {
      const a = res.argumentAt(open, i);
      return a === null || is(tokens[a], "punct", ")") ? null : a;
    };
    /** An object literal that is the whole argument at a. */
    const literal = (a: number | null): boolean =>
      a !== null && is(tokens[a], "punct", "{") && res.endOf(a) === res.closeOf(a) + 1;
    const verbMethod = HTTP_VERBS.has(name) && name !== "request" ? name.toUpperCase() : undefined;
    let urlAt: number | null = null;
    let configAt: number | null = null;
    let fromConfig = false;
    /** undefined: the library's default; null: not known. */
    let method: string | null | undefined = verbMethod;
    if (
      (module === "needle" || module === "superagent") &&
      (name === "call" || (module === "needle" && name === "request"))
    ) {
      // `needle(method, url, …)`, `superagent(method, url)`, `superagent(url)` (GET)
      const a0 = arg(0);
      const a1 = arg(1);
      if (a0 === null) return;
      const m0 = tokens[a0]!;
      const literalNotMethod =
        (m0.type === "string" || m0.type === "template") &&
        res.endOf(a0) === a0 + 1 &&
        methodAt({ at: a0, end: a0 + 1 }) === null;
      // `superagent(url)`, `superagent(url, callback)`: a GET of the first argument
      if (
        module === "superagent" &&
        (a1 === null || isFunctionArgument(a1) || (literalNotMethod && arg(2) === null))
      ) {
        urlAt = a0;
        method = "GET";
      } else {
        urlAt = a1;
        method = methodAt({ at: a0, end: res.endOf(a0) });
      }
    } else if (module === "needle" || module === "superagent" || module === "lib") {
      urlAt = arg(0);
      if (method === undefined) method = null;
    } else if (name === "call" || name === "request") {
      const a0 = arg(0);
      if (literal(a0)) {
        configAt = a0;
        fromConfig = true;
      } else {
        urlAt = a0;
        configAt = arg(1);
      }
    } else {
      urlAt = arg(0);
      // axios: `post(url, data, config)`; got and ky: `post(url, options)`
      configAt = module === "axios" && /^(post|put|patch)$/.test(name) ? arg(2) : arg(1);
    }
    const unknown = (expression: string): void =>
      pushClient(unknownRead(expression), t, method ? { method } : {});
    if (configAt !== null) {
      if (literal(configAt)) {
        const lit = literalKeys(configAt);
        if (!lit || lit.spread) return unknown("<options>");
        for (const key of ADDRESS_OPTIONS[module] ?? [])
          if (!(fromConfig && key === "url") && lit.keys.has(key)) return unknown(`options.${key}`);
        const m = lit.keys.get("method");
        if (method === undefined && m) method = methodAt(m);
        if (fromConfig) {
          const u = lit.keys.get("url");
          if (!u) return unknown("options.url");
          urlAt = u.at;
        }
      } else {
        // a config passed as a name: it may set the base or the URL of an instance with a base
        if (instance?.base !== undefined || instance?.unknownBase)
          return unknown(
            tokens[configAt]!.type === "ident" ? tokens[configAt]!.value : "<options>",
          );
        if (method === undefined) method = null;
      }
    }
    if (method === undefined)
      method = instance && instance.method !== undefined ? instance.method : "GET";
    if (urlAt === null) return;
    const r = readArg(urlAt, true);
    if (!r) return;
    if (r.value === null) return unknown(r.expression ?? "<expression>");
    const base = instance?.base;
    /** The address the library makes of the input `v`, or null when it is not known. */
    const join = (v: string): string | null => {
      // the defaults are changed in the file: only an absolute input is known
      if (instance?.unknownBase) return ABSOLUTE.test(v) && !v.includes(REF_OPEN) ? v : null;
      if (base === undefined) return v;
      if (v.includes(REF_OPEN) || v.startsWith("${…}")) return null;
      if (module === "axios") {
        // axios' buildFullPath and combineURLs
        if (/^([a-z][a-z\d+\-.]*:)?\/\//i.test(v)) return v;
        // axios ignores the base for an absolute input (isAbsoluteURL). A computed part may make
        // one unless the text before it already rules that out: `/${p}` may be `//elsewhere`,
        // `${p}` and `api${p}` may be `https://elsewhere` (#196).
        const head = v.includes("${…}") ? v.slice(0, v.indexOf("${…}")) : null;
        if (head !== null && /^(?:[a-z][a-z\d+\-.]*(?::\/?)?)?$|^\/$/i.test(head)) return null;
        return v ? `${base.replace(/\/?\/$/, "")}/${v.replace(/^\/+/, "")}` : base;
      }
      // got and ky (1.x) prepend the prefix to a relative input and refuse a leading slash; what
      // they do with an absolute input differs between versions
      if (v.startsWith("/") || /^[a-z][\d+\-.a-z]*:/i.test(v)) return null;
      return `${base.endsWith("/") ? base : `${base}/`}${v}`;
    };
    let unread = !!r.partial;
    for (const [i, v] of [r.value, ...(r.more ?? [])].entries()) {
      const value = join(v);
      if (value === null || !ADDRESS_START.test(value)) {
        unread = true;
        continue;
      }
      pushClient(
        {
          value,
          evidence: i === 0 && value === v ? r.evidence : resolvedEvidence(value),
        },
        t,
        method ? { method } : {},
      );
    }
    if (unread) unknown(r.partial ? (read(urlAt)?.expression ?? "<expression>") : "<expression>");
  };
  const clientRequest = (t: Token, open: number, c: ClientHit): void => {
    const { module, verb: name } = c;
    if (c.unread) {
      pushClient(
        unknownRead(c.unread),
        t,
        HTTP_VERBS.has(name) && name !== "request" ? { method: name.toUpperCase() } : {},
      );
      return;
    }
    if (isLibrary(module)) {
      libraryRequest(t, open, module, name, c.instance);
      return;
    }
    const at = open + 1;
    const method = name === "request" ? verb(open) : { method: name.toUpperCase() };
    if (is(tokens[at], "punct", "{")) {
      pushClient(optionsAddress(at, module), t, method);
      return;
    }
    let r = readArg(at, true);
    if (!r) return;
    if (
      r.value !== null &&
      ADDRESS_START.test(r.value) &&
      (module === "http" || module === "https")
    ) {
      const merged = overridden(at, r);
      if (merged) r = { ...merged, ...(r.partial ? { partial: true as const } : {}) };
    }
    if (r.value !== null && ADDRESS_START.test(r.value)) {
      pushClient(r, t, method);
      // a call site that could not be read keeps the unread row too, so nothing unread is hidden
      if (r.partial)
        pushClient(
          { value: null, evidence: "unknown", expression: read(at)?.expression ?? "<expression>" },
          t,
          method,
        );
      return;
    }
    // not shaped like an address (`${…}/x`, an error text a wrapper passes): not read
    pushClient(
      {
        value: null,
        evidence: "unknown",
        expression: r.value === null ? (r.expression ?? "<expression>") : "<expression>",
      },
      t,
      method,
    );
  };

  // `fetch(new Request(url, init))`, and `fetch(r)` with `const r = new Request(…)` declared
  // before the call and never written again: the request's URL and method. `Request` must be the
  // global one (no binding of the name in the file is visible at the call).
  let requestQuestions = 0;
  const mentionsRequest = source.includes("Request");
  /**
   * The file gives `Request` a value of its own somewhere: an import (`import Request from …`,
   * `import { Request }`, `import { Foo as Request }`, which the scope tables do not hold), an
   * assignment of the global (`globalThis.Request = …`, also `window.` and `self.`, or a bare
   * `Request = …`). Then no `new Request` is read in the file.
   */
  let requestReplaced: boolean | null = null;
  const replacesRequest = (): boolean => {
    if (requestReplaced !== null) return requestReplaced;
    requestReplaced = false;
    for (const p of positionsOf("Request")) {
      const before = tokens[p - 1];
      const after = tokens[p + 1];
      const written =
        after?.type === "punct" && (WRITE_OPERATORS.has(after.value) || after.value === "++");
      // a declaration of the name is a binding the scope tables see (`boundAround`)
      if (written && !is(before, "punct", ".") && !declaresAt(p)) requestReplaced = true;
      else if (
        written &&
        is(before, "punct", ".") &&
        is(tokens[p - 2], "ident") &&
        GLOBALS.has(tokens[p - 2]!.value)
      )
        requestReplaced = true;
      else if (!is(before, "punct", ".")) {
        // inside an import clause: back over names, commas, braces, `as` and `*` to `import`
        for (let m = p - 1, guard = 0; m >= 0 && guard < 200; m--, guard++) {
          const x = tokens[m]!;
          if (x.type === "ident" && x.value === "import") {
            requestReplaced = true;
            break;
          }
          if (x.type === "ident" || x.type === "string") continue;
          if (x.type === "punct" && /^(,|\{|\}|\*)$/.test(x.value)) continue;
          break;
        }
      }
      if (requestReplaced) break;
    }
    return requestReplaced;
  };
  const globalRequest = (j: number): boolean =>
    !replacesRequest() && (wrapperResolver ??= makeResolver()).boundAround(j, "Request") === null;
  /** `new Request(` whose `(` is at `open - 0`, written as the whole expression at `at`. */
  const newRequest = (at: number): number | null => {
    if (
      !is(tokens[at], "ident", "new") ||
      !is(tokens[at + 1], "ident", "Request") ||
      !is(tokens[at + 2], "punct", "(")
    )
      return null;
    const res = (wrapperResolver ??= makeResolver());
    const close = res.closeOf(at + 2);
    return close !== -1 && res.endOf(at) === close + 1 && globalRequest(at + 1) ? at + 2 : null;
  };
  /** The `(` of the `new Request(` the fetch argument at `at` is, or null. */
  const requestAt = (at: number): number | null => {
    if (!mentionsRequest) return null;
    const direct = newRequest(at);
    if (direct !== null) return direct;
    const name = tokens[at];
    if (name?.type !== "ident" || OPERATOR_WORDS.has(name.value)) return null;
    const res = (wrapperResolver ??= makeResolver());
    if (res.endOf(at) !== at + 1 || requestQuestions++ >= 64) return null;
    const b = res.boundAround(at, name.value);
    if (b?.kind !== "local" || !b.site) return null;
    const { name: decl, word } = b.site;
    if (
      word !== decl - 1 ||
      decl >= at ||
      !/^(const|let|var)$/.test(tokens[word]?.value ?? "") ||
      !is(tokens[decl + 1], "punct", "=")
    )
      return null;
    const open = newRequest(decl + 2);
    return open !== null && !writtenAgain(name.value, decl) ? open : null;
  };
  /** The method of `fetch(request, init)`: init's own, else the one the request was made with. */
  const requestMethod = (fetchOpen: number, requestOpen: number): { method?: string } => {
    const res = (wrapperResolver ??= makeResolver());
    const init = res.argumentAt(fetchOpen, 1);
    if (init !== null && !is(tokens[init], "punct", ")")) {
      // an init that is not read may set the method
      if (!is(tokens[init], "punct", "{") || res.endOf(init) !== res.closeOf(init) + 1) return {};
      const lit = literalKeys(init);
      if (!lit || lit.spread) return {};
      const m = lit.keys.get("method");
      if (m) {
        const own = methodAt(m);
        return own ? { method: own } : {};
      }
    }
    return verb(requestOpen);
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

    if (clients.size || functions.size) {
      // `(0, X.get)(…)`: how esbuild calls a named import
      const open = called
        ? k + 1
        : member &&
            is(tokens[k + 1], "punct", ")") &&
            is(tokens[k + 2], "punct", "(") &&
            is(tokens[k - 3], "punct", ",") &&
            is(tokens[k - 4], "number", "0") &&
            is(tokens[k - 5], "punct", "(")
          ? k + 2
          : -1;
      const c = open !== -1 && !(called && definesMethod(open)) ? clientAt(k) : null;
      if (c) {
        clientRequest(t, open, c);
        continue;
      }
    }

    if (t.value === "fetch" && called) {
      // `x.fetch(` is some object's own method unless x is the global object.
      if (member && !(is(tokens[k - 2], "ident") && GLOBALS.has(tokens[k - 2]!.value))) continue;
      // `function fetch(` and `async fetch(` declare a function; they do not call one.
      if (is(prev, "ident", "function") || is(prev, "ident", "async") || is(prev, "punct", "*"))
        continue;
      // `{ fetch(key) { … } }` defines a method of that name: a parameter list followed by a body.
      if (definesMethod(k + 1)) continue;
      const q = requestAt(k + 2);
      const r = q ? readArg(q + 1, true) : readArg(k + 2, true);
      if (r) push(out.endpoints, "fetch", r, t, q ? requestMethod(k + 1, q) : verb(k + 1));
    } else if (called && !member && aliases.get(k) === "fetch") {
      // Another name for fetch (`const request = fetch`): a request, but known by inference.
      const q = requestAt(k + 2);
      const r = q ? readArg(q + 1, true) : readArg(k + 2, true);
      if (r && q)
        push(
          out.endpoints,
          "fetch",
          { ...r, evidence: r.evidence === "literal" ? "inferred" : r.evidence },
          t,
          requestMethod(k + 1, q),
        );
      else if (r)
        push(
          out.endpoints,
          "fetch",
          { ...r, evidence: r.evidence === "literal" ? "inferred" : r.evidence },
          t,
          verb(k + 1),
        );
    } else if (HTTP_VERBS.has(t.value) && member && called) {
      const owner = tokens[k - 2];
      // A client by its name only. Where a parameter or a local of that name is meant
      // (`function login(axios, body)`), the URL is read at the call only: a value bound from
      // call sites would be taken for a request of whatever object the callers pass.
      // A declaration, pattern or `for … of` of the name (`const { https } = o`), and a member
      // of another object (`this.https`), are other objects: then only the shape counts.
      const named =
        is(owner, "ident") &&
        (HTTP_CLIENTS.has(owner!.value) || legacyClients.has(owner!.value)) &&
        !is(tokens[k - 3], "punct", ".");
      let client = named;
      let local = false;
      if (named && clientChecks++ < MAX_CLIENT_CALLS) {
        const bound = (wrapperResolver ??= makeResolver()).boundAround(k - 2, owner!.value);
        // A parameter of the name: where the file binds that name to the module, the parameter
        // is another object (`function f(https, a = https.get(…))`); where it does not, a
        // parameter named like a client is taken as one (`login(axios, body)`), read at the call.
        if (bound?.kind === "param") {
          if (legacyClients.has(owner!.value)) client = false;
          else local = true;
        }
        // no binding visible, and the file assigns the global of that name: which object the
        // call is on is not known, so the call is an unknown row
        // a local the scope tables do not hold (a later declarator of a list): another object
        else if (bound === null && localAt(k - 2)) client = false;
        else if (bound === null && globalWritten(owner!.value)) {
          pushClient(
            unknownRead("<expression>"),
            t,
            t.value === "request" ? verb(k + 1) : { method: t.value.toUpperCase() },
          );
          continue;
        }
        // a local of the name is another object, unless it is bound to a module itself
        // (`const https = n(5)` in a webpack module, `const https = require("https")`)
        else if (bound?.kind === "local") {
          const kind = bound.site ? moduleKind(bound.site, k - 2) : null;
          // a webpack module this file does not show: the client's own name still counts
          // (0.9.2's rule); under another name the object is not known, and the call is an
          // unknown row
          if (kind === "unknown" && !HTTP_CLIENTS.has(owner!.value)) {
            pushClient(
              { value: null, evidence: "unknown", expression: "<expression>" },
              t,
              t.value === "request" ? verb(k + 1) : { method: t.value.toUpperCase() },
            );
            continue;
          }
          // A local bound to another module is that module, not an object of unknown shape;
          // under a client's own name (`const axios = require("./http")`, a wrapper module) the
          // name rule of 0.9.2 still holds.
          const own = HTTP_CLIENTS.has(owner!.value);
          if (kind === "other" && !own) continue;
          client = kind === "client" || (own && (kind === "unknown" || kind === "other"));
        }
        // A declaration that an assignment writes to may hold something else at the call:
        // which object is called is not known, so the call is an unknown row, not the address.
        if (client && reassignedAt(k - 2, owner!.value)) {
          pushClient(
            { value: null, evidence: "unknown", expression: "<expression>" },
            t,
            t.value === "request" ? verb(k + 1) : { method: t.value.toUpperCase() },
          );
          continue;
        }
      } else if (named) {
        out.clientsSkipped = true;
        // past the cap: a name with a declaration written again is not read by name
        if (reassignedClients.has(owner!.value)) {
          pushClient(
            unknownRead("<expression>"),
            t,
            t.value === "request" ? verb(k + 1) : { method: t.value.toUpperCase() },
          );
          continue;
        }
      }
      // `net.request({ url: "https://…", method: "POST" })`: the address is an option.
      const url = is(tokens[k + 2], "punct", "{") ? option(k + 1, "url") : null;
      if (url !== null) {
        if (ABSOLUTE.test(url))
          push(out.endpoints, "http-client", { value: url, evidence: "inferred" }, t, verb(k + 1));
        continue;
      }
      const r = local ? read(k + 2) : readArg(k + 2, true);
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
      if (reassignedClients.has("axios") && reassignedAt(k, "axios")) {
        pushClient(unknownRead("<expression>"), t, {});
        continue;
      }
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
