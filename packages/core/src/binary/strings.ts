import { latin1 } from "./reader.js";

export interface ExtractedString {
  offset: number;
  encoding: "ascii" | "utf16le";
  value: string;
}

export interface StringsOptions {
  minLength?: number;
  /** Stop after this many strings to bound memory on huge inputs. */
  max?: number;
  utf16?: boolean;
}

const isPrintable = (b: number): boolean => (b >= 0x20 && b <= 0x7e) || b === 0x09;

/** Printable ASCII runs, plus optional UTF-16LE runs, like `strings -a`. */
export function extractStrings(bytes: Uint8Array, options: StringsOptions = {}): ExtractedString[] {
  const minLength = options.minLength ?? 4;
  const max = options.max ?? 50_000;
  const out: ExtractedString[] = [];

  let start = -1;
  for (let i = 0; i <= bytes.length; i++) {
    const printable = i < bytes.length && isPrintable(bytes[i]!);
    if (printable) {
      if (start === -1) start = i;
      continue;
    }
    if (start !== -1 && i - start >= minLength) {
      out.push({
        offset: start,
        encoding: "ascii",
        value: latin1(bytes.subarray(start, i)),
      });
      if (out.length >= max) return out;
    }
    start = -1;
  }

  if (options.utf16) {
    for (const parity of [0, 1]) scanUtf16(bytes, parity, minLength, max, out);
  }
  return out;
}

function scanUtf16(
  bytes: Uint8Array,
  parity: number,
  minLength: number,
  max: number,
  out: ExtractedString[],
): void {
  let begin = -1;
  const flush = (end: number): void => {
    if (begin === -1 || (end - begin) / 2 < minLength) return;
    let value = "";
    for (let j = begin; j < end; j += 2) value += String.fromCharCode(bytes[j]!);
    out.push({ offset: begin, encoding: "utf16le", value });
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
