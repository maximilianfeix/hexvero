# Changelog

All notable changes to hexvero are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- Web UI collection tables page with the server's `next` offset, so a page the byte budget cut
  short no longer skips rows, and a row the server shortened to fit is marked with the full
  item's size (#81).

## [0.5.1] - 2026-10-14

### Accuracy

- Storage keys a helper object builds from its callers (`prefs.get("theme")` with
  `localStorage.getItem(PREFIX + name)`) are read: calling a method of a helper object no longer
  counts as changing it. Keys written as properties (`localStorage.sidebarWidth = …`) are reported
  with read, write or delete. Locals declared with `let` or `var` and never assigned again
  (`+=`, `++` count as assignments) are followed like `const`, and module wrappers with a
  string key (`{ "src/a.js"(exports) { … } }`) are functions of the resolver. Corpus,
  development sets: holdout2 storage keys 47 → 53 of 57 with false reports 1 → 0, holdout
  48 → 51 of 51; endpoints holdout2 53 → 54, holdout 35 → 36. The real applications checked
  report the same results.

## [0.5.0] - 2026-10-14

### Added

- `hexvero compare <a> <b>` without a collection (or with `--all`), and `hexvero_compare`
  without `collection`: one row per collection both targets share with the counts of added,
  removed, changed, relocated, unknown and unchanged items, which comparisons were partial, and
  the collections only one side has (#83).

### Accuracy

- Methods of object literals are functions to the resolver: `const http = { getJson(url) {…},
  postJson: (url, body) => … }` called as `http.getJson("…")` gives the address at each call
  site (only through that object, never through a bare call of the same name). `new URL(path,
  base)` is evaluated when both parts are known. Corpus, development sets: holdout2 endpoints
  46 → 53 of 57, holdout 32 → 35 of 42, still without false reports; the real applications
  checked report the same results as 0.4.2.

## [0.4.2] - 2026-10-14

### Accuracy

- Modules a bundler wrapped into one file are followed: esbuild's `__commonJS` wrappers with
  `exports.NAME = …` or `module.exports = { … }`, its `__toESM` interop, and the same helpers once
  minified (recognised by what their code does, not by name). Top-level object patterns
  (`var { A, B: b } = require_x()`, several per statement), classes written as
  `var Name = class { … }`, and keys of another module's object (`links.upload`) are read too.
  Corpus, development sets: holdout2 endpoints 22 → 46 of 57 with false reports 10 → 0, IPC
  channels 110 → 118 of 126; holdout endpoints 30 → 32 of 42 (false 1 → 0), storage keys 46 → 48
  of 51. The real applications checked (Claude, Discord, Electron Fiddle, Electron API Demos)
  report the same IPC channels, bridge members, window settings, endpoints and storage as 0.4.1.

## [0.4.1] - 2026-10-14

### Accuracy

- Endpoints and storage keys the fast scan cannot read go through the expression resolver: an
  address passed in by the callers of the function that makes the request (also through class
  methods and `this` fields set in a constructor), members of a `require`d module, and templates
  whose unreadable parts are kept as `${…}`. A value read this way only counts as a request
  address when it starts like one (scheme, absolute path, or another module's constant), so
  strings that callers pass for other reasons are not reported. Corpus, blind sets now used for
  development: holdout endpoints 24 → 30 of 42 with 5 → 1 false, storage keys 42 → 46 of 51;
  holdout2 endpoints 15 → 22 of 57, false reports unchanged at 10. Endpoints and storage of the
  real applications checked (Claude, Discord, Electron Fiddle, Electron API Demos) are unchanged.
- Resolvers of the same file share their indexes. A cold analysis of the Claude desktop archive
  takes about 10% longer sequentially (6.9 s → 7.6 s) and about 6% with worker threads
  (4.8 s → 5.1 s) on the test machine.

### Fixed

- The README showed a plugin install command Claude Code does not have (`--marketplace`); it is
  `/plugin marketplace add maximilianfeix/hexvero`, then `/plugin install hexvero@hexvero`
  (installed and checked in a clean Claude Code configuration). The plugin manifest said 0.3.0;
  releases now bump it with the packages.
- CLI tables show lists of plain values (an IPC channel's senders and receivers) instead of
  leaving the column out.

## [0.4.0] - 2026-10-14

### Accuracy

- IPC channels the fast scan cannot read are passed to a bounded resolver: concatenation and
  templates, one-expression functions (also curried), helper functions and class methods whose
  channel is bound at every readable call site, routers that build names from a constructor
  argument, arrays, Maps and objects registered in loops or `forEach`, `Object.entries/keys/values`,
  IPC objects kept in class fields. Rows say `via: "resolved"` and how (`resolution`). Nothing is
  guessed: an unreadable part leaves the call unresolved, and a partly readable helper keeps it in
  the limitation.
- Constants are followed through re-exports (`module.exports = { A: x.B }`, `export { A as B }
  from`, `export *`), nested groups (`channels.settings.get`) and `exports.X = { … }`.
- Window options are read through `Object.assign` (in argument order), factory parameters, and
  defaults or option factories in other modules (`definedIn` says where a value is written).
- contextBridge objects assembled from spreads of objects of the same file are read member by
  member.
- Fixed: `"win:" + id` was reported as the channel `win:`; a webPreferences object that no window
  takes (a manifest check) was reported as a window's setting; helper calls with an unreadable
  channel were dropped without a limitation; past a fixed budget, a helper's body reached into the
  following code.
- A new blind set, `corpus/holdout2`, written by an independent agent, with its blind measurement
  in `corpus/results/round3`, and REA 6.5.0 measured on it (`docs/competitive/rea-scorecard.md`).

### Security

- `hexvero_export` and `hexvero_recover` over MCP write only inside allowed roots (working
  directory and temp directory, or `HEXVERO_WRITE_ROOTS`), never into hidden paths, and an export
  must end in `.json` and may replace only an earlier export. Before, an agent misled by text in
  an analyzed file could write anywhere the server could, for example a shell startup file.
- `hexvero ui` analyzes in a worker like the MCP server, so a hostile file cannot stall the server.
- Device files, FIFOs and sockets are refused instead of read (`/dev/zero` never ends).
- A ZIP or APK may inflate at most 1 GiB in total, so entries that share compressed data cannot
  multiply memory use; a forged ASAR header length no longer allocates more than the file holds.
- SQLite databases open immutable, or from a private copy when a `-wal` file is pending, so no
  `-wal`/`-shm` files appear next to the analyzed file.
- New cache and scan-state directories are created `0700`, their files `0600` (existing
  directories keep their mode).
- `setup` leaves a differing hexvero entry alone instead of replacing it, and inserts into plain
  JSON as text, so key order and indentation stay as they were.
- The UI server sends a Content-Security-Policy that allows only its own origin.
- The UI's export download is fetched with the `Authorization` header; the server no longer
  accepts the session token in a query string.
- The cache is bounded: entries older than 30 days and the oldest beyond 1 GiB are removed
  (`HEXVERO_CACHE_MAX_MB`, `HEXVERO_CACHE_MAX_AGE_DAYS`), and directories an older version created
  `0755` are tightened to `0700`. `hexvero cache [--prune] [--clear [--apply]]`.
- Cancelling a call graph stops the engine once no other caller waits for the same run.
- `setup` reports a client file it cannot write and goes on with the others.
- MCP results carry `_meta["io.github.maximilianfeix.hexvero/untrustedContent"]: true`.
- GitHub Actions are pinned to commit SHAs.

### Performance

- JavaScript applications are analyzed faster with identical results: a faster tokenizer, fewer
  passes in name resolution, and up to three worker threads for applications with 4 MiB of source
  or more (`HEXVERO_JS_THREADS`). See docs/benchmarks.md for measurements.
- A helper function's body now ends at its closing brace however many functions precede it;
  before, past a fixed budget a body was taken as the next 4,000 tokens, which was slow and could
  report a channel passed to the helper that it never forwards.

### Added

- `hexvero setup --remove [--apply]` takes the hexvero entry out of agent client files again,
  with a backup of each file; files with comments are left alone with a note. When no client is
  found, `setup` says so in three lines instead of listing every client as not detected.
- `analyze` suggests up to four next commands for the kind of target (`next` in JSON and in the
  MCP result), pointing only at lists that exist.
- Native binaries get first-look findings: the hardening facts in one line, and imports that start
  processes, load code, change memory protection or open network connections. They are worded as
  imports, not as observed behaviour.
- `hexvero_compare` pages its lists with `offset` and `limit`; `hexvero_analyze` takes
  `detail: "full"` for the earlier, larger overview.
- A Claude Code plugin and marketplace manifest (`/plugin install hexvero --marketplace
  maximilianfeix/hexvero`), `mcpName` for the official MCP registry, and `glama.json`.
- The skill is a short core with one reference file per workflow, with tests that it names only
  tools and commands that exist. Tests plant prompt-injection text in a target and check that it
  reaches the agent only as quoted data.
- `scripts/context-cost.mjs` measures bytes and `o200k_base` tokens of fixed agent investigations;
  `scripts/demo-agent.mjs` writes `docs/demo/agent-session.md` from a real MCP session.

- A public corpus with written-down correct results (`corpus/`): three small Electron applications
  in three builds each (as written, bundled, minified), later versions with listed edits, three C
  programs with ordinary calls, tail calls, uncalled and pointer-reached functions, and damaged
  inputs. `corpus/score.mjs` counts hits, misses and false reports per class of finding and never
  adds classes up; `corpus/gate.mjs` fails CI when a result gets worse. Two of the sets were
  written without access to hexvero and measured before use (see `corpus/README.md`).
- Large JavaScript applications can be read to the end. A scan takes files in a fixed order (the
  entry file, then shallow paths before deep ones) and stores what it has read; `analyze
  --continue` reads the next batch, `--all` everything that is left, `--include <path>` only the
  files under a path, `--fresh` starts over. Over MCP: `hexvero_analyze { scan, include }`. In the
  UI a partial analysis is marked as such and offers both actions. Every result carries
  `coverage` (files in total, scanned, unread) and `complete`; a partial scan is never presented
  as a complete one. Stored state is tied to the content of the input, is replaced atomically, and
  a small application that is read in one run stores nothing.
- Electron archives and directories now have `endpoints`, `storage` and `urls` collections, from
  the same detector the single-bundle analysis uses. Each row has file, line and column, an
  `evidence` of `literal`, `template`, `inferred` or `unknown`, the HTTP method where the code
  states one and, for storage, whether the key is read, written or deleted. A request whose
  address cannot be read is listed with `value: null` instead of being dropped.
- IPC, bridge and window-setting detection follows names: renamed imports and destructured
  bindings (which is what every minifier produces), aliases, channel names from constants and from
  other modules, helper functions that pass a channel on, handlers registered from a table, and
  `event.reply`. Names are resolved with their scope, so a short minified name is not mistaken for
  `ipcMain` inside a function that declares its own.
- Window settings are attributed to a window (`window` field, counted per file) and read from the
  options of `new BrowserWindow(…)`, including an object passed by name, spread in, or returned by
  a helper; a key written for the window replaces the same key of its base object.
- IPC through names another file defines: a page global (`window.ipc = electron.ipcRenderer`,
  used as bare `ipc` in the page's other scripts) and a name bound at the top of a main-process
  file whose siblings in the same directory are built into one script. Evidence is required:
  the same directory and no file importing the using file; a `window.` global does not reach
  main-process files; a non-IPC global of the same name makes the name ambiguous. Also read:
  `x = require("electron").ipcRenderer`, a call written above the binding it uses,
  `webContents.ipc.on(…)`, `webContents.postMessage(…)` and `event.sender.send(…)` in listeners
  registered under another name. Rows read this way carry `via: "global"`.
- Channel names from compiled TypeScript string enums (`IpcEvents.RUN`, `module.IpcEvents.RUN`,
  also minified). A minifier's one-letter local is not taken as the enum's name, and a name the
  file binds to anything else resolves nothing.
- Limitations that name what could be seen but not read, with file and line:
  `ipc_receiver_unresolved` (a call that looks like IPC on a name that could not be traced),
  `ipc_channel_unresolved` (a channel that is a parameter or computed), `webpreferences_computed`
  and `window_options_unresolved`. The IPC finding is `confirmed` only when the first two are
  absent.
- Collection `windows`: one row per window constructor call, also one that writes no setting,
  with `nodeIntegration`, `contextIsolation` and `sandbox` each as `true`, `false`, `computed`,
  `conflicting` or `not written`, and the derived `nodeIntegrationInEffect`,
  `contextIsolationInEffect`, `sandboxInEffect` and `pageRequire` with the rule each rests on
  (`basis`). A default taken from the Electron version in `package.json` is `default on` /
  `default off` and `… by default`, never `on` / `off`. Rules and sources:
  `docs/electron-findings.md`.
- Six more window settings are read as written (`webSecurity`, `allowRunningInsecureContent`,
  `webviewTag`, `nodeIntegrationInSubFrames`, `nodeIntegrationInWorker`, `enableRemoteModule`),
  with findings for `webSecurity: false`, `allowRunningInsecureContent: true` and
  `webviewTag: true`, and `electron.node-integration-default` when nothing is written and the
  named Electron version predates 5.
- `compare` reports `unknown` for an item found on one side whose file the other side did not
  read, could not read, or read only up to the token budget (`?` lines on the command line,
  `unknown` in JSON and over MCP), and `matchedByPosition` for settings of windows without a
  name.

- Results that are derived from a partly read application say so themselves: a collection page
  carries `partial`, a comparison `partialScan` and a warning, and counts in findings read "in
  the scanned part" with confidence `inferred`. An archive with files that could not be read, or a
  folder whose listing was cut, is `complete: false` and described as incomplete.
- `hexvero_analyze` accepts `batch` and `fresh` next to `scan` and `include`.

### Changed

- `hexvero_analyze` over MCP returns a brief overview (facts and list sizes) instead of samples of
  every list: about 40 to 65 percent fewer tokens for a typical Electron investigation or version
  comparison. The CLI's `--json` output is unchanged.

- Analyzing a JavaScript application takes about twice as long as in 0.3.0 (measured: 6.3 s
  against 2.7 s on a 47 MiB archive, same memory). The time goes into following names.
- A large JavaScript application now leaves scan state under `~/.cache/hexvero/scans` (or
  `HEXVERO_CACHE_DIR`); a later `analyze` shows that state until `--fresh` is given.
- Rows of `endpoints` and `storage` may have `value: null` (a call whose argument could not be
  read) and carry `evidence`, `count`, `column` and, for IPC rows, `via`.
- `endpoints` no longer contains URLs that merely occur as strings; those are in `urls`. An
  endpoint row's value is the address alone, with the method in its own field (previously
  `"POST /login"`). `XMLHttpRequest.open` counts only on an object created as one, and a verb
  method of an unknown object only with an absolute URL.
- Modules of a JavaScript application are listed in scan order instead of archive order.
- Call graphs through radare2 include tail calls, derived from its jump references; the
  `callgraph_tail_calls_unknown` limitation remains only when those references are missing or cut.
- `compare` matches window settings by file, window and key, endpoints by file, kind and value,
  and storage by file, kind, value and operation; line and column are positions for these lists.
  A known identity is kept for short lists with a repeated item, and a composite key may have an
  empty part.
- Window settings are matched in `compare` by the variable the window is assigned to
  (`windowName`, with `#n` for a window that is not assigned), so a window added before another
  no longer pairs two different windows; the window number is a position.
- A window setting whose value is not a literal is a row with `value: null` and the expression
  in `computed`, instead of being dropped. It decides no app-wide flag.
- `app.enableSandbox()` is read from code, not text, and counts as certain only as an
  unconditional statement at the top of a file.
- Stored scans of earlier detectors are not reused (`JS_SCAN_SCHEMA` 5).

### Fixed

- A read-only or unwritable cache directory made the analysis of a large JavaScript app fail; it
  now completes and reports `scan_state_not_saved`.
- A missing engine's error now says how to install one.
- Claude Code was not detected by `setup` when only `~/.claude.json` existed.

- The CLI cut large output at a buffer boundary when it was piped (`--json | …`); it now exits
  only after standard output has been written.
- A folder with more than 50,000 files was listed only in part without a word, and dependencies
  under `node_modules` could use up that limit before the application's own files were reached.
- Settings were read from raw text, so `sandbox: false` in a comment or in an unrelated options
  object near a window counted as a window setting.
- A Mach-O, ELF or PE file that is cut short was analyzed without any limitation when its headers
  were intact; it now carries `file_truncated`.
- A file over the size budget of one run was counted as skipped for good; it now stays unread and
  a continued scan takes it.
- The `nodeIntegration: true` finding said "XSS becomes RCE" whatever `contextIsolation` was. Its
  text now follows `pageRequire` of the same window; no finding derives that conclusion from one
  setting.
- For one window and key the later write wins, as in JavaScript, also across a spread
  (`{ sandbox: true, ...base }` takes the base's value); the directly written key used to win
  always, which could show the safe value where the unsafe one is in effect. Two different values
  in separate objects of one window are `conflicting`, not one of the two.
- A helper that returns its options as `return ({ … })` was not followed.
- Settings of an options object declared above its `new BrowserWindow(options)` were rows without
  a window, and the window read as not written.
- `{ ...base, webPreferences: {…} }`: the later `webPreferences` now replaces the whole object the
  base brought, and the other way round.
- Settings of a window whose options could not be followed (a parameter, a call, a condition, a
  spread of something unknown), or whose options object is assigned to later, read as
  `computed`; they used to read as not written.

## [0.3.0] - 2026-10-13

### Added

- `contextBridge` collection and finding: every function a preload script exposes to pages
  (`window.<api>.<member>`), with file, line and the IPC channel it forwards to; `compare` matches
  it by `api+member`, so a swapped bridge function shows up as one added and one removed. An object
  passed by name is followed to its definition in the same file; what cannot be read (a value built
  elsewhere, a spread, a computed key) is listed as such and reported as a limitation.
- Electron findings carry evidence: each names the file and line it was read from
  (`nodeIntegration: true @ main.js:14`), the CLI prints it, and a new `webPreferences` collection
  lists every BrowserWindow setting with its position. A `sandbox: false` finding was added; HTML
  `preload="metadata"` attributes are no longer reported as preload scripts.
- `examples/`: a small Electron app in two versions and a C program in two versions, generated
  reproducibly by `scripts/build-examples.mjs`, used by the README demos and by `npm run e2e`.
- `npm run e2e`: the four core flows on real inputs (Electron evidence, a native binary compiled
  on the spot with call graphs through every installed engine, comparison of two controlled
  builds, a real MCP client over stdio). CI runs them on Linux and, with radare2, on macOS.
- `compare` (CLI and `hexvero_compare`) now matches items by an auto-detected identity field that
  is present and distinct on both sides (`name`, `channel`, `id`, `path`, `url`, … or `--key`),
  reports `changed` items with the fields that differ, treats items that differ only in
  address-like fields as `relocated` (`--ignore none` to count them), diffs duplicate identities as
  multisets, rejects an unknown `--key`, and states when a comparison is partial.
- `hexvero setup` knows 18 agent clients (Claude Code, Claude Desktop, Codex, Cursor, Windsurf,
  Gemini CLI, Antigravity, VS Code, Trae, OpenCode, GitHub Copilot CLI, Qwen Code, Qoder, Devin, Pi,
  Kiro, Amp, Zed), writes each client's own entry dialect including Codex TOML, honours their
  environment overrides, configures only detected clients unless `--all`, and never rewrites a file
  it cannot parse. MCP registry manifest `server.json`. README translations in eight languages.
- Cross-references and call graphs through engines: provider operations `xrefs`, `callers`,
  `callees`, `callgraph` and `search` for radare2, rizin and Ghidra with one normalized shape; the
  whole-program graph is read once and walked locally with depth/node bounds (`hexvero calls`,
  `hexvero_call_graph`), including shortest call paths and explicit truncation facts.
- Zero-dependency JavaScript bundle splitting (webpack 4/5, Rspack, browserify, esbuild): module
  boundaries, require graph, export names, endpoint/route/storage candidates, vendor fingerprints.
- Objective-C metadata from Mach-O images without an engine: classes (methods, ivars, properties,
  adopted protocols, superclass incl. external binds), protocols, categories; pointers decoded through
  dyld chained fixups (PTR_64, PTR_64_OFFSET, ARM64E) and dyld_info bind opcodes. Swift class names
  and mangled symbols are made readable (approximate, no `swift-demangle` needed).
- CIL method-body decoder for .NET assemblies: every opcode, tiny/fat headers, exception clauses, call
  targets resolved to names, string literals, raw and normalized IL digests; `methods`, `calls` and
  `cil` collections and a finding for process/reflection/network/crypto/file/registry calls.
- Android resources.arsc decoder (packages, types, default values, locales, densities) that resolves
  manifest references such as the application label; Flutter/Dart AOT snapshot facts (version hash,
  features, engine build ids, per-ABI digests) without Apktool or any engine.
- Guided MCP prompts (investigate_feature, compare_versions, triage_binary, map_electron_app, explain_apk)
  and an unknowns ledger tool (`hexvero_unknowns`) whose entries ship with exports.
- `hexvero recover` and the `hexvero_recover` MCP tool write bundle modules or source-map originals to
  disk without an external engine (REA needs Wakaru on Linux x64 for this).

### Fixed

- Call graphs now include tail calls when rizin provides the code references; through radare2,
  which does not, the graph carries a `callgraph_tail_calls_unknown` limitation so "not reached"
  is never presented as definite there; cached graphs from earlier versions are not reused.
  `strings --tag url` finds URLs inside longer strings. In `compare`, the source line of a
  `webPreferences` or `contextBridge` entry is a position, so code moving above it is not a change
  (`--strict` keeps it as content).
- The comparison with REA in the README and docs/benchmarks.md is replaced by measurements against
  REA 6.4.0; three earlier statements (139 tools, aborting on 500 MB bundles, needing an engine for
  most targets) were out of date or wrong and are corrected.
- `hexvero setup`, checked client by client against each client's documentation or source:
  settings files with comments (Zed's default file, VS Code, OpenCode) are edited in place with
  every comment preserved instead of being skipped; Windsurf now targets the directory Cascade
  reads; `COPILOT_HOME` and `QWEN_HOME` are honoured; Zed's macOS path no longer follows
  `XDG_CONFIG_HOME`; Cursor entries carry `type: "stdio"`; Amp's `settings.jsonc` is used when
  present; Codex configs with an inline `mcp_servers` table are left untouched instead of being
  broken; a client that already has the entry is reported as configured. The client table in
  docs/mcp.md states for each row what was verified and how.
- Call graphs through rizin lost every edge when rizin named a call target differently in its
  graph than in its function list (found by running the real engine). Functions are now unified
  by address, other names become aliases (`main` for `entry0`), and engine output is labelled so
  a missing document cannot be mistaken for another. The graph cache key includes the engine
  build and a schema version, so an engine upgrade or a changed file never serves a stale graph.
- Page budgets are a strict, documented contract: `maxBytes` bounds the real UTF-8 size of the page
  JSON for every shape of item (multibyte text, escapes, long keys, thousands of fields, deep
  nesting); budgets outside 512 … 64 MiB are rejected instead of being raised silently; an item that
  cannot fit is reduced to a measured form or a `$truncated` placeholder with `itemBytes`; pages name
  the `next` offset and `bytes` is exact. `maxBytes` is available on `hexvero_collection`,
  `hexvero_strings`, the HTTP API and `--max-bytes`.
- `compare` no longer sets differences aside by field name alone. Nothing is ignored by default;
  address fields of native symbols, exports, sections and segments count as `relocated` only when
  both values look like addresses, with samples shown; a `value` that changes from `old` to `new`
  is always a change. Nested changes are reported by path, and results state whether the comparison
  is complete (`truncated`, analysis limitations).
- The JavaScript bundle splitter recognises webpack 5 output whose modules are parenthesized arrow
  functions (`((module, exports, require) => { … })`), the default for current webpack builds.
- Web UI accessibility review: "Open file" is a real button reachable by keyboard; the view tabs are
  a navigation with arrow-key, Home/End movement and `aria-current`; Strings and Hex stay usable
  while analysis loads or fails, and a failed analysis offers Retry; tables use non-interactive
  table roles with a row count; the hex dump is focusable, reports read errors with Retry and decodes
  i32/f32/u64/f64 in both byte orders; graph nodes are keyboard-selectable and edge truncation is
  shown; the error banner is announced and dismissible, upload progress is announced in the top bar;
  a stale target URL explains that the target is no longer open; the shortcut hint says Ctrl+O off
  macOS; the format list matches the README; findings show their location when a parser records one.
- CLI usability review: `--help` exits 0; `*.map` files are recognised as source maps (so `recover`
  accepts them); `ui --host` is honoured with a warning for non-loopback hosts; value flags without
  a value, out-of-range `--limit`/`--offset` and unknown `--tag` or engine names are usage errors
  instead of silent clamps; `bytes` and `compare` say when their output was clamped or partial;
  empty pages read "0 of N"; `recover` explains what it accepts and when no module boundaries were
  found; a busy port and unknown-function errors get plain messages (`HEXVERO_DEBUG=1` for stacks);
  directory targets no longer print a size and hash.
- Core robustness review: the page byte budget is now an upper bound including the envelope, with
  oversized items compacted and marked `itemTruncated`; strings longer than 4096 characters are cut
  and report their full `length`; large (lazy) ASAR targets are identified by the SHA-256 of the
  whole file instead of a head+size fingerprint labelled as such; binary plists memoize shared
  objects so a fan-out chain cannot expand exponentially; directory analysis never follows symbolic
  links; analysis workers get a 2 GiB heap cap by default (`maxWorkerHeapMb`); `ilSha256` is null
  for clipped IL bodies; a Rust toolchain detected only from mangled symbols is `inferred`; ELF note
  alignment and ASAR offsets are validated.

### Changed

- Release pipeline: the packed tarballs are installed into an empty project and exercised (CLI,
  shipped UI and skill, a real MCP session over stdio, the UI server) before anything is published;
  version, tag and source branch are validated on every path; the GitHub release stays a draft
  until npm holds exactly the tested tarballs and an install from the registry passes; identical
  re-publishes are accepted, differing ones fail; a manual run can only dry-run.
- Security review of the MCP and HTTP surfaces: every MCP tool carries explicit annotations
  (export, recover, provider_run and call_graph are no longer advertised as read-only);
  `hexvero_export` refuses to replace an existing file unless `overwrite: true` and returns the
  absolute path; `hexvero_recover` bounds its `skipped` list; engine processes are killed when the
  server exits or the client cancels (`cancelled` error code); `address` rejects radare2 iterator
  syntax; the loopback server rejects requests whose Host is not the bound host (DNS rebinding),
  accepts `?token=` only for the export download, compares tokens in constant time, answers 400 to
  malformed JSON and keeps uploads in a private per-server directory.

## [0.2.1] - 2026-10-13

### Added

- Analyses run in a worker thread with a timeout (`HEXVERO_ANALYSIS_TIMEOUT_MS`) and per-caller
  cancellation; MCP and HTTP servers stay responsive and client cancels stop the work.
- Agent skill (`skills/hexvero/SKILL.md`) shipped in the npm package and installed by
  `hexvero setup --skill` for Claude Code, Codex and `.agents`.
- German README; npm metadata for every package; `npm run publish:all`.
- CI runs typecheck and tests on Windows and macOS.

## [0.2.0] - 2026-10-13

### Added

- Toolchain facts for ELF, PE and Mach-O: compiler (GCC, clang, Apple clang, MSVC), Rust detection,
  DWARF presence, Swift/Objective-C runtime use, embedded build paths.
- PE version resources (VS_VERSIONINFO): file and product versions, company, product and file names.
- hexvero.dev landing page deployed through GitHub Pages; issue forms, PR checklist and Dependabot.

### Changed

- GitHub Actions bumped to current majors; dev tooling updated (Vite 8.3, Vitest 5, oxfmt).

## [0.1.1] - 2026-10-13

### Added

- Apple app bundle analysis for `.app` directories (Info.plist facts, main binary, frameworks, helpers,
  entitlements, privacy keys, URL schemes).
- Lazy, file-backed reading for ASARs above the in-memory limit; byte windows served from disk.
- ZIP64 central directories.

### Fixed

- Mach-O: section records were skipped with the wrong length; addresses and symbol values use bigint.
- ZIP64 offset read from the wrong field; `.aar`/`.jar` archives no longer routed to the APK parser.
- WASM global initializer expressions containing `0x0b` immediates.
- Parser bounds errors are reported as `malformed` instead of internal errors.
- HTTP server: double-decoded upload names, unvalidated numeric query params, `Origin: null`,
  immutable caching of unhashed assets, unhandled read-stream errors.
- Web UI: storage-safe token read, bounded response cache, keyboard-reachable close control.
- Providers: Ghidra cache keyed by file content, stale outputs removed, `which()` honors PATHEXT.

## [0.1.0] - 2026-10-13

### Added

- Zero-dependency parsers for ELF, PE and Mach-O (thin and fat) with sections, segments, symbols,
  imports/exports, dynamic metadata and hardening flags.
- Go buildinfo recovery (version, main module, dependencies, build settings) and .NET metadata
  inventory (assembly, types, methods, P/Invoke, user strings).
- WebAssembly and EVM bytecode inspection, SQLite schema inventory, XML and binary plist decoding,
  HAR capture summaries, ZIP reader and Android APK manifest decoding.
- Electron ASAR reader, JavaScript module graph with IPC channel matching, source map decoding.
- `hexvero` CLI with analyze, collection, strings, bytes, compare, export, provider, mcp, ui, doctor
  and setup commands.
- Compact MCP server with 12 tools and a discovery payload under 32 KiB.
- Local web UI with overview, findings, collections, strings, hex viewer and module graph.
- Optional radare2/rizin and Ghidra headless adapters.
- Java class, JAR and DEX inspection; APK analysis lists classes and packages.
- Review workflow with a threaded quality report on every pull request; release workflow on tags.
