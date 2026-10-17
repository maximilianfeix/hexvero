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

**Slower than 0.3.0, and why.** Following names through aliases, constants, helper functions
and other files costs passes over the token stream that 0.3.0 did not make; it is what takes the
ChatGPT archive from 3 IPC channels to 23. After merging the cross-file IPC and window work, the
Claude archive took 7.4 s against 2.6 to 2.9 s for 0.3.0 on a quiet machine. Profiling then showed
the tokenizer allocating two substrings per punctuation character, repeated full passes in name
resolution, and a helper-body search that turned superlinear past a fixed budget. Those are fixed,
and applications with 4 MiB of source or more are tokenized in up to three worker threads. Every
change was checked to give byte-identical full exports on 33 inputs (the three archives below,
Discord's core module, Electron API Demos, Electron Fiddle 0.38 and 0.39, the examples and the
corpus) and on the ChatGPT archive.

Medians of alternating runs on 2026-10-14, empty cache each run, macOS on Apple silicon, with
background system load (load average 8 to 30, so absolute times vary by up to a third between
sessions; compare within a row):

| Input                                                   | 0.3.0            | before this work | now, one thread  | now, default threads |
| ------------------------------------------------------- | ---------------- | ---------------- | ---------------- | -------------------- |
| Claude `app.asar` (5 runs)                              | 2.98 s, 628 MiB  | 8.04 s, 585 MiB  | 7.08 s, 599 MiB  | 4.93 s, 801 MiB      |
| ChatGPT `app.asar`, first batch (3 runs)                | 10.84 s, 804 MiB | 23.57 s, 564 MiB | 14.35 s, 708 MiB | 13.38 s, 971 MiB     |
| Discord `app.asar`, under the thread threshold (5 runs) | 0.48 s, 213 MiB  | 0.80 s, 246 MiB  | 0.78 s, 206 MiB  | 0.76 s, 205 MiB      |

After the accuracy work of the same evening (bounded resolver, window options across modules),
three alternating runs each, same machine, load average about 9:

| Input                                    | 0.3.0           | now, one thread  | now, default threads |
| ---------------------------------------- | --------------- | ---------------- | -------------------- |
| Claude `app.asar`                        | 2.68 s, 756 MiB | 7.07 s, 654 MiB  | 4.80 s, 941 MiB      |
| ChatGPT `app.asar`, first batch (2 runs) | 9.19 s, 900 MiB | 14.82 s, 813 MiB | 10.51 s, 1,133 MiB   |

The resolver runs only for calls the fast scan leaves open, and window options are evaluated only
for windows whose options could not be followed; neither changed the times measurably. The results
with and without threads were again byte-identical on all reference inputs.

On the quiet machine earlier the same day, the Claude archive took 5.8 s with one thread and
4.1 s with threads. Analysis is still 1.2 to 1.7 times slower than 0.3.0 with threads and 1.3 to
2.4 times with one; threads cost about 200 MiB more memory and about twice the CPU time. The rest
of the cost is a dozen passes over millions of token objects, bounded by memory access; a compact
token representation would be the next step. `HEXVERO_JS_THREADS=0` turns threads off.

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

The table above was measured before `hexvero_analyze` switched to a short overview by default
(`detail: "full"` gives the earlier result). Token counts for fixed investigations on the corpus,
with the `o200k_base` tokenizer (`node scripts/context-cost.mjs`, 2026-10-14):

| Scenario                                            | Before | After |
| --------------------------------------------------- | ------ | ----- |
| Session start (`tools/list`, prompts, instructions) | 3,763  | 3,796 |
| Native first look: open, analyze, imports           | 1,197  | 885   |
| Electron investigation: open, analyze, four lists   | 5,215  | 2,986 |
| Version comparison: two analyses, three compares    | 9,298  | 3,232 |

`o200k_base` is OpenAI's published tokenizer; Claude's tokenizer is not public, so these counts
are a stand-in that moves in the same direction, not the exact number a Claude model sees.

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

## Repeat runs on a large application (0.7.0)

Measured 2026-10-15 on the same machine (Apple M2, Node 25.2.1) with an empty cache per run;
wall times vary by about ±20 % between runs.

