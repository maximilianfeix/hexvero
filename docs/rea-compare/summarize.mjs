// Reads results/runs.jsonl and prints one Markdown row per step: cold wall, warm median wall, peak RSS, output bytes.
import fs from "node:fs";
const rows = fs
  .readFileSync(new URL("../results/runs.jsonl", import.meta.url), "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l));
const groups = new Map();
for (const r of rows) {
  const m = r.label.match(/^(.*)-(cold|warm\d+)$/);
  const key = m ? m[1] : r.label;
  const kind = m ? m[2] : "single";
  if (!groups.has(key)) groups.set(key, {});
  groups.get(key)[kind] = r;
}
const med = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};
const s = (ms) => (ms == null ? "n/a" : (ms / 1000).toFixed(2));
const mib = (b) => (b == null ? "n/a" : (b / 1048576).toFixed(0));
console.log(
  "| step | exit | cold wall s | warm wall s (median of 3) | first stdout byte s (cold) | peak RSS MiB, largest process (time -l) | peak RSS MiB, process tree (sampled) | processes | stdout bytes |",
);
console.log("|---|---|---|---|---|---|---|---|---|");
for (const [key, g] of groups) {
  const cold = g.cold ?? g.single;
  const warm = Object.entries(g)
    .filter(([k]) => k.startsWith("warm"))
    .map(([, v]) => v);
  const all = [cold, ...warm].filter(Boolean);
  console.log(
    `| ${key} | ${cold.exit}${cold.timedOutAfterS ? " (killed after " + cold.timedOutAfterS + " s)" : ""} | ${s(cold.wallMs)} | ${warm.length ? s(med(warm.map((w) => w.wallMs))) : "not run"} | ${s(cold.firstByteMs)} | ${mib(Math.max(...all.map((r) => r.timeL.maxRssBytes ?? 0)))} | ${mib(Math.max(...all.map((r) => r.treePeakRssBytes)))} | ${Math.max(...all.map((r) => r.maxProcessesInTree))} | ${cold.stdoutBytes} |`,
  );
}
