#!/usr/bin/env node
/**
 * Runs hexvero on every corpus input and writes what it reports in the corpus's neutral
 * observation format. It knows nothing about the expected results.
 *
 *   npm run build && node corpus/observe-hexvero.mjs [--out file.json] [--engines radare2,rizin]
 *
 * A scratch cache directory is used, so stored scans and cached graphs of earlier runs cannot
 * leak into the observations.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { builtRoot, corpusRoot, loadCases } from "./cases.mjs";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
const cache = mkdtempSync(join(tmpdir(), "hexvero-corpus-cache-"));
process.env.HEXVERO_CACHE_DIR = cache;
const core = await import("../packages/core/dist/index.js");
const out = resolve(arg("out", join(corpusRoot, "results", "hexvero.observations.json")));
const engines = arg("engines", "radare2,rizin").split(",").filter(Boolean);
const available = new Map((await core.detectProviders()).map((p) => [p.name, p]));

const all = async (session, id, name) => {
  const names = await session.collections(id);
  if (!(name in names)) return [];
  return (await session.collection(id, name, { limit: 5000, maxBytes: 32 << 20 })).items;
};

async function electron(path) {
  const session = new core.Session();
  const target = await session.open(path);
  const analysis = await session.analyze(target.id);
  const endpoints = await all(session, target.id, "endpoints");
  const storage = new Map();
  for (const row of await all(session, target.id, "storage")) {
    if (row.value === null) continue;
    const key = `${row.kind}\u0000${row.value}`;
    const entry = storage.get(key) ?? { kind: row.kind, value: row.value, ops: [] };
    if (row.op && !entry.ops.includes(row.op)) entry.ops.push(row.op);
    storage.set(key, entry);
  }
  return {
    complete: analysis.data.kind === "javascript-app" ? analysis.data.app.coverage.complete : null,
    limitations: analysis.limitations.map((l) => l.code),
    ipcChannels: await all(session, target.id, "ipcChannels"),
    webPreferences: (await all(session, target.id, "webPreferences")).map((w) => ({
      key: w.key,
      value: w.value,
      file: w.file,
    })),
    contextBridge: (await all(session, target.id, "contextBridge")).map((b) => ({
      api: b.api,
      member: b.member,
      channel: b.channel,
    })),
    endpoints: endpoints
      .filter((e) => e.value !== null)
      .map((e) => ({
        value: e.value,
        kind: e.kind,
        method: e.method ?? null,
        confidence: e.confidence,
      })),
    endpointsUnreadable: endpoints.filter((e) => e.value === null).length,
    storage: [...storage.values()],
  };
}

/** The default comparison a user gets, reduced to the item names the expectations use. */
async function compare(a, b, collections) {
  const session = new core.Session();
  const ta = await session.open(a);
  const tb = await session.open(b);
  const result = {};
  const last = (label) => String(label).split("::").at(-1);
  for (const name of collections) {
    const diff = core.compareItems(
      await all(session, ta.id, name),
      await all(session, tb.id, name),
      {
        collection: name,
        positional: core.positionalFields(name, [ta.info.format, tb.info.format]),
      },
    );
    const label = (text) => {
      const parts = String(text).split("::");
      if (name === "contextBridge") return parts.join(".");
      // file::kind::value::op, or kind::value::op, or kind::value
      if (name === "storage") {
        const kinds = [
          "localStorage",
          "sessionStorage",
          "indexedDB",
          "cache",
          "cookie",
          "electron-store",
        ];
        const at = parts.findIndex((part) => kinds.includes(part));
        return at === -1 ? String(text) : `${parts[at]} ${parts[at + 1]}`;
      }
      if (
        name === "endpoints" ||
        name === "ipcChannels" ||
        name === "imports" ||
        name === "symbols"
      )
        return last(text);
      return String(text);
    };
    result[name] = {
      key: diff.key,
      added: diff.added.map(label),
      removed: diff.removed.map(label),
      changed: diff.changed.flatMap((c) =>
        name === "webPreferences"
          ? c.fields.map((f) => `${String(c.key).split("::").at(-1)}: ${f.before} -> ${f.after}`)
          : [label(c.key)],
      ),
      relocated: diff.relocated,
      unchanged: diff.unchanged,
    };
  }
  return result;
}

