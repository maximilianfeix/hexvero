/**
 * Dependency-free JavaScript scanner. It tokenizes enough of the language to
 * skip strings, template literals, comments and regular expressions, then
 * reports module references and Electron IPC usage with line numbers. It is a
 * lexer, not a parser: dynamic specifiers and computed channels are reported
 * as `dynamic` so that callers never mistake a guess for a fact.
 */

import { Constants, resolveAliases } from "./aliases.js";

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
   * (`webContents.ipc.on`).
   */
  via?: "alias" | "constant" | "wrapper" | "table" | "global" | "webContents";
  /** A channel named by a constant of another module, to be looked up there. */
  channelRef?: { specifier: string; property: string };
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
}

/** What a second reader of the same token stream needs to follow names. */
export interface ScanContext {
  aliases: Map<number, string>;
  constants: Constants;
  /** Helper functions of the file that pass their first argument on as an IPC channel. */
  wrappers: Map<string, string>;
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
  /** End of the function body that starts at `k` (a brace block, or an expression). */
  // All function bodies together may cost this many token visits; unclosed bodies would
  // otherwise each be walked to their limit.
  let budget = 400_000;
  const bodyEnd = (k: number): number => {
    let d = 0;
    const block = is(k, "punct", "{");
    for (let j = k; j < tokens.length && j < k + 4000 && budget-- > 0; j++) {
      const p = tokens[j]!;
      if (p.type !== "punct") continue;
      if (p.value === "{" || p.value === "(" || p.value === "[") d++;
      else if (p.value === "}" || p.value === ")" || p.value === "]") {
        d--;
        if (d < 0 || (block && d === 0)) return j;
      } else if (!block && d === 0 && (p.value === ";" || p.value === ",")) return j;
    }
    return Math.min(tokens.length, k + 4000);
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
const IPC_APIS = new Set([
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
const IPC_METHODS = new Set([...IPC_APIS].map((api) => api.split(".")[1]!));
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
const isIdentStart = (c: string): boolean => /[A-Za-z_$À-￿]/.test(c);
const isIdentPart = (c: string): boolean => /[\w$À-￿]/.test(c);

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
      while (j < n && source[j] !== c && source[j] !== "\n") {
        if (source[j] === "\\") {
          value += source[j + 1] ?? "";
          j += 2;
          continue;
        }
        value += source[j];
        j++;
      }
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
          value += source[j + 1] ?? "";
          j += 2;
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
    const three = source.slice(i, i + 3);
    const two = source.slice(i, i + 2);
    const punct = PUNCT3.has(three) ? three : PUNCT2.has(two) ? two : c;
    tokens.push({ type: "punct", value: punct, line, start: i, end: i + punct.length });
    i += punct.length;
  }
  return { tokens, truncated: i < n };
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
  // Most files of a large application name none of the objects whose other names are followed
  // (icons, locale tables, vendored libraries). For those the resolution is skipped: nothing
  // would use it, and it is the most expensive step of a scan.
  let aliases = new Map<number, string>();
  let wrappers = new Map<string, string>();
  if (NAMES_SOMETHING.test(source)) {
    const own = new Set(constants.names());
    aliases = resolveAliases(tokens, ALIAS_TARGETS, own);
    if (/ipc|webContents/.test(source)) wrappers = findWrappers(tokens, aliases);
    if (wrappers.size) {
      for (const name of wrappers.keys()) own.add(name);
      aliases = resolveAliases(tokens, ALIAS_TARGETS, own);
    }
    constants.visible = aliases;
  }
  options.onTokens?.(tokens, truncated, { aliases, constants, wrappers });
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
      const named = constants.resolve(m + (direct ? 4 : 6));
      if (named && "value" in named)
        ipc.push({
          api: direct ? "event.reply" : "event.sender.send",
          channel: named.value,
          line: at(m)!.line,
        });
    }
  };

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
    if (is(k + 1, "punct", ".") && is(k + 2, "ident") && is(k + 3, "punct", "(")) {
      const owner = aliases.get(k) ?? t.value;
      const api = `${owner}.${at(k + 2)!.value}`;
      if (IPC_APIS.has(api)) {
        const named = constants.resolve(k + 4);
        const usage: IpcUsage = {
          api,
          channel: named && "value" in named ? named.value : null,
          line: t.line,
        };
        if (named && "ref" in named) usage.channelRef = named.ref;
        if (named && "value" in named && named.via === "constant") usage.via = "constant";
        else if (owner !== t.value) usage.via = "alias";
        // `for (const [channel, fn] of Object.entries(handlers)) ipcMain.handle(channel, fn)`:
        // one registration per key of the table.
        const keys =
          named === null && is(k + 4, "ident") && is(k + 5, "punct", ",")
            ? tableKeys(k, at(k + 4)!.value)
            : [];
        if (keys.length)
          for (const channel of keys) ipc.push({ api, channel, line: t.line, via: "table" });
        else ipc.push(usage);
        if (api === "ipcMain.on" || api === "ipcMain.once") replies(k + 3);
      }
    }
    // A call of one of the file's own channel-forwarding helpers: `route("rooms:list", fn)`.
    if (is(k + 1, "punct", "(") && !is(k - 1, "ident", "function")) {
      const helper = aliases.get(k);
      const api = helper === t.value ? wrappers.get(helper) : undefined;
      if (api) {
        const named = constants.resolve(k + 2);
        const usage: IpcUsage = {
          api,
          channel: named && "value" in named ? named.value : null,
          line: t.line,
          via: "wrapper",
        };
        if (named && "ref" in named) usage.channelRef = named.ref;
        if (usage.channel !== null || usage.channelRef) ipc.push(usage);
      }
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
  };
}
