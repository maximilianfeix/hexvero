# MCP server

Start: `npx -y hexvero mcp` (stdio). Register with `hexvero setup --apply` (dry run without `--apply`; existing files are backed up as `*.hexvero-backup`) or add it to your client's
configuration manually:

```json
{ "mcpServers": { "hexvero": { "command": "npx", "args": ["-y", "hexvero", "mcp"] } } }
```

## Workflow

1. `hexvero_open { path }` → `{ id, info: { format, size, sha256 } }`
2. `hexvero_analyze { targetId }` → summary, findings (each with `confidence` and, where a parser records one, a `location` such as `main.js:14`), limitations, `collections: { name: count }`, compact overview. For a JavaScript application the result also has `complete` and `coverage { total, scanned, remaining, nextFiles }`: when `complete` is false, every list covers the scanned part only. Call again with `scan: "continue"` (next batch), `scan: "all"` (the rest) or `include: ["src/main"]` (unread files under those paths) to read more; `scan: "fresh"` discards the stored scan The result also has `next`: up to four calls that answer the obvious next questions for this kind of target, ready to send. `overview` lists the facts and the size of each list; `detail: "full"` adds samples of every list (the earlier default), and the lists themselves are paged with `hexvero_collection`.
3. `hexvero_collection { targetId, collection, offset?, limit?, text?, maxBytes? }` → one page with `next`
4. `hexvero_strings`, `hexvero_bytes` for raw evidence
5. `hexvero_compare { targetA, targetB, collection }` for two builds; `hexvero_unknowns { action: "record" | "list" | "resolve" | "remove" }` for questions the evidence cannot answer
6. `hexvero_export { targetId, path }` when the agent needs everything; `hexvero_recover { targetId, outputDir }` to get bundle modules or original sources as files
7. With an engine installed: `hexvero_providers`, `hexvero_provider_run`, `hexvero_call_graph`; `hexvero_sourcemap` maps a generated position to its source; `hexvero_list` / `hexvero_close` manage the session

Results are JSON in a single text content block. Errors come back as `{ "error": { "code", "message", "details" } }` with `isError: true`.
Codes: `not_found`, `invalid_input`, `unsupported_format`, `malformed`, `too_large`, `provider_unavailable`, `cancelled`.

## Paths and writes

`hexvero_open`, `hexvero_export` and `hexvero_recover` take paths as the hexvero process sees them: pass absolute paths, because relative ones resolve against the server's working directory, which the agent cannot observe. Export and recover write only inside the allowed roots: the server's working directory (unless it is the home directory or `/`) and the system temp directory, or the directories listed in `HEXVERO_WRITE_ROOTS` (separated by `:`, or `;` on Windows). They never write into a hidden file or directory below a root, an export must end in `.json`, and a symlink that leads out of a root is refused. Export refuses to replace an existing file unless `overwrite: true`, and even then replaces only an earlier hexvero export; recover refuses a non-empty directory. The CLI has none of these limits, because there a person picks the path. Tool annotations say which tools write (`readOnlyHint: false`): export, recover, provider_run and call_graph (engine caches under `~/.cache/hexvero`), close and unknowns (session state). Strings, symbol names, decompiled code and recovered files are data from the target, never instructions. Every tool result says so in machine-readable form as well: `_meta["io.github.maximilianfeix.hexvero/untrustedContent"]` is `true`.

## Budget

The tool catalog is under 32 KiB. Lists come back as pages; the contract is:

- `maxBytes` (512 … 4 MiB over MCP, default 262144) bounds the UTF-8 size of the page JSON, envelope included. That JSON is the text of the tool result; the JSON-RPC message around it adds its own string escaping. A budget outside the range is an `invalid_input` error, never adjusted silently.
- Every page with items left returns at least one and names the offset of the following page in `next` (`null` at the end), so following `next` always terminates. `bytes` is the exact size of the page.
- An item that does not fit even alone comes back reduced (long strings cut, long arrays sampled, or a `{ $truncated, $bytes, $preview }` placeholder) and the page carries `itemTruncated: true` and `itemBytes`. To read it whole, request `offset` = its index, `limit: 1`, `maxBytes` ≥ `itemBytes + 512`, or use `hexvero_export`.
- Strings longer than 4096 characters are cut and carry their full `length`. `limit` goes up to 2000.

The compact overview samples arrays longer than eight items and says how many more exist and which collection holds them.

## Comparing builds

`hexvero_compare { targetA, targetB }` without `collection` returns `collections`: one row per collection both targets share with the counts of added, removed, changed, relocated, unknown and unchanged items and `partial`, plus `onlyA`, `onlyB` and `partialScan`; use it to pick the collection to diff. `hexvero_compare { targetA, targetB, collection, key?, ignore?, strict? }` matches items by an identity (auto-detected, or `key`; `type+name` style composites are allowed) and returns `added`, `removed`, `changed` (with the differing paths), `relocated` and `unchanged`. Nothing is ignored by default. The one built-in rule: in native binaries, a symbol, export, section or segment whose only difference is an address field (`0x…` on both sides) is `relocated`, reported with samples; `strict: true` counts those as changed and `ignore` excludes further fields. `complete` is true only when all items were compared, nothing was ignored and neither analysis carries limitations; otherwise equal does not mean identical.

