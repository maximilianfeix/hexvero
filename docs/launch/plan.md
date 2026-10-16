# Seven-day plan and signals

Day 0 is the day 0.8.0 is on npm. No star target is promised; the goal is that people with the
problem try the main flow once and say where it was wrong.

| Day | What                                                                                                                                                                                                                                        | Done when                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| 0   | Internal check: `npx hexvero@0.8.0 demo` in an empty directory on macOS and Linux, `ui --demo`, `compare --report`; website and `/demo/` load; social preview renders in a link preview                                                     | all four commands work from the registry        |
| 1   | Three to five external first users who build or review Electron apps: send the repo and one sentence ("does `npx hexvero demo`, then `compare` on two of your own builds, tell you something true?"). Ask them to report what confused them | at least three answers                          |
| 2   | Fix real entry hurdles from those answers (install errors, wrong facts, unclear output). Release a patch if needed                                                                                                                          | every reproducible hurdle fixed or written down |
| 3   | Public main post: Show HN, written by you, in the morning US time; X post with the video the same day. Answer comments yourself                                                                                                             | posted once; no reposts                         |
| 4   | Community post A (r/electronjs) if its rules allow it                                                                                                                                                                                       | posted or skipped with the reason               |
| 5   | Technical follow-up: article.md on DEV or a blog, disclosing AI assistance; community post B only if a methodology post fits the subreddit                                                                                                  | published                                       |
| 6–7 | Evaluation: read the signals below, write down the next three priorities in `docs/growth/`                                                                                                                                                  | a short written result                          |

## Signals

| Signal                                                 | Where                                                                                                    | Limits                                                          |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Repository views and unique visitors, referrers        | GitHub Insights → Traffic (`gh api repos/maximilianfeix/hexvero/traffic/views`, `.../popular/referrers`) | 14 days of history only; the maintainer's own visits count      |
| Stars and when they came                               | `gh api repos/maximilianfeix/hexvero/stargazers -H "Accept: application/vnd.github.star+json"`           | a lagging signal; says nothing about use                        |
| npm downloads                                          | https://api.npmjs.org/downloads/range/last-week/hexvero                                                  | counts CI, mirrors and `npx` re-runs; a rough indicator only    |
| First-user feedback that names what was clear or wrong | issues, replies, messages                                                                                | small numbers; keep the exact words                             |
| Recurring install errors                               | issues with the bug template, `hexvero doctor` output                                                    | only what people report                                         |
| Use of the main flow                                   | people saying they ran `demo` or `compare --report`                                                      | voluntary only: hexvero has no telemetry and none will be added |

Write the numbers down with the date you read them. Do not present any of them as a promise or
as a conversion rate the data cannot show.
