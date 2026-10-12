**Build hexvero around bounded, evidence-backed inspection.** Treat ten hours as a prototype budget: complete PRs 1–6 first, then add formats in order. The full list below is a credible v1 roadmap; completing every parser, provider, and verification gate in ten hours is not a credible maintenance commitment.

“Zero dependency” means built-in analyzers require only Node, with no external engines or native npm modules. MCP and GUI packages may depend on their SDKs and React. Support Node ≥22; feature-detect `node:sqlite`, which appeared in 22.5 and became flag-free in 22.13. [Node documentation](https://nodejs.org/download/release/latest-jod/docs/api/sqlite.html)

**Monorepo and ownership**

```text
package.json                 # private; npm workspaces; pinned packageManager
tsconfig.base.json
packages/
  core/src/
    contracts.ts             # Evidence, Finding, errors, jobs, pagination
    reader.ts                # bounded random-access reads; bigint offsets
    operations.ts            # shared application operations
    jobs.ts                  # workers, cancellation, budgets
    store.ts                 # disk-backed results, indexes, artifacts
    paths.ts                 # native paths, file URLs, archive identities
  analyzers/src/
    registry.ts
    binary/{elf,pe,macho,go,dotnet,wasm,evm}.ts
    containers/{zip,asar,axml,plist}.ts
    structured/{sqlite,har,sourcemap}.ts
    javascript/{lexer,graph}.ts
    strings.ts
  providers/src/
    contract.ts
    process.ts
    {ghidra,radare}.ts
    scripts/Export.java
  cli/src/{main,commands,output}.ts
  mcp/src/{server,tools,schemas}.ts
  server/src/{http,auth,uploads,events}.ts
  web/src/{app,routes,api,components,styles}/
tests/{fixtures,integration,malformed,performance}/
docs/{formats,limits,providers}.md
```

Dependencies point toward `core`; adapters never call each other. One operation registry supplies CLI, HTTP, and MCP handlers. Format modules own interpretation: Go and .NET consume parsed executable address mappings instead of implementing their own.

Ship prebuilt GUI assets with the CLI; users never run Vite. Store sessions outside the repository in an application data directory.

**Interfaces and result contracts**

Illustrative TypeScript; `Result` carries tagged expected failures:

```ts
type Result<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      error: {
        code: "INVALID" | "UNSUPPORTED" | "LIMIT" | "STALE" | "IO" | "PROVIDER" | "CANCELLED";
        message: string;
        evidenceIds?: string[];
      };
    };

interface Analyzer {
  id: string;
  version: string;
  probe(source: SourceReader): Promise<Result<Probe>>;
  analyze(ctx: AnalysisContext): AsyncIterable<AnalysisEvent>;
}

interface Evidence {
  id: string;
  sourceId: string;
  locator:
    | { kind: "bytes"; offset: string; length: string }
    | { kind: "structured"; pointer: string; containerEvidenceId: string };
  producer: { id: string; version: string; runId: string };
  parentIds: string[];
}

interface Finding {
  id: string;
  kind: string;
  value: JsonValue;
  basis: "observed" | "derived" | "inferred" | "unknown";
  evidenceIds: string[];
  limitations: string[];
}

interface Provider {
  id: string;
  detect(): Promise<Result<ProviderCapabilities>>;
  run(ctx: ProviderContext, request: ProviderRequest): AsyncIterable<AnalysisEvent>;
}

interface Page<T> {
  schemaVersion: 1;
  resultId: string;
  items: T[];
  page: { nextCursor: string | null; returned: number; bytes: number };
  coverage: {
    state: "complete" | "partial" | "unknown";
    examined: string;
    unit: string;
    reasons: string[];
  };
  warnings: string[];
}
```

`AnalysisContext` supplies reader, parsed facts, evidence sink, budgets, and `AbortSignal`. The source registry retains original input, resolved identity, SHA-256, size, and archive ancestry. Preserve raw values alongside normalized ones. Offsets and addresses serialize as decimal or explicitly prefixed hexadecimal strings.

Jobs return immediately with `jobId`; states are queued/running/completed/partial/failed/cancelled. Completion or cancellation freezes an immutable result snapshot. Partial findings remain available.

Use append-only NDJSON records plus a sparse disk index, not giant in-memory arrays. Defaults: 100 rows/16 KiB per page; hard limits: 1,000 rows/64 KiB. Oversized fields become artifact references with previews. Bound scanning time separately from returned rows.

Opaque cursors bind result, collection, filters, order, and position. Expired cursors fail explicitly. `nextCursor:null` means pagination ended, not that analysis covered the entire target.

File delivery streams NDJSON with backpressure into an exclusively created temporary file, then publishes atomically. Return artifact ID, digest, size, and coverage; never materialize the complete JSON document.

**Exactly 14 MCP tools**

`?` means optional. `P` expands to `cursor?`, `limit?`, `maxBytes?`, `outputPath?`; file output exports the full filtered snapshot rather than the current page.

| Tool                   | Purpose                                                          | Input fields                                                                        |
| ---------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `hexvero_open`         | Register a local file or directory                               | `path`, `formatHint?`                                                               |
| `hexvero_close`        | Release a target and optionally its retained results             | `targetId`, `purgeResults?`                                                         |
| `hexvero_inspect`      | Show identity, detected formats, capabilities, and run summaries | `targetId`                                                                          |
| `hexvero_analyze`      | Start selected built-in analyses                                 | `targetId`, `analyses?`, `sliceId?`, `budgets?`                                     |
| `hexvero_job`          | Inspect or cancel a job                                          | `jobId`, `action: status\|cancel`                                                   |
| `hexvero_results`      | Browse a typed result collection                                 | `resultId`, `collection`, `kind?`, `text?`, `P`                                     |
| `hexvero_strings`      | Browse retained strings                                          | `resultId`, `contains?`, `encoding?`, `minLength?`, `P`                             |
| `hexvero_symbols`      | Browse symbols, imports, or exports                              | `resultId`, `role?`, `name?`, `P`                                                   |
| `hexvero_graph`        | Retrieve a bounded dependency neighborhood                       | `resultId`, `rootId?`, `depth?`, `edgeKinds?`, `P`                                  |
| `hexvero_bytes`        | Read a bounded byte window                                       | `targetId`, `offset`, `length`, `encoding: hex\|base64`                             |
| `hexvero_evidence`     | Resolve provenance for selected records                          | `resultId`, `ids`, `P`                                                              |
| `hexvero_export`       | Export findings and evidence as NDJSON                           | `resultId`, `collections?`, `outputPath?`                                           |
| `hexvero_providers`    | Detect installed engines and their supported operations          | none                                                                                |
| `hexvero_provider_run` | Start optional engine analysis                                   | `targetId`, `provider`, `operation`, `address?`, `sliceId?`, `timeoutMs?`, `reuse?` |

Collection names are a small enum, not arbitrary query languages. Provider operations are `inventory`, `disassemble`, and `decompile`; unsupported combinations return capability errors. No raw shell commands or provider scripting surface.

Keep `tools/list` below 32 KiB, with a measured token budget; validate converted schemas against actual MCP clients. Return structured results once, without duplicating large JSON in text. CLI verbs mirror these tools, with `--json`, `--out`, `--wait`; exit codes: 0 success, 1 failure, 2 usage, 3 partial, 130 interrupted.

**Implementation: one milestone per PR**

All parser PRs require a valid fixture, malformed/truncated cases, and a public CLI test asserting provenance.

| PR  | Scope and principal files                                                                          | Acceptance test                                                                                                              |
| --- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 1   | Workspace, contracts, bounded reader, source registration; `core/*`, `cli/main.ts`                 | `hexvero open fixture --json`; reject overflowing ranges; preserve Windows/file-URL inputs.                                  |
| 2   | Streaming strings, jobs, retained results, pagination/export; `strings.ts`, `core/{jobs,store}.ts` | CLI analyzes and exports a large generated file; chunk-boundary strings survive; cancellation retains partial results.       |
| 3   | MCP adapter and all 14 compact contracts; `mcp/*`                                                  | Real SDK client opens, analyzes, pages, exports; unavailable capabilities report unsupported; discovery stays within budget. |
| 4   | Local HTTP service and browser upload; `server/*`                                                  | Upload → job → results through HTTP; oversized upload and disconnect clean up owned files.                                   |
| 5   | Polished GUI shell, evidence, strings, hex; `web/*`                                                | Browser drag-and-drop yields navigable findings; byte selection opens exact evidence; narrow viewport works.                 |
| 6   | ELF headers, sections, symbols, dynamic imports/exports; `binary/elf.ts`                           | ELF32/64, both endians, stripped and sectionless fixtures; CLI/MCP/GUI agree. **Prototype checkpoint.**                      |
| 7   | PE headers, sections, imports/exports; `binary/pe.ts`                                              | PE32/PE32+, ordinal imports, forwarded exports, malformed RVAs.                                                              |
| 8   | Thin/fat Mach-O, symbols, dylibs, export trie; `binary/macho.ts`                                   | Enumerate every fat slice; dylib names resolve relative to commands; invalid command sizes fail.                             |
| 9   | Go build information; `binary/go.ts`                                                               | Pointer and inline layouts recover compiler/modules through existing address mappings.                                       |
| 10  | .NET metadata streams and table inventory; `binary/dotnet.ts`                                      | Assembly/type/method names from differing heap/index widths; truncated stream preserves earlier facts.                       |
| 11  | WASM inventory and EVM selector candidates; `binary/{wasm,evm}.ts`                                 | Import/export index spaces correct; PUSH payload bytes never become opcodes or false selectors.                              |
| 12  | SQLite schema, HAR summaries, XML/binary plist; `structured/*`, `containers/plist.ts`              | Read-only schema; HAR retains source linkage; oversized JSON refuses cleanly; plist variants agree.                          |
| 13  | ZIP directory reader and APK AXML; `containers/{zip,axml}.ts`                                      | Stored/deflated manifests; namespace/typed attributes; traversal and decompression-budget cases.                             |
| 14  | ASAR virtual filesystem, directory traversal, JS reference graph; `asar.ts`, `javascript/*`        | Windows ASAR paths, unpacked entries, cycles, comments/string decoys; unresolved references remain explicit.                 |
| 15  | Source-map decoding and GUI graph; `sourcemap.ts`, `web/components/Graph*`                         | VLQ mapping resolves source positions; escaped names render safely; large graph shows bounded neighborhoods.                 |
| 16  | Provider supervisor and radare2/rizin; `providers/{process,radare}.ts`                             | Installed engine produces attributed findings; timeout/cancel terminates owned children; outputs spool to disk.              |
| 17  | Ghidra headless and reusable owned project cache; `ghidra.ts`, `scripts/*`                         | Real import, warm reuse, version/options invalidation, cancellation, concurrent-cache locking.                               |
| 18  | Packaging, compatibility, documentation, performance gates                                         | Clean npm install without external engines; Windows/Linux/macOS workflows; measured discovery, export, and GUI workloads.    |

Record elapsed time, CPU time, peak process-family memory, and whole-workflow agent tokens. Separate cold/warm provider runs. Simulated providers do not establish real-engine support; publish unverified coverage explicitly.

**Parsing constraints**

- **Common:** validate offset, count, multiplication, and decoded-size bounds before allocation. Use `bigint` arithmetic; preserve raw offsets. Stream strings with overlap/state across chunks. Unsupported structures produce coverage gaps, not empty success.
- **ELF:** `EI_CLASS` and `EI_DATA` independently determine layout and byte order. Handle extended numbering, linked string tables, `NOBITS`, absent section tables, and segment-based dynamic metadata. Undefined symbols and export visibility require interpretation. [ELF ABI](https://refspecs.linuxfoundation.org/elf/gabi4%2B/ch4.eheader.html)
- **PE:** validate `e_lfanew`, optional-header size, PE32/PE32+ directory offsets, and directory count. Translate RVAs only through backed ranges; certificate-directory addresses are file offsets. Bound thunk walks and forwarded-export strings. [PE specification](https://learn.microsoft.com/en-us/windows/win32/debug/pe-format)
- **Mach-O:** distinguish fat-container and slice endianness, 32/64-bit layouts, and slice-relative offsets. Bound `ncmds/sizeofcmds`; `LC_LOAD_DYLIB` names are command-relative. Stripped exports may require dyld export tries. [Apple definitions](https://github.com/apple-oss-distributions/xnu/blob/main/EXTERNAL_HEADERS/mach-o/loader.h)
- **Go:** locate `\xff Go buildinf:` with a validated 32-byte header; honor pointer size, endian flag, and inline-versus-pointer encoding. Translate virtual addresses through the executable parser. [Go implementation](https://go.dev/src/debug/buildinfo/buildinfo.go)
- **.NET:** follow the CLI directory to `BSJB`; stream offsets are metadata-root-relative. Decode `#~`, `#Strings`, `#Blob`, and `#GUID`; heap flags, row counts, and coded-index tags determine widths. Explicitly reject unsupported `#-` layouts. [ECMA-335](https://ecma-international.org/publications-and-standards/standards/ecma-335/)
- **WASM:** bound signed/unsigned LEB128 by bit width and validate terminal bits. Respect section lengths and ordering; custom sections may repeat. Imported functions precede defined functions in the function index space. [Binary specification](https://webassembly.github.io/spec/core/binary/index.html)
- **EVM:** decode instructions before matching `PUSH4 → EQ → … → JUMPI`. Emit inferred selector candidates, not function names; optimized dispatchers may differ. Require an explicit runtime-bytecode hint when ambiguous. ABI selectors are four bytes, but constants alone do not prove dispatch. [Solidity ABI](https://docs.soliditylang.org/en/latest/abi-spec.html)
- **SQLite:** dynamically import `node:sqlite`; open read-only in a worker. Inspect schema only, disable extensions, and require a coherent offline database/WAL set. Do not silently inspect an inconsistent copied database.
- **ASAR:** decode Chromium Pickle framing before header JSON. Entry offsets are decimal strings relative to payload start; handle `unpacked` and links. Keep archive paths distinct from native paths; never concatenate untrusted entries into extraction paths. [ASAR format](https://github.com/electron/asar)
- **APK/AXML:** use ZIP central-directory sizes with bounded inflation. Decode binary XML chunks, UTF-8/UTF-16 string pools, namespaces, resource maps, and typed attributes. Preserve unresolved resource IDs; text XML parsing cannot substitute. [Android structures](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/main/libs/androidfw/include/androidfw/ResourceTypes.h)
- **Structured/JS:** cap whole-document HAR/plist/source-map parsing explicitly. Source maps require signed Base64 VLQ and stateful deltas; never fetch embedded URLs automatically. JS v1 graphs cover literal references using a lexer and mark heuristic edges inferred. [Source-map specification](https://tc39.es/ecma426/)

**Frontend and transport**

Routes: `/`, `/targets/:id/overview`, `/findings`, `/hex`, `/strings`, `/symbols`, `/graph`; selected evidence lives in a side panel and URL query state.

Use React query caching keyed by immutable result IDs; local state owns selections, filters, and panels. Virtualize tables and hex rows. Graphs load bounded neighborhoods rather than entire applications.

Visual direction: graphite surfaces, restrained cyan accents, readable sans-serif labels, monospace data, consistent spacing, keyboard navigation, explicit partial-analysis badges.

Serve prebuilt assets and:

- `POST /api/uploads`: raw streamed body to owned storage.
- `POST /api/operations/:name`: shared typed operations.
- `GET /api/jobs/:id/events`: SSE progress summaries with bounded queues.
- `GET /api/results/:id/:collection`: cursor pages.
- `GET /api/targets/:id/bytes`: bounded binary windows.
- `GET /api/artifacts/:id`: streamed downloads.

Workers isolate synchronous parsing; HTTP streams honor backpressure. Bind loopback, validate Host/Origin, require a session token, and expose registered target IDs instead of unrestricted filesystem paths.

**Deliberately outside v1**

No target execution, live debugging, injection, patching, unpacking, protection recovery, cloud uploads, telemetry, or automatic engine installers. Defer Binary Ninja, IDA, RetDec, CFR, DEX decompilation, full JS resolution, indexed source maps, arbitrary SQL, live databases, firmware filesystems, DWARF/PDB, and exhaustive Mach-O chained-fixup recovery.

Recognizing RISC-V/PowerPC architecture IDs does not establish disassembly support. Unsupported variants must remain visible as limitations. Keep Ghidra project reuse confined to hexvero-owned caches, keyed by target digest, engine version, script version, and analysis options.
