# Progress

State of the work, written so that a fresh session can continue. Last updated 2026-10-14.

## Round 4: branch `oss/round-4` (on `quality/round-3`, local only)

Not pushed, merged, tagged or published; each needs the maintainer's approval.

- Agent experience: short default `hexvero_analyze` overview (`brief()` in
  `packages/core/src/compact.ts`, `detail: "full"` for the old one), `next` suggestions
  (`packages/core/src/next.ts`), paged `hexvero_compare`, the skill split into a core and
  references, `scripts/context-cost.mjs` (token counts in `docs/benchmarks.md`).
- Setup: `setup --remove`, a plain message when no client is found, differing entries left alone,
  plain JSON edited as text.
- Native first look: hardening and import findings (`nativeFindings` in `analyzers/binary.ts`).
- Security fixes from `docs/audits/security-review.md`: MCP write roots
  (`packages/mcp/src/writePolicy.ts`, `HEXVERO_WRITE_ROOTS`), UI in a worker, device files
  refused, ZIP inflate budget, ASAR header cap, SQLite without sidecars, private cache modes, CSP.
  Open: the P3 items listed there.
- Distribution files: `.claude-plugin/`, `.mcp.json`, `glama.json`, `mcpName`. Nothing submitted
  to any registry.
- Docs: README rebuilt, audits in `docs/audits/`, launch plan and 90-day roadmap in `docs/growth/`
  (drafts only; nothing posted), demos in `docs/demo/`.
- Not done: agent task-success experiment (NOT RUN), Ghidra (NOT RUN, not installed), Linux and
  Windows runs (BLOCKED locally; CI runs them after a push), the integration branch
  `integration/round-3-fixes` in `~/hexvero-integration` is still unreviewed and unmerged.

## Round 3: branch `quality/round-3`

## Where things stand

- Released: 0.3.0 (tag `v0.3.0` on `6feaf0b`, all four npm packages, GitHub release).
- This branch is local only. Nothing of it is pushed, merged, tagged or published; each of those
  needs the maintainer's approval for this round.
- Commits on the branch carry the maintainer's identity (set `GIT_AUTHOR_*` / `GIT_COMMITTER_*`;
  the repository's local git config names someone else).

## What this round added

1. **Corpus with written-down correct results** (`corpus/`, see `corpus/README.md`).
   Sets: `dev`, `validation` (measured blind once as round 1, then used), `holdout` (written
   afterwards, blind), `damaged`. Scorer per class of finding, no total. `corpus/gate.mjs` in CI.
2. **Continued scans of large JavaScript apps**: fixed file order, stored state per input content
   (`packages/core/src/javascript/scanState.ts`), `analyze --continue | --all | --include | --fresh
   | --batch`, MCP `hexvero_analyze { scan, include }`, HTTP `?scan=continue|all`, a notice with
   actions in the UI. `coverage` and `complete` in every result.
3. **Endpoints and storage for Electron apps** from one shared detector
   (`packages/core/src/javascript/candidates.ts`), with file, line, column and `evidence`.
4. **Name resolution** (`packages/core/src/javascript/aliases.ts`): other names for known objects,
   scoped; string constants and tables, also across modules; channel-forwarding helpers; handler
   tables; `event.reply`. Used by IPC, bridge, window-setting and endpoint detection.
5. **Window settings per window**, located structurally (`windowRanges` in
   `packages/core/src/javascript/app.ts`), with override handling for base objects.
6. **Tail calls through radare2** from its jump references (`providers/run.ts`, `graph.ts`,
   `GRAPH_SCHEMA = 6`).
7. **Cut-short binaries** reported (`file_truncated`) for Mach-O, ELF and PE.

## How to check it

```bash
npm run check          # typecheck, lint, format, unit tests, catalog shape
npm run e2e            # real flows: Electron, native via radare2 and rizin, compare, MCP over stdio
npm run corpus         # corpus inputs rebuild to the committed bytes; no result is worse
node scripts/smoke-tarballs.mjs
```

## Measurements

