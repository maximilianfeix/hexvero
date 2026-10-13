// Measures an MCP server's catalog over stdio: tool count and exact UTF-8 bytes of the
// JSON `result` object of tools/list, prompts/list and resources/list.
// usage: node mcp-catalog.mjs <label> [KEY=VALUE ...] -- <command> [args...]
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const require = createRequire(new URL("../install/package.json", import.meta.url));
const load = async (s) => import(pathToFileURL(require.resolve(s)).href);
const { Client } = await load("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = await load("@modelcontextprotocol/sdk/client/stdio.js");
const argv = process.argv.slice(2);
const label = argv.shift();
const sep = argv.indexOf("--");
const envPairs = argv.slice(0, sep).map((p) => p.split(/=(.*)/s).slice(0, 2));
const [command, ...args] = argv.slice(sep + 1);
const env = { ...process.env, ...Object.fromEntries(envPairs) };
const bytes = (v) => Buffer.byteLength(JSON.stringify(v), "utf8");
const t0 = performance.now();
const transport = new StdioClientTransport({ command, args, env, stderr: "ignore" });
const client = new Client({ name: "rea-bench", version: "1.0.0" });
await client.connect(transport);
const tInit = performance.now();
const pageAll = async (fn, key) => {
  const pages = [];
  let cursor;
  let items = [];
  do {
    const r = await fn(cursor ? { cursor } : {});
    pages.push(r);
    items = items.concat(r[key] ?? []);
    cursor = r.nextCursor;
  } while (cursor);
  return { pages, items };
};
const out = {
  label,
  command: [command, ...args].join(" "),
  env: Object.fromEntries(envPairs),
  server: client.getServerVersion(),
  capabilities: Object.keys(client.getServerCapabilities() ?? {}),
  instructionsBytes: Buffer.byteLength(client.getInstructions() ?? "", "utf8"),
  initMs: Math.round(tInit - t0),
};
const t1 = performance.now();
const tools = await pageAll((p) => client.listTools(p), "tools");
out.toolsListMs = Math.round(performance.now() - t1);
out.tools = {
  count: tools.items.length,
  pages: tools.pages.length,
  resultBytes: tools.pages.reduce((n, p) => n + bytes(p), 0),
  inputSchemaBytes: tools.items.reduce((n, t) => n + bytes(t.inputSchema ?? null), 0),
  outputSchemaBytes: tools.items.reduce(
    (n, t) => n + (t.outputSchema ? bytes(t.outputSchema) : 0),
    0,
  ),
  descriptionBytes: tools.items.reduce(
    (n, t) => n + Buffer.byteLength(t.description ?? "", "utf8"),
    0,
  ),
  largest: tools.items
    .map((t) => [t.name, bytes(t)])
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5),
};
for (const [name, fn, key] of [
  ["prompts", (p) => client.listPrompts(p), "prompts"],
  ["resources", (p) => client.listResources(p), "resources"],
]) {
  try {
    const r = await pageAll(fn, key);
    out[name] = { count: r.items.length, resultBytes: r.pages.reduce((n, p) => n + bytes(p), 0) };
  } catch (e) {
    out[name] = { error: String(e.message ?? e) };
  }
}
if (process.env.DUMP) {
  const fs = await import("node:fs");
  fs.writeFileSync(
    process.env.DUMP,
    JSON.stringify(tools.pages.length === 1 ? tools.pages[0] : tools.pages),
  );
}
await client.close();
console.log(JSON.stringify(out, null, 1));
