/**
 * SARIF 2.1.0 from a `PolicyResult`, for GitHub code scanning and other SARIF readers.
 *
 * The places hexvero reports are paths inside the analyzed build (`main.js` inside
 * `notesdesk-1.5.0.asar`), not files of the repository the workflow runs in. GitHub resolves a
 * relative `uri` against the repository root whatever its `uriBaseId`, so a bare `main.js` could
 * open the repository's own `main.js`. Every path is therefore prefixed with a segment no
 * repository is expected to have, `hexvero-build/after/<archive>/main.js` (`before` for the
 * before build), its `uriBaseId` (`HEXVERO_TARGET_B`, `HEXVERO_TARGET_A`) is given the absolute
 * base `file:///` so the resolved URI is absolute and outside any checkout, and the run says in
 * `originalUriBaseIds` and `properties` that these are paths inside the analyzed build.
 *
 * Only findings that count (state `new` or `suppression-expired`) become results: code scanning
 * ignores SARIF `suppressions`, so a baselined or suppressed finding there would reopen an alert.
 * Their numbers are in the run's properties.
 *
 * Checked against the OASIS schema (test fixture) and GitHub's list of supported fields:
 * https://docs.github.com/en/code-security/reference/code-scanning/sarif-files/sarif-support
 */
import {
  AUDIT_RULES,
  type AuditFinding,
  type AuditPlace,
  type AuditResult,
  type AuditRuleId,
} from "./audit.js";
import type { Place } from "./report.js";
import {
  POLICY_RULES,
  plain,
  STATUS_TEXT,
  type PolicyFinding,
  type PolicyResult,
  type PolicyRuleId,
} from "./policy.js";

export const SARIF_SCHEMA = "https://json.schemastore.org/sarif-2.1.0.json";
export const SARIF_BASE = { a: "HEXVERO_TARGET_A", b: "HEXVERO_TARGET_B" } as const;

