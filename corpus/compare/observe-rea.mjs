#!/usr/bin/env node
/**
 * Runs REA on every corpus input and writes what it reports in the corpus's neutral observation
 * format (the format of ../observe-hexvero.mjs). It knows nothing about the expected results.
 *
 *   REA_PKG_DIR=… COMPARE_SCRATCH=… node corpus/compare/observe-rea.mjs [--out file.json]
 *        [--reuse] [--store-calls-as-storage]
 *
 * REA is used through its command line, one documented call per input:
 *   Electron archive   rea analyze-javascript-application <asar> --json     (complete Evidence)
 *   two versions       rea compare-application-versions <input.json> --json  (both Evidence inline)
 *   Mach-O             rea inspect-macho <binary> --json                     (no engine needed)
 *   damaged input      the call that fits its format, with the corpus's time limit
 * Call paths, callers and the function list need a deep-analysis provider (Ghidra, Hopper or IDA).
 * The script asks REA for them once per binary and records REA's answer; when no provider is
 * there, these classes are NOT RUN, not zero.
 *
 * --reuse keeps Evidence files of an earlier run of this script (they are large and slow to make).
 * --store-calls-as-storage writes the alternative reading described in README.md.
 */
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  arg,
  builtDir,
  corpusDir,
  ensureDir,
  flag,
  measure,
  node,
  reaCli,
  resultsDir,
  scratch,
  sha256,
  toolEnv,
} from "./lib/common.mjs";
import { compareFromRea, electronFromRea, importsFromRea, robustFromRea } from "./lib/rea-map.mjs";

const { loadCases } = await import(pathToFileURL(join(corpusDir, "cases.mjs")).href);
const sets = arg("sets", "dev,validation,damaged,holdout").split(",");
const out = resolve(arg("out", join(resultsDir, "rea.observations.json")));
const alt = flag("store-calls-as-storage");
const env = toolEnv();
const work = ensureDir(join(scratch(), "work", "rea-evidence"));
const rea = (args, options = {}) => measure(node, [reaCli(), ...args], { env, ...options });
const fileOf = (input, suffix = "json") => join(work, `${input.replaceAll("/", "__")}.${suffix}`);
const raw = {};
const notRun = [];

/** The complete Evidence of one archive, from a file of an earlier run or from REA. */
async function evidenceOf(input) {
  const file = fileOf(input);
  if (!(flag("reuse") && existsSync(file) && statSync(file).size > 0)) {
    const run = await rea(["analyze-javascript-application", join(builtDir, input), "--json"], { stdoutFile: file });
    raw[`analyze:${input}`] = { exit: run.exit, wallMs: run.wallMs, stdoutBytes: run.stdoutBytes };
    if (run.exit !== 0) return { error: readFileSync(file, "utf8").slice(0, 600), file };
  }
  const text = readFileSync(file, "utf8");
  raw[`analyze:${input}`] = { ...raw[`analyze:${input}`], bytes: Buffer.byteLength(text), sha256: sha256(text) };
  return { evidence: JSON.parse(text), file };
}

