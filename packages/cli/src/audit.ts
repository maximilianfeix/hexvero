import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve as resolvePath } from "node:path";
import {
  AnalysisError,
  auditBuild,
  auditToSarif,
  CHECK_EXIT,
  CORE_VERSION,
  createAuditBaseline,
  isStdout,
  AUDIT_STATUS_TEXT,
  parseAuditBaseline,
  parsePolicy,
  PolicyError,
  shellWord,
  writeFileNoFollow,
  type AuditFinding,
  type AuditResult,
  type LoadedAuditBaseline,
  type LoadedPolicy,
  type Session,
} from "@hexvero/core";
import { flagString, UsageError, type ParsedArgs } from "./args.js";
import { readText } from "./check.js";
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

const STATE_MARK: Record<AuditFinding["state"], string> = {
  new: "new",
  "suppression-expired": "suppression expired",
  baselined: "baselined",
  suppressed: "suppressed",
};

const counts = (f: AuditFinding): boolean => f.state === "new" || f.state === "suppression-expired";

/** The result for a terminal: status first, then each finding with where it was read. */
export function formatAudit(io: Io, r: AuditResult): string {
  const color = r.status === "pass" ? "green" : r.status === "fail" ? "red" : "yellow";
  const lines = [
    `${paint(io, "bold", "hexvero audit")} ${paint(io, color, AUDIT_STATUS_TEXT[r.status])}`,
    paint(
      io,
      "dim",
      `  build ${safe(baseName(r.target.path))} · unknown ${r.unknown}${r.policy ? ` · policy ${safe(baseName(r.policy.file))}` : ""}`,
    ),
    "",
  ];
  // without a policy or baseline every finding is new at fail: keep the plain listing
  const accounted = Boolean(r.policy || r.baseline);
  if (!r.findings.length) lines.push(paint(io, "dim", "  no findings"));
  for (const f of r.findings) {
    const mark = f.unknown
      ? paint(io, "yellow", "?")
      : counts(f)
        ? paint(io, f.level === "fail" ? "red" : "yellow", "✗")
        : paint(io, "dim", "·");
    const state = accounted
      ? `  ${paint(io, "dim", `${STATE_MARK[f.state]}${f.unknown ? ", unknown" : ""} · ${f.level}`)}`
      : f.unknown
        ? paint(io, "dim", "  unknown")
        : "";
    lines.push(`  ${mark} ${f.rule}  ${safe(f.key)}${state}`);
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
    if (f.suppression)
      lines.push(
        f.state === "suppression-expired"
          ? `      ${paint(io, "yellow", "!")} suppression expired on ${f.suppression.expires ?? "?"}, so the finding counts again: ${safe(f.suppression.reason)}`
          : paint(
              io,
              "dim",
              `      suppressed: ${safe(f.suppression.reason)}${f.suppression.expires ? ` (until ${f.suppression.expires})` : ""}`,
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
  if (r.baseline) {
    const accepted = r.findings.filter((f) => f.state === "baselined").length;
    const fresh = r.findings.filter((f) => f.baselineState === "new").length;
    lines.push(
      "",
      paint(
        io,
        "dim",
        `  baseline ${safe(r.baseline.file)}: ${r.baseline.matched} finding(s) matched, ${accepted} baselined, ${fresh} new`,
      ),
      ...(r.baseline.warnings ?? []).map((w) => `  ${paint(io, "yellow", "!")} ${safe(w)}`),
    );
  }
  if (r.findings.some((f) => counts(f) && f.level === "fail"))
    lines.push(
      "",
      paint(
        io,
        "dim",
        "  Accept what is there now: add --baseline <file> --update-baseline, or a suppression with the fingerprint and a reason in the policy's audit section.",
      ),
    );
  if (r.status === "incomplete")
    lines.push(
      "",
      paint(
        io,
        "dim",
        `  A rule that could not be decided is not a finding, and a baseline cannot accept it. To pass while unknowns stay open, run with --unknown warn (listed) or --unknown allow${r.policy ? `, or set "unknown" in the policy's audit section` : ""}; they stay listed either way.`,
      ),
    );
  return lines.join("\n");
}

/**
 * `hexvero audit <build>`: exit 0 pass, 1 technical error, 2 usage error or invalid policy or
 * baseline, 3 a rule violated, 4 not decidable under `unknown: fail` (the default), as `check`.
 * `--policy`, `--baseline` and `--update-baseline` read and write files as `check` does.
 */
export async function runAudit(args: ParsedArgs, io: Io, session: Session): Promise<number> {
  const [build, extra] = args.positionals;
  if (!build) throw new UsageError("missing <build>");
  if (extra !== undefined) throw new UsageError(`unexpected argument "${extra}"`);
  const formatFlag = flagString(args.flags, "format") ?? (args.flags["json"] ? "json" : "text");
  if (!(FORMATS as readonly string[]).includes(formatFlag))
    throw new UsageError(`--format must be one of ${FORMATS.join(", ")}, got "${formatFlag}"`);
  const format = formatFlag as Format;
  const unknownFlag = flagString(args.flags, "unknown");
  if (unknownFlag !== undefined && !(UNKNOWN as readonly string[]).includes(unknownFlag))
    throw new UsageError(`--unknown must be one of ${UNKNOWN.join(", ")}, got "${unknownFlag}"`);
  const out = flagString(args.flags, "out");
  const force = Boolean(args.flags["force"]);
  const policyFile = flagString(args.flags, "policy");
  const baselineFile = flagString(args.flags, "baseline");
  const update = Boolean(args.flags["update-baseline"]);
  if (update && !baselineFile)
    throw new UsageError("--update-baseline needs --baseline <file> to write");

  let policy: LoadedPolicy | undefined;
  let baseline: LoadedAuditBaseline | undefined;
  try {
    // An unreadable file is a technical error (1); a file that says the wrong thing is 2.
    if (policyFile) policy = parsePolicy(await readText(policyFile, "policy"), policyFile);
    if (baselineFile && !update) {
      let text: string;
      try {
        text = await readFile(baselineFile, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          throw new UsageError(
            `baseline ${baselineFile} does not exist; create it with --baseline ${shellWord(baselineFile)} --update-baseline`,
          );
        throw error;
      }
      baseline = parseAuditBaseline(text, baselineFile);
    }
  } catch (error) {
    if (error instanceof PolicyError) {
      io.err(
        `${paint(io, "red", "error:")} ${safe(error.message.split("\n")[0]!)}${error.issues.map((i) => `\n  - ${safe(i)}`).join("")}`,
      );
      return 2;
    }
    throw error;
  }

  const target = await session.open(build);
  const options = {
    unknown: unknownFlag as (typeof UNKNOWN)[number] | undefined,
    policy,
    digest: Boolean(baselineFile),
  };
  let result = await auditBuild(session, target.id, { ...options, baseline });
  if (update && baselineFile) {
    const written = createAuditBaseline(result);
    // a baseline usually lives in a directory of its own (.hexvero/audit-baseline.json)
    await mkdir(dirname(resolvePath(baselineFile)), { recursive: true });
    await writeFileNoFollow(baselineFile, `${JSON.stringify(written, null, 2)}\n`, {
      overwrite: true,
    });
    const loaded = parseAuditBaseline(JSON.stringify(written), baselineFile);
    result = await auditBuild(session, target.id, { ...options, baseline: loaded });
    io.err(
      `${paint(io, "green", "✓")} wrote ${safe(baselineFile)}: ${written.fingerprints.length} finding(s) accepted`,
    );
  }
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
  // Text output lists them itself; with another format they go to stderr, not into the data.
  if (format !== "text" || out)
    for (const w of result.baseline?.warnings ?? [])
      io.err(`${paint(io, "yellow", "warning:")} ${safe(w)}`);
  return CHECK_EXIT[result.status];
}
