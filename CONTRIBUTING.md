# Contributing

```bash
npm install
npm run check          # typecheck, lint, format check, tests
npm run build          # all packages plus the web UI into packages/cli/ui
node packages/cli/bin/hexvero.js analyze /bin/ls
npm run ui             # start the UI from source
```

## Rules the review workflow enforces

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

Bump versions in all `packages/*/package.json`, add a CHANGELOG entry, tag `vX.Y.Z` and push the
tag. The Release workflow packs every package, creates the GitHub release and publishes to npm when
`NPM_TOKEN` is configured.
