#!/usr/bin/env node
/**
 * Release gate 2: pack the four packages, install exactly those tarballs into an empty project
 * and exercise the installed product: CLI, shipped UI and skill, and a real MCP session over
 * stdio. Fails when any @hexvero package would be taken from the registry instead of a tarball.
 *
 * Usage: node scripts/smoke-tarballs.mjs [--out release] [--registry] [--keep]
 *   --out dir     where tarballs and manifest.json are written (default: a temp dir)
 *   --registry    skip packing; install hexvero@<version> from the npm registry instead and, when
 *                 --out holds a manifest.json, require the registry packages to match it
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name) =>
  args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : undefined;
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const run = (cmd, argv, cwd) =>
  execFileSync(cmd, argv, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });
const ESC = String.fromCharCode(27);
const stripAnsi = (text) =>
  text
    .split(ESC)
    .map((part, i) => (i ? part.replace(/^\[[0-9;]*m/, "") : part))
    .join("");
const step = (label) => console.log(`smoke: ${label}`);
/** Failures are thrown so `finally` blocks run and no child process is left behind. */
class SmokeFailure extends Error {}
const fail = (message) => {
  throw new SmokeFailure(message);
};
const children = new Set();
process.on("exit", () => {
  for (const child of children) child.kill("SIGKILL");
});
process.on("uncaughtException", (error) => {
  console.error(
    `smoke: FAILED - ${error instanceof SmokeFailure ? error.message : (error.stack ?? error)}`,
  );
  process.exit(1);
});
process.on("unhandledRejection", (error) => {
  console.error(
    `smoke: FAILED - ${error instanceof SmokeFailure ? error.message : (error?.stack ?? error)}`,
  );
  process.exit(1);
});

const version = JSON.parse(readFileSync(join(root, "packages/cli/package.json"), "utf8")).version;
const workspaces = ["core", "mcp", "server", "cli"];
const out = option("out")
  ? resolve(option("out"))
  : mkdtempSync(join(tmpdir(), "hexvero-tarballs-"));
mkdirSync(out, { recursive: true });
const project = mkdtempSync(join(tmpdir(), "hexvero-smoke-"));

let tarballs = [];
if (flag("registry")) {
  step(`installing hexvero@${version} from the registry`);
  run(npm, ["init", "-y"], project);
  run(
    npm,
    ["install", "--no-audit", "--no-fund", "--ignore-scripts", `hexvero@${version}`],
    project,
  );
  // With --out pointing at a release directory, the installed packages must be the released bytes.
  const manifestPath = join(out, "manifest.json");
  if (existsSync(manifestPath)) {
    const lock = JSON.parse(readFileSync(join(project, "package-lock.json"), "utf8"));
    for (const t of JSON.parse(readFileSync(manifestPath, "utf8")).tarballs) {
      const entry = lock.packages?.[`node_modules/${t.name}`];
      if (entry?.integrity !== t.integrity)
        fail(
          `${t.name} from the registry (${entry?.integrity}) is not the released tarball (${t.integrity})`,
        );
    }
    step("registry packages match the released tarballs");
  }
} else {
  step("packing the four packages");
  for (const w of workspaces) {
    const [info] = JSON.parse(
      run(npm, ["pack", "-w", `./packages/${w}`, "--pack-destination", out, "--json"], root),
    );
    const file = join(out, info.filename);
    tarballs.push({
      name: info.name,
      version: info.version,
      file: info.filename,
      integrity: info.integrity,
      sha256: createHash("sha256").update(readFileSync(file)).digest("hex"),
      files: info.files.length,
    });
  }
  writeFileSync(join(out, "manifest.json"), `${JSON.stringify({ version, tarballs }, null, 2)}\n`);
  step("installing the tarballs into an empty project");
  run(npm, ["init", "-y"], project);
  run(
    npm,
    ["install", "--no-audit", "--no-fund", ...tarballs.map((t) => join(out, t.file))],
    project,
  );
  // Every @hexvero package and hexvero itself must resolve to one of our tarballs.
  const lock = JSON.parse(readFileSync(join(project, "package-lock.json"), "utf8"));
  for (const t of tarballs) {
    const entry = lock.packages?.[`node_modules/${t.name}`];
    if (!entry) fail(`${t.name} was not installed`);
    if (!String(entry.resolved ?? "").startsWith("file:"))
      fail(`${t.name} resolved to ${entry.resolved}, not to the local tarball`);
    if (entry.integrity !== t.integrity)
      fail(`${t.name} integrity differs from the packed tarball`);
  }
}

