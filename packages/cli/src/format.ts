import { randomBytes } from "node:crypto";
import type { Finding, Limitation } from "@hexvero/core";

export interface Io {
  out(text: string): void;
  err(text: string): void;
  color: boolean;
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
 * Text that did not come from hexvero itself (a file name, an error naming an archive entry) as
 * one terminal-safe string: control characters other than newline and tab become `\u001b`, so
 * a name cannot move the cursor, retitle the window or recolor the output. The escape is the JSON
 * one, so a C1 character that JSON.stringify leaves as it is stays the same character in JSON.
 */
export function printable(text: string): string {
  return text.replace(CONTROL, escapeControl);
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
const escapeControl = (c: string): string => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`;
// eslint-disable-next-line no-control-regex
const OWN_CONTROL = new RegExp(
  `${TOKEN}(\u001b\\[\\d+m)|[\u0000-\u0008\u000b-\u001f\u007f-\u009f]`,
  "g",
);

/**
 * What reaches the terminal: printable(), except for the color codes paint() marked. Target text
 * (IPC channel names, file names, strings) is printed by many commands; filtering here covers
 * them all.
 */
export function terminalSafe(text: string): string {
  return text.replace(OWN_CONTROL, (match, own: string | undefined) => own ?? escapeControl(match));
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
    const location = f.location ? paint(io, "cyan", `  @ ${f.location}`) : "";
    const lines = [`  ${badge} ${f.title}${location}`];
    if (f.detail) lines.push(paint(io, "dim", `      ${f.detail}`));
    return lines;
  });
}

export function formatLimitations(io: Io, limitations: Limitation[]): string[] {
  return limitations.map(
    (l) => `  ${paint(io, "yellow", "!")} ${l.message} ${paint(io, "dim", `(${l.code})`)}`,
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
    return text.length > maxWidth ? `${text.slice(0, maxWidth - 1)}…` : text;
  };
  const widths = columns.map((c) => Math.max(c.length, ...rows.map((r) => cell(r[c]).length)));
  const line = (values: string[]): string =>
    `  ${values.map((v, i) => v.padEnd(widths[i]!)).join("  ")}`.trimEnd();
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
