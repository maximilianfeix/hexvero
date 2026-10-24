import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

// scripts/release-verify.mjs checks every file scripts/release.mjs bumps. It reads paths relative
// to its own location, so a copy of the script inside a copy of the versioned files is checked
// in isolation.
const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const versioned = [
  "packages/core/package.json",
  "packages/mcp/package.json",
  "packages/server/package.json",
  "packages/cli/package.json",
  "packages/web/package.json",
  "packages/cli/src/usage.ts",
  "packages/mcp/src/index.ts",
  "packages/core/src/version.ts",
  "server.json",
  ".claude-plugin/plugin.json",
  "CHANGELOG.md",
  "docs/ci.md",
  "site/index.html",
  "README.md",
  "docs/mcp.md",
  "scripts/release-verify.mjs",
];
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function copyRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "hexvero-release-verify-"));
  dirs.push(dir);
  for (const file of versioned) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    cpSync(join(repo, file), join(dir, file));
  }
  return dir;
}

function verify(dir: string): { status: number; output: string } {
  try {
    const out = execFileSync(process.execPath, [join(dir, "scripts", "release-verify.mjs")], {
      encoding: "utf8",
      stdio: "pipe",
    });
    return { status: 0, output: out };
  } catch (error) {
    const e = error as { status: number; stdout: string; stderr: string };
    return { status: e.status, output: `${e.stdout}${e.stderr}` };
  }
}

function setJsonVersion(dir: string, file: string, version: string): void {
  const path = join(dir, file);
  const json = JSON.parse(readFileSync(path, "utf8")) as { version: string };
  json.version = version;
  writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`);
}

describe("release-verify", () => {
  it("accepts the committed tree", () => {
    // the script's own report is part of the expectation, so a failure shows what it found
    expect(verify(copyRepo())).toEqual({
      status: 0,
      output: expect.stringContaining("is consistent"),
    });
  });

  it("fails when the web package version differs", () => {
    const dir = copyRepo();
    setJsonVersion(dir, "packages/web/package.json", "0.0.1");
    const r = verify(dir);
    expect(r.status).toBe(1);
    expect(r.output).toContain("packages/web is 0.0.1");
  });

  it("fails when the CI example pins another version", () => {
    const dir = copyRepo();
    const path = join(dir, "docs/ci.md");
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace(/hexvero@\d+\.\d+\.\d+/, "hexvero@0.0.1"),
    );
    const r = verify(dir);
    expect(r.status).toBe(1);
    expect(r.output).toContain("docs/ci.md pins hexvero@0.0.1");
  });

  it("fails when the Claude plugin manifest version differs", () => {
    const dir = copyRepo();
    setJsonVersion(dir, ".claude-plugin/plugin.json", "0.0.1");
    const r = verify(dir);
    expect(r.status).toBe(1);
    expect(r.output).toContain(".claude-plugin/plugin.json version is 0.0.1");
  });
});
