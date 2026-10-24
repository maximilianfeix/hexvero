/**
 * `hexvero audit <build>`: the rules that make sense on one build, applied to its own lists. The
 * same reading as `check`, without a before build: a finding is what the build has, not what
 * changed. Status and exit codes are `check`'s (0 pass, 3 violated, 4 not decidable under
 * `unknown: fail`); a rule whose list may be missing rows (a partial scan, a file that could not
 * be read, a capped list) is not decidable rather than passed.
 *
 * The rules are Electronegativity's checks that hexvero reads (docs/engineering/audit-plan.md
 * maps them): windows whose pages may do more, @electron/remote enabled, dangerous command-line
 * switches and accepted certificate errors, shell.openExternal with a URL the app does not fix,
 * permission handlers missing or granting everything, and a Content Security Policy missing or
 * weak.
 */
import { createHash } from "node:crypto";
import type { SideCoverage, UnresolvedFamily } from "./compare.js";
import type { CspRow, JsAppInfo, OpenExternalRow, PermissionHandlerRow } from "./javascript/app.js";
import { AnalysisError, type Limitation } from "./model.js";
import type { Session, TargetRecord } from "./session.js";

export const AUDIT_RULES = [
  "window-permissive",
  "remote-enabled",
  "unsafe-switch",
  "open-external",
  "permission-handler-missing",
  "permission-handler-grants-all",
  "csp-missing",
  "csp-weak",
] as const;
export type AuditRuleId = (typeof AUDIT_RULES)[number];

export interface AuditPlace {
  file: string;
  line?: number;
}

export interface AuditFinding {
  rule: AuditRuleId;
  /** sha256 hex (first 32) of `${rule}\0${identity}`; independent of lines and order. */
  fingerprint: string;
  /** True when hexvero could not tell whether the rule is violated here. */
  unknown: boolean;
  key: string;
  message: string;
  /** The list the finding is read from. */
  collection: string;
  where: AuditPlace[];
}

export interface AuditResult {
  hexvero: "audit";
  version: 1;
  status: "pass" | "fail" | "incomplete";
  findings: AuditFinding[];
  /** Rules that could not be decided, with the gaps (the same codes as `check`). */
  incomplete: Array<{ rule: AuditRuleId; collection: string; gaps: string[] }>;
  /** How unknown findings and gaps were counted. */
  unknown: "fail" | "warn" | "allow";
  warnings?: string[];
  target: TargetRecord["info"];
}

export const AUDIT_STATUS_TEXT: Record<AuditResult["status"], string> = {
  pass: "pass: no finding",
  fail: "fail: a rule is violated",
  incomplete: "incomplete: a rule could not be decided (unknown: fail)",
};

export interface AuditOptions {
  /** `fail` (default): an unknown finding or a gap makes the status `incomplete`. */
  unknown?: "fail" | "warn" | "allow" | undefined;
}

/** For each derived window setting, the values under which a page can do more. */
const PERMISSIVE: Readonly<Record<string, readonly string[]>> = {
  nodeIntegrationInEffect: ["on", "default on"],
  contextIsolationInEffect: ["off", "default off"],
  sandboxInEffect: ["off", "default off"],
  pageRequire: ["yes", "yes by default"],
};

/** URL schemes `open-external` takes as fixed by the app: they open a browser or a mail client. */
const WEB_SCHEMES = new Set(["http", "https", "mailto"]);

/**
 * Whether an openExternal call opens a URL the app does not fix: `fail` on Electron's shell,
 * `unknown` on a receiver not read as it; null when the URL is a literal or its known part fixes
 * the scheme to http, https or mailto.
 */
export function openExternalRisk(row: OpenExternalRow): "fail" | "unknown" | null {
  if (row.argumentKind === "literal") return null;
  if (row.argumentKind === "inferred" && row.scheme !== null && WEB_SCHEMES.has(row.scheme))
    return null;
  return row.targetKind === "shell" ? "fail" : "unknown";
}

/**
 * Whether a permission handler grants every request: `fail` when it does (or is cleared) on a
 * receiver read as a session or webContents, `unknown` when that cannot be told; null otherwise.
 */
export function permissionRisk(row: PermissionHandlerRow): "fail" | "unknown" | null {
  if (row.grants === "unknown") return "unknown";
  if (row.grants !== "always") return null;
  // `X.webContents.session` is a session only if X is a window, which is not proven here
  return row.targetKind === "session" ? "fail" : "unknown";
}

