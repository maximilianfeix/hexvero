/**
 * Dependency-free JavaScript scanner. It tokenizes enough of the language to
 * skip strings, template literals, comments and regular expressions, then
 * reports module references and Electron IPC usage with line numbers. It is a
 * lexer, not a parser: dynamic specifiers and computed channels are reported
 * as `dynamic` so that callers never mistake a guess for a fact.
 */

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
}

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

export function scanJavaScript(source: string, options: { maxTokens?: number } = {}): ScanResult {
  const { tokens, truncated } = tokenize(source, options.maxTokens);
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
      const api = `${t.value}.${at(k + 2)!.value}`;
      if (IPC_APIS.has(api)) ipc.push({ api, channel: literal(at(k + 4)), line: t.line });
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
  };
}
