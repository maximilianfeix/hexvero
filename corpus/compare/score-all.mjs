#!/usr/bin/env node
/**
 * Scores every observation file of the comparison with the corpus's own scorer, per set.
 *
 *   node corpus/compare/score-all.mjs [--sets dev,validation,holdout,damaged]
 *
 * results/hexvero.observations.json and results/rea.observations*.json
 *     -> results/scores/<tool>.<set>.md and .json            (the scorer's output, untouched)
 * results/answers/<via>.<tool>.<variant>.json  (what the calls of the five questions returned)
 *     -> results/scores/answers/<via>.<tool>.<variant>.<set>.json
 * The scorer is ../score.mjs as it is now; it is run as a child process and not modified.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { arg, corpusDir, ensureDir, node, resultsDir } from "./lib/common.mjs";

const sets = arg("sets", "dev,validation,holdout,damaged").split(",").filter((s) => existsSync(join(corpusDir, s)));
const scorer = join(corpusDir, "score.mjs");
const scores = ensureDir(join(resultsDir, "scores"));
const run = (file, set, base, markdown) =>
  execFileSync(node, [scorer, file, "--set", set, "--json", `${base}.json`, ...(markdown ? ["--markdown", `${base}.md`] : [])], { stdio: ["ignore", "ignore", "inherit"] });

for (const file of readdirSync(resultsDir).filter((f) => /\.observations(\.[\w-]+)?\.json$/.test(f))) {
  const tool = file.replace(/\.json$/, "").replace(".observations", "");
  for (const set of sets) run(join(resultsDir, file), set, join(scores, `${tool}.${set}`), true);
  console.log(`scored ${file} for ${sets.join(", ")}`);
}
const answers = join(resultsDir, "answers");
if (existsSync(answers)) {
  const outDir = ensureDir(join(scores, "answers"));
  for (const file of readdirSync(answers).filter((f) => f.endsWith(".json") && !f.endsWith("blocked.json"))) {
    for (const set of sets.filter((s) => s !== "damaged")) run(join(answers, file), set, join(outDir, `${file.replace(/\.json$/, "")}.${set}`), false);
    console.log(`scored answers ${file}`);
  }
}
