// Runs one command under `/usr/bin/time -l`, streams stdout to a file, and records:
//   wallMs (monotonic clock around the child), firstByteMs (first stdout byte),
//   timeL.maxRssBytes / peakFootprintBytes (as printed by /usr/bin/time -l: the largest single process),
//   treePeakRssBytes (sum of RSS over the whole process tree, sampled every 100 ms with ps),
//   exit code/signal, stdout bytes, last stderr lines.
// usage: node measure.mjs <label> <stdout-file> -- <command> [args...]      (appends one JSON line to results/runs.jsonl)
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
const argv = process.argv.slice(2);
const label = argv.shift();
const outFile = argv.shift();
argv.shift();
const out = fs.openSync(outFile, "w");
const t0 = performance.now();
const child = spawn("/usr/bin/time", ["-l", ...argv], {
  stdio: ["ignore", "pipe", "pipe"],
  env: process.env,
  detached: true,
});
// MEASURE_TIMEOUT_S=<n>: kill the whole process group after n seconds (then /usr/bin/time prints nothing; treePeakRssBytes still holds).
let timedOut = false;
const limit = Number(process.env.MEASURE_TIMEOUT_S ?? 0);
const killer =
  limit > 0
    ? setTimeout(() => {
        timedOut = true;
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
      }, limit * 1000)
    : null;
let first = null,
  bytes = 0,
  err = "";
child.stdout.on("data", (d) => {
  if (first === null) first = performance.now() - t0;
  bytes += d.length;
  fs.writeSync(out, d);
});
child.stderr.on("data", (d) => {
  err += d;
  if (err.length > 400000) err = err.slice(-200000);
});
let treePeak = 0,
  maxProcs = 0;
const sample = () => {
  try {
    const rows = execFileSync("ps", ["-axo", "pid=,ppid=,rss="], { encoding: "utf8" })
      .trim()
      .split("\n")
      .map((l) => l.trim().split(/\s+/).map(Number));
    const kids = new Map();
    for (const [pid, ppid] of rows) {
      if (!kids.has(ppid)) kids.set(ppid, []);
      kids.get(ppid).push(pid);
    }
    const rss = new Map(rows.map(([pid, , r]) => [pid, r]));
    let sum = 0,
      n = 0;
    const stack = [child.pid];
    while (stack.length) {
      const p = stack.pop();
      sum += rss.get(p) ?? 0;
      n++;
      for (const k of kids.get(p) ?? []) stack.push(k);
    }
    if (sum * 1024 > treePeak) treePeak = sum * 1024;
    if (n > maxProcs) maxProcs = n;
  } catch {}
};
const timer = setInterval(sample, 100);
child.on("close", (code, signal) => {
  clearInterval(timer);
  if (killer) clearTimeout(killer);
  fs.closeSync(out);
  const wallMs = Math.round(performance.now() - t0);
  const num = (re) => {
    const m = err.match(re);
    return m ? Number(m[1].replace(",", ".")) : null;
  }; // decimal comma under de_DE
  const stderrTail = err
    .split("\n")
    .filter((l) => !/^\s+\d+\s+[a-z ]+$/.test(l) && !/ real .* user .* sys/.test(l) && l.trim())
    .slice(-4)
    .map((l) => l.slice(0, 300));
  const rec = {
    label,
    command: argv.join(" "),
    exit: code,
    signal,
    timedOutAfterS: timedOut ? limit : null,
    wallMs,
    firstByteMs: first === null ? null : Math.round(first),
    stdoutBytes: bytes,
    timeL: {
      realS: num(/([\d.,]+) real/),
      userS: num(/([\d.,]+) user/),
      sysS: num(/([\d.,]+) sys/),
      maxRssBytes: num(/(\d+)\s+maximum resident set size/),
      peakFootprintBytes: num(/(\d+)\s+peak memory footprint/),
    },
    treePeakRssBytes: treePeak,
    maxProcessesInTree: maxProcs,
    stderrTail,
    at: new Date().toISOString(),
  };
  fs.appendFileSync(new URL("../results/runs.jsonl", import.meta.url), JSON.stringify(rec) + "\n");
  const mb = (b) => (b == null ? "n/a" : (b / 1048576).toFixed(1) + " MiB");
  console.log(
    `${label}: exit=${code}${signal ? "/" + signal : ""} wall=${(wallMs / 1000).toFixed(2)}s first=${first === null ? "n/a" : (first / 1000).toFixed(2) + "s"} maxRSS=${mb(rec.timeL.maxRssBytes)} footprint=${mb(rec.timeL.peakFootprintBytes)} treeRSS=${mb(treePeak)} procs=${maxProcs} out=${bytes} B`,
  );
  if (code !== 0) console.log(stderrTail.join("\n"));
});
