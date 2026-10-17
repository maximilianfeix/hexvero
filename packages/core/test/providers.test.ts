import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { detectProviders } from "../src/providers/index.js";
import { loadCallGraph, runProvider } from "../src/providers/run.js";

const unixOnly = process.platform === "win32" ? describe.skip : describe;

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const waitFor = async (check: () => boolean): Promise<boolean> => {
  for (let i = 0; i < 100; i++) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
};

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
    for (const iterator of ["entry0@@F", "entry0@@@F", "$$", "entry0$$", "-", "0x", "a@b"])
      await expect(
        runProvider({
          targetPath: target,
          provider: "radare2",
          operation: "disassemble",
          address: iterator,
        }),
      ).rejects.toThrow(/address must be/);
    for (const ok of [
      "0x1000",
      "00101000",
      "main",
      "sym.imp.__assert_rtn",
      "fcn.00001a78",
      "FUN_00101000",
      "Foo::bar",
      "_start",
      ".hidden",
    ])
      expect(
        (
          await runProvider({
            targetPath: target,
            provider: "radare2",
            operation: "disassemble",
            address: ok,
          })
        ).address,
      ).toBe(ok);
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

  it("kills the engine when the caller aborts", async () => {
    writeFileSync(
      join(dir, "rizin"),
      '#!/bin/sh\nif [ "$1" = "-v" ]; then echo slow; exit 0; fi\nsleep 5\n',
    );
    chmodSync(join(dir, "rizin"), 0o755);
    const target = join(dir, "bin7");
    writeFileSync(target, "q");
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    const started = performance.now();
    await expect(
      runProvider({
        targetPath: target,
        provider: "rizin",
        operation: "functions",
        signal: controller.signal,
      }),
    ).rejects.toThrow(/cancelled/);
    expect(performance.now() - started).toBeLessThan(3000);
  });

  it("stops a shared call-graph run once every waiting caller has cancelled", async () => {
    const pidFile = join(dir, "engine.pid");
    writeFileSync(
      join(dir, "rizin"),
      `#!/bin/sh\nif [ "$1" = "-v" ]; then echo "rizin shared"; exit 0; fi\necho $$ > "${pidFile}"\necho start >> "${pidFile}.log"\nsleep 30\n`,
    );
    chmodSync(join(dir, "rizin"), 0o755);
    const target = join(dir, "bin-shared");
    writeFileSync(target, "shared");
    const first = new AbortController();
    const second = new AbortController();
    const a = loadCallGraph({ targetPath: target, provider: "rizin", signal: first.signal });
    const b = loadCallGraph({ targetPath: target, provider: "rizin", signal: second.signal });
    expect(await waitFor(() => existsSync(pidFile))).toBe(true);
    const pid = Number(readFileSync(pidFile, "utf8"));
    first.abort();
    await expect(a).rejects.toThrow(/cancelled/);
    // the other caller still waits, so the engine keeps running
    await new Promise((r) => setTimeout(r, 200));
    expect(alive(pid)).toBe(true);
    second.abort();
    await expect(b).rejects.toThrow(/cancelled/);
    expect(await waitFor(() => !alive(pid))).toBe(true);
    // both callers shared one engine run
    expect(readFileSync(`${pidFile}.log`, "utf8").trim().split("\n")).toHaveLength(1);
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
    ).rejects.toMatchObject({
      code: "provider_unavailable",
      message: expect.stringMatching(/exceeded 300 ms/),
      details: { reason: "timeout", timeoutMs: 300 },
    });
  });
});
