# Sprint status: 10-hour sprint "know what changed inside your Electron release"

Brief: `~/Downloads/hexvero-10h-masterprompt.md` (2026-10-17). This file is the resume point after
any interruption or context compaction.

| Field          | Value                                                                                                                                   |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| started_at     | 2026-10-16T22:44:36Z (2026-10-17 00:44 CEST)                                                                                            |
| not_before     | 2026-10-17T08:44:36Z (10 h later)                                                                                                       |
| base commit    | `841b6db` (origin/main, README: 22-second launch video #130), packages 0.8.0                                                            |
| npm            | `hexvero@0.8.0` published 2026-10-16 (latest), release workflow green                                                                   |
| working branch | `sprint/10h` in worktree `~/hexvero-10h`                                                                                                |
| toolchain      | Node 22.17.1 (`.nvmrc` 22) for gates; Node 25.2.1 system; npm 10/11; Claude Code 2.1.302; vhs, ffmpeg, Playwright MCP, Chrome extension |
| authorization  | user, 2026-10-17: full rights on PC, GitHub and websites incl. issues, PRs, merges, releases                                            |

## Time log

| Period (UTC) | Active work                                                                                                                                                                                                       | Notes         |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| 22:44–23:25  | inventory, baseline, contracts, 8 agents launched; M, E, C, P, D, G integrated; integration fixes (bridge coverage, WHATWG host parsing, unpacked ASAR entries, scan-cache key, descriptor reads, 503 on timeout) | lead + agents |

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

Running: A2 (IPC wrapper classes, Fiddle + holdout5 dev), I (offline HTML report), J (interface
graph), R (independent review of 841b6db..HEAD).

## Measurements

- Blind holdout5 (round 4, scorer blobs in corpus/results/round4/README.md), totals over three
  builds of one app, hit/missed/false: IPC channels base 47/7/0 → final 49/5/0; window settings
  14/25/0 unchanged; bridge members 57/0/0; endpoints 15/3/0; storage keys 6/12/2. Changes v1→v2
  identical at base and final (ipcChannels 3/1/0, contextBridge 4/0/0, webPreferences 0/2/0,
  endpoints 1/0/0). holdout5 is a development set from now on.
- Benchmark (Node 22.17.1, M2, load 15–20 during agents): Claude.app 7.14 → 7.92 s median,
  ChatGPT.app 14.18 → 13.70 s, peak RSS 796 → 787 MiB; Discord median 0.75 → 1.45 s (first run
  0.76 s both) to be re-measured at lower load.

## Open risks

- REA documents `compare_application_versions`; release comparison alone is not a differentiator (docs/competitive/matrix-2026-10-17.md).
- npm download statistics unavailable for hexvero (API lag).

## Next steps / resume instructions
