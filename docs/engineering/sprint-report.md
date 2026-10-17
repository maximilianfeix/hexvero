# Sprint report: 10-hour sprint "know what changed inside your Electron release"

Brief: `~/Downloads/hexvero-10h-masterprompt.md` (§14). Running record with every hand-over,
review and measurement: [sprint-status.md](sprint-status.md). Entries marked OPEN are filled in at
the very end.

## 1. Runtime and scope

| Item         | Value                                                                                                                                                                                                         |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| started_at   | 2026-10-16T22:44:36Z                                                                                                                                                                                          |
| working time | 22:44–03:44Z (5 h 00) and 14:00Z–ended_at; **03:44–14:00Z was a pause** (weekly usage limit: lead and every agent stopped)                                                                                    |
| ended_at     | OPEN                                                                                                                                                                                                          |
| base commit  | `841b6db` (0.8.0)                                                                                                                                                                                             |
| final commit | OPEN (main)                                                                                                                                                                                                   |
| releases     | 0.9.0 (01:20Z, run 38990077564), 0.9.1 (03:00Z, 38996747203), 0.9.2 (15:20Z, 39044161003), 0.9.3 (16:30Z, 39049256326), 0.9.4 (17:00Z, 39051642548), 0.9.5 (17:30Z, 39054086916), 0.9.6 (18:05Z, 39056731394) |
| roles        | lead + specialists, at most six at a time (A, A2, A3, B, C, D, D2, E, E6, F, G, H, I, J, K, L, M, M3, P, P2, S, U, X; reviewers R, R2, R3)                                                                    |
| PRs          | #136 (0.9.0), #137 (0.9.1), #139, #141, #142 (0.9.2), #144, #146, #148, #155, #156 (0.9.3), #159, #160 (0.9.4), #162, #163, #164 (0.9.5), #165 (0.9.6), #167, #169, #171                                      |
| issues       | #138, #140, #143, #145, #147, #154, #157, #158, #161, #166, #168, #170 (closed by those PRs); #149–#153 good first issues                                                                                     |

The ten hours are counted as working time. The `not_before` of the brief (08:44:36Z) fell into the
pause; work continued after it until ten hours of work were reached.

## 2. Main changes, before → after