/** Whether a CSP row weakens: `fail` with weaknesses, `unknown` when the policy is not read. */
export function cspRisk(row: CspRow): "fail" | "unknown" | null {
  if (row.reportOnly) return null;
  // a <meta> after the head: whether it applies at all is not known
  if (row.outsideHead || row.doubt || (row.kind === "header" && row.via !== "onHeadersReceived"))
    return row.weaknesses === null || row.weaknesses.length ? "unknown" : null;
  if (row.weaknesses === null) return "unknown";
  return row.weaknesses.length ? "fail" : null;
}

const fingerprint = (rule: AuditRuleId, identity: string): string =>
  createHash("sha256").update(`${rule}\0${identity}`).digest("hex").slice(0, 32);

/** Limitation codes that say rows of a rule's list may be missing. */
const RULE_LIMITATIONS: Partial<Record<AuditRuleId, readonly string[]>> = {
  "remote-enabled": ["remote_enabled_truncated"],
};

const RULE_FAMILY: Record<AuditRuleId, UnresolvedFamily | null> = {
  "window-permissive": "window",
  "remote-enabled": null,
  "unsafe-switch": "switches",
  "open-external": "openExternal",
  "permission-handler-missing": "permissions",
  "permission-handler-grants-all": "permissions",
  "csp-missing": "csp",
  "csp-weak": "csp",
};

const RULE_COLLECTION: Record<AuditRuleId, string> = {
  "window-permissive": "windows",
  "remote-enabled": "remoteEnabled",
  "unsafe-switch": "switches",
  "open-external": "openExternal",
  "permission-handler-missing": "permissionHandlers",
  "permission-handler-grants-all": "permissionHandlers",
  "csp-missing": "csp",
  "csp-weak": "csp",
};

/** The gaps of one rule on one build, in check's codes and order. */
function gapsOf(
  rule: AuditRuleId,
  coverage: SideCoverage | null,
  limitations: readonly Limitation[],
): string[] {
  const gaps: string[] = [];
  if (coverage && !coverage.complete) gaps.push("scan_partial");
  if (coverage && (coverage.unreadable.size > 0 || coverage.unreadableUnlisted))
    gaps.push("files_unreadable");
  const family = RULE_FAMILY[rule];
  const capped = (RULE_LIMITATIONS[rule] ?? []).some((c) => limitations.some((l) => l.code === c));
  if ((family !== null && (coverage?.unresolved.get(family)?.size ?? 0) > 0) || capped)
    gaps.push("values_unresolved");
  return gaps;
}

const place = (r: { file: string; line: number }): AuditPlace => ({ file: r.file, line: r.line });

