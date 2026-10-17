# Positioning (one page)

**Headline (0.9.0):** Know what changed inside your Electron release.

**Subline:** The interfaces pages can call, window settings and network hosts that changed
between two builds, with the file and line on both sides, what could not be established, and a
policy gate for CI. Locally, without executing the target. (Claims: [claims.md](claims.md) P4.)

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

- Newest blind set `holdout5` (round 4, measured once on 2026-10-17): IPC channels 49 of 54 with
  none false, bridge members 57 of 57, window settings 14 of 39; of the 8 expected changes to v2: channels
  3 of 4, bridge members 4 of 4, window settings 0 of 2, endpoints 1 of 1. Source: `corpus/results/round4/README.md`.
  Always quote the misses with the hits. (`holdout4`, 0.7.3: 12 of 57 channels.)
- Separate from the blind result, never mixed with it: holdout5 as a development set after the
  sprint (72/0/0 channels, 131/9/0 senders and receivers, 17/35/0 window settings, 4 inputs) and
  Electron Fiddle bridge members linked to a main-process end 0 → 45 of 46 (claims.md A6, A7).
- MCP catalog: 16 tools, `tools/list` 15,637 bytes; session start 17,847 bytes, 4,158 tokens with
  `o200k_base` (`node scripts/context-cost.mjs`, 2026-10-17). Re-run before quoting.

## Do not claim

- "secure", "safe", "malicious", "vulnerable" verdicts; that a static finding shows run-time
  behavior or exploitability.
- "complete", "finds all IPC", "replaces Ghidra/REA/Electronegativity".
- "first" or "only" tool that compares versions: REA documents `compare_application_versions`
  (`docs/competitive/matrix-2026-10-17.md`). No market-leadership claim.
- Any user, star or download count as an achievement; any speed comparison not re-measured.
- "Never executes, so it is safe to open anything": parsing hostile bytes is still a risk.
- "No network" without the cloud-agent caveat.