| Area                                       | Before (0.8.0)                                   | After                                                                                                                                                                                                                                                    | Where / commit                                                  |
| ------------------------------------------ | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Whole comparison (P0 §6.1)                 | compare read a capped list; a cut was not said   | whole lists up to 200,000 items / 256 MiB per side, `completeness` with gaps, paged rows with stable ids                                                                                                                                                 | `core/src/compare.ts`, contracts C1/C3; #136 `08f80c5`          |
| Semantic uncertainty (§6.2)                | an unreadable item on one side read as removed   | `unknown`, with the reason per family (`ipc`, `bridge`, `window`, `endpoint`, `storage`)                                                                                                                                                                 | C2; `compare.ts`, `session.ts`                                  |
| Interface ends (§6.3)                      | ends cut before direction and link were computed | direction/link from all ends; `endsTotal`, `endsTruncated`; the UI links to the full ipc list; ends sorted once per channel (20,000 members: 75 s → < 2 s)                                                                                               | C4; `javascript/interfaces.ts`; #137, #142                      |
| Resolver pattern family (§7)               | registry functions and wrapper classes unread    | abstract evaluation of registries, IPC wrapper classes, window options from constants, `Object.assign`, spreads; budgets, ReDoS limits; Electron Fiddle bridge members linked 0 → 45 of 46 (none false)                                                  | `javascript/resolve.ts`, `app.ts`                               |
| Policies, baselines, SARIF, CI (§8)        | none                                             | `hexvero check` (exit 0/1/2/3/4), baselines, suppressions with expiry, SARIF 2.1.0, a CI example on two synthetic builds, the CI pin bumped and checked by the release                                                                                   | `core/src/policy.ts`, `sarif.ts`, `cli/src/check.ts`, #141      |
| Reviewer workspace (§9)                    | compare view without evidence pairs              | evidence before/after with source lines, interface map, release gate in the UI (`POST /api/check`), offline HTML report; failed loads with Retry, hostile text written out, focus and history kept                                                       | `packages/web`, `server/src/index.ts`, `core/src/htmlReport.ts` |
| Electron observations (§10.3)              | none                                             | `bridgeExposures`, `navigationHandlers`; undecidable exposures kept and flagged (`bridge_exposures_undecided`)                                                                                                                                           | `javascript/app.ts`; #137                                       |
| Storage keys through wrappers and enums    | Fiddle's settings unread (miss M2)               | keys through the app's own `save`/`retrieve` methods and compiled TS enums; Fiddle 0.38 → 0.39: `isUsingSocketFirewall` added, 28 of 28 keys, none false                                                                                                 | `resolve.ts` `wrapperCalls`/`callSites`, `aliases.ts`; #142     |
| Performance (§10.4)                        | —                                                | warm compare/report/check −20 to −29 % (MCP SDK loaded only for `hexvero mcp`); 0.9.1's cold-scan regression (+26 %) fixed: Discord 0.9.0 827 ms, 0.9.1 1,062 ms, 0.9.2 878 ms                                                                           | `eda5ef0`; P2 in #142; `docs/benchmarks.md`                     |
| Robustness (§13 "adversariale Inputs")     | no fuzzing                                       | `npm run fuzz` (seeded); fixed: forged ASAR headers, policies nested past the stack, 100k-entry archives, slow HTML report, terminal escape and line forging, excerpts of a build changed on disk                                                        | `scripts/fuzz.mjs`, `cli/src/format.ts`, `core/src/source.ts`   |
| MCP review workflow (§10.5)                | compare in one page                              | per-list paging, `hexvero_check` with path confinement; 16 tools, `tools/list` 15,637 bytes                                                                                                                                                              | `packages/mcp/src`                                              |
| Case study (§10.6)                         | none for real releases                           | Electron Fiddle 0.38.0 → 0.39.0, checked against the source; re-run on 0.9.0 and for M2 on 0.9.2                                                                                                                                                         | `docs/case-studies/electron-fiddle-0.38.0-to-0.39.0.md`         |
| Contributor experience (§10.7)             | no detector guide                                | `docs/contributing/new-detector.md`; five tasks re-checked on 0.9.2 and filed as good first issues #149–#153                                                                                                                                             | `docs/launch/contributor-tasks.md`; #155                        |
| Endpoints through HTTP client methods (M3) | `https.get(url)` with a parameter URL: no row    | requests through `node:https`/`http`, Electron `net` and request libraries are endpoints; strict bindings, IIFE call sites, options merged over a URL only when known; undecidable → unknown row; Fiddle: the bundled CLI's api.github.com request found | `candidates.ts`, `resolve.ts`; #156, #160                       |
| IPC payload shapes (M1)                    | a new payload field on a channel was invisible   | sending `ipc` rows carry an `args` shape (sorted object-literal keys, `…` for unknown names); Fiddle: `NPM_ADD_MODULES` gains `useSocketFirewall`, the one changed call of 157                                                                           | `javascript/payload.ts`, `compare.ts`; #164                     |

## 3. Code map and reading coverage

[codebase-map.md](codebase-map.md), made at `f0382dc` from `git ls-files` (586 files): 106 read in
full, 320 inventoried (role from path, exports or header), 139 generated, 21 binary fixtures or
assets. Six end-to-end paths are traced with `file:line`. Not every file was read; the map says
which. It describes the base of the sprint; files added later are not in it.

## 4. Skills

Inventory and fit: [skill-audit.md](skill-audit.md) (installed, missing, not needed; revisions of
the marketplaces). Project skills added: `.claude/skills/hexvero-codebase`,
`hexvero-evidence-contracts`, `hexvero-parser-regression`, `hexvero-launch-proof`.
`skills/hexvero/SKILL.md` was not changed. Used: subagent-driven work per role with frozen
contracts (C1–C7); three independent second readers (R: 21 findings; R2: 10; R3: 9, then 5 more on
re-review; all fixed); the security-guidance review on every commit (it found hidden real
findings in two fix rounds and a quadratic scope walk); Playwright checks of the UI (agent U, and
the lead on the published 0.9.2); the claims registry of `hexvero-launch-proof`.

## 5. Tests and benchmarks

Commands: `npm run check` (typecheck, lint, format, tests, MCP shape), `npm run e2e`,
`npm run corpus`, `node corpus/build.mjs --check`, `node scripts/build-site-demo.mjs --check`,
`node scripts/release-verify.mjs`, `node scripts/smoke-tarballs.mjs`, `npm run fuzz`.

