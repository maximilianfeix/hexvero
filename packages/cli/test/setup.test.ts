import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Io } from "../src/format.js";
import { insertJsonc, stripJsonc } from "../src/jsonc.js";
import {
  CLIENTS,
  entryFor,
  patchToml,
  setup,
  unpatchToml,
  type SetupContext,
} from "../src/setup.js";

function capture(): Io & { stdout: string[]; stderr: string[] } {
  const io = {
    stdout: [] as string[],
    stderr: [] as string[],
    color: false,
    out: (t: string) => void io.stdout.push(t),
    err: (t: string) => void io.stderr.push(t),
  };
  return io;
}

describe("setup", () => {
  const home = mkdtempSync(join(tmpdir(), "hexvero-setup-"));
  const ctx: SetupContext = { home, platform: "linux", env: { HOME: home } };
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  it("knows every documented client with a unique id", () => {
    const ids = CLIENTS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThanOrEqual(18);
    for (const c of CLIENTS) expect(c.file(ctx).startsWith(home)).toBe(true);
  });

  it("configures only detected clients by default and writes each dialect", async () => {
    mkdirSync(join(home, ".cursor"), { recursive: true });
    mkdirSync(join(home, ".config", "opencode"), { recursive: true });
    mkdirSync(join(home, ".config", "Code", "User"), { recursive: true });
    mkdirSync(join(home, ".copilot"), { recursive: true });
    writeFileSync(
      join(home, ".cursor", "mcp.json"),
      JSON.stringify({ mcpServers: { other: { command: "x" } } }),
    );
    const dry = capture();
    expect(await setup(dry, { apply: false, json: true }, ctx)).toBe(0);
    const plan = JSON.parse(dry.stdout.join("")).results as Array<{
      client: string;
      action: string;
    }>;
    expect(plan.find((r) => r.client === "cursor")?.action).toBe("would add hexvero");
    expect(plan.find((r) => r.client === "windsurf")?.action).toContain("not detected");
    expect(plan.find((r) => r.client === "windsurf-legacy")?.action).toContain("not detected");
    expect(existsSync(join(home, ".codeium"))).toBe(false);

    const io = capture();
    expect(await setup(io, { apply: true, json: true }, ctx)).toBe(0);
    const cursor = JSON.parse(readFileSync(join(home, ".cursor", "mcp.json"), "utf8"));
    expect(cursor.mcpServers.other).toEqual({ command: "x" });
    expect(cursor.mcpServers.hexvero).toEqual({
      type: "stdio",
      command: "npx",
      args: ["-y", "hexvero", "mcp"],
    });
    expect(existsSync(join(home, ".cursor", "mcp.json.hexvero-backup"))).toBe(true);
    const opencode = JSON.parse(
      readFileSync(join(home, ".config", "opencode", "opencode.json"), "utf8"),
    );
    expect(opencode.mcp.hexvero).toEqual({
      type: "local",
      command: ["npx", "-y", "hexvero", "mcp"],
      enabled: true,
    });
    const vscode = JSON.parse(
      readFileSync(join(home, ".config", "Code", "User", "mcp.json"), "utf8"),
    );
    expect(vscode.servers.hexvero.type).toBe("stdio");
    const copilot = JSON.parse(readFileSync(join(home, ".copilot", "mcp-config.json"), "utf8"));
    expect(copilot.mcpServers.hexvero.tools).toEqual(["*"]);
    expect(existsSync(join(home, ".codeium"))).toBe(false);
  });

  it("appends the Codex TOML table once and never rewrites existing content", async () => {
    mkdirSync(join(home, ".codex"), { recursive: true });
    const original = `model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "keep"\n`;
    writeFileSync(join(home, ".codex", "config.toml"), original);
    const io = capture();
    expect(await setup(io, { client: "codex", apply: true, json: true }, ctx)).toBe(0);
    const toml = readFileSync(join(home, ".codex", "config.toml"), "utf8");
    expect(toml).toBe(
      `${original}\n[mcp_servers.hexvero]\ncommand = "npx"\nargs = ["-y", "hexvero", "mcp"]\n`,
    );
    expect(readFileSync(join(home, ".codex", "config.toml.hexvero-backup"), "utf8")).toBe(original);
    // second run: already configured → untouched, backup not overwritten
    const again = capture();
    await setup(again, { client: "codex", apply: true, json: true }, ctx);
    expect(JSON.parse(again.stdout.join("")).results[0].action).toContain("already mentions");
    expect(readFileSync(join(home, ".codex", "config.toml"), "utf8")).toBe(toml);
    expect(readFileSync(join(home, ".codex", "config.toml.hexvero-backup"), "utf8")).toBe(original);
    expect(patchToml('[mcp_servers."hexvero"]\ncommand = "x"\n').skipped).toContain("already");
    expect(patchToml('[mcp_servers]\nhexvero = { command = "x" }\n').skipped).toContain("already");
    const triple = '"'.repeat(3);
    expect(patchToml(`note = ${triple}\nunterminated\n`).skipped).toContain("multi-line");
    expect(patchToml("a = 1").content).toBe(
      `a = 1\n\n[mcp_servers.hexvero]\ncommand = "npx"\nargs = ["-y", "hexvero", "mcp"]\n`,
    );
  });

  it("leaves incompatible containers alone and keeps every backup", async () => {
    mkdirSync(join(home, ".kiro", "settings"), { recursive: true });
    const file = join(home, ".kiro", "settings", "mcp.json");
    writeFileSync(file, JSON.stringify({ mcpServers: ["not", "an", "object"] }));
    const io = capture();
    await setup(io, { client: "kiro", apply: true, json: true }, ctx);
    expect(JSON.parse(io.stdout.join("")).results[0].action).toContain("not an object");
    expect(JSON.parse(readFileSync(file, "utf8")).mcpServers).toEqual(["not", "an", "object"]);
    writeFileSync(file, JSON.stringify({ other: 1 }));
    await setup(capture(), { client: "kiro", apply: true, json: true }, ctx);
    writeFileSync(file, JSON.stringify({ other: 2 }));
    const second = capture();
    await setup(second, { client: "kiro", apply: true, json: true }, ctx);
    expect(JSON.parse(readFileSync(`${file}.hexvero-backup`, "utf8")).other).toBe(1);
    expect(JSON.parse(second.stdout.join("")).results[0].action).toMatch(/hexvero-backup-\d+/);
    if (process.platform !== "win32") {
      const { statSync } = await import("node:fs");
      expect(statSync(`${file}.hexvero-backup`).mode & 0o077).toBe(0);
    }
  });

  it("uses platform specific paths for Zed and VS Code on Windows", () => {
    const win: SetupContext = {
      home: "C:\\Users\\me",
      platform: "win32",
      env: { APPDATA: "C:\\Users\\me\\AppData\\Roaming" },
    };
    const zed = CLIENTS.find((c) => c.id === "zed")!;
    expect(zed.file(win)).toContain("Roaming");
    expect(zed.file(win)).toContain("Zed");
    expect(CLIENTS.find((c) => c.id === "vscode")!.file(win)).toContain("Code");
  });

  it("refuses to rewrite files it cannot parse and honours --client for undetected clients", async () => {
    mkdirSync(join(home, ".qwen"), { recursive: true });
    writeFileSync(join(home, ".qwen", "settings.json"), "{ not json at all");
    const io = capture();
    await setup(io, { client: "qwen-code", apply: true, json: true }, ctx);
    const result = JSON.parse(io.stdout.join("")).results[0];
    expect(result.action).toContain("skipped");
    expect(readFileSync(join(home, ".qwen", "settings.json"), "utf8")).toBe("{ not json at all");
    const zed = capture();
    await setup(zed, { client: "zed", apply: true, json: true }, ctx);
    const settings = JSON.parse(
      readFileSync(join(home, ".config", "zed", "settings.json"), "utf8"),
    );
    expect(settings.context_servers.hexvero).toEqual(entryFor("default"));
  });

  it("edits settings with comments in place and keeps every comment (Zed, VS Code, OpenCode)", async () => {
    const dir = join(home, ".config", "zed");
    mkdirSync(dir, { recursive: true });
    const original = [
      "// Zed settings",
      "//",
      "// For information on how to configure Zed, see the documentation.",
      "{",
      '  "theme": "One Dark", // trailing comment',
      "  /* block */",
      '  "context_servers": {',
      '    "other": { "command": "x", "args": [] }, // keep me',
      "  },",
      "}",
      "",
    ].join("\n");
    writeFileSync(join(dir, "settings.json"), original);
    const io = capture();
    await setup(io, { client: "zed", apply: true, json: true }, ctx);
    expect(JSON.parse(io.stdout.join("")).results[0].action).toContain("added hexvero");
    const edited = readFileSync(join(dir, "settings.json"), "utf8");
    for (const kept of [
      "// Zed settings",
      "// trailing comment",
      "/* block */",
      "// keep me",
      '"theme": "One Dark"',
    ])
      expect(edited, kept).toContain(kept);
    const parsed = JSON.parse(stripJsonc(edited));
    expect(parsed.context_servers.hexvero).toEqual({
      command: "npx",
      args: ["-y", "hexvero", "mcp"],
    });
    expect(parsed.context_servers.other).toEqual({ command: "x", args: [] });
    // a second run changes nothing
    const again = capture();
    await setup(again, { client: "zed", apply: true, json: true }, ctx);
    expect(JSON.parse(again.stdout.join("")).results[0].action).toContain("already configured");
    expect(readFileSync(join(dir, "settings.json"), "utf8")).toBe(edited);
  });

  it("inserts into JSONC at any depth, creates missing containers and refuses what it cannot parse", () => {
    const entry = { command: "npx" };
    const empty = insertJsonc("{}", ["mcpServers"], "hexvero", entry);
    expect(empty.ok && JSON.parse(empty.content)).toEqual({ mcpServers: { hexvero: entry } });
    const nested = insertJsonc('{ // c\n  "a": { "b": {} } }', ["a", "b"], "hexvero", entry);
    expect(nested.ok && JSON.parse(stripJsonc(nested.content))).toEqual({
      a: { b: { hexvero: entry } },
    });
    const missing = insertJsonc('{\n  "x": 1, // one\n}', ["a", "b"], "hexvero", entry);
    expect(missing.ok && JSON.parse(stripJsonc(missing.content))).toEqual({
      x: 1,
      a: { b: { hexvero: entry } },
    });
    expect(insertJsonc('{ "mcpServers": [] }', ["mcpServers"], "hexvero", entry)).toEqual({
      ok: false,
      reason: "container-not-object",
    });
    expect(
      insertJsonc('{ "mcpServers": { "hexvero": {} } }', ["mcpServers"], "hexvero", entry),
    ).toEqual({
      ok: false,
      reason: "already-present",
    });
    expect(insertJsonc("{ not json", ["a"], "hexvero", entry).ok).toBe(false);
    expect(insertJsonc("[1]", ["a"], "hexvero", entry)).toEqual({
      ok: false,
      reason: "not-an-object",
    });
    // a brace or comment marker inside a string is not structure
    const tricky = insertJsonc(
      '{ "s": "a // } b", "k": { "t": "/* */" } }',
      ["k"],
      "hexvero",
      entry,
    );
    expect(tricky.ok && JSON.parse(stripJsonc(tricky.content))).toEqual({
      s: "a // } b",
      k: { hexvero: entry, t: "/* */" },
    });
  });

  it("honours client environment overrides and refuses to extend an inline TOML table", () => {
    const env: SetupContext = {
      home,
      platform: "darwin",
      env: {
        COPILOT_HOME: join(home, "cp"),
        QWEN_HOME: join(home, "qw"),
        XDG_CONFIG_HOME: join(home, "xdg"),
      },
    };
    const file = (id: string): string => CLIENTS.find((c) => c.id === id)!.file(env);
    expect(file("copilot-cli")).toBe(join(home, "cp", "mcp-config.json"));
    expect(file("qwen-code")).toBe(join(home, "qw", "settings.json"));
    expect(file("zed")).toBe(join(home, ".config", "zed", "settings.json")); // macOS ignores XDG for Zed
    expect(file("windsurf")).toBe(join(home, "xdg", "devin", "mcp_config.json"));
    expect(CLIENTS.find((c) => c.id === "cursor")!.dialect).toBe("stdio");
    expect(patchToml('mcp_servers = { other = { command = "x" } }\n').skipped).toContain(
      "inline table",
    );
    expect(patchToml('[tools]\nhexvero = "unrelated"\n').skipped).toBeNull();
    expect(patchToml('[mcp_servers]\nhexvero = { command = "x" }\n').skipped).toContain("already");
  });

  it("removes exactly its own entry again, with backups, and is idempotent", async () => {
    const own = mkdtempSync(join(tmpdir(), "hexvero-remove-"));
    const c: SetupContext = { home: own, platform: "linux", env: { HOME: own } };
    try {
      mkdirSync(join(own, ".codex"), { recursive: true });
      mkdirSync(join(own, ".claude"), { recursive: true });
      mkdirSync(join(own, ".config", "zed"), { recursive: true });
      const codex = `model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "keep"\n`;
      writeFileSync(join(own, ".codex", "config.toml"), codex);
      writeFileSync(
        join(own, ".claude.json"),
        JSON.stringify({ n: 1, mcpServers: { other: { command: "x" } } }),
      );
      writeFileSync(
        join(own, ".config", "zed", "settings.json"),
        '{\n  // keep this comment\n  "context_servers": {}\n}\n',
      );
      await setup(capture(), { apply: true, json: true }, c);
      expect(readFileSync(join(own, ".codex", "config.toml"), "utf8")).toContain(
        "[mcp_servers.hexvero]",
      );
      // a dry run changes nothing and says what it would do
      const dry = capture();
      await setup(dry, { apply: false, json: true, remove: true }, c);
      const planned = JSON.parse(dry.stdout.join("")).results as Array<{
        client: string;
        action: string;
      }>;
      expect(planned.map((r) => `${r.client}: ${r.action}`).toSorted()).toEqual([
        "claude-code: would remove hexvero",
        "codex: would remove hexvero",
        'zed: skipped: the file has comments; remove the "hexvero" entry by hand',
      ]);
      expect(readFileSync(join(own, ".codex", "config.toml"), "utf8")).toContain("hexvero");
      // the real run removes only hexvero's entries and keeps backups
      await setup(capture(), { apply: true, json: true, remove: true }, c);
      expect(readFileSync(join(own, ".codex", "config.toml"), "utf8")).toBe(codex);
      expect(JSON.parse(readFileSync(join(own, ".claude.json"), "utf8"))).toEqual({
        n: 1,
        mcpServers: { other: { command: "x" } },
      });
      expect(readFileSync(join(own, ".config", "zed", "settings.json"), "utf8")).toContain(
        "// keep this comment",
      );
      // again: only the file with comments, which needs a hand, is still mentioned
      const again = capture();
      await setup(again, { apply: true, json: true, remove: true }, c);
      expect(
        (JSON.parse(again.stdout.join("")).results as Array<{ client: string }>).map(
          (r) => r.client,
        ),
      ).toEqual(["zed"]);
      const none = capture();
      await setup(none, { apply: true, json: false, remove: true, client: "codex" }, c);
      expect(none.stdout.join("\n")).toContain("nothing to remove");
      expect(
        unpatchToml(
          'a = 1\n[mcp_servers.hexvero]\ncommand = "npx"\n[mcp_servers.hexvero.env]\nX = "1"\n[b]\nc = 2\n',
        ),
      ).toBe("a = 1\n[b]\nc = 2\n");
      expect(unpatchToml("a = 1\n")).toBeNull();
    } finally {
      rmSync(own, { recursive: true, force: true });
    }
  });

  it("says plainly when no client is found instead of listing every miss", async () => {
    const empty = mkdtempSync(join(tmpdir(), "hexvero-empty-"));
    try {
      const io = capture();
      await setup(
        io,
        { apply: false, json: false },
        { home: empty, platform: "linux", env: { HOME: empty } },
      );
      const text = io.stdout.join("\n");
      expect(text).toContain("No MCP client configuration was found");
      expect(text).toContain("hexvero setup --client claude-code --apply");
      expect(text.split("\n").length).toBeLessThan(6);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
