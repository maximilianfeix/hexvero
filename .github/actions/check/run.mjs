#!/usr/bin/env node
// The reusable action `hexvero release check` (action.yml at the repository root) runs this file.
// It reads its inputs from INPUT_* variables that action.yml passes explicitly, runs
// `hexvero check` without a shell (every input is one argument, whatever it contains), writes the
// Markdown result to the job summary and a SARIF file, sets the step outputs, and exits with the
// check's own code: 0 pass, 1 technical error, 2 usage error or invalid policy, 3 policy violated,
// 4 not decidable. A failure while writing the summary or the SARIF file is reported but never
// changes that code.
//
// HEXVERO_ACTION_CLI, when set, is the path of a hexvero CLI script run with this Node.js instead
// of `npx hexvero@<version>`: the tests and this repository's own workflow use their build.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** The command that runs hexvero: [file, leading arguments]. */
export function hexveroCommand(env, version) {
  const cli = env.HEXVERO_ACTION_CLI;
  if (cli) return [process.execPath, [resolve(cli)]];
  const pkg = `hexvero@${version}`;
  // npx is a .cmd script on Windows, which cannot be spawned without a shell; run npm's own
  // npx-cli.js with this Node.js instead.
  if (process.platform === "win32") {
    const npxCli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npx-cli.js");
    if (existsSync(npxCli)) return [process.execPath, [npxCli, "--yes", pkg]];
  }
  return ["npx", ["--yes", pkg]];
}

/**
 * The arguments of `hexvero check`. Flags use the `--name=value` form and the two builds follow
 * `--`, so a path that starts with `--` is read as a path and not as a flag.
 */
export function checkArgs({ before, after, policy, baseline }, extra) {
  const args = ["check", `--policy=${policy}`];
  if (baseline) args.push(`--baseline=${baseline}`);
  args.push(...extra, "--", before, after);
  return args;
}

/** Runs a command without a shell; stderr goes to the log, stdout is returned when captured. */
function run(file, args, { capture, env }) {
  return new Promise((done) => {
    const child = spawn(file, args, {
      shell: false,
      env,
      stdio: ["ignore", capture ? "pipe" : "inherit", "inherit"],
    });
    const chunks = [];
    if (capture) child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.on("error", (error) => done({ code: 1, stdout: "", error }));
    child.on("close", (code, signal) =>
      done({
        code: code ?? 1,
        stdout: Buffer.concat(chunks).toString("utf8"),
        error: signal ? new Error(`hexvero was stopped by ${signal}`) : undefined,
      }),
    );
  });
}

/** Appends `name=value` to $GITHUB_OUTPUT in the multi-line form, safe for any value. */
async function setOutputs(file, outputs) {
  if (!file) return;
  let text = "";
  for (const [name, value] of Object.entries(outputs)) {
    let delimiter;
    do delimiter = `hexvero_${randomBytes(8).toString("hex")}`;
    while (value.includes(delimiter));
    text += `${name}<<${delimiter}\n${value}\n${delimiter}\n`;
  }
  await appendFile(file, text);
}

const warn = (message) => console.log(`::warning title=hexvero release check::${escape(message)}`);
const fail = (message) => console.log(`::error title=hexvero release check::${escape(message)}`);
// Workflow commands end at a newline; % and line breaks are escaped as the runner expects.
const escape = (s) => String(s).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");

/** Runs the action with the given environment and returns the exit code. */
export async function main(env = process.env) {
  const inputs = {
    before: env.INPUT_BEFORE ?? "",
    after: env.INPUT_AFTER ?? "",
    policy: env.INPUT_POLICY ?? "",
    baseline: env.INPUT_BASELINE ?? "",
  };
  const version = (env.INPUT_VERSION ?? "").trim() || "0.12.0";
  const sarif = env.INPUT_SARIF ?? "hexvero.sarif";
  const missing = ["before", "after", "policy"].filter((name) => !inputs[name]);
  if (missing.length > 0) {
    fail(`missing input: ${missing.join(", ")}`);
    await setOutputs(env.GITHUB_OUTPUT, { "exit-code": "2", sarif: "", summary: "" });
    return 2;
  }
  if (!VERSION_PATTERN.test(version)) {
    fail(`version must be a published hexvero version such as 0.12.0, got "${version}"`);
    await setOutputs(env.GITHUB_OUTPUT, { "exit-code": "2", sarif: "", summary: "" });
    return 2;
  }
  const [file, lead] = hexveroCommand(env, version);

  // The check itself, as Markdown: its exit code is the action's.
  const primary = await run(file, [...lead, ...checkArgs(inputs, ["--format=markdown"])], {
    capture: true,
    env,
  });
  const code = primary.code;
  if (primary.error) fail(`could not run hexvero: ${primary.error.message}`);
  if (primary.stdout) process.stdout.write(primary.stdout);

  let summary = "";
  if (primary.stdout) {
    try {
      summary = join(env.RUNNER_TEMP || tmpdir(), `hexvero-summary-${process.pid}.md`);
      await writeFile(summary, primary.stdout);
      if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, primary.stdout);
    } catch (error) {
      warn(`could not write the job summary: ${error.message}`);
    }
  }

  // The same check as SARIF, only when it reached a result: after an error it would only fail
  // again. A stale file from an earlier run must not be uploaded as this run's result.
  let sarifPath = "";
  if (sarif && [0, 3, 4].includes(code)) {
    try {
      await rm(sarif, { force: true });
      await mkdir(dirname(resolve(sarif)), { recursive: true });
      const second = await run(
        file,
        [...lead, ...checkArgs(inputs, ["--format=sarif", `--out=${sarif}`, "--force"])],
        { capture: false, env },
      );
      if (second.error) throw second.error;
      if (second.code !== code)
        warn(`writing the SARIF file exited ${second.code}, the check exited ${code}`);
      if (existsSync(sarif)) sarifPath = sarif;
      else warn(`no SARIF file was written to ${sarif}`);
    } catch (error) {
      warn(`could not write the SARIF file: ${error.message}`);
    }
  }

  try {
    await setOutputs(env.GITHUB_OUTPUT, {
      "exit-code": String(code),
      sarif: sarifPath,
      summary,
    });
  } catch (error) {
    warn(`could not write the step outputs: ${error.message}`);
  }
  return code;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await main();
}
