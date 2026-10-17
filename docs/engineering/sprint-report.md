# Sprint report: 10-hour sprint "know what changed inside your Electron release"

Brief: `~/Downloads/hexvero-10h-masterprompt.md` (§14). Running record:
[sprint-status.md](sprint-status.md). Entries marked OPEN are filled in at the end of the sprint.

## 1. Runtime and scope

| Item         | Value                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------- |
| started_at   | 2026-10-16T22:44:36Z                                                                        |
| not_before   | 2026-10-17T08:44:36Z                                                                        |
| ended_at     | OPEN                                                                                        |
| base commit  | `841b6db` (0.8.0)                                                                           |
| final commit | OPEN (main)                                                                                 |
| releases     | 0.9.0 (01:20Z, run 38990077564), 0.9.1 (03:00Z, run 38996747203)                            |
| roles        | lead + specialists (at most six at a time), listed in sprint-status                         |
| PRs          | #136 (0.9.0), #137 (0.9.1), #139 (launch status), #141 (CI example pin), OPEN (round three) |

## 2. Main changes, before → after

| Area                                           | Before (0.8.0)                                   | After                                                                                                                                                                                                   | Where / commit                                                     |
| ---------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Whole comparison (P0 §6.1)                     | compare read a capped list; a cut was not said   | whole lists up to 200,000 items / 256 MiB per side, `completeness` with gaps, paged rows with stable ids                                                                                                | `core/src/compare.ts`, contracts C1/C3; #136 `08f80c5`             |
| Semantic uncertainty (§6.2)                    | an unreadable item on one side read as removed   | `unknown`, with the reason per family (`ipc`, `bridge`, `window`, `endpoint`, `storage`)                                                                                                                | C2; `compare.ts`, `session.ts`                                     |
| Interface ends (§6.3)                          | ends cut before direction and link were computed | direction/link from all ends; `endsTotal`, `endsTruncated`; the UI links to the full ipc list                                                                                                           | C4; `javascript/interfaces.ts`; `e992143` (0.9.1)                  |
| Resolver pattern family (§7)                   | registry functions and wrapper classes unread    | abstract evaluation of registries, IPC wrapper classes, window options from constants, `Object.assign`, spreads; budgets, ReDoS limits; Electron Fiddle bridge members linked 0 → 45 of 46 (none false) | `javascript/resolve.ts`, `app.ts`                                  |
| Policies, baselines, SARIF, CI (§8)            | none                                             | `hexvero check` (exit 0/1/2/3/4), baselines, suppressions with expiry, SARIF 2.1.0, a CI example on two synthetic builds                                                                                | `core/src/policy.ts`, `sarif.ts`, `cli/src/check.ts`, `docs/ci.md` |
| Reviewer workspace (§9)                        | compare view without evidence pairs              | evidence before/after with source lines, interface map, release gate in the UI (`POST /api/check`), offline HTML report                                                                                 | `packages/web`, `server/src/index.ts`, `core/src/htmlReport.ts`    |
| Electron observations (§10.3)                  | none                                             | `bridgeExposures`, `navigationHandlers`; undecidable exposures kept and flagged (`bridge_exposures_undecided`)                                                                                          | `javascript/app.ts`; #137 `337ad51`                                |
| Performance (§10.4)                            | warm compare/report/check loaded the MCP SDK     | MCP SDK only for `hexvero mcp`: −20 to −29 % warm; analyze on Discord unchanged (like-for-like A/B)                                                                                                     | `eda5ef0`; `docs/benchmarks.md`                                    |
| MCP review workflow (§10.5)                    | compare in one page                              | per-list paging, `hexvero_check` with path confinement; 16 tools, `tools/list` 15,637 bytes                                                                                                             | `packages/mcp/src`                                                 |
| Case study (§10.6)                             | none for real releases                           | Electron Fiddle 0.38.0 → 0.39.0, checked against the source, re-run on 0.9.0                                                                                                                            | `docs/case-studies/electron-fiddle-0.38.0-to-0.39.0.md`            |
| Contributor experience (§10.7)                 | no detector guide                                | `docs/contributing/new-detector.md`, five contributor tasks                                                                                                                                             | `docs/launch/contributor-tasks.md`                                 |
| Release consistency (§14)                      | the CI example's pinned version was not bumped   | release script bumps it, release-verify refuses a mismatch                                                                                                                                              | #141                                                               |
| Round three (storage wrappers, robustness, UI) | OPEN                                             | OPEN                                                                                                                                                                                                    | OPEN                                                               |

## 3. Code map and reading coverage

