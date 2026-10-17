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
  /** More HTTP client calls than MAX_CLIENT_CALLS were checked; the rest gave no rows. */
  clientsSkipped?: true;
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
type ClientModule = "http" | "https" | "electron" | "net" | "lib";
const clientModule = (spec: Token | undefined): ClientModule | null => {
  if (spec?.type !== "string") return null;
  if (spec.value === "electron") return "electron";
  const m = /^(?:node:)?(https?|axios|got|ky|superagent|needle)$/.exec(spec.value);
  return !m ? null : m[1] === "http" || m[1] === "https" ? m[1] : "lib";
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
  const clients = new Map<string, Array<{ module: ClientModule; at: number }>>();
  /** Every name bound to a client module, as 0.9.2 read it: its rule applies where no binding is proven. */
  const legacyClients = new Set<string>();
  /** Declarations of client names that an assignment writes to: no client where they are meant. */
  const reassignedClients = new Map<string, number[]>();
  const functions = new Map<string, Array<{ module: ClientModule; verb: string; at: number }>>();
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
        // `X = require(…)`, `X = f(require(…))`
        if (is(tokens[k - 1], "punct", "=") && is(tokens[k - 2], "ident"))
          bind(tokens[k - 2]!.value, module, k - 2);
        else if (
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
    if (declared.size)
      for (let k = 1; k + 1 < tokens.length; k++) {
        const t = tokens[k]!;
        if (t.type !== "ident" || !declared.has(t.value) || is(tokens[k - 1], "punct", "."))
          continue;
        const after = tokens[k + 1]!;
        const before = tokens[k - 1]!;
        if (
          !(
            (after.type === "punct" &&
              (/^([-+*/%&|^]|\*\*|<<|>>>?|&&|\|\||\?\?)?=$/.test(after.value) ||
                after.value === "++" ||
                after.value === "--")) ||
            (before.type === "punct" && (before.value === "++" || before.value === "--"))
          )
        )
          continue;
        const binder = (wrapperResolver ??= makeResolver());
        // more writes than are checked: the names are no proven clients (0.9.2's rule applies)
        if (writes++ >= MAX_CLIENT_CALLS) {
          clients.clear();
          functions.clear();
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
        const keep = <T extends { at: number; module?: ClientModule }>(
          list: T[] | undefined,
        ): T[] =>
          (list ?? []).filter((c) => {
            if (!binder.writesTo(k, t.value, c.at)) return true;
            if (another && another !== "electron" && c.module && c.module !== "electron") {
              if (c.module !== another) c.module = "lib";
              return true;
            }
            const gone = reassignedClients.get(t.value) ?? [];
            gone.push(c.at);
            reassignedClients.set(t.value, gone);
            return false;
          });
        const c = keep(clients.get(t.value));
        const f = keep(functions.get(t.value));
        if (c.length) clients.set(t.value, c);
        else clients.delete(t.value);
        if (f.length) functions.set(t.value, f);
        else functions.delete(t.value);
      }
  }
  // Calls checked against the bindings per file; above the cap, client calls are not read
  // (limitation `client_calls_skipped`), so no input makes the check slow.
  let clientChecks = 0;
  const refers = (j: number, at: number): boolean => {
    if (clientChecks++ >= MAX_CLIENT_CALLS) {
      // above the cap, calls are read by 0.9.2's name rule (see the verb branch below)
      out.clientsSkipped = true;
      return false;
    }
    return (wrapperResolver ??= makeResolver()).refersTo(j, tokens[j]!.value, at);
  };
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
  /** The client module the verb at k is called on, when it is one of the bindings above. */
  const clientAt = (k: number): { module: ClientModule; verb: string } | null => {
    const t = tokens[k]!;
    if (!is(tokens[k - 1], "punct", ".") && !is(tokens[k - 1], "punct", "?.")) {
      const list = functions.get(t.value);
      if (!list || is(tokens[k - 1], "ident", "function")) return null;
      const hit = list.find((c) => refers(k, c.at));
      return hit ? { module: hit.module, verb: hit.verb } : null;
    }
    if (!HTTP_VERBS.has(t.value)) return null;
    const owner = tokens[k - 2];
    if (owner?.type !== "ident") return null;
    if (!is(tokens[k - 3], "punct", ".")) {
      const list = clients.get(owner.value)?.filter((c) => c.module !== "electron");
      if (list?.length && means(k - 2, list)) {
        const module = list[0]!.module;
        return module === "net" && t.value !== "request" ? null : { module, verb: t.value };
      }
      return null;
    }
    // `X.default.get(…)` (a bundler's interop object), `X.net.request(…)` (Electron)
    const root = tokens[k - 4];
    if (root?.type !== "ident" || is(tokens[k - 5], "punct", ".")) return null;
    const list = clients.get(root.value);
    if (owner.value === "net" && t.value === "request") {
      const electron = list?.filter((c) => c.module === "electron");
      return electron?.length && means(k - 4, electron) ? { module: "net", verb: "request" } : null;
    }
    if (owner.value !== "default") return null;
    const modules = list?.filter((c) => c.module !== "electron" && c.module !== "net");
    return modules?.length && means(k - 4, modules)
      ? { module: modules[0]!.module, verb: t.value }
      : null;
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
      const url = module === "net" || module === "lib" ? part("url") : null;
      return url && ABSOLUTE.test(url)
        ? { value: url, evidence: "inferred" }
        : unknownRead("options.url");
    }
    if (module === "lib") return unknownRead("<options>");
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
  const clientRequest = (t: Token, open: number, module: ClientModule, name: string): void => {
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
        clientRequest(t, open, c.module, c.verb);
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
        if (
          client &&
          reassignedClients
            .get(owner!.value)
            ?.some((at) => (wrapperResolver ??= makeResolver()).refersTo(k - 2, owner!.value, at))
        ) {
          pushClient(
            { value: null, evidence: "unknown", expression: "<expression>" },
            t,
            t.value === "request" ? verb(k + 1) : { method: t.value.toUpperCase() },
          );
          continue;
        }
      } else if (named) out.clientsSkipped = true;
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
