# Five contributor tasks

Each one is a real gap found in the code during the 2026-10-17 sprint (see
`docs/engineering/codebase-map.md`, open questions). Sized for an afternoon; every one has a way
to reproduce it, the files involved and what "done" means. Run `npm install && npm run check`
first.

## 1. The HTTP export writes less than `hexvero export`

- **Reproduce:** `hexvero ui --demo`, click "Export JSON", compare the file with
  `hexvero export examples/notesdesk-1.5.0.asar out.json`. The UI file lacks `complete`,
  `incomplete`, `volatile` and `unknowns`.
- **Files:** `packages/server/src/index.ts` (`sub === "export"`), `packages/core/src/session.ts`
  (`Session.export`), `packages/server/test/server.test.ts`.
- **Done when:** both write the same document (same top-level fields, same `hexvero: 1`), with a
  server test that compares the two for one target.

## 2. The UI cannot read a large app with `fresh`, `include` or `batch`

- **Reproduce:** the CLI and MCP accept `--fresh`, `--include p,q`, `--batch n`; the HTTP route
  `GET /api/targets/:id/analysis` accepts only `scan=continue|all` and answers 400 otherwise.
- **Files:** `packages/server/src/index.ts` (the `scan` parameter), `packages/web/src/views/Workspace.tsx`
  (the "Read next batch" buttons), server tests.
- **Done when:** the route accepts the same options as `Session.continueAnalysis` with validation
  and a test per option; the UI offers "read only these paths" for a partly read app.

## 3. `hexvero_compare` pages four lists with one offset

- **Reproduce:** call `hexvero_compare` with `offset: 50` on a collection with 60 added and 5
  removed items: the removed list comes back empty although none of its items were shown.
- **Files:** `packages/mcp/src/tools.ts` (`hexvero_compare`, the `window` helper),
  `packages/mcp/test/*.test.ts`, `docs/mcp.md`.
- **Done when:** each list (added, removed, changed, unknown) reports its own `next`, the tool
  description says how to page them, and `scripts/check-shape.mjs` still passes (catalog size).

## 4. A brand-new permissive window is not flagged by `hexvero check`

- **Reproduce:** v2 adds a second BrowserWindow with `nodeIntegration: true`; the rule
  `window-more-permissive` reads only `overview.windowChanges`, which pairs windows present in both
  builds, so the new window passes.
- **Files:** `packages/core/src/policy.ts` (`windowDrafts`), `packages/core/test/policy.test.ts`,
  `docs/cli.md`, `docs/policy.schema.json` if a new rule or option is added.
- **Done when:** an added window whose effective settings are permissive (`nodeIntegrationInEffect`
  on, `contextIsolationInEffect` off, `sandboxInEffect` off) is a finding with its file:line, with
  a test for an added restrictive window that is not.

## 5. A stale UI token after a server restart

- **Reproduce:** `hexvero ui`, open the page, stop and restart the server, reload: the page keeps
  the old token from `localStorage` and every call answers 401 until the new link is opened.
- **Files:** `packages/web/src/lib/api.ts` (`adoptHashToken`, `token()`), `packages/web/src/App.tsx`.
- **Done when:** a 401 with a stored token clears it and shows the "open the link `hexvero ui`
  printed" state once, with a unit test of the token logic; the token still never appears in a
  URL after load.
