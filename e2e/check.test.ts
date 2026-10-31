/**
 * The CI example: runs the reusable action's script (.github/actions/check/run.mjs) with the
 * inputs of .github/workflows/check-example.yml and the built CLI on the committed example builds,
 * validates the SARIF it writes against the SARIF 2.1.0 schema, and checks the workflow's own
 * hygiene (pinned actions, least privilege).
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Ajv } from "ajv";
import addFormatsModule from "ajv-formats";
import { afterAll, describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const bin = join(root, "packages", "cli", "bin", "hexvero.js");
const action = join(root, ".github", "actions", "check", "run.mjs");
const workflow = readFileSync(join(root, ".github", "workflows", "check-example.yml"), "utf8");
const work = mkdtempSync(join(tmpdir(), "hexvero-e2e-check-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));
const addFormats = addFormatsModule as unknown as (ajv: Ajv) => void;

/** The `with:` inputs of the workflow step that runs this repository's action (`uses: ./`). */
function workflowInputs(): Record<string, string> {
  const lines = workflow.split("\n");
  const at = lines.findIndex((l) => l.trim() === "uses: ./");
  if (at === -1) throw new Error("the workflow does not run the repository's action");
  const withAt = lines.findIndex((l, i) => i > at && l.trim() === "with:");
  const inputs: Record<string, string> = {};
  for (const line of lines.slice(withAt + 1)) {
    const m = /^ {10}([\w-]+): (.+)$/.exec(line);
    if (!m) break;
    inputs[m[1]!] = m[2]!;
  }
  return inputs;
}

describe("the CI example workflow", () => {
  it("runs the action as the workflow does: exit 3 and a schema-valid SARIF file", () => {
    const inputs = workflowInputs();
    expect(Object.keys(inputs).toSorted()).toEqual(["after", "before", "policy", "sarif"]);
    const out = join(work, "hexvero.sarif");
    const output = join(work, "github-output");
    writeFileSync(output, "");
    const env: Record<string, string | undefined> = {
      ...process.env,
      HEXVERO_ACTION_CLI: bin,
      GITHUB_OUTPUT: output,
      GITHUB_STEP_SUMMARY: join(work, "step-summary.md"),
      RUNNER_TEMP: work,
      INPUT_BEFORE: inputs["before"],
      INPUT_AFTER: inputs["after"],
      INPUT_POLICY: inputs["policy"],
      INPUT_SARIF: out,
    };
    const run = spawnSync(process.execPath, [action], { cwd: root, encoding: "utf8", env });
    expect(run.status, run.stderr).toBe(3);
    expect(run.stdout).toContain("fail: the policy is violated");
    expect(readFileSync(output, "utf8")).toMatch(/^exit-code<<(\S+)\n3\n\1$/m);
    expect(readFileSync(join(work, "step-summary.md"), "utf8")).toContain("# hexvero check: fail");
    const log = JSON.parse(readFileSync(out, "utf8"));
    const schema = JSON.parse(
      readFileSync(
        join(root, "packages", "core", "test", "fixtures", "sarif-schema-2.1.0.json"),
        "utf8",
      ),
    );
    const ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(ajv);
    const validate = ajv.compile(schema);
    expect(validate(log), JSON.stringify(validate.errors)).toBe(true);
    const results = log.runs[0].results as Array<{ ruleId: string; properties: { key: string } }>;
    expect(results.map((r) => [r.ruleId, r.properties.key])).toEqual([
      ["new-interface-member", "notesdesk.checkUpdate"],
      ["new-external-host", "updates.notesdesk.example"],
    ]);
    // the CLI itself never replaces the file without --force (the action passes it)
    const again = spawnSync(
      process.execPath,
      [
        bin,
        "check",
        inputs["before"]!,
        inputs["after"]!,
        "--policy",
        inputs["policy"]!,
        "--format",
        "sarif",
        "--out",
        out,
      ],
      { cwd: root, encoding: "utf8" },
    );
    expect(again.status).toBe(2);
  });

  it("pins every action by commit and grants security-events only to the upload job", () => {
    const uses = [...workflow.matchAll(/uses:\s*(\S+)(.*)/g)];
    expect(uses.length).toBeGreaterThan(0);
    for (const [, ref, comment] of uses) {
      if (ref === "./") continue; // this repository's own action, at this commit
      expect(ref).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
      expect(comment).toMatch(/# v\d+/);
    }
    const [top, jobs] = workflow.split(/^jobs:$/m);
    expect(top).toMatch(/^permissions:\n {2}contents: read\n/m);
    const [check, upload] = jobs!.split(/^ {2}upload:$/m);
    expect(check).not.toContain("security-events");
    expect(upload).toContain("security-events: write");
    expect(upload).toContain("github.event.pull_request.head.repo.full_name == github.repository");
  });
});
