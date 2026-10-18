# What hexvero reads

hexvero is built for Electron releases, and the same parsers read many other formats. Everything
in the table below works with Node.js alone; optional engines add disassembly and decompilation on
top. Moved here from the README after 0.9.9. The lists each format produces are in
[cli.md](cli.md#collections-by-format).

## Formats

Everything in this table works with Node alone. Engines add disassembly and decompilation on top.

| Target                   | Built-in result                                                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| ELF (32/64, LE/BE)       | Sections, segments, symbols, dynamic imports/exports, needed libraries, RPATH, build-id, NX/PIE/RELRO/canary/FORTIFY            |
| PE / PE32+               | Sections with entropy, imports (names and ordinals), exports and forwarders, PDB path, VERSIONINFO, ASLR/NX/CFG/GS/Authenticode |
| Mach-O (thin and fat)    | Load commands, segments, symbols, dylibs, UUID, platform/SDK, encryption, code signature, PIE/ARC/canary                        |
| Apple `.app` bundles     | Info.plist facts, executable, frameworks, entitlements, Objective-C classes/protocols, readable Swift names                     |
| Go binaries              | Compiler version, main module, dependencies with replacements, build settings, VCS revision                                     |
| .NET assemblies          | Assembly and references, types with methods, P/Invoke, user strings, CIL method bodies with call targets and digests            |
| Rust / C / C++ toolchain | Compiler and rustc version strings, DWARF presence, build paths (confirmed only when a version string is present)               |
| WebAssembly              | Types, imports/exports with correct index spaces, memories, tables, producers, WASI/Emscripten/wasm-bindgen                     |
| EVM bytecode             | PUSH-aware disassembly, dispatch selectors with jump targets, solc metadata, DELEGATECALL/SELFDESTRUCT                          |
| SQLite databases         | Tables, columns, row counts, sample rows, views, indexes, triggers (read-only via `node:sqlite`)                                |
| plist (XML and binary)   | Fully decoded property list                                                                                                     |
| Android APK              | Manifest, permissions, components with intent filters, deep links, native libs, DEX classes, resources.arsc, frameworks         |
| Java class / JAR / DEX   | Constant pool, members, referenced APIs, manifest and packages; DEX classes, strings and SDK hints                              |
| Flutter apps             | Engine and Dart snapshot facts, library digests                                                                                 |
| Electron ASAR / JS apps  | Package facts, module roles, resolved import graph, IPC channel sender/receiver matching, preload and `webPreferences` flags    |
| JavaScript bundles       | webpack / Rspack / browserify / esbuild module boundaries, requires, exports, endpoints, storage, vendor fingerprints           |
| Source maps              | Sources grouped by package, mapping count, original position lookup, originals written back to disk                             |
| ZIP, HAR                 | ZIP/ZIP64 entries; HAR hosts, methods, status buckets, API-like endpoints, secrets in URLs, auth headers, WebSockets            |
| Anything                 | Strings (ASCII and UTF-16) with tags, bounded byte windows, entropy                                                             |

Packaged Electron builds (a macOS `.app`, a Windows or Linux install directory, a release ZIP)
are opened as the Electron app inside them; how the app is picked is in
[cli.md](cli.md#packaged-builds-app-install-directories-zip).

Reading SQLite databases needs Node.js 22.13 or 24 and newer; on 22.12 everything else works and
SQLite files are refused with a message saying so.

## A native program

On a native program hexvero names the hardening and the imports worth a look. A real run of 0.9.9
on the example program in [`examples/native/`](../examples/native/) (macOS, Apple clang):

```text
$ cc -O2 -o demo examples/native/demo-v2.c && hexvero analyze demo
Findings
  ● Imports functions that start other programs or a shell: system  @ symbol table: _system (undefined)
      Read from the import table. Whether and with what input they are called is not established by static reading; a call graph (hexvero calls) shows who calls them. (collection imports)
  ● Hardening: PIE yes, stack canary no, ARC no, code signature yes, stripped yes  @ Mach-O header flags, load commands (LC_CODE_SIGNATURE), symbol table
      From headers and imported symbols. A missing symbol alone does not prove a missing protection (for example a binary without stack buffers needs no canary).

$ hexvero calls demo radare2 main --goal system      # with radare2, rizin or Ghidra installed
radare2 path main → sym.imp.system · found
main
  └ sym._run_tool
    └ sym.imp.system
```

Native findings cite a collection (imports, symbols) rather than a file offset.

<a id="optional-engines"></a>

## Optional engines

hexvero detects `r2`/`radare2`, `rizin` and Ghidra's `analyzeHeadless` on `PATH` (or
`GHIDRA_INSTALL_DIR`). With one installed:

```bash
hexvero provider ./program radare2 functions
hexvero provider ./program ghidra decompile --address main
hexvero provider ./program radare2 xrefs --address sym.imp.system
hexvero provider ./program ghidra search --text password
hexvero calls ./program radare2 main --depth 3
hexvero calls ./program ghidra entry --goal system
```

Call graphs include tail calls through both radare2 (from its jump references) and rizin. Ghidra
imports each target once into a project cached under `~/.cache/hexvero` and reuses it. Engine
output is bounded, timeouts and cancellation kill the whole process group, and a missing
decompiler plugin is reported as a limitation rather than an empty result. Call graphs are read
from the engine once per file and walked locally with depth and node bounds. Verified against
radare2 6.2 and rizin 0.9 on macOS, end to end and against the corpus's written-down call paths;
Ghidra only through its headless script on fixtures (not installed on the test machine); Windows
engine support is untested.

hexvero is not a decompiler by itself. Built-in analysis gives structure, symbols, strings,
imports, metadata and hardening facts; for disassembly and pseudocode, install radare2, rizin or
Ghidra and use `hexvero provider` or `hexvero calls`.
