# Progress

State of the work on branch `quality/round-3`, written so that a fresh session can continue.
Last updated 2026-10-13.

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
- `corpus/results/hexvero.*`: current result on all sets; regenerate with `npm run corpus:accept`.
- `corpus/compare/`: the comparison with REA 6.4.0 on the corpus (harness, raw data, summary).
- `docs/benchmarks.md`: hexvero's own timings.

## Open

- **Ghidra: NOT RUN.** It is not installed on the development machine and was not installed
  without asking. hexvero's Ghidra path is covered by fixtures only. To verify: install Ghidra,
  then `npm run e2e` and `node corpus/observe-hexvero.mjs --engines radare2,rizin,ghidra`.
- **Linux and Windows**: the corpus's native inputs are Mach-O arm64 only. Whether the packed
  archives rebuild to the same bytes on Linux is checked by CI (`corpus/build.mjs --check`) but
  has not run yet, because the branch is not pushed.
- **Agent experiment: NOT RUN.** No model budget was authorized, so there is no statement about
  agent success rates or token costs.
- A request whose address comes from a function parameter (the `/v1/login` case of the minified
  `dev` input) cannot be read statically and is counted as missed.
- Native `analyze` raises no finding for an imported `system`.
- The UI's partial-analysis notice was checked by hand in Chrome on a 541 MiB archive; there is no
  automated browser test.

## Next steps a maintainer may want

1. Review the branch, then push it and open a pull request (CI will run the corpus checks on
   Linux and macOS for the first time).
2. Decide on a release. The changes are additive except for the points under "Changed" in the
   changelog (`endpoints` no longer contains bare URLs; module order).
3. Install Ghidra once and close the NOT RUN item above.
