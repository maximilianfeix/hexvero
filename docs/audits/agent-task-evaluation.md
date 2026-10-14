# Agent task evaluation (2026-10-14)

Does an agent answer static-triage questions better with hexvero or with REA? This is a small,
reproducible experiment, not a benchmark of either tool's whole range.

## Method

- **Harness:** `scripts/agent-eval.mjs`. Each run is `claude -p` (Claude Code 2.1.300 in print
  mode) with the same model (`sonnet`), started from an empty directory with
  `--setting-sources project` (no user hooks or plug-ins) and `--strict-mcp-config` with exactly
  one MCP server: hexvero (`oss/round-5`) or REA 6.5.0. All built-in tools are disallowed (no
  shell, no file reading), so the answer can only come from the MCP server.
- **Prompt:** identical for both tools, neutral (no tool names, no hints about either tool's
  workflow). It asks for a block between `ANSWER` and `END`, one item per line, and to leave out
  what cannot be determined.
- **Tasks:** five questions about `corpus/holdout2` (bundled builds for single-app questions, plain
  builds for the comparison), graded mechanically against `expected.json`: hits, items the
  expectations rule out, and items that are not expected.
- **Repetitions:** two per task and tool.
- **Measured:** correctness, turns (model round trips, roughly tool calls plus one), wall time,
  tokens read and written as Claude Code reports them, and Claude Code's API-equivalent cost.

## Limits

- `holdout2` was used to develop hexvero after its blind measurement, so hexvero has seen
  these idioms. REA has not. This favours hexvero on correctness. A fresh blind set is the fix
  (PROGRESS.md).
- One model, one client, two repetitions, five tasks.
- Claude Code loads MCP tool schemas on demand when there are many tools, so REA's 3 MB catalog is
  not paid in full; the token numbers are what this client actually used.
- The grader reads only the answer block. It does not judge explanations or citations.

## Results

Raw rows: `corpus/compare/results/agent-eval/`. Tokens are what Claude Code read in total
(input, cache writes and cache reads), summed over the run; cost is Claude Code's
API-equivalent figure.

### Variant A: only the MCP server (no file reading), two repetitions

|                                     | hexvero  | REA 6.5.0 |
| ----------------------------------- | -------- | --------- |
| Expected items answered             | 98 of 98 | 62 of 98  |
| Tasks answered completely           | 10 of 10 | 0 of 10   |
| Items ruled out by the expectations | 0        | 0         |
| Items not expected                  | 0        | 0         |
| Turns per task (mean)               | 7.7      | 28.4      |
| Wall time, all 10 runs              | 154 s    | 1,051 s   |
| Tokens read per task (mean)         | 116 k    | 1,591 k   |
| Cost, all 10 runs                   | $1.01    | $6.51     |

Per task (first and second repetition):

| Task                                               | hexvero | REA 6.5.0 |
| -------------------------------------------------- | ------- | --------- |
| t1 all IPC channels, editor (22)                   | 22, 22  | 17, 14    |
| t2 all IPC channels, music player (20)             | 20, 20  | 12, 12    |
| t3 channel behind `window.inkwell.getSettings` (1) | 1, 1    | 0, 0      |
| t4 channels added and removed between versions (2) | 2, 2    | 1, 0      |
| t5 core window settings, music player (4)          | 4, 4    | 3, 3      |

Neither tool led the agent to a wrong item. REA's agent left items out and said why; several
of its answers say that the full result went to a file it could not read without a file tool.
That is REA's documented way to handle large results, so variant B allows reading files.

### Variant B: the MCP server plus file reading, one repetition

|                                     | hexvero  | REA 6.5.0 |
| ----------------------------------- | -------- | --------- |
| Expected items answered             | 49 of 49 | 49 of 49  |
| Tasks answered completely           | 5 of 5   | 5 of 5    |
| Items ruled out by the expectations | 0        | 0         |
| Items not expected                  | 1        | 1         |
| Turns per task (mean)               | 7.8      | 7.6       |
| Wall time, all 5 runs               | 82 s     | 190 s     |
| Tokens read per task (mean)         | 120 k    | 177 k     |
| Cost, all 5 runs                    | $0.52    | $0.89     |

The one item that was not expected is the same for both: the template channel
`plugin:${pluginId}:event`, whose names exist only at run time. The expectations leave it out on
purpose; both agents named it as a template.

## Conclusion

- With file reading, which is how REA documents its large results, **correctness was the same**:
  every expected item, nothing wrong, for both tools.
- hexvero got there in **less than half the wall time** and with **about a third fewer tokens**,
  in the same number of turns.
- Without file reading, REA's agent could not reach its results and left out a third of the
  items. hexvero needed no files. That says something about workflow fit for clients without file
  access, not about the analysis itself.
- Small experiment, one model; `holdout2` favours hexvero (see Limits). Not yet a basis for a
  general claim.