[codebase-map.md](codebase-map.md), made at `f0382dc` from `git ls-files` (586 files): 106 read in
full, 320 inventoried (role from path, exports or header), 139 generated, 21 binary fixtures or
assets. Six end-to-end paths are traced with `file:line`. Not every file was read; the map says
which.

## 4. Skills

Inventory and fit: [skill-audit.md](skill-audit.md) (installed, missing, not needed; revisions of
the marketplaces). Project skills added: `.claude/skills/hexvero-codebase`,
`hexvero-evidence-contracts`, `hexvero-parser-regression`, `hexvero-launch-proof`.
`skills/hexvero/SKILL.md` was not changed. Used in the sprint: subagent-driven work per role with
frozen contracts, independent second-reader reviews (R, R2) and the security-guidance review on
each commit, Playwright checks of the UI, the launch-proof claims registry. OPEN: final list.

## 5. Tests and benchmarks

Commands: `npm run check` (typecheck, lint, format, tests, MCP shape), `npm run e2e`,
`npm run corpus`, `node scripts/build-site-demo.mjs --check`, `node scripts/release-verify.mjs`,
`node scripts/smoke-tarballs.mjs`.

| Gate                        | Base `841b6db` | 0.9.0 | 0.9.1 (`6bb3f44`)   | Final |
| --------------------------- | -------------- | ----- | ------------------- | ----- |
| `npm run check`             | PASS, 405      | PASS  | PASS, 675 \| 1 skip | OPEN  |
| `npm run e2e`               | PASS, 11       | PASS  | PASS, 13            | OPEN  |
| `npm run corpus`            | PASS, 298 rows | PASS  | PASS, none worse    | OPEN  |
| CI (Node 22/24, 3 OS, e2e)  | PASS           | PASS  | PASS                | OPEN  |
| Release workflow + registry | —              | PASS  | PASS                | —     |
| `npx hexvero@<v>` from cold | —              | PASS  | PASS                | —     |

NOT RUN: Linux and Windows runs of the CLI commands by hand (CI runs the tests there). BLOCKED:
none. One timing test ("grows linearly") fails under load above about 12 and passes alone and in
CI.

## 6. Historical, development and blind results

Never mix the three.

- **Historical blind** (earlier release, a set the code was not tuned on at the time): `holdout4`
  on 0.7.3, 12 of 57 IPC channels, 36 of 48 window settings with 4 wrong (claims A5).
- **Blind, measured once in this sprint**: `holdout5` (round 4, written without access to
  hexvero), totals over three builds of one app, hit/missed/false: IPC channels 47/7/0 at the base
  → 49/5/0; window settings 14/25/0 unchanged; changes v1→v2: channels 3 of 4, bridge members 4 of
  4, window settings 0 of 2, endpoints 1 of 1 (`corpus/results/round4/README.md`).
- **Development set** (`holdout5` after its misses were worked on, four inputs): IPC channels
  72/0/0, senders and receivers 131/9/0, window settings 17/35/0 (0.9.0) → 32/20/0 (0.9.1, class
  fields deliberately not read), window-setting changes 1 of 2 (claims N2).

## 7. Screenshots, demo, reports, CLI/CI example

Screenshots: `docs/screenshots/` (compare, evidence before/after, interface map, release gate,
source, graph, overview, HTML report; phone widths). Videos: `docs/demo/compare.mp4`,
`release-gate.mp4` (25 s), `ui-review.mp4`. Example reports: `site/demo/report.md`,
`report.html` (generated by the release). CI example: `docs/ci.md`,
`.github/workflows/check-example.yml`. OPEN: round-three screenshots.

## 8. Marketing and publication status

Source of truth: `docs/launch/status.json`. Published: npm 0.9.0/0.9.1, GitHub releases, website
https://maximilianfeix.github.io/hexvero/, official MCP registry (0.9.1 latest), DEV article
https://dev.to/taventix/what-changed-in-this-electron-update-diffing-two-appasar-builds-without-running-either-422d,
doyensec/awesome-electronjs-hacking. Prepared, not published: X posts (maintainer's click), HN
fact brief (HN forbids generated text; the maintainer writes the post), second article, Console.dev
submission. Blocked: Reddit (browser automation blocked), punkpeye/awesome-mcp-servers (needs a
Glama listing), sindresorhus/awesome-electron (from 2026-11-11), Lobsters (invitation).

## 9. Known limits, next five tasks, how to continue

Limits: docs/electron-findings.md "Not read" (cross-module mutation of options objects, class-field
options read as computed, unflagged bridge-exposure gaps, navigation handlers read by method
name); IPC payload shapes are not compared (Fiddle M1). OPEN: round-three limits.

Next tasks: OPEN.

Continue: read `docs/engineering/sprint-status.md` "Next steps / resume instructions".
