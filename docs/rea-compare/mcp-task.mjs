// Drives one MCP server through a fixed list of tool calls and records, per call, the latency and the exact
// UTF-8 bytes of the JSON result the client receives (whole result, text content only, structuredContent only).
// usage: node mcp-task.mjs <label> <plan.json> [KEY=VALUE ...] -- <command> [args...]
// plan.json: [{ "tool": "...", "args": {...} }, ...]; a string value "$N.a.b.c" is replaced by that path in call N's
// structuredContent (or parsed first text block). Appends one JSON line to results/mcp-tasks.jsonl.
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import fs from "node:fs";
const require = createRequire(new URL("../install/package.json", import.meta.url));
const load = async (s) => import(pathToFileURL(require.resolve(s)).href);
const { Client } = await load("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = await load("@modelcontextprotocol/sdk/client/stdio.js");
const argv = process.argv.slice(2);
const label = argv.shift();
const plan = JSON.parse(fs.readFileSync(argv.shift(), "utf8"));
const sep = argv.indexOf("--");
const env = {
  ...process.env,
  ...Object.fromEntries(argv.slice(0, sep).map((p) => p.split(/=(.*)/s).slice(0, 2))),
};
const [command, ...args] = argv.slice(sep + 1);
const bytes = (v) =>
  Buffer.byteLength(typeof v === "string" ? v : JSON.stringify(v ?? null), "utf8");
const t0 = performance.now();
const client = new Client({ name: "rea-bench", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command, args, env, stderr: "ignore" }));
const connectMs = Math.round(performance.now() - t0);
const payloads = [];
const resolve = (v) => {
  if (typeof v === "string" && /^\$\d+\./.test(v)) {
    const [n, ...path] = v.slice(1).split(".");
    return path.reduce((o, k) => o?.[k], payloads[Number(n)]);
  }
  if (Array.isArray(v)) return v.map(resolve);
  if (v && typeof v === "object")
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolve(x)]));
  return v;
};
const calls = [];
for (const step of plan) {
  const t = performance.now();
  let r,
    error = null;
  try {
    r = await client.callTool({ name: step.tool, arguments: resolve(step.args ?? {}) }, undefined, {
      timeout: 600000,
      maxTotalTimeout: 600000,
    });
  } catch (e) {
    error = String(e.message ?? e).slice(0, 400);
  }
  const text = (r?.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("");
  let payload = r?.structuredContent;
  if (payload === undefined) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }
  payloads.push(payload);
  if (process.env.DUMP_DIR)
    fs.writeFileSync(
      `${process.env.DUMP_DIR}/${label}-${calls.length}-${step.tool}.json`,
      JSON.stringify(r ?? { error }),
    );
  calls.push({
    tool: step.tool,
    ms: Math.round(performance.now() - t),
    isError: r?.isError === true || error !== null,
    error: error ?? (r?.isError ? text.slice(0, 300) : null),
    resultBytes: r ? bytes(r) : 0,
    textBytes: bytes(text),
    structuredBytes: r?.structuredContent === undefined ? 0 : bytes(r.structuredContent),
  });
}
await client.close();
const rec = {
  label,
  command: [command, ...args].join(" "),
  connectMs,
  totalMs: Math.round(performance.now() - t0),
  calls,
  totalResultBytes: calls.reduce((n, c) => n + c.resultBytes, 0),
  at: new Date().toISOString(),
};
fs.appendFileSync(
  new URL("../results/mcp-tasks.jsonl", import.meta.url),
  JSON.stringify(rec) + "\n",
);
console.log(JSON.stringify(rec, null, 1));
