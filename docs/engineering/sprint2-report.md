# Sprint 2 report: ten more hours on hexvero

Asked by the maintainer on 2026-10-17 ("mach danach nochmal 10h arbeiten") after the first sprint
([sprint-report.md](sprint-report.md)), under the same rules: working time counts, every analysis
change gets an independent second reader before it ships, blind results are measured once and kept
apart from development numbers, nothing is posted in the maintainer's name, and no number is made
up. The time log is in [sprint2-status.md](sprint2-status.md).

## 1. Time

| Field            | Value                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------- |
| started          | 2026-10-17T19:05:11Z, base `5fe4692` (0.9.6)                                          |
| ten hours        | 2026-10-18T05:05Z; no pause was taken, so no time is added                            |
| wrap-up after it | 05:05–07:00Z: the holdout7 measurement, the last merges and this report, logged apart |

From about 23:55 to 05:00 the machine was overloaded (load 24–50) by three agents running gates
and probes at once: one Claude.app run took 956 s, and full test runs timed out after 15–48
minutes and were repeated. Those hours were worked, not paused, but they produced less than the
first five. Running fewer heavy agents at once would have been faster.

## 2. Shipped

Two releases, both verified the same way: release workflow green, `npm view` latest, `npx
hexvero@<v>` from an empty cache (`--version`, `demo`, `check` exit 3 on the demo policy that is
broken on purpose, `compare --report` 33,298 bytes), the Pages report naming the version, and the
MCP registry marking it latest (`docs/launch/status.json`).

**0.9.7** (run 39069203666):

- #182 release-policy rule `new-bridge-exposure` (a privileged object a preload newly hands to
  pages); a policy that does not list it runs it at `warn`.
- #180 suggested commands say `npx hexvero …` when npx started hexvero; #178 the compare view
  explains the `ipc` group.
- #184 less CPU on large single-bundle apps with identical output (Discord `analyze --fresh`
  1,990 → 1,760 ms against 0.8.0's 1,560 ms).
- #185, #186 IPC with optional chaining and its lowered forms; windows whose `webPreferences`
  follow an unread spread; later computed keys, generators, unnamed accessors and `__proto__` in
  window options and channel tables. #186 also fixed a false SAFE window that #185 had brought to
  main (`[K]: {unsafe}` with `K = "webPreferences"`), which is why 0.9.7 waited for it.

**0.9.8** (run 39073271201):

- #188 storage keys (and IPC channels) through wrapper classes or objects of another module, with
  replacements of a wrapper method detected and flagged; read in path order so a file growing
  between two builds changes no row.

