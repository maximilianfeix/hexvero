# Benchmarks

The hexvero numbers on this page are produced by `scripts/bench.mjs` and can be reproduced with
the command next to them. The REA comparison further down was run once with the scripts recorded in
[docs/rea-compare](rea-compare/README.md). Numbers describe one machine on one day; they are
evidence for orders of magnitude, not promises.

## hexvero

```bash
npm run build && node scripts/bench.mjs
```

Measured 2026-10-13 on an Apple M2 with 8 GiB RAM, macOS 26.5, Node 25.2.1, hexvero `main` (the 0.3.0
release candidate). Each input is analyzed three times, each time in a fresh process
(`hexvero analyze <input> --json`); peak memory is the maximum resident set size reported by
`/usr/bin/time -l`. The CLI keeps no analysis cache between processes, so the first run and the
median differ only by the operating system's file cache.

| Input                           | Size      | First run | Median of 3 | Peak RSS | `analyze --json` output |
| ------------------------------- | --------- | --------- | ----------- | -------- | ----------------------- |
| `examples/notesdesk-1.4.0.asar` | 6.1 KiB   | 0.16 s    | 0.16 s      | 78 MiB   | 9.7 KiB                 |
| `/bin/ls` (fat Mach-O)          | 151 KiB   | 0.16 s    | 0.16 s      | 76 MiB   | 4.3 KiB                 |
| The Node launcher binary        | 66.8 KiB  | 0.19 s    | 0.17 s      | 76 MiB   | 4.6 KiB                 |
| Discord `app.asar`              | 3.4 MiB   | 0.36 s    | 0.36 s      | 221 MiB  | 12.9 KiB                |
| Claude `app.asar`               | 42.4 MiB  | 2.32 s    | 2.32 s      | 533 MiB  | 28.7 KiB                |
| ChatGPT `app.asar`              | 541.5 MiB | 10.22 s   | 9.98 s      | 835 MiB  | 25.9 KiB                |

Run to run on this 8 GiB machine, the largest input took 10 to 13 s and peaked between 730 and
900 MiB, depending on what else was in memory; the comparison further down ran on Node 24.21 and
an earlier build and peaked at 652 MiB.

The three application archives are whatever versions were installed on the test machine; they are
not redistributed. Add your own files as arguments to `scripts/bench.mjs`.

### What an agent sees

Measured in the same run with a real MCP client over stdio (`@modelcontextprotocol/sdk`):

| Measurement                                                 | Value                                         |
| ----------------------------------------------------------- | --------------------------------------------- |
| `tools/list` result                                         | 15 tools, 12,847 bytes                        |
| `prompts/list` result                                       | 5 prompts, 1,650 bytes                        |
| `hexvero_open` + `hexvero_analyze` on the 541.5 MiB archive | 9.6 s, 15,029-byte result                     |
| The same `hexvero_analyze` again in the session             | 0.01 s                                        |
| One default page of `modules` on that archive               | 21,751 bytes, 100 of 5,000 items, `next: 100` |

Bytes are not tokens. As a rough guide, English-like JSON runs at three to four bytes per token
with common tokenizers; measure with your model's tokenizer if you need token counts.

The page size is not an accident of this input: `maxBytes` is a hard bound on the serialized page
(default 262,144 bytes), enforced on the real UTF-8 size and covered by tests that try multibyte
text, escape-heavy strings, long keys, thousands of fields and deep nesting
(`packages/core/test/paging.test.ts`).

### Limits these numbers show

- Memory grows with the JavaScript that is scanned, not with the archive size alone: about 0.8 GiB for a
  541 MiB archive, of which 5,000 JavaScript files were scanned and the rest reported as a
  limitation (`js_files_truncated`).
- Analysis time for large Electron apps is dominated by tokenizing JavaScript in one worker thread.
- Engine-backed operations (call graphs, cross-references) are not in this table; their time is the
  engine's analysis time. On the example program, radare2 6.2 and rizin 0.9 answer in about 0.1 s.

## Compared with REA 6.4.0

Measured 2026-10-13 on the same machine with Node 24.21.0 for both tools: REA `rea-agents` 6.4.0
from npm (git tag `rea-agents-6.4.0`), and a frozen copy of hexvero's working tree on `main` (after
`a87f93b`, with uncommitted work that has since been merged). Where hexvero changed afterwards, the
table says so. The machine was under load during these runs (load average 6 to 12, swap in use), so
sizes, counts and exit codes are reliable and wall times are indicative; sub-second differences
mean nothing. "Cold" means the tool's own cache was deleted, not the operating system's file cache.
Inputs are the files in `examples/`, a C program compiled with `cc -O1`
([source](rea-compare/demo.c)), and application archives installed on the test machine. Setup,
commands and scripts: [docs/rea-compare](rea-compare/README.md).

