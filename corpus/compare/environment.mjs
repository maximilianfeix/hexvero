#!/usr/bin/env node
/**
 * Records the environment of a run: tools, runtime, machine, engines, inputs, time and load.
 *
 *   HEXVERO_DIR=… REA_PKG_DIR=… [HEXVERO_COMMIT=…] node corpus/compare/environment.mjs --stage before|after
 *        [--out results/environment.json]
 *
 * `before` writes the file; `after` adds the load and time at the end to it.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { arg, builtDir, corpusDir, hexveroCli, node, reaCli, resultsDir, sha256 } from "./lib/common.mjs";

const out = resolve(arg("out", join(resultsDir, "environment.json")));
const stage = arg("stage", "before");
const sh = (cmd, args = []) => {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (error) {
    return `unavailable: ${String(error.message).split("\n")[0]}`;
  }
};
const moment = () => ({
  at: new Date().toISOString(),
  local: sh("date"),
  uptime: sh("uptime"),
  loadavg: sh("sysctl", ["-n", "vm.loadavg"]),
  memoryPressure: sh("memory_pressure").split("\n").filter((l) => /free percentage|Pages (free|active|wired)|Swap|Pageouts/.test(l)),
});
if (stage === "after") {
  const env = JSON.parse(readFileSync(out, "utf8"));
  env.after = moment();
  writeFileSync(out, `${JSON.stringify(env, null, 1)}\n`);
  console.log(`after: ${env.after.loadavg}`);
  process.exit(0);
}
const sums = readFileSync(join(builtDir, "SHA256SUMS"), "utf8").trim().split("\n").map((line) => line.split(/\s+/));
const inputs = sums.map(([expected, file]) => {
  const path = join(builtDir, file);
  const actual = existsSync(path) ? sha256(readFileSync(path)) : null;
  return { file, sha256: expected, matchesFile: actual === expected };
});
// The expectation files and the scorer as they were when this run started: they can change later.
const walk = (dir) => readdirSync(dir).toSorted().flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? walk(path) : [path];
});
const expectations = ["dev", "validation", "holdout", "damaged"]
  .filter((set) => existsSync(join(corpusDir, set)))
  .flatMap((set) => walk(join(corpusDir, set)).filter((f) => /expected[\w-]*\.json$/.test(f)))
  .concat(["score.mjs", "cases.mjs"].map((f) => join(corpusDir, f)))
  .map((f) => ({ file: relative(corpusDir, f), sha256: sha256(readFileSync(f)), modified: statSync(f).mtime.toISOString() }));
const reaPkg = JSON.parse(readFileSync(join(resolve(process.env.REA_PKG_DIR), "package.json"), "utf8"));
const env = {
  before: moment(),
  hexvero: {
    version: sh(node, [hexveroCli(), "--version"]),
    commit: process.env.HEXVERO_COMMIT ?? "not given (HEXVERO_COMMIT)",
    how: "git archive of the commit, npm ci, npm run build; the working tree was not measured",
    doctor: sh(node, [hexveroCli(), "doctor"]).split("\n").slice(0, 20),
  },
  rea: {
    package: `${reaPkg.name}@${reaPkg.version}`,
    cli: sh(node, [reaCli(), "--version"]),
    gitTag: `rea-agents-${reaPkg.version}`,
    deepProviders: "none: Ghidra, Hopper and IDA are not installed",
  },
  node: { version: process.version, path: "the same binary runs both tools", v8: process.versions.v8 },
  os: { name: sh("sw_vers", ["-productName"]), version: sh("sw_vers", ["-productVersion"]), build: sh("sw_vers", ["-buildVersion"]), kernel: sh("uname", ["-rm"]) },
  machine: {
    cpu: sh("sysctl", ["-n", "machdep.cpu.brand_string"]),
    cores: Number(sh("sysctl", ["-n", "hw.ncpu"])),
    memoryBytes: Number(sh("sysctl", ["-n", "hw.memsize"])),
  },
  engines: { radare2: sh("r2", ["-v"]).split("\n")[0], rizin: sh("rizin", ["-v"]).split("\n")[0] },
  compiler: sh("cc", ["--version"]).split("\n")[0],
  systemTools: { nm: sh("xcrun", ["-f", "nm"]), note: "rea inspect-macho runs the system's nm, otool, dyld_info, lipo, vtool" },
  expectations,
  inputs,
  allInputsMatchSums: inputs.every((i) => i.matchesFile),
};
writeFileSync(out, `${JSON.stringify(env, null, 1)}\n`);
console.log(`before: ${env.before.loadavg}; ${inputs.length} inputs, sums ${env.allInputsMatchSums ? "match" : "DO NOT MATCH"}`);
