import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { detectProviders } from "../src/providers/index.js";
import { runProvider } from "../src/providers/run.js";

const unixOnly = process.platform === "win32" ? describe.skip : describe;

unixOnly("providers", () => {
  const dir = mkdtempSync(join(tmpdir(), "hexvero-prov-"));
  const originalPath = process.env["PATH"];
  beforeAll(() => {
    // Fake radare2 that answers each command with canned JSON, plus a slow one for the timeout test.
    writeFileSync(
      join(dir, "r2"),
      `#!/bin/sh
if [ "$1" = "-v" ]; then echo "radare2 5.9.9 fake"; exit 0; fi
while [ $# -gt 1 ]; do if [ "$1" = "-c" ]; then CMD="$2"; fi; shift; done
case "$CMD" in
  *aflj*) echo 'WARN: noise'; echo '[{"name":"main","offset":4096,"size":42}]' ;;
  *pdfj*) echo '{"name":"main","ops":[{"offset":4096,"opcode":"push rbp"}]}' ;;
  *pdgj*) echo '' ;;
  *izj*) echo '[{"string":"hello","vaddr":8192}]' ;;
  *iij*) echo '[{"name":"puts","libname":"libc.so.6"}]' ;;
  *) echo 'null' ;;
esac
`,
    );
    chmodSync(join(dir, "r2"), 0o755);
    writeFileSync(
      join(dir, "analyzeHeadless"),
      `#!/bin/sh\n# args: projectDir name -import file ... op addr out\nfor a; do OUT=$a; done\nmkdir -p "$1"; touch "$1/hexvero.gpr"; echo '{"functions":[{"name":"entry","address":"0x1000"}],"truncated":false}' > "$OUT"\n`,
    );
    chmodSync(join(dir, "analyzeHeadless"), 0o755);
    process.env["PATH"] = `${dir}:${originalPath ?? ""}`;
    process.env["HEXVERO_CACHE_DIR"] = join(dir, "cache");
  });
  afterAll(() => {
    process.env["PATH"] = originalPath ?? "";
    delete process.env["HEXVERO_CACHE_DIR"];
    rmSync(dir, { recursive: true, force: true });
  });

  it("detects engines on PATH with versions", async () => {
    const found = await detectProviders();
    const r2 = found.find((p) => p.name === "radare2")!;
    expect(r2.available).toBe(true);
    expect(r2.version).toBe("radare2 5.9.9 fake");
    expect(r2.operations).toContain("decompile");
    expect(found.find((p) => p.name === "ghidra")?.available).toBe(true);
    expect(found.find((p) => p.name === "rizin")?.available).toBe(false);
  });

  it("runs radare2 operations and parses JSON past warnings", async () => {
    const target = join(dir, "bin");
    writeFileSync(target, "x");
    const functions = await runProvider({
      targetPath: target,
      provider: "radare2",
      operation: "functions",
    });
    expect(functions.result).toEqual([{ name: "main", offset: 4096, size: 42 }]);
    expect(functions.limitations).toEqual([]);
    const dis = await runProvider({
      targetPath: target,
      provider: "radare2",
      operation: "disassemble",
      address: "0x1000",
    });
    expect((dis.result as { name: string }).name).toBe("main");
    const dec = await runProvider({
      targetPath: target,
      provider: "radare2",
      operation: "decompile",
      address: "main",
    });
    expect(dec.limitations[0]?.code).toBe("decompiler_missing");
    await expect(
      runProvider({
        targetPath: target,
        provider: "rizin",
        operation: "functions",
      }),
    ).rejects.toThrow(/not installed/);
    await expect(
      runProvider({
        targetPath: target,
        provider: "radare2",
        operation: "functions",
        address: "x; rm -rf /",
      }),
    ).rejects.toThrow(/address must be/);
  });

  it("runs Ghidra headless against a cached project", async () => {
    const target = join(dir, "bin2");
    writeFileSync(target, "y");
    const first = await runProvider({
      targetPath: target,
      provider: "ghidra",
      operation: "functions",
    });
    expect((first.result as { functions: unknown[] }).functions).toHaveLength(1);
    const second = await runProvider({
      targetPath: target,
      provider: "ghidra",
      operation: "functions",
    });
    expect(second.limitations).toEqual([]);
    await expect(
      runProvider({
        targetPath: target,
        provider: "ghidra",
        operation: "strings",
      }),
    ).rejects.toThrow(/does not support/);
  });

  it("kills engines that exceed the timeout", async () => {
    writeFileSync(join(dir, "rizin"), "#!/bin/sh\nsleep 5\n");
    chmodSync(join(dir, "rizin"), 0o755);
    const target = join(dir, "bin3");
    writeFileSync(target, "z");
    await expect(
      runProvider({
        targetPath: target,
        provider: "rizin",
        operation: "functions",
        timeoutMs: 300,
      }),
    ).rejects.toThrow(/exceeded 300 ms/);
  });
});
