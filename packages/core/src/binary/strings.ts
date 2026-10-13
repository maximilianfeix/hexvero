import { latin1 } from "./reader.js";

export interface ExtractedString {
  offset: number;
  encoding: "ascii" | "utf16le";
  /** The run's text, cut to `maxLength` characters when `length` is present. */
  value: string;
  /** Full length in characters when the value was cut. */
  length?: number;
}

export interface StringsOptions {
  minLength?: number;
  /** Stop after this many strings to bound memory on huge inputs. */
  max?: number;
  /** Longest value kept per string (default 4096); longer runs report their full `length`. */
  maxLength?: number;
  utf16?: boolean;
}

const isPrintable = (b: number): boolean => (b >= 0x20 && b <= 0x7e) || b === 0x09;

/** Printable ASCII runs, plus optional UTF-16LE runs, like `strings -a`. */
export function extractStrings(bytes: Uint8Array, options: StringsOptions = {}): ExtractedString[] {
  const minLength = options.minLength ?? 4;
  const max = options.max ?? 50_000;
  // One minified bundle without newlines is a single multi-megabyte "string"; keep a prefix and
  // report the real length so pages stay within their byte budget.
  const maxLength = options.maxLength ?? 4096;
  const out: ExtractedString[] = [];

  let start = -1;
  for (let i = 0; i <= bytes.length; i++) {
    const printable = i < bytes.length && isPrintable(bytes[i]!);
    if (printable) {
      if (start === -1) start = i;
      continue;
    }
    if (start !== -1 && i - start >= minLength) {
      const length = i - start;
      const item: ExtractedString = {
        offset: start,
        encoding: "ascii",
        value: latin1(bytes.subarray(start, Math.min(i, start + maxLength))),
      };
      if (length > maxLength) item.length = length;
      out.push(item);
      if (out.length >= max) return out;
    }
    start = -1;
  }

  if (options.utf16) {
    for (const parity of [0, 1]) scanUtf16(bytes, parity, minLength, max, out, maxLength);
  }
  return out;
}

function scanUtf16(
  bytes: Uint8Array,
  parity: number,
  minLength: number,
  max: number,
  out: ExtractedString[],
  maxLength: number,
): void {
  let begin = -1;
  const flush = (end: number): void => {
    if (begin === -1 || (end - begin) / 2 < minLength) return;
    let value = "";
    const chars = (end - begin) >> 1;
    for (let j = begin; j < Math.min(end, begin + maxLength * 2); j += 2)
      value += String.fromCharCode(bytes[j]!);
    const item: ExtractedString = { offset: begin, encoding: "utf16le", value };
    if (chars > maxLength) item.length = chars;
    out.push(item);
  };
  for (let i = parity; i + 1 < bytes.length && out.length < max; i += 2) {
    if (isPrintable(bytes[i]!) && bytes[i + 1] === 0) {
      if (begin === -1) begin = i;
      continue;
    }
    flush(i);
    begin = -1;
  }
  if (out.length < max) flush(bytes.length - ((bytes.length - parity) % 2));
}

/** Heuristic buckets that make a strings dump useful at a glance. */
export function classifyString(value: string): string[] {
  const tags: string[] = [];
  if (/^https?:\/\//i.test(value)) tags.push("url");
  if (
    /^[A-Za-z]:\\|^\/(usr|etc|var|home|Users|tmp|lib|lib64|opt|bin|sbin|System|Library|Applications|private|dev|proc|sys)\//.test(
      value,
    )
  ) {
    tags.push("path");
  }
  if (/^[\w.-]+@[\w.-]+\.\w+$/.test(value)) tags.push("email");
  if (/^(\d{1,3}\.){3}\d{1,3}(:\d+)?$/.test(value)) tags.push("ip");
  if (/%[sdxpu]/.test(value)) tags.push("format");
  if (/\b(password|secret|token|api[_-]?key|bearer)\b/i.test(value)) tags.push("secret-ish");
  if (/^[A-Za-z0-9+/]{32,}={0,2}$/.test(value)) tags.push("base64-ish");
  return tags;
}
