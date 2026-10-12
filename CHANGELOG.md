# Changelog

All notable changes to hexvero are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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
