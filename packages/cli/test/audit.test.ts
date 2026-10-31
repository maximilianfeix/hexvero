import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
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
const dir = mkdtempSync(join(tmpdir(), "hexvero-audit-cli-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const audit = async (...argv: string[]) => {
  const io = capture();
  const code = await main(["audit", ...argv], io);
  return { code, io };
};

const write = (name: string, source: string, html?: string): string => {
  const path = join(dir, `${name}.asar`);
  writeFileSync(
    path,
    buildAsar({
      "package.json": JSON.stringify({
        name,
        main: "main.js",
        devDependencies: { electron: "^33.0.0" },
      }),
      "main.js": source,
      ...(html === undefined ? {} : { "index.html": html }),
    }),
  );
  return path;
};

const SAFE = `const { app, BrowserWindow, session } = require("electron");
app.on("web-contents-created", (e, contents) => {
  contents.on("will-navigate", (ev) => ev.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
});
app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((wc, p, cb) => cb(false));
  new BrowserWindow({ webPreferences: { sandbox: true, contextIsolation: true } }).loadFile("index.html");
});
`;
const CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'self'">`;

describe("hexvero audit", () => {
  it("passes (exit 0) a build that sets what the rules ask for", async () => {
    const { code, io } = await audit(write("safe", SAFE, CSP));
    expect(io.text()).toContain("hexvero audit pass");
    expect(code).toBe(0);
  });

  it("fails the example build (exit 3) with file:line places", async () => {
    const { code, io } = await audit(join(root, "examples", "notesdesk-1.5.0.asar"));
    expect(code).toBe(3);
    expect(io.text()).toContain("open-external");
    expect(io.text()).toContain("@ main.js:");
    expect(io.text()).toContain("permission-handler-missing");
    expect(io.text()).toContain("csp-missing");
    expect(io.text()).toContain("navigation-unlimited  no will-navigate listener");
  });

  it("is not decidable (exit 4) on unknowns only, and passes with --unknown warn", async () => {
    const path = write("unknown", `${SAFE}function helper(s, url) { s.openExternal(url); }\n`, CSP);
    const r = await audit(path);
    expect(r.code).toBe(4);
    expect(r.io.text()).toContain("--unknown warn");
    expect((await audit(path, "--unknown", "warn")).code).toBe(0);
  });

  it("writes JSON and SARIF with the same findings", async () => {
    const path = join(root, "examples", "notesdesk-1.5.0.asar");
    const json = await audit(path, "--format", "json");
    const result = JSON.parse(json.io.stdout.join("\n")) as {
      hexvero: string;
      status: string;
      findings: Array<{ rule: string; fingerprint: string }>;
    };
    expect(result.hexvero).toBe("audit");
    expect(result.status).toBe("fail");
    const sarif = await audit(path, "--format", "sarif");
    const log = JSON.parse(sarif.io.stdout.join("\n")) as {
      version: string;
      runs: Array<{
        results: Array<{
          ruleId: string;
          partialFingerprints: Record<string, string>;
          locations: Array<{
            physicalLocation?: { artifactLocation: { uri: string; uriBaseId: string } };
          }>;
        }>;
      }>;
    };
    expect(log.version).toBe("2.1.0");
    const results = log.runs[0]!.results;
    expect(results.map((x) => x.ruleId)).toEqual(result.findings.map((f) => f.rule));
    expect(results.map((x) => x.partialFingerprints["hexveroFingerprint/v1"])).toEqual(
      result.findings.map((f) => f.fingerprint),
    );
    const located = results.find((x) => x.locations[0]?.physicalLocation);
    expect(located?.locations[0]?.physicalLocation?.artifactLocation.uri).toBe(
      "hexvero-build/build/notesdesk-1.5.0.asar/main.js",
    );
  });

  it("writes --out once and never over a file without --force", async () => {
    const out = join(dir, "audit.json");
    const path = join(root, "examples", "notesdesk-1.5.0.asar");
    expect((await audit(path, "--format", "json", "--out", out)).code).toBe(3);
    expect(existsSync(out)).toBe(true);
    expect(JSON.parse(readFileSync(out, "utf8")).hexvero).toBe("audit");
    const again = await audit(path, "--format", "json", "--out", out);
    expect(again.code).toBe(2);
    expect(again.io.text()).toContain("pass --force");
    expect((await audit(path, "--out", out, "--force")).code).toBe(3);
  });

  it("is the subcommand even where a file named audit exists, and is in --help", async () => {
    const work = mkdtempSync(join(dir, "cwd-"));
    writeFileSync(join(work, "audit"), "not a build\n");
    const cwd = process.cwd();
    process.chdir(work);
    try {
      const r = await audit();
      expect(r.code).toBe(2);
      expect(r.io.text()).toContain("missing <build>");
    } finally {
      process.chdir(cwd);
    }
    const help = capture();
    expect(await main(["--help"], help)).toBe(0);
    expect(help.text()).toContain("audit <build>");
  });

  it("refuses usage errors (exit 2) and a target that is no Electron app (exit 1)", async () => {
    expect((await audit()).code).toBe(2);
    expect((await audit("a", "b")).code).toBe(2);
    expect((await audit("x.asar", "--format", "markdown")).code).toBe(2);
    expect((await audit("x.asar", "--unknown", "maybe")).code).toBe(2);
    const plain = join(dir, "plain.js");
    writeFileSync(plain, "console.log(1);\n");
    const r = await audit(plain);
    expect(r.code).toBe(1);
    expect(r.io.text()).toContain("Electron application");
  });
});

/** A policy file with the given `audit` section. */
const policyFile = (name: string, section: unknown, extra: Record<string, unknown> = {}) => {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify({ hexvero: "policy", version: 1, audit: section, ...extra }));
  return path;
};

