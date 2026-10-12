import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { UsageError } from "./args.js";
import { paint, toJson, type Io } from "./format.js";

interface Client {
  id: string;
  name: string;
  file: (home: string) => string;
  /** Path inside the JSON config where servers live. */
  key: string[];
}

const SERVER = { command: "npx", args: ["-y", "hexvero", "mcp"] };

export const CLIENTS: Client[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    file: (h) => join(h, ".claude.json"),
    key: ["mcpServers"],
  },
  {
    id: "claude-desktop",
    name: "Claude Desktop",
    file: (h) =>
      process.platform === "darwin"
        ? join(h, "Library", "Application Support", "Claude", "claude_desktop_config.json")
        : join(h, ".config", "Claude", "claude_desktop_config.json"),
    key: ["mcpServers"],
  },
  {
    id: "cursor",
    name: "Cursor",
    file: (h) => join(h, ".cursor", "mcp.json"),
    key: ["mcpServers"],
  },
  {
    id: "windsurf",
    name: "Windsurf",
    file: (h) => join(h, ".codeium", "windsurf", "mcp_config.json"),
    key: ["mcpServers"],
  },
  {
    id: "gemini-cli",
    name: "Gemini CLI",
    file: (h) => join(h, ".gemini", "settings.json"),
    key: ["mcpServers"],
  },
  {
    id: "vscode",
    name: "VS Code",
    file: (h) => join(h, ".vscode", "mcp.json"),
    key: ["servers"],
  },
];

export async function setup(
  io: Io,
  options: { client?: string | undefined; apply: boolean; json: boolean },
): Promise<number> {
  if (options.client === "codex") {
    const snippet = `[mcp_servers.hexvero]\ncommand = "npx"\nargs = ["-y", "hexvero", "mcp"]`;
    io.out(
      options.json
        ? toJson({
            client: "codex",
            file: join(homedir(), ".codex", "config.toml"),
            snippet,
          })
        : `Add to ~/.codex/config.toml:\n\n${snippet}`,
    );
    return 0;
  }
  const clients = options.client ? CLIENTS.filter((c) => c.id === options.client) : CLIENTS;
  if (!clients.length)
    throw new UsageError(
      `unknown client "${options.client}"; known: codex, ${CLIENTS.map((c) => c.id).join(", ")}`,
    );
  const results: Array<{ client: string; file: string; action: string }> = [];
  for (const client of clients) {
    const file = client.file(homedir());
    const exists = existsSync(file);
    if (!options.apply) {
      results.push({
        client: client.id,
        file,
        action: exists ? "would add hexvero" : "would create",
      });
      continue;
    }
    let config: Record<string, unknown> = {};
    if (exists) {
      try {
        config = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      } catch {
        results.push({
          client: client.id,
          file,
          action: "skipped: existing file is not valid JSON",
        });
        continue;
      }
    }
    let node = config;
    for (const k of client.key) node = (node[k] as Record<string, unknown>) ?? (node[k] = {});
    node["hexvero"] = SERVER;
    mkdirSync(join(file, ".."), { recursive: true });
    if (exists) writeFileSync(`${file}.hexvero-backup`, readFileSync(file));
    writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
    results.push({
      client: client.id,
      file,
      action: exists ? "added hexvero (backup written)" : "created",
    });
  }
  if (options.json) io.out(toJson({ apply: options.apply, results }));
  else {
    for (const r of results)
      io.out(
        `${paint(io, options.apply ? "green" : "cyan", options.apply ? "✓" : "·")} ${r.client.padEnd(14)} ${r.action}  ${paint(io, "dim", r.file)}`,
      );
    if (!options.apply)
      io.out(
        paint(
          io,
          "dim",
          "\nDry run. Re-run with --apply to write; existing files are backed up as *.hexvero-backup.",
        ),
      );
  }
  return 0;
}
