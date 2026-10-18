/**
 * Dependency-free JavaScript scanner. It tokenizes enough of the language to
 * skip strings, template literals, comments and regular expressions, then
 * reports module references and Electron IPC usage with line numbers. It is a
 * lexer, not a parser: dynamic specifiers and computed channels are reported
 * as `dynamic` so that callers never mistake a guess for a fact.
 */

import { Constants, type Evaluator, type Resolved, resolveAliases } from "./aliases.js";
import { PayloadReader } from "./payload.js";
import { ExpressionResolver, type ResolveMethod, type Val } from "./resolve.js";
import {
  channelArg,
  type ObjectCall,
  type ParamIpc,
  WrapperReader,
  type WrapperFacts,
  type WrapperRow,
} from "./wrappers.js";

export interface ModuleReference {
  specifier: string;
  kind: "import" | "require" | "dynamic-import" | "export-from";
  line: number;
  dynamic: boolean;
}

export interface IpcUsage {
  api: string;
  channel: string | null;
  line: number;
  /**
   * How the row was read when not from a literal call on the object's own name: through another
   * name for ipcMain/ipcRenderer (`alias`), with a channel name taken from a constant, through
   * a helper function of the file that passes its first argument on as the channel (`wrapper`),
   * or as one of the keys of an object whose entries are registered in a loop (`table`).
   * `global`: through a name another file defines (a `window.` global, or a name at the top of a
   * file that is built together with this one). `webContents`: on one page's own channel object
   * (`webContents.ipc.on`). A `wrapper` row of a class or object method (see wrappers.ts) is read
   * at the call of the method and names it in `wrapper`. `parameter`: on a parameter of a
   * function or method (named in `wrapper`) that every call site of the application passes
   * ipcMain or ipcRenderer for (`register(ipc) { ipc.handle(…) }` with `prefs.register(ipcMain)`).
   */
  via?:
    | "alias"
    | "constant"
    | "wrapper"
    | "table"
    | "global"
    | "webContents"
    | "resolved"
    | "parameter";
  /** For a call of a wrapper method: `<Class>.<method>` (or the export key of a minified class). */
  wrapper?: string;
  /**
   * For `via: "resolved"`: how the channel was read from an expression the fast scan could not
   * (see resolve.ts), and the lines of the call sites or lists it was bound at.
   */
  resolution?: { method: ResolveMethod; lines: number[] };
  /** A channel named by a constant of another module, to be looked up there. */
  channelRef?: { specifier: string; property: string; before?: string; after?: string };
  /**
   * For a call without a channel: why the evaluation of the code that builds it stopped (an
   * unsupported form, too many values, a limit, a cycle, a value known only at run time).
   */
  reason?: string;
  /**
   * For a call that sends (`ipcRenderer.send` / `invoke` / `sendSync` / `postMessage`,
   * `webContents.send`, `event.reply`, `event.sender.send`) read at the call itself: the shape of
   * the arguments after the channel as written, e.g. `({dir, packageManager}, ...)`, or
   * `not read` (see payload.ts). Absent on rows read elsewhere (a wrapper method, a helper, a name
   * of another file): their payload is not read. Compared as content; never part of the identity.
   */
  args?: string;
}

export interface ScanResult {
  references: ModuleReference[];
  ipc: IpcUsage[];
  exports: string[];
  moduleSystem: "esm" | "cjs" | "mixed" | "none";
  sourceMappingUrl: string | null;
  lines: number;
  minified: boolean;
  truncated: boolean;
  /** String constants this file exports; other files' channel names may refer to them. */
  constants?: Record<string, string>;
  /** Names this file passes on from another module (`module.exports = { A: x.A }`, `export { A } from`). */
  reexports?: Record<string, { specifier: string; property: string }>;
  /** `export * from "…"` specifiers. */
  starExports?: string[];
  /**
   * Every `module.exports = require("…")`, also under a condition or replaced later: for the
   * replacements of wrapper methods only, where reading too much only reads less.
   */
  looseStarExports?: string[];
  /** Keys of `constants` whose values were read by evaluating code (see resolve.ts). */
  evaluated?: string[];
  /** Exported names whose value an evaluation could not read, with the reason. */
  unevaluated?: Record<string, string>;
  /** Wrapper classes and objects this file exports, for calls in other files (wrappers.ts). */
  wrappers?: WrapperFacts;
  /** The search for calls of the file's wrappers ran out of its budget. */
  wrappersCapped?: true;
  /**
   * Methods of the file's own IPC wrappers the file replaces, as `Class.method:line` (at most
   * 20): their calls in the file give no row.
   */
  wrappersReplaced?: string[];
  /**
   * Functions and methods whose parameter is used as the IPC object (`register(ipc) {
   * ipc.handle(…) }`), with this file's call sites; the application stage decides (wrappers.ts).
   */
  paramIpc?: ParamIpc[];
}

/** What a second reader of the same token stream needs to follow names. */
export interface ScanContext {
  aliases: Map<number, string>;
  constants: Constants;
  /** Helper functions of the file that pass their first argument on as an IPC channel. */
  wrappers: Map<string, string>;
  /**
   * Calls of the file's wrapper methods (wrappers.ts), by the token of the method name: the IPC
   * API and the token of the channel argument. Read on first use.
   */
  methodCalls?: () => ReadonlyMap<number, { api: string; arg: number }>;
}

/**
 * Top-level functions whose first parameter ends up as the channel of an IPC call inside them:
 * `function route(channel, fn) { ipcMain.handle(channel, …) }`,
 * `const call = (channel) => (...args) => ipcRenderer.invoke(channel, ...args)`,
 * `const emit = ipcRenderer.send.bind(ipcRenderer)`. Maps the function's name to the IPC API.
 */
