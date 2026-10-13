import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { detectProviders } from "../src/providers/index.js";
import { loadCallGraph, runProvider } from "../src/providers/run.js";

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
  *agCj*) echo '[{"name":"main","addr":4096,"size":42},{"name":"helper","addr":4200,"size":10}]'; echo '[{"name":"main","size":42,"imports":["helper","sym.imp.puts"]},{"name":"helper","size":10,"imports":["sym.imp.puts"]}]' ;;
  *axtj*) echo '[{"name":"main","addr":4096,"size":42}]'; echo '[{"from":4100,"type":"CALL","opcode":"call helper","fcn_name":"main"},{"from":4204,"type":"CALL"}]' ;;
  *izj*aflj*|*aflj*izj*) echo '[{"name":"main","offset":4096,"size":42}]'; echo '[{"string":"hello main","vaddr":8192},{"string":"other","vaddr":8200}]' ;;
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
      `#!/bin/sh
# args: projectDir name -import file ... op spec out
for a; do P2=$P1; P1=$CUR; CUR=$a; done
mkdir -p "$1"; touch "$1/hexvero.gpr"
case "$P2" in
  callgraph) echo '{"nodes":[{"name":"entry","address":"0x1000"},{"name":"FUN_2000","address":"0x2000"}],"edges":[{"from":"entry","to":"FUN_2000"},{"from":"FUN_2000","to":"puts"}],"truncated":false}' > "$CUR" ;;
  search) echo "{\\"functions\\":[{\\"name\\":\\"entry\\",\\"address\\":\\"0x1000\\"}],\\"strings\\":[],\\"needle\\":\\"$P1\\"}" > "$CUR" ;;
  *) echo '{"functions":[{"name":"entry","address":"0x1000"}],"truncated":false}' > "$CUR" ;;
esac
`,
    );
    chmodSync(join(dir, "analyzeHeadless"), 0o755);
    writeFileSync(
      join(dir, "rizin"),
      `#!/bin/sh
if [ "$1" = "-v" ]; then echo "rizin 0.9.1 fake"; exit 0; fi
while [ $# -gt 1 ]; do if [ "$1" = "-c" ]; then CMD="$2"; fi; shift; done
case "$CMD" in
  *agCj*) echo 'ERROR: Command agCj does not exist' >&2 ;;
  *"agC json"*) echo '[{"offset":4096,"name":"entry0","size":40}]'; echo '{"nodes":[{"id":0,"title":"entry0","offset":4096,"out_nodes":[1]},{"id":1,"title":"sym.imp.puts","offset":8192,"out_nodes":[]}]}' ;;
  *axtj*) echo '[{"offset":4096,"name":"entry0","size":40}]'; echo '[{"from":4112,"to":8192,"type":"CALL"}]' ;;
  *) echo 'null' ;;
esac
`,
    );
    chmodSync(join(dir, "rizin"), 0o755);
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
    expect(found.find((p) => p.name === "rizin")?.version).toBe("rizin 0.9.1 fake");
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
      runProvider({ targetPath: target, provider: "rizin", operation: "functions" }, [
        { name: "rizin", available: false, operations: [] },
      ]),
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

  it("answers xrefs, callers, callees, callgraph and search through radare2", async () => {
    const target = join(dir, "bin4");
    writeFileSync(target, "w");
    const xrefs = await runProvider({
      targetPath: target,
      provider: "radare2",
      operation: "xrefs",
      address: "helper",
    });
    expect(xrefs.result).toEqual({
      references: [
        { from: "0x1004", type: "CALL", function: "main", opcode: "call helper" },
        { from: "0x106c", type: "CALL", function: null, opcode: null },
      ],
      truncated: false,
    });
    const graph = await runProvider({
      targetPath: target,
      provider: "radare2",
      operation: "callgraph",
    });
    const g = graph.result as {
      nodes: Array<{ name: string }>;
      edges: unknown[];
      truncated: boolean;
    };
    expect(g.nodes.map((n) => n.name)).toEqual(["main", "helper", "sym.imp.puts"]);
    expect(g.edges).toHaveLength(3);
    const callers = await runProvider({
      targetPath: target,
      provider: "radare2",
      operation: "callers",
      address: "puts",
    });
    expect(
      (callers.result as { callers: Array<{ name: string }> }).callers.map((c) => c.name),
    ).toEqual(["helper", "main"]);
    const callees = await runProvider({
      targetPath: target,
      provider: "radare2",
      operation: "callees",
      address: "0x1000",
    });
    expect(
      (callees.result as { callees: Array<{ name: string }> }).callees.map((c) => c.name),
    ).toEqual(["helper", "sym.imp.puts"]);
    const missing = await runProvider({
      targetPath: target,
      provider: "radare2",
      operation: "callees",
      address: "nope",
    });
    expect(missing.limitations[0]?.code).toBe("function_not_found");
    const first = await loadCallGraph({ targetPath: target, provider: "radare2" });
    expect(first.cached).toBe(false);
    expect(first.graph.edges).toHaveLength(3);
    const second = await loadCallGraph({ targetPath: target, provider: "radare2" });
    expect(second.cached).toBe(true);
    expect(second.graph).toBe(first.graph);
    expect(existsSync(join(dir, "cache", "graphs"))).toBe(true);
    const search = await runProvider({
      targetPath: target,
      provider: "radare2",
      operation: "search",
      text: "MAIN",
    });
    expect(search.result).toEqual({
      needle: "MAIN",
      functions: [{ name: "main", address: "0x1000" }],
      strings: [{ value: "hello main", address: "0x2000" }],
      truncated: false,
    });
    await expect(
      runProvider({ targetPath: target, provider: "radare2", operation: "search", text: "" }),
    ).rejects.toThrow(/search needs text/);
    await expect(
      runProvider({ targetPath: target, provider: "radare2", operation: "callers" }),
    ).rejects.toThrow(/needs an address/);
    await expect(
      runProvider({ targetPath: target, provider: "radare2", operation: "functions", text: "x" }),
    ).rejects.toThrow(/only accepted by the search/);
  });

  it("projects Ghidra call graphs and passes search text as a script argument", async () => {
    const target = join(dir, "bin5");
    writeFileSync(target, "v");
    const callers = await runProvider({
      targetPath: target,
      provider: "ghidra",
      operation: "callers",
      address: "puts",
    });
    expect(
      (callers.result as { callers: Array<{ name: string }> }).callers.map((c) => c.name),
    ).toEqual(["FUN_2000"]);
    const search = await runProvider({
      targetPath: target,
      provider: "ghidra",
      operation: "search",
      text: "-scriptlog; touch /tmp/pwned",
    });
    expect((search.result as { needle: string }).needle).toBe("text:-scriptlog; touch /tmp/pwned");
  });

  it("speaks rizin's dialect: agC json graphs and axtj rows without function names", async () => {
    const target = join(dir, "bin6");
    writeFileSync(target, "u");
    const graph = await runProvider({
      targetPath: target,
      provider: "rizin",
      operation: "callgraph",
    });
    expect((graph.result as { edges: unknown[] }).edges).toEqual([
      { from: "entry0", to: "sym.imp.puts" },
    ]);
    const xrefs = await runProvider({
      targetPath: target,
      provider: "rizin",
      operation: "xrefs",
      address: "sym.imp.puts",
    });
    expect(
      (xrefs.result as { references: Array<{ function: string }> }).references[0]?.function,
    ).toBe("entry0");
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
