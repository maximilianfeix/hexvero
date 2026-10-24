import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