- `corpus/results/round1/`: the blind measurement on `validation` at `9d596ca`.
- `corpus/results/round2/`: the blind measurement on `holdout`, observed at `1ca224b`. The scorer
  was changed three times afterwards (address prefixes in comparisons; stricter storage-operation
  and negative-path rules from the independent review); each time the stored observations were
  scored again, never observed again.
- `corpus/results/hexvero.*`: current result on all sets; regenerate with `npm run corpus:accept`.
- `corpus/compare/`: REA 6.4.0 against hexvero `a6d9b82` on the corpus: harness, mapping
  decisions, raw data of 1,460 runs, `summary.md`. Timings there were taken under load.
- `docs/benchmarks.md`: hexvero's own timings, including the slowdown against 0.3.0.

## Reviews

- An independent review of `6feaf0b..a8985ad` found 4 must-fix and 12 should-fix points. All
  must-fix points and should-fix points 1 to 11 are fixed in `479a916`, each with a test in
  `packages/core/test/completeness.test.ts` or the CLI and MCP tests. Not done: budgets other than
  the batch size over MCP (P2-12 in part), a lock against two processes continuing the same input
  (last writer wins; consistent, but one run's progress is lost), clean-up of old state files, the
  scan request as a GET in the HTTP API.

## A second branch on top of this one

Another session of the maintainer worked in `~/hexvero-integration` on branch
`integration/round-3-fixes` (HEAD `db2d988` when last reported, 17 commits on top of `479a916`,
not pushed). By its own account it adds IPC through `window.x = ipcRenderer` globals and names
shared across sibling files, more window-setting keys with a `windows` collection, `unknown` items
in comparisons and two scorer rules for window settings, tuned on three applications outside the
corpus, and it updates the README demo block and Limits list. It was not reviewed or merged here.
The blind measurement and the REA comparison describe this branch, not that one. Its write-up is
`~/hexvero-campaign-2026-10-13/INTEGRATION-REPORT.md`.

## Open

- **Ghidra: NOT RUN.** It is not installed on the development machine and was not installed
  without asking. hexvero's Ghidra path is covered by fixtures only. To verify: install Ghidra,
  then `npm run e2e` and `node corpus/observe-hexvero.mjs --engines radare2,rizin,ghidra`.
- **Hold-out misses** (see `corpus/README.md`, "Results so far"): about four in ten IPC channels
  and six in ten window settings of the hold-out application are not found. Tuning on that set
  would end its use as a blind measurement; write a new blind set first.
- **Speed**: a JavaScript application takes about 2.3 times as long as in 0.3.0 because of the
  name resolution (`packages/core/src/javascript/aliases.ts`); `docs/benchmarks.md` has the
  numbers. A cheaper design (resolving a name only where one is used) is not started.
- **rizin**: a jump to an import that rizin does not list as a function gives "No function
  matches atoi" instead of a path (hold-out `exprcalc.O2`); radare2 answers it. One false direct
  caller through rizin on `exprcalc.O0`.
- **`hexvero_compare` over MCP** returns at most 50 added or removed and 25 changed items and has
  no paging; the CLI returns all.
- **README demo block and Limits list** on this branch are stale in three places (the radare2
  tail-call line, 5 findings instead of 7, the 5,000-file limit); the integration branch rewrites
  them.
- **Linux and Windows**: the corpus's native inputs are Mach-O arm64 only. Whether the packed
  archives rebuild to the same bytes on Linux is checked by CI (`corpus/build.mjs --check`) but
  has not run yet, because the branch is not pushed.
- **Agent experiment: NOT RUN.** No model budget was authorized, so there is no statement about
  agent success rates or token costs.
- A request whose address comes from a function parameter cannot be read statically and is
  counted as missed. Native `analyze` raises no finding for an imported `system`.
- The UI's partial-analysis notice was checked by hand in Chrome on a 541 MiB archive; there is no
  automated browser test.

## Next steps a maintainer may want

1. Decide how the two branches go together (this one alone, or with the integration branch on
   top), then push and open a pull request. CI will run the corpus checks on Linux and macOS for
   the first time.
2. Decide on a release. The changes are additive except for the points under "Changed" in the
   changelog (`endpoints` no longer contains bare URLs; module order).
3. Install Ghidra once and close the NOT RUN item above.
