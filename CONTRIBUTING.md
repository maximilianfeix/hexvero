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
npm run release -- 0.2.2
```

The script bumps every package and the version constants, moves the notes under the version,
commits, tags `v0.2.2` and pushes. The Release workflow checks that the tag matches the package
versions, runs the full check, creates the GitHub release with the tarballs and publishes all four
packages to npm with provenance. npm tries trusted publishing first (OIDC from this repository's
`release.yml`, configured on npmjs.com per package); the `NPM_TOKEN` repository secret is the fallback
when no trusted publisher exists. Versions that already exist on npm are skipped, so a re-run is safe.
Run the workflow by hand with "dry run" enabled to exercise the whole pipeline, including
`npm publish --dry-run`, without releasing anything.
