#!/usr/bin/env node
/**
 * Agent task evaluation: the same model answers the same questions about corpus inputs, once with
 * hexvero's MCP server and once with REA's, and the answers are graded against the corpus's
 * written-down expectations. Nothing else differs between the two runs of a task: same prompt,
 * same model, no built-in tools (no shell, no file reading), only the one MCP server.
 *
 *   REA_PKG_DIR=… node scripts/agent-eval.mjs [--tools hexvero,rea] [--tasks t1,t2] [--model sonnet]
 *        [--reps 1] [--out results.jsonl]
 *
 * It runs `claude -p` (Claude Code in print mode) from an empty directory with
 * `--setting-sources project` and `--strict-mcp-config`, so no user hooks, plug-ins or other MCP
 * servers take part. Each answer must end with a block between the lines ANSWER and END, one item
 * per line; grading reads only that block: hits, misses, and items the expectations rule out.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
const built = join(root, "corpus", "built", "holdout2");
const expect = (name) =>
  JSON.parse(readFileSync(join(root, "corpus", "holdout2", name, "expected.json"), "utf8")).expect;
const editor = expect("markdown-editor");
const player = expect("music-player");
const v2 = expect("markdown-editor-v2");

const channels = (e) => e.ipcChannels.present.map((c) => c.channel);
const absentChannels = (e) => (e.ipcChannels.absent ?? []).map((c) => c.channel).filter(Boolean);

/** Each task: question, the input it is about, expected items, items ruled out. */
const TASKS = {
  t1: {
    question:
      "List every IPC channel name this Electron application uses, in either direction (renderer to main and main to renderer).",
    inputs: [join(built, "markdown-editor.bundled.asar")],
    want: channels(editor),
    forbid: absentChannels(editor),
  },
  t2: {
    question:
      "List every IPC channel name this Electron application uses, in either direction (renderer to main and main to renderer).",
    inputs: [join(built, "music-player.bundled.asar")],
    want: channels(player),
    forbid: absentChannels(player),
  },
  t3: {
    question:
      "Through which IPC channel does the page API member window.inkwell.getSettings reach the main process? Answer with the channel name.",
    inputs: [join(built, "markdown-editor.bundled.asar")],
    want: [editor.contextBridge.present.find((m) => m.member === "getSettings").channel],
    forbid: [],
  },
  t4: {
    question:
      "Between version A and version B of this application, which IPC channels were added and which were removed? Write added channels as +name and removed ones as -name.",
    inputs: [
      join(built, "markdown-editor.plain.asar"),
      join(built, "markdown-editor-v2.plain.asar"),
    ],
    want: [
      ...v2.compare.ipcChannels.added.map((c) => `+${c}`),
      ...v2.compare.ipcChannels.removed.map((c) => `-${c}`),
    ],
    forbid: [],
  },
  t5: {
    question:
      "For each window of this application, which values of contextIsolation, nodeIntegration and sandbox does the code set? Answer one distinct key=value per line (for example sandbox=true), counting a value once even if several windows set it.",
    inputs: [join(built, "music-player.bundled.asar")],
    want: [
      ...new Set(
        player.webPreferences.present
          .filter((p) => ["contextIsolation", "nodeIntegration", "sandbox"].includes(p.key))
          .map((p) => `${p.key}=${p.value}`),
      ),
    ],
    forbid: [],
  },
};

const tools = arg("tools", "hexvero,rea").split(",");
const tasks = arg("tasks", Object.keys(TASKS).join(",")).split(",");
const model = arg("model", "sonnet");
const reps = Number(arg("reps", "1"));
const out = resolve(arg("out", join(tmpdir(), "hexvero-agent-eval.jsonl")));
/** `--allow-read`: both tools' agents may read files (REA writes large results to files). */
const allowRead = process.argv.includes("--allow-read");
const work = mkdtempSync(join(tmpdir(), "hexvero-agent-eval-"));

