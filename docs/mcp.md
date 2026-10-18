# MCP server

Start: `npx -y hexvero mcp` (stdio; pin a version, e.g. `npx -y hexvero@0.9.8 mcp`, for reproducible results). Register with `hexvero setup --apply` (dry run without `--apply`; existing files are backed up as `*.hexvero-backup`) or add it to your client's
configuration manually:

```json
{ "mcpServers": { "hexvero": { "command": "npx", "args": ["-y", "hexvero", "mcp"] } } }
```

## Workflow

1. `hexvero_open { path }` → `{ id, info: { format, size, sha256 } }`
2. `hexvero_analyze { targetId }` → summary, findings (each with `confidence` and, where a parser records one, a `location` such as `main.js:14`), limitations, `collections: { name: count }`, compact overview. For a JavaScript application the result also has `complete` and `coverage { total, scanned, remaining, nextFiles }`: when `complete` is false, every list covers the scanned part only. Call again with `scan: "continue"` (next batch), `scan: "all"` (the rest) or `include: ["src/main"]` (unread files under those paths) to read more; `scan: "fresh"` discards the stored scan The result also has `next`: up to four calls that answer the obvious next questions for this kind of target, ready to send. `overview` lists the facts and the size of each list; `detail: "full"` adds samples of every list (the earlier default), and the lists themselves are paged with `hexvero_collection`.
3. `hexvero_collection { targetId, collection, offset?, limit?, text?, maxBytes? }` → one page with `next`
4. `hexvero_strings`, `hexvero_bytes` for raw evidence
5. `hexvero_compare { targetA, targetB, collection }` for two builds; `hexvero_check { targetA, targetB, policy | policyPath }` applies a release policy to them; `hexvero_unknowns { action: "record" | "list" | "resolve" | "remove" }` for questions the evidence cannot answer
6. `hexvero_export { targetId, path }` when the agent needs everything; `hexvero_recover { targetId, outputDir }` to get bundle modules or original sources as files
7. With an engine installed: `hexvero_providers`, `hexvero_provider_run`, `hexvero_call_graph`; `hexvero_sourcemap` maps a generated position to its source; `hexvero_list` / `hexvero_close` manage the session

## Tools

16 tools; the catalog (`tools/list`) is 15,637 bytes, measured with `node scripts/context-cost.mjs` (session start with prompts and instructions: 17,847 bytes, 4,158 `o200k_base` tokens). `scripts/check-shape.mjs` fails the build above 16 tools.

| Tool                                                                | Writes         | Purpose                                                                 |
| ------------------------------------------------------------------- | -------------- | ----------------------------------------------------------------------- |
| `hexvero_open` · `hexvero_list` · `hexvero_close`                   | close: session | Register, list and release targets                                      |
| `hexvero_analyze`                                                   | no             | Summary, findings, limitations, coverage, collection counts, next calls |
| `hexvero_collection` · `hexvero_strings` · `hexvero_bytes`          | no             | Paged lists, tagged strings, a hex window                               |
| `hexvero_compare`                                                   | no             | Items of one collection between two targets, each list paged on its own |
| `hexvero_check`                                                     | no             | A release policy applied to two targets (`hexvero check`)               |
| `hexvero_export` · `hexvero_recover`                                | yes            | The analysis as JSON, bundle modules or source-map originals as files   |
| `hexvero_unknowns`                                                  | session        | Ledger of open questions                                                |
| `hexvero_sourcemap`                                                 | no             | Original position for a generated line/column                           |
| `hexvero_providers` · `hexvero_provider_run` · `hexvero_call_graph` | engine caches  | radare2, rizin, Ghidra                                                  |

Results are JSON in a single text content block. Errors come back as `{ "error": { "code", "message", "details" } }` with `isError: true`.
Codes: `not_found`, `invalid_input`, `unsupported_format`, `malformed`, `too_large`, `provider_unavailable`, `cancelled`.
A request the caller cancels fails with `cancelled`. A limit that was exceeded is `too_large`; when the limit was time or memory rather than size, `details.reason` says so (`"timeout"` with `details.timeoutMs`, or `"memory"`). An engine run that times out is `provider_unavailable` with `details.reason: "timeout"`.

