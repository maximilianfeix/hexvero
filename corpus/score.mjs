#!/usr/bin/env node
/**
 * Scores a tool's observations against the corpus expectations.
 *
 *   node corpus/score.mjs corpus/results/hexvero.observations.json [--set dev|validation|damaged]
 *        [--json out.json] [--markdown out.md]
 *
 * Per class of finding it counts, for each input:
 *   hit      an expected item the tool reported
 *   missed   an expected item the tool did not report
 *   false    an item the tool reported that the expectations rule out: one listed as absent, or
 *            any unlisted item when the class is marked exhaustive
 * Classes are never added up into one score: a missed IPC channel and a missed storage key are
 * different failures. Attribute checks (who sends, which channel a bridge member forwards to,
 * which HTTP method) are counted separately and only for items that were found.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { loadCases } from "./cases.mjs";

const file = process.argv[2];
if (!file) {
  console.error(
    "usage: node corpus/score.mjs <observations.json> [--set name] [--json f] [--markdown f]",
  );
  process.exit(2);
}
const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
};
const { tool, observations } = JSON.parse(readFileSync(file, "utf8"));
const sets = arg("set")
  ? [arg("set")]
  : ["dev", "validation", "holdout", "holdout2", "holdout3", "holdout4", "holdout5", "holdout6", "damaged"];

const rows = [];
const add = (set, input, klass, counts, notes = []) =>
  rows.push({ set, input, class: klass, hit: 0, missed: 0, false: 0, ...counts, notes });

/** Set comparison: expected present, expected absent, observed; all as plain keys. */
function sets3(present, absent, observed, exhaustive) {
  const seen = new Set(observed);
  const hit = present.filter((p) => seen.has(p));
  const missed = present.filter((p) => !seen.has(p));
  const want = new Set(present);
  const ruledOut = new Set(absent);
  const wrong = [...seen].filter((o) => ruledOut.has(o) || (exhaustive && !want.has(o)));
  return { hit, missed, wrong };
}
const fileName = (f) => String(f).split(/[\\/]/).at(-1);
/**
 * The window settings every expected.json lists. A case may list more keys (holdout3 lists
 * `webSecurity`); those are scored for that case too.
 */
const SCORED_SETTINGS = new Set(["preload", "contextIsolation", "nodeIntegration", "sandbox"]);
const bare = (name) =>
  String(name)
    .replace(/^(sym\.imp\.|sym\.|imp\.)/, "")
    .replace(/^_+/, "");

/**
 * A case may attribute facts to source modules that a bundler merges into an entry file. Its
 * `bundledFiles` maps each module to that file (holdout5); for an input that is not the plain
 * build, expected file names are mapped through it before they are compared. A module merged
 * into more than one entry file keeps its own name (no scored fact names one).
 */
function fileMap(c, input) {
  if (!c.bundledFiles || /\.plain\.asar$/.test(input)) return (f) => f;
  const map = new Map(
    Object.entries(c.bundledFiles).flatMap(([module, entry]) => {
      const entries = String(entry).match(/[\w./-]+\.js\b/g) ?? [];
      return entries.length === 1 ? [[module, entries[0]]] : [];
    }),
  );
  return (f) => map.get(f) ?? f;
}