function findWrappers(tokens: Token[], aliases: Map<number, string>): Map<string, string> {
  const wrappers = new Map<string, string>();
  const is = (k: number, type: Token["type"], value?: string): boolean => {
    const t = tokens[k];
    return !!t && t.type === type && (value === undefined || t.value === value);
  };
  const apiAt = (k: number): string | null => {
    if (!is(k, "ident") || !is(k + 1, "punct", ".") || !is(k + 2, "ident")) return null;
    // the method name decides first: almost no token pair gets as far as building a string
    if (!IPC_METHODS.has(tokens[k + 2]!.value)) return null;
    const api = `${aliases.get(k) ?? tokens[k]!.value}.${tokens[k + 2]!.value}`;
    return IPC_APIS.has(api) && !api.startsWith("contextBridge.") ? api : null;
  };
  /** The IPC API called with `param` as its first argument between two token positions. */
  const forwards = (from: number, to: number, param: string): string | null => {
    for (let k = from; k + 4 < to; k++) {
      const api = apiAt(k);
      // The parameter must be the whole first argument: `send(ns + ":" + name)` and
      // `send(m.channel)` build the channel from it, they do not pass it on.
      if (
        api &&
        is(k + 3, "punct", "(") &&
        is(k + 4, "ident", param) &&
        (is(k + 5, "punct", ",") || is(k + 5, "punct", ")"))
      )
        return api;
    }
    return null;
  };
  // The closing bracket of every opening one, counting all three kinds alike, matched once.
  // A body's end is then found by jumping over bracket groups instead of walking every token.
  const match = new Int32Array(tokens.length).fill(-1);
  const opened: number[] = [];
  for (let j = 0; j < tokens.length; j++) {
    const p = tokens[j]!;
    if (p.type !== "punct") continue;
    if (p.value === "{" || p.value === "(" || p.value === "[") opened.push(j);
    else if (p.value === "}" || p.value === ")" || p.value === "]") {
      const at = opened.pop();
      if (at !== undefined) match[at] = j;
    }
  }
  /** End of the function body that starts at `k` (a brace block, or an expression). */
  const bodyEnd = (k: number): number => {
    const limit = Math.min(tokens.length, k + 4000);
    if (is(k, "punct", "{")) return match[k]! !== -1 && match[k]! < limit ? match[k]! : limit;
    // An expression ends at a `;` or `,` outside brackets, or where its enclosing bracket closes.
    for (let j = k; j < limit; j++) {
      const p = tokens[j]!;
      if (p.type !== "punct") continue;
      if (p.value === "{" || p.value === "(" || p.value === "[") {
        if (match[j] === -1) return limit;
        j = match[j]!;
      } else if (p.value === "}" || p.value === ")" || p.value === "]") return j;
      else if (p.value === ";" || p.value === ",") return j;
    }
    return limit;
  };
  let depth = 0;
  for (let k = 0; k + 4 < tokens.length; k++) {
    const t = tokens[k]!;
    if (t.type === "punct") {
      if (t.value === "{") depth++;
      else if (t.value === "}") depth--;
      continue;
    }
    if (depth !== 0 || t.type !== "ident") continue;
    let name: string | null = null;
    let params = -1;
    if (t.value === "function" && is(k + 1, "ident") && is(k + 2, "punct", "(")) {
      name = tokens[k + 1]!.value;
      params = k + 2;
    } else if (is(k + 1, "punct", "=") && !is(k - 1, "punct", ".")) {
      let v = k + 2;
      // `emit = ipcRenderer.send.bind(ipcRenderer)`
      const bound = apiAt(v);
      if (bound && is(v + 3, "punct", ".") && is(v + 4, "ident", "bind")) {
        wrappers.set(t.value, bound);
        continue;
      }
      if (is(v, "ident", "async")) v++;
      if (is(v, "ident", "function")) {
        v++;
        if (is(v, "ident")) v++;
      }
      if (is(v, "punct", "(")) {
        name = t.value;
        params = v;
      } else if (is(v, "ident") && is(v + 1, "punct", "=>")) {
        const api = forwards(v + 2, bodyEnd(v + 2), tokens[v]!.value);
        if (api) wrappers.set(t.value, api);
        continue;
      }
    }
    if (name === null || !is(params + 1, "ident")) continue;
    const param = tokens[params + 1]!.value;
    // skip the parameter list
    let close = params;
    for (let d = 0; close < tokens.length && close < params + 200; close++) {
      const p = tokens[close]!;
      if (p.type !== "punct") continue;
      if (p.value === "(") d++;
      else if (p.value === ")") {
        d--;
        if (d === 0) break;
      }
    }
    const start = is(close + 1, "punct", "=>") ? close + 2 : close + 1;
    const api = forwards(start, bodyEnd(start), param);
    if (api) wrappers.set(name, api);
  }
  return wrappers;
}

/** A file that contains none of these cannot have a finding that depends on following a name. */
const NAMES_SOMETHING =
  /ipcMain|ipcRenderer|contextBridge|fetch|BrowserWindow|BrowserView|WebContentsView|localStorage|sessionStorage|webContents|exposeIn/;

/** Names whose other names are followed (see aliases.ts). */
export const ALIAS_TARGETS: ReadonlySet<string> = new Set([
  "ipcMain",
  "ipcRenderer",
  "contextBridge",
  "fetch",
  "BrowserWindow",
  "BrowserView",
  "WebContentsView",
  "localStorage",
  "sessionStorage",
]);

export interface Token {
  type: "ident" | "string" | "punct" | "template" | "regex" | "number";
  value: string;
  line: number;
  /** Byte offsets into the source (end is exclusive). */
  start: number;
  end: number;
}

const KEYWORDS_BEFORE_REGEX = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "case",
  "do",
  "else",
  "yield",
  "await",
]);
/** The IPC calls the scan reads, as `<object>.<method>`. */
export const IPC_APIS: ReadonlySet<string> = new Set([
  "ipcMain.on",
  "ipcMain.once",
  "ipcMain.handle",
  "ipcMain.handleOnce",
  "ipcRenderer.on",
  "ipcRenderer.once",
  "ipcRenderer.send",
  "ipcRenderer.invoke",
  "ipcRenderer.sendSync",
  "ipcRenderer.postMessage",
  "webContents.send",
  "contextBridge.exposeInMainWorld",
]);
/** Methods of ipcMain and ipcRenderer a parameter used as one of them is read for (`paramIpc`). */
const OBJECT_METHODS: ReadonlySet<string> = new Set([
  "on",
  "once",
  "handle",
  "handleOnce",
  "send",
  "invoke",
  "sendSync",
  "postMessage",
]);
/** Of those, the methods only IPC objects have: read on a parameter in any file. */
const IPC_ONLY_METHODS: ReadonlySet<string> = new Set([
  "handle",
  "handleOnce",
  "invoke",
  "sendSync",
]);
const OBJECT_SENDS: ReadonlySet<string> = new Set(["send", "invoke", "sendSync", "postMessage"]);
/**
 * IPC calls read once per element of a list of routes (`ipcMain[r.kind](r.channel, …)`, and the
 * loops the fast scan leaves open), per file. The later ones stay without a channel.
 */
const MAX_ROUTE_READS = 256;
/** Calls on names that may be such a parameter, read per file. */
const MAX_OBJECT_CALLS = 2000;
/** Objects a class field may hold that the scan reads IPC calls on. */
const FIELD_TARGETS: ReadonlySet<string> = new Set(["ipcMain", "ipcRenderer"]);
const IPC_METHODS = new Set([...IPC_APIS].map((api) => api.split(".")[1]!));
/** The calls whose arguments after the channel are a payload that is sent (see `IpcUsage.args`). */
const SENDING_APIS: ReadonlySet<string> = new Set([
  "ipcRenderer.send",
  "ipcRenderer.invoke",
  "ipcRenderer.sendSync",
  "ipcRenderer.postMessage",
  "webContents.send",
]);
const PUNCT3 = new Set(["===", "!==", "...", ">>>", "**=", "<<=", ">>=", "&&=", "||=", "??="]);
const PUNCT2 = new Set([
  "=>",
  "==",
  "!=",
  "<=",
  ">=",
  "&&",
  "||",
  "??",
  "?.",
  "++",
  "--",
  "+=",
  "-=",
  "*=",
  "/=",
  "**",
  "<<",
  ">>",
]);
/** Characters that can follow the first one of a multi-character punctuator. */
const PUNCT_SECOND = new Set([...PUNCT2, ...PUNCT3].map((p) => p[1]!));
// ASCII by char code; everything from U+00C0 up counts as a letter, as before.
const isIdentStart = (c: string): boolean => {
  const x = c.charCodeAt(0);
  return (x >= 97 && x <= 122) || (x >= 65 && x <= 90) || x === 95 || x === 36 || x >= 0xc0;
};
const isIdentPart = (c: string): boolean => {
  const x = c.charCodeAt(0);
  return (
    (x >= 97 && x <= 122) ||
    (x >= 65 && x <= 90) ||
    (x >= 48 && x <= 57) ||
    x === 95 ||
    x === 36 ||
    x >= 0xc0
  );
};

/**
 * The text of the escape sequence at `j` (a backslash) of a string or template literal, the index
 * after it, and the line breaks it spans (a line continuation): `\n`, `\x41`, `\u0041`,
 * `\u{1F600}`, `\0`, legacy octal `\101`, and any other character as itself.
 */
