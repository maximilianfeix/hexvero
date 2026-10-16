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
import { compareReleases, type ChangeRow, type Place, type ReleaseComparison } from "./report.js";
import type { Session, TargetRecord } from "./session.js";

export const POLICY_RULES = [
  "new-interface-member",
  "new-external-host",
  "window-more-permissive",
] as const;
export type PolicyRuleId = (typeof POLICY_RULES)[number];

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

export interface Policy {
  hexvero: "policy";
  version: 1;
  rules: Record<PolicyRuleId, RuleConfig>;
  unknown: UnknownHandling;
  suppressions: Suppression[];
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
}

export interface PolicyResult {
  hexvero: "check";
  version: 1;
  status: "pass" | "fail" | "incomplete" | "error";
  findings: PolicyFinding[];
  /** Coverage gaps that made the check undecidable for a rule. */
  incomplete: Array<{ rule: string; collection: string; gaps: string[] }>;
  baseline?: { file: string; created: string; matched: number };
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
  const text = JSON.stringify(v) ?? String(v);
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
    if (!["$schema", "hexvero", "version", "rules", "unknown", "suppressions"].includes(k))
      issues.push(`${k}: unknown key (allowed: hexvero, version, rules, unknown, suppressions)`);
  if (raw["hexvero"] !== "policy")
    issues.push(`hexvero: must be "policy", got ${quote(raw["hexvero"])}`);
  if (raw["version"] !== 1)
    issues.push(`version: this hexvero reads policy version 1, got ${quote(raw["version"])}`);
  if (raw["$schema"] !== undefined && typeof raw["$schema"] !== "string")
    issues.push(`$schema: must be a string`);

  const rules = {} as Record<PolicyRuleId, RuleConfig>;
  for (const id of POLICY_RULES) rules[id] = { level: "fail" };
  const rawRules = raw["rules"];
  if (rawRules === undefined) issues.push(`rules: missing (an object with one entry per rule)`);
  else if (!isRecord(rawRules)) issues.push(`rules: must be an object`);
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

  const suppressions: Suppression[] = [];
  const rawSup = raw["suppressions"];
  if (rawSup !== undefined && !Array.isArray(rawSup)) issues.push(`suppressions: must be a list`);
  else
    (rawSup ?? []).forEach((s: unknown, i: number) => {
      const path = `suppressions[${i}]`;
      if (!isRecord(s)) {
        issues.push(`${path}: must be an object with rule, fingerprint and reason`);
        return;
      }
      for (const k of Object.keys(s))
        if (!["rule", "fingerprint", "reason", "expires"].includes(k))
          issues.push(`${path}.${k}: unknown key (allowed: rule, fingerprint, reason, expires)`);
      const before = issues.length;
      if (!(POLICY_RULES as readonly unknown[]).includes(s["rule"]))
        issues.push(
          `${path}.rule: must be one of ${POLICY_RULES.join(", ")}, got ${quote(s["rule"])}`,
        );
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
        suppressions.push({
          rule: s["rule"] as PolicyRuleId,
          fingerprint: s["fingerprint"] as string,
          reason: s["reason"] as string,
          ...(typeof s["expires"] === "string" ? { expires: s["expires"] } : {}),
        });
    });