| Gate                        | Base `841b6db` | 0.9.0 | 0.9.1 (`6bb3f44`)   | 0.9.2 (`660c9f4`)   | final (`fe6c7dc`)   |
| --------------------------- | -------------- | ----- | ------------------- | ------------------- | ------------------- |
| `npm run check`             | PASS, 405      | PASS  | PASS, 675 \| 1 skip | PASS, 727 \| 1 skip | PASS, 765 \| 1 skip |
| `npm run e2e`               | PASS, 11       | PASS  | PASS, 13            | PASS, 13            | PASS, 13            |
| `npm run corpus`            | PASS, 298 rows | PASS  | PASS, none worse    | PASS, none worse    | PASS, none worse    |
| CI (Node 22/24, 3 OS, e2e)  | PASS           | PASS  | PASS                | PASS                | PASS                |
| fuzz (× 225 cases)          | —              | —     | —                   | PASS, seeds 7–9     | PASS, seeds 11, 13  |
| Release workflow + registry | —              | PASS  | PASS                | PASS                | PASS                |
| `npx hexvero@<v>` from cold | —              | PASS  | PASS                | PASS (+ web UI)     | PASS                |

FAIL, then fixed: the 0.9.2 PR's Windows tests (Windows refuses file names with control
characters; those cases now run elsewhere); the first local `npm run release -- 0.9.2` stopped at
the release-verify test, the second passed, and the test now prints the reason (#146). NOT RUN:
Linux and Windows runs of the CLI by hand (CI runs the tests there); MCP, web server and session
API are fuzzed only through unit tests; APK, JAR and native binaries were not fuzzed. BLOCKED:
none. The timing test "grows linearly" fails under load above about 12; it passes alone and in CI.

Speed is compared like for like only (registry installs, or a core's `dist` loaded by path). An
early "no slowdown" for 0.9.1 was wrong because two worktrees loaded one core through a symlinked
`node_modules`; it was withdrawn (claims N4) and the regression fixed.

Final speed, registry installs, `analyze --json --fresh`, a fresh cache per run, interleaved
(17:39Z, load 7–15): Discord 0.8.0 809 ms, 0.9.0 901 ms, 0.9.5 976 ms (7 runs each; +21 % against
the base, +8 % against 0.9.0); Claude.app (47 MB) 0.8.0 5.4–6.4 s, 0.9.5 6.9–7.7 s (3 runs each,
noisy); peak RSS not higher (Claude 0.8.0 859–1,101 MiB, 0.9.5 857–994 MiB). The budget set at the
start (at most 15 % against the base) is exceeded on Discord.

A last profiling round (0.9.6, `ccba870`) removed four repeated per-file passes with identical
results: Discord 0.9.5 995 → 953 ms, Claude.app 8.4 → 7.5 s (interleaved against registry 0.8.0
769 ms / 6.7 s; load 5–13). What remains against the base is, by CPU profile (Discord, self ms
per run, 4 profiles each), one linear pass per file for each analysis added in the sprint:

| Function                            | 0.8.0 | 0.9.5 | Analysis                                  |
| ----------------------------------- | ----- | ----- | ----------------------------------------- |
| `findCandidates`                    | 43    | 80    | HTTP clients, webpack module ids, storage |
| `privilegedBindings` + `privileged` | 0     | 39    | bridge exposures                          |
| `navigationHandlers`                | 0     | 14    | navigation handlers                       |
| `readWrappers`                      | 0     | 11    | IPC wrapper classes                       |
| `innermostBlock`, `depthAt`         | 0     | 17    | bracket tables (once per file)            |
| `memberWritten`, `storageKey`       | 0     | 17    | storage wrappers                          |
| `webpackModule`                     | 0     | 8     | webpack module-id table                   |
| `matches` (payload)                 | 0     | 8     | IPC payload shapes                        |
| `Constants` (second instance)       | 19    | 30    | window-option evaluation                  |

This is the cost of the new facts, not repeated work; it is justified as such here, and the
remaining candidates (reusing the scan's `Constants` for the window evaluation, an identifier
index for the reassigned-client loop) are next task 1.

## 6. Historical, development and blind results

Never mix them.

- **Historical blind**: `holdout4` on 0.7.3, 12 of 57 IPC channels, 36 of 48 window settings with
  4 wrong (claims A5).
- **Blind, `holdout5`** (round 4, measured once): IPC channels 47/7/0 at the base → 49/5/0; window
  settings 14/25/0 unchanged; changes v1→v2: channels 3 of 4, bridge members 4 of 4, window
  settings 0 of 2, endpoints 1 of 1 (`corpus/results/round4/README.md`).
- **Blind, `holdout6`** (round 5, a screenshot annotator written without access to hexvero,
  measured once on `7f38b14`; 0.8.0 → 0.9.2 code): IPC channels 52/12/0 throughout; storage keys
  14/27/0 → 22/19/0; endpoints 15/6/4 → 16/5/4; window settings 24/28/2 → 44/8/15, where the 15
  false are windowless duplicates of rows that were right; window-setting changes 0/1/6 → 1/0/1
  (`corpus/results/round5/README.md`).
- **Development sets** (worked on after their measurement): `holdout5` window settings 17/35/0
  (0.9.0) → 32/20/0 (0.9.1, class fields deliberately not read); `holdout6` window settings
  44/8/0 after the duplicate fix (claims B2).

## 7. Screenshots, demo, reports, CLI/CI example

Screenshots: `docs/screenshots/` (compare, evidence before/after, interface map, release gate,
source, graph, overview, HTML report; phone widths). Videos: `docs/demo/compare.mp4`,
`release-gate.mp4` (25 s), `ui-review.mp4`. Example reports: `site/demo/report.md`,
`report.html` (generated by each release; the site names 0.9.2). CI example: `docs/ci.md` and the
site (pinned to the release), `.github/workflows/check-example.yml`. The web UI of the published
0.9.2 was checked by hand at 1440 px (compare view and release gate on the demo).

## 8. Marketing and publication status

Source of truth: `docs/launch/status.json`. Published: npm 0.9.0 to 0.9.5, GitHub releases,
website https://maximilianfeix.github.io/hexvero/, official MCP registry (0.9.5 latest), DEV
article
https://dev.to/taventix/what-changed-in-this-electron-update-diffing-two-appasar-builds-without-running-either-422d,
doyensec/awesome-electronjs-hacking, five good first issues. Prepared, not published: X posts for
0.9.0, 0.9.2 and 0.9.6 (maintainer's click), HN fact brief (HN forbids generated text; the maintainer
writes the post), second article (re-run on 0.9.6), Console.dev submission. Blocked: Reddit (browser automation
blocked), punkpeye/awesome-mcp-servers (needs a Glama listing), sindresorhus/awesome-electron
(from 2026-11-11), Lobsters (invitation). Metrics at the end of the sprint, with the baseline's commands: stars 5 → 5,
views 149 → 161 (14 days), npm downloads still not reported by the API, DEV 0 reactions
([docs/growth/metrics-2026-10-17-end.md](../growth/metrics-2026-10-17-end.md)); the posts that
reach people were not made during the sprint.

## 9. Known limits, next five tasks, how to continue

Limits (details in `docs/electron-findings.md` "Not read" and the storage-wrapper section):
cross-module mutation of options objects; class-field options read as computed; a window whose
options spread an unknown object reads as computed; storage wrappers called from another module
or declared twice in a file stay unread; IPC payload shapes are not compared (Fiddle M1); a
same-size in-place edit of an app-folder file is not detected; table widths count code points
(wide CJK characters misalign); HTTP clients bound through webpack ids of another chunk, a client held in a variable, `got(url)`/`axios(url)` called directly, options passed as a name; IPC payload keys compared as written (`{1.5: x}` vs `{"1.5": x}`), transpiler spread helpers, what a handler reads from the payload; `ipcRenderer?.send(…)` gives no row.

Next five tasks:

1. Scan time against the sprint base (Discord +24 % against 0.8.0 on 0.9.6, see §5): reuse the
   scan's `Constants` for the window-option evaluation where results stay identical, and index
   identifiers for the reassigned-client loop.
2. Wrapper calls across modules (storage and endpoints): follow an exported wrapper into the
   modules that import it, under the same strict rules.
3. A third blind set before the next minor release, measured once on its release candidate.
4. The good first issues #149–#153 (export parity, UI scan options, collection meanings in
   reports, a traceable corpus baseline, the stale UI token).
5. Glama listing (maintainer) to unblock punkpeye/awesome-mcp-servers; awesome-electron from
   2026-11-11.

Continue: read `docs/engineering/sprint-status.md` "Next steps / resume instructions".
