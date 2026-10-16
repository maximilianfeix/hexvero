# Positioning (one page)

**Headline:** Know what changed inside your app.

**Subline:** Inspect Electron apps and binaries, trace findings to their source, and compare
releases. Locally, without executing the target.

## Who it is for

1. **Electron developers and security engineers** who ship or review a desktop app and want to
   know what an update actually changed: which IPC channels a page can reach, which preload
   members appeared or went away, which window settings moved, which servers the code now calls.
2. **Developers who do that work through a coding agent** (Claude Code, Codex, Cursor) over MCP,
   and need answers small enough for the agent's context with a citation per claim.

Not first: reverse engineers who live in IDA or Ghidra. For them hexvero is a fast first pass.

## The problem

A release diff of an Electron app is a diff of minified bundles. Reading it by hand does not
scale; running the app to find out is not always allowed or safe. Existing static checkers
(Electronegativity, ElectroNG) look for known risky patterns in one build; they do not say what
changed between two builds with the line behind each change.

## The promise, and the proof for each part

| Claim                                   | Proof in the repository                                                          |
| --------------------------------------- | -------------------------------------------------------------------------------- |
| Shows what changed between two builds   | `npx hexvero demo`; `compare --report`; `packages/core/src/report.ts`; e2e flows |
| Each change traced to file and line     | `Place` rows in the report; `/api/targets/:id/source`; `report.test.ts`          |
| Facts and inferences kept apart         | `●`/`○`, `literal`/`inferred`, `link direct/resolved/unresolved`                 |
| Says what it could not establish        | `limitations`, `unknown` rows, the "Not established" section                     |
| Does not execute the target             | no code path runs a target; engines read files only (README, FAQ)                |
| Local                                   | no network calls in the code base; UI on 127.0.0.1 with a token                  |
| Measured accuracy, including its misses | `corpus/`, blind sets `holdout2` (round3) and `holdout4`                         |

## Numbers you may quote (with their source)

- Newest blind set `holdout4` (measured once with 0.7.3): 12 of 57 IPC channels, 36 of 48 window
  settings with 4 false, bridge members 66 of 66, 5 of 8 version changes. Source:
  `corpus/holdout4/README.md`. Always quote the misses with the hits.
- MCP catalog: 15 tools; session start about 3,800 tokens with `o200k_base`
  (`node scripts/context-cost.mjs`, README table). Re-run before quoting.

## Do not claim

- "secure", "safe", "malicious", "vulnerable" verdicts; that a static finding shows run-time
  behavior or exploitability.
- "complete", "finds all IPC", "replaces Ghidra/REA/Electronegativity".
- Any user, star or download count as an achievement; any speed comparison not re-measured.
- "Never executes, so it is safe to open anything": parsing hostile bytes is still a risk.
- "No network" without the cloud-agent caveat.
