# Sprint 2 status: ten more hours on hexvero

Asked by the maintainer on 2026-10-17 ("mach danach nochmal 10h arbeiten") after the first sprint
([sprint-report.md](sprint-report.md)). Same rules as the first brief
(`~/Downloads/hexvero-10h-masterprompt.md`): working time counts, not wall time; every analysis
change gets an independent second reader before it ships; blind results are measured once and
kept apart from development numbers; nothing is posted in the maintainer's name; no fake numbers.
This file is the resume point after any interruption.

| Field        | Value                                                                              |
| ------------ | ---------------------------------------------------------------------------------- |
| started_at   | 2026-10-17T19:05:11Z                                                               |
| ten hours at | 2026-10-18T05:05:11Z if worked without a pause (pauses are logged below and added) |
| base commit  | `5fe4692` (main, release 0.9.6 `849b30e`)                                          |
| npm          | `hexvero@0.9.6` latest                                                             |
| toolchain    | Node 22.17.1 for gates; worktrees from `scratchpad/mkwt.sh` (own `@hexvero` links) |

## Baseline (from the end of sprint 1, at `fe6c7dc`/`5fe4692`)

- Gates: check 765 passed | 1 skipped, e2e 13, corpus 298 rows none worse, fuzz seed 13 225/0.
- Speed, Discord `analyze --json --fresh`, registry installs: 0.8.0 769 ms, 0.9.6 953 ms (+24 %);
  Claude.app 6.7 s → 7.5 s.
- Blind: holdout6 (round 5) and holdout5 (round 4); both are development sets now.

## Plan (from sprint-report §9 and the blind round 5)

| Agent | Branch / worktree                                | Task                                                                                           |
| ----- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| E7    | `sprint2/e7-holdout7` `~/hexvero-s2-e7-holdout7` | DONE `6640046`: holdout7 (Padwright, 23 files); not merged, not read; measured once at the end |
| P4    | `sprint2/p4-perf` `~/hexvero-s2-p4-perf`         | scan time against 0.8.0, identical output                                                      |
| W     | `sprint2/w-wrappers` `~/hexvero-s2-w-wrappers`   | storage and endpoint wrappers defined in another module                                        |
| C2    | `sprint2/c2-coverage` `~/hexvero-s2-c2-coverage` | `ipcRenderer?.send(…)` rows; window keys written after an unknown spread                       |

The good first issues #149–#153 stay with contributors.

## Time log

| Period (UTC) | Work                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Who           |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| 19:05–19:20  | inventory, plan, worktrees with own packages (`scratchpad/mkwt.sh`), E7 P4 W C2 started, this resume point; lead: compare view explains the `ipc` group (#178), suggested commands say `npx hexvero` under npx (#180); Glama still 404 (needs the maintainer's account)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | lead + agents |
| 19:20–19:40  | E7 handed back holdout7 (`sprint2/e7-holdout7` `6640046`, Padwright; kept unmerged and unread until the one measurement); lead: release-policy rule `new-bridge-exposure` (#182, draft; default warn when a policy does not list it), R4 reviewing; load 40 during four agents, timing tests not meaningful then                                                                                                                                                                                                                                                                                                                                                                                                                                                       | lead + agents |
| 19:40–20:08  | R4 found the new rule never loaded `bridgeExposures` in the real check path (undecided read as definite; a second preload read as new) → fixed with two `checkRelease` tests, plus a fail-closed label fix from the security review; #182 merged (`0effbef`). P4 (perf: Discord CPU +27.6 % → +12.8 % against 0.8.0, Claude unchanged), W (storage through wrappers of another module; holdout5 storage 7 → 16, holdout6 22 → 33 hits, 0 new false) and C2 (windows after an unread spread; `?.` IPC) handed back; reviews R4 → P4, R5 → W, R3 → C2 running; C2's corpus accept left out (do one accept on main at the end). Release 0.9.7 tried twice: timing tests fail at load 22–24 from the reviewers' probes; waiting for a quiet machine, not skipping the gate | lead + agents |
| 20:08–20:20  | R4 on P4: merge yes (16,800 fuzz inputs, 77 edge cases, 97 exports: 0 differences) → #184 merged (`47f021a`), two older conservative gaps filed (#183). R5 on W: merge yes in principle, but 10× cost on hostile bundles and four false keys inherited from the shared IPC code (static method, method replaced in a third module, `export *` winner, reseeded parameter) → back to W. R3 on C2: false SAFE windows when a quoted/computed `webPreferences` key follows (A1, high) → C2 fixed in `12169b0`, R3 re-reviewing. Release 0.9.7 third try: linearity test fails only under load 20 (passes alone twice) → after W and R3 finish                                                                                                                             | lead + agents |

## Next steps / resume instructions

1. On each hand-back: second reader (read-only, probes against the 0.9.6 core), fixes with
   regression tests, gates (`npm run check`, `npm run e2e`, `npm run corpus`,
   `node scripts/build-site-demo.mjs --check`), PR, CI, squash merge.
2. Release when a merged change is visible to users: in `~/hexvero-sprint` (main),
   `npm run release -- <v>` then `git push --atomic origin main v<v>`, watch the Release workflow,
   verify `npx hexvero@<v>` from an empty cache, update `docs/launch/status.json`.
3. At the end: measure holdout7 once on the release candidate (and 0.9.6 for comparison), then a
   sprint-2 report next to sprint-report.md.