function escapeAt(source: string, j: number): [string, number, number] {
  const e = source[j + 1];
  if (e === undefined) return ["", j + 1, 0];
  const hex = (from: number, length: number): number | null => {
    const digits = source.slice(from, from + length);
    return digits.length === length && /^[0-9a-fA-F]+$/.test(digits) ? parseInt(digits, 16) : null;
  };
  switch (e) {
    case "n":
      return ["\n", j + 2, 0];
    case "t":
      return ["\t", j + 2, 0];
    case "r":
      return ["\r", j + 2, 0];
    case "b":
      return ["\b", j + 2, 0];
    case "f":
      return ["\f", j + 2, 0];
    case "v":
      return ["\v", j + 2, 0];
    case "\r":
      return ["", source[j + 2] === "\n" ? j + 3 : j + 2, 1];
    case "\n":
    case "\u2028":
    case "\u2029":
      return ["", j + 2, 1];
    case "x": {
      const code = hex(j + 2, 2);
      return code === null ? ["x", j + 2, 0] : [String.fromCharCode(code), j + 4, 0];
    }
    case "u": {
      if (source[j + 2] === "{") {
        const close = source.indexOf("}", j + 3);
        const code = close > j + 3 && close < j + 10 ? hex(j + 3, close - j - 3) : null;
        if (code !== null && code <= 0x10ffff) return [String.fromCodePoint(code), close + 1, 0];
        return ["u", j + 2, 0];
      }
      const code = hex(j + 2, 4);
      return code === null ? ["u", j + 2, 0] : [String.fromCharCode(code), j + 6, 0];
    }
    default: {
      // `\0` and legacy octal escapes: up to three octal digits, at most 255
      const octal = /^[0-7]{1,3}/.exec(source.slice(j + 1, j + 4))?.[0];
      if (octal !== undefined) {
        let digits = octal;
        while (parseInt(digits, 8) > 255) digits = digits.slice(0, -1);
        return [String.fromCharCode(parseInt(digits, 8)), j + 1 + digits.length, 0];
      }
      // any other character stands for itself (a surrogate pair stays whole)
      const cp = source.codePointAt(j + 1)!;
      const ch = String.fromCodePoint(cp);
      return [ch, j + 1 + ch.length, 0];
    }
  }
}

export function tokenize(
  source: string,
  maxTokens = 2_000_000,
): { tokens: Token[]; truncated: boolean } {
  const tokens: Token[] = [];
  const n = source.length;
  let i = 0;
  let line = 1;
  let braceDepth = 0;
  const templateDepth: number[] = [];
  const regexAllowed = (): boolean => {
    const t = tokens[tokens.length - 1];
    if (!t) return true;
    if (t.type === "punct") return !")]}".includes(t.value);
    if (t.type === "ident") return KEYWORDS_BEFORE_REGEX.has(t.value);
    return false;
  };

  while (i < n && tokens.length < maxTokens) {
    const c = source[i]!;
    if (c === "\n") {
      line++;
      i++;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r" || c === " " || c === "﻿") {
      i++;
      continue;
    }
    if (c === "/" && source[i + 1] === "/") {
      const end = source.indexOf("\n", i);
      i = end === -1 ? n : end;
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      for (let k = i; k < stop; k++) if (source[k] === "\n") line++;
      i = stop;
      continue;
    }
    if (c === '"' || c === "'") {
      const startLine = line;
      let j = i + 1;
      let value = "";
      let run = j;
      while (j < n && source[j] !== c && source[j] !== "\n") {
        if (source[j] === "\\") {
          const [text, next, lines] = escapeAt(source, j);
          value += source.slice(run, j) + text;
          line += lines;
          j = next;
          run = j;
          continue;
        }
        j++;
      }
      value += source.slice(run, Math.min(j, n));
      tokens.push({ type: "string", value, line: startLine, start: i, end: j + 1 });
      i = j + 1;
      continue;
    }
    const resumesTemplate =
      c === "}" &&
      templateDepth.length > 0 &&
      templateDepth[templateDepth.length - 1] === braceDepth;
    if (c === "`" || resumesTemplate) {
      if (resumesTemplate) {
        templateDepth.pop();
        braceDepth--;
      }
      const startLine = line;
      let j = i + 1;
      let value = "";
      let dynamic = false;
      while (j < n && source[j] !== "`") {
        if (source[j] === "\\") {
          const [text, next, lines] = escapeAt(source, j);
          value += text;
          line += lines;
          j = next;
          continue;
        }
        if (source[j] === "$" && source[j + 1] === "{") {
          dynamic = true;
          templateDepth.push(braceDepth + 1);
          j += 2;
          break;
        }
        if (source[j] === "\n") line++;
        value += source[j];
        j++;
      }
      tokens.push({
        type: "template",
        value: dynamic ? `${value}\${…}` : value,
        line: startLine,
        start: i,
        end: dynamic ? j : j + 1,
      });
      i = dynamic ? j : j + 1;
      if (dynamic) braceDepth++;
      continue;
    }
    if (c === "/" && regexAllowed()) {
      let j = i + 1;
      let inClass = false;
      while (j < n && source[j] !== "\n") {
        if (source[j] === "\\") {
          j += 2;
          continue;
        }
        if (source[j] === "[") inClass = true;
        else if (source[j] === "]") inClass = false;
        else if (source[j] === "/" && !inClass) break;
        j++;
      }
      while (j + 1 < n && /[a-z]/.test(source[j + 1]!)) j++;
      tokens.push({ type: "regex", value: source.slice(i, j + 1), line, start: i, end: j + 1 });
      i = j + 1;
      continue;
    }
    if (isIdentStart(c)) {
      let j = i + 1;
      while (j < n && isIdentPart(source[j]!)) j++;
      tokens.push({ type: "ident", value: source.slice(i, j), line, start: i, end: j });
      i = j;
      continue;
    }
    if (/\d/.test(c) || (c === "." && /\d/.test(source[i + 1] ?? ""))) {
      let j = i + 1;
      while (j < n && /[\w.]/.test(source[j]!)) j++;
      tokens.push({ type: "number", value: source.slice(i, j), line, start: i, end: j });
      i = j;
      continue;
    }
    if (c === "{") braceDepth++;
    if (c === "}") braceDepth--;
    // Most punctuation is one character; only look for a longer one when the next character
    // could continue it (saves two substrings per character on minified code).
    let punct = c;
    if (PUNCT_SECOND.has(source[i + 1] ?? "")) {
      const three = source.slice(i, i + 3);
      const two = source.slice(i, i + 2);
      punct = PUNCT3.has(three) ? three : PUNCT2.has(two) ? two : c;
    }
    tokens.push({ type: "punct", value: punct, line, start: i, end: i + punct.length });
    i += punct.length;
  }
  return { tokens: optionalIpcCalls(tokens), truncated: i < n };
}

/**
 * Names whose optional chaining is read as the plain member: IPC methods and the objects IPC is
 * called on. `ipcRenderer?.send("x")`, `ipcRenderer.send?.("x")`, `event.sender?.send("x")`,
 * `win?.webContents?.send("x")` are then the same calls as without `?.`, for every reader.
 */
const OPTIONAL_IPC = new Set([
  "on",
  "once",
  "handle",
  "handleOnce",
  "send",
  "invoke",
  "sendSync",
  "sendToHost",
  "postMessage",
  "reply",
  "exposeInMainWorld",
  "webContents",
  "sender",
  "ipcRenderer",
  "ipcMain",
  "contextBridge",
]);

/**
 * The token stream with optional chaining on IPC calls read as plain calls, in the source form
 * and in the form esbuild (and TypeScript, Babel) lower it to for older targets:
 *
 * - `X?.m(` and `X.m?.(` are `X.m(` for a name m in OPTIONAL_IPC (`?.` before another name
 *   stays as it is);
 * - `X == null ? void 0 : X.m(` (also `X == null || X.m(`, `null == X || X.m(`) is `X.m(`;
 * - `(T = E) == null ? void 0 : T.m(` (also with `||`, and `=== null || T === void 0 ? void 0 :`)
 *   is `E.m(` when E is a chain of names: the temporary is assigned from E in the same expression,
 *   so it is that object;
 * - `(T = E.m) == null ? void 0 : T.call(R, …)` is `E.m(…)` when R is E itself, or the temporary
 *   E was assigned to (`(_e = (_d = win.webContents).send) == null ? void 0 : _e.call(_d, …)`).
 *
 * The object guarded against null is the receiver of the call: the call is made whenever the
 * object is there, which is what a row says of a plain call too. Nothing else is rewritten, and a
 * receiver that is not provably the same object (another name, another temporary) is left alone.
 */
