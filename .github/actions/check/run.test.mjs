// Tests of the reusable action's script: `node --test .github/actions/check/`.
// The real cases run this repository's built CLI (npm run build) on the builds of `hexvero demo`;
// they are skipped when the CLI is not built. A fake CLI covers what the demo cannot produce.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { auditArgs, auditSupported, checkArgs, main } from "./run.mjs";

const root = resolve(import.meta.dirname, "../../..");
const cli = join(root, "packages/cli/bin/hexvero.js");
const built = existsSync(join(root, "packages/cli/dist"));

let work;
before(async () => {
  work = await mkdtemp(join(tmpdir(), "hexvero-action-"));
});
after(async () => {
  await rm(work, { recursive: true, force: true });
});

/** A fresh directory with an empty job summary and output file, and the env of a run. */
async function setup(name, inputs, cliPath) {
  const dir = join(work, name);
  await mkdir(dir, { recursive: true });
  const env = {
    ...process.env,
    GITHUB_STEP_SUMMARY: join(dir, "step-summary.md"),
    GITHUB_OUTPUT: join(dir, "github-output"),
    RUNNER_TEMP: dir,
    HEXVERO_ACTION_CLI: cliPath,
    ...inputs,
  };
  await writeFile(env.GITHUB_STEP_SUMMARY, "");
  await writeFile(env.GITHUB_OUTPUT, "");
  return { dir, env };
}

/** The outputs written to $GITHUB_OUTPUT (multi-line form). */
async function outputs(file) {
  const text = await readFile(file, "utf8");
  const result = {};
  const re = /^([\w-]+)<<(\S+)\n([\s\S]*?)\n\2$/gm;
  for (const m of text.matchAll(re)) result[m[1]] = m[3];
  return result;
}

/** Inputs for the fake CLI, which reads no file. */
const inputs = (dir) => ({
  INPUT_BEFORE: "a.asar",
  INPUT_AFTER: "b.asar",
  INPUT_POLICY: "policy.json",
  INPUT_SARIF: join(dir, "hexvero.sarif"),
});

describe("checkArgs", () => {
  test("puts the builds after -- and flags in --name=value form", () => {
    assert.deepEqual(
      checkArgs({ before: "--a b", after: "c", policy: "p q.json", baseline: "" }, ["--x=1"]),
      ["check", "--policy=p q.json", "--x=1", "--", "--a b", "c"],
    );
    assert.deepEqual(checkArgs({ before: "a", after: "b", policy: "p", baseline: "base" }, []), [
      "check",
      "--policy=p",
      "--baseline=base",
      "--",
      "a",
      "b",
    ]);
  });
});

describe("auditArgs", () => {
  test("audits the after build alone; policy and baseline are optional", () => {
    assert.deepEqual(auditArgs({ after: "--b c", policy: "", baseline: "" }, ["--x=1"]), [
      "audit",
      "--x=1",
      "--",
      "--b c",
    ]);
    assert.deepEqual(auditArgs({ after: "b", policy: "p", baseline: "base" }, []), [
      "audit",
      "--policy=p",
      "--baseline=base",
      "--",
      "b",
    ]);
  });

  test("needs 0.13.0 or later", () => {
    assert.equal(auditSupported("0.12.0"), false);
    assert.equal(auditSupported("0.13.0"), true);
    assert.equal(auditSupported("0.13.0-rc.1"), true);
    assert.equal(auditSupported("1.0.0"), true);
  });
});

