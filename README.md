<div align="center">

# hexvero

### Reverse engineer anything, locally.

Zero-dependency static analysis for native binaries, apps and web bundles,
with a compact MCP server, a CLI and a local web UI.

`npx hexvero ui` · `npx hexvero analyze ./target` · `npx hexvero mcp`

</div>

---

hexvero reads executables, app bundles, databases and captures **without
running them** and returns findings with the evidence and limitations behind
each conclusion. Everything built in works with Node.js alone; Ghidra and
radare2/rizin are optional providers for disassembly and decompilation.

## Why hexvero

| Problem with existing agent RE tooling          | hexvero                                                     |
| ----------------------------------------------- | ----------------------------------------------------------- |
| 100+ MCP tools and multi-megabyte tool catalogs | 14 tools, discovery payload under 32 KiB                    |
| Results that overflow the model context or Node | Every list is paged; large results export to a file         |
| Needs Hopper / IDA / Ghidra / JDK before step 1 | Built-in parsers need nothing but Node >= 22                |
| CLI only                                        | A local web UI with hex view, strings, symbols and findings |

## What it analyzes

| Target                     | Built-in result                                                         |
| -------------------------- | ----------------------------------------------------------------------- |
| ELF, PE, Mach-O (fat)      | Headers, sections, segments, symbols, imports, exports, hardening flags |
| Go binaries                | Compiler version, module path, dependencies, build settings             |
| .NET assemblies            | Metadata streams, assembly/type/method inventory                        |
| WebAssembly                | Sections, imports, exports, memories, tables                            |
| EVM bytecode               | Dispatch selectors and candidate functions                              |
| SQLite databases           | Tables, columns, indexes, views, triggers                               |
| plist (XML / binary)       | Decoded property list                                                   |
| Android APK                | Decoded AndroidManifest.xml, package facts, native libraries            |
| Electron / JavaScript apps | ASAR tree, module graph, imports, IPC channels                          |
| HAR captures               | Requests, hosts, payload shapes                                         |
| Anything                   | Printable strings, entropy, bounded byte windows                        |

## Status

Early development. See [docs/ARCHITECTURE-PLAN.md](docs/ARCHITECTURE-PLAN.md)
for the design and milestone list.

## License

MIT
