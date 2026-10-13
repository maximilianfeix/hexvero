#!/usr/bin/env node
/**
 * Reproducible measurements for docs/benchmarks.md.
 *
 *   npm run build && node scripts/bench.mjs [more files…]
 *
 * For every input it runs the built CLI three times in a fresh process and reports the median
 * wall time, the peak resident memory (from /usr/bin/time) and the size of the JSON result. It
 * also measures the MCP catalog and one real MCP session on the largest input. Inputs that do
 * not exist on this machine are listed as skipped. Nothing is cached between runs: the CLI keeps
 * no analysis cache, so "cold" and "warm" differ only by the operating system's file cache; the
 * first run of each input is reported separately for that reason.
 */
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { cpus, platform, release, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const bin = join(root, "packages", "cli", "bin", "hexvero.js");
const mac = platform() === "darwin";
const inputs = [
  join(root, "examples", "notesdesk-1.4.0.asar"),
  "/bin/ls",
  process.execPath,
  "/Applications/Discord.app/Contents/Resources/app.asar",
  "/Applications/Claude.app/Contents/Resources/app.asar",
  "/Applications/ChatGPT.app/Contents/Resources/app.asar",
  ...process.argv.slice(2).map((p) => resolve(p)),
];

/** One CLI run under /usr/bin/time: wall seconds, peak RSS in MiB, stdout bytes. */
function measure(args) {
  const started = process.hrtime.bigint();
  const run = spawnSync("/usr/bin/time", [mac ? "-l" : "-v", process.execPath, bin, ...args], {
    encoding: "buffer",
    maxBuffer: 1 << 30,
  });
  const seconds = Number(process.hrtime.bigint() - started) / 1e9;
  const err = run.stderr.toString();
  const rss = mac
    ? Number(/(\d+)\s+maximum resident set size/.exec(err)?.[1] ?? 0) / 1048576
    : Number(/Maximum resident set size \(kbytes\): (\d+)/.exec(err)?.[1] ?? 0) / 1024;
  return { seconds, rss, bytes: run.stdout.length, ok: run.status === 0 };
}
const median = (values) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)];
const size = (n) =>
  n >= 1 << 20 ? `${(n / 1048576).toFixed(1)} MiB` : `${(n / 1024).toFixed(1)} KiB`;

const version = spawnSync(process.execPath, [bin, "--version"], { encoding: "utf8" }).stdout.trim();
const commit = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).stdout.trim();
console.log(
  `hexvero ${version} (commit ${commit}) · Node ${process.version} · ${cpus()[0].model} · ${Math.round(totalmem() / 2 ** 30)} GiB RAM · ${platform()} ${release()}\n`,
);
console.log("| Input | Size | First run | Median of 3 | Peak RSS | `analyze --json` output |");
console.log("| --- | --- | --- | --- | --- | --- |");
let largest = null;
for (const input of inputs) {
  if (!existsSync(input)) {
    console.log(`| \`${input}\` | not on this machine | skipped | | | |`);
    continue;
  }
  const bytes = statSync(input).size;
  const runs = [1, 2, 3].map(() => measure(["analyze", input, "--json"]));
  if (!runs[0].ok) {
    console.log(`| \`${input}\` | ${size(bytes)} | failed | | | |`);
    continue;
  }
  if (!largest || bytes > largest.bytes) largest = { input, bytes };
  console.log(
    `| \`${input.replace(root + "/", "")}\` | ${size(bytes)} | ${runs[0].seconds.toFixed(2)} s | ${median(runs.map((r) => r.seconds)).toFixed(2)} s | ${Math.round(median(runs.map((r) => r.rss)))} MiB | ${size(runs[0].bytes)} |`,
  );
}

const client = new Client({ name: "bench", version: "0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [bin, "mcp"] }));
const tools = await client.listTools();
const prompts = await client.listPrompts();
console.log(
  `\nMCP catalog: ${tools.tools.length} tools, tools/list result ${Buffer.byteLength(JSON.stringify(tools))} bytes; ${prompts.prompts.length} prompts, prompts/list result ${Buffer.byteLength(JSON.stringify(prompts))} bytes.`,
);
if (largest) {
  const text = async (name, args) =>
    (await client.callTool({ name, arguments: args })).content[0].text;
  const opened = JSON.parse(await text("hexvero_open", { path: largest.input }));
  let t = performance.now();
  const analysis = await text("hexvero_analyze", { targetId: opened.id });
  const first = (performance.now() - t) / 1000;
  t = performance.now();
  await text("hexvero_analyze", { targetId: opened.id });
  const again = (performance.now() - t) / 1000;
  const collections = Object.keys(JSON.parse(analysis).collections ?? {});
  const page = collections.length
    ? await text("hexvero_collection", { targetId: opened.id, collection: collections.at(-1) })
    : "";
  console.log(
    `MCP session on \`${largest.input}\` (${size(largest.bytes)}): open + analyze answered in ${first.toFixed(1)} s with a ${Buffer.byteLength(analysis)}-byte result (3 tool calls to the first page of data); the same analyze again took ${again.toFixed(2)} s (in-session cache); one default page of \`${collections.at(-1)}\` is ${Buffer.byteLength(page)} bytes.`,
  );
}
await client.close();