function scoreElectron(c, input, o) {
  const e = c.expect;
  const where = [c.set, input];
  const mapFile = fileMap(c, input);
  if (e.ipcChannels) {
    const got = new Map(o.ipcChannels.map((x) => [x.channel, x]));
    const s = sets3(
      e.ipcChannels.present.map((p) => p.channel),
      e.ipcChannels.absent.map((a) => a.channel),
      [...got.keys()],
      e.ipcChannels.exhaustive,
    );
    add(
      ...where,
      "IPC channels",
      { hit: s.hit.length, missed: s.missed.length, false: s.wrong.length },
      [...s.missed.map((m) => `missed ${m}`), ...s.wrong.map((w) => `false ${w}`)],
    );
    // Who sends and who receives, for channels that were found.
    let right = 0;
    let lost = 0;
    let extra = 0;
    const notes = [];
    for (const p of e.ipcChannels.present) {
      const g = got.get(p.channel);
      if (!g) continue;
      for (const role of ["senders", "receivers"]) {
        const s2 = sets3(
          [...new Set(p[role].map((f) => fileName(mapFile(f))))],
          [],
          (g[role] ?? []).map(fileName),
          true,
        );
        right += s2.hit.length;
        lost += s2.missed.length;
        extra += s2.wrong.length;
        notes.push(...s2.missed.map((m) => `${p.channel}: ${role.slice(0, -1)} ${m} missed`));
        notes.push(...s2.wrong.map((w) => `${p.channel}: ${role.slice(0, -1)} ${w} false`));
      }
    }
    add(...where, "IPC senders and receivers", { hit: right, missed: lost, false: extra }, notes);
    // A channel whose name only exists at run time (holdout5: `unknown`, a number of channels).
    // A tool shows it by listing IPC calls without a channel; such calls cannot be grouped into
    // channels, so the row asks only whether any is shown: all `unknown` hit if at least one
    // call is, all missed if none is; one false if the case has none and the tool shows some.
    if (e.ipcChannels.unknown !== undefined) {
      const shown = o.ipcUnreadable?.length ?? 0;
      const want = e.ipcChannels.unknown;
      add(
        ...where,
        "IPC channels with an unknown name shown",
        {
          hit: want && shown ? want : 0,
          missed: want && !shown ? want : 0,
          false: !want && shown ? 1 : 0,
        },
        shown ? [`${shown} call(s) without a channel: ${o.ipcUnreadable.join(", ")}`] : [],
      );
    }
  }
  if (e.webPreferences) {
    // A multiset: the same key and value may be set for two windows.
    const key = (w) =>
      `${fileName(w.file)} ${w.key}=${w.key === "preload" ? fileName(w.value) : w.value}`;
    const want = e.webPreferences.present.map((w) => key({ ...w, file: mapFile(w.file) }));
    // Scored: a literal value for one of the keys the case lists (at least the four every
    // expected.json lists). A row with
    // another key has no written-down result to be checked against, and a row whose value is
    // null says the value is computed at run time, which the results deliberately do not list.
    // Neither is a claimed value: both are counted in the notes and nowhere else.
    const listed = new Set([
      ...SCORED_SETTINGS,
      ...e.webPreferences.present.map((w) => w.key),
      ...(e.webPreferences.absent ?? []).map((w) => w.key),
    ]);
    const scored = o.webPreferences.filter((w) => w.value !== null && listed.has(w.key));
    const otherKeys = o.webPreferences.filter((w) => !listed.has(w.key)).length;
    const computed = o.webPreferences.filter((w) => w.value === null && listed.has(w.key)).length;
    const have = scored.map(key);
    const left = [...have];
    const missed = [];
    let hit = 0;
    for (const w of want) {
      const i = left.indexOf(w);
      if (i === -1) missed.push(w);
      else {
        hit++;
        left.splice(i, 1);
      }
    }
    add(...where, "window settings", { hit, missed: missed.length, false: left.length }, [
      ...missed.map((m) => `missed ${m}`),
      ...left.map((w) => `false ${w}`),
      ...(otherKeys ? [`not scored: ${otherKeys} row(s) with other keys`] : []),
      ...(computed ? [`not scored: ${computed} row(s) with a computed value`] : []),
    ]);
  }
  if (e.contextBridge) {
    const key = (b) => `${b.api}.${b.member}`;
    const got = new Map(o.contextBridge.filter((b) => b.member !== null).map((b) => [key(b), b]));
    const s = sets3(
      e.contextBridge.present.map(key),
      e.contextBridge.absent.map(key),
      [...got.keys()],
      e.contextBridge.exhaustive,
    );
    const unread = o.contextBridge.filter((b) => b.member === null).length;
    add(
      ...where,
      "bridge members",
      { hit: s.hit.length, missed: s.missed.length, false: s.wrong.length },
      [
        ...s.missed.map((m) => `missed ${m}`),
        ...s.wrong.map((w) => `false ${w}`),
        ...(unread ? [`${unread} entr${unread === 1 ? "y" : "ies"} reported as unreadable`] : []),
      ],
    );
    const found = e.contextBridge.present.filter((p) => got.has(key(p)));
    const wrong = found.filter((p) => (got.get(key(p)).channel ?? null) !== (p.channel ?? null));
    add(
      ...where,
      "bridge member channel",
      { hit: found.length - wrong.length, missed: wrong.length, false: 0 },
      wrong.map((p) => `${key(p)}: expected ${p.channel}, got ${got.get(key(p)).channel}`),
    );
  }
  if (e.endpoints) {
    const values = o.endpoints.map((x) => x.value);
    const matches = (p, v) => (p.value !== undefined ? v === p.value : v.startsWith(p.prefix));
    const name = (p) => p.value ?? `${p.prefix}…`;
    const found = e.endpoints.present.filter((p) => values.some((v) => matches(p, v)));
    const missed = e.endpoints.present.filter((p) => !found.includes(p));
    const absent = new Set(e.endpoints.absent.map((a) => a.value));
    const wrong = [...new Set(values)].filter(
      (v) =>
        absent.has(v) ||
        (e.endpoints.exhaustive && !e.endpoints.present.some((p) => matches(p, v))),
    );
    add(...where, "endpoints", { hit: found.length, missed: missed.length, false: wrong.length }, [
      ...missed.map((m) => `missed ${name(m)}`),
      ...wrong.map((w) => `false ${w}`),
    ]);
    const withMethod = found.filter((p) => p.method);
    const badMethod = withMethod.filter(
      (p) =>
        !o.endpoints.some(
          (x) => matches(p, x.value) && String(x.method ?? "").toUpperCase() === p.method,
        ),
    );
    if (withMethod.length)
      add(
        ...where,
        "endpoint method",
        { hit: withMethod.length - badMethod.length, missed: badMethod.length, false: 0 },
        badMethod.map((p) => `${name(p)}: expected ${p.method}`),
      );
    if (e.endpoints.unreadable !== undefined)
      add(...where, "requests with an unknown URL shown", {
        hit: Math.min(e.endpoints.unreadable, o.endpointsUnreadable ?? 0),
        missed: Math.max(0, e.endpoints.unreadable - (o.endpointsUnreadable ?? 0)),
        false: Math.max(0, (o.endpointsUnreadable ?? 0) - e.endpoints.unreadable),
      });
  }
  if (e.storage) {
    const key = (s) => `${s.kind} ${s.value}`;
    const got = new Map(o.storage.map((s) => [key(s), s]));
    const absentValues = new Set(e.storage.absent.map((a) => a.value));
    const want = new Set(e.storage.present.map(key));
    const found = e.storage.present.filter((p) => got.has(key(p)));
    const missed = e.storage.present.filter((p) => !got.has(key(p)));
    const wrong = [...got.values()].filter(
      (s) => absentValues.has(s.value) || (e.storage.exhaustive && !want.has(key(s))),
    );
    add(
      ...where,
      "storage keys",
      { hit: found.length, missed: missed.length, false: wrong.length },
      [...missed.map((m) => `missed ${key(m)}`), ...wrong.map((w) => `false ${key(w)}`)],
    );
    const withOps = found.filter((p) => p.ops);
    // The operations must be the same set: reporting a write that does not happen is as wrong
    // as missing one that does.
    const sameOps = (p) => {
      const got2 = new Set(got.get(key(p)).ops ?? []);
      return got2.size === p.ops.length && p.ops.every((op) => got2.has(op));
    };
    const badOps = withOps.filter((p) => !sameOps(p));
    if (withOps.length)
      add(
        ...where,
        "storage read/write/delete",
        { hit: withOps.length - badOps.length, missed: badOps.length, false: 0 },
        badOps.map(
          (p) =>
            `${key(p)}: expected ${p.ops.join("+")}, got ${(got.get(key(p)).ops ?? []).join("+") || "none"}`,
        ),
      );
  }
  if (o.complete === false) rows.at(-1).notes.push("tool reported the analysis as partial");
}

