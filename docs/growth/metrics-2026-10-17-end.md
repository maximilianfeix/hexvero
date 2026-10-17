# Metrics at the end of the sprint (2026-10-17, 18:41 UTC)

Read with the same commands as [metrics-2026-10-17.md](metrics-2026-10-17.md) (the baseline,
00:55 CEST the same day), so the two can be compared. Nothing here is a target.

| Signal                   | Baseline                                       | End of sprint                                  | Command                                                        |
| ------------------------ | ---------------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------- |
| Stars / forks / watchers | 5 / 0 / 0                                      | 5 / 0 / 0                                      | `gh api repos/maximilianfeix/hexvero`                          |
| Repo views, 14 days      | 149, 33 unique                                 | 161, 39 unique                                 | `gh api repos/maximilianfeix/hexvero/traffic/views`            |
| Clones, 14 days          | 2,777, 456 unique                              | 3,107, 533 unique                              | `…/traffic/clones`                                             |
| Referrers, 14 days       | github.com 55/5, reddit.com 12/10, t.co 4/4, … | github.com 57/5, reddit.com 12/10, t.co 4/4, … | `…/traffic/popular/referrers`                                  |
| npm downloads            | not available ("package hexvero not found")    | not available ("package hexvero not found")    | `curl https://api.npmjs.org/downloads/point/last-week/hexvero` |
| DEV article (2026-10-16) | 0 reactions, 0 comments                        | 0 reactions, 0 comments                        | `curl "https://dev.to/api/articles?username=taventix"`         |
| First-user feedback      | none recorded                                  | none recorded                                  | —                                                              |

## Reading

- No change in stars and almost none in views: the sprint shipped releases 0.9.0 to 0.9.6, but
  the posts that reach people (X, Show HN, the community posts) are the maintainer's and were not
  made during the sprint (`docs/launch/status.json`). This reading is the before-value for them.
- Clones grew by about 330 during the day, in which every pull request, release and Pages build
  ran workflows that check out the repository; they say nothing about people.
- The views include the maintainer and the agents of this sprint.
- The npm downloads API still does not know the package, as in the baseline; `npm view hexvero`
  answers with 0.9.6 as the latest version.
