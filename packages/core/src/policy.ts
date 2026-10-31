/**
 * Release policies (contract C5): a JSON policy file says which kinds of change between two
 * builds are allowed, `evaluatePolicy` applies it to a `ReleaseComparison` and returns a
 * `PolicyResult` that the CLI prints as text, Markdown, JSON or SARIF.
 *
 * A policy is data only: no code, no regular expressions. The one pattern it knows is a host
 * wildcard `*.example.com` (any subdomain of example.com, not example.com itself).
 *
 * Fingerprints name a finding by what it is about, never by where it sits: the rule plus the
 * semantic identity of the item (an interface member's `api.member`, a host name, a window and
 * setting). Lines, columns and the order of rows do not enter them, so a baseline survives code
 * moving around. Consequences, by design:
 * - Duplicates: the same member or host found in several places is one finding with several
 *   places.
 * - Renames: a member renamed from `openInShell` to `checkUpdate` is a removal (no finding) plus
 *   an addition (a new finding). There is no rename detection.
 * - Version: fingerprints are defined for policy version 1 and baseline version 1. A later
 *   version that changes an identity will be a new version number, and files of the old one are
 *   refused with a message, never matched silently.
 */
import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { AnalysisError } from "./model.js";
import { directoryDigest } from "./digest.js";
import {
  compareReleases,
  TRACE_HOST_NOTE,
  traceMarkdownLine,
  type ChangeRow,
  type Place,
  type ReleaseComparison,
} from "./report.js";
import { judgeSwitch, splitSwitch } from "./javascript/switches.js";
import {
  AUDIT_LATER_RULES,
  AUDIT_RULES,
  AUDIT_STATUS_TEXT,
  cspRisk,
  dangerousCallRisk,
  hiddenFeatures,
  httpResourceRisk,
  hiddenFeaturesNote,
  openExternalRisk,
  permissionRisk,
  type AuditResult,
  type AuditRuleId,
} from "./audit.js";
import type {
  CspRow,
  DangerousCallRow,
  LoadRow,
  OpenExternalRow,
  PermissionHandlerRow,
} from "./javascript/app.js";
import { UNRESOLVED_LIMITATIONS, type Session, type TargetRecord } from "./session.js";

export const POLICY_RULES = [
  "new-interface-member",
  "new-external-host",
  "window-more-permissive",
  "new-bridge-exposure",
  "fuse-weakened",
  "remote-enabled",
  "new-unsafe-switch",
  "new-open-external",
  "permission-handler-grants-all",
  "csp-weakened",
  "navigation-limit-removed",
  "new-dangerous-call",
  "new-insecure-webview",
  "new-custom-protocol",
  "new-http-resource",
] as const;
export type PolicyRuleId = (typeof POLICY_RULES)[number];

/** Rules added after 0.9.6: they run at warn when a policy does not list them. */
const LATER_RULES: ReadonlySet<PolicyRuleId> = new Set([
  "new-bridge-exposure",
  "fuse-weakened",
  "remote-enabled",
  "new-unsafe-switch",
  "new-open-external",
  "permission-handler-grants-all",
  "csp-weakened",
  "navigation-limit-removed",
  "new-dangerous-call",
  "new-insecure-webview",
  "new-custom-protocol",
  "new-http-resource",
]);

export type RuleLevel = "fail" | "warn" | "off";
export type UnknownHandling = "fail" | "warn" | "allow";

export interface RuleConfig {
  level: RuleLevel;
  /** `new-external-host` only: hosts that may appear (exact, or `*.domain` for subdomains). */
  allow?: string[];
}

export interface Suppression {
  rule: PolicyRuleId;
  fingerprint: string;
  reason: string;
  /** `YYYY-MM-DD`, inclusive (UTC). After that day the suppression no longer applies. */
  expires?: string;
}

export interface AuditSuppression {
  rule: AuditRuleId;
  fingerprint: string;
  reason: string;
  /** `YYYY-MM-DD`, inclusive (UTC). After that day the suppression no longer applies. */
  expires?: string;
}

/**
 * The policy's `audit` section, for `hexvero audit --policy`: levels and suppressions of the
 * audit rules. A section of its own because two audit rules share a name with a check rule
 * (`remote-enabled`, `permission-handler-grants-all`) but mean "is there", not "is new".
 */
export interface AuditPolicy {
  /** Every audit rule; one the section does not list runs at fail. */
  rules: Record<AuditRuleId, { level: RuleLevel }>;
  /** The section's `unknown`, else the policy's. */
  unknown: UnknownHandling;
  suppressions: AuditSuppression[];
}

export interface Policy {
  hexvero: "policy";
  version: 1;
  rules: Record<PolicyRuleId, RuleConfig>;
  unknown: UnknownHandling;
  suppressions: Suppression[];
  /** Set when the file has an `audit` section; `auditPolicyOf` gives the defaults otherwise. */
  audit?: AuditPolicy;
}

/** The audit section of a policy, or the defaults (every rule at fail) without one. */
export function auditPolicyOf(policy?: Policy): AuditPolicy {
  if (policy?.audit) return policy.audit;
  const rules = {} as AuditPolicy["rules"];
  for (const id of AUDIT_RULES) rules[id] = { level: "fail" };
  return { rules, unknown: policy?.unknown ?? "fail", suppressions: [] };
}

/** A policy as read from a file, with what identifies that file's bytes. */
export interface LoadedPolicy {
  policy: Policy;
  file: string;
  sha256: string;
}

export interface PolicyFinding {
  rule: PolicyRuleId;
  /** sha256 hex (first 32) of `${rule}\0${semantic identity}`; independent of lines, order. */
  fingerprint: string;
  level: "fail" | "warn";
  state: "new" | "baselined" | "suppressed" | "suppression-expired";
  /** The change it is about; `row` is the ChangeRow id (C3). */
  row: string;
  collection: string;
  key: string;
  message: string;
  where: Place[];
  /** True when the finding rests on an unknown/incomplete comparison. */
  unknown: boolean;
  /**
   * How the underlying fact was read (`literal`, `inferred`, `link direct`, …), as the parser
   * says it. Separate from `level`, which is what the policy makes of it.
   */
  basis?: string;
  /** For a suppressed or expired finding: the reason given in the policy. */
  suppression?: { reason: string; expires?: string };
  /** For an interface member: the windows that load it and its channel (`ChangeRow.trace`). */
  trace?: { windows: string[]; channel: string | null };
}

export interface PolicyResult {
  hexvero: "check";
  version: 1;
  status: "pass" | "fail" | "incomplete" | "error";
  findings: PolicyFinding[];
  /** Coverage gaps that made the check undecidable for a rule. */
  incomplete: Array<{ rule: string; collection: string; gaps: string[] }>;
  /** What the check could not tell about the builds, without changing the status. */
  warnings?: string[];
  /** `warnings`: the baseline was written for another policy or another before build. */
  baseline?: { file: string; created: string; matched: number; warnings?: string[] };
  policy: { file: string; sha256: string };
  a: TargetRecord["info"];
  b: TargetRecord["info"];
}

export interface BaselineFile {
  hexvero: "baseline";
  version: 1;
  created: string;
  policy: string;
  a: string;
  b: string;
  fingerprints: Array<{ rule: string; fingerprint: string; key: string }>;
}

export interface LoadedBaseline {
  baseline: BaselineFile;
  file: string;
}

/**
 * A baseline written by `hexvero audit --update-baseline`: check's format with `command: "audit"`
 * and the one build it was written from in place of `a` and `b`. Check's files have no `command`;
 * each command refuses the other's file rather than matching fingerprints of other rules.
 */
export interface AuditBaselineFile {
  hexvero: "baseline";
  version: 1;
  command: "audit";
  created: string;
  /** sha256 of the policy file, or null when the audit ran without one. */
  policy: string | null;
  /** sha256 of the build (a content digest for a directory). Provenance only. */
  build: string;
  fingerprints: Array<{ rule: AuditRuleId; fingerprint: string; key: string }>;
}

export interface LoadedAuditBaseline {
  baseline: AuditBaselineFile;
  file: string;
}

/** A policy or baseline file that does not say what it must; `issues` name each problem. */
export class PolicyError extends Error {
  constructor(
    message: string,
    readonly issues: string[],
  ) {
    super(issues.length ? `${message}\n${issues.map((i) => `  - ${i}`).join("\n")}` : message);
    this.name = "PolicyError";
  }
}

/** Larger than any sensible policy; refuses a mistaken path to a build or a log. */
export const MAX_POLICY_BYTES = 1 << 20;

const sha256 = (data: string | Uint8Array): string =>
  createHash("sha256").update(data).digest("hex");

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** A value from a policy file, quoted for an error message and cut short. */
const quote = (v: unknown): string => {
  let text: string;
  try {
    text = JSON.stringify(v) ?? String(v);
  } catch {
    // JSON.parse reads nesting that JSON.stringify cannot write back (stack depth)
    text = Array.isArray(v) ? "a nested list" : "a nested object";
  }
  return text.length > 60 ? `${text.slice(0, 59)}…` : text;
};

const HOST_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
/** An allow entry: a host name, `*.` + a host name, an IPv4 address or a bracketed IPv6 one. */
export function validAllowEntry(entry: string): boolean {
  if (entry.length === 0 || entry.length > 253) return false;
  if (/^\[[0-9a-f:.]+\]$/.test(entry)) return true;
  const name = entry.startsWith("*.") ? entry.slice(2) : entry;
  const labels = name.split(".");
  // a wildcard needs at least a domain and a top-level label: `*.com` would allow half the web
  if (entry.startsWith("*.") && labels.length < 2) return false;
  return labels.every((l) => HOST_LABEL.test(l));
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
function validDate(text: string): boolean {
  const m = DATE.exec(text);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === text;
}

const FINGERPRINT = /^[0-9a-f]{32}$/;

/** Suppressions of a policy or its audit section; problems go to `issues` with their path. */
function parseSuppressions<R extends string>(
  rawSup: unknown,
  at: string,
  ids: readonly R[],
  issues: string[],
): Array<{ rule: R; fingerprint: string; reason: string; expires?: string }> {
  const out: Array<{ rule: R; fingerprint: string; reason: string; expires?: string }> = [];
  if (rawSup === undefined) return out;
  if (!Array.isArray(rawSup)) {
    issues.push(`${at}: must be a list`);
    return out;
  }
  rawSup.forEach((s: unknown, i: number) => {
    const path = `${at}[${i}]`;
    if (!isRecord(s)) {
      issues.push(`${path}: must be an object with rule, fingerprint and reason`);
      return;
    }
    for (const k of Object.keys(s))
      if (!["rule", "fingerprint", "reason", "expires"].includes(k))
        issues.push(`${path}.${k}: unknown key (allowed: rule, fingerprint, reason, expires)`);
    const before = issues.length;
    if (!(ids as readonly unknown[]).includes(s["rule"]))
      issues.push(`${path}.rule: must be one of ${ids.join(", ")}, got ${quote(s["rule"])}`);
    if (typeof s["fingerprint"] !== "string" || !FINGERPRINT.test(s["fingerprint"]))
      issues.push(
        `${path}.fingerprint: must be 32 lower-case hex characters, got ${quote(s["fingerprint"])}`,
      );
    if (typeof s["reason"] !== "string" || s["reason"].trim() === "" || s["reason"].length > 500)
      issues.push(`${path}.reason: must say why, in 1 to 500 characters`);
    if (
      s["expires"] !== undefined &&
      (typeof s["expires"] !== "string" || !validDate(s["expires"]))
    )
      issues.push(`${path}.expires: must be a date YYYY-MM-DD, got ${quote(s["expires"])}`);
    if (issues.length === before)
      out.push({
        rule: s["rule"] as R,
        fingerprint: s["fingerprint"] as string,
        reason: s["reason"] as string,
        ...(typeof s["expires"] === "string" ? { expires: s["expires"] } : {}),
      });
  });
  return out;
}

/** The `audit` section: `rules` (levels of audit rules), `unknown`, `suppressions`. */
function parseAuditSection(
  raw: unknown,
  inherited: UnknownHandling,
  issues: string[],
): AuditPolicy | undefined {
  if (!isRecord(raw)) {
    issues.push(`audit: must be an object with rules, unknown and suppressions`);
    return undefined;
  }
  for (const k of Object.keys(raw))
    if (!["rules", "unknown", "suppressions"].includes(k))
      issues.push(`audit.${k}: unknown key (allowed: rules, unknown, suppressions)`);
  const section = auditPolicyOf(undefined);
  section.unknown = inherited;
  // rules added after the section could be written run at warn when it does not list them
  for (const id of AUDIT_LATER_RULES) section.rules[id] = { level: "warn" };
  const rawRules = raw["rules"];
  if (rawRules !== undefined && !isRecord(rawRules)) issues.push(`audit.rules: must be an object`);
  else
    for (const [id, cfg] of Object.entries(rawRules ?? {})) {
      const path = `audit.rules.${id}`;
      if (!(AUDIT_RULES as readonly string[]).includes(id)) {
        issues.push(`${path}: unknown audit rule (known: ${AUDIT_RULES.join(", ")})`);
        continue;
      }
      if (!isRecord(cfg)) {
        issues.push(`${path}: must be an object like { "level": "fail" }`);
        continue;
      }
      for (const k of Object.keys(cfg))
        if (k !== "level") issues.push(`${path}.${k}: unknown key (allowed: level)`);
      const level = cfg["level"];
      if (level !== "fail" && level !== "warn" && level !== "off") {
        issues.push(`${path}.level: must be "fail", "warn" or "off", got ${quote(level)}`);
        continue;
      }
      section.rules[id as AuditRuleId] = { level };
    }
  if (raw["unknown"] !== undefined) {
    const u = raw["unknown"];
    if (u === "fail" || u === "warn" || u === "allow") section.unknown = u;
    else issues.push(`audit.unknown: must be "fail", "warn" or "allow", got ${quote(u)}`);
  }
  section.suppressions = parseSuppressions(
    raw["suppressions"],
    "audit.suppressions",
    AUDIT_RULES,
    issues,
  );
  return section;
}

/**
 * Reads and validates a policy. Every problem is reported at once with its JSON path; nothing
 * unknown is ignored, so a misspelt rule or key is an error rather than a rule that never runs.
 * Rules the file does not list run at level `fail`.
 */
export function parsePolicy(text: string, file: string): LoadedPolicy {
  if (Buffer.byteLength(text) > MAX_POLICY_BYTES)
    throw new PolicyError(`${file} is not a policy`, [
      `larger than ${MAX_POLICY_BYTES} bytes; a policy is a short JSON file`,
    ]);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new PolicyError(`${file} is not valid JSON`, [(error as Error).message]);
  }
  const issues: string[] = [];
  if (!isRecord(raw))
    throw new PolicyError(`invalid policy ${file}`, ["the file must be an object"]);
  for (const k of Object.keys(raw))
    if (!["$schema", "hexvero", "version", "rules", "unknown", "suppressions", "audit"].includes(k))
      issues.push(
        `${k}: unknown key (allowed: hexvero, version, rules, unknown, suppressions, audit)`,
      );
  if (raw["hexvero"] !== "policy")
    issues.push(`hexvero: must be "policy", got ${quote(raw["hexvero"])}`);
  if (raw["version"] !== 1)
    issues.push(`version: this hexvero reads policy version 1, got ${quote(raw["version"])}`);
  if (raw["$schema"] !== undefined && typeof raw["$schema"] !== "string")
    issues.push(`$schema: must be a string`);

  const rules = {} as Record<PolicyRuleId, RuleConfig>;
  // A rule a policy does not list runs at fail, except rules added after a policy could have been
  // written for them: they start at warn, so an upgrade never turns a passing check red.
  for (const id of POLICY_RULES) rules[id] = { level: LATER_RULES.has(id) ? "warn" : "fail" };
  const rawRules = raw["rules"];
  // a policy only for `hexvero audit` may leave the check rules out: they then run as with `{}`
  if (rawRules === undefined) {
    if (raw["audit"] === undefined)
      issues.push(`rules: missing (an object with one entry per rule)`);
  } else if (!isRecord(rawRules)) issues.push(`rules: must be an object`);
  else
    for (const [id, cfg] of Object.entries(rawRules)) {
      if (!(POLICY_RULES as readonly string[]).includes(id)) {
        issues.push(`rules.${id}: unknown rule (known: ${POLICY_RULES.join(", ")})`);
        continue;
      }
      const path = `rules.${id}`;
      if (!isRecord(cfg)) {
        issues.push(`${path}: must be an object like { "level": "fail" }`);
        continue;
      }
      const allowed = id === "new-external-host" ? ["level", "allow"] : ["level"];
      for (const k of Object.keys(cfg))
        if (!allowed.includes(k))
          issues.push(`${path}.${k}: unknown key (allowed: ${allowed.join(", ")})`);
      const level = cfg["level"];
      if (level !== "fail" && level !== "warn" && level !== "off") {
        issues.push(`${path}.level: must be "fail", "warn" or "off", got ${quote(level)}`);
        continue;
      }
      const rule: RuleConfig = { level };
      if (cfg["allow"] !== undefined) {
        if (!Array.isArray(cfg["allow"])) issues.push(`${path}.allow: must be a list of hosts`);
        else {
          const list: string[] = [];
          cfg["allow"].forEach((entry, i) => {
            if (typeof entry !== "string" || !validAllowEntry(entry))
              issues.push(
                `${path}.allow[${i}]: ${quote(entry)} is not a host name, "*.domain", IPv4 or [IPv6] address (lower case, no scheme, port or path)`,
              );
            else list.push(entry);
          });
          rule.allow = list;
        }
      }
      rules[id as PolicyRuleId] = rule;
    }

  let unknown: UnknownHandling = "fail";
  if (raw["unknown"] !== undefined) {
    const u = raw["unknown"];
    if (u === "fail" || u === "warn" || u === "allow") unknown = u;
    else issues.push(`unknown: must be "fail", "warn" or "allow", got ${quote(u)}`);
  }

  const suppressions = parseSuppressions(raw["suppressions"], "suppressions", POLICY_RULES, issues);
  const audit =
    raw["audit"] === undefined ? undefined : parseAuditSection(raw["audit"], unknown, issues);

  if (issues.length) throw new PolicyError(`invalid policy ${file}`, issues);
  return {
    policy: {
      hexvero: "policy",
      version: 1,
      rules,
      unknown,
      suppressions,
      ...(audit ? { audit } : {}),
    },
    file,
    sha256: sha256(text),
  };
}