function optionalIpcCalls(tokens: Token[]): Token[] {
  let any = false;
  for (const t of tokens)
    if (t.type === "punct" && (t.value === "?." || t.value === "==" || t.value === "===")) {
      any = true;
      break;
    }
  if (!any) return tokens;
  const punct = (a: Token[], k: number, v: string): boolean =>
    a[k]?.type === "punct" && a[k]!.value === v;
  const ident = (a: Token[], k: number, v?: string): boolean =>
    a[k]?.type === "ident" && (v === undefined || a[k]!.value === v);
  const ipcName = (a: Token[], k: number): boolean =>
    a[k]?.type === "ident" && OPTIONAL_IPC.has(a[k]!.value);
  /** The end (exclusive) of the chain of names `a.b.c` that starts at k, or k. */
  const chainEnd = (a: Token[], k: number): number => {
    if (!ident(a, k)) return k;
    let j = k + 1;
    while (punct(a, j, ".") && ident(a, j + 1)) j += 2;
    return j;
  };
  const same = (a: Token[], from: number, to: number, at: number): boolean => {
    for (let j = from; j < to; j++)
      if (a[at + j - from]?.type !== a[j]!.type || a[at + j - from]!.value !== a[j]!.value)
        return false;
    return true;
  };
  /**
   * The length of the null test of the temporary `name` at k: `== null ? void 0 :`,
   * `== null ||`, `=== null || name === void 0 ? void 0 :`; 0 when there is none.
   */
  const guard = (a: Token[], k: number, name: string): number => {
    if (punct(a, k, "==") && ident(a, k + 1, "null")) {
      if (punct(a, k + 2, "||")) return 3;
      if (punct(a, k + 2, "?") && ident(a, k + 3, "void") && a[k + 4]?.value === "0")
        return punct(a, k + 5, ":") ? 6 : 0;
      return 0;
    }
    if (
      punct(a, k, "===") &&
      ident(a, k + 1, "null") &&
      punct(a, k + 2, "||") &&
      ident(a, k + 3, name) &&
      punct(a, k + 4, "===") &&
      ident(a, k + 5, "void") &&
      a[k + 6]?.value === "0" &&
      punct(a, k + 7, "?") &&
      ident(a, k + 8, "void") &&
      a[k + 9]?.value === "0" &&
      punct(a, k + 10, ":")
    )
      return 11;
    return 0;
  };
  // 1. `?.` in the source. The array is copied only from the first change on: most files have
  // nothing to rewrite, and their stream stays the same array.
  let a: Token[] = tokens;
  let copy: Token[] | null = null;
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k]!;
    if (t.type === "punct" && t.value === "?.") {
      // `X.m?.(`: the call itself; `X?.m`: the member
      const call = punct(tokens, k + 1, "(") && ipcName(tokens, k - 1);
      if (call || ipcName(tokens, k + 1)) {
        copy ??= tokens.slice(0, k);
        if (!call) copy.push({ ...t, value: "." });
        continue;
      }
    }
    copy?.push(t);
  }
  if (copy) a = copy;
  // 2. the lowered forms, innermost first: a temporary inside E is read before E is
  for (let pass = 0; pass < 3; pass++) {
    const copied: { out: Token[] | null } = { out: null };
    /** The copy up to token k, made at the first change. */
    const start = (k: number): Token[] => (copied.out ??= a.slice(0, k));
    for (let k = 0; k < a.length; k++) {
      // Every form below starts with `X ==`, `X ===` or `(T =`: most tokens are passed over by
      // this test alone.
      const t1 = a[k + 1]?.value;
      if (t1 !== "==" && t1 !== "===" && !(a[k]!.value === "(" && a[k + 2]?.value === "=")) {
        copied.out?.push(a[k]!);
        continue;
      }
      // `X == null ? void 0 : X.m`, `X == null || X.m`, `null == X || X.m`
      if (ident(a, k) && !punct(a, k - 1, ".") && !punct(a, k - 1, "?.")) {
        const name = a[k]!.value;
        const g = guard(a, k + 1, name);
        if (g && ident(a, k + 1 + g, name) && punct(a, k + 2 + g, ".") && ipcName(a, k + 3 + g)) {
          start(k).push(a[k]!);
          k += 1 + g; // on the second X, which is dropped: the `.` comes next
          continue;
        }
      }
      if (
        ident(a, k, "null") &&
        punct(a, k + 1, "==") &&
        ident(a, k + 2) &&
        punct(a, k + 3, "||") &&
        ident(a, k + 4, a[k + 2]?.value) &&
        punct(a, k + 5, ".") &&
        ipcName(a, k + 6)
      ) {
        start(k).push(a[k + 4]!);
        k += 4;
        continue;
      }
      // `(T = E) <guard> T.m(` and `(T = E.m) <guard> T.call(R, …)`
      if (punct(a, k, "(") && ident(a, k + 1) && punct(a, k + 2, "=")) {
        const temp = a[k + 1]!.value;
        // E: a chain of names, or `(T2 = C).m`
        let inner: { name: string; from: number; to: number } | null = null;
        let eFrom = k + 3;
        let eTo = chainEnd(a, eFrom);
        if (
          eTo === eFrom &&
          punct(a, eFrom, "(") &&
          ident(a, eFrom + 1) &&
          punct(a, eFrom + 2, "=")
        ) {
          const cTo = chainEnd(a, eFrom + 3);
          if (
            cTo > eFrom + 3 &&
            punct(a, cTo, ")") &&
            punct(a, cTo + 1, ".") &&
            ident(a, cTo + 2)
          ) {
            inner = { name: a[eFrom + 1]!.value, from: eFrom + 3, to: cTo };
            eTo = cTo + 3;
          }
        }
        if (eTo > eFrom && punct(a, eTo, ")")) {
          const g = guard(a, eTo + 1, temp);
          const use = eTo + 1 + g;
          if (g && ident(a, use, temp) && punct(a, use + 1, ".")) {
            // `T.m(`: E is the receiver
            if (!inner && ipcName(a, use + 2)) {
              const o = start(k);
              for (let j = eFrom; j < eTo; j++) o.push(a[j]!);
              k = use; // the `.` after T comes next
              continue;
            }
            // `T.call(R, …)`: E's last name is the method, R its receiver
            const method = eTo - 1;
            if (
              ident(a, use + 2, "call") &&
              punct(a, use + 3, "(") &&
              ipcName(a, method) &&
              punct(a, method - 1, ".")
            ) {
              const r = use + 4;
              const rEnd = chainEnd(a, r);
              const receiver = inner
                ? rEnd === r + 1 && a[r]!.value === inner.name
                : rEnd > r && rEnd - r === method - 1 - eFrom && same(a, eFrom, method - 1, r);
              if (receiver && (punct(a, rEnd, ",") || punct(a, rEnd, ")"))) {
                const o = start(k);
                if (inner) for (let j = inner.from; j < inner.to; j++) o.push(a[j]!);
                else for (let j = eFrom; j < method - 1; j++) o.push(a[j]!);
                o.push(a[method - 1]!, a[method]!, a[use + 3]!);
                // the arguments after R, without its comma
                k = punct(a, rEnd, ",") ? rEnd : rEnd - 1;
                continue;
              }
            }
          }
        }
      }
      copied.out?.push(a[k]!);
    }
    if (!copied.out) break;
    a = copied.out;
  }
  return a;
}

const literal = (t: Token | undefined): string | null =>
  t && (t.type === "string" || (t.type === "template" && !t.value.includes("${"))) ? t.value : null;

const EXPORT_DECLARATIONS = new Set([
  "default",
  "function",
  "class",
  "const",
  "let",
  "var",
  "async",
]);

