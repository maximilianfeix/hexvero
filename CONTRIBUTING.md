# Contributing

```bash
npm install
npm run check          # typecheck, lint, format check, tests
npm run build          # all packages plus the web UI into packages/cli/ui
node packages/cli/bin/hexvero.js analyze /bin/ls
npm run ui             # start the UI from source
```

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
