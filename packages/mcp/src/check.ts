/**
 * `hexvero_check`: the release-policy check of `hexvero check` (contracts C5, C7) for an agent,
 * and, without targetB, `hexvero audit` of one build (the Electron security rules, the policy's
 * `audit` section, audit baselines). Read-only: the policy and the baseline are read, never
 * written; accepting findings into a baseline stays a CLI action (`--update-baseline`), where a
 * person decides.
 *
 * The status is decided on every finding; the result shows a page of them (`findingsPage`) and
 * stays within CHECK_RESULT_BYTES, so a large check never floods the agent's context.
 */
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  AnalysisError,
  CORE_VERSION,
  PolicyError,
  auditBuild,
  auditToSarif,
  checkRelease,
  parseAuditBaseline,
  parseBaseline,
  parsePolicy,
  renderPolicyMarkdown,
  toSarif,
  type AuditResult,
  type LoadedAuditBaseline,
  type LoadedBaseline,
  type LoadedPolicy,
  type PolicyResult,
  type Session,
} from "@hexvero/core";
import { checkReadPath } from "./writePolicy.js";

/** Upper bound of the serialized result, like the default page budget of the other tools. */
export const CHECK_RESULT_BYTES = 256 * 1024;
const DEFAULT_FINDINGS = 100;
/** As the core's MAX_POLICY_BYTES: checked before reading, so a wrong path is not read whole. */
const MAX_POLICY_BYTES = 1 << 20;
/** Places kept per finding; `whereTotal` says how many there were. */
const MAX_PLACES = 20;

const invalid = (error: PolicyError): AnalysisError =>
  new AnalysisError("invalid_input", error.message.split("\n")[0]!, { issues: error.issues });

/** Line and column (1-based) of a character offset. */
function lineCol(text: string, offset: number): string {
  const before = text.slice(0, offset).split("\n");
  return `line ${before.length} col ${before.at(-1)!.length + 1}`;
}

/** A prefix that already fails for a reason other than ending early. */
const fails = (prefix: string): boolean => {
  try {
    JSON.parse(prefix);
    return false;
  } catch (e) {
    return !/end of JSON input|Unterminated string/i.test((e as Error).message);
  }
};

/**
 * Where JSON.parse failed, without its message (which quotes the text). V8 names the position for
 * most errors; for an unexpected token it does not, and the offset is found as the shortest
 * prefix that already fails for a reason other than ending early.
 */
function errorOffset(text: string, error: Error): number {
  const at = /position (\d+)/.exec(error.message);
  if (at) return Number(at[1]);
  if (/end of JSON input/i.test(error.message)) return text.length;
  let lo = 1;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (fails(text.slice(0, mid))) hi = mid;
    else lo = mid + 1;
  }
  return lo - 1;
}

/**
 * Reads a policy or baseline file the agent named, through one descriptor (opened non-blocking
 * and checked with fstat, so the checked file is the one read and a FIFO cannot block). Only
 * inside the allowed directories (`checkReadPath`). Errors never quote the file: a file that is
 * not JSON is reported by position only, and a JSON file that does not declare itself a hexvero
 * policy or baseline is refused without listing its keys or values.
 */
