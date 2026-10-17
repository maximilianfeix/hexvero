# Seven-day follow-up plan for 0.9.0

Day 0 is the day `hexvero@0.9.0` is on npm. No star or download target is promised; the goal is
that people who ship or review Electron apps run `demo`, then `check` on two of their own builds,
and say where the answer was wrong. The 0.8.0 plan's day 3 to 5 (Show HN, community posts,
first article) is either done (DEV) or still open and carried over below.

| Day | What                                                                                                                                                                                                                                                                                                                                                       | Done when                                                   |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| 0   | From an empty cache on macOS and Linux: `npx hexvero@0.9.0 demo`, `compare --report report.html`, `check … --policy hexvero-demo/policy.json` (expect exit 3), `ui --demo --open`; website, `/demo/`, `/demo/report.html` load; MCP registry lists 0.9.0. Re-run every row of [claims.md](claims.md) with `npx hexvero@0.9.0` and update the commit column | every claim re-verified on the published version            |
| 1   | Feedback: send the repository and one sentence to three to five people who build or review Electron apps ("does `npx hexvero demo`, then `npx hexvero check old.asar new.asar --policy policy.json` on two of your builds, tell you something true, and where is it wrong?")                                                                               | at least three answers, written down with their exact words |
| 2   | Fixes: every reproducible entry hurdle from day 1 fixed or written down as an issue; known small one: `--update-baseline` into a directory that does not exist fails with a bare `ENOENT` (claims.md, article step 5). Patch release if needed                                                                                                             | each hurdle has an issue or a fix                           |
| 3   | X post with `docs/demo/release-gate.mp4` (draft in posts.md, "X: 0.9.0"); Show HN only if the maintainer writes it himself from [hn-fact-brief.md](hn-fact-brief.md) (HN forbids generated text). Answer comments yourself                                                                                                                                 | posted once each, or skipped with the reason                |
| 4   | Read the r/electronjs and r/ReverseEngineering rules by hand (they could not be read from here); post community post A or B only if allowed                                                                                                                                                                                                                | posted or skipped with the reason in status.json            |
| 5   | Second technical post: rewrite [article.md](article.md) (the release gate) in your own words for a venue other than DEV; disclose AI assistance where asked                                                                                                                                                                                                | published, URL in status.json                               |
| 6   | Metrics re-reading with the same commands as [docs/growth/metrics-2026-10-17.md](../growth/metrics-2026-10-17.md) (below); write `docs/growth/metrics-<date>.md` with the values and the date read                                                                                                                                                         | file written                                                |
| 7   | Evaluation: the three next priorities from feedback and metrics in `docs/growth/`; candidates already known: IPC wrapper classes, `Object.assign` window options across bindings (holdout5), payload shapes (Fiddle M1), a new blind set for the next accuracy number                                                                                      | a short written result                                      |

## Metrics, re-read with the baseline's commands

```bash
gh api repos/maximilianfeix/hexvero --jq '{stars: .stargazers_count, forks: .forks_count, watchers: .subscribers_count}'
gh api repos/maximilianfeix/hexvero/traffic/views
gh api repos/maximilianfeix/hexvero/traffic/clones
gh api repos/maximilianfeix/hexvero/traffic/popular/referrers
curl https://api.npmjs.org/downloads/point/last-week/hexvero
curl "https://dev.to/api/articles?username=taventix"
```

| Signal                    | Baseline (2026-10-17 00:55 CEST)    | Limits                                                           |
| ------------------------- | ----------------------------------- | ---------------------------------------------------------------- |
| Stars / forks / watchers  | 5 / 0 / 0                           | lagging; says nothing about use                                  |
| Views, 14 days            | 149 views, 33 unique                | includes the maintainer and agents                               |
| Clones, 14 days           | 2,777, 456 unique                   | dominated by CI and automation                                   |
| Referrers                 | github.com, reddit.com, t.co, …     | source posts not identified                                      |
| npm downloads (last week) | not available ("package not found") | stats lag for new packages; counts CI, mirrors and `npx` re-runs |
| DEV article               | 0 reactions, 0 comments             | views not public                                                 |
| First-user feedback       | none recorded yet                   | small numbers; keep the exact words                              |

Write the numbers with the date read. Do not present any of them as a promise or as a conversion
rate the data cannot show. hexvero has no telemetry and none will be added.