const RULE_TEXT: Record<PolicyRuleId, { name: string; short: string; full: string; help: string }> =
  {
    "new-interface-member": {
      name: "NewInterfaceMember",
      short: "A member exposed to pages is new in this build.",
      full: "The preload script exposes a member (contextBridge.exposeInMainWorld) that the previous build did not expose. Pages of the app can call it.",
      help: "Review what the new member lets a page do and which IPC handler it reaches. If it is intended, accept it with `hexvero check --update-baseline` or a suppression in the policy.",
    },
    "new-external-host": {
      name: "NewExternalHost",
      short: "The build talks to a host the previous build did not name.",
      full: "A request target (fetch, XMLHttpRequest, WebSocket, a URL literal) names a host that is new in this build and not in the policy's allow list. A host computed at run time is reported as unknown.",
      help: "Check that the host is expected. Add it to `rules.new-external-host.allow` (exact name or `*.domain`) when it is.",
    },
    "window-more-permissive": {
      name: "WindowMorePermissive",
      short: "A window's settings let its pages do more than before.",
      full: "A BrowserWindow present in both builds changed nodeIntegration, contextIsolation, sandbox, page access to require, webSecurity or allowRunningInsecureContent in a direction that lets its pages do more (Electron's security guide, sections 2-4, 6 and 8). When the direction cannot be told, the finding is unknown.",
      help: "Whether this matters depends on what the window loads. Review the window's settings and the content it shows.",
    },
    "new-bridge-exposure": {
      name: "NewBridgeExposure",
      short: "A preload hands a privileged object to pages as it is.",
      full: "The preload script exposes a privileged object to web content through contextBridge without wrapping it (ipcRenderer or one of its methods, shell, the electron module, a Node module such as fs or child_process, process, require), and the previous build did not. Pages can then use the whole object, not only the calls the app meant to offer. An exposure hexvero could not decide is reported as unknown.",
      help: 'Expose a function that does the one thing pages need (e.g. `send: (msg) => ipcRenderer.send("channel", msg)`) instead of the object. If the exposure is intended, accept it with `hexvero check --update-baseline` or a suppression in the policy.',
    },
    "fuse-weakened": {
      name: "FuseWeakened",
      short: "The packaged build's Electron runtime is less locked down than before.",
      full: "Read from the Electron binary and the bundle's metadata of two packaged builds (a macOS .app, a Windows or Linux install directory, a release ZIP): a fuse moved to its less safe state (runAsNode, nodeOptions or nodeCliInspect on; embeddedAsarIntegrityValidation, onlyLoadAppFromAsar or cookieEncryption off; grantFileProtocolExtraPrivileges on), the ASAR integrity record no longer covers the archive Electron loads, or the Electron line went past its end of support by the release data snapshot hexvero ships (never a claim about vulnerabilities). A state hexvero could not read on one side is reported as unknown.",
      help: "Flip the fuse back with @electron/fuses when packaging, keep an integrity record for the archive the app loads, or move to a supported Electron line. If the change is intended, accept it with `hexvero check --update-baseline` or a suppression in the policy.",
    },
    "remote-enabled": {
      name: "RemoteEnabled",
      short: "The build newly turns on @electron/remote for a webContents.",
      full: "The main process calls enable() of @electron/remote/main for a window (or every webContents, or one a helper is handed) that the previous build did not enable it for. Pages there reach main-process modules and objects through the remote module. A row the comparison could not decide is reported as unknown.",
      help: "Replace the remote calls with IPC handlers that do the one thing the page needs. If enabling it is intended, accept it with `hexvero check --update-baseline` or a suppression in the policy.",
    },
    "new-unsafe-switch": {
      name: "NewUnsafeSwitch",
      short: "The build newly weakens a process-wide security check.",
      full: "The main process appends a Chromium command-line switch that weakens a security boundary (ignore-certificate-errors, disable-web-security, no-sandbox, remote-debugging-port and the others listed in hexvero's Electron findings), a certificate-error handler accepts certificate errors (callback(true)), or a certificate verify proc reports success (callback(0)), and the previous build did not. A switch whose name or value hexvero could not read is reported as unknown.",
      help: "Remove the switch or the accepting call, or limit it to development builds. If the change is intended, accept it with `hexvero check --update-baseline` or a suppression in the policy.",
    },
    "new-open-external": {
      name: "NewOpenExternal",
      short: "The build newly opens a URL it does not fix with shell.openExternal.",
      full: "The build calls shell.openExternal with a URL that is not a literal and whose known start does not fix the scheme to http, https or mailto, and the previous build had no such call (by receiver and as much of the URL as is read). A URL from a page or a message may then open any protocol handler or file (Electron's security guide, section 15). A call on a receiver not read as Electron's shell is reported as unknown.",
      help: "Check the URL's scheme (and host) before opening it, or open only URLs the app writes itself. If the call is intended, accept it with `hexvero check --update-baseline` or a suppression in the policy.",
    },
    "permission-handler-grants-all": {
      name: "PermissionHandlerGrantsAll",
      short: "A permission handler newly grants every request.",
      full: "A session's setPermissionRequestHandler or setPermissionCheckHandler handler calls callback(true) or returns true unconditionally (or is cleared with null), and the previous build's handler for that session did not; or the previous build set a permission request handler and this build sets none. Electron then grants every permission a page asks for. A handler whose answer hexvero could not read is reported as unknown.",
      help: "Grant only the permissions the app needs, for the origins that need them. If the change is intended, accept it with `hexvero check --update-baseline` or a suppression in the policy.",
    },
    "csp-weakened": {
      name: "CspWeakened",
      short: "The build's Content Security Policy is newly weaker.",
      full: "A Content Security Policy of the build (a <meta> tag in an HTML file, a header set in code) has a weakness no policy of the previous build has ('unsafe-inline' without a nonce or hash, 'unsafe-eval', a wildcard or bare scheme for scripts, scripts or plugins not restricted), or the previous build set a policy and this build sets none. A policy hexvero could not read is reported as unknown.",
      help: "Restore the stricter policy. If the change is intended, accept it with `hexvero check --update-baseline` or a suppression in the policy.",
    },
    "navigation-limit-removed": {
      name: "NavigationLimitRemoved",
      short: "The build no longer limits navigation or window creation as the previous build did.",
      full: "The previous build listens for will-navigate or will-frame-navigate, or sets a setWindowOpenHandler, and this build does neither (by kind, anywhere in the files read); or a setWindowOpenHandler of this build returns { action: \"allow\" } on every path where the previous build's for that window did not. Pages may then navigate to or open a URL the app does not expect (Electron's security guide, sections 13 and 14).",
      help: 'Restore the listener or the handler (call event.preventDefault() for URLs the app does not expect; return { action: "deny" } for windows it does not expect). If the change is intended, accept it with `hexvero check --update-baseline` or a suppression in the policy.',
    },
  };

