/**
 * The payload shape of an IPC call: what the arguments after the channel look like as written,
 * read from the tokens of the call and never run. Only what the text says for certain is kept:
 *
 * - `(` … `)` with one entry per argument after the channel, separated by `, `;
 * - an object literal argument is `{a, b}`: its property names, sorted, shorthand (`{ a }`),
 *   `key: value` and method (`a() {}`) alike; a name that is not a plain identifier is quoted;
 *   when a `...spread` or a computed key (`[k]: v`) leaves names unknown, the list ends in `…`;
 * - a `...spread` argument is `...`: the number of arguments at run time is then not known;
 * - any other argument is `_`: a value, not described further.
 *
 * `(_, ...)` is a call with one value and a spread after the channel. When the call's brackets
 * cannot be matched (a file read only in part) the shape is `not read`.
 *
 * Linear time: brackets are matched once per file, and each call or object literal walks only
 * its own top-level tokens, jumping over nested brackets.
 */

import type { Token } from "./scan.js";

/** The shape written when the call's arguments cannot be read. */
export const NOT_READ = "not read";
/** At most this many arguments and property names per object are written out. */
const MAX_ARGS = 32;
const MAX_KEYS = 64;
/** A name written without quotes: an identifier, or an integer key. */
const PLAIN = /^(?:[A-Za-z_$][\w$]*|0|[1-9]\d*)$/;

const isPunct = (t: Token | undefined, value: string): boolean =>
  !!t && t.type === "punct" && t.value === value;

export class PayloadReader {
  private match: Int32Array | null = null;

  constructor(private readonly tokens: readonly Token[]) {}

  private matches(): Int32Array {
    if (this.match) return this.match;
    const match = new Int32Array(this.tokens.length).fill(-1);
    const open: number[] = [];
    for (let j = 0; j < this.tokens.length; j++) {
      const p = this.tokens[j]!;
      if (p.type !== "punct") continue;
      if (p.value === "{" || p.value === "(" || p.value === "[") open.push(j);
      else if (p.value === "}" || p.value === ")" || p.value === "]") {
        const at = open.pop();
        if (at !== undefined) match[at] = j;
      }
    }
    this.match = match;
    return match;
  }

  /**
   * The top-level parts of the bracket that opens at `open`, as [start, end) token ranges split
   * at its commas; null when the bracket is not closed. A trailing comma adds no part.
   */
  private parts(open: number): Array<[number, number]> | null {
    const match = this.matches();
    const close = match[open] ?? -1;
    if (close === -1) return null;
    const out: Array<[number, number]> = [];
    let start = open + 1;
    for (let j = open + 1; j < close; j++) {
      const t = this.tokens[j]!;
      if (t.type !== "punct") continue;
      if (t.value === "{" || t.value === "(" || t.value === "[") {
        const end = match[j] ?? -1;
        if (end === -1 || end > close) return null;
        j = end;
      } else if (t.value === ",") {
        out.push([start, j]);
        start = j + 1;
      }
    }
    if (start < close) out.push([start, close]);
    return out;
  }

  /** The shape of the call whose `(` is at `open`, the channel being its first argument. */
  shapeAt(open: number): string {
    if (!isPunct(this.tokens[open], "(")) return NOT_READ;
    const parts = this.parts(open);
    if (parts === null || parts.length === 0) return NOT_READ;
    const rest = parts.slice(1);
    const written = rest.slice(0, MAX_ARGS).map(([s, e]) => this.argument(s, e));
    if (written.includes(null)) return NOT_READ;
    if (rest.length > MAX_ARGS) written.push(`… +${rest.length - MAX_ARGS} more`);
    return `(${written.join(", ")})`;
  }

  private argument(start: number, end: number): string | null {
    if (isPunct(this.tokens[start], "...")) return "...";
    // exactly an object literal: `{` … `}` and nothing after it
    if (isPunct(this.tokens[start], "{") && this.matches()[start] === end - 1)
      return this.object(start);
    return "_";
  }

  private object(open: number): string | null {
    const parts = this.parts(open);
    if (parts === null) return null;
    const keys = new Set<string>();
    let unknown = false;
    for (const [s, e] of parts) {
      const name = this.entryName(s, e);
      if (name === null) unknown = true;
      else keys.add(name);
    }
    const sorted = [...keys].toSorted();
    const shown = sorted.slice(0, MAX_KEYS).map((k) => (PLAIN.test(k) ? k : JSON.stringify(k)));
    if (sorted.length > MAX_KEYS) shown.push(`… +${sorted.length - MAX_KEYS} more`);
    if (unknown) shown.push("…");
    return `{${shown.join(", ")}}`;
  }

  /** The property name an object entry defines, or null when the text does not say it. */
  private entryName(start: number, end: number): string | null {
    const { tokens } = this;
    let k = start;
    // `async`, `get`, `set` and `*` before a method's name; alone they are names themselves
    while (
      k + 1 < end &&
      ((tokens[k]!.type === "ident" && /^(async|get|set)$/.test(tokens[k]!.value)) ||
        isPunct(tokens[k], "*")) &&
      !isPunct(tokens[k + 1], ",") &&
      !isPunct(tokens[k + 1], ":") &&
      !isPunct(tokens[k + 1], "(")
    )
      k++;
    const t = tokens[k];
    if (!t) return null;
    let name: string;
    if (t.type === "ident") name = t.value;
    else if (t.type === "string") name = t.value;
    else if (t.type === "number" && /^(0|[1-9]\d*)$/.test(t.value)) name = t.value;
    // a spread, a computed key, a number written otherwise: the name is not in the text
    else return null;
    const next = k + 1;
    // shorthand `{ a }` (only an identifier can be one)
    if (next === end) return t.type === "ident" && k === start ? name : null;
    if (isPunct(tokens[next], ":")) return name === "__proto__" ? null : name;
    // a method `a() {}`
    if (isPunct(tokens[next], "(")) return name;
    return null;
  }
}
