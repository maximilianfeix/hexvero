# hexvero and REA on the corpus: a measured comparison

Two static-analysis tools, the same inputs, the same questions, the corpus's own scorer. This
directory holds the harness, the raw results and a summary. It measures; it does not argue.
Where REA is better it says so, and where a comparison would be unfair it is not made.

- **[summary.md](summary.md)**: the tables (correctness first, then cost) and what they do and do
  not show.
- `results/`: every raw number the summary is built from.
- The scripts in this directory: how the numbers were made, and how to make them again.

## What was compared

| | hexvero | REA |
| --- | --- | --- |
| version | commit `a6d9b82` (branch `quality/round-3`), package version 0.3.0 | `rea-agents` 6.4.0 from npm (git tag `rea-agents-6.4.0`) |
| how obtained | `git archive a6d9b82`, `npm ci`, `npm run build` in a scratch directory; the working tree, which moved on during the run, was never measured | the installed package in a scratch directory; version read from its `package.json` and from `rea --version` |
| runtime | Node 24.21.0 | the same Node 24.21.0 binary |
| engines used | radare2 6.2.4 and rizin 0.9.1 (Homebrew) for call graphs | none: REA's deep providers are Ghidra, Hopper and IDA, and none is installed. REA 6.4.0 has no radare2 or rizin provider (no such word in its `dist/`, its README or its docs) |

`results/environment.json` records the rest: OS, CPU, memory, compiler, the SHA-256 of every input
(checked against `corpus/built/SHA256SUMS`), the SHA-256 and modification time of every expectation
file and of the scorer at the start of the run, date, time and load before and after.

The corpus: `corpus/dev`, `corpus/validation`, `corpus/damaged`, and `corpus/holdout`. The hold-out
set appeared while this comparison was being built; it was complete (expectation files and built
inputs, committed) before the final run started and **is included**. hexvero's own observer of the
pinned commit knows three sets; `observe-hexvero-pinned.mjs` runs it a second time for the fourth
without changing it.

## Method

### A. Correctness

`observe-hexvero-pinned.mjs` runs `corpus/observe-hexvero.mjs` of commit `a6d9b82`, unmodified,
against the pinned build and the current inputs. `observe-rea.mjs` runs REA 6.4.0 on the same inputs
and writes the same neutral format. Both files are scored by the current `corpus/score.mjs` against
the current expectation files, one set at a time (`score-all.mjs`); the scorer is run as it is and
its output is kept untouched in `results/scores/`.

REA's calls for the correctness part, one per input:

| input | call | why this call |
| --- | --- | --- |
| Electron archive | `rea analyze-javascript-application <asar> --json` | REA's documented call for an ASAR (`docs/cli.md`); the command line always returns the complete Evidence |
| two versions | `rea compare-application-versions <input.json> --json`, both Evidence records inline | "analyze each version once, then call `compare_application_versions`" (REA skill, `references/javascript-applications.md`) |
| Mach-O | `rea inspect-macho <binary> --json` | the one native call that needs no deep provider |
| damaged input | the call that fits the format, with the corpus's 30 s limit | |

### B. The five questions

| | question | hexvero | REA | scorer classes |
| --- | --- | --- | --- | --- |
| Q1 | Which IPC channels exist and where? | `analyze`, then `collection ipcChannels` and `collection contextBridge` | one analysis, read in one of three ways (below) | IPC channels; IPC senders and receivers; bridge members; bridge member channel |
| Q2 | Which relevant Electron settings are set? | `analyze`, then `collection webPreferences` | the same analysis | window settings |
| Q3 | Which endpoints and storage keys can be evidenced? | `analyze`, then `collection endpoints` and `collection storage` | the same analysis | endpoints; endpoint method; requests with an unknown URL shown; storage keys; storage read/write/delete |
| Q4 | What changed between two builds? | `compare <a> <b> <list>` for each list the pair is scored on | analyze both, then `compare-application-versions` | changes in … |
| Q5 | Which known native call path can be demonstrated? | `calls <binary> <engine> <from> --goal <to>` for each from/to pair of the expectations, with radare2 and with rizin | no call without a deep provider | call paths |

Each question is costed as if it were asked alone: hexvero's `analyze` is paid again for Q1, Q2 and
Q3. REA answers Q1 to Q3 from one analysis; its call sequence is the same for the three questions,
so it was measured once per input and the same measurement appears in the three rows.