const uriOf = (file: string): string =>
  file
    .split(/[\\/]/)
    .map((segment) =>
      segment === ".." || segment === "."
        ? encodeURIComponent(segment).replace(/\./g, "%2E")
        : encodeURIComponent(segment),
    )
    .join("/");

/** The path segment every location starts with: it names hexvero, the side and the archive. */
export const SARIF_PREFIX = "hexvero-build";

function location(
  p: Place,
  archives: { a: string; b: string },
  id?: number,
): Record<string, unknown> {
  const uri = `${SARIF_PREFIX}/${p.side === "a" ? "before" : "after"}/${uriOf(archives[p.side])}/${uriOf(p.file)}`;
  return {
    ...(id === undefined ? {} : { id }),
    physicalLocation: {
      artifactLocation: { uri, uriBaseId: SARIF_BASE[p.side] },
      ...(p.line === undefined ? {} : { region: { startLine: p.line } }),
    },
    ...(p.role ? { message: { text: p.role } } : {}),
  };
}

/** The place an alert should open at: the item itself before a handler or caller. */
function primary(where: readonly Place[]): Place | undefined {
  return where.find((p) => !p.role) ?? where[0];
}

function level(f: PolicyFinding, unknown: SarifOptions["unknown"]): "error" | "warning" | "note" {
  if (!f.unknown) return f.level === "fail" ? "error" : "warning";
  if (unknown === "allow") return "note";
  return f.level === "fail" && unknown === "fail" ? "error" : "warning";
}

export interface SarifOptions {
  /** The hexvero version, for `tool.driver.semanticVersion`. */
  version: string;
  /** The policy's `unknown` setting, which decides the level of unknown findings. */
  unknown: "fail" | "warn" | "allow";
}

const baseName = (path: string): string => path.split(/[\\/]/).pop() ?? path;

/** A SARIF 2.1.0 log with one run. */
export function toSarif(result: PolicyResult, options: SarifOptions): Record<string, unknown> {
  const counted = result.findings.filter(
    (f) => f.state === "new" || f.state === "suppression-expired",
  );
  const archives = {
    a: baseName(result.a.path).replace(/[\\/]/g, "_") || "before",
    b: baseName(result.b.path).replace(/[\\/]/g, "_") || "after",
  };
  const results = counted.map((f) => {
    const first = primary(f.where);
    const rest = f.where.filter((p) => p !== first).slice(0, 9);
    return {
      ruleId: f.rule,
      ruleIndex: POLICY_RULES.indexOf(f.rule),
      level: level(f, options.unknown),
      message: { text: plain(f.message) },
      locations: first
        ? [location(first, archives)]
        : [{ logicalLocations: [{ name: plain(f.key), kind: "member" }] }],
      ...(rest.length
        ? { relatedLocations: rest.map((p, i) => location(p, archives, i + 1)) }
        : {}),
      // Code scanning keys alerts on primaryLocationLineHash; a semantic fingerprint keeps one
      // alert per member, host or window setting however the code around it moves.
      partialFingerprints: {
        "hexveroFingerprint/v1": f.fingerprint,
        primaryLocationLineHash: `${f.fingerprint}:1`,
      },
      properties: {
        state: f.state,
        unknown: f.unknown,
        collection: f.collection,
        key: plain(f.key),
        row: f.row,
        ...(f.basis ? { basis: f.basis } : {}),
      },
    };
  });
  const states = (s: PolicyFinding["state"]): number =>
    result.findings.filter((f) => f.state === s).length;
  const describe = (side: "a" | "b"): string => {
    const info = result[side];
    return `Paths inside the analyzed build ${plain(baseName(info.path))} (sha256 ${info.sha256}), not files of this repository.`;
  };
  return {
    $schema: SARIF_SCHEMA,
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "hexvero",
            semanticVersion: options.version,
            informationUri: "https://github.com/maximilianfeix/hexvero",
            rules: POLICY_RULES.map((id) => ({
              id,
              name: RULE_TEXT[id].name,
              shortDescription: { text: RULE_TEXT[id].short },
              fullDescription: { text: RULE_TEXT[id].full },
              help: { text: RULE_TEXT[id].help, markdown: RULE_TEXT[id].help },
              defaultConfiguration: { level: "error" },
              properties: { tags: ["security", "electron", "release"], precision: "high" },
            })),
          },
        },
        automationDetails: { id: "hexvero-check/" },
        originalUriBaseIds: {
          [SARIF_BASE.a]: { uri: "file:///", description: { text: describe("a") } },
          [SARIF_BASE.b]: { uri: "file:///", description: { text: describe("b") } },
        },
        invocations: [
          {
            executionSuccessful: result.status !== "error",
            toolExecutionNotifications: result.incomplete.map((i) => ({
              level: "warning",
              message: {
                text: `${i.rule} could not be decided on ${i.collection}: ${i.gaps.join(", ")}.`,
              },
              descriptor: { id: i.rule },
            })),
          },
        ],
        results,
        properties: {
          hexvero: {
            status: result.status,
            statusText: STATUS_TEXT[result.status],
            locations:
              "Locations are paths inside the analyzed build archives, written as hexvero-build/before/<archive>/<path> (uriBaseId HEXVERO_TARGET_A) and hexvero-build/after/<archive>/<path> (uriBaseId HEXVERO_TARGET_B), not files of the repository this log is uploaded to.",
            before: { file: plain(baseName(result.a.path)), sha256: result.a.sha256 },
            after: { file: plain(baseName(result.b.path)), sha256: result.b.sha256 },
            policy: result.policy.sha256,
            incomplete: result.incomplete,
            notReported: { baselined: states("baselined"), suppressed: states("suppressed") },
          },
        },
      },
    ],
  };
}

