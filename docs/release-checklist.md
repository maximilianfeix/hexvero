# Release checklist (0.4.0)

Status words: PASS, FAIL, BLOCKED, NOT RUN. Updated 2026-10-14 for branch `oss/round-5`.

| Gate                                                   | How                                                                   | Status                                                  |
| ------------------------------------------------------ | --------------------------------------------------------------------- | ------------------------------------------------------- |
| Type check, lint, format, unit tests                   | `npm run check`                                                       | PASS locally (macOS, Node 25)                           |
| End-to-end flows                                       | `npm run e2e`                                                         | PASS locally (macOS, radare2)                           |
| Corpus inputs rebuild to the committed bytes           | `node corpus/build.mjs --check`                                       | PASS                                                    |
| No corpus result worse than committed                  | `node corpus/gate.mjs`                                                | PASS                                                    |
| Committed examples match the generator                 | `node scripts/build-examples.mjs && git diff --exit-code -- examples` | PASS                                                    |
| Packed tarballs install and work, worker pool included | `node scripts/smoke-tarballs.mjs`                                     | PASS locally                                            |
| Release metadata                                       | `npm run release:check`                                               | PASS                                                    |
| CI on Linux (Node 22, 24), Windows, macOS              | push the branch, open a PR                                            | NOT RUN (branch not pushed)                             |
| Node 22.12 minimum                                     | ran the suite on 22.12 in round 4                                     | PASS (round 4), NOT RUN for round 5                     |
| Ghidra adapter                                         | needs Ghidra                                                          | NOT RUN                                                 |
| Website and homepage links                             | `docs/audits/domain-check.md`                                         | FAIL: hexvero.dev serves a certificate for another host |
| Dependency audit                                       | `npm audit --omit=dev`                                                | PASS (0)                                                |
| Security review items                                  | `docs/audits/security-review.md`                                      | PASS for P1/P2; two P3 items open by decision           |
| Blind accuracy measurement recorded                    | `corpus/results/round3`                                               | PASS (and shows the limits)                             |

## Before tagging

1. Fix the domain (DNS to GitHub Pages and the custom domain in the repository settings), or point
   `homepage` and `server.json` at `https://maximilianfeix.github.io/hexvero/` for this release.
2. Push `oss/round-5`, open a pull request to `main`, and wait for every CI job.
3. Merge, then `npm run release -- 0.4.0` (commits and tags locally) and
   `git push --atomic origin main v0.4.0`; the release workflow publishes with provenance.
4. Check the registry install: `npx hexvero@0.4.0 --version`, `npx hexvero@0.4.0 analyze <asar>`.
