# Sprint status: 10-hour sprint "know what changed inside your Electron release"

Brief: `~/Downloads/hexvero-10h-masterprompt.md` (2026-10-17). This file is the resume point after
any interruption or context compaction.

| Field          | Value                                                                                                                                   |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| started_at     | 2026-10-16T22:44:36Z (2026-10-17 00:44 CEST)                                                                                            |
| not_before     | 2026-10-17T08:44:36Z (10 h later)                                                                                                       |
| base commit    | `841b6db` (origin/main, README: 22-second launch video #130), packages 0.8.0                                                            |
| npm            | `hexvero@0.9.0` published 2026-10-17 01:20Z (latest), run 38990077564 green; base was 0.8.0                                             |
| working branch | `sprint/10h` (0.9.0, #136), `sprint/091` (0.9.1, #137); round three on branches from main `c3e037a`                                     |
| toolchain      | Node 22.17.1 (`.nvmrc` 22) for gates; Node 25.2.1 system; npm 10/11; Claude Code 2.1.302; vhs, ffmpeg, Playwright MCP, Chrome extension |
| authorization  | user, 2026-10-17: full rights on PC, GitHub and websites incl. issues, PRs, merges, releases                                            |

## Time log

| Period (UTC) | Active work                                                                                                                                                                                                                                                                                                                                                                 | Notes         |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| 22:44–23:25  | inventory, baseline, contracts, 8 agents launched; M, E, C, P, D, G integrated; integration fixes (bridge coverage, WHATWG host parsing, unpacked ASAR entries, scan-cache key, descriptor reads, 503 on timeout)                                                                                                                                                           | lead + agents |
| 23:25–01:20  | integration of A, A2, B, C, D, D2, G, H, I, J, L, P; review R (21 findings) fixed; PR #136 squash `08f80c5`; release 0.9.0 (`03588ec`, tag v0.9.0, run 38990077564 green); npx hexvero@0.9.0 demo/check/report verified                                                                                                                                                     | lead + agents |
| 01:20–02:10  | `sprint/091`: A3 window options (Object.assign, spreads, class fields), K bridge exposures + navigation handlers, report same-name note; review R2 (1 critical, 1 high, 3 medium, 5 low); #8 #10 fixed (`48b03ce`); #1 #2 #6 → A3, #3 #4 #5 #9 → K                                                                                                                          | lead + agents |
| 02:10–02:55  | A3 `c466919` and K rounds `a23930a`, `02e6da4`, `5fe9263` integrated (security review found false negatives twice, then a fail-open path); scope memo `f3d9489` (hostile input > 280 s → 0.6 s); fair A/B shows no slowdown; CHANGELOG consolidated; claims N1–N6; PR #137                                                                                                  | lead + agents |
| 02:55–03:15  | PR #137 squash `337ad51`; release 0.9.1 (`3c187a3`, run 38996747203 green; npm latest, GitHub release, MCP registry isLatest, Pages); npx hexvero@0.9.1 verified from an empty cache; #139 launch status; #141 CI example pin (release.mjs bumps it, release-verify checks it); round three started (S, X, U); report draft                                                 | lead + agents |
| 03:15–03:44  | U handed back (UI states); interface-map Back fix (`ca3209d`); S handed back (storage wrappers); **setup bug found by S: worktrees with a symlinked node_modules resolved `@hexvero/*` to `~/hexvero-091`**, so the "like-for-like" A/B (claim N4) compared one core twice; registry installs show 0.9.0 842 ms → 0.9.1 1065 ms on Discord (+26 %, over budget); P2 started | lead + agents |
| 03:44–14:00  | **pause: weekly usage limit** (lead and every agent stopped; no work, no commits)                                                                                                                                                                                                                                                                                           | —             |
| 14:00–       | X handed back (fuzzing, 5 failures fixed); round three integrated on `sprint/round3`; gates green (check 707 \| 1 skip, e2e 13, corpus none worse); fuzz seed 7: 225 cases, 0 failed; P2 resumed                                                                                                                                                                            | lead + agents |

## Agents and branches

| Role                              | Branch / worktree                              | Status                                                                                                                                                                                                                           |
| --------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lead / integrator                 | `sprint/10h`                                   | active                                                                                                                                                                                                                           |
| A analyzer (resolver, C4)         | `sprint/a-analyzer` `~/hexvero-10h-a-analyzer` | running since 22:58Z                                                                                                                                                                                                             |
| B compare (C1–C3)                 | `sprint/b-compare`                             | running since 22:58Z                                                                                                                                                                                                             |
| P policy (C5, C6, SARIF, CI)      | `sprint/p-policy`                              | running since 22:58Z                                                                                                                                                                                                             |
| C web + server (C7)               | `sprint/c-web`                                 | running since 22:58Z                                                                                                                                                                                                             |
| M map + skills                    | `sprint/m-map`                                 | running since 22:58Z                                                                                                                                                                                                             |
| E independent fixtures (holdout5) | `sprint/e-fixtures` `f537d27`                  | DONE 23:11Z: Tidemark app, 2 versions, own v2 format (`changes`, `unchangedMoves`, `bundledFiles`); not built or scored. Kept out of A's worktree until A freezes; then base and final are scored with the same scorer revision. |
| F launch / market                 | lead                                           | matrix, status.json, metrics done                                                                                                                                                                                                |

## Contracts (frozen before parallel work)

See [contracts.md](contracts.md).

## Acceptance (from the brief)

| Item                                           | Status                                                                   |
| ---------------------------------------------- | ------------------------------------------------------------------------ |
| Baseline measured at base commit               | PASS: check 405 tests, e2e 11, corpus 298 rows, bench (Node 22.17.1, M2) |
| C4 interface ends truncation confirmed in code | confirmed (direction/link computed after slice)                          |

## Tests

| Gate             | Base                                             | Final |
| ---------------- | ------------------------------------------------ | ----- |
| `npm run check`  | PASS (after excluding published text from oxfmt) |       |
| `npm run e2e`    | PASS 11/11                                       |       |
| `npm run corpus` | PASS 298 rows                                    |       |

## Integration state (2026-10-16 23:50Z, `aa88007`)

Merged into `sprint/10h`: M (map, skills), C (reviewer workspace), P (check/SARIF/CI), D (codes,
release-verify), G (Fiddle case study), B (C1–C3), A (registry evaluation, C4, DoS limits),
D2 (MCP check, per-list paging), H (holdout5 + round 4 blind result). Lead fixes: bridge-rule
coverage, WHATWG host parsing, unpacked ASAR entries, scan-cache key, descriptor reads, 503 on
timeout, check reads every page. Gates at `aa88007`: check 539 passed, e2e 13, corpus 45 inputs /
298 rows none worse.

Merged later: I (HTML report), J (interface map), D2 L8, B L4, P review fixes, A review fixes.
Running at 00:15Z: A2 (IPC wrapper classes, Fiddle + holdout5 dev). Gates at 973cfd7: check 596
passed, e2e 13, corpus 298 rows none worse.

## Independent review (agent R, 2026-10-17, 841b6db..f8ffe2d) — ALL FIXED and merged by 973cfd7 (00:15Z); extra: same-named windows judged together (8a1d4bb)

4 high, 6 medium, 11 low; 16 confirmed with scripts (scratchpad/review/). Assigned:

- A (resolver): H1 ReDoS bypass in simpleRegex, H2 effects in unread initializers → wrong
  channels, M1 `var` in blocks, M2 block const leak, M3 key order, M6 async/generator, L1, L3.
- P (policy): H3 renamed/new permissive window passes, H4 wrong target kind passes, M4 renamed
  file makes old host/member "new", M5 SARIF URIs may land on repo files, L2, L5–L7, L9, L11.
- D2 (MCP): L8 policyPath reads any path and echoes content.
- B (report): L4 duplicate row ids.
- Lead: L10 symlink race (fixed, `db4f0d9`). Not built: C7 `POST /api/check` (UI policy check);
  `item_truncated` gap is never produced (documented in contracts).

## Measurements

- Blind holdout5 (round 4, scorer blobs in corpus/results/round4/README.md), totals over three
  builds of one app, hit/missed/false: IPC channels base 47/7/0 → final 49/5/0; window settings
  14/25/0 unchanged; bridge members 57/0/0; endpoints 15/3/0; storage keys 6/12/2. Changes v1→v2
  identical at base and final (ipcChannels 3/1/0, contextBridge 4/0/0, webPreferences 0/2/0,
  endpoints 1/0/0). holdout5 is a development set from now on.
- Benchmark (Node 22.17.1, M2, load 15–20 during agents): Claude.app 7.14 → 7.92 s median,
  ChatGPT.app 14.18 → 13.70 s, peak RSS 796 → 787 MiB; Discord median 0.75 → 1.45 s (first run
  0.76 s both) to be re-measured at lower load.
- Interleaved A/B at the same load (00:53Z, load 13–19; 841b6db vs 2ef9ceb, 7 fresh runs each,
  `analyze --json --fresh`, script scratchpad/ab.sh): Discord median 771 → 825 ms (+7 %, the
  extra wrapper/registry resolution), Claude.app 7.28 → 6.77 s (noise). The earlier Discord
  1.45 s was load. Budget: ≤ 15 % slower on real apps; met.
- A2 (IPC wrapper classes): Electron Fiddle members linked to a main-process end 0 → 45 of 46
  (both versions, checked against v0.39.0 source, none false); holdout5 development numbers
  IPC channels 63/9/0 → 72/0/0, senders/receivers 81/45/0 → 131/9/0.

- 0.9.1 window options (A3, after R2; holdout5 is a development set): window settings over 4
  inputs 17/35/0 (0.9.0) → 42/10/0 (with class fields) → **32/20/0** (`c466919`, class fields no
  longer read: R2 kept finding unseen ways to change a field, and a false safe value is worse than
  computed). v1→v2 webPreferences changes 0/2/0 → 1/1/0 (missed: preview window's
  `sandbox: true → false`, set through a class field). Committed corpus: time-tracker window
  settings 11/0/0 → 7/4/0 per build, re-accepted. R2 probes t1–t4, t7, t8, dbg2 re-run on
  `c466919`: no false safe value. Gates at `c466919`: check 663 passed | 1 skipped, e2e 13,
  corpus none worse.

- Speed 0.9.1 (Discord `analyze --fresh`, 7 interleaved runs, both as worktree builds, load
  9–11): 0.9.0 `03588ec` 1,123 ms, `41d732c` 1,053 ms. A checkout built differently
  (`~/hexvero-sprint`) runs the same 0.9.0 code in 821–880 ms, so only like-for-like builds are
  compared; the earlier "+24 %" was that artefact.

- **Correction (14:05Z):** the earlier "no slowdown" for 0.9.1 (claim N4) was wrong: both
  worktree builds loaded the same core through a symlinked node_modules. Measured on registry
  installs (each with its own dependencies), Discord `analyze --json --fresh`, 7 interleaved runs,
  load 8–12: 0.8.0 778 ms, 0.9.0 842 ms, 0.9.1 1065 ms (+26 %). Core-level bisect: the jump comes
  with `1d7107a` (window options, A3). Warm `compare` Claude vs Discord (registry): 0.9.0 261 ms,
  0.9.1 195 ms, so the 0.9.1 CHANGELOG line on warm commands holds. P2 works on the regression.
- **Active time vs wall time:** 22:44–03:44Z and from 14:00Z are working time; 03:44–14:00Z was
  the usage-limit pause. The ten hours are counted as working time, not wall time.

## Open risks

- REA documents `compare_application_versions`; release comparison alone is not a differentiator (docs/competitive/matrix-2026-10-17.md).
- npm download statistics unavailable for hexvero (API lag).

## Second review R2 (sprint/091, origin/main..1d7107a, 02:00Z)

Probe scripts: scratchpad/review2/t1–t8.mjs, dbg2.mjs. A false safe value is worse than "computed".

- CRITICAL #1 (A3; FIXED `c466919`): top-level block/if/switch/for/catch shadow reports the
  outer options (resolve.ts `lookup` falls through to topDeclarations). Regression against 0.9.0.
- HIGH #2 (A3; FIXED `c466919` by not reading class fields): class-field options changed through alias, argument, Object.assign(this),
  Reflect.set, defineProperty, computed keys are reported literal. Rule: if not robust, class
  fields are not read at all.
- MEDIUM #3 #4 #5, LOW #9 (K; FIXED `a23930a`; security-review follow-ups `02e6da4` (decoys hid real exposures), `5fe9263` (budget/cache fail-open → kept and flagged `undecided`), `f3d9489` (lead: scope read once, DoS)): false bridge exposures (reassigned name, loop
  variable, arrow parameter, module methods), false `deny` with spread/computed key, navigation
  target through shadowing, compare key for minified receivers.
- LOW #6, #7 (A3; FIXED `c466919`): limitation note for cross-module mutation; `__toESM(m, 1)` node mode. #8, #10: fixed
  `48b03ce` (control characters in Markdown report heading and note shown as `\u{…}`).

## Round three (from 03:05Z, branches from main `c3e037a`)

| Agent | Branch / worktree                            | Task                                                                    |
| ----- | -------------------------------------------- | ----------------------------------------------------------------------- |
| S     | `sprint/s-storage` `~/hexvero-10h-s-storage` | storage keys through wrapper methods and enums (Fiddle M2)              |
| X     | `sprint/x-robust` `~/hexvero-10h-x-robust`   | seeded fuzzing of readers/exports, hostile policy JSON, output paths    |
| U     | `sprint/u-states` `~/hexvero-10h-u-states`   | UI browser states (loading/empty/error/large/hostile, keyboard, widths) |

## Third review R3 (sprint/round3, origin/main..220a949, 14:30Z)

Probes: scratchpad/r3/probes/. HIGH H1: another class's `this.save("…")` becomes a storage key or
endpoint (regression; main: unknown) → S (`sprint/s2`). MEDIUM M1 (`this` in a nested object
method), M2 (reassigned/shadowed wrapper functions, `exports.X` vs a local of that name) → S.
LOW L1 (reassigned enum member, regression), L2 (`x.Setting.member` through any object), L5
(RSS 528 vs 275 MB with 199k functions) → S; L3 (terminal: forged new line, raw bidi/zero-width),
L4 (table widths, `code()` cut inside an escape), L6 (stale header cache) → X (`sprint/x2`).
Sound: kind-aware compare rule, budgets, ASAR validation, policy nesting, report escaping,
fuzz.mjs, web retry/focus/tabs/history, paint token (no bypass found).

## Next steps / resume instructions

1. On hand-back of S, X, U: cherry-pick or merge onto a branch from main, run the gates (check,
   e2e, corpus, `build-site-demo --check`), run an independent review (second reader + security
   review) before any release; fix findings with regression tests.
2. Release 0.9.2 only if round three changes behaviour users see: PR → CI → squash merge →
   `npm run release -- 0.9.2` in `~/hexvero-sprint` → `git push --atomic origin main v0.9.2` →
   watch the Release workflow → `npx hexvero@0.9.2` from an empty cache → status.json.
3. Fill the OPEN entries in [sprint-report.md](sprint-report.md) at the end (runtime, final
   gates, round three, next five tasks). Do not stop before not_before (08:44:36Z).
