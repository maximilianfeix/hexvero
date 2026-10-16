---
name: hexvero-codebase
description: Orientation for changing the hexvero monorepo (core analyzers, compare/report, CLI, MCP, server, web, corpus, release scripts). Use before editing hexvero code to find the right file, follow a call chain from a surface to the core, and pick the build and test commands that prove the change.
---

# Working in the hexvero codebase

Read [docs/engineering/codebase-map.md](../../../docs/engineering/codebase-map.md) first: a
one-page architecture, six end-to-end paths with `file:line`, design decisions, open questions,
and an inventory of every tracked file with its owner and whether it was read.

## Where things are

- `packages/core/src/session.ts`: `Session`, the one object CLI, MCP and HTTP share. Surfaces
  translate arguments; they do not compute facts.
- `packages/core/src/analyzers/dispatch.ts`: format switch; `scanApplication` for ASAR and
  directories (stored scans, token pool).
- `packages/core/src/javascript/app.ts`: Electron/JavaScript application analysis;
  `scan.ts` (tokenizer, IPC calls), `aliases.ts`, `resolve.ts`, `ambient.ts`, `candidates.ts`,
  `interfaces.ts`, `scanState.ts`, `tokenPool.ts`.
- `packages/core/src/formats/`: one parser per format, each with a byte-built fixture in
  `packages/core/test/fixtures/` and a test (enforced by `scripts/check-shape.mjs`).
- `packages/core/src/compare.ts`, `report.ts`, `source.ts`, `paging.ts`: comparison, release report,
  source windows, byte-budgeted pages.
- `packages/cli/src/index.ts` (commands), `packages/mcp/src/tools.ts` (15 tools, limit 16),
  `packages/server/src/index.ts` (loopback API), `packages/web/src/` (React UI built into
  `packages/cli/ui`).
- `corpus/`, `e2e/`, `scripts/`: measurement, end-to-end flows, release and site generators.

## Commands (root `package.json`)

```bash
export PATH=$HOME/.nvm/versions/node/v22.17.1/bin:$PATH   # Node >= 22.12
npm run build          # tsc -b core, mcp, server, cli; then Vite build of web into packages/cli/ui
npm run check          # typecheck + lint (oxlint) + format:check (oxfmt) + vitest + check:shape
npx vitest run packages/core/test/compare.test.ts   # one test file
npm run e2e            # build, regenerate examples, e2e/flows.test.ts (engines if installed)
npm run corpus         # build, corpus/build.mjs --check, corpus/gate.mjs (no row may get worse)
npm run site:demo      # build, regenerate site/demo from a real comparison
node packages/cli/bin/hexvero.js analyze examples/notesdesk-1.5.0.asar --json   # after build
```

`scripts/check-shape.mjs` reads `packages/mcp/dist`: run `npm run build` before `npm run check` or
the catalog rule is skipped. After changing report output run `npm run site:demo`; CI does not
check `site/demo` (see the map's open questions).

## Rules that keep the code honest

- Never run an analyzed target; engines (radare2, rizin, Ghidra) read files only.
- Parsers throw `AnalysisError` with a code; anything skipped or cut becomes a `limitation` with a
  stable code; every list leaves through `pageOf`.
- Contracts frozen for the sprint are in [docs/engineering/contracts.md](../../../docs/engineering/contracts.md);
  changes go through the lead.
- For evidence rules use the `hexvero-evidence-contracts` skill; for parser fixes
  `hexvero-parser-regression`; for public claims `hexvero-launch-proof`.
