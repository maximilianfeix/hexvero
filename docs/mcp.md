# MCP server

Start: `npx -y hexvero mcp` (stdio). Register with `hexvero setup --apply` (dry run without `--apply`; existing files are backed up as `*.hexvero-backup`) or add it to your client's
configuration manually:

```json
{ "mcpServers": { "hexvero": { "command": "npx", "args": ["-y", "hexvero", "mcp"] } } }
```

## Workflow

1. `hexvero_open { path }` → `{ id, info: { format, size, sha256 } }`
2. `hexvero_analyze { targetId }` → summary, findings, limitations, `collections: { name: count }`, compact overview
3. `hexvero_collection { targetId, collection, offset?, limit?, text? }` → one page
4. `hexvero_strings`, `hexvero_bytes` for raw evidence
5. `hexvero_export { targetId, path }` when the agent needs everything; `hexvero_recover { targetId, outputDir }` to get bundle modules or original sources as files

Results are JSON in a single text content block. Errors come back as `{ "error": { "code", "message", "details" } }` with `isError: true`.
Codes: `not_found`, `invalid_input`, `unsupported_format`, `malformed`, `too_large`, `provider_unavailable`.

## Budget

The tool catalog is under 32 KiB. Default pages are 100 items and at most 256 KiB serialized; `limit` goes up to 2000.
The compact overview samples arrays longer than eight items and says how many more exist and which collection holds them.

## Guided prompts

`prompts/list` returns `investigate_feature`, `compare_versions`, `triage_binary`, `map_electron_app` and `explain_apk`.
Each takes a few string arguments (feature, path, pathA/pathB, focus) and renders a numbered plan that names the hexvero tools to call and the rules for citing evidence. Open questions go into the ledger with `hexvero_unknowns { action: "record" }` and come back with `hexvero_export`.

## Detected clients

`hexvero setup` writes only to clients whose config directory exists; `--all` configures every known client and `--client <id>` one of them. Each client's own environment override is honoured (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GEMINI_CLI_HOME`, `PI_CODING_AGENT_DIR`, `OPENCODE_CONFIG_DIR`, `XDG_CONFIG_HOME`, `APPDATA`).

| id             | Client             | Config file                                         | Entry                              |
| -------------- | ------------------ | --------------------------------------------------- | ---------------------------------- |
| claude-code    | Claude Code        | `~/.claude.json`                                    | `mcpServers`                       |
| claude-desktop | Claude Desktop     | `claude_desktop_config.json` in the app support dir | `mcpServers`                       |
| codex          | Codex              | `~/.codex/config.toml`                              | `[mcp_servers.hexvero]`            |
| cursor         | Cursor             | `~/.cursor/mcp.json`                                | `mcpServers`                       |
| windsurf       | Windsurf           | `~/.codeium/windsurf/mcp_config.json`               | `mcpServers`                       |
| gemini-cli     | Gemini CLI         | `~/.gemini/settings.json`                           | `mcpServers`                       |
| antigravity    | Antigravity        | `~/.gemini/config/mcp_config.json`                  | `mcpServers`                       |
| vscode         | VS Code            | `User/mcp.json` in the user data dir                | `servers` (type stdio)             |
| trae           | Trae               | `User/mcp.json` in the user data dir                | `mcpServers`                       |
| opencode       | OpenCode           | `~/.config/opencode/opencode.json`                  | `mcp` (type local)                 |
| copilot-cli    | GitHub Copilot CLI | `~/.copilot/mcp-config.json`                        | `mcpServers` (type stdio, tools *) |
| qwen-code      | Qwen Code          | `~/.qwen/settings.json`                             | `mcpServers`                       |
| qoder          | Qoder              | `~/.qoder/settings.json`                            | `mcpServers`                       |
| devin          | Devin              | `~/.config/devin/mcp_config.json`                   | `mcpServers`                       |
| pi             | Pi                 | `~/.pi/agent/mcp.json`                              | `mcpServers` (type stdio)          |
| kiro           | Kiro               | `~/.kiro/settings/mcp.json`                         | `mcpServers`                       |
| amp            | Amp                | `~/.config/amp/settings.json`                       | `amp.mcpServers`                   |
| zed            | Zed                | `~/.config/zed/settings.json`                       | `context_servers` (source custom)  |

Files that are not plain JSON (comments, trailing commas) are reported and left untouched. The MCP registry manifest lives in `server.json` at the repository root.