const AUDIT_TEXT: Record<
  AuditRuleId,
  { name: string; short: string; full: string; help?: string }
> = {
  "window-permissive": {
    name: "WindowPermissive",
    short: "A window's settings let its pages do more.",
    full: "A BrowserWindow has Node integration on, context isolation off, the sandbox off, or page access to require, as written or by the default of the Electron version package.json names (Electron's security guide, sections 2-4); or it writes webSecurity: false (section 6) or allowRunningInsecureContent: true (section 8, also on when webSecurity is false and it is not written). A setting hexvero could not read is reported as unknown.",
    help: "Electron's security guide: section 2 (Node integration), 3 (context isolation), 4 (sandbox), section 6 (do not disable webSecurity), section 8 (do not enable allowRunningInsecureContent). Remove the setting, or keep it to a window that loads only the app's own files. See docs/electron-findings.md of hexvero for what is read and what is not.",
  },
  "remote-enabled": {
    name: "RemoteEnabled",
    short: "@electron/remote is enabled for a webContents.",
    full: "The main process calls enable() of @electron/remote/main: pages there reach main-process modules and objects through the remote module.",
  },
  "unsafe-switch": {
    name: "UnsafeSwitch",
    short: "A process-wide security check is weakened.",
    full: "A Chromium command-line switch that weakens a security boundary is appended, a certificate-error handler accepts certificate errors, or a certificate verify proc reports success. A switch whose name or value hexvero could not read is reported as unknown.",
  },
  "open-external": {
    name: "OpenExternal",
    short: "shell.openExternal opens a URL whose scheme the app does not fix.",
    full: "shell.openExternal is called with a URL that is not a literal and whose known start does not fix the scheme to http, https or mailto, so a URL from a page or a message may open any protocol handler or file (Electron's security guide, section 15). A call on a receiver not read as Electron's shell is reported as unknown.",
  },
  "permission-handler-missing": {
    name: "PermissionHandlerMissing",
    short: "No permission request handler is set.",
    full: "No session.setPermissionRequestHandler was found in the files read; Electron then grants every permission a page asks for (Electron's security guide, section 5).",
  },
  "permission-handler-grants-all": {
    name: "PermissionHandlerGrantsAll",
    short: "A permission handler grants every request.",
    full: "A setPermissionRequestHandler or setPermissionCheckHandler handler calls callback(true) or returns true unconditionally, or is cleared with null. A handler whose answer hexvero could not read is reported as unknown.",
  },
  "csp-missing": {
    name: "CspMissing",
    short: "No Content Security Policy is set.",
    full: "No <meta http-equiv=\"Content-Security-Policy\"> in the app's HTML files and no Content-Security-Policy header set in a webRequest.onHeadersReceived listener (Electron's security guide, section 7).",
  },
  "csp-weak": {
    name: "CspWeak",
    short: "A Content Security Policy is weak.",
    full: "A Content Security Policy lets scripts run inline or through eval, from any origin or scheme, or does not restrict scripts or plugins at all. A policy hexvero could not read is reported as unknown.",
  },
  "navigation-unlimited": {
    name: "NavigationUnlimited",
    short: "Navigation or window creation is not limited.",
    full: 'No will-navigate or will-frame-navigate listener, or no setWindowOpenHandler, was found in the files read (for the app, or for a window when other windows have one), or a setWindowOpenHandler returns { action: "allow" } on every path. A listener on a webContents not read as a window leaves windows without their own unknown. Whether a handler checks the URL is not read.',
    help: "Electron's security guide, section 13 (limit navigation: call event.preventDefault() in a will-navigate handler for URLs the app does not expect) and section 14 (limit the creation of new windows: register a setWindowOpenHandler that denies unexpected windows). See docs/electron-findings.md of hexvero for what is read and what is not.",
  },
};

