#!/usr/bin/env node
/**
 * Publishes the tarballs listed in <dir>/manifest.json in dependency order and proves the
 * registry holds exactly those bytes.
 *
 *   node scripts/publish-tarballs.mjs <dir> [--dry-run [--allow-existing]]
 *
 * Per package:
 * - not on the registry: `npm publish <tarball> --provenance` (or `--dry-run`);
 * - already there with the same integrity: accepted, so a re-run after a partial release finishes;
 * - already there with a different integrity: failure. A version is never silently skipped.
 * Afterwards every package is read back from the registry until its integrity matches.
 * `--allow-existing` is for rehearsals on an unreleased tree only (with `--dry-run`): a version
 * that already exists with other content is reported loudly instead of failing the rehearsal.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const dir = resolve(process.argv[2] ?? "release");
const dryRun = process.argv.includes("--dry-run");
const allowExisting = dryRun && process.argv.includes("--allow-existing");
const { version, tarballs } = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
const npm = (argv, options = {}) =>
  execFileSync("npm", argv, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });
/** Integrity of name@version on the registry, or null when that version does not exist. */
const published = (name) => {
  try {
    const text = npm(["view", `${name}@${version}`, "dist.integrity", "--json"]).trim();
    return text ? JSON.parse(text) : null;
  } catch (error) {
    const output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
    if (/E404|404 Not Found|is not in this registry/.test(output)) return null;
    throw new Error(`cannot read ${name}@${version} from the registry: ${output.slice(-400)}`, {
      cause: error,
    });
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/**
 * Polls the registry until it serves this tarball. Right after a publish npm can take minutes to
 * show a new version (three attempts in two releases failed a two-minute wait), so this waits up to ten.
 */
async function appears(t) {
  let seen = null;
  const deadline = Date.now() + 10 * 60_000;
  for (
    let wait = 5000;
    seen !== t.integrity && Date.now() < deadline;
    wait = Math.min(wait * 1.5, 30_000)
  ) {
    try {
      seen = published(t.name);
    } catch (error) {
      // a transient registry or network error right after publishing: keep polling
      console.log(`publish: registry not readable yet (${String(error.message).slice(0, 120)})`);
    }
    if (seen !== t.integrity) await sleep(wait);
  }
  return seen;
}

const failures = [];
let skipped = 0;
// A prerelease (1.2.3-rc.1) must not become the default install.
const distTag = version.includes("-") ? ["--tag", "next"] : [];

for (const t of tarballs) {
  const existing = published(t.name);
  if (existing === t.integrity) {
    console.log(`publish: ${t.name}@${version} is already on the registry with identical content`);
    continue;
  }
  if (existing !== null && allowExisting) {
    // npm refuses even a dry run over an existing version, so this package cannot be rehearsed.
    console.log(
      `publish: SKIPPED ${t.name}@${version}: already published with different content, so npm publish --dry-run cannot run. A release needs a new version.`,
    );
    skipped++;
    continue;
  }
  if (existing !== null) {
    failures.push(
      `${t.name}@${version} exists on the registry with different content (${existing})`,
    );
    break; // later packages depend on this one
  }
  console.log(`publish: ${t.name}@${version}${dryRun ? " (dry run)" : ""}`);
  try {
    npm(
      [
        "publish",
        join(dir, t.file),
        "--access",
        "public",
        ...distTag,
        ...(dryRun ? ["--dry-run"] : ["--provenance"]),
      ],
      { stdio: "inherit" },
    );
  } catch {
    // npm refuses a version it is still processing from an earlier attempt ("previously staged");
    // if that attempt carried this very tarball, it is published once the registry shows it.
    if (!dryRun && (await appears(t)) === t.integrity) {
      console.log(`publish: ${t.name}@${version} was already being published with this content`);
      continue;
    }
    failures.push(`npm publish failed for ${t.name}@${version}`);
    break;
  }
}

if (!dryRun && failures.length === 0) {
  for (const t of tarballs) {
    const seen = await appears(t);
    if (seen !== t.integrity)
      failures.push(
        `${t.name}@${version} on the registry does not match the released tarball (${seen})`,
      );
    else console.log(`publish: verified ${t.name}@${version} on the registry`);
  }
}

if (failures.length) {
  console.error(`publish: FAILED\n${failures.map((f) => `  - ${f}`).join("\n")}`);
  console.error(
    "Nothing was skipped. Fix the cause and re-run; identical versions already published are accepted.",
  );
  process.exit(1);
}
console.log(
  dryRun
    ? `publish: dry run complete (${tarballs.length - skipped} of ${tarballs.length} packages rehearsed${skipped ? `, ${skipped} SKIPPED` : ""})`
    : `publish: all ${tarballs.length} packages published and verified`,
);
