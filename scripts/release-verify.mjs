#!/usr/bin/env node
/**
 * Release gate 1: every place that states a version agrees, and (given a tag) matches it.
 * Usage: node scripts/release-verify.mjs [vX.Y.Z]
 * Checks every file scripts/release.mjs bumps: the four published packages and their pinned
 * @hexvero/* dependencies, the private web package, the version constants compiled into the CLI,
 * MCP server and core (VERSION, SERVER_VERSION, CORE_VERSION), server.json, the Claude plugin
 * manifest (.claude-plugin/plugin.json), and the CHANGELOG section.
 */
import { readFileSync } from "node:fs";

const tag = process.argv[2];
const problems = [];
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
// web is built into the CLI package (ui/) and never published on its own, so it stays private.
const packages = ["core", "mcp", "server", "cli", "web"].map((d) => ({
  dir: `packages/${d}`,
  json: JSON.parse(read(`packages/${d}/package.json`)),
  published: d !== "web",
}));
const version = packages[0].json.version;

for (const { dir, json, published } of packages) {
  if (json.version !== version) problems.push(`${dir} is ${json.version}, expected ${version}`);
  if (published && json.private) problems.push(`${dir} is private`);
  for (const [dep, range] of Object.entries(json.dependencies ?? {}))
    if (dep.startsWith("@hexvero/") && range !== version)
      problems.push(`${dir} depends on ${dep}@${range}, expected the exact version ${version}`);
}
const constant = (file, pattern, label) => {
  const found = pattern.exec(read(file))?.[1];
  if (found !== version)
    problems.push(`${label} in ${file} is ${found ?? "missing"}, expected ${version}`);
};
constant("packages/cli/src/index.ts", /export const VERSION = "([^"]+)"/, "VERSION");
constant("packages/mcp/src/index.ts", /export const SERVER_VERSION = "([^"]+)"/, "SERVER_VERSION");
constant("packages/core/src/version.ts", /export const CORE_VERSION = "([^"]+)"/, "CORE_VERSION");
const manifest = JSON.parse(read("server.json"));
if (manifest.version !== version) problems.push(`server.json version is ${manifest.version}`);
for (const p of manifest.packages ?? [])
  if (p.version !== version) problems.push(`server.json package ${p.identifier} is ${p.version}`);
const plugin = JSON.parse(read(".claude-plugin/plugin.json"));
if (plugin.version !== version)
  problems.push(`.claude-plugin/plugin.json version is ${plugin.version}, expected ${version}`);
if (!new RegExp(`^## \\[${version.replace(/\./g, "\\.")}\\]`, "m").test(read("CHANGELOG.md")))
  problems.push(`CHANGELOG.md has no "## [${version}]" section`);
if (tag !== undefined) {
  if (!/^v\d+\.\d+\.\d+(-[\w.]+)?$/.test(tag))
    problems.push(`"${tag}" is not a release tag (vX.Y.Z)`);
  else if (tag.slice(1) !== version)
    problems.push(`tag ${tag} does not match package version ${version}`);
}

if (problems.length) {
  console.error(
    `release-verify: ${problems.length} problem(s)\n${problems.map((p) => `  - ${p}`).join("\n")}`,
  );
  process.exit(1);
}
console.log(`release-verify: version ${version} is consistent${tag ? ` and matches ${tag}` : ""}`);
