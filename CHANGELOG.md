# Changelog

All notable changes to hexvero are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Zero-dependency JavaScript bundle splitting (webpack 4/5, Rspack, browserify, esbuild): module
  boundaries, require graph, export names, endpoint/route/storage candidates, vendor fingerprints.
- Objective-C metadata from Mach-O images without an engine: classes (methods, ivars, properties,
  adopted protocols, superclass incl. external binds), protocols, categories; pointers decoded through
  dyld chained fixups (PTR_64, PTR_64_OFFSET, ARM64E) and dyld_info bind opcodes. Swift class names
  and mangled symbols are made readable (approximate, no `swift-demangle` needed).
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
