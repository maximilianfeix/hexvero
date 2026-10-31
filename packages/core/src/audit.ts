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
 * permission handlers missing or granting everything, a Content Security Policy missing or
 * weak, and navigation or window creation that the app does not limit.
 */
import { createHash } from "node:crypto";
import type { SideCoverage, UnresolvedFamily } from "./compare.js";
import { directoryDigest } from "./digest.js";
import type {
  CspRow,
  JsAppInfo,
  NavigationHandler,
  OpenExternalRow,
  PermissionHandlerRow,
} from "./javascript/app.js";
import { AnalysisError, type Limitation } from "./model.js";
import type { AuditPolicy, LoadedAuditBaseline, LoadedPolicy } from "./policy.js";
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
  "navigation-unlimited",
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
  /** The rule's level in the policy (`fail` without one); rules at `off` give no finding. */
  level: "fail" | "warn";
  /**
   * `new` counts; `baselined` (in the baseline) and `suppressed` (by the policy) do not;
   * `suppression-expired` (a suppression whose day has passed) counts again. As `check`.
   */
  state: "new" | "baselined" | "suppressed" | "suppression-expired";
  /** For a suppressed or expired finding: the reason given in the policy. */
  suppression?: { reason: string; expires?: string };
  /** With a baseline only: whether the baseline has the finding (SARIF `baselineState`). */
  baselineState?: "new" | "unchanged";
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
  /** The policy file read with `--policy`. */
  policy?: { file: string; sha256: string };
  /** With `--baseline`; `warnings`: written for another policy, or a partial directory digest. */
  baseline?: { file: string; created: string; matched: number; warnings?: string[] };
  target: TargetRecord["info"];
}

export const AUDIT_STATUS_TEXT: Record<AuditResult["status"], string> = {
  pass: "pass: no new finding at level fail",
  fail: "fail: a rule is violated",
  incomplete: "incomplete: a rule could not be decided (unknown: fail)",
};

export interface AuditOptions {
  /**
   * `fail`: an unknown finding or a gap makes the status `incomplete`. Default: the policy's
   * `audit.unknown` (else its `unknown`), else `fail`.
   */
  unknown?: "fail" | "warn" | "allow" | undefined;
  /** Levels and suppressions from the policy's `audit` section. */
  policy?: LoadedPolicy | undefined;
  /** Accepted findings: they are listed as `baselined` and do not count. */
  baseline?: LoadedAuditBaseline | undefined;
  /**
   * Give a directory a content digest (it has no file digest) for a baseline to record. Always
   * done when `baseline` is set.
   */
  digest?: boolean | undefined;
  /** The day suppressions are judged against; default now. */
  now?: Date | undefined;
}

/** The policy's audit section, or every rule at fail (as `auditPolicyOf`, without a value import). */
function sectionOf(loaded: LoadedPolicy | undefined): AuditPolicy {
  const audit = loaded?.policy.audit;
  if (audit) return audit;
  const rules = {} as AuditPolicy["rules"];
  for (const id of AUDIT_RULES) rules[id] = { level: "fail" };
  return { rules, unknown: loaded?.policy.unknown ?? "fail", suppressions: [] };
}

/** True when the day of `now` (UTC) is after `expires`. */
const expired = (expires: string | undefined, now: Date): boolean =>
  expires !== undefined && now.toISOString().slice(0, 10) > expires;

/** For each derived window setting, the values under which a page can do more. */
const PERMISSIVE: Readonly<Record<string, readonly string[]>> = {
  nodeIntegrationInEffect: ["on", "default on"],
  contextIsolationInEffect: ["off", "default off"],
  sandboxInEffect: ["off", "default off"],
  pageRequire: ["yes", "yes by default"],
  webSecurityInEffect: ["off", "default off"],
  allowRunningInsecureContentInEffect: ["on", "default on"],
};

/**
 * What a permissive value of a web security setting lets a page do, with the section of
 * Electron's security guide that advises against it. The core settings say "its pages may do
 * more" with the basis of the derived value.
 */
