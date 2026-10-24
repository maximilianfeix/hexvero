import { randomBytes } from "node:crypto";
import type { Finding, Limitation } from "@hexvero/core";

export interface Io {
  out(text: string): void;
  err(text: string): void;
  color: boolean;
  /** How the user started hexvero, for the commands it suggests (`npx hexvero` under npx). */
  invocation?: string;
  /**
   * One status line that replaces itself (progress of a long analysis); null clears it. Only set
   * when stderr is a terminal, so pipes, CI logs and tests never see it.
   */
  status?: (line: string | null) => void;
}

/** The terminal's streams: color only on a TTY without NO_COLOR, a status line only on a TTY. */
export function defaultIo(): Io {
  const io: Io = {
    out: (text) => process.stdout.write(`${terminalSafe(text)}\n`),
    err: (text) => process.stderr.write(`${terminalSafe(text)}\n`),
    color: Boolean(process.stdout.isTTY) && !process.env["NO_COLOR"],
    invocation: invocationFrom(process.env),
  };
  if (process.stderr.isTTY) {
    let shown = false;
    io.status = (line) => {
      // \r and "erase line" are hexvero's own; the line itself is built from numbers and words
      if (line === null) {
        if (shown) process.stderr.write("\r\u001b[2K");
        shown = false;
        return;
      }
      const width = Math.max(20, (process.stderr.columns || 80) - 1);
      process.stderr.write(`\r\u001b[2K${terminalSafe(line).slice(0, width)}`);
      shown = true;
    };
  }
  return io;
}

/** A command to suggest, written the way this process was started. */
export function suggest(io: Io, rest: string): string {
  return `${io.invocation ?? "hexvero"} ${rest}`;
}

/** `npx hexvero` when npm started this process for npx or `npm exec`, else `hexvero`. */
export function invocationFrom(env: NodeJS.ProcessEnv): string {
  return env["npm_command"] === "exec" ? "npx hexvero" : "hexvero";
}