**How REA is read.** REA has no call that returns "the IPC channels" or "the window settings" as a
list. Its documentation describes three ways to read an analysis, and all three were measured:

- **summary**: the documented first step for an application of unknown size. Command line:
  `analyze-javascript-application --json > evidence.json`, wrap it, `inspect-analysis-view` with
  `{"kind":"summary"}` (`docs/cli.md`). MCP: `analyze_javascript_application` with
  `detail: "summary"`. The summary view holds counts ("ipc.literal_channels: 4"), coverage and
  limitations. It names no channel, setting, endpoint or key, so for these questions it is not an
  answer; it is scored as "counts only".
- **filtered** (command line only): `--filter-output normalized_result.graph.nodes`, a documented
  global option. The smallest single output that still holds the facts. It leaves out the semantic
  graph, so the class "requests with an unknown URL shown" is not in it and is not scored for it.
- **complete**: the default result, the complete Evidence, on the command line and over MCP.
- **export** (MCP only): `analyze_javascript_application` with `detail: "summary"`, then
  `export_evidence_bundle` to a file. This is what REA's documentation says to do when the
  complete Evidence does not fit the MCP transport, which happened here for the hold-out
  application. The caller receives two small results and a path; the facts are in the file.
  Both sizes are recorded: `bytesToCaller` and `bytesToFiles`.

The other targeted calls do not fit an inventory question: a module page lists module identities,
a module item "does not include every child syntax observation", and `trace_application_feature`
needs a seed that is already known (a channel name, with at least one character).

From the complete or filtered Evidence the facts still have to be picked out of a graph of nodes.
The harness does that with `lib/rea-map.mjs`; a person would use `jq`, as REA's documentation
does. That step is not a REA call: it is neither counted nor timed, and the byte counts are what
REA returned, not what the mapping kept. For hexvero the returned pages are reduced by
`lib/hexvero-map.mjs`, which only renames fields.

A full export of one tool is never set against a short answer of the other: hexvero's `export` is
not used at all, and REA's complete Evidence is shown next to REA's own smaller ways, each with the
answer it actually carries.

Per run the harness records the exact commands or tool calls, the number of calls, the bytes
returned per call and in total, the wall time, the peak resident set size, the exit status and
errors, and the answer reduced to the neutral format (`results/answers/`), which is then scored.
`results/cli.runs.jsonl` and `results/mcp.runs.jsonl` hold one JSON line per run.

- **Bytes** are what the caller receives: stdout on the command line, the JSON-RPC `result` over
  MCP. Where the documented way sends a large result to a file and the caller reads a smaller one,
  both numbers are recorded and named (`bytesToCaller`, `bytesToFiles`; the size of an input file
  the caller has to hand back is `inputFileBytes`). REA's progress lines on stderr are counted
  apart (`stderrBytes`).
- **Peak RSS**: `treePeakRssBytes` is the sum over the process tree (and the process group),
  sampled every 100 ms with `ps`; a peak shorter than that can be missed. On the command line
  `maxRssBytes` is also recorded: the largest single process as `/usr/bin/time -l` reports it, exact.
- **MCP** runs use a real client, `@modelcontextprotocol/sdk`, over stdio. One session per run.
  `tools/list` is not part of a run; `mcp-catalog.mjs` measures it once as the fixed cost.

### C. Timing discipline

`run-all.sh` reads the 1-minute load average before it starts and waits, for at most 20 minutes,
until it is 4 or less (`results/load-wait.log`). Each run records the load at its start.
Every timed step runs `REPS` times cold and `REPS` times warm (5 in the committed results):

- **cold**: the first run after deleting each tool's own caches. The operating system's file cache
  is not purged (that needs root), so a cold run does not include reading the inputs from disk.
- **warm**: the same run again at once.

Caches: hexvero writes to `HEXVERO_CACHE_DIR`, set to a scratch directory; `~/.cache/hexvero` is
never touched. REA has no cache variable. Its uninstaller removes `~/.rea/cache` and
`~/.rea/state`, and it creates `rea-*` directories under `TMPDIR`; so both tools run with `HOME`
and `TMPDIR` pointing into the scratch directory, and a cold run empties them. For the calls used
here REA left nothing behind in either place: its cold and warm runs differ only by chance.
An MCP server keeps results in memory for the length of a session; that is inside one run.