/** Reads a baseline file written by `createBaseline`; anything else is refused. */
export function parseBaseline(text: string, file: string): LoadedBaseline {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new PolicyError(`${file} is not valid JSON`, [(error as Error).message]);
  }
  const issues: string[] = [];
  if (!isRecord(raw))
    throw new PolicyError(`invalid baseline ${file}`, ["the file must be an object"]);
  if (raw["command"] === "audit")
    throw new PolicyError(`invalid baseline ${file}`, [
      'command: "audit": this baseline was written by hexvero audit; hexvero check needs one written by check --update-baseline',
    ]);
  if (raw["command"] !== undefined && raw["command"] !== "check")
    issues.push(`command: must be "check" or left out, got ${quote(raw["command"])}`);
  if (raw["hexvero"] !== "baseline")
    issues.push(`hexvero: must be "baseline", got ${quote(raw["hexvero"])}`);
  if (raw["version"] !== 1)
    issues.push(`version: this hexvero reads baseline version 1, got ${quote(raw["version"])}`);
  for (const k of ["created", "policy", "a", "b"])
    if (typeof raw[k] !== "string") issues.push(`${k}: must be a string`);
  const fingerprints: BaselineFile["fingerprints"] = [];
  if (!Array.isArray(raw["fingerprints"])) issues.push(`fingerprints: must be a list`);
  else
    raw["fingerprints"].forEach((f: unknown, i: number) => {
      if (
        !isRecord(f) ||
        typeof f["rule"] !== "string" ||
        typeof f["fingerprint"] !== "string" ||
        !FINGERPRINT.test(f["fingerprint"]) ||
        typeof f["key"] !== "string"
      )
        issues.push(`fingerprints[${i}]: must be { "rule", "fingerprint" (32 hex), "key" }`);
      else fingerprints.push({ rule: f["rule"], fingerprint: f["fingerprint"], key: f["key"] });
    });
  if (issues.length) throw new PolicyError(`invalid baseline ${file}`, issues);
  const b = raw as Record<string, string>;
  return {
    baseline: {
      hexvero: "baseline",
      version: 1,
      created: b["created"]!,
      policy: b["policy"]!,
      a: b["a"]!,
      b: b["b"]!,
      fingerprints,
    },
    file,
  };
}

/**
 * The baseline that accepts every finding of `result` that is not already suppressed by the
 * policy. Sorted, so the same findings give the same file apart from `created`.
 */
export function createBaseline(result: PolicyResult, now: Date = new Date()): BaselineFile {
  const seen = new Set<string>();
  const fingerprints: BaselineFile["fingerprints"] = [];
  for (const f of result.findings) {
    if (f.state === "suppressed" || seen.has(f.fingerprint)) continue;
    seen.add(f.fingerprint);
    fingerprints.push({ rule: f.rule, fingerprint: f.fingerprint, key: f.key });
  }
  fingerprints.sort((x, y) =>
    x.rule === y.rule ? (x.fingerprint < y.fingerprint ? -1 : 1) : x.rule < y.rule ? -1 : 1,
  );
  return {
    hexvero: "baseline",
    version: 1,
    created: now.toISOString(),
    policy: result.policy.sha256,
    a: result.a.sha256,
    b: result.b.sha256,
    fingerprints,
  };
}

/**
 * Reads a baseline written by `hexvero audit --update-baseline`; a check baseline and anything
 * else is refused with what is wrong.
 */
export function parseAuditBaseline(text: string, file: string): LoadedAuditBaseline {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new PolicyError(`${file} is not valid JSON`, [(error as Error).message]);
  }
  if (!isRecord(raw))
    throw new PolicyError(`invalid baseline ${file}`, ["the file must be an object"]);
  if (raw["hexvero"] === "baseline" && raw["command"] === undefined && "a" in raw)
    throw new PolicyError(`invalid baseline ${file}`, [
      "this baseline was written by hexvero check (it has no command and names two builds); hexvero audit needs one written by audit --update-baseline",
    ]);
  const issues: string[] = [];
  if (raw["hexvero"] !== "baseline")
    issues.push(`hexvero: must be "baseline", got ${quote(raw["hexvero"])}`);
  if (raw["version"] !== 1)
    issues.push(`version: this hexvero reads baseline version 1, got ${quote(raw["version"])}`);
  if (raw["command"] !== "audit")
    issues.push(`command: must be "audit", got ${quote(raw["command"])}`);
  for (const k of ["created", "build"])
    if (typeof raw[k] !== "string") issues.push(`${k}: must be a string`);
  if (raw["policy"] !== null && typeof raw["policy"] !== "string")
    issues.push(`policy: must be a sha256 string or null`);
  const fingerprints: AuditBaselineFile["fingerprints"] = [];
  if (!Array.isArray(raw["fingerprints"])) issues.push(`fingerprints: must be a list`);
  else
    raw["fingerprints"].forEach((f: unknown, i: number) => {
      if (
        !isRecord(f) ||
        !(AUDIT_RULES as readonly unknown[]).includes(f["rule"]) ||
        typeof f["fingerprint"] !== "string" ||
        !FINGERPRINT.test(f["fingerprint"]) ||
        typeof f["key"] !== "string"
      )
        issues.push(
          `fingerprints[${i}]: must be { "rule" (an audit rule), "fingerprint" (32 hex), "key" }`,
        );
      else
        fingerprints.push({
          rule: f["rule"] as AuditRuleId,
          fingerprint: f["fingerprint"],
          key: f["key"],
        });
    });
  if (issues.length) throw new PolicyError(`invalid baseline ${file}`, issues);
  return {
    baseline: {
      hexvero: "baseline",
      version: 1,
      command: "audit",
      created: raw["created"] as string,
      policy: raw["policy"] as string | null,
      build: raw["build"] as string,
      fingerprints,
    },
    file,
  };
}

/**
 * The audit baseline that accepts every finding of `result` that the policy does not suppress
 * (an expired suppression's finding is accepted, but stays counted while the suppression names
 * it). Sorted, so the same findings give the same file apart from `created`.
 */
export function createAuditBaseline(
  result: Pick<AuditResult, "findings" | "target" | "policy">,
  now: Date = new Date(),
): AuditBaselineFile {
  const seen = new Set<string>();
  const fingerprints: AuditBaselineFile["fingerprints"] = [];
  for (const f of result.findings) {
    if (f.state === "suppressed" || seen.has(f.fingerprint)) continue;
    seen.add(f.fingerprint);
    fingerprints.push({ rule: f.rule, fingerprint: f.fingerprint, key: f.key });
  }
  fingerprints.sort((x, y) =>
    x.rule === y.rule ? (x.fingerprint < y.fingerprint ? -1 : 1) : x.rule < y.rule ? -1 : 1,
  );
  return {
    hexvero: "baseline",
    version: 1,
    command: "audit",
    created: now.toISOString(),
    policy: result.policy?.sha256 ?? null,
    build: result.target.sha256,
    fingerprints,
  };
}

export function fingerprintOf(rule: PolicyRuleId, identity: string): string {
  return sha256(`${rule}\0${identity}`).slice(0, 32);
}

// ---------------------------------------------------------------------------------------------
// Adapters for contract C3 / C1. Until ChangeRow.id and ReleaseComparison.completeness land
// (owner B), they are computed here from what the comparison already carries. Once B's fields
// exist, these functions use them as they are; nothing else here needs to change.
// ---------------------------------------------------------------------------------------------

/** TODO(C3): use `row.id` only once every ChangeRow carries it. */
export function rowId(row: ChangeRow): string {
  const id = (row as ChangeRow & { id?: unknown }).id;
  if (typeof id === "string" && id) return id;
  return sha256(`${row.collection}\0${row.change}\0${row.key}`).slice(0, 16);
}

interface Completeness {
  complete: boolean;
  gaps: string[];
}

/**
 * Completeness of one list of the comparison, as the comparison reports it (C1). A list the
 * comparison names no completeness for exists on neither side: nothing was found, which is
 * complete unless an application was read only in part.
 */
export function completenessOf(r: ReleaseComparison, collection: string): Completeness {
  const c = r.completeness[collection];
  if (c) return { complete: c.complete, gaps: [...c.gaps] };
  return r.overview.partialScan.a || r.overview.partialScan.b
    ? { complete: false, gaps: ["scan_partial"] }
    : { complete: true, gaps: [] };
}

/** The lists the rules read that each kind of analysis produces. */
const KIND_LISTS: Record<string, ReadonlySet<string>> = {
  "javascript-app": new Set([
    "interfaces",
    "contextBridge",
    "bridgeExposures",
    "remoteEnabled",
    "switches",
    "openExternal",
    "permissionHandlers",
    "csp",
    "navigationHandlers",
    "dangerousCalls",
    "webviews",
    "protocols",
    "loads",
    "windows",
    "endpoints",
    "urls",
    "runtime",
  ]),
  javascript: new Set(["endpoints", "urls"]),
};
/** The kind of analysis a format gives, for a comparison evaluated without `sides`. */
const FORMAT_KIND: Record<string, string> = {
  asar: "javascript-app",
  directory: "javascript-app",
  javascript: "javascript",
};

/** True when `kind` is an analysis `hexvero check` can apply a policy to. */
export function checkableKind(kind: string): boolean {
  return kind in KIND_LISTS;
}

// ---------------------------------------------------------------------------------------------
// Semantic identities
// ---------------------------------------------------------------------------------------------

/** The identity a list is matched by when the overview does not name one (a list one side has). */
const DEFAULT_KEYS: Record<string, string> = {
  bridgeExposures: "file+api+member+exposed",
  remoteEnabled: "file+kind+targetKind+window",
  switches: "file+kind+targetKind+name",
  openExternal: "file+targetKind+argumentKind+argument",
  permissionHandlers: "file+kind+targetKind+session",
  csp: "file+kind+via",
  dangerousCalls: "file+method+targetKind+argumentKind+argument",
  webviews: "file+kind+src",
  protocols: "file+kind+scheme",
  loads: "file+kind+targetKind+window+argumentKind+argument",
  interfaces: "file+api+member",
  contextBridge: "api+member",
  windows: "file+windowName",
  endpoints: "file+kind+value",
  urls: "file+value",
  runtime: "item",
};

/** Fields that say where an item sits, not what it is. */
const POSITION_FIELDS = new Set(["line", "column", "offset", "lines", "location", "window"]);

/**
 * The fields of a row's item, recovered from its label: the label is the key fields joined by
 * `::` (when the comparison names a composite key and the label splits into exactly that many
 * parts) or the item as canonical JSON. Null when neither reading is unambiguous.
 */
function fieldsOf(r: ReleaseComparison, row: ChangeRow): Record<string, unknown> | null {
  if (row.key.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(row.key);
      if (isRecord(parsed)) return parsed;
    } catch {
      // not JSON after all: fall through to the key reading
    }
  }
  const key =
    r.overview.collections.find((c) => c.collection === row.collection)?.key ??
    DEFAULT_KEYS[row.collection];
  if (!key) return null;
  const names = key.split("+");
  const parts = row.key.split("::");
  if (parts.length !== names.length) return null;
  return Object.fromEntries(names.map((n, i) => [n, parts[i]]));
}

/** JSON with sorted keys and position fields removed: an identity that ignores lines. */
function stableJson(item: Record<string, unknown>): string {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(item).toSorted()) if (!POSITION_FIELDS.has(k)) out[k] = item[k];
  return JSON.stringify(out);
}

/** `api.member` of an interface or bridge row; the preload file is not part of it. */
function memberIdentity(r: ReleaseComparison, row: ChangeRow): { id: string; label: string } {
  const f = fieldsOf(r, row);
  if (f && typeof f["api"] === "string" && f["member"] !== undefined) {
    const label =
      f["member"] === null || f["member"] === "null"
        ? f["api"]
        : `${f["api"]}.${String(f["member"])}`;
    return { id: `member\0${f["api"]}\0${String(f["member"])}`, label };
  }
  if (f && row.key.startsWith("{")) return { id: `item\0${stableJson(f)}`, label: row.key };
  // A label that cannot be split unambiguously is its own identity. It carries no line either.
  return { id: `label\0${row.collection}\0${row.key}`, label: row.key };
}

/** The URL-like value of an endpoints or urls row. */
function valueOf(r: ReleaseComparison, row: ChangeRow): string {
  const f = fieldsOf(r, row);
  if (f && typeof f["value"] === "string") return f["value"];
  if (f && typeof f["url"] === "string") return f["url"];
  // WHATWG normalization first; `s` in case a line break survives (an escaped `\n` in a literal)
  const key = urlInput(row.key);
  const m = /[a-z][a-z0-9+.-]*:\/\/.*$/is.exec(key) ?? /\$\{.*$/s.exec(key);
  return m ? m[0] : row.key;
}

/**
 * A URL string as the WHATWG URL parser reads it: leading and trailing C0 controls and spaces
 * removed, and every tab, line feed and carriage return removed wherever it is, so
 * `"\u0001https://evil.example"` and `"ht\ttps://evil.example"` are the hosts fetch would use.
 */
const removable = (c: string): boolean => c.charCodeAt(0) <= 0x20;
function urlInput(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && removable(value[start]!)) start++;
  while (end > start && removable(value[end - 1]!)) end--;
  return value.slice(start, end).replace(/[\t\n\r]/g, "");
}

