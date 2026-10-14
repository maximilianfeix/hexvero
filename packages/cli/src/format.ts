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

export function paint(io: Io, color: Color, text: string): string {
  return io.color ? `${codes[color]}${text}${codes.reset}` : text;
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

export function table(rows: Array<Record<string, unknown>>, maxWidth = 60): string[] {
  if (!rows.length) return ["  (empty)"];
  const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((c) =>
    rows.some((r) => r[c] !== undefined && (typeof r[c] !== "object" || plainList(r[c]))),
  );
  const cell = (v: unknown): string => {
    const text =
      v === undefined || v === null
        ? ""
        : plainList(v)
          ? v.join(", ")
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