function scoreCompare(c, o) {
  for (const [name, want] of Object.entries(c.expect.compare)) {
    const got = o[name];
    const tag = (x) => [
      ...(x.added ?? []).map((v) => `+${v}`),
      ...(x.removed ?? []).map((v) => `-${v}`),
      ...(x.changed ?? []).map((v) => `~${v}`),
    ];
    if (!got) {
      add(c.set, `${c.a} → ${c.b}`, `changes in ${name}`, { missed: tag(want).length }, [
        "the tool has no such list",
      ]);
      continue;
    }
    // An expected endpoint may be the known leading part of an address that ends in run-time
    // text (as in the single-build expectations): a reported address that starts with it counts.
    const expected = tag(want);
    const reported =
      name === "endpoints"
        ? tag(got).map(
            (g) => expected.find((e) => e[0] === g[0] && g.slice(1).startsWith(e.slice(1))) ?? g,
          )
        : tag(got);
    const s = sets3(expected, [], [...new Set(reported)], true);
    add(
      c.set,
      `${c.a} → ${c.b}`,
      `changes in ${name}`,
      { hit: s.hit.length, missed: s.missed.length, false: s.wrong.length },
      [...s.missed.map((m) => `missed ${m}`), ...s.wrong.map((w) => `false ${w}`)],
    );
  }
}

