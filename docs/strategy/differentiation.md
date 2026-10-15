# Differentiation: hexvero, REA and Electronegativity

Date: 2026-10-15. hexvero 0.6.2. Sources checked on that date:
[REA README](https://github.com/morluto/rea) and docs at `rea-agents` 6.5.0
([cli.md](https://github.com/morluto/rea/blob/main/docs/cli.md),
[javascript-application-workflows.md](https://github.com/morluto/rea/blob/main/docs/javascript-application-workflows.md),
[managed-code-analysis.md](https://github.com/morluto/rea/blob/main/docs/managed-code-analysis.md)),
[Electronegativity README](https://github.com/doyensec/electronegativity) (v1.10.0, December 2022),
and Electron's [security checklist](https://www.electronjs.org/docs/latest/tutorial/security).
Measurements on the same inputs, and the longer feature-by-feature comparison with REA, are in
[`docs/audits/competitive-gap-analysis.md`](../audits/competitive-gap-analysis.md). This page does
not repeat them.

## The question each tool answers

- **REA**: "How does this application work, and how can my agent rebuild the feature?" Its
  README opens with "See a feature you like. Understand how it works, down to the binary level",
  and it combines static analysis, runtime capture (browser, processes, adb) and the Hopper,
  Ghidra or IDA decompilers.
- **Electronegativity**: "Which Electron security anti-patterns does this code contain?" A
  rule-based checker (42 checks in its own sample output) that writes CSV or SARIF. The README
  states that it is no longer actively maintained.
- **hexvero**: "What does this artifact contain, what does it expose, what changed between two
  builds, and what in the file supports each answer?" It reads the files it is given and never
  runs them.

hexvero is the tool for the moment between two builds: you have the previous release and the
new one, and need to know which IPC channels, preload members, window settings, endpoints and
storage keys appeared, disappeared or changed, without reading through a decompiler, and while
telling a real removal apart from a file that wasn't read.

## Comparison matrix

"Yes" in a REA or Electronegativity column comes from their documentation. Where the
documentation doesn't settle it, the cell says so rather than claiming a gap.

|                                   | hexvero                                                                                                                             | REA                                                                                                                                                                                          | Electronegativity                                                   |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Core use case                     | Inventory of what an artifact exposes, and diffs between builds                                                                     | Understand and reconstruct features in a third-party app                                                                                                                                     | Find Electron security misconfigurations                            |
| Static vs dynamic                 | Static only; the target is never executed                                                                                           | Both: static JS/.NET/native, plus browser, process and adb capture                                                                                                                           | Static (AST and DOM parsing)                                        |
| Evidence and traceability         | Each row of an Electron collection carries `file` and `line` (or a byte offset for binaries); findings carry `confirmed`/`inferred` | Evidence records with artifact identity, source locations, observations, inferences and unresolved findings ([cli.md](https://github.com/morluto/rea/blob/main/docs/cli.md))                 | File, line, column, sample, severity and confidence per finding     |
| Deterministic output              | Exports sorted; threaded and sequential runs byte-identical (checked in the corpus gate)                                            | Its managed-code lane checks "deterministic ordering" ([managed-code-analysis.md](https://github.com/morluto/rea/blob/main/docs/managed-code-analysis.md)); not checked for other lanes here | Not documented                                                      |
| Unknown or incomplete results     | `limitations` per analysis; a session ledger of unknowns; a partial JS scan names the files it skipped                              | Unknowns recorded and kept separate from inferences                                                                                                                                          | Parse `errors` listed in the result                                 |
| Electron IPC mapping              | `ipc` collection (sender and receiver per channel, with file and line) and `graph`                                                  | IPC is one of the seed kinds of its application graph                                                                                                                                        | Not a goal of the tool; no channel inventory documented             |
| Preload / contextBridge discovery | `contextBridge` collection: API, member, channel, file, line                                                                        | Electron boundaries in `analyze-javascript-application`                                                                                                                                      | Context isolation checks; no member inventory                       |
| Build-to-build diff               | `hexvero compare a b` (overview) and `compare a b <collection>`; added, removed, changed, relocated, unknown                        | `compare_application_versions` over two application graphs, `compare_source_to_bundle`, .NET member comparison, Evidence bundle compare                                                      | `-u 7..8` lists Electron upgrade breaking changes; no artifact diff |
| CLI                               | Yes: analyze, collection, compare, export, strings, bytes, calls, recover; the unknowns ledger and `hexvero_sourcemap` are MCP only | Yes                                                                                                                                                                                          | Yes                                                                 |
| CI                                | `--json` on every command; no network, no engine needed for JS                                                                      | CLI with documented exit statuses                                                                                                                                                            | GitHub Action producing SARIF code-scanning alerts                  |
| MCP context                       | 15 tools, about 14 KB of definitions; paged collections with byte caps                                                              | 170+ tools (see the gap analysis for measured sizes)                                                                                                                                         | No MCP server                                                       |
| Supported targets                 | Electron/JS, ASAR, ELF, PE, Mach-O, .NET, Java, APK, DEX, WASM, SQLite, plist, HAR, EVM                                             | Broader: adds firmware, packet captures, crashes, logic signals, live devices and websites                                                                                                   | Electron sources, ASAR and HTML                                     |
| Optional external engines         | radare2, rizin or Ghidra for call graphs and xrefs                                                                                  | Hopper, Ghidra, IDA, JADX, objdump, rizin and others, per target                                                                                                                             | None                                                                |
| Required permissions              | Read access to the target; writes only its own cache                                                                                | Runtime lanes run the target with the user's permissions; setup edits agent configs after approval                                                                                           | Read access                                                         |
| Installation friction             | `npx hexvero`; Node 22.12+; no system tools                                                                                         | `npx rea-agents setup`; Node 22.19+/24.11+/26+; on Linux the JS lane needs a procps-compatible `ps`                                                                                          | `npm install -g`; README notes heap-size flags for large ASARs      |

## What hexvero does not try to be

- A decompiler or a replacement for Hopper, Ghidra, IDA or REA's native lanes. hexvero hands
  native call graphs to radare2, rizin or Ghidra when they are installed.
- A runtime tool. No browser automation, no process capture, no device access.
- A security scanner with severities. hexvero reports facts (a window has `sandbox: false`; a
  channel exists) and leaves the verdict to the reader. Electronegativity, or its commercial
  successor, covers rule-based checks.
- A large tool catalog. New capability goes into existing tools and collections.

## Where the claim must hold

The positioning only holds if the implementation backs it. The engineering checks that keep it
honest are tracked in [`docs/engineering/8h-mission-progress.md`](../engineering/8h-mission-progress.md):

1. A diff never reports a removal for something the other side did not read or did not compare.
2. Every Electron row points at a file and a line, or says why it can't.
3. The same input gives byte-identical output.
4. Inferred rows are never labelled confirmed.
