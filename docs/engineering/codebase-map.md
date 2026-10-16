# hexvero codebase map

Base: commit `f0382dc` (branch `sprint/m-map`, packages 0.8.0), written 2026-10-17 by agent M. Every
`file:line` below was checked at that commit: in source files marked `read` by reading them, in
test files marked `inventoried` by locating the test title with `grep -n`. Reading status per file is in the
[inventory](#file-inventory): `read` means the whole file was read for this map, `inventoried`
means it is listed with a role taken from its path, exports or header comment only. Nothing in
this document is a measurement; it is a reading of the code.

Related: [contracts.md](contracts.md) (sprint contracts C1–C7, frozen 2026-10-17; not yet in the
code at this commit, see [open questions](#open-questions)), [sprint-status.md](sprint-status.md),
[../../CONTRIBUTING.md](../../CONTRIBUTING.md).

## Architecture on one page

hexvero reads files statically and never executes the target. One TypeScript core, three thin
surfaces, one React UI:

```
                   ┌──────────────── @hexvero/core (zero runtime deps) ────────────────┐
 CLI  hexvero ───┐ │ target.ts  loadTarget: stat, sha256, detectFormat, 512 MiB cap     │
 (packages/cli)  │ │ session.ts Session: content ids, shared/cancellable analyze,       │
                 ├─┤            continueAnalysis, collectionsOf, compare*, source,      │
 MCP  stdio ─────┤ │            strings, bytes, export                                  │
 (packages/mcp)  │ │ analyzers/dispatch.ts  format switch ─┬─ formats/*  (ELF, PE, …)  │
                 │ │ analyzers/worker.ts    worker thread  ├─ analyzers/binary.ts       │
 HTTP loopback ──┘ │                                       └─ javascript/app.ts (ASAR,  │
 (packages/server)  │  scanState.ts + cache.ts  stored scans    directories): scan.ts,  │
   ▲                │  tokenPool.ts + tokenWorker.ts            aliases, resolve,       │
   │ /api + static  │                                           ambient, candidates,    │
 React UI           │ compare.ts compareItems   report.ts compareReleases +             │
 (packages/web,     │ paging.ts pageOf          renderReleaseReport   source.ts         │
  built into        │ compact.ts next.ts unknowns.ts  providers/* (radare2/rizin/ghidra)│
  packages/cli/ui)  └───────────────────────────────────────────────────────────────────┘
```

- **One shared object.** `Session` (`packages/core/src/session.ts:146`) holds opened targets by a
  content-derived id (`t_<sha256[0..12]>`, directories `d_<hash of path>`, `session.ts:176-180`),
  runs each analysis once, and flattens it into named lists (`collectionsOf`, `session.ts:676`).
  CLI, MCP and HTTP only translate arguments and render results.
- **Model.** Every analyzer returns `Analysis<T>` with `findings` (`confidence: "confirmed" |
  "inferred"`), `limitations` (stable `code` + message) and format data (`model.ts:6-38`). Errors are
  `AnalysisError` with one of seven codes (`model.ts:80-96`).
- **Electron/JavaScript.** `analyzeJavaScriptTree` (`javascript/app.ts:2015`) reads files in a fixed
  order (entry, depth, path; `app.ts:1602`), per file a token-level scan (`readFileTokens`,
  `app.ts:1746` → `scanJavaScript`, `scan.ts:447`), then cross-file resolution (constants, globals),
  channel matching (`app.ts:2828`), window effects (`windowEffects`, `app.ts:220`), and findings.
  Large apps are read in batches; state is stored on disk and continued (`analyzers/dispatch.ts:86`).
- **Isolation.** MCP and UI sessions run analyses in a worker thread with a time and heap limit
  (`cli/src/index.ts:759`, `:776`; `analyzers/worker.ts:34`). The CLI analyzes in-process
  (`cli/src/index.ts:165`), where no timeout applies (documented at `session.ts:155-160`).
- **Bounded output.** Every list leaves through `pageOf` (`paging.ts:57`): a byte budget, an item
  cap of 2,000, `next` that always advances, oversized items reduced and flagged.
- **Comparison.** `compareItems` (`compare.ts:416`) matches by a detected identity, separates
  `relocated` (positions only) from `changed`, and calls one-sided items `unknown` when the other
  side did not read that file or was cut. `compareReleases` (`report.ts:119`) turns that into rows
  with places; `renderReleaseReport` (`report.ts:253`) into deterministic Markdown.
- **Build and release.** `tsc -b` for core/mcp/server/cli, Vite for web into `packages/cli/ui`
  (`packages/web/vite.config.ts:7`). Four npm packages are published (`hexvero`, `@hexvero/core`,
  `@hexvero/mcp`, `@hexvero/server`); `@hexvero/web` is private and ships inside the CLI.
  `scripts/release.mjs` bumps and tags; the tag starts `.github/workflows/release.yml`.

Commands (from `package.json:12-28`): `npm run build`, `npm run typecheck`, `npm run lint`,
`npm run format:check`, `npm test` (vitest), `npm run check` (all of these plus
`scripts/check-shape.mjs`), `npm run e2e` (build, examples, `vitest.e2e.config.ts`),
`npm run corpus` (build, `corpus/build.mjs --check`, `corpus/gate.mjs`), `npm run release:check`,
`npm run release -- x.y.z`, `npm run site:demo`. Node >= 22.12 (`package.json:40-42`).

Owner roles used below: Lead; A analyzer (`core/src/javascript`); B compare (`compare`, `session`,
`report`, `source`, `paging`, `compact`, `next`, `unknowns`); C web + server; D cli + mcp; E quality
(tests, e2e, corpus, scripts, examples); F launch (site, docs, launch, READMEs). An owner with `*`
is assigned by area because the brief names no owner for that path.

## Six end-to-end paths

### Path 1: `hexvero analyze app.asar` to an IPC finding

**Input.** `hexvero analyze <path> [--json] [--continue|--all|--include p,q] [--batch n] [--fresh]`.

**Call chain.**

1. `packages/cli/bin/hexvero.js:7-22` imports `dist/index.js`, calls `main(argv)`, exits after
   stdout drains; an unhandled rejection exits 70.
2. `main` (`packages/cli/src/index.ts:84`) → `parseArgs` (`cli/src/args.ts:8`) → `run`
   (`index.ts:164`), which creates `new Session()` without a worker (`index.ts:165`).
3. `case "analyze"` (`index.ts:194`): `session.open` (`session.ts:171`) → `loadTarget`
   (`target.ts:22`): stat, refuse non-regular files (`target.ts:37-40`), above 512 MiB only ASAR is
   accepted, lazily, with a streamed SHA-256 (`target.ts:48-66`); otherwise read whole and
   `detectFormat` (`formats/detect.ts:25`; ASAR by `.asar` or a `{"files"` header at byte 16,
   `detect.ts:40,76-79`). `register` derives the id (`session.ts:176-180`).
4. Without scan flags `session.analyze` (`session.ts:217`), else `continueAnalysis`
   (`session.ts:300`); both end in `analyzeTarget` (`analyzers/dispatch.ts:167`), which maps
   `RangeError`/`TypeError` to `malformed` (`dispatch.ts:174-179`).
5. `case "asar"` (`dispatch.ts:292`) → `scanApplication` (`dispatch.ts:86`) over
   `asarTreeFromFile` (lazy) or `asarTree` (`dispatch.ts:296`; `app.ts:1549-1568`) on
   `openAsar`/`openAsarFile` (`formats/asar.ts:35,57`; JSON index capped at 256 MiB,
   `asar.ts:113`).
6. `analyzeJavaScriptTree` (`app.ts:2015`): per file in `scanOrder` (`app.ts:1602`)
   `readFileTokens` (`app.ts:1746`, or a token-pool result, `app.ts:2174`) → `scanJavaScript`
   (`scan.ts:447`) → `tokenize` (`scan.ts:286`). An IPC row is pushed where
   `<owner>.<method>(` matches `IPC_APIS` (`scan.ts:229-242`, `696-751`), owner through aliases;
   unresolved channel arguments go to the bounded `ExpressionResolver` (`scan.ts:773-797`, first 200).
7. After all files: channel constants of other modules (`app.ts:2742-2757`), IPC through globals
   (`resolveAmbient`, `app.ts:2760`), the `ipc_channel_unresolved` limitation for calls without a
   channel (`app.ts:2802-2811`), channel matching into `ipcChannels` (`app.ts:2828-2847`; receivers
   are `.on|once|handle|handleOnce`, `app.ts:2836`).
8. Finding `electron.ipc` (`app.ts:3065-3082`): `confidence` is `confirmed` unless an IPC call could
   not be traced or had no readable channel (`app.ts:3079`); `location` is the first handler
   registration (`app.ts:3067-3069`). A partial scan rewrites the title to "in the scanned part" and
   downgrades to `inferred` (`app.ts:3169-3178`).
9. Back in the CLI: `collections` (`session.ts:355`), `suggestNextSteps` (`next.ts:26`), output
   as text or `--json` with `complete`/`coverage` (`index.ts:213-288`).

**Data model.** `IpcUsage {api, channel|null, line, via?, resolution?, channelRef?}`
(`scan.ts:19-40`); `JsModule` (`app.ts:34`); `JsAppInfo.ipcChannels {channel, senders[],
receivers[]}` (`app.ts:1255-1259`); collections `ipcChannels`, `ipc` (one row per call with
`module`), `contextBridge`, `interfaces`, `windows`, `webPreferences` (`session.ts:878-895`).
`Finding.location` is `file:line`.

**Completeness limits.** 5,000 files and 256 MiB per run, 16 MiB per file (`app.ts:2035-2037`);
2,000,000 tokens per file (`scan.ts:288`, limitation `scan_truncated`); 200 resolver calls per file
(`scan.ts:775`); caps on settings (`app.ts:59-60`), bridge members (`app.ts:839-840`), candidates
(`app.ts:1391`). `node_modules/` is never scanned for JavaScript (`app.ts:1598-1599`). Every cap
becomes a limitation code (`app.ts:2671-2706`, `2789-2817`).

**Errors.** `AnalysisError` → exit 1, with `--json` an `{error:{code,message,details}}` object on
stdout (`index.ts:123-145`); `UsageError` → exit 2 with the command's help lines (`index.ts:103-122`);
`EADDRINUSE` → exit 1 (`index.ts:147-150`); anything else exit 1, stack with `HEXVERO_DEBUG=1`.

**Tests.** `e2e/flows.test.ts:62` (every finding's `location` line contains the evidence),
`:119` (renderer ↔ preload ↔ main through IPC); `packages/cli/test/cli.test.ts:158`, `:172`,
`:269`; `packages/core/test/javascript.test.ts`, `idioms.test.ts`, `ambient.test.ts`,
`resolve.test.ts`, `completeness.test.ts:46` (inventoried, titles only).

### Path 2: two releases → `compareReleases` → source window → Markdown report

**Input.** `hexvero compare <a> <b> --report file.md [--force]` (`cli/src/index.ts:378-401`), or
`GET /api/compare?a&b` and `/api/compare/report` (`server/src/index.ts:228-243`), or
`scripts/build-site-demo.mjs`.

**Call chain.**

1. `compareReleases(session, a, b, {maxRows})` (`core/src/report.ts:119`; default 200 rows per
   collection, the server passes 500, `server/src/index.ts:232`).
2. `session.compareAll` (`session.ts:395`): for every collection both sides have,
   `compareCollection` (`session.ts:367`) pages each side to 2,000 items / 64 MiB
   (`session.ts:374-375`) and calls `compareItems` (`compare.ts:416`) with `positionalFields`
   (`compare.ts:162`), per-side `coverage` (`session.ts:333`) and `cut` flags. Window settings
   that changed are classified more/less permissive (`session.ts:416-440`, table `session.ts:89-94`).
3. Collections with differences, minus `SUMMARY_ONLY` (`report.ts:60`), ordered by `ORDER`
   (`report.ts:46-55`), are compared again row by row (`report.ts:141-177`); `placesOf`
   (`report.ts:71`) yields `Place {side, file, line?, role?}` from `file`/`line`, `location`,
   interface `ends` (`role: "handler"`), or the `ipc` calls of a channel (`receiver`/`sender`).
   Lists that only one side has are all added/removed, or `unknown` when the other side is partial
   (`report.ts:180-206`).
4. `renderReleaseReport` (`report.ts:253`): header table with sha256, summary counts, window
   changes, rows with places, "Not established" (unknowns, partial scans, 20 limitations per side),
   "Reproduce" (`report.ts:253-361`). Target text is quoted by `code`, `cell`, `shellWord`
   (`report.ts:222-236`). No dates and only base names, so the bytes are deterministic.
5. CLI writes with flag `wx` unless `--force` (`index.ts:387-393`).
6. **Source window.** The Markdown report contains `file:line` only. The lines themselves come
   from `Session.source` (`session.ts:454`) → `sourceWindow` (`core/src/source.ts:32`), used by
   `GET /api/targets/:id/source` (`server/src/index.ts:320-326`, path 4) and by
   `scripts/build-site-demo.mjs:31-39` (three lines of context per place for `site/demo/`).

**Data model.** `CompareResult` (`compare.ts:75-106`: `key`, `added[]`, `removed[]`,
`unknown: UnknownItem[]`, `changed: ChangedItem[]`, `relocated`, `unchanged`, `duplicateKeys`,
`matchedByPosition`, `compared`); `CollectionComparison` with `partial` (`session.ts:41-56`);
`ChangeRow {collection, change, key, where: Place[], basis?, fields?, reason?}` and
`ReleaseComparison {hexvero, a, b, overview, changes, cut, limitations}` (`report.ts:16-43`);
`SourceWindow {file, line, start, lines, totalLines, cut}` (`source.ts:8-19`).

**Completeness limits.** 2,000 items per side and collection (`session.ts:374`; text "only the first
2,000 items" at `cli/src/index.ts:444` and `report.ts:338`); `maxRows` per collection with `cut`
(`report.ts:175`); `changed` rows carry the b-side place only (`report.ts:172`); source windows
only for files the analysis read, at most 8 MiB, lines cut at 400 characters, context at most 60
(`source.ts:22-24,39-45`).

**Errors.** Existing report file → `UsageError` (`index.ts:390-391`); `--report` with a
collection name → `UsageError` (`index.ts:383-384`); `sourceWindow`: `not_found` for unread
files, `invalid_input` for a bad line or a path that leaves a directory target, `too_large`
(`source.ts:39-45,60-86`).

**Tests.** `packages/core/test/report.test.ts:51` (places per side), `:82` (limitations kept,
deterministic bytes), `:96` (quoting), `:139`, `:153` (source window refuses unread files and
links out); `compare.test.ts` (`:96`, `:420`); `session.test.ts:191`, `:249`; `cli.test.ts:43`;
`server/test/server.test.ts:132`; `scripts/smoke-tarballs.mjs:153-166`.

### Path 3: MCP tool call → paginated answer → error handling

**Input.** `hexvero mcp` over stdio, e.g. `hexvero_collection {targetId, collection, offset?,
limit?, text?, maxBytes?}`.

**Call chain.**

1. `cli/src/index.ts:758-761` → `serveStdio(new Session({ worker: true }))`
   (`mcp/src/index.ts:241`); SIGINT/SIGTERM kill engines first (`index.ts:244-249`).
2. `createHexveroServer` (`mcp/src/index.ts:155`) registers each of the 15 `toolSchemas`
   (`mcp/src/tools.ts:38-251`) with zod input schemas and `TOOL_ANNOTATIONS` (`index.ts:52-146`).
3. The registered callback (`index.ts:178-208`) runs `handlers[name](args, extra.signal)`;
   `hexvero_collection` (`tools.ts:339-346`) → `session.collection` (`session.ts:465`) →
   `pageOf` (`core/src/paging.ts:57`); a partly read app adds `partial` to the page
   (`tools.ts:344-345`).
4. `pageOf`: validates `maxBytes` (512 … 64 MiB, `paging.ts:63-68`; the MCP schema caps it at
   4 MiB, `tools.ts:27-35`), filters by `text`, clamps `limit` to 1 … 2,000 (`paging.ts:84`),
   reserves the widest envelope (`paging.ts:89-99`), adds items while they fit, reduces a first item
   that does not (`reduceItem`, `paging.ts:165`), sets `next` and the exact `bytes`
   (`paging.ts:127-147`).
5. The result is returned once as JSON text with `_meta["io.github.maximilianfeix.hexvero/untrustedContent"]
   = true` (`index.ts:181-186`).
6. Other paginated tools: `hexvero_strings` (same `pageOf`), `hexvero_compare` windows its lists
   with `offset`/`limit` and a `next` per list (`tools.ts:398-485`), `hexvero_unknowns list`.

**Errors.** `AnalysisError` → `isError: true` with `{error:{code,message,details}}`; anything else
code `internal` (`index.ts:187-206`). Arguments that fail the zod schema are refused before the
handler runs; the test sees the client call throw (`mcp/test/server.test.ts:263`). Writes go
through `checkWritePath` (`mcp/src/writePolicy.ts:44`): allowed roots, no hidden path, `.json`
for exports; `Session.export` with `onlyReplaceExports` replaces only earlier exports
(`session.ts:574-582`).

**Data model.** `CollectionPage {items, total, offset, truncated, collection, bytes, next,
itemTruncated?, itemBytes?}` (`paging.ts:39-49`), plus `partial {scanned,total,remaining,skipped}`
(`session.ts:319-326`).

**Completeness limits.** `bytes` covers the page JSON, not the JSON-RPC envelope (`paging.ts:5-10`);
over MCP an item larger than 4 MiB cannot be fetched whole, only exported. `hexvero_compare`
compares 2,000 items per side (path 2).

**Tests.** `mcp/test/server.test.ts:62` (paging), `:154` (structured errors), `:168` (export
policy), `:208` (continued scans, `partial` on pages), `:273` (result text within `maxBytes`);
`mcp/test/writePolicy.test.ts`; `mcp/test/agent.test.ts:92`, `:123`, `:158` (target text stays
data); `core/test/paging.test.ts:22-93`; `e2e/flows.test.ts:477` (real stdio client);
`scripts/smoke-tarballs.mjs:235-271`.

### Path 4: `hexvero ui --demo` → HTTP route → Session → CompareView / SourceView

**Input.** `hexvero ui [--port n] [--host h] [--open] [--demo]` (`cli/src/index.ts:762-785`; port
7331, `Session({worker:true})`, a warning for non-loopback hosts).

**Call chain.**

1. `startUi` (`cli/src/ui.ts:21`): with `--demo`, opens `examples/notesdesk-1.4.0.asar` and
   `1.5.0.asar` (`ui.ts:26-35`, paths from `examplesDirectory`, `cli/src/demo.ts:12`) and sets the
   start page `/compare?a=<id>&b=<id>`; `startServer` (`server/src/index.ts:126`) with the built UI
   (`uiDirectory`, `ui.ts:13`); prints `url#token=<token>` (`ui.ts:49-52`).
2. Browser: `main.tsx` → `App` (`web/src/App.tsx:55`); `useRoute`/`parseRoute`
   (`web/src/lib/route.ts:10-17`) gives tab `compare`; `App.tsx:307-314` renders `CompareView`.
3. `CompareView` (`web/src/views/CompareView.tsx:37`) → `Comparison` (`:116`) → `api.compare`
   (`web/src/lib/api.ts:255`, cached GET) with `Authorization: Bearer` from `#token` or
   `localStorage` (`api.ts:146-177`).
4. Server `api()` (`server/src/index.ts:146`): Host must name the bound or a loopback host
   (`:149-161`), Origin must equal Host (`:162-172`), bearer token compared in constant time
   (`:134-144`, `:173-181`); `GET /api/compare` → `compareReleases(..., {maxRows: 500})`
   (`:228-243`) → path 2.
5. Each row: `ChangeItem` (`CompareView.tsx:335`) → `PlaceLink` (`:386`) →
   `navigate(targetId, "source", {file, line})` (`:399`) → `Workspace` (`web/src/views/Workspace.tsx:203`)
   → `SourceView` (`web/src/views/SourceView.tsx:11`) → `api.source` (`api.ts:259`, context 14) →
   `GET /api/targets/:id/source` (`server/src/index.ts:320-326`) → `Session.source` → `sourceWindow`.
   Lines render as React text, never markup (`SourceView.tsx:58-80`).
6. "Download report (.md)" → `/api/compare/report` fetched with the header and saved from a Blob
   (`CompareView.tsx:168-179`, `api.ts:257-292`).

**Data model.** The UI mirrors `ReleaseComparison`, `ChangeRow`, `Place`, `SourceWindow` by hand
(`web/src/lib/api.ts:74-130`; it does not import core types).

**Completeness limits.** 500 rows per collection with a "shown of total" note
(`CompareView.tsx:243-250`); a partial-scan banner when either side was read in part
(`:186-194`); the text filter works on loaded rows only (`:133-140`).

**Errors.** Server: `fail` maps `not_found`→404, `too_large`→413, `cancelled`→499,
`provider_unavailable`→501, other `AnalysisError`→400, else 500 (`server/src/index.ts:78-105`);
401/403 for token, Host or Origin; `POST /api/demo` without example files → 404 (`:219-227`).
UI: `HttpError` (`api.ts:136-144`) shown in an alert (`CompareView.tsx:126-131`,
`SourceView.tsx:53-57`).

**Tests.** `server/test/server.test.ts:43` (token, cross-origin, DNS rebinding, token in query
refused), `:132` (demo, compare, report, source only for read files), `:178`;
`web/src/lib/pages.test.ts` (paging helpers only). No test renders `CompareView` or `SourceView`;
`scripts/smoke-tarballs.mjs:273-306` checks the static page and `/api/health` of an installed UI.

### Path 5: large app → partial/aborted/continued analysis → scan-cache validation

**Input.** CLI `analyze --continue | --all | --include p | --batch n | --fresh`
(`cli/src/index.ts:196-212`); MCP `hexvero_analyze {scan: continue|all|fresh, batch, include,
fresh}` (`mcp/src/tools.ts:55-91`, `305-338`); HTTP `GET /api/targets/:id/analysis?scan=continue|all`
(`server/src/index.ts:266-306`; no `fresh`, `include` or `batch` there); UI buttons "Read next
batch" / "Read all remaining files" (`web/src/views/Workspace.tsx:29-42,148-172`).

**Call chain.**

1. `Session.continueAnalysis` (`session.ts:300-312`) waits for a running analysis, drops the
   cached analysis and collections, stores the request in `e.next` and calls `analyze`.
2. `Session.analyze` (`session.ts:217-292`): one pending run per target shared by all waiters;
   a waiter's abort releases only its wait, the run is aborted when no waiter is left
   (`session.ts:254-257`). With a worker: `analyzeInWorker` (`analyzers/worker.ts:34`) copies the
   bytes, transfers them (`worker.ts:57-70`), and settles on message, timeout (`too_large`,
   `worker.ts:81-92`), abort (`invalid_input` "cancelled", `:93-101`), worker error (OOM →
   `too_large`, `:115-128`) or a non-zero exit (`malformed`, `:129-138`), then terminates the
   worker. Without a worker (CLI) the scan runs to its end on the caller's thread.
3. `scanApplication` (`dispatch.ts:86-164`): `scanKey` (`javascript/scanState.ts:21`: sha256 of
   `scan\0<JS_SCAN_SCHEMA>\0<CORE_VERSION>\0` + the ASAR sha256, or for a directory every file's
   path, size and mtime); `fresh` drops it (`dispatch.ts:92`); `loadScan` (`scanState.ts:47`)
   rejects a state whose key or schema differs, whose lists are missing, whose `scanned` count
   disagrees with modules + skipped, that names a module not in `scanned`, a path the input does
   not have, or a path twice (`scanState.ts:54-78`). A stored scan is shown as it stands unless the
   caller asks for more (`maxJsFiles: 0`, `dispatch.ts:107-116`).
4. Token pool: `plannedReads` (`app.ts:1618`) lists the run's files with the same order and
   budgets; at >= 4 MiB (`tokenPool.ts:15`) and `scanThreads() > 0` (`tokenPool.ts:18-23`; default
   up to 3, `HEXVERO_JS_THREADS`, 0 disables) `readTokensInParallel` (`tokenPool.ts:36`) tokenizes
   them largest first in `tokenWorker.ts`; a failed worker's files are read by the scan itself.
   The merge order is the scan's own, so the result is the same with or without threads.
5. `analyzeJavaScriptTree` with `resume` skips `facts.scanned` (`app.ts:2105-2107`); in `all` mode
   `onFacts` fires after each batch (`app.ts:2156`) and `scanApplication` saves each one
   (`dispatch.ts:142-145`); otherwise state is saved once after the run when the run advanced, or
   when a first run was partial or the app holds >= 1 MiB of JavaScript (`dispatch.ts:79`,
   `151-157`). `saveScan` writes a temp file 0600 and renames it (`scanState.ts:85-100`), then
   `pruneCacheSoon` (`cache.ts:151`). An unwritable cache adds `scan_state_not_saved`
   (`dispatch.ts:158-162`).
6. `coverage` (`app.ts:2656-2670`): `complete` only with no file left, none skipped and a listing
   that was not cut; `js_files_truncated` while files remain (`app.ts:2676-2680`). The CLI, MCP,
   server and UI each say "partial"/"N of M" (`cli/src/index.ts:250-269`, `tools.ts:322-326`,
   `server/src/index.ts:297-302`, `Workspace.tsx:130-147`).
7. Cache: root `~/.cache/hexvero` or `HEXVERO_CACHE_DIR` (`cache.ts:24-26`), 1,024 MiB and 30 days by
   default (`cache.ts:31-38`), only names matching `ENTRY` are touched, links never followed
   (`cache.ts:41-45,79-112`); pruning keeps anything younger than one hour (`cache.ts:121-148`).

**Data model.** `JsScanRequest` (`dispatch.ts:56-67`); `JsScanFacts` (`app.ts:1309-1360`, schema
`JS_SCAN_SCHEMA = 6`, `app.ts:1303`); stored file `{key, savedAt, facts}`; `JsCoverage`
(`app.ts:1280-1300`); `SideCoverage` for comparisons (`session.ts:333-345`).

**Completeness limits.** A run killed outside `all` mode loses that run's progress; the previous
complete state stays because the replace is atomic. A worker timeout (120 s default,
`worker.ts:18-20`) during `all` keeps the batches saved so far. `skippedFiles` and `partialFiles`
are listed up to 200 each (`app.ts:2161`, `2212`).

**Errors.** Corrupt or foreign state is ignored silently (`loadScan` returns null); timeouts and OOM
surface as `too_large`, cancellation as `invalid_input` (see open questions).

**Tests.** `core/test/resume.test.ts:51-151` (batches never repeat or lose a file, `all`,
`include`, byte budget), `:170` (key by content, damaged or foreign state ignored, atomic write),
`:191` (continues across sessions; a changed input starts over), `:235` (large app stored and reused);
`completeness.test.ts:125`, `:149` (unwritable cache); `worker.test.ts:15-45`; `cache.test.ts:45`,
`:56`; `mcp/test/server.test.ts:208`; `cli/test/cli.test.ts:172`; `performance.test.ts:111` and
`scripts/smoke-tarballs.mjs:188-233` (same analysis with 0 and 2 threads).

### Path 6: release bump → built packages → generated web demo → release workflow

**Input.** `npm run release -- x.y.z [--push]` on a clean `main` with notes under
`## [Unreleased]`.

**Call chain.**

1. `scripts/release.mjs`: version pattern (`:12-16`), clean tree (`:20-23`), branch `main`
   (`:24-27`), `git pull --ff-only` (`:28`), non-empty Unreleased section (`:30-37`), then
   `npm run check` on the untouched tree (`:39`).
2. Bump: `version` and `@hexvero/*` dependencies of core, mcp, server, cli, web (`:41-55`); constants
   `SERVER_VERSION`, cli `VERSION`, `CORE_VERSION`, `server.json`, `.claude-plugin/plugin.json`
   (`:56-64`); the `unreleased-note` block out of every README (`:68-74`); CHANGELOG section with
   today's date (`:76-91`).
3. Gates on the bumped tree (`:95-102`): `npm install`, `npm run check`, `npm run build`,
   `node scripts/build-site-demo.mjs` (regenerates `site/demo/index.html` and `report.md` from
   `packages/core/dist`, `build-site-demo.mjs:11-21,156-176`; the page and the report name the
   version), `release-verify.mjs v<version>` (four published packages, exact internal pins,
   constants, `server.json`, CHANGELOG, tag; `release-verify.mjs:13-45`), `smoke-tarballs.mjs`
   (pack, install into an empty project, exercise CLI, demo, compare report, export, token workers,
   MCP over stdio, UI; `smoke-tarballs.mjs:102-306`). Any failure restores the tree
   (`release.mjs:103-108`).
4. Commit `chore(release): x.y.z` and annotated tag (`:110-111`); `--push` pushes main and the tag
   atomically, which is the point of no return (`:112-125`).
5. `.github/workflows/release.yml` on tag `v*`: `verify` (`:27-69`: `npm ci`, check, build,
   `release-verify` with the tag, tag on main, `smoke-tarballs --out release`, publish dry run,
   notes, artifact); `publish` (`:71-126`: sha256 of every tarball equals the verified one, draft
   GitHub release, `publish-tarballs.mjs` with provenance and registry read-back,
   `publish-tarballs.mjs:68-122`); `registry-smoke` (`:128-150`); `finalize` (`:152-167`,
   prerelease vs latest).
6. After the run: `mcp-registry.yml` publishes `server.json` when Release succeeded (`:7-38`);
   `pages.yml` deploys `site/` on pushes to main that touch `site/**` (`:3-31`), which the release
   commit does when `site/demo` changed.

**Data model.** `release/manifest.json {version, tarballs:[{name, version, file, integrity,
sha256, files}]}` (`smoke-tarballs.mjs:107-117`), consumed by `publish-tarballs.mjs:23` and the
publish job's integrity step (`release.yml:96-107`).

**Completeness limits.** The CI workflow runs neither `build-site-demo.mjs --check` nor
`npm run release:check`; only `release.mjs` and `npm run release:check` (`package.json:27`) touch
`site/demo`. `release-verify.mjs` checks four packages, not `packages/web` or
`.claude-plugin/plugin.json`.

**Errors.** Every gate exits non-zero with its own output (`release.mjs:19`); a version already on
npm with other content fails the publish (`publish-tarballs.mjs:82-87`), identical content is
accepted on re-run (`:70-73`).

**Tests.** No unit tests for the release scripts; `smoke-tarballs.mjs` and `release-verify.mjs` are
the gates. `ci.yml:48-79` runs e2e, the examples diff, corpus check and gate, and the tarball smoke
on every push and PR.

## Design decisions found in the code

1. **One core, thin surfaces.** CLI, MCP and HTTP share `Session` (`session.ts:142-145`); no
   surface computes facts of its own.
2. **Facts and inferences stay apart.** `confidence` on findings (`model.ts:6`); `evidence` on
   endpoint/storage rows (`app.ts:3141-3142`); Electron defaults read as `default on/off`, never
   as `on/off`, because package.json names a requested version, not the shipped runtime
   (`app.ts:165-172`, `233-243`).
3. **Unknown is a third answer.** A one-sided item is `unknown`, not added/removed, when the other
   side did not read its file or was cut (`compare.ts:506-548`); an interface without an end is
   `unknown` while blind spots exist and `none` only without them (`interfaces.ts:57-67,115-129`).
4. **Identity joins only.** The interface map joins preload ↔ window ↔ channel on exact equality,
   no similarity matching (`interfaces.ts:4-12`).
5. **Positions are not content.** Source lines and native addresses are compared as positions and
   reported as `relocated` (`compare.ts:108-169`, `588-598`); `--strict` turns this off.
6. **Every list is bounded and says so.** Byte-budgeted pages (`paging.ts:4-23`), `next` always
   advances, limitations for every cap.
7. **Target text is data.** MCP `_meta` untrusted flag (`mcp/src/index.ts:152-153`), prompts quote
   arguments as JSON (`prompts.ts:15-18`), the report quotes target text (`report.ts:221-236`),
   the UI renders source lines as text (`SourceView.tsx:7-10`).
8. **Writes are fenced.** CLI refuses to overwrite without `--force`/`overwrite`; MCP writes only in
   allowed roots and replaces only earlier exports (`writePolicy.ts:1-8`, `session.ts:560-582`).
9. **Loopback API with a header token.** Token never accepted in a URL, Host and Origin checked
   against DNS rebinding, strict CSP (`server/src/index.ts:122-181`, `385-392`).
10. **Stored scans are keyed by everything that decides the reading** (content, schema, analyzer
    version) and replaced atomically (`scanState.ts:1-9`).
11. **Parallel tokenizing must not change the result** (`tokenPool.ts:1-6`); checked by
    `performance.test.ts:111` and the smoke test.
12. **Release gates run before anything is pushed**, the tested tarballs are the published ones
    (sha256 between jobs, integrity read-back), and the GitHub release becomes public last
    (`release.yml:3-12`).
13. **Generated pages come from real runs.** `site/demo` is produced by `compareReleases` and
    `Session.source` (`build-site-demo.mjs:2-6`); examples are byte-reproducible
    (`build-examples.mjs:1-7`, CI diff at `ci.yml:72-73`).
14. **The corpus is measured, not believed**: expectations written from sources, observer and scorer
    separated, gate against a committed result (`corpus/README.md:1-5,81-117`, `gate.mjs:1-11`).

## Open questions

Found while reading; each names where. None is a verified bug.

1. **Contracts not yet implemented at `f0382dc`.** `contracts.md` C1–C7 describe
   `CompareCompleteness`, `SideCoverage.unresolved`, `ChangeRow.id/whereBefore`,
   `ReleaseComparison.page/completeness`, `InterfaceRow.endsTotal/endsTruncated`, `hexvero check`.
   None exist in the code yet (`compare.ts:54-60,75-106`, `report.ts:7-43`, `interfaces.ts:22-55`).
   Today `interfaceMap` computes `direction` and `link` from the first 20 sorted ends
   (`interfaces.ts:111-136`), which C4 changes to all ends.
2. **Cancellation code.** Analyses cancelled by the caller reject with `invalid_input`
   (`session.ts:221,269`; `worker.ts:40,96`), while `AnalysisError` has a `cancelled` code
   (`model.ts:87`), providers use it (`providers/run.ts:113,160,419,422`) and the server maps it to 499
   (`server/src/index.ts:85`). Should analysis cancellation use `cancelled`?
3. **Timeout reported as `too_large`.** An analysis timeout is `too_large` (`worker.ts:85`), which the
   HTTP server returns as 413 (`server/src/index.ts:83`). Intended?
4. **Two export shapes.** `Session.export` writes `generator`, `complete`, `incomplete`, `volatile`,
   `unknowns` (`session.ts:584-602`); the HTTP export route writes only `{hexvero:1, target,
   analysis}` (`server/src/index.ts:329-343`).
5. **HTTP scan options.** The analysis route accepts `scan=continue|all` only
   (`server/src/index.ts:274-278`); CLI and MCP also offer `fresh`, `include`, `batch`.
6. **MCP compare paging.** `hexvero_compare` applies one `offset` to the added, removed, unknown and
   changed lists together (`tools.ts:399-409`); a caller cannot page one list alone.
7. **Site demo freshness is not gated in CI.** `build-site-demo.mjs --check` runs only in
   `npm run release:check` (`package.json:27`); `ci.yml` and `release.yml` do not run it, so report
   format changes on main can leave `site/demo` stale until the next release regenerates it
   (`release.mjs:100`).
8. **Version checks.** `release.mjs` bumps `packages/web/package.json` and
   `.claude-plugin/plugin.json` (`release.mjs:41-61`); `release-verify.mjs` checks neither
   (`release-verify.mjs:13-39`).
9. **Corpus baseline provenance.** `corpus/results/hexvero.json` records `tool.version` 0.7.4 and
   `commit` `2fa9b6e+uncommitted`; packages are 0.8.0. The gate still compares current code with it
   (`gate.mjs:30-58`), but the baseline's commit cannot be checked out as recorded.
10. **Stale docs.** `corpus/README.md:12-17` lists the sets dev, validation, holdout, damaged, while
    `cases.mjs:19` and `score.mjs` also load holdout2–holdout4; `docs/release-checklist.md` is the
    0.4.0 checklist.
11. **UI token persistence.** The web client stores the session token in `localStorage`
    (`api.ts:155-160`) and falls back to it when the URL has none (`api.ts:146-154`); a restarted
    server issues a new token, so the stored one then yields 401. Intended convenience?
12. **No UI component tests.** Nothing renders `CompareView` or `SourceView` in a test
    (`packages/web` has only `src/lib/pages.test.ts`).
13. **Corpus holdout verification executes corpus programs.** `corpus/holdout/verify/*.cjs|mjs` run
    bundled corpus sources against stand-ins (header comments). These are hexvero's own MIT corpus
    files, not targets; worth stating wherever the "never execute targets" rule is quoted.

## File inventory

Generated from `git ls-files` at `f0382dc` (586 files) with `wc`-style line counts. Status:
`read` (whole file read for this map), `inventoried` (listed; role from path, exports or header
comment, marked "from header comment" where that is the source), `generated` (with its generator),
`binary fixture` (committed binary input that is not regenerated), `binary asset` (image or video).

| Status                      | Files |
| --------------------------- | ----: |
| read                        |   106 |
| inventoried                 |   320 |
| generated (text and binary) |   139 |
| binary fixture or asset     |    21 |

### Generated and binary files: generator, schema, sample

| Files                                                    | Generator                                                                                                     | Schema                                                                                                                                                           | Sample                                                                                                                                                                                                                  |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `examples/notesdesk-1.4.0.asar`, `1.5.0.asar`            | `node scripts/build-examples.mjs` (CI: `git diff --exit-code -- examples`, `ci.yml:72-73`)                    | ASAR: 16-byte Pickle prefix (`4`, header size, string size, JSON length), JSON index `{files:{name:{size, offset}}}`, then contents (`build-examples.mjs:17-39`) | 1.5.0 prefix `4 312 308 302`; index `{"files":{"package.json":{"size":209,"offset":"0"},"main.js":{"size":1413,"offset":"209"},…,"renderer":{"files":{"index.html":…,"app.bundle.js":{"size":3490,"offset":"2736"}}}}}` |
| `examples/notesdesk-1.5.0.bundle.js`                     | same                                                                                                          | webpack 5 bundle with four modules (`build-examples.mjs:117-184`)                                                                                                | `/******/ (() => { // webpackBootstrap`                                                                                                                                                                                 |
| `site/demo/index.html`, `site/demo/report.md`            | `node scripts/build-site-demo.mjs` (`--check` compares)                                                       | HTML page and `renderReleaseReport` Markdown                                                                                                                     | `# What changed: notesdesk-1.4.0.asar → notesdesk-1.5.0.asar` / "A static reading of both files by hexvero 0.8.0."                                                                                                      |
| `corpus/built/**/*.asar` (27, damaged excluded)          | `node corpus/build.mjs` (esbuild 0.28.2, @electron/asar 4.3.1, fixed mtimes); `--check` rebuilds and compares | ASAR of a case's `src/` as `plain`, `bundled`, `minified`, `-v2`                                                                                                 | `corpus/built/dev/notes-app.plain.asar`                                                                                                                                                                                 |
| `corpus/built/damaged/*` (6)                             | `corpus/build.mjs` (cuts at fixed places, `build.mjs:163-190`)                                                | truncated or lying ASAR / Mach-O                                                                                                                                 | `empty.asar` has sha256 `e3b0c442…b855`                                                                                                                                                                                 |
| `corpus/built/**/*.macho-arm64` (8)                      | Apple clang 17 with `--native`, only when absent; not rebuilt by `--check`                                    | Mach-O arm64                                                                                                                                                     | `dev/calls.O2.macho-arm64`                                                                                                                                                                                              |
| `corpus/built/SHA256SUMS`                                | `corpus/build.mjs`                                                                                            | `<sha256>  <path>` per line (41 lines)                                                                                                                           | `e09fe9d4…a4d8  damaged/body-cut.macho-arm64`                                                                                                                                                                           |
| `corpus/results/**`                                      | `corpus/observe-hexvero.mjs` + `corpus/score.mjs` (`npm run corpus:accept`)                                   | observations `{tool, observations}`; scores `{tool, totals, rows:[{set, input, class, hit, missed, false, notes}]}`                                              | row `{"set":"dev","input":"dev/calls.O2.macho-arm64 → dev/calls-v2.O2.macho-arm64","class":"changes in imports","hit":1,"missed":0,"false":0,"notes":[]}`                                                               |
| `corpus/compare/results/**`, `corpus/compare/summary.md` | `corpus/compare/run-all.sh`, `score-all.mjs`, `summarize.mjs`                                                 | same scorer formats, `*.runs.jsonl` measurements                                                                                                                 | `results/scores/hexvero.dev.json`                                                                                                                                                                                       |
| `docs/demo/*.gif`, `compare.mp4`                         | `vhs docs/demo/*.tape`                                                                                        | GIF / MP4                                                                                                                                                        | `docs/demo/compare.gif`                                                                                                                                                                                                 |
| `docs/demo/agent-session.md`                             | `node scripts/demo-agent.mjs`                                                                                 | Markdown transcript of tool calls                                                                                                                                | "# An agent investigation, call by call"                                                                                                                                                                                |
| `docs/social-preview.png`                                | rendered from `docs/launch/assets/social-preview.html`                                                        | PNG                                                                                                                                                              | —                                                                                                                                                                                                                       |
| `package-lock.json`                                      | `npm install`                                                                                                 | npm lockfile v3                                                                                                                                                  | —                                                                                                                                                                                                                       |

### packages/core/src: analyzers, formats, JavaScript scanner, session, compare, report (60)

| path                                          | lines | role                                                                                                                                                                | owner | status      |
| --------------------------------------------- | ----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ----------- |
| `packages/core/src/analyzers/binary.ts`       |   422 | analyzeBinary: ELF/PE/Mach-O/fat containers with hardening, toolchain, Go/.NET/ObjC extras (from header comment)                                                    | A*    | inventoried |
| `packages/core/src/analyzers/dispatch.ts`     |   438 | analyzeTarget: format switch to parsers; scanApplication (stored scan, worker token pool) for ASAR/directories; RangeError/TypeError -> malformed                   | A*    | read        |
| `packages/core/src/analyzers/worker.ts`       |   140 | analyzeInWorker: worker thread with timeout (HEXVERO_ANALYSIS_TIMEOUT_MS, 120 s), abort, heap limit, structured errors                                              | A*    | read        |
| `packages/core/src/analyzers/workerEntry.ts`  |    31 | worker side of analyzeInWorker: runs analyzeTarget and posts the result or the AnalysisError                                                                        | A*    | read        |
| `packages/core/src/binary/reader.ts`          |   136 | ByteReader: bounds-checked cursor with switchable endianness (from header comment)                                                                                  | A*    | inventoried |
| `packages/core/src/binary/strings.ts`         |   118 | extractStrings / classifyString / STRING_TAGS for ASCII and UTF-16LE runs (from exports)                                                                            | A*    | inventoried |
| `packages/core/src/cache.ts`                  |   168 | private bounded cache root (~/.cache/hexvero or HEXVERO_CACHE_DIR): scans/, graphs/, ghidra/; pruneCache, pruneCacheSoon                                            | A*    | read        |
| `packages/core/src/compact.ts`                |    62 | compact (sampled projection) and brief (counts only) of analysis data for agents                                                                                    | B     | read        |
| `packages/core/src/compare.ts`                |   623 | compareItems: identity detection (COMPOSITE_KEYS, KEY_CANDIDATES), multiset pairing, relocated vs changed, unknown via coverage/cut                                 | B     | read        |
| `packages/core/src/formats/apk.ts`            |   363 | parseApk: manifest, components, permissions, dex/native libs, signing block (from header comments)                                                                  | A*    | inventoried |
| `packages/core/src/formats/arsc.ts`           |   271 | parseArsc: Android resources.arsc (ResTable) packages, keys, default values (from header comment)                                                                   | A*    | inventoried |
| `packages/core/src/formats/asar.ts`           |   151 | openAsar (in memory) / openAsarFile (from disk): Pickle header, JSON index (<=256 MiB), bounded reads                                                               | A*    | read        |
| `packages/core/src/formats/axml.ts`           |   191 | parseAxml: Android binary XML (from header comment)                                                                                                                 | A*    | inventoried |
| `packages/core/src/formats/bundle.ts`         |   267 | analyzeAppBundle / isAppBundle: macOS and iOS .app directories (from header comment)                                                                                | A*    | inventoried |
| `packages/core/src/formats/cil.ts`            |   547 | decodeMethodBody: CIL (ECMA-335) method bodies (from header comment)                                                                                                | A*    | inventoried |
| `packages/core/src/formats/detect.ts`         |    79 | detectFormat: magic bytes first, file name second (ASAR by extension or `{"files"` header)                                                                          | A*    | read        |
| `packages/core/src/formats/dex.ts`            |   202 | parseDex / descriptorToName: Android DEX (from exports)                                                                                                             | A*    | inventoried |
| `packages/core/src/formats/dotnet.ts`         |   665 | parseDotnet: .NET metadata tables, types, members, IL facts (from exports)                                                                                          | A*    | inventoried |
| `packages/core/src/formats/elf.ts`            |   396 | parseElf: ELF headers, sections, segments, symbols (from exports)                                                                                                   | A*    | inventoried |
| `packages/core/src/formats/evm.ts`            |   277 | parseEvm / disassembleEvm: EVM bytecode, selectors (from exports)                                                                                                   | A*    | inventoried |
| `packages/core/src/formats/flutter.ts`        |   175 | summarizeFlutter: Dart snapshot hash, engine build id (from header comment)                                                                                         | A*    | inventoried |
| `packages/core/src/formats/go.ts`             |   208 | parseGoBuildInfo: Go buildinfo and modules (from exports)                                                                                                           | A*    | inventoried |
| `packages/core/src/formats/har.ts`            |   222 | parseHar: HAR captures, hosts, API endpoints (from exports)                                                                                                         | A*    | inventoried |
| `packages/core/src/formats/java.ts`           |   380 | parseJavaClass / parseJar (from exports)                                                                                                                            | A*    | inventoried |
| `packages/core/src/formats/macho.ts`          |   401 | parseMacho / parseMachoFat (from exports)                                                                                                                           | A*    | inventoried |
| `packages/core/src/formats/machoObjc.ts`      |   643 | parseObjcMetadata: Objective-C classes, methods, protocols via chained fixups (from header comment)                                                                 | A*    | inventoried |
| `packages/core/src/formats/pe.ts`             |   359 | parsePe: PE/COFF sections, imports, exports, entropy (from exports)                                                                                                 | A*    | inventoried |
| `packages/core/src/formats/peResources.ts`    |   128 | readVersionInfo: PE RT_VERSION resource (from header comment)                                                                                                       | A*    | inventoried |
| `packages/core/src/formats/plist.ts`          |   237 | parsePlist: XML and binary property lists (from header comment)                                                                                                     | A*    | inventoried |
| `packages/core/src/formats/sqlite.ts`         |   244 | inspectSqlite: tables, columns, indexes via node:sqlite, read-only (from exports)                                                                                   | A*    | inventoried |
| `packages/core/src/formats/swiftDemangle.ts`  |   136 | lightweight Swift symbol reader (from header comment)                                                                                                               | A*    | inventoried |
| `packages/core/src/formats/toolchain.ts`      |   103 | detectToolchain: compiler, debug info, runtimes (from header comment)                                                                                               | A*    | inventoried |
| `packages/core/src/formats/wasm.ts`           |   327 | parseWasm: sections, imports, exports, types (from exports)                                                                                                         | A*    | inventoried |
| `packages/core/src/formats/zip.ts`            |   165 | openZip: central directory, bounded inflate (from exports and comments)                                                                                             | A*    | inventoried |
| `packages/core/src/index.ts`                  |   199 | public barrel of @hexvero/core: every export the CLI, MCP, server and scripts use                                                                                   | A*    | read        |
| `packages/core/src/javascript/aliases.ts`     |  1429 | resolveAliases and Constants: other names for ipcMain/ipcRenderer/fetch..., string constants (from header comment)                                                  | A     | inventoried |
| `packages/core/src/javascript/ambient.ts`     |   455 | collectAmbient / resolveAmbient: IPC through globals another file defines (from header comment)                                                                     | A     | inventoried |
| `packages/core/src/javascript/app.ts`         |  3211 | analyzeJavaScriptTree: per-file facts (readFileTokens), windows/webPreferences, contextBridge, IPC channel matching, coverage, findings; FileTree for dirs and ASAR | A     | read        |
| `packages/core/src/javascript/bundle.ts`      |   685 | analyzeBundle: webpack/Rspack/browserify/esbuild module maps without an engine (from header comment)                                                                | A     | inventoried |
| `packages/core/src/javascript/candidates.ts`  |   641 | findCandidates: endpoints, storage, URL literals with evidence (from header comment)                                                                                | A     | inventoried |
| `packages/core/src/javascript/interfaces.ts`  |   139 | interfaceMap: contextBridge member -> window -> main-process end by exact channel; link direct/resolved/unresolved/unknown/none                                     | A     | read        |
| `packages/core/src/javascript/recover.ts`     |   213 | recoverBundle / recoverSourceMap / safeRelativePath (from exports)                                                                                                  | A     | inventoried |
| `packages/core/src/javascript/resolve.ts`     |  2098 | ExpressionResolver: bounded resolution of channel expressions and window options (from header comment)                                                              | A     | inventoried |
| `packages/core/src/javascript/scan.ts`        |   814 | tokenize (2,000,000-token budget) and scanJavaScript: module references, IPC_APIS calls, wrappers, table keys, replies                                              | A     | read        |
| `packages/core/src/javascript/scanState.ts`   |   104 | stored scan state: scanKey (schema+version+content), loadScan validation, atomic saveScan, dropScan                                                                 | A     | read        |
| `packages/core/src/javascript/sourcemap.ts`   |   150 | summarizeSourceMap / originalPositionFor / decodeVlq (from exports)                                                                                                 | A     | inventoried |
| `packages/core/src/javascript/tokenPool.ts`   |    88 | readTokensInParallel: worker threads for files >= 4 MiB total; HEXVERO_JS_THREADS; results identical to sequential                                                  | A     | read        |
| `packages/core/src/javascript/tokenWorker.ts` |    17 | worker side of the token pool: readFileTokens per message                                                                                                           | A     | read        |
| `packages/core/src/model.ts`                  |    96 | shared result model: Finding (confirmed\|inferred), Limitation, TargetInfo, Analysis<T>, Page, AnalysisError codes                                                  | A*    | read        |
| `packages/core/src/next.ts`                   |    97 | suggestNextSteps: up to 4 follow-up questions with MCP tool args and CLI command                                                                                    | B     | read        |
| `packages/core/src/paging.ts`                 |   193 | pageOf: byte-budgeted pages (512 B..64 MiB, 2000 items), next offset, reduceItem placeholder for oversized items                                                    | B     | read        |
| `packages/core/src/providers/graph.ts`        |   603 | normalized whole-program call graph: neighborhood, tracePath, callersOf (from header comment)                                                                       | A*    | inventoried |
| `packages/core/src/providers/index.ts`        |   103 | detectProviders: radare2, rizin, ghidra on PATH, never installs (from header comment)                                                                               | A*    | inventoried |
| `packages/core/src/providers/run.ts`          |   739 | runProvider / loadCallGraph / killEngines: engines as child processes, cached, cancellable (from header comments)                                                   | A*    | inventoried |
| `packages/core/src/report.ts`                 |   361 | compareReleases (ChangeRow with Place[]) and renderReleaseReport (deterministic Markdown, quoting of target text)                                                   | B     | read        |
| `packages/core/src/session.ts`                |   916 | Session: targets by content id, shared/cancellable analyze, continueAnalysis, collectionsOf, compareCollection/compareAll, source, strings, bytes, export           | B     | read        |
| `packages/core/src/source.ts`                 |    87 | sourceWindow: lines around file:line, only for files the analysis read, inside the target, 8 MiB / 400 chars / 60 lines context caps                                | B     | read        |
| `packages/core/src/target.ts`                 |   114 | loadTarget: stat, size limit (512 MiB, ASAR lazy above it), SHA-256, detectFormat; readWindow                                                                       | A*    | read        |
| `packages/core/src/unknowns.ts`               |   110 | UnknownsLedger: open questions recorded per session, exported with analyses                                                                                         | B     | read        |
| `packages/core/src/version.ts`                |     2 | CORE_VERSION constant, rewritten by scripts/release.mjs                                                                                                             | A*    | read        |

### packages/core: build files and Ghidra script (3)

| path                                      | lines | role                                                                            | owner | status      |
| ----------------------------------------- | ----: | ------------------------------------------------------------------------------- | ----- | ----------- |
| `packages/core/ghidra/HexveroExport.java` |   218 | Ghidra headless export script used by the ghidra provider (from header comment) | A*    | inventoried |
| `packages/core/package.json`              |    42 | @hexvero/core: zero runtime dependencies, files dist + ghidra                   | A*    | read        |
| `packages/core/tsconfig.json`             |     6 | core project                                                                    | A*    | read        |

### packages/core/test: unit tests and byte-built fixtures (43)

| path                                           | lines | role                                                                                                                                            | owner | status      |
| ---------------------------------------------- | ----: | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ----------- |
| `packages/core/test/ambient.test.ts`           |   480 | tests: IPC through names another file defines; IPC on a page's own channel object; main-to-page messages outside a written-out ipcMain listener | E     | inventoried |
| `packages/core/test/android-resources.test.ts` |   111 | tests: parseArsc; Flutter facts                                                                                                                 | E     | inventoried |
| `packages/core/test/apk.test.ts`               |   224 | tests: openZip; parseAxml; parseApk                                                                                                             | E     | inventoried |
| `packages/core/test/appBundle.test.ts`         |    85 | tests: app bundles                                                                                                                              | E     | inventoried |
| `packages/core/test/cache.test.ts`             |    94 | tests: cache                                                                                                                                    | E     | inventoried |
| `packages/core/test/candidates.test.ts`        |   487 | tests: endpoints; storage; storage through helpers                                                                                              | E     | inventoried |
| `packages/core/test/cil.test.ts`               |   208 | tests: decodeMethodBody                                                                                                                         | E     | inventoried |
| `packages/core/test/compare.test.ts`           |   582 | tests: compareItems; items on one side only                                                                                                     | E     | inventoried |
| `packages/core/test/completeness.test.ts`      |   317 | tests: a scan that did not read everything says so; an unwritable cache directory; a guess is not reported as a fact                            | E     | inventoried |
| `packages/core/test/fixtures/arsc.ts`          |   152 | fixture builder: buildArsc (bytes built in code)                                                                                                | E     | inventoried |
| `packages/core/test/fixtures/asar.ts`          |    33 | fixture builder: buildAsar (bytes built in code)                                                                                                | E     | inventoried |
| `packages/core/test/fixtures/axml.ts`          |   109 | fixture builder: buildAxml (bytes built in code)                                                                                                | E     | inventoried |
| `packages/core/test/fixtures/builder.ts`       |    75 | shared byte builder for format fixtures                                                                                                         | E     | inventoried |
| `packages/core/test/fixtures/dex.ts`           |    46 | fixture builder: buildDex (bytes built in code)                                                                                                 | E     | inventoried |
| `packages/core/test/fixtures/dotnet.ts`        |    98 | fixture builder: buildDotnetMetadata (bytes built in code)                                                                                      | E     | inventoried |
| `packages/core/test/fixtures/elf.ts`           |   131 | fixture builder: buildElf (bytes built in code)                                                                                                 | E     | inventoried |
| `packages/core/test/fixtures/go.ts`            |    47 | fixture builder: buildGoInline (bytes built in code)                                                                                            | E     | inventoried |
| `packages/core/test/fixtures/java.ts`          |    48 | fixture builder: buildClass (bytes built in code)                                                                                               | E     | inventoried |
| `packages/core/test/fixtures/macho.ts`         |    93 | fixture builder: buildMacho (bytes built in code)                                                                                               | E     | inventoried |
| `packages/core/test/fixtures/machoObjc.ts`     |   293 | fixture builder: buildObjcMacho (bytes built in code)                                                                                           | E     | inventoried |
| `packages/core/test/fixtures/pe.ts`            |   111 | fixture builder: buildPe (bytes built in code)                                                                                                  | E     | inventoried |
| `packages/core/test/fixtures/zip.ts`           |    98 | fixture builder: crc32 (bytes built in code)                                                                                                    | E     | inventoried |
| `packages/core/test/formats.test.ts`           |   227 | tests: detectFormat; parseElf; parsePe                                                                                                          | E     | inventoried |
| `packages/core/test/go-dotnet.test.ts`         |    82 | tests: parseGoBuildInfo; parseDotnet                                                                                                            | E     | inventoried |
| `packages/core/test/graph.test.ts`             |   289 | tests: call graph                                                                                                                               | E     | inventoried |
| `packages/core/test/idioms.test.ts`            |   252 | tests: idioms of channel and bridge definitions                                                                                                 | E     | inventoried |
| `packages/core/test/interfaces.test.ts`        |   167 | tests: interface map; comparing interface rows                                                                                                  | E     | inventoried |
| `packages/core/test/java.test.ts`              |   118 | tests: parseJavaClass; parseJar; parseDex                                                                                                       | E     | inventoried |
| `packages/core/test/javascript.test.ts`        |   560 | tests: tokenize/scanJavaScript; source maps; ASAR                                                                                               | E     | inventoried |
| `packages/core/test/jsBundle.test.ts`          |   235 | tests: analyzeBundle; recovery; bundles without a module map                                                                                    | E     | inventoried |
| `packages/core/test/objc.test.ts`              |   104 | tests: parseObjcMetadata; Swift name recovery                                                                                                   | E     | inventoried |
| `packages/core/test/paging.test.ts`            |   111 | tests: page byte budget contract                                                                                                                | E     | inventoried |
| `packages/core/test/performance.test.ts`       |   157 | tests: JavaScript scan performance                                                                                                              | E     | inventoried |
| `packages/core/test/providers.test.ts`         |   379 | tests (no top-level describe title)                                                                                                             | E     | inventoried |
| `packages/core/test/report.test.ts`            |   180 | tests: release comparison; source lines                                                                                                         | E     | read        |
| `packages/core/test/resolve.test.ts`           |   517 | tests: bounded expression resolution                                                                                                            | E     | inventoried |
| `packages/core/test/resume.test.ts`            |   258 | tests: continued JavaScript scans; stored scan state                                                                                            | E     | read        |
| `packages/core/test/session.test.ts`           |   266 | tests: Session                                                                                                                                  | E     | inventoried |
| `packages/core/test/structured.test.ts`        |   282 | tests: parsePlist; parseHar; inspectSqlite                                                                                                      | E     | inventoried |
| `packages/core/test/toolchain.test.ts`         |   142 | tests: detectToolchain; readVersionInfo                                                                                                         | E     | inventoried |
| `packages/core/test/wasm-evm.test.ts`          |   156 | tests: parseWasm; EVM                                                                                                                           | E     | inventoried |
| `packages/core/test/windows.test.ts`           |   556 | tests: what follows from a window's settings together; window settings as written, computed, or absent                                          | E     | inventoried |
| `packages/core/test/worker.test.ts`            |    46 | tests: analyzeInWorker                                                                                                                          | E     | read        |

### packages/cli (17)

| path                              | lines | role                                                                                                         | owner | status      |
| --------------------------------- | ----: | ------------------------------------------------------------------------------------------------------------ | ----- | ----------- |
| `packages/cli/.gitignore`         |     1 | ignores /skills copied at prepack                                                                            | D     | read        |
| `packages/cli/README.md`          |    12 | npm README of the `hexvero` package                                                                          | D     | inventoried |
| `packages/cli/bin/hexvero.js`     |    22 | CLI entry: imports dist/index.js, waits for stdout drain, exit 70 on an unhandled rejection                  | D     | read        |
| `packages/cli/package.json`       |    63 | `hexvero` package: bin, files (dist, bin, ui, skills, examples), prepack copies skills and examples          | D     | read        |
| `packages/cli/src/args.ts`        |    84 | parseArgs, flagString, flagNumber, UsageError                                                                | D     | read        |
| `packages/cli/src/cache.ts`       |    80 | `hexvero cache`: list, --prune, --clear [--apply]                                                            | D     | read        |
| `packages/cli/src/demo.ts`        |   130 | example builds (DEMO_FILES), writeDemoFiles, formatChanges/formatDemo for `demo` and `compare --report`      | D     | read        |
| `packages/cli/src/doctor.ts`      |    46 | `hexvero doctor`: Node version, node:sqlite, engines                                                         | D     | read        |
| `packages/cli/src/format.ts`      |   110 | terminal formatting: findings, limitations, tables, hexdump, colors (from header comment)                    | D     | inventoried |
| `packages/cli/src/index.ts`       |   871 | main/run: argument dispatch for every command, exit codes 0/1/2, text and --json output                      | D     | read        |
| `packages/cli/src/jsonc.ts`       |   153 | minimal JSONC insert/remove for client settings files (from header comment)                                  | D     | inventoried |
| `packages/cli/src/setup.ts`       |   630 | `hexvero setup`: register/remove the MCP server in agent client configs, backups first (from header comment) | D     | inventoried |
| `packages/cli/src/skill.ts`       |    96 | `hexvero setup --skill`: installs skills/hexvero for agents (from header comment)                            | D     | inventoried |
| `packages/cli/src/ui.ts`          |    77 | startUi: opens demo targets, starts @hexvero/server with the built UI, prints URL with #token                | D     | read        |
| `packages/cli/test/cli.test.ts`   |   329 | tests: hexvero CLI; setup --skill                                                                            | E     | inventoried |
| `packages/cli/test/setup.test.ts` |   398 | tests: setup                                                                                                 | E     | inventoried |
| `packages/cli/tsconfig.json`      |    20 | cli project, references core, mcp, server                                                                    | D     | read        |

### packages/mcp (10)

| path                                    | lines | role                                                                                                                          | owner | status      |
| --------------------------------------- | ----: | ----------------------------------------------------------------------------------------------------------------------------- | ----- | ----------- |
| `packages/mcp/package.json`             |    48 | @hexvero/mcp: depends on core, @modelcontextprotocol/sdk, zod                                                                 | D     | read        |
| `packages/mcp/src/index.ts`             |   251 | createHexveroServer / serveStdio: registers 15 tools with annotations, one JSON text result, isError payloads, guided prompts | D     | read        |
| `packages/mcp/src/prompts.ts`           |   126 | GUIDED_PROMPTS: five investigation prompts, arguments quoted as JSON data                                                     | D     | read        |
| `packages/mcp/src/tools.ts`             |   557 | toolSchemas (zod inputs) and createHandlers: the 15 tool handlers over Session                                                | D     | read        |
| `packages/mcp/src/writePolicy.ts`       |    63 | checkWritePath: export/recover only inside allowed roots, no hidden paths, .json exports                                      | D     | read        |
| `packages/mcp/test/agent.test.ts`       |   193 | tests: the packaged skill; an investigation as the skill describes it                                                         | E     | inventoried |
| `packages/mcp/test/callgraph.test.ts`   |   105 | tests: hexvero_call_graph                                                                                                     | E     | inventoried |
| `packages/mcp/test/server.test.ts`      |   306 | tests: hexvero MCP server; page budget over MCP                                                                               | E     | read        |
| `packages/mcp/test/writePolicy.test.ts` |    59 | tests: MCP write policy                                                                                                       | E     | inventoried |
| `packages/mcp/tsconfig.json`            |     7 | mcp project, references core                                                                                                  | D     | read        |

### packages/server (4)

| path                                  | lines | role                                                                                                                                              | owner | status |
| ------------------------------------- | ----: | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------ |
| `packages/server/package.json`        |    44 | @hexvero/server: depends on core                                                                                                                  | C     | read   |
| `packages/server/src/index.ts`        |   416 | startServer: loopback HTTP API (token, Host/Origin checks), routes for targets, analysis, collections, compare, report, source, export; static UI | C     | read   |
| `packages/server/test/server.test.ts` |   197 | tests: hexvero HTTP API                                                                                                                           | E     | read   |
| `packages/server/tsconfig.json`       |     7 | server project, references core                                                                                                                   | C     | read   |

### packages/web (22)

| path                                        | lines | role                                                                                                        | owner | status      |
| ------------------------------------------- | ----: | ----------------------------------------------------------------------------------------------------------- | ----- | ----------- |
| `packages/web/index.html`                   |    14 | Vite HTML entry                                                                                             | C     | read        |
| `packages/web/package.json`                 |    24 | @hexvero/web (private): React 19, Vite 8, react-virtual                                                     | C     | read        |
| `packages/web/public/favicon.svg`           |     1 | favicon                                                                                                     | C     | inventoried |
| `packages/web/public/icon.svg`              |     1 | app icon                                                                                                    | C     | inventoried |
| `packages/web/src/App.tsx`                  |   406 | App shell: target list, open path/upload, demo button, routes to CompareView or Workspace                   | C     | read        |
| `packages/web/src/lib/api.ts`               |   313 | typed HTTP client: bearer token from #token (persisted to localStorage), response cache, downloads via Blob | C     | read        |
| `packages/web/src/lib/pages.test.ts`        |    33 | tests: collection pages                                                                                     | E     | inventoried |
| `packages/web/src/lib/pages.ts`             |    25 | nextOffset / reducedRow helpers for byte-budgeted pages                                                     | C     | read        |
| `packages/web/src/lib/route.ts`             |    57 | history router: /targets/:id/:tab, /compare?a&b                                                             | C     | read        |
| `packages/web/src/lib/useAsync.ts`          |    35 | useAsync hook keyed by string, ignores stale results                                                        | C     | read        |
| `packages/web/src/main.tsx`                 |    10 | React root                                                                                                  | C     | read        |
| `packages/web/src/styles.css`               |  1420 | all UI styles and theme tokens (see DESIGN.md)                                                              | C     | inventoried |
| `packages/web/src/views/CollectionView.tsx` |   228 | virtualized collection table with paging and reduced-row notice (from comments)                             | C     | inventoried |
| `packages/web/src/views/CompareView.tsx`    |   407 | Compare view: pickers, Comparison (changes, window changes, not established, counts), PlaceLink to source   | C     | read        |
| `packages/web/src/views/GraphView.tsx`      |   176 | module graph with a deterministic layered layout (from header comment)                                      | C     | inventoried |
| `packages/web/src/views/HexView.tsx`        |   289 | windowed hex viewer over /bytes (from header comment)                                                       | C     | inventoried |
| `packages/web/src/views/Overview.tsx`       |   368 | fact sheet, findings, limitations; finding file:line links (from comments)                                  | C     | inventoried |
| `packages/web/src/views/SourceView.tsx`     |    87 | source lines around file:line from /api/targets/:id/source, rendered as text                                | C     | read        |
| `packages/web/src/views/StringsView.tsx`    |   105 | strings tab (no header comment; role from name)                                                             | C     | inventoried |
| `packages/web/src/views/Workspace.tsx`      |   227 | per-target tabs, partial-scan banner with continue/all, export, routes to views                             | C     | read        |
| `packages/web/tsconfig.json`                |    19 | web typecheck (bundler resolution, noEmit)                                                                  | C     | read        |
| `packages/web/vite.config.ts`               |    16 | Vite config: React plugin, build into ../cli/ui, dev proxy /api -> 127.0.0.1:7331                           | C     | read        |

### e2e (1)

| path                | lines | role                                                                                                   | owner | status |
| ------------------- | ----: | ------------------------------------------------------------------------------------------------------ | ----- | ------ |
| `e2e/flows.test.ts` |   577 | four end-to-end flows on real inputs: Electron, native with installed engines, compare, MCP over stdio | E     | read   |

### scripts (13)

| path                           | lines | role                                                                                                                                    | owner | status      |
| ------------------------------ | ----: | --------------------------------------------------------------------------------------------------------------------------------------- | ----- | ----------- |
| `scripts/agent-eval.mjs`       |   224 | agent task evaluation with hexvero vs REA MCP servers graded on the corpus (from header comment)                                        | E     | inventoried |
| `scripts/bench.mjs`            |   110 | reproducible measurements for docs/benchmarks.md (from header comment)                                                                  | E     | inventoried |
| `scripts/build-examples.mjs`   |   202 | generates examples/notesdesk-1.4.0.asar, 1.5.0.asar and 1.5.0.bundle.js (byte-reproducible)                                             | E     | read        |
| `scripts/build-site-demo.mjs`  |   176 | writes site/demo/index.html and report.md from a real compareReleases run; --check fails when stale                                     | E     | read        |
| `scripts/check-shape.mjs`      |    70 | project rules: no any, AnalysisError in parsers, a test per format, confidence literals, console.log only in CLI, <=16 MCP tools        | E     | read        |
| `scripts/context-cost.mjs`     |   131 | bytes and tokens an agent pays for typical investigations (from header comment)                                                         | E     | inventoried |
| `scripts/demo-agent.mjs`       |   121 | writes docs/demo/agent-session.md from real tool results (from header comment)                                                          | E     | inventoried |
| `scripts/publish-tarballs.mjs` |   135 | publishes manifest tarballs in order with provenance, accepts identical re-runs, reads back integrity                                   | E     | read        |
| `scripts/release-notes.mjs`    |    27 | prints the CHANGELOG section of a tag (falls back to git log)                                                                           | E     | read        |
| `scripts/release-verify.mjs`   |    53 | release gate 1: versions of 4 published packages, pinned deps, constants, server.json, CHANGELOG, tag                                   | E     | read        |
| `scripts/release.mjs`          |   126 | cuts a release: changelog check, gates, version bump of 5 packages and constants, site demo, verify, smoke, commit + tag, optional push | E     | read        |
| `scripts/review-report.mjs`    |   110 | Review workflow gates and Markdown report (from header comment)                                                                         | E     | inventoried |
| `scripts/smoke-tarballs.mjs`   |   312 | release gate 2: pack 4 packages, install into an empty project, exercise CLI, demo, worker pool, MCP, UI                                | E     | read        |

### .github (11)

| path                                 | lines | role                                                                                                     | owner | status      |
| ------------------------------------ | ----: | -------------------------------------------------------------------------------------------------------- | ----- | ----------- |
| `.github/CODEOWNERS`                 |     2 | every path owned by @maximilianfeix                                                                      | Lead  | read        |
| `.github/ISSUE_TEMPLATE/bug.yml`     |    35 | bug report form                                                                                          | Lead  | inventoried |
| `.github/ISSUE_TEMPLATE/config.yml`  |     5 | issue template config                                                                                    | Lead  | inventoried |
| `.github/ISSUE_TEMPLATE/feature.yml` |    21 | feature request form                                                                                     | Lead  | inventoried |
| `.github/dependabot.yml`             |    13 | weekly npm and actions updates                                                                           | Lead  | read        |
| `.github/pull_request_template.md`   |    11 | PR template                                                                                              | Lead  | inventoried |
| `.github/workflows/ci.yml`           |    79 | CI: check on Node 22/24, tests on Windows/macOS, e2e + examples diff + corpus check/gate + tarball smoke | Lead  | read        |
| `.github/workflows/mcp-registry.yml` |    38 | publishes server.json to the MCP registry after a successful Release run                                 | Lead  | read        |
| `.github/workflows/pages.yml`        |    31 | deploys site/ to GitHub Pages on push to main touching site/**                                           | Lead  | read        |
| `.github/workflows/release.yml`      |   167 | Release on tag v*: verify -> publish (draft release, npm with provenance) -> registry-smoke -> finalize  | Lead  | read        |
| `.github/workflows/review.yml`       |    57 | PR quality gates with a threaded report comment                                                          | Lead  | read        |

### repository root (36)

| path                              | lines | role                                                                                                                     | owner | status                  |
| --------------------------------- | ----: | ------------------------------------------------------------------------------------------------------------------------ | ----- | ----------------------- |
| `.claude-plugin/marketplace.json` |    14 | Claude Code plugin marketplace entry                                                                                     | Lead  | read                    |
| `.claude-plugin/plugin.json`      |    10 | Claude Code plugin manifest (version bumped by release.mjs)                                                              | Lead  | read                    |
| `.editorconfig`                   |    15 | LF, 2 spaces, final newline                                                                                              | Lead  | read                    |
| `.gitattributes`                  |     2 | text=auto eol=lf for byte-stable fixtures                                                                                | Lead  | read                    |
| `.gitignore`                      |     9 | ignores node_modules, dist, packages/cli/ui, packages/cli/examples, .hexvero/                                            | Lead  | read                    |
| `.mcp.json`                       |     8 | project MCP config: npx -y hexvero mcp                                                                                   | Lead  | read                    |
| `.nvmrc`                          |     1 | Node 22                                                                                                                  | Lead  | read                    |
| `.oxfmtrc.json`                   |    24 | oxfmt: print width 100, ignores dist, lockfile, examples, corpus built/results/src, site/demo, docs/launch/published     | Lead  | read                    |
| `.oxlintrc.json`                  |    16 | oxlint: correctness errors, suspicious warnings                                                                          | Lead  | read                    |
| `CHANGELOG.md`                    |   738 | doc: "Changelog"                                                                                                         | Lead  | inventoried             |
| `CODE_OF_CONDUCT.md`              |    11 | doc: "Code of Conduct"                                                                                                   | Lead  | inventoried             |
| `CONTRIBUTING.md`                 |   113 | doc: "Contributing"                                                                                                      | Lead  | read                    |
| `DESIGN.md`                       |    61 | doc: "hexvero — design decisions"                                                                                        | Lead  | read                    |
| `DISCLAIMER.md`                   |     9 | doc: "Responsible use"                                                                                                   | Lead  | inventoried             |
| `LICENSE`                         |    21 | MIT license                                                                                                              | Lead  | inventoried             |
| `PRODUCT.md`                      |    41 | doc: "hexvero — product context"                                                                                         | Lead  | inventoried             |
| `PROGRESS.md`                     |   181 | doc: "Progress"                                                                                                          | Lead  | inventoried             |
| `README.de.md`                    |    70 | doc: "Installation"                                                                                                      | F     | inventoried             |
| `README.es.md`                    |    55 | doc: "Instalación"                                                                                                       | F     | inventoried             |
| `README.fr.md`                    |    55 | doc: "Installation"                                                                                                      | F     | inventoried             |
| `README.ja.md`                    |    55 | doc: "インストール"                                                                                                      | F     | inventoried             |
| `README.ko.md`                    |    55 | doc: "설치"                                                                                                              | F     | inventoried             |
| `README.md`                       |   452 | doc: "Try it"                                                                                                            | F     | inventoried             |
| `README.pt-BR.md`                 |    55 | doc: "Instalação"                                                                                                        | F     | inventoried             |
| `README.ru.md`                    |    55 | doc: "Установка"                                                                                                         | F     | inventoried             |
| `README.zh.md`                    |    55 | doc: "安装"                                                                                                              | F     | inventoried             |
| `SECURITY.md`                     |    41 | doc: "Security"                                                                                                          | Lead  | inventoried             |
| `glama.json`                      |     4 | Glama listing maintainers                                                                                                | Lead  | read                    |
| `llms.txt`                        |    27 | LLM-oriented project summary (root copy)                                                                                 | F     | inventoried             |
| `package-lock.json`               |  4270 | npm lockfile                                                                                                             | Lead  | generated (npm install) |
| `package.json`                    |    43 | workspace root: scripts (build, typecheck, lint, format, test, check, e2e, corpus, release, site:demo), pinned dev tools | Lead  | read                    |
| `server.json`                     |    23 | MCP registry manifest (name, version, npm package, stdio)                                                                | Lead  | read                    |
| `tsconfig.base.json`              |    21 | strict compiler options (exactOptionalPropertyTypes, noUncheckedIndexedAccess, NodeNext)                                 | Lead  | read                    |
| `tsconfig.json`                   |    17 | solution file: project references core, mcp, server, cli                                                                 | Lead  | read                    |
| `vitest.config.ts`                |     9 | unit tests: packages/_/src/\*\*/_.test.ts and packages/_/test/\*\*/_.test.ts, 20 s timeout                               | Lead  | read                    |
| `vitest.e2e.config.ts`            |    12 | e2e tests: e2e/**/*.test.ts, 120 s, no file parallelism                                                                  | Lead  | read                    |

### examples (6)

| path                                 | lines | role                                                                                | owner | status                                         |
| ------------------------------------ | ----: | ----------------------------------------------------------------------------------- | ----- | ---------------------------------------------- |
| `examples/README.md`                 |    20 | doc: "Examples"                                                                     | E     | read                                           |
| `examples/native/demo-v1.c`          |    22 | C example, version 1 (e2e flow 2/3 compile it)                                      | E     | inventoried                                    |
| `examples/native/demo-v2.c`          |    28 | C example, version 2: adds read_config/getenv, new version string                   | E     | inventoried                                    |
| `examples/notesdesk-1.4.0.asar`      |       | example Electron app 1.4.0 (nodeIntegration on, sandbox off, shell:open)            | E     | generated, binary (scripts/build-examples.mjs) |
| `examples/notesdesk-1.5.0.asar`      |       | example Electron app 1.5.0 (sandbox on, update:check, computed plugin:${…} channel) | E     | generated, binary (scripts/build-examples.mjs) |
| `examples/notesdesk-1.5.0.bundle.js` |    67 | 1.5.0 renderer bundle alone (webpack 5, four modules) for `recover`                 | E     | generated (scripts/build-examples.mjs)         |

### skills (user-facing agent skill; not modified here) (6)

| path                                     | lines | role                                     | owner | status      |
| ---------------------------------------- | ----: | ---------------------------------------- | ----- | ----------- |
| `skills/hexvero/SKILL.md`                |    51 | doc: "Investigate software with hexvero" | D*    | read        |
| `skills/hexvero/references/compare.md`   |    13 | doc: "Comparing two versions"            | D*    | inventoried |
| `skills/hexvero/references/electron.md`  |    32 | doc: "Electron and JavaScript apps"      | D*    | inventoried |
| `skills/hexvero/references/formats.md`   |    14 | doc: "Other formats"                     | D*    | inventoried |
| `skills/hexvero/references/native.md`    |    18 | doc: "Native binaries (ELF, PE, Mach-O)" | D*    | inventoried |
| `skills/hexvero/references/reporting.md` |    25 | doc: "Writing the answer"                | D*    | inventoried |

### site (GitHub Pages) (11)

| path                      | lines | role                                                                             | owner | status                                  |
| ------------------------- | ----: | -------------------------------------------------------------------------------- | ----- | --------------------------------------- |
| `site/demo/index.html`    |   156 | website example comparison page (all rows from compareReleases + Session.source) | F     | generated (scripts/build-site-demo.mjs) |
| `site/demo/report.md`     |    90 | Markdown report of the example comparison (renderReleaseReport)                  | F     | generated (scripts/build-site-demo.mjs) |
| `site/index.html`         |   311 | website home page                                                                | F     | inventoried                             |
| `site/llms.txt`           |    28 | LLM-oriented project summary served by the website                               | F     | inventoried                             |
| `site/logo-mark.svg`      |     1 | image/video asset                                                                | F     | inventoried                             |
| `site/logo.svg`           |     1 | image/video asset                                                                | F     | inventoried                             |
| `site/robots.txt`         |     4 | website robots                                                                   | F     | inventoried                             |
| `site/site.css`           |   495 | website styles                                                                   | F     | inventoried                             |
| `site/sitemap.xml`        |     5 | website sitemap                                                                  | F     | inventoried                             |
| `site/social-preview.png` |       | image/video asset                                                                | F     | binary asset                            |
| `site/ui-compare.png`     |       | image/video asset                                                                | F     | binary asset                            |

### corpus: tools and README (6)

| path                         | lines | role                                                                                                                               | owner | status      |
| ---------------------------- | ----: | ---------------------------------------------------------------------------------------------------------------------------------- | ----- | ----------- |
| `corpus/README.md`           |   156 | doc: "Corpus"                                                                                                                      | E     | read        |
| `corpus/build.mjs`           |   220 | builds corpus inputs (esbuild + @electron/asar pinned; native only with --native), damaged cuts, SHA256SUMS; --check (header read) | E     | inventoried |
| `corpus/cases.mjs`           |    32 | loadCases: every expected*.json of the sets dev, validation, holdout..holdout4, damaged                                            | E     | read        |
| `corpus/gate.mjs`            |    72 | fails when any (set, input, class) row is worse than corpus/results/hexvero.json                                                   | E     | read        |
| `corpus/observe-hexvero.mjs` |   301 | runs hexvero on every corpus input into the neutral observation format, scratch cache (header read)                                | E     | inventoried |
| `corpus/score.mjs`           |   479 | scores observations against expectations: hit, missed, false per class and input (header read)                                     | E     | inventoried |

### corpus/compare: hexvero vs REA harness (16)

| path                                        | lines | role                                                                                  | owner | status                                   |
| ------------------------------------------- | ----: | ------------------------------------------------------------------------------------- | ----- | ---------------------------------------- |
| `corpus/compare/README.md`                  |   383 | doc: "hexvero and REA on the corpus: a measured comparison"                           | E     | inventoried                              |
| `corpus/compare/conclusions.md`             |   126 | doc: "6. What hexvero does better, with the evidence"                                 | E     | inventoried                              |
| `corpus/compare/environment.mjs`            |    84 | records tools, runtime, machine, engines of a comparison run (from header comment)    | E     | inventoried                              |
| `corpus/compare/lib/common.mjs`             |   228 | shared paths and measured command runner for the comparison (from header comment)     | E     | inventoried                              |
| `corpus/compare/lib/hexvero-map.mjs`        |    79 | reduces hexvero CLI/MCP payloads to the neutral format (from header comment)          | E     | inventoried                              |
| `corpus/compare/lib/plan.mjs`               |    65 | the five user questions as units of work (from header comment)                        | E     | inventoried                              |
| `corpus/compare/lib/rea-map.mjs`            |   347 | maps REA 6.4.0 output to the neutral format (from header comment)                     | E     | inventoried                              |
| `corpus/compare/mcp-catalog.mjs`            |    94 | measures initialize and tools/list sizes of both MCP servers (from header comment)    | E     | inventoried                              |
| `corpus/compare/observe-hexvero-pinned.mjs` |    74 | runs the observer of a pinned hexvero commit (from header comment)                    | E     | inventoried                              |
| `corpus/compare/observe-rea.mjs`            |   187 | runs REA on every corpus input into the neutral format (from header comment)          | E     | inventoried                              |
| `corpus/compare/run-all.sh`                 |    37 | whole comparison in order, configured by environment (from header comment)            | E     | inventoried                              |
| `corpus/compare/run-cli.mjs`                |   294 | the five questions through each tool's CLI, measured (from header comment)            | E     | inventoried                              |
| `corpus/compare/run-mcp.mjs`                |   344 | the five questions through each MCP server over stdio, measured (from header comment) | E     | inventoried                              |
| `corpus/compare/score-all.mjs`              |    36 | scores every observation file of the comparison per set (from header comment)         | E     | inventoried                              |
| `corpus/compare/summarize.mjs`              |   374 | builds compare/summary.md from raw results (from header comment)                      | E     | inventoried                              |
| `corpus/compare/summary.md`                 |   377 | doc: "hexvero a6d9b82 and REA 6.4.0 on the hexvero corpus"                            | E     | generated (corpus/compare/summarize.mjs) |

### corpus cases: sources and expectations (hand-written test inputs) (111)

| path                                                       | lines | role                                                                                                      | owner | status      |
| ---------------------------------------------------------- | ----: | --------------------------------------------------------------------------------------------------------- | ----- | ----------- |
| `corpus/damaged/expected.json`                             |    44 | expected facts written from the sources (method + why per item)                                           | E     | inventoried |
| `corpus/dev/native/calls-v2.c.patch.json`                  |    14 | edits that make the v2 native input                                                                       | E     | inventoried |
| `corpus/dev/native/calls.c`                                |    41 | native case source (C)                                                                                    | E     | inventoried |
| `corpus/dev/native/expected-compare.json`                  |    23 | expected facts written from the sources (method + why per item)                                           | E     | inventoried |
| `corpus/dev/native/expected.json`                          |    79 | expected facts written from the sources (method + why per item)                                           | E     | inventoried |
| `corpus/dev/notes-app-v2/changes.json`                     |    37 | listed edits that turn the case into its -v2 build                                                        | E     | inventoried |
| `corpus/dev/notes-app-v2/expected.json`                    |    30 | expected facts written from the sources (method + why per item)                                           | E     | inventoried |
| `corpus/dev/notes-app/expected.json`                       |   184 | expected facts written from the sources (method + why per item)                                           | E     | inventoried |
| `corpus/dev/notes-app/src/channels.js`                     |     5 | case source (notes-app): channels.js                                                                      | E     | inventoried |
| `corpus/dev/notes-app/src/index.html`                      |     4 | case source (notes-app): index.html                                                                       | E     | inventoried |
| `corpus/dev/notes-app/src/main.js`                         |    64 | case source (notes-app): main.js                                                                          | E     | inventoried |
| `corpus/dev/notes-app/src/package.json`                    |    12 | case source (notes-app): package.json                                                                     | E     | inventoried |
| `corpus/dev/notes-app/src/preload.js`                      |    15 | case source (notes-app): preload.js                                                                       | E     | inventoried |
| `corpus/dev/notes-app/src/renderer.js`                     |    62 | case source (notes-app): renderer.js                                                                      | E     | inventoried |
| `corpus/holdout/README.md`                                 |   229 | doc: "Hold-out set of the corpus"                                                                         | E     | inventoried |
| `corpus/holdout/native/expected.json`                      |   230 | expected facts written from the sources (method + why per item)                                           | E     | inventoried |
| `corpus/holdout/native/exprcalc.c`                         |   203 | native case source (C)                                                                                    | E     | inventoried |
| `corpus/holdout/time-tracker-v2/changes.json`              |    57 | listed edits that turn the case into its -v2 build                                                        | E     | inventoried |
| `corpus/holdout/time-tracker-v2/expected.json`             |    52 | expected facts written from the sources (method + why per item)                                           | E     | inventoried |
| `corpus/holdout/time-tracker/expected.json`                |   765 | expected facts written from the sources (method + why per item)                                           | E     | inventoried |
| `corpus/holdout/time-tracker/src/config/endpoints.js`      |    21 | case source (time-tracker): config/endpoints.js                                                           | E     | inventoried |
| `corpus/holdout/time-tracker/src/config/windows.js`        |    23 | case source (time-tracker): config/windows.js                                                             | E     | inventoried |
| `corpus/holdout/time-tracker/src/index.html`               |    40 | case source (time-tracker): index.html                                                                    | E     | inventoried |
| `corpus/holdout/time-tracker/src/ipc/channels.js`          |    15 | case source (time-tracker): ipc/channels.js                                                               | E     | inventoried |
| `corpus/holdout/time-tracker/src/ipc/events.js`            |     7 | case source (time-tracker): ipc/events.js                                                                 | E     | inventoried |
| `corpus/holdout/time-tracker/src/ipc/index.js`             |     9 | case source (time-tracker): ipc/index.js                                                                  | E     | inventoried |
| `corpus/holdout/time-tracker/src/lib/format.js`            |    22 | case source (time-tracker): lib/format.js                                                                 | E     | inventoried |
| `corpus/holdout/time-tracker/src/lib/keys.js`              |    10 | case source (time-tracker): lib/keys.js                                                                   | E     | inventoried |
| `corpus/holdout/time-tracker/src/main.js`                  |   356 | case source (time-tracker): main.js                                                                       | E     | inventoried |
| `corpus/holdout/time-tracker/src/package.json`             |    15 | case source (time-tracker): package.json                                                                  | E     | inventoried |
| `corpus/holdout/time-tracker/src/preload.js`               |   102 | case source (time-tracker): preload.js                                                                    | E     | inventoried |
| `corpus/holdout/time-tracker/src/renderer-widget.js`       |    74 | case source (time-tracker): renderer-widget.js                                                            | E     | inventoried |
| `corpus/holdout/time-tracker/src/renderer.js`              |   226 | case source (time-tracker): renderer.js                                                                   | E     | inventoried |
| `corpus/holdout/verify.mjs`                                |   459 | checks time-tracker expectations against what the built program does with stand-ins (from header comment) | E     | inventoried |
| `corpus/holdout/verify/observe-main.cjs`                   |   142 | runs a bundled corpus main.js against stand-ins for electron (corpus sources only, from header comment)   | E     | inventoried |
| `corpus/holdout/verify/observe-preload.cjs`                |    64 | runs a bundled corpus preload.js against a stand-in for electron (from header comment)                    | E     | inventoried |
| `corpus/holdout/verify/observe-renderer.mjs`               |   137 | runs a bundled corpus renderer against browser stand-ins (from header comment)                            | E     | inventoried |
| `corpus/holdout2/README.md`                                |   226 | doc: "Second hold-out set of the corpus"                                                                  | E     | inventoried |
| `corpus/holdout2/markdown-editor-v2/changes.json`          |    62 | listed edits that turn the case into its -v2 build                                                        | E     | inventoried |
| `corpus/holdout2/markdown-editor-v2/expected.json`         |    48 | expected facts written from the sources (method + why per item)                                           | E     | inventoried |
| `corpus/holdout2/markdown-editor/expected.json`            |   569 | expected facts written from the sources (method + why per item)                                           | E     | inventoried |
| `corpus/holdout2/markdown-editor/src/config/defaults.js`   |    35 | case source (markdown-editor): config/defaults.js                                                         | E     | inventoried |
| `corpus/holdout2/markdown-editor/src/config/endpoints.js`  |    15 | case source (markdown-editor): config/endpoints.js                                                        | E     | inventoried |
| `corpus/holdout2/markdown-editor/src/index.html`           |    55 | case source (markdown-editor): index.html                                                                 | E     | inventoried |
| `corpus/holdout2/markdown-editor/src/ipc/channels.js`      |    17 | case source (markdown-editor): ipc/channels.js                                                            | E     | inventoried |
| `corpus/holdout2/markdown-editor/src/lib/markdown.js`      |    59 | case source (markdown-editor): lib/markdown.js                                                            | E     | inventoried |
| `corpus/holdout2/markdown-editor/src/lib/settings-file.js` |    38 | case source (markdown-editor): lib/settings-file.js                                                       | E     | inventoried |
| `corpus/holdout2/markdown-editor/src/main.js`              |   399 | case source (markdown-editor): main.js                                                                    | E     | inventoried |
| `corpus/holdout2/markdown-editor/src/package.json`         |    12 | case source (markdown-editor): package.json                                                               | E     | inventoried |
| `corpus/holdout2/markdown-editor/src/preload.js`           |    78 | case source (markdown-editor): preload.js                                                                 | E     | inventoried |
| `corpus/holdout2/markdown-editor/src/renderer-preview.js`  |    32 | case source (markdown-editor): renderer-preview.js                                                        | E     | inventoried |
| `corpus/holdout2/markdown-editor/src/renderer-settings.js` |    47 | case source (markdown-editor): renderer-settings.js                                                       | E     | inventoried |
| `corpus/holdout2/markdown-editor/src/renderer.js`          |   277 | case source (markdown-editor): renderer.js                                                                | E     | inventoried |
| `corpus/holdout2/music-player/expected.json`               |   629 | expected facts written from the sources (method + why per item)                                           | E     | inventoried |
| `corpus/holdout2/music-player/src/index.html`              |    61 | case source (music-player): index.html                                                                    | E     | inventoried |
| `corpus/holdout2/music-player/src/lib/keys.js`             |     8 | case source (music-player): lib/keys.js                                                                   | E     | inventoried |
| `corpus/holdout2/music-player/src/main.js`                 |   319 | case source (music-player): main.js                                                                       | E     | inventoried |
| `corpus/holdout2/music-player/src/main/window-options.js`  |    29 | case source (music-player): main/window-options.js                                                        | E     | inventoried |
| `corpus/holdout2/music-player/src/package.json`            |    16 | case source (music-player): package.json                                                                  | E     | inventoried |
| `corpus/holdout2/music-player/src/preload.js`              |    65 | case source (music-player): preload.js                                                                    | E     | inventoried |
| `corpus/holdout2/music-player/src/renderer-mini.js`        |    36 | case source (music-player): renderer-mini.js                                                              | E     | inventoried |
| `corpus/holdout2/music-player/src/renderer.js`             |   314 | case source (music-player): renderer.js                                                                   | E     | inventoried |
| `corpus/holdout2/music-player/src/shared/endpoints.js`     |    15 | case source (music-player): shared/endpoints.js                                                           | E     | inventoried |
| `corpus/holdout2/music-player/src/shared/ipc.js`           |    21 | case source (music-player): shared/ipc.js                                                                 | E     | inventoried |
| `corpus/holdout2/music-player/src/shared/time.js`          |    28 | case source (music-player): shared/time.js                                                                | E     | inventoried |
| `corpus/holdout3/README.md`                                |   206 | doc: "Third hold-out set of the corpus"                                                                   | E     | inventoried |
| `corpus/holdout3/podcast-player-v2/changes.json`           |    81 | listed edits that turn the case into its -v2 build                                                        | E     | inventoried |
| `corpus/holdout3/podcast-player-v2/expected.json`          |   106 | expected facts written from the sources (method + why per item)                                           | E     | inventoried |
| `corpus/holdout3/podcast-player/expected.json`             |  1124 | expected facts written from the sources (method + why per item)                                           | E     | inventoried |
| `corpus/holdout3/podcast-player/src/index.html`            |    29 | case source (podcast-player): index.html                                                                  | E     | inventoried |
| `corpus/holdout3/podcast-player/src/main.js`               |   405 | case source (podcast-player): main.js                                                                     | E     | inventoried |
| `corpus/holdout3/podcast-player/src/package.json`          |    15 | case source (podcast-player): package.json                                                                | E     | inventoried |
| `corpus/holdout3/podcast-player/src/player.html`           |    17 | case source (podcast-player): player.html                                                                 | E     | inventoried |
| `corpus/holdout3/podcast-player/src/preload-player.js`     |    24 | case source (podcast-player): preload-player.js                                                           | E     | inventoried |
| `corpus/holdout3/podcast-player/src/preload.js`            |    59 | case source (podcast-player): preload.js                                                                  | E     | inventoried |
| `corpus/holdout3/podcast-player/src/renderer-player.js`    |    58 | case source (podcast-player): renderer-player.js                                                          | E     | inventoried |
| `corpus/holdout3/podcast-player/src/renderer.js`           |   236 | case source (podcast-player): renderer.js                                                                 | E     | inventoried |
| `corpus/holdout3/podcast-player/src/shared/channels.js`    |    46 | case source (podcast-player): shared/channels.js                                                          | E     | inventoried |
| `corpus/holdout3/podcast-player/src/shared/endpoints.js`   |    14 | case source (podcast-player): shared/endpoints.js                                                         | E     | inventoried |
| `corpus/holdout3/podcast-player/src/shared/index.js`       |    22 | case source (podcast-player): shared/index.js                                                             | E     | inventoried |
| `corpus/holdout4/README.md`                                |   213 | doc: "Fourth hold-out set of the corpus"                                                                  | E     | inventoried |
| `corpus/holdout4/kanban-board-v2/changes.json`             |    76 | listed edits that turn the case into its -v2 build                                                        | E     | inventoried |
| `corpus/holdout4/kanban-board-v2/expected.json`            |   106 | expected facts written from the sources (method + why per item)                                           | E     | inventoried |
| `corpus/holdout4/kanban-board/expected.json`               |   868 | expected facts written from the sources (method + why per item)                                           | E     | inventoried |
| `corpus/holdout4/kanban-board/src/activity.html`           |    19 | case source (kanban-board): activity.html                                                                 | E     | inventoried |
| `corpus/holdout4/kanban-board/src/import.html`             |    17 | case source (kanban-board): import.html                                                                   | E     | inventoried |
| `corpus/holdout4/kanban-board/src/index.html`              |    42 | case source (kanban-board): index.html                                                                    | E     | inventoried |
| `corpus/holdout4/kanban-board/src/lib/board-model.js`      |   101 | case source (kanban-board): lib/board-model.js                                                            | E     | inventoried |
| `corpus/holdout4/kanban-board/src/lib/channels.js`         |    26 | case source (kanban-board): lib/channels.js                                                               | E     | inventoried |
| `corpus/holdout4/kanban-board/src/lib/window-factory.js`   |    38 | case source (kanban-board): lib/window-factory.js                                                         | E     | inventoried |
| `corpus/holdout4/kanban-board/src/main.js`                 |   361 | case source (kanban-board): main.js                                                                       | E     | inventoried |
| `corpus/holdout4/kanban-board/src/package.json`            |     9 | case source (kanban-board): package.json                                                                  | E     | inventoried |
| `corpus/holdout4/kanban-board/src/preload-activity.js`     |    14 | case source (kanban-board): preload-activity.js                                                           | E     | inventoried |
| `corpus/holdout4/kanban-board/src/preload.js`              |    53 | case source (kanban-board): preload.js                                                                    | E     | inventoried |
| `corpus/holdout4/kanban-board/src/renderer-activity.js`    |    58 | case source (kanban-board): renderer-activity.js                                                          | E     | inventoried |
| `corpus/holdout4/kanban-board/src/renderer-import.js`      |    53 | case source (kanban-board): renderer-import.js                                                            | E     | inventoried |
| `corpus/holdout4/kanban-board/src/renderer.js`             |   216 | case source (kanban-board): renderer.js                                                                   | E     | inventoried |
| `corpus/validation/README.md`                              |   100 | doc: "Validation half of the corpus"                                                                      | E     | inventoried |
| `corpus/validation/chat-app-v2/changes.json`               |    57 | listed edits that turn the case into its -v2 build                                                        | E     | inventoried |
| `corpus/validation/chat-app-v2/expected.json`              |    42 | expected facts written from the sources (method + why per item)                                           | E     | inventoried |
| `corpus/validation/chat-app/expected.json`                 |   511 | expected facts written from the sources (method + why per item)                                           | E     | inventoried |
| `corpus/validation/chat-app/src/index.html`                |    25 | case source (chat-app): index.html                                                                        | E     | inventoried |
| `corpus/validation/chat-app/src/ipc-names.js`              |    11 | case source (chat-app): ipc-names.js                                                                      | E     | inventoried |
| `corpus/validation/chat-app/src/main.js`                   |   201 | case source (chat-app): main.js                                                                           | E     | inventoried |
| `corpus/validation/chat-app/src/net.js`                    |    27 | case source (chat-app): net.js                                                                            | E     | inventoried |
| `corpus/validation/chat-app/src/package.json`              |    12 | case source (chat-app): package.json                                                                      | E     | inventoried |
| `corpus/validation/chat-app/src/preload.js`                |    61 | case source (chat-app): preload.js                                                                        | E     | inventoried |
| `corpus/validation/chat-app/src/renderer-settings.js`      |    40 | case source (chat-app): renderer-settings.js                                                              | E     | inventoried |
| `corpus/validation/chat-app/src/renderer.js`               |   180 | case source (chat-app): renderer.js                                                                       | E     | inventoried |
| `corpus/validation/native/dispatch.c`                      |    90 | native case source (C)                                                                                    | E     | inventoried |
| `corpus/validation/native/expected.json`                   |   141 | expected facts written from the sources (method + why per item)                                           | E     | inventoried |

### corpus/built: built inputs (42)

| path                                                  | lines | role         | owner | status                                                                       |
| ----------------------------------------------------- | ----: | ------------ | ----- | ---------------------------------------------------------------------------- |
| `corpus/built/SHA256SUMS`                             |    41 | corpus input | E     | generated (corpus/build.mjs)                                                 |
| `corpus/built/damaged/body-cut.macho-arm64`           |       | corpus input | E     | generated, binary (corpus/build.mjs (cut from built inputs at fixed places)) |
| `corpus/built/damaged/contents-cut.asar`              |       | corpus input | E     | generated, binary (corpus/build.mjs (cut from built inputs at fixed places)) |
| `corpus/built/damaged/empty.asar`                     |       | corpus input | E     | generated, binary (corpus/build.mjs (cut from built inputs at fixed places)) |
| `corpus/built/damaged/header-cut.asar`                |       | corpus input | E     | generated, binary (corpus/build.mjs (cut from built inputs at fixed places)) |
| `corpus/built/damaged/header-length-lies.asar`        |       | corpus input | E     | generated, binary (corpus/build.mjs (cut from built inputs at fixed places)) |
| `corpus/built/damaged/load-commands-cut.macho-arm64`  |       | corpus input | E     | generated, binary (corpus/build.mjs (cut from built inputs at fixed places)) |
| `corpus/built/dev/calls-v2.O0.macho-arm64`            |       | corpus input | E     | binary fixture (Apple clang 17, built once with --native)                    |
| `corpus/built/dev/calls-v2.O2.macho-arm64`            |       | corpus input | E     | binary fixture (Apple clang 17, built once with --native)                    |
| `corpus/built/dev/calls.O0.macho-arm64`               |       | corpus input | E     | binary fixture (Apple clang 17, built once with --native)                    |
| `corpus/built/dev/calls.O2.macho-arm64`               |       | corpus input | E     | binary fixture (Apple clang 17, built once with --native)                    |
| `corpus/built/dev/notes-app-v2.plain.asar`            |       | corpus input | E     | generated, binary (corpus/build.mjs (esbuild 0.28.2 + @electron/asar 4.3.1)) |
| `corpus/built/dev/notes-app.bundled.asar`             |       | corpus input | E     | generated, binary (corpus/build.mjs (esbuild 0.28.2 + @electron/asar 4.3.1)) |
| `corpus/built/dev/notes-app.minified.asar`            |       | corpus input | E     | generated, binary (corpus/build.mjs (esbuild 0.28.2 + @electron/asar 4.3.1)) |
| `corpus/built/dev/notes-app.plain.asar`               |       | corpus input | E     | generated, binary (corpus/build.mjs (esbuild 0.28.2 + @electron/asar 4.3.1)) |
| `corpus/built/holdout/exprcalc.O0.macho-arm64`        |       | corpus input | E     | binary fixture (Apple clang 17, built once with --native)                    |
| `corpus/built/holdout/exprcalc.O2.macho-arm64`        |       | corpus input | E     | binary fixture (Apple clang 17, built once with --native)                    |
| `corpus/built/holdout/time-tracker-v2.plain.asar`     |       | corpus input | E     | generated, binary (corpus/build.mjs (esbuild 0.28.2 + @electron/asar 4.3.1)) |
| `corpus/built/holdout/time-tracker.bundled.asar`      |       | corpus input | E     | generated, binary (corpus/build.mjs (esbuild 0.28.2 + @electron/asar 4.3.1)) |
| `corpus/built/holdout/time-tracker.minified.asar`     |       | corpus input | E     | generated, binary (corpus/build.mjs (esbuild 0.28.2 + @electron/asar 4.3.1)) |
| `corpus/built/holdout/time-tracker.plain.asar`        |       | corpus input | E     | generated, binary (corpus/build.mjs (esbuild 0.28.2 + @electron/asar 4.3.1)) |
| `corpus/built/holdout2/markdown-editor-v2.plain.asar` |       | corpus input | E     | generated, binary (corpus/build.mjs (esbuild 0.28.2 + @electron/asar 4.3.1)) |
| `corpus/built/holdout2/markdown-editor.bundled.asar`  |       | corpus input | E     | generated, binary (corpus/build.mjs (esbuild 0.28.2 + @electron/asar 4.3.1)) |
| `corpus/built/holdout2/markdown-editor.minified.asar` |       | corpus input | E     | generated, binary (corpus/build.mjs (esbuild 0.28.2 + @electron/asar 4.3.1)) |
| `corpus/built/holdout2/markdown-editor.plain.asar`    |       | corpus input | E     | generated, binary (corpus/build.mjs (esbuild 0.28.2 + @electron/asar 4.3.1)) |
| `corpus/built/holdout2/music-player.bundled.asar`     |       | corpus input | E     | generated, binary (corpus/build.mjs (esbuild 0.28.2 + @electron/asar 4.3.1)) |
| `corpus/built/holdout2/music-player.minified.asar`    |       | corpus input | E     | generated, binary (corpus/build.mjs (esbuild 0.28.2 + @electron/asar 4.3.1)) |
| `corpus/built/holdout2/music-player.plain.asar`       |       | corpus input | E     | generated, binary (corpus/build.mjs (esbuild 0.28.2 + @electron/asar 4.3.1)) |
| `corpus/built/holdout3/podcast-player-v2.plain.asar`  |       | corpus input | E     | generated, binary (corpus/build.mjs (esbuild 0.28.2 + @electron/asar 4.3.1)) |
| `corpus/built/holdout3/podcast-player.bundled.asar`   |       | corpus input | E     | generated, binary (corpus/build.mjs (esbuild 0.28.2 + @electron/asar 4.3.1)) |
| `corpus/built/holdout3/podcast-player.minified.asar`  |       | corpus input | E     | generated, binary (corpus/build.mjs (esbuild 0.28.2 + @electron/asar 4.3.1)) |
| `corpus/built/holdout3/podcast-player.plain.asar`     |       | corpus input | E     | generated, binary (corpus/build.mjs (esbuild 0.28.2 + @electron/asar 4.3.1)) |
| `corpus/built/holdout4/kanban-board-v2.plain.asar`    |       | corpus input | E     | generated, binary (corpus/build.mjs (esbuild 0.28.2 + @electron/asar 4.3.1)) |
| `corpus/built/holdout4/kanban-board.bundled.asar`     |       | corpus input | E     | generated, binary (corpus/build.mjs (esbuild 0.28.2 + @electron/asar 4.3.1)) |
| `corpus/built/holdout4/kanban-board.minified.asar`    |       | corpus input | E     | generated, binary (corpus/build.mjs (esbuild 0.28.2 + @electron/asar 4.3.1)) |
| `corpus/built/holdout4/kanban-board.plain.asar`       |       | corpus input | E     | generated, binary (corpus/build.mjs (esbuild 0.28.2 + @electron/asar 4.3.1)) |
| `corpus/built/validation/chat-app-v2.plain.asar`      |       | corpus input | E     | generated, binary (corpus/build.mjs (esbuild 0.28.2 + @electron/asar 4.3.1)) |
| `corpus/built/validation/chat-app.bundled.asar`       |       | corpus input | E     | generated, binary (corpus/build.mjs (esbuild 0.28.2 + @electron/asar 4.3.1)) |
| `corpus/built/validation/chat-app.minified.asar`      |       | corpus input | E     | generated, binary (corpus/build.mjs (esbuild 0.28.2 + @electron/asar 4.3.1)) |
| `corpus/built/validation/chat-app.plain.asar`         |       | corpus input | E     | generated, binary (corpus/build.mjs (esbuild 0.28.2 + @electron/asar 4.3.1)) |
| `corpus/built/validation/dispatch.O0.macho-arm64`     |       | corpus input | E     | binary fixture (Apple clang 17, built once with --native)                    |
| `corpus/built/validation/dispatch.O2.macho-arm64`     |       | corpus input | E     | binary fixture (Apple clang 17, built once with --native)                    |

### corpus results (generated measurements) (92)

| path                                                                        | lines | role                                                         | owner | status                                                                            |
| --------------------------------------------------------------------------- | ----: | ------------------------------------------------------------ | ----- | --------------------------------------------------------------------------------- |
| `corpus/compare/results/agent-eval/2026-10-14-allow-read.jsonl`             |    10 | measured result                                              | E     | generated (corpus/compare/* scripts (run-all.sh, score-all.mjs, summarize.mjs))   |
| `corpus/compare/results/agent-eval/2026-10-14.jsonl`                        |    20 | measured result                                              | E     | generated (corpus/compare/* scripts (run-all.sh, score-all.mjs, summarize.mjs))   |
| `corpus/compare/results/answers/cli.blocked.json`                           |    93 | measured result                                              | E     | generated (corpus/compare/* scripts (run-all.sh, score-all.mjs, summarize.mjs))   |
| `corpus/compare/results/answers/cli.hexvero.default.json`                   |  4850 | measured result                                              | E     | generated (corpus/compare/* scripts (run-all.sh, score-all.mjs, summarize.mjs))   |
| `corpus/compare/results/answers/cli.rea.complete.json`                      |  2321 | measured result                                              | E     | generated (corpus/compare/* scripts (run-all.sh, score-all.mjs, summarize.mjs))   |
| `corpus/compare/results/answers/cli.rea.filtered.json`                      |  2103 | measured result                                              | E     | generated (corpus/compare/* scripts (run-all.sh, score-all.mjs, summarize.mjs))   |
| `corpus/compare/results/answers/cli.rea.summary.json`                       |   322 | measured result                                              | E     | generated (corpus/compare/* scripts (run-all.sh, score-all.mjs, summarize.mjs))   |
| `corpus/compare/results/answers/mcp.blocked.json`                           |   243 | measured result                                              | E     | generated (corpus/compare/* scripts (run-all.sh, score-all.mjs, summarize.mjs))   |
| `corpus/compare/results/answers/mcp.hexvero.default.json`                   |  2508 | measured result                                              | E     | generated (corpus/compare/* scripts (run-all.sh, score-all.mjs, summarize.mjs))   |
| `corpus/compare/results/answers/mcp.rea.complete.json`                      |    73 | measured result                                              | E     | generated (corpus/compare/* scripts (run-all.sh, score-all.mjs, summarize.mjs))   |
| `corpus/compare/results/answers/mcp.rea.export.json`                        |  1741 | measured result                                              | E     | generated (corpus/compare/* scripts (run-all.sh, score-all.mjs, summarize.mjs))   |
| `corpus/compare/results/answers/mcp.rea.summary.json`                       |   287 | measured result                                              | E     | generated (corpus/compare/* scripts (run-all.sh, score-all.mjs, summarize.mjs))   |
| `corpus/compare/results/cli.runs.jsonl`                                     |   730 | measured result                                              | E     | generated (corpus/compare/* scripts (run-all.sh, score-all.mjs, summarize.mjs))   |
| `corpus/compare/results/cost-per-unit.md`                                   |   267 | doc: "Cost per unit"                                         | E     | generated (corpus/compare/* scripts (run-all.sh, score-all.mjs, summarize.mjs))   |
| `corpus/compare/results/environment.json`                                   |   279 | measured result                                              | E     | generated (corpus/compare/* scripts (run-all.sh, score-all.mjs, summarize.mjs))   |
| `corpus/compare/results/hexvero.observations.json`                          |  5884 | measured result                                              | E     | generated (corpus/compare/* scripts (run-all.sh, score-all.mjs, summarize.mjs))   |
| `corpus/compare/results/mcp-catalog.json`                                   |   198 | measured result                                              | E     | generated (corpus/compare/* scripts (run-all.sh, score-all.mjs, summarize.mjs))   |
| `corpus/compare/results/mcp.runs.jsonl`                                     |   730 | measured result                                              | E     | generated (corpus/compare/* scripts (run-all.sh, score-all.mjs, summarize.mjs))   |
| `corpus/compare/results/rea-6.5.0/holdout2.json`                            |  1167 | measured result                                              | E     | generated (corpus/compare/* scripts (run-all.sh, score-all.mjs, summarize.mjs))   |
| `corpus/compare/results/rea-6.5.0/holdout2.md`                              |    90 | doc: "REA 6.5.0 on the hexvero corpus"                       | E     | generated (corpus/compare/* scripts (run-all.sh, score-all.mjs, summarize.mjs))   |
| `corpus/compare/results/rea-6.5.0/mcp-catalog.json`                         |   198 | measured result                                              | E     | generated (corpus/compare/* scripts (run-all.sh, score-all.mjs, summarize.mjs))   |
| `corpus/compare/results/rea-6.5.0/mcp.holdout2.runs.jsonl`                  |    76 | measured result                                              | E     | generated (corpus/compare/* scripts (run-all.sh, score-all.mjs, summarize.mjs))   |
| `corpus/compare/results/rea-6.5.0/other-sets.json`                          |  2699 | measured result                                              | E     | generated (corpus/compare/* scripts (run-all.sh, score-all.mjs, summarize.mjs))   |
| `corpus/compare/results/rea-6.5.0/other-sets.md`                            |   217 | doc: "REA 6.5.0 on the hexvero corpus"                       | E     | generated (corpus/compare/* scripts (run-all.sh, score-all.mjs, summarize.mjs))   |
| `corpus/compare/results/rea-6.5.0/rea.holdout2.observations.json`           |  1908 | measured result                                              | E     | generated (corpus/compare/* scripts (run-all.sh, score-all.mjs, summarize.mjs))   |
| `corpus/compare/results/rea-6.5.0/rea.observations.json`                    |  2946 | measured result                                              | E     | generated (corpus/compare/* scripts (run-all.sh, score-all.mjs, summarize.mjs))   |
| `corpus/compare/results/rea.observations.alt-store.json`                    |  2878 | measured result                                              | E     | generated (corpus/compare/* scripts (run-all.sh, score-all.mjs, summarize.mjs))   |
| `corpus/compare/results/rea.observations.json`                              |  2818 | measured result                                              | E     | generated (corpus/compare/* scripts (run-all.sh, score-all.mjs, summarize.mjs))   |
| `corpus/compare/results/scores/answers/cli.hexvero.default.dev.json`        |   761 | measured result                                              | E     | generated (corpus/compare/* scripts (run-all.sh, score-all.mjs, summarize.mjs))   |
| `corpus/compare/results/scores/answers/cli.hexvero.default.holdout.json`    |  1020 | measured result                                              | E     | generated (corpus/compare/* scripts (run-all.sh, score-all.mjs, summarize.mjs))   |
| `corpus/compare/results/scores/answers/cli.hexvero.default.validation.json` |   759 | measured result                                              | E     | generated (corpus/compare/* scripts (run-all.sh, score-all.mjs, summarize.mjs))   |
| `corpus/compare/results/scores/answers/cli.rea.complete.dev.json`           |   600 | measured result                                              | E     | generated (corpus/compare/* scripts (run-all.sh, score-all.mjs, summarize.mjs))   |
| `corpus/compare/results/scores/answers/cli.rea.complete.holdout.json`       |   808 | measured result                                              | E     | generated (corpus/compare/* scripts (run-all.sh, score-all.mjs, summarize.mjs))   |
| `corpus/compare/results/scores/answers/cli.rea.complete.validation.json`    |   697 | measured result                                              | E     | generated (corpus/compare/* scripts (run-all.sh, score-all.mjs, summarize.mjs))   |
| `corpus/compare/results/scores/answers/cli.rea.filtered.dev.json`           |   518 | measured result                                              | E     | generated (corpus/compare/* scripts (run-all.sh, score-all.mjs, summarize.mjs))   |
| `corpus/compare/results/scores/answers/cli.rea.filtered.holdout.json`       |   714 | measured result                                              | E     | generated (corpus/compare/* scripts (run-all.sh, score-all.mjs, summarize.mjs))   |
| `corpus/compare/results/scores/answers/cli.rea.filtered.validation.json`    |   613 | measured result                                              | E     | generated (corpus/compare/* scripts (run-all.sh, score-all.mjs, summarize.mjs))   |
| `corpus/compare/results/scores/answers/cli.rea.summary.dev.json`            |   473 | measured result                                              | E     | generated (corpus/compare/* scripts (run-all.sh, score-all.mjs, summarize.mjs))   |
| `corpus/compare/results/scores/answers/cli.rea.summary.holdout.json`        |   633 | measured result                                              | E     | generated (corpus/compare/* scripts (run-all.sh, score-all.mjs, summarize.mjs))   |
| `corpus/compare/results/scores/answers/cli.rea.summary.validation.json`     |   543 | measured result                                              | E     | generated (corpus/compare/* scripts (run-all.sh, score-all.mjs, summarize.mjs))   |
| `corpus/compare/results/scores/answers/mcp.hexvero.default.dev.json`        |   761 | measured result                                              | E     | generated (corpus/compare/* scripts (run-all.sh, score-all.mjs, summarize.mjs))   |
| `corpus/compare/results/scores/answers/mcp.hexvero.default.holdout.json`    |  1020 | measured result                                              | E     | generated (corpus/compare/* scripts (run-all.sh, score-all.mjs, summarize.mjs))   |
| `corpus/compare/results/scores/answers/mcp.hexvero.default.validation.json` |   759 | measured result                                              | E     | generated (corpus/compare/* scripts (run-all.sh, score-all.mjs, summarize.mjs))   |
| `corpus/compare/results/scores/answers/mcp.rea.complete.dev.json`           |   518 | measured result                                              | E     | generated (corpus/compare/* scripts (run-all.sh, score-all.mjs, summarize.mjs))   |
| `corpus/compare/results/scores/answers/mcp.rea.complete.holdout.json`       |   630 | measured result                                              | E     | generated (corpus/compare/* scripts (run-all.sh, score-all.mjs, summarize.mjs))   |
| `corpus/compare/results/scores/answers/mcp.rea.complete.validation.json`    |   613 | measured result                                              | E     | generated (corpus/compare/* scripts (run-all.sh, score-all.mjs, summarize.mjs))   |
| `corpus/compare/results/scores/answers/mcp.rea.export.dev.json`             |   518 | measured result                                              | E     | generated (corpus/compare/* scripts (run-all.sh, score-all.mjs, summarize.mjs))   |
| `corpus/compare/results/scores/answers/mcp.rea.export.holdout.json`         |   714 | measured result                                              | E     | generated (corpus/compare/* scripts (run-all.sh, score-all.mjs, summarize.mjs))   |
| `corpus/compare/results/scores/answers/mcp.rea.export.validation.json`      |   613 | measured result                                              | E     | generated (corpus/compare/* scripts (run-all.sh, score-all.mjs, summarize.mjs))   |
| `corpus/compare/results/scores/answers/mcp.rea.summary.dev.json`            |   555 | measured result                                              | E     | generated (corpus/compare/* scripts (run-all.sh, score-all.mjs, summarize.mjs))   |
| `corpus/compare/results/scores/answers/mcp.rea.summary.holdout.json`        |   727 | measured result                                              | E     | generated (corpus/compare/* scripts (run-all.sh, score-all.mjs, summarize.mjs))   |
| `corpus/compare/results/scores/answers/mcp.rea.summary.validation.json`     |   627 | measured result                                              | E     | generated (corpus/compare/* scripts (run-all.sh, score-all.mjs, summarize.mjs))   |
| `corpus/compare/results/scores/hexvero.damaged.json`                        |    93 | measured result                                              | E     | generated (corpus/compare/* scripts (run-all.sh, score-all.mjs, summarize.mjs))   |
| `corpus/compare/results/scores/hexvero.damaged.md`                          |    20 | doc: "hexvero 0.3.0 on the hexvero corpus"                   | E     | generated (corpus/compare/* scripts (run-all.sh, score-all.mjs, summarize.mjs))   |
| `corpus/compare/results/scores/hexvero.dev.json`                            |   694 | measured result                                              | E     | generated (corpus/compare/* scripts (run-all.sh, score-all.mjs, summarize.mjs))   |
| `corpus/compare/results/scores/hexvero.dev.md`                              |    87 | doc: "hexvero 0.3.0 on the hexvero corpus"                   | E     | generated (corpus/compare/* scripts (run-all.sh, score-all.mjs, summarize.mjs))   |
| `corpus/compare/results/scores/hexvero.holdout.json`                        |   867 | measured result                                              | E     | generated (corpus/compare/* scripts (run-all.sh, score-all.mjs, summarize.mjs))   |
| `corpus/compare/results/scores/hexvero.holdout.md`                          |    83 | doc: "hexvero 0.3.0 on the hexvero corpus"                   | E     | generated (corpus/compare/* scripts (run-all.sh, score-all.mjs, summarize.mjs))   |
| `corpus/compare/results/scores/hexvero.validation.json`                     |   652 | measured result                                              | E     | generated (corpus/compare/* scripts (run-all.sh, score-all.mjs, summarize.mjs))   |
| `corpus/compare/results/scores/hexvero.validation.md`                       |    83 | doc: "hexvero 0.3.0 on the hexvero corpus"                   | E     | generated (corpus/compare/* scripts (run-all.sh, score-all.mjs, summarize.mjs))   |
| `corpus/compare/results/scores/rea.alt-store.damaged.json`                  |    91 | measured result                                              | E     | generated (corpus/compare/* scripts (run-all.sh, score-all.mjs, summarize.mjs))   |
| `corpus/compare/results/scores/rea.alt-store.damaged.md`                    |    20 | doc: "REA 6.4.0 on the hexvero corpus"                       | E     | generated (corpus/compare/* scripts (run-all.sh, score-all.mjs, summarize.mjs))   |
| `corpus/compare/results/scores/rea.alt-store.dev.json`                      |   716 | measured result                                              | E     | generated (corpus/compare/* scripts (run-all.sh, score-all.mjs, summarize.mjs))   |
| `corpus/compare/results/scores/rea.alt-store.dev.md`                        |    77 | doc: "REA 6.4.0 on the hexvero corpus"                       | E     | generated (corpus/compare/* scripts (run-all.sh, score-all.mjs, summarize.mjs))   |
| `corpus/compare/results/scores/rea.alt-store.holdout.json`                  |   981 | measured result                                              | E     | generated (corpus/compare/* scripts (run-all.sh, score-all.mjs, summarize.mjs))   |
| `corpus/compare/results/scores/rea.alt-store.holdout.md`                    |    75 | doc: "REA 6.4.0 on the hexvero corpus"                       | E     | generated (corpus/compare/* scripts (run-all.sh, score-all.mjs, summarize.mjs))   |
| `corpus/compare/results/scores/rea.alt-store.validation.json`               |   841 | measured result                                              | E     | generated (corpus/compare/* scripts (run-all.sh, score-all.mjs, summarize.mjs))   |
| `corpus/compare/results/scores/rea.alt-store.validation.md`                 |    75 | doc: "REA 6.4.0 on the hexvero corpus"                       | E     | generated (corpus/compare/* scripts (run-all.sh, score-all.mjs, summarize.mjs))   |
| `corpus/compare/results/scores/rea.damaged.json`                            |    91 | measured result                                              | E     | generated (corpus/compare/* scripts (run-all.sh, score-all.mjs, summarize.mjs))   |
| `corpus/compare/results/scores/rea.damaged.md`                              |    20 | doc: "REA 6.4.0 on the hexvero corpus"                       | E     | generated (corpus/compare/* scripts (run-all.sh, score-all.mjs, summarize.mjs))   |
| `corpus/compare/results/scores/rea.dev.json`                                |   722 | measured result                                              | E     | generated (corpus/compare/* scripts (run-all.sh, score-all.mjs, summarize.mjs))   |
| `corpus/compare/results/scores/rea.dev.md`                                  |    77 | doc: "REA 6.4.0 on the hexvero corpus"                       | E     | generated (corpus/compare/* scripts (run-all.sh, score-all.mjs, summarize.mjs))   |
| `corpus/compare/results/scores/rea.holdout.json`                            |  1002 | measured result                                              | E     | generated (corpus/compare/* scripts (run-all.sh, score-all.mjs, summarize.mjs))   |
| `corpus/compare/results/scores/rea.holdout.md`                              |    75 | doc: "REA 6.4.0 on the hexvero corpus"                       | E     | generated (corpus/compare/* scripts (run-all.sh, score-all.mjs, summarize.mjs))   |
| `corpus/compare/results/scores/rea.validation.json`                         |   853 | measured result                                              | E     | generated (corpus/compare/* scripts (run-all.sh, score-all.mjs, summarize.mjs))   |
| `corpus/compare/results/scores/rea.validation.md`                           |    75 | doc: "REA 6.4.0 on the hexvero corpus"                       | E     | generated (corpus/compare/* scripts (run-all.sh, score-all.mjs, summarize.mjs))   |
| `corpus/results/hexvero.json`                                               |  4078 | measured result                                              | E     | generated (corpus/observe-hexvero.mjs + corpus/score.mjs (npm run corpus:accept)) |
| `corpus/results/hexvero.md`                                                 |   418 | doc: "hexvero 0.7.4 on the hexvero corpus"                   | E     | generated (corpus/observe-hexvero.mjs + corpus/score.mjs (npm run corpus:accept)) |
| `corpus/results/hexvero.observations.json`                                  | 11754 | measured result                                              | E     | generated (corpus/observe-hexvero.mjs + corpus/score.mjs (npm run corpus:accept)) |
| `corpus/results/round1/hexvero.observations.json`                           |  3139 | measured result                                              | E     | generated (corpus/observe-hexvero.mjs + corpus/score.mjs (npm run corpus:accept)) |
| `corpus/results/round1/hexvero.validation.json`                             |   771 | measured result                                              | E     | generated (corpus/observe-hexvero.mjs + corpus/score.mjs (npm run corpus:accept)) |
| `corpus/results/round1/hexvero.validation.md`                               |    83 | doc: "hexvero 0.3.0 on the hexvero corpus"                   | E     | generated (corpus/observe-hexvero.mjs + corpus/score.mjs (npm run corpus:accept)) |
| `corpus/results/round2/hexvero.holdout.json`                                |   864 | measured result                                              | E     | generated (corpus/observe-hexvero.mjs + corpus/score.mjs (npm run corpus:accept)) |
| `corpus/results/round2/hexvero.holdout.md`                                  |    83 | doc: "hexvero 0.3.0 on the hexvero corpus"                   | E     | generated (corpus/observe-hexvero.mjs + corpus/score.mjs (npm run corpus:accept)) |
| `corpus/results/round2/hexvero.observations.json`                           |  5881 | measured result                                              | E     | generated (corpus/observe-hexvero.mjs + corpus/score.mjs (npm run corpus:accept)) |
| `corpus/results/round3/README.md`                                           |    30 | doc: "Round 3: blind measurement on `holdout2` (2026-10-14)" | E     | generated (corpus/observe-hexvero.mjs + corpus/score.mjs (npm run corpus:accept)) |
| `corpus/results/round3/holdout2.after.json`                                 |   965 | measured result                                              | E     | generated (corpus/observe-hexvero.mjs + corpus/score.mjs (npm run corpus:accept)) |
| `corpus/results/round3/holdout2.after.md`                                   |    90 | doc: "hexvero 0.3.0 on the hexvero corpus"                   | E     | generated (corpus/observe-hexvero.mjs + corpus/score.mjs (npm run corpus:accept)) |
| `corpus/results/round3/holdout2.after.observations.json`                    |  8311 | measured result                                              | E     | generated (corpus/observe-hexvero.mjs + corpus/score.mjs (npm run corpus:accept)) |
| `corpus/results/round3/holdout2.before.json`                                |   965 | measured result                                              | E     | generated (corpus/observe-hexvero.mjs + corpus/score.mjs (npm run corpus:accept)) |
| `corpus/results/round3/holdout2.before.md`                                  |    90 | doc: "hexvero 0.3.0 on the hexvero corpus"                   | E     | generated (corpus/observe-hexvero.mjs + corpus/score.mjs (npm run corpus:accept)) |
| `corpus/results/round3/holdout2.before.observations.json`                   |  8168 | measured result                                              | E     | generated (corpus/observe-hexvero.mjs + corpus/score.mjs (npm run corpus:accept)) |

### docs/rea-compare: measurement scripts and plans (18)

| path                                          | lines | role                                                                                 | owner | status      |
| --------------------------------------------- | ----: | ------------------------------------------------------------------------------------ | ----- | ----------- |
| `docs/rea-compare/README.md`                  |    57 | doc: "REA comparison scripts"                                                        | F     | inventoried |
| `docs/rea-compare/count-tokens.mjs`           |    22 | o200k_base token count of files (from header comment)                                | F     | inventoried |
| `docs/rea-compare/demo.c`                     |    22 | C input for the REA comparison                                                       | F     | inventoried |
| `docs/rea-compare/env.sh`                     |     7 | environment for the comparison scripts (from header comment)                         | F     | inventoried |
| `docs/rea-compare/mcp-catalog.mjs`            |    83 | MCP catalog size over stdio (from header comment)                                    | F     | inventoried |
| `docs/rea-compare/mcp-task.mjs`               |    94 | drives an MCP server through a plan, records latency and bytes (from header comment) | F     | inventoried |
| `docs/rea-compare/measure.mjs`                |   113 | runs a command under /usr/bin/time -l and records wall, RSS (from header comment)    | F     | inventoried |
| `docs/rea-compare/mkinput.mjs`                |    14 | builds REA CLI input files (from header comment)                                     | F     | inventoried |
| `docs/rea-compare/plans/t1-hexvero.json`      |     4 | MCP call plan, task 1, hexvero                                                       | F     | inventoried |
| `docs/rea-compare/plans/t1-rea-complete.json` |     6 | MCP call plan, task 1, REA complete                                                  | F     | inventoried |
| `docs/rea-compare/plans/t1-rea-summary.json`  |    16 | MCP call plan, task 1, REA summary                                                   | F     | inventoried |
| `docs/rea-compare/plans/t3-hexvero.json`      |    12 | MCP call plan, task 3, hexvero                                                       | F     | inventoried |
| `docs/rea-compare/plans/t3-rea.json`          |    23 | MCP call plan, task 3, REA                                                           | F     | inventoried |
| `docs/rea-compare/rea-extract.mjs`            |   109 | reduces REA evidence JSON to benchmark facts (from header comment)                   | F     | inventoried |
| `docs/rea-compare/run-large-rea.sh`           |    12 | REA on one large app.asar (from header comment)                                      | F     | inventoried |
| `docs/rea-compare/run-large.sh`               |    21 | large real app.asar measurements (from header comment)                               | F     | inventoried |
| `docs/rea-compare/run-small.sh`               |    36 | small task measurements, both tools (from header comment)                            | F     | inventoried |
| `docs/rea-compare/summarize.mjs`              |    35 | prints one Markdown row per measured step (from header comment)                      | F     | inventoried |

### docs (58)

| path                                        | lines | role                                                                                              | owner | status                                                                   |
| ------------------------------------------- | ----: | ------------------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------ |
| `docs/ARCHITECTURE-PLAN.md`                 |   205 | doc                                                                                               | F     | inventoried                                                              |
| `docs/audits/agent-integration-audit.md`    |   106 | doc: "Agent integration audit"                                                                    | F     | inventoried                                                              |
| `docs/audits/agent-task-evaluation.md`      |    93 | doc: "Agent task evaluation (2026-10-14)"                                                         | F     | inventoried                                                              |
| `docs/audits/competitive-gap-analysis.md`   |   160 | doc: "Competitive gap analysis: hexvero and REA"                                                  | F     | inventoried                                                              |
| `docs/audits/developer-experience-audit.md` |    71 | doc: "Developer experience audit"                                                                 | F     | inventoried                                                              |
| `docs/audits/domain-check.md`               |    44 | doc: "Domain, DNS, HTTPS and GitHub Pages (checked 2026-10-14, rechecked the same evening: uncha" | F     | inventoried                                                              |
| `docs/audits/security-review.md`            |    49 | doc: "Security review (round 4, 2026-10-14; P3 items updated the same day)"                       | F     | inventoried                                                              |
| `docs/banner-dark.svg`                      |    67 | image/video asset                                                                                 | F     | inventoried                                                              |
| `docs/banner-light.svg`                     |    67 | image/video asset                                                                                 | F     | inventoried                                                              |
| `docs/benchmarks.md`                        |   193 | doc: "Benchmarks"                                                                                 | F     | inventoried                                                              |
| `docs/cli.md`                               |   166 | doc: "CLI reference"                                                                              | F     | inventoried                                                              |
| `docs/competitive/rea-scorecard.md`         |   147 | doc: "hexvero and REA: scorecard"                                                                 | F     | inventoried                                                              |
| `docs/demo/agent-session.md`                |   278 | doc: "An agent investigation, call by call"                                                       | F     | generated (scripts/demo-agent.mjs)                                       |
| `docs/demo/analyze.png`                     |       | image/video asset                                                                                 | F     | binary asset                                                             |
| `docs/demo/compare.gif`                     |       | image/video asset                                                                                 | F     | generated, binary (vhs docs/demo/*.tape)                                 |
| `docs/demo/compare.mp4`                     |       | image/video asset                                                                                 | F     | generated, binary (vhs docs/demo/*.tape)                                 |
| `docs/demo/compare.tape`                    |    33 | vhs tape that records docs/demo/compare.gif/.mp4                                                  | F     | inventoried                                                              |
| `docs/demo/demo.gif`                        |       | image/video asset                                                                                 | F     | generated, binary (vhs docs/demo/*.tape)                                 |
| `docs/demo/demo.tape`                       |    38 | vhs tape that records docs/demo/demo.gif                                                          | F     | inventoried                                                              |
| `docs/demo/electron-ipc.md`                 |    74 | doc: "Map an Electron app's IPC surface without running it"                                       | F     | inventoried                                                              |
| `docs/demo/native.gif`                      |       | image/video asset                                                                                 | F     | generated, binary (vhs docs/demo/*.tape)                                 |
| `docs/demo/native.tape`                     |    33 | vhs tape that records docs/demo/native.gif                                                        | F     | inventoried                                                              |
| `docs/electron-findings.md`                 |   112 | doc: "Electron findings: conditions and sources"                                                  | F     | inventoried                                                              |
| `docs/engineering/8h-mission-progress.md`   |   216 | doc: "Product differentiation mission: progress"                                                  | Lead  | inventoried                                                              |
| `docs/engineering/contracts.md`             |   153 | doc: "Sprint contracts (frozen 2026-10-17 by the lead)"                                           | Lead  | read                                                                     |
| `docs/engineering/sprint-status.md`         |    48 | doc: "Sprint status: 10-hour sprint "know what changed inside your Electron release""             | Lead  | read                                                                     |
| `docs/growth/90-day-roadmap.md`             |    73 | doc: "90-day roadmap"                                                                             | F     | inventoried                                                              |
| `docs/growth/launch-strategy.md`            |   133 | doc: "Launch strategy"                                                                            | F     | inventoried                                                              |
| `docs/growth/overnight-log.md`              |   120 | doc: "Overnight log (2026-10-14/15)"                                                              | F     | inventoried                                                              |
| `docs/launch/README.md`                     |    42 | doc: "Launch kit: "Know what changed inside your app""                                            | F     | read                                                                     |
| `docs/launch/article.md`                    |    96 | doc: "What changed in this Electron update? Reading two builds without running either"            | F     | inventoried                                                              |
| `docs/launch/assets/social-preview.html`    |   102 | HTML source rendered into docs/social-preview.png                                                 | F     | inventoried                                                              |
| `docs/launch/before/before-ui-overview.png` |       | image/video asset                                                                                 | F     | binary asset                                                             |
| `docs/launch/before/before-ui-start.png`    |       | image/video asset                                                                                 | F     | binary asset                                                             |
| `docs/launch/channels.md`                   |    17 | doc: "Channels"                                                                                   | F     | inventoried                                                              |
| `docs/launch/faq.md`                        |    50 | doc: "FAQ"                                                                                        | F     | inventoried                                                              |
| `docs/launch/plan.md`                       |    28 | doc: "Seven-day plan and signals"                                                                 | F     | inventoried                                                              |
| `docs/launch/positioning.md`                |    52 | doc: "Positioning (one page)"                                                                     | F     | inventoried                                                              |
| `docs/launch/posts.md`                      |    75 | doc: "Posts (drafts, not posted)"                                                                 | F     | inventoried                                                              |
| `docs/launch/published/devto.md`            |    81 | doc: "1. Two builds, one command"                                                                 | F     | inventoried                                                              |
| `docs/launch/release-notes-0.8.0.md`        |    48 | doc: "hexvero 0.8.0: know what changed inside your app"                                           | F     | inventoried                                                              |
| `docs/logo-mark.svg`                        |     1 | image/video asset                                                                                 | F     | inventoried                                                              |
| `docs/logo.svg`                             |     1 | image/video asset                                                                                 | F     | inventoried                                                              |
| `docs/mcp.md`                               |    87 | doc: "MCP server"                                                                                 | F     | inventoried                                                              |
| `docs/release-checklist.md`                 |    29 | doc: "Release checklist (0.4.0)"                                                                  | F     | read                                                                     |
| `docs/screenshots/ui-compare-phone.png`     |       | image/video asset                                                                                 | F     | binary asset                                                             |
| `docs/screenshots/ui-compare.png`           |       | image/video asset                                                                                 | F     | binary asset                                                             |
| `docs/screenshots/ui-graph.png`             |       | image/video asset                                                                                 | F     | binary asset                                                             |
| `docs/screenshots/ui-hex.png`               |       | image/video asset                                                                                 | F     | binary asset                                                             |
| `docs/screenshots/ui-overview.png`          |       | image/video asset                                                                                 | F     | binary asset                                                             |
| `docs/screenshots/ui-source.png`            |       | image/video asset                                                                                 | F     | binary asset                                                             |
| `docs/screenshots/ui-start.png`             |       | image/video asset                                                                                 | F     | binary asset                                                             |
| `docs/social-preview.png`                   |       | image/video asset                                                                                 | F     | generated, binary (rendered from docs/launch/assets/social-preview.html) |
| `docs/strategy/differentiation.md`          |    73 | doc: "Differentiation: hexvero, REA and Electronegativity"                                        | F     | inventoried                                                              |
| `docs/strategy/positioning.md`              |    39 | doc: "Positioning"                                                                                | F     | inventoried                                                              |
| `docs/use-cases/electron-interface-map.md`  |    57 | doc: "Electron interface map"                                                                     | F     | inventoried                                                              |
| `docs/use-cases/release-interface-diff.md`  |    76 | doc: "What changed in the interface between two builds"                                           | F     | inventoried                                                              |
| `docs/video/hexvero.mp4`                    |       | image/video asset                                                                                 | F     | binary asset                                                             |
