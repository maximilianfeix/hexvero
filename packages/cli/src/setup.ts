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
import { insertJsonc } from "./jsonc.js";
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

type Dialect = "default" | "stdio" | "copilot" | "opencode" | "toml";

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
const copilotDir = envDir("COPILOT_HOME", ".copilot");
const qwenDir = envDir("QWEN_HOME", ".qwen");
const devinDir = (ctx: SetupContext): string =>
  ctx.platform === "win32" ? join(appData(ctx), "devin") : join(xdg(ctx), "devin");
/** Zed reads ~/.config/zed on macOS regardless of XDG_CONFIG_HOME; Linux follows XDG. */
const zedDir = (ctx: SetupContext): string =>
  ctx.platform === "win32"
    ? join(appData(ctx), "Zed")
    : ctx.platform === "darwin"
      ? join(ctx.home, ".config", "zed")
      : join(xdg(ctx), "zed");
const opencodeDir = (ctx: SetupContext): string =>
  ctx.env["OPENCODE_CONFIG_DIR"] || join(xdg(ctx), "opencode");

export const CLIENTS: Client[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    // ~/.claude (the data directory), or ~/.claude.json alone, means Claude Code is in use.
    marker: (ctx) =>
      ctx.env["CLAUDE_CONFIG_DIR"]
        ? claudeCodeDir(ctx)
        : existsSync(join(ctx.home, ".claude.json"))
          ? join(ctx.home, ".claude.json")
          : join(ctx.home, ".claude"),
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
    dialect: "stdio",
  },
  {
    // Current Windsurf (Cascade) reads the Devin config directory; see docs/mcp.md.
    id: "windsurf",
    name: "Windsurf",
    marker: homeDir(".codeium", "windsurf"),
    file: (ctx) => join(devinDir(ctx), "mcp_config.json"),
    key: ["mcpServers"],
    dialect: "default",
  },
  {
    // Older Windsurf builds read this file; only offered when it already exists.
    id: "windsurf-legacy",
    name: "Windsurf (legacy config)",
    marker: homeDir(".codeium", "windsurf", "mcp_config.json"),
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
    marker: copilotDir,
    file: (ctx) => join(copilotDir(ctx), "mcp-config.json"),
    key: ["mcpServers"],
    dialect: "copilot",
  },
  {
    id: "qwen-code",
    name: "Qwen Code",
    marker: qwenDir,
    file: (ctx) => join(qwenDir(ctx), "settings.json"),
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
    marker: devinDir,
    file: (ctx) => join(devinDir(ctx), "mcp_config.json"),
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
    file: (ctx) => {
      const jsonc = join(xdg(ctx), "amp", "settings.jsonc");
      return existsSync(jsonc) ? jsonc : join(xdg(ctx), "amp", "settings.json");
    },
    key: ["amp.mcpServers"],
    dialect: "default",
  },
  {
    id: "zed",
    name: "Zed",
    marker: zedDir,
    file: (ctx) => join(zedDir(ctx), "settings.json"),
    key: ["context_servers"],
    dialect: "default",
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
  if (/mcp_servers\s*\.\s*["']?hexvero["']?/.test(existing))
    return { content: existing, skipped: "already mentions mcp_servers.hexvero; left untouched" };
  // `mcp_servers = { … }` (inline table) or a `[mcp_servers]` table with keys cannot be extended
  // by appending `[mcp_servers.hexvero]`; TOML rejects that.
  if (/^\s*mcp_servers\s*=/m.test(existing))
    return {
      content: existing,
      skipped: "mcp_servers is an inline table; add hexvero inside it by hand",
    };
  const table = /^\s*\[mcp_servers\]\s*$([\s\S]*?)(?=^\s*\[|(?![\s\S]))/m.exec(existing);
  if (table && /^\s*["']?hexvero["']?\s*=/m.test(table[1] ?? ""))
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
/** A write failure as one line: the code and what it means for this file. */
function writeError(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "EACCES" || code === "EPERM"
    ? `cannot write the file (${code}); left untouched`
    : code === "EROFS"
      ? "the file is on a read-only file system; left untouched"
      : `could not write the file (${error instanceof Error ? error.message : String(error)}); left untouched`;
}

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
  /** Take the hexvero entry out again instead of adding it. */
  remove?: boolean | undefined;
}

/** `[mcp_servers.hexvero]` and its sub-tables such as `[mcp_servers.hexvero.env]`. */
const ours = (line: string): boolean =>
  /^\s*\[\s*mcp_servers\s*\.\s*["']?hexvero["']?\s*(\.[^\]]*)?\]\s*$/.test(line);

/**
 * The file without hexvero's `[mcp_servers.hexvero]` table (and its sub-tables), or null when the
 * file has none. Everything else stays byte for byte.
 */
export function unpatchToml(existing: string): string | null {
  const lines = existing.split("\n");
  if (!lines.some(ours)) return null;
  const kept: string[] = [];
  let inside = false;
  for (const line of lines) {
    if (/^\s*\[/.test(line)) inside = ours(line);
    if (!inside) kept.push(line);
  }
  return `${kept
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\s+$/, "")}\n`;
}

/** Removes hexvero's entry from each client's file, with a backup; leaves everything else alone. */
function remove(
  options: SetupOptions,
  clients: readonly Client[],
  ctx: SetupContext,
): Array<{ client: string; file: string; detected: boolean; action: string }> {
  const results: Array<{ client: string; file: string; detected: boolean; action: string }> = [];
  for (const client of clients) {
    const file = client.file(ctx);
    const detected = existsSync(client.marker(ctx));
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8");
    let content: string | null = null;
    if (client.dialect === "toml") content = unpatchToml(text);
    else {
      let config: Record<string, unknown> | null = null;
      try {
        const parsed: unknown = JSON.parse(text);
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed))
          config = parsed as Record<string, unknown>;
      } catch {
        config = null;
      }
      if (config === null) {
        // Comments or trailing commas: rewriting the file would lose them, so it is not touched.
        if (/["']hexvero["']\s*:/.test(text))
          results.push({
            client: client.id,
            file,
            detected,
            action: 'skipped: the file has comments; remove the "hexvero" entry by hand',
          });
        continue;
      }
      let node: unknown = config;
      for (const k of client.key)
        node = node && typeof node === "object" ? (node as Record<string, unknown>)[k] : undefined;
      if (node && typeof node === "object" && "hexvero" in node) {
        delete (node as Record<string, unknown>)["hexvero"];
        content = `${JSON.stringify(config, null, 2)}\n`;
      }
    }
    if (content === null) continue;
    if (!options.apply) {
      results.push({ client: client.id, file, detected, action: "would remove hexvero" });
      continue;
    }
    let saved: string;
    try {
      saved = backup(file);
      replaceFile(file, content);
    } catch (error) {
      // One unwritable file (permissions, a read-only mount) must not stop the other clients.
      results.push({ client: client.id, file, detected, action: `skipped: ${writeError(error)}` });
      continue;
    }
    results.push({
      client: client.id,
      file,
      detected,
      action: `removed hexvero (backup: ${saved})`,
    });
  }
  return results;
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
  if (options.remove) {
    const removed = remove(options, clients, ctx);
    if (options.json) io.out(toJson({ apply: options.apply, remove: true, results: removed }));
    else {
      for (const r of removed)
        io.out(
          `${r.action.startsWith("skipped") ? paint(io, "yellow", "!") : paint(io, options.apply ? "green" : "cyan", options.apply ? "✓" : "·")} ${r.client.padEnd(14)} ${r.action}  ${paint(io, "dim", r.file)}`,
        );
      if (!removed.length)
        io.out("No client configuration has a hexvero entry; nothing to remove.");
      else if (!options.apply)
        io.out(
          paint(
            io,
            "dim",
            "\nDry run. Re-run with --remove --apply to write; each file is backed up first.",
          ),
        );
    }
    return 0;
  }
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
      const text = exists ? readFileSync(file, "utf8") : "";
      let config: Record<string, unknown> | null = {};
      if (exists) {
        try {
          const parsed: unknown = JSON.parse(text);
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
            throw new Error("not an object");
          config = parsed as Record<string, unknown>;
        } catch {
          config = null;
        }
      }
      if (config === null) {
        // Comments or trailing commas (Zed, VS Code, OpenCode …): insert the entry as text and
        // leave every other character of the file alone.
        const edit = insertJsonc(text, client.key, "hexvero", entryFor(client.dialect));
        if (!edit.ok) {
          results.push({
            client: client.id,
            file,
            detected,
            action:
              edit.reason === "already-present"
                ? "already configured; left untouched"
                : edit.reason === "container-not-object"
                  ? `skipped: "${client.key.join(".")}" is not an object in the existing file; left untouched`
                  : "skipped: existing file is neither JSON nor JSON with comments; add the entry by hand",
          });
          continue;
        }
        content = edit.content;
      } else {
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
        if (JSON.stringify(node["hexvero"]) === JSON.stringify(entryFor(client.dialect))) {
          results.push({
            client: client.id,
            file,
            detected,
            action: "already configured; left untouched",
          });
          continue;
        }
        if (node["hexvero"] !== undefined) {
          // A hand-edited or pinned entry is the user's decision; never replace it silently.
          results.push({
            client: client.id,
            file,
            detected,
            action:
              "skipped: a different hexvero entry exists; left untouched (edit it by hand or run --remove first)",
          });
          continue;
        }
        // Insert as text so key order, indentation and every other entry stay byte-identical.
        const edit = exists
          ? insertJsonc(text, client.key, "hexvero", entryFor(client.dialect))
          : null;
        if (edit?.ok) content = edit.content;
        else {
          node["hexvero"] = entryFor(client.dialect);
          content = `${JSON.stringify(config, null, 2)}\n`;
        }
      }
    }
    let saved: string | null;
    try {
      mkdirSync(dirname(file), { recursive: true });
      saved = exists ? backup(file) : null;
      replaceFile(file, content);
    } catch (error) {
      results.push({ client: client.id, file, detected, action: `skipped: ${writeError(error)}` });
      continue;
    }
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
  else if (results.every((r) => !r.detected) && !options.client && !options.all) {
    io.out(
      `No MCP client configuration was found under ${ctx.home}.\nName the client to configure, for example:\n  hexvero setup --client claude-code --apply\nKnown clients: ${CLIENTS.map((c) => c.id).join(", ")}. "--all --apply" writes every one of them.`,
    );
  } else {
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
