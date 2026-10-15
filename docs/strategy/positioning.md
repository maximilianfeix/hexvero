# Positioning

**hexvero: evidence-first software intelligence.** Inspect artifacts, trace interfaces, compare
builds, locally and without running the target.

## One sentence against the neighbours

REA helps an agent understand how a feature in someone else's application works and rebuild it,
using decompilers and runtime capture. Electronegativity checks Electron code against a list of
security anti-patterns. hexvero tells you, from the files alone, what a build exposes and what
changed since the last one, and points at the line that shows it.

## Where hexvero is the right tool

- **Release review of an Electron app:** before shipping, see which preload members, IPC
  handlers, window settings, endpoints and storage keys differ from the last release
  ([`docs/use-cases/release-interface-diff.md`](../use-cases/release-interface-diff.md)).
- **Mapping an unfamiliar Electron app:** from page API to main-process handler, with file and
  line ([`docs/use-cases/electron-interface-map.md`](../use-cases/electron-interface-map.md)).
- **A first look at any binary or package:** format, imports, exports, libraries, hardening,
  strings, without an engine installed.
- **An agent with a small context budget:** 15 MCP tools and paged, size-capped results.

## Where it is not

Decompiling functions (use Ghidra, IDA, Hopper or REA), observing behaviour at run time (REA,
Frida, a debugger), or rule-based security scoring (Electronegativity and its successors).

## Claims and their evidence

| Claim                                    | Where it is checked                                                                  |
| ---------------------------------------- | ------------------------------------------------------------------------------------ |
| Never runs the target                    | No process spawn in the analyzers; engines run only on request (`calls`, `provider`) |
| Same input, same output                  | `session.test.ts` export byte-identity; threaded vs sequential corpus exports        |
| No removal claimed for what was not read | `compare.test.ts`, `session.test.ts` (2,000-item cut, coverage)                      |
| Interface links are exact                | `interfaces.test.ts`; 0 false links on 15 corpus inputs (development sets)           |
| 15 MCP tools                             | `tools/list` of the published package                                                |

The feature-by-feature comparison is in [`differentiation.md`](differentiation.md).