const server = {
  hexvero: {
    command: process.execPath,
    args: [join(root, "packages", "cli", "bin", "hexvero.js"), "mcp"],
  },
  rea: () => ({
    command: process.execPath,
    args: [join(process.env.REA_PKG_DIR ?? "", "scripts", "rea.mjs"), "--mcp"],
  }),
};
const BUILTIN =
  "Bash Read Write Edit MultiEdit Glob Grep WebFetch WebSearch Task Agent NotebookEdit TodoWrite";

function prompt(task) {
  const files =
    task.inputs.length === 1
      ? `The application archive is at ${task.inputs[0]}.`
      : `Version A is at ${task.inputs[0]} and version B is at ${task.inputs[1]}.`;
  return [
    allowRead
      ? "Answer a question about an application using the tools of the connected MCP server; you may read files it writes."
      : "Answer a question about an application using only the tools of the connected MCP server.",
    "Do not run the application.",
    files,
    `Question: ${task.question}`,
    "End your reply with a block that starts with a line ANSWER and ends with a line END, with one item per line and nothing else inside it. If you cannot determine an item, leave it out.",
  ].join("\n");
}

const norm = (s) => s.replace(/\s+/g, "").toLowerCase();

function grade(task, text) {
  const block = /^ANSWER\s*$([\s\S]*?)^END\s*$/m.exec(text ?? "")?.[1] ?? "";
  const items = block
    .split("\n")
    .map((l) =>
      l
        .trim()
        .replace(/^[-*•]\s+(?=\S)/, (m) => (task.want.some((w) => w.startsWith("-")) ? m : ""))
        .replace(/^`|`$/g, ""),
    )
    .filter(Boolean);
  const got = new Set(items.map(norm));
  const hits = task.want.filter((w) => got.has(norm(w)));
  const wrong = items.filter((i) => task.forbid.some((f) => norm(f) === norm(i)));
  const extra = items.filter((i) => !task.want.some((w) => norm(w) === norm(i)));
  return {
    answered: block !== "",
    items: items.length,
    hit: hits.length,
    of: task.want.length,
    ruledOut: wrong.length,
    notExpected: extra.length,
  };
}

for (let rep = 1; rep <= reps; rep++)
  for (const id of tasks)
    for (const tool of tools) {
      const task = TASKS[id];
      const config = join(work, `${tool}.mcp.json`);
      writeFileSync(
        config,
        JSON.stringify({
          mcpServers: {
            [tool]: typeof server[tool] === "function" ? server[tool]() : server[tool],
          },
        }),
      );
      const started = Date.now();
      let result = null;
      let error = null;
      try {
        const raw = execFileSync(
          "claude",
          [
            "-p",
            prompt(task),
            "--model",
            model,
            "--output-format",
            "json",
            "--setting-sources",
            "project",
            "--strict-mcp-config",
            "--mcp-config",
            config,
            "--allowedTools",
            `mcp__${tool}`,
            ...(allowRead ? ["Read"] : []),
            "--disallowedTools",
            ...BUILTIN.split(" ").filter((t) => !(allowRead && t === "Read")),
            "--no-session-persistence",
          ],
          {
            cwd: work,
            encoding: "utf8",
            timeout: 15 * 60 * 1000,
            maxBuffer: 64 << 20,
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        result = JSON.parse(raw);
      } catch (e) {
        error = e instanceof Error ? e.message.slice(0, 500) : String(e);
      }
      const row = {
        at: new Date().toISOString(),
        task: id,
        tool,
        allowRead,
        model,
        rep,
        wallMs: Date.now() - started,
        turns: result?.num_turns ?? null,
        usage: result?.usage ?? null,
        costUsd: result?.total_cost_usd ?? null,
        isError: result?.is_error ?? null,
        grade: grade(task, result?.result),
        answer: result?.result ?? null,
        error,
      };
      appendFileSync(out, `${JSON.stringify(row)}\n`);
      console.log(
        `${id} ${tool}: ${row.grade.hit}/${row.grade.of} hit, ${row.grade.ruledOut} ruled out, ${row.grade.notExpected} not expected, turns ${row.turns}, ${Math.round(row.wallMs / 1000)} s${error ? `, error ${error.slice(0, 120)}` : ""}`,
      );
    }
console.log(`rows appended to ${out}`);
