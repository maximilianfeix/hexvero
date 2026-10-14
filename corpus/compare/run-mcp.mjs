#!/usr/bin/env node
/**
 * The five questions through each tool's MCP server over stdio, with a real MCP client
 * (@modelcontextprotocol/sdk), measured.
 *
 *   HEXVERO_DIR=… REA_PKG_DIR=… MCP_SDK_DIR=… COMPARE_SCRATCH=… node corpus/compare/run-mcp.mjs
 *        [--reps 5] [--sets …] [--questions …] [--tools hexvero,rea] [--engines radare2,rizin]
 *        [--variants summary,complete,export,default,radare2,rizin] [--out results/mcp.runs.jsonl]
 *        [--answers-only]
 *
 * A run is one session: start the server, initialize, make the calls of one question on one unit,
 * close. tools/list is not part of a run; its size is the fixed cost measured by mcp-catalog.mjs.
 * Per call the bytes of the JSON-RPC `result` are recorded as the client receives them, and apart
 * from that the bytes of its text content and of its structuredContent: REA sends the same payload
 * in both, hexvero sends text only.
 * Cold: the tools' caches are deleted before the session. Warm: the session is repeated at once.
 * What a server keeps in memory dies with the session, so warm differs from cold only by what is on
 * disk (hexvero's cache directory; REA keeps nothing on disk for these calls).
 *
 * hexvero   hexvero_open, hexvero_analyze, hexvero_collection per list; hexvero_compare per list;
 *           hexvero_call_graph with a goal per path question.
 * REA       summary   analyze_javascript_application { detail: "summary" }: the documented first call;
 *                     it returns the summary view (counts) and keeps the Evidence in the session.
 *           complete  analyze_javascript_application: the default, the complete Evidence inline.
 *           export    detail summary, then export_evidence_bundle to a file: what REA's documentation
 *                     says to do when the complete Evidence does not fit the transport.
 *           Q4        both versions with detail summary, then compare_application_versions on the
 *                     two retained Evidence ids.
 *           Q5        open_binary and trace_call_path once per binary, to record REA's answer.
 */
import { appendFileSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  arg,
  builtDir,
  dropCaches,
  ensureDir,
  hexveroCli,
  loadAvg,
  node,
  reaCli,
  resultsDir,
  scratch,
  sha256,
  toolEnv,
  watchTree,
} from "./lib/common.mjs";
import { collectionToNeutral, compareToNeutral, pathToNeutral } from "./lib/hexvero-map.mjs";
import { QUESTIONS, emptyElectron, loadPlan } from "./lib/plan.mjs";
import { compareFromRea, electronFromRea } from "./lib/rea-map.mjs";

