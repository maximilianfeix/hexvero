# Contributing

```bash
npm install
npm run check          # typecheck, lint, format check, tests
npm run build          # all packages plus the web UI into packages/cli/ui
node packages/cli/bin/hexvero.js analyze /bin/ls
npm run ui             # start the UI from source
```

More checks, when your change touches them:

```bash
npm run e2e            # real flows: Electron, native through radare2/rizin (if installed), compare, MCP over stdio
npm run corpus         # the corpus inputs rebuild to the same bytes, and no corpus result got worse
node scripts/smoke-tarballs.mjs   # install the packed packages into an empty project and use them
```

## Where things are

| Path                                                              | What it is                                                                                                                                                                     |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/core/src/formats/`                                      | one parser per file format; no dependencies                                                                                                                                    |
| `packages/core/src/javascript/`                                   | the JavaScript scanner: tokenizer, name resolution (`aliases.ts`), endpoints and storage (`candidates.ts`), Electron app analysis (`app.ts`), continued scans (`scanState.ts`) |
| `packages/core/src/providers/`                                    | radare2, rizin and Ghidra as child processes; call graphs                                                                                                                      |
| `packages/core/src/session.ts`                                    | targets, analysis cache, collections and paging, shared by CLI, MCP and HTTP                                                                                                   |
| `packages/mcp`, `packages/cli`, `packages/server`, `packages/web` | thin adapters and the React UI                                                                                                                                                 |
| `corpus/`                                                         | inputs with written-down correct results and the scorer ([README](corpus/README.md))                                                                                           |
| `skills/hexvero/`                                                 | the agent skill; a test checks that it names only tools and commands that exist                                                                                                |

## Fixing a missed or wrong finding

The corpus makes these reviews objective:

1. Reproduce it with a small input. If it is an Electron or native idiom the corpus lacks, add it
   to a `corpus/dev` case (sources plus an expectation with a `why`) and run `node
   corpus/build.mjs`.
2. Run `node corpus/observe-hexvero.mjs && node corpus/score.mjs corpus/results/hexvero.observations.json --set dev`
   and see the row fail.
3. Fix the detector and add a unit test.
4. `npm run corpus` must pass; `npm run corpus:accept` records the new result.
5. Do not look at `corpus/holdout` or tune on it: it measures how hexvero does on code it was not
   fitted to.

## Platforms

|         | Unit tests | End-to-end with engines |
| ------- | ---------- | ----------------------- |
| macOS   | CI         | CI (radare2)            |
| Linux   | CI         | CI (radare2)            |
| Windows | CI         | not tested              |

Node.js 22.12 is the minimum; SQLite needs 22.13 or 24.

## Rules

Automated by `npm run check` (`scripts/check-shape.mjs`): no `any`, `AnalysisError` instead of bare
`Error` in parsers, a test per format, `confidence` literals, `console.log` only in the CLI, at most 16
MCP tools. The rest is checked by reviewers.

- No `any`. `exactOptionalPropertyTypes` is on.
- Parsers live in `packages/core/src/formats/`, throw `AnalysisError` with a code, and have a test
  that builds its fixture byte by byte under `packages/core/test/fixtures/`.
- A finding has `confidence: "confirmed" | "inferred"`. Anything skipped, truncated or unreadable
  becomes a `limitation` with a stable `code`.
- Every list returned to a caller is paged. Never return an unbounded array from CLI, MCP or HTTP.
- The MCP catalog stays at or under 16 tools; prefer a parameter over a new tool.
- `console.log` only in the CLI package; MCP speaks on stdout.

## Roadmap

`docs/growth/90-day-roadmap.md` lists what is planned next and why; the gap analysis in
`docs/audits/competitive-gap-analysis.md` explains the priorities.

## Pull requests

One issue per feature, one PR per issue, squash-merged. Titles use conventional commits
(`feat(core): …`, `fix(web): …`). The Review workflow posts a threaded report on every PR.

## Releases

Write the notes under `## [Unreleased]` in CHANGELOG.md, then from a clean `main`:

```bash
npm run release:check          # optional rehearsal: checks, build, version gate, tarball smoke test
npm run release -- 0.3.0       # bump, gates, commit and tag locally; nothing is pushed
git push --atomic origin main v0.3.0   # the point of no return (or: npm run release -- 0.3.0 --push)
```

`npm run release` bumps every package, the version constants and `server.json`, removes the
"this describes main" note from the READMEs (add it back between the `unreleased-note` markers when
`main` gains features npm does not have yet), moves the notes under the version and runs every gate the workflow runs (checks, build, version consistency, an
install of the packed tarballs with a real CLI, MCP and UI session) before it commits and tags.
Pushing the tag starts the Release workflow:

1. `verify` (no credentials): checks, build, the version matches the tag, the tagged commit is on
   `main`, pack, install the tarballs into an empty project and exercise them, `npm publish
   --dry-run`.
2. `publish`: a **draft** GitHub release with the tested tarballs, `npm publish` of exactly those
   tarballs with provenance, then read-back from the registry until every integrity matches.
3. `registry-smoke` (no credentials): installs the release from npm, requires the installed
   packages to be the released tarballs, and runs the same smoke test.
4. `finalize`: only now the GitHub release becomes public (`--prerelease` and npm tag `next` for
   versions like `1.0.0-rc.1`).

npm tries trusted publishing first (OIDC from this repository's `release.yml`); the `NPM_TOKEN`
repository secret is the fallback. The first workflow-driven release is the first real test of
that path: confirm the trusted publisher or the token's scope on npmjs.com before tagging.

If a run fails after some packages were published, use **Re-run failed jobs**: it reuses the
tarballs of the first attempt, and versions already on npm with identical content are accepted. A
version with different content fails the run; nothing is skipped silently. Starting the workflow
by hand runs `verify` only; packages whose version is already on npm are reported as SKIPPED.
