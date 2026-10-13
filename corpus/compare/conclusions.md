## 6. What hexvero does better, with the evidence

Read hold-out first: hexvero was tuned on dev and validation, REA on neither, so only hold-out is
level ground (README, "Limits").

- **It names more of what an Electron application does, on every set.** Hold-out, three builds of
  one application, hit / missed / false: IPC channels 41 / 31 / 0 against REA's 33 / 39 / 0; bridge
  members 60 / 9 / 0 against 0 / 69 / 0; window settings 12 / 21 / 0 against 0 / 33 / 0; endpoints
  24 / 18 / 5 against 9 / 33 / 30; storage keys 42 / 9 / 0 against 12 / 39 / 0. On dev and
  validation the gap is wider, and there hexvero had the advantage of having been tuned on the
  inputs. The table "Expected items only one tool reported" counts, per class, what one tool
  reported and the other did not: on hold-out 8 channels, 60 bridge members, 12 window settings,
  15 endpoints and 30 storage keys in hexvero's favour, 2 receiver attributions in REA's.
- **Fewer false endpoints.** REA files calls such as `store.get("window.bounds")`,
  `cache.fetch("items")` and `router.get("/local/route")` under network endpoints: 9, 18 and 30
  false endpoints on dev, validation and hold-out, against hexvero's 0, 0 and 5. Read the other way
  (README, decision 7) REA's false endpoints fall to 6, 6 and 3 and 12 false storage keys appear.
- **It says which channel a bridge member uses.** 18 of 18 on dev, 39 of 39 on validation, 24 of
  60 on hold-out. REA has no such field; the class is NOT RUN for REA.
- **Native call paths and callers with engines that are a `brew install` away.** With radare2:
  every expected function, call path and direct caller on all six binaries, including the paths
  through tail calls at `-O2` (70 call paths, 76 callers, 0 missed, 0 false). With rizin: 68 of 70
  paths and one false caller, all three errors on the hold-out binary (section 2, failed runs).
  REA needs Ghidra, Hopper or IDA for these questions and has no radare2 or rizin provider; with
  none installed they are NOT RUN, which is a statement about setup, not about REA's analysis.
- **Comparing two builds of a native binary.** hexvero: 3 of 3 expected changes on the one pair
  (dev, a tuned set). REA has no call for it without a deep provider: NOT RUN.
- **The answer arrives as a short list.** A caller who asks for the IPC channels gets a page of
  0.5 to 5.9 kB from hexvero after an `analyze` result of 17 to 28 kB (command line; 11 to 17 kB
  and 0.4 to 4.7 kB over MCP). REA has no list call. Its small result, the summary (11.9 kB), holds
  counts and no names. The names are in a graph the caller has to pick apart: 139 to 273 kB with
  `--filter-output`, 1.05 to 6.47 MB complete, for archives of 6 to 35 kB.
- **Over MCP the complete answer of REA did not fit for the hold-out application.** Its Evidence
  for a 35 kB archive is 5.7 MB, sent twice in one result; REA refused all 30 runs with
  `resource_constraint` and pointed to `export_evidence_bundle`, which writes the facts to a file
  (24.9 kB returned, 5.7 to 6.5 MB in the file). That works; it means the caller needs file
  access and a second tool to read the answer.