async function readJsonFile(
  path: string,
  what: "policy" | "baseline",
  session: Session,
  create = "hexvero check <before> <after> --policy <file>",
): Promise<string> {
  const opened = session.list().map((t) => {
    // A packaged build counts as what was opened: the bundle or install directory itself, or
    // the directory of the archive (the app read out of a ZIP has no path on disk).
    const c = t.info.container;
    if (c) return c.format === "directory" ? c.path : dirname(c.path);
    return t.info.format === "directory" ? t.info.path : dirname(t.info.path);
  });
  const real = checkReadPath(path, what, opened);
  let text: string;
  let handle;
  try {
    handle = await open(real, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    const info = await handle.stat();
    if (!info.isFile())
      throw new AnalysisError("invalid_input", `the ${what} ${real} is not a regular file`, {
        path: real,
      });
    if (info.size > MAX_POLICY_BYTES)
      throw new AnalysisError(
        "invalid_input",
        `the ${what} ${real} is larger than ${MAX_POLICY_BYTES} bytes`,
        { path: real },
      );
    const bytes = Buffer.alloc(info.size);
    let done = 0;
    while (done < bytes.length) {
      const { bytesRead } = await handle.read(bytes, done, bytes.length - done, done);
      if (bytesRead === 0) break;
      done += bytesRead;
    }
    text = bytes.subarray(0, done).toString("utf8");
  } catch (error) {
    if (error instanceof AnalysisError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    throw new AnalysisError(
      code === "ENOENT" ? "not_found" : "invalid_input",
      `cannot read the ${what} ${real}: ${code ?? "read failed"}${
        code === "ENOENT" && what === "baseline"
          ? `; a baseline is created with the CLI: ${create} --baseline <file> --update-baseline`
          : ""
      }`,
      { path: real },
    );
  } finally {
    await handle?.close();
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new AnalysisError(
      "invalid_input",
      `the ${what} ${real} is not valid JSON at ${lineCol(text, errorOffset(text, error as Error))}`,
      { path: real },
    );
  }
  if (
    typeof raw !== "object" ||
    raw === null ||
    (raw as Record<string, unknown>)["hexvero"] !== what
  )
    throw new AnalysisError(
      "invalid_input",
      `the ${what} ${real} is not a hexvero ${what} (it must be a JSON object with "hexvero": "${what}")`,
      { path: real },
    );
  return text;
}

/** Exactly one of `policy` and `policyPath`; for an audit (`optional`) also neither. */
export async function loadPolicy(
  args: Record<string, unknown>,
  session: Session,
  optional = false,
): Promise<LoadedPolicy | undefined> {
  const inline = args["policy"];
  const path = args["policyPath"];
  if (optional && inline === undefined && path === undefined) return undefined;
  if ((inline === undefined) === (path === undefined))
    throw new AnalysisError(
      "invalid_input",
      optional
        ? "pass at most one of policy or policyPath"
        : "pass exactly one of policy or policyPath (or omit targetB to audit targetA alone)",
    );
  try {
    if (typeof path === "string")
      return parsePolicy(await readJsonFile(path, "policy", session), resolve(path));
    return parsePolicy(JSON.stringify(inline), "inline");
  } catch (error) {
    throw error instanceof PolicyError ? invalid(error) : error;
  }
}

async function loadBaseline(path: unknown, session: Session): Promise<LoadedBaseline | undefined> {
  if (typeof path !== "string") return undefined;
  try {
    return parseBaseline(await readJsonFile(path, "baseline", session), resolve(path));
  } catch (error) {
    throw error instanceof PolicyError ? invalid(error) : error;
  }
}

async function loadAuditBaseline(
  path: unknown,
  session: Session,
): Promise<LoadedAuditBaseline | undefined> {
  if (typeof path !== "string") return undefined;
  try {
    const text = await readJsonFile(path, "baseline", session, "hexvero audit <build>");
    return parseAuditBaseline(text, resolve(path));
  } catch (error) {
    throw error instanceof PolicyError ? invalid(error) : error;
  }
}

/** What a check finding and an audit finding share, for paging and counting. */
interface Countable {
  state: string;
  level: "fail" | "warn";
  unknown?: boolean;
  where: unknown[];
}

const bounded = <F extends Countable>(f: F): F & { whereTotal?: number } =>
  f.where.length > MAX_PLACES
    ? { ...f, where: f.where.slice(0, MAX_PLACES), whereTotal: f.where.length }
    : f;

function counts(findings: Countable[]): Record<string, number> {
  const out: Record<string, number> = { fail: 0, warn: 0, unknown: 0 };
  for (const f of findings) {
    out[f.state] = (out[f.state] ?? 0) + 1;
    out[f.level] = (out[f.level] ?? 0) + 1;
    if (f.unknown) out["unknown"]! += 1;
  }
  return out;
}

/**
 * One page of `all` (offset, limit) put into the answer by `render`, with `findingsPage` and
 * `counts`. The counts are over every finding, not the page. Hard budget: the page is halved until
 * the answer fits CHECK_RESULT_BYTES; at least one finding is always shown.
 */
function pageFindings<F extends Countable>(
  all: F[],
  args: Record<string, unknown>,
  render: (findings: F[], common: Record<string, unknown>) => Record<string, unknown>,
): Record<string, unknown> {
  const offset = typeof args["offset"] === "number" ? args["offset"] : 0;
  let limit = typeof args["limit"] === "number" ? args["limit"] : DEFAULT_FINDINGS;
  const total = all.length;
  const shape = (size: number): Record<string, unknown> => {
    const findings = all.slice(offset, offset + size).map(bounded);
    const next = offset + findings.length < total ? offset + findings.length : null;
    const findingsPage = {
      offset,
      limit: size,
      total,
      next,
      shown: `${findings.length} of ${total} findings shown${next === null ? "" : `; pass offset: ${next} for the rest`}`,
    };
    return render(findings, { findingsPage, counts: counts(all) });
  };
  let out = shape(limit);
  while (limit > 1 && Buffer.byteLength(JSON.stringify(out)) > CHECK_RESULT_BYTES) {
    limit = Math.max(1, Math.floor(limit / 2));
    out = shape(limit);
  }
  return out;
}

/**
 * `hexvero audit <build>` of targetA: the CLI's `--format json` (an `AuditResult`) or SARIF.
 * The policy is optional (without one every rule is at fail); `unknown` is `--unknown`.
 */
async function runAuditTool(session: Session, args: Record<string, unknown>): Promise<unknown> {
  const format = args["format"] ?? "json";
  if (format !== "json" && format !== "sarif")
    throw new AnalysisError(
      "invalid_input",
      `an audit (no targetB) returns json or sarif, not ${String(format)}`,
    );
  const policy = await loadPolicy(args, session, true);
  const baseline = await loadAuditBaseline(args["baselinePath"], session);
  const result = await auditBuild(session, String(args["targetA"]), {
    policy,
    baseline,
    unknown: args["unknown"] as AuditResult["unknown"] | undefined,
  });
  return pageFindings(result.findings, args, (findings, common) => {
    const paged: AuditResult = { ...result, findings };
    if (format === "sarif")
      return {
        status: result.status,
        format,
        ...common,
        sarif: auditToSarif(paged, { version: CORE_VERSION }),
      };
    return { ...paged, ...common };
  });
}

export async function runCheckTool(
  session: Session,
  args: Record<string, unknown>,
): Promise<unknown> {
  if (args["targetB"] === undefined) return runAuditTool(session, args);
  if (args["unknown"] !== undefined)
    throw new AnalysisError(
      "invalid_input",
      'unknown applies to an audit (no targetB); for two builds set "unknown" in the policy',
    );
  const policy = (await loadPolicy(args, session))!;
  const baseline = await loadBaseline(args["baselinePath"], session);
  const result = await checkRelease(
    session,
    String(args["targetA"]),
    String(args["targetB"]),
    policy,
    {
      baseline,
    },
  );
  const format =
    args["format"] === "markdown" || args["format"] === "sarif" ? args["format"] : "json";
  return pageFindings(result.findings, args, (findings, common) => {
    // The status and counts come from every finding, not from the page.
    const paged: PolicyResult = { ...result, findings };
    if (format === "markdown")
      return {
        status: result.status,
        format,
        ...common,
        text: renderPolicyMarkdown(paged),
      };
    if (format === "sarif")
      return {
        status: result.status,
        format,
        ...common,
        sarif: toSarif(paged, { version: CORE_VERSION, unknown: policy.policy.unknown }),
      };
    return { ...paged, ...common };
  });
}
