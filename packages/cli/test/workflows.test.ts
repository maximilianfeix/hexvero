import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const dir = join(import.meta.dirname, "..", "..", "..", ".github", "workflows");
const read = (name: string): string => readFileSync(join(dir, name), "utf8");
/** The text of one job: from `  name:` to the next job at the same indent. */
const job = (text: string, name: string): string => {
  const start = text.indexOf(`\n  ${name}:\n`);
  expect(start, `job ${name}`).toBeGreaterThan(-1);
  const rest = text.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[\w-]+:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
};

describe("release and review workflows", () => {
  it("publish only after the checks CI runs, built from a fresh install", () => {
    const release = read("release.yml");
    const verify = job(release, "verify");
    for (const step of [
      "npm run check",
      "npm run e2e",
      "git diff --exit-code -- examples",
      "node scripts/build-site-demo.mjs --check",
      "node corpus/build.mjs --check",
      "node corpus/gate.mjs",
    ])
      expect(verify).toContain(step);
    expect(verify).not.toContain("cache: npm");
    expect(job(release, "platforms")).toContain("os: [windows-latest, macos-latest]");
    expect(job(release, "publish")).toContain("needs: [verify, platforms]");
  });

  it("run pull request code without a write token, and post only the bot's own comment", () => {
    const review = read("review.yml");
    expect(review.split("\njobs:")[0]).not.toContain("pull-requests: write");
    const gates = job(review, "gates");
    expect(gates).not.toContain("pull-requests: write");
    const comment = job(review, "comment");
    expect(comment).toContain("pull-requests: write");
    expect(comment).not.toContain("actions/checkout");
    expect(comment).toContain('c.user.login === "github-actions[bot]"');
    expect(comment).toContain("const LIMIT = 60000;");
  });

  it("publish to the MCP registry only after a tag push, and keep no checkout credentials", () => {
    expect(read("mcp-registry.yml")).toContain("github.event.workflow_run.event == 'push'");
    for (const name of readdirSync(dir).filter((f) => f.endsWith(".yml"))) {
      const checkouts = read(name).split("uses: actions/checkout@").slice(1);
      for (const step of checkouts)
        expect(step.split("\n      - ")[0], `${name} checkout`).toContain(
          "persist-credentials: false",
        );
    }
  });
});
