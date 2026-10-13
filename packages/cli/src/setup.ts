import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { UsageError } from "./args.js";
import { paint, toJson, type Io } from "./format.js";

/**
 * Registers the hexvero MCP server with agent clients. Every client is described
 * by where its user-level config lives (honoring the client's own environment
 * overrides), which key holds servers and which entry dialect it reads. Setup
 * only touches clients whose config directory exists unless --all is given, and
 * never rewrites a file it cannot parse.
 */

export interface SetupContext {
  home: string;
  platform: NodeJS.Platform;
  env: Readonly<Record<string, string | undefined>>;
}

type Dialect = "default" | "stdio" | "copilot" | "opencode" | "zed" | "toml";

export interface Client {
  id: string;
  name: string;
  /** Directory whose presence means the client is installed. */
  marker: (ctx: SetupContext) => string;
  file: (ctx: SetupContext) => string;
  /** Path inside the config where servers live (ignored for toml). */
  key: string[];
  dialect: Dialect;
}

const COMMAND = "npx";
const ARGS = ["-y", "hexvero", "mcp"];

const xdg = (ctx: SetupContext): string => ctx.env["XDG_CONFIG_HOME"] || join(ctx.home, ".config");
const appData = (ctx: SetupContext): string =>
  ctx.env["APPDATA"] || join(ctx.home, "AppData", "Roaming");
/** Per-platform user directory of VS Code style editors (`Code`, `Trae`). */
const editorUserDir =
  (product: string) =>
  (ctx: SetupContext): string =>
    ctx.platform === "win32"
      ? join(appData(ctx), product, "User")
      : ctx.platform === "darwin"
        ? join(ctx.home, "Library", "Application Support", product, "User")
        : join(xdg(ctx), product, "User");
const appSupport =
  (product: string) =>
  (ctx: SetupContext): string =>
    ctx.platform === "win32"
      ? join(appData(ctx), product)
      : ctx.platform === "darwin"
        ? join(ctx.home, "Library", "Application Support", product)
        : join(xdg(ctx), product);
const homeDir =
  (...parts: string[]) =>
  (ctx: SetupContext): string =>
    join(ctx.home, ...parts);
const envDir =
  (variable: string, ...fallback: string[]) =>
  (ctx: SetupContext): string =>
    ctx.env[variable] || join(ctx.home, ...fallback);

const claudeCodeDir = envDir("CLAUDE_CONFIG_DIR");
const codexDir = envDir("CODEX_HOME", ".codex");
const geminiDir = (ctx: SetupContext): string =>
  join(ctx.env["GEMINI_CLI_HOME"] || ctx.home, ".gemini");
const piDir = envDir("PI_CODING_AGENT_DIR", ".pi", "agent");
const opencodeDir = (ctx: SetupContext): string =>
  ctx.env["OPENCODE_CONFIG_DIR"] || join(xdg(ctx), "opencode");

