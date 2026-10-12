import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Session } from "@hexvero/core";
import { createHexveroServer } from "../src/index.js";
import { buildElf } from "../../core/test/fixtures/elf.js";

describe("hexvero MCP server", () => {
  const dir = mkdtempSync(join(tmpdir(), "hexvero-mcp-"));
  const client = new Client({ name: "test", version: "0" });
  let targetId = "";
  beforeAll(async () => {
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await createHexveroServer(new Session()).connect(serverTransport);
    await client.connect(clientTransport);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const call = async (
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<{ ok: boolean; body: Record<string, unknown> }> => {
    const result = await client.callTool({ name, arguments: args });
    const content = (
      result.content as Array<{ type: string; text: string }>
    )[0]!;
    return {
      ok: !result.isError,
      body: JSON.parse(content.text) as Record<string, unknown>,
    };
  };

  it("advertises a compact catalog", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toHaveLength(12);
    const bytes = Buffer.byteLength(JSON.stringify(tools));
    expect(bytes).toBeLessThan(32 * 1024);
    expect(tools.every((t) => t.description && t.description.length > 20)).toBe(
      true,
    );
  });

  it("opens, analyzes and pages a target", async () => {
    const path = join(dir, "fixture.so");
    writeFileSync(path, buildElf());
    const opened = await call("hexvero_open", { path });
    expect(opened.ok).toBe(true);
    targetId = opened.body["id"] as string;
    expect(targetId).toMatch(/^t_/);
    const analyzed = await call("hexvero_analyze", { targetId });
    expect(analyzed.ok).toBe(true);
    expect(analyzed.body["summary"]).toContain("ELF64");
    expect(analyzed.body["collections"]).toMatchObject({ symbols: 2 });
    const overview = analyzed.body["overview"] as Record<string, unknown>;
    expect(overview["kind"]).toBe("binary");
    const page = await call("hexvero_collection", {
      targetId,
      collection: "symbols",
      limit: 1,
    });
    expect(page.body).toMatchObject({
      total: 2,
      truncated: true,
      collection: "symbols",
    });
    const strings = await call("hexvero_strings", { targetId, text: "libc" });
    expect((strings.body["items"] as unknown[]).length).toBe(1);
    const bytes = await call("hexvero_bytes", {
      targetId,
      offset: 0,
      length: 4,
    });
    expect(bytes.body["hex"]).toBe("7f454c46");
  });

  it("returns structured errors instead of throwing", async () => {
    const missing = await call("hexvero_analyze", {
      targetId: "t_missing000000",
    });
    expect(missing.ok).toBe(false);
    expect(missing.body["error"]).toMatchObject({ code: "not_found" });
    const badCollection = await call("hexvero_collection", {
      targetId,
      collection: "nothing",
    });
    expect(badCollection.ok).toBe(false);
    expect(
      (badCollection.body["error"] as { message: string }).message,
    ).toContain("available");
  });

  it("compares collections and exports to a file", async () => {
    const other = join(dir, "other.so");
    writeFileSync(other, buildElf({ nx: false }));
    const b = await call("hexvero_open", { path: other });
    const diff = await call("hexvero_compare", {
      targetA: targetId,
      targetB: b.body["id"],
      collection: "findings",
      key: "kind",
    });
    expect(diff.ok).toBe(true);
    expect(diff.body["unchanged"]).toBe(1);
    const out = join(dir, "export.json");
    const exported = await call("hexvero_export", { targetId, path: out });
    expect(exported.ok).toBe(true);
    expect(exported.body["bytes"]).toBeGreaterThan(100);
    const providers = await call("hexvero_providers");
    expect(
      (providers.body["providers"] as Array<{ name: string }>).map(
        (p) => p.name,
      ),
    ).toEqual(["radare2", "rizin", "ghidra"]);
  });
});
