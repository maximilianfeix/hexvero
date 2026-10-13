/**
 * Shared by every script of the comparison: where things are, how a command is run and measured.
 *
 * No path of any machine is written in here. Everything comes from the environment:
 *
 *   HEXVERO_DIR      a built copy of hexvero at the commit under test (has packages/cli/bin/hexvero.js)
 *   REA_PKG_DIR      the installed rea-agents package (has scripts/rea.mjs)
 *   MCP_SDK_DIR      a directory whose node_modules holds @modelcontextprotocol/sdk (MCP scripts only)
 *   COMPARE_SCRATCH  a scratch directory for caches, a private HOME and TMPDIR, and large raw outputs
 *   CORPUS_DIR       the corpus (default: the parent directory of this one)
 *
 * The Node binary that runs the script also runs both tools (process.execPath), so the runtime is
 * identical for both by construction.
 */
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const compareDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const need = (name) => {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is not set; see corpus/compare/README.md`);
    process.exit(2);
  }
  return resolve(value);
};
export const corpusDir = resolve(process.env.CORPUS_DIR ?? join(compareDir, ".."));
export const builtDir = join(corpusDir, "built");
export const resultsDir = resolve(process.env.COMPARE_RESULTS ?? join(compareDir, "results"));
export const scratch = () => need("COMPARE_SCRATCH");
export const hexveroCli = () => join(need("HEXVERO_DIR"), "packages", "cli", "bin", "hexvero.js");
export const reaCli = () => join(need("REA_PKG_DIR"), "scripts", "rea.mjs");
export const node = process.execPath;

export const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
export const flag = (name) => process.argv.includes(`--${name}`);
export const sha256 = (data) => createHash("sha256").update(data).digest("hex");
export const ensureDir = (dir) => (mkdirSync(dir, { recursive: true }), dir);

/**
 * The environment both tools run in: a private HOME and TMPDIR under the scratch directory, and a
 * private hexvero cache. REA 6.4.0 has no cache variable; what it would keep lives under
 * $HOME/.rea (cache, state) and in rea-* directories under TMPDIR, so both are redirected.
 */
export function toolEnv() {
  const base = scratch();
  const home = ensureDir(join(base, "home"));
  const tmp = ensureDir(join(base, "tmp"));
  const env = { ...process.env, HOME: home, TMPDIR: `${tmp}/`, HEXVERO_CACHE_DIR: join(base, "cache", "hexvero") };
  // Variables that would change REA's behaviour stay as the caller set them; none is set here.
  delete env.FORCE_COLOR;
  env.NO_COLOR = "1";
  return env;
}

/** Deletes each tool's own caches. The operating system's file cache is not purged. */
export function dropCaches() {
  const base = scratch();
  rmSync(join(base, "cache", "hexvero"), { recursive: true, force: true });
  rmSync(join(base, "home", ".rea"), { recursive: true, force: true });
  rmSync(join(base, "home", ".cache"), { recursive: true, force: true });
  rmSync(join(base, "home", ".local"), { recursive: true, force: true });
  const tmp = join(base, "tmp");
  if (existsSync(tmp)) for (const name of readdirSync(tmp)) rmSync(join(tmp, name), { recursive: true, force: true });
}

/**
 * Sum of the resident set sizes of a process and all its descendants, in bytes; null on failure.
 * With `group`, every process of that process group counts too (a child whose parent has exited
 * is no longer a descendant, but keeps the group).
 */
function treeRss(rootPid, group) {
  return new Promise((done) => {
    execFile("ps", ["-axo", "pid=,ppid=,pgid=,rss="], { encoding: "utf8" }, (error, stdout) => {
      if (error) return done(null);
      const kids = new Map();
      const rss = new Map();
      const members = new Set();
      for (const line of stdout.split("\n")) {
        const [pid, ppid, pgid, kb] = line.trim().split(/\s+/).map(Number);
        if (!pid) continue;
        rss.set(pid, kb);
        if (group && pgid === group) members.add(pid);
        if (!kids.has(ppid)) kids.set(ppid, []);
        kids.get(ppid).push(pid);
      }
      const seen = new Set();
      const stack = [rootPid, ...members];
      while (stack.length) {
        const pid = stack.pop();
        if (seen.has(pid) || !rss.has(pid)) continue;
        seen.add(pid);
        for (const kid of kids.get(pid) ?? []) stack.push(kid);
      }
      let sum = 0;
      for (const pid of seen) sum += rss.get(pid);
      done({ bytes: sum * 1024, processes: seen.size });
    });
  });
}

/** Samples the process tree under a pid until stop() is called. */
export function watchTree(pid, { everyMs = 100, group = null } = {}) {
  let peak = 0;
  let processes = 0;
  let samples = 0;
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    const r = await treeRss(pid, group);
    busy = false;
    if (!r) return;
    samples++;
    if (r.bytes > peak) peak = r.bytes;
    if (r.processes > processes) processes = r.processes;
  };
  const timer = setInterval(tick, everyMs);
  tick();
  return () => {
    clearInterval(timer);
    return { treePeakRssBytes: peak, maxProcessesInTree: processes, rssSamples: samples };
  };
}

/**
 * Runs one command and measures it.
 *
 *   stdoutBytes / stderrBytes  what the caller receives on the two streams
 *   wallMs                     monotonic clock around the child
 *   maxRssBytes                `/usr/bin/time -l`: the largest single process (exact)
 *   treePeakRssBytes           sum over the process tree, sampled every 100 ms (can miss short peaks)
 *
 * stdout is written to `stdoutFile` when given (and still counted), otherwise kept in memory.
 */
export function measure(command, args, { env, stdoutFile, timeoutMs = 600_000 } = {}) {
  return new Promise((done) => {
    const t0 = performance.now();
    const child = spawn("/usr/bin/time", ["-l", command, ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    const fd = stdoutFile ? openSync(stdoutFile, "w") : null;
    const chunks = [];
    let stdoutBytes = 0;
    let firstByteMs = null;
    let err = "";
    let timedOut = false;
    const killer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      if (firstByteMs === null) firstByteMs = performance.now() - t0;
      stdoutBytes += d.length;
      if (fd !== null) writeSync(fd, d);
      else chunks.push(d);
    });
    child.stderr.on("data", (d) => {
      err += d;
    });
    const stop = watchTree(child.pid, { group: child.pid });
    child.on("close", (code, signal) => {
      clearTimeout(killer);
      const wallMs = performance.now() - t0;
      const tree = stop();
      if (fd !== null) closeSync(fd);
      // /usr/bin/time appends its report to stderr; split it off again.
      const at = err.search(/\n?\s*[\d.,]+ real\s+[\d.,]+ user\s+[\d.,]+ sys/);
      const toolErr = at === -1 ? err : err.slice(0, at);
      const report = at === -1 ? "" : err.slice(at);
      const num = (re) => {
        const m = report.match(re);
        return m ? Number(m[1].replace(",", ".")) : null;
      };
      done({
        exit: code,
        signal,
        timedOut,
        wallMs: Math.round(wallMs),
        firstByteMs: firstByteMs === null ? null : Math.round(firstByteMs),
        stdoutBytes,
        stderrBytes: Buffer.byteLength(toolErr),
        userS: num(/([\d.,]+) user/),
        sysS: num(/([\d.,]+) sys/),
        maxRssBytes: num(/(\d+)\s+maximum resident set size/),
        peakFootprintBytes: num(/(\d+)\s+peak memory footprint/),
        ...tree,
        stdout: fd === null ? Buffer.concat(chunks).toString("utf8") : null,
        stderr: toolErr,
      });
    });
  });
}

export const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
export const loadAvg = () =>
  new Promise((done) =>
    execFile("sysctl", ["-n", "vm.loadavg"], { encoding: "utf8" }, (e, out) =>
      done(e ? null : out.replace(/[{}]/g, "").trim().split(/\s+/).map((x) => Number(x.replace(",", ".")))),
    ),
  );
export const stats = (values) => {
  const v = values.filter((x) => typeof x === "number").toSorted((a, b) => a - b);
  if (!v.length) return null;
  const mid = v.length >> 1;
  return { n: v.length, min: v[0], median: v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2, max: v.at(-1) };
};
