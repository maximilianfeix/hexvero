# hexvero and REA: scorecard

A living record of measured comparisons with [REA](https://github.com/morluto/rea) (npm
`rea-agents`). Every row names the versions, the input, the commands and the result. A row that was
not measured says NOT RUN. Updated 2026-10-14.

**Scope.** REA is a much broader reverse-engineering system: dynamic instrumentation, mobile and
firmware work, decompiler integrations, provenance-signed evidence. None of that is measured here,
and hexvero does not try to match it. This card covers static triage of applications, where both
tools have a documented first step.

**Environment.** Apple M2, 8 GiB, macOS 26.5.2, Node v25.2.1 for both tools. The machine had
background load (load average 4 to 30), so timings are medians of alternating runs and should be
compared within a row, not across sessions. REA 6.5.0 was installed from npm with
`npm install --ignore-scripts rea-agents@6.5.0`. hexvero is commit `9c00044` (branch
`oss/round-5`), unreleased; the released 0.3.0 is measured where it matters.

## Accuracy on code neither tool was fitted to

`corpus/holdout2`: two Electron applications in three builds each (plain, esbuild-bundled,
minified) and one two-version comparison. An independent agent wrote them without access to
either tool (see `corpus/holdout2/README.md`).

Input SHA-256 prefixes: `9166058d61abf470` markdown-editor.plain, `48abcc5336c4cd17` .bundled,
`c1527d4b6fc51fa5` .minified, `290f5d4756cd730d` markdown-editor-v2.plain, `3547c46e5e1d2cc8`
music-player.plain, `47479ec6ed75f18e` .bundled, `404d37bcc0849885` .minified.

| Class (hit of expected, false)     | REA 6.5.0         | hexvero `bdb69b6`, blind | hexvero `9c00044`  | Winner on the blind measurement |
| ---------------------------------- | ----------------- | ------------------------ | ------------------ | ------------------------------- |
| IPC channels                       | 87 of 126         | 90 of 126                | 110 of 126         | close (hexvero +3)              |
| IPC senders and receivers          | 144 of 174        | 173 of 180               | 197 of 210         | hexvero                         |
| Window settings                    | 8 of 63           | 42 of 63, 6 false        | 46 of 63, 0 false  | hexvero                         |
| Bridge members                     | 66 of 135         | 78 of 135                | 129 of 135         | hexvero                         |
| Bridge member channel              | 6 of 66           | 65 of 78                 | 113 of 129         | hexvero                         |
| Endpoints                          | 6 of 57, 39 false | 15 of 57, 10 false       | 15 of 57, 10 false | hexvero, both weak              |
| Storage keys                       | 15 of 57          | 47 of 57, 1 false        | 47 of 57, 1 false  | hexvero                         |
| Changes between versions (5 lists) | 2 of 10, 4 false  | 6 of 10                  | 7 of 10            | hexvero                         |

Only the middle column is a blind measurement of hexvero (`corpus/results/round3`). The work after
it used holdout2's misses, so the right column is a development result. Denominators of the
dependent classes (senders and receivers, bridge member channel) grow with what a tool finds. The
same scorer, mapping rules and REA observer as the earlier comparison were used
(`corpus/compare/README.md`).

Reproduce:

```bash
npm run build
node corpus/observe-hexvero.mjs --out /tmp/h.json && node corpus/score.mjs /tmp/h.json --set holdout2
REA_PKG_DIR=… MCP_SDK_DIR=… COMPARE_SCRATCH=… node corpus/compare/observe-rea.mjs --sets holdout2 --out /tmp/r.json
node corpus/score.mjs /tmp/r.json --set holdout2
```

REA's raw observations and scores are in `corpus/compare/results/rea-6.5.0/`.

## Catalog overhead (MCP `tools/list`)

`node corpus/compare/mcp-catalog.mjs --reps 3` (`corpus/compare/results/rea-6.5.0/mcp-catalog.json`):

|                                                  | tools | `tools/list` bytes | connect median |
| ------------------------------------------------ | ----- | ------------------ | -------------- |
| hexvero `9c00044`                                | 15    | 14,106             | 322 ms         |
| REA 6.5.0 default                                | 207   | 3,087,952          | 1,690 ms       |
| REA 6.5.0 `REA_MCP_INPUT_SCHEMA_PROFILE=compact` | 207   | 2,482,411          | 1,426 ms       |

Winner: hexvero, by a factor of about 175 in bytes. Limitation: clients that load tool schemas on
demand (deferred tools) do not pay REA's full catalog up front; how much of it a given client loads
was not measured.

## Scripted questions over MCP (bytes to the agent, time)

