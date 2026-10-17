# CLI reference

All commands accept `--json` for machine-readable output and `--no-color`. Paths may be relative.

| Command                                                                                                                                      | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `demo [dir]`                                                                                                                                 | Copies the two example builds (`notesdesk-1.4.0.asar`, `notesdesk-1.5.0.asar`) into `dir` (default `./hexvero-demo`) and prints what changed between them, with the place of each change and what was not established. A file of the same name with other content is never replaced.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `analyze <path> [--out file.json]`                                                                                                           | Detects the format, runs the analyzer, prints summary, findings, limitations and the collections that exist. `--out` also writes the complete JSON (an existing file is replaced, without `--force`). For a large JavaScript app see [Large applications](#large-applications).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `collection <path> <name> [--text s] [--limit n] [--offset n]`                                                                               | Pages one list. Unknown names return the available ones.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `strings <path> [--min n] [--utf16] [--tag t] [--text s] [--limit n] [--offset n]`                                                           | Printable strings with offsets and tags.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `bytes <path> <offset> [length]`                                                                                                             | Hex dump (max 64 KiB). Offset accepts `0x` hex.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `compare <a> <b> [collection] [--key f[+g]] [--ignore f,g] [--strict]`                                                                       | Without a collection (or with `--all`): one row per collection both targets have, with the counts of added, removed, changed, relocated, unknown and unchanged items, and which comparisons were partial (past the comparison budget of 200,000 items or 256 MiB per side). For Electron apps it then lists window settings whose derived value changed what a page may do (`sandboxInEffect: on → off (more permissive)`); these are facts to review, not findings. With a collection: added, removed and changed items between two targets. Items are matched by an identity that hexvero picks (`name`, `channel`, `path`, `type+name` for methods …) or by `--key`. Nothing is ignored by default except that address fields of native symbols, exports, sections and segments which only moved are counted as `relocated` and shown with an example; `--strict` counts them as changed, `--ignore` excludes more fields. The output says when a comparison is partial or the analyses carry limitations.                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `compare <a> <b> --report file.md\|file.html [--force] [--offset n] [--limit n]`                                                             | Writes the comparison of every reviewed list as Markdown: a summary table, window settings to review, each change with the file and line it was read from on its side and how it was read (`literal`, `inferred`, `link direct`), a list that exists in one build only as added or removed, what was not established (limitations of both sides, unknown items), and the command to reproduce it. No dates and no directories, so the same inputs give the same bytes. Text from the targets is quoted so it cannot add Markdown of its own; control, bidi and zero-width characters in it show as `\u{202e}`. Refuses to replace an existing file unless `--force` is given. Rows are paged (200 per report; `--offset n`, `--limit n` up to 5,000) and the report says how many of how many are shown. A file name ending in `.html` or `.htm` writes one self-contained HTML page instead, from the same comparison: the same sections, before/after places with the seven source lines around each (at most 200 excerpts and 250,000 characters; the page says when it cut), and filters by kind, list and text. It loads nothing from the network, makes no link from target text, escapes every piece of target text (invisible characters show as `⟨U+202E⟩`) and carries a Content-Security-Policy that allows only its own inline script by hash; with JavaScript off it shows the same content without the filters. |
| `check <before> <after> --policy <file> [--baseline file] [--update-baseline] [--format text\|json\|markdown\|sarif] [--out file] [--force]` | Applies a release policy to the comparison of two builds: new interface members, new external hosts, windows that became more permissive. Exit `0` pass, `1` technical error, `2` usage error or invalid policy, `3` policy violated, `4` not decidable under `unknown: fail`. See [Release policies](#release-policies-hexvero-check).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `export <path> <out.json>`                                                                                                                   | The complete analysis as JSON. An existing `out.json` is replaced (unlike `compare --report` and `check --out`, which need `--force`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `recover <path> <outdir>`                                                                                                                    | Splits a JavaScript bundle into module files (webpack, Rspack, browserify, esbuild, and scope-hoisted bundles at their `// path` comments), or writes a source map's original sources, into a new directory. Rollup/Vite chunks have no module boundaries; the manifest lists the chunks they import.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `provider <path> <engine> <operation> [--address a] [--text s] [--timeout ms]`                                                               | Runs radare2/rizin/ghidra operations: functions, disassemble, decompile, strings, imports, xrefs, callers, callees, callgraph, search.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `calls <path> <engine> <root> [--direction d] [--depth n] [--max n] [--goal g]`                                                              | Bounded call-graph neighborhood around a function, or the shortest call path to `--goal`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `mcp`                                                                                                                                        | Serves MCP over stdio.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `ui [--port n] [--host h] [--open] [--demo]`                                                                                                 | Starts the local web UI (default port 7331, loopback only unless `--host` is given, which prints a warning). `--demo` opens the example builds and starts on their comparison. The Compare view ends in a release gate; see [Web UI](#web-ui-hexvero-ui).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `doctor`                                                                                                                                     | Checks Node, `node:sqlite` and engines.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `setup [--client c] [--apply]`                                                                                                               | Registers the MCP server; dry run by default.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

Exit codes: `0` success (including `--help`), `1` analysis error (`{"error":{"code","message","details"}}` with `--json`), `2` usage error. Set `HEXVERO_DEBUG=1` for stack traces. `check` adds `3` (policy violated) and `4` (not decidable); see below.

## Release policies: `hexvero check`

```bash
hexvero check <before> <after> --policy <file> [--baseline <file>] [--update-baseline]
              [--format text|json|markdown|sarif] [--out <file>] [--force]
```

`check` compares two builds as `compare` does and applies a policy file to the result. The
policy is JSON, data only (no code, no regular expressions), described by
[`policy.schema.json`](policy.schema.json); [`examples/policy.json`](../examples/policy.json) is
a complete one, and `hexvero demo` copies it next to the example builds:

```json
{
  "hexvero": "policy",
  "version": 1,
  "rules": {
    "new-interface-member": { "level": "fail" },
    "new-external-host": { "level": "fail", "allow": ["api.example.com", "*.cdn.example.com"] },
    "window-more-permissive": { "level": "fail" }
  },
  "unknown": "fail",
  "suppressions": [
    {
      "rule": "new-external-host",
      "fingerprint": "68312dcec55422c3b8affec165b21b83",
      "reason": "update server, reviewed in #42",
      "expires": "2026-12-31"
    }
  ]
}
```

| Rule                     | Reports                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `new-interface-member`   | A member pages can call (`window.api.member`, from `contextBridge.exposeInMainWorld`) that the before build did not expose anywhere (a member that only moved to another preload file is not new). Read from `interfaces`, or `contextBridge` where there is no `interfaces` list.                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `new-external-host`      | A host named by a new `endpoints` or `urls` row that is not in `allow` and that the before build did not already name (in any file, with any path: a renamed chunk or a new path on a known host is not a new host). The value is read as a WHATWG URL parser reads it: leading and trailing control characters and spaces and every tab and line break are dropped, any number of slashes may follow the scheme. `allow` takes exact host names and `*.domain` (every subdomain of `domain`, not `domain` itself); no scheme, port or path. Relative paths, `file:`, `data:`, app schemes and loopback are not external. A host built at run time (`https://${region}.api.example.com`) is unknown, never a pass. |
| `window-more-permissive` | A window present in both builds whose derived `nodeIntegration`, `contextIsolation`, `sandbox` or page `require` changed so its pages may do more, and a new window (or one renamed: matched windows are matched by file and name) whose own settings already let its pages do more (`nodeIntegrationInEffect` on, `contextIsolationInEffect` off, `sandboxInEffect` off, `pageRequire` yes, or their defaults), with its file and line. When a removed window had the same permissive setting, the new one may be that window renamed, and the finding is unknown; so is a change whose direction cannot be told, a window row on a side that was not read, and a new window whose settings are not known.        |

**What can be checked.** Both builds must be JavaScript applications (an Electron `.asar` or an
app directory) or both single JavaScript bundles. Anything else (a README, a JSON file, a
binary, an archive compared with a bundle) is refused with exit `1`; there is nothing to check
there, and a check that found nothing must not read as a pass. Two bundles have no windows or
bridge lists, so those rules are undecidable for them (gap `collection_missing`).

`level` is `fail`, `warn` or `off`; a rule the policy does not list runs at `fail`. A misspelt
rule or key is an error, not a rule that never runs. `level` says what the policy makes of a
finding; how the fact was read (`literal`, `inferred`, `link direct`) is reported separately as
`basis`.

**Unknown.** When a rule cannot be decided (a value computed at run time, an unresolved IPC
channel, a file not read, a list compared only in part), `unknown` says what that means:
`fail` (default) makes the status `incomplete` and the exit code `4`; `warn` and `allow` let the
check pass. The unknown findings and the gaps stay listed in every case. A definite violation
wins over an undecidable one (exit `3`).

**Fingerprints** name a finding by what it is about, never by where: `sha256(rule \0 identity)`,
first 32 hex characters. The identity is the member (`api.member`, not the preload file), the
host, or the window, setting and new value. Lines, columns and the order of rows do not enter
it, so a baseline survives code moving. The same member or host in several places is one
finding with every place. A rename is a removal plus an addition: the new name is a new finding.
An unknown finding ("may be new") has a fingerprint of its own (`identity` prefixed with
`maybe`), so a baseline that accepted an unknown does not accept the same item once it is
definitely new.
Fingerprints are defined for policy and baseline version 1; another version is refused.

**Baseline.** `--baseline file --update-baseline` writes every current finding (except
suppressed ones) to `file` and is the only way findings are accepted; a normal run with
`--baseline file` reads it and never writes. Accepted findings have state `baselined` and do not
fail the check. A gap that leaves a rule undecidable cannot be baselined: set `unknown` to
`warn` when you accept it. When the baseline was written for another policy or against another
before build (its `policy` or `a` sha256 differs), the result says so in `baseline.warnings`
(text output and stderr); it is still applied.

**Suppressions** set one finding aside by rule and fingerprint, with a reason and an optional
last day (`expires`, UTC). After that day the finding returns with state `suppression-expired`
and counts as new, even if a baseline accepted it: an expired suppression takes precedence over
the baseline, so a deadline set in the policy cannot be bypassed by an older baseline. The order
is: active suppression (`suppressed`), expired suppression (`suppression-expired`, counts), in
the baseline (`baselined`), otherwise `new`.

**Output.** Text, `--format json` (the `PolicyResult`), `--format markdown` (for a pull request
comment or job summary) and `--format sarif` (SARIF 2.1.0) all come from the same result.
`--out file` writes it to a file and prints a one-line status; an existing file is replaced only
with `--force`. In SARIF, locations are paths inside the analyzed build, written as
`hexvero-build/after/<archive>/<path>` (`before` for the before build) with
`uriBaseId: HEXVERO_TARGET_B` (or `_A`) whose base is `file:///`, described as such in
`originalUriBaseIds` and the run properties; nothing is mapped onto files of your repository. Only findings that count (`new`,
`suppression-expired`) become SARIF results, because code scanning does not honor SARIF
suppressions. For CI, see [ci.md](ci.md).

```text
$ hexvero check hexvero-demo/notesdesk-1.4.0.asar hexvero-demo/notesdesk-1.5.0.asar --policy hexvero-demo/policy.json
hexvero check fail: the policy is violated
  before notesdesk-1.4.0.asar · after notesdesk-1.5.0.asar · policy policy.json

  ✗ new-interface-member  notesdesk.checkUpdate  new · fail
      New interface member notesdesk.checkUpdate is exposed to pages.
      @ b: preload.js:9, handler main.js:30 · link direct · fingerprint 40aa15f76bfd9988f9302d187c03c61d
  ✗ new-external-host  updates.notesdesk.example  new · fail
      New external host updates.notesdesk.example, not in the allow list (https://updates.notesdesk.example/latest.json).
      @ b: main.js:30 · literal · fingerprint 68312dcec55422c3b8affec165b21b83

  Accept what is there now: add --baseline <file> --update-baseline, or a suppression with the fingerprint and a reason in the policy.
```

Exit `3`. After the two findings are accepted with `--update-baseline`, the same run exits `0`.
The unresolved IPC channel at `main.js:33` does not make `new-interface-member` undecidable:
which members a preload exposes is read from the bridge itself. An unreadable or truncated bridge,
a host built at run time, a window setting whose direction is unclear, or a partly read app does
(exit `4` under `"unknown": "fail"`).

## Web UI: `hexvero ui`

`hexvero ui --demo --open` starts the loopback server with the two example builds and opens their
comparison. The reviewer flow ends in **Release gate** at the bottom of the Compare view (or
**Release gate ↓** next to the report download): a policy editor prefilled with
[`examples/policy.json`](../examples/policy.json) (embedded in the UI at build time, nothing is
fetched), **Run check**, and the result: the status as a word and a sign (`✓ Pass`, `✗ Fail`,
`? Incomplete`), each finding with its rule, key, places (each opens the source lines), basis and
fingerprint, unknown findings marked as such, rules that could not be decided with the gaps in
plain words, and **Download SARIF** / **Download Markdown** of the same run. An invalid policy
lists every problem with its JSON path. `Ctrl`/`⌘`+`Enter` in the editor runs the check; `Tab`
leaves it. Same rules and output as `hexvero check`; no baseline (use the CLI for
`--baseline`/`--update-baseline`).

The UI calls `POST /api/check?a=<id>&b=<id>[&format=json|markdown|sarif]` with the policy JSON as
the request body (at most 1 MiB). The server never reads a policy or baseline path from the
client, and the route sits behind the same session token, Host and Origin checks as every other
`/api` route. `json` (default) answers the `PolicyResult` of contract C5; `markdown` and `sarif`
are downloads with `Content-Disposition: attachment;
filename="<before>-to-<after>.hexvero-check.md|.sarif"`. The policy is named `policy.json` in the
result. Status codes: `200` the check ran (pass, fail and incomplete alike; read `status`), `400`
`invalid_policy` with `details.issues` (every problem of the policy) or `invalid_input` (missing or
equal `a`/`b`, unknown `format`, a target that is not a JavaScript app), `401` no or wrong token,
`403` foreign Host or Origin, `404` unknown target id, `405` a method other than POST, `413` a
body over 1 MiB.

## Collections by format

| Format               | Collections                                                                                                                                                                |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ELF                  | sections, segments, symbols, imports, exports, libraries, goDependencies                                                                                                   |
| PE                   | sections, imports, exports, libraries, goDependencies; .NET adds types, methods (with IL facts), calls, cil, pinvokes, userStrings, assemblyRefs                           |
| Mach-O               | segments, sections, symbols, imports, exports, libraries, goDependencies; fat adds slices                                                                                  |
| WASM                 | imports, exports, types, sections                                                                                                                                          |
| EVM                  | selectors, instructions, opcodes                                                                                                                                           |
| SQLite               | tables, columns, indexes, triggers, samples                                                                                                                                |
| HAR                  | requests, hosts, endpoints                                                                                                                                                 |
| APK                  | permissions, components, libraries, files, classes, packages, dexFiles                                                                                                     |
| JAR                  | classes, packages, manifest                                                                                                                                                |
| Java class           | methods, fields, referencedMethods, referencedClasses, constants                                                                                                           |
| DEX                  | classes, packages, dexStrings                                                                                                                                              |
| ZIP                  | files                                                                                                                                                                      |
| Electron / directory | modules, edges, externals, ipcChannels, ipc, webPreferences, windows, contextBridge, bridgeExposures, interfaces, navigationHandlers, endpoints, storage, urls, sourceMaps |
| JavaScript file      | references, ipc, exports, bundleModules, endpoints, routes, storage, urls                                                                                                  |
| Source map           | sources, packages                                                                                                                                                          |

`findings` and `limitations` exist for every format.

## Large applications

A JavaScript application is read 5,000 files at a time (`--batch n` changes that). When files are
left, the summary starts with `partial`, a Coverage section says how many are unread, and
`--json` carries `complete: false` and a `coverage` object. Everything in the result then covers
the scanned part only.

```bash
hexvero analyze app.asar              # the first batch, or the stored scan as it stands
hexvero analyze app.asar --continue   # read the next batch
hexvero analyze app.asar --all        # read everything that is left
hexvero analyze app.asar --include src/main,dist/*.js   # only unread files under these paths
hexvero analyze app.asar --fresh      # discard the stored scan and start again
```

Files are taken in a fixed order: the entry file from `package.json`, then shallow paths before
deep ones, then by path. A continued scan therefore never reads a file twice and never leaves one
out. What has been read is stored under `~/.cache/hexvero/scans` (or `HEXVERO_CACHE_DIR`), keyed by
the content of the input and the hexvero version, so `collection`, `compare` and `export` in later invocations see the
same state, and a changed archive starts from nothing. An application with 1 MiB of JavaScript
or more is stored even when one batch read it whole, so later invocations reuse the scan (Claude's
47 MiB archive: about 8 s cold, 0.3 s from the stored scan); a smaller one stores nothing. If a run is interrupted, the state of the last finished batch remains.

Applications with 4 MiB of source or more are tokenized in up to three worker threads, largest
file first; the results are merged in the fixed order above, so the analysis is the same as with
one thread. `HEXVERO_JS_THREADS=0` turns the threads off, any other number sets their count.

## The cache

`~/.cache/hexvero` (or `HEXVERO_CACHE_DIR`) holds stored scans (`scans/`), engine call graphs
(`graphs/`) and Ghidra projects (`ghidra/`). Directories are created `0700` and files `0600`;
directories an older version created more open are tightened when they are next used. Entries
older than 30 days are removed, and the oldest beyond 1 GiB in total, at most once an hour and
never one written in the last hour. `HEXVERO_CACHE_MAX_MB` and `HEXVERO_CACHE_MAX_AGE_DAYS` change
the limits. Only files and directories hexvero names itself are ever removed, and links are not
followed.

```bash
hexvero cache                   # where it is, what it holds, the limits
hexvero cache --prune           # apply the limits now
hexvero cache --clear           # what --clear --apply would remove
hexvero cache --clear --apply   # remove everything hexvero stored
```

## Endpoints and storage

For Electron archives, directories and single bundles:

```bash
hexvero collection app.asar endpoints
hexvero collection app.asar storage --text token
```

Each row says where it was read (`file`, `line`, `column`) and how (`evidence`):

| `evidence` | Meaning                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------- |
| `literal`  | the address or key is a string at the call                                                  |
| `template` | part of it is known, the rest is an expression, shown as `${…}`                             |
| `inferred` | reached through a constant or another name for `fetch`, or recognised by its shape only     |
| `unknown`  | there is a call, but its argument cannot be read; `value` is null and `expression` names it |

A URL that only occurs as a string is not an endpoint; those are listed in `urls`.

## Next steps

`analyze` ends with up to four commands that answer the obvious next questions for this kind of
target (`next` in `--json`). They only point at lists that exist in this analysis.

## Setting up and removing agent clients

```bash
hexvero setup                     # dry run: which client files would change
hexvero setup --apply             # add the hexvero MCP server to every detected client
hexvero setup --client cursor --apply
hexvero setup --remove            # dry run of taking it out again
hexvero setup --remove --apply    # remove exactly the "hexvero" entry, backing up each file first
```

`setup` never removes or rewrites anything else. A file with comments (JSONC) is edited as text
when an entry is added; for removal it is left alone with a note to remove the entry by hand, since
rewriting would lose the comments. When no client configuration is found, `setup` says so and shows
how to name one.

## When something is missing

- No engine installed: `calls` and `provider` fail with `provider_unavailable` and say how to
  install one; everything else works without an engine. `hexvero doctor` lists what is installed.
- A read-only cache directory: analysis still works; a large JavaScript app reports
  `scan_state_not_saved` because its scan cannot be continued later. Set `HEXVERO_CACHE_DIR` to a
  writable directory to fix that.

## What an export and a comparison promise

`export` writes one JSON document. Besides the analysis itself it carries:

| Field        | Meaning                                                                                                                                                                                                                                                   |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hexvero`    | Format version of the document, `1`. A change that breaks readers raises it.                                                                                                                                                                              |
| `generator`  | The package and version that produced the analysis.                                                                                                                                                                                                       |
| `complete`   | `false` when the analysis recorded any limitation: it stopped at a size cap, read an application only in part, met something it could not follow, or could not establish a fact it looks for (an ELF without `PT_GNU_STACK` leaves the NX state unknown). |
| `incomplete` | The codes of those limitations, once each. Their messages are in `analysis.limitations`.                                                                                                                                                                  |
| `volatile`   | The fields that differ between two exports of the same input (`exportedAt`, `target.openedAt`, `analysis.durationMs`). Everything else is the same byte for byte.                                                                                         |

Four states are kept apart:

- **Found**: a row in a collection, with the file and line (or byte offset) it was read from.
  `confidence: "confirmed"` means read as written; `"inferred"` means reached through a
  constant, an alias or a shape, and says how.
- **Not found**: no row, in an analysis that is `complete`. This says the analysis saw nothing,
  not that the thing cannot happen at run time.
- **Not analyzed**: a file that was skipped or read only in part is named in the limitations
  (`scan_truncated`, `scan_partial`, `har_truncated` …). Nothing is claimed about it.
- **Unresolved**: a row whose value could not be established, such as an IPC call whose channel
  is a parameter. It is listed with `channel: null` and named in `ipc_channel_unresolved`.

`compare` applies the same rules to two targets. An item on one side only is `added` or
`removed` only when the other side read the file it is in and compared its whole list. When the
other side skipped that file, read the application only in part, or was cut at 2,000 items, the
item is `unknown` and the reason is given.
