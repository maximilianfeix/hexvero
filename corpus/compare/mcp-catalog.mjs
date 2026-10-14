#!/usr/bin/env node
/**
 * The fixed cost an MCP client pays before the first call: the size of each server's answer to
 * initialize and to tools/list, in bytes of the JSON `result` as received.
 *
 *   HEXVERO_DIR=… REA_PKG_DIR=… MCP_SDK_DIR=… COMPARE_SCRATCH=… node corpus/compare/mcp-catalog.mjs
 *        [--reps 5] [--out results/mcp-catalog.json]
 *
 * REA is measured twice: as it starts by default, and with REA_MCP_INPUT_SCHEMA_PROFILE=compact,
 * the smaller advertisement its documentation offers for clients with a schema size limit
 * (docs/mcp-contracts.md).
 */
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { arg, hexveroCli, loadAvg, node, reaCli, resultsDir, stats, toolEnv, watchTree } from "./lib/common.mjs";

const require = createRequire(join(resolve(process.env.MCP_SDK_DIR ?? "."), "package.json"));
const load = (spec) => import(pathToFileURL(require.resolve(spec)).href);
const { Client } = await load("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = await load("@modelcontextprotocol/sdk/client/stdio.js");
const reps = Number(arg("reps", "5"));
const out = resolve(arg("out", join(resultsDir, "mcp-catalog.json")));
const bytes = (v) => Buffer.byteLength(JSON.stringify(v), "utf8");

async function once(args, extraEnv) {
  const t0 = performance.now();
  const transport = new StdioClientTransport({ command: node, args, env: { ...toolEnv(), ...extraEnv }, stderr: "ignore" });
  const client = new Client({ name: "hexvero-corpus-compare", version: "1.0.0" });
  await client.connect(transport);
  const connectMs = performance.now() - t0;
  const stop = watchTree(transport.pid);
  const t1 = performance.now();
  const pages = [];
  let cursor;
  do {
    const page = await client.listTools(cursor ? { cursor } : {});
    pages.push(page);
    cursor = page.nextCursor;
  } while (cursor);
  const listMs = performance.now() - t1;
  const tools = pages.flatMap((p) => p.tools);
  const optional = async (fn) => {
    try {
      const r = await fn();
      return { count: Object.values(r).find(Array.isArray)?.length ?? 0, resultBytes: bytes(r) };
    } catch (error) {
      return { unsupported: String(error?.message ?? error).slice(0, 120) };
    }
  };
  const result = {
    server: client.getServerVersion(),
    instructionsBytes: Buffer.byteLength(client.getInstructions() ?? "", "utf8"),
    connectMs: Math.round(connectMs),
    toolsListMs: Math.round(listMs),
    tools: tools.length,
    pages: pages.length,
    toolsListResultBytes: pages.reduce((n, p) => n + bytes(p), 0),
    inputSchemaBytes: tools.reduce((n, t) => n + bytes(t.inputSchema ?? null), 0),
    outputSchemaBytes: tools.reduce((n, t) => n + (t.outputSchema ? bytes(t.outputSchema) : 0), 0),
    descriptionBytes: tools.reduce((n, t) => n + Buffer.byteLength(t.description ?? "", "utf8"), 0),
    largestTools: tools.map((t) => [t.name, bytes(t)]).toSorted((a, b) => b[1] - a[1]).slice(0, 5),
    prompts: await optional(() => client.listPrompts()),
    resources: await optional(() => client.listResources()),
  };
  Object.assign(result, stop());
  await client.close();
  return result;
}

const servers = [
  { label: "hexvero", args: [hexveroCli(), "mcp"], env: {} },
  { label: "rea (default)", args: [reaCli(), "--mcp"], env: {} },
  { label: "rea (REA_MCP_INPUT_SCHEMA_PROFILE=compact)", args: [reaCli(), "--mcp"], env: { REA_MCP_INPUT_SCHEMA_PROFILE: "compact" } },
];
const report = { at: new Date().toISOString(), loadBefore: await loadAvg(), reps, servers: [] };
for (const s of servers) {
  const runs = [];
  for (let i = 0; i < reps; i++) runs.push(await once(s.args, s.env));
  const sizes = new Set(runs.map((r) => r.toolsListResultBytes));
  report.servers.push({
    label: s.label,
    env: s.env,
    ...runs[0],
    sizeStableOverRuns: sizes.size === 1,
    connectMs: stats(runs.map((r) => r.connectMs)),
    toolsListMs: stats(runs.map((r) => r.toolsListMs)),
    treePeakRssBytes: Math.max(...runs.map((r) => r.treePeakRssBytes)),
  });
  console.log(`${s.label}: ${runs[0].tools} tools, tools/list ${runs[0].toolsListResultBytes} B, connect median ${report.servers.at(-1).connectMs.median} ms`);
}
report.loadAfter = await loadAvg();
writeFileSync(out, `${JSON.stringify(report, null, 1)}\n`);
