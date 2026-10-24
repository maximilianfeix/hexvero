/**
 * The first minute with the built CLI, as `npx hexvero` runs it: the start screen and --version
 * without the analyzers, the Node.js version check, `hexvero <path>` and a file named like a
 * command, with real exit codes and streams.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const bin = join(root, "packages", "cli", "bin", "hexvero.js");
const work = mkdtempSync(join(tmpdir(), "hexvero-e2e-firstrun-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const run = (args: string[], options: { cwd?: string; node?: string[] } = {}) =>
  spawnSync(process.execPath, [...(options.node ?? []), bin, ...args], {
    cwd: options.cwd ?? work,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", npm_command: "" },
  });

describe("first run with the built CLI", () => {
  it("prints the start screen on stderr with exit 2, and the version on stdout", () => {
    const bare = run([]);
    expect(bare.status).toBe(2);
    expect(bare.stdout).toBe("");
    expect(bare.stderr).toContain("Start here:");
    expect(bare.stderr.trim().split("\n").length).toBeLessThanOrEqual(15);
    const version = run(["--version"]);
    expect(version.status).toBe(0);
    expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
    const help = run(["--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("Usage: hexvero");
  });

  it("says which Node.js it needs on an older one", () => {
    const old = run(["--version"], {
      node: [
        "--import",
        'data:text/javascript,Object.defineProperty(process.versions,"node",{value:"20.11.1"})',
      ],
    });
    expect(old.status).toBe(1);
    expect(old.stderr).toContain("hexvero needs Node.js 22.12 or newer; this is Node.js 20.11.1");
    expect(old.stdout).toBe("");
  });

  it("gives a quick look for hexvero <path>, and a command still wins over a file of its name", () => {
    const quick = run([join(root, "examples", "notesdesk-1.5.0.asar")]);
    expect(quick.status, quick.stderr).toBe(0);
    expect(quick.stdout).toContain("6 IPC channels");
    expect(quick.stdout).toContain("Top findings");
    expect(quick.stderr).toBe(""); // no progress line without a terminal
    // a file called "doctor" in the working directory: `hexvero doctor` is still the command,
    // `hexvero ./doctor` the file
    copyFileSync(join(root, "examples", "notesdesk-1.5.0.asar"), join(work, "doctor"));
    const command = run(["doctor"]);
    expect(command.stdout).not.toContain("Top findings");
    const file = run(["./doctor"]);
    expect(file.status, file.stderr).toBe(0);
    expect(file.stdout).toContain("Top findings");
    const typo = run(["comapre", "a", "b"]);
    expect(typo.status).toBe(2);
    expect(typo.stderr).toContain("did you mean: hexvero compare");
  });
});
