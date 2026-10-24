# Audit plan: Electronegativity parity

Written 2026-10-24 for branch `feat/audit-parity` (first slice). Goal: hexvero as the maintained
open-source successor to [Electronegativity](https://github.com/doyensec/electronegativity)
(unmaintained; last npm release 1.10.3, 2023-03-09), next to its two-build release diff.

Source of the check list: `src/finder/checks/AtomicChecks`, `GlobalChecks` and
`AtomicChecks/ElectronAtomicUpgradeChecks.js` of the repository's default branch (commit
`975eb59`, 2025-08-23), read 2026-10-24.

## How the audit is built

**A command of its own, not a mode of `check`.** `check` evaluates a comparison (`evaluatePolicy`
over a `ReleaseComparison`); every rule there means "new in the after build", its identities and
baselines are defined against a before build, and its gaps come from comparing two sides. A
single build has no comparison. Faking an empty before build would make every rule report
"new" with the wrong wording and wrong gaps (`files_unread` for every file). So:

- `packages/core/src/audit.ts`: `auditBuild(session, id, { unknown })` reads one analysis's lists
  and its `SideCoverage`, and returns an `AuditResult` (status `pass` / `fail` / `incomplete`,
  findings with fingerprints, `incomplete` with check's gap codes). `auditApp` is the pure part.
- The risk predicates (`openExternalRisk`, `permissionRisk`, `cspRisk`) are shared: `audit` asks
  "is it there", the check rules (`new-open-external`, `permission-handler-grants-all`,
  `csp-weakened`) ask "is it there and not in the before build".
- `hexvero audit <build> [--format text|json|sarif] [--unknown fail|warn|allow]`: exit codes as
  `check` (0 pass, 3 violated, 4 not decidable), SARIF through `auditToSarif`.
- Not in this slice: audit suppressions and baselines (see follow-ups), an MCP parameter and UI.

## Every Electronegativity check

`covered` = read and judged by an audit rule; `read` = the fact is in a collection but no audit
rule judges it yet; `missing` = not read. "Planned id" is the rule (or collection) a follow-up
adds.

| Electronegativity check                                           | hexvero collection                                            | hexvero rule (audit / check)                                | Status                                      | Planned id                     |
| ----------------------------------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------- | ------------------------------ |
| `NODE_INTEGRATION_JS_CHECK`                                       | `windows` (`nodeIntegrationInEffect`), `webPreferences`       | `window-permissive` / `window-more-permissive`              | covered                                     |                                |
| `NODE_INTEGRATION_HTML_CHECK` (`<webview nodeintegration>`)       | —                                                             | —                                                           | missing                                     | `webviews`, `webview-insecure` |
| `NODE_INTEGRATION_ATTACH_EVENT_JS_CHECK` (`will-attach-webview`)  | —                                                             | —                                                           | missing                                     | `webviews`, `webview-insecure` |
| `CONTEXT_ISOLATION_JS_CHECK`                                      | `windows` (`contextIsolationInEffect`)                        | `window-permissive` / `window-more-permissive`              | covered                                     |                                |
| `SANDBOX_JS_CHECK`                                                | `windows` (`sandboxInEffect`, `app.enableSandbox()`)          | `window-permissive` / `window-more-permissive`              | covered                                     |                                |
| `PRELOAD_JS_CHECK`                                                | `windows` (`preload`), `contextBridge`, `bridgeExposures`     | — / `new-bridge-exposure`, `new-interface-member`           | read (what a preload exposes is judged)     |                                |
| `REMOTE_MODULE_JS_CHECK`                                          | `remoteEnabled`, `webPreferences` (`enableRemoteModule`)      | `remote-enabled` / `remote-enabled`                         | covered                                     |                                |
| `WEB_SECURITY_JS_CHECK`                                           | `webPreferences` (`webSecurity`)                              | —                                                           | read                                        | `window-permissive` (extended) |
| `WEB_SECURITY_HTML_CHECK` (`<webview disablewebsecurity>`)        | —                                                             | —                                                           | missing                                     | `webview-insecure`             |
| `INSECURE_CONTENT_JS_CHECK`                                       | `webPreferences` (`allowRunningInsecureContent`)              | —                                                           | read                                        | `window-permissive` (extended) |
| `INSECURE_CONTENT_HTML_CHECK` (webview `webpreferences`)          | —                                                             | —                                                           | missing                                     | `webview-insecure`             |
| `EXPERIMENTAL_FEATURES_JS_CHECK` / `_HTML_CHECK`                  | —                                                             | —                                                           | missing                                     | `window-permissive` (extended) |
| `BLINK_FEATURES_JS_CHECK` / `_HTML_CHECK`                         | —                                                             | —                                                           | missing                                     | `window-permissive` (extended) |
| `AUXCLICK_JS_CHECK` / `_HTML_CHECK`                               | —                                                             | —                                                           | missing (obsolete since `auxclick` default) | none planned                   |
| `AFFINITY_JS_CHECK` / `_HTML_CHECK` / `AFFINITY_GLOBAL_CHECK`     | —                                                             | —                                                           | missing (option removed in Electron 14)     | none planned                   |
| `ALLOWPOPUPS_HTML_CHECK`                                          | —                                                             | —                                                           | missing                                     | `webview-insecure`             |
| `CSP_HTML_CHECK`, `CSP_JS_CHECK`, `CSP_GLOBAL_CHECK`              | `csp` (this slice)                                            | `csp-missing`, `csp-weak` / `csp-weakened`                  | covered                                     |                                |
| `OPEN_EXTERNAL_JS_CHECK`                                          | `openExternal` (this slice)                                   | `open-external` / `new-open-external`                       | covered                                     |                                |
| `PERMISSION_REQUEST_HANDLER_JS_CHECK`, `_GLOBAL_CHECK`            | `permissionHandlers` (this slice)                             | `permission-handler-missing`, `-grants-all` / `-grants-all` | covered                                     |                                |
| `CERTIFICATE_ERROR_EVENT_JS_CHECK`                                | `switches` (`certificate-error`)                              | `unsafe-switch` / `new-unsafe-switch`                       | covered                                     |                                |
| `CERTIFICATE_VERIFY_PROC_JS_CHECK`                                | `switches` (`certificate-verify-proc`)                        | `unsafe-switch` / `new-unsafe-switch`                       | covered                                     |                                |
| `CUSTOM_ARGUMENTS_JS_CHECK`                                       | `switches` (`switch`, `argument`)                             | `unsafe-switch` / `new-unsafe-switch`                       | covered                                     |                                |
| `CUSTOM_ARGUMENTS_JSON_CHECK` (switches in package.json scripts)  | —                                                             | —                                                           | missing                                     | `switches` kind `script`       |
| `SECURITY_WARNINGS_DISABLED_JS_CHECK`                             | `switches` (`security-warnings`)                              | — (it hides console warnings only)                          | read                                        |                                |
| `SECURITY_WARNINGS_DISABLED_JSON_CHECK`                           | —                                                             | —                                                           | missing                                     | `switches` kind `script`       |
| `LIMIT_NAVIGATION_JS_CHECK`, `LIMIT_NAVIGATION_GLOBAL_CHECK`      | `navigationHandlers` (presence, `returns` deny/allow)         | —                                                           | read                                        | `navigation-unlimited`         |
| `PROTOCOL_HANDLER_JS_CHECK`                                       | —                                                             | —                                                           | missing                                     | `protocols`, `custom-protocol` |
| `DANGEROUS_FUNCTIONS_JS_CHECK` (`executeJavaScript`, `insertCSS`) | —                                                             | —                                                           | missing                                     | `dangerous-call`               |
| `HTTP_RESOURCES_JS_CHECK` / `_HTML_CHECK`                         | `urls` (URL literals; `http:` visible)                        | —                                                           | read in part                                | `http-resource`                |
| `HTTP_RESOURCES_WITH_NODE_INTEGRATION_GLOBAL_CHECK`               | `urls`, `windows`                                             | —                                                           | read in part                                | `http-resource`                |
| `ELECTRON_VERSION_JSON_CHECK`                                     | `runtime` (packaged builds), package.json `electron` range    | — / `fuse-weakened` (end of support)                        | read                                        | `electron-outdated`            |
| `AVAILABLE_SECURITY_FIXES_GLOBAL_CHECK`                           | `runtime` (end of support from a dated release-data snapshot) | — / `fuse-weakened`                                         | read in part (no CVE list, by design)       | `electron-outdated`            |
| 27 upgrade checks (`ElectronAtomicUpgradeChecks`, Electron 5–8)   | —                                                             | —                                                           | not planned (API migration, not security)   | none                           |

## Electronegativity's open issues

| Issue                                                            | What it asks                                                                                                           | How hexvero answers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [#113](https://github.com/doyensec/electronegativity/issues/113) | A packaged `.app` with a bundled, minified `main.js` reports "No CSP" and no permission handler, although both are set | hexvero opens a `.app`, an install directory or a release ZIP as the app inside, and reads bundled and minified code by scope (esbuild plain and minified, webpack's module of `electron`, interop helpers); for permission grants, tests compare the minified build's answers with the plain one's (comma sequences, `!0`, comma returns). Which page a `<meta>` policy belongs to is not read: any HTML file of the app counts. The issue's own code is a test: the handler reads `never`, the CSP header (`...details.responseHeaders` spread) is read in its `onHeadersReceived` listener. A partial scan never reads as "missing". |
| [#106](https://github.com/doyensec/electronegativity/issues/106) | `Unknown Electron release "25.2.x"`: the release list is stale and the tool errors                                     | No error on an unknown version: the window defaults come from the major in package.json (marked "default", an assumption), and a packaged build's Electron line is judged against a dated snapshot of Electron's release data that says its date; an unknown line is unknown. No CVE list is claimed.                                                                                                                                                                                                                                                                                                                                   |
| [#108](https://github.com/doyensec/electronegativity/issues/108) | An exit code when issues are found                                                                                     | `hexvero audit` and `check`: `0` pass, `3` violated, `4` not decidable (with `--unknown fail`), `1` error, `2` usage. SARIF 2.1.0 for code scanning.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| [#78](https://github.com/doyensec/electronegativity/issues/78)   | Annotations in source code to ignore a check                                                                           | Suppressions live in the policy (`check`), by a fingerprint that names the item, never the line, with a reason and an optional expiry date. Source annotations do not survive a minified build. For `audit` the fingerprints exist (JSON, SARIF); reading suppressions from a policy is a follow-up (below).                                                                                                                                                                                                                                                                                                                            |
| [#93](https://github.com/doyensec/electronegativity/issues/93)   | `eng-disable` comments must be on the same line, which Prettier breaks                                                 | No comments are read: fingerprints do not contain lines, so moving or reformatting code changes no finding and no suppression (except `csp-weak`, whose identity includes the policy text).                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| [#58](https://github.com/doyensec/electronegativity/issues/58)   | Checks assume old `webPreferences` defaults (nodeIntegration on)                                                       | `windows` derives each setting from the literal, else the default of the Electron version package.json names (Breaking changes 5.0, 12.0, 20.0), and says which (`on` vs `default on`); without a version it is `unknown`, not a guess.                                                                                                                                                                                                                                                                                                                                                                                                 |

## What this slice implements

1. Collections `openExternal`, `permissionHandlers`, `csp` (`packages/core/src/javascript/security.ts`),
   wired into the scan (`app.ts`, JS_SCAN_SCHEMA 37), `collectionsOf`, `compare` (identities,
   positional and derived fields, unresolved families `openExternal`, `permissions`, `csp`) and
   the report order. Limitations `open_external_truncated`, `permission_handlers_truncated`,
   `csp_truncated`, `html_unread`. Finding `electron.open-external`.
2. Check rules `new-open-external`, `permission-handler-grants-all`, `csp-weakened` (warn when a
   policy does not list them): schema, `examples/policy.json`, `hexvero init`, SARIF texts, web
   labels.
3. `hexvero audit` with eight rules: `window-permissive`, `remote-enabled`, `unsafe-switch`,
   `open-external`, `permission-handler-missing`, `permission-handler-grants-all`, `csp-missing`,
   `csp-weak`.
4. Tests (`packages/core/test/security.test.ts`, `packages/cli/test/audit.test.ts`): plain, esbuild
   bundled and minified, webpack, look-alike and unproven receivers, the cap, nested and hostile
   input, HTML comments and raw text, the rules on one and two builds.

## Follow-ups, in order of value

1. **Audit suppressions and baselines**: `hexvero audit --policy <file>` reading an `audit`
   section (levels, suppressions by fingerprint with reason and expiry) and `--baseline`, so CI
   can accept known findings (#78). Then an MCP parameter (`hexvero_check` with one target, no new
   tool) and the UI.
2. **`window-permissive` extended** with `webSecurity: false`, `allowRunningInsecureContent: true`
   (both already read in `webPreferences`), `experimentalFeatures` and `enableBlinkFeatures` (new
   keys).
3. **`webviews`**: `<webview>` tags in HTML (`nodeintegration`, `disablewebsecurity`,
   `allowpopups`, `webpreferences`), `webviewTag`, and `will-attach-webview` handlers; rule
   `webview-insecure`.
4. **`navigation-unlimited`**: no `will-navigate` / `setWindowOpenHandler` for a window
   (`navigationHandlers` already says it); later what the handlers check.
5. **`protocols`**: `protocol.handle`, `registerFileProtocol` and the others,
   `setAsDefaultProtocolClient`; rule `custom-protocol`.
6. **`dangerous-call`**: `executeJavaScript` and `insertCSS` with an argument that is not a
   literal.
7. **`http-resource`**: `loadURL("http:…")` and `http:` script and style sources in HTML.
8. **package.json scripts**: switches and `ELECTRON_DISABLE_SECURITY_WARNINGS` in scripts.
9. **`electron-outdated`** from `runtime` for packaged builds.
10. Permission handlers per session against the windows' `partition` / `session`, and the
    remaining permission APIs (`setDevicePermissionHandler`, `setDisplayMediaRequestHandler`).
11. One scope reader: `switches.ts` and `security.ts` each prove Electron's names (`app`,
    `shell`, `session`); merge them into one module once both are stable.
12. Corpus rows for the new collections (`corpus/dev` expectations), so their accuracy is
    measured like the others.