The two tools alternate within each unit, so a change of the machine load hits both. Reported are
min, median and max, never a mean.

### D. Setup, as needed for these five questions

| | hexvero at `a6d9b82` | REA 6.4.0 |
| --- | --- | --- |
| Node | `>=22.12.0` (root `package.json`) | `^22.19.0 \|\| ^24.11.0 \|\| >=26.0.0` (package `engines`). On Node 25 `npm install rea-agents` picks an older release: the install made that way in the earlier round holds 4.0.1. Not repeated in this round |
| install | built from source here (`npm ci`, `npm run build`); 15 MCP tools | `npm install rea-agents@6.4.0`: 190 packages, 144 MB in `node_modules`; 170 MCP tools |
| Q1–Q4 on Electron archives | nothing else | nothing else |
| Mach-O imports | nothing else (own parser) | the system's `nm`, `otool`, `dyld_info`, `lipo`, `vtool` (Xcode command line tools; macOS only for this call) |
| Q5, call paths | radare2 or rizin on `PATH` | Ghidra 12.1.x (`GHIDRA_INSTALL_DIR`, a Java runtime), or Hopper, or IDA with an MCP registration. None installed here, so not run |
| agent setup | `hexvero setup` exists; not run | `rea setup` exists; not run, no agent configuration was changed |

The fixed cost of an MCP session (`tools/list`) is in the summary, section 4.

### E. Environment

`results/environment.json`. In short: Apple M2, 8 cores, 8 GiB, macOS 26.5.2, Node 24.21.0,
Apple clang 17.0.0, radare2 6.2.4, rizin 0.9.1.

## Mapping decisions

REA reports the same kinds of facts in other shapes. `lib/rea-map.mjs` maps them, with one rule:
REA gets credit for a fact it reports, in whatever shape; it gets no credit for a fact it does not
report; a fact it reports under another heading keeps REA's heading. The decisions that could be
argued either way are marked **arguable**, with the direction in which they lean.

1. **IPC channels.** A channel is every distinct literal `channel` of REA's `ipc-channel` and
   `ipc-handler` observations. Operations whose channel REA marks `dynamic` (`CH.SAVE`,
   `` `room:${room}:ack` ``) have no name and are left out; REA is not charged a false item for
   them and gets no hit for the constant it did not resolve.
2. **Senders and receivers.** `mode` `send` or `invoke` makes the observation's source file a
   sender; `listen` or `handle` makes it a receiver. The file is the `source` of the observation's
   location.
3. **Window settings.** One setting per `web_preferences` entry with a literal value, for the four
   keys the corpus scores (`preload`, `contextIsolation`, `nodeIntegration`, `sandbox`; the
   expectation files say they are exhaustive for these four). Other keys REA reports, for example
   `webSecurity: false`, are dropped so that they are not counted as false. Entries REA marks
   `dynamic` (an object passed by name, a spread) carry no value and are left out.
   **Arguable**, leans to REA: without the filter REA would be charged false items for correct
   extra settings. hexvero's observer does not need the filter because hexvero at this commit
   lists only these four keys.
4. **Bridge members.** REA gives an API name and a list of member names; each becomes one member.
   An API whose name or members REA marks unknown becomes an entry without a member, which the
   scorer notes as unreadable and does not count.
5. **Bridge member channel: NOT RUN.** REA has no field that says which channel a member uses.
   The scorer would count `null` as wrong for members with a channel and as right for members
   without one; neither is a measurement, so the class is NOT RUN for REA.
6. **Endpoints.** REA's `endpoint` observations with `endpoint_kind: "network"`. Observations of
   kind `route` are REA's own heading for something that is not a request and are left out.
   **Arguable**, leans to REA: `route("rooms:list")` in chat-app is an IPC wrapper that REA files
   as a route; it is neither credited as a channel nor charged as a false endpoint.
7. **Store calls stay endpoints. Arguable, leans against REA; counted both ways.** REA reports
   `store.get("window.bounds")`, `prefs.delete("auth.refreshToken")` and also
   `seen.get("ghost.map-key")` (a `Map`) as network endpoints with mechanism `call:<name>.get`.
   The default mapping keeps REA's heading: they are endpoints, the corpus rules them out, and the
   electron-store keys are missed. The other reading (REA found the key, under the wrong heading)
   is written to `results/rea.observations.alt-store.json` by `--store-calls-as-storage`, scored
   too, and shown in the summary next to the default.
