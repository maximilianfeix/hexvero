#!/usr/bin/env node
/**
 * Builds summary.md from the raw results: correctness first, then cost.
 *
 *   node corpus/compare/summarize.mjs
 *
 * Reads results/scores/*.json, results/*.runs.jsonl, results/answers/*, results/mcp-catalog.json and
 * results/environment.json. The tables are generated; the closing sections come from
 * conclusions.md, which is written by hand from these tables.
 *
 * One thing the scorer cannot say is added here: a class REA was not run on. The scorer knows
 * NOT RUN for a whole native observation only, so for REA it counts an unasked call path as missed.
 * rea.observations.json lists those (input, class) pairs under `notRun` with the reason, and this
 * script shows them as NOT RUN instead of the scorer's count. The scorer's files stay untouched.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compareDir, readJson, resultsDir, stats } from "./lib/common.mjs";
import { QUESTIONS } from "./lib/plan.mjs";

const scoresDir = join(resultsDir, "scores");
const sets = ["dev", "validation", "holdout", "damaged"].filter((s) => existsSync(join(scoresDir, `hexvero.${s}.json`)));
const table = (head, lines) => [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`, ...lines.map((l) => `| ${l.join(" | ")} |`)].join("\n");
const hmf = (t) => (t ? `${t.hit} / ${t.missed} / ${t.false}${t.hedged ? ` (+${t.hedged} warned)` : ""}` : "");
const sum = (rows) => rows.reduce((t, r) => ({ hit: t.hit + r.hit, missed: t.missed + r.missed, false: t.false + r.false, hedged: t.hedged + (r.hedged ?? 0) }), { hit: 0, missed: 0, false: 0, hedged: 0 });
const mib = (b) => (b ? (b / 1048576).toFixed(0) : "");
const kb = (b) => (b >= 10_000_000 ? `${(b / 1e6).toFixed(1)} MB` : b >= 100_000 ? `${(b / 1000).toFixed(0)} kB` : b >= 10_000 ? `${(b / 1000).toFixed(1)} kB` : `${Math.round(b)} B`);

// ---- correctness ---------------------------------------------------------------------------
const reaObs = readJson(join(resultsDir, "rea.observations.json"));
const hexObs = readJson(join(resultsDir, "hexvero.observations.json"));
const notRun = reaObs.notRun ?? [];
const isNotRun = (input, klass) => notRun.find((n) => n.key === input && (n.class === "*" || n.class === klass));
const baseInput = (label) => label.replace(/ \([^)]*\)$/, "");
const engineOf = (label) => label.match(/ \(([^)]*)\)$/)?.[1] ?? null;

function correctness(reaFile = "rea") {
  const out = [];
  for (const set of sets) {
    const hex = readJson(join(scoresDir, `hexvero.${set}.json`)).rows;
    const rea = readJson(join(scoresDir, `${reaFile}.${set}.json`)).rows;
    const classes = [...new Set(hex.map((r) => r.class))];
    for (const klass of classes) {
      const hexRows = hex.filter((r) => r.class === klass);
      const engines = [...new Set(hexRows.map((r) => engineOf(r.input)))];
      const hexCell = engines
        .map((e) => `${e ? `${e}: ` : ""}${hmf(sum(hexRows.filter((r) => engineOf(r.input) === e)))}`)
        .join("<br>");
      // REA: the same inputs, each either scored or NOT RUN.
      const inputs = [...new Set(hexRows.map((r) => baseInput(r.input)))];
      const scored = [];
      const skipped = [];
      for (const input of inputs) {
        const found = rea.filter((r) => baseInput(r.input) === input && r.class === klass);
        const reason = isNotRun(input, klass) ?? found.map((r) => isNotRun(r.input, klass)).find(Boolean);
        if (reason) skipped.push(reason);
        else if (found.length) scored.push(...found);
        else {
          const whole = rea.find((r) => baseInput(r.input) === input && r.notes.some((n) => n.startsWith("NOT RUN")));
          skipped.push(isNotRun(input, "*") ?? { reason: whole ? whole.notes[0] : "no observation" });
        }
      }
      const reaCell = [scored.length ? hmf(sum(scored)) : null, skipped.length ? `NOT RUN${scored.length ? ` on ${skipped.length} of ${inputs.length}` : ""}` : null].filter(Boolean).join("; ");
      out.push({ set, klass, inputs: inputs.length, hexCell, reaCell, skipped });
    }
  }
  return out;
}
const rows = correctness();
const correctnessTable = table(
  ["set", "class", "inputs", "hexvero hit / missed / false", "REA hit / missed / false"],
  rows.map((r) => [r.set, r.klass, r.inputs, r.hexCell, r.reaCell]),
);
const reasonsByText = new Map();
for (const r of rows) for (const s of r.skipped) reasonsByText.set(s.reason, new Set([...(reasonsByText.get(s.reason) ?? []), r.klass]));
const notRunList = [...reasonsByText].map(([reason, classes]) => `- **${[...classes].join(", ")}**: ${reason}`).join("\n");

let altTable = "";
if (existsSync(join(scoresDir, `rea.alt-store.${sets[0]}.json`))) {
  const alt = correctness("rea.alt-store");
  const differing = alt.filter((a, i) => a.reaCell !== rows[i].reaCell);
  altTable = table(
    ["set", "class", "REA, default mapping", "REA, store calls read as storage keys"],
    differing.map((a) => [a.set, a.klass, rows.find((r) => r.set === a.set && r.klass === a.klass).reaCell, a.reaCell]),
  );
}

// Expected items one tool reported and the other did not, from the scorer's notes. For senders and
// receivers an item counts for a tool only if that tool found the channel at all.
function foundByOne() {
  const lines = [];
  const bag = (list) => {
    const m = new Map();
    for (const x of list) m.set(x, (m.get(x) ?? 0) + 1);
    return m;
  };
  const minus = (a, b) => [...a].flatMap(([k, n]) => Array(Math.max(0, n - (b.get(k) ?? 0))).fill(k));
  const missedOf = (row) =>
    row.notes
      .filter((n) => /^missed /.test(n) || / missed$/.test(n))
      .map((n) => n.replace(/^missed /, "").replace(/ missed$/, ""));
  for (const set of sets.filter((x) => x !== "damaged")) {
    const hex = readJson(join(scoresDir, `hexvero.${set}.json`)).rows;
    const rea = readJson(join(scoresDir, `rea.${set}.json`)).rows;
    const byClass = new Map();
    for (const h of hex) {
      if (engineOf(h.input) || isNotRun(h.input, h.class) || isNotRun(h.input, "*")) continue;
      const r = rea.find((x) => x.input === h.input && x.class === h.class);
      if (!r || !h.notes.concat(r.notes).some((n) => /missed/.test(n))) continue;
      let hm = missedOf(h);
      let rm = missedOf(r);
      if (h.class === "IPC senders and receivers") {
        const channelsMissed = (rows) => new Set(missedOf(rows.find((x) => x.input === h.input && x.class === "IPC channels") ?? { notes: [] }));
        const hc = channelsMissed(hex);
        const rc = channelsMissed(rea);
        const channel = (item) => item.replace(/: (sender|receiver) .*$/, "");
        // A role one tool missed is "found by the other" only if the other has the channel.
        hm = hm.filter((i) => !rc.has(channel(i)));
        rm = rm.filter((i) => !hc.has(channel(i)));
      }
      const onlyHex = minus(bag(rm), bag(hm));
      const onlyRea = minus(bag(hm), bag(rm));
      const e = byClass.get(h.class) ?? { onlyHex: [], onlyRea: [] };
      const short = h.input.split("/").at(-1).replace(/\.asar/g, "");
      e.onlyHex.push(...onlyHex.map((i) => `${i} (${short})`));
      e.onlyRea.push(...onlyRea.map((i) => `${i} (${short})`));
      byClass.set(h.class, e);
    }
    for (const [klass, e] of byClass)
      if (e.onlyHex.length || e.onlyRea.length)
        lines.push([set, klass, e.onlyHex.length, e.onlyRea.length, e.onlyRea.length ? e.onlyRea.map((i) => `\`${i.replaceAll("|", "\\|")}\``).join(", ") : ""]);
  }
  return table(["set", "class", "expected items hexvero reported and REA did not", "expected items REA reported and hexvero did not", "the latter, listed"], lines);
}
const foundByOneTable = foundByOne();

// REA's own words on the version comparisons, unmapped.
const literal = Object.entries(reaObs.observations)
  .filter(([k, v]) => k.startsWith("compare:") && v.compare?.literal)
  .map(([k, v]) => {
    const s = v.compare.literal.summary;
    return [k.replace("compare:", "").replace("|", " → "), s.added, s.removed, s.changed, s.unknown, s.unchanged, v.compare.literal.coverage];
  });

// ---- cost ----------------------------------------------------------------------------------
const readRuns = (file) =>
  existsSync(join(resultsDir, file))
    ? readFileSync(join(resultsDir, file), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];
const answerScores = (via, tool, variant) => {
  const all = [];
  for (const set of sets) {
    const f = join(scoresDir, "answers", `${via}.${tool}.${variant}.${set}.json`);
    if (existsSync(f)) all.push(...readJson(f).rows);
  }
  return all;
};
const answerFile = (via, tool, variant) => {
  const f = join(resultsDir, "answers", `${via}.${tool}.${variant}.json`);
  return existsSync(f) ? readJson(f).observations : {};
};
const classesOf = (q, row) => (QUESTIONS[q].classes ? QUESTIONS[q].classes.includes(row.class) : row.class.startsWith("changes in"));

const clean = (s) => String(s).replaceAll("|", "\\|").replaceAll("\n", " ");
function costTable(via) {
  const runs = readRuns(`${via}.runs.jsonl`);
  if (!runs.length) return { text: "_not run_", perUnit: "", loads: null, runs: 0 };
  const lines = [];
  const perUnit = [];
  for (const q of Object.keys(QUESTIONS)) {
    const forQ = runs.filter((r) => r.questions.includes(q));
    const groups = [...new Set(forQ.map((r) => `${r.tool}\u0000${r.variant}`))];
    for (const g of groups) {
      const [tool, variant] = g.split("\u0000");
      const mine = forQ.filter((r) => r.tool === tool && r.variant === variant);
      const units = [...new Set(mine.map((r) => r.unit))];
      const fileVariant = variant === "radare2" || variant === "rizin" ? "default" : variant;
      const scored = answerScores(via, tool, fileVariant);
      const answers = answerFile(via, tool, fileVariant);
      const name = `${tool}${variant === "default" ? "" : ` (${variant})`}`;
      const unitStats = units.map((unit) => {
        const u = mine.filter((r) => r.unit === unit);
        const cold = stats(u.filter((r) => r.phase === "cold").map((r) => r.wallMs));
        const warm = stats(u.filter((r) => r.phase === "warm").map((r) => r.wallMs));
        const first = u[0];
        const electron = answers[unit]?.electron;
        // A class the returned output cannot hold is left out here and named in the README.
        const usable = scored.filter(
          (r) =>
            r.input === unit &&
            classesOf(q, r) &&
            !(r.class === "requests with an unknown URL shown" && electron?.endpointsUnreadableKnown === false) &&
            !(tool === "rea" && r.class === "bridge member channel"),
        );
        const total = sum(usable);
        const countsOnly = electron?.answerKind === "counts only";
        const stat = {
          calls: first.callCount,
          bytes: first.bytesToCaller,
          text: first.textBytes ?? null,
          files: first.bytesToFiles ?? 0,
          cold,
          warm,
          rss: Math.max(...u.map((r) => r.treePeakRssBytes ?? 0)),
          failed: u.filter((r) => !r.ok).length,
          runs: u.length,
          total,
          countsOnly,
          exact: !countsOnly && usable.length > 0 && total.missed === 0 && total.false === 0 && !total.hedged,
        };
        perUnit.push([q, name, unit, stat.calls, stat.bytes, stat.files || "", cold ? `${cold.min} / ${cold.median} / ${cold.max}` : "", warm ? `${warm.min} / ${warm.median} / ${warm.max}` : "", mib(stat.rss), stat.runs, stat.failed || "", countsOnly ? "counts only" : hmf(total)]);
        return stat;
      });
      const b = stats(unitStats.map((u) => u.bytes));
      const cold = stats(unitStats.map((u) => u.cold?.median));
      const warm = stats(unitStats.map((u) => u.warm?.median));
      const total = sum(unitStats.map((u) => u.total));
      const answer = unitStats.every((u) => u.countsOnly)
        ? `counts only, no names: 0 / ${total.missed} / 0`
        : `${hmf(total)}; ${unitStats.filter((u) => u.exact).length} of ${units.length} units exact`;
      lines.push([
        q,
        name,
        units.length,
        [...new Set(unitStats.map((u) => u.calls))].toSorted((x, y) => x - y).join(", "),
        `${kb(b.median)} (${kb(b.min)}–${kb(b.max)})`,
        ...(via === "mcp" ? [kb(stats(unitStats.map((u) => u.text)).median)] : []),
        unitStats.some((u) => u.files) ? kb(stats(unitStats.map((u) => u.files)).median) : "",
        cold ? `${Math.round(cold.median)} (${Math.round(cold.min)}–${Math.round(cold.max)})` : "",
        warm ? `${Math.round(warm.median)} (${Math.round(warm.min)}–${Math.round(warm.max)})` : "",
        mib(Math.max(...unitStats.map((u) => u.rss))),
        unitStats.reduce((n, u) => n + u.failed, 0),
        answer,
      ]);
    }
  }
  // Runs in which a call failed: which, how often, and the first error.
  const failures = new Map();
  for (const r of runs.filter((x) => !x.ok)) {
    const key = `${r.tool} (${r.variant})\u0000${r.unit}`;
    const f = failures.get(key) ?? { n: 0, error: r.errors[0] ?? "" };
    f.n++;
    failures.set(key, f);
  }
  const failureTable = failures.size
    ? table(["tool (way)", "unit", "failed runs", "first error"], [...failures].map(([k, f]) => [...k.split("\u0000"), f.n, clean(String(f.error).replace(/\s+/g, " ").slice(0, 260))]))
    : "_none_";
  const blockedFile = join(resultsDir, "answers", `${via}.blocked.json`);
  const head = ["question", "tool (way)", "units", "calls per unit", "bytes returned per unit, median (min–max)", ...(via === "mcp" ? ["one copy of the payload (text), median"] : []), "bytes written to side files, median", "cold ms per unit, median (min–max of unit medians)", "warm ms per unit, median (min–max)", "peak RSS of the process tree, MiB (max)", "failed runs", "answer by the scorer: hit / missed / false"];
  return {
    text: table(head, lines),
    perUnit: table(["question", "tool (way)", "unit", "calls", "bytes returned", "bytes to side files", "cold ms min / median / max", "warm ms min / median / max", "peak tree RSS MiB", "runs", "failed", "answer hit / missed / false"], perUnit),
    blocked: existsSync(blockedFile) ? readJson(blockedFile) : [],
    failureTable,
    loads: stats(runs.map((r) => r.load1)),
    runs: runs.length,
    from: runs[0].at,
    to: runs.at(-1).at,
    unstable: runs.filter((r) => r.answerStable === false).length,
  };
}
const cli = costTable("cli");
const mcp = costTable("mcp");
const blockedText = (b) =>
  (b ?? []).length
    ? table(
        ["tool", "question", "unit", "status", "reason", "attempt"],
        b.map((x) => [x.tool, x.question, x.unit, x.status, clean(x.reason), x.attempt ? (Array.isArray(x.attempt) ? x.attempt.map((c) => `${c.tool}: ${c.isError ? "error" : "ok"}, ${c.resultBytes} B, ${c.ms} ms`).join("; ") : `\`${clean(x.attempt.command)}\`: exit ${x.attempt.exit}, ${x.attempt.stdoutBytes} B, ${x.attempt.wallMs} ms`) : ""]),
      )
    : "_none_";

// ---- fixed cost and environment ----------------------------------------------------------------
const catalogFile = join(resultsDir, "mcp-catalog.json");
const catalog = existsSync(catalogFile) ? readJson(catalogFile) : null;
const catalogTable = catalog
  ? table(
      ["server", "tools", "tools/list result, bytes", "of which input schemas", "output schemas", "descriptions", "instructions (initialize), bytes", "start + initialize ms, median (min–max)", "tools/list ms, median"],
      catalog.servers.map((s) => [s.label, s.tools, s.toolsListResultBytes, s.inputSchemaBytes, s.outputSchemaBytes, s.descriptionBytes, s.instructionsBytes, `${s.connectMs.median} (${s.connectMs.min}–${s.connectMs.max})`, s.toolsListMs.median]),
    )
  : "_not measured_";
const envFile = join(resultsDir, "environment.json");
const env = existsSync(envFile) ? readJson(envFile) : null;
const loadNote = (c) => (c.loads ? `${c.runs} runs from ${c.from} to ${c.to}; 1-minute load average at the start of a run: min ${c.loads.min}, median ${c.loads.median}, max ${c.loads.max}` : "not run");
const loaded = [cli, mcp].some((c) => c.loads && c.loads.median > 4);

const conclusionsFile = join(compareDir, "conclusions.md");
const conclusions = existsSync(conclusionsFile) ? readFileSync(conclusionsFile, "utf8") : "_conclusions.md is missing_\n";

const md = `# hexvero ${hexObs.tool.commit} and REA ${reaObs.tool.version} on the hexvero corpus

Generated by \`corpus/compare/summarize.mjs\` from the files in \`results/\`. Method, mapping decisions and
limits: [README.md](README.md). Sets scored: ${sets.join(", ")}.${env ? ` Run on ${env.before.local}; ${env.machine.cpu}, ${(env.machine.memoryBytes / 2 ** 30).toFixed(0)} GiB, ${env.os.name} ${env.os.version}, Node ${env.node.version}.` : ""}

## 1. Correctness, per class and set

hit = an expected item the tool reported; missed = an expected item it did not report; false = a
reported item the expectations rule out. Classes are never added up. hexvero's native rows are per
engine. NOT RUN = the tool was not asked, for the reason listed below the table; it is not a zero.

${correctnessTable}

### NOT RUN, with reasons

${notRunList || "_none_"}

### Expected items only one tool reported

From the scorer's notes, for the classes both tools were scored on. A row is missing when both tools
missed the same items or none.

${foundByOneTable}

### REA's version comparisons in its own words

The table above maps REA's comparison generously (README, "Mapping decisions"). Unmapped, REA's own
classification of the compared items is:

${table(["pair", "added", "removed", "changed", "unknown", "unchanged", "coverage"], literal)}

${altTable ? `### The one mapping decision that changes counts\n\nREA reports calls like \`store.get("window.bounds")\` as network endpoints. The default mapping keeps REA's heading (a false endpoint, a missed storage key). Read instead as electron-store keys, the rows that change are:\n\n${altTable}\n` : ""}
## 2. Cost per question, command line

${loadNote(cli)}.${loaded ? " **Timings were taken under load; see section 5.**" : ""}
A unit is one input (Q1–Q3), one pair of builds (Q4) or one binary and engine (Q5). REA's three ways
for Q1–Q3 run the same calls whatever the question, so they were measured once and appear in each row.
"Bytes returned" is what the caller receives on stdout; REA's summary way writes the complete Evidence
to a file first (next column), as its documentation does.

${cli.text}

Runs with a failed call on the command line:

${cli.failureTable}

Not run or blocked on the command line:

${blockedText(cli.blocked)}

## 3. Cost per question, MCP over stdio

${loadNote(mcp)}.${loaded ? " **Timings were taken under load; see section 5.**" : ""}
One session per run: start the server, initialize, the calls, close; the times include the server
start. \`tools/list\` is not included (section 4). "Bytes returned" is the JSON-RPC result; REA sends
each payload twice in it (text and structuredContent), the next column counts one copy.

${mcp.text}

Runs with a failed call over MCP:

${mcp.failureTable}

Not run or blocked over MCP:

${blockedText(mcp.blocked)}

## 4. Fixed cost of an MCP session

${catalogTable}

## 5. Load during the timed runs

${env ? `Before: \`${env.before.uptime}\`. After: \`${env.after?.uptime ?? "not recorded"}\`.` : ""}

- Command line: ${loadNote(cli)}.
- MCP: ${loadNote(mcp)}.

${loaded ? "The median 1-minute load average was above 4. Every timing in sections 2 to 4 was **taken under this load**. The runs of the two tools alternate, so both were hit by it, but the times are not a statement about either tool's speed on a quiet machine." : "The machine was calm (median load at most 4)."}
The operating system's file cache was not purged before cold runs. Answers that differed between
repeated runs of the same calls: command line ${cli.unstable ?? 0}, MCP ${mcp.unstable ?? 0}.

${conclusions}`;
writeFileSync(join(compareDir, "summary.md"), md);
writeFileSync(join(resultsDir, "cost-per-unit.md"), `# Cost per unit\n\nEvery unit of every question; times are min / median / max over the repeated runs.\n\n## Command line\n\n${cli.perUnit}\n\n## MCP\n\n${mcp.perUnit}\n`);
console.log(`summary.md written: ${rows.length} correctness rows, ${cli.runs} cli runs, ${mcp.runs} mcp runs`);
