# 90-day roadmap

Date: 2026-10-14. A plan for a solo maintainer, sized to evenings. Dates are relative to the next
release (day 0). Nothing here promises adoption; each item names the signal that says whether it
worked.

## What can be said, with its source

Claims for posts and articles, each backed by a file in the repository. Anything not on this list
is not claimed.

- On a blind set of two Electron apps, hexvero (before this round) read 90 of 126 IPC channels,
  42 of 63 window settings and 47 of 57 storage keys; REA 6.5.0 read 87, 8 and 15
  (`docs/competitive/rea-scorecard.md`). The blind set is small; say so.
- The MCP catalog is 14 KB against 3.09 MB (same file).
- On the Claude desktop app, about 5 s and 52 KB of output against 179 s and 123.5 MB, with 233
  named IPC channels against 9 literal ones (same file; an observation on one app without ground
  truth).
- In the agent experiment both tools led to fully correct answers when files could be read; hexvero in less than half the time and with about a third fewer tokens (`docs/audits/agent-task-evaluation.md`). Not: "agents answer better with hexvero".
- Not to be claimed: speed against hexvero 0.3.0 (it is slower), completeness, dynamic analysis.

Article ideas that teach something on their own: mapping an Electron app's IPC surface without
running it (with the typed IPC layer of a real app as the example); what a blind test set changed
about this project's accuracy numbers (the round-3 result where a week of work showed no gain);
how much context an MCP investigation really costs, measured per question.

## Before day 0

- Fix hexvero.dev or move the homepage links to the GitHub Pages address
  (`docs/audits/domain-check.md`).
- Review and merge this round's branch after CI passes on Linux, Windows and macOS.
- Release with the verified pipeline; check the npm package carries `mcpName`.
- Publish to the official MCP registry; add the server to Glama.

## Days 1 to 30: launch and listen

| Week | Work                                                                                                                                                                            | Signal                                        |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| 1    | One Show HN in your own words; the awesome-mcp-servers PR; the doyensec list PR                                                                                                 | first external issues; where people got stuck |
| 2    | Fix the top three issues from week 1; reply to every issue within two days                                                                                                      | issues closed, people coming back             |
| 3    | Technical article on Electron static triage of a public app                                                                                                                     | referrals in GitHub traffic                   |
| 4    | The next blind set (`holdout3`), written by someone without access to hexvero, measured before any tuning; `holdout2` has been used for development since its blind measurement | per-class numbers on unseen code              |

## Days 31 to 60: accuracy where it is weakest

- Channels registered from classes, arrays and Maps; options built with `Object.assign` and config
  modules: the misses of the current hold-out set. Tune on the old hold-out, measure on the new.
- The speed regression: resolve names only where a finding needs them.
- Ghidra: install once, run the corpus, publish the rows.
- A comparison view in the web UI.

Signal: hold-out recall up without new false reports; `docs/benchmarks.md` back near 0.3.0 times.

## Days 61 to 90: make it easy to contribute and to rely on

- Contributor guide for adding a corpus case and a detector (the corpus makes reviews objective).
- Label five good first issues from real feedback.
- Stable evidence ids per fact, so an agent can cite and re-fetch one item.
- Windows: run the engines there once and document what works.

Signal: first external pull request merged; first external corpus case.

## Ongoing

- One release every two to four weeks with release notes that name what users reported.
- Every claim in the README backed by a script in the repository.
- No telemetry; ask in issues when a number is needed.
