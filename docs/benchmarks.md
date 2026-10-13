# Benchmarks

The hexvero numbers on this page are produced by `scripts/bench.mjs` and can be reproduced with
the command next to them. The REA comparison further down was run once with the scripts recorded in
[docs/rea-compare](rea-compare/README.md). Numbers describe one machine on one day; they are
evidence for orders of magnitude, not promises.

## hexvero

```bash
npm run build && node scripts/bench.mjs
```

Measured 2026-10-13 on an Apple M2 with 8 GiB RAM, macOS 26.5, Node 25.2.1, hexvero at commit
`479a916` plus the scan fast paths of the following commit. Each input is analyzed three times,
each time in a fresh process (`hexvero analyze <input> --json --fresh`); peak memory is the maximum
resident set size reported by `/usr/bin/time -l`. The machine was not idle during this run (1-minute
load 8 to 11 on 8 cores), so the times are upper bounds rather than best cases.

| Input                           | Size      | First run | Median of 3 | Peak RSS | `analyze --json` output |
| ------------------------------- | --------- | --------- | ----------- | -------- | ----------------------- |
| `examples/notesdesk-1.4.0.asar` | 6.1 KiB   | 0.21 s    | 0.19 s      | 85 MiB   | 12.1 KiB                |
| `/bin/ls` (fat Mach-O)          | 151 KiB   | 0.17 s    | 0.17 s      | 77 MiB   | 4.3 KiB                 |
| The Node launcher binary        | 66.8 KiB  | 0.16 s    | 0.16 s      | 76 MiB   | 4.6 KiB                 |
| Discord `app.asar`              | 3.4 MiB   | 0.66 s    | 0.66 s      | 231 MiB  | 18.4 KiB                |
| Claude `app.asar`               | 46.8 MiB  | 6.60 s    | 6.60 s      | 595 MiB  | 37.0 KiB                |
| ChatGPT `app.asar`, first batch | 541.5 MiB | 17.44 s   | 16.57 s     | 715 MiB  | 39.7 KiB                |
| ChatGPT `app.asar`, `--all`     | 541.5 MiB | 35.2 s    | one run     | 719 MiB  | 14,816 of 14,816 files  |

The first batch of the largest archive is 5,000 of its 14,816 JavaScript files; `--all` reads all
of them in three batches and leaves a 17.8 MB scan state under the cache directory.

**Slower than 0.3.0, and why.** Run alternately on the same Claude archive (12.2 million tokens in
391 files), 0.3.0 took 2.6 to 2.9 s and this build 6.0 to 6.5 s, with the same peak memory. The
difference is the name resolution added in this version: following renamed bindings, constants and
helper functions with their scopes costs about as much as tokenizing. It is what takes the same
analysis of the ChatGPT archive from 3 IPC channels to 23. Making it cheaper is open work.

The three application archives are whatever versions were installed on the test machine; they are
not redistributed. Add your own files as arguments to `scripts/bench.mjs`.

### What an agent sees

Measured in the same run with a real MCP client over stdio (`@modelcontextprotocol/sdk`):

| Measurement                                                 | Value                                         |
| ----------------------------------------------------------- | --------------------------------------------- |
| `tools/list` result                                         | 15 tools, 13,668 bytes                        |
| `prompts/list` result                                       | 5 prompts, 1,650 bytes                        |
| `hexvero_open` + `hexvero_analyze` on the 541.5 MiB archive | 17 s for a first batch, 23,671-byte result    |
| The same `hexvero_analyze` again in the session             | 0.01 s                                        |
| One default page of `modules` on that archive               | 21,751 bytes, 100 of 5,000 items, `next: 100` |

Bytes are not tokens. As a rough guide, English-like JSON runs at three to four bytes per token
with common tokenizers; measure with your model's tokenizer if you need token counts.

The page size is not an accident of this input: `maxBytes` is a hard bound on the serialized page
(default 262,144 bytes), enforced on the real UTF-8 size and covered by tests that try multibyte
text, escape-heavy strings, long keys, thousands of fields and deep nesting
(`packages/core/test/paging.test.ts`).

### Limits these numbers show

- Memory grows with the JavaScript that is scanned in one batch, not with the archive size or the
  number of batches: about 0.7 GiB for a 541 MiB archive, whether 5,000 files are read or all
  14,816.
- Analysis time for large Electron apps is dominated by tokenizing JavaScript in one worker thread.
- Engine-backed operations (call graphs, cross-references) are not in this table; their time is the
  engine's analysis time. On the example program, radare2 6.2 and rizin 0.9 answer in about 0.1 s.

## Compared with REA 6.4.0

The comparison is now run on the [corpus](../corpus/README.md), where the correct answers are
written down, with both tools pinned (hexvero `a6d9b82`, REA `rea-agents` 6.4.0, Node 24.21.0 for
both). It lives in [corpus/compare](../corpus/compare/README.md): the harness, every decision about
how REA's output is mapped onto the corpus's classes, the raw data of 1,460 runs, and
[summary.md](../corpus/compare/summary.md) with correctness per class and set first and cost per
question second.

Three things from it belong on this page:

- Correctness on the hold-out set, the only set neither tool had seen, is in the README table.
  hexvero was tuned on the other two sets; its results there are not a fair comparison.
- Sizes do not depend on the machine. `tools/list`: 13,428 bytes for hexvero's 15 tools, 1,954,693
  for REA's 170 (1,772,772 with its compact profile). Per question about one small Electron
  application over MCP: 15 to 21 KB from hexvero; from REA a 24 KB summary with counts but no
  names, or 1 to 6.5 MB complete, which REA refused to send for the three largest inputs because it
  exceeds its own response budget (its export file works).
- Times were taken while the machine was busy (1-minute load 6 to 77 on 8 cores, swapping) after
  waiting 20 minutes for it to calm down. They are published as measured and marked as such, and
  no speed comparison is made from them.

The earlier comparison on installed desktop applications (2026-10-13, hexvero before 0.3.0) had
three flaws this one avoids: hexvero was an uncommitted working copy, the applications cannot be
redistributed, and on the largest one hexvero had read 5,000 files against REA's 15,211. Its
scripts remain in [docs/rea-compare](rea-compare/README.md) as a record; its numbers are no longer
quoted.

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
