<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/banner-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="docs/banner-light.svg">
  <img src="docs/banner-dark.svg" alt="hexvero – reverse engineer anything, locally. Facts with evidence, honest about what it can't tell." width="100%">
</picture>

[![CI](https://github.com/maximilianfeix/hexvero/actions/workflows/ci.yml/badge.svg)](https://github.com/maximilianfeix/hexvero/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/maximilianfeix/hexvero?style=flat-square&color=F2B84B&labelColor=1B1D21)](https://github.com/maximilianfeix/hexvero/releases/latest)
[![npm](https://img.shields.io/npm/v/hexvero?style=flat-square&color=F2B84B&labelColor=1B1D21)](https://www.npmjs.com/package/hexvero)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2022.12-F2B84B?style=flat-square&labelColor=1B1D21)](package.json)
[![Runtime dependencies](https://img.shields.io/badge/core_dependencies-0-F2B84B?style=flat-square&labelColor=1B1D21)](packages/core/package.json)
[![MCP tools](https://img.shields.io/badge/MCP_tools-15-F2B84B?style=flat-square&labelColor=1B1D21)](#for-ai-agents)
[![Network](https://img.shields.io/badge/network-never-F2B84B?style=flat-square&labelColor=1B1D21)](#faq)
[![License](https://img.shields.io/badge/license-MIT-F2B84B?style=flat-square&labelColor=1B1D21)](LICENSE)

<a href="#install"><img src="https://img.shields.io/badge/Install-F2B84B?style=for-the-badge&labelColor=1B1D21" alt="Install"></a>
<a href="#web-ui"><img src="https://img.shields.io/badge/Web_UI-1B1D21?style=for-the-badge" alt="Web UI"></a>
<a href="#for-ai-agents"><img src="https://img.shields.io/badge/MCP_server-1B1D21?style=for-the-badge" alt="MCP server for AI agents"></a>
<a href="#what-it-reads"><img src="https://img.shields.io/badge/17_formats-1B1D21?style=for-the-badge" alt="17 formats"></a>

**English** · [Deutsch](README.de.md)

[Install](#install) · [What it reads](#what-it-reads) · [CLI](#cli) · [Web UI](#web-ui) · [For AI agents](#for-ai-agents) · [Engines](#optional-engines) · [Compared with REA](#compared-with-rea) · [How it works](#how-it-works) · [FAQ](#faq)

</div>

---

**See what a file is before you trust it, run it or rebuild it.** hexvero reads executables, app bundles, databases and captures on your machine **without executing them** and tells you what it found, how sure it is, and what it could not establish. It is one CLI, one compact MCP server for coding agents, and one local web UI, built on parsers that need nothing but Node.js.

```bash
npx hexvero analyze /Applications/Notion.app/Contents/Resources/app.asar
npx hexvero ui --open          # drag any file into the browser
npx hexvero setup --apply      # register the MCP server with Claude Code, Cursor, Codex …
```

```text
/opt/homebrew/bin/gh
  macho · 51 MB · sha256 91c6ac70187c39ed… · 90 ms

Summary
  Mach-O arm64 executable, 4 dylibs, 144 symbols · Go 1.25.1 (github.com/cli/cli/v2/cmd/gh)

Findings
  ○ Imports ptrace/sysctl (possible anti-debugging)
  ● cgo enabled (links C code)

Collections
  segments (5), sections (15), symbols (144), imports (144), libraries (4), goDependencies (212)
```

A filled dot is a fact the parser read from the file; a hollow dot is an inference from patterns. Everything that could not be established is listed, never hidden.

### Why

Reverse-engineering tooling for agents exists, but it ships 100+ MCP tools and a multi-megabyte catalog that small-context models choke on, returns results so large that Node runs out of memory, and asks you to install Ghidra, Hopper or IDA before the first useful answer. hexvero takes the opposite stance:

- **Built in, zero dependencies.** ELF, PE, Mach-O, Go, .NET, WebAssembly, EVM, SQLite, plist, APK, Electron, JavaScript, source maps and HAR are parsed by code in this repository. No JDK, no Python, no engine.
- **Bounded by design.** Every list is a page with `offset`, `limit`, a text filter and a byte budget. The complete result goes to a file with one command, never into your context window.
- **15 tools, not 139.** The MCP catalog is under 32 KiB and reads like a workflow: open, analyze, page, read bytes, export.
- **Honest output.** Findings carry `confirmed` or `inferred`; `limitations` say what was skipped, truncated or unreadable and why.
- **A real UI.** Verdict, hardening marks, findings, virtualized tables, a hex viewer with live decoding and a module graph for Electron apps. Local only.
- **Engines when you want them.** radare2, rizin and Ghidra plug in behind one interface for disassembly and decompilation; hexvero never installs them for you.

<a id="install"></a>

## Install

Requires Node.js 22.12 or newer (24 recommended for SQLite support without warnings).

```bash
npm install -g hexvero        # the hexvero command
hexvero doctor                # checks Node, node:sqlite and optional engines
```

Or run without installing: `npx hexvero <command>`.

<a id="what-it-reads"></a>

## What it reads

| Target                  | Built-in result                                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| ELF (32/64, LE/BE)      | Sections, segments, symbols, dynamic imports/exports, needed libraries, RPATH, build-id, NX/PIE/RELRO/canary/FORTIFY            |
| PE / PE32+              | Sections with entropy, imports (names and ordinals), exports and forwarders, PDB path, ASLR/NX/CFG/GS/Authenticode              |
| Mach-O (thin and fat)   | Load commands, segments, symbols, dylibs, UUID, platform/SDK, encryption, code signature, PIE/ARC/canary                        |
| Go binaries             | Compiler version, main module, dependencies with replacements, build settings, VCS revision                                     |
| .NET assemblies         | Assembly and references, types with methods, P/Invoke declarations, user strings, obfuscation hints                             |
| WebAssembly             | Types, imports/exports with correct index spaces, memories, tables, producers, WASI/Emscripten/wasm-bindgen                     |
| EVM bytecode            | PUSH-aware disassembly, dispatch selectors with jump targets, solc metadata, DELEGATECALL/SELFDESTRUCT                          |
| SQLite databases        | Tables, columns, row counts, sample rows, views, indexes, triggers (read-only via `node:sqlite`)                                |
| plist (XML and binary)  | Fully decoded property list                                                                                                     |
| Android APK             | Manifest facts, permissions, components with intent filters, deep links, native libraries, DEX classes and packages, frameworks |
| Java class / JAR / DEX  | Constant pool, members, referenced APIs, manifest and packages; DEX classes, strings and SDK hints                              |
| Electron ASAR / JS apps | Package facts, module roles, resolved import graph, IPC channel sender/receiver matching, preload and sandbox flags             |
| JavaScript files        | Imports, requires, dynamic imports, exports, IPC usage, source map comment                                                      |
| Source maps             | Sources grouped by package, mapping count, original position lookup                                                             |
| HAR captures            | Hosts, methods, status buckets, API-like endpoints, secrets in URLs, auth headers, WebSockets                                   |
| Anything                | Strings (ASCII and UTF-16) with tags, bounded byte windows, entropy                                                             |

<a id="cli"></a>

## CLI

```text
hexvero analyze <path> [--json] [--out file.json]     summary, findings, limitations, overview
hexvero collection <path> <name> [--text s] [--limit n] [--offset n]
hexvero strings <path> [--min n] [--utf16] [--tag url|path|email|ip|format|secret-ish]
hexvero bytes <path> <offset> [length]                hex dump
hexvero compare <a> <b> <collection> [--key field]    added / removed between two builds
hexvero export <path> <out.json>                      the complete analysis
hexvero recover <path> <outdir>                       bundle modules or source-map originals as files
hexvero provider <path> radare2|rizin|ghidra <op> [--address a] [--text s]
                                                      functions, disassemble, decompile, strings, imports,
                                                      xrefs, callers, callees, callgraph, search
hexvero calls <path> <engine> <root> [--direction callers|callees|both] [--depth n] [--goal g]
hexvero mcp · hexvero ui [--port n] [--open] · hexvero doctor · hexvero setup [--client c] [--apply]
```

Every command takes `--json`. Exit codes: `0` ok, `1` analysis failed (with a structured error), `2` usage. See [docs/cli.md](docs/cli.md).

<a id="web-ui"></a>

## Web UI

```bash
hexvero ui --open
```

Starts a loopback server with a per-session token and opens the browser. Drop a file anywhere, or type a path on your machine. Each target gets a verdict line, a fact sheet, hardening marks, findings with confidence, and one tab per collection that actually exists. The hex viewer loads windows on demand, decodes the selected byte as u8…u64/f32/f64 in both byte orders and follows arrow keys. Electron apps get a layered module graph that highlights a module's imports on click. Dark and light themes, keyboard shortcuts (`⌘O` open, `/` filter), phone layout.

<a id="for-ai-agents"></a>

## For AI agents

```bash
hexvero setup                 # shows what would change
hexvero setup --apply         # writes the MCP registration, backs up existing files
hexvero setup --client codex  # prints the TOML snippet for ~/.codex/config.toml
hexvero setup --skill --apply # installs the investigation skill for Claude Code, Codex and .agents
```

Supported: Claude Code, Claude Desktop, Cursor, Windsurf, Gemini CLI, VS Code, Codex. Any other client can run `npx -y hexvero mcp` over stdio.

| Tool                                         | Purpose                                                                                   |
| -------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `hexvero_open`                               | Register a file or directory; returns a content-derived id                                |
| `hexvero_analyze`                            | Summary, findings, limitations, collection counts and a compact overview                  |
| `hexvero_collection`                         | Page any list: symbols, imports, exports, sections, types, selectors, requests, modules … |
| `hexvero_strings`                            | Tagged strings with filter and paging                                                     |
| `hexvero_bytes`                              | A bounded hex window                                                                      |
| `hexvero_export`                             | The complete analysis to a file                                                           |
| `hexvero_compare`                            | Diff one collection between two targets                                                   |
| `hexvero_sourcemap`                          | Original position for a generated line/column                                             |
| `hexvero_providers` · `hexvero_provider_run` | Detect and drive radare2, rizin or Ghidra (incl. xrefs, callers, callees, search)         |
| `hexvero_call_graph`                         | Bounded call-graph neighborhood or shortest call path, one cached engine run per target   |
| `hexvero_list` · `hexvero_close`             | Session housekeeping                                                                      |

Ask your agent: _"Open ~/Downloads/app.asar with hexvero, tell me which IPC channels the renderer can reach and whether nodeIntegration is on."_ See [docs/mcp.md](docs/mcp.md).

<a id="optional-engines"></a>

## Optional engines

hexvero detects `r2`/`radare2`, `rizin` and Ghidra's `analyzeHeadless` on `PATH` (or `GHIDRA_INSTALL_DIR`). With one installed:

```bash
hexvero provider ./program radare2 functions
hexvero provider ./program ghidra decompile --address main
hexvero provider ./program radare2 xrefs --address sym.imp.system
hexvero provider ./program ghidra search --text password
hexvero calls ./program radare2 main --depth 3
hexvero calls ./program ghidra entry --goal system
```

Ghidra imports each target once into a project cached under `~/.cache/hexvero` and reuses it. Engine output is bounded, timeouts kill the whole process group, and decompiler plugins that are missing are reported as a limitation rather than an empty result.

Call graphs are read from the engine once per target (radare2 `aflj` + `agCj`, Ghidra's reference manager) and walked locally: `hexvero calls` and `hexvero_call_graph` answer callers, callees, bounded neighborhoods and shortest paths without one engine round-trip per function, and every result states which depth, node or engine limit cut it.

<a id="compared-with-rea"></a>

## Compared with REA

[REA](https://github.com/morluto/rea) is the project that proved agents want this. hexvero is a smaller reimplementation that starts from its users' open issues.

|                                               | REA                                                    | hexvero                                             |
| --------------------------------------------- | ------------------------------------------------------ | --------------------------------------------------- |
| MCP tools / catalog                           | 139 tools, ~2 MB                                       | 15 tools, < 32 KiB                                  |
| Large results                                 | Single JSON document; 500 MB bundles abort Node        | Paged collections with byte budgets; export to file |
| Native analysis without an engine             | Limited                                                | Full container parsing, Go, .NET, hardening facts   |
| Install                                       | Node + Ghidra/Hopper/IDA + JDK/Python for most targets | Node only; engines optional                         |
| Call graph / cross-references                 | One engine request per node, unbounded walk            | One cached engine read, bounded local walk          |
| GUI                                           | None                                                   | Local web UI                                        |
| Dynamic analysis, Frida, ADB, process capture | Yes                                                    | Not in scope                                        |

REA covers far more ground in dynamic and provider-driven analysis. If you need Hopper, IDA, Frida or Android device work today, use REA.

<a id="how-it-works"></a>

## How it works

```text
packages/core     parsers (formats/*), JavaScript scanner, Session (targets, collections, paging, export)
packages/mcp      McpServer with 15 tools over one Session
packages/server   loopback HTTP API + static hosting for the UI
packages/cli      hexvero command; ships the built UI
packages/web      React + Vite UI
```

Every parser returns facts plus `findings` and `limitations`. The Session flattens an analysis into named collections and pages them; CLI, MCP and HTTP are thin adapters over the same calls. Tests build their fixtures byte by byte (`packages/core/test/fixtures`), so the suite runs anywhere in seconds. See [docs/ARCHITECTURE-PLAN.md](docs/ARCHITECTURE-PLAN.md) and [CONTRIBUTING.md](CONTRIBUTING.md).

<a id="faq"></a>

## FAQ

<details><summary><b>Does hexvero run or upload my files?</b></summary>

No. Targets are parsed as bytes. The UI server binds to 127.0.0.1 with a per-session token. There is no telemetry and no network call anywhere in the code base.

</details>

<details><summary><b>Is this a decompiler?</b></summary>

Not by itself. Built-in analysis gives you structure, symbols, strings, imports, metadata and hardening facts. For disassembly and pseudocode, install radare2, rizin or Ghidra and use `hexvero provider`.

</details>

<details><summary><b>What about Windows?</b></summary>

Parsers and the CLI are platform independent. Provider process-group handling and the fake-engine tests target POSIX; Windows engine support is untested.

</details>

<details><summary><b>Legal</b></summary>

hexvero is for lawful research, education, interoperability and analysis of software you own or are authorized to examine. See [DISCLAIMER.md](DISCLAIMER.md).

</details>

## License

MIT
