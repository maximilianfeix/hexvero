import {
  AnalysisError,
  auditBuild,
  auditToSarif,
  CHECK_EXIT,
  CORE_VERSION,
  isStdout,
  AUDIT_STATUS_TEXT,
  writeFileNoFollow,
  type AuditResult,
  type Session,
} from "@hexvero/core";
import { flagString, UsageError, type ParsedArgs } from "./args.js";
import { paint, toJson, type Io } from "./format.js";

const FORMATS = ["text", "json", "sarif"] as const;
type Format = (typeof FORMATS)[number];
const UNKNOWN = ["fail", "warn", "allow"] as const;

/** Target text for a terminal: no control characters (no escape sequences), one line. */
const safe = (text: string): string =>
  [...text]
    .map((c) => {
      const n = c.codePointAt(0)!;
      return n < 32 || n === 0x7f || (n >= 0x80 && n < 0xa0) ? " " : c;
    })
    .join("");

const baseName = (path: string): string => path.split(/[\\/]/).pop() ?? path;

/** What each gap needs before a rule can be decided. */
const GAP_STEP: Record<string, string> = {
  scan_partial:
    'the build was read only in part: run "hexvero analyze <build> --all", then audit again',
  files_unreadable:
    'a file could not be read ("hexvero collection <build> limitations" says which and why)',
  values_unresolved:
    "the list may be missing rows (a capped list, an HTML file not read, a value computed at run time)",
};

/** The result for a terminal: status first, then each finding with where it was read. */
export function formatAudit(io: Io, r: AuditResult): string {
  const color = r.status === "pass" ? "green" : r.status === "fail" ? "red" : "yellow";
  const lines = [
    `${paint(io, "bold", "hexvero audit")} ${paint(io, color, AUDIT_STATUS_TEXT[r.status])}`,
    paint(io, "dim", `  build ${safe(baseName(r.target.path))} · unknown ${r.unknown}`),
    "",
  ];
  if (!r.findings.length) lines.push(paint(io, "dim", "  no findings"));
  for (const f of r.findings) {
    const mark = f.unknown ? paint(io, "yellow", "?") : paint(io, "red", "✗");
    lines.push(
      `  ${mark} ${f.rule}  ${safe(f.key)}${f.unknown ? paint(io, "dim", "  unknown") : ""}`,
    );
    lines.push(`      ${safe(f.message)}`);
    const where = f.where
      .slice(0, 4)
      .map((p) => `${safe(p.file)}${p.line === undefined ? "" : `:${p.line}`}`)
      .join(", ");
    lines.push(
      paint(
        io,
        "dim",
        `      ${where ? `@ ${where}${f.where.length > 4 ? ` +${f.where.length - 4} more` : ""}` : "no place: an absence in the files read"} · fingerprint ${f.fingerprint}`,
      ),
    );
  }
  for (const w of r.warnings ?? []) lines.push(`  ${paint(io, "yellow", "!")} ${safe(w)}`);
  if (r.incomplete.length) {
    lines.push("", paint(io, "bold", "  Not decidable"));
    for (const i of r.incomplete)
      lines.push(
        `    ${paint(io, "yellow", "!")} ${i.rule} on ${i.collection}: ${i.gaps.join(", ")}`,
      );
    const gaps = [...new Set(r.incomplete.flatMap((i) => i.gaps))];
    for (const g of gaps) lines.push(paint(io, "dim", `    ${g}: ${GAP_STEP[g] ?? g}`));
  }
  if (r.status === "incomplete")
    lines.push(
      "",
      paint(
        io,
        "dim",
        "  To pass while unknowns stay open, run with --unknown warn (listed) or --unknown allow; they stay listed either way.",
      ),
    );
  return lines.join("\n");
}

/**
 * `hexvero audit <build>`: exit 0 pass, 1 technical error, 2 usage error, 3 a rule violated, 4
 * not decidable under `--unknown fail` (the default), as `check`.
 */
export async function runAudit(args: ParsedArgs, io: Io, session: Session): Promise<number> {
  const [build, extra] = args.positionals;
  if (!build) throw new UsageError("missing <build>");
  if (extra !== undefined) throw new UsageError(`unexpected argument "${extra}"`);
  const formatFlag = flagString(args.flags, "format") ?? (args.flags["json"] ? "json" : "text");
  if (!(FORMATS as readonly string[]).includes(formatFlag))
    throw new UsageError(`--format must be one of ${FORMATS.join(", ")}, got "${formatFlag}"`);
  const format = formatFlag as Format;
  const unknownFlag = flagString(args.flags, "unknown") ?? "fail";
  if (!(UNKNOWN as readonly string[]).includes(unknownFlag))
    throw new UsageError(`--unknown must be one of ${UNKNOWN.join(", ")}, got "${unknownFlag}"`);
  const out = flagString(args.flags, "out");
  const force = Boolean(args.flags["force"]);

  const target = await session.open(build);
  const result = await auditBuild(session, target.id, {
    unknown: unknownFlag as (typeof UNKNOWN)[number],
  });
  const text =
    format === "json"
      ? toJson(result)
      : format === "sarif"
        ? toJson(auditToSarif(result, { version: CORE_VERSION }))
        : formatAudit(out ? { ...io, color: false } : io, result);
  if (out) {
    try {
      await writeFileNoFollow(out, `${text}\n`, { overwrite: force });
    } catch (error) {
      if (error instanceof AnalysisError && error.details["code"] === "EEXIST")
        throw new UsageError(`${out} exists; pass --force to replace it`);
      throw error;
    }
    (isStdout(out) ? (t: string) => io.err(t) : (t: string) => io.out(t))(
      `${paint(io, "bold", "hexvero audit")} ${AUDIT_STATUS_TEXT[result.status]} · ${result.findings.length} finding(s) · ${safe(out)}`,
    );
  } else io.out(text);
  return CHECK_EXIT[result.status];
}