export function scanJavaScript(
  source: string,
  options: {
    maxTokens?: number;
    /** Receives the token stream once, for a second reader that should not tokenize again. */
    onTokens?: (tokens: Token[], truncated: boolean, context: ScanContext) => void;
  } = {},
): ScanResult {
  const { tokens, truncated } = tokenize(source, options.maxTokens);
  // Names are resolved with their scope: first the file's constants, then, when the file has
  // channel-forwarding helpers, those as well (they are found with the first result).
  const constants = new Constants(tokens);
  let resolver: ExpressionResolver | null = null;
  constants.useEvaluator(
    evaluatorFor(
      tokens,
      constants,
      () => resolver,
      (r) => (resolver = r),
    ),
  );
  // Most files of a large application name none of the objects whose other names are followed
  // (icons, locale tables, vendored libraries). For those the resolution is skipped: nothing
  // would use it, and it is the most expensive step of a scan.
  // Whether the text names IPC at all: tested once per file, not at every `this.x.on(…)`.
  let ipcText: boolean | undefined;
  const namesIpc = (): boolean => (ipcText ??= /ipc|webContents/.test(source));
  let aliases = new Map<number, string>();
  let wrappers = new Map<string, string>();
  if (NAMES_SOMETHING.test(source)) {
    const own = new Set(constants.names());
    aliases = resolveAliases(tokens, ALIAS_TARGETS, own);
    if (namesIpc()) wrappers = findWrappers(tokens, aliases);
    if (wrappers.size) {
      for (const name of wrappers.keys()) own.add(name);
      aliases = resolveAliases(tokens, ALIAS_TARGETS, own);
    }
    constants.visible = aliases;
  }
  // Wrapper classes and objects (wrappers.ts), read once on first use: by the bridge reader
  // through the context, else after the scan below.
  let wrapperScan: {
    rows: WrapperRow[];
    inner: Set<number>;
    facts: WrapperFacts | null;
    calls: Map<number, { api: string; arg: number }>;
    capped?: true;
    paramIpc?: ParamIpc[];
    replaced?: string[];
  } | null = null;
  const readWrappers = (): NonNullable<typeof wrapperScan> => {
    if (wrapperScan) return wrapperScan;
    wrapperScan = { rows: [], inner: new Set(), facts: null, calls: new Map() };
    const named = /ipcMain|ipcRenderer|webContents/.test(source);
    // A file that names no IPC object may still take one as a parameter: read for that when it
    // calls a method only IPC objects have (`register(m) { m.handle(…) }`), and for the methods
    // they share with other objects (`on`, `once`, `send`, `postMessage`) only when its text names
    // `ipc` (`register(ipc)`, a comment, an import of ipcMain). A library that never says `ipc`
    // is not read for its streams and emitters.
    const namesIpcText = /ipc/i.test(source);
    const objectsMaybe =
      /\.(handle|handleOnce|invoke|sendSync)\(/.test(source) ||
      (namesIpcText && /\.(on|once|send|postMessage)\(/.test(source));
    if (!named && !objectsMaybe) return wrapperScan;
    const punct = (k: number, v: string): boolean =>
      tokens[k]?.type === "punct" && tokens[k]!.value === v;
    // IPC calls whose channel is a lone name: the calls a wrapper method can make
    const calls: Array<{ api: string; arg: number }> = [];
    for (let k = 0; named && k + 5 < tokens.length; k++) {
      const method = tokens[k + 2]!;
      if (
        tokens[k]!.type !== "ident" ||
        !punct(k + 1, ".") ||
        method.type !== "ident" ||
        !IPC_METHODS.has(method.value) ||
        !punct(k + 3, "(") ||
        tokens[k + 4]!.type !== "ident" ||
        !(punct(k + 5, ",") || punct(k + 5, ")"))
      )
        continue;
      let owner = aliases.get(k) ?? tokens[k]!.value;
      if (
        !IPC_APIS.has(`${owner}.${method.value}`) &&
        punct(k - 1, ".") &&
        tokens[k - 2]?.type === "ident" &&
        tokens[k - 2]!.value === "this"
      )
        owner =
          (resolver ??= new ExpressionResolver(tokens, constants)).fieldOwner(
            k,
            aliases,
            FIELD_TARGETS,
          ) ?? owner;
      const api = `${owner}.${method.value}`;
      if (IPC_APIS.has(api) && !api.startsWith("contextBridge.")) calls.push({ api, arg: k + 4 });
    }
    // `ipc.handle(C.GET, …)` on a name that is no IPC object here: maybe a parameter that every
    // call site passes ipcMain for (`register(ipc) { … }`, called as `prefs.register(ipcMain)`)
    const objects: Array<{ at: number; call: ObjectCall }> = [];
    let payloads: PayloadReader | null = null;
    for (
      let k = 0;
      objectsMaybe && k + 3 < tokens.length && objects.length < MAX_OBJECT_CALLS;
      k++
    ) {
      const method = tokens[k + 2]!;
      if (
        tokens[k]!.type !== "ident" ||
        !punct(k + 1, ".") ||
        method.type !== "ident" ||
        !OBJECT_METHODS.has(method.value) ||
        (!namesIpcText && !IPC_ONLY_METHODS.has(method.value)) ||
        !punct(k + 3, "(") ||
        punct(k - 1, ".") ||
        punct(k - 1, "?.") ||
        tokens[k]!.value === "this"
      )
        continue;
      const owner = aliases.get(k) ?? tokens[k]!.value;
      if (IPC_APIS.has(`${owner}.${method.value}`) || owner === "webContents") continue;
      // only a name some function around the call has as a parameter (a cheap test first)
      if (
        !(resolver ??= new ExpressionResolver(tokens, constants)).paramAround(k, tokens[k]!.value)
      )
        continue;
      let read = channelArg(tokens, constants, k + 4);
      // a channel the constants cannot say (a table of a module a bundler wrapped): read by the
      // bounded resolver, one whole value or none
      if (read === null && !punct(k + 4, ")")) {
        const found = resolver.resolveArgument(k + 4);
        if (found && !found.partial && found.values.length === 1)
          read = { value: found.values[0]!, via: "evaluated" };
      }
      const call: ObjectCall = {
        method: method.value,
        line: tokens[k]!.line,
        channel: read && "value" in read ? read.value : null,
      };
      if (read && "ref" in read) call.channelRef = read.ref;
      if (OBJECT_SENDS.has(method.value))
        call.args = (payloads ??= new PayloadReader(tokens, source)).shapeAt(k + 3);
      objects.push({ at: k, call });
    }
    if (!calls.length && !objects.length) return wrapperScan;
    const reader = new WrapperReader(
      tokens,
      (resolver ??= new ExpressionResolver(tokens, constants)),
      constants,
      null,
      "",
      (k) => {
        // as the scan reads a call: another name for one, or the name itself
        const name = aliases.get(k) ?? tokens[k]!.value;
        return name === "ipcMain" || name === "ipcRenderer" ? name : null;
      },
    );
    if (calls.length) reader.findClasses(calls);
    if (objects.length) reader.findObjectParams(objects);
    // A method of the file's own wrappers that the file replaces (`Svc.prototype.register = f`,
    // `w.handle = () => {}` on an instance): its calls give no row here, as across modules.
    const replaced = reader.readOwnReplacements();
    // a search cut short may have missed a call site that passes something else: no decision
    const objectsCut = objects.length >= MAX_OBJECT_CALLS;
    const read = objects.length ? reader.paramIpc() : [];
    const paramIpc = reader.objectsCapped || objectsCut ? [] : read;
    if (!reader.classes.length && !paramIpc.length) return wrapperScan;
    const rows = reader.rows();
    const replacedAt = [...new Set(replaced.map((x) => `${x.via}:${reader.lineOf(x.at)}`))];
    const facts = reader.facts();
    wrapperScan = {
      rows,
      inner: reader.inner,
      facts,
      calls: new Map(rows.map((r) => [r.at, { api: r.usage.api, arg: r.arg }])),
      // what the search for IPC object parameters could not read only leaves its own rows out
      ...(reader.capped ? { capped: true as const } : {}),
      ...(paramIpc.length ? { paramIpc } : {}),
      ...(replacedAt.length ? { replaced: replacedAt.slice(0, 20) } : {}),
    };
    return wrapperScan;
  };
  options.onTokens?.(tokens, truncated, {
    aliases,
    constants,
    wrappers,
    methodCalls: () => readWrappers().calls,
  });
  const references: ModuleReference[] = [];
  const ipc: IpcUsage[] = [];
  const exports = new Set<string>();
  let esm = false;
  let cjs = false;
  const at = (k: number): Token | undefined => tokens[k];
  const is = (k: number, type: Token["type"], value?: string): boolean => {
    const t = at(k);
    return !!t && t.type === type && (value === undefined || t.value === value);
  };
  const specifierAt = (k: number, kind: ModuleReference["kind"], line: number): void => {
    const t = at(k);
    if (!t) return;
    const value = literal(t);
    const isCall = kind === "require" || kind === "dynamic-import";
    const lone = !isCall || is(k + 1, "punct", ")") || is(k + 1, "punct", ",");
    if (value !== null && lone) references.push({ specifier: value, kind, line, dynamic: false });
    else
      references.push({
        specifier: t.type === "template" ? t.value : "<expression>",
        kind,
        line,
        dynamic: true,
      });
  };
  const findFrom = (k: number, kind: ModuleReference["kind"], line: number): void => {
    for (let j = k + 1; j < Math.min(tokens.length, k + 200); j++) {
      if (is(j, "ident", "from") && is(j + 1, "string")) {
        specifierAt(j + 1, kind, line);
        return;
      }
      if (is(j, "punct", ";")) return;
    }
  };

  /**
   * The keys of the object a loop variable runs over, when `name` is bound by
   * `Object.entries(T)`, `Object.keys(T)` or `in T` shortly before token k.
   */
  const tableKeys = (k: number, name: string): string[] => {
    for (let j = k - 1; j >= 4 && j > k - 40; j--) {
      // `[name, …] of Object.entries(T)`, `name of Object.keys(T)`: the key binding itself
      if (
        is(j, "ident", "Object") &&
        is(j + 1, "punct", ".") &&
        is(j + 3, "punct", "(") &&
        is(j + 4, "ident") &&
        is(j + 5, "punct", ")") &&
        is(j - 1, "ident", "of")
      ) {
        const entries = is(j + 2, "ident", "entries");
        const keys = is(j + 2, "ident", "keys");
        const bound = entries
          ? is(j - 2, "punct", "]")
            ? firstOfPattern(j - 2) === name
            : false
          : keys && is(j - 2, "ident", name);
        return bound ? constants.keysOf(at(j + 4)!.value, j + 4) : [];
      }
      // `name in T)`
      if (
        is(j, "ident", "in") &&
        is(j - 1, "ident", name) &&
        is(j + 1, "ident") &&
        is(j + 2, "punct", ")")
      )
        return constants.keysOf(at(j + 1)!.value, j + 1);
    }
    return [];
  };
  /**
   * For `for (const [name, …] of T)` shortly before token k: the first elements of the pairs of
   * the list T, resolved. Empty when T is no list of pairs declared in this file.
   */
  const pairList = (k: number, name: string): ReturnType<Constants["pairFirsts"]> => {
    for (let j = k - 1; j >= 4 && j > k - 40; j--)
      if (
        is(j, "ident") &&
        is(j + 1, "punct", ")") &&
        is(j - 1, "ident", "of") &&
        is(j - 2, "punct", "]") &&
        firstOfPattern(j - 2) === name
      )
        return constants.pairFirsts(at(j)!.value, j);
    return [];
  };
  /** The first name of the array pattern that closes at `close`: `[id, fn]` gives `id`. */
  const firstOfPattern = (close: number): string | null => {
    for (let j = close - 1; j >= 0 && j > close - 12; j--)
      if (is(j, "punct", "[")) return is(j + 1, "ident") ? at(j + 1)!.value : null;
    return null;
  };

  /**
   * Inside an `ipcMain.on(channel, (event, …) => { … })` listener, `event.reply("x")` and
   * `event.sender.send("x")` send on a channel. `open` is the call's opening parenthesis.
   */
  let replyBudget = 400_000;
  const replies = (open: number): void => {
    let d = 0;
    let end = open;
    for (; end < tokens.length && end < open + 20_000 && replyBudget-- > 0; end++) {
      const p = tokens[end]!;
      if (p.type !== "punct") continue;
      if (p.value === "(" || p.value === "{" || p.value === "[") d++;
      else if (p.value === ")" || p.value === "}" || p.value === "]") {
        d--;
        if (d === 0) break;
      }
    }
    // The listener's first parameter: after the first top-level comma of the call.
    let j = open + 1;
    for (let e = 0; j < end; j++) {
      const p = tokens[j]!;
      if (p.type !== "punct") continue;
      if (p.value === "(" || p.value === "{" || p.value === "[") e++;
      else if (p.value === ")" || p.value === "}" || p.value === "]") e--;
      else if (p.value === "," && e === 0) break;
    }
    j++;
    if (is(j, "ident", "async")) j++;
    if (is(j, "ident", "function")) {
      j++;
      if (is(j, "ident")) j++;
    }
    if (is(j, "punct", "(")) j++;
    const event = at(j);
    if (!event || event.type !== "ident") return;
    for (let m = j + 1; m + 4 < end && replyBudget-- > 0; m++) {
      if (!is(m, "ident", event.value) || !is(m + 1, "punct", ".")) continue;
      const direct = is(m + 2, "ident", "reply") && is(m + 3, "punct", "(");
      const viaSender =
        is(m + 2, "ident", "sender") &&
        is(m + 3, "punct", ".") &&
        is(m + 4, "ident", "send") &&
        is(m + 5, "punct", "(");
      if (!direct && !viaSender) continue;
      const named = channelAt(m + (direct ? 4 : 6));
      const api = direct ? "event.reply" : "event.sender.send";
      const args = payload.shapeAt(m + (direct ? 3 : 5));
      if (named && "value" in named)
        ipc.push({ api, channel: named.value, line: at(m)!.line, ...viaOf(named), args });
      // A channel named by another module's constant, looked up once that module is read.
      else if (named && "ref" in named)
        ipc.push({ api, channel: null, line: at(m)!.line, channelRef: named.ref, args });
    }
  };

  /**
   * The channel an argument names, only when the argument is that literal or name and nothing
   * more: `"win:" + id` is not the channel `win:`.
   */
  const channelAt = (k: number): ReturnType<Constants["resolve"]> => {
    if (at(k)?.type === "template") return constants.resolveArg(k);
    const named = constants.resolve(k);
    if (named === null) return null;
    let end = k + 1;
    while (is(end, "punct", ".") && is(end + 1, "ident")) end += 2;
    return is(end, "punct", ",") || is(end, "punct", ")") ? named : null;
  };
  /**
   * The rows of an IPC call that runs once per element of a list of routes (see
   * `ExpressionResolver.perElement`): `ranges` are the expressions to read per element, the
   * channel argument last. Cross-module names are read as references (`Channels.SAVE` of
   * `require("./channels")`), filled in once that module is read. Null when the loop or its list
   * is not read whole.
   */
  let routeResolver: ExpressionResolver | null = null;
  /** Calls read per element of a list so far in this file (see MAX_ROUTE_READS). */
  let routeReads = 0;
  const perRoute = (
    k: number,
    ranges: Array<[number, number]>,
  ): { rows: Array<Array<Val | null>>; line: number } | null => {
    if (routeReads >= MAX_ROUTE_READS) return null;
    routeReads++;
    routeResolver ??= new ExpressionResolver(tokens, constants, "", null, routeRef, false, true);
    return routeResolver.perElement(k, ranges);
  };
  /** `ipcMain[expr](channel, …)` at k, with `]` at close. */
  const computedCalls = (k: number, owner: string, close: number): IpcUsage[] => {
    const line = at(k)!.line;
    const unread: IpcUsage = { api: `${owner}.[unknown]`, channel: null, line };
    const arg = close + 2;
    resolver ??= new ExpressionResolver(tokens, constants);
    const argEnd = resolver.endOf(arg);
    if (argEnd <= arg) return [unread];
    // `ipcMain["handle"](…)`, or `ipcMain[M](…)` with `M = "handle"` a constant, outside a
    // loop: the method it names, read as `ipcMain.handle(…)` (esbuild's minifier writes the
    // literal form so).
    const key = at(k + 2);
    const keyName =
      close === k + 3
        ? key?.type === "string"
          ? key.value
          : key?.type === "ident"
            ? constants.stringOf(key.value, k + 2)
            : null
        : null;
    if (keyName !== null && IPC_APIS.has(`${owner}.${keyName}`) && !keyName.startsWith("expose")) {
      const api = `${owner}.${keyName}`;
      const named = channelAt(arg);
      const usage: IpcUsage = {
        api,
        channel: named && "value" in named ? named.value : null,
        line,
      };
      if (named && "ref" in named) usage.channelRef = named.ref;
      if (named && "value" in named && named.via !== "literal") Object.assign(usage, viaOf(named));
      else if (owner !== at(k)!.value) usage.via = "alias";
      if (SENDING_APIS.has(api)) usage.args = payload.shapeAt(close + 1);
      if (named === null) open.push({ usage, at: arg });
      if (api === "ipcMain.on" || api === "ipcMain.once") replies(close + 1);
      return [usage];
    }
    if (routeReads >= MAX_ROUTE_READS) {
      unread.reason = `more calls with a computed method than are read per file (${MAX_ROUTE_READS})`;
      return [unread];
    }
    const found = perRoute(k, [
      [k + 2, close],
      [arg, argEnd],
    ]);
    if (!found) {
      unread.reason =
        "the method and channel are read per element of a list, which is not read whole";
      return [unread];
    }
    const out: IpcUsage[] = [];
    for (const [method, channel] of found.rows) {
      const name = method?.kind === "str" && method.values.length === 1 ? method.values[0]! : null;
      const api =
        name !== null && IPC_APIS.has(`${owner}.${name}`) && !name.startsWith("expose")
          ? `${owner}.${name}`
          : `${owner}.[unknown]`;
      const read = routeChannel(channel);
      out.push(
        read.channel !== null || read.channelRef
          ? {
              api,
              ...read,
              line,
              via: "resolved",
              resolution: { method: "element", lines: [found.line] },
            }
          : { api, channel: null, line },
      );
    }
    return out;
  };
  /** IPC calls whose channel argument is neither a literal nor a constant: resolved below. */
  const open: Array<{ usage: IpcUsage; at: number }> = [];
  const payload = new PayloadReader(tokens, source);
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k]!;
    if (t.type !== "ident") continue;
    switch (t.value) {
      case "import":
        if (is(k + 1, "punct", "(")) specifierAt(k + 2, "dynamic-import", t.line);
        else if (is(k + 1, "punct", ".")) esm = true;
        else {
          esm = true;
          if (is(k + 1, "string")) specifierAt(k + 1, "import", t.line);
          else findFrom(k, "import", t.line);
        }
        break;
      case "export": {
        esm = true;
        if (is(k + 1, "punct", "{") || is(k + 1, "punct", "*")) findFrom(k, "export-from", t.line);
        const next = at(k + 1);
        if (next?.type === "ident" && EXPORT_DECLARATIONS.has(next.value)) {
          const name =
            next.value === "default"
              ? "default"
              : at(next.value === "async" ? k + 3 : k + 2)?.value;
          if (name && /^[\w$]+$/.test(name)) exports.add(name);
        }
        break;
      }
      case "require":
        if (is(k + 1, "punct", "(") && !is(k - 1, "punct", ".")) {
          cjs = true;
          specifierAt(k + 2, "require", t.line);
        }
        break;
      case "module":
        if (is(k + 1, "punct", ".") && is(k + 2, "ident", "exports")) {
          cjs = true;
          if (is(k + 3, "punct", ".") && is(k + 4, "ident") && is(k + 5, "punct", "=")) {
            exports.add(at(k + 4)!.value);
          }
        }
        break;
      case "exports":
        if (
          is(k + 1, "punct", ".") &&
          is(k + 2, "ident") &&
          is(k + 3, "punct", "=") &&
          !is(k - 1, "punct", ".")
        ) {
          cjs = true;
          exports.add(at(k + 2)!.value);
        }
        break;
      default:
        break;
    }
    if (
      is(k + 1, "punct", ".") &&
      is(k + 2, "ident") &&
      IPC_METHODS.has(at(k + 2)!.value) &&
      is(k + 3, "punct", "(")
    ) {
      let owner = aliases.get(k) ?? t.value;
      // `this.ipc.handle(…)` with the IPC object kept in a field of the class
      if (
        !IPC_APIS.has(`${owner}.${at(k + 2)!.value}`) &&
        is(k - 1, "punct", ".") &&
        is(k - 2, "ident", "this") &&
        namesIpc()
      )
        owner =
          (resolver ??= new ExpressionResolver(tokens, constants)).fieldOwner(
            k,
            aliases,
            FIELD_TARGETS,
          ) ?? owner;
      const api = `${owner}.${at(k + 2)!.value}`;
      if (IPC_APIS.has(api)) {
        const named = channelAt(k + 4);
        const usage: IpcUsage = {
          api,
          channel: named && "value" in named ? named.value : null,
          line: t.line,
        };
        if (named && "ref" in named) usage.channelRef = named.ref;
        if (named && "value" in named && named.via !== "literal")
          Object.assign(usage, viaOf(named));
        else if (owner !== t.value) usage.via = "alias";
        const shape = SENDING_APIS.has(api) ? { args: payload.shapeAt(k + 3) } : {};
        Object.assign(usage, shape);
        // `for (const [channel, fn] of Object.entries(handlers)) ipcMain.handle(channel, fn)`:
        // one registration per key of the table.
        const keys =
          named === null && is(k + 4, "ident") && is(k + 5, "punct", ",")
            ? tableKeys(k, at(k + 4)!.value)
            : [];
        const pairs =
          named === null && keys.length === 0 && is(k + 4, "ident") && is(k + 5, "punct", ",")
            ? pairList(k, at(k + 4)!.value)
            : [];
        if (keys.length)
          for (const channel of keys)
            ipc.push({ api, channel, line: t.line, via: "table", ...shape });
        else if (pairs.some((p) => p !== null)) {
          // One registration per pair; a pair whose name cannot be read stays a call without one.
          for (const p of pairs)
            if (p && "value" in p)
              ipc.push({ api, channel: p.value, line: t.line, via: "table", ...shape });
            else if (p && "ref" in p)
              ipc.push({
                api,
                channel: null,
                line: t.line,
                via: "table",
                channelRef: p.ref,
                ...shape,
              });
          if (pairs.includes(null)) ipc.push(usage);
        } else {
          ipc.push(usage);
          if (named === null) open.push({ usage, at: k + 4 });
        }
        if (api === "ipcMain.on" || api === "ipcMain.once") replies(k + 3);
      }
    }
    // `ipcMain[route.kind](route.channel, route.fn)` in a loop over a list of routes: one row per
    // element, the method its `kind` when that is a method of the object (else unknown).
    if (is(k + 1, "punct", "[") && namesIpc()) {
      const owner = aliases.get(k) ?? t.value;
      if ((owner === "ipcMain" || owner === "ipcRenderer") && !is(k - 1, "punct", ".")) {
        resolver ??= new ExpressionResolver(tokens, constants);
        const close = resolver.closeOf(k + 1);
        if (close > k + 2 && is(close + 1, "punct", "(") && !is(close + 2, "punct", ")")) {
          ipc.push(...computedCalls(k, owner, close));
        }
      }
    }
    // A call of one of the file's own channel-forwarding helpers: `route("rooms:list", fn)`.
    if (is(k + 1, "punct", "(") && !is(k - 1, "ident", "function")) {
      const helper = aliases.get(k);
      const api = helper === t.value ? wrappers.get(helper) : undefined;
      if (api) {
        const named = channelAt(k + 2);
        const usage: IpcUsage = {
          api,
          channel: named && "value" in named ? named.value : null,
          line: t.line,
          via: "wrapper",
        };
        if (named && "ref" in named) usage.channelRef = named.ref;
        // A call whose channel cannot be read is kept without one, so the limitation names it.
        ipc.push(usage);
      }
    }
  }

  // Calls of the file's wrapper methods: read at the call, the channel from its argument.
  const wrapped = readWrappers();
  if (wrapped.rows.length) {
    for (const row of wrapped.rows) {
      ipc.push(row.usage);
      if (row.unread) open.push({ usage: row.usage, at: row.arg });
    }
    ipc.sort((x, y) => x.line - y.line);
  }

  // The slow path, only for the calls the fast scan left open: a bounded expression resolver.
  if (open.length) {
    resolver ??= new ExpressionResolver(tokens, constants);
    for (const { usage, at: argument } of open.slice(0, 200)) {
      // Inside a channel-forwarding helper the calls of the helper carry the channels (`wrapper`
      // rows); the call inside it stays without a channel, as it may be called from elsewhere.
      const helper = resolver.enclosingName(argument);
      if (helper !== null && wrappers.has(helper)) continue;
      // likewise inside a wrapper method of a class or object
      if (wrapped.inner.has(argument)) continue;
      const found = resolver.resolveArgument(argument);
      // why the evaluation of the code that builds the channel stopped, when it says
      const why = found ? null : resolver.reason;
      if (!found || found.partial) {
        // `for (const r of ROUTES) ipcMain.handle(r.channel, r.fn)` with channels of another
        // module: one row per element, the names read as references
        const routed =
          !usage.wrapper && usage.via !== "wrapper"
            ? perRoute(argument, [[argument, resolver.endOf(argument)]])
            : null;
        const index = routed ? ipc.indexOf(usage) : -1;
        if (
          routed &&
          index !== -1 &&
          routed.rows.every(([c]) => {
            const read = routeChannel(c);
            return read.channel !== null || read.channelRef !== undefined;
          })
        ) {
          ipc.splice(
            index,
            1,
            ...routed.rows.map(([c]): IpcUsage => ({
              api: usage.api,
              ...routeChannel(c),
              line: usage.line,
              via: "resolved",
              resolution: { method: "element", lines: [routed.line] },
              ...(usage.args === undefined ? {} : { args: usage.args }),
            })),
          );
          continue;
        }
      }
      if (!found) {
        if (why) usage.reason = `evaluation stopped: ${why}`;
        continue;
      }
      const index = ipc.indexOf(usage);
      if (index === -1) continue;
      ipc.splice(
        index,
        // a partial result keeps the call without a channel as well, for the limitation
        found.partial ? 0 : 1,
        ...found.values.map((channel): IpcUsage => ({
          api: usage.api,
          channel,
          line: usage.line,
          // a call of a wrapper method stays one, with how its argument was read
          ...(usage.wrapper
            ? { via: "wrapper" as const, wrapper: usage.wrapper }
            : { via: "resolved" as const }),
          resolution: { method: found.method, lines: found.lines },
          // the same call, so the same payload
          ...(usage.args === undefined ? {} : { args: usage.args }),
        })),
      );
    }
  }
  const sourceMappingUrl =
    /\/\/[#@]\s*sourceMappingURL=(\S+)\s*$/.exec(source.slice(-2000))?.[1] ?? null;
  const lines = source.split("\n").length;
  return {
    references,
    ipc,
    exports: [...exports],
    moduleSystem: esm && cjs ? "mixed" : esm ? "esm" : cjs ? "cjs" : "none",
    sourceMappingUrl,
    lines,
    minified: source.length > 2000 && source.length / lines > 500,
    truncated,
    ...(Object.keys(constants.exported).length ? { constants: constants.exported } : {}),
    ...(Object.keys(constants.reexported).length ? { reexports: constants.reexported } : {}),
    ...(() => {
      // `module.exports = require("./x")`: a star export only where it is certain (aliases.ts)
      const whole = constants.wholeReexports();
      const stars = [...constants.starExports];
      if (whole.strict !== null && !stars.includes(whole.strict)) stars.push(whole.strict);
      return {
        ...(stars.length ? { starExports: stars } : {}),
        ...(whole.loose.length ? { looseStarExports: whole.loose } : {}),
      };
    })(),
    ...(constants.evaluated.length ? { evaluated: constants.evaluated } : {}),
    ...(Object.keys(constants.unevaluated).length ? { unevaluated: constants.unevaluated } : {}),
    ...(wrapped.facts ? { wrappers: wrapped.facts } : {}),
    ...(wrapped.capped ? { wrappersCapped: true as const } : {}),
    ...(wrapped.paramIpc ? { paramIpc: wrapped.paramIpc } : {}),
    ...(wrapped.replaced ? { wrappersReplaced: wrapped.replaced } : {}),
  };
}

/** How a route table's cross-module name is written while the scan reads it (see `routeChannel`). */
const routeRef = (specifier: string, property: string): string =>
  `\u0001${specifier}\u0002${property}\u0001`;
const ROUTE_REF =
  // oxlint-disable-next-line no-control-regex -- the markers are control characters on purpose
  /^([^\u0001]*)\u0001([^\u0001\u0002]*)\u0002([^\u0001\u0002]*)\u0001([^\u0001]*)$/;

/**
 * The channel of one element of a route table: a whole string, or a reference to another
 * module's constant (with what is written before and after it); otherwise none (unresolved).
 */
function routeChannel(v: Val | null | undefined): Pick<IpcUsage, "channel" | "channelRef"> {
  if (v?.kind !== "str" || v.values.length !== 1) return { channel: null };
  const text = v.values[0]!;
  if (text.includes("${…}") || text === "") return { channel: null };
  if (!text.includes("\u0001")) return { channel: text };
  const m = ROUTE_REF.exec(text);
  if (!m) return { channel: null };
  const [, before, specifier, property, after] = m;
  return {
    channel: null,
    channelRef: {
      specifier: specifier!,
      property: property!,
      ...(before ? { before } : {}),
      ...(after ? { after } : {}),
    },
  };
}

/** `via` and `resolution` of an IPC row whose channel was read by name. */
function viaOf(
  named: Extract<NonNullable<Resolved>, { value: string }>,
): Pick<IpcUsage, "via" | "resolution"> {
  if (named.via === "evaluated")
    return {
      via: "resolved",
      resolution: { method: "evaluated", lines: named.line === undefined ? [] : [named.line] },
    };
  return named.via === "constant" ? { via: "constant" } : {};
}

/**
 * The evaluator that lets a file's constants read declarations only an evaluation can
 * (`const BOARD = defineChannels(…)`), through the file's one resolver, created on first use.
 */
export function evaluatorFor(
  tokens: Token[],
  constants: Constants,
  get: () => ExpressionResolver | null,
  set: (r: ExpressionResolver) => void,
): Evaluator {
  const resolver = (): ExpressionResolver => {
    const have = get();
    if (have) return have;
    const made = new ExpressionResolver(tokens, constants);
    set(made);
    return made;
  };
  return {
    name: (name, at) => {
      const r = resolver();
      const value = r.topValue(name, at);
      return { value, reason: r.reason };
    },
    at: (at) => {
      const r = resolver();
      const value = r.valueAt(at);
      return { value, reason: r.reason };
    },
  };
}