- **Fixed cost of an MCP session.** `tools/list`: 13,428 bytes for 15 tools against 1,954,693
  bytes for 170 tools (1,772,772 with REA's compact schema profile). Three quarters of REA's are
  output schemas.

## 7. What REA does better, with the evidence

- **Two receiver attributions on hold-out.** In the plain build REA names `main.js` as receiver of
  `sync:cancel` and `license:activate`; hexvero found the channels and missed the receivers. Among
  the channels each tool found on hold-out, REA missed 12 sender or receiver attributions and
  hexvero 22 (the class is only counted for found channels, and REA found fewer).
- **One endpoint on dev.** `/v1/login` in the minified build: reported by REA, missed by hexvero,
  on a set hexvero was tuned on.
- **It reports window settings beyond the four the corpus scores.** For chat-app REA lists
  `webSecurity: false` on the settings window. hexvero at this commit lists `preload`,
  `contextIsolation`, `nodeIntegration` and `sandbox` only, so a caller asking hexvero for the
  relevant settings is not told about `webSecurity: false`. The corpus does not score this; it was
  seen in the raw outputs (`hexvero collection … webPreferences`, 7 rows, none `webSecurity`).
- **It does not call something added or removed that it cannot back.** With partial coverage REA
  classifies every one-sided item as `unknown`: across the three pairs 0 added, 0 removed, 369
  unknown, 117 changed (of which the mapping reads the location-only ones as moved). That is
  cautious and, read literally, no answer to "what changed". Mapped generously it produced 3 false
  changes on the three pairs and hexvero 2, both on hold-out. One is shared: both tools report
  `widget:close` as removed where the expectation is "changed".
- **Every fact carries its own evidence.** Each REA observation has a line and column range, the
  SHA-256 of the file, the extractor and a confidence, and every result states its coverage and
  limitations. hexvero's channel list gives file names; lines are in a second list (`ipc`) that
  these questions did not ask for. This is why REA's output is large; it is also what a careful
  reader may want.
- **The summary stays small.** 11.8 to 11.9 kB whether the Evidence behind it is 1 MB or 6.5 MB.
  The corpus is too small to show what that is worth on a real application.
- **Damaged inputs: no difference.** Both tools refuse or flag all six (6 / 0 / 0 each). REA
  refuses all six with a structured error.
- **Imports without an engine: no difference.** 37 of 37 for both.
- **Breadth that was not asked for.** Decompilation, runtime observation, Android, managed code,
  firmware, browser capture: 170 tools against 15. None of it was measured here.

## 8. What this comparison does not show

- **Anything about large real applications.** The largest input is 50 kB. Coverage, time, memory
  and output size on an application of hundreds of megabytes are not measured, for either tool.
- **Anything about agents.** No model was run. How often an agent reaches a correct answer with
  either tool, in how many turns and at what token cost, is unknown. Bytes are not tokens.
- **REA with its engines.** Ghidra, Hopper and IDA were not installed. Every native result of REA
  beyond the import list is NOT RUN, not bad.
- **Speed.** All timings were taken on a machine with a 1-minute load average between 5.8 and 77
  (median 12) that was swapping (section 5). The medians are reported because they were measured;
  no claim about speed follows from them, in either direction.
- **Memory under normal conditions.** Peak RSS was sampled on a machine short of memory, where
  the system takes pages away; the numbers can be lower than on a machine with free memory.
- **Dynamic analysis, decompilation, other formats.** Not asked.
- **Inputs outside this corpus.** Four small Electron applications' worth of idioms and three C
  programs, written by the hexvero project. A corpus written by the REA project would look
  different.
- **Later hexvero commits.** Only `a6d9b82`.
- **That the mapping is the only fair one.** It is one reading, documented decision by decision,
  with the one decision that moves counts shown both ways.

## 9. Candidate claims for hexvero

One sentence each. "Supported" means: this data shows it, within the limits of section 8.

**Supported by this data**

1. "On the hexvero corpus, including the hold-out set neither tool was tuned on, hexvero names
   more IPC channels, bridge members, window settings, endpoints and storage keys of an Electron
   archive than REA 6.4.0, with fewer false endpoints." (Sections 1 and 6. Say "on the hexvero
   corpus" every time.)
2. "hexvero answers 'which IPC channels exist' with a list of a few kilobytes; REA 6.4.0 has no
   list call, and its smallest output that names the channels was 139 to 273 kB for archives under
   35 kB." (Section 2.)
3. "hexvero's MCP server describes itself in 13 kB; REA 6.4.0's `tools/list` is 1.95 MB."
   (Section 4. A measured fact about two servers, one with 15 tools and one with 170.)
4. "hexvero traces native call paths with radare2 or rizin; REA 6.4.0 needs Ghidra, Hopper or IDA
   for the same question." (Setup, README D. With radare2 all 70 expected paths were right.)
5. "On hold-out hexvero missed 31 of 72 IPC channel occurrences and 21 of 33 window settings."
   (Not a selling point, but true and measured; a claim about completeness has to carry it.)

**Not supported by this data**

1. "hexvero is faster than REA." Every timing was taken under load.
2. "hexvero is more accurate than REA", without "on the hexvero corpus": the corpus is hexvero's
   own and two of its sets were used to tune hexvero.
3. "hexvero finds every IPC channel" or any 100 % claim: 100 % was reached on the tuned sets only.
4. "Agents succeed more often with hexvero" or "hexvero saves tokens": no agent was run, no token
   was counted.
5. "hexvero is better at native analysis than REA": REA's native analysis was not run.
6. "hexvero uses less memory": measured under memory pressure, on tiny inputs.
7. "hexvero scales to large applications": the largest input is 50 kB.
8. "hexvero reports all relevant Electron settings": it does not list `webSecurity`, which REA does.
