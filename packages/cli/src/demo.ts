import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { shellWord, type ChangeRow, type ReleaseComparison } from "@hexvero/core";
import { UsageError } from "./args.js";
import { heading, paint, printable, suggest, type Io } from "./format.js";

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

/** The example release policy that ships next to the builds (`examples/policy.json`). */
export const DEMO_POLICY = "policy.json";

/**
 * Copies the example builds into `dir` so the commands printed afterwards work as typed. A file
 * that already exists with the same bytes is kept; one with different bytes is never replaced.
 * The example policy is copied too when it ships and `dir` has none (an edited one is kept).
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
  const policy = join(dirname(sources[0]), DEMO_POLICY);
  const policyTarget = join(dir, DEMO_POLICY);
  if (existsSync(policy) && !existsSync(policyTarget))
    writeFileSync(policyTarget, readFileSync(policy), { flag: "wx" });
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
      const here = r.changes.filter((c) => c.collection === current).length;
      const all = r.cut.find((c) => c.collection === current)?.total ?? here;
      out.push(
        `  ${paint(io, "bold", current)}${paint(io, "dim", ` (${here === all ? all : `${here} of ${all} on this page`})`)}`,
      );
    }
    if (shown++ >= maxPerCollection) {
      if (shown === maxPerCollection + 1)
        out.push(paint(io, "dim", `    … more: ${suggest(io, `compare <a> <b> ${current}`)}`));
      continue;
    }
    const [sign, color] = MARK[row.change];
    const where = row.where
      .slice(0, 3)
      .map(
        (p) =>
          `${p.role ? `${p.role} ` : ""}${printable(p.file)}${p.line === undefined ? "" : `:${p.line}`}`,
      )
      .join(", ");
    const fields = (row.fields ?? [])
      .slice(0, 3)
      .map((f) => printable(`${f.field}: ${JSON.stringify(f.before)} → ${JSON.stringify(f.after)}`))
      .join(", ");
    out.push(
      `    ${paint(io, color, sign)} ${printable(row.key)}${
        where ? paint(io, "dim", `  @ ${row.where[0]!.side}: ${where}`) : ""
      }${row.basis ? paint(io, "dim", ` · ${row.basis}`) : ""}`,
    );
    if (fields) out.push(paint(io, "dim", `        ${fields}`));
    if (row.reason) out.push(paint(io, "dim", `        ${printable(row.reason)}`));
  }
  if (r.page.next !== null)
    out.push(
      paint(
        io,
        "dim",
        `  ${r.changes.length} of ${r.page.total} rows; the rest: --report <file> --offset ${r.page.next}`,
      ),
    );
  return out;
}

/** `file:line` of a place, printable. */
const at = (p: { file: string; line?: number }): string =>
  `${printable(p.file)}${p.line === undefined ? "" : `:${p.line}`}`;

/**
 * Each added or changed preload member as window → member (place) → channel → handler, and an
 * added host on a handler's own line, as `check --format markdown` and the reports draw it.
 */
function tracePaths(r: ReleaseComparison): string[] {
  const hosts = r.changes.filter((c) => c.collection === "endpoints" && c.change === "added");
  return r.changes
    .filter(
      (c) => c.collection === "interfaces" && (c.change === "added" || c.change === "changed"),
    )
    .map((row) => {
      const own = row.where.find((p) => p.role === undefined);
      const handlers = row.where.filter((p) => p.role === "handler");
      const steps: string[] = [];
      if (row.trace?.windows.length) steps.push(printable(row.trace.windows.join(", ")));
      steps.push(
        `${printable(row.key.split("::").slice(-2).join("."))}${own ? ` (${at(own)})` : ""}`,
      );
      if (row.trace?.channel) steps.push(printable(row.trace.channel));
      for (const h of handlers) steps.push(`handler ${at(h)}`);
      for (const host of hosts)
        if (host.where.some((p) => handlers.some((h) => h.file === p.file && h.line === p.line)))
          steps.push(
            `host ${printable(host.key.split("::").slice(2).join("::"))} (on the handler's line)`,
          );
      return steps.join(" → ");
    });
}

/** A path as it can be pasted into a shell. */
const q = shellWord;

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
  const paths = tracePaths(r);
  if (paths.length) {
    lines.push("", paint(io, "bold", "  New ways pages reach the main process"));
    for (const path of paths) lines.push(`    ${path}`);
  }
  if (r.overview.windowChanges.length) {
    lines.push("", paint(io, "bold", "  Window settings to review"));
    for (const w of r.overview.windowChanges)
      lines.push(
        `    ${printable(`${w.window} ${w.setting}: ${w.before} → ${w.after}`)} (${w.direction})`,
      );
  }
  const limits = [
    ...r.limitations.a.map((l) => ["a", l] as const),
    ...r.limitations.b.map((l) => ["b", l] as const),
  ];
  if (limits.length) {
    lines.push("", paint(io, "bold", "  Not established"));
    for (const [side, l] of limits.slice(0, 5))
      lines.push(
        `    ${paint(io, "yellow", "!")} ${side}: ${printable(l.message)} ${paint(io, "dim", `(${l.code})`)}`,
      );
  }
  lines.push(
    "",
    paint(io, "bold", "  Next"),
    `    ${suggest(io, `compare ${q(a)} ${q(b)} interfaces`)}`,
    `    ${suggest(io, `compare ${q(a)} ${q(b)} --report report.md`)}`,
    `    ${suggest(io, `check ${q(a)} ${q(b)} --policy ${q(join(dirname(a), DEMO_POLICY))}`)}`,
    `    ${suggest(io, "ui --demo --open")}`,
  );
  return lines.join("\n");
}