export const CLIENTS: Client[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    marker: (ctx) =>
      ctx.env["CLAUDE_CONFIG_DIR"] ? claudeCodeDir(ctx) : join(ctx.home, ".claude"),
    file: (ctx) => join(claudeCodeDir(ctx), ".claude.json"),
    key: ["mcpServers"],
    dialect: "default",
  },
  {
    id: "claude-desktop",
    name: "Claude Desktop",
    marker: appSupport("Claude"),
    file: (ctx) => join(appSupport("Claude")(ctx), "claude_desktop_config.json"),
    key: ["mcpServers"],
    dialect: "default",
  },
  {
    id: "codex",
    name: "Codex",
    marker: codexDir,
    file: (ctx) => join(codexDir(ctx), "config.toml"),
    key: ["mcp_servers"],
    dialect: "toml",
  },
  {
    id: "cursor",
    name: "Cursor",
    marker: homeDir(".cursor"),
    file: homeDir(".cursor", "mcp.json"),
    key: ["mcpServers"],
    dialect: "default",
  },
  {
    id: "windsurf",
    name: "Windsurf",
    marker: homeDir(".codeium", "windsurf"),
    file: homeDir(".codeium", "windsurf", "mcp_config.json"),
    key: ["mcpServers"],
    dialect: "default",
  },
  {
    id: "gemini-cli",
    name: "Gemini CLI",
    marker: geminiDir,
    file: (ctx) => join(geminiDir(ctx), "settings.json"),
    key: ["mcpServers"],
    dialect: "default",
  },
  {
    id: "antigravity",
    name: "Antigravity",
    marker: (ctx) => join(geminiDir(ctx), "config"),
    file: (ctx) => join(geminiDir(ctx), "config", "mcp_config.json"),
    key: ["mcpServers"],
    dialect: "default",
  },
  {
    id: "vscode",
    name: "VS Code",
    marker: editorUserDir("Code"),
    file: (ctx) => join(editorUserDir("Code")(ctx), "mcp.json"),
    key: ["servers"],
    dialect: "stdio",
  },
  {
    id: "trae",
    name: "Trae",
    marker: editorUserDir("Trae"),
    file: (ctx) => join(editorUserDir("Trae")(ctx), "mcp.json"),
    key: ["mcpServers"],
    dialect: "default",
  },
  {
    id: "opencode",
    name: "OpenCode",
    marker: opencodeDir,
    file: (ctx) => join(opencodeDir(ctx), "opencode.json"),
    key: ["mcp"],
    dialect: "opencode",
  },
  {
    id: "copilot-cli",
    name: "GitHub Copilot CLI",
    marker: homeDir(".copilot"),
    file: homeDir(".copilot", "mcp-config.json"),
    key: ["mcpServers"],
    dialect: "copilot",
  },
  {
    id: "qwen-code",
    name: "Qwen Code",
    marker: homeDir(".qwen"),
    file: homeDir(".qwen", "settings.json"),
    key: ["mcpServers"],
    dialect: "default",
  },
  {
    id: "qoder",
    name: "Qoder",
    marker: homeDir(".qoder"),
    file: homeDir(".qoder", "settings.json"),
    key: ["mcpServers"],
    dialect: "default",
  },
  {
    id: "devin",
    name: "Devin",
    marker: (ctx) =>
      ctx.platform === "win32" ? join(appData(ctx), "devin") : join(xdg(ctx), "devin"),
    file: (ctx) =>
      join(
        ctx.platform === "win32" ? join(appData(ctx), "devin") : join(xdg(ctx), "devin"),
        "mcp_config.json",
      ),
    key: ["mcpServers"],
    dialect: "default",
  },
  {
    id: "pi",
    name: "Pi",
    marker: piDir,
    file: (ctx) => join(piDir(ctx), "mcp.json"),
    key: ["mcpServers"],
    dialect: "stdio",
  },
  {
    id: "kiro",
    name: "Kiro",
    marker: homeDir(".kiro"),
    file: homeDir(".kiro", "settings", "mcp.json"),
    key: ["mcpServers"],
    dialect: "default",
  },
  {
    id: "amp",
    name: "Amp",
    marker: (ctx) => join(xdg(ctx), "amp"),
    file: (ctx) => join(xdg(ctx), "amp", "settings.json"),
    key: ["amp.mcpServers"],
    dialect: "default",
  },
  {
    id: "zed",
    name: "Zed",
    marker: (ctx) => (ctx.platform === "win32" ? join(appData(ctx), "Zed") : join(xdg(ctx), "zed")),
    file: (ctx) =>
      ctx.platform === "win32"
        ? join(appData(ctx), "Zed", "settings.json")
        : join(xdg(ctx), "zed", "settings.json"),
    key: ["context_servers"],
    dialect: "zed",
  },
];

/** The server entry in the dialect a client reads. */
export function entryFor(dialect: Dialect): Record<string, unknown> {
  switch (dialect) {
    case "stdio":
      return { type: "stdio", command: COMMAND, args: ARGS };
    case "copilot":
      return { type: "stdio", command: COMMAND, args: ARGS, tools: ["*"] };
    case "opencode":
      return { type: "local", command: [COMMAND, ...ARGS], enabled: true };
    case "zed":
      return { source: "custom", command: COMMAND, args: ARGS };
    default:
      return { command: COMMAND, args: ARGS };
  }
}

const TOML_BLOCK = `[mcp_servers.hexvero]\ncommand = "${COMMAND}"\nargs = [${ARGS.map((a) => `"${a}"`).join(", ")}]\n`;

/**
 * Appends a `[mcp_servers.hexvero]` table. hexvero ships no TOML parser, so it never rewrites
 * existing content: a file that already mentions the server (table, quoted table, inline table) or
 * that ends inside a multi-line string is returned unchanged with a reason.
 */
