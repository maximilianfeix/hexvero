#!/usr/bin/env node
/**
 * Cuts a release: bumps every package to the given version, moves the
 * CHANGELOG "Unreleased" section under the version, runs every release gate, then commits and
 * tags locally. It pushes only with --push; the tag push is what starts the publishing workflow.
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
/** Runs a gate with its output on the terminal, so a failure shows its own reason. */
const gate = (cmd) => execSync(cmd, { stdio: "inherit" });
if (sh("git status --porcelain")) {
  console.error("working tree is not clean; commit or stash first");
  process.exit(1);
}
if (sh("git branch --show-current") !== "main") {
  console.error("run releases from main");
  process.exit(1);
}
sh("git pull --ff-only origin main");
// Gates on the untouched tree first: a failing check must not leave version bumps behind.
gate("npm run check");

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
  ["server.json", /"version": "[^"]+"/g, `"version": "${version}"`],
];
for (const [file, re, replacement] of constants)
  writeFileSync(file, readFileSync(file, "utf8").replace(re, replacement));

// The READMEs carry a note that says "this describes main, npm serves an older version". It is
// only true between releases, so the release removes it.
for (const file of ["README.md", "README.de.md"]) {
  const text = readFileSync(file, "utf8");
  writeFileSync(
    file,
    text.replace(/<!-- unreleased-note:start -->[\s\S]*?<!-- unreleased-note:end -->\n\n?/, ""),
  );
}

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

// From here on files are rewritten. If any gate fails, the tree goes back to the clean state it
// was verified to be in above, so the next attempt starts from the same place.
try {
  gate("npm install --no-audit --no-fund");
  gate("npm run check");
  gate("npm run build");
  gate(`node scripts/release-verify.mjs v${version}`);
  gate("node scripts/smoke-tarballs.mjs");
} catch {
  sh("git checkout -- . && git clean -fdq -- examples packages scripts docs");
  console.error(
    `\nrelease ${version} aborted: a gate failed (see above). The working tree was restored.`,
  );
  process.exit(1);
}
sh(`git add -A && git commit -q -m "chore(release): ${version}"`);
sh(`git tag -a v${version} -m "hexvero ${version}"`);
const push = `git push --atomic origin main v${version}`;
if (process.argv.includes("--push")) {
  // Point of no return: the tag starts the Release workflow, which publishes to npm.
  sh(push);
  console.log(
    `pushed v${version}; the Release workflow publishes it: https://github.com/maximilianfeix/hexvero/actions`,
  );
} else {
  console.log(
    `v${version} is committed and tagged locally. Nothing has been pushed or published.\n` +
      `Publish it with:  ${push}\n` +
      `                  (a direct push to main; branch protection lets the repository admin do this)\n` +
      `Undo it with:     git tag -d v${version} && git reset --hard HEAD~1`,
  );
}