| Command                                      | Wall time | Peak RSS |
| -------------------------------------------- | --------- | -------- |
| `analyze` Claude desktop `app.asar` (47 MiB) | 10.2 s    | 776 MB   |
| the same again, 0.7.0 before the stored scan | 8.0 s     | 819 MB   |
| the same again, with the stored scan (#115)  | 0.3–1.0 s | 179 MB   |
| `compare` Claude vs Discord, overview        | 8.5 s     | 928 MB   |

Cold and warm exports of six real Electron apps are byte-identical apart from timing fields.

## Profile of analyze, compare, report and check (2026-10-17, after 0.9.0)

**Machine and inputs.** Apple M2 (4 performance + 4 efficiency cores), 8 GiB RAM, macOS 26.5.2,
Node 22.17.1, hexvero 0.9.0 at `03588ec`. The machine was **busy**: other agents were running, the
1-minute load average was 12 to 25 on 8 cores during every measurement below (logged per run).
Absolute times are therefore upper bounds; only interleaved comparisons within a row are meaningful.

| Input                     | Bytes      | SHA-256                                                            |
| ------------------------- | ---------- | ------------------------------------------------------------------ |
| Claude desktop `app.asar` | 49,233,786 | `bfa22ac393906762fa04b9607ff202907405b089c1ae7db257159202f31bb3d0` |
| Discord `app.asar`        | 3,613,300  | `d37245e51c24567ed4fc0998e223a70c0cf7c9b02bdf6ee0bd3942df92d050e0` |

Claude against Discord is two different applications, the worst case for whole-list comparison:
almost every item is added or removed.

**Method.** Each run is a fresh process under `/usr/bin/time -l` (wall, user + sys, peak RSS),
with `HEXVERO_CACHE_DIR` pointing to an empty directory for a cold run and to a directory holding
both stored scans for a warm run. Profiles are `node --cpu-prof` (one `.cpuprofile` per thread),
summarized by self and inclusive time per function. A/B runs alternate the two builds in the same
loop (A, B, A, B, ...) so that load affects both alike.

### Where the time goes

`analyze <claude> --json --fresh`, 12.6 s wall, 30.6 s CPU, 824 MiB peak. Timeline of the
threaded run (busy share of each thread per 0.5 s): the main thread reads the archive and plans for
1.1 s, three token workers are then busy from 1.1 s to 9.6 s, and the main thread assembles for the
last 1.4 s. With `HEXVERO_JS_THREADS=0` the same work in one thread, inclusive time:

| Function (packages/core/dist/javascript)  | Inclusive | Self   |
| ----------------------------------------- | --------- | ------ |
| `readFileTokens` (app.js), all per-file   | 81 %      | 0.6 %  |
| `onTokens` (app.js), the per-file readers | 35 %      | 5.1 %  |
| `findCandidates` (candidates.js)          | 22 %      | 5.5 %  |
| `resolveArgument` (resolve.js), bounded   | 15 %      | –      |
| `Constants` constructor (aliases.js)      | 15 %      | 3.9 %  |
| `tokenize` (scan.js)                      | 12 %      | 10.9 % |
| garbage collector                         | 9 %       | 9.0 %  |
| `resolveAliases` (aliases.js)             | 9 %       | 6.1 %  |
| `collectAmbient` (ambient.js)             | 5 %       | 4.6 %  |

No function holds more than 11 % of self time; the cost is a dozen linear passes over the token
stream per file, spread evenly over three workers that stay busy until the same last half second. No
single change there passes the 10 % bar while keeping the output identical; the largest isolated
item, `/ipc|webContents/.test(source)` in `scanJavaScript`, is 2.6 %. That path was left alone.

`compare <claude> <discord>` cold is the same scan (the Claude archive) plus 0.8 s for Discord:
9.1 s median. Warm, with both scans stored, `compare`, `compare --report r.md|r.html` and `check
--policy examples/policy.json` take 0.26 to 0.30 s, and the profile of `check` shows where:

| `check`, warm, one profile (busy CPU)        | 0.9.0         | after the change |
| -------------------------------------------- | ------------- | ---------------- |
| sampled CPU                                  | 284 ms        | 196 ms           |
| module loading (`node:internal/modules/*`)   | 107 ms (38 %) | 34 ms (18 %)     |
| MCP SDK, zod, ajv and `@hexvero/mcp` frames  | 30 ms (11 %)  | 0                |
| `@hexvero/core` work (load, compare, policy) | 122 ms (44 %) | 123 ms (66 %)    |

(Three profile pairs; the quietest is shown. The others: 551 → 402 ms and 1,141 → 364 ms.)

The CLI imported `@hexvero/mcp` at the top of `packages/cli/src/index.ts`, so every command loaded
the MCP SDK, zod and ajv. Measured on its own (`await import`), that adds 61 to 106 ms after
`@hexvero/core` (29 to 36 ms). It is used by one command, `hexvero mcp`.

### The change

`@hexvero/mcp` is now imported inside `case "mcp"`, like `ui`, `check` and `demo` already were.
Nothing else changed.

Interleaved A/B, 9 runs each, warm cache, load 12.9 to 15.9 (median 14.1):

| Command (Claude → Discord)            | 0.9.0 median (min–max) | after (min–max)    | Change | Peak RSS      |
| ------------------------------------- | ---------------------- | ------------------ | ------ | ------------- |
| `compare`                             | 0.26 s (0.24–0.70)     | 0.19 s (0.18–0.22) | −27 %  | 205 → 184 MiB |
| `compare --report r.md`               | 0.28 s (0.26–0.34)     | 0.20 s (0.19–0.24) | −29 %  | 212 → 187 MiB |
| `compare --report r.html`             | 0.30 s (0.27–0.42)     | 0.24 s (0.21–0.28) | −20 %  | 226 → 201 MiB |
| `check --policy examples/policy.json` | 0.29 s (0.26–0.38)     | 0.21 s (0.19–0.30) | −28 %  | 213 → 188 MiB |
| `--version`                           | 0.12 s (0.11–0.15)     | 0.06 s (0.06–0.10) | −50 %  | 75 → 55 MiB   |

Cold paths, interleaved, 3 runs each, load 11.7 to 25.3. The change cannot touch the scan; these
rows show the noise of a loaded machine, not an effect:

| Command                                 | 0.9.0 runs (s)     | after runs (s)     | CPU median, A → B |
| --------------------------------------- | ------------------ | ------------------ | ----------------- |
| `analyze <claude> --json --fresh`       | 10.63, 8.62, 12.02 | 10.25, 9.13, 6.88  | 31.1 → 27.2 s     |
| `analyze <claude> --json` (stored scan) | 0.32, 0.52, 0.26   | 0.34, 0.31, 0.13   | 0.25 → 0.18 s     |
| `compare`, empty cache                  | 7.78, 21.63, 9.12  | 16.71, 31.11, 9.52 | 30.4 → 35.8 s     |
| `check`, empty cache                    | 6.84, 8.13, 8.47   | 9.17, 9.55, 9.25   | 30.0 → 30.6 s     |

Peak RSS of the cold runs was 605 to 1,039 MiB on both builds.

**Same output.** Before and after, from an empty cache each: `analyze --json` of both archives,
of `examples/notesdesk-1.4.0.asar`, `notesdesk-1.5.0.asar` and `notesdesk-1.5.0.bundle.js`; on
both pairs (Claude → Discord and notesdesk 1.4.0 → 1.5.0) `compare` as text and `--json`,
`compare ipc --json`, `compare --report` as `.md` and `.html`, `check` as text, `json` and
`sarif`, and `export` of the first input. All 23 files are byte-identical after removing
`openedAt`, `exportedAt` and `durationMs`, and every exit code is the same.

## Scan time after 0.9.1 (2026-10-17)

**Problem.** `analyze <discord> --json --fresh` was measured at 1,065 ms median for 0.9.1 against
842 ms for 0.9.0 (7 interleaved runs, registry installs), over the budget of 15 % slower.

**Cause, by profile.** Same machine as above (Apple M2, 8 GiB, Node 22.17.1). `node --cpu-prof` of
one fresh analysis of Discord in one process, inclusive time (self where noted) averaged over 5 profiles before (load 6.0 to 16.8) and 4 after (load 13.4):

| Function (packages/core/dist/javascript)                   | `c2b1020` | after  |
| ---------------------------------------------------------- | --------- | ------ |
| `moduleResolver` (app.js): evaluating window options again | 122 ms    | 30 ms  |
| `tokenize` (scan.js), self                                 | 115 ms    | 45 ms  |
| garbage collector                                          | 126 ms    | 57 ms  |
| `windowRanges` (app.js), via `ExpressionResolver.binding`  | 212 ms    | 135 ms |
| `enclosing` + `functions` (resolve.js), self               | 99 ms     | 34 ms  |

The window-options evaluation added in 0.9.1 (`moduleResolver`, for a window whose options the
ranges could not follow) tokenized the scanned file a second time. Discord's `bundle.js` (3.06 MB)
was tokenized twice, and every per-file table of the resolver (brackets, functions, the innermost
function per token, names, declarations) is kept per token array, so all of them were built a
second time for the copy. The scan now hands its own token stream to that evaluation when the file
was tokenized in the same thread (a worker's tokens stay in the worker; then it tokenizes as
before). Besides, five more tables that depend on the tokens alone (the bracket parents, the export
index, the webpack module table, function declarations and parameter names by name) were built per
`ExpressionResolver` instance, and a file has several (scan, window ranges, bridge, navigation);
they are now shared per token array like the others. One quadratic copy (`[...list, d]` per
function declaration of the same name) is a push.

**Result.** CLI, `analyze <app> --json --fresh`, a fresh process per run, an empty
`HEXVERO_CACHE_DIR` per build, the three builds interleaved, 7 runs each (registry installs of 0.9.0
and 0.9.1, this checkout's build):

| Input   | Load (1 min) | 0.9.0 median, runs (ms)                   | 0.9.1                                              | after                                              |
| ------- | ------------ | ----------------------------------------- | -------------------------------------------------- | -------------------------------------------------- |
| Discord | 7.7 → 6.8    | 864: 995 872 802 796 772 966 864          | 1,043 (+20.7 %): 1043 1001 1025 1066 990 1278 1062 | 852 (−1.4 %): 852 880 844 834 849 898 863          |
| Claude  | 6.6 → 13.4   | 7,222: 7222 7792 6405 7400 6471 7424 6711 | 6,946 (−3.8 %): 6874 6526 6965 6582 6991 6946 7547 | 7,192 (−0.4 %): 7192 6788 7000 7757 7181 7341 9648 |

The scan alone (one `Session` analysis in a process, without CLI start), Discord, 7 interleaved
runs at load 8.0 → 7.5: 0.9.0 (`03588ec`) median 689 ms (739 667 689 688 676 744 699), after 781 ms
(841 769 770 782 836 781 778), +13 %; `c2b1020` was 974 to 1,286 ms in 5 runs at load 16.8 → 14.8.
Claude is read by three token workers, which hid the extra work of 0.9.1 there.

**Function cap.** The resolver's per-file cap raised from 20,000 to 200,000 functions (in
`c2b1020`) shows no measurable cost on Claude: the same build with the cap set back to 20,000, 5
interleaved runs of the scan at load 20.8 → 19.5, medians 7,646 ms (200,000: 8950 7503 7646 7646 6915) against 7,714 ms (20,000: 8536 6593 6272 7714 7714). The spread under that load is larger
than any difference.

**Same output.** From an empty cache, before (`c2b1020`) and after: `analyze --json --fresh` of
Discord, Claude (also with `--all`), `examples/notesdesk-1.4.0.asar` and `notesdesk-1.5.0.asar`,
and `corpus/observe-hexvero.mjs` over the corpus: identical after removing `openedAt` and
`durationMs`. `npm run corpus`: none worse, `corpus/results` unchanged.

## Blind result on corpus/holdout3

`corpus/holdout3` was written by an independent agent without access to hexvero's code or
output. Its expectations were committed before any run, and hexvero 0.7.0 was scored once:

| Class                 | 0.7.0, blind | 0.7.3 (holdout3 now a development set) |
| --------------------- | ------------ | -------------------------------------- |
| IPC channels          | 16 / 23      | 23 / 23                                |
| senders and receivers | 24 / 33      | 46 / 47                                |
| bridge members        | 0 / 26       | 26 / 26                                |
| window settings       | 11 / 14 \*   | 14 / 14                                |
| endpoints (false)     | 4 / 7 (2)    | 6 / 7 (0)                              |
| storage keys          | 9 / 9        | 9 / 9                                  |
| v1 → v2 changes       | 5 / 8        | 8 / 8                                  |

\* Rescored with the corrected scorer; the scorer of that day reported 9 / 14 (see the set's
README). The 0.7.3 column covers the plain, bundled and minified builds, which all score the
same. The fixes came from this set, so the 0.7.3 column is not a blind number.

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