async function native(path, expect, engine) {
  if (!available.get(engine)?.available)
    return { status: "NOT RUN", reason: `${engine} is not installed` };
  const session = new core.Session();
  const target = await session.open(path);
  const bare = (name) =>
    String(name)
      .replace(/^(sym\.imp\.|sym\.|imp\.|dbg\.|fcn\.)/, "")
      .replace(/^_+/, "");
  const imports = (await all(session, target.id, "imports")).map((i) => bare(i.name));
  const run = await core.loadCallGraph({ targetPath: target.info.path, provider: engine });
  const graph = run.graph;
  const limits = [
    ...new Set([...(run.limitations ?? []), ...graph.limitations].map((l) => l.code)),
  ];
  // An engine may call one function by several names (rizin names main `entry0`). Answers use
  // the name the question used when the function has it among its names.
  const asked = new Set([
    "main",
    ...(expect.functions?.present ?? []),
    ...(expect.callers ?? []).flatMap((q) => [q.of, ...q.expect]),
    ...(expect.paths ?? []).flatMap((q) => [q.from, q.to, ...(q.via ?? [])]),
  ]);
  const nameOf = (id) => {
    const n = graph.nodes.find((x) => x.id === id);
    if (!n) return bare(id);
    const names = [n.name, ...(n.aliases ?? [])].map(bare);
    return names.find((x) => asked.has(x)) ?? names[0];
  };
  const node = (name) => {
    for (const spec of [name, `_${name}`, `sym._${name}`, `sym.imp.${name}`, `sym.${name}`]) {
      const hit = core.resolveNode(graph, spec);
      if (hit.node) return hit.node;
    }
    return null;
  };
  return {
    status: "RUN",
    engine: available.get(engine).version ?? null,
    limitations: limits,
    imports,
    functions: (expect.functions?.present ?? []).filter((f) => node(f) !== null),
    paths: (expect.paths ?? []).map((q) => {
      const from = node(q.from);
      const to = node(q.to);
      if (!from || !to)
        return {
          from: q.from,
          to: q.to,
          found: false,
          hedged: false,
          unresolved: !from ? q.from : q.to,
        };
      const trace = core.tracePath(graph, from, to, "callees");
      return {
        from: q.from,
        to: q.to,
        found: trace.status === "found",
        path: trace.path?.map(nameOf) ?? null,
        // "hedged": the answer comes with a statement that the graph may miss edges.
        hedged: trace.limitations.length > 0,
        limitations: trace.limitations.map((l) => l.code),
      };
    }),
    callers: (expect.callers ?? []).map((q) => {
      const n = node(q.of);
      return {
        of: q.of,
        callers: n ? core.callersOf(graph, n.id).map(nameOf) : null,
      };
    }),
  };
}

/** One damaged input, in a child process with a time limit: a hang or a crash is an outcome too. */
function robust(path, seconds) {
  const script = `
    process.env.HEXVERO_CACHE_DIR = ${JSON.stringify(cache)};
    const core = await import(${JSON.stringify(resolve(corpusRoot, "../packages/core/dist/index.js"))});
    const session = new core.Session();
    try {
      const t = await session.open(${JSON.stringify(path)});
      const a = await session.analyze(t.id);
      const partial = a.data.kind === "javascript-app" && !a.data.app.coverage.complete;
      console.log(JSON.stringify({ outcome: a.limitations.length || partial ? "flagged" : "clean", format: t.info.format, limitations: a.limitations.map((l) => l.code), summary: a.summary }));
    } catch (e) {
      console.log(JSON.stringify(e instanceof core.AnalysisError ? { outcome: "error", code: e.code, message: e.message } : { outcome: "crash", message: String(e && e.stack || e) }));
    }`;
  try {
    const stdout = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      timeout: seconds * 1000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return JSON.parse(stdout.trim().split("\n").at(-1));
  } catch (error) {
    return error.killed || error.signal
      ? { outcome: "timeout", message: `no result within ${seconds} s` }
      : { outcome: "crash", message: String(error.stderr || error.message).slice(0, 400) };
  }
}

const observations = {};
try {
  for (const c of loadCases()) {
    if (c.kind === "electron")
      for (const input of c.inputs)
        observations[input] = { electron: await electron(join(builtRoot, input)) };
    else if (c.kind === "compare")
      observations[`compare:${c.a}|${c.b}`] = {
        compare: await compare(
          join(builtRoot, c.a),
          join(builtRoot, c.b),
          Object.keys(c.expect.compare),
        ),
      };
    else if (c.kind === "native")
      for (const input of c.inputs)
        for (const engine of engines)
          observations[`native:${input}:${engine}`] = {
            native: await native(join(builtRoot, input), c.expect, engine),
          };
    else if (c.kind === "robustness")
      for (const r of c.expect.robustness)
        observations[`robust:${r.input}`] = {
          robust: robust(join(builtRoot, r.input), c.timeLimitSeconds ?? 30),
        };
  }
} finally {
  await core.killEngines?.();
  rmSync(cache, { recursive: true, force: true });
}
const pkg = JSON.parse(readFileSync(resolve(corpusRoot, "../packages/core/package.json"), "utf8"));
let commit = "unknown";
try {
  commit = execFileSync("git", ["-C", corpusRoot, "rev-parse", "--short", "HEAD"], {
    encoding: "utf8",
  }).trim();
  if (
    execFileSync("git", ["-C", corpusRoot, "status", "--porcelain", "--", "../packages"], {
      encoding: "utf8",
    }).trim()
  )
    commit += "+uncommitted";
} catch {
  /* not a checkout */
}
writeFileSync(
  out,
  `${JSON.stringify(
    {
      tool: {
        name: "hexvero",
        version: pkg.version,
        commit,
        node: process.version,
        platform: `${process.platform} ${process.arch}`,
        engines: Object.fromEntries(
          engines.map((e) => [e, available.get(e)?.version ?? "not installed"]),
        ),
      },
      observations,
    },
    null,
    1,
  )}\n`,
);
console.log(`observations: ${Object.keys(observations).length} written to ${out}`);
