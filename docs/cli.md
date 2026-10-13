# CLI reference

All commands accept `--json` for machine-readable output and `--no-color`. Paths may be relative.

| Command                                                                            | What it does                                                                                                                                        |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `analyze <path> [--out file.json]`                                                 | Detects the format, runs the analyzer, prints summary, findings, limitations and the collections that exist. `--out` also writes the complete JSON. |
| `collection <path> <name> [--text s] [--limit n] [--offset n]`                     | Pages one list. Unknown names return the available ones.                                                                                            |
| `strings <path> [--min n] [--utf16] [--tag t] [--text s] [--limit n] [--offset n]` | Printable strings with offsets and tags.                                                                                                            |
| `bytes <path> <offset> [length]`                                                   | Hex dump (max 64 KiB). Offset accepts `0x` hex.                                                                                                     |
| `compare <a> <b> <collection> [--key field]`                                       | Added/removed items between two targets, keyed by `name` or `--key`.                                                                                |
| `export <path> <out.json>`                                                         | The complete analysis as JSON.                                                                                                                      |
| `provider <path> <engine> <operation> [--address a] [--text s] [--timeout ms]`     | Runs radare2/rizin/ghidra operations: functions, disassemble, decompile, strings, imports, xrefs, callers, callees, callgraph, search.              |
| `calls <path> <engine> <root> [--direction d] [--depth n] [--max n] [--goal g]`    | Bounded call-graph neighborhood around a function, or the shortest call path to `--goal`.                                                           |
| `mcp`                                                                              | Serves MCP over stdio.                                                                                                                              |
| `ui [--port n] [--host h] [--open]`                                                | Starts the local web UI (default port 7331).                                                                                                        |
| `doctor`                                                                           | Checks Node, `node:sqlite` and engines.                                                                                                             |
| `setup [--client c] [--apply]`                                                     | Registers the MCP server; dry run by default.                                                                                                       |

Exit codes: `0` success, `1` analysis error (`{"error":{"code","message","details"}}` with `--json`), `2` usage error.

## Collections by format

| Format               | Collections                                                                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| ELF                  | sections, segments, symbols, imports, exports, libraries, goDependencies                                                                         |
| PE                   | sections, imports, exports, libraries, goDependencies; .NET adds types, methods (with IL facts), calls, cil, pinvokes, userStrings, assemblyRefs |
| Mach-O               | segments, sections, symbols, imports, exports, libraries, goDependencies; fat adds slices                                                        |
| WASM                 | imports, exports, types, sections                                                                                                                |
| EVM                  | selectors, instructions, opcodes                                                                                                                 |
| SQLite               | tables, columns, indexes, triggers, samples                                                                                                      |
| HAR                  | requests, hosts, endpoints                                                                                                                       |
| APK                  | permissions, components, libraries, files, classes, packages, dexFiles                                                                           |
| JAR                  | classes, packages, manifest                                                                                                                      |
| Java class           | methods, fields, referencedMethods, referencedClasses, constants                                                                                 |
| DEX                  | classes, packages, dexStrings                                                                                                                    |
| ZIP                  | files                                                                                                                                            |
| Electron / directory | modules, edges, externals, ipcChannels, ipc, sourceMaps                                                                                          |
| JavaScript file      | references, ipc, exports                                                                                                                         |
| Source map           | sources, packages                                                                                                                                |

`findings` and `limitations` exist for every format.
