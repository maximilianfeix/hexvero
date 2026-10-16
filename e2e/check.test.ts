/**
 * The CI example: runs the exact `hexvero check` command of .github/workflows/check-example.yml
 * with the built CLI on the committed example builds, validates the SARIF it writes against the
 * SARIF 2.1.0 schema, and checks the workflow's own hygiene (pinned actions, least privilege).
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Ajv } from "ajv";
import addFormatsModule from "ajv-formats";
import { afterAll, describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const bin = join(root, "packages", "cli", "bin", "hexvero.js");
const workflow = readFileSync(join(root, ".github", "workflows", "check-example.yml"), "utf8");
const work = mkdtempSync(join(tmpdir(), "hexvero-e2e-check-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));
const addFormats = addFormatsModule as unknown as (ajv: Ajv) => void;

/** The arguments after `hexvero.js` of the workflow line that writes the SARIF file. */
function workflowCheckArgs(): string[] {
  const line = workflow
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith("node packages/cli/bin/hexvero.js check") && l.includes("--out"));
  if (!line) throw new Error("the workflow has no check step writing --out");
  return line.split(/\s+/).slice(2);
}

describe("the CI example workflow", () => {
  it("runs hexvero check as the workflow does: exit 3 and a schema-valid SARIF file", () => {
    const args = workflowCheckArgs();
    const out = join(work, "hexvero.sarif");
    args[args.indexOf("--out") + 1] = out;
    const run = spawnSync(process.execPath, [bin, ...args], { cwd: root, encoding: "utf8" });
    expect(run.status, run.stderr).toBe(3);
    expect(run.stdout).toContain("fail: the policy is violated");
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
    // a second run never replaces the file without --force
    const again = spawnSync(process.execPath, [bin, ...args], { cwd: root, encoding: "utf8" });
    expect(again.status).toBe(2);
  });

  it("pins every action by commit and grants security-events only to the upload job", () => {
    const uses = [...workflow.matchAll(/uses:\s*(\S+)(.*)/g)];
    expect(uses.length).toBeGreaterThan(0);
    for (const [, ref, comment] of uses) {
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
