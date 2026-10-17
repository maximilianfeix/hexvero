# Launch kit: "Know what changed inside your Electron release"

Prepared 2026-10-16 for hexvero 0.8.0, updated 2026-10-17 for 0.9.0 (the release gate). Every
claim in these files is a row in [claims.md](claims.md) with its command, commit, date and
limitation. Nothing here invents users, stars, testimonials or vulnerabilities.

| File                                             | What it is                                                              |
| ------------------------------------------------ | ----------------------------------------------------------------------- |
| [claims.md](claims.md)                           | Claim registry for 0.9.0: claim, command, commit, date, scope, limits   |
| [positioning.md](positioning.md)                 | One page: who, problem, promise, proof, what not to claim               |
| [release-notes-0.9.0.md](release-notes-0.9.0.md) | 0.9.0 release notes: before/after per feature, breaking change, limits  |
| [release-notes-0.8.0.md](release-notes-0.8.0.md) | Release notes matching what shipped in 0.8.0                            |
| [article.md](article.md)                         | Second technical article (draft): the release gate                      |
| [hn-fact-brief.md](hn-fact-brief.md)             | Facts and limits for a Show HN the maintainer writes himself            |
| [posts.md](posts.md)                             | X post and thread, Show HN title and first comment, two community posts |
| [faq.md](faq.md)                                 | Concrete answers to the questions people will ask                       |
| [channels.md](channels.md)                       | Channels with URL, audience, rules as checked, and which post fits      |
| [plan.md](plan.md)                               | Seven-day plan and the signals to watch                                 |

## Assets (all real output)

| Asset                                           | Source                                                                                       |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `docs/screenshots/ui-compare.png`               | Web UI, Compare view, example builds, 1440×900, dark (2026-10-17)                            |
| `docs/screenshots/ui-evidence-before-after.png` | Compare view, evidence panel: `main.js:8` of both builds                                     |
| `docs/screenshots/ui-interface-map.png`         | Interface map of 1.5.0, `checkUpdate` selected (2026-10-17)                                  |
| `docs/screenshots/report-html.png`              | `compare --report report.html`, the changed window (2026-10-17)                              |
| `docs/demo/release-gate.mp4`, `.gif`            | `vhs docs/demo/release-gate.tape`: demo, compare, check exit 3 (25.2 s)                      |
| `docs/screenshots/ui-source.png`                | Web UI, source lines around `main.js:30`                                                     |
| `docs/screenshots/ui-overview.png`              | Web UI, overview of notesdesk 1.5.0                                                          |
| `docs/screenshots/ui-start.png`                 | Web UI start screen                                                                          |
| `docs/screenshots/ui-compare-phone.png`         | Compare view at 390 px                                                                       |
| `docs/social-preview.png` (1200×630)            | Rendered from `docs/launch/assets/social-preview.html`                                       |
| `docs/demo/compare.gif`, `compare.mp4`          | `vhs docs/demo/compare.tape`: `hexvero demo`, `compare --report`                             |
| `site/demo/` (website `/demo/`)                 | `node scripts/build-site-demo.mjs` from a real run: `index.html`, `report.md`, `report.html` |
| `docs/launch/before/*.png`                      | The UI before this sprint, for comparison                                                    |

## Status of public actions

| Action                                                   | Status                                                                                                                                                                                  |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Branch, pull request, merge to `main`                    | see the pull request "Launch: know what changed inside your app"                                                                                                                        |
| Release 0.8.0 (tag, npm with provenance, GitHub release) | through `npm run release -- 0.8.0` and the Release workflow                                                                                                                             |
| Website (GitHub Pages)                                   | deploys from `site/` on merge                                                                                                                                                           |
| Repository description and homepage                      | updated to the positioning and the Pages URL                                                                                                                                            |
| Show HN, X, Reddit, DEV posts                            | **not posted**: drafts in [posts.md](posts.md). HN forbids generated text and automated posting; these must be rewritten and posted by the maintainer, on the day in [plan.md](plan.md) |
| awesome-mcp-servers (punkpeye)                           | **not submitted**: the list requires a Glama score badge and hexvero has no Glama listing yet (glama.ai returned 404 on 2026-10-16)                                                     |
| sindresorhus/awesome-electron                            | **not submitted**: asks for 30 days after creation; eligible from 2026-11-11                                                                                                            |
| doyensec/awesome-electronjs-hacking                      | already listed (merged 2026-10-14)                                                                                                                                                      |
| Custom domain hexvero.dev                                | **blocked on the owner**: DNS at Hetzner points elsewhere; see `docs/audits/domain-check.md`                                                                                            |