const installed = join(project, "node_modules", "hexvero");
const bin = join(installed, "bin", "hexvero.js");
const cli = (...argv) => run(process.execPath, [bin, ...argv], project);

step("CLI: --version, --help, doctor");
const reported = cli("--version").trim();
if (reported !== version) fail(`hexvero --version printed ${reported}, expected ${version}`);
if (!cli("--help").includes("Usage: hexvero")) fail("--help did not print usage");
JSON.parse(cli("doctor", "--json"));

step("shipped assets: web UI and agent skill");
for (const asset of ["ui/index.html", "skills/hexvero/SKILL.md"])
  if (!existsSync(join(installed, asset))) fail(`the installed package lacks ${asset}`);
if (!JSON.parse(cli("setup", "--skill", "--json")).results?.length)
  fail("setup --skill found no skill");

step("CLI: analyze, collection, compare, export on generated inputs");
// A minimal ELF64 header is enough for the parser to answer; no fixture file is shipped.
const elf = Buffer.alloc(64);
elf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]);
elf.writeUInt16LE(2, 16);
elf.writeUInt16LE(0x3e, 18);
elf.writeUInt32LE(1, 20);
elf.writeUInt16LE(64, 52);
const sample = join(project, "sample.elf");
writeFileSync(sample, elf);
const analysis = JSON.parse(cli("analyze", sample, "--json"));
if (analysis.target?.info?.format !== "elf")
  fail(`analyze reported format ${analysis.target?.info?.format}`);
const exported = join(project, "export.json");
cli("export", sample, exported);
if (JSON.parse(readFileSync(exported, "utf8")).hexvero !== 1)
  fail("export did not write an analysis");
JSON.parse(cli("collection", sample, "findings", "--json"));
JSON.parse(cli("compare", sample, sample, "findings", "--json"));

step("CLI: a large generated app, with and without worker threads");
// Over the 4 MiB threshold, so the token worker of the installed package really runs.
const workerFile = join(
  project,
  "node_modules",
  "@hexvero",
  "core",
  "dist",
  "javascript",
  "tokenWorker.js",
);
if (!existsSync(workerFile)) fail("the installed @hexvero/core lacks its token worker");
const bigApp = join(project, "big-app");
mkdirSync(bigApp, { recursive: true });
writeFileSync(join(bigApp, "package.json"), JSON.stringify({ name: "big", main: "main.js" }));
for (let f = 0; f < 8; f++) {
  const lines = [`const { ipcMain: m } = require("electron");`];
  for (let i = 0; i < 6000; i++)
    lines.push(
      `function f${f}_${i}(e,t){m.handle("ch:${f}:${i % 50}",(a,b)=>b);return fetch("https://api.example.com/${i % 9}").then(e=>t(e))}`,
    );
  writeFileSync(join(bigApp, f === 0 ? "main.js" : `part${f}.js`), lines.join("\n"));
}
const analyzed = {};
for (const threads of ["0", "2"]) {
  const bigOut = join(project, `big-${threads}.json`);
  execFileSync(process.execPath, [bin, "export", bigApp, bigOut], {
    cwd: project,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HEXVERO_JS_THREADS: threads,
      HEXVERO_CACHE_DIR: join(project, `cache-${threads}`),
    },
  });
  const big = JSON.parse(readFileSync(bigOut, "utf8")).analysis;
  big.durationMs = 0;
  analyzed[threads] = JSON.stringify(big);
}
// The generated sources must stay over the threshold, or this step proves nothing.
const bigBytes = readdirSync(bigApp)
  .filter((n) => n.endsWith(".js"))
  .reduce((sum, n) => sum + statSync(join(bigApp, n)).size, 0);
