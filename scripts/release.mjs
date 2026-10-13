#!/usr/bin/env node
/**
 * Cuts a release: bumps every package to the given version, moves the
 * CHANGELOG "Unreleased" section under the version, commits, tags and pushes.
 * The Release workflow then builds, creates the GitHub release and publishes
 * to npm. Usage: npm run release -- 0.2.2
 */
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version ?? "")) {
  console.error("usage: npm run release -- <x.y.z>");
  process.exit(2);
}
const sh = (cmd) => execSync(cmd, { stdio: "pipe", encoding: "utf8" }).trim();
if (sh("git status --porcelain")) {
  console.error("working tree is not clean; commit or stash first");
  process.exit(1);
}
if (sh("git branch --show-current") !== "main") {
  console.error("run releases from main");
  process.exit(1);
}
sh("git pull --ff-only origin main");

const packages = [
  "packages/core",
  "packages/mcp",
  "packages/server",
  "packages/cli",
  "packages/web",
];
for (const dir of packages) {
  const path = `${dir}/package.json`;
  const pkg = JSON.parse(readFileSync(path, "utf8"));
  pkg.version = version;
  for (const dep of Object.keys(pkg.dependencies ?? {}))
    if (dep.startsWith("@hexvero/")) pkg.dependencies[dep] = version;
  writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
}
const constants = [
  ["packages/mcp/src/index.ts", /SERVER_VERSION = "[^"]+"/, `SERVER_VERSION = "${version}"`],
  ["packages/cli/src/index.ts", /VERSION = "[^"]+"/, `VERSION = "${version}"`],
  ["packages/server/src/index.ts", /version: "[^"]+"/, `version: "${version}"`],
];
for (const [file, re, replacement] of constants)
  writeFileSync(file, readFileSync(file, "utf8").replace(re, replacement));

const today = new Date().toISOString().slice(0, 10);
const changelog = readFileSync("CHANGELOG.md", "utf8");
if (!changelog.includes("## [Unreleased]"))
  throw new Error("CHANGELOG.md has no Unreleased section");
const unreleasedBody = changelog
  .split("## [Unreleased]")[1]
  .split(/\n## \[/)[0]
  .trim();
if (!unreleasedBody) {
  console.error("CHANGELOG.md: the Unreleased section is empty; write the notes first");
  process.exit(1);
}
writeFileSync(
  "CHANGELOG.md",
  changelog.replace("## [Unreleased]\n", `## [Unreleased]\n\n## [${version}] - ${today}\n`),
);

sh("npm install --no-audit --no-fund");
sh("npm run check");
sh(`git add -A && git commit -q -m "chore(release): ${version}"`);
sh(`git tag -a v${version} -m "hexvero ${version}"`);
sh("git push origin main --follow-tags");
console.log(
  `released v${version}; the Release workflow publishes it: https://github.com/maximilianfeix/hexvero/actions`,
);