Merged after 0.9.8, not released: #190 (`9bf3538`, the blind set holdout7 and its measurement)
and #191 (`7ead4bd`, IPC built from data, below). #191's Windows test job failed once: the test
"an importer growing between two builds changes no row" (from #188) timed out at 20.6 s; the rerun
passed at 18.7 s against its 20 s limit, so that test runs close to its limit on Windows (§6).

## 3. What the second readers found

Every analysis change had an independent reader (R3–R7) probing it against the released core.
None of the merged changes went in on the first round:

- **W (#188)**, eight rounds with R5: an app-wide member-write union that silently dropped
  wrapper channels 0.9.6 reported (8,417 names on Fiddle, including `get`, `set`, `handle`); a
  silent 20,000-name fallback; about 15 replacement forms not seen; a loose CJS whole re-export
  that read a reassigned or conditional export as certain; `module["exports"]` and tagged-template
  ASI cases; a per-module budget that cost 7× on hostile input; and a size-based read order that
  made `compare` show a false change when one file grew.
- **C2 (#185, #186)**, R3: a false SAFE window when a quoted or computed `webPreferences` key
  follows, and the one #185 brought to main; the security review added quoted `"__proto__"`.
- **I2 (#191)**, three rounds with R7: a budget charged before the scope check that dropped real
  bridge members in minified bundles; false rows from `delete`, control flow in loop rounds,
  element writes and a rebound parameter; silent omissions; a stricter table rule that lost 0.9.8
  rows after `console.log(T)`; Claude.app +30 % with new limitations (now byte-identical, about
  +15 %).
- **H (HTTP request forms, not merged)**, two rounds with R6: an instance whose base is changed
  after `create` gave the old base as a known row; an imported `Request` taken for the global one;
  destructuring writes not seen; quadratic again above 60k functions (out of memory at 80k, now
  1.6 s). R6's second verdict is merge yes on conditions, which H was still working on at the end.
- The automated security review flagged unbounded loops or unreported cuts six times; each was
  fixed before merge.

## 4. Blind result (round 6, holdout7)

Written by an independent author during the sprint, kept unmerged and unread, measured once at
06:22Z on 0.9.6, 0.9.8 and the IPC branch (`corpus/results/round6/README.md`):

| Class (hit/missed/false) | 0.9.6   | 0.9.8   | IPC branch |
| ------------------------ | ------- | ------- | ---------- |
| IPC channels             | 23/29/0 | 23/29/0 | 23/29/0    |
| bridge members           | 11/41/0 | 11/41/0 | 11/41/0    |
| storage keys             | 14/11/0 | 21/4/0  | 21/4/0     |
| changes in storage       | 0/1/0   | 1/0/0   | 1/0/0      |
| every other class        | same    | same    | same       |

The storage work carries over to a set nobody tuned on. The IPC work does not: the IPC branch
closed every IPC and bridge miss of holdout6 and changes nothing on holdout7. Padwright's 29
missed channels and 41 missed bridge members are the first thing to read now that it is a
development set.

## 5. Development sets (not blind; never mix with §4)

0.9.6 → end of sprint, hit/missed/false:

- Storage keys: holdout5 7/17/4 → 16/8/4, holdout6 22/19/0 → 33/8/0 (#188).
- IPC (#191): holdout6 channels 52/12/0 → 64/0/0, senders and receivers 89/23/0 → 136/0/0,
  bridge members 60/20/0 → 80/0/0; holdout2 bridge members 129/6/0 → 133/2/0; holdout channels
  69/3/0 → 72/0/0.
- Endpoints (H, unmerged): holdout 36/6/0 → 39/3/0.
- No new false row in any set. The committed corpus baseline (written by 0.9.0) is regenerated in
  #191; the one row the gate called worse is explained there and was checked by R7.

Real apps: Discord gains two true `webContents.send` senders; Electron Fiddle loses nine false
`__SENTRY_IPC__` bridge members; Claude.app's output is unchanged.

## 6. Open at the end

- **H, `sprint2/h-http`** (`~/hexvero-s2-h-http`, commits up to `ca1a6c8` plus uncommitted work):
  R6's conditions — the write cap's wording and the rows it costs in minified code (one Claude.app
  row), a write before a later inner declaration charged to the outer binding, docs. Then a short
  R6 look, rebase onto main (JS_SCAN_SCHEMA 24 once #191 has 23), PR, release.
- **0.9.9**: release #191 (and H) on a quiet machine; the timing gates are meaningless under load.
- The test "an importer growing between two builds changes no row" takes 18.7–20.6 s on the
  Windows runner against a 20 s limit: make its fixture smaller (the property it checks does not
  need 3M tokens), do not raise the limit.
- Low notes left by R5 and R7: partial rows for a renamed IPC parameter in a file without the text
  "ipc", a silent per-file cut of 2,000 parameter functions, and a member added after
  `exposeInMainWorld` counted. Issue #183 holds the older conservative gaps.
- The good first issues #149–#153 stay with contributors. Glama (needs the maintainer's account)
  and the launch posts (the maintainer's) are unchanged.

## 7. Metrics at the end (same commands as `docs/growth/metrics-2026-10-17-end.md`)

| Signal                   | End of sprint 1 (18:41Z) | End of sprint 2 (06:50Z)       |
| ------------------------ | ------------------------ | ------------------------------ |
| Stars / forks / watchers | 5 / 0 / 0                | 5 / 0 / 0                      |
| Repo views, 14 days      | 161, 39 unique           | 183, 40 unique                 |
| Clones, 14 days          | 3,107, 533 unique        | 4,298, 575 unique              |
| npm downloads, last week | "package not found"      | 364 (2026-10-10 to 2026-10-16) |
| DEV article              | 0 reactions, 0 comments  | 0 reactions, 0 comments        |

The npm count is the first the API has returned. It includes this project's own release
workflows, which install each version from the registry, and the npx checks of this sprint, so it
says nothing about people. Views and clones include the maintainer, the agents and CI.

## 8. How to continue

Read [sprint2-status.md](sprint2-status.md) "Next steps", then §6 above: finish H with R6, rebase
it after #191, and release 0.9.9 on a quiet machine. Then read holdout7's IPC and bridge misses,
now a development set, and measure the next change on a new blind set.
