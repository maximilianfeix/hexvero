import type { Limitation } from "../model.js";
import { findCandidates, resolvePending, type Candidate } from "./candidates.js";
import { tokenize, type Token } from "./scan.js";

/**
 * Bundle dissection without an engine: finds the module map that webpack,
 * Rspack, browserify and esbuild emit, delimits every module by matching
 * brackets at the token level, and records the intra-bundle require graph,
 * export names, vendor fingerprints and URL/route/storage candidates.
 * Nothing is evaluated; every result points at byte offsets in the file.
 */

export type Bundler =
  | "webpack"
  | "rspack"
  | "browserify"
  | "esbuild"
  | "rollup"
  | "vite"
  | "parcel";

export interface BundleModule {
  id: string;
  /** Source path when the bundle kept it (development builds, esbuild, browserify deps). */
  name: string | null;
  start: number;
  end: number;
  size: number;
  line: number;
  requires: string[];
  exports: string[];
  /**
   * Method shorthand (esbuild) needs `function` prepended to become a valid expression.
   * `hoisted`: a section of a scope-hoisted bundle, bounded by the path comment the bundler wrote
   * before it; its names are shared with the other sections, so it is no function at all.
   */
  factory: "function" | "method" | "hoisted";
}

/** An endpoint, route, storage access or URL literal, with the bundle module it sits in. */
export interface BundleCandidate extends Candidate {
  moduleId: string | null;
}

export interface JsBundleInfo {
  bundler: Bundler | null;
  hasRuntime: boolean;
  chunkIds: string[];
  entryIds: string[];
  modules: BundleModule[];
  vendors: string[];
  endpoints: BundleCandidate[];
  routes: BundleCandidate[];
  storage: BundleCandidate[];
  /** URLs that occur as plain strings. Not endpoints: nothing shows they are requested. */
  urls: BundleCandidate[];
  /** Other chunk files this one imports (`./chunk-x.js`), when no module boundaries were found. */
  chunks?: string[];
  limitations: Limitation[];
}

/** `// src/renderer/app.ts` at the start of a line: the path comment esbuild writes before each module. */
const PATH_BANNER = /^\/\/ ((?:[\w@.+-]+\/)*[\w@.+-]+\.(?:[cm]?[jt]sx?|vue|svelte|json))[ \t]*$/gm;

/**
 * Sections of a scope-hoisted bundle, split at the path comments its bundler wrote (esbuild with
 * `format: "esm"` or `"iife"`, which hoists modules instead of wrapping them). Comments inside a
 * string or template do not count. At least two are needed; one says nothing about boundaries.
 */
function hoistedSections(source: string, tokens: Token[]): BundleModule[] {
  const inside = (offset: number): boolean => {
    let lo = 0;
    let hi = tokens.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const t = tokens[mid]!;
      if (t.end <= offset) lo = mid + 1;
      else if (t.start > offset) hi = mid - 1;
      else return true;
    }
    return false;
  };
  const marks: Array<{ path: string; at: number }> = [];
  for (const m of source.matchAll(PATH_BANNER))
    if (!inside(m.index)) marks.push({ path: m[1]!, at: m.index });
  if (marks.length < 2) return [];
  return marks.map((mark, i) => {
    const end = marks[i + 1]?.at ?? source.length;
    const body = source.slice(mark.at, end);
    const requires = new Set<string>();
    for (const r of body.matchAll(
      /\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    ))
      requires.add((r[1] ?? r[2])!);
    return {
      id: mark.path,
      name: mark.path,
      start: mark.at,
      end,
      size: end - mark.at,
      line: source.slice(0, mark.at).split("\n").length,
      requires: [...requires],
      exports: [],
      factory: "hoisted" as const,
    };
  });
}