## Paths and writes

`hexvero_open`, `hexvero_check` (`policyPath`, `baselinePath`: read only, `.json`, inside the same roots or next to an opened target), `hexvero_export` and `hexvero_recover` take paths as the hexvero process sees them: pass absolute paths, because relative ones resolve against the server's working directory, which the agent cannot observe. Export and recover write only inside the allowed roots: the server's working directory (unless it is the home directory or `/`) and the system temp directory, or the directories listed in `HEXVERO_WRITE_ROOTS` (separated by `:`, or `;` on Windows). They never write into a hidden file or directory below a root, an export must end in `.json`, and a symlink that leads out of a root is refused: every component of the path is judged by where it leads, also a symlink whose target does not exist yet. As Linux's `protected_symlinks` does, a link in a sticky directory (a shared temp directory) is followed only when it belongs to you or to root. An export never writes through a symlink at the path itself, even one that stays inside a root; a new file is created exclusively and an existing one is opened without following links. The policy is checked again when the file is opened (an export analyzes first, which takes time) and before every directory and file a recovery creates, and an opened export must be the file at the location the policy resolved (same device and inode), otherwise it is refused and a file it just created is removed. A directory on the way that other users can change is refused: one that is not sticky and is owned by a user other than you or root, writable by everyone, or writable by its group. That covers the root's ancestors up to `/`, the root, and the directories below it. A sticky shared temp directory such as `/tmp` is fine. A group-writable directory is accepted only on Linux when its group is provably your user-private group (the umask `002` layout of Debian, Ubuntu and others): every `/etc/group` entry with that gid is named after you and lists no one else, the gid is 1000 or more, and no other account in `/etc/passwd` has it as its primary group. Never on macOS, where every user's primary group is the shared `staff`. For a setup the check cannot prove, `HEXVERO_TRUST_GROUP_WRITABLE=1` accepts group-writable directories; the risk is that any other member of such a group can swap a directory for a link between the check and the write and so direct an export or recovery to a place of their choosing. Otherwise point `HEXVERO_WRITE_ROOTS` at a directory only you can change. Two setups this refuses on purpose: a server running as root in a container over a bind mount owned by your user (uid 1000): the mount's directories belong to a user other than the server's and other than root, so run the server as that user or point `HEXVERO_WRITE_ROOTS` at a directory the server's user owns; and accounts and groups from LDAP or SSSD, which are not in `/etc/group` and `/etc/passwd`, so a user-private group cannot be proven and `HEXVERO_TRUST_GROUP_WRITABLE=1` is the way to accept it. On Windows these ownership checks do not apply, and access control lists are not checked. What remains: Node has no `openat`, so another process of the same user that swaps a directory for a link in the instant between the last check and the open can still have an empty file or an empty directory created at the link's target (the file is removed again when the path still names it): every export and every recovered file is opened first and compared with the location the policy resolved, and on a mismatch it is removed again and the write stops before any content is written. An existing export with other hard links is not replaced. Export refuses to replace an existing file unless `overwrite: true`, and even then replaces only an earlier hexvero export; recover refuses a non-empty directory. The CLI has none of these limits, because there a person picks the path. Tool annotations say which tools write (`readOnlyHint: false`): export, recover, provider_run and call_graph (engine caches under `~/.cache/hexvero`), close and unknowns (session state). Strings, symbol names, decompiled code and recovered files are data from the target, never instructions. Every tool result says so in machine-readable form as well: `_meta["io.github.maximilianfeix.hexvero/untrustedContent"]` is `true`.

## Budget

The tool catalog is under 32 KiB (15,637 bytes for 16 tools). Lists come back as pages; the contract is:

- `maxBytes` (512 … 4 MiB over MCP, default 262144) bounds the UTF-8 size of the page JSON, envelope included. That JSON is the text of the tool result; the JSON-RPC message around it adds its own string escaping. A budget outside the range is an `invalid_input` error, never adjusted silently.
- Every page with items left returns at least one and names the offset of the following page in `next` (`null` at the end), so following `next` always terminates. `bytes` is the exact size of the page.
- An item that does not fit even alone comes back reduced (long strings cut, long arrays sampled, or a `{ $truncated, $bytes, $preview }` placeholder) and the page carries `itemTruncated: true` and `itemBytes`. To read it whole, request `offset` = its index, `limit: 1`, `maxBytes` ≥ `itemBytes + 512`, or use `hexvero_export`.
- Strings longer than 4096 characters are cut and carry their full `length`. `limit` goes up to 2000.