/** The findings of every rule on one app's lists; pure. */
export function auditApp(
  app: Pick<
    JsAppInfo,
    "windows" | "remoteEnabled" | "switches" | "openExternal" | "permissionHandlers" | "csp"
  >,
): Array<Omit<AuditFinding, "fingerprint"> & { identity: string }> {
  type Draft = Omit<AuditFinding, "fingerprint"> & { identity: string };
  const out: Draft[] = [];

  for (const w of app.windows ?? []) {
    for (const [setting, open] of Object.entries(PERMISSIVE)) {
      const value = String((w as unknown as Record<string, unknown>)[setting]);
      const unknown = value === "unknown";
      if (!unknown && !open.includes(value)) continue;
      const assumed = value.includes("default");
      out.push({
        rule: "window-permissive",
        identity: `${w.file}\0${w.windowName}\0${setting}`,
        unknown,
        key: `${w.windowName} ${setting} ${value}`,
        message: unknown
          ? `Window ${w.windowName}: ${setting} cannot be told (a value computed at run time, or no Electron version named in package.json for its default).`
          : `Window ${w.windowName}: ${setting} is ${value}${assumed ? " (the default of the Electron version package.json names; an assumption about the shipped runtime)" : ""}, so its pages may do more (${w.basis}).`,
        collection: "windows",
        where: [place(w)],
      });
    }
  }

  for (const r of app.remoteEnabled ?? []) {
    if (r.kind !== "enable") continue;
    out.push({
      rule: "remote-enabled",
      identity: `${r.file}\0${r.targetKind}\0${String(r.target)}`,
      unknown: false,
      key: `enable ${String(r.target ?? "?")}`,
      message: `@electron/remote is enabled for ${r.target ?? "a webContents"} (${r.targetKind}): its pages reach main-process modules and objects through the remote module, which Electron's security guide advises against.`,
      collection: "remoteEnabled",
      where: [place(r)],
    });
  }

  for (const r of app.switches ?? []) {
    if (r.dangerous === false) continue;
    const what =
      r.kind === "switch" || r.kind === "argument"
        ? `the command-line ${r.kind} ${r.name ?? "(name not read)"}${r.value !== null ? `=${r.value}` : ""}`
        : r.kind === "certificate-error"
          ? `certificate errors accepted (${r.accepts ?? "unknown"})`
          : r.kind === "certificate-verify-proc"
            ? `a certificate verify proc that reports success (${r.accepts ?? "unknown"})`
            : r.kind;
    out.push({
      rule: "unsafe-switch",
      identity: `${r.file}\0${r.kind}\0${String(r.name)}\0${String(r.value)}\0${String(r.accepts)}`,
      unknown: r.dangerous === null,
      key: `${r.kind} ${r.name ?? r.accepts ?? "?"}`,
      message: `${r.dangerous === null ? "May weaken" : "Weakens"} a process-wide security check: ${what}${r.reason ? ` (${r.reason})` : ""}.`,
      collection: "switches",
      where: [place(r)],
    });
  }

  for (const r of app.openExternal ?? []) {
    const risk = openExternalRisk(r);
    if (!risk) continue;
    const url =
      r.argumentKind === "inferred"
        ? r.argument !== null
          ? `a URL starting ${JSON.stringify(r.argument)}`
          : `one of ${(r.values ?? []).map((v) => JSON.stringify(v)).join(", ")}`
        : "a URL that is not read";
    out.push({
      rule: "open-external",
      identity: `${r.file}\0${r.targetKind}\0${r.argumentKind}\0${String(r.argument)}`,
      unknown: risk === "unknown",
      key: `${r.target}.openExternal(${r.argumentKind === "literal" ? JSON.stringify(r.argument) : r.argumentKind})`,
      message:
        risk === "fail"
          ? `shell.openExternal opens ${url}, whose scheme the app does not fix to http, https or mailto: a URL from a page or a message may open any protocol handler or file (Electron's security guide, section 15).`
          : `${r.target}.openExternal opens ${url}; the receiver is not read as Electron's shell, so whether it is shell.openExternal is not known.`,
      collection: "openExternal",
      where: [place(r)],
    });
  }

  const handlers = app.permissionHandlers ?? [];
  const requests = handlers.filter((h) => h.kind === "request");
  if (requests.length === 0)
    out.push({
      rule: "permission-handler-missing",
      identity: "none",
      unknown: false,
      key: "no setPermissionRequestHandler",
      message:
        "No setPermissionRequestHandler was found in the files read: without one, Electron grants every permission a page asks for (camera, microphone, notifications, geolocation …); Electron's security guide, section 5.",
      collection: "permissionHandlers",
      where: [],
    });
  else if (!requests.some((h) => h.targetKind === "session" && h.session === "default"))
    out.push({
      rule: "permission-handler-missing",
      identity: "no-default-session",
      unknown: true,
      key: "no setPermissionRequestHandler read on the default session",
      message:
        "No setPermissionRequestHandler is read on session.defaultSession, the session windows use unless they name a partition: the ones found are on a partition, on a webContents' session or on a receiver not read as a session, so whether the default session has one is not known.",
      collection: "permissionHandlers",
      where: requests.slice(0, 10).map(place),
    });
  for (const r of handlers) {
    const risk = permissionRisk(r);
    if (!risk) continue;
    out.push({
      rule: "permission-handler-grants-all",
      identity: `${r.file}\0${r.kind}\0${r.targetKind}\0${String(r.session)}`,
      unknown: risk === "unknown",
      key: `${r.kind} handler on ${r.session ?? r.target}`,
      message:
        risk === "fail"
          ? `The permission ${r.kind} handler on ${r.target} grants every ${r.kind === "request" ? "request" : "check"}${r.evidence.includes("(null)") ? " (cleared with null: Electron's default grants all)" : ""}.`
          : r.grants === "unknown"
            ? `What the permission ${r.kind} handler on ${r.target} answers is not read (a handler passed by name, or its callback handed on).`
            : `The permission ${r.kind} handler on ${r.target} grants every ${r.kind === "request" ? "request" : "check"}, on a receiver not read as a session of Electron's session module.`,
      collection: "permissionHandlers",
      where: [place(r)],
    });
  }

  const csp = app.csp ?? [];
  const enforced = csp.filter((r) => !r.reportOnly);
  const applied = enforced.filter(
    (r) => (r.kind === "meta" && !r.outsideHead) || (r.via === "onHeadersReceived" && !r.doubt),
  );
  if (applied.length === 0)
    out.push(
      enforced.length
        ? {
            rule: "csp-missing",
            identity: "other-only",
            unknown: true,
            key: "Content-Security-Policy only where it may not apply",
            message:
              "A Content-Security-Policy is written only where it may not apply (a header outside a webRequest.onHeadersReceived listener, a <meta> after the document's head), so whether it reaches the app's pages is not known.",
            collection: "csp",
            where: enforced.slice(0, 10).map(place),
          }
        : {
            rule: "csp-missing",
            identity: "none",
            unknown: false,
            key: "no Content-Security-Policy",
            message:
              "No Content-Security-Policy was found: no <meta http-equiv> in the app's HTML files and no header set in a webRequest.onHeadersReceived listener. A page loaded from a server may still get one from it (Electron's security guide, section 7).",
            collection: "csp",
            where: [],
          },
    );
  for (const r of csp) {
    const risk = cspRisk(r);
    if (!risk) continue;
    out.push({
      rule: "csp-weak",
      identity: `${r.file}\0${r.kind}\0${String(r.via)}\0${String(r.policy)}`,
      unknown: risk === "unknown",
      key: `${r.kind} ${r.policy === null ? "(policy not read)" : r.policy.slice(0, 60)}`,
      message:
        risk === "fail"
          ? `The Content-Security-Policy ${r.kind === "meta" ? "<meta> tag" : "header"} is weak: ${(r.weaknesses ?? []).join("; ")}.`
          : r.weaknesses === null
            ? `The Content-Security-Policy ${r.kind === "meta" ? "<meta> tag's" : "header's"} value is not read (computed at run time), so whether it is weak is not known.`
            : `The Content-Security-Policy ${r.kind === "meta" ? "<meta> tag" : "header"} is weak (${r.weaknesses.join("; ")}), but whether it applies is not known: ${r.outsideHead ? "it stands after the document's head" : (r.doubt ?? "it is not set in a webRequest.onHeadersReceived listener")}.`,
      collection: "csp",
      where: [place(r)],
    });
  }
  return out;
}

