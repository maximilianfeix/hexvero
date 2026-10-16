import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildAsar } from "../../core/test/fixtures/asar.js";
import type { Io } from "../src/format.js";
import { main } from "../src/index.js";

function capture(): Io & { stdout: string[]; stderr: string[]; text(): string } {
  const io = {
    stdout: [] as string[],
    stderr: [] as string[],
    color: false,
    out: (t: string) => void io.stdout.push(t),
    err: (t: string) => void io.stderr.push(t),
    text: () => [...io.stdout, ...io.stderr].join("\n"),
  };
  return io;
}

const root = join(import.meta.dirname, "..", "..", "..");
const examplePolicy = join(root, "examples", "policy.json");

const check = async (...argv: string[]) => {
  const io = capture();
  const code = await main(["check", ...argv], io);
  return { code, io };
};

const evil = (v2: boolean) => ({
  "package.json": JSON.stringify({
    name: "evil",
    version: v2 ? "2.0.0" : "1.0.0",
    main: "main.js",
  }),
  "main.js": [
    'const { ipcMain } = require("electron");',
    'ipcMain.handle("ok", () => 1);',
    v2
      ? 'fetch("https://x.evil.example/\u001b]8;;https://phish.example\u0007click\\n# Approved <img src=x onerror=alert(1)>");'
      : "",
  ].join("\n"),
  "preload.js": [
    'const { contextBridge, ipcRenderer } = require("electron");',
    'contextBridge.exposeInMainWorld("api", {',
    '  ok: () => ipcRenderer.invoke("ok"),',
    v2
      ? '  "x\\n# Approved <script>alert(1)</script>\u001b[2J": () => ipcRenderer.invoke("ok"),'
      : "",
    "});",
  ].join("\n"),
});

