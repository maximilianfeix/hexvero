import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChangeRow, ReleaseComparison } from "@hexvero/core";
import { UsageError } from "./args.js";
import { heading, paint, type Io } from "./format.js";

/** The two example builds that ship with the package (built by scripts/build-examples.mjs). */
export const DEMO_FILES = ["notesdesk-1.4.0.asar", "notesdesk-1.5.0.asar"] as const;

/** Where the example builds are: ./examples in the package, ../../examples in the repository. */
export function examplesDirectory(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [join(here, "..", "examples"), join(here, "..", "..", "..", "examples")])
    if (DEMO_FILES.every((f) => existsSync(join(candidate, f)))) return candidate;
  return null;
}

/** The bundled example builds, read in place (for `ui --demo`). */
export function demoPaths(): [string, string] {
  const source = examplesDirectory();
  if (!source) throw new UsageError("the example builds are missing from this installation");
  return [join(source, DEMO_FILES[0]), join(source, DEMO_FILES[1])];
}

/**
 * Copies the example builds into `dir` so the commands printed afterwards work as typed. A file
 * that already exists with the same bytes is kept; one with different bytes is never replaced.
 */
export function writeDemoFiles(dir: string): [string, string] {
  const sources = demoPaths();
  mkdirSync(dir, { recursive: true });
  const paths = sources.map((source, i) => {
    const bytes = readFileSync(source);
    const target = join(dir, DEMO_FILES[i]!);
    if (existsSync(target)) {
      if (!readFileSync(target).equals(bytes))
        throw new UsageError(`${target} exists with other content; pick another directory`);
    } else writeFileSync(target, bytes, { flag: "wx" });
    return target;
  });
  return [paths[0]!, paths[1]!];
}

const MARK: Record<ChangeRow["change"], [string, "green" | "red" | "yellow"]> = {
  added: ["+", "green"],
  removed: ["-", "red"],
  changed: ["~", "yellow"],
  unknown: ["?", "yellow"],
};

/** The rows of a release comparison as terminal lines: change, key, place, how it was read. */
export function formatChanges(io: Io, r: ReleaseComparison, maxPerCollection = 8): string[] {
  const out: string[] = [];
  let current = "";
  let shown = 0;
  for (const row of r.changes) {
    if (row.collection !== current) {
      current = row.collection;
      shown = 0;
      const total = r.changes.filter((c) => c.collection === current).length;
      out.push(`  ${paint(io, "bold", current)}${paint(io, "dim", ` (${total})`)}`);
    }
    if (shown++ >= maxPerCollection) {
      if (shown === maxPerCollection + 1)
        out.push(paint(io, "dim", `    … more: hexvero compare <a> <b> ${current}`));
      continue;
    }
    const [sign, color] = MARK[row.change];
    const where = row.where
      .slice(0, 3)
      .map(
        (p) => `${p.role ? `${p.role} ` : ""}${p.file}${p.line === undefined ? "" : `:${p.line}`}`,
      )
      .join(", ");
    const fields = (row.fields ?? [])
      .slice(0, 3)
      .map((f) => `${f.field}: ${JSON.stringify(f.before)} → ${JSON.stringify(f.after)}`)
      .join(", ");
    out.push(
      `    ${paint(io, color, sign)} ${row.key}${
        where ? paint(io, "dim", `  @ ${row.where[0]!.side}: ${where}`) : ""
      }${row.basis ? paint(io, "dim", ` · ${row.basis}`) : ""}`,
    );
    if (fields) out.push(paint(io, "dim", `        ${fields}`));
    if (row.reason) out.push(paint(io, "dim", `        ${row.reason}`));
  }
  return out;
}

/** A path as it can be pasted into a shell. */
const q = (p: string): string => (/^[\w./@:+-]+$/.test(p) ? p : JSON.stringify(p));

/** The terminal summary of `hexvero demo`. */
export function formatDemo(io: Io, r: ReleaseComparison, a: string, b: string): string {
  const lines = [
    heading(io, `What changed between ${DEMO_FILES[0]} and ${DEMO_FILES[1]}`),
    paint(
      io,
      "dim",
      "  Two builds of a small example Electron app, read statically. Nothing was executed.",
    ),
    "",
    ...formatChanges(io, r, 4),
  ];
  if (r.overview.windowChanges.length) {
    lines.push("", paint(io, "bold", "  Window settings to review"));
    for (const w of r.overview.windowChanges)
      lines.push(`    ${w.window} ${w.setting}: ${w.before} → ${w.after} (${w.direction})`);
  }
  const limits = [
    ...r.limitations.a.map((l) => ["a", l] as const),
    ...r.limitations.b.map((l) => ["b", l] as const),
  ];
  if (limits.length) {
    lines.push("", paint(io, "bold", "  Not established"));
    for (const [side, l] of limits.slice(0, 5))
      lines.push(
        `    ${paint(io, "yellow", "!")} ${side}: ${l.message} ${paint(io, "dim", `(${l.code})`)}`,
      );
  }
  lines.push(
    "",
    paint(io, "bold", "  Next"),
    `    hexvero compare ${q(a)} ${q(b)} interfaces`,
    `    hexvero compare ${q(a)} ${q(b)} --report report.md`,
    `    hexvero ui --demo --open`,
  );
  return lines.join("\n");
}
