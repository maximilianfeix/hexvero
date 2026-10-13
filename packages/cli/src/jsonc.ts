/**
 * Minimal JSONC support for editing agent-client settings that carry comments or trailing commas
 * (Zed, VS Code, OpenCode, …). Nothing is reformatted: one entry is inserted as text at the start
 * of the target object and every comment stays where it was.
 */

/** Removes `//` and block comments and trailing commas outside strings, keeping all offsets' order. */
export function stripJsonc(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '"') {
      const end = stringEnd(text, i);
      out += text.slice(i, end);
      i = end;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      i = close === -1 ? text.length : close + 2;
    } else {
      out += c;
      i++;
    }
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

/** Index just past the string literal that opens at `start`. */
function stringEnd(text: string, start: number): number {
  let i = start + 1;
  while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
  return Math.min(text.length, i + 1);
}

/** Skips whitespace and comments from `i`. */
function skipTrivia(text: string, i: number): number {
  for (;;) {
    while (i < text.length && /\s/.test(text[i]!)) i++;
    if (text[i] === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (text[i] === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      i = close === -1 ? text.length : close + 2;
    } else return i;
  }
}

/** Index past the JSON value that starts at `i` (object, array, string or scalar). */
function valueEnd(text: string, i: number): number {
  if (text[i] === '"') return stringEnd(text, i);
  if (text[i] === "{" || text[i] === "[") {
    let depth = 0;
    while (i < text.length) {
      const c = text[i]!;
      if (c === '"') {
        i = stringEnd(text, i);
        continue;
      }
      if (c === "/" && (text[i + 1] === "/" || text[i + 1] === "*")) {
        i = skipTrivia(text, i);
        continue;
      }
      if (c === "{" || c === "[") depth++;
      if (c === "}" || c === "]") {
        depth--;
        if (depth === 0) return i + 1;
      }
      i++;
    }
    return text.length;
  }
  while (i < text.length && !/[,}\]\s]/.test(text[i]!)) i++;
  return i;
}

/** Offset of the `{` that opens the value of `key` inside the object opening at `open`, or -1. */
function memberObject(text: string, open: number, key: string): number | "not-object" | -1 {
  let i = skipTrivia(text, open + 1);
  while (i < text.length && text[i] !== "}") {
    if (text[i] !== '"') return -1;
    const nameEnd = stringEnd(text, i);
    let name: unknown;
    try {
      name = JSON.parse(text.slice(i, nameEnd));
    } catch {
      return -1;
    }
    i = skipTrivia(text, nameEnd);
    if (text[i] !== ":") return -1;
    i = skipTrivia(text, i + 1);
    if (name === key) return text[i] === "{" ? i : "not-object";
    i = skipTrivia(text, valueEnd(text, i));
    if (text[i] === ",") i = skipTrivia(text, i + 1);
  }
  return -1;
}

export type JsoncEdit =
  | { ok: true; content: string }
  | {
      ok: false;
      reason: "not-an-object" | "container-not-object" | "already-present" | "unparsable";
    };

/**
 * Inserts `"name": entry` into the object at `path` of a JSONC document, creating missing
 * containers, without touching anything else. Refuses when the entry exists already.
 */
export function insertJsonc(text: string, path: string[], name: string, entry: unknown): JsoncEdit {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonc(text));
  } catch {
    return { ok: false, reason: "unparsable" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return { ok: false, reason: "not-an-object" };
  let open = skipTrivia(text, 0);
  if (text[open] !== "{") return { ok: false, reason: "not-an-object" };
  let depth = 1;
  let remaining = [...path];
  while (remaining.length) {
    const next = memberObject(text, open, remaining[0]!);
    if (next === "not-object") return { ok: false, reason: "container-not-object" };
    if (next === -1) break;
    open = next;
    depth++;
    remaining = remaining.slice(1);
  }
  if (remaining.length === 0 && memberObject(text, open, name) !== -1)
    return { ok: false, reason: "already-present" };
  // Build the text to insert: the entry, wrapped in whatever containers are missing.
  let value: unknown = entry;
  let key = name;
  for (const container of remaining.toReversed()) {
    value = { [key]: value };
    key = container;
  }
  const pad = "  ".repeat(depth);
  const body = JSON.stringify(value, null, 2).replace(/\n/g, `\n${pad}`);
  const after = skipTrivia(text, open + 1);
  const empty = text[after] === "}";
  const insertion = `\n${pad}${JSON.stringify(key)}: ${body}${empty ? `\n${"  ".repeat(depth - 1)}` : ","}`;
  const content = `${text.slice(0, open + 1)}${insertion}${empty ? text.slice(after) : text.slice(open + 1)}`;
  try {
    JSON.parse(stripJsonc(content));
  } catch {
    return { ok: false, reason: "unparsable" };
  }
  return { ok: true, content };
}