  if (issues.length) throw new PolicyError(`invalid policy ${file}`, issues);
  return {
    policy: { hexvero: "policy", version: 1, rules, unknown, suppressions },
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

/** Limitation codes of the JavaScript analysis and the C1 gap each one means, per collection. */
const LIMITATION_GAPS: Record<string, { gap: string; collections: readonly string[] | "all" }> = {
  js_files_truncated: { gap: "files_unread", collections: "all" },
  js_files_skipped: { gap: "files_unreadable", collections: "all" },
  scan_truncated: { gap: "files_unreadable", collections: "all" },
  file_truncated: { gap: "files_unreadable", collections: "all" },
  ipc_channel_unresolved: {
    gap: "values_unresolved",
    collections: ["ipcChannels", "ipc", "interfaces"],
  },
  ipc_receiver_unresolved: {
    gap: "values_unresolved",
    collections: ["ipcChannels", "ipc", "interfaces"],
  },
  window_options_unresolved: {
    gap: "values_unresolved",
    collections: ["windows", "webPreferences"],
  },
  webpreferences_computed: { gap: "values_unresolved", collections: ["windows", "webPreferences"] },
  web_preferences_truncated: { gap: "item_truncated", collections: ["windows", "webPreferences"] },
};

/**
 * Completeness of one collection of the comparison.
 * TODO(C3): `r.completeness[collection]` is used when present; the local reading below is the
 * stand-in until B's comparison carries it, and is removed then.
 */
export function completenessOf(r: ReleaseComparison, collection: string): Completeness {
  const given = (r as ReleaseComparison & { completeness?: Record<string, Completeness> })
    .completeness;
  if (given && isRecord(given)) {
    const c = given[collection];
    return c ? { complete: c.complete, gaps: [...c.gaps] } : { complete: true, gaps: [] };
  }
  const gaps = new Set<string>();
  const c = r.overview.collections.find((x) => x.collection === collection);
  if (c?.partial) gaps.add("budget");
  if (r.cut.some((x) => x.collection === collection)) gaps.add("budget");
  if (r.overview.partialScan.a || r.overview.partialScan.b) gaps.add("scan_partial");
  for (const l of [...r.limitations.a, ...r.limitations.b]) {
    const m = LIMITATION_GAPS[l.code];
    if (m && (m.collections === "all" || m.collections.includes(collection))) gaps.add(m.gap);
  }
  return { complete: gaps.size === 0, gaps: [...gaps].toSorted() };
}

// ---------------------------------------------------------------------------------------------
// Semantic identities
// ---------------------------------------------------------------------------------------------

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
  const key = r.overview.collections.find((c) => c.collection === row.collection)?.key;
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
  const m = /[a-z][a-z0-9+.-]*:\/\/.*$/i.exec(row.key) ?? /\$\{.*$/.exec(row.key);
  return m ? m[0] : row.key;
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
  const v = value.trim();
  let authority: string;
  let scheme: string;
  const m = /^([a-z][a-z0-9+.-]*:)?\/\/([^/?#]*)/i.exec(v);
  if (m) {
    scheme = (m[1] ?? "https:").toLowerCase();
    authority = m[2]!;
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(v)) return { kind: "none" };
  else if (v.startsWith("${") || v.startsWith("`"))
    return { kind: "unknown", why: "the start of the URL is computed at run time" };
  else return { kind: "none" };
  if (!NETWORK_SCHEMES.has(scheme)) return { kind: "none" };
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

export interface EvaluateOptions {
  baseline?: LoadedBaseline | undefined;
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

function interfaceDrafts(r: ReleaseComparison, collection: string): Draft[] {
  const out: Draft[] = [];
  for (const row of r.changes) {
    if (row.collection !== collection || (row.change !== "added" && row.change !== "unknown"))
      continue;
    const { id, label } = memberIdentity(r, row);
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

function hostDrafts(r: ReleaseComparison, allow: readonly string[]): Draft[] {
  const out: Draft[] = [];
  for (const row of r.changes) {
    if (row.collection !== "endpoints" && row.collection !== "urls") continue;
    if (row.change !== "added" && row.change !== "unknown") continue;
    const value = valueOf(r, row);
    const reading = hostOf(value);
    if (reading.kind === "none") continue;
    if (reading.kind === "unknown") {
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
    if (hostAllowed(reading.host, allow)) continue;
    const unknown = row.change === "unknown";
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

function windowDrafts(r: ReleaseComparison): Draft[] {
  const out: Draft[] = [];
  for (const w of r.overview.windowChanges) {
    if (w.direction === "less permissive") continue;
    const row: ChangeRow = r.changes.find(
      (c) => c.collection === "windows" && c.key === w.window,
    ) ?? { collection: "windows", change: "changed", key: w.window, where: [] };
    const unknown = w.direction === "unclear";
    out.push({
      rule: "window-more-permissive",
      identity: `window\0${w.window}\0${w.setting}\0${w.after}`,
      row,
      key: `${w.window} ${w.setting}`,
      message: unknown
        ? `Window ${plain(w.window)}: ${w.setting} changed from ${plain(w.before)} to ${plain(w.after)}; whether pages may now do more is not known.`
        : `Window ${plain(w.window)} lets its pages do more: ${w.setting} ${plain(w.before)} → ${plain(w.after)}.`,
      where: row.where,
      unknown,
    });
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
  const drafts: Draft[] = [];
  const incomplete: PolicyResult["incomplete"] = [];
  for (const rule of POLICY_RULES) {
    const cfg = policy.rules[rule];
    if (cfg.level === "off") continue;
    const collections = RULE_COLLECTIONS[rule](r);
    for (const collection of collections) {
      const c = completenessOf(r, collection);
      if (!c.complete) incomplete.push({ rule, collection, gaps: c.gaps });
    }
    if (rule === "new-interface-member") drafts.push(...interfaceDrafts(r, collections[0]!));
    if (rule === "new-external-host") drafts.push(...hostDrafts(r, cfg.allow ?? []));
    if (rule === "window-more-permissive") drafts.push(...windowDrafts(r));
  }

  const accepted = new Set(
    options.baseline?.baseline.fingerprints.map((f) => `${f.rule}\0${f.fingerprint}`),
  );
  let matched = 0;
  const findings: PolicyFinding[] = collect(drafts).map((d) => {
    const fingerprint = fingerprintOf(d.rule, d.identity);
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
      ? {
          baseline: {
            file: options.baseline.file,
            created: options.baseline.baseline.created,
            matched,
          },
        }
      : {}),
    policy: { file: loaded.file, sha256: loaded.sha256 },
    a: r.a.info,
    b: r.b.info,
  };
}

/** Rows a check reads at most; past this the collection is reported as not decidable. */
export const CHECK_MAX_ROWS = 100_000;

/**
 * The whole comparison a check needs: every row, not the first page a reader is shown.
 * TODO(C3): once `compareReleases` pages its rows (`{ offset, limit }` and `page.next`), this
 * loops over the pages up to CHECK_MAX_ROWS instead of asking for one large page.
 */
export async function comparisonForCheck(
  session: Session,
  idA: string,
  idB: string,
): Promise<ReleaseComparison> {
  return compareReleases(session, idA, idB, { maxRows: CHECK_MAX_ROWS });
}

/** Compares two opened targets and applies the policy: `hexvero check` without the printing. */
export async function checkRelease(
  session: Session,
  idA: string,
  idB: string,
  policy: LoadedPolicy,
  options: EvaluateOptions = {},
): Promise<PolicyResult> {
  return evaluatePolicy(await comparisonForCheck(session, idA, idB), policy, options);
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
