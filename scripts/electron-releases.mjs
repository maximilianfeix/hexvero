#!/usr/bin/env node
/**
 * Refreshes hexvero's offline snapshot of Electron's release data
 * (packages/core/src/data/electronReleases.ts), which `runtime` uses to say whether the Electron
 * line a packaged build ships is still supported. Run by hand when the snapshot should move on;
 * never in CI, so an analysis never depends on the network or on the day CI ran.
 *
 * Sources (both published by the Electron project):
 * - https://releases.electronjs.org/releases.json: every release with its date, Chromium and Node
 *   versions. Nightlies are left out.
 * - https://releases.electronjs.org/schedule.json: per major line, its stable date and its
 *   end-of-life date (Electron supports the latest three stable lines; the schedule gives the
 *   day each line drops out). Dates in the future are planned and may move.
 *
 * Usage: node scripts/electron-releases.mjs [--date YYYY-MM-DD]
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RELEASES = "https://releases.electronjs.org/releases.json";
const SCHEDULE = "https://releases.electronjs.org/schedule.json";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "packages", "core", "src", "data", "electronReleases.ts");

const dateArg = process.argv.indexOf("--date");
const snapshot = dateArg > 0 ? process.argv[dateArg + 1] : new Date().toISOString().slice(0, 10);
if (!/^\d{4}-\d{2}-\d{2}$/.test(snapshot ?? "")) throw new Error("--date must be YYYY-MM-DD");

async function json(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-(?:alpha|beta)\.\d+)?$/;
const releases = await json(RELEASES);
const schedule = await json(SCHEDULE);
if (!Array.isArray(releases) || !Array.isArray(schedule))
  throw new Error("unexpected shape: both files must be lists");

const versions = {};
for (const r of releases) {
  if (typeof r?.version !== "string" || !VERSION.test(r.version)) continue; // nightlies and odd ones
  if (!DATE.test(r.date ?? "")) continue;
  versions[r.version] = [r.date, String(r.chrome ?? ""), String(r.node ?? "")];
}
const majors = {};
for (const s of schedule) {
  const m = /^(\d+)\.0\.0$/.exec(s?.version ?? "");
  if (!m) continue;
  majors[m[1]] = {
    stable: DATE.test(s.stableDate ?? "") ? s.stableDate : null,
    eol: DATE.test(s.eolDate ?? "") ? s.eolDate : null,
  };
}
const sortVersion = (a, b) => {
  const pa = a.split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  const pb = b.split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if (pa[i] === pb[i]) continue;
    if (pa[i] === undefined) return -1;
    if (pb[i] === undefined) return 1;
    return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
};
const sortedVersions = Object.fromEntries(
  Object.keys(versions)
    .toSorted(sortVersion)
    .map((v) => [v, versions[v]]),
);
const sortedMajors = Object.fromEntries(
  Object.keys(majors)
    .toSorted((a, b) => Number(a) - Number(b))
    .map((k) => [k, majors[k]]),
);

const data = {
  snapshot,
  sources: [RELEASES, SCHEDULE],
  versions: sortedVersions,
  majors: sortedMajors,
};
const body = `/**
 * Electron release data, derived from the Electron project's own files on ${snapshot} by
 * scripts/electron-releases.mjs (run by hand, never in CI). Do not edit by hand.
 *
 * - \`versions\`: every non-nightly release as [date, Chromium version, Node version], from
 *   ${RELEASES}
 * - \`majors\`: per major line, its stable date and end-of-life date, from
 *   ${SCHEDULE}.
 *   A date after \`snapshot\` is the date planned then; it may move.
 */
export interface ElectronReleaseSnapshot {
  snapshot: string;
  sources: string[];
  versions: Record<string, [date: string, chrome: string, node: string]>;
  majors: Record<string, { stable: string | null; eol: string | null }>;
}

export const ELECTRON_RELEASES: ElectronReleaseSnapshot = {
  snapshot: ${JSON.stringify(snapshot)},
  sources: [
${data.sources.map((s) => `    ${JSON.stringify(s)},`).join("\n")}
  ],
  versions: {
${Object.entries(sortedVersions)
  .map(([v, row]) => `    "${v}": [${row.map((x) => JSON.stringify(x)).join(", ")}],`)
  .join("\n")}
  },
  majors: {
${Object.entries(sortedMajors)
  .map(
    ([m, x]) =>
      `    "${m}": { stable: ${JSON.stringify(x.stable)}, eol: ${JSON.stringify(x.eol)} },`,
  )
  .join("\n")}
  },
};
`;
writeFileSync(out, body);
console.log(
  `${out}: ${Object.keys(sortedVersions).length} releases, ${Object.keys(sortedMajors).length} major lines, snapshot ${snapshot}`,
);
