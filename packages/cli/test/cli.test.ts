import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildAsar } from "../../core/test/fixtures/asar.js";
import { buildElf } from "../../core/test/fixtures/elf.js";
import type { Io } from "../src/format.js";
import { main } from "../src/index.js";

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

describe("hexvero CLI", () => {
  const dir = mkdtempSync(join(tmpdir(), "hexvero-cli-"));
  const so = join(dir, "lib.so");
  writeFileSync(so, buildElf());
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("shows the cache and clears it only with --apply", async () => {
    const root = join(dir, "cache");
    mkdirSync(join(root, "scans"), { recursive: true });
    const entry = join(root, "scans", `${"a".repeat(40)}.json`);
    writeFileSync(entry, "{}");
    const saved = process.env["HEXVERO_CACHE_DIR"];
    process.env["HEXVERO_CACHE_DIR"] = root;
    try {
      const shown = capture();
      expect(await main(["cache", "--json"], shown)).toBe(0);
      expect(JSON.parse(shown.stdout.join(""))).toMatchObject({
        root,
        areas: { scans: { count: 1 } },
      });
      const dry = capture();
      expect(await main(["cache", "--clear"], dry)).toBe(0);
      expect(dry.stdout.join("\n")).toContain("Would remove 1 entries");
      expect(existsSync(entry)).toBe(true);
      expect(await main(["cache", "--clear", "--apply"], capture())).toBe(0);
      expect(existsSync(entry)).toBe(false);
    } finally {
      if (saved === undefined) delete process.env["HEXVERO_CACHE_DIR"];
      else process.env["HEXVERO_CACHE_DIR"] = saved;
    }
  });

  it("prints help and version", async () => {
    const io = capture();
    expect(await main([], io)).toBe(2);
    expect(io.stderr[0]).toContain("Usage: hexvero");
    const help = capture();
    expect(await main(["--help"], help)).toBe(0);
    expect(help.stdout[0]).toContain("Usage: hexvero");
    expect(await main(["--version"], io)).toBe(0);
    expect(io.stdout.at(-1)).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("turns silent clamps into usage errors and reports partial output", async () => {
    for (const argv of [
      ["collection", so, "symbols", "--limit", "0"],
      ["collection", so, "symbols", "--offset", "-1"],
      ["strings", so, "--tag", "nope"],
      ["strings", so, "--text"],
      ["provider", so, "hopper", "functions"],
      ["provider", so, "ghidra", "strings"],
    ]) {
      const io = capture();
      expect(await main(argv, io), argv.join(" ")).toBe(2);
      expect(io.stderr[0]).toMatch(/usage:/);
      expect(io.stderr[0]).not.toContain("Usage: hexvero"); // short, not the whole help
    }
    const empty = capture();
    expect(await main(["collection", so, "symbols", "--text", "zzz-none"], empty)).toBe(0);
    expect(empty.stdout[0]).toContain("symbols 0 of 0");
    const map = join(dir, "app.js.map");
    writeFileSync(
      map,
      JSON.stringify({
        version: 3,
        sources: ["a.ts"],
        sourcesContent: ["let a = 1;"],
        names: [],
        mappings: "AAAA",
      }),
    );
    const linker = join(dir, "linker.map");
    writeFileSync(linker, "Archive member included to satisfy reference by file\n");
    const lio = capture();
    expect(await main(["analyze", linker, "--json"], lio)).toBe(0);
    expect(JSON.parse(lio.stdout.join("")).target.info.format).toBe("unknown");
    const bio = capture();
    expect(await main(["bytes", so, "0", "100000"], bio)).toBe(0);
    expect(bio.stdout.join("\n")).not.toContain("clamped"); // the file ends first
    const cio = capture();
    expect(await main(["compare", so, so, "symbols", "--json"], cio)).toBe(0);
    expect(JSON.parse(cio.stdout.join(""))).toMatchObject({
      truncated: false,
      compared: { a: 2, b: 2 },
    });
    const mio = capture();
    expect(await main(["analyze", map, "--json"], mio)).toBe(0);
    expect(JSON.parse(mio.stdout.join("")).target.info.format).toBe("json");
    expect(JSON.parse(mio.stdout.join("")).summary.toLowerCase()).toContain("source map");
  });

  it("analyzes a file in human and JSON form", async () => {
    const io = capture();
    expect(await main(["analyze", so], io)).toBe(0);
    const text = io.stdout.join("\n");
    expect(text).toContain("ELF64 x86-64 shared-object");
    expect(text).toContain("symbols (2)");
    const jio = capture();
    expect(await main(["analyze", so, "--json", "--out", join(dir, "a.json")], jio)).toBe(0);
    const parsed = JSON.parse(jio.stdout.join(""));
    expect(parsed.summary).toContain("ELF64");
    expect(parsed.overview.kind).toBe("binary");
    expect(existsSync(join(dir, "a.json"))).toBe(true);
  });

  it("reads a large JavaScript app in batches and never shows a partial scan as complete", async () => {
    const cache = mkdtempSync(join(tmpdir(), "hexvero-cli-cache-"));
    const previous = process.env["HEXVERO_CACHE_DIR"];
    process.env["HEXVERO_CACHE_DIR"] = cache;
    try {
      const app = join(dir, "app.asar");
      writeFileSync(
        app,
        buildAsar({
          "package.json": JSON.stringify({ name: "big", main: "main.js" }),
          "main.js": 'require("electron").ipcMain.handle("main:start", () => 1);',
          ...Object.fromEntries(
            Array.from({ length: 6 }, (_, i) => [
              `src/part${i}.js`,
              `require("electron").ipcRenderer.send("part:${i}");`,
            ]),
          ),
        }),
      );
      const first = capture();
      expect(await main(["analyze", app, "--batch", "3", "--continue"], first)).toBe(0);
      const text = first.stdout.join("\n");
      expect(text).toContain("partial: 3 of 7 JavaScript files scanned");
      expect(text).toContain("partial: 3 of 7 JavaScript files scanned (42%), 4 unread");
      expect(text).toContain("--continue");
      expect(text).toContain("(js_files_truncated)");
      // a later, separate invocation sees the stored state and still says partial
      const json = capture();
      expect(await main(["analyze", app, "--json"], json)).toBe(0);
      const stored = JSON.parse(json.stdout.join(""));
      expect(stored.complete).toBe(false);
      expect(stored.coverage).toMatchObject({ scanned: 3, remaining: 4, resumed: true });
      // other commands read the same state, and say that it is partial
      const channels = capture();
      expect(await main(["collection", app, "ipcChannels", "--json"], channels)).toBe(0);
      const page = JSON.parse(channels.stdout.join(""));
      expect(page.total).toBe(3);
      expect(page.partial).toEqual({ scanned: 3, total: 7, remaining: 4, skipped: 0 });
      const listed = capture();
      expect(await main(["collection", app, "ipcChannels"], listed)).toBe(0);
      expect(listed.stdout.join("\n")).toContain(
        "partial: this list covers 3 of 7 JavaScript files",
      );
      // a comparison that involves a partly read side warns that differences may be unread files
      const compared = capture();
      expect(await main(["compare", app, app, "ipcChannels"], compared)).toBe(0);
      expect(compared.stdout.join("\n")).toContain(
        "was read only in part (3 of 7 JavaScript files)",
      );
      const comparedJson = capture();
      expect(await main(["compare", app, app, "ipcChannels", "--json"], comparedJson)).toBe(0);
      expect(JSON.parse(comparedJson.stdout.join(""))).toMatchObject({
        complete: false,
        partialScan: { a: { scanned: 3, total: 7 } },
      });
      // files under one path only
      const picked = capture();
      expect(await main(["analyze", app, "--include", "src/part5.js", "--json"], picked)).toBe(0);
      expect(JSON.parse(picked.stdout.join("")).coverage.scanned).toBe(4);
      const all = capture();
      expect(await main(["analyze", app, "--all"], all)).toBe(0);
      expect(all.stdout.join("\n")).toContain("all 7 JavaScript files scanned");
      expect(all.stdout.join("\n")).not.toContain("partial");
      const done = capture();
      expect(await main(["collection", app, "ipcChannels", "--json"], done)).toBe(0);
      expect(JSON.parse(done.stdout.join("")).total).toBe(7);
      // --fresh forgets the stored scan
      const fresh = capture();
      expect(
        await main(["analyze", app, "--fresh", "--batch", "2", "--continue", "--json"], fresh),
      ).toBe(0);
      expect(JSON.parse(fresh.stdout.join("")).coverage).toMatchObject({
        scanned: 2,
        resumed: false,
      });
      const bad = capture();
      expect(await main(["analyze", app, "--batch", "0"], bad)).toBe(2);
    } finally {
      if (previous === undefined) delete process.env["HEXVERO_CACHE_DIR"];
      else process.env["HEXVERO_CACHE_DIR"] = previous;
      rmSync(cache, { recursive: true, force: true });
    }
  });

  it("pages collections, strings and bytes", async () => {
    const io = capture();
    expect(await main(["collection", so, "symbols", "--limit", "1"], io)).toBe(0);
    expect(io.stdout[0]).toContain("symbols 1-1 of 2");
    expect(io.stdout[1]).toContain("__stack_chk_fail");
    const sio = capture();
    expect(await main(["strings", so, "--tag", "path", "--json"], sio)).toBe(0);
    expect(JSON.parse(sio.stdout.join("")).items[0].value).toBe("/lib64/ld-linux-x86-64.so.2");
    const bio = capture();
    expect(await main(["bytes", so, "0", "16"], bio)).toBe(0);
    expect(bio.stdout[0]).toMatch(/^ {2}00000000 {2}7f 45 4c 46/);
  });

  it("reports usage and analysis errors with exit codes", async () => {
    const io = capture();
    expect(await main(["collection", so], io)).toBe(2);
    expect(io.stderr[0]).toContain("missing <collection>");
    const nio = capture();
    expect(await main(["analyze", join(dir, "nope.bin")], nio)).toBe(1);
    expect(nio.stderr[0]).toContain("error (not_found)");
    const jio = capture();
    expect(await main(["analyze", join(dir, "nope.bin"), "--json"], jio)).toBe(1);
    expect(JSON.parse(jio.stdout.join("")).error.code).toBe("not_found");
    expect(await main(["frobnicate"], capture())).toBe(2);
  });

  it("compares collections and runs doctor/setup dry runs", async () => {
    const other = join(dir, "other.so");
    writeFileSync(other, buildElf({ nx: false }));
    const io = capture();
    expect(await main(["compare", so, other, "findings", "--key", "kind", "--json"], io)).toBe(0);
    expect(JSON.parse(io.stdout.join("")).unchanged).toBe(1);
    const dio = capture();
    expect(await main(["doctor", "--json"], dio)).toBe(0);
    expect(JSON.parse(dio.stdout.join("")).node.ok).toBe(true);
    const sio = capture();
    expect(await main(["setup", "--client", "cursor"], sio)).toBe(0);
    expect(sio.stdout.join("\n")).toContain("Dry run");
    const cio = capture();
    expect(await main(["setup", "--client", "codex"], cio)).toBe(0);
    expect(cio.stdout[0]).toMatch(/codex\s+would (add hexvero|create)\s+.*config\.toml/);
  });
});

describe("setup --skill", () => {
  it("dry-runs and installs the skill into a temporary home", async () => {
    const { installSkill, skillTargets } = await import("../src/skill.js");
    const home = mkdtempSync(join(tmpdir(), "hexvero-skill-"));
    const targets = skillTargets(home);
    expect(targets.map((t) => t.id)).toEqual(["claude-code", "codex", "agents"]);
    const io = capture();
    expect(installSkill(io, { client: "claude-code", apply: false, json: true })).toBe(0);
    expect(JSON.parse(io.stdout.join("")).results[0].action).toBe("would install");
    rmSync(home, { recursive: true, force: true });
  });
});
