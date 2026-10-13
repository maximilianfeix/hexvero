#!/usr/bin/env node
/**
 * The five questions through each tool's command line, measured.
 *
 *   HEXVERO_DIR=… REA_PKG_DIR=… COMPARE_SCRATCH=… node corpus/compare/run-cli.mjs
 *        [--reps 5] [--sets dev,validation,holdout] [--questions Q1,Q2,Q3,Q4,Q5] [--tools hexvero,rea]
 *        [--engines radare2,rizin] [--out results/cli.runs.jsonl] [--answers-only]
 *
 * A run is the whole sequence of calls one question needs on one unit (an input, a pair, a binary).
 * Per unit and tool: `reps` times [delete the tools' caches, run (cold), run again (warm)]; the tools
 * alternate, so a drift of the machine load hits both. One JSON line per run goes to the output.
 * The answer the calls returned is reduced to the corpus's neutral format and written to
 * results/answers/cli.<tool>.<variant>.json for the scorer.
 *
 * hexvero   analyze, then one `collection` page per list (further pages when a page says `next`);
 *           `compare` per list; `calls <binary> <engine> <from> --goal <to>` per path question.
 * REA       three documented ways to read one analysis, all recorded:
 *   summary    analyze-javascript-application --json > file, then inspect-analysis-view (summary);
 *              what docs/cli.md recommends. The view holds counts, no names.
 *   filtered   analyze-javascript-application --json --filter-output normalized_result.graph.nodes;
 *              the smallest single output that still holds the facts.
 *   complete   analyze-javascript-application --json; the default, the complete Evidence.
 *   Q4: analyze both versions to files, then compare-application-versions with both inline.
 *   Q5: no call without a deep provider; one attempt per binary is recorded, nothing is timed.
 */
import { appendFileSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  arg,
  builtDir,
  dropCaches,
  ensureDir,
  hexveroCli,
  loadAvg,
  measure,
  node,
  reaCli,
  resultsDir,
  scratch,
  sha256,
  toolEnv,
} from "./lib/common.mjs";
import { collectionToNeutral, compareToNeutral, pathToNeutral } from "./lib/hexvero-map.mjs";
import { QUESTIONS, emptyElectron, loadPlan } from "./lib/plan.mjs";
import { compareFromRea, electronFromRea } from "./lib/rea-map.mjs";

const reps = Number(arg("reps", "5"));
const sets = arg("sets", "dev,validation,holdout").split(",");
const questions = arg("questions", "Q1,Q2,Q3,Q4,Q5").split(",");
const tools = arg("tools", "hexvero,rea").split(",");
const engines = arg("engines", "radare2,rizin").split(",");
const out = resolve(arg("out", join(resultsDir, "cli.runs.jsonl")));
const answersDir = ensureDir(resolve(arg("answers", join(resultsDir, "answers"))));
const note = arg("note", null);
// --answers-only: make every call once and rewrite the answer files; nothing is appended to the runs.
const answersOnly = process.argv.includes("--answers-only");
const env = toolEnv();
const work = ensureDir(join(scratch(), "work", "cli"));
const plan = await loadPlan(sets);
const shown = (a) => String(a).replaceAll(builtDir, "$BUILT").replaceAll(work, "$WORK");

/** One call. `toFile` sends stdout to a file, as the tool's documentation does for large results. */
async function call(tool, args, { toFile = null, inputFile = null } = {}) {
  const cli = tool === "hexvero" ? hexveroCli() : reaCli();
  const r = await measure(node, [cli, ...args], { env, stdoutFile: toFile });
  return {
    command: `${tool} ${args.map(shown).join(" ")}${toFile ? ` > ${shown(toFile)}` : ""}`,
    exit: r.exit,
    signal: r.signal,
    timedOut: r.timedOut,
    wallMs: r.wallMs,
    stdoutBytes: r.stdoutBytes,
    stderrBytes: r.stderrBytes,
    stdoutTo: toFile ? "file" : "caller",
    inputFileBytes: inputFile ? statSync(inputFile).size : null,
    maxRssBytes: r.maxRssBytes,
    treePeakRssBytes: r.treePeakRssBytes,
    maxProcessesInTree: r.maxProcessesInTree,
    error: r.exit === 0 ? null : (r.stdout ?? r.stderr ?? "").slice(0, 300),
    text: r.stdout,
  };
}
const json = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