export function patchToml(existing: string): { content: string; skipped: string | null } {
  if (/mcp_servers\s*\.\s*["']?hexvero["']?|^\s*hexvero\s*=/m.test(existing))
    return { content: existing, skipped: "already mentions mcp_servers.hexvero; left untouched" };
  const tripleQuotes = (existing.match(/"{3}|'{3}/g) ?? []).length;
  if (tripleQuotes % 2 === 1)
    return { content: existing, skipped: "ends inside a multi-line string; add the table by hand" };
  const sep =
    existing.length === 0 || existing.endsWith("\n\n")
      ? ""
      : existing.endsWith("\n")
        ? "\n"
        : "\n\n";
  return { content: `${existing}${sep}${TOML_BLOCK}`, skipped: null };
}

/** Writes `content` atomically next to `file` (temp file + rename) following a symlinked target. */
function replaceFile(file: string, content: string): void {
  const target = existsSync(file) ? realpathSync(file) : file;
  const mode = existsSync(target) ? statSync(target).mode & 0o777 : 0o600;
  const temp = `${target}.hexvero-${process.pid}.tmp`;
  writeFileSync(temp, content, { mode });
  renameSync(temp, target);
}

/** Copies the current file to a backup that is never overwritten and never more readable than the original. */
function backup(file: string): string {
  const target = realpathSync(file);
  const mode = statSync(target).mode & 0o700;
  let path = `${target}.hexvero-backup`;
  if (existsSync(path)) path = `${target}.hexvero-backup-${Date.now()}`;
  writeFileSync(path, readFileSync(target), { mode: mode || 0o600, flag: "wx" });
  return path;
}

export function defaultContext(): SetupContext {
  return { home: homedir(), platform: process.platform, env: process.env };
}

export interface SetupOptions {
  client?: string | undefined;
  apply: boolean;
  json: boolean;
  /** Also configure clients whose directory does not exist (default: detected clients only). */
  all?: boolean | undefined;
}

export async function setup(
  io: Io,
  options: SetupOptions,
  ctx = defaultContext(),
): Promise<number> {
  let clients = options.client ? CLIENTS.filter((c) => c.id === options.client) : CLIENTS;
  if (!clients.length)
    throw new UsageError(
      `unknown client "${options.client}"; known: ${CLIENTS.map((c) => c.id).join(", ")}`,
    );
  const results: Array<{ client: string; file: string; detected: boolean; action: string }> = [];
  if (!options.client && !options.all) {
    const detected = clients.filter((c) => existsSync(c.marker(ctx)));
    for (const c of clients)
      if (!detected.includes(c))
        results.push({
          client: c.id,
          file: c.file(ctx),
          detected: false,
          action: "not detected (use --all or --client)",
        });
    clients = detected;
  }
  for (const client of clients) {
    const file = client.file(ctx);
    const exists = existsSync(file);
    const detected = existsSync(client.marker(ctx));
    if (!options.apply) {
      results.push({
        client: client.id,
        file,
        detected,
        action: exists ? "would add hexvero" : "would create",
      });
      continue;
    }
    let content: string;
    if (client.dialect === "toml") {
      const patched = patchToml(exists ? readFileSync(file, "utf8") : "");
      if (patched.skipped) {
        results.push({ client: client.id, file, detected, action: `skipped: ${patched.skipped}` });
        continue;
      }
      content = patched.content;
    } else {
      let config: Record<string, unknown> = {};
      if (exists) {
        try {
          const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
            throw new Error("not an object");
          config = parsed as Record<string, unknown>;
        } catch {
          results.push({
            client: client.id,
            file,
            detected,
            action:
              "skipped: existing file is not plain JSON (comments or trailing commas?); add the entry by hand",
          });
          continue;
        }
      }
      let node: Record<string, unknown> | null = config;
      for (const k of client.key) {
        const existing = node[k];
        if (existing === undefined) {
          node[k] = {};
        } else if (typeof existing !== "object" || existing === null || Array.isArray(existing)) {
          node = null;
          break;
        }
        node = node[k] as Record<string, unknown>;
      }
      if (node === null) {
        results.push({
          client: client.id,
          file,
          detected,
          action: `skipped: "${client.key.join(".")}" is not an object in the existing file; left untouched`,
        });
        continue;
      }
      node["hexvero"] = entryFor(client.dialect);
      content = `${JSON.stringify(config, null, 2)}\n`;
    }
    mkdirSync(dirname(file), { recursive: true });
    const saved = exists ? backup(file) : null;
    replaceFile(file, content);
    results.push({
      client: client.id,
      file,
      detected,
      action: saved ? `added hexvero (backup: ${saved})` : "created",
    });
  }
  results.sort(
    (a, b) => Number(b.detected) - Number(a.detected) || a.client.localeCompare(b.client),
  );
  if (options.json) io.out(toJson({ apply: options.apply, results }));
  else {
    for (const r of results) {
      const mark = r.action.startsWith("not detected")
        ? paint(io, "dim", "–")
        : r.action.startsWith("skipped")
          ? paint(io, "yellow", "!")
          : paint(io, options.apply ? "green" : "cyan", options.apply ? "✓" : "·");
      io.out(`${mark} ${r.client.padEnd(14)} ${r.action}  ${paint(io, "dim", r.file)}`);
    }
    if (!options.apply)
      io.out(
        paint(
          io,
          "dim",
          "\nDry run. Re-run with --apply to write; existing files are backed up next to them as *.hexvero-backup (never overwritten). Only detected clients are configured unless you pass --all or --client.",
        ),
      );
  }
  return 0;
}
