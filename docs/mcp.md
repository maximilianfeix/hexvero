# MCP server

Start: `npx -y hexvero mcp` (stdio). Register with `hexvero setup --apply` or add it to your client's
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