function scoreNative(c, input, engine, o) {
  const where = [c.set, `${input} (${engine})`];
  if (o.status !== "RUN") {
    add(...where, "native analysis", {}, [`${o.status}: ${o.reason}`]);
    return;
  }
  const e = c.expect;
  if (e.imports) {
    // Some imports depend on the build (a fortified variant at -O0): listed per input.
    const present = [...e.imports.present, ...(e.imports.presentByInput?.[input] ?? [])];
    const s = sets3(present, e.imports.absent ?? [], o.imports.map(bare), false);
    add(
      ...where,
      "imports",
      { hit: s.hit.length, missed: s.missed.length, false: s.wrong.length },
      [...s.missed.map((m) => `missed ${m}`), ...s.wrong.map((w) => `false ${w}`)],
    );
  }
  if (e.functions) {
    const s = sets3(e.functions.present, [], o.functions.map(bare), false);
    add(
      ...where,
      "functions",
      { hit: s.hit.length, missed: s.missed.length },
      s.missed.map((m) => `missed ${m}`),
    );
  }
  if (e.paths) {
    // Four outcomes, kept apart: a wrong "no path" that carries a warning is not the same as one
    // stated flatly, and neither is a correct answer.
    const count = { hit: 0, missed: 0, false: 0, hedged: 0 };
    const notes = [];
    for (const q of e.paths) {
      const g = o.paths.find((p) => p.from === q.from && p.to === q.to);
      const label = `${q.from} → ${q.to}`;
      if (!g) {
        count.missed++;
        notes.push(`${label}: no answer`);
      } else if (q.expect === "path") {
        if (g.found) count.hit++;
        else if (g.hedged) {
          count.hedged++;
          notes.push(
            `${label}: path not found, answer carries a warning (${(g.limitations ?? []).join(", ")})`,
          );
        } else {
          count.missed++;
          notes.push(
            `${label}: path not found, stated without warning${g.unresolved ? ` (no function ${g.unresolved})` : ""}`,
          );
        }
      } else if (g.unresolved) {
        // "No path" from a tool that did not even find the function is not an answer.
        count.missed++;
        notes.push(`${label}: not answered (no function ${g.unresolved})`);
      } else if (g.found) {
        count.false++;
        notes.push(
          `${label}: a path was reported that does not exist (${(g.path ?? []).join(" → ")})`,
        );
      } else count.hit++;
    }
    add(...where, "call paths", count, notes);
  }
  if (e.callers) {
    const count = { hit: 0, missed: 0, false: 0 };
    const notes = [];
    for (const q of e.callers) {
      const g = o.callers.find((x) => x.of === q.of);
      if (!g || g.callers === null) {
        count.missed += Math.max(1, q.expect.length);
        notes.push(`${q.of}: function not found`);
        continue;
      }
      // A caller that reaches the function through a pointer is true but not a direct call:
      // reporting it is not an error, and it is noted rather than counted.
      const indirect = g.callers.map(bare).filter((x) => (q.indirect ?? []).includes(x));
      if (indirect.length) notes.push(`${q.of}: indirect caller ${indirect.join(", ")} reported`);
      const s = sets3(
        q.expect,
        [],
        g.callers.map(bare).filter((x) => !indirect.includes(x)),
        true,
      );
      count.hit += s.hit.length + (q.expect.length === 0 && s.wrong.length === 0 ? 1 : 0);
      count.missed += s.missed.length;
      count.false += s.wrong.length;
      notes.push(
        ...s.missed.map((m) => `${q.of}: caller ${m} missed`),
        ...s.wrong.map((w) => `${q.of}: caller ${w} false`),
      );
    }
    add(...where, "direct callers", count, notes);
  }
  if (o.limitations?.length)
    rows.at(-1).notes.push(`graph limitations: ${o.limitations.join(", ")}`);
}

