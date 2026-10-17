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
import { AnalysisError } from "./model.js";
import { compareReleases, type ChangeRow, type Place, type ReleaseComparison } from "./report.js";
import type { Session, TargetRecord } from "./session.js";

export const POLICY_RULES = [
  "new-interface-member",
  "new-external-host",
  "window-more-permissive",
  "new-bridge-exposure",
] as const;
export type PolicyRuleId = (typeof POLICY_RULES)[number];

/** Rules added after 0.9.6: they run at warn when a policy does not list them. */
const LATER_RULES: ReadonlySet<PolicyRuleId> = new Set(["new-bridge-exposure"]);

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
  // A rule a policy does not list runs at fail, except rules added after a policy could have been
  // written for them: they start at warn, so an upgrade never turns a passing check red.
  for (const id of POLICY_RULES) rules[id] = { level: LATER_RULES.has(id) ? "warn" : "fail" };
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
    "windows",
    "endpoints",
    "urls",
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
  interfaces: "file+api+member",
  contextBridge: "api+member",
  windows: "file+windowName",
  endpoints: "file+kind+value",
  urls: "file+value",
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
};

/**
 * Gaps that do not bear on a rule in a list it reads. For the interface rule, a value hexvero
 * could not resolve in `interfaces` is a channel name: it decides which handler a member reaches,
 * not whether the member exists (an unreadable bridge member is a gap of `contextBridge` itself).
 * Every other gap of `interfaces` (budget, unread files, truncation) still counts.
 */
const IRRELEVANT_GAPS: Partial<Record<PolicyRuleId, Record<string, readonly string[]>>> = {
  "new-interface-member": { interfaces: ["values_unresolved"] },
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
    if (!f || typeof f["api"] !== "string" || f["exposed"] === undefined) continue;
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

function windowDrafts(r: ReleaseComparison, sides: CheckSides | undefined): Draft[] {
  const out: Draft[] = [];
  for (const w of r.overview.windowChanges) {
    if (w.direction === "less permissive") continue;
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
  out.push(...unmatchedWindowDrafts(r, sides));
  return out;
}

/** For each derived window setting, the values under which a page can do more. */
const PERMISSIVE: Record<string, readonly string[]> = {
  nodeIntegrationInEffect: ["on", "default on"],
  contextIsolationInEffect: ["off", "default off"],
  sandboxInEffect: ["off", "default off"],
  pageRequire: ["yes", "yes by default"],
};

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
    for (const setting of Object.keys(PERMISSIVE)) {
      const value = String(item[setting] ?? "unknown");
      const open = PERMISSIVE[setting]!.includes(value);
      if (!open && value !== "unknown") continue;
      const twin = open && row.change === "added" ? removedOpen(setting) : undefined;
      const unknown = row.change === "unknown" || value === "unknown" || twin !== undefined;
      out.push({
        rule: "window-more-permissive",
        identity: `window\0${row.key}\0${setting}\0${value}`,
        row,
        key: `${row.key} ${setting}`,
        message:
          row.change === "unknown"
            ? `Window ${label} may be new (${plain(row.reason ?? "the comparison could not tell")}): ${setting} is ${plain(value)}.`
            : value === "unknown"
              ? `New window ${label}: whether ${setting} lets its pages do more is not known.`
              : twin !== undefined
                ? `New window ${label} has ${setting} ${plain(value)}; it may be ${plain(twin)} renamed, which had it too.`
                : `New window ${label} lets its pages do more: ${setting} is ${plain(value)}.`,
        where: row.where,
        unknown,
      });
    }
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
  for (const rule of POLICY_RULES) {
    const cfg = policy.rules[rule];
    if (cfg.level === "off") continue;
    const collections = RULE_COLLECTIONS[rule](r);
    for (const collection of new Set([...collections, ...RULE_COVERAGE[rule](r)])) {
      const ignore = IRRELEVANT_GAPS[rule]?.[collection] ?? [];
      const gaps = completenessOf(r, collection).gaps.filter((g) => !ignore.includes(g));
      if (missing(collection)) gaps.unshift("collection_missing");
      if (gaps.length) incomplete.push({ rule, collection, gaps });
    }
    if (rule === "new-interface-member") drafts.push(...interfaceDrafts(r, collections[0]!, sides));
    if (rule === "new-external-host") drafts.push(...hostDrafts(r, cfg.allow ?? [], sides));
    if (rule === "window-more-permissive") drafts.push(...windowDrafts(r, sides));
    if (rule === "new-bridge-exposure") drafts.push(...exposureDrafts(r, sides));
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
const RULE_LISTS = ["interfaces", "contextBridge", "windows", "endpoints", "urls"];

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
  const comparison = await comparisonForCheck(session, idA, idB);
  return evaluatePolicy(comparison, policy, { ...options, sides: options.sides ?? sides });
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
