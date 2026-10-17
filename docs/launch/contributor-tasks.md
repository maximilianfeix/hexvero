# Five contributor tasks

Each one is a real gap found in the code during the 2026-10-17 sprint (see
`docs/engineering/codebase-map.md`, open questions). Sized for an afternoon; every one has a way
to reproduce it, the files involved and what "done" means. Run `npm install && npm run check`
first. To add a new observation or collection, follow
[docs/contributing/new-detector.md](../contributing/new-detector.md).

## Done in the 0.9.0 sprint

Two of the original five were solved in the sprint and are no longer open:

- **`hexvero_compare` pages four lists with one offset.** Each list (added, removed, changed,
  unknown) now pages on its own with `list` + `offset` and reports its own `next`
  (`packages/mcp/src/tools.ts:159,420`). Sprint commit `9500c41`, released in `08f80c5` (#136).
- **A brand-new permissive window is not flagged by `hexvero check`.** `unmatchedWindowDrafts`
  (`packages/core/src/policy.ts:860-920`) judges an added window by its own settings, with tests
  for a new permissive and a new safe window (`packages/core/test/policy.test.ts:1000`). Review
  fix H3, sprint commit `84e8284`, released in `08f80c5` (#136).

Their places below are taken by two gaps verified in the code at `03588ec`.

## 1. The HTTP export writes less than `hexvero export` ([#149](https://github.com/maximilianfeix/hexvero/issues/149))

- **Reproduce:** `hexvero ui --demo`, click "Export JSON", compare the file with
  `hexvero export examples/notesdesk-1.5.0.asar out.json`. The UI file lacks `complete`,
  `incomplete`, `volatile` and `unknowns`.
- **Files:** `packages/server/src/index.ts` (`sub === "export"`), `packages/core/src/session.ts`
  (`Session.export`), `packages/server/test/server.test.ts`.
- **Done when:** both write the same document (same top-level fields, same `hexvero: 1`), with a
  server test that compares the two for one target.

## 2. The UI cannot read a large app with `fresh`, `include` or `batch` ([#150](https://github.com/maximilianfeix/hexvero/issues/150))

- **Reproduce:** the CLI and MCP accept `--fresh`, `--include p,q`, `--batch n`; the HTTP route
  `GET /api/targets/:id/analysis` accepts only `scan=continue|all` and answers 400 otherwise.
- **Files:** `packages/server/src/index.ts` (the `scan` parameter), `packages/web/src/views/Workspace.tsx`
  (the "Read next batch" buttons), server tests.
- **Done when:** the route accepts the same options as `Session.continueAnalysis` with validation
  and a test per option; the UI offers "read only these paths" for a partly read app.

## 3. Reports do not say what a collection means ([#151](https://github.com/maximilianfeix/hexvero/issues/151))

- **Reproduce:** `hexvero compare examples/notesdesk-1.4.0.asar examples/notesdesk-1.5.0.asar
  --report r.md` (or `r.html`): each group is headed by the bare collection name
  (`webPreferences`, `interfaces`). The one-sentence meaning of each list exists only in the web
  UI, `MEANING` in `packages/web/src/lib/compare.ts:265`; `report.ts` and `htmlReport.ts` have no
  such text (verified by searching for the sentences in `packages/*/src`).
- **Files:** `packages/core/src/report.ts` (`ORDER`, the group headings),
  `packages/core/src/htmlReport.ts` (`<section class="group"><h3>`), `packages/web/src/lib/compare.ts`,
  `packages/core/test/report.test.ts`, `packages/core/test/htmlReport.test.ts`.
- **Done when:** the sentences live in `@hexvero/core` (one table, exported), the web UI imports
  them instead of keeping its own copy, both reports print the sentence under each group heading,
  and `scripts/build-site-demo.mjs --check` passes after regenerating the demo.

## 4. The corpus baseline cannot be traced to a commit ([#152](https://github.com/maximilianfeix/hexvero/issues/152))

- **Reproduce:** `corpus/results/hexvero.json` records `tool.version` `0.9.0` and `commit`
  `f39d2f1+uncommitted` (checked 2026-10-17 on 0.9.2), while the packages are 0.9.2. `corpus/observe-hexvero.mjs:286-291`
  appends `+uncommitted` and carries on, so `npm run corpus:accept` from a dirty tree writes a
  baseline nobody can check out; `corpus/gate.mjs` then compares every later run with it.
- **Files:** `corpus/observe-hexvero.mjs`, `package.json` (`corpus:accept`), `corpus/gate.mjs`,
  `corpus/README.md`.
- **Done when:** `corpus:accept` refuses to write `results/` from a tree with uncommitted changes
  under `packages/` or `corpus/` (with a flag to override that is recorded in the file), the gate
  prints the baseline's version and commit next to the current ones, and the baseline is
  regenerated from a clean checkout of the current release.

## 5. A stale UI token after a server restart ([#153](https://github.com/maximilianfeix/hexvero/issues/153))

- **Reproduce:** `hexvero ui`, open the page, stop and restart the server, reload: the page keeps
  the old token from `localStorage` and every call answers 401 until the new link is opened.
  Since 0.9.2 the error says to open the link again and offers Retry (`api.ts` adds the hint to
  every 401), but the stale token is not cleared, so Retry keeps failing.
- **Files:** `packages/web/src/lib/api.ts` (`adoptHashToken`, `token()`), `packages/web/src/App.tsx`.
- **Done when:** a 401 with a stored token clears it and shows the "open the link `hexvero ui`
  printed" state once, with a unit test of the token logic; the token still never appears in a
  URL after load.
