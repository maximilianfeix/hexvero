/**
 * Lightweight Swift symbol reader. It does not implement the full Swift
 * demangler; it recovers the identifier path (module, types, member) and the
 * entity kind from a mangled name so that agents and humans can read symbol
 * lists without `swift-demangle`. Results are marked approximate.
 */
export interface SwiftSymbol {
  mangled: string;
  readable: string;
  /** Nominal types between module and member; parameter labels are kept apart from the path. */
  labels: string[];
  kind:
    | "function"
    | "variable"
    | "class"
    | "struct"
    | "enum"
    | "protocol"
    | "initializer"
    | "getter"
    | "setter"
    | "metadata"
    | "other";
  approximate: true;
  module: string;
}

const KIND_SUFFIX: Array<[RegExp, SwiftSymbol["kind"]]> = [
  [/fC$/, "initializer"],
  [/vg$/, "getter"],
  [/vs$/, "setter"],
  [/vp$|v$/, "variable"],
  [/F$|Tf$|Tj$|Tq$|TR$/, "function"],
  [/M[acnfLXVSIsy]$/, "metadata"],
  [/C(Ma|Mn|Mf|Mm|MX)?$/, "class"],
  [/V(Ma|Mn)?$/, "struct"],
  [/O(Ma|Mn)?$/, "enum"],
  [/P(Mp|Tl)?$/, "protocol"],
];

/** `_TtC7Module5Name` (Objective-C visible Swift class names) → `Module.Name`; null when not that shape. */
export function demangleSwiftClassName(name: string): string | null {
  const m = /^_Tt([CVOP]+)(\d[0-9A-Za-z_]*)$/.exec(name);
  if (!m) return null;
  const parts: string[] = [];
  let s = m[2]!;
  let guard = 0;
  while (s.length && guard++ < 32) {
    if (/^[CVOP]\d/.test(s)) {
      s = s.slice(1);
      continue;
    }
    const n = /^(\d+)/.exec(s);
    if (!n) break;
    const len = Number(n[1]);
    const word = s.slice(n[0].length, n[0].length + len);
    if (!len || word.length < len) break;
    parts.push(/^_[0-9A-F]{32}$/.test(word) ? "(private)" : word);
    s = s.slice(n[0].length + len);
  }
  return parts.length && s.length === 0 ? parts.join(".") : null;
}

export function isSwiftSymbol(name: string): boolean {
  return /^_?\$[sS]|^_?\$S|^__?T0|^_?\$e/.test(name);
}

/** Extracts length-prefixed identifiers; handles the `0` escape for punycode-free words and word substitutions (`A`-`Z`) loosely. */
export function demangleSwift(mangled: string): SwiftSymbol | null {
  if (!isSwiftSymbol(mangled)) return null;
  let s = mangled.replace(/^_?\$[sSe]|^__?T0/, "");
  const NOMINAL: Record<string, SwiftSymbol["kind"]> = {
    C: "class",
    V: "struct",
    O: "enum",
    P: "protocol",
  };
  const path: string[] = [];
  const labels: string[] = [];
  let member: string | null = null;
  let nominalKind: SwiftSymbol["kind"] | null = null;
  let pending: string | null = null;
  let guard = 0;
  while (s.length && guard++ < 64) {
    const m = /^(\d+)/.exec(s);
    if (!m) {
      const marker = s[0]!;
      if (NOMINAL[marker] && pending !== null) {
        // the identifier before a nominal marker is a type on the path
        path.push(pending);
        pending = null;
        nominalKind = NOMINAL[marker]!;
        s = s.slice(1);
        continue;
      }
      break;
    }
    const len = Number(m[1]);
    const text = s.slice(m[0].length, m[0].length + len);
    if (len === 0 || text.length < len) break;
    s = s.slice(m[0].length + len);
    if (/^_[0-9A-F]{32}$/.test(text)) continue; // private discriminator
    if (pending !== null) {
      // two identifiers in a row without a marker: the first is the member (or module), later ones are labels
      if (member === null && path.length === 0) path.push(pending);
      else if (member === null) member = pending;
      else labels.push(pending);
    }
    pending = text;
  }
  if (pending !== null) {
    if (member === null) member = pending;
    else labels.push(pending);
  }
  if (path.length === 0 && member !== null) {
    // only one identifier: it is the module when a type marker followed, otherwise an entity in an unknown module
    path.push(member);
    member = null;
  }
  if (path.length === 0) return null;
  const rest = s;
  let kind: SwiftSymbol["kind"] = "other";
  for (const [re, k] of KIND_SUFFIX) {
    if (re.test(rest)) {
      kind = k;
      break;
    }
  }
  if (kind === "other" && nominalKind && rest.length <= 2) kind = nominalKind;
  if (kind === "other" && /F|Tf|Tj|Tq|TR|yyF|SgF|tF/.test(rest)) kind = "function";
  const isCall = kind === "function" || kind === "initializer";
  const readable =
    [...path, ...(member ? [member] : [])].join(".") +
    (isCall ? `(${labels.length ? `${labels.join(":")}:` : "…"})` : "");
  return { mangled, readable, labels, kind, approximate: true, module: path[0]! };
}
