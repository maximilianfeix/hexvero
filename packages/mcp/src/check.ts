/**
 * `hexvero_check`: the release-policy check of `hexvero check` (contracts C5, C7) for an agent.
 * Read-only: the policy and the baseline are read, never written; accepting findings into a
 * baseline stays a CLI action (`--update-baseline`), where a person decides.
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
  checkRelease,
  parseBaseline,
  parsePolicy,
  renderPolicyMarkdown,
  toSarif,
  type LoadedBaseline,
  type LoadedPolicy,
  type PolicyFinding,
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
          ? "; a baseline is created with the CLI: hexvero check <before> <after> --policy <file> --baseline <file> --update-baseline"
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

export async function loadPolicy(
  args: Record<string, unknown>,
  session: Session,
): Promise<LoadedPolicy> {
  const inline = args["policy"];
  const path = args["policyPath"];
  if ((inline === undefined) === (path === undefined))
    throw new AnalysisError("invalid_input", "pass exactly one of policy or policyPath");
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

const bounded = (f: PolicyFinding): PolicyFinding & { whereTotal?: number } =>
  f.where.length > MAX_PLACES
    ? { ...f, where: f.where.slice(0, MAX_PLACES), whereTotal: f.where.length }
    : f;

function counts(findings: PolicyFinding[]): Record<string, number> {
  const out: Record<string, number> = { fail: 0, warn: 0, unknown: 0 };
  for (const f of findings) {
    out[f.state] = (out[f.state] ?? 0) + 1;
    out[f.level]! += 1;
    if (f.unknown) out["unknown"]! += 1;
  }
  return out;
}

export async function runCheckTool(
  session: Session,
  args: Record<string, unknown>,
): Promise<unknown> {
  const policy = await loadPolicy(args, session);
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
  const offset = typeof args["offset"] === "number" ? args["offset"] : 0;
  let limit = typeof args["limit"] === "number" ? args["limit"] : DEFAULT_FINDINGS;
  const total = result.findings.length;
  const shape = (size: number): Record<string, unknown> => {
    const findings = result.findings.slice(offset, offset + size).map(bounded);
    const next = offset + findings.length < total ? offset + findings.length : null;
    const findingsPage = {
      offset,
      limit: size,
      total,
      next,
      shown: `${findings.length} of ${total} findings shown${next === null ? "" : `; pass offset: ${next} for the rest`}`,
    };
    // The status and counts come from every finding, not from the page.
    const paged: PolicyResult = { ...result, findings };
    const common = { findingsPage, counts: counts(result.findings) };
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
  };
  let out = shape(limit);
  // Hard budget: halve the page until it fits; at least one finding is always shown.
  while (limit > 1 && Buffer.byteLength(JSON.stringify(out)) > CHECK_RESULT_BYTES) {
    limit = Math.max(1, Math.floor(limit / 2));
    out = shape(limit);
  }
  return out;
}