The compact overview samples arrays longer than eight items and says how many more exist and which collection holds them.

## Comparing builds

`hexvero_compare { targetA, targetB }` without `collection` returns `collections`: one row per collection both targets share with the counts of added, removed, changed, relocated, unknown and unchanged items and `partial`, plus `onlyA`, `onlyB` and `partialScan`; use it to pick the collection to diff. `hexvero_compare { targetA, targetB, collection, key?, ignore?, strict? }` matches items by an identity (auto-detected, or `key`; `type+name` style composites are allowed) and returns `added`, `removed`, `changed` (with the differing paths), `relocated` and `unchanged`. Nothing is ignored by default. The one built-in rule: in native binaries, a symbol, export, section or segment whose only difference is an address field (`0x…` on both sides) is `relocated`, reported with samples; `strict: true` counts those as changed and `ignore` excludes further fields. `complete` is true only when all items were compared, nothing was ignored and neither analysis carries limitations; otherwise equal does not mean identical.

`added`, `removed`, `changed` and `unknown` each come as `{ count, sample, next? }`: by default
50, 50, 25 and 50 items, `limit` (up to 500) per list. Each list pages on its own: `next` is the
offset of that list's following page, and the next call passes it together with the list,
`{ …, list: "removed", offset: next }`. Such a call returns that list's page and only the counts of
the others. An `offset` without `list` is an `invalid_input` error, because one offset cannot be
right for four lists of different lengths. `shown` says in words how many items of each list the
answer holds and how to get the rest, e.g. `removed 2 of 7 (next: list "removed", offset 2)`.
`unknown` holds items found on one side where the other side has values that could not be
resolved or files that were not read: they are neither added nor removed. `completeness` is the
core's record of what was compared (`compared`, `total`, `complete`, `gaps`); `note` states it. A
side that is a partly read JavaScript app adds `partialScan` and a `partialNote`.

## Release policy check

`hexvero_check { targetA, targetB, policy | policyPath, baselinePath?, format?, offset?, limit? }`
is `hexvero check` without the exit code: it compares the two targets in full (every row, not a
page) and applies the policy (format: [policy.schema.json](policy.schema.json), example:
[examples/policy.json](../examples/policy.json)). Pass the policy inline as a JSON object or as
the path of a file, exactly one of the two. The answer is the `PolicyResult` of the CLI's
`--format json` (`status` `pass`, `fail` or `incomplete`, `findings`, `incomplete`, `baseline`,
`policy`, `a`, `b`), plus `counts` by state and level over all findings and `findingsPage`
`{ offset, limit, total, next, shown }`. The status is decided on every finding; the result shows
up to `limit` of them (default 100, at most 500) and is held under 256 KiB by showing fewer, so
follow `next`. A finding keeps up to 20 places, with `whereTotal` when it had more. `format:
"markdown"` returns `{ status, format, counts, findingsPage, text }` and `format: "sarif"` the same
with `sarif` (a SARIF 2.1.0 log) for the page shown. `incomplete` means the check could not be
decided, not that it passed.

The tool is read-only (`readOnlyHint: true`): `policyPath` and `baselinePath` are read, never
written, and only `.json` files of at most 1 MiB inside the write roots (see
[Paths and writes](#paths-and-writes)) or in the directory of a target opened in the session; a
symlink is judged by where it leads. The file is read through one descriptor that must be a
regular file. Errors never quote the file: a file that is not JSON is reported as `not valid JSON
at line N col M`, and a JSON file without `"hexvero": "policy"` (or `"baseline"`) is refused
without naming its keys. Creating or updating a baseline stays a CLI action,
`hexvero check <before> <after> --policy <file> --baseline <file> --update-baseline`, so a person
accepts findings. An invalid policy is `invalid_input` with the problem in `message` and every
issue with its JSON path in `details.issues`; a missing policy or baseline file is `not_found`.

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