| Measurement                            | REA 6.4.0                                                                                                                                                                                                 | hexvero                                                                                                                            |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `tools/list` result over stdio         | 170 tools, 1,954,693 bytes                                                                                                                                                                                | 15 tools, 12,847 bytes                                                                                                             |
| … with REA's compact schema profile    | 1,772,772 bytes                                                                                                                                                                                           | n/a                                                                                                                                |
| … without output schemas               | 458,073 bytes                                                                                                                                                                                             | 12,847 bytes (it has none)                                                                                                         |
| … in `o200k_base` tokens               | 509,696                                                                                                                                                                                                   | 3,043                                                                                                                              |
| Electron example, one analysis call    | 2.8 s warm, 429 MiB (5 processes), 1,317,187 bytes                                                                                                                                                        | 0.13 s warm, 84 MiB, 7,940 bytes (9,411 bytes on the current build)                                                                |
| … correctness against the known answer | 6 of 6 IPC channels, all window settings, all 6 bridge members; of the endpoints one false, one missed                                                                                                    | 6 of 6 IPC channels, all window settings; bridge members missing (listed since); endpoints and storage not reported for an archive |
| Diff of the two example builds         | 3 calls, 10.1 s, 450,066 bytes, 78 items, from 2.6 MB of input JSON; channel changes, bridge change, new endpoint and storage key reported; the settings flip appears as one window removed and one added | 2 calls, 0.33 s, 1,240 bytes; channel and settings changes exact; bridge swap missed (exact since, with a third call)              |
| Native program without an engine       | imports, library, signature detail in 2 calls, 2.4 to 3.0 s each, with the commands and tool hashes behind each fact                                                                                      | imports, library, decoded PIE and canary in 2 calls, 0.12 s each                                                                   |
| Native call graph                      | needs Ghidra, Hopper or IDA (none installed: not run)                                                                                                                                                     | radare2 or rizin, 0.2 to 0.3 s                                                                                                     |
| 568 MB Electron archive                | 821 s in a single run, 1.0 GiB (1,029 MiB), 554,367,786 bytes; 15,211 JavaScript files parsed, coverage marked partial                                                                                    | 13.7 s cold (13 to 19 s over three runs), 652 MiB, 25,254 bytes; 5,000 of 14,816 JavaScript files scanned, stated as a limitation  |
| Bundle source recovery on macOS        | `capability_unavailable` (needs a Wakaru binary, Linux x64 only)                                                                                                                                          | 4 module files (split, not rewritten)                                                                                              |

Notes that belong with these numbers:

- REA refuses the Claude and ChatGPT archives by default with `artifact_integrity_mismatch`, a
  documented integrity check; the row above uses the policy its error message names
  (`--integrity-policy record-and-continue`).
- REA's catalog is 76% output schemas; a client that ignores them still loads 458 KB.
- REA reported things that hexvero does not report for an Electron archive (it does for a
  standalone bundle): fetch endpoints and storage keys. It also keeps per-fact evidence ids with
  source ranges, and on larger apps sender-validation observations.
- This comparison found hexvero defects that are addressed on `main`: URLs inside longer strings
  were not tagged, bridge members were not listed, and a tail call hid a call path without any
  limitation. rizin graphs now include tail calls. Through radare2 the path is still not found, but
  the result carries a limitation instead of a definite "not reached".
- Still open in hexvero: `analyze` raises no finding for an imported `system`, and JavaScript
  scanning stops at 5,000 files.
- On one real app (Discord) REA reported no IPC operations where the archive text contains them and
  hexvero reported 29 call sites; REA's own limitations say that only proven aliases of the Electron
  module are followed and that missing findings do not establish absence. On Claude the two agree
  closely; on ChatGPT they disagree in the other direction on windows and channels. Neither is
  ground truth.
- Not measured: REA with an engine, dynamic analysis, Wakaru recovery, Windows or Linux hosts.

## End-to-end checks

`npm run e2e` runs the four user flows on real inputs and fails if a result is wrong, so the demo
outputs in the README cannot drift from the product:

| Flow             | What is real                                                       | What it asserts                                                                                                                                                                   |
| ---------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Electron         | the example archives in `examples/`                                | every finding's `file:line` contains the text it claims; IPC senders and receivers; recovered module files                                                                        |
| Native           | a C program compiled on the spot; radare2 and rizin when installed | imports and strings; the same call graph and path through each engine; cross-references; cache reuse, invalidation on file or engine change, shared concurrent runs, cancellation |
| Build comparison | two builds of the C program and of the Electron app                | known additions appear; moved symbols are `relocated` with a sample; a flipped setting is a change                                                                                |
| Coding agent     | the built CLI over MCP stdio                                       | open, analyze, a budgeted query, bytes, unknowns, compare, export, a refused overwrite, a structured error                                                                        |

CI runs them on Linux without an engine (those assertions are logged as skipped, never passed
silently) and on macOS with radare2 installed. Ghidra is exercised only through fixtures of its
export script's output.