// ---- hexvero -------------------------------------------------------------------------------
async function hexveroElectron(unit, q) {
  const path = join(builtDir, unit.input);
  const calls = [await call("hexvero", ["analyze", path, "--json"])];
  const answer = {};
  const analysis = json(calls[0].text);
  answer.complete = analysis?.complete ?? null;
  for (const name of QUESTIONS[q].collections) {
    const items = [];
    let offset = null;
    do {
      const c = await call("hexvero", ["collection", path, name, ...(offset === null ? [] : ["--offset", String(offset)]), "--json"]);
      calls.push(c);
      const page = json(c.text);
      if (!page?.items) break;
      items.push(...page.items);
      offset = page.next ?? null;
    } while (offset !== null);
    Object.assign(answer, collectionToNeutral(name, items));
  }
  return { calls, answer: { key: unit.input, electron: answer } };
}
async function hexveroCompare(unit) {
  const calls = [];
  const compare = {};
  for (const name of unit.collections) {
    const c = await call("hexvero", ["compare", join(builtDir, unit.a), join(builtDir, unit.b), name, "--json"]);
    calls.push(c);
    const diff = json(c.text);
    if (diff?.added) compare[name] = compareToNeutral(name, diff);
  }
  return { calls, answer: { key: `compare:${unit.a}|${unit.b}`, compare } };
}
async function hexveroPaths(unit, engine) {
  const calls = [];
  const paths = [];
  for (const question of unit.paths) {
    const c = await call("hexvero", ["calls", join(builtDir, unit.input), engine, question.from, "--goal", question.to, "--json"]);
    calls.push(c);
    paths.push(pathToNeutral(question, json(c.text)));
  }
  return {
    calls,
    answer: {
      key: `native:${unit.input}:${engine}`,
      native: { status: "RUN", engine, imports: [], functions: [], callers: [], paths },
    },
  };
}

// ---- REA -----------------------------------------------------------------------------------
const evidenceFile = (input) => join(work, `${input.replaceAll("/", "__")}.evidence.json`);
async function reaElectron(unit, variant) {
  const path = join(builtDir, unit.input);
  if (variant === "summary") {
    const file = evidenceFile(unit.input);
    const a = await call("rea", ["analyze-javascript-application", path, "--json"], { toFile: file });
    const calls = [a];
    const answer = { ...emptyElectron(), answerKind: "counts only" };
    if (a.exit === 0) {
      // docs/cli.md does this step with jq; it is glue, not a REA call, and is not counted or timed.
      const viewFile = join(work, `${unit.input.replaceAll("/", "__")}.view.json`);
      writeFileSync(viewFile, `{"source":{"kind":"inline","evidence":${readFileSync(file, "utf8")}},"view":{"kind":"summary"}}`);
      const v = await call("rea", ["inspect-analysis-view", viewFile, "--json"], { inputFile: viewFile });
      calls.push(v);
      const summary = json(v.text)?.normalized_result?.summary;
      answer.counts = summary?.electron ?? null;
      answer.complete = summary ? summary.coverage?.application?.status === "complete" : null;
    }
    return { calls, answer: { key: unit.input, electron: answer } };
  }
  const args = ["analyze-javascript-application", path, "--json"];
  if (variant === "filtered") args.push("--filter-output", "normalized_result.graph.nodes");
  const a = await call("rea", args);
  const evidence = json(a.text);
  return {
    calls: [a],
    answer: { key: unit.input, electron: evidence?.normalized_result ? electronFromRea(evidence) : emptyElectron() },
  };
}
async function reaCompare(unit) {
  const files = [evidenceFile(unit.a), evidenceFile(unit.b)];
  const calls = [
    await call("rea", ["analyze-javascript-application", join(builtDir, unit.a), "--json"], { toFile: files[0] }),
    await call("rea", ["analyze-javascript-application", join(builtDir, unit.b), "--json"], { toFile: files[1] }),
  ];
  let compare = {};
  if (calls.every((c) => c.exit === 0)) {
    const inputFile = join(work, "compare-input.json");
    writeFileSync(inputFile, `{"left":${readFileSync(files[0], "utf8")},"right":${readFileSync(files[1], "utf8")}}`);
    const c = await call("rea", ["compare-application-versions", inputFile, "--json"], { inputFile });
    calls.push(c);
    const result = json(c.text);
    if (result?.normalized_result?.items) compare = compareFromRea(result, unit.collections);
  }
  return { calls, answer: { key: `compare:${unit.a}|${unit.b}`, compare } };
}

// ---- the schedule ----------------------------------------------------------------------------
/** Every (tool, variant, unit) with the questions its call sequence answers. */
const jobs = [];
const job = (tool, variant, qs, unit, label, run) => jobs.push({ tool, variant, questions: qs, unit: label, set: unit.set, run });
const electronQs = questions.filter((q) => QUESTIONS[q].collections);
for (const unit of plan.electron) {
  if (tools.includes("hexvero")) for (const q of electronQs) job("hexvero", "default", [q], unit, unit.input, () => hexveroElectron(unit, q));
  // REA's three ways run the same calls whatever the question: measured once, reported for each.
  if (tools.includes("rea") && electronQs.length)
    for (const variant of ["summary", "filtered", "complete"])
      job("rea", variant, electronQs, unit, unit.input, () => reaElectron(unit, variant));
}
const blocked = [];
if (questions.includes("Q4"))
  for (const unit of plan.pairs) {
    const label = `${unit.a} → ${unit.b}`;
    if (tools.includes("hexvero")) job("hexvero", "default", ["Q4"], unit, label, () => hexveroCompare(unit));
    if (tools.includes("rea")) {
      if (unit.electron) job("rea", "complete", ["Q4"], unit, label, () => reaCompare(unit));
      else blocked.push({ tool: "rea", question: "Q4", unit: label, status: "NOT RUN", reason: "REA 6.4.0 has no call that compares the import or symbol tables of two Mach-O files" });
    }
  }
