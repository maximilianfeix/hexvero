# Hacker News: fact brief for the maintainer

HN's guidelines say "Don't post generated text or AI-edited text" and "please don't automate
posting" (https://news.ycombinator.com/newsguidelines.html, read 2026-10-17). So this is not a
post. It is the list of facts, sources and limits you need to write one yourself, in your words.

## The one thing to show

Two builds of an Electron app go in; out comes what a page can now reach, which window settings
moved, which hosts are new, each with the file and line on both sides, plus what hexvero could
not establish. Then the same comparison as a CI gate.

```bash
npx hexvero demo
npx hexvero check hexvero-demo/notesdesk-1.4.0.asar hexvero-demo/notesdesk-1.5.0.asar --policy hexvero-demo/policy.json
```

Verify both commands from an empty directory on the release you link before posting.

## Facts you can state (each with its source)

| Fact                                                                                                                       | Source                                             |
| -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Reads ASAR archives, app folders, bundles; never runs the target                                                           | code; README "How it works"                        |
| Comparison covers whole lists (budget 200,000 items/256 MiB per side) and says when it does not                            | `packages/core/src/compare.ts`, contracts C1       |
| An item whose file the other build could not read, or whose value could not be resolved there, is `unknown`, not `removed` | contracts C2; `packages/core/test/compare.test.ts` |
| `hexvero check`: JSON policy, baselines, suppressions with expiry, SARIF 2.1.0, exit 0/1/2/3/4                             | `docs/cli.md`, `docs/ci.md`                        |
| A CI example runs on two synthetic builds                                                                                  | `.github/workflows/check-example.yml`              |
| MCP: 16 tools, `tools/list` 15,637 bytes                                                                                   | `scripts/context-cost.mjs`, `docs/mcp.md`          |

## Numbers, with their limits (say both)

- Newest blind set `holdout5` (one app, three builds, written without access to hexvero, measured
  once on 2026-10-17): IPC channels 49 of 54 found, no false ones; window settings 14 of 39;
  changes between two versions: channels 3 of 4, bridge members 4 of 4, window settings 0 of 2,
  endpoints 1 of 1. Source: `corpus/results/round4/README.md`. Most misses: a wrapper class around
  `ipcMain`, window options built with `Object.assign`.
- Real app, Electron Fiddle 0.38.0 → 0.39.0: no false change in channels, bridge or windows; 4
  changes found by reading the source that hexvero missed. Source:
  `docs/case-studies/electron-fiddle-0.38.0-to-0.39.0.md`.

## Do not say

"finds all", "secure", "vulnerability", "first/only tool to compare versions" (REA documents a
version comparison too: `docs/competitive/matrix-2026-10-17.md`), any star or user count.

## Likely questions and the honest answers

- _How is this different from REA?_ REA is a much broader RE toolkit with runtime capture; it also
  compares app versions. hexvero is Node-only, Electron-delta-first, with a local review UI and a
  CI policy on the same comparison.
- _Electronegativity?_ Single-build misconfiguration checks with SARIF; its README says it is no
  longer actively maintained. hexvero does not try to replace its rule set.
- _Can I trust a pass?_ A pass means nothing new against the policy in what was read. Unreadable
  or unresolved parts make the check `incomplete` (exit 4) by default.
