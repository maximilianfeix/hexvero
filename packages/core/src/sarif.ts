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
      full: "A BrowserWindow present in both builds changed nodeIntegration, contextIsolation, sandbox or page access to require in a direction that lets its pages do more. When the direction cannot be told, the finding is unknown.",
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