/**
 * Audits one opened target: an Electron archive or app directory (also inside a packaged
 * build). Anything else, and an app without a JavaScript module hexvero could read, is refused
 * with `invalid_input` rather than passed for lack of anything to audit.
 */
export async function auditBuild(
  session: Session,
  id: string,
  options: AuditOptions = {},
): Promise<AuditResult> {
  const unknownMode = options.unknown ?? "fail";
  const analysis = await session.analyze(id);
  const info = session.get(id).info;
  if (analysis.data.kind !== "javascript-app")
    throw new AnalysisError(
      "invalid_input",
      `hexvero audit reads an Electron application (an .asar, an app directory or a packaged build); ${info.path} is ${analysis.data.kind} (${info.format})`,
    );
  const { app } = analysis.data;
  if (app.modules.length === 0)
    throw new AnalysisError(
      "invalid_input",
      `nothing to audit: ${info.path} has no JavaScript module hexvero could read (an empty directory, no .js files, or only links that lead out of it)`,
    );
  const coverage = await session.coverage(id);
  const incomplete: AuditResult["incomplete"] = [];
  for (const rule of AUDIT_RULES) {
    const gaps = gapsOf(rule, coverage, analysis.limitations);
    if (gaps.length) incomplete.push({ rule, collection: RULE_COLLECTION[rule], gaps });
  }
  const undecided = new Set(incomplete.map((i) => i.rule));
  const findings: AuditFinding[] = [];
  for (const d of auditApp(app)) {
    // an absence is not a finding while the list may be missing rows: the rule is undecided
    if (
      (d.rule === "permission-handler-missing" || d.rule === "csp-missing") &&
      !d.unknown &&
      undecided.has(d.rule)
    )
      continue;
    const fp = fingerprint(d.rule, d.unknown ? `maybe\0${d.identity}` : d.identity);
    const prior = findings.find((f) => f.fingerprint === fp);
    if (prior) {
      for (const p of d.where)
        if (!prior.where.some((q) => q.file === p.file && q.line === p.line)) prior.where.push(p);
      continue;
    }
    findings.push({
      rule: d.rule,
      fingerprint: fp,
      unknown: d.unknown,
      key: d.key,
      message: d.message,
      collection: d.collection,
      where: d.where,
    });
  }
  findings.sort(
    (x, y) =>
      AUDIT_RULES.indexOf(x.rule) - AUDIT_RULES.indexOf(y.rule) ||
      (x.key < y.key ? -1 : x.key > y.key ? 1 : 0) ||
      (x.fingerprint < y.fingerprint ? -1 : 1),
  );
  let status: AuditResult["status"] = "pass";
  if (findings.some((f) => !f.unknown)) status = "fail";
  else if (unknownMode === "fail" && (findings.length > 0 || incomplete.length > 0))
    status = "incomplete";
  const warnings: string[] = [];
  if (app.package === null)
    warnings.push("no package.json at the top: entry and Electron version unknown");
  return {
    hexvero: "audit",
    version: 1,
    status,
    findings,
    incomplete,
    unknown: unknownMode,
    ...(warnings.length ? { warnings } : {}),
    target: info,
  };
}
