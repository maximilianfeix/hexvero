# Changelog

All notable changes to hexvero are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- CLI usability review: `--help` exits 0; `*.map` files are recognised as source maps (so `recover`
  accepts them); `ui --host` is honoured with a warning for non-loopback hosts; value flags without
  a value, out-of-range `--limit`/`--offset` and unknown `--tag` or engine names are usage errors
  instead of silent clamps; `bytes` and `compare` say when their output was clamped or partial;
  empty pages read "0 of N"; `recover` explains what it accepts and when no module boundaries were
  found; a busy port and unknown-function errors get plain messages (`HEXVERO_DEBUG=1` for stacks);
  directory targets no longer print a size and hash.
- Core robustness review: the page byte budget is now an upper bound including the envelope, with
  oversized items compacted and marked `itemTruncated`; strings longer than 4096 characters are cut
  and report their full `length`; large (lazy) ASAR targets are identified by the SHA-256 of the
  whole file instead of a head+size fingerprint labelled as such; binary plists memoize shared
  objects so a fan-out chain cannot expand exponentially; directory analysis never follows symbolic
  links; analysis workers get a 2 GiB heap cap by default (`maxWorkerHeapMb`); `ilSha256` is null
  for clipped IL bodies; a Rust toolchain detected only from mangled symbols is `inferred`; ELF note
  alignment and ASAR offsets are validated.

### Changed

- Security review of the MCP and HTTP surfaces: every MCP tool carries explicit annotations
  (export, recover, provider_run and call_graph are no longer advertised as read-only);
  `hexvero_export` refuses to replace an existing file unless `overwrite: true` and returns the
  absolute path; `hexvero_recover` bounds its `skipped` list; engine processes are killed when the
  server exits or the client cancels (`cancelled` error code); `address` rejects radare2 iterator
  syntax; the loopback server rejects requests whose Host is not the bound host (DNS rebinding),
  accepts `?token=` only for the export download, compares tokens in constant time, answers 400 to
  malformed JSON and keeps uploads in a private per-server directory.

### Added

- `hexvero setup` knows 18 agent clients (Claude Code, Claude Desktop, Codex, Cursor, Windsurf,
  Gemini CLI, Antigravity, VS Code, Trae, OpenCode, GitHub Copilot CLI, Qwen Code, Qoder, Devin, Pi,
  Kiro, Amp, Zed), writes each client's own entry dialect including Codex TOML, honours their
  environment overrides, configures only detected clients unless `--all`, and never rewrites a file
  it cannot parse. MCP registry manifest `server.json`. README translations in eight languages.
- Cross-references and call graphs through engines: provider operations `xrefs`, `callers`,
  `callees`, `callgraph` and `search` for radare2, rizin and Ghidra with one normalized shape; the
  whole-program graph is read once and walked locally with depth/node bounds (`hexvero calls`,
  `hexvero_call_graph`), including shortest call paths and explicit truncation facts.
- Zero-dependency JavaScript bundle splitting (webpack 4/5, Rspack, browserify, esbuild): module
  boundaries, require graph, export names, endpoint/route/storage candidates, vendor fingerprints.
- Objective-C metadata from Mach-O images without an engine: classes (methods, ivars, properties,
  adopted protocols, superclass incl. external binds), protocols, categories; pointers decoded through
  dyld chained fixups (PTR_64, PTR_64_OFFSET, ARM64E) and dyld_info bind opcodes. Swift class names
  and mangled symbols are made readable (approximate, no `swift-demangle` needed).
- CIL method-body decoder for .NET assemblies: every opcode, tiny/fat headers, exception clauses, call
  targets resolved to names, string literals, raw and normalized IL digests; `methods`, `calls` and
  `cil` collections and a finding for process/reflection/network/crypto/file/registry calls.
- Android resources.arsc decoder (packages, types, default values, locales, densities) that resolves
  manifest references such as the application label; Flutter/Dart AOT snapshot facts (version hash,
  features, engine build ids, per-ABI digests) without Apktool or any engine.
- Guided MCP prompts (investigate_feature, compare_versions, triage_binary, map_electron_app, explain_apk)
  and an unknowns ledger tool (`hexvero_unknowns`) whose entries ship with exports.
- `hexvero recover` and the `hexvero_recover` MCP tool write bundle modules or source-map originals to
  disk without an external engine (REA needs Wakaru on Linux x64 for this).

## [0.2.1] - 2026-10-13

### Added

- Analyses run in a worker thread with a timeout (`HEXVERO_ANALYSIS_TIMEOUT_MS`) and per-caller
  cancellation; MCP and HTTP servers stay responsive and client cancels stop the work.
- Agent skill (`skills/hexvero/SKILL.md`) shipped in the npm package and installed by
  `hexvero setup --skill` for Claude Code, Codex and `.agents`.
- German README; npm metadata for every package; `npm run publish:all`.
- CI runs typecheck and tests on Windows and macOS.

## [0.2.0] - 2026-10-13

### Added

- Toolchain facts for ELF, PE and Mach-O: compiler (GCC, clang, Apple clang, MSVC), Rust detection,
  DWARF presence, Swift/Objective-C runtime use, embedded build paths.
- PE version resources (VS_VERSIONINFO): file and product versions, company, product and file names.
- hexvero.dev landing page deployed through GitHub Pages; issue forms, PR checklist and Dependabot.

### Changed

- GitHub Actions bumped to current majors; dev tooling updated (Vite 8.3, Vitest 5, oxfmt).

## [0.1.1] - 2026-10-13

### Added

- Apple app bundle analysis for `.app` directories (Info.plist facts, main binary, frameworks, helpers,
  entitlements, privacy keys, URL schemes).
- Lazy, file-backed reading for ASARs above the in-memory limit; byte windows served from disk.
- ZIP64 central directories.

### Fixed

- Mach-O: section records were skipped with the wrong length; addresses and symbol values use bigint.
- ZIP64 offset read from the wrong field; `.aar`/`.jar` archives no longer routed to the APK parser.
- WASM global initializer expressions containing `0x0b` immediates.
- Parser bounds errors are reported as `malformed` instead of internal errors.
- HTTP server: double-decoded upload names, unvalidated numeric query params, `Origin: null`,
  immutable caching of unhashed assets, unhandled read-stream errors.
- Web UI: storage-safe token read, bounded response cache, keyboard-reachable close control.
- Providers: Ghidra cache keyed by file content, stale outputs removed, `which()` honors PATHEXT.

## [0.1.0] - 2026-10-13

### Added

- Zero-dependency parsers for ELF, PE and Mach-O (thin and fat) with sections, segments, symbols,
  imports/exports, dynamic metadata and hardening flags.
- Go buildinfo recovery (version, main module, dependencies, build settings) and .NET metadata
  inventory (assembly, types, methods, P/Invoke, user strings).
- WebAssembly and EVM bytecode inspection, SQLite schema inventory, XML and binary plist decoding,
  HAR capture summaries, ZIP reader and Android APK manifest decoding.
- Electron ASAR reader, JavaScript module graph with IPC channel matching, source map decoding.
- `hexvero` CLI with analyze, collection, strings, bytes, compare, export, provider, mcp, ui, doctor
  and setup commands.
- Compact MCP server with 12 tools and a discovery payload under 32 KiB.
- Local web UI with overview, findings, collections, strings, hex viewer and module graph.
- Optional radare2/rizin and Ghidra headless adapters.
- Java class, JAR and DEX inspection; APK analysis lists classes and packages.
- Review workflow with a threaded quality report on every pull request; release workflow on tags.