describe("with the built CLI on the demo builds", { skip: !built && "run npm run build" }, () => {
  let demo;
  before(async () => {
    const dir = join(work, "demo");
    await mkdir(dir, { recursive: true });
    execFileSync(process.execPath, [cli, "demo"], { cwd: dir, stdio: "ignore" });
    demo = join(dir, "hexvero-demo");
  });

  test("pass: exit 0, summary and SARIF written", async () => {
    const { dir, env } = await setup(
      "pass",
      {
        INPUT_BEFORE: join(demo, "notesdesk-1.4.0.asar"),
        INPUT_AFTER: join(demo, "notesdesk-1.4.0.asar"),
        INPUT_POLICY: join(demo, "policy.json"),
        INPUT_SARIF: "",
      },
      cli,
    );
    env.INPUT_SARIF = join(dir, "hexvero.sarif");
    assert.equal(await main(env), 0);
    const out = await outputs(env.GITHUB_OUTPUT);
    assert.equal(out["exit-code"], "0");
    assert.equal(out.sarif, env.INPUT_SARIF);
    assert.match(await readFile(env.GITHUB_STEP_SUMMARY, "utf8"), /# hexvero check: pass/);
    assert.equal(
      await readFile(out.summary, "utf8"),
      await readFile(env.GITHUB_STEP_SUMMARY, "utf8"),
    );
    assert.equal(JSON.parse(await readFile(out.sarif, "utf8")).version, "2.1.0");
  });

  test("audit of one build: no before input, exit 3, audit summary and SARIF", async () => {
    const { dir, env } = await setup(
      "audit",
      { INPUT_AFTER: join(demo, "notesdesk-1.5.0.asar"), INPUT_VERSION: "0.13.0" },
      cli,
    );
    env.INPUT_SARIF = join(dir, "hexvero.sarif");
    assert.equal(await main(env), 3);
    const out = await outputs(env.GITHUB_OUTPUT);
    assert.equal(out["exit-code"], "3");
    const summary = await readFile(env.GITHUB_STEP_SUMMARY, "utf8");
    assert.match(summary, /# hexvero audit: fail/);
    assert.match(summary, /\| open-external \|/);
    const sarif = JSON.parse(await readFile(out.sarif, "utf8"));
    assert.ok(sarif.runs[0].results.some((r) => r.ruleId === "csp-missing"));
  });

  test("audit through npx is refused before 0.13.0, with a clear message (exit 2)", async () => {
    const { env } = await setup(
      "audit-old",
      { INPUT_AFTER: join(demo, "notesdesk-1.5.0.asar"), INPUT_VERSION: "0.12.0" },
      "",
    );
    delete env.HEXVERO_ACTION_CLI;
    assert.equal(await main(env), 2);
    assert.equal((await outputs(env.GITHUB_OUTPUT))["exit-code"], "2");
  });

  test("violation: exit 3, summary and SARIF still written", async () => {
    const { dir, env } = await setup(
      "violation",
      {
        INPUT_BEFORE: join(demo, "notesdesk-1.4.0.asar"),
        INPUT_AFTER: join(demo, "notesdesk-1.5.0.asar"),
        INPUT_POLICY: join(demo, "policy.json"),
      },
      cli,
    );
    env.INPUT_SARIF = join(dir, "hexvero.sarif");
    // a stale file of an earlier run is replaced, not refused
    await writeFile(env.INPUT_SARIF, "stale");
    assert.equal(await main(env), 3);
    const out = await outputs(env.GITHUB_OUTPUT);
    assert.equal(out["exit-code"], "3");
    assert.match(await readFile(env.GITHUB_STEP_SUMMARY, "utf8"), /# hexvero check: fail/);
    const sarif = JSON.parse(await readFile(out.sarif, "utf8"));
    assert.ok(sarif.runs[0].results.length > 0);
  });

  test("paths with spaces and a leading --", async () => {
    const { dir, env } = await setup("spaces", {}, cli);
    const builds = join(dir, "my builds");
    await mkdir(builds, { recursive: true });
    await copyFile(join(demo, "notesdesk-1.4.0.asar"), join(builds, "--old build.asar"));
    await copyFile(join(demo, "notesdesk-1.5.0.asar"), join(builds, "new build.asar"));
    await copyFile(join(demo, "policy.json"), join(builds, "release policy.json"));
    Object.assign(env, {
      INPUT_BEFORE: join(builds, "--old build.asar"),
      INPUT_AFTER: join(builds, "new build.asar"),
      INPUT_POLICY: join(builds, "release policy.json"),
      INPUT_SARIF: join(dir, "out dir", "hexvero result.sarif"),
    });
    assert.equal(await main(env), 3);
    const out = await outputs(env.GITHUB_OUTPUT);
    assert.equal(out.sarif, env.INPUT_SARIF);
    assert.ok(existsSync(env.INPUT_SARIF));
  });

  test("technical failure: a missing build exits 1 and writes no SARIF", async () => {
    const { dir, env } = await setup(
      "missing",
      {
        INPUT_BEFORE: join(demo, "does-not-exist.asar"),
        INPUT_AFTER: join(demo, "notesdesk-1.5.0.asar"),
        INPUT_POLICY: join(demo, "policy.json"),
      },
      cli,
    );
    env.INPUT_SARIF = join(dir, "hexvero.sarif");
    const code = await main(env);
    assert.ok(code === 1 || code === 2, `exit ${code}`);
    const out = await outputs(env.GITHUB_OUTPUT);
    assert.equal(out["exit-code"], String(code));
    assert.equal(out.sarif, "");
    assert.ok(!existsSync(env.INPUT_SARIF));
  });
});

describe("with a fake CLI", () => {
  let fake;
  before(async () => {
    // Exits FAKE_CODE; the Markdown run prints a result, the SARIF run fails when FAKE_SARIF_FAIL.
    fake = join(work, "fake-hexvero.mjs");
    await writeFile(
      fake,
      [
        'import { writeFileSync } from "node:fs";',
        "const args = process.argv.slice(2);",
        "const code = Number(process.env.FAKE_CODE);",
        'const out = args.find((a) => a.startsWith("--out="));',
        "if (out) {",
        "  if (process.env.FAKE_SARIF_FAIL) { console.error('sarif broke'); process.exit(1); }",
        '  writeFileSync(out.slice(6), JSON.stringify({ version: "2.1.0", runs: [] }));',
        "} else console.log(`# hexvero check: fake ${code}\\n\\nargs ${JSON.stringify(args)}`);",
        "process.exit(code);",
      ].join("\n"),
    );
  });

  test("undecidable: exit 4 with summary and SARIF", async () => {
    const { dir, env } = await setup("undecidable", { FAKE_CODE: "4" }, fake);
    Object.assign(env, inputs(dir));
    assert.equal(await main(env), 4);
    const out = await outputs(env.GITHUB_OUTPUT);
    assert.equal(out["exit-code"], "4");
    assert.equal(out.sarif, env.INPUT_SARIF);
    assert.match(await readFile(env.GITHUB_STEP_SUMMARY, "utf8"), /fake 4/);
  });

  test("a failing SARIF run does not turn exit 3 into anything else", async () => {
    const { dir, env } = await setup("sarif-fails", { FAKE_CODE: "3", FAKE_SARIF_FAIL: "1" }, fake);
    Object.assign(env, inputs(dir));
    assert.equal(await main(env), 3);
    const out = await outputs(env.GITHUB_OUTPUT);
    assert.equal(out["exit-code"], "3");
    assert.equal(out.sarif, "");
    assert.match(await readFile(env.GITHUB_STEP_SUMMARY, "utf8"), /fake 3/);
  });

  test("an unwritable job summary does not turn exit 3 into anything else", async () => {
    const { dir, env } = await setup("summary-fails", { FAKE_CODE: "3" }, fake);
    Object.assign(env, inputs(dir));
    env.GITHUB_STEP_SUMMARY = dir; // a directory: appending fails
    assert.equal(await main(env), 3);
    assert.equal((await outputs(env.GITHUB_OUTPUT))["exit-code"], "3");
  });

  test("technical failure: exit 1 is passed through, no SARIF run", async () => {
    const { dir, env } = await setup("error", { FAKE_CODE: "1" }, fake);
    Object.assign(env, inputs(dir));
    assert.equal(await main(env), 1);
    const out = await outputs(env.GITHUB_OUTPUT);
    assert.equal(out["exit-code"], "1");
    assert.equal(out.sarif, "");
  });

  test("a CLI that cannot be started exits 1", async () => {
    const { dir, env } = await setup("no-cli", {}, join(work, "missing-cli.mjs"));
    Object.assign(env, inputs(dir));
    assert.equal(await main(env), 1);
    assert.equal((await outputs(env.GITHUB_OUTPUT))["exit-code"], "1");
  });

  test("missing inputs and a bad version are usage errors (2)", async () => {
    const { env } = await setup("usage", { INPUT_BEFORE: "a" }, fake);
    assert.equal(await main(env), 2);
    assert.equal((await outputs(env.GITHUB_OUTPUT))["exit-code"], "2");
    const bad = await setup("bad-version", { FAKE_CODE: "0" }, fake);
    Object.assign(bad.env, inputs(bad.dir), { INPUT_VERSION: "latest; rm -rf /" });
    assert.equal(await main(bad.env), 2);
  });
});
