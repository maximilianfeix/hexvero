# Product differentiation mission: progress

Started 2026-10-15 06:54 CEST. Phase times below come from commit and PR timestamps (an earlier
version of this file had estimated times that ran ahead of the clock) on branch `mission/evidence-first` from `main` at `e50c4b3`
(0.6.2). Times are local (CEST). Owner's authorization in the session: merging and releasing are
allowed.

## Phase 1: audit and positioning (06:54–07:00)

- Repository state: 0.6.2 is the latest tag, npm `latest` and MCP registry `isLatest`; no open
  PRs; one open issue (#84, Windows with a real radare2, not testable here).
- Existing work found and not repeated: `docs/audits/competitive-gap-analysis.md` (measured
  comparison with REA), `docs/audits/security-review.md`, coverage-aware `compare`
  (`unknown` items), the unknowns ledger, `_meta` untrusted-content marking in MCP results.
- New: [`docs/strategy/differentiation.md`](../strategy/differentiation.md), from REA 6.5.0's,
  Electronegativity's and Electron's current documentation. REA has version comparison of
  application graphs and Evidence bundles, so build diffs alone are not presented as unique.

### Top five weaknesses found, ranked

1. **False removals in `compare` past 2,000 items** (P1). Each side was cut at 2,000 items, and
   anything beyond the other side's cut counted as added or removed. Reproduced: two captures with
   the same 2,500 requests in opposite order showed 500 removed and 500 added. **Fixed.**
2. **`compare … ipc` treated moved calls as removed and added** (P1). The identity included the
   line. notes-app v1 → v2: 14 added / 14 removed, where 2 / 2 is the truth. **Fixed.**
3. **CLI, MCP and the overview each had their own copy of the comparison call** (P1). They could
   drift apart. **Fixed**: `Session.compareCollection` is the one implementation.
4. **A single JS file hid unresolved IPC channels** (P0). The row had `channel: null`, but the
   analysis claimed no limitation, unlike a directory. **Fixed.**
5. **Exports didn't say which version produced them, or whether they were whole** (P1).
   `complete` had to be inferred from `limitations`. **Fixed**: `generator`, `complete`,
   `incomplete`, `volatile`.

Further items, not done: an ipc compare on a single file (rows without `module`) falls back to
full-content matching, so moved calls show as removed and added there. Real minified apps with
generated IPC (Claude's `$eipc_message$…` channels) leave every interface row `unresolved`.
`compareAll` had no test before this work.

## Phase 2: evidence contract (07:00–07:05)

- Export fields added (format stays `hexvero: 1`); semantics in [`docs/cli.md`](../cli.md#what-an-export-and-a-comparison-promise):
  found, not found, not analyzed, unresolved.
- Determinism test: two fresh sessions export the same input byte-identically, apart from the
  fields named in `volatile`.
- Security review of untrusted input (existing protections verified, nothing changed):
  `recover` writes only into a new or empty directory, refuses paths outside it, and never
  overwrites; ZIP inflation has a per-archive budget; ASAR offsets are bounds-checked; MCP
  results carry an untrusted-content marker, and the server instructions say target text is
  data.

## Phase 3: Electron interface map (07:05–07:13)

- New collection `interfaces`: contextBridge member → windows that load its preload →
  main-process ends of the same channel (file, line, api), with `link` = direct / resolved /
  unresolved / unknown / none. Joined on exact names only, so it makes no heuristic links.
- Scored against a join derived from the corpus ground truth (contextBridge member → channel,
  ipcChannels → files). All 15 Electron inputs are development sets, so these are not blind
  numbers:

  | Input set                           | Members with a channel | Linked to the right file | Unknown / unresolved | Missing row | False links |
  | ----------------------------------- | ---------------------- | ------------------------ | -------------------- | ----------- | ----------- |
  | dev notes-app (3 builds)            | 15                     | 15                       | 0                    | 0           | 0           |
  | holdout time-tracker (3 builds)     | 60                     | 26                       | 25                   | 9           | 0           |
  | holdout2 markdown-editor (3 builds) | 66                     | 54                       | 6                    | 6           | 0           |
  | holdout2 music-player (3 builds)    | 60                     | 39                       | 21                   | 0           | 0           |
  | validation chat-app (3 builds)      | 33                     | 33                       | 0                    | 0           | 0           |

  The chat-app count treats `renderer-settings.js` (a renderer that calls `ipcRenderer` itself)
  as not an end of a preload member, which is correct. "Missing row" means the contextBridge
  reader did not see the member at all, which is the existing bridge accuracy.

- Claude desktop (real app): 100 rows, all `unresolved`. Its channels are generated at run time,
  so nothing is linked and nothing is invented.

## Phase 4: comparison (07:13–07:15)

- Fixes 1–3 above. `interfaces` is matched by `file+api+member`, with lines (including the ends'
  lines) treated as positions.
- The overview lists `windowChanges`: derived window settings that changed what a page may do,
  each marked more permissive, less permissive or unclear. They are facts to review, not
  findings. NotesDesk 1.4.0 → 1.5.0: `nodeIntegrationInEffect on → off`, `sandboxInEffect
  off → on` (both less permissive).

## Regression check (07:16–07:18)

- `npm run check`, the corpus gate (226 rows, none worse), e2e (11) and the build check all pass.
- Full exports of 40 inputs (Claude, Discord, Discord core, two Electron Fiddle builds, Electron
  API Demos, NotesDesk and the whole corpus), main vs this branch: the analyses are identical in
  all 40. The only differences are the new top-level export fields.

## Phase 6 note: "zero tools" in an MCP directory

- `npx -y hexvero@0.6.2 mcp` answers `initialize` and lists 15 tools over stdio (checked
  07:52).
- The official registry entry (0.6.2, `isLatest`) has no tool list; its schema doesn't carry
  one. A directory that shows only registry metadata will show 0 tools whatever the server does.
  No listing showing 0 was found by search, so the directory couldn't be identified; the cause is
  not in hexvero's package or server. Status: NOT REPRODUCED.

## Merged and released (07:21–07:41)

- PR #113 (07:21), #114 docs (07:31), #115 stored scans (07:33). Release 0.7.0 at 07:41: npm
  with provenance, GitHub release, MCP registry 0.7.0 with the new description. CI was green on
  Linux (Node 22 and 24), macOS and Windows for every PR.

## Phase 5: performance and a new blind set (07:25–07:58)

Apple M2, 8 cores, Node 25.2.1, empty cache per run, `/usr/bin/time -l`:

| Command                               | Wall time | Peak RSS | Output |
| ------------------------------------- | --------- | -------- | ------ |
| `--version` (startup)                 | 0.16 s    | 75 MB    |        |
| `analyze` NotesDesk 1.4.0 (6 KB)      | 0.17 s    | 84 MB    | 14 KB  |
| `analyze` Discord `app.asar` (3.6 MB) | 0.98 s    | 230 MB   | 22 KB  |
| `analyze` Claude `app.asar` (47 MiB)  | 10.19 s   | 776 MB   | 52 KB  |
| `analyze` Claude again, 0.7.0         | 8.00 s    | 819 MB   |        |
| `analyze` Claude again, after #115    | 0.3–1.0 s | 179 MB   |        |
| `compare` NotesDesk overview          | 0.71 s    | 99 MB    |        |
| `compare` Claude vs Discord overview  | 8.48 s    | 928 MB   | 4 KB   |

Wall times on this machine vary by about ±20 % between runs. The repeat run on 0.7.0 shows that a
whole scan was not reused; #115 stores it for apps with 1 MiB of JavaScript or more. Comparing
cold and warm exports found a second defect: a cap met in an earlier run (`ipc_open_calls_capped`)
was lost from a continued scan. Fixed in the same PR. Afterwards, cold and warm exports of six
real apps are byte-identical apart from timing fields.

**Blind set holdout3.** One independent agent wrote a podcast app (two preloads, three windows)
and its expectations. It could read only the corpus format files, and it saw no hexvero code or
output. The expectations were committed (`b58f97d`, 07:42) before any run. 0.7.0 was scored once
(07:43); the full table is in `corpus/holdout3/README.md`. The headline numbers: bridge members
**0/26**, endpoints 4/7 with **2 false**, channels 16/23, senders and receivers 24/33, storage
9/9 with 0 false.

The fixes (PR #116, 07:58) are general idioms, each with a unit test: `Object.freeze` /
`Object.assign` bridge values, static class fields as constants, `module.exports = { ...mod }`,
loops over pair lists and Maps, and `event.reply` with constants. Afterwards, with holdout3 now a
development set: bridge 26/26, channels 23/23, senders and receivers 46/47, endpoints 6/7 with
0 false, v1 → v2 changes 8/8, and interface links 23/26 exact with 0 false ends. The real apps
are unchanged, and holdout gained one correct sender.

## Phase 6: developer experience

- The large-app re-scan above was the biggest first-run cost on real apps; it is fixed.
- MCP "zero tools": not reproduced (see the note above).
- The CI recipe is documented in [`docs/use-cases/release-interface-diff.md`](../use-cases/release-interface-diff.md#in-ci).
  `compare` keeps exit code 0, and any gate is the pipeline's own choice made from the JSON.
- Cross-platform: CI passes on Linux, macOS and Windows. A Windows run with a real radare2 is
  still untested (issue #84).

## Phase 7: visible differentiation

- [`docs/strategy/positioning.md`](../strategy/positioning.md),
  [`docs/use-cases/electron-interface-map.md`](../use-cases/electron-interface-map.md) and
  [`docs/use-cases/release-interface-diff.md`](../use-cases/release-interface-diff.md) were
  built from real CLI output on the NotesDesk example.
- The new tagline is in the README, packages, registry, plugin, website title and meta, and
  `llms.txt`.
- An X post for 0.7.0 went out at 07:57: https://x.com/44errrr/status/2110610883516756308.

## After 0.7.0 (07:58–09:36)

Releases, all published to npm with provenance, as GitHub releases and to the MCP registry by
the workflow:

| Version | Time  | What                                                                                                                                                                 |
| ------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0.7.1   | 08:15 | holdout3 fixes (bridge `Object.freeze`/`Object.assign`, static class constants, spread re-exports, pair-list loops), esbuild wrappers and minified declaration lists |
| 0.7.2   | 08:31 | 28 false bridge members on Claude removed (a loop variable and reused short names were followed to other objects); stored scans keyed by version                     |
| 0.7.3   | 08:49 | `webPreferences: Object.assign(…)` and frozen bases; corpus scorer scores every key a case lists                                                                     |
| 0.7.4   | 09:26 | windows from a factory of another module (rest parameters, `??`, no windowless duplicates); `new URL(template, base)`                                                |
| 0.7.5   | 09:35 | window bases from other modules, applied at their level and place; `definedIn.line` is a position in `compare`                                                       |

**Blind set holdout4** (kanban app; written by an independent agent; expectations committed at
`514345e` before the run): scored once at 09:05 with the analysis of 0.7.3. Over the three builds:
IPC channels 12/57, bridge member channels 21/66, window settings 36/48 with **4 false**, endpoints
12/21, storage keys 12/18, bridge members 66/66; full table in `corpus/holdout4/README.md`.
After 0.7.4 (now a development set): window settings 44/48 with 0 false, endpoints 15/21. Most of
the missed channels come from `defineChannels("board", [...])`, a channel registry built by a
loop with a regular-expression callback. hexvero does not evaluate that, and the channels stay
unread without any false report.

Current corpus totals (all development sets; false in parentheses):

| Set      | IPC channels | Window settings | Bridge channels | Endpoints | Storage keys |
| -------- | ------------ | --------------- | --------------- | --------- | ------------ |
| holdout  | 64/72 (0)    | 27/33 (0)       | 40/60 (0)       | 36/42 (0) | 51/51 (0)    |
| holdout2 | 118/126 (0)  | 48/63 (0)       | 113/129 (0)     | 54/57 (0) | 53/57 (0)    |
| holdout3 | 69/69 (0)    | 42/42 (0)       | 78/78 (0)       | 18/21 (0) | 27/27 (0)    |
| holdout4 | 12/57 (0)    | 44/48 (0)       | 21/66 (0)       | 15/21 (0) | 12/18 (0)    |

Every change was checked against full exports of six real apps (Claude, Discord, Discord core,
two Electron Fiddle builds, Electron API Demos). The only real-app changes in this phase were
Claude's: 28 false bridge members removed, and 15 settings of two `WebContentsView`s read from
the frozen base they come from (checked in the source).

## Scorecard

| Area                    | Verdict | Evidence                                                                                                  |
| ----------------------- | ------- | --------------------------------------------------------------------------------------------------------- |
| A. Differentiation      | PASS    | positioning and differentiation pages; every claim is mapped to a test or a source                        |
| B. Evidence reliability | PASS    | `complete`/`incomplete`/`volatile` in exports; determinism test; unresolved IPC reported for single files |
| C. Comparison           | PASS    | no added/removed past the 2,000-item cut or for unread files; ipc moves are relocations; tests            |
| D. Electron accuracy    | PARTIAL | 0 false links on 16 corpus inputs; real apps with run-time channels stay `unresolved`                     |
| E. Usability            | PARTIAL | warm runs on large apps fixed; Windows with real engines untested                                         |
| F. Performance          | PASS    | measurements above; the only growth is a ~1 MB cache file for large apps                                  |
| G. Engineering quality  | PASS    | CI green on four platforms; corpus gate 242 rows, none worse                                              |

## Remaining

1. A third independent blind set: holdout3 and holdout4 are development sets now.
2. Static IPC through generated frameworks (Claude's `$eipc_message$_<uuid>_…`): read the
   generator's naming scheme where its parts are literals, or say clearly why a row is
   unresolved.
3. Channel registries built by functions (`defineChannels(area, actions)`) and API clients whose
   base URL comes from a factory closure (holdout4): evaluate pure helper functions with literal
   arguments, bounded, or keep reporting them as unread.