8. **Endpoint method.** REA has no method field. Where the mechanism names an HTTP verb
   (`call:axios.post`, `call:https.get`) the verb is taken as the method. **Arguable**, leans to
   REA. `xhr.open("PUT", …)` and `fetch(url, { method })` carry no verb in the mechanism and get
   none.
9. **Requests with an unknown URL.** REA's application graph has no entry for a request whose
   address it cannot read, but its semantic graph has `request` nodes with `endpoint: null`. Each
   such node counts as a request shown with an unknown URL, unless the application graph has an
   endpoint at the same file and line. **Arguable**, leans to REA: the node is deep inside the
   complete Evidence and is not labelled as a finding. It also cuts the other way: a request whose
   address is fixed but which REA did not resolve (a template) lands here and counts as a false
   "unknown" on top of the missed endpoint. The same double count applies to hexvero.
10. **Storage.** `local-storage` → `localStorage`, `session-storage` → `sessionStorage`,
    `indexed-db` → `indexedDB`. Operations from the mechanism: `getItem`/`get` read,
    `setItem`/`set` write, `removeItem`/`delete`/`deleteDatabase` delete, `open` none.
    An access whose key REA could not read (`name: null`) is not a key and not a false one; it is
    counted in `storageKeysUnread` and scored nowhere, as hexvero's observer does with its rows
    without a value.
11. **Completeness.** REA marks the graph coverage of every corpus input `partial`; that is
    passed on (`complete: false`) and the scorer notes it.