describe("hexvero audit --policy / --baseline", () => {
  const example = join(root, "examples", "notesdesk-1.5.0.asar");
  const findingsOf = async (...argv: string[]) => {
    const r = await audit(example, "--format", "json", ...argv);
    return JSON.parse(r.io.stdout.join("\n")) as {
      status: string;
      findings: Array<{ rule: string; fingerprint: string; state: string; level: string }>;
      baseline?: { matched: number; warnings?: string[] };
    };
  };

  it("writes a baseline with --update-baseline (exit 0); the next run passes, a new finding fails", async () => {
    const baseline = join(dir, "fresh", ".hexvero", "audit-baseline.json");
    const missing = await audit(example, "--baseline", baseline);
    expect(missing.code).toBe(2);
    expect(missing.io.stderr.join("\n")).toContain("does not exist; create it with");
    const update = await audit(example, "--baseline", baseline, "--update-baseline");
    expect(update.code).toBe(0);
    expect(update.io.stderr.join("\n")).toContain("4 finding(s) accepted");
    const written = JSON.parse(readFileSync(baseline, "utf8"));
    expect(written).toMatchObject({ hexvero: "baseline", version: 1, command: "audit" });
    expect(written.fingerprints).toHaveLength(4);
    const again = await audit(example, "--baseline", baseline);
    expect(again.code).toBe(0);
    expect(again.io.text()).toContain("4 finding(s) matched, 4 baselined, 0 new");
    expect(again.io.text()).toContain("baselined · fail");
    // the normal run leaves the file as it was
    expect(JSON.parse(readFileSync(baseline, "utf8"))).toEqual(written);
    // drop one accepted finding: it is new again (exit 3)
    const less = join(dir, "less.json");
    writeFileSync(
      less,
      JSON.stringify({
        ...written,
        fingerprints: written.fingerprints.filter(
          (f: { rule: string }) => f.rule !== "csp-missing",
        ),
      }),
    );
    const r = await audit(example, "--baseline", less);
    expect(r.code).toBe(3);
    expect(r.io.text()).toContain("csp-missing  no Content-Security-Policy  new · fail");
    expect(r.io.text()).toContain("3 baselined, 1 new");
  });

  it("is not decidable (exit 4) when only an unknown is new, as without a baseline", async () => {
    const path = write(
      "unknown-b",
      `${SAFE}function helper(s, url) { s.openExternal(url); }\n`,
      CSP,
    );
    const baseline = join(dir, "unknown-baseline.json");
    expect((await audit(path, "--baseline", baseline, "--update-baseline")).code).toBe(0);
    expect((await audit(path, "--baseline", baseline)).code).toBe(0);
    const empty = join(dir, "empty-baseline.json");
    const file = JSON.parse(readFileSync(baseline, "utf8"));
    writeFileSync(empty, JSON.stringify({ ...file, fingerprints: [] }));
    expect((await audit(path, "--baseline", empty)).code).toBe(4);
  });

  it("applies levels, suppressions and an expired suppression from the policy", async () => {
    const plain = await findingsOf();
    const suppress = (expires: string) =>
      plain.findings.map((f) => ({
        rule: f.rule,
        fingerprint: f.fingerprint,
        reason: "reviewed in #42",
        expires,
      }));
    const live = policyFile("live.json", { suppressions: suppress("2999-12-31") });
    const ok = await audit(example, "--policy", live);
    expect(ok.code).toBe(0);
    expect(ok.io.text()).toContain("suppressed: reviewed in #42 (until 2999-12-31)");
    const lapsed = policyFile("lapsed.json", { suppressions: suppress("2020-01-01") });
    const r = await audit(example, "--policy", lapsed);
    expect(r.code).toBe(3);
    expect(r.io.text()).toContain("suppression expired on 2020-01-01, so the finding counts again");
    const levels = policyFile("levels.json", {
      rules: {
        "open-external": { level: "off" },
        "permission-handler-missing": { level: "warn" },
        "csp-missing": { level: "warn" },
        "navigation-unlimited": { level: "warn" },
      },
    });
    const warned = await findingsOf("--policy", levels);
    expect(warned.status).toBe("pass");
    expect(warned.findings.map((f) => f.rule)).not.toContain("open-external");
    expect(warned.findings.every((f) => f.level === "warn")).toBe(true);
    expect((await audit(example, "--policy", levels)).code).toBe(0);
  });

  it("refuses an invalid policy or baseline (exit 2) and an unreadable policy (exit 1)", async () => {
    const bad = policyFile("bad-audit.json", {
      rules: { "csp-weakened": { level: "fail" } },
      unknown: "maybe",
    });
    const r = await audit(example, "--policy", bad);
    expect(r.code).toBe(2);
    expect(r.io.stderr.join("\n")).toContain("audit.rules.csp-weakened: unknown audit rule");
    expect(r.io.stderr.join("\n")).toContain('audit.unknown: must be "fail", "warn" or "allow"');
    const missing = await audit(example, "--policy", join(dir, "nope.json"));
    expect(missing.code).toBe(1);
    expect(missing.io.text()).toContain("cannot read the policy");
    expect((await audit(example, "--update-baseline")).code).toBe(2);
    // a baseline of hexvero check is not an audit baseline
    const checkBaseline = join(dir, "check-baseline.json");
    const checkIo = capture();
    await main(
      [
        "check",
        join(root, "examples", "notesdesk-1.4.0.asar"),
        example,
        "--policy",
        join(root, "examples", "policy.json"),
        "--baseline",
        checkBaseline,
        "--update-baseline",
      ],
      checkIo,
    );
    const wrong = await audit(example, "--baseline", checkBaseline);
    expect(wrong.code).toBe(2);
    expect(wrong.io.stderr.join("\n")).toContain("written by hexvero check");
    // and the other way round
    const auditBaseline = join(dir, "audit-only.json");
    await audit(example, "--baseline", auditBaseline, "--update-baseline");
    const back = capture();
    const code = await main(
      [
        "check",
        join(root, "examples", "notesdesk-1.4.0.asar"),
        example,
        "--policy",
        join(root, "examples", "policy.json"),
        "--baseline",
        auditBaseline,
      ],
      back,
    );
    expect(code).toBe(2);
    expect(back.text()).toContain("written by hexvero audit");
  });

  it("never writes a baseline through a symbolic link", async (ctx) => {
    const elsewhere = mkdtempSync(join(tmpdir(), "hexvero-audit-elsewhere-"));
    const missing = join(elsewhere, "planted.txt");
    try {
      symlinkSync(missing, join(dir, "dangling-audit-baseline.json"));
    } catch (error) {
      if (["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) ctx.skip();
      throw error;
    }
    const r = await audit(
      example,
      "--baseline",
      join(dir, "dangling-audit-baseline.json"),
      "--update-baseline",
    );
    expect(r.code).not.toBe(0);
    expect(existsSync(missing)).toBe(false);
    rmSync(elsewhere, { recursive: true, force: true });
  });

  it("writes SARIF with suppressions and baselineState", async () => {
    const plain = await findingsOf();
    const csp = plain.findings.find((f) => f.rule === "csp-missing")!;
    const policy = policyFile("sarif.json", {
      suppressions: [
        { rule: "csp-missing", fingerprint: csp.fingerprint, reason: "server sets it" },
      ],
    });
    const baseline = join(dir, "sarif-baseline.json");
    await audit(example, "--baseline", baseline, "--update-baseline");
    const r = await audit(example, "--policy", policy, "--baseline", baseline, "--format", "sarif");
    expect(r.code).toBe(0);
    const log = JSON.parse(r.io.stdout.join("\n"));
    const results = log.runs[0].results as Array<Record<string, unknown>>;
    expect(results).toHaveLength(4);
    expect(results.every((x) => x["baselineState"] === "unchanged")).toBe(true);
    expect(results.find((x) => x["ruleId"] === "csp-missing")?.["suppressions"]).toEqual([
      { kind: "external", status: "accepted", justification: "server sets it" },
    ]);
    // the baseline was written without the policy: said on stderr, not in the data
    expect(r.io.stderr.join("\n")).toContain("the baseline was written without a policy");
  });
});