if (bigBytes < 4 * 1024 * 1024) fail(`the generated app has only ${bigBytes} bytes of source`);
if (analyzed["0"] !== analyzed["2"]) fail("the analysis differs with worker threads");
if (!analyzed["2"].includes("ch:7:49")) fail("the large app's IPC channels are missing");

step("MCP over stdio: initialize, tools/list, open, analyze, collection, export");
// Resolve the SDK the way the installed package does, through its export map.
const sdk = (subpath) =>
  import(
    pathToFileURL(
      createRequire(join(project, "node_modules", "@hexvero", "mcp", "package.json")).resolve(
        `@modelcontextprotocol/sdk/${subpath}`,
      ),
    ).href
  );
const { Client } = await sdk("client/index.js");
const { StdioClientTransport } = await sdk("client/stdio.js");
const client = new Client({ name: "smoke", version: "0" });
await client.connect(
  new StdioClientTransport({ command: process.execPath, args: [bin, "mcp"], cwd: project }),
);
const server = client.getServerVersion();
if (server?.version !== version) fail(`MCP server reports version ${server?.version}`);
const { tools } = await client.listTools();
if (tools.length < 10 || !tools.some((t) => t.name === "hexvero_analyze"))
  fail("tools/list is incomplete");
const call = async (name, argv) => {
  const r = await client.callTool({ name, arguments: argv });
  if (r.isError) fail(`${name} returned an error: ${r.content?.[0]?.text}`);
  return JSON.parse(r.content[0].text);
};
const opened = await call("hexvero_open", { path: sample });
const mcpAnalysis = await call("hexvero_analyze", { targetId: opened.id });
if (typeof mcpAnalysis.summary !== "string") fail("hexvero_analyze returned no summary");
const page = await call("hexvero_collection", {
  targetId: opened.id,
  collection: "findings",
  maxBytes: 1024,
});
if (page.bytes > 1024) fail("hexvero_collection exceeded its byte budget");
await call("hexvero_export", { targetId: opened.id, path: join(project, "mcp-export.json") });
await client.close();

step("UI server: static page and token-gated API");
const ui = spawn(process.execPath, [bin, "ui", "--port", "0", "--no-color"], {
  cwd: project,
  stdio: ["ignore", "pipe", "pipe"],
});
children.add(ui);
const url = await new Promise((resolveUrl, reject) => {
  let text = "";
  const timer = setTimeout(() => reject(new Error(`ui did not start: ${text}`)), 15000);
  ui.stdout.on("data", (chunk) => {
    text += chunk;
    const m = /(http:\/\/[^\s]+)#token=(\S+)/.exec(stripAnsi(text));
    if (m) {
      clearTimeout(timer);
      resolveUrl({ base: m[1].replace(/\/$/, ""), token: m[2] });
    }
  });
  ui.once("exit", (code) => reject(new SmokeFailure(`ui exited with ${code}: ${text}`)));
}).catch((e) => {
  ui.kill("SIGKILL");
  fail(e.message);
});
try {
  const html = await fetch(`${url.base}/`);
  if (html.status !== 200 || !(await html.text()).includes('<div id="root"'))
    fail("UI index page is not served");
  if ((await fetch(`${url.base}/api/health`)).status !== 401) fail("API answered without a token");
  const health = await fetch(`${url.base}/api/health`, {
    headers: { authorization: `Bearer ${url.token}` },
  });
  if ((await health.json()).version !== version) fail("API health reports another version");
} finally {
  ui.kill("SIGINT");
}

if (!flag("keep")) rmSync(project, { recursive: true, force: true });
console.log(
  `smoke: OK - hexvero ${version} ${flag("registry") ? "from the registry" : `from ${tarballs.length} local tarballs in ${out}`}`,
);
process.exit(0);
