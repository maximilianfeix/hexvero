import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve as resolvePath } from "node:path";
import {
  CHECK_EXIT,
  CORE_VERSION,
  PolicyError,
  checkRelease,
  createBaseline,
  parseBaseline,
  parsePolicy,
  renderPolicyMarkdown,
  STATUS_TEXT,
  toSarif,
  type LoadedBaseline,
  type PolicyFinding,
  type PolicyResult,
  type Session,
} from "@hexvero/core";
import { flagString, UsageError, type ParsedArgs } from "./args.js";
import { paint, toJson, type Io } from "./format.js";

const FORMATS = ["text", "json", "markdown", "sarif"] as const;
type Format = (typeof FORMATS)[number];

/** Target text for a terminal: no control characters (no escape sequences), one line. */
const safe = (text: string): string =>
  [...text]
    .map((c) => {
      const n = c.codePointAt(0)!;
      return n < 32 || n === 0x7f || (n >= 0x80 && n < 0xa0) ? " " : c;
    })
    .join("");

const baseName = (path: string): string => path.split(/[\\/]/).pop() ?? path;

const STATE_MARK: Record<PolicyFinding["state"], string> = {
  new: "new",
  "suppression-expired": "suppression expired",
  baselined: "baselined",
  suppressed: "suppressed",
};

/** The result for a terminal: status first, then each finding with where it was read. */
export function formatCheck(io: Io, r: PolicyResult): string {
  const color = r.status === "pass" ? "green" : r.status === "fail" ? "red" : "yellow";
  const lines = [
    `${paint(io, "bold", "hexvero check")} ${paint(io, color, STATUS_TEXT[r.status])}`,
    paint(
      io,
      "dim",
      `  before ${safe(baseName(r.a.path))} · after ${safe(baseName(r.b.path))} · policy ${safe(baseName(r.policy.file))}`,
    ),
    "",
  ];
  if (!r.findings.length) lines.push(paint(io, "dim", "  no findings"));
  for (const f of r.findings) {
    const counts = f.state === "new" || f.state === "suppression-expired";
    const mark = f.unknown
      ? paint(io, "yellow", "?")
      : counts
        ? paint(io, f.level === "fail" ? "red" : "yellow", "✗")
        : paint(io, "dim", "·");
    lines.push(
      `  ${mark} ${f.rule}  ${safe(f.key)}  ${paint(io, "dim", `${STATE_MARK[f.state]}${f.unknown ? ", unknown" : ""} · ${f.level}`)}`,
    );
    lines.push(`      ${safe(f.message)}`);
    const where = f.where
      .slice(0, 4)
      .map(
        (p) =>
          `${p.role ? `${p.role} ` : ""}${safe(p.file)}${p.line === undefined ? "" : `:${p.line}`}`,
      )
      .join(", ");
    lines.push(
      paint(
        io,
        "dim",
        `      ${where ? `@ ${f.where[0]!.side}: ${where}${f.where.length > 4 ? ` +${f.where.length - 4} more` : ""}` : "no place recorded"}${f.basis ? ` · ${safe(f.basis)}` : ""} · fingerprint ${f.fingerprint}`,
      ),
    );
    if (f.suppression)
      lines.push(
        paint(
          io,
          "dim",
          `      suppressed: ${safe(f.suppression.reason)}${f.suppression.expires ? ` (until ${f.suppression.expires})` : ""}`,
        ),
      );
  }
  if (r.incomplete.length) {
    lines.push("", paint(io, "bold", "  Not decidable"));
    for (const i of r.incomplete)
      lines.push(
        `    ${paint(io, "yellow", "!")} ${i.rule} on ${i.collection}: ${i.gaps.join(", ")}`,
      );
  }
  if (r.baseline)
    lines.push(
      "",
      paint(
        io,
        "dim",
        `  baseline ${safe(r.baseline.file)}: ${r.baseline.matched} finding(s) matched`,
      ),
      ...(r.baseline.warnings ?? []).map((w) => `  ${paint(io, "yellow", "!")} ${safe(w)}`),
    );
  if (r.status === "fail" || r.status === "incomplete")
    lines.push(
      "",
      paint(
        io,
        "dim",
        "  Accept what is there now: add --baseline <file> --update-baseline, or a suppression with the fingerprint and a reason in the policy.",
      ),
    );
  return lines.join("\n");
}

