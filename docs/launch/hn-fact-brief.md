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

Verify both commands from an empty directory on the release you link before posting (latest:
0.9.6, checked 2026-10-17 18:14Z).

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

- Blind set `holdout5` (newest until round 5; see `holdout6` below; one app, three builds, written without access to hexvero, measured
  once on 2026-10-17): IPC channels 49 of 54 found, no false ones; window settings 14 of 39;
  changes between two versions: channels 3 of 4, bridge members 4 of 4, window settings 0 of 2,
  endpoints 1 of 1. Source: `corpus/results/round4/README.md`. Most misses: a wrapper class around
  `ipcMain`, window options built with `Object.assign`.
- Newest blind set `holdout6` (a screenshot annotator, written without access to hexvero,
  measured once on the 0.9.2 code): IPC channels 52 of 64, no false; bridge members 60 of 80, no
  false; storage keys 22 of 41, no false; window settings 44 of 52 with 15 false, all of them
  duplicate rows of literals that were right for their window (fixed after the measurement; the
  set is a development set from then on). Source: `corpus/results/round5/README.md`. Say both the
  hits and the 15.
- Real app, Electron Fiddle 0.38.0 → 0.39.0 (measured with 0.8.0): no false change in channels,
  bridge or windows; 4 changes found by reading the source that hexvero missed. Source:
  `docs/case-studies/electron-fiddle-0.38.0-to-0.39.0.md`.
- After the sprint, Fiddle's handlers registered through its wrapper class
  (`ipcMainManager.handle`) are read: 45 of 46 bridge members with a channel are linked to a
  main-process handler in both builds (0.8.0: 0). Command:
  `node scripts/case-study/bridge-links.mjs packages/core ElectronFiddle <a.asar> <b.asar>`.
- holdout5 after the sprint is a **development set**, not blind (its misses were worked on): IPC
  channels 72/0/0, senders and receivers 131/9/0, window settings 17/35/0 over 4 inputs (0.9.0);
  0.9.1: window settings 32/20/0, window-setting changes v1→v2 1 of 2 (claims N2). Never quote
  these instead of, or mixed with, the blind 49 of 54 above.
- Cost on 0.9.6: Discord `analyze --fresh` 769 ms (0.8.0) → 953 ms (+24 %), Claude.app 6.7 → 7.5 s,
  peak memory not higher; say it, with the reason (one pass per added analysis, sprint report §5).
- Earlier cost: Discord `analyze` median about +7 % (771 → 825 ms; a re-run gave 812 → 879 ms), Claude.app
  within noise; interleaved runs against 0.8.0 on one Apple M2 with other load.
- Verify every row in `docs/launch/claims.md` (A1, A6–A8, N1–N6, B1–B5, E1–E3, F1–F2) on the release you link.
- 0.9.5 shows the new payload field of the one changed IPC call in Fiddle (`NPM_ADD_MODULES` gains
  `useSocketFirewall`): with it, all four changes the 0.8.0 run missed there are reported (claims
  F1, F2).
- 0.9.3 also finds the request of the CLI Fiddle 0.39.0 bundles (`sfw.mjs` → api.github.com),
  through `node:https` and two wrapper functions: claims E1.
- 0.9.2 finds the new Electron Fiddle setting `isUsingSocketFirewall` (stored through the app's
  own `save`/`retrieve` wrappers): claims B3.
- 0.9.1 adds two observations: privileged objects a preload hands to pages (`bridgeExposures`)
  and navigation/new-window handlers (`navigationHandlers`, `returns: deny` only where it is a
  literal). Where the analysis cannot decide, an exposure is kept and flagged, never dropped.

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