describe("hexvero check", () => {
  const dir = mkdtempSync(join(tmpdir(), "hexvero-check-"));
  const a = join(dir, "demo", "notesdesk-1.4.0.asar");
  const b = join(dir, "demo", "notesdesk-1.5.0.asar");
  const policyWith = (over: Record<string, unknown>, name: string): string => {
    const path = join(dir, name);
    writeFileSync(
      path,
      JSON.stringify({ ...JSON.parse(readFileSync(examplePolicy, "utf8")), ...over }),
    );
    return path;
  };
  beforeAll(async () => {
    expect(await main(["demo", join(dir, "demo")], capture())).toBe(0);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("fails the demo builds (exit 3) on the update host and the new preload member", async () => {
    const { code, io } = await check(a, b, "--policy", examplePolicy);
    expect(code).toBe(3);
    const text = io.text();
    expect(text).toContain("fail: the policy is violated");
    expect(text).toContain("new-interface-member  notesdesk.checkUpdate");
    expect(text).toContain("new-external-host  updates.notesdesk.example");
    expect(text).toContain("@ b: main.js:30");
    expect(text).not.toContain("Not decidable");
  });

  it("prints the same result as JSON, Markdown and SARIF", async () => {
    const json = await check(a, b, "--policy", examplePolicy, "--format", "json");
    expect(json.code).toBe(3);
    const result = JSON.parse(json.io.stdout.join("\n"));
    expect(result).toMatchObject({ hexvero: "check", version: 1, status: "fail" });
    expect(result.findings).toHaveLength(2);
    const md = await check(a, b, "--policy", examplePolicy, "--format", "markdown");
    expect(md.code).toBe(3);
    expect(md.io.stdout.join("\n")).toContain("# hexvero check: fail");
    for (const f of result.findings) expect(md.io.stdout.join("\n")).toContain(f.fingerprint);
    const sarif = await check(a, b, "--policy", examplePolicy, "--format", "sarif");
    expect(sarif.code).toBe(3);
    const log = JSON.parse(sarif.io.stdout.join("\n"));
    expect(log.version).toBe("2.1.0");
    expect(
      log.runs[0].results.map(
        (r: { partialFingerprints: Record<string, string> }) =>
          r.partialFingerprints["hexveroFingerprint/v1"],
      ),
    ).toEqual(result.findings.map((f: { fingerprint: string }) => f.fingerprint));
  });

  it("writes --out once and never over a file without --force", async () => {
    const out = join(dir, "result.sarif");
    const first = await check(a, b, "--policy", examplePolicy, "--format", "sarif", "--out", out);
    expect(first.code).toBe(3);
    expect(first.io.stdout.join("\n")).toContain(`· 2 finding(s) · ${out}`);
    expect(JSON.parse(readFileSync(out, "utf8")).version).toBe("2.1.0");
    writeFileSync(out, "keep me");
    const refused = await check(a, b, "--policy", examplePolicy, "--out", out);
    expect(refused.code).toBe(2);
    expect(refused.io.stderr.join("\n")).toContain("exists; pass --force to replace it");
    expect(readFileSync(out, "utf8")).toBe("keep me");
    expect((await check(a, b, "--policy", examplePolicy, "--out", out, "--force")).code).toBe(3);
    expect(readFileSync(out, "utf8")).toContain("hexvero check fail");
    expect(readFileSync(out, "utf8")).not.toContain("\u001b");
  });

  it("accepts findings only with --update-baseline; the accepted builds then pass", async () => {
    const baseline = join(dir, "baseline.json");
    const missing = await check(a, b, "--policy", examplePolicy, "--baseline", baseline);
    expect(missing.code).toBe(2);
    expect(missing.io.stderr.join("\n")).toContain("does not exist; create it with");
    const update = await check(
      a,
      b,
      "--policy",
      examplePolicy,
      "--baseline",
      baseline,
      "--update-baseline",
    );
    expect(update.io.stderr.join("\n")).toContain("2 finding(s) accepted");
    const written = JSON.parse(readFileSync(baseline, "utf8"));
    expect(written).toMatchObject({ hexvero: "baseline", version: 1 });
    expect(written.fingerprints.map((f: { key: string }) => f.key)).toEqual([
      "updates.notesdesk.example",
      "notesdesk.checkUpdate",
    ]);
    // findings accepted; nothing new and nothing undecidable is left
    expect(update.code).toBe(0);
    const again = await check(
      a,
      b,
      "--policy",
      examplePolicy,
      "--baseline",
      baseline,
      "--format",
      "json",
    );
    expect(again.code).toBe(0);
    const result = JSON.parse(again.io.stdout.join("\n"));
    expect(result.status).toBe("pass");
    expect(result.baseline.matched).toBe(2);
    expect(result.findings.every((f: { state: string }) => f.state === "baselined")).toBe(true);
    // with unknown: warn the same run passes, and the gap stays listed
    const warn = policyWith({ unknown: "warn" }, "warn.json");
    const passed = await check(a, b, "--policy", warn, "--baseline", baseline);
    expect(passed.code).toBe(0);
    // the baseline file was not touched by the normal runs
    expect(JSON.parse(readFileSync(baseline, "utf8"))).toEqual(written);
  });

  it("brings an expired suppression back as a failure", async () => {
    const json = JSON.parse(
      (await check(a, b, "--policy", examplePolicy, "--json")).io.stdout.join("\n"),
    );
    const suppress = (expires: string) =>
      json.findings.map((f: { rule: string; fingerprint: string }) => ({
        rule: f.rule,
        fingerprint: f.fingerprint,
        reason: "reviewed in #42",
        expires,
      }));
    const live = policyWith(
      { unknown: "allow", suppressions: suppress("2999-12-31") },
      "live.json",
    );
    expect((await check(a, b, "--policy", live)).code).toBe(0);
    const expired = policyWith(
      { unknown: "allow", suppressions: suppress("2020-01-01") },
      "expired.json",
    );
    const r = await check(a, b, "--policy", expired);
    expect(r.code).toBe(3);
    expect(r.io.text()).toContain("suppression expired");
  });

  it("refuses an invalid policy with exit 2 and says precisely what is wrong", async () => {
    const bad = join(dir, "bad.json");
    writeFileSync(
      bad,
      JSON.stringify({
        hexvero: "policy",
        version: 1,
        rules: { "new-external-host": { level: "fail", allow: ["https://x.example"] } },
        unknown: "maybe",
      }),
    );
    const r = await check(a, b, "--policy", bad);
    expect(r.code).toBe(2);
    const err = r.io.stderr.join("\n");
    expect(err).toContain(`invalid policy ${bad}`);
    expect(err).toContain(
      'rules.new-external-host.allow[0]: "https://x.example" is not a host name',
    );
    expect(err).toContain('unknown: must be "fail", "warn" or "allow", got "maybe"');
    writeFileSync(bad, "{ not json");
    const notJson = await check(a, b, "--policy", bad);
    expect(notJson.code).toBe(2);
    expect(notJson.io.stderr.join("\n")).toContain("is not valid JSON");
  });

  it("uses exit 2 for usage errors and 1 for files it cannot read", async () => {
    expect((await check(a, b)).io.stderr.join("\n")).toContain("missing --policy <file>");
    expect((await check(a, b)).code).toBe(2);
    expect((await check(a)).code).toBe(2);
    expect((await check(a, b, "--policy", examplePolicy, "--format", "html")).code).toBe(2);
    expect((await check(a, b, "--policy", examplePolicy, "--update-baseline")).code).toBe(2);
    const unreadable = await check(a, b, "--policy", join(dir, "nope.json"));
    expect(unreadable.code).toBe(1);
    expect(unreadable.io.stderr.join("\n")).toContain("cannot read the policy");
    expect((await check(join(dir, "missing.asar"), b, "--policy", examplePolicy)).code).toBe(1);
  });

  it("passes (exit 0) when nothing changed", async () => {
    expect((await check(a, a, "--policy", examplePolicy)).code).toBe(0);
  });

  it("keeps hostile text from the build out of the terminal and the Markdown", async () => {
    const e1 = join(dir, "evil-1.asar");
    const e2 = join(dir, "evil-2.asar");
    writeFileSync(e1, buildAsar(evil(false)));
    writeFileSync(e2, buildAsar(evil(true)));
    const text = await check(e1, e2, "--policy", examplePolicy);
    expect(text.code).toBe(3);
    const out = text.io.text();
    expect(out).toContain("x.evil.example");
    expect(out).not.toContain("\u001b");
    expect(out).not.toContain("\u0007");
    expect(out.split("\n").some((l) => l.startsWith("# Approved"))).toBe(false);
    const md = (
      await check(e1, e2, "--policy", examplePolicy, "--format", "markdown")
    ).io.stdout.join("\n");
    expect(md.split("\n").some((l) => l.startsWith("# Approved"))).toBe(false);
    expect(md).not.toContain("\u001b");
    const prose = md.replace(/`` .*? ``/g, "").replace(/`[^`\n]*`/g, "");
    expect(prose).not.toMatch(/(?<!\\)<(img|script)/);
    expect(existsSync(join(dir, "evil-2.asar"))).toBe(true);
  });
});