12. **Version comparison. Arguable on three points, all lean to REA.** REA classifies each compared
    item as unchanged, added, removed, changed or unknown. On this corpus it never says added or
    removed: both graphs have partial coverage, and its rule is then to call a one-sided item
    `unknown` ("the opposite graph is incomplete, so an unmatched node cannot be classified as
    added or removed"). The mapping
    - reads `changed` with the single dimension `location` as "moved", not as a change;
    - reads a one-sided `unknown` item as removed (left only) or added (right only);
    - drops a name that is both removed and added: REA's identity of a window or a handler
      contains its line, so a moved item shows up as one gone and one new;
    - for windows, pairs the gone and the new windows in source order and compares their literal
      settings, so that a flipped setting is a change and not a window removed and added.
    The summary also prints REA's own counts per pair, unmapped.
13. **Mach-O.** `inspect-macho` returns imports and exports. Imports are scored. **Functions,
    call paths and direct callers are NOT RUN**: REA lists functions and call relations through a
    deep provider only. **Arguable**: the export list does contain `_main`; counting exports as a
    function list would give REA 1 hit and 6 to 16 misses per binary, a comparison of two
    different things, so it is not made.
14. **Comparison of two Mach-O builds: NOT RUN.** No REA call compares import or symbol tables
    without a deep provider. Diffing two `inspect-macho` results in the harness would be the
    harness's work, not REA's.
15. **Damaged inputs.** A non-zero exit with a structured error is `error`. A result is `flagged`
    only if it names something missing (a parse failure, an integrity contradiction, an empty
    list marked not exhaustive). The limitations REA attaches to every result, intact input or
    not, are not a flag. On this corpus REA refuses all six inputs, so the rule was never needed.

**What the scorer cannot express.** It knows NOT RUN for a whole native observation only. REA's
native observation is RUN for imports, so the scorer's own files for REA
(`results/scores/rea.*.md`) show functions, call paths and callers as *missed*, and
`bridge member channel` with counts. Those rows are an artefact. `rea.observations.json` lists
each such (input, class) pair under `notRun` with its reason, and `summarize.mjs` shows NOT RUN in
their place. Read REA's rows in `summary.md`, not in the scorer's raw files.

## Reproduce

```sh
# 1. hexvero at the commit, outside the repository (does not touch the repository's git state)
mkdir -p "$SCRATCH/hexvero-a6d9b82"
git -C <repo> archive a6d9b82 | tar -x -C "$SCRATCH/hexvero-a6d9b82"
(cd "$SCRATCH/hexvero-a6d9b82" && npm ci && npm run build)        # with Node 24.21.0

# 2. REA 6.4.0 and the MCP client SDK, with the same Node
mkdir -p "$SCRATCH/install" && cd "$SCRATCH/install"
npm init -y && npm install rea-agents@6.4.0 @modelcontextprotocol/sdk

# 3. run
export HEXVERO_DIR="$SCRATCH/hexvero-a6d9b82" HEXVERO_COMMIT=a6d9b82
export REA_PKG_DIR="$SCRATCH/install/node_modules/rea-agents"
export MCP_SDK_DIR="$SCRATCH/install"
export COMPARE_SCRATCH="$SCRATCH/work"
NODE=/path/to/node-24.21.0/bin/node REPS=5 sh corpus/compare/run-all.sh
```

`run-all.sh` runs, in order: `environment.mjs --stage before`, `observe-hexvero-pinned.mjs`,
`observe-rea.mjs` (twice: default mapping and the alternative of decision 7), `mcp-catalog.mjs`,
`run-cli.mjs`, `run-mcp.mjs`, `environment.mjs --stage after`, `score-all.mjs`, `summarize.mjs`.
Each script states its options at the top and can be run alone. No script contains a path of the
machine it was written on.

| file | what it holds |
| --- | --- |
| `results/environment.json` | versions, machine, input and expectation hashes, load before and after |
| `results/load-wait.log` | the load readings while waiting for a calm machine |
| `results/hexvero.observations.json`, `results/rea.observations.json` | both tools in the neutral format; REA's file also lists `notRun` and the size and hash of each raw result |
| `results/rea.observations.alt-store.json` | REA under the alternative of decision 7 |
| `results/scores/<tool>.<set>.md` and `.json` | the scorer's output per set, untouched |
| `results/cli.runs.jsonl`, `results/mcp.runs.jsonl` | one line per timed run of a question |
| `results/answers/` | what the calls of each question returned, in the neutral format, and the blocked items |
| `results/scores/answers/` | those answers scored |
| `results/mcp-catalog.json` | `tools/list` and `initialize` sizes and times |
| `results/cost-per-unit.md` | the cost tables broken down to every input |

REA's raw Evidence files are 1 to 6 MB each and stay in the scratch directory; their sizes and
SHA-256 sums are in `rea.observations.json` under `raw`.

## How the committed results came about

One run of `run-all.sh` on 2026-10-13, 21:01 to 22:33 local time, then three additions, all with
the same scripts and all visible in the files:

1. A mapping error was found after the timed command-line runs had started: a storage access
   whose key REA could not read was passed on as a key named `null` and counted as false against
   REA. It was fixed (decision 10), `observe-rea.mjs --reuse` rebuilt both REA observation files
   from the Evidence of the main run, and `run-cli.mjs --answers-only --tools rea` made each REA
   call once more to rewrite `results/answers/cli.rea.*.json`. No timing was touched. The MCP runs
   started after the fix.
2. The MCP runs showed REA refusing its complete result for the hold-out application. The export
   way was added and run on its own (`run-mcp.mjs --tools rea --variants export --questions
   Q1,Q2,Q3`), 90 runs appended to `results/mcp.runs.jsonl` from 22:36 to 22:44 under the same
   kind of load. `run-all.sh` now includes it.
3. The reason text of the blocked MCP items was rebuilt with `run-mcp.mjs --answers-only --tools
   rea --questions Q4,Q5 --variants none`.

The expectation files and the scorer did not change between the start of the run and the last
scoring (their hashes in `environment.json` were checked again afterwards).

## Found along the way

Defects and oddities, each with what was expected and what happened. None was fixed here.

**hexvero at `a6d9b82`**

1. *rizin, tail call to an import: "No function matches atoi".*
   `hexvero calls corpus/built/holdout/exprcalc.O2.macho-arm64 rizin debug_level --goal atoi --json`
   exits 1 with `{"error":{"code":"invalid_input","message":"No function matches atoi","details":{"candidates":[]}}}`.
   Expected: the path `debug_level → atoi` (the source returns `atoi(level)`; at `-O2` that is a
   jump). With `radare2` in place of `rizin` the same command answers
   `"path":["sym._debug_level","sym.imp.atoi"],"status":"found"`. rizin 0.9.1 lists no function
   for the `atoi` stub in this binary (`rizin -q -c 'aaa;afl~atoi'` prints nothing) and makes
   `debug_level` 1288 bytes long. hexvero's own `collection … imports` lists `_atoi`, so the
   error tells the caller that a function hexvero itself lists does not exist, with no warning
   that the engine's function list is short. Same for `main → atoi`. Both are the two missed
   call paths of the rizin rows; the scorer's note is "path not found, stated without warning".
2. *rizin, a false caller.* `corpus/built/holdout/exprcalc.O0.macho-arm64` with rizin, through
   the pinned observer: `next_token` is reported as a direct caller of `count_binary`; the
   expectations say it is not. With radare2 it is not reported
   (`results/scores/hexvero.holdout.md`).
3. *`webSecurity: false` is not listed.*
   `hexvero collection corpus/built/validation/chat-app.plain.asar webPreferences --json` returns
   7 rows, all with the keys `preload`, `contextIsolation`, `nodeIntegration`, `sandbox`. The
   settings window in `corpus/validation/chat-app/src/main.js` is created with
   `webPreferences: { ...LEGACY_PREFERENCES, sandbox: false, webSecurity: false }`. Expected by a
   user who asks for the relevant settings: `webSecurity: false` in the list or among the
   findings. Actual: in neither. REA reports it. The corpus does not score it.
4. *`hexvero_compare` over MCP returns samples without a way to get the rest.*
   `packages/mcp/src/tools.ts`, lines 400 to 402: `added` and `removed` are cut to 50 items and
   `changed` to 25, and the tool has no offset or limit parameter; the command line returns the
   full lists. No pair of this corpus has that many differences, so this was read in the source
   and not measured.
5. *The pinned observer outside a checkout.* `corpus/observe-hexvero.mjs` run from a `git archive`
   copy prints `fatal: not a git repository` twice and records the commit as `unknown`.
   `observe-hexvero-pinned.mjs` writes the commit it was given instead.

**The scorer and the corpus**

6. *No NOT RUN per class.* `score.mjs` accepts `status: "NOT RUN"` for a whole native observation
   only. A tool that can answer one native class and not the others is counted as having missed
   the others. Worked around in `summarize.mjs` (see "What the scorer cannot express").
7. *Window settings are scored as if every key were expected.* The expectation files say the
   list is exhaustive for four keys; `score.mjs` counts any other reported key as false. A tool
   that correctly reports `webSecurity: false` is charged for it. Worked around by decision 3.
8. *Senders and receivers are counted only for channels a tool found.* A tool that finds fewer
   channels has fewer attributions to miss, so the missed counts of two tools in this class are
   not comparable on their own (hold-out: hexvero 22, REA 12).
9. *An unresolved fixed address counts twice.* A request whose address is fixed but which the tool
   could not resolve is a missed endpoint and, if the tool shows the request, a false "unknown
   URL" as well. Applies to both tools (hold-out: 12 and 16 false).
**REA 6.4.0**, as observed, not as a defect report: store and `Map` calls are filed as network
endpoints; the complete Evidence for a 35 kB archive is 5.7 MB and exceeds REA's own MCP response
budget because the result carries it twice.

## Limits of this comparison

- **The corpus is hexvero's, and hexvero was tuned on two of its sets.** `corpus/README.md`:
  dev was written alongside hexvero and used to tune it; validation was measured once untouched
  and then used for tuning; hold-out was written after that tuning and measured untouched. So
  hexvero's dev and validation rows are results on inputs it was tuned on, and REA was tuned on
  none of them. **Hold-out is the only set on which neither tool had seen the inputs**; read it
  first. All applications are small programs written to contain hard cases, not real products.
- **Small inputs.** The largest archive is about 40 kB. Nothing here says how either tool behaves
  on an application of hundreds of megabytes; REA's summary-first design is built for that case
  and gets no chance to pay off here.
- **REA without an engine.** REA's native analysis is built on Ghidra, Hopper or IDA. With none
  installed, three native classes and Q5 are NOT RUN for REA. This compares hexvero with radare2
  and rizin against REA without its engines; it says nothing about REA with Ghidra.
- **REA does more than was asked.** Decompilation, runtime observation, Android, firmware,
  managed code, browser capture: none of it is in these five questions.
- **The mapping is a judgement.** Fifteen decisions, listed above; one of them is counted both ways.
- **The results hold paths of the machine they were made on** (in error messages REA returned
  and in `environment.json`). The scripts do not.
- **No agent was run.** There was no budget for a model. Nothing here is a statement about how
  often an agent succeeds with either tool or what it costs in tokens. Bytes returned are bytes,
  not tokens.
- **One machine, and a loaded one.** See the summary, section 5.
- **hexvero at one commit.** `a6d9b82`; the branch moved on during the run and later commits were
  not measured.
