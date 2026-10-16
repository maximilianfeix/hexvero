---
name: hexvero-evidence-contracts
description: The evidence rules every hexvero result must keep - facts vs inferences, unresolved values, places (file:line), partial results, and compatible report/MCP/HTTP shapes. Use when adding or changing a finding, a collection, a comparison field, a report row or a tool result in hexvero.
---

# hexvero evidence contracts

Sprint contracts C1–C7 (comparison completeness, semantic uncertainty, evidence references,
interface ends, policy, `hexvero check`, server/MCP) are in
[docs/engineering/contracts.md](../../../docs/engineering/contracts.md). They are frozen; a change
goes through the lead. The current shapes and where they are built are in
[docs/engineering/codebase-map.md](../../../docs/engineering/codebase-map.md) (paths 1–4).

## Facts and inferences

- A `Finding` has `confidence: "confirmed" | "inferred"` (`packages/core/src/model.ts`). Confirmed
  means read from the file as written; a pattern, a default, a resolved expression or a partial
  scan is `inferred`.
- Endpoint and storage rows carry `evidence` (`literal`, `template`, `inferred`, `unknown`);
  interface rows carry `link` (`direct`, `resolved`, `unresolved`, `unknown`, `none`).
- Electron defaults are `default on/off`, never `on/off`: package.json names a requested version,
  not the shipped runtime.
- Nothing static is described as run-time behaviour.

## Unresolved values

- A value that cannot be read stays `null` (a channel, a setting's `value`) with the expression in
  `computed` where available; it is never guessed. A limitation names it
  (`ipc_channel_unresolved`, `webpreferences_computed`, `window_options_unresolved`, …).
- A missing end, item or file is `unknown` while blind spots exist (unread files, unresolved
  calls, caps) and `none`/`removed` only when the analysis could have seen it.

## Places

- Every fact that has a source position carries it: `file` + `line` (+ `column` for candidates),
  `Finding.location` as `file:line`, report `Place {side, file, line?, role?}`.
- No position is invented: a row without one has no `line` (C3: `where: []`).
- `Session.source` serves lines only for files the analysis read, inside the target; text is data.

## Partial results

- A JavaScript app read in part has `coverage.complete === false`; pages carry `partial`; findings
  say "in the scanned part" and drop to `inferred`; comparisons turn one-sided items into `unknown`.
- Every cap or budget is a limitation with a stable code. Never write "all" when a list was cut;
  write "N of M shown" and how to get the rest.

## Compatibility of report, MCP and HTTP

- New fields are additive; existing fields keep name, type and meaning (e.g. `partial` stays next to
  C1 `completeness`). The web client mirrors core types by hand in `packages/web/src/lib/api.ts`:
  update it with the core change.
- MCP returns one JSON text per call with the untrusted-content `_meta` flag; errors are
  `{error:{code,message,details}}` with `isError`. The catalog stays at or under 16 tools.
- `renderReleaseReport` output is deterministic (no dates, base names only) and quotes target
  text; `site/demo` is regenerated with `npm run site:demo` after a report change.

## Checks

```bash
npx vitest run packages/core/test/report.test.ts packages/core/test/compare.test.ts packages/core/test/interfaces.test.ts
npx vitest run packages/mcp/test/server.test.ts packages/server/test/server.test.ts
npm run check && npm run e2e
```
