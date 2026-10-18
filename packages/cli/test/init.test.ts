import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parsePolicy } from "@hexvero/core";
import { buildAsar } from "../../core/test/fixtures/asar.js";
import type { Io } from "../src/format.js";
import { main } from "../src/index.js";

function capture(): Io & { text(): string } {
  const lines: string[] = [];
  return {
    color: false,
    out: (t: string) => void lines.push(t),
    err: (t: string) => void lines.push(t),
    text: () => lines.join("\n"),
  };
}

const dir = mkdtempSync(join(tmpdir(), "hexvero-init-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const build = (name: string, host: string): string => {
  const path = join(dir, `${name}.asar`);
  writeFileSync(
    path,
    buildAsar({
      "package.json": JSON.stringify({ name, version: "1.0.0", main: "main.js" }),
      "main.js": `fetch("https://${host}/v1/x");\n`,
    }),
  );
  return path;
};

describe("hexvero init (#197)", () => {
  it("writes .hexvero/policy.json in the working directory and never over it without --force", async () => {
    const cwd = process.cwd();
    const work = mkdtempSync(join(dir, "work-"));
    process.chdir(work);
    try {
      const io = capture();
      expect(await main(["init"], io)).toBe(0);
      expect(io.text()).toContain("wrote .hexvero/policy.json");
      const text = readFileSync(join(work, ".hexvero", "policy.json"), "utf8");
      const loaded = parsePolicy(text, "policy.json");
      expect(Object.values(loaded.policy.rules).map((r) => r.level)).toEqual([
        "fail",
        "fail",
        "fail",
        "fail",
      ]);
      expect(loaded.policy.unknown).toBe("fail");
      const again = capture();
      expect(await main(["init"], again)).toBe(2);
      expect(again.text()).toContain(".hexvero/policy.json exists; pass --force to replace it");
      expect(await main(["init", "--force"], capture())).toBe(0);
      // the README's next step now finds it
      const a = build("own-a", "api.own.example");
      expect(await main(["check", a, a, "--policy", ".hexvero/policy.json"], capture())).toBe(0);
    } finally {
      process.chdir(cwd);
    }
  });

  it("allows the hosts of a given build, so a first check of it passes", async () => {
    const a = build("hosts-a", "api.hosts.example");
    const out = join(dir, "hosts", "policy.json");
    const io = capture();
    expect(await main(["init", a, "--out", out], io)).toBe(0);
    expect(io.text()).toContain("1 host(s)");
    expect(io.text()).toContain("checked against itself: pass");
    const policy = JSON.parse(readFileSync(out, "utf8"));
    expect(policy.rules["new-external-host"].allow).toEqual(["api.hosts.example"]);
    // a later build with the same host passes, a new host fails
    const same = build("hosts-b", "api.hosts.example");
    const other = build("hosts-c", "api.elsewhere.example");
    expect(await main(["check", a, same, "--policy", out], capture())).toBe(0);
    expect(await main(["check", a, other, "--policy", out], capture())).toBe(3);
  });

  it("refuses a build it cannot read hosts from", async () => {
    const readme = join(dir, "README.txt");
    writeFileSync(readme, "hello\n");
    const io = capture();
    expect(await main(["init", readme, "--out", join(dir, "x.json")], io)).toBe(2);
    expect(io.text()).toContain("init reads hosts from an Electron app");
  });

  it("names init when the policy file is missing, and lists it in --help", async () => {
    const a = build("missing-a", "api.missing.example");
    const io = capture();
    expect(await main(["check", a, a, "--policy", join(dir, "none.json")], io)).toBe(1);
    expect(io.text()).toContain("ENOENT; create one with: hexvero init --out");
    const help = capture();
    expect(await main(["--help"], help)).toBe(0);
    expect(help.text()).toContain("init [build] [--out file] [--force]");
  });
});