const codes = {
  reset: "\u001b[0m",
  dim: "\u001b[2m",
  bold: "\u001b[1m",
  red: "\u001b[31m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  cyan: "\u001b[36m",
  magenta: "\u001b[35m",
};
type Color = keyof typeof codes;

/**
 * paint() marks the codes it writes with a token made for this process, which text from a target
 * cannot contain by chance or design; terminalSafe() keeps marked codes as color and escapes any
 * other control character, including a color code that came from a target.
 */
const TOKEN = `\u0000${randomBytes(8).toString("hex")}`;

export function paint(io: Io, color: Color, text: string): string {
  return io.color ? `${TOKEN}${codes[color]}${text}${TOKEN}${codes.reset}` : text;
}

/**
 * Characters that change what a terminal shows without being seen: bidi marks, embeddings,
 * overrides and isolates, zero-width characters and the BOM (the set the Markdown and HTML
 * reports show as escapes too).
 */
const HIDDEN = "\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff";
// eslint-disable-next-line no-control-regex
const ANY_CONTROL = new RegExp(`[\u0000-\u001f\u007f-\u009f${HIDDEN}]`, "g");
const escapeChar = (c: string): string => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`;

/**
 * Text that did not come from hexvero itself (a key, a file name, an error naming an archive
 * entry) as one line of visible text: every control character, line breaks and tabs included,
 * and every hidden character becomes `\u001b`, so the text can neither forge a line of output
 * nor move the cursor, retitle the window, recolor or reorder what is shown. The escape is the
 * JSON one, so a character JSON.stringify leaves as it is stays the same character in JSON.
 */
export function printable(text: string): string {
  return text.replace(ANY_CONTROL, escapeChar);
}

/** Like printable(), cut to at most `max` printed characters, never inside an escape. */
export function printableCut(text: string, max: number): string {
  const out: string[] = [];
  let width = 0;
  for (const c of text) {
    const shown = c.replace(ANY_CONTROL, escapeChar);
    if (width + shown.length > max - 1) {
      out.push("…");
      return out.join("");
    }
    out.push(shown);
    width += shown.length;
  }
  return out.join("");
}

/** The number of characters a line takes on the terminal (code points, not UTF-16 units). */
const printedWidth = (text: string): number => [...text].length;

// eslint-disable-next-line no-control-regex
const OWN_CONTROL = new RegExp(
  `${TOKEN}(\u001b\\[\\d+m)|[\u0000-\u0008\u000b-\u001f\u007f-\u009f${HIDDEN}]`,
  "g",
);

/**
 * What reaches the terminal: line breaks and tabs hexvero writes, the color codes paint()
 * marked, and every other control or hidden character as an escape. Target text printed inside a
 * line goes through printable() first, so its own line breaks are escaped there.
 */
export function terminalSafe(text: string): string {
  return text.replace(OWN_CONTROL, (match, own: string | undefined) => own ?? escapeChar(match));
}

export function heading(io: Io, text: string): string {
  return paint(io, "bold", text);
}

/**
 * One finding per block: the claim and where it was read on the first line, the explanation
 * below it, so long details never push the evidence off the screen.
 */
export function formatFindings(io: Io, findings: Finding[]): string[] {
  if (!findings.length) return [paint(io, "dim", "  (no findings)")];
  return findings.flatMap((f) => {
    const badge = f.confidence === "confirmed" ? paint(io, "green", "●") : paint(io, "yellow", "○");
    const location = f.location ? paint(io, "cyan", `  @ ${printable(f.location)}`) : "";
    const lines = [`  ${badge} ${printable(f.title)}${location}`];
    if (f.detail) lines.push(paint(io, "dim", `      ${printable(f.detail)}`));
    return lines;
  });
}

export function formatLimitations(io: Io, limitations: Limitation[]): string[] {
  return limitations.map(
    (l) =>
      `  ${paint(io, "yellow", "!")} ${printable(l.message)} ${paint(io, "dim", `(${l.code})`)}`,
  );
}

/** Renders a list of flat objects as an aligned table, truncating long cells. */
/** A list of plain values (`senders: ["main.js"]`): a table column, shown comma-separated. */
const plainList = (v: unknown): v is Array<string | number | boolean> =>
  Array.isArray(v) && v.every((x) => x === null || typeof x !== "object");

/** A list of places (`{ file, line, api? }`), shown as `main.js:40 handle`. */
const placeList = (v: unknown): v is Array<{ file: string; line: number; api?: string }> =>
  Array.isArray(v) &&
  v.length > 0 &&
  v.every(
    (x) =>
      x !== null &&
      typeof x === "object" &&
      typeof (x as { file?: unknown }).file === "string" &&
      typeof (x as { line?: unknown }).line === "number",
  );

export function table(rows: Array<Record<string, unknown>>, maxWidth = 60): string[] {
  if (!rows.length) return ["  (empty)"];
  const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((c) =>
    rows.some(
      (r) => r[c] !== undefined && (typeof r[c] !== "object" || plainList(r[c]) || placeList(r[c])),
    ),
  );
  const cell = (v: unknown): string => {
    const text =
      v === undefined || v === null
        ? ""
        : plainList(v)
          ? v.join(", ")
          : placeList(v)
            ? v
                .map((p) => `${p.file}:${p.line}${p.api ? ` ${p.api.split(".").pop()}` : ""}`)
                .join(", ")
            : typeof v === "object"
              ? JSON.stringify(v)
              : String(v);
    return printableCut(text, maxWidth);
  };
  const widths = columns.map((c) =>
    Math.max(printedWidth(c), ...rows.map((r) => printedWidth(cell(r[c])))),
  );
  const line = (values: string[]): string =>
    `  ${values.map((v, i) => v + " ".repeat(Math.max(0, widths[i]! - printedWidth(v)))).join("  ")}`.trimEnd();
  return [
    line(columns),
    line(widths.map((w) => "-".repeat(w))),
    ...rows.map((r) => line(columns.map((c) => cell(r[c])))),
  ];
}

export function hexdump(hex: string, ascii: string, offset: number): string[] {
  const lines: string[] = [];
  for (let i = 0; i < hex.length; i += 32) {
    const chunk = hex.slice(i, i + 32).match(/../g) ?? [];
    const addr = (offset + i / 2).toString(16).padStart(8, "0");
    lines.push(`  ${addr}  ${chunk.join(" ").padEnd(47)}  |${ascii.slice(i / 2, i / 2 + 16)}|`);
  }
  return lines;
}

export const toJson = (value: unknown): string =>
  JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 2);