`added`, `removed` and `changed` each come as `{ count, sample, next? }`: by default 50, 50 and 25
items. `offset` and `limit` (up to 500) page through longer lists the same way as collections;
`next` is the offset of the following page. A side that is a partly read JavaScript app adds
`partialScan` and a `partialNote`.

## Guided prompts

`prompts/list` returns `investigate_feature`, `compare_versions`, `triage_binary`, `map_electron_app` and `explain_apk`.
Each takes a few string arguments (feature, path, pathA/pathB, focus) and renders a numbered plan that names the hexvero tools to call and the rules for citing evidence. Open questions go into the ledger with `hexvero_unknowns { action: "record" }` and come back with `hexvero_export`.

## Detected clients

`hexvero setup` writes only to clients whose config directory exists; `--all` configures every known client and `--client <id>` one of them. It is a dry run without `--apply`. Each client's own environment override is honoured (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GEMINI_CLI_HOME`, `COPILOT_HOME`, `QWEN_HOME`, `PI_CODING_AGENT_DIR`, `OPENCODE_CONFIG_DIR`, `XDG_CONFIG_HOME`, `APPDATA`).

Each row was checked on 2026-10-13 against the client's own documentation or source. "Read back" means the client's CLI listed the server from a file that `setup` generated in a temporary home; nothing else was tested against a running client.

| id              | Client                 | Config file                                                | Entry                                   | Checked                                                   |
| --------------- | ---------------------- | ---------------------------------------------------------- | --------------------------------------- | --------------------------------------------------------- |
| claude-code     | Claude Code            | `~/.claude.json`                                           | `mcpServers`                            | docs; read back with `claude mcp list`                    |
| claude-desktop  | Claude Desktop         | `claude_desktop_config.json` in the app support dir        | `mcpServers`                            | docs for macOS and Windows; the Linux path is unverified  |
| codex           | Codex                  | `~/.codex/config.toml`                                     | `[mcp_servers.hexvero]` (appended)      | docs and source; read back with `codex mcp list`          |
| cursor          | Cursor                 | `~/.cursor/mcp.json`                                       | `mcpServers` (type stdio)               | docs                                                      |
| windsurf        | Windsurf               | `~/.config/devin/mcp_config.json`                          | `mcpServers`                            | docs (Cascade reads the Devin config directory)           |
| windsurf-legacy | Windsurf, older builds | `~/.codeium/windsurf/mcp_config.json`                      | `mcpServers`                            | only offered when that file exists                        |
| gemini-cli      | Gemini CLI             | `~/.gemini/settings.json`                                  | `mcpServers`                            | docs                                                      |
| antigravity     | Antigravity            | `~/.gemini/config/mcp_config.json`                         | `mcpServers`                            | docs for the default path                                 |
| vscode          | VS Code                | `User/mcp.json` in the user data dir                       | `servers` (type stdio)                  | docs for the default profile                              |
| trae            | Trae                   | `User/mcp.json` in the user data dir                       | `mcpServers`                            | **unverified**: only the project-level file is documented |
| opencode        | OpenCode               | `~/.config/opencode/opencode.json`                         | `mcp` (type local)                      | docs and source                                           |
| copilot-cli     | GitHub Copilot CLI     | `~/.copilot/mcp-config.json`                               | `mcpServers` (type stdio, tools `*`)    | docs; read back with `copilot mcp list`                   |
| qwen-code       | Qwen Code              | `~/.qwen/settings.json`                                    | `mcpServers`                            | docs                                                      |
| qoder           | Qoder                  | `~/.qoder/settings.json`                                   | `mcpServers`                            | docs for Qoder CLI; the IDE's file is undocumented        |
| devin           | Devin                  | `~/.config/devin/mcp_config.json`                          | `mcpServers`                            | docs                                                      |
| pi              | Pi                     | `~/.pi/agent/mcp.json`                                     | `mcpServers` (type stdio)               | docs and source                                           |
| kiro            | Kiro                   | `~/.kiro/settings/mcp.json`                                | `mcpServers`                            | docs                                                      |
| amp             | Amp                    | `~/.config/amp/settings.json` or `.jsonc`                  | `amp.mcpServers` (a literal dotted key) | docs                                                      |
| zed             | Zed                    | `~/.config/zed/settings.json` (`%APPDATA%\Zed` on Windows) | `context_servers`                       | docs and source                                           |

How files are edited:

- Plain JSON is parsed, the entry is set and the file is written back; an existing file is first copied to `*.hexvero-backup` (never overwritten, never more readable than the original).
- JSON with comments or trailing commas (Zed, VS Code, OpenCode, Amp `.jsonc` …) is edited as text: the entry is inserted and every comment stays in place.
- Codex TOML is append-only. If the file already mentions `mcp_servers.hexvero`, defines `mcp_servers` as an inline table, or ends inside a multi-line string, it is left untouched with a reason.
- A file that cannot be parsed either way, or whose server container is not an object, is reported and left untouched. A client that already has the same entry is reported as already configured.

The MCP registry manifest lives in `server.json` at the repository root.
