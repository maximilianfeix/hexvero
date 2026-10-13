import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Session, normalizeCallGraph } from "@hexvero/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHexveroServer, type ProviderBridge } from "../src/index.js";

describe("hexvero_call_graph", () => {
  const dir = mkdtempSync(join(tmpdir(), "hexvero-graph-"));
  const client = new Client({ name: "test", version: "0" });
  const calls: string[] = [];
  const bridge: ProviderBridge = {
    detect: async () => ({ providers: [] }),
    run: async (args) => {
      calls.push(`${args.operation}:${args.address ?? ""}:${args.text ?? ""}`);
      return { result: { ok: true }, limitations: [] };
    },
    callGraph: async (args) => {
      calls.push(`callgraph:${args.provider}`);
      return normalizeCallGraph("ghidra", {
        nodes: [
          { name: "entry", address: "0x1000" },
          { name: "FUN_1100", address: "0x1100" },
          { name: "FUN_1200", address: "0x1200" },
        ],
        edges: [
          { from: "0x1000", to: "0x1100" },
          { from: "0x1100", to: "0x1200" },
          { from: "0x1200", to: "EXTERNAL:1", toName: "system" },
        ],
      });
    },
  };
  let targetId = "";
  beforeAll(async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await createHexveroServer(new Session(), bridge).connect(serverTransport);
    await client.connect(clientTransport);
    const path = join(dir, "prog");
    writeFileSync(path, "not really a program");
    const opened = await client.callTool({ name: "hexvero_open", arguments: { path } });
    const text = (opened.content as Array<{ text: string }>)[0]!.text;
    targetId = (JSON.parse(text) as { id: string }).id;
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    return { ok: !result.isError, body: JSON.parse(text) as Record<string, unknown> };
  };

  it("returns bounded neighborhoods and shortest paths", async () => {
    const hood = await call("hexvero_call_graph", {
      targetId,
      provider: "ghidra",
      root: "0x1000",
      maxDepth: 1,
    });
    expect(hood.ok).toBe(true);
    expect(hood.body["levels"]).toEqual([
      { depth: 0, ids: ["0x1000"] },
      { depth: 1, ids: ["0x1100"] },
    ]);
    expect((hood.body["truncated"] as { depth: boolean }).depth).toBe(true);
    expect(hood.body["functions"]).toBe(4);
    const path = await call("hexvero_call_graph", {
      targetId,
      provider: "ghidra",
      root: "entry",
      goal: "system",
    });
    expect(path.body["path"]).toEqual(["0x1000", "0x1100", "0x1200", "EXTERNAL:1"]);
    const reverse = await call("hexvero_call_graph", {
      targetId,
      provider: "ghidra",
      root: "system",
      goal: "entry",
      direction: "both",
    });
    expect(reverse.body["path"]).toEqual(["EXTERNAL:1", "0x1200", "0x1100", "0x1000"]);
    const missing = await call("hexvero_call_graph", {
      targetId,
      provider: "ghidra",
      root: "FUN_",
    });
    expect(missing.ok).toBe(false);
    expect(
      (missing.body["error"] as { details: { candidates: string[] } }).details.candidates,
    ).toEqual(["FUN_1100 (0x1100)", "FUN_1200 (0x1200)"]);
  });

  it("passes search text through hexvero_provider_run", async () => {
    const r = await call("hexvero_provider_run", {
      targetId,
      provider: "radare2",
      operation: "search",
      text: "secret",
    });
    expect(r.ok).toBe(true);
    expect(calls).toContain("search::secret");
  });
});