const CONSEQUENCE: Readonly<Record<string, { key: string; effect: string }>> = {
  webSecurityInEffect: {
    key: "webSecurity",
    effect: "the same-origin policy is off for its pages (Electron's security guide, section 6)",
  },
  allowRunningInsecureContentInEffect: {
    key: "allowRunningInsecureContent",
    effect:
      "its https pages may run scripts, styles and plugins loaded over http (Electron's security guide, section 8)",
  },
};

/** How a web security value came about, from the window's written state. */
function webSecurityWhy(w: Record<string, unknown>, setting: string): string {
  const key = CONSEQUENCE[setting]!.key;
  const state = w[key];
  if (typeof state === "boolean") return `${key} is ${String(state)} as written`;
  return `${key} is not written and webSecurity: false turns it on`;
}

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
  "navigation-unlimited": ["navigation_handlers_truncated"],
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
  "navigation-unlimited": null,
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
  "navigation-unlimited": "navigationHandlers",
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

/**
 * A finding of one rule before its fingerprint. `absence`: it reports that something was not
 * found in the files read, so it is no finding while the rule's list may be missing rows.
 */
export type AuditDraft = Omit<
  AuditFinding,
  "fingerprint" | "level" | "state" | "suppression" | "baselineState"
> & { identity: string; absence?: true };

/** The navigation and window-creation limits `navigation-unlimited` asks for. */
const NAVIGATION_LIMITS = [
  {
    group: "navigate",
    kinds: ["will-navigate", "will-frame-navigate"],
    what: "will-navigate listener",
    missing:
      "No will-navigate or will-frame-navigate listener was found in the files read: without one, a page of the app may navigate its window to a URL the app does not expect (Electron's security guide, section 13).",
    effect:
      "a page may navigate the window to a URL the app does not expect (Electron's security guide, section 13)",
  },
  {
    group: "open",
    kinds: ["setWindowOpenHandler"],
    what: "setWindowOpenHandler",
    missing:
      "No setWindowOpenHandler was found in the files read: without one, a page of the app may open new windows for a URL the app does not expect (Electron's security guide, section 14).",
    effect:
      "a page may open new windows for a URL the app does not expect (Electron's security guide, section 14)",
  },
] as const;

/**
 * `navigation-unlimited`, for an app with a window or a handler read: no will-navigate /
 * will-frame-navigate listener, or no setWindowOpenHandler, in the files read (for the app, or
 * for a window when others have one), and a window open handler that returns
 * `{ action: "allow" }` on every path. A listener on a webContents not read as a window may be any
 * window's: windows without one of their own are then unknown. Whether a handler checks the URL
 * is not read.
 */
function navigationDrafts(
  handlers: readonly NavigationHandler[],
  windows: JsAppInfo["windows"],
): AuditDraft[] {
  const out: AuditDraft[] = [];
  // no window and no handler read: nothing says the app has pages to navigate (and the session
  // does not list navigationHandlers then)
  if (windows.length === 0 && handlers.length === 0) return out;
  for (const limit of NAVIGATION_LIMITS) {
    const rows = handlers.filter((h) => (limit.kinds as readonly string[]).includes(h.kind));
    if (rows.length === 0) {
      out.push({
        rule: "navigation-unlimited",
        identity: `none\0${limit.group}`,
        unknown: false,
        key: `no ${limit.what}`,
        message: limit.missing,
        collection: "navigationHandlers",
        where: [],
        absence: true,
      });
      continue;
    }
    if (rows.some((h) => h.targetKind === "app")) continue;
    const uncovered = windows.filter(
      (w) =>
        !rows.some(
          (h) => h.targetKind === "window" && h.file === w.file && h.window === w.windowName,
        ),
    );
    if (uncovered.length === 0) continue;
    if (rows.some((h) => h.targetKind === "webContents")) {
      const names = [...new Set(uncovered.map((w) => w.windowName))];
      out.push({
        rule: "navigation-unlimited",
        identity: `unmatched\0${limit.group}`,
        unknown: true,
        key: `${limit.what} not read for ${names.slice(0, 5).join(", ")}${names.length > 5 ? ` … and ${names.length - 5} more` : ""}`,
        message: `No ${limit.what} is read for window${names.length === 1 ? "" : "s"} ${names.slice(0, 5).join(", ")}${names.length > 5 ? ` … and ${names.length - 5} more` : ""}: the ones found are on a webContents not read as a window of the app (a parameter, another module's window), so whether ${names.length === 1 ? "it has" : "they have"} one is not known.`,
        collection: "navigationHandlers",
        where: uncovered.slice(0, 10).map(place),
      });
      continue;
    }
    for (const w of uncovered)
      out.push({
        rule: "navigation-unlimited",
        identity: `window\0${limit.group}\0${w.file}\0${w.windowName}`,
        unknown: false,
        key: `${w.windowName}: no ${limit.what}`,
        message: `Window ${w.windowName} has no ${limit.what} in the files read, while other windows have one: ${limit.effect}.`,
        collection: "navigationHandlers",
        where: [place(w)],
        absence: true,
      });
  }
  for (const h of handlers) {
    if (h.kind !== "setWindowOpenHandler" || h.returns !== "allow") continue;
    const on = h.window ?? h.target;
    out.push({
      rule: "navigation-unlimited",
      identity: `allow\0${h.file}\0${h.targetKind}\0${String(h.window)}`,
      unknown: false,
      key: `setWindowOpenHandler on ${on} returns allow`,
      message: `The setWindowOpenHandler of ${on} returns { action: "allow" } on every path, so a page may open a window for a URL the app does not expect (Electron's security guide, section 14).`,
      collection: "navigationHandlers",
      where: [place(h)],
    });
  }
  return out;
}

