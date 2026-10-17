# Changelog

All notable changes to hexvero are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Electron analysis

- Storage keys through wrapper methods and enums: a storage call whose key is a parameter of the function or method it is in (Electron Fiddle's `save(key, value)` / `retrieve(key)`) is read at each call of that wrapper in the same file, one row per call with that call's line and column and `via` naming the wrapper (`AppState.save`, `prefs.get`, `put`). Keys are read as literals, constants, templates and members of compiled TypeScript string enums (`c.GlobalSetting.theme` as webpack writes an import, the enum announced in tsc's `t.A = t.GlobalSetting = … = void 0` chain); a call whose key cannot be read keeps the storage call's unread row, nothing is guessed. A class written as `exports.Name = class {…}` is now a class for the resolver, an object literal of helpers in a minifier's `var a = …, c = {…}` is followed, and a parameter or local of the helper's name around a call is no call of it. The resolver reads up to 200,000 functions per file (was 20,000: Fiddle's renderer bundle has 25,113, and its `AppState` came after the first 20,000). In `compare`, an unread storage key hides only items of its own kind in its file. Electron Fiddle 0.38.0 → 0.39.0: storage rows 10 / 10 (all unread) to 82 / 85, 27 / 28 keys read (every `GlobalSetting` and `WindowSpecificSetting` member, checked against the v0.39.0 source), and `compare` lists `isUsingSocketFirewall` as added (read, write, delete) with nothing else added or removed (miss M2 of the case study). holdout5 storage keys unchanged at 7 / 17 / 4 (its misses are wrappers called from another module and files). Not read: wrapper calls from another module, keys taken from `this`, constants in a minifier's declaration list (docs/electron-findings.md). Stored scans are read again.

### Web UI

- Text from the target is shown with invisible and direction-changing characters written out as
  `⟨U+…⟩` in every view, not only in Compare, the evidence panel and the source view: finding
  titles and details, limitations, table cells, module names in the graph, the target path above
  the tabs and the target names in the sidebar. A right-to-left override in a channel list or a
  file name (`…\u202Egpj.exe` read as `…exe.jpg`) no longer reorders what the reviewer reads.
- A table, the strings list, the interface map, the module graph or the source lines that fail to
  load (an error from the server, a timeout, a stopped server) say what failed, are announced to
  screen readers and offer **Retry**; a failed table no longer reads "No rows match."
- A link to a view the target does not have (the module graph or interface map of a plain
  JavaScript file, an unknown tab) says so and offers the overview instead of the server's
  "Unknown collection" message or an empty panel.
- After a link or Back/Forward replaces the view, focus moves to the workspace instead of falling
  to the page start; the "Reading …" line is announced while an analysis runs.
- In the interface map, opening a node or edge is a history entry, as in Compare: Back closes the
  evidence and stays on the map (it used to leave the map).

## [0.9.1] - 2026-10-17

### Web UI

- Release gate in the Compare view: a policy editor prefilled with `examples/policy.json`
  (embedded at build time), **Run check**, the status as a word and a sign, each finding with
  rule, key, places (linked to the source lines), basis and fingerprint, unknown findings marked,
  undecidable rules with their gaps in plain words, and **Download SARIF** / **Download
  Markdown**. An invalid policy lists every issue. Screenshots `docs/screenshots/ui-release-gate*.png`,
  recording `docs/demo/ui-review.mp4`.

### Server

- `POST /api/check?a=<id>&b=<id>[&format=json|markdown|sarif]` (contract C7): the policy JSON is
  the request body (at most 1 MiB, read with `parsePolicy`); the server reads no policy or
  baseline path from the client. `400 invalid_policy` carries `details.issues`; Markdown and SARIF
  are downloads with a file name. Behind the existing token, Host and Origin checks.
- `MAX_POLICY_BYTES` is exported from `@hexvero/core`.

### Electron analysis

- Window options built from module constants and factories are read: `Object.assign({}, A, B, { … })` and `{ ...A, ...B, key: v }` with `A`, `B` constants of the same or another module (the later write wins), the shorthand `{ webPreferences }` (it was read as no webPreferences at all, so a version default could stand in for a value the code sets), and esbuild's `__toESM(require_x()).default` of a CommonJS module (by the helper's node-mode argument when it is a literal, or when the module does not mark itself as an ES module). A name is followed to the declaration it has where it is used, so a shadowing parameter, local, `catch (…)` binding or declaration in a block at the top of the file, or a minifier's short name reused in another function, no longer stands for it (the evaluation of options also read a top-level constant through such a block before), and a change to the base or to the merged object after the merge makes the value computed. An `Object.assign` argument that cannot be read makes the keys before it computed instead of hiding the whole call. Where the evaluation of a window's options cannot read a key, the rows as written stay. Options taken from a field of an object (`new BrowserWindow(this.options)`, `webPreferences: this.prefs`) are no longer followed at all, also not in the form earlier releases read by name (`options = {…}` in a class body): a field can be changed in more ways than a reading of the text sees (`Object.assign(this, …)`, `Reflect.set`, a computed key, an alias of a nested object), so those windows read as computed with `window_options_unresolved`. A change made to an imported options object in another module is not seen (docs/electron-findings.md, Not read). holdout5 (development set): window settings 17 / 35 / 0 to 32 / 20 / 0 over the four inputs (each 8 / 5 / 0: the editor and help windows read, the preview window's class field not), webPreferences changes v1 to v2 0 / 2 / 0 to 1 / 1 / 0. time-tracker window settings 11 / 0 / 0 (plain) and 8 / 3 / 0 (bundled, minified) to 7 / 4 / 0 each, its v1 to v2 webPreferences changes 2 / 0 / 0 to 1 / 1 / 0 (its main window takes a class field). A module that a minified bundle binds in a declaration list (`var a = …, u = h(S())`) is read as that module (not where gaps are shown); music-player minified: IPC channels 12 / 8 / 0 to 20 / 0 / 0, as in its plain and bundled builds. Stored scans are read again.

- New collection `bridgeExposures` and finding `electron.bridge-exposure`: a preload that hands a
  privileged object to pages as it is through contextBridge (`ipcRenderer`, a method of it such as
  `ipcRenderer.on` passed as a reference or bound, `shell`, the `electron` module, a Node module
  object such as `fs` or `child_process` or one of its members, `process`, `require`), with `api`,
  `member`, `exposed`, the value as written (`evidence`), file and line. Every member of a Node
  module counts except a short list that only informs (`fs.stat*`, `fs.exists*`, `process.env`,
  …); `os` is not listed. Plain, esbuild-bundled and minified preloads give the same rows (also a
  bundler's default import, `e.default.ipcRenderer`, and a value under a key that is not read). A
  wrapper function, or a parameter, loop variable, `catch` binding or local of the same name, or a
  name written again after its declaration, is not the privileged object; a declaration or write
  of the same name in another function does not hide the real one.
- No exposure is dropped where the analysis cannot decide: when the resolver's budget runs out,
  two declarations in one scope leave the binding open, or there are more declarations or writes
  than are kept, the row is kept with `undecided: budget | scope | writes`, and the new limitation
  `bridge_exposures_undecided` lists it. An unreadable exposed value says "not established" through
  `context_bridge_members_unreadable`. Each declaration's scope is read once, so hostile inputs stay
  fast (198 nested blocks with 400 exposures: 0.6 s).
- New collection `navigationHandlers` and finding `electron.navigation`: `setWindowOpenHandler`,
  `will-navigate` and `will-frame-navigate` registrations per window (or `app` for
  `web-contents-created`), with `returns: deny | allow` only where the returned `action` is a
  literal and nothing next to it can replace it (a spread, a computed key, an accessor or method,
  a path that ends without a return make it `unknown`). `win.webContents` through a parameter, and
  `contents` of a function inside `web-contents-created`, read `targetKind: webContents`. Rows
  carry `window` (name, `app` or null). Absence reads "no … found in the files read". New
  limitation code `navigation_handlers_truncated`.
- Both collections compare (identity without lines, lines as positions, the written evidence and a
  minified receiver's name not a change of their own) and come after `windows` in release reports
  and the compare view.
  Stored scans are read again. Rules and sources:
  docs/electron-findings.md.

### Compare and reports

- Imported modules (`externals`) are matched by specifier: a changed import count is one changed
  row, not one removal and one addition (Electron Fiddle 0.38.0 → 0.39.0 on 0.9.0: 10 false
  removals, now none).
- When both builds have the same file name (two `app.asar`), the reproduce line uses
  `<before>`/`<after>` and a note names both sha256 prefixes; reports still hold no directories.
- Control characters in a name from the target (a heading, a table cell, the note) are shown as
  `\u{…}` in Markdown reports, so an escape sequence does not reach a terminal.

### Interface map

- A row with more than 20 ends links to the target's ipc list for that channel, where every end
  is listed ("1 of 30 ends shown; all of them are in the ipc list").

### CLI

- The MCP SDK is loaded only for `hexvero mcp`. Warm `compare`, `compare --report` and `check`
  are 20–29 % faster (interleaved runs, 9 each, Claude.app vs Discord; docs/benchmarks.md);
  outputs are byte-identical.

## [0.9.0] - 2026-10-17

### Electron analysis

- IPC wrapper classes and objects: a method that passes one of its parameters on, whole, as the
  channel of `ipcMain.handle/on/once/handleOnce` or `ipcRenderer.invoke/send/…`
  (`handle(channel, fn) { ipcMain.handle(channel, fn) }`) is a wrapper, and each call of it on an
  instance is an IPC row at the call, `via: "wrapper"`, with the new field `wrapper`
  (`IpcMainManager.handle`); interface ends carry it too and their link is `resolved`. Instances
  are read through `new`, names and property keys bound once, `this`, chains of methods that
  return `this`, parameters whose call sites pass one, and across modules (`require`/`import`,
  re-exports, webpack `i(id)` and esbuild module wrappers). A method that changes or builds the
  channel is no wrapper. Electron Fiddle 0.39.0: 45 of 46 `ElectronFiddle` members are linked to
  a main-process end (was 0); see the case study.
- webpack 5 module functions written as methods (`{ 76675(e, n, i) { … } }`) and webpack's
  `i(id)` are read; TypeScript enums exported to CommonJS (`exports.E = E = {}`) and enums under
  a minifier's one-letter name (in the block that declares it, when the name means nothing else
  there) give channel names; `forEach((e => …))` callbacks in parentheses are read.
- The resolver no longer reads a parameter the function assigns to (`channel = "x:" + channel`)
  as what the call sites pass; it reads `var { K: name } = …` patterns inside functions.
- New limitation code `ipc_wrappers_capped` when the search for wrapper calls runs out of its
  budget. Short-named enums are checked in one pass per file under a budget (at most 256 per
  file), and the scope lookups behind the wrapper search are cached and charged to the
  resolver's budget, so hostile inputs stay linear (`completeness.test.ts`). The scope lookup behind it is block-aware: a `const`, `let` or `class` of an inner block (also at the top of the file) is visible only inside that block and shadows a parameter there; a `var`, a function declaration or a declarator list inside an inner block is not followed. Stored scans of the earlier format are read again (`JS_SCAN_SCHEMA` 7).

### Comparing releases

- `compare` covers whole lists (up to 200,000 items or 256 MiB serialized per side, said when
  not) instead of the first 2,000 items per side, and every comparison reports its
  `completeness` per list (compared, total, gaps).
- An item found on one side only is `unknown`, not `removed` or `added`, when the other build did
  not read its file or has a value of the same kind there that could not be resolved (an IPC
  call without a readable channel, a computed window setting, a URL with `${…}`), with that
  reason.
- Release comparisons are paged (`--report <file> --offset n --limit n`, `/api/compare`), rows
  carry stable ids, and changed rows carry the place in the before build (`whereBefore`), so a
  change is shown with the file and line on both sides.
- `--report report.html` (or `.htm`): one self-contained, offline page with the summary, the
  window settings to review, each change with the source lines of both builds, what was not
  established and the command to reproduce it; filters run in one inline script allowed by a
  strict CSP, all target text is escaped and bidi or invisible characters are written out.
- Less noise: an interface row whose only difference is its `reason` text is unchanged, and
  findings are matched by kind and location, so a reworded title is not an added and a removed
  finding (both seen on Electron Fiddle 0.38.0 → 0.39.0).

### Web UI

- Compare view as a reviewer workspace: a summary bar of facts, filters for change kind, list and
  basis kept in the URL, an evidence panel with the lines of the build before and after side by
  side, "N of M shown" with Load more, keyboard navigation. The session token moves from the
  address bar to storage on load.
- Interface map tab for JavaScript apps: window → preload member → channel → main-process
  handler, each edge saying whether it was read as a literal, resolved, or not read (with the
  reason); every node opens its file and line.

### Reading Electron apps and files

- Entries an ASAR marks as unpacked are read from `<archive>.unpacked/` next to the archive,
  confined like a directory target; when that directory is missing, the limitation says so
  instead of "too large or could not be decoded". The scan cache key covers those files.
- Target files are read through one descriptor that refuses anything but a regular file
  (`O_NONBLOCK`, `O_NOFOLLOW`, same-inode check after open), so a FIFO cannot block an analysis
  and a link swapped in after the check cannot lead out of the root.

### MCP

- `hexvero_check` (16th tool, read-only): the release policy check over MCP with an inline
  `policy` or a `policyPath`, an optional read-only `baselinePath`, JSON/Markdown/SARIF output,
  findings paged under a 256 KiB result budget. Baselines are written only by the CLI.
- **Breaking:** `hexvero_compare` pages one list at a time: pass `list` (`added`, `removed`,
  `changed`, `unknown`) with `offset`; `offset` without `list` is refused with `invalid_input`.
  One offset applied to four lists of different lengths returned wrong pages before.
- Catalog: 16 tools, `tools/list` 15,637 bytes (was 14,156 with 15 tools).

### Release policies

- Review fixes: `window-more-permissive` also judges new and renamed windows by their own
  settings (a removed window with the same setting makes it unknown); hosts and members the
  before build already had (another file, another path) are not new; a target that is not a
  JavaScript application, or two of different kinds, is refused with exit 1 instead of passing;
  SARIF paths start with `hexvero-build/<side>/<archive>/` so they cannot land on repository
  files; URL values lose control characters as in WHATWG URL before their host is read;
  unknown findings get their own fingerprints; a baseline written for another policy or before
  build is reported; a check compares the builds once however many pages it reads.

- `hexvero check <before> <after> --policy <file>` applies a JSON release policy to the
  comparison of two builds: `new-interface-member` (a member pages can call that is new),
  `new-external-host` (a new host outside the `allow` list; exact names and `*.domain`), and
  `window-more-permissive`. Exit codes: `0` pass, `1` technical error, `2` usage error or invalid
  policy, `3` policy violated, `4` not decidable under `unknown: fail`.
- Policies are data only, validated with a message per problem and described by
  `docs/policy.schema.json` (JSON Schema 2020-12). Unknowns (a host computed at run time, an
  unresolved IPC channel, a file not read) are never a pass: `unknown: fail` makes the check
  incomplete, `warn` and `allow` let it pass and keep them listed.
- Findings carry fingerprints made from what they are about (member, host, window setting), not
  lines, so `--baseline file --update-baseline` accepts the current findings once and later runs
  only fail on new ones. Suppressions take a reason and an optional `expires` date; an expired
  one counts as new again.
- Output as text, JSON, Markdown or SARIF 2.1.0 from the same result; `--out` never replaces a
  file without `--force`. SARIF locations are paths inside the analyzed build
  (`uriBaseId: HEXVERO_TARGET_B`), never mapped onto repository files.
- `hexvero demo` also copies the example policy (`policy.json`) and prints the `check` command;
  `docs/ci.md` and `.github/workflows/check-example.yml` show the check in GitHub Actions with
  an optional, least-privilege code-scanning upload.

### JavaScript analysis

- IPC channel names built by a channel-registry function are read:
  `const BOARD = defineChannels("board", ["list", "moveCard"])` with a body that loops over the
  list and writes `` `${prefix}:${kebab(name)}` `` into a fresh object, also with `forEach`,
  `map` and `Object.fromEntries`, across CommonJS and ES modules, in esbuild bundles (also
  minified) and in functions of a webpack-style bundle. Such rows say
  `via: "resolved", resolution.method: "evaluated"`. Function bodies are read by a small,
  explicitly listed abstract evaluation (resolve.ts); nothing of the analyzed code is run.
  Where it stops (a statement outside the subset, too many values, a depth or work limit, a
  cycle, a value known only at run time) the call keeps no channel, carries a `reason`, and
  `ipc_channel_unresolved` names it, also for a channel named through another module's table
  that the module could not read (before, those were dropped from the limitation silently).
  A registry function imported from a third module (unbundled) is not followed yet; such calls
  are named with that reason. The evaluation is bounded on hostile input: regular expressions
  with at most one quantified atom, strings of at most 1,000 characters, at most 64 nested
  blocks, and an exception inside it ends that question with a reason, not the analysis.
  It also stops, rather than guess, when an expression it cannot read may have effects (a call,
  an assignment, `delete`), at `var` inside a block, at `async` functions and generators, at
  integer-like and `__proto__` keys, and when a built table is aliased, `delete`d or passed to
  code that may change it; keys keep the order JavaScript gives them, and a block's `const` no
  longer reaches past its block.
- String and template literals decode `\x41`, `\u0041`, `\u{41}`, `\0`, octal escapes and line
  continuations as JavaScript does (before, `"a\x41"` was read as `ax41`).
- Interface rows (C4) compute `direction` and `link` from every matching end and say how many
  there are: `endsTotal`, `endsTruncated`; `ends` keeps the first 20 as evidence.
- Hold-out results improved with no new false report: window settings read through bundled
  modules (holdout2, holdout4) and bridge member channels named by a bundled module's table
  (holdout2).

## [0.8.0] - 2026-10-16

### Compare releases

- `hexvero demo [dir]` copies two builds of the example Electron app (now shipped in the npm
  package, 12 KB) into `./hexvero-demo` and shows what changed: each change with the file and line
  it was read from on its side, how it was read (`literal`, `inferred`, `link direct`), the window
  settings to review, and what was not established. A file of the same name with other content
  is never replaced.
- `hexvero compare <a> <b> --report report.md` writes the comparison as Markdown: summary,
  changes with places, a section for what could not be established, and the command to
  reproduce it. Deterministic (no dates, no directories); text from the targets is quoted so it
  cannot add links, HTML or a shell command of its own. Refuses to overwrite without `--force`.
- `hexvero compare <a> <b> --report report.html` (or `.htm`) writes the same comparison as one
  self-contained, offline HTML page: summary, window settings to review, changes per list with
  sign and word, before/after places with the seven source lines around each (at most 200
  excerpts and 250,000 characters, said when cut), completeness gaps, "Not established", "N of M
  rows shown" and the reproduce command. Filters by kind, list and text run in one inline script
  allowed by its sha256 in a strict Content-Security-Policy (`default-src 'none'`); the page reads
  the same with JavaScript off, loads nothing and links nothing from target text. Target text is
  escaped, and bidi, zero-width and control characters show as `⟨U+202E⟩`. Other extensions
  still write Markdown; `--force`, `--offset` and `--limit` apply to both.
- A list one build does not have at all (the first endpoint, the first storage key) is now
  reported row by row as added or removed, or as unknown when the other build was read only in
  part. Before, the comparison only said "only in b: endpoints".
- Web UI: a **Compare** view for two open builds, with links from every change and every
  finding location of a JavaScript app to the source lines around it (`/api/targets/:id/source`,
  only files the analysis read, only inside the target), a filter, the counts of every list and a
  report download. The start screen leads with the example builds; `hexvero ui --demo` starts
  on their comparison. No horizontal scrolling at phone width.
- Example 1.5.0 registers IPC channels whose names come from an environment variable, so the
  demo also shows an honest unknown (`ipc_channel_unresolved` at `main.js:33`).

### Website and docs

- New landing page and a static example report generated from a real run
  (`scripts/build-site-demo.mjs`, checked by `release:check`). Site URLs point at GitHub Pages;
  `hexvero.dev` does not serve this site.
- README leads with the comparison, the verified `npx hexvero demo` start, three questions and
  the most important limits; the limits now quote the newest blind set (holdout4).

## [0.7.5] - 2026-10-15

### Accuracy

- Window bases another module exports (`import windowConfig from "./config/windows.js"` and
  `webPreferences: Object.assign({ preload }, windowConfig.secureDefaults)` or
  `...windowConfig.main`) are evaluated across modules and applied where they stand, so the
  later of two writes in the same object wins. A base used as a webPreferences argument holds the
  settings themselves; one spread into window options holds them under `webPreferences`. Where
  a whole window can already be evaluated, that evaluation is kept; a base that cannot be read
  whole still leaves the keys after its place unknown. ES default imports of a module count as
  that module (`import x from` reads like `require`). holdout window settings 24/33 → 27/33,
  holdout2 46/63 → 48/63, both with 0 false; holdout changes in webPreferences 1/2 → 2/2.
- `compare` treats `definedIn.line` (where in another module a window's setting was read) as a
  position: a base module whose lines shift no longer changes the window's settings.
- No real application changed.

## [0.7.4] - 2026-10-15

### Accuracy

- A new blind set, `corpus/holdout4` (a kanban app; written by an independent agent, scored
  once with the analysis of 0.7.3 before any change), found window settings 36/48 with 4 false,
  IPC channels 12/57 and bridge channels 21/66; everything is in its README.
- Windows built by a factory of another module (`new BrowserWindow(makeWindow({ … }))`) are
  evaluated through rest elements in destructured parameters (`{ preload, ...more }`) and `??`,
  so each window gets the factory's defaults with its own overrides. The factory's defaults are
  no longer also reported as a row without a window. holdout4 window settings 36/48 (4 false)
  → 44/48 (0 false); 16/16 on the plain build. The channels built by `defineChannels(…)` (a
  loop with a regular-expression callback) are still not read. No real app changed.
- `new URL(\`boards/${id}\`, BASE)`is read as`https://…/boards/${…}`when the gap lies in the
  path; a gap before the first`/` (it may be a whole address) leaves the request unknown.
  holdout4 endpoints 12/21 → 15/21, requests shown as unknown although their address is known
  5 → 2. No real app changed.

### Fixed

- `compare … ipc` on two single JavaScript files (rows without `module`) matches calls by
  `api+channel` with the line as a position, so a call that only moved is relocated, not removed
  and added.

## [0.7.3] - 2026-10-15

### Accuracy

- Window settings written as `webPreferences: Object.assign({}, BASE, { … })` are read: the
  arguments are laid over each other from left to right, and the later of two writes of a key
  wins, as in JavaScript. Bases declared as `const BASE = Object.freeze({ … })` are followed
  (also when spread or returned by a helper), and passing such a base to `Object.assign` as a
  source no longer counts as a change to it. holdout3 window settings 9/14 → 11/14 on all three
  builds, 0 false. Claude desktop: 15 settings of two `WebContentsView`s now read from the frozen
  base they are built from (`sandbox`, `contextIsolation`, `nodeIntegration`, …); no other real
  app changed.
- Corpus scorer: window settings are scored for every key a case lists, not only the four every
  case lists. holdout3 also lists `webSecurity`, which hexvero reported and the scorer counted
  as missed. holdout3 window settings are 14/14 on all three builds; its blind result, rescored
  from the recorded observations, is 11/14 (README).

## [0.7.2] - 2026-10-15

### Fixed

- False contextBridge members: an exposed value passed by name was followed to any object
  declared under that name in the file. In minified code the name can be a loop variable
  (`for (const [t, n] of Object.entries(u)) exposeInMainWorld(t, n)`) or a short name reused
  in every function. Claude desktop showed 28 such members (Sentry fields such as `__SENTRY__`
  and `sentry_key` under `[t]`). A name bound by the loop or function around the call, or declared
  more than once in the file, is no longer followed; the row says the members could not be read.
  No corpus row and no other real app changed.
- A stored scan is named after the hexvero version too. Since 0.7.0 stores the whole scan of a
  large app, an upgrade would otherwise have kept showing results read by the old version until
  `--fresh`.

## [0.7.1] - 2026-10-15

### Accuracy

- A new blind set, `corpus/holdout3` (a podcast app with two preloads in two windows, written
  by an independent agent without access to hexvero's code or output), was scored once with
  0.7.0 before any change: IPC channels 16/23, senders and receivers 24/33, window settings 9/14,
  bridge members **0/26**, endpoints 4/7 with 2 false, storage 9/9; all of it is in
  `corpus/holdout3/README.md`. The fixes below came from it, so holdout3 is now a development
  set: channels 23/23, senders and receivers 46/47, bridge members 26/26 with every channel,
  endpoints 6/7 with 0 false, v1 → v2 changes 8/8. 23 of 26 interface rows link to the exact
  file and line, 1 is `unknown` (a sender passed in as a parameter), 2 that had one of two ends
  now have both; no false end.
- contextBridge values built as `Object.freeze({…})`, `Object.seal`, `Object.preventExtensions`
  or `Object.assign(a, b, …)` of objects of the same file, and a trailing comma after the value.
- Channel constants as static string fields of a class (`class Library { static LIST = "…" }`).
- `module.exports = { ...channels }` and `{ ...require("./x") }` pass every export of that
  module on, like `export * from`.
- Handlers registered in a loop over a list of pairs or a `Map`
  (`for (const [ch, fn] of routes) ipcMain.handle(ch, fn)`), also with channel names from
  another module.
- `event.reply(CONSTANT, …)` and `event.sender.send(…)` with a constant or another module's
  constant. Holdout time-tracker: one more sender found (`sync:progress`).
- Bundled and minified builds (esbuild): a class expression with static fields
  (`var Library2 = class { static LIST = "…" }`), tables and strings a `__commonJS` wrapper exports
  by name, spreads of other wrappers' exports, `var { Library } = require_channels()`, and the
  minified forms of both inside declaration lists. The corpus now bundles every preload, so
  holdout3 is scored on all three builds: each scores the same (channels 23/23, senders and
  receivers 46/47, bridge members and their channels 26/26, endpoints 6/7, 0 false).
- Real applications (Claude, Discord, Discord core, two Electron Fiddle builds, Electron API
  Demos) are unchanged.

## [0.7.0] - 2026-10-15

### Performance

- A JavaScript application with 1 MiB of JavaScript or more is stored even when one run read it
  whole, so the next `analyze`, `collection`, `compare` or `export` of the same archive reuses the
  scan. Claude desktop's 47 MiB `app.asar`: 10.2 s and 776 MB cold, 0.3–1.0 s warm. Cold and
  warm exports of six real Electron apps are byte-identical apart from timing fields and
  `coverage.resumed`. `--fresh`
  reads everything again; smaller apps still touch no disk.

### Documentation

- Two walkthroughs on the NotesDesk example: [Electron interface map](docs/use-cases/electron-interface-map.md)
  and [what changed between two builds](docs/use-cases/release-interface-diff.md), with the JSON
  a CI job can read. [Positioning](docs/strategy/positioning.md) and
  [differentiation](docs/strategy/differentiation.md) say what hexvero is for, next to REA and
  Electronegativity, and which test backs each claim.
- New tagline in the README, package, registry entry, plugin and website: evidence-first
  software intelligence. Inspect artifacts, trace interfaces, compare builds.

### Added

- `interfaces` collection for Electron apps: one row per contextBridge member, joined to the
  windows that load its preload and to the main-process ends of its channel (`ipcMain.handle`,
  `webContents.send`, … with file and line). `link` says how the join holds: `direct`,
  `resolved` (through a constant, alias or wrapper), `unresolved` (the member's channel is not
  readable), `unknown` (no end found, while the analysis has blind spots it names) or `none` (no
  end in an analysis that read everything). Rows are joined on exact names only. On the corpus's
  15 Electron inputs (all development sets) it makes no false link; every member whose channel
  and handler are both read is linked to the right file. `compare` matches rows by
  `file+api+member` and treats lines, including the lines of the ends, as positions. Text tables
  show lists of places as `main.js:40 handle`.
- The `compare` overview (CLI and MCP) lists window settings whose derived value changed what a
  page may do: `nodeIntegrationInEffect`, `contextIsolationInEffect`, `sandboxInEffect` and
  `pageRequire`, each marked more permissive, less permissive or unclear (`windowChanges`). They
  are facts to review, not findings. The `details:` hint now points at `interfaces`,
  `contextBridge`, `ipcChannels` or `windows` before other collections.

- Exports state which analyzer produced them and whether they are whole: `generator`
  (`@hexvero/core` and its version), `complete` (false when the analysis recorded any limitation),
  `incomplete` (the limitation codes) and `volatile` (the fields that differ between two exports
  of the same input; a test checks that everything else is byte-identical). The format stays
  `hexvero: 1`; the fields are additions. `docs/cli.md` describes found, not found, not analyzed
  and unresolved, and what `compare` promises for each.

### Fixed

- A scan continued over several runs dropped `ipc_open_calls_capped` when the cap was met in an
  earlier run, so the result looked more complete than it was. The flag is now stored with the
  scan (scan schema 6; stored scans of older versions are read again from the start).
- `compare … ipc` no longer reports a call that only moved as removed and added: the identity is
  `module+api+channel` and the line is a position. NotesDesk-style v1 → v2 (corpus `notes-app`):
  14 added and 14 removed before, 2 and 2 now (the renamed channel), 12 relocated.

- A single JavaScript file whose IPC call passes a computed channel now reports
  `ipc_channel_unresolved`, as an application directory already did. Before, the row had
  `channel: null` and the analysis claimed no limitation.

- `compare` no longer reports false additions and removals for collections longer than 2,000
  items. Each side is compared up to 2,000 items; an item found on one side only while the other
  side was cut there is now `unknown` ("the other side was compared only in part"), not added or
  removed. Two captures with the same 2,500 requests in opposite order used to show 500 removed
  and 500 added; they now show 0 of each and 1,000 unknown. CLI, MCP and the `compare --all`
  overview share one implementation (`Session.compareCollection`).

## [0.6.2] - 2026-10-14

### Accuracy

- Defaults in destructured parameters (`function prefs({ sandbox = true, nodeIntegration = false } = {})`)
  apply when a caller leaves the key out. Holdout (development set): window settings 21 → 24 of
  33, changes in webPreferences 0 → 1 of 2 with the one false report gone; real applications
  unchanged. Where a window's options are spread from several places, the window reader can still
  miss such a default.

### Release process

- The publish step waits up to ten minutes for the registry to serve a new version (it waited
  two, and npm's delay failed three publish attempts in two of the last six releases), and a publish npm
  refuses because the same version is still being processed counts as done once the registry
  shows the identical tarball.

## [0.6.1] - 2026-10-14

### Accuracy

- esbuild's ES-module interop in CommonJS bundles is read: names declared bare at the top and
  set once inside an `__esm` wrapper are constants, and names destructured from
  `__toCommonJS(namespace)` mean what `__export(namespace, { … })` hands out (strings, tables,
  enums). An object key or an arrow's returned name (`{ Push: () => Push }`) no longer makes an
  enum ambiguous. Holdout (development set): bridge member channels 32 → 40 of 60, IPC senders
  and receivers 97 → 104, no false reports; real applications unchanged.

- IPC channel names from a shared IPC module are followed through more of its forms: string
  enums exported as tsc writes them (`export var Push;` and its definition), exports that alias a
  key of an imported table (`export const ConfigSync = Channel.ConfigGetSync`), and templates
  around one constant (`` `${TIMER_PREFIX}tick` ``), also when that constant is another module's.
  A bridge member that subscribes and unsubscribes on the same channel counts it once. Corpus,
  holdout (a development set): IPC channels 60 → 64 of 72, bridge member channels 28 → 32 of
  60, no false reports; the real applications checked report the same results.

## [0.6.0] - 2026-10-14

### Added

- `hexvero recover` splits scope-hoisted bundles (esbuild `format: "esm"` or `"iife"`) at the
  `// src/path.js` comments the bundler writes before each module; the files keep the code as
  written and say that names are shared between sections. Rollup and Vite chunks keep no module
  boundaries: instead of guessing, the analysis lists the chunk files they import (`chunks`) with
  the limitation `bundle_chunk_only` (#82).

### Fixed

- Native findings say where they were read (#80): notable imports name the first matching import
  as the table shows it (`.dynsym: system`, `import table: KERNEL32.dll!CreateProcessW`,
  `symbol table: _system (undefined)`), and the hardening line names the headers it comes from.

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
