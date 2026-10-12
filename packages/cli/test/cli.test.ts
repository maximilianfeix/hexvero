import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
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

  it("prints help and version", async () => {
    const io = capture();
    expect(await main([], io)).toBe(2);
    expect(io.stdout[0]).toContain("Usage: hexvero");
    expect(await main(["--version"], io)).toBe(0);
    expect(io.stdout.at(-1)).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("analyzes a file in human and JSON form", async () => {
    const io = capture();
    expect(await main(["analyze", so], io)).toBe(0);
    const text = io.stdout.join("\n");
    expect(text).toContain("ELF64 x86-64 shared-object");
    expect(text).toContain("symbols (2)");
    const jio = capture();
    expect(
      await main(["analyze", so, "--json", "--out", join(dir, "a.json")], jio),
    ).toBe(0);
    const parsed = JSON.parse(jio.stdout.join(""));
    expect(parsed.summary).toContain("ELF64");
    expect(parsed.overview.kind).toBe("binary");
    expect(existsSync(join(dir, "a.json"))).toBe(true);
  });

  it("pages collections, strings and bytes", async () => {
    const io = capture();
    expect(await main(["collection", so, "symbols", "--limit", "1"], io)).toBe(
      0,
    );
    expect(io.stdout[0]).toContain("symbols 1-1 of 2");
    expect(io.stdout[1]).toContain("__stack_chk_fail");
    const sio = capture();
    expect(await main(["strings", so, "--tag", "path", "--json"], sio)).toBe(0);
    expect(JSON.parse(sio.stdout.join("")).items[0].value).toBe(
      "/lib64/ld-linux-x86-64.so.2",
    );
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
    expect(await main(["analyze", join(dir, "nope.bin"), "--json"], jio)).toBe(
      1,
    );
    expect(JSON.parse(jio.stdout.join("")).error.code).toBe("not_found");
    expect(await main(["frobnicate"], capture())).toBe(2);
  });

  it("compares collections and runs doctor/setup dry runs", async () => {
    const other = join(dir, "other.so");
    writeFileSync(other, buildElf({ nx: false }));
    const io = capture();
    expect(
      await main(
        ["compare", so, other, "findings", "--key", "kind", "--json"],
        io,
      ),
    ).toBe(0);
    expect(JSON.parse(io.stdout.join("")).unchanged).toBe(1);
    const dio = capture();
    expect(await main(["doctor", "--json"], dio)).toBe(0);
    expect(JSON.parse(dio.stdout.join("")).node.ok).toBe(true);
    const sio = capture();
    expect(await main(["setup", "--client", "cursor"], sio)).toBe(0);
    expect(sio.stdout.join("\n")).toContain("Dry run");
    const cio = capture();
    expect(await main(["setup", "--client", "codex"], cio)).toBe(0);
    expect(cio.stdout[0]).toContain("[mcp_servers.hexvero]");
  });
});