if (questions.includes("Q5"))
  for (const unit of plan.native) {
    if (tools.includes("hexvero")) for (const engine of engines) job("hexvero", engine, ["Q5"], unit, `${unit.input} (${engine})`, () => hexveroPaths(unit, engine));
    if (tools.includes("rea")) {
      // One attempt, to record what REA answers; not a timed run.
      const c = await call("rea", ["function", join(builtDir, unit.input), unit.paths[0]?.from ?? "main", "--json"]);
      const answer = json(c.text);
      blocked.push({
        tool: "rea",
        question: "Q5",
        unit: unit.input,
        status: c.exit === 0 ? "AVAILABLE BUT NOT DRIVEN" : "NOT RUN",
        reason: c.exit === 0 ? "a deep provider answered; this script does not drive it" : `${answer?.code ?? `exit ${c.exit}`}: providers ${(answer?.details?.candidate_ids ?? []).join(", ")} are not installed`,
        attempt: { command: c.command, exit: c.exit, wallMs: c.wallMs, stdoutBytes: c.stdoutBytes, stderrBytes: c.stderrBytes },
      });
    }
  }

const answers = new Map(); // `${tool}.${variant}` -> observations
const answerHashes = new Map();
const record = async (j, phase, rep) => {
  const load = await loadAvg();
  const { calls, answer } = await j.run();
  const hash = sha256(JSON.stringify(answer));
  const id = `${j.tool}.${j.variant}\u0000${j.questions.join("+")}\u0000${j.unit}`;
  const stable = !answerHashes.has(id) || answerHashes.get(id) === hash;
  answerHashes.set(id, answerHashes.get(id) ?? hash);
  const file = `${j.tool}.${j.variant === "radare2" || j.variant === "rizin" ? "default" : j.variant}`;
  const store = answers.get(file) ?? {};
  const merged = store[answer.key] ?? {};
  for (const [kind, value] of Object.entries(answer))
    if (kind !== "key") merged[kind] = kind === "electron" ? { ...emptyElectron(), ...merged.electron, ...value } : { ...merged[kind], ...value };
  store[answer.key] = merged;
  answers.set(file, store);
  const line = {
    at: new Date().toISOString(),
    via: "cli",
    tool: j.tool,
    variant: j.variant,
    questions: j.questions,
    set: j.set,
    unit: j.unit,
    phase,
    rep,
    calls: calls.map(({ text, ...c }) => c),
    callCount: calls.length,
    bytesToCaller: calls.reduce((n, c) => n + (c.stdoutTo === "caller" ? c.stdoutBytes : 0), 0),
    bytesToFiles: calls.reduce((n, c) => n + (c.stdoutTo === "file" ? c.stdoutBytes : 0), 0),
    stderrBytes: calls.reduce((n, c) => n + c.stderrBytes, 0),
    wallMs: calls.reduce((n, c) => n + c.wallMs, 0),
    treePeakRssBytes: Math.max(...calls.map((c) => c.treePeakRssBytes)),
    maxRssBytes: Math.max(...calls.map((c) => c.maxRssBytes ?? 0)),
    ok: calls.every((c) => c.exit === 0),
    errors: calls.filter((c) => c.exit !== 0).map((c) => `${c.command}: exit ${c.exit} ${c.error ?? ""}`),
    answerSha256: hash,
    answerStable: stable,
    load1: load?.[0] ?? null,
    ...(note ? { note } : {}),
  };
  if (!answersOnly) appendFileSync(out, `${JSON.stringify(line)}\n`);
  return line;
};

// Units in order; within a unit the tools alternate, each rep being a cold run followed by a warm one.
const units = [...new Set(jobs.map((j) => j.unit))];
let done = 0;
for (const unit of units) {
  const here = jobs.filter((j) => j.unit === unit);
  for (let rep = 1; rep <= (answersOnly ? 1 : reps); rep++)
    for (const j of here) {
      dropCaches();
      const cold = await record(j, "cold", rep);
      const warm = answersOnly ? cold : await record(j, "warm", rep);
      done += 2;
      if (rep === 1)
        console.log(
          `${j.tool}/${j.variant} ${j.questions.join("+")} ${unit}: ${cold.callCount} calls, ${cold.bytesToCaller} B, cold ${cold.wallMs} ms, warm ${warm.wallMs} ms${cold.ok ? "" : " FAILED"}`,
        );
    }
}
for (const [file, observations] of answers)
  writeFileSync(join(answersDir, `cli.${file}.json`), `${JSON.stringify({ tool: { name: `${file} via cli` }, observations }, null, 1)}\n`);
if (blocked.length) writeFileSync(join(answersDir, "cli.blocked.json"), `${JSON.stringify(blocked, null, 1)}\n`);
console.log(answersOnly ? `answers rewritten in ${answersDir}; no run recorded` : `${done} runs appended to ${out}; ${blocked.length} blocked items`);
