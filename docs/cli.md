# CLI reference

All commands accept `--json` for machine-readable output and `--no-color`. Paths may be relative.

| Command                                                                            | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `analyze <path> [--out file.json]`                                                 | Detects the format, runs the analyzer, prints summary, findings, limitations and the collections that exist. `--out` also writes the complete JSON. For a large JavaScript app see [Large applications](#large-applications).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `collection <path> <name> [--text s] [--limit n] [--offset n]`                     | Pages one list. Unknown names return the available ones.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `strings <path> [--min n] [--utf16] [--tag t] [--text s] [--limit n] [--offset n]` | Printable strings with offsets and tags.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `bytes <path> <offset> [length]`                                                   | Hex dump (max 64 KiB). Offset accepts `0x` hex.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `compare <a> <b> [collection] [--key f[+g]] [--ignore f,g] [--strict]`             | Without a collection (or with `--all`): one row per collection both targets have, with the counts of added, removed, changed, relocated, unknown and unchanged items, and which comparisons were partial (2,000 items per side). With a collection: added, removed and changed items between two targets. Items are matched by an identity that hexvero picks (`name`, `channel`, `path`, `type+name` for methods …) or by `--key`. Nothing is ignored by default except that address fields of native symbols, exports, sections and segments which only moved are counted as `relocated` and shown with an example; `--strict` counts them as changed, `--ignore` excludes more fields. The output says when a comparison is partial or the analyses carry limitations. |
| `export <path> <out.json>`                                                         | The complete analysis as JSON.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `recover <path> <outdir>`                                                          | Splits a JavaScript bundle into module files (webpack, Rspack, browserify, esbuild, and scope-hoisted bundles at their `// path` comments), or writes a source map's original sources, into a new directory. Rollup/Vite chunks have no module boundaries; the manifest lists the chunks they import.                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `provider <path> <engine> <operation> [--address a] [--text s] [--timeout ms]`     | Runs radare2/rizin/ghidra operations: functions, disassemble, decompile, strings, imports, xrefs, callers, callees, callgraph, search.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `calls <path> <engine> <root> [--direction d] [--depth n] [--max n] [--goal g]`    | Bounded call-graph neighborhood around a function, or the shortest call path to `--goal`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `mcp`                                                                              | Serves MCP over stdio.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `ui [--port n] [--host h] [--open]`                                                | Starts the local web UI (default port 7331, loopback only unless `--host` is given, which prints a warning).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `doctor`                                                                           | Checks Node, `node:sqlite` and engines.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `setup [--client c] [--apply]`                                                     | Registers the MCP server; dry run by default.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

Exit codes: `0` success (including `--help`), `1` analysis error (`{"error":{"code","message","details"}}` with `--json`), `2` usage error. Set `HEXVERO_DEBUG=1` for stack traces.

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
| Electron / directory | modules, edges, externals, ipcChannels, ipc, webPreferences, contextBridge, endpoints, storage, urls, sourceMaps                                 |
| JavaScript file      | references, ipc, exports, bundleModules, endpoints, routes, storage, urls                                                                        |
| Source map           | sources, packages                                                                                                                                |

`findings` and `limitations` exist for every format.

## Large applications

A JavaScript application is read 5,000 files at a time (`--batch n` changes that). When files are
left, the summary starts with `partial`, a Coverage section says how many are unread, and
`--json` carries `complete: false` and a `coverage` object. Everything in the result then covers
the scanned part only.

```bash
hexvero analyze app.asar              # the first batch, or the stored scan as it stands
hexvero analyze app.asar --continue   # read the next batch
hexvero analyze app.asar --all        # read everything that is left
hexvero analyze app.asar --include src/main,dist/*.js   # only unread files under these paths
hexvero analyze app.asar --fresh      # discard the stored scan and start again
```

Files are taken in a fixed order: the entry file from `package.json`, then shallow paths before
deep ones, then by path. A continued scan therefore never reads a file twice and never leaves one
out. What has been read is stored under `~/.cache/hexvero/scans` (or `HEXVERO_CACHE_DIR`), keyed by
the content of the input, so `collection`, `compare` and `export` in later invocations see the
same state, and a changed archive starts from nothing. An application that fits into one batch
stores nothing. If a run is interrupted, the state of the last finished batch remains.

Applications with 4 MiB of source or more are tokenized in up to three worker threads, largest
file first; the results are merged in the fixed order above, so the analysis is the same as with
one thread. `HEXVERO_JS_THREADS=0` turns the threads off, any other number sets their count.

## The cache

`~/.cache/hexvero` (or `HEXVERO_CACHE_DIR`) holds stored scans (`scans/`), engine call graphs
(`graphs/`) and Ghidra projects (`ghidra/`). Directories are created `0700` and files `0600`;
directories an older version created more open are tightened when they are next used. Entries
older than 30 days are removed, and the oldest beyond 1 GiB in total, at most once an hour and
never one written in the last hour. `HEXVERO_CACHE_MAX_MB` and `HEXVERO_CACHE_MAX_AGE_DAYS` change
the limits. Only files and directories hexvero names itself are ever removed, and links are not
followed.

```bash
hexvero cache                   # where it is, what it holds, the limits
hexvero cache --prune           # apply the limits now
hexvero cache --clear           # what --clear --apply would remove
hexvero cache --clear --apply   # remove everything hexvero stored
```

## Endpoints and storage

For Electron archives, directories and single bundles:

```bash
hexvero collection app.asar endpoints
hexvero collection app.asar storage --text token
```

Each row says where it was read (`file`, `line`, `column`) and how (`evidence`):

| `evidence` | Meaning                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------- |
| `literal`  | the address or key is a string at the call                                                  |
| `template` | part of it is known, the rest is an expression, shown as `${…}`                             |
| `inferred` | reached through a constant or another name for `fetch`, or recognised by its shape only     |
| `unknown`  | there is a call, but its argument cannot be read; `value` is null and `expression` names it |

A URL that only occurs as a string is not an endpoint; those are listed in `urls`.

## Next steps

`analyze` ends with up to four commands that answer the obvious next questions for this kind of
target (`next` in `--json`). They only point at lists that exist in this analysis.

## Setting up and removing agent clients

```bash
hexvero setup                     # dry run: which client files would change
hexvero setup --apply             # add the hexvero MCP server to every detected client
hexvero setup --client cursor --apply
hexvero setup --remove            # dry run of taking it out again
hexvero setup --remove --apply    # remove exactly the "hexvero" entry, backing up each file first
```

`setup` never removes or rewrites anything else. A file with comments (JSONC) is edited as text
when an entry is added; for removal it is left alone with a note to remove the entry by hand, since
rewriting would lose the comments. When no client configuration is found, `setup` says so and shows
how to name one.

## When something is missing

- No engine installed: `calls` and `provider` fail with `provider_unavailable` and say how to
  install one; everything else works without an engine. `hexvero doctor` lists what is installed.
- A read-only cache directory: analysis still works; a large JavaScript app reports
  `scan_state_not_saved` because its scan cannot be continued later. Set `HEXVERO_CACHE_DIR` to a
  writable directory to fix that.