/** The SARIF uriBaseId of an audited build. */
export const SARIF_AUDIT_BASE = "HEXVERO_TARGET";

/** A SARIF 2.1.0 log with one run for `hexvero audit`. */
export function auditToSarif(
  result: AuditResult,
  options: { version: string },
): Record<string, unknown> {
  const archive = baseName(result.target.path).replace(/[\\/]/g, "_") || "build";
  const at = (p: AuditPlace, id?: number): Record<string, unknown> => ({
    ...(id === undefined ? {} : { id }),
    physicalLocation: {
      artifactLocation: {
        uri: `${SARIF_PREFIX}/build/${uriOf(archive)}/${uriOf(p.file)}`,
        uriBaseId: SARIF_AUDIT_BASE,
      },
      ...(p.line === undefined ? {} : { region: { startLine: p.line } }),
    },
  });
  const levelOf = (f: AuditFinding): "error" | "warning" | "note" =>
    !f.unknown
      ? "error"
      : result.unknown === "fail"
        ? "error"
        : result.unknown === "warn"
          ? "warning"
          : "note";
  return {
    $schema: SARIF_SCHEMA,
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "hexvero",
            semanticVersion: options.version,
            informationUri: "https://github.com/maximilianfeix/hexvero",
            rules: AUDIT_RULES.map((id) => ({
              id,
              name: AUDIT_TEXT[id].name,
              shortDescription: { text: AUDIT_TEXT[id].short },
              fullDescription: { text: AUDIT_TEXT[id].full },
              help: {
                text:
                  AUDIT_TEXT[id].help ??
                  "See docs/electron-findings.md of hexvero for what is read and what is not.",
              },
              defaultConfiguration: { level: "error" },
              properties: { tags: ["security", "electron"], precision: "high" },
            })),
          },
        },
        automationDetails: { id: "hexvero-audit/" },
        originalUriBaseIds: {
          [SARIF_AUDIT_BASE]: {
            uri: "file:///",
            description: {
              text: `Paths inside the analyzed build ${plain(baseName(result.target.path))} (sha256 ${result.target.sha256}), not files of this repository.`,
            },
          },
        },
        invocations: [
          {
            executionSuccessful: true,
            toolExecutionNotifications: result.incomplete.map((i) => ({
              level: "warning",
              message: {
                text: `${i.rule} could not be decided on ${i.collection}: ${i.gaps.join(", ")}.`,
              },
              descriptor: { id: i.rule },
            })),
          },
        ],
        results: result.findings.map((f) => {
          const [first, ...rest] = f.where;
          return {
            ruleId: f.rule,
            ruleIndex: AUDIT_RULES.indexOf(f.rule),
            level: levelOf(f),
            message: { text: plain(f.message) },
            locations: first
              ? [at(first)]
              : [{ logicalLocations: [{ name: plain(f.key), kind: "member" }] }],
            ...(rest.length
              ? { relatedLocations: rest.slice(0, 9).map((p, i) => at(p, i + 1)) }
              : {}),
            partialFingerprints: {
              "hexveroFingerprint/v1": f.fingerprint,
              primaryLocationLineHash: `${f.fingerprint}:1`,
            },
            properties: { unknown: f.unknown, collection: f.collection, key: plain(f.key) },
          };
        }),
        properties: {
          hexvero: {
            status: result.status,
            locations:
              "Locations are paths inside the analyzed build, written as hexvero-build/build/<archive>/<path> (uriBaseId HEXVERO_TARGET), not files of the repository this log is uploaded to.",
            build: { file: plain(baseName(result.target.path)), sha256: result.target.sha256 },
            unknown: result.unknown,
            incomplete: result.incomplete,
          },
        },
      },
    ],
  };
}
