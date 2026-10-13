import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Io } from "../src/format.js";
import { CLIENTS, entryFor, patchToml, setup, type SetupContext } from "../src/setup.js";

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
    expect(existsSync(join(home, ".codeium"))).toBe(false);

    const io = capture();
    expect(await setup(io, { apply: true, json: true }, ctx)).toBe(0);
    const cursor = JSON.parse(readFileSync(join(home, ".cursor", "mcp.json"), "utf8"));
    expect(cursor.mcpServers.other).toEqual({ command: "x" });
    expect(cursor.mcpServers.hexvero).toEqual({ command: "npx", args: ["-y", "hexvero", "mcp"] });
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
    writeFileSync(join(home, ".qwen", "settings.json"), "{ // comment\n}");
    const io = capture();
    await setup(io, { client: "qwen-code", apply: true, json: true }, ctx);
    const result = JSON.parse(io.stdout.join("")).results[0];
    expect(result.action).toContain("skipped");
    expect(readFileSync(join(home, ".qwen", "settings.json"), "utf8")).toBe("{ // comment\n}");
    const zed = capture();
    await setup(zed, { client: "zed", apply: true, json: true }, ctx);
    const settings = JSON.parse(
      readFileSync(join(home, ".config", "zed", "settings.json"), "utf8"),
    );
    expect(settings.context_servers.hexvero).toEqual(entryFor("zed"));
  });
});