for (const c of loadCases(sets)) {
  // A comparison case that also lists the single-build facts of its later input (holdout5) has
  // that input scored like an Electron case.
  if (c.kind === "compare" && c.inputs && c.expect.ipcChannels)
    for (const input of c.inputs) {
      const o = observations[input]?.electron;
      if (o) scoreElectron(c, input, o);
      else add(c.set, input, "electron analysis", {}, ["NOT RUN: no observation"]);
    }
  if (c.kind === "electron")
    for (const input of c.inputs) {
      const o = observations[input]?.electron;
      if (o) scoreElectron(c, input, o);
      else add(c.set, input, "electron analysis", {}, ["NOT RUN: no observation"]);
    }
  else if (c.kind === "compare") {
    const o = observations[`compare:${c.a}|${c.b}`]?.compare;
    if (o) scoreCompare(c, o);
    else add(c.set, `${c.a} → ${c.b}`, "comparison", {}, ["NOT RUN: no observation"]);
  } else if (c.kind === "native") {
    for (const input of c.inputs) {
      const keys = Object.keys(observations).filter((k) => k.startsWith(`native:${input}:`));
      if (!keys.length) add(c.set, input, "native analysis", {}, ["NOT RUN: no observation"]);
      for (const k of keys) scoreNative(c, input, k.split(":").at(-1), observations[k].native);
    }
  } else if (c.kind === "robustness")
    for (const r of c.expect.robustness) {
      const o = observations[`robust:${r.input}`]?.robust;
      if (!o) add(c.set, r.input, "damaged input", {}, ["NOT RUN: no observation"]);
      else {
        // "flagged" counts only when the limitation is about what is wrong with this input:
        // any unrelated limitation would otherwise let a damaged file pass.
        const named =
          o.outcome !== "flagged" ||
          !r.mustMention ||
          (o.limitations ?? []).some((code) => r.mustMention.some((m) => code.includes(m)));
        const ok = r.allowed.includes(o.outcome) && named;
        add(c.set, r.input, "damaged input", ok ? { hit: 1 } : { false: 1 }, [
          `${o.outcome}${o.code ? ` ${o.code}` : ""}${o.limitations?.length ? ` (${o.limitations.join(", ")})` : ""}${ok ? "" : `; allowed: ${r.allowed.join(" or ")}${r.mustMention ? `, naming ${r.mustMention.join(" or ")}` : ""}`}`,
        ]);
      }
    }
}

// Totals per set and class; never across classes.
const totals = new Map();
for (const r of rows) {
  const key = `${r.set}\u0000${r.class}`;
  const t = totals.get(key) ?? {
    set: r.set,
    class: r.class,
    hit: 0,
    missed: 0,
    false: 0,
    hedged: 0,
    inputs: 0,
  };
  t.hit += r.hit;
  t.missed += r.missed;
  t.false += r.false;
  t.hedged += r.hedged ?? 0;
  t.inputs++;
  totals.set(key, t);
}
const table = (head, lines) =>
  [
    `| ${head.join(" | ")} |`,
    `| ${head.map(() => "---").join(" | ")} |`,
    ...lines.map((l) => `| ${l.join(" | ")} |`),
  ].join("\n");
const md = [
  `# ${tool.name} ${tool.version ?? ""} on the hexvero corpus`,
  "",
  `Tool: ${Object.entries(tool)
    .map(([k, v]) => `${k} ${typeof v === "object" ? JSON.stringify(v) : v}`)
    .join(" · ")}`,
  "",
  "## Per class",
  "",
  table(
    ["set", "class", "inputs", "hit", "missed", "false", "not found but warned"],
    [...totals.values()].map((t) => [
      t.set,
      t.class,
      t.inputs,
      t.hit,
      t.missed,
      t.false,
      t.hedged || "",
    ]),
  ),
  "",
  "## Per input",
  "",
  table(
    ["set", "input", "class", "hit", "missed", "false", "notes"],
    rows.map((r) => [
      r.set,
      r.input,
      r.class,
      r.hit,
      r.missed,
      r.false,
      [r.hedged ? `${r.hedged} not found but warned` : "", ...r.notes]
        .filter(Boolean)
        .join("; ")
        .replaceAll("|", "\\|"),
    ]),
  ),
  "",
].join("\n");
if (arg("markdown")) writeFileSync(arg("markdown"), md);
if (arg("json"))
  writeFileSync(
    arg("json"),
    `${JSON.stringify({ tool, totals: [...totals.values()], rows }, null, 1)}\n`,
  );
console.log(md);