function render(
  io: Io,
  result: PolicyResult,
  format: Format,
  unknown: "fail" | "warn" | "allow",
): string {
  switch (format) {
    case "json":
      return toJson(result);
    case "markdown":
      return renderPolicyMarkdown(result);
    case "sarif":
      return toJson(toSarif(result, { version: CORE_VERSION, unknown }));
    case "text":
      return formatCheck(io, result);
  }
}

async function readText(path: string, what: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    const e = new Error(
      `cannot read the ${what} ${path}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`,
    );
    (e as Error & { what?: string }).what = what;
    throw e;
  }
}

/**
 * `hexvero check <before> <after> --policy <file>`: exit 0 pass, 1 technical error, 2 usage or
 * invalid policy, 3 policy violated, 4 not decidable under `unknown: fail` (contract C6).
 */
export async function runCheck(args: ParsedArgs, io: Io, session: Session): Promise<number> {
  const [before, after, extra] = args.positionals;
  if (!before) throw new UsageError("missing <before>");
  if (!after) throw new UsageError("missing <after>");
  if (extra !== undefined) throw new UsageError(`unexpected argument "${extra}"`);
  const policyFile = flagString(args.flags, "policy");
  if (!policyFile) throw new UsageError("missing --policy <file>");
  const baselineFile = flagString(args.flags, "baseline");
  const update = Boolean(args.flags["update-baseline"]);
  if (update && !baselineFile)
    throw new UsageError("--update-baseline needs --baseline <file> to write");
  const formatFlag = flagString(args.flags, "format") ?? (args.flags["json"] ? "json" : "text");
  if (!(FORMATS as readonly string[]).includes(formatFlag))
    throw new UsageError(`--format must be one of ${FORMATS.join(", ")}, got "${formatFlag}"`);
  const format = formatFlag as Format;
  const out = flagString(args.flags, "out");
  const force = Boolean(args.flags["force"]);

  let policy;
  let baseline: LoadedBaseline | undefined;
  try {
    // An unreadable file is a technical error (1); a file that says the wrong thing is 2.
    policy = parsePolicy(await readText(policyFile, "policy"), policyFile);
    if (baselineFile && !update) {
      let text: string;
      try {
        text = await readFile(baselineFile, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          throw new UsageError(
            `baseline ${baselineFile} does not exist; create it with --baseline ${baselineFile} --update-baseline`,
          );
        throw error;
      }
      baseline = parseBaseline(text, baselineFile);
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

  const a = await session.open(before);
  const b = await session.open(after);
  let result = await checkRelease(session, a.id, b.id, policy, { baseline });
  if (update && baselineFile) {
    const written = createBaseline(result);
    // a baseline usually lives in a directory of its own (.hexvero/baseline.json): create it
    await mkdir(dirname(resolvePath(baselineFile)), { recursive: true });
    await writeFile(baselineFile, `${JSON.stringify(written, null, 2)}\n`);
    const loaded = parseBaseline(JSON.stringify(written), baselineFile);
    result = await checkRelease(session, a.id, b.id, policy, { baseline: loaded });
    io.err(
      `${paint(io, "green", "✓")} wrote ${safe(baselineFile)}: ${written.fingerprints.length} finding(s) accepted`,
    );
  }

  const text = render(out ? { ...io, color: false } : io, result, format, policy.policy.unknown);
  if (out) {
    try {
      await writeFile(out, `${text}\n`, { flag: force ? "w" : "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw new UsageError(`${out} exists; pass --force to replace it`);
      throw error;
    }
    io.out(
      `${paint(io, "bold", "hexvero check")} ${STATUS_TEXT[result.status]} · ${result.findings.length} finding(s) · ${safe(out)}`,
    );
  } else io.out(text);
  // Text output lists them itself; with another format they go to stderr, not into the data.
  if (format !== "text" || out)
    for (const w of result.baseline?.warnings ?? [])
      io.err(`${paint(io, "yellow", "warning:")} ${safe(w)}`);
  return CHECK_EXIT[result.status];
}
