# Product differentiation mission: progress

Started 2026-10-15 06:54 CEST on branch `mission/evidence-first` from `main` at `e50c4b3`
(0.6.2). Times are local (CEST). Owner's authorization in the session: merging and releasing are
allowed.

## Phase 1: audit and positioning (06:54–07:05)

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

## Phase 2: evidence contract (07:05–07:15)

- Export fields added (format stays `hexvero: 1`); semantics in [`docs/cli.md`](../cli.md#what-an-export-and-a-comparison-promise):
  found, not found, not analyzed, unresolved.
- Determinism test: two fresh sessions export the same input byte-identically, apart from the
  fields named in `volatile`.
- Security review of untrusted input (existing protections verified, nothing changed):
  `recover` writes only into a new or empty directory, refuses paths outside it, and never
  overwrites; ZIP inflation has a per-archive budget; ASAR offsets are bounds-checked; MCP
  results carry an untrusted-content marker, and the server instructions say target text is
  data.

## Phase 3: Electron interface map (07:15–07:35)

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

## Phase 4: comparison (07:35–07:45)

- Fixes 1–3 above. `interfaces` is matched by `file+api+member`, with lines (including the ends'
  lines) treated as positions.
- The overview lists `windowChanges`: derived window settings that changed what a page may do,
  each marked more permissive, less permissive or unclear. They are facts to review, not
  findings. NotesDesk 1.4.0 → 1.5.0: `nodeIntegrationInEffect on → off`, `sandboxInEffect
  off → on` (both less permissive).

## Regression check (07:50)

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

## Remaining

- Use-case pages, positioning, and a fresh blind evaluation set (phases 5 and 7).
