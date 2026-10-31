import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
        "fail",
        "fail",
        "fail",
        "fail",
        "fail",
        "fail",
        "fail",
      ]);
      expect(loaded.policy.unknown).toBe("fail");
      const again = capture();
      expect(await main(["init"], again)).toBe(2);
      expect(again.text()).toContain(".hexvero/policy.json exists; pass --force to replace it");
      const forced = capture();
      expect(await main(["init", "--force"], forced), forced.text()).toBe(0);
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

  it("writes only hosts the policy can list, from requests, and says what it left out (#197 review)", async () => {
    const path = join(dir, "vertex.asar");
    writeFileSync(
      path,
      buildAsar({
        "package.json": JSON.stringify({ name: "v", main: "main.js" }),
        "main.js": [
          'fetch("https://REGION-aiplatform-ENDPOINT_ID.p.googleapis.com/v1");',
          'fetch("https://api.ok.example/x");',
          'const DOCS = "https://docs.only.example/page";',
        ].join("\n"),
      }),
    );
    const out = join(dir, "vertex", "policy.json");
    const io = capture();
    expect(await main(["init", path, "--out", out], io)).toBe(0);
    const policy = JSON.parse(readFileSync(out, "utf8"));
    expect(policy.rules["new-external-host"].allow).toEqual(["api.ok.example"]);
    expect(io.text()).toContain("region-aiplatform-endpoint_id.p.googleapis.com");
    expect(io.text()).toContain("1 host(s) occur only in plain URL strings");
    // the file is a policy check reads
    expect(await main(["check", path, path, "--policy", out], capture())).toBe(0);
  });

  it("never writes through a symbolic link, also with --force or a dangling one", async () => {
    const target = join(dir, "real.json");
    writeFileSync(target, "keep");
    const link = join(dir, "link.json");
    symlinkSync(target, link);
    const io = capture();
    expect(await main(["init", "--out", link, "--force"], io)).toBe(2);
    expect(io.text()).toContain("is a symbolic link");
    expect(readFileSync(target, "utf8")).toBe("keep");
    const dangling = join(dir, "dangling.json");
    symlinkSync(join(dir, "nowhere.json"), dangling);
    expect(await main(["init", "--out", dangling], capture())).toBe(2);
    expect(await main(["init", "--out", dangling, "--force"], capture())).toBe(2);
  });

  it("writes the policy to stdout with -, saying so on stderr", async (ctx) => {
    if (process.platform === "win32") return ctx.skip();
    const bin = join(import.meta.dirname, "..", "bin", "hexvero.js");
    const r = spawnSync(process.execPath, [bin, "init", "--out", "-"], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).hexvero).toBe("policy");
    expect(existsSync(join(process.cwd(), "-"))).toBe(false);
  });

  // Windows refuses control characters in file names; the name cannot exist there
  it.skipIf(process.platform === "win32")(
    "prints the build path without control characters",
    async () => {
      const a = build("ctl\u001b[31m", "api.ctl.example");
      const io = capture();
      expect(await main(["init", a, "--out", join(dir, "ctl.json")], io)).toBe(0);
      expect(io.text()).not.toContain("\u001b");
    },
  );
});
