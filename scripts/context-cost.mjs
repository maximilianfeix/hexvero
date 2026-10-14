#!/usr/bin/env node
/**
 * What an agent pays in context for typical hexvero investigations, in bytes and in tokens.
 *
 *   npm run build && node scripts/context-cost.mjs [--json out.json]
 *
 * Runs the built MCP server over stdio with a real MCP client, performs fixed investigations on
 * the corpus inputs, and counts every result the client receives: bytes of the JSON-RPC result
 * text, and tokens with the o200k_base encoding of gpt-tokenizer (pinned in package.json). Tokens
 * of another model's tokenizer differ; o200k_base is used because it is published and stable.
 * Engine steps are skipped, and listed as skipped, when no engine is installed.
 */
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { encode } from "gpt-tokenizer/encoding/o200k_base";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const built = join(root, "corpus", "built");
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(root, "packages", "cli", "bin", "hexvero.js"), "mcp"],
  env: { ...process.env, HEXVERO_CACHE_DIR: join(root, "node_modules", ".cache", "context-cost") },
});
const client = new Client({ name: "context-cost", version: "1" });
await client.connect(transport);

const rows = [];
const measure = (scenario, step, text) => {
  rows.push({ scenario, step, bytes: Buffer.byteLength(text), tokens: encode(text).length });
};
const call = async (scenario, name, args) => {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content.map((c) => c.text ?? "").join("");
  measure(scenario, name, text);
  if (result.isError) throw new Error(`${name}: ${text}`);
  return JSON.parse(text);
};

// 1. Fixed cost of a session
measure("session", "tools/list", JSON.stringify(await client.listTools()));
measure("session", "prompts/list", JSON.stringify(await client.listPrompts()));
measure("session", "instructions", client.getInstructions() ?? "");

// 2. Simple analysis: a native binary
const native = (
  await call("native first look", "hexvero_open", {
    path: join(built, "dev", "calls.O2.macho-arm64"),
  })
).id;
await call("native first look", "hexvero_analyze", { targetId: native });
await call("native first look", "hexvero_collection", { targetId: native, collection: "imports" });

// 3. Electron investigation: channels, bridge, settings, endpoints of the hold-out app
const app = (
  await call("Electron investigation", "hexvero_open", {
    path: join(built, "holdout", "time-tracker.minified.asar"),
  })
).id;
await call("Electron investigation", "hexvero_analyze", { targetId: app });
for (const collection of ["ipcChannels", "contextBridge", "webPreferences", "endpoints"])
  await call("Electron investigation", "hexvero_collection", { targetId: app, collection });

// 4. Version comparison of the two hold-out builds
const a = (
  await call("version comparison", "hexvero_open", {
    path: join(built, "holdout", "time-tracker.plain.asar"),
  })
).id;
const b = (
  await call("version comparison", "hexvero_open", {
    path: join(built, "holdout", "time-tracker-v2.plain.asar"),
  })
).id;
await call("version comparison", "hexvero_analyze", { targetId: a });
await call("version comparison", "hexvero_analyze", { targetId: b });
for (const collection of ["ipcChannels", "webPreferences", "endpoints"])
  await call("version comparison", "hexvero_compare", { targetA: a, targetB: b, collection });

// 5. Native call path with an engine
const providers = await call("native call path", "hexvero_providers", {});
const engine = (providers.providers ?? providers).find?.((p) => p.available && p.name !== "ghidra");
if (engine)
  await call("native call path", "hexvero_call_graph", {
    targetId: native,
    provider: engine.name,
    root: "main",
    goal: "system",
  });
else
  rows.push({
    scenario: "native call path",
    step: "hexvero_call_graph",
    skipped: "no engine installed",
  });

// 6. A filtered question: one channel's call sites
await call("filtered question", "hexvero_collection", {
  targetId: app,
  collection: "ipc",
  text: "timer",
});

await client.close();

const totals = new Map();
for (const r of rows) {
  if (r.skipped) continue;
  const t = totals.get(r.scenario) ?? { scenario: r.scenario, calls: 0, bytes: 0, tokens: 0 };
  t.calls += 1;
  t.bytes += r.bytes;
  t.tokens += r.tokens;
  totals.set(r.scenario, t);
}
const line = (cells) => `| ${cells.join(" | ")} |`;
console.log(line(["scenario", "calls or items", "bytes", "o200k_base tokens"]));
console.log(line(["---", "---", "---", "---"]));
for (const t of totals.values()) console.log(line([t.scenario, t.calls, t.bytes, t.tokens]));
for (const r of rows.filter((x) => x.skipped))
  console.log(line([r.scenario, "skipped", r.skipped, ""]));
console.log("\nper step:");
for (const r of rows)
  console.log(`  ${r.scenario} · ${r.step}: ${r.skipped ?? `${r.bytes} B, ${r.tokens} tokens`}`);
const out = process.argv.indexOf("--json");
if (out !== -1)
  writeFileSync(
    process.argv[out + 1],
    `${JSON.stringify({ rows, totals: [...totals.values()] }, null, 1)}\n`,
  );
