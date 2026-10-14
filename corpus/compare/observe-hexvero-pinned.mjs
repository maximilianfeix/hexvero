#!/usr/bin/env node
/**
 * Runs the hexvero observer of the commit under test, unmodified, against the current corpus.
 *
 *   HEXVERO_DIR=… [HEXVERO_COMMIT=a6d9b82] node corpus/compare/observe-hexvero-pinned.mjs [--out file.json]
 *
 * HEXVERO_DIR is a built copy of that commit (git archive, npm ci, npm run build). Its own
 * corpus/observe-hexvero.mjs and corpus/cases.mjs are copied next to its packages/ into a directory
 * whose dev/, validation/, damaged/ and built/ are links to the current corpus, so the pinned code
 * reads the current inputs and expectation files. The pinned cases.mjs knows three sets; a set
 * added later (holdout) is observed by a second run in which the link named dev points at it.
 * Observation keys are input paths, so the runs merge without renaming anything.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { arg, corpusDir, node, resultsDir, scratch, toolEnv } from "./lib/common.mjs";

const root = resolve(process.env.HEXVERO_DIR ?? "");
if (!existsSync(join(root, "packages", "core", "dist", "index.js"))) {
  console.error("HEXVERO_DIR must point at a built copy of hexvero");
  process.exit(2);
}
const out = resolve(arg("out", join(resultsDir, "hexvero.observations.json")));
const env = toolEnv();
const work = join(scratch(), "work");
mkdirSync(work, { recursive: true });

function view(name, links) {
  const dir = join(root, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir);
  for (const file of ["observe-hexvero.mjs", "cases.mjs"]) copyFileSync(join(root, "corpus", file), join(dir, file));
  for (const [link, target] of Object.entries(links))
    if (existsSync(join(corpusDir, target))) symlinkSync(join(corpusDir, target), join(dir, link));
  return dir;
}
function observe(dir, file) {
  execFileSync(node, [join(dir, "observe-hexvero.mjs"), "--out", file], { env, stdio: ["ignore", "inherit", "inherit"] });
  return JSON.parse(readFileSync(file, "utf8"));
}

const main = observe(
  view("corpus-view", { dev: "dev", validation: "validation", damaged: "damaged", built: "built" }),
  join(work, "hexvero.main.json"),
);
const merged = { ...main.observations };
const sets = ["dev", "validation", "damaged"];
if (existsSync(join(corpusDir, "holdout")) && existsSync(join(corpusDir, "built", "holdout"))) {
  const extra = observe(view("corpus-view-holdout", { dev: "holdout", built: "built" }), join(work, "hexvero.holdout.json"));
  for (const [key, value] of Object.entries(extra.observations)) {
    if (key in merged) throw new Error(`observation ${key} exists in two sets`);
    merged[key] = value;
  }
  sets.push("holdout");
}
writeFileSync(
  out,
  `${JSON.stringify(
    {
      tool: {
        ...main.tool,
        // The copy is no git checkout, so the observer cannot read the commit; it is given here.
        commit: process.env.HEXVERO_COMMIT ?? main.tool.commit,
        observer: "corpus/observe-hexvero.mjs of that commit, unmodified",
      },
      sets,
      observations: merged,
    },
    null,
    1,
  )}\n`,
);
console.log(`observations: ${Object.keys(merged).length} written to ${out} (sets ${sets.join(", ")})`);