if (!process.env.MCP_SDK_DIR) {
  console.error("MCP_SDK_DIR is not set; see corpus/compare/README.md");
  process.exit(2);
}
const require = createRequire(join(resolve(process.env.MCP_SDK_DIR), "package.json"));
const load = (spec) => import(pathToFileURL(require.resolve(spec)).href);
const { Client } = await load("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = await load("@modelcontextprotocol/sdk/client/stdio.js");

const reps = Number(arg("reps", "5"));
const sets = arg("sets", "dev,validation,holdout").split(",");
const questions = arg("questions", "Q1,Q2,Q3,Q4,Q5").split(",");
const tools = arg("tools", "hexvero,rea").split(",");
const engines = arg("engines", "radare2,rizin").split(",");
const out = resolve(arg("out", join(resultsDir, "mcp.runs.jsonl")));
const answersDir = ensureDir(resolve(arg("answers", join(resultsDir, "answers"))));
const note = arg("note", null);
// --answers-only: make every call once and rewrite the answer files; nothing is appended to the runs.
const answersOnly = process.argv.includes("--answers-only");
const variants = arg("variants", "default,radare2,rizin,summary,complete,export").split(",");
const env = toolEnv();
const work = ensureDir(join(scratch(), "work", "mcp"));
const plan = await loadPlan(sets);
const shown = (v) => JSON.stringify(v).replaceAll(builtDir, "$BUILT").replaceAll(work, "$WORK");
const bytes = (v) => Buffer.byteLength(typeof v === "string" ? v : JSON.stringify(v ?? null), "utf8");
const serverArgs = { hexvero: () => [hexveroCli(), "mcp"], rea: () => [reaCli(), "--mcp"] };

/** One session. `script(callTool)` makes the calls and returns the neutral answer. */
async function session(tool, script) {
  const t0 = performance.now();
  const transport = new StdioClientTransport({ command: node, args: serverArgs[tool](), env, stderr: "ignore" });
  const client = new Client({ name: "hexvero-corpus-compare", version: "1.0.0" });
  await client.connect(transport);
  const connectMs = Math.round(performance.now() - t0);
  const stop = watchTree(transport.pid);
  const calls = [];
  const callTool = async (name, args) => {
    const t = performance.now();
    let result = null;
    let thrown = null;
    try {
      result = await client.callTool({ name, arguments: args }, undefined, { timeout: 600_000, maxTotalTimeout: 600_000 });
    } catch (error) {
      thrown = String(error?.message ?? error).slice(0, 400);
    }
    const text = (result?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("");
    let payload = result?.structuredContent;
    if (payload === undefined)
      try {
        payload = JSON.parse(text);
      } catch {
        payload = null;
      }
    const isError = thrown !== null || result?.isError === true;
    // REA's error text is JSON: its code and what it names say why a call failed.
    let errorDetail = null;
    if (isError)
      try {
        const e = JSON.parse(text).error;
        errorDetail = { code: e.code, operation: e.details?.operation ?? null, resource: e.details?.resource ?? null, providers: e.details?.candidate_ids ?? null };
      } catch {
        /* not JSON */
      }
    calls.push({
      tool: name,
      arguments: shown(args),
      ms: Math.round(performance.now() - t),
      resultBytes: result ? bytes(result) : 0,
      textBytes: bytes(text),
      structuredBytes: result?.structuredContent === undefined ? 0 : bytes(result.structuredContent),
      isError,
      error: isError ? (thrown ?? text.slice(0, 300)) : null,
      ...(errorDetail ? { errorDetail } : {}),
    });
    return isError ? null : payload;
  };
  /** Bytes the last call wrote to a file instead of returning them. */
  callTool.sideFile = (size) => {
    calls.at(-1).sideFileBytes = size;
  };
  let answer = null;
  let failure = null;
  try {
    answer = await script(callTool);
  } catch (error) {
    failure = String(error?.stack ?? error).slice(0, 400);
  }
  const tree = stop();
  await client.close();
  return { calls, answer, failure, connectMs, sessionMs: Math.round(performance.now() - t0), ...tree };
}

// ---- hexvero -------------------------------------------------------------------------------
const hexveroElectron = (unit, q) => async (call) => {
  const target = await call("hexvero_open", { path: join(builtDir, unit.input) });
  const analysis = await call("hexvero_analyze", { targetId: target.id });
  const answer = { complete: analysis?.complete ?? null };
  for (const name of QUESTIONS[q].collections) {
    const items = [];
    let offset = 0;
    for (;;) {
      const page = await call("hexvero_collection", { targetId: target.id, collection: name, ...(offset ? { offset } : {}) });
      if (!page?.items) break;
      items.push(...page.items);
      if (page.next === null || page.next === undefined) break;
      offset = page.next;
    }
    Object.assign(answer, collectionToNeutral(name, items));
  }
  return { key: unit.input, electron: answer };
};
const hexveroCompare = (unit) => async (call) => {
  const a = await call("hexvero_open", { path: join(builtDir, unit.a) });
  const b = await call("hexvero_open", { path: join(builtDir, unit.b) });
  const compare = {};
  for (const name of unit.collections) {
    const diff = await call("hexvero_compare", { targetA: a.id, targetB: b.id, collection: name });
    if (diff?.added) compare[name] = compareToNeutral(name, diff);
  }
  return { key: `compare:${unit.a}|${unit.b}`, compare };
};
const hexveroPaths = (unit, engine) => async (call) => {
  const target = await call("hexvero_open", { path: join(builtDir, unit.input) });
  const paths = [];
  for (const question of unit.paths)
    paths.push(pathToNeutral(question, await call("hexvero_call_graph", { targetId: target.id, provider: engine, root: question.from, goal: question.to })));
  return { key: `native:${unit.input}:${engine}`, native: { status: "RUN", engine, imports: [], functions: [], callers: [], paths } };
};

// ---- REA -----------------------------------------------------------------------------------
const reaElectron = (unit, variant) => async (call) => {
  const args = { input_path: join(builtDir, unit.input) };
  if (variant === "summary") {
    const view = await call("analyze_javascript_application", { ...args, detail: "summary" });
    const summary = view?.normalized_result?.summary;
    return {
      key: unit.input,
      electron: {
        ...emptyElectron(),
        answerKind: "counts only",
        counts: summary?.electron ?? null,
        complete: summary ? summary.coverage?.application?.status === "complete" : null,
      },
    };
  }
  if (variant === "export") {
    // The documented way out when the complete Evidence does not fit the transport: keep it in the
    // session (detail summary) and write the session's bundle to a file. The caller receives the
    // two small results; the facts are in the file, which is read here as a caller would read it.
    await call("analyze_javascript_application", { ...args, detail: "summary" });
    const file = join(work, `${unit.input.replaceAll("/", "__")}.bundle.json`);
    const written = await call("export_evidence_bundle", { path: file, overwrite: true });
    if (!written) return { key: unit.input, electron: emptyElectron() };
    call.sideFile(statSync(file).size);
    const record = JSON.parse(readFileSync(file, "utf8")).records.find((r) => r.operation === "analyze_javascript_application");
    return { key: unit.input, electron: record?.normalized_result?.graph ? electronFromRea(record) : emptyElectron() };
  }
  const evidence = await call("analyze_javascript_application", args);
  return { key: unit.input, electron: evidence?.normalized_result?.graph ? electronFromRea(evidence) : emptyElectron() };
};
const reaCompare = (unit) => async (call) => {
  const ids = [];
  for (const input of [unit.a, unit.b]) {
    const view = await call("analyze_javascript_application", { input_path: join(builtDir, input), detail: "summary" });
    ids.push(view?.normalized_result?.parent_evidence_id);
  }
  let compare = {};
  if (ids.every(Boolean)) {
    const [left, right] = ids.map((evidence_id) => ({ kind: "retained-evidence", evidence_id }));
    const result = await call("compare_application_versions", { left, right });
    if (result?.normalized_result?.items) compare = compareFromRea(result, unit.collections);
  }
  return { key: `compare:${unit.a}|${unit.b}`, compare };
};

// ---- the schedule ----------------------------------------------------------------------------
const jobs = [];
const job = (tool, variant, qs, unit, label, script) => jobs.push({ tool, variant, questions: qs, unit: label, set: unit.set, script });
const electronQs = questions.filter((q) => QUESTIONS[q].collections);
for (const unit of plan.electron) {
  if (tools.includes("hexvero")) for (const q of electronQs) job("hexvero", "default", [q], unit, unit.input, hexveroElectron(unit, q));
  if (tools.includes("rea") && electronQs.length)
    for (const variant of ["summary", "complete", "export"]) job("rea", variant, electronQs, unit, unit.input, reaElectron(unit, variant));
}
const blocked = [];
const errorCode = (call) =>
  call.errorDetail
    ? `${call.errorDetail.code}${call.errorDetail.providers ? `: providers ${call.errorDetail.providers.join(", ")} are not installed` : ""}${call.errorDetail.operation ? ` (operation ${call.errorDetail.operation})` : ""}`
    : String(call.error).slice(0, 300);
if (questions.includes("Q4"))
  for (const unit of plan.pairs) {
    const label = `${unit.a} → ${unit.b}`;
    if (tools.includes("hexvero")) job("hexvero", "default", ["Q4"], unit, label, hexveroCompare(unit));
    if (tools.includes("rea")) {
      if (unit.electron) job("rea", "summary", ["Q4"], unit, label, reaCompare(unit));
      else blocked.push({ tool: "rea", question: "Q4", unit: label, status: "NOT RUN", reason: "REA 6.4.0 has no tool that compares the import or symbol tables of two Mach-O files" });
    }
  }
if (questions.includes("Q5"))
  for (const unit of plan.native) {
    if (tools.includes("hexvero")) for (const engine of engines) job("hexvero", engine, ["Q5"], unit, `${unit.input} (${engine})`, hexveroPaths(unit, engine));
    if (tools.includes("rea")) {
      const q = unit.paths[0] ?? { from: "main", to: "main" };
      const s = await session("rea", async (call) => {
        await call("open_binary", { path: join(builtDir, unit.input) });
        return call("trace_call_path", { start: q.from, goal: q.to, direction: "forward" });
      });
      const last = s.calls.at(-1);
      blocked.push({
        tool: "rea",
        question: "Q5",
        unit: unit.input,
        status: last.isError ? "NOT RUN" : "AVAILABLE BUT NOT DRIVEN",
        reason: last.isError ? errorCode(last) : "a deep provider answered; this script does not drive it",
        attempt: s.calls,
      });
    }
  }

const answers = new Map();
const answerHashes = new Map();
const record = async (j, phase, rep) => {
  const load = await loadAvg();
  const s = await session(j.tool, j.script);
  const answer = s.answer ?? { key: null };
  const hash = sha256(JSON.stringify(answer));
  const id = `${j.tool}.${j.variant}\u0000${j.questions.join("+")}\u0000${j.unit}`;
  const stable = !answerHashes.has(id) || answerHashes.get(id) === hash;
  answerHashes.set(id, answerHashes.get(id) ?? hash);
  if (answer.key) {
    const file = `${j.tool}.${j.variant === "radare2" || j.variant === "rizin" ? "default" : j.variant}`;
    const store = answers.get(file) ?? {};
    const merged = store[answer.key] ?? {};
    for (const [kind, value] of Object.entries(answer))
      if (kind !== "key") merged[kind] = kind === "electron" ? { ...emptyElectron(), ...merged.electron, ...value } : { ...merged[kind], ...value };
    store[answer.key] = merged;
    answers.set(file, store);
  }
  const line = {
    at: new Date().toISOString(),
    via: "mcp",
    tool: j.tool,
    variant: j.variant,
    questions: j.questions,
    set: j.set,
    unit: j.unit,
    phase,
    rep,
    calls: s.calls,
    callCount: s.calls.length,
    bytesToCaller: s.calls.reduce((n, c) => n + c.resultBytes, 0),
    textBytes: s.calls.reduce((n, c) => n + c.textBytes, 0),
    structuredBytes: s.calls.reduce((n, c) => n + c.structuredBytes, 0),
    bytesToFiles: s.calls.reduce((n, c) => n + (c.sideFileBytes ?? 0), 0),
    connectMs: s.connectMs,
    callsMs: s.calls.reduce((n, c) => n + c.ms, 0),
    wallMs: s.sessionMs,
    treePeakRssBytes: s.treePeakRssBytes,
    maxProcessesInTree: s.maxProcessesInTree,
    ok: !s.failure && s.calls.every((c) => !c.isError),
    errors: [...(s.failure ? [s.failure] : []), ...s.calls.filter((c) => c.isError).map((c) => `${c.tool}: ${c.errorDetail ? JSON.stringify(c.errorDetail) : c.error}`)],
    answerSha256: hash,
    answerStable: stable,
    load1: load?.[0] ?? null,
    ...(note ? { note } : {}),
  };
  if (!answersOnly) appendFileSync(out, `${JSON.stringify(line)}\n`);
  return line;
};

const wanted = jobs.filter((j) => variants.includes(j.variant));
const units = [...new Set(wanted.map((j) => j.unit))];
let done = 0;
for (const unit of units) {
  const here = wanted.filter((j) => j.unit === unit);
  for (let rep = 1; rep <= (answersOnly ? 1 : reps); rep++)
    for (const j of here) {
      dropCaches();
      const cold = await record(j, "cold", rep);
      const warm = answersOnly ? cold : await record(j, "warm", rep);
      done += 2;
      if (rep === 1)
        console.log(
          `${j.tool}/${j.variant} ${j.questions.join("+")} ${unit}: ${cold.callCount} calls, ${cold.bytesToCaller} B (text ${cold.textBytes}), cold ${cold.wallMs} ms, warm ${warm.wallMs} ms${cold.ok ? "" : ` FAILED ${cold.errors[0]}`}`,
        );
    }
}
for (const [file, observations] of answers)
  writeFileSync(join(answersDir, `mcp.${file}.json`), `${JSON.stringify({ tool: { name: `${file} via mcp` }, observations }, null, 1)}\n`);
if (blocked.length) writeFileSync(join(answersDir, "mcp.blocked.json"), `${JSON.stringify(blocked, null, 1)}\n`);
console.log(answersOnly ? `answers rewritten in ${answersDir}; no run recorded` : `${done} runs appended to ${out}; ${blocked.length} blocked items`);