/** Relative files a chunk imports statically or with `import()`: the other chunks of its build. */
function chunkImports(tokens: Token[]): string[] {
  const out = new Set<string>();
  for (let k = 0; k + 1 < tokens.length; k++) {
    const t = tokens[k]!;
    if (t.type !== "ident" || (t.value !== "from" && t.value !== "import")) continue;
    const spec = is(tokens[k + 1], "punct", "(") ? tokens[k + 2] : tokens[k + 1];
    if (spec?.type === "string" && /^\.\.?\//.test(spec.value) && /\.[cm]?js$/.test(spec.value))
      out.add(spec.value);
  }
  return [...out].toSorted();
}

const VENDORS: Array<[string, RegExp]> = [
  ["webpack", /__webpack_require__|webpackChunk|webpackJsonp/],
  ["Rspack", /rspackChunk|__rspack_require__/],
  ["Vite", /__vite__|import\.meta\.hot|__VITE_PRELOAD__/],
  ["Rollup", /ROLLUP_FILE_URL|import\.meta\.ROLLUP/],
  ["esbuild", /__commonJS\(|__esm\(|__toESM\(/],
  ["Parcel", /parcelRequire/],
  ["browserify", /typeof require=="function"&&require;|function\(e,n,t\)\{function o\(i,f\)/],
  [
    "React",
    /React\.createElement|react\/jsx-runtime|__REACT_DEVTOOLS_GLOBAL_HOOK__|\.createRoot\(/,
  ],
  ["Preact", /preact\/hooks|__PREACT_DEVTOOLS__/],
  ["Vue", /__VUE__|__VUE_PROD_DEVTOOLS__|createApp\(/],
  ["Svelte", /svelte\/internal|SvelteComponent/],
  ["Solid", /solid-js\/web|_\$insert\(/],
  ["Angular", /ɵɵdefineComponent|ngDevMode/],
  ["Next.js", /__NEXT_DATA__|\/_next\/static/],
  ["Nuxt", /__NUXT__|nuxt\/dist/],
  ["Remix", /__remixContext|@remix-run/],
  ["Electron", /require\("electron"\)|from"electron"|ipcRenderer\./],
  ["jQuery", /jQuery\.fn|\$\.ajax\(/],
  ["Lodash", /lodash\.js|lodash\/lodash|__lodash_hash_undefined__/],
  ["Sentry", /@sentry\/|Sentry\.init\(/],
  ["Segment", /analytics\.track\(|segment\.com/],
  ["Google Analytics", /gtag\(|google-analytics\.com/],
  ["Stripe", /js\.stripe\.com|Stripe\(/],
  ["Firebase", /firebaseapp\.com|firebase\/app/],
  ["Socket.IO", /socket\.io-client|engine\.io/],
  ["gRPC-web", /grpc-web/],
  ["WebAssembly", /WebAssembly\.(instantiate|compile)/],
];

const is = (t: Token | undefined, type: Token["type"], value?: string): boolean =>
  !!t && t.type === type && (value === undefined || t.value === value);
const OPEN: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
const CLOSE = new Set([")", "]", "}"]);

/** Index of the token that closes the bracket opened at `open`, or -1. */
function matchBracket(tokens: Token[], open: number): number {
  const stack: string[] = [];
  for (let i = open; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.type !== "punct") continue;
    if (OPEN[t.value]) stack.push(OPEN[t.value]!);
    else if (CLOSE.has(t.value)) {
      if (stack.pop() !== t.value) return -1;
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

interface FunctionSpan {
  /** Index of the token after the parameter list's closing parenthesis (the body `{`). */
  bodyOpen: number;
  bodyClose: number;
  /** Last token of the whole value: the body `}` or the `)` of a parenthesized wrapper. */
  end: number;
  params: string[];
}

/** Reads a function/arrow/method value starting at `i`; returns null when it is not a function. */
function readFunction(tokens: Token[], i: number): FunctionSpan | null {
  let k = i;
  // webpack 5 wraps every module value: `((module, exports, require) => { ... })`
  if (
    is(tokens[k], "punct", "(") &&
    (is(tokens[k + 1], "punct", "(") ||
      is(tokens[k + 1], "ident", "function") ||
      is(tokens[k + 1], "ident", "async") ||
      (is(tokens[k + 1], "ident") && is(tokens[k + 2], "punct", "=>")))
  ) {
    const inner = readFunction(tokens, k + 1);
    if (inner && is(tokens[inner.end + 1], "punct", ")")) {
      // `((…) => {})()` or `(…).bind(…)` is a call, not a module value
      const next = tokens[inner.end + 2];
      if (next && next.type === "punct" && (next.value === "(" || next.value === ".")) return null;
      return { ...inner, end: inner.end + 1 };
    }
    if (inner) return null;
  }
  if (is(tokens[k], "ident", "async")) k++;
  if (is(tokens[k], "ident", "function")) {
    k++;
    if (is(tokens[k], "punct", "*")) k++;
    if (is(tokens[k], "ident")) k++;
  }
  if (!is(tokens[k], "punct", "(")) {
    // single-param arrow: a => {...}
    if (
      is(tokens[k], "ident") &&
      is(tokens[k + 1], "punct", "=>") &&
      is(tokens[k + 2], "punct", "{")
    ) {
      const close = matchBracket(tokens, k + 2);
      return close === -1
        ? null
        : { bodyOpen: k + 2, bodyClose: close, end: close, params: [tokens[k]!.value] };
    }
    return null;
  }
  const paramsClose = matchBracket(tokens, k);
  if (paramsClose === -1) return null;
  const params = tokens
    .slice(k + 1, paramsClose)
    .filter((t) => t.type === "ident")
    .map((t) => t.value);
  let bodyOpen = paramsClose + 1;
  if (is(tokens[bodyOpen], "punct", "=>")) bodyOpen++;
  if (!is(tokens[bodyOpen], "punct", "{")) return null;
  const bodyClose = matchBracket(tokens, bodyOpen);
  return bodyClose === -1 ? null : { bodyOpen, bodyClose, end: bodyClose, params };
}

interface RawModule {
  id: string;
  name: string | null;
  fn: FunctionSpan;
  /** Token range of the whole value (function or browserify [fn, deps] pair). */
  valueStart: number;
  valueEnd: number;
  depsMap: Record<string, string> | null;
  requireParam: string | null;
  esbuild: boolean;
}

const keyOf = (t: Token | undefined): string | null =>
  !t ? null : t.type === "string" || t.type === "number" || t.type === "ident" ? t.value : null;

/** Parses `{ key: fn, "path": fn, key(exports, module) {} }` or `[fn, fn]` module maps; null if it is not one. */
function readModuleMap(
  tokens: Token[],
  open: number,
  kind: "object" | "array",
): RawModule[] | null {
  const close = matchBracket(tokens, open);
  if (close === -1) return null;
  const modules: RawModule[] = [];
  let i = open + 1;
  let index = 0;
  let nonModules = 0;
  while (i < close) {
    if (is(tokens[i], "punct", ",")) {
      i++;
      index++;
      continue;
    }
    let id: string;
    let name: string | null = null;
    let valueStart: number;
    if (kind === "object") {
      const key = keyOf(tokens[i]);
      if (key === null) return null;
      id = key;
      if (tokens[i]!.type === "string") name = key;
      if (is(tokens[i + 1], "punct", ":")) valueStart = i + 2;
      else if (is(tokens[i + 1], "punct", "(")) valueStart = i + 1; // method shorthand (esbuild)
      else return null;
    } else {
      id = String(index);
      valueStart = i;
    }
    let fn: FunctionSpan | null = null;
    let valueEnd = -1;
    let depsMap: Record<string, string> | null = null;
    if (kind === "object" && valueStart === i + 1) {
      // method shorthand: key(params) { body }
      const paramsClose = matchBracket(tokens, valueStart);
      const bodyOpen = paramsClose + 1;
      const bodyClose =
        paramsClose === -1 || !is(tokens[bodyOpen], "punct", "{")
          ? -1
          : matchBracket(tokens, bodyOpen);
      if (bodyClose !== -1) {
        fn = {
          bodyOpen,
          bodyClose,
          end: bodyClose,
          params: tokens
            .slice(valueStart + 1, paramsClose)
            .filter((t) => t.type === "ident")
            .map((t) => t.value),
        };
        valueEnd = bodyClose;
      }
    } else if (is(tokens[valueStart], "punct", "[")) {
      // browserify: [function(require, module, exports) {...}, {"./dep": 2}]
      const arrClose = matchBracket(tokens, valueStart);
      const inner = readFunction(tokens, valueStart + 1);
      if (arrClose !== -1 && inner) {
        fn = inner;
        valueEnd = arrClose;
        const mapOpen = inner.end + 2;
        if (is(tokens[mapOpen - 1], "punct", ",") && is(tokens[mapOpen], "punct", "{")) {
          const mapClose = matchBracket(tokens, mapOpen);
          depsMap = {};
          for (let k = mapOpen + 1; k < mapClose; k++) {
            const t = tokens[k]!;
            if ((t.type === "string" || t.type === "ident") && is(tokens[k + 1], "punct", ":")) {
              const v = keyOf(tokens[k + 2]);
              if (v !== null) depsMap[t.value] = v;
              k += 2;
            }
          }
        }
      }
    } else {
      fn = readFunction(tokens, valueStart);
      if (fn) valueEnd = fn.end;
    }
    if (!fn) {
      nonModules++;
      // skip this entry up to the next top-level comma
      let depth = 0;
      let k = valueStart;
      for (; k < close; k++) {
        const t = tokens[k]!;
        if (t.type !== "punct") continue;
        if (OPEN[t.value]) depth++;
        else if (CLOSE.has(t.value)) depth--;
        else if (t.value === "," && depth === 0) break;
      }
      i = k;
      continue;
    }
    modules.push({
      id,
      name,
      fn,
      valueStart,
      valueEnd,
      depsMap,
      requireParam: null,
      esbuild: kind === "object" && valueStart === i + 1,
    });
    i = valueEnd + 1;
  }
  if (modules.length < 1 || nonModules > modules.length) return null;
  return modules;
}

function collectBody(tokens: Token[], m: RawModule): BundleModule {
  const requires = new Set<string>();
  const exportsSet = new Set<string>();
  const requireNames = new Set<string>(["__webpack_require__", "__nested_webpack_require__"]);
  if (m.requireParam) requireNames.add(m.requireParam);
  if (m.depsMap) requireNames.add("require");
  // webpack: (module, exports, require) · browserify: (require, module, exports) · esbuild: (exports, module)
  const exportObject = m.depsMap
    ? (m.fn.params[2] ?? "exports")
    : m.esbuild
      ? (m.fn.params[0] ?? "exports")
      : (m.fn.params[1] ?? "exports");
  const moduleObject = m.depsMap
    ? (m.fn.params[1] ?? "module")
    : m.esbuild
      ? (m.fn.params[1] ?? "module")
      : (m.fn.params[0] ?? "module");

  /** Skips a nested function whose parameters shadow a require/exports binding. */
  const skipShadowing = (k: number): number => {
    const fn = readFunction(tokens, k);
    if (!fn) return k;
    const shadows = fn.params.some(
      (p) => requireNames.has(p) || p === exportObject || p === moduleObject,
    );
    return shadows ? fn.bodyClose : k;
  };

  for (let k = m.fn.bodyOpen + 1; k < m.fn.bodyClose; k++) {
    const t = tokens[k]!;
    if (t.type === "punct" && t.value === "(" && is(tokens[k - 1], "punct", "=>")) continue;
    if (t.type === "ident" && (t.value === "function" || t.value === "async")) {
      const skipped = skipShadowing(k);
      if (skipped !== k) {
        k = skipped;
        continue;
      }
    }
    if (t.type !== "ident" || is(tokens[k - 1], "punct", ".")) continue;
    if (requireNames.has(t.value) && is(tokens[k + 1], "punct", "(")) {
      const arg = tokens[k + 2];
      if (
        arg &&
        (arg.type === "number" || arg.type === "string") &&
        is(tokens[k + 3], "punct", ")")
      ) {
        requires.add(m.depsMap?.[arg.value] ?? arg.value);
      }
      k += 1;
      continue;
    }
    // __webpack_require__.d(exports, { name: () => value }) (webpack 5) or .d(exports, "name", getter) (webpack 4)
    if (
      requireNames.has(t.value) &&
      is(tokens[k + 1], "punct", ".") &&
      is(tokens[k + 2], "ident", "d") &&
      is(tokens[k + 3], "punct", "(")
    ) {
      const callClose = matchBracket(tokens, k + 3);
      if (callClose === -1) continue;
      // second argument starts after the first top-level comma
      let depth = 0;
      let second = -1;
      for (let j = k + 4; j < callClose; j++) {
        const x = tokens[j]!;
        if (x.type !== "punct") continue;
        if (OPEN[x.value]) depth++;
        else if (CLOSE.has(x.value)) depth--;
        else if (x.value === "," && depth === 0) {
          second = j + 1;
          break;
        }
      }
      if (second !== -1) {
        const arg = tokens[second]!;
        if (arg.type === "string") exportsSet.add(arg.value);
        else if (is(arg, "punct", "{")) {
          const objClose = matchBracket(tokens, second);
          let d = 0;
          for (let j = second + 1; j < objClose; j++) {
            const x = tokens[j]!;
            if (x.type === "punct") {
              if (OPEN[x.value]) d++;
              else if (CLOSE.has(x.value)) d--;
              continue;
            }
            if (
              d === 0 &&
              (x.type === "ident" || x.type === "string") &&
              is(tokens[j + 1], "punct", ":")
            )
              exportsSet.add(x.value);
          }
        }
      }
      k = callClose;
      continue;
    }
    if (
      (t.value === exportObject || t.value === "exports") &&
      is(tokens[k + 1], "punct", ".") &&
      is(tokens[k + 2], "ident") &&
      is(tokens[k + 3], "punct", "=")
    ) {
      exportsSet.add(tokens[k + 2]!.value);
      k += 3;
      continue;
    }
    if (
      (t.value === "module" || t.value === moduleObject) &&
      is(tokens[k + 1], "punct", ".") &&
      is(tokens[k + 2], "ident", "exports") &&
      is(tokens[k + 3], "punct", "=")
    ) {
      exportsSet.add("module.exports");
      k += 3;
    }
  }
  const start = tokens[m.valueStart]!.start;
  const end = tokens[m.valueEnd]!.end;
  return {
    id: m.id,
    name: m.name,
    start,
    end,
    size: end - start,
    line: tokens[m.valueStart]!.line,
    requires: [...requires],
    exports: [...exportsSet],
    factory: m.esbuild ? "method" : "function",
  };
}

export function analyzeBundle(source: string, options: { maxTokens?: number } = {}): JsBundleInfo {
  const { tokens, truncated } = tokenize(source, options.maxTokens);
  const limitations: Limitation[] = [];
  if (truncated)
    limitations.push({
      code: "scan_truncated",
      message: "Token budget exhausted; modules after the cut are missing.",
    });
  const head = source.slice(0, 1 << 20);
  const vendors = VENDORS.filter(([, re]) => re.test(head) || re.test(source.slice(-65536))).map(
    ([name]) => name,
  );

  let bundler: Bundler | null = null;
  if (/rspackChunk|__rspack_require__/.test(head)) bundler = "rspack";
  else if (
    /__webpack_require__|webpackChunk|webpackJsonp|__webpack_modules__|\{i:\w+,l:!1,exports:\{\}\}/.test(
      head,
    )
  )
    bundler = "webpack";
  else if (/__commonJS\(|__esm\(/.test(head)) bundler = "esbuild";
  else if (/parcelRequire/.test(head)) bundler = "parcel";
  else if (
    /typeof require=="function"&&require;/.test(head) ||
    /\[function\(require,module,exports\)/.test(head)
  )
    bundler = "browserify";
  else if (/__vite__|import\.meta\.hot/.test(head)) bundler = "vite";
  else if (/ROLLUP_FILE_URL|import\.meta\.ROLLUP/.test(head)) bundler = "rollup";

  const hasRuntime =
    /__webpack_require__\s*\.\s*[dro]\s*=|function __webpack_require__|__webpack_modules__|\{i:\w+,l:!1,exports:\{\}\}|parcelRequire\s*=|typeof require=="function"&&require;|__commonJS\s*=/.test(
      head,
    );
  const chunkIds: string[] = [];
  const entryIds: string[] = [];
  const found: RawModule[] = [];

  // 1) webpack/Rspack chunk pushes: (self.webpackChunkX = self.webpackChunkX || []).push([[ids], { modules }, entry?])
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k]!;
    if (t.type === "ident" && /^(webpackChunk|webpackJsonp|rspackChunk)/.test(t.value)) {
      // find .push( [ [
      const pushAt = tokens.findIndex(
        (x, idx) => idx > k && idx < k + 12 && x.type === "ident" && x.value === "push",
      );
      if (
        pushAt === -1 ||
        !is(tokens[pushAt + 1], "punct", "(") ||
        !is(tokens[pushAt + 2], "punct", "[")
      )
        continue;
      const idsOpen = pushAt + 3;
      if (!is(tokens[idsOpen], "punct", "[")) continue;
      const idsClose = matchBracket(tokens, idsOpen);
      for (let j = idsOpen + 1; j < idsClose; j++) {
        const id = keyOf(tokens[j]);
        if (id !== null && !is(tokens[j], "punct")) chunkIds.push(id);
      }
      const mapOpen = idsClose + 2;
      if (is(tokens[mapOpen - 1], "punct", ",") && is(tokens[mapOpen], "punct", "{")) {
        const mods = readModuleMap(tokens, mapOpen, "object");
        if (mods) {
          found.push(...mods);
          k = matchBracket(tokens, mapOpen);
        }
      }
    }
  }
  // 2) __webpack_modules__ = { ... } / var __webpack_modules__ = ({ ... })
  for (let k = 0; k < tokens.length && found.length === 0; k++) {
    const t = tokens[k]!;
    if (
      t.type === "ident" &&
      t.value === "__webpack_modules__" &&
      is(tokens[k + 1], "punct", "=")
    ) {
      let open = k + 2;
      if (is(tokens[open], "punct", "(")) open++;
      if (is(tokens[open], "punct", "{")) {
        const mods = readModuleMap(tokens, open, "object");
        if (mods) found.push(...mods);
      } else if (is(tokens[open], "punct", "[")) {
        const mods = readModuleMap(tokens, open, "array");
        if (mods) found.push(...mods);
      }
    }
  }
  // 3) esbuild: __commonJS({ "path"(exports, module) { ... } }) / __esm({ ... })
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k]!;
    if (
      t.type === "ident" &&
      (t.value === "__commonJS" || t.value === "__esm") &&
      is(tokens[k + 1], "punct", "(") &&
      is(tokens[k + 2], "punct", "{")
    ) {
      const mods = readModuleMap(tokens, k + 2, "object");
      if (mods) {
        found.push(...mods);
        k = matchBracket(tokens, k + 2);
      }
    }
  }
  // 4) Generic IIFE argument (webpack 4 bootstrap, browserify prelude): `})({ ... })` or `})([ ... ])` or `}({...},{},[1])`
  if (found.length === 0 && bundler !== null && bundler !== "vite" && bundler !== "rollup") {
    for (let k = 0; k < tokens.length; k++) {
      if (
        !is(tokens[k], "punct", "(") ||
        !(is(tokens[k + 1], "punct", "{") || is(tokens[k + 1], "punct", "["))
      )
        continue;
      if (!(is(tokens[k - 1], "punct", ")") || is(tokens[k - 1], "punct", "}"))) continue;
      const kind = is(tokens[k + 1], "punct", "{") ? "object" : "array";
      const mods = readModuleMap(tokens, k + 1, kind);
      if (mods && mods.length >= 2) {
        found.push(...mods);
        const close = matchBracket(tokens, k + 1);
        // browserify trailer: , {}, [entry ids]
        if (is(tokens[close + 1], "punct", ",") && is(tokens[close + 2], "punct", "{")) {
          const cacheClose = matchBracket(tokens, close + 2);
          if (
            is(tokens[cacheClose + 1], "punct", ",") &&
            is(tokens[cacheClose + 2], "punct", "[")
          ) {
            const entriesClose = matchBracket(tokens, cacheClose + 2);
            for (let j = cacheClose + 3; j < entriesClose; j++) {
              const id = keyOf(tokens[j]);
              if (id !== null && !is(tokens[j], "punct")) entryIds.push(id);
            }
          }
        }
        break;
      }
    }
  }

  // Resolve the require parameter per module: webpack passes (module, exports, require); browserify (require, module, exports); esbuild (exports, module)
  for (const m of found) {
    if (m.depsMap) m.requireParam = m.fn.params[0] ?? null;
    else if (bundler === "esbuild") m.requireParam = null;
    else m.requireParam = m.fn.params[2] ?? null;
  }
  const wrapped = found.map((m) => collectBody(tokens, m)).toSorted((a, b) => a.start - b.start);
  // no module map: a scope-hoisted bundle may still say where each module starts
  const modules = wrapped.length ? wrapped : hoistedSections(source, tokens);
  const chunks = modules.length ? [] : chunkImports(tokens);
  if (!modules.length && chunks.length)
    limitations.push({
      code: "bundle_chunk_only",
      message: `No module boundaries inside this file (Rollup and Vite keep none); it imports ${chunks.length} other chunk file(s) of its build: ${chunks.slice(0, 5).join(", ")}${chunks.length > 5 ? ", …" : ""}. Recover those files on their own, or use a source map.`,
    });
  const moduleOf = (offset: number): string | null =>
    modules.find((m) => offset >= m.start && offset < m.end)?.id ?? null;
  const cands = findCandidates(tokens, source, (row, at) => {
    (row as BundleCandidate).moduleId = moduleOf(at.start);
  });
  if (cands.truncated)
    limitations.push({
      code: "candidates_truncated",
      message: "More endpoints, storage accesses or URLs exist than the 2,000 per list recorded.",
    });
  if (cands.clientsSkipped)
    limitations.push({
      code: "client_calls_skipped",
      message:
        "More than 2,000 calls of HTTP client modules (node:https, node:http, Electron's net) were checked; the further ones give no endpoint rows.",
    });
  if (cands.wrappersSkipped)
    limitations.push({
      code: "storage_wrappers_skipped",
      message:
        "The file has more functions than storage wrappers are followed for (50,000); keys passed through a wrapper are not read at each call (no rows with via).",
    });
  const candidates = {
    // A single file has no other module to look a constant up in.
    endpoints: (cands.endpoints as BundleCandidate[]).map((c) => resolvePending(c, () => null)),
    routes: cands.routes as BundleCandidate[],
    storage: (cands.storage as BundleCandidate[]).map((c) => resolvePending(c, () => null)),
    urls: cands.urls as BundleCandidate[],
  };

  if (bundler && modules.length === 0 && bundler !== "vite" && bundler !== "rollup") {
    limitations.push({
      code: "bundle_modules_not_found",
      message: `${bundler} markers are present but no module map could be delimited; the runtime may use an unsupported layout.`,
    });
  }
  return {
    bundler,
    hasRuntime,
    chunkIds,
    entryIds,
    modules,
    vendors,
    ...candidates,
    ...(chunks.length ? { chunks } : {}),
    limitations,
  };
}