const NETWORK_SCHEMES = new Set(["http:", "https:", "ws:", "wss:", "ftp:"]);

export type HostReading =
  | { kind: "host"; host: string }
  | { kind: "none" }
  | { kind: "unknown"; why: string };

/**
 * The host a URL-like value talks to. `none` for values that reach no network host (a relative
 * path, `file:`, `data:`, an app scheme, loopback); `unknown` when the host is built at run time
 * (`https://${region}.api.example.com`) or cannot be read; a template is never a pass.
 */
export function hostOf(value: string): HostReading {
  const v = urlInput(value);
  if (v.startsWith("${") || v.startsWith("`"))
    return { kind: "unknown", why: "the start of the URL is computed at run time" };
  // Read the authority the way a WHATWG URL parser does for special schemes: any run of slashes
  // or backslashes after the scheme, or none at all (`http:evil.com` is evil.com), so a value a
  // browser or fetch would send to a host is never mistaken for one that reaches none.
  let scheme: string;
  let rest: string;
  const sm = /^([a-z][a-z0-9+.-]*):/i.exec(v);
  if (sm) {
    scheme = `${sm[1]!.toLowerCase()}:`;
    if (!NETWORK_SCHEMES.has(scheme)) return { kind: "none" };
    rest = v.slice(sm[0].length);
  } else if (/^[/\\]{2}/.test(v)) {
    scheme = "https:"; // protocol-relative: the page's scheme, a network one for a web page
    rest = v;
  } else return { kind: "none" };
  const authority = rest.replace(/^[/\\]*/, "").split(/[/\\?#]/)[0] ?? "";
  if (/\$\{|[`{}]/.test(authority) || authority === "")
    return { kind: "unknown", why: "the host is computed at run time" };
  let host: string;
  try {
    host = new URL(`${scheme}//${authority}/`).hostname.toLowerCase();
  } catch {
    return { kind: "unknown", why: "the host could not be read" };
  }
  if (host === "") return { kind: "unknown", why: "the host could not be read" };
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    /^127\.\d+\.\d+\.\d+$/.test(host) ||
    host === "[::1]" ||
    host === "0.0.0.0"
  )
    return { kind: "none" };
  return { kind: "host", host: host.replace(/\.$/, "") };
}

/**
 * True when the host a request target can reach is known although part of the value is computed:
 * the value is plain, or its computed parts all come after a literal scheme that reaches no
 * host (`file://${path}`), or after a literal network host that a `/`, `?` or `#` closes
 * (`https://api.example.com/users/${id}`). A value that could not be read at all (`null`), one
 * without a literal scheme (`/${p}` may become `//elsewhere.example`), and one whose computed part
 * comes before the end of its host (`https://${region}.example.com`, `https://a.example${x}`) can
 * reach any host.
 */
export function hostKnown(value: string | null | undefined, evidence?: unknown): boolean {
  if (typeof value !== "string") return false;
  if (!value.includes("${")) return true;
  // a computed value is trusted only as the reader wrote it: text and gaps of the argument
  if (evidence !== undefined && evidence !== "template") return false;
  if (hostOf(value).kind === "unknown") return false;
  const v = urlInput(value);
  const literal = v.slice(0, v.indexOf("${"));
  const sm = /^([a-z][a-z0-9+.-]*):/i.exec(literal);
  if (!sm) return false;
  if (!NETWORK_SCHEMES.has(`${sm[1]!.toLowerCase()}:`)) return true;
  // the authority must end inside the literal part
  return /[/\\?#]/.test(literal.slice(sm[0].length).replace(/^[/\\]*/, ""));
}

/**
 * True when every request target a build names has a known host (`hostKnown`) and no limitation
 * says targets exist that are not listed. Then the values hexvero could not resolve in its
 * `endpoints` and `urls` cannot hide a host, and they do not leave `new-external-host` open.
 */
function targetHostsKnown(
  r: ReleaseComparison,
  sides: CheckSides | undefined,
  side: "a" | "b",
): boolean {
  if (!sides) return false;
  if (r.limitations[side].some((l) => UNRESOLVED_LIMITATIONS[l.code] === "endpoint")) return false;
  for (const collection of ["endpoints", "urls"]) {
    const items = sides.items[side][collection];
    if (!items) continue;
    for (const item of items) {
      if (!isRecord(item)) return false;
      const v = item["value"] ?? item["url"];
      if (!hostKnown(typeof v === "string" ? v : null, item["evidence"] ?? "missing")) return false;
    }
  }
  return true;
}

/** The reason a comparison gives an item found next to values it could not resolve. */
const NEXT_TO_UNRESOLVED = "the other side has values there that could not be resolved";

/** Exact entries match the host itself; `*.d` matches every subdomain of d, not d. */
export function hostAllowed(host: string, allow: readonly string[]): boolean {
  return allow.some((entry) =>
    entry.startsWith("*.")
      ? host.endsWith(entry.slice(1)) && host.length > entry.length - 1
      : host === entry,
  );
}

// ---------------------------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------------------------

/** Text from a target as one plain line: no control characters, at most 300 characters. */
export function plain(text: string): string {
  const flat = [...text]
    .map((c) => {
      const code = c.codePointAt(0)!;
      return code < 32 ||
        code === 0x7f ||
        (code >= 0x80 && code < 0xa0) ||
        code === 0x2028 ||
        code === 0x2029
        ? " "
        : c;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > 300 ? `${flat.slice(0, 299)}…` : flat;
}

/**
 * What a check knows about each build beyond the comparison: the kind of analysis and every item
 * of the lists the rules read. Without it, the kind follows the format and the before build's
 * items are only those the comparison lists as removed.
 */
export interface CheckSides {
  kind: { a: string; b: string };
  items: {
    a: Partial<Record<string, readonly unknown[]>>;
    b: Partial<Record<string, readonly unknown[]>>;
  };
}

export interface EvaluateOptions {
  baseline?: LoadedBaseline | undefined;
  /**
   * checkRelease only: compute content digests of app directories (`a.sha256` / `b.sha256`),
   * which reads every listed file. Always done when `baseline` is set; set it to write one.
   */
  digest?: boolean | undefined;
  sides?: CheckSides | undefined;
  /** The day suppressions are judged against; default now. */
  now?: Date | undefined;
}

interface Draft {
  rule: PolicyRuleId;
  identity: string;
  row: ChangeRow;
  key: string;
  message: string;
  where: Place[];
  unknown: boolean;
}

const RULE_COLLECTIONS: Record<PolicyRuleId, (r: ReleaseComparison) => string[]> = {
  "new-interface-member": (r) => {
    const present = new Set([
      ...r.overview.collections.map((c) => c.collection),
      ...r.overview.onlyA,
      ...r.overview.onlyB,
    ]);
    return present.has("interfaces") || !present.has("contextBridge")
      ? ["interfaces"]
      : ["contextBridge"];
  },
  "new-external-host": () => ["endpoints", "urls"],
  "window-more-permissive": () => ["windows"],
  "new-bridge-exposure": () => ["bridgeExposures"],
  "fuse-weakened": () => ["runtime"],
  "remote-enabled": () => ["remoteEnabled"],
  "new-unsafe-switch": () => ["switches"],
  "new-open-external": () => ["openExternal"],
  "permission-handler-grants-all": () => ["permissionHandlers"],
  "csp-weakened": () => ["csp"],
  "navigation-limit-removed": () => ["navigationHandlers"],
  "new-dangerous-call": () => ["dangerousCalls"],
  "new-insecure-webview": () => ["webviews"],
  "new-custom-protocol": () => ["protocols"],
  "new-http-resource": () => ["loads"],
};

/**
 * Lists whose completeness decides a rule besides the ones its findings come from. Which members
 * a preload exposes is read from the bridge itself, so the bridge decides "new interface member".
 */
const RULE_COVERAGE: Record<PolicyRuleId, (r: ReleaseComparison) => string[]> = {
  "new-interface-member": () => ["contextBridge"],
  "new-external-host": () => [],
  "window-more-permissive": () => [],
  // what a preload hands to pages is read from the bridge: an unreadable member is a gap here too
  "new-bridge-exposure": () => ["contextBridge"],
  "fuse-weakened": () => [],
  "remote-enabled": () => [],
  "new-unsafe-switch": () => [],
  "new-open-external": () => [],
  "permission-handler-grants-all": () => [],
  "csp-weakened": () => [],
  "navigation-limit-removed": () => [],
  "new-dangerous-call": () => [],
  "new-insecure-webview": () => [],
  "new-custom-protocol": () => [],
  "new-http-resource": () => [],
};

/**
 * Gaps that do not bear on a rule in a list it reads. For the interface rule, a value hexvero
 * could not resolve in `interfaces` is a channel name: it decides which handler a member reaches,
 * not whether the member exists (an unreadable bridge member is a gap of `contextBridge` itself).
 * Every other gap of `interfaces` (budget, unread files, truncation) still counts.
 */
const IRRELEVANT_GAPS: Partial<Record<PolicyRuleId, Record<string, readonly string[]>>> = {
  "new-interface-member": { interfaces: ["values_unresolved"] },
  // the runtime is read from the build's binary and metadata, not by the JavaScript scan
  "fuse-weakened": { runtime: ["scan_partial", "files_unread", "files_unreadable"] },
};

function mergePlaces(into: Place[], more: readonly Place[]): void {
  for (const p of more)
    if (
      !into.some(
        (q) => q.side === p.side && q.file === p.file && q.line === p.line && q.role === p.role,
      )
    )
      into.push(p);
}

/** One draft per semantic identity: duplicates become one finding with every place. */
function collect(drafts: Draft[]): Draft[] {
  const by = new Map<string, Draft>();
  for (const d of drafts) {
    const id = `${d.rule}\0${d.identity}`;
    const prior = by.get(id);
    if (!prior) by.set(id, { ...d, where: [...d.where] });
    else {
      mergePlaces(prior.where, d.where);
      // a definite reading wins over an unknown one of the same item
      if (prior.unknown && !d.unknown) Object.assign(prior, { ...d, where: prior.where });
    }
  }
  return [...by.values()];
}

/**
 * The items of `collection` on side a: every item when the check has them, else the ones the
 * comparison lists as removed (read back from their labels).
 */
function beforeItems(
  r: ReleaseComparison,
  collection: string,
  sides: CheckSides | undefined,
): Array<Record<string, unknown>> {
  const all = sides?.items.a[collection];
  if (all) return all.filter(isRecord);
  return r.changes
    .filter((row) => row.collection === collection && row.change === "removed")
    .map((row) => fieldsOf(r, row) ?? { label: row.key });
}

/** `member\0api\0member` of every member the before build exposes. */
function beforeMembers(r: ReleaseComparison, sides: CheckSides | undefined): Set<string> {
  const out = new Set<string>();
  for (const collection of ["interfaces", "contextBridge"])
    for (const item of beforeItems(r, collection, sides))
      if (typeof item["api"] === "string" && item["member"] !== undefined)
        out.add(`member\0${item["api"]}\0${String(item["member"])}`);
  return out;
}

/** Hosts and raw values of every request target the before build names. */
function beforeTargets(
  r: ReleaseComparison,
  sides: CheckSides | undefined,
): { hosts: Set<string>; values: Set<string> } {
  const hosts = new Set<string>();
  const values = new Set<string>();
  for (const collection of ["endpoints", "urls"])
    for (const item of beforeItems(r, collection, sides)) {
      const v = item["value"] ?? item["url"];
      if (typeof v !== "string") continue;
      values.add(v);
      const reading = hostOf(v);
      if (reading.kind === "host") hosts.add(reading.host);
    }
  return { hosts, values };
}

function interfaceDrafts(
  r: ReleaseComparison,
  collection: string,
  sides: CheckSides | undefined,
): Draft[] {
  const out: Draft[] = [];
  const before = beforeMembers(r, sides);
  for (const row of r.changes) {
    if (row.collection !== collection || (row.change !== "added" && row.change !== "unknown"))
      continue;
    const { id, label } = memberIdentity(r, row);
    // exposed before from another file (a moved preload, a renamed chunk): not new
    if (before.has(id)) continue;
    const unknown = row.change === "unknown";
    out.push({
      rule: "new-interface-member",
      identity: id,
      row,
      key: label,
      message: unknown
        ? `Interface member ${plain(label)} may be new: ${plain(row.reason ?? "the comparison could not tell")}.`
        : `New interface member ${plain(label)} is exposed to pages.`,
      where: row.where,
      unknown,
    });
  }
  return out;
}

function hostDrafts(
  r: ReleaseComparison,
  allow: readonly string[],
  sides: CheckSides | undefined,
): Draft[] {
  const out: Draft[] = [];
  // A host the before build already named, in any file or with any path, is not a new host.
  const before = beforeTargets(r, sides);
  // When every target of the before build has a known host, an item that sits next to values it
  // could not resolve is new exactly when its host is not one of them.
  const beforeKnown = targetHostsKnown(r, sides, "a");
  for (const row of r.changes) {
    if (row.collection !== "endpoints" && row.collection !== "urls") continue;
    if (row.change !== "added" && row.change !== "unknown") continue;
    const value = valueOf(r, row);
    const reading = hostOf(value);
    if (reading.kind === "none") continue;
    if (reading.kind === "unknown") {
      if (before.values.has(value)) continue;
      // Without a host the value itself (minus where it sits) is what the finding is about.
      out.push({
        rule: "new-external-host",
        identity: `template\0${value}`,
        row,
        key: value,
        message: `A new request target ${plain(value)} goes to a host that is not known: ${reading.why}.`,
        where: row.where,
        unknown: true,
      });
      continue;
    }
    if (hostAllowed(reading.host, allow) || before.hosts.has(reading.host)) continue;
    const unknown = row.change === "unknown" && !(beforeKnown && row.reason === NEXT_TO_UNRESOLVED);
    out.push({
      rule: "new-external-host",
      identity: `host\0${reading.host}`,
      row,
      key: reading.host,
      message: unknown
        ? `Host ${plain(reading.host)} may be new (${plain(value)}): ${plain(row.reason ?? "the comparison could not tell")}.`
        : `New external host ${plain(reading.host)}, not in the allow list (${plain(value)}).`,
      where: row.where,
      unknown,
    });
  }
  return out;
}

/**
 * A privileged object a preload newly hands to pages as it is (`bridgeExposures`): `ipcRenderer`, a
 * method of it, `shell`, the `electron` module, a Node module or `process`. The same exposure in
 * another file of the before build (a moved preload) is not new. An exposure hexvero kept but
 * could not decide (`undecided`: a budget, an open scope) is a finding that may be new.
 */
/** An exposure's identity: what is handed to which name, without the file it sits in. */
const exposureIdentity = (f: Record<string, unknown>): string =>
  `exposure\0${String(f["api"])}\0${String(f["member"])}\0${String(f["exposed"])}`;

function exposureDrafts(r: ReleaseComparison, sides: CheckSides | undefined): Draft[] {
  const out: Draft[] = [];
  const identityOf = exposureIdentity;
  const before = new Set(beforeItems(r, "bridgeExposures", sides).map(identityOf));
  const after = (sides?.items.b["bridgeExposures"] ?? []).filter(isRecord);
  for (const row of r.changes) {
    if (
      row.collection !== "bridgeExposures" ||
      (row.change !== "added" && row.change !== "unknown")
    )
      continue;
    const f = fieldsOf(r, row);
    if (!f || typeof f["api"] !== "string" || f["exposed"] === undefined) {
      // A label that cannot be split (a name from the target holding "::") is never dropped: it
      // is an exposure that may be new, under its label.
      out.push({
        rule: "new-bridge-exposure",
        identity: `label\0bridgeExposures\0${row.key}`,
        row,
        key: row.key,
        message: `Pages may get a privileged object (${plain(row.key)}): the exposure could not be read back from the comparison.`,
        where: row.where,
        unknown: true,
      });
      continue;
    }
    const identity = identityOf(f);
    if (before.has(identity)) continue;
    const item = after.find(
      (i) => String(i["file"]) === String(f["file"]) && identityOf(i) === identity,
    );
    const undecided = typeof item?.["undecided"] === "string" ? String(item["undecided"]) : null;
    const unknown = row.change === "unknown" || undecided !== null;
    const member = f["member"] === null || f["member"] === "null" ? null : String(f["member"]);
    const label = member === null ? `window.${f["api"]}` : `window.${f["api"]}.${member}`;
    const exposed = plain(String(f["exposed"]));
    out.push({
      rule: "new-bridge-exposure",
      identity,
      row,
      key: `${f["api"]}${member === null ? "" : `.${member}`}`,
      message: unknown
        ? `Pages may get ${exposed} as ${plain(label)}: ${plain(undecided ? `not decided (${undecided})` : (row.reason ?? "the comparison could not tell"))}.`
        : `Pages get ${exposed} as ${plain(label)}, handed over as it is, not wrapped.`,
      where: row.where,
      unknown,
    });
  }
  return out;
}

/**
 * `@electron/remote` newly turned on for a webContents (`remoteEnabled`, kind `enable`): for a
 * window, for every webContents (`app`), for a webContents a helper is handed (`unknown`) or for
 * another receiver. The same target enabled in the before build (in any file) is not new.
 */
const remoteIdentity = (f: Record<string, unknown>): string =>
  `remote\0${String(f["targetKind"])}\0${String(f["window"])}`;

function remoteDrafts(r: ReleaseComparison, sides: CheckSides | undefined): Draft[] {
  const out: Draft[] = [];
  const before = new Set(
    beforeItems(r, "remoteEnabled", sides)
      .filter((f) => f["kind"] === "enable")
      .map(remoteIdentity),
  );
  for (const row of r.changes) {
    if (row.collection !== "remoteEnabled" || (row.change !== "added" && row.change !== "unknown"))
      continue;
    const f = fieldsOf(r, row);
    if (!f || f["kind"] === undefined) {
      out.push({
        rule: "remote-enabled",
        identity: `label\0remoteEnabled\0${row.key}`,
        row,
        key: row.key,
        message: `@electron/remote may be turned on (${plain(row.key)}): the row could not be read back from the comparison.`,
        where: row.where,
        unknown: true,
      });
      continue;
    }
    if (f["kind"] !== "enable") continue;
    const identity = remoteIdentity(f);
    if (before.has(identity)) continue;
    const kind = String(f["targetKind"]);
    const whose =
      kind === "window"
        ? `window ${plain(String(f["window"]))}`
        : kind === "app"
          ? "every webContents (web-contents-created)"
          : kind === "unknown"
            ? "a webContents a helper is handed"
            : "a webContents";
    const unknown = row.change === "unknown";
    out.push({
      rule: "remote-enabled",
      identity,
      row,
      key: `enable ${whose}`,
      message: unknown
        ? `@electron/remote may be newly enabled for ${whose}: ${plain(row.reason ?? "the comparison could not tell")}.`
        : `@electron/remote is newly enabled for ${whose}: its pages reach main-process modules through the remote module.`,
      where: row.where,
      unknown,
    });
  }
  return out;
}

/**
 * A dangerous switch, or certificate errors accepted, that the before build does not have
 * (`switches`): a switch by name and value, a certificate handler or verify proc by kind and what
 * it accepts. A row whose danger could not be told (`dangerous: null`) is unknown.
 */
const switchIdentity = (f: Record<string, unknown>): string =>
  `switch\0${String(f["kind"])}\0${String(f["name"])}\0${String(f["value"])}\0${String(f["accepts"])}`;

function switchDrafts(r: ReleaseComparison, sides: CheckSides | undefined): Draft[] {
  const out: Draft[] = [];
  const before = new Set(beforeItems(r, "switches", sides).map(switchIdentity));
  for (const row of r.changes) {
    if (
      row.collection !== "switches" ||
      (row.change !== "added" && row.change !== "changed" && row.change !== "unknown")
    )
      continue;
    const keyed = fieldsOf(r, row);
    // the label holds the key fields only: the after side's items with those fields carry the rest
    const matches = keyed
      ? (sides?.items.b["switches"] ?? []).filter(
          (i): i is Record<string, unknown> =>
            isRecord(i) && Object.keys(keyed).every((n) => String(i[n]) === String(keyed[n])),
        )
      : [];
    const candidates: Array<Record<string, unknown>> = matches.length
      ? matches
      : keyed
        ? [fallbackSwitch(keyed)]
        : [];
    const seen = new Set<string>();
    for (const f of candidates) {
      const id = switchIdentity(f);
      if (seen.has(id)) continue;
      seen.add(id);
      const d = switchDraft(row, f, before);
      if (d) out.push(d);
    }
    if (!keyed || keyed["kind"] === undefined) {
      out.push({
        rule: "new-unsafe-switch",
        identity: `label\0switches\0${row.key}`,
        row,
        key: row.key,
        message: `A process-wide security check may be weakened (${plain(row.key)}): the row could not be read back from the comparison.`,
        where: row.where,
        unknown: true,
      });
    }
  }
  return out;
}

/** What a row's key fields alone say, when the after side's items are not at hand. */
function fallbackSwitch(keyed: Record<string, unknown>): Record<string, unknown> {
  const name = keyed["name"] === "null" ? null : keyed["name"];
  const kind = String(keyed["kind"]);
  // the key holds the name as read; judged as the scan judges it, with the value not at hand
  const judged =
    typeof name === "string" ? judgeSwitch(splitSwitch(name).key, "unknown", null) : null;
  return {
    ...keyed,
    name,
    value: null,
    accepts: undefined,
    dangerous:
      kind === "security-warnings"
        ? false
        : (kind === "switch" || kind === "argument") && judged?.dangerous === true
          ? true
          : null,
    reason: "the row's other fields could not be read back from the comparison",
  };
}

function switchDraft(
  row: ChangeRow,
  f: Record<string, unknown>,
  before: ReadonlySet<string>,
): Draft | null {
  {
    if (f["dangerous"] === false) return null;
    const identity = switchIdentity(f);
    if (before.has(identity)) return null;
    const kind = String(f["kind"]);
    const unknown = f["dangerous"] !== true || row.change === "unknown";
    const name = f["name"] === null ? "a switch whose name is not read" : String(f["name"]);
    const value = typeof f["value"] === "string" ? `=${String(f["value"])}` : "";
    const key =
      kind === "switch" || kind === "argument"
        ? `${kind} ${name}${value}`
        : `${kind} accepts ${String(f["accepts"])}`;
    const what =
      kind === "switch" || kind === "argument"
        ? `the command-line ${kind} ${plain(name + value)}`
        : kind === "certificate-error"
          ? `certificate errors accepted (${plain(String(f["accepts"]))})`
          : `a certificate verify proc that reports success (${plain(String(f["accepts"]))})`;
    return {
      rule: "new-unsafe-switch",
      identity: `${identity}\0${String(f["targetKind"])}`,
      row,
      key,
      message: unknown
        ? `The after build may weaken a process-wide security check: ${what}; ${plain(String(f["reason"] ?? "the comparison could not tell"))}.`
        : `The after build weakens a process-wide security check: ${what}${f["reason"] ? ` (${plain(String(f["reason"]))})` : ""}.`,
      where: row.where,
      unknown,
    };
  }
}

/**
 * The after side's items behind a row (its label holds the key fields only), or null when the
 * label cannot be read back or no item matches it.
 */
function afterItems(
  r: ReleaseComparison,
  row: ChangeRow,
  sides: CheckSides | undefined,
): Array<Record<string, unknown>> | null {
  const keyed = fieldsOf(r, row);
  if (!keyed) return null;
  const matches = (sides?.items.b[row.collection] ?? []).filter(
    (i): i is Record<string, unknown> =>
      // a field the item does not have is written `null` in the label
      isRecord(i) && Object.keys(keyed).every((n) => String(i[n] ?? null) === String(keyed[n])),
  );
  return matches.length ? matches : null;
}

/** A row of a security list whose item could not be read back: an unknown finding. */
function unreadDraft(rule: PolicyRuleId, row: ChangeRow, what: string): Draft {
  return {
    rule,
    identity: `label\0${row.collection}\0${row.key}`,
    row,
    key: row.key,
    message: `${what} (${plain(row.key)}): the row could not be read back from the comparison.`,
    where: row.where,
    unknown: true,
  };
}

/** How often each identity occurs. */
function counts(ids: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const id of ids) out.set(id, (out.get(id) ?? 0) + 1);
  return out;
}

const changedRows = (r: ReleaseComparison, collection: string): ChangeRow[] =>
  r.changes.filter(
    (row) =>
      row.collection === collection &&
      (row.change === "added" || row.change === "changed" || row.change === "unknown"),
  );

/**
 * A shell.openExternal call whose URL the app does not fix (`openExternalRisk`) that the before
 * build does not have: by receiver kind and as much of the URL as is read, in any file. A call on
 * a receiver not read as Electron's shell is unknown.
 */
const openIdentity = (f: Record<string, unknown>): string =>
  `open\0${String(f["targetKind"])}\0${String(f["argumentKind"])}\0${String(f["argument"])}`;

function openExternalDrafts(r: ReleaseComparison, sides: CheckSides | undefined): Draft[] {
  const out: Draft[] = [];
  // a multiset: a second call of the same kind is new even when the before build had one
  const before = counts(beforeItems(r, "openExternal", sides).map(openIdentity));
  const after = counts((sides?.items.b["openExternal"] ?? []).filter(isRecord).map(openIdentity));
  for (const row of changedRows(r, "openExternal")) {
    const items = afterItems(r, row, sides);
    if (!items) {
      out.push(unreadDraft("new-open-external", row, "A shell.openExternal call may be new"));
      continue;
    }
    for (const f of items) {
      const risk = openExternalRisk(f as unknown as OpenExternalRow);
      const identity = openIdentity(f);
      if (!risk || (after.get(identity) ?? 1) <= (before.get(identity) ?? 0)) continue;
      // one finding per identity, with the place of each new row (collect merges the places)
      const unknown = risk === "unknown" || row.change === "unknown";
      const url =
        f["argumentKind"] === "inferred" && typeof f["argument"] === "string"
          ? `a URL starting ${plain(JSON.stringify(f["argument"]))}`
          : f["argumentKind"] === "inferred"
            ? "one of a few URLs"
            : "a URL that is not read";
      out.push({
        rule: "new-open-external",
        identity,
        row,
        key: `${String(f["targetKind"])} openExternal ${String(f["argumentKind"])}${typeof f["argument"] === "string" ? ` ${String(f["argument"])}` : ""}`,
        message: unknown
          ? `The after build may newly open ${url} with shell.openExternal: ${f["targetKind"] === "unknown" ? "the receiver is not read as Electron's shell" : plain(row.reason ?? "the comparison could not tell")}.`
          : `The after build newly opens ${url} with shell.openExternal; its scheme is not fixed to http, https or mailto.`,
        where: row.where,
        unknown,
      });
    }
  }
  return out;
}

/** The request handlers of a list of permissionHandlers items. */
const requests = (list: Array<Record<string, unknown>>): Array<Record<string, unknown>> =>
  list.filter((f) => f["kind"] === "request");

/**
 * A permission handler that grants every request (`permissionRisk`) that the before build does
 * not have (by kind, session and receiver kind), and a before build's request handlers gone
 * without one left in the after build (Electron then grants every request).
 */
const permissionIdentity = (f: Record<string, unknown>): string =>
  `permission\0${String(f["kind"])}\0${String(f["targetKind"])}\0${String(f["session"])}\0${String(f["grants"])}`;

function permissionDrafts(r: ReleaseComparison, sides: CheckSides | undefined): Draft[] {
  const out: Draft[] = [];
  const beforeList = beforeItems(r, "permissionHandlers", sides);
  const before = counts(beforeList.map(permissionIdentity));
  const afterCounts = counts(
    (sides?.items.b["permissionHandlers"] ?? []).filter(isRecord).map(permissionIdentity),
  );
  for (const row of changedRows(r, "permissionHandlers")) {
    const items = afterItems(r, row, sides);
    if (!items) {
      out.push(
        unreadDraft("permission-handler-grants-all", row, "A permission handler may grant all"),
      );
      continue;
    }
    for (const f of items) {
      const risk = permissionRisk(f as unknown as PermissionHandlerRow);
      const identity = permissionIdentity(f);
      if (!risk || (afterCounts.get(identity) ?? 1) <= (before.get(identity) ?? 0)) continue;
      const unknown = risk === "unknown" || row.change === "unknown";
      const on = f["session"] ? String(f["session"]) : String(f["target"] ?? "a session");
      out.push({
        rule: "permission-handler-grants-all",
        identity,
        row,
        key: `${String(f["kind"])} handler on ${on} grants ${String(f["grants"])}`,
        message: unknown
          ? `The after build's permission ${String(f["kind"])} handler on ${plain(on)} may grant every request: ${f["grants"] === "unknown" ? "what it answers is not read" : "the receiver is not read as a session"}.`
          : `The after build's permission ${String(f["kind"])} handler on ${plain(on)} grants every request, and the before build's did not.`,
        where: row.where,
        unknown,
      });
    }
  }
  // request handlers gone: for a session that had one, or anywhere when none is left, Electron
  // grants every request again. Attached to a removed (else any changed) row of the list.
  const after = (sides?.items.b["permissionHandlers"] ?? []).filter(isRecord);
  const anchor =
    r.changes.find((row) => row.collection === "permissionHandlers" && row.change === "removed") ??
    r.changes.find((row) => row.collection === "permissionHandlers");
  const removedWhere = r.changes
    .filter((row) => row.collection === "permissionHandlers" && row.change === "removed")
    .flatMap((row) => row.where);
  if (sides?.items.a["permissionHandlers"] && sides.items.b["permissionHandlers"] && anchor) {
    const sessionsOf = (list: Array<Record<string, unknown>>): Set<string> =>
      new Set(
        requests(list)
          .filter((f) => f["targetKind"] === "session")
          .map((f) => String(f["session"])),
      );
    const afterSessions = sessionsOf(after);
    if (requests(beforeList).length && !requests(after).length)
      out.push({
        rule: "permission-handler-grants-all",
        identity: "permission\0removed",
        row: anchor,
        key: "setPermissionRequestHandler removed",
        message:
          "The before build sets a permission request handler and the after build sets none: Electron grants every permission a page asks for.",
        where: removedWhere.length ? removedWhere : anchor.where,
        unknown: false,
      });
    else
      for (const session of sessionsOf(beforeList)) {
        if (afterSessions.has(session)) continue;
        // a handler on a receiver not read as a session may still be this one
        const maybe = requests(after).some((f) => f["targetKind"] !== "session");
        out.push({
          rule: "permission-handler-grants-all",
          identity: `permission\0removed\0${session}`,
          row: anchor,
          key: `setPermissionRequestHandler removed for ${session}`,
          message: `The before build sets a permission request handler on session ${plain(session)} and the after build sets none there${maybe ? " that is read as that session" : ""}: Electron grants every permission its pages ask for.`,
          where: removedWhere.length ? removedWhere : anchor.where,
          unknown: maybe,
        });
      }
  }
  return out;
}

/** The navigation limits `navigation-limit-removed` watches, by the kinds that set them. */
const NAVIGATION_LIMITS = [
  {
    group: "navigate",
    kinds: ["will-navigate", "will-frame-navigate"],
    key: "will-navigate listener removed",
    message:
      "The before build listens for will-navigate or will-frame-navigate and the after build does not: a page may navigate its window to a URL the app does not expect (Electron's security guide, section 13).",
  },
  {
    group: "open",
    kinds: ["setWindowOpenHandler"],
    key: "setWindowOpenHandler removed",
    message:
      "The before build sets a setWindowOpenHandler and the after build sets none: a page may open new windows for a URL the app does not expect (Electron's security guide, section 14).",
  },
] as const;

/** A setWindowOpenHandler whose every return is `{ action: "allow" }`. */
const opensAll = (f: Record<string, unknown>): boolean =>
  f["kind"] === "setWindowOpenHandler" && f["returns"] === "allow";

/** A window open handler by receiver kind and window, and what it returns. */
const openHandlerIdentity = (f: Record<string, unknown>): string =>
  `navigation\0allow\0${String(f["targetKind"])}\0${String(f["window"] ?? null)}`;

/**
 * Navigation limits the before build sets and the after build does not: every will-navigate /
 * will-frame-navigate listener gone, or every setWindowOpenHandler (by kind, in any file), and a
 * setWindowOpenHandler that returns `{ action: "allow" }` on every path where the before build had
 * none such for that receiver kind and window.
 */
function navigationDrafts(r: ReleaseComparison, sides: CheckSides | undefined): Draft[] {
  const out: Draft[] = [];
  const beforeList = beforeItems(r, "navigationHandlers", sides);
  const before = counts(beforeList.filter(opensAll).map(openHandlerIdentity));
  const afterList = (sides?.items.b["navigationHandlers"] ?? []).filter(isRecord);
  const after = counts(afterList.filter(opensAll).map(openHandlerIdentity));
  for (const row of changedRows(r, "navigationHandlers")) {
    const items = afterItems(r, row, sides);
    if (!items) {
      out.push(unreadDraft("navigation-limit-removed", row, "A navigation limit may be gone"));
      continue;
    }
    for (const f of items) {
      if (!opensAll(f)) continue;
      const identity = openHandlerIdentity(f);
      if ((after.get(identity) ?? 1) <= (before.get(identity) ?? 0)) continue;
      const on = String(f["window"] ?? f["target"] ?? "a webContents");
      const unknown = row.change === "unknown";
      out.push({
        rule: "navigation-limit-removed",
        identity,
        row,
        key: `setWindowOpenHandler on ${on} returns allow`,
        message: unknown
          ? `The after build's setWindowOpenHandler of ${plain(on)} may newly allow every window: ${plain(row.reason ?? "the comparison could not tell")}.`
          : `The after build's setWindowOpenHandler of ${plain(on)} returns { action: "allow" } on every path, and the before build's did not: a page may open a window for a URL the app does not expect (Electron's security guide, section 14).`,
        where: row.where,
        unknown,
      });
    }
  }
  // a limit gone: attached to a removed row of the list (else any changed one)
  const anchor =
    r.changes.find((row) => row.collection === "navigationHandlers" && row.change === "removed") ??
    r.changes.find((row) => row.collection === "navigationHandlers");
  if (!sides?.items.a["navigationHandlers"] || !sides.items.b["navigationHandlers"] || !anchor)
    return out;
  for (const limit of NAVIGATION_LIMITS) {
    const of = (list: Array<Record<string, unknown>>) =>
      list.filter((f) => (limit.kinds as readonly string[]).includes(String(f["kind"])));
    if (!of(beforeList).length || of(afterList).length) continue;
    const removedWhere = r.changes
      .filter(
        (row) =>
          row.collection === "navigationHandlers" &&
          row.change === "removed" &&
          of([fieldsOf(r, row) ?? {}]).length > 0,
      )
      .flatMap((row) => row.where);
    out.push({
      rule: "navigation-limit-removed",
      identity: `navigation\0removed\0${limit.group}`,
      row: anchor,
      key: limit.key,
      message: limit.message,
      where: removedWhere.length ? removedWhere : anchor.where,
      unknown: false,
    });
  }
  return out;
}

/**
 * A call that runs code or styles in a page that are not a literal (`dangerousCallRisk`) and that
 * the before build does not have: by method, receiver kind and as much of the code as is read, in
 * any file. A call on a receiver not read as a webContents, a frame or webFrame is unknown.
 */
const callIdentity = (f: Record<string, unknown>): string =>
  `call\0${String(f["method"])}\0${String(f["targetKind"])}\0${String(f["argumentKind"])}\0${String(f["argument"])}`;

function dangerousCallDrafts(r: ReleaseComparison, sides: CheckSides | undefined): Draft[] {
  const out: Draft[] = [];
  const before = counts(beforeItems(r, "dangerousCalls", sides).map(callIdentity));
  const after = counts((sides?.items.b["dangerousCalls"] ?? []).filter(isRecord).map(callIdentity));
  for (const row of changedRows(r, "dangerousCalls")) {
    const items = afterItems(r, row, sides);
    if (!items) {
      out.push(
        unreadDraft("new-dangerous-call", row, "A call that runs code in a page may be new"),
      );
      continue;
    }
    for (const f of items) {
      const risk = dangerousCallRisk(f as unknown as DangerousCallRow);
      const identity = callIdentity(f);
      if (!risk || (after.get(identity) ?? 1) <= (before.get(identity) ?? 0)) continue;
      const unknown = risk === "unknown" || row.change === "unknown";
      const code =
        f["argumentKind"] === "inferred" && typeof f["argument"] === "string"
          ? `code starting ${plain(JSON.stringify(f["argument"]))}`
          : "code that is not read";
      out.push({
        rule: "new-dangerous-call",
        identity,
        row,
        key: `${String(f["method"])} ${String(f["targetKind"])} ${String(f["argumentKind"])}${typeof f["argument"] === "string" ? ` ${String(f["argument"])}` : ""}`,
        message: unknown
          ? `The after build may newly run ${code} in a page with ${String(f["method"])}: ${f["targetKind"] === "unknown" ? "the receiver is not read as a webContents, a frame or webFrame" : plain(row.reason ?? "the comparison could not tell")}.`
          : `The after build newly runs ${code} in a page with ${String(f["method"])}: text that reaches it runs with the page's rights.`,
        where: row.where,
        unknown,
      });
    }
  }
  return out;
}

/**
 * A load over plain http from another host (`httpResourceRisk`) that the before build does not
 * have: by kind, receiver kind and the URL as far as it is read, in any file and without lines
 * or window names (a minifier renames those). A load on a receiver not read as a window or a
 * webContents, or of a URL whose host is not read, is unknown.
 */
const loadIdentity = (f: Record<string, unknown>): string =>
  `load ${String(f["kind"])} ${String(f["targetKind"])} ${String(f["argumentKind"])} ${String(f["argument"])} ${Array.isArray(f["values"]) ? f["values"].join(" ") : ""}`;

function httpResourceDrafts(r: ReleaseComparison, sides: CheckSides | undefined): Draft[] {
  const out: Draft[] = [];
  const before = counts(beforeItems(r, "loads", sides).map(loadIdentity));
  const after = counts((sides?.items.b["loads"] ?? []).filter(isRecord).map(loadIdentity));
  for (const row of changedRows(r, "loads")) {
    const items = afterItems(r, row, sides);
    if (!items) {
      out.push(unreadDraft("new-http-resource", row, "A load over plain http may be new"));
      continue;
    }
    for (const f of items) {
      const risk = httpResourceRisk(f as unknown as LoadRow);
      const identity = loadIdentity(f);
      if (!risk || (after.get(identity) ?? 1) <= (before.get(identity) ?? 0)) continue;
      const unknown = risk === "unknown" || row.change === "unknown";
      const values = Array.isArray(f["values"]) ? (f["values"] as unknown[]).map(String) : null;
      const shown =
        f["argumentKind"] === "literal"
          ? String(f["argument"])
          : values
            ? `one of ${values.join(", ")}`
            : `${String(f["argument"])} …`;
      const what =
        f["kind"] === "loadURL"
          ? `loads ${plain(JSON.stringify(shown))} with loadURL`
          : `loads the ${String(f["kind"])} ${plain(JSON.stringify(shown))} in an HTML file`;
      out.push({
        rule: "new-http-resource",
        identity,
        row,
        key: `${String(f["kind"])} ${String(f["targetKind"])} ${shown}`,
        message: unknown
          ? `The after build may newly load over plain http: it ${what}, ${risk === "unknown" ? (f["targetKind"] === "unknown" ? "on a receiver not read as a window or a webContents" : "and the URL's host is not read (a dev server on this machine gives no finding)") : plain(row.reason ?? "and the comparison could not tell")}.`
          : `The after build newly ${what} over plain http: anyone on the network path can read or replace what it loads (Electron's security guide, section 1).`,
        where: row.where,
        unknown,
      });
    }
  }
  return out;
}

/** A webview weakness by where the webview is written, its src and the weakness. */
const webviewIdentity = (f: Record<string, unknown>, reason: string): string =>
  `webview\0${String(f["kind"])}\0${String(f["src"] ?? null)}\0${reason}`;

/** The weaknesses of a webviews item: those that take effect as written, then host-dependent. */
const webviewReasons = (f: Record<string, unknown>): Array<{ reason: string; host: boolean }> => [
  ...(Array.isArray(f["insecure"]) ? f["insecure"] : []).map((x) => ({
    reason: String(x),
    host: false,
  })),
  ...(Array.isArray(f["hostDependent"]) ? f["hostDependent"] : []).map((x) => ({
    reason: String(x),
    host: true,
  })),
];

/** How often each webview weakness identity occurs in a list. */
const webviewIds = (list: Array<Record<string, unknown>>): Map<string, number> =>
  counts(list.flatMap((f) => webviewReasons(f).map((w) => webviewIdentity(f, w.reason))));

/** The will-attach-webview listeners of a webviews list. */
const attachListeners = (list: Array<Record<string, unknown>>): number =>
  list.filter((f) => f["kind"] === "attach-listener").length;

/** A privileged scheme or default protocol client by kind and scheme. */
const protocolIdentity = (f: Record<string, unknown>): string =>
  `protocol\0${String(f["kind"])}\0${String(f["scheme"] ?? null)}`;

/** A privileged scheme given `bypassCSP: true`. */
const bypassesCsp = (f: Record<string, unknown>): boolean =>
  f["kind"] === "privileged" &&
  isRecord(f["privileges"]) &&
  (f["privileges"] as Record<string, unknown>)["bypassCSP"] === true;

/** The protocols rows `new-custom-protocol` watches: privileged schemes and default clients. */
const protocolWatched = (f: Record<string, unknown>): boolean =>
  f["kind"] === "privileged" || f["kind"] === "default-client";

/**
 * A webview weakness (by kind, src and weakness, in any file) that the before build does not
 * have, and a before build's will-attach-webview listeners all gone. A weakness that takes effect
 * only in a hosting window with the same setting, or in an after build where no window is read to
 * enable webviewTag, is unknown.
 */
function webviewDrafts(r: ReleaseComparison, sides: CheckSides | undefined): Draft[] {
  const out: Draft[] = [];
  const beforeList = beforeItems(r, "webviews", sides);
  const afterList = (sides?.items.b["webviews"] ?? []).filter(isRecord);
  const before = webviewIds(beforeList);
  const after = webviewIds(afterList);
  const tagOn = (sides?.items.b["webPreferences"] ?? []).some(
    (p) => isRecord(p) && p["key"] === "webviewTag" && p["value"] === true,
  );
  for (const row of changedRows(r, "webviews")) {
    const items = afterItems(r, row, sides);
    if (!items) {
      out.push(unreadDraft("new-insecure-webview", row, "A webview may be newly insecure"));
      continue;
    }
    for (const f of items)
      for (const { reason, host } of webviewReasons(f)) {
        const identity = webviewIdentity(f, reason);
        if ((after.get(identity) ?? 1) <= (before.get(identity) ?? 0)) continue;
        const src = typeof f["src"] === "string" ? ` (src ${plain(JSON.stringify(f["src"]))})` : "";
        const doubts = [
          ...(row.change === "unknown"
            ? [plain(row.reason ?? "the comparison could not tell")]
            : []),
          ...(host
            ? ["it takes effect only in a hosting window that has the same setting itself"]
            : []),
          ...(tagOn ? [] : ["no window of the after build is read to enable webviewTag"]),
        ];
        out.push({
          rule: "new-insecure-webview",
          identity,
          row,
          key: `${String(f["kind"])} webview${src}: ${reason}`,
          message: `The after build's ${String(f["kind"]) === "html" ? "<webview> tag" : "webview"}${src} newly sets ${plain(reason)} (Electron's security guide, sections 11 and 12)${doubts.length ? `; ${doubts.join("; ")}` : ""}.`,
          where: row.where,
          unknown: doubts.length > 0,
        });
      }
  }
  const listeners = attachListeners;
  const anchor =
    r.changes.find((row) => row.collection === "webviews" && row.change === "removed") ??
    r.changes.find((row) => row.collection === "webviews");
  if (
    sides?.items.a["webviews"] &&
    sides.items.b["webviews"] &&
    anchor &&
    listeners(beforeList) > 0 &&
    listeners(afterList) === 0
  ) {
    const removedWhere = r.changes
      .filter(
        (row) =>
          row.collection === "webviews" &&
          row.change === "removed" &&
          fieldsOf(r, row)?.["kind"] === "attach-listener",
      )
      .flatMap((row) => row.where);
    out.push({
      rule: "new-insecure-webview",
      identity: "webview\0listener-removed",
      row: anchor,
      key: "will-attach-webview listener removed",
      message:
        "The before build listens for will-attach-webview and the after build does not: the app no longer checks the options and URL of a <webview> before it is created (Electron's security guide, section 12).",
      where: removedWhere.length ? removedWhere : anchor.where,
      unknown: false,
    });
  }
  return out;
}

/**
 * A scheme newly registered as privileged or as the app's default protocol client (by scheme, in
 * any file), and `bypassCSP` newly given to a privileged scheme the before build has. A scheme
 * that is not read, or a receiver not read as Electron's protocol or app, is unknown.
 */
function protocolDrafts(r: ReleaseComparison, sides: CheckSides | undefined): Draft[] {
  const out: Draft[] = [];
  const beforeList = beforeItems(r, "protocols", sides);
  const afterList = (sides?.items.b["protocols"] ?? []).filter(isRecord);
  const schemeId = protocolIdentity;
  const bypass = bypassesCsp;
  const watched = protocolWatched;
  const before = counts(beforeList.filter(watched).map(schemeId));
  const after = counts(afterList.filter(watched).map(schemeId));
  const bypassBefore = new Set(beforeList.filter(bypass).map((f) => String(f["scheme"] ?? null)));
  for (const row of changedRows(r, "protocols")) {
    const items = afterItems(r, row, sides);
    if (!items) {
      out.push(unreadDraft("new-custom-protocol", row, "A custom protocol may be new"));
      continue;
    }
    for (const f of items) {
      if (!watched(f)) continue;
      const scheme = typeof f["scheme"] === "string" ? f["scheme"] : null;
      const proven = f["targetKind"] === "protocol" || f["targetKind"] === "app";
      const doubts = [
        ...(row.change === "unknown" ? [plain(row.reason ?? "the comparison could not tell")] : []),
        ...(scheme === null ? ["its scheme is not read"] : []),
        ...(proven ? [] : ["the receiver is not read as Electron's"]),
      ];
      const name = scheme === null ? "a scheme" : `the scheme ${plain(JSON.stringify(scheme))}`;
      const identity = schemeId(f);
      if ((after.get(identity) ?? 1) > (before.get(identity) ?? 0)) {
        const privileged = f["kind"] === "privileged";
        const granted = isRecord(f["privileges"])
          ? Object.entries(f["privileges"] as Record<string, unknown>)
              .filter(([, v]) => v === true)
              .map(([k]) => k)
          : null;
        out.push({
          rule: "new-custom-protocol",
          identity,
          row,
          key: `${privileged ? "privileged scheme" : "default protocol client"} ${scheme ?? "(not read)"}`,
          message: privileged
            ? `The after build newly registers ${name} as privileged (${granted === null ? "privileges not read" : granted.length ? plain(granted.join(", ")) : "no privileges"})${granted?.includes("bypassCSP") ? ": its content is not held to the Content Security Policy" : ""}${doubts.length ? `; ${doubts.join("; ")}` : ""}.`
            : `The after build newly makes the app the default client of ${name}: the operating system hands it URLs of that scheme from browsers and other programs, which reach the app's handling of them${doubts.length ? `; ${doubts.join("; ")}` : ""}.`,
          where: row.where,
          unknown: doubts.length > 0,
        });
        continue;
      }
      if (!bypass(f) || bypassBefore.has(String(scheme))) continue;
      out.push({
        rule: "new-custom-protocol",
        identity: `protocol\0bypassCSP\0${String(scheme)}`,
        row,
        key: `privileged scheme ${scheme ?? "(not read)"} bypassCSP`,
        message: `The after build newly gives ${name} the privilege bypassCSP: its content is not held to the Content Security Policy (Electron's security guide, sections 7 and 18)${doubts.length ? `; ${doubts.join("; ")}` : ""}.`,
        where: row.where,
        unknown: doubts.length > 0,
      });
    }
  }
  return out;
}

/** A CSP row that applies to the app's pages: enforced, in a <meta> tag or onHeadersReceived. */
const appliedCsp = (f: unknown): boolean =>
  isRecord(f) &&
  f["reportOnly"] !== true &&
  f["doubt"] === undefined &&
  ((f["kind"] === "meta" && f["outsideHead"] !== true) || f["via"] === "onHeadersReceived");

/** Where a policy is set: weaknesses are compared per policy, not across the build. */
const cspPlace = (f: Record<string, unknown>): string =>
  `${String(f["file"])}\0${String(f["kind"])}\0${String(f["via"])}`;

/**
 * A Content Security Policy weakness (`cspWeaknesses`) that no enforced policy of the before
 * build has, a policy whose value is not read, and a before build's applied policies gone
 * without one left in the after build.
 */
function cspDrafts(r: ReleaseComparison, sides: CheckSides | undefined): Draft[] {
  const out: Draft[] = [];
  const beforeList = beforeItems(r, "csp", sides).filter((f) => f["reportOnly"] !== true);
  // the weaknesses of each applied policy of the before build, by where it is set; a policy
  // that may not apply (a header elsewhere, a <meta> after the head) is no baseline
  const known = new Map<string, Set<string>>();
  const unreadBefore = new Set<string>();
  for (const f of beforeList.filter(appliedCsp)) {
    const place = cspPlace(f);
    if (f["weaknesses"] === null) unreadBefore.add(place);
    const set = known.get(place) ?? new Set<string>();
    if (Array.isArray(f["weaknesses"])) for (const w of f["weaknesses"]) set.add(String(w));
    known.set(place, set);
  }
  for (const row of changedRows(r, "csp")) {
    const items = afterItems(r, row, sides);
    if (!items) {
      out.push(unreadDraft("csp-weakened", row, "A Content Security Policy may be weaker"));
      continue;
    }
    for (const f of items) {
      const risk = cspRisk(f as unknown as CspRow);
      if (!risk) continue;
      const where = `${String(f["kind"]) === "meta" ? "<meta> tag" : "header"} in ${plain(String(f["file"]))}`;
      const place = cspPlace(f);
      if (risk === "unknown") {
        if (unreadBefore.has(place) && appliedCsp(f)) continue;
        out.push({
          rule: "csp-weakened",
          identity: `csp\0unread\0${place}`,
          row,
          key:
            f["weaknesses"] === null
              ? `${String(f["kind"])} policy not read`
              : `${String(f["kind"])} policy that may not apply`,
          message:
            f["weaknesses"] === null
              ? `The after build's Content-Security-Policy ${where} is not read (computed at run time), so whether it is weaker is not known.`
              : `The after build's Content-Security-Policy ${where} is weak (${plain((f["weaknesses"] as unknown[]).map(String).join("; "))}), and whether it applies is not known: ${plain(f["outsideHead"] === true ? "it stands after the document's head" : typeof f["doubt"] === "string" ? f["doubt"] : "it is not set in a webRequest.onHeadersReceived listener")}.`,
          where: row.where,
          unknown: true,
        });
        continue;
      }
      const had = known.get(place);
      for (const w of (f["weaknesses"] as unknown[]).map(String)) {
        if (had?.has(w)) continue;
        out.push({
          rule: "csp-weakened",
          identity: `csp\0${place}\0${w}`,
          row,
          key: w,
          message: `The after build's Content-Security-Policy ${where} is weaker: ${plain(w)}, which the before build's policy there does not allow.`,
          where: row.where,
          // a policy that may not apply (a header outside onHeadersReceived) is unknown
          unknown: row.change === "unknown" || !appliedCsp(f),
        });
      }
    }
  }
  const after = sides?.items.b["csp"];
  // a place (a page's <meta>, a listener's header) whose applied policy is gone while others
  // remain: each page is judged on its own, so another page's policy does not excuse it
  if (after && sides?.items.a["csp"] && after.some(appliedCsp)) {
    const afterPlaces = new Set(
      after.filter(appliedCsp).map((f) => cspPlace(f as Record<string, unknown>)),
    );
    for (const f of beforeList.filter(appliedCsp)) {
      const place = cspPlace(f);
      if (afterPlaces.has(place)) continue;
      const anchor =
        r.changes.find(
          (row) => row.collection === "csp" && row.where.some((w) => w.file === String(f["file"])),
        ) ?? r.changes.find((row) => row.collection === "csp");
      if (!anchor) continue;
      out.push({
        rule: "csp-weakened",
        identity: `csp\0removed\0${place}`,
        row: anchor,
        key: `Content-Security-Policy removed from ${String(f["file"])}`,
        message: `The before build's Content-Security-Policy ${String(f["kind"]) === "meta" ? "<meta> tag" : "header"} in ${plain(String(f["file"]))} applies, and the after build sets none there that is read as applying (removed, report-only, outside the head, or set where it may not apply). A page whose file was removed or renamed is reported too.`,
        where: anchor.where,
        unknown: false,
      });
    }
  }
  // no applied policy left (removed, made report-only, moved out of the head, put behind a
  // condition): attached to a removed row of the list, else any changed one
  const removed = r.changes.filter((row) => row.collection === "csp" && row.change === "removed");
  const anchor = removed[0] ?? r.changes.find((row) => row.collection === "csp");
  if (
    after &&
    sides?.items.a["csp"] &&
    beforeList.some(appliedCsp) &&
    !after.some(appliedCsp) &&
    anchor
  )
    out.push({
      rule: "csp-weakened",
      identity: "csp\0removed",
      row: anchor,
      key: "Content-Security-Policy removed",
      message:
        "The before build sets a Content Security Policy that applies (a <meta> tag in the head or an onHeadersReceived header) and the after build sets none that is read as applying (removed, report-only, outside the head, or set where it may not apply).",
      where: removed.length ? removed.flatMap((row) => row.where) : anchor.where,
      unknown: false,
    });
  return out;
}

/** Added to the webSecurity finding that also stands for allowRunningInsecureContent. */
const INSECURE_FOLLOWS =
  " allowRunningInsecureContent is not read as a value of its own and depends on it (webSecurity: false turns it on), so it cannot be told either.";

/**
 * Whether a window's allowRunningInsecureContent is unknown only because its webSecurity is:
 * not written, or computed with no webPreferences row of its own (options that could not be
 * followed). One finding, webSecurity's, then says both, as `audit` does. Without the side's
 * webPreferences a computed one keeps its own finding.
 */
function insecureFollows(
  item: Record<string, unknown> | null,
  sides: CheckSides | undefined,
  side: "a" | "b",
): boolean {
  if (
    !item ||
    item["webSecurityInEffect"] !== "unknown" ||
    item["allowRunningInsecureContentInEffect"] !== "unknown"
  )
    return false;
  const state = item["allowRunningInsecureContent"];
  if (state === "not written") return true;
  const prefs = sides?.items[side]["webPreferences"];
  if (state !== "computed" || !prefs) return false;
  return !prefs
    .filter(isRecord)
    .some(
      (p) =>
        p["key"] === "allowRunningInsecureContent" &&
        p["file"] === item["file"] &&
        p["window"] === item["window"],
    );
}

/** The feature settings one side's window item hides behind an unknown webSecurity. */
function hiddenOn(
  item: Record<string, unknown> | null,
  sides: CheckSides | undefined,
  side: "a" | "b",
): string[] {
  const prefs = sides?.items[side]["webPreferences"];
  return item ? hiddenFeatures(item, prefs ? prefs.filter(isRecord) : undefined) : [];
}

/** The sentence a webSecurity finding adds for the feature settings it stands for. */
const featuresSentence = (columns: readonly string[]): string =>
  columns.length ? ` ${hiddenFeaturesNote(columns).slice(2)}.` : "";

function windowDrafts(r: ReleaseComparison, sides: CheckSides | undefined): Draft[] {
  const out: Draft[] = [];
  /** Per window: the feature changes to unknown that its webSecurity finding says. */
  const folded = new Map<string, string[]>();
  for (const w of r.overview.windowChanges) {
    if (w.setting !== "webSecurityInEffect" || w.after !== "unknown") continue;
    const row = r.changes.find((c) => c.collection === "windows" && c.key === w.window);
    if (!row) continue;
    const hidden = hiddenOn(windowItem(r, row, "b", sides), sides, "b").filter((setting) =>
      r.overview.windowChanges.some(
        (x) => x.window === w.window && x.setting === setting && x.after === "unknown",
      ),
    );
    if (hidden.length) folded.set(w.window, hidden);
  }
  for (const w of r.overview.windowChanges) {
    if (folded.get(w.window)?.includes(w.setting)) continue;
    if (w.direction === "less permissive") continue;
    // Both values known and neither move lets pages do more (`default off` → `off`, writing the
    // default; `default on` → `on`): nothing to report, and nothing unknown either.
    if (
      w.direction === "unclear" &&
      w.before !== "unknown" &&
      w.after !== "unknown" &&
      !(PERMISSIVE[w.setting]?.includes(w.after) && !PERMISSIVE[w.setting]?.includes(w.before))
    )
      continue;
    const row: ChangeRow = r.changes.find(
      (c) => c.collection === "windows" && c.key === w.window,
    ) ?? {
      // the same id the report gives a row (C3): an empty id makes rowId derive it
      id: rowId({ id: "", collection: "windows", change: "changed", key: w.window, where: [] }),
      collection: "windows",
      change: "changed",
      key: w.window,
      where: [],
    };
    const follows =
      w.after === "unknown" &&
      (w.setting === "webSecurityInEffect" ||
        w.setting === "allowRunningInsecureContentInEffect") &&
      r.overview.windowChanges.some(
        (x) =>
          x.window === w.window && x.setting === "webSecurityInEffect" && x.after === "unknown",
      ) &&
      insecureFollows(windowItem(r, row, "b", sides), sides, "b");
    if (follows && w.setting === "allowRunningInsecureContentInEffect") continue;
    const unknown = w.direction === "unclear";
    const note =
      w.setting === "blinkFeaturesInEffect" && !unknown
        ? blinkNote(windowItem(r, row, "b", sides))
        : "";
    out.push({
      rule: "window-more-permissive",
      identity: `window\0${w.window}\0${w.setting}\0${w.after}`,
      row,
      key: `${w.window} ${w.setting}`,
      message: unknown
        ? `Window ${plain(w.window)}: ${w.setting} changed from ${plain(w.before)} to ${plain(w.after)}; whether pages may now do more is not known.${follows ? INSECURE_FOLLOWS : ""}${w.setting === "webSecurityInEffect" ? featuresSentence(folded.get(w.window) ?? []) : ""}`
        : `Window ${plain(w.window)} lets its pages do more: ${w.setting} ${plain(w.before)} → ${plain(w.after)}${note}.`,
      where: row.where,
      unknown,
    });
  }
  out.push(...unmatchedWindowDrafts(r, sides));
  return out;
}

/** For each derived window setting, the values under which a page can do more. */
const PERMISSIVE: Record<string, readonly string[]> = {
  nodeIntegrationInEffect: ["on", "default on"],
  contextIsolationInEffect: ["off", "default off"],
  sandboxInEffect: ["off", "default off"],
  pageRequire: ["yes", "yes by default"],
  webSecurityInEffect: ["off", "default off"],
  allowRunningInsecureContentInEffect: ["on", "default on"],
  experimentalFeaturesInEffect: ["on"],
  blinkFeaturesInEffect: ["on"],
};

/** ` (enableBlinkFeatures A, B)` for a window item that names Blink features; else empty. */
function blinkNote(item: Record<string, unknown> | null): string {
  const features = item?.["enableBlinkFeatures"];
  return Array.isArray(features) && features.length
    ? ` (enableBlinkFeatures ${features.map((x) => plain(String(x))).join(", ")})`
    : "";
}

/** The window item behind a row of `windows`, from its label or the side's items. */
function windowItem(
  r: ReleaseComparison,
  row: ChangeRow,
  side: "a" | "b",
  sides: CheckSides | undefined,
): Record<string, unknown> | null {
  const f = fieldsOf(r, row);
  if (f && Object.keys(PERMISSIVE).some((k) => k in f)) return f;
  if (!f) return null;
  const list = (sides?.items[side]["windows"] ?? []).filter(isRecord);
  const matches = list.filter(
    (w) => w["file"] === f["file"] && String(w["windowName"]) === String(f["windowName"]),
  );
  if (matches.length <= 1) return matches[0] ?? null;
  // Several windows share the file and variable name (two `win` in two functions): judge them
  // together, so the most permissive value of each setting counts and a safe first match cannot
  // hide a permissive second one. Values that differ without one being permissive are unknown.
  const merged: Record<string, unknown> = { ...matches[0] };
  for (const [setting, open] of Object.entries(PERMISSIVE)) {
    const values = [...new Set(matches.map((m) => String(m[setting])))];
    merged[setting] =
      values.find((v) => open.includes(v)) ?? (values.length === 1 ? values[0] : "unknown");
  }
  return merged;
}

/**
 * Windows the comparison could not match by file and name: a window that is new, renamed, or
 * on a side that was not read. An added window is judged by its own settings. When a removed
 * window was already as permissive on a setting, the added one may be that window renamed, so
 * the finding is unknown; so is an unknown row, and a window whose settings cannot be read.
 */
function unmatchedWindowDrafts(r: ReleaseComparison, sides: CheckSides | undefined): Draft[] {
  const out: Draft[] = [];
  const removed = r.changes
    .filter((row) => row.collection === "windows" && row.change === "removed")
    .map((row) => ({ row, item: windowItem(r, row, "a", sides) }));
  const removedOpen = (setting: string): string | undefined => {
    for (const { row, item } of removed)
      if (!item || PERMISSIVE[setting]!.includes(String(item[setting] ?? "unknown")))
        return row.key;
    return undefined;
  };
  for (const row of r.changes) {
    if (row.collection !== "windows" || (row.change !== "added" && row.change !== "unknown"))
      continue;
    const side = row.change === "unknown" && row.where[0]?.side === "a" ? "a" : "b";
    const item = windowItem(r, row, side, sides);
    const label = plain(row.key);
    if (!item) {
      out.push({
        rule: "window-more-permissive",
        identity: `window\0${row.key}`,
        row,
        key: row.key,
        message: `Window ${label} is ${row.change === "added" ? "new" : "not matched"} and its settings could not be read.`,
        where: row.where,
        unknown: true,
      });
      continue;
    }
    const follows = insecureFollows(item, sides, side);
    const hidden = hiddenOn(item, sides, side);
    for (const setting of Object.keys(PERMISSIVE)) {
      const value = String(item[setting] ?? "unknown");
      const open = PERMISSIVE[setting]!.includes(value);
      if (!open && value !== "unknown") continue;
      if (follows && setting === "allowRunningInsecureContentInEffect") continue;
      if (hidden.includes(setting)) continue;
      const also =
        setting === "webSecurityInEffect"
          ? `${follows ? INSECURE_FOLLOWS : ""}${featuresSentence(hidden)}`
          : "";
      const twin = open && row.change === "added" ? removedOpen(setting) : undefined;
      const unknown = row.change === "unknown" || value === "unknown" || twin !== undefined;
      out.push({
        rule: "window-more-permissive",
        identity: `window\0${row.key}\0${setting}\0${value}`,
        row,
        key: `${row.key} ${setting}`,
        message:
          row.change === "unknown"
            ? `Window ${label} may be new (${plain(row.reason ?? "the comparison could not tell")}): ${setting} is ${plain(value)}.${also}`
            : value === "unknown"
              ? `New window ${label}: whether ${setting} lets its pages do more is not known.${also}`
              : twin !== undefined
                ? `New window ${label} has ${setting} ${plain(value)}; it may be ${plain(twin)} renamed, which had it too.`
                : `New window ${label} lets its pages do more: ${setting} is ${plain(value)}${setting === "blinkFeaturesInEffect" ? blinkNote(item) : ""}.`,
        where: row.where,
        unknown,
      });
    }
  }
  return out;
}

/**
 * For each fuse the rule watches, its less safe state, and what that state lets happen (Electron's
 * documentation of the fuse, docs/tutorial/fuses.md).
 */
export const FUSE_LESS_SAFE: Readonly<Record<string, { state: "on" | "off"; means: string }>> = {
  runAsNode: {
    state: "on",
    means: "ELECTRON_RUN_AS_NODE can start the app's binary as a plain Node.js process",
  },
  nodeOptions: {
    state: "on",
    means: "the NODE_OPTIONS and NODE_EXTRA_CA_CERTS environment variables are respected",
  },
  nodeCliInspect: {
    state: "on",
    means: "--inspect and the other debugging flags are respected in the main process",
  },
  embeddedAsarIntegrityValidation: {
    state: "off",
    means: "Electron does not validate app.asar against the build's integrity record",
  },
  onlyLoadAppFromAsar: {
    state: "off",
    means: "Electron also looks for the app in app/ and default_app.asar, not only in app.asar",
  },
  cookieEncryption: {
    state: "off",
    means: "cookies on disk are not encrypted with the operating system's keys",
  },
  grantFileProtocolExtraPrivileges: {
    state: "on",
    means: "pages loaded from file:// get the extra privileges of Electron's legacy file protocol",
  },
};

const COVERS = "covers the loaded archive";
const PAST_SUPPORT = "past end of support";

/**
 * The `runtime` rows of one side as item → row: every row when the check has them, else the ones
 * the comparison lists as changed (their before or after values). Null when the side has none.
 */
function runtimeOf(
  r: ReleaseComparison,
  sides: CheckSides | undefined,
  side: "a" | "b",
): Map<string, Record<string, unknown>> | null {
  const all = sides?.items[side]["runtime"];
  const out = new Map<string, Record<string, unknown>>();
  if (all) for (const item of all.filter(isRecord)) out.set(String(item["item"]), item);
  else
    for (const row of r.changes) {
      if (row.collection !== "runtime" || row.change !== "changed") continue;
      const value = row.fields?.find((f) => f.field === "value");
      if (value)
        out.set(row.key, { item: row.key, value: side === "a" ? value.before : value.after });
    }
  return out.size ? out : null;
}

/** The `value` of a runtime row, as text. */
function runtimeValue(m: Map<string, Record<string, unknown>>, item: string): string | undefined {
  const v = m.get(item)?.["value"];
  return v === undefined ? undefined : String(v);
}

/** The runtime facts the rule reads: fuses, integrity coverage, support. */
function fuseDrafts(r: ReleaseComparison, sides: CheckSides | undefined): Draft[] {
  const before = runtimeOf(r, sides, "a");
  const after = runtimeOf(r, sides, "b");
  if (!before || !after) return [];
  const value = runtimeValue;
  const out: Draft[] = [];
  const rowFor = (item: string): ChangeRow =>
    r.changes.find((c) => c.collection === "runtime" && c.key === item) ?? {
      id: rowId({ id: "", collection: "runtime", change: "changed", key: item, where: [] }),
      collection: "runtime",
      change: "changed",
      key: item,
      where: [],
    };
  const push = (item: string, identity: string, unknown: boolean, message: string): void => {
    const row = rowFor(item);
    out.push({
      rule: "fuse-weakened",
      identity,
      row,
      key: item,
      message,
      where: row.where,
      unknown,
    });
  };
  // a fuse the wire of a side does not hold: unknown when that wire was not read, else absent
  const fuseValue = (m: Map<string, Record<string, unknown>>, name: string): string | undefined =>
    value(m, `fuse.${name}`) ?? (value(m, "fuses") === "unknown" ? "unknown" : undefined);
  for (const [name, { state: bad, means }] of Object.entries(FUSE_LESS_SAFE)) {
    const was = fuseValue(before, name);
    // A fuse the after build's wire does not hold, while the before build had it (a wire of a
    // schema version hexvero does not know, a short wire): not read, so it may be weakened.
    const now = fuseValue(after, name) ?? (was === undefined ? undefined : "unknown");
    // a fuse new in this Electron starts at its default: no move
    if (was === undefined || now === undefined || was === bad) continue;
    // `removed` (r) has no effect: what it was in effect before is not known, so a move from it
    // is a finding that may be one, never a definite one
    const open = was === "unknown" || was === "removed";
    if (now === bad)
      push(
        `fuse.${name}`,
        `fuse\0${name}\0${bad}`,
        open,
        was === "unknown"
          ? `Fuse ${name} is ${bad}; it was not read in the before build, so it may have been ${bad} already: ${means}.`
          : was === "removed"
            ? `Fuse ${name} is ${bad}; in the before build it was marked removed (no effect), so whether this is a move is not known: ${means}.`
            : `Fuse ${name} moved ${was} → ${bad}: ${means}.`,
      );
    // a removed fuse is no effect; one not read afterwards may be anything, so it is a finding too
    else if (now === "unknown" && was !== "unknown")
      push(
        `fuse.${name}`,
        `fuse\0${name}\0${bad}`,
        true,
        `Fuse ${name} was ${was} and could not be read in the after build (${plain(String(after.get(`fuse.${name}`)?.["detail"] ?? after.get("fuses")?.["detail"] ?? "not in its fuse wire"))}); if it is ${bad}, ${means}.`,
      );
  }
  const covered = value(before, "asarIntegrity");
  const covers = value(after, "asarIntegrity");
  if (covered !== undefined && covers !== undefined && covers !== COVERS) {
    const integrity = after.get("asarIntegrity")?.["detail"];
    if (covered === COVERS)
      push(
        "asarIntegrity",
        `integrity\0${covers}`,
        covers === "unknown",
        covers === "unknown"
          ? `The ASAR integrity record covered the archive Electron loads; in the after build it could not be read (${plain(String(integrity ?? ""))}).`
          : `The ASAR integrity record no longer covers what Electron loads: ${covers} (${plain(String(integrity ?? ""))}).`,
      );
    else if (covered === "unknown" && covers !== "unknown")
      push(
        "asarIntegrity",
        `integrity\0${covers}`,
        true,
        `The ASAR integrity record ${covers} in the after build; in the before build it could not be read, so coverage may be lost (${plain(String(integrity ?? ""))}).`,
      );
  }
  const was = value(before, "support");
  const now = value(after, "support");
  if (was !== undefined && now !== undefined && was !== PAST_SUPPORT) {
    const electron = value(after, "electron") ?? "unknown";
    const detail = plain(String(after.get("support")?.["detail"] ?? ""));
    const line = /^(\d+)\./.exec(electron)?.[1] ?? electron;
    if (now === PAST_SUPPORT)
      push(
        "support",
        `support\0${line}`,
        was === "unknown",
        was === "unknown"
          ? `The after build's runtime is past end of support, and the before build's support status is not known: ${detail}.`
          : `The runtime went past end of support: ${detail}.`,
      );
    else if (now === "unknown" && was === "supported")
      push(
        "support",
        `support\0${line}`,
        true,
        `The before build's runtime was supported; the after build's support status is not known: ${detail}.`,
      );
  }
  return out;
}

const RULE_RANK = (rule: string): number => POLICY_RULES.indexOf(rule as PolicyRuleId);

/** True when the day of `now` (UTC) is after `expires`. */
function expired(expires: string | undefined, now: Date): boolean {
  return expires !== undefined && now.toISOString().slice(0, 10) > expires;
}

/**
 * Applies a policy to a comparison. Pure: the same comparison, policy, baseline and day give the
 * same result.
 *
 * Status: `fail` when a counted finding at level fail is not unknown; otherwise `incomplete` when
 * `unknown` is `fail` and a rule at level fail has a counted unknown finding or a coverage gap;
 * otherwise `pass`. Counted means state `new` or `suppression-expired`. A warn-level rule never
 * changes the status. Unknown findings stay listed under `warn` and `allow`.
 */
export function evaluatePolicy(
  r: ReleaseComparison,
  loaded: LoadedPolicy,
  options: EvaluateOptions = {},
): PolicyResult {
  const { policy } = loaded;
  const now = options.now ?? new Date();
  const { sides } = options;
  const drafts: Draft[] = [];
  const incomplete: PolicyResult["incomplete"] = [];
  const kind = (side: "a" | "b"): string =>
    sides?.kind[side] ?? FORMAT_KIND[r[side].info.format] ?? r[side].info.format;
  const [kindA, kindB] = [kind("a"), kind("b")];
  /** A list a rule needs that one of the analyses cannot produce: nothing can be decided. */
  const missing = (collection: string): boolean =>
    kindA !== kindB || !(KIND_LISTS[kindA]?.has(collection) ?? false);
  // Unresolved values that cannot hide a host do not leave the host rule open (`hostKnown`).
  const hostsKnown = targetHostsKnown(r, sides, "a") && targetHostsKnown(r, sides, "b");
  for (const rule of POLICY_RULES) {
    const cfg = policy.rules[rule];
    if (cfg.level === "off") continue;
    const collections = RULE_COLLECTIONS[rule](r);
    for (const collection of new Set([...collections, ...RULE_COVERAGE[rule](r)])) {
      const ignore = [
        ...(IRRELEVANT_GAPS[rule]?.[collection] ?? []),
        ...(rule === "new-external-host" && hostsKnown ? ["values_unresolved"] : []),
      ];
      const gaps = completenessOf(r, collection).gaps.filter((g) => !ignore.includes(g));
      // The runtime exists only for packaged builds: with neither side one, the rule has nothing
      // to compare (it reads nothing); with one side only, it cannot tell what moved.
      if (rule === "fuse-weakened") {
        if (r.overview.onlyA.includes(collection) || r.overview.onlyB.includes(collection))
          gaps.unshift("collection_missing");
      } else if (missing(collection)) gaps.unshift("collection_missing");
      if (gaps.length) incomplete.push({ rule, collection, gaps });
    }
    if (rule === "new-interface-member") drafts.push(...interfaceDrafts(r, collections[0]!, sides));
    if (rule === "new-external-host") drafts.push(...hostDrafts(r, cfg.allow ?? [], sides));
    if (rule === "window-more-permissive") drafts.push(...windowDrafts(r, sides));
    if (rule === "new-bridge-exposure") drafts.push(...exposureDrafts(r, sides));
    if (rule === "fuse-weakened") drafts.push(...fuseDrafts(r, sides));
    if (rule === "remote-enabled") drafts.push(...remoteDrafts(r, sides));
    if (rule === "new-unsafe-switch") drafts.push(...switchDrafts(r, sides));
    if (rule === "new-open-external") drafts.push(...openExternalDrafts(r, sides));
    if (rule === "permission-handler-grants-all") drafts.push(...permissionDrafts(r, sides));
    if (rule === "csp-weakened") drafts.push(...cspDrafts(r, sides));
    if (rule === "navigation-limit-removed") drafts.push(...navigationDrafts(r, sides));
    if (rule === "new-dangerous-call") drafts.push(...dangerousCallDrafts(r, sides));
    if (rule === "new-insecure-webview") drafts.push(...webviewDrafts(r, sides));
    if (rule === "new-custom-protocol") drafts.push(...protocolDrafts(r, sides));
    if (rule === "new-http-resource") drafts.push(...httpResourceDrafts(r, sides));
  }

  const accepted = new Set(
    options.baseline?.baseline.fingerprints.map((f) => `${f.rule}\0${f.fingerprint}`),
  );
  let matched = 0;
  const findings: PolicyFinding[] = collect(drafts).map((d) => {
    // An unknown ("may be new") has its own fingerprint, so accepting it never accepts the same
    // item once it is known to be new.
    const fingerprint = fingerprintOf(d.rule, d.unknown ? `maybe\0${d.identity}` : d.identity);
    const level = policy.rules[d.rule].level as "fail" | "warn";
    const sup = policy.suppressions.find((s) => s.rule === d.rule && s.fingerprint === fingerprint);
    let state: PolicyFinding["state"] = "new";
    if (sup) state = expired(sup.expires, now) ? "suppression-expired" : "suppressed";
    else if (accepted.has(`${d.rule}\0${fingerprint}`)) state = "baselined";
    if (accepted.has(`${d.rule}\0${fingerprint}`)) matched++;
    return {
      rule: d.rule,
      fingerprint,
      level,
      state,
      row: rowId(d.row),
      collection: d.row.collection,
      key: d.key,
      message: d.message,
      where: d.where,
      unknown: d.unknown,
      ...(d.row.basis ? { basis: d.row.basis } : {}),
      ...(d.rule === "new-interface-member" && d.row.trace ? { trace: d.row.trace } : {}),
      ...(sup
        ? { suppression: { reason: sup.reason, ...(sup.expires ? { expires: sup.expires } : {}) } }
        : {}),
    };
  });
  findings.sort(
    (x, y) =>
      RULE_RANK(x.rule) - RULE_RANK(y.rule) ||
      (x.key < y.key ? -1 : x.key > y.key ? 1 : 0) ||
      (x.fingerprint < y.fingerprint ? -1 : 1),
  );

  const counted = (f: PolicyFinding): boolean =>
    f.state === "new" || f.state === "suppression-expired";
  let status: PolicyResult["status"] = "pass";
  if (findings.some((f) => counted(f) && f.level === "fail" && !f.unknown)) status = "fail";
  else if (
    policy.unknown === "fail" &&
    (findings.some((f) => counted(f) && f.level === "fail" && f.unknown) ||
      incomplete.some((i) => policy.rules[i.rule as PolicyRuleId].level === "fail"))
  )
    status = "incomplete";

  return {
    hexvero: "check",
    version: 1,
    status,
    findings,
    incomplete,
    ...(options.baseline
      ? { baseline: baselineSummary(options.baseline, loaded, r, matched) }
      : {}),
    policy: { file: loaded.file, sha256: loaded.sha256 },
    a: r.a.info,
    b: r.b.info,
  };
}

function baselineSummary(
  loaded: LoadedBaseline,
  policy: LoadedPolicy,
  r: ReleaseComparison,
  matched: number,
): NonNullable<PolicyResult["baseline"]> {
  const warnings: string[] = [];
  if (loaded.baseline.policy !== policy.sha256)
    warnings.push(
      `the baseline was written for another policy (sha256 ${loaded.baseline.policy.slice(0, 12)}…)`,
    );
  if (loaded.baseline.a !== r.a.info.sha256)
    warnings.push(
      `the baseline was written against another before build (sha256 ${loaded.baseline.a.slice(0, 12)}…)`,
    );
  return {
    file: loaded.file,
    created: loaded.baseline.created,
    matched,
    ...(warnings.length ? { warnings } : {}),
  };
}

/** Rows a check reads at most; past this the collection is reported as not decidable. */
export const CHECK_MAX_ROWS = 100_000;
/** The core's largest page of rows. */
const CHECK_PAGE_ROWS = 5000;

/**
 * The session as `compareReleases` sees it during one check: the comparison and the item lists
 * are computed once and every later page reuses them, so reading N pages costs one comparison,
 * not N. (`compareReleases` pages its rows; its signature stays as it is.)
 */
function memoized(session: Session): Session {
  const cache = new Map<string, unknown>();
  const once = new Set([
    "compareAll",
    "compareCollection",
    "items",
    "coverage",
    "collections",
    "analyze",
  ]);
  return new Proxy(session, {
    get(target, name, receiver) {
      const value: unknown = Reflect.get(target, name, receiver);
      if (typeof value !== "function") return value;
      const fn = value as (...args: unknown[]) => unknown;
      if (typeof name !== "string" || !once.has(name)) return fn.bind(target);
      return (...args: unknown[]) => {
        const key = `${name}\0${JSON.stringify(args)}`;
        if (!cache.has(key)) cache.set(key, fn.apply(target, args));
        return cache.get(key);
      };
    },
  });
}

/**
 * The whole comparison a check needs: every row, not the first page a reader is shown. Pages of
 * the core's largest size are read until `page.next` is null; past CHECK_MAX_ROWS rows the
 * remaining ones are not read and every rule is reported as undecidable ("budget"), never as
 * passed.
 */
export async function comparisonForCheck(
  session: Session,
  idA: string,
  idB: string,
): Promise<ReleaseComparison> {
  const once = memoized(session);
  const first = await compareReleases(once, idA, idB, { offset: 0, limit: CHECK_PAGE_ROWS });
  const changes = [...first.changes];
  let next = first.page.next;
  while (next !== null && changes.length < CHECK_MAX_ROWS) {
    const more = await compareReleases(once, idA, idB, { offset: next, limit: CHECK_PAGE_ROWS });
    changes.push(...more.changes);
    next = more.page.next;
  }
  const page = { ...first.page, offset: 0, limit: changes.length, next };
  if (next === null) return { ...first, changes, cut: [], page };
  // Rows left unread: mark every collection incomplete so no rule can pass on a part.
  const completeness = Object.fromEntries(
    Object.entries(first.completeness).map(([name, c]) => [
      name,
      { ...c, complete: false, gaps: [...new Set([...c.gaps, "budget"])].toSorted() },
    ]),
  );
  return { ...first, changes, completeness, page };
}

/** The lists the rules read, per side, for `CheckSides.items`. */
const RULE_LISTS = [
  "interfaces",
  "contextBridge",
  "bridgeExposures",
  "remoteEnabled",
  "switches",
  "openExternal",
  "permissionHandlers",
  "csp",
  "navigationHandlers",
  "dangerousCalls",
  "webviews",
  "protocols",
  "loads",
  "windows",
  "webPreferences",
  "endpoints",
  "urls",
  "runtime",
];

/**
 * For an app directory without package.json or JavaScript: an archive or nested app that is the
 * likelier thing to check (`resources/app.asar`, `resources/app/package.json`). Looks only at the
 * top and at `resources/`, by name.
 */
function appHints(dir: string): { asar?: string; nestedPackage?: string } {
  const out: { asar?: string; nestedPackage?: string } = {};
  for (const sub of ["", "resources"]) {
    let names: string[];
    try {
      names = readdirSync(join(dir, sub)).toSorted();
    } catch {
      continue;
    }
    const asar = names.find((n) => n.toLowerCase().endsWith(".asar"));
    if (asar && !out.asar) out.asar = join(dir, sub, asar);
  }
  const nested = join(dir, "resources", "app", "package.json");
  try {
    if (statSync(nested).isFile()) out.nestedPackage = nested;
  } catch {
    // no nested app
  }
  return out;
}

async function sidesOf(session: Session, idA: string, idB: string): Promise<CheckSides> {
  const side = async (id: string) => {
    const [analysis, lists] = await Promise.all([session.analyze(id), session.collections(id)]);
    const items: Partial<Record<string, readonly unknown[]>> = {};
    for (const name of RULE_LISTS) items[name] = name in lists ? await session.items(id, name) : [];
    return { kind: analysis.data.kind as string, items };
  };
  const [a, b] = await Promise.all([side(idA), side(idB)]);
  return { kind: { a: a.kind, b: b.kind }, items: { a: a.items, b: b.items } };
}

/**
 * Compares two opened targets and applies the policy: `hexvero check` without the printing.
 * Both must be JavaScript applications (an Electron archive or app directory) or both
 * JavaScript bundles; anything else is refused with an `invalid_input` error (CLI exit 1)
 * rather than passed for lack of anything to check.
 */
export async function checkRelease(
  session: Session,
  idA: string,
  idB: string,
  policy: LoadedPolicy,
  options: EvaluateOptions = {},
): Promise<PolicyResult> {
  const sides = await sidesOf(session, idA, idB);
  for (const side of ["a", "b"] as const)
    if (!checkableKind(sides.kind[side]))
      throw new AnalysisError(
        "invalid_input",
        `hexvero check compares two builds of a JavaScript application (an Electron .asar, an app directory or a bundle); ${side === "a" ? "before" : "after"} is ${sides.kind[side]} (${session.get(side === "a" ? idA : idB).info.format})`,
      );
  if (sides.kind.a !== sides.kind.b)
    throw new AnalysisError(
      "invalid_input",
      `hexvero check compares two builds of the same kind; before is ${sides.kind.a}, after is ${sides.kind.b}`,
    );
  // An app with nothing hexvero could read (an empty directory, one without JavaScript, files
  // that are only links out of it) would pass every rule for lack of findings: refuse it. A
  // missing package.json at the top is only a warning: an electron-vite `out/` directory or a
  // `linux-unpacked/` build with resources/app are real things to check.
  const warnings: string[] = [];
  if (sides.kind.a === "javascript-app")
    for (const side of ["a", "b"] as const) {
      const id = side === "a" ? idA : idB;
      const { data } = await session.analyze(id);
      if (data.kind !== "javascript-app") continue;
      const info = session.get(id).info;
      const name = side === "a" ? "before" : "after";
      const hints = info.format === "directory" ? appHints(info.path) : null;
      if (data.app.modules.length === 0)
        throw new AnalysisError(
          "invalid_input",
          `nothing to check: the ${name} build ${info.path} has no JavaScript module hexvero could read (an empty directory, no .js files, or only links that lead out of it)${
            hints?.asar ? `; check ${hints.asar} instead` : ""
          }`,
          { side },
        );
      if (data.app.package === null)
        warnings.push(
          `${name} build: no package.json at the top: entry and Electron version unknown${
            hints?.nestedPackage
              ? ` (${hints.nestedPackage} exists; check that directory instead)`
              : ""
          }`,
        );
    }
  let comparison = await comparisonForCheck(session, idA, idB);
  // A directory has no file digest; give it a content digest so a baseline can tell its builds.
  const partial: string[] = [];
  for (const side of ["a", "b"] as const) {
    const info = comparison[side].info;
    if (info.format !== "directory" || info.sha256) continue;
    if (!options.baseline && !options.digest) continue;
    const digest = directoryDigest(info.path);
    if (digest.partial)
      partial.push(`${side === "a" ? "before" : "after"} build: ${digest.partial}`);
    comparison = {
      ...comparison,
      [side]: { ...comparison[side], info: { ...info, sha256: digest.sha256 } },
    };
  }
  const result = evaluatePolicy(comparison, policy, { ...options, sides: options.sides ?? sides });
  if (warnings.length) result.warnings = warnings;
  // The digest only matters for a baseline: say there when it does not cover the whole build.
  if (result.baseline && partial.length)
    result.baseline = {
      ...result.baseline,
      warnings: [...(result.baseline.warnings ?? []), ...partial],
    };
  return result;
}

/** Exit codes of `hexvero check` (contract C6). */
export const CHECK_EXIT: Record<PolicyResult["status"], number> = {
  pass: 0,
  error: 1,
  fail: 3,
  incomplete: 4,
};

// ---------------------------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------------------------

const baseName = (path: string): string => path.split(/[\\/]/).pop() ?? path;
/** Target text inside a code span that it cannot close. */
const code = (text: string): string => {
  const flat = plain(text);
  const longest = Math.max(0, ...(flat.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  const pad = longest || flat.startsWith(" ") || flat.endsWith(" ") ? " " : "";
  return `${fence}${pad}${flat}${pad}${fence}`;
};
/** A code span inside a table cell: GitHub splits cells at `|` even inside code spans. */
const cellCode = (text: string): string => code(text).replace(/\|/g, "\\|");
/** Prose from a target with every Markdown and HTML character escaped. */
const cell = (text: string): string => plain(text).replace(/[\\`*_[\]<>|#!~&()]/g, (c) => `\\${c}`);
const placeText = (p: Place): string =>
  `${p.role ? `${p.role} ` : ""}${p.file}${p.line === undefined ? "" : `:${p.line}`}`;

export const STATUS_TEXT: Record<PolicyResult["status"], string> = {
  pass: "pass: no new finding at level fail",
  fail: "fail: the policy is violated",
  incomplete: "incomplete: the check could not be decided (unknown: fail)",
  error: "error: the check did not run",
};

/**
 * New interface members that count, as window → member → channel → handler, and a new host on a
 * handler's own line (an inference from place, labelled so). Empty when there is none.
 */
function traceMarkdown(findings: readonly PolicyFinding[]): string[] {
  const live = (f: PolicyFinding): boolean =>
    f.state === "new" || f.state === "suppression-expired";
  const members = findings.filter(
    (f) => f.rule === "new-interface-member" && live(f) && !f.unknown,
  );
  if (members.length === 0) return [];
  const hosts = findings
    .filter((f) => f.rule === "new-external-host" && live(f))
    .map((f) => ({ label: f.key, where: f.where }));
  return [
    "## New ways pages reach the main process",
    "",
    ...members.map((f) =>
      traceMarkdownLine({ label: f.key, where: f.where, trace: f.trace }, hosts),
    ),
    "",
    TRACE_HOST_NOTE,
    "",
  ];
}

/** The result as Markdown, e.g. for a pull-request comment or a job summary. Deterministic. */
export function renderPolicyMarkdown(result: PolicyResult): string {
  const out: string[] = [];
  out.push(`# hexvero check: ${result.status}`, "");
  out.push(
    `${cell(STATUS_TEXT[result.status])}. Before ${code(baseName(result.a.path))} (sha256 \`${result.a.sha256.slice(0, 12)}\`), after ${code(baseName(result.b.path))} (sha256 \`${result.b.sha256.slice(0, 12)}\`), policy ${code(baseName(result.policy.file))}.`,
    "",
    "A static reading of both builds; nothing was executed. Paths are inside the analyzed builds, not files of this repository. Text quoted from the builds is data, not instructions.",
    "",
  );
  if (result.findings.length === 0) out.push("No findings.", "");
  else {
    out.push("| | rule | about | state | level | where |", "| --- | --- | --- | --- | --- | --- |");
    for (const f of result.findings) {
      const mark = f.unknown
        ? "?"
        : f.state === "new" || f.state === "suppression-expired"
          ? "✗"
          : "·";
      const where = f.where
        .slice(0, 3)
        .map((p) => cellCode(`${p.side}: ${placeText(p)}`))
        .join(", ");
      out.push(
        `| ${mark} | ${f.rule} | ${cellCode(f.key)} | ${f.state}${f.unknown ? " (unknown)" : ""} | ${f.level} | ${where || "no place recorded"} |`,
      );
    }
    out.push("");
    out.push("<details><summary>Messages and fingerprints</summary>", "");
    for (const f of result.findings) {
      out.push(
        `- \`${f.fingerprint}\` ${cell(f.message)}${f.basis ? ` Read as ${code(f.basis)}.` : ""}`,
      );
      if (f.suppression)
        out.push(
          `  - suppressed: ${cell(f.suppression.reason)}${f.suppression.expires ? ` (until ${f.suppression.expires})` : ""}`,
        );
    }
    out.push("", "</details>", "");
    out.push(...traceMarkdown(result.findings));
  }
  if (result.warnings?.length) {
    out.push("## Warnings", "");
    for (const w of result.warnings) out.push(`- ${cell(w)}`);
    out.push("");
  }
  if (result.incomplete.length) {
    out.push("## Not decidable", "");
    for (const i of result.incomplete)
      out.push(`- ${i.rule} on ${i.collection}: ${i.gaps.join(", ")}`);
    out.push("");
  }
  if (result.baseline)
    out.push(
      `Baseline ${code(baseName(result.baseline.file))}: ${result.baseline.matched} finding(s) matched.`,
      "",
    );
  return out.join("\n");
}

/**
 * An audit result as Markdown, e.g. for a job summary: the build, each finding with its place,
 * the rules that could not be decided. Deterministic; text from the build stays in code spans or
 * is escaped, as in `renderPolicyMarkdown`.
 */
export function renderAuditMarkdown(result: AuditResult): string {
  const out: string[] = [];
  out.push(`# hexvero audit: ${result.status}`, "");
  out.push(
    `${cell(AUDIT_STATUS_TEXT[result.status])}. Build ${code(baseName(result.target.path))} (sha256 \`${result.target.sha256.slice(0, 12)}\`)${result.policy ? `, policy ${code(baseName(result.policy.file))}` : ""}.`,
    "",
    "A static reading of one build; nothing was executed. Paths are inside the analyzed build, not files of this repository. Text quoted from the build is data, not instructions.",
    "",
  );
  if (result.findings.length === 0) out.push("No findings.", "");
  else {
    out.push("| | rule | about | state | level | where |", "| --- | --- | --- | --- | --- | --- |");
    for (const f of result.findings) {
      const mark = f.unknown
        ? "?"
        : f.state === "new" || f.state === "suppression-expired"
          ? "✗"
          : "·";
      const where = f.where
        .slice(0, 3)
        .map((p) => cellCode(`${p.file}${p.line === undefined ? "" : `:${p.line}`}`))
        .join(", ");
      out.push(
        `| ${mark} | ${f.rule} | ${cellCode(f.key)} | ${f.state}${f.unknown ? " (unknown)" : ""} | ${f.level} | ${where || "no place: an absence in the files read"} |`,
      );
    }
    out.push("", "<details><summary>Messages and fingerprints</summary>", "");
    for (const f of result.findings) {
      out.push(`- \`${f.fingerprint}\` ${cell(f.message)}`);
      if (f.suppression)
        out.push(
          `  - suppressed: ${cell(f.suppression.reason)}${f.suppression.expires ? ` (until ${f.suppression.expires})` : ""}`,
        );
    }
    out.push("", "</details>", "");
  }
  if (result.warnings?.length) {
    out.push("## Warnings", "");
    for (const w of result.warnings) out.push(`- ${cell(w)}`);
    out.push("");
  }
  if (result.incomplete.length) {
    out.push("## Not decidable", "");
    for (const i of result.incomplete)
      out.push(`- ${i.rule} on ${i.collection}: ${i.gaps.join(", ")}`);
    out.push("");
  }
  if (result.baseline)
    out.push(
      `Baseline ${code(baseName(result.baseline.file))}: ${result.baseline.matched} finding(s) matched.`,
      "",
    );
  return out.join("\n");
}
