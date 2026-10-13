#!/usr/bin/env node
/**
 * Fails when hexvero does worse on the corpus than the committed result.
 *
 *   npm run build && node corpus/gate.mjs
 *
 * It records fresh observations, scores them, and compares every row (set, input, class) with
 * corpus/results/hexvero.json. A row may improve; it may not lose a hit or gain a miss or a false
 * report. Rows for an engine that is not installed here are skipped and listed, never counted as
 * passed. To accept a deliberate change, regenerate the committed result (see corpus/README.md).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { corpusRoot } from "./cases.mjs";

const temp = mkdtempSync(join(tmpdir(), "hexvero-corpus-gate-"));
try {
  const observations = join(temp, "observations.json");
  const scored = join(temp, "scored.json");
  const run = (script, args) =>
    execFileSync(process.execPath, [join(corpusRoot, script), ...args], { stdio: ["ignore", "pipe", "inherit"] });
  run("observe-hexvero.mjs", ["--out", observations]);
  run("score.mjs", [observations, "--json", scored]);
  const key = (r) => `${r.set} | ${r.input} | ${r.class}`;
  const now = new Map(JSON.parse(readFileSync(scored, "utf8")).rows.map((r) => [key(r), r]));
  const baseline = JSON.parse(readFileSync(join(corpusRoot, "results", "hexvero.json"), "utf8")).rows;
  const worse = [];
  const skipped = [];
  let compared = 0;
  for (const before of baseline) {
    const after = now.get(key(before));
    const notRun = (r) => r.notes.some((n) => /^(NOT RUN|BLOCKED)/.test(n));
    if (!after || notRun(after) || notRun(before)) {
      skipped.push(key(before));
      continue;
    }
    compared++;
    if (after.hit < before.hit || after.missed > before.missed || after.false > before.false)
      worse.push(
        `${key(before)}: hit ${before.hit} -> ${after.hit}, missed ${before.missed} -> ${after.missed}, false ${before.false} -> ${after.false}${after.notes.length ? ` (${after.notes.join("; ")})` : ""}`,
      );
  }
  if (skipped.length) console.log(`corpus gate: ${skipped.length} row(s) not compared here (engine not installed or not run):\n  ${[...new Set(skipped.map((s) => s.split(" | ")[1]))].join("\n  ")}`);
  if (worse.length) {
    console.error(`corpus gate: ${worse.length} of ${compared} row(s) are worse than the committed result:\n  ${worse.join("\n  ")}`);
    process.exit(1);
  }
  console.log(`corpus gate: ${compared} row(s) compared, none worse than the committed result`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
