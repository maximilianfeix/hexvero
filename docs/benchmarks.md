# Benchmarks

Every number on this page was produced by a script in this repository and can be reproduced with
the command next to it. Numbers describe one machine on one day; they are evidence for orders of
magnitude, not promises.

## hexvero

```bash
npm run build && node scripts/bench.mjs
```

Measured 2026-10-13 on an Apple M2 with 8 GiB RAM, macOS 26.5, Node 25.2.1, hexvero `main` at the
commit after `a87f93b` (the 0.3.0 release candidate). Each input is analyzed three times, each
time in a fresh process (`hexvero analyze <input> --json`); peak memory is the maximum resident set
size reported by `/usr/bin/time -l`. The CLI keeps no analysis cache between processes, so the
first run and the median differ only by the operating system's file cache.

| Input                           | Size      | First run | Median of 3 | Peak RSS | `analyze --json` output |
| ------------------------------- | --------- | --------- | ----------- | -------- | ----------------------- |
| `examples/notesdesk-1.4.0.asar` | 6.1 KiB   | 0.20 s    | 0.18 s      | 78 MiB   | 8.1 KiB                 |
| `/bin/ls` (fat Mach-O)          | 151 KiB   | 0.24 s    | 0.24 s      | 76 MiB   | 4.3 KiB                 |
| Discord `app.asar`              | 3.4 MiB   | 0.40 s    | 0.46 s      | 205 MiB  | 11.7 KiB                |
| Claude `app.asar`               | 42.4 MiB  | 2.89 s    | 2.93 s      | 490 MiB  | 25.4 KiB                |
| ChatGPT `app.asar`              | 541.5 MiB | 13.12 s   | 11.55 s     | 732 MiB  | 24.7 KiB                |

The three application archives are whatever versions were installed on the test machine; they are
not redistributed. Add your own files as arguments to `scripts/bench.mjs`.

### What an agent sees

Measured in the same run with a real MCP client over stdio (`@modelcontextprotocol/sdk`):

| Measurement                                                 | Value                                         |
| ----------------------------------------------------------- | --------------------------------------------- |
| `tools/list` result                                         | 15 tools, 12,847 bytes                        |
| `prompts/list` result                                       | 5 prompts, 1,650 bytes                        |
| `hexvero_open` + `hexvero_analyze` on the 541.5 MiB archive | 10.7 s, 14,123-byte result                    |
| The same `hexvero_analyze` again in the session             | 0.01 s                                        |
| One default page of `modules` on that archive               | 21,751 bytes, 100 of 5,000 items, `next: 100` |

Bytes are not tokens. As a rough guide, English-like JSON runs at three to four bytes per token
with common tokenizers; measure with your model's tokenizer if you need token counts.

The page size is not an accident of this input: `maxBytes` is a hard bound on the serialized page
(default 262,144 bytes), enforced on the real UTF-8 size and covered by tests that try multibyte
text, escape-heavy strings, long keys, thousands of fields and deep nesting
(`packages/core/test/paging.test.ts`).

### Limits these numbers show

- Memory grows with the JavaScript that is scanned, not with the archive size alone: 732 MiB for a
  541 MiB archive, of which 5,000 JavaScript files were scanned and the rest reported as a
  limitation (`js_files_truncated`).
- Analysis time for large Electron apps is dominated by tokenizing JavaScript in one worker thread.
- Engine-backed operations (call graphs, cross-references) are not in this table; their time is the
  engine's analysis time. On the example program, radare2 6.2 and rizin 0.9 answer in about 0.1 s.

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