const observations = {};
for (const c of loadCases(sets)) {
  if (c.kind === "electron") {
    for (const input of c.inputs) {
      const { evidence, error } = await evidenceOf(input);
      if (error) {
        notRun.push({ key: input, class: "*", reason: `REA failed: ${error}` });
        continue;
      }
      observations[input] = { electron: electronFromRea(evidence, { storeCallsAsStorage: alt }) };
      notRun.push({
        key: input,
        class: "bridge member channel",
        reason:
          "REA 6.4.0 lists the member names of an exposed API (context-bridge-api.members) and has no field that says which IPC channel a member uses",
      });
    }
  } else if (c.kind === "compare") {
    const key = `compare:${c.a}|${c.b}`;
    const label = `${c.a} → ${c.b}`;
    if (!c.a.endsWith(".asar")) {
      notRun.push({
        key: label,
        class: "*",
        reason:
          "REA 6.4.0 has no call that compares the import or symbol tables of two Mach-O files: compare-application-versions takes JavaScript application Evidence, compare-artifacts compares archive inventories, compare-functions needs function Evidence from a deep provider (none installed)",
      });
      continue;
    }
    const left = await evidenceOf(c.a);
    const right = await evidenceOf(c.b);
    if (left.error || right.error) {
      notRun.push({ key: label, class: "*", reason: `REA failed on an input: ${left.error ?? right.error}` });
      continue;
    }
    const inputFile = fileOf(`${c.a}--${c.b}`, "compare-input.json");
    writeFileSync(inputFile, JSON.stringify({ left: left.evidence, right: right.evidence }));
    const outFile = fileOf(`${c.a}--${c.b}`, "compare.json");
    const run = await rea(["compare-application-versions", inputFile, "--json"], { stdoutFile: outFile });
    const text = readFileSync(outFile, "utf8");
    raw[key] = { exit: run.exit, wallMs: run.wallMs, stdoutBytes: run.stdoutBytes, inputBytes: statSync(inputFile).size, sha256: sha256(text) };
    if (run.exit !== 0) {
      notRun.push({ key: label, class: "*", reason: `REA failed: ${text.slice(0, 600)}` });
      continue;
    }
    observations[key] = { compare: compareFromRea(JSON.parse(text), Object.keys(c.expect.compare)) };
  } else if (c.kind === "native") {
    for (const input of c.inputs) {
      const path = join(builtDir, input);
      const key = `native:${input}:inspect-macho`;
      const run = await rea(["inspect-macho", path, "--json"]);
      raw[key] = { exit: run.exit, wallMs: run.wallMs, stdoutBytes: run.stdoutBytes, sha256: sha256(run.stdout) };
      if (run.exit !== 0) {
        observations[key] = { native: { status: "NOT RUN", reason: `rea inspect-macho failed: ${run.stdout.slice(0, 300)}` } };
        continue;
      }
      const facts = importsFromRea(JSON.parse(run.stdout));
      // The deep questions: asked once, to record what REA answers on this machine.
      const deep = await rea(["function", path, "main", "--json"]);
      let deepAnswer = null;
      try {
        deepAnswer = JSON.parse(deep.stdout);
      } catch {
        /* not JSON */
      }
      const provider = deep.exit === 0 ? (deepAnswer?.provider?.name ?? deepAnswer?.provider ?? "available") : null;
      raw[`function:${input}`] = { exit: deep.exit, wallMs: deep.wallMs, stdoutBytes: deep.stdoutBytes, code: deepAnswer?.code ?? null };
      observations[key] = {
        native: {
          status: "RUN",
          engine: "rea inspect-macho (system nm, dyld_info, otool)",
          limitations: [],
          imports: facts.imports,
          exportsSeen: facts.exports,
          functions: [],
          paths: [],
          callers: [],
          deepProvider: provider,
        },
      };
      if (deep.exit === 0)
        console.error(`note: REA has a deep provider for ${input}; this script does not drive it. Extend it before trusting the native rows.`);
      const reason =
        deep.exit === 0
          ? "a deep provider is available but this script does not drive it"
          : `rea function … answered ${deepAnswer?.code ?? `exit ${deep.exit}`}: candidates ${(deepAnswer?.details?.candidate_ids ?? []).join(", ")}; none is installed. REA 6.4.0 has no radare2 or rizin provider`;
      for (const klass of ["functions", "call paths", "direct callers"])
        notRun.push({ key: `${input} (inspect-macho)`, class: klass, reason });
    }
  } else if (c.kind === "robustness") {
    for (const r of c.expect.robustness) {
      const path = join(builtDir, r.input);
      const args = r.input.endsWith(".asar") ? ["analyze-javascript-application", path, "--json"] : ["inspect-macho", path, "--json"];
      const run = await rea(args, { timeoutMs: (c.timeLimitSeconds ?? 30) * 1000 });
      observations[`robust:${r.input}`] = { robust: { ...robustFromRea(run), command: `rea ${args[0]}`, exit: run.exit, wallMs: run.wallMs } };
    }
  }
}

const version = await rea(["--version"]);
const pkg = JSON.parse(readFileSync(join(process.env.REA_PKG_DIR, "package.json"), "utf8"));
writeFileSync(
  out,
  `${JSON.stringify(
    {
      tool: {
        name: "REA",
        version: pkg.version,
        package: pkg.name,
        cli: version.stdout.trim(),
        node: process.version,
        platform: `${process.platform} ${process.arch}`,
        mapping: alt ? "alternative: store calls counted as storage" : "default",
        "deep providers": "none installed (Ghidra, Hopper, IDA)",
      },
      notRun,
      observations,
      raw,
    },
    null,
    1,
  )}\n`,
);
console.log(`observations: ${Object.keys(observations).length} written to ${out}; ${notRun.length} NOT RUN entries`);