/** The findings of every rule on one app's lists; pure. */
export function auditApp(
  app: Pick<
    JsAppInfo,
    | "windows"
    | "remoteEnabled"
    | "switches"
    | "openExternal"
    | "permissionHandlers"
    | "csp"
    | "navigationHandlers"
    | "webPreferences"
  >,
): AuditDraft[] {
  type Draft = AuditDraft;
  const out: Draft[] = [];

  for (const w of app.windows ?? []) {
    const fields = w as unknown as Record<string, unknown>;
    // allowRunningInsecureContent that is not written as a value of its own (not written, or not
    // read because the window's options could not be followed) follows webSecurity: when that is
    // unknown, one finding (webSecurity's) says both, not two per window. One written as a
    // computed value keeps its own.
    const insecure = fields["allowRunningInsecureContent"];
    const follows =
      fields["webSecurityInEffect"] === "unknown" &&
      (insecure === "not written" ||
        (insecure === "computed" &&
          !(app.webPreferences ?? []).some(
            (p) =>
              p.key === "allowRunningInsecureContent" && p.file === w.file && p.window === w.window,
          )));
    for (const [setting, open] of Object.entries(PERMISSIVE)) {
      // a window row of an older shape has no web security columns: nothing is read there
      if (!(setting in fields)) continue;
      const value = String(fields[setting]);
      const unknown = value === "unknown";
      if (!unknown && !open.includes(value)) continue;
      if (follows && setting === "allowRunningInsecureContentInEffect") continue;
      const assumed = value.includes("default");
      const web = CONSEQUENCE[setting];
      out.push({
        rule: "window-permissive",
        identity: `${w.file}\0${w.windowName}\0${setting}`,
        unknown,
        key: `${w.windowName} ${setting} ${value}`,
        message: web
          ? unknown
            ? `Window ${w.windowName}: ${web.key} cannot be told (a value computed at run time)${follows && setting === "webSecurityInEffect" ? "; allowRunningInsecureContent is not read as a value of its own and depends on it (webSecurity: false turns it on), so it cannot be told either" : ""}.`
            : `Window ${w.windowName}: ${webSecurityWhy(fields, setting)}, so ${web.effect}.`
          : unknown
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
      absence: true,
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
            absence: true,
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

  out.push(...navigationDrafts(app.navigationHandlers ?? [], app.windows ?? []));
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
  const section = sectionOf(options.policy);
  const unknownMode = options.unknown ?? section.unknown;
  const now = options.now ?? new Date();
  const analysis = await session.analyze(id);
  let info = session.get(id).info;
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
  // A directory has no file digest; give it a content digest so a baseline records the build.
  let partialDigest: string | null = null;
  if (info.format === "directory" && !info.sha256 && (options.baseline || options.digest)) {
    const digest = directoryDigest(info.path);
    partialDigest = digest.partial ?? null;
    info = { ...info, sha256: digest.sha256 };
  }
  const level = (rule: AuditRuleId) => section.rules[rule].level;
  const coverage = await session.coverage(id);
  const incomplete: AuditResult["incomplete"] = [];
  for (const rule of AUDIT_RULES) {
    if (level(rule) === "off") continue;
    const gaps = gapsOf(rule, coverage, analysis.limitations);
    if (gaps.length) incomplete.push({ rule, collection: RULE_COLLECTION[rule], gaps });
  }
  const undecided = new Set(incomplete.map((i) => i.rule));
  const accepted = new Set(
    options.baseline?.baseline.fingerprints.map((f) => `${f.rule}\0${f.fingerprint}`),
  );
  let matched = 0;
  const findings: AuditFinding[] = [];
  for (const d of auditApp(app)) {
    const ruleLevel = level(d.rule);
    if (ruleLevel === "off") continue;
    // an absence is not a finding while the list may be missing rows: the rule is undecided
    if (d.absence && undecided.has(d.rule)) continue;
    const fp = fingerprint(d.rule, d.unknown ? `maybe\0${d.identity}` : d.identity);
    const prior = findings.find((f) => f.fingerprint === fp);
    if (prior) {
      for (const p of d.where)
        if (!prior.where.some((q) => q.file === p.file && q.line === p.line)) prior.where.push(p);
      continue;
    }
    const sup = section.suppressions.find((s) => s.rule === d.rule && s.fingerprint === fp);
    const inBaseline = accepted.has(`${d.rule}\0${fp}`);
    if (inBaseline) matched++;
    let state: AuditFinding["state"] = "new";
    if (sup) state = expired(sup.expires, now) ? "suppression-expired" : "suppressed";
    else if (inBaseline) state = "baselined";
    findings.push({
      rule: d.rule,
      fingerprint: fp,
      unknown: d.unknown,
      key: d.key,
      message: d.message,
      collection: d.collection,
      where: d.where,
      level: ruleLevel,
      state,
      ...(sup
        ? { suppression: { reason: sup.reason, ...(sup.expires ? { expires: sup.expires } : {}) } }
        : {}),
      ...(options.baseline
        ? { baselineState: inBaseline ? ("unchanged" as const) : ("new" as const) }
        : {}),
    });
  }
  findings.sort(
    (x, y) =>
      AUDIT_RULES.indexOf(x.rule) - AUDIT_RULES.indexOf(y.rule) ||
      (x.key < y.key ? -1 : x.key > y.key ? 1 : 0) ||
      (x.fingerprint < y.fingerprint ? -1 : 1),
  );
  // As check: only counted findings (new, suppression expired) at level fail move the status.
  const counted = findings.filter(
    (f) => f.level === "fail" && (f.state === "new" || f.state === "suppression-expired"),
  );
  let status: AuditResult["status"] = "pass";
  if (counted.some((f) => !f.unknown)) status = "fail";
  else if (
    unknownMode === "fail" &&
    (counted.length > 0 || incomplete.some((i) => level(i.rule) === "fail"))
  )
    status = "incomplete";
  const warnings: string[] = [];
  if (app.package === null)
    warnings.push("no package.json at the top: entry and Electron version unknown");
  let baseline: AuditResult["baseline"];
  if (options.baseline) {
    const notes: string[] = [];
    const written = options.baseline.baseline.policy;
    if (written !== (options.policy?.sha256 ?? null))
      notes.push(
        written === null
          ? "the baseline was written without a policy"
          : `the baseline was written for another policy (sha256 ${written.slice(0, 12)}…)`,
      );
    if (partialDigest) notes.push(`build: ${partialDigest}`);
    baseline = {
      file: options.baseline.file,
      created: options.baseline.baseline.created,
      matched,
      ...(notes.length ? { warnings: notes } : {}),
    };
  }
  return {
    hexvero: "audit",
    version: 1,
    status,
    findings,
    incomplete,
    unknown: unknownMode,
    ...(warnings.length ? { warnings } : {}),
    ...(options.policy
      ? { policy: { file: options.policy.file, sha256: options.policy.sha256 } }
      : {}),
    ...(baseline ? { baseline } : {}),
    target: info,
  };
}
