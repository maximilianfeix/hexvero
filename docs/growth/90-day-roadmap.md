# 90-day roadmap

Date: 2026-10-14. A plan for a solo maintainer, sized to evenings. Dates are relative to the next
release (day 0). Nothing here promises adoption; each item names the signal that says whether it
worked.

## Before day 0

- Review and merge this round's branch (and decide on the separate integration branch).
- Release with the verified pipeline; check the npm package carries `mcpName`.
- Publish to the official MCP registry; add the server to Glama.

## Days 1 to 30: launch and listen

| Week | Work                                                                                                | Signal                                        |
| ---- | --------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| 1    | One Show HN in your own words; the awesome-mcp-servers PR; the doyensec list PR                     | first external issues; where people got stuck |
| 2    | Fix the top three issues from week 1; reply to every issue within two days                          | issues closed, people coming back             |
| 3    | Technical article on Electron static triage of a public app                                         | referrals in GitHub traffic                   |
| 4    | A new blind hold-out set (written by someone without access to hexvero), measured before any tuning | per-class numbers on unseen code              |

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
