/**
 * `hexvero_check`: the release-policy check of `hexvero check` (contracts C5, C7) for an agent.
 * Read-only: the policy and the baseline are read, never written; accepting findings into a
 * baseline stays a CLI action (`--update-baseline`), where a person decides.
 *
 * The status is decided on every finding; the result shows a page of them (`findingsPage`) and
 * stays within CHECK_RESULT_BYTES, so a large check never floods the agent's context.
 */
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
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

/** Upper bound of the serialized result, like the default page budget of the other tools. */
export const CHECK_RESULT_BYTES = 256 * 1024;
const DEFAULT_FINDINGS = 100;
/** As the core's MAX_POLICY_BYTES: checked before reading, so a wrong path is not read whole. */
const MAX_POLICY_BYTES = 1 << 20;
/** Places kept per finding; `whereTotal` says how many there were. */
const MAX_PLACES = 20;

const invalid = (error: PolicyError): AnalysisError =>
  new AnalysisError("invalid_input", error.message.split("\n")[0]!, { issues: error.issues });

async function readSmall(path: string, what: "policy" | "baseline"): Promise<string> {
  const absolute = resolve(path);
  try {
    const info = await stat(absolute);
    if (!info.isFile())
      throw new AnalysisError("invalid_input", `the ${what} ${absolute} is not a file`, {
        path: absolute,
      });
    if (info.size > MAX_POLICY_BYTES)
      throw new AnalysisError(
        "invalid_input",
        `the ${what} ${absolute} is larger than ${MAX_POLICY_BYTES} bytes`,
        { path: absolute },
      );
    return await readFile(absolute, "utf8");
  } catch (error) {
    if (error instanceof AnalysisError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    throw new AnalysisError(
      code === "ENOENT" ? "not_found" : "invalid_input",
      `cannot read the ${what} ${absolute}: ${code ?? (error as Error).message}${
        code === "ENOENT" && what === "baseline"
          ? "; a baseline is created with the CLI: hexvero check <before> <after> --policy <file> --baseline <file> --update-baseline"
          : ""
      }`,
      { path: absolute },
    );
  }
}

export async function loadPolicy(args: Record<string, unknown>): Promise<LoadedPolicy> {
  const inline = args["policy"];
  const path = args["policyPath"];
  if ((inline === undefined) === (path === undefined))
    throw new AnalysisError("invalid_input", "pass exactly one of policy or policyPath");
  try {
    if (typeof path === "string")
      return parsePolicy(await readSmall(path, "policy"), resolve(path));
    return parsePolicy(JSON.stringify(inline), "inline");
  } catch (error) {
    throw error instanceof PolicyError ? invalid(error) : error;
  }
}

async function loadBaseline(path: unknown): Promise<LoadedBaseline | undefined> {
  if (typeof path !== "string") return undefined;
  try {
    return parseBaseline(await readSmall(path, "baseline"), resolve(path));
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
  const policy = await loadPolicy(args);
  const baseline = await loadBaseline(args["baselinePath"]);
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