`node corpus/compare/run-mcp.mjs --reps 1 --sets holdout2` (76 sessions,
`corpus/compare/results/rea-6.5.0/mcp.holdout2.runs.jsonl`). The same fixed calls for every input;
this is not an agent and says nothing about answer quality.

| Question                        | hexvero: calls, bytes, wall | REA 6.5.0                                                                             |
| ------------------------------- | --------------------------- | ------------------------------------------------------------------------------------- |
| Q1 IPC channels and handlers    | 4, 10.3 KB, 0.37 s          | summary call: 1 call, 24.8 KB, 5.4 s (counts only; the items need an evidence export) |
| Q2 bridge members               | 3, 6.6 KB, 0.27 s           | (same summary call)                                                                   |
| Q3 window settings              | 4, 9.5 KB, 0.27 s           | (same summary call)                                                                   |
| Q4 changes between two versions | 7, 7.3 KB, 0.37 s           | 3 calls, 3.06 MB, 6.7 s                                                               |

Winner: hexvero on bytes and time. REA's summary is one call where hexvero needs three or four.

## Agent task success (Claude Code, `sonnet`)

`scripts/agent-eval.mjs`, five graded questions about holdout2, the same neutral prompt, one MCP
server per run, details and limits in `docs/audits/agent-task-evaluation.md`:

|                                                   | hexvero           | REA 6.5.0              |
| ------------------------------------------------- | ----------------- | ---------------------- |
| With file reading (1 repetition): items right     | 49 of 49          | 49 of 49               |
| turns per task, wall time, tokens per task        | 7.8, 82 s, 120 k  | 7.6, 190 s, 177 k      |
| Without file reading (2 repetitions): items right | 98 of 98          | 62 of 98               |
| turns per task, wall time, tokens per task        | 7.7, 154 s, 116 k | 28.4, 1,051 s, 1,591 k |

Winner: tie on correctness where both can work as documented; hexvero on time and tokens.
holdout2 was used to develop hexvero, which favours it; REA has not seen it.

## A large real application (no ground truth)

Claude desktop `app.asar` (46.8 MiB, SHA-256 prefix `82a54170115e3e20`), back to back:

|                                                                                                  | wall         | peak RSS        | output   | IPC channels named                                                                              |
| ------------------------------------------------------------------------------------------------ | ------------ | --------------- | -------- | ----------------------------------------------------------------------------------------------- |
| hexvero `9c00044` `analyze --json` (3 runs)                                                      | 5.0 to 5.4 s | 0.90 to 1.02 GB | 52 KB    | 233                                                                                             |
| REA 6.5.0 `analyze-javascript-application --json --integrity-policy record-and-continue` (1 run) | 179 s        | 975 MB          | 123.5 MB | 9 literal; 1,512 channel operations not resolved; 837 limitations (most are result-budget cuts) |
| hexvero 0.3.0                                                                                    | 2.7 to 3.7 s | 0.57 to 0.77 GB |          | 17                                                                                              |

Without the integrity option REA stops with `artifact_integrity_mismatch`, because the archive's
declared integrity does not match an unpacked native file. That is a real finding about the
package, not an error.

hexvero's 233 channels come from the app's typed IPC layer (`"$eipc_message$_…" + "Buddy_$_status"`).
A sample was checked against the source. This app has no written-down ground truth, so these are
observations, not accuracy figures.

## Large-app coverage, speed and memory

- hexvero reads JavaScript applications 5,000 files at a time (`--continue`, `--all`). On the
  three local apps every file was read in one batch, except ChatGPT (5,000 of 14,816 per batch).
- Against its own 0.3.0, hexvero is 1.2 to 1.8 times slower with worker threads and up to 2.6
  times with one thread, and uses about 25 to 30 % more memory with threads
  (`docs/benchmarks.md`). This regression is open.

## Not measured (NOT RUN)

- **Agent task success on other models and clients.** Only Claude Code with `sonnet` was run.
- **Native binaries.** REA's native analysis needs engines it installs itself; not repeated this
  round. The 6.4.0 comparison of imports is in `corpus/compare/summary.md`.
- **Windows and Linux** runs of either tool.
- **Installation friction** of REA 6.5.0 in a clean environment.

## Where REA is stronger

- Scope: dynamic analysis, device and firmware work, decompiler ecosystems, 207 tools.
- Evidence model: signed, hash-addressed evidence records with provenance; hexvero's evidence is
  file and line.
- Checks hexvero does not make: ASAR integrity against the packaged files, sender-validation
  observations in IPC handlers (56 on the Claude archive), utility processes.
- Every JavaScript file goes through a full AST parser (425 files, 7.8 million nodes on the Claude
  archive). hexvero's token scanner reads only patterns.
