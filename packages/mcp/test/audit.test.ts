/**
 * `hexvero_check` without targetB: `hexvero audit` of one build over MCP (the Electron security
 * rules, the policy's `audit` section, audit baselines), read-only and paged like the check.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  Session,
  auditBuild,
  checkRelease,
  createAuditBaseline,
  createBaseline,
  parsePolicy,
} from "@hexvero/core";
import { createHexveroServer } from "../src/index.js";
import { CHECK_RESULT_BYTES } from "../src/check.js";
import { buildAsar } from "../../core/test/fixtures/asar.js";

const examples = resolve(import.meta.dirname, "..", "..", "..", "examples");
const policyPath = join(examples, "policy.json");
const examplePolicy = JSON.parse(readFileSync(policyPath, "utf8")) as Record<string, unknown>;

const dir = mkdtempSync(join(tmpdir(), "hexvero-mcp-audit-"));
const session = new Session();
const client = new Client({ name: "audit-test", version: "0" });
let v14 = "";
let v15 = "";
beforeAll(async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createHexveroServer(session).connect(serverTransport);
  await client.connect(clientTransport);
  v14 = (await session.open(join(examples, "notesdesk-1.4.0.asar"))).id;
  v15 = (await session.open(join(examples, "notesdesk-1.5.0.asar"))).id;
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const call = async (args: Record<string, unknown>) => {
  const result = await client.callTool({ name: "hexvero_check", arguments: args });
  const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
  if (!result.isError)
    expect(result["_meta"]?.["io.github.maximilianfeix.hexvero/untrustedContent"]).toBe(true);
  return { ok: !result.isError, text, body: JSON.parse(text) as Record<string, unknown> };
};
const error = (r: { body: Record<string, unknown> }) =>
  r.body["error"] as { code: string; message: string; details: Record<string, unknown> };

/** Every limit the audit rules ask for: a CSP, a permission handler, navigation limits. */
const SAFE = `const { app, BrowserWindow, session } = require("electron");
app.on("web-contents-created", (e, contents) => {
  contents.on("will-navigate", (ev) => ev.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
});
session.defaultSession.setPermissionRequestHandler((wc, p, cb) => cb(false));
app.whenReady().then(() => {
  const win = new BrowserWindow({ webPreferences: { contextIsolation: true, sandbox: true } });
  win.loadFile("index.html");
});
`;
/** A will-navigate listener on a webContents hexvero cannot tie to the window: undecidable. */
const UNDECIDED = `const { app, BrowserWindow, session } = require("electron");
session.defaultSession.setPermissionRequestHandler((wc, p, cb) => cb(false));
function watch(contents) { contents.on("will-navigate", (e) => e.preventDefault()); }
app.whenReady().then(() => {
  const win = new BrowserWindow({ webPreferences: { contextIsolation: true, sandbox: true } });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  watch(win.webContents);
});
`;
let n = 0;
const openApp = async (main: string): Promise<string> => {
  const path = join(dir, `app-${n++}.asar`);
  writeFileSync(
    path,
    buildAsar({
      "package.json": JSON.stringify({
        name: "a",
        main: "main.js",
        devDependencies: { electron: "^33.0.0" },
      }),
      "main.js": main,
      "index.html": `<meta http-equiv="Content-Security-Policy" content="default-src 'self'">`,
    }),
  );
  return (await session.open(path)).id;
};

describe("hexvero_check: audit of one build", () => {
  it("is a mode of the existing tool: targetB optional, unknown as a parameter, still 16 tools", async () => {
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(16);
    const check = tools.find((t) => t.name === "hexvero_check")!;
    expect(check.inputSchema.required).toEqual(["targetA"]);
    expect(check.description).toMatch(/omit targetB/i);
    expect(Object.keys(check.inputSchema.properties ?? {})).toContain("unknown");
  });

  it("fails a build that violates a rule, with the same findings as auditBuild", async () => {
    const r = await call({ targetA: v15 });
    expect(r.ok).toBe(true);
    expect(r.body).toMatchObject({ hexvero: "audit", version: 1, status: "fail", unknown: "fail" });
    const findings = r.body["findings"] as Array<{ rule: string; state: string; level: string }>;
    expect(findings.map((f) => f.rule)).toEqual([
      "open-external",
      "permission-handler-missing",
      "csp-missing",
      "navigation-unlimited",
    ]);
    expect(findings).toEqual((await auditBuild(session, v15)).findings);
    expect(r.body["findingsPage"]).toMatchObject({ offset: 0, total: 4, next: null });
    expect(r.body["counts"]).toMatchObject({ new: 4, fail: 4, warn: 0, unknown: 0 });
    expect(r.body["policy"]).toBeUndefined();
  });

  it("passes a build that keeps every rule", async () => {
    const r = await call({ targetA: await openApp(SAFE) });
    expect(r.body).toMatchObject({ hexvero: "audit", status: "pass", findings: [] });
    expect(r.body["incomplete"]).toEqual([]);
  });

  it("is incomplete when a rule cannot be decided, and passes with unknown: warn", async () => {
    const id = await openApp(UNDECIDED);
    const r = await call({ targetA: id });
    expect(r.body["status"]).toBe("incomplete");
    const findings = r.body["findings"] as Array<{ rule: string; unknown: boolean }>;
    expect(findings).toEqual([
      expect.objectContaining({ rule: "navigation-unlimited", unknown: true }),
    ]);
    expect(r.body["counts"]).toMatchObject({ unknown: 1 });
    const warn = await call({ targetA: id, unknown: "warn" });
    expect(warn.body).toMatchObject({ status: "pass", unknown: "warn" });
    expect((warn.body["findings"] as unknown[]).length).toBe(1);
  });

  it("applies the policy's audit section: levels, unknown and suppressions", async () => {
    const levels = await call({
      targetA: v15,
      policy: {
        hexvero: "policy",
        version: 1,
        audit: {
          rules: {
            "open-external": { level: "off" },
            "permission-handler-missing": { level: "warn" },
            "csp-missing": { level: "warn" },
            "navigation-unlimited": { level: "warn" },
          },
        },
      },
    });
    expect(levels.body).toMatchObject({ status: "pass", policy: { file: "inline" } });
    expect(levels.body["counts"]).toMatchObject({ warn: 3, fail: 0 });
    const first = await auditBuild(session, v15);
    const suppressions = first.findings.map((f) => ({
      rule: f.rule,
      fingerprint: f.fingerprint,
      reason: "reviewed",
    }));
    const file = join(dir, "audit-policy.json");
    writeFileSync(file, JSON.stringify({ hexvero: "policy", version: 1, audit: { suppressions } }));
    const suppressed = await call({ targetA: v15, policyPath: file });
    expect(suppressed.body).toMatchObject({ status: "pass", policy: { file } });
    expect(suppressed.body["counts"]).toMatchObject({ suppressed: 4 });
    // the example policy has no audit section: every rule at fail, as without a policy
    const example = await call({ targetA: v15, policyPath });
    expect(example.body).toMatchObject({ status: "fail", policy: { file: policyPath } });
  });

  it("matches an audit baseline it reads, never writes one, and refuses a check baseline", async () => {
    const path = join(dir, "audit-baseline.json");
    const missing = await call({ targetA: v15, baselinePath: path });
    expect(error(missing).code).toBe("not_found");
    expect(error(missing).message).toContain("hexvero audit <build> --baseline");
    writeFileSync(
      path,
      JSON.stringify(createAuditBaseline(await auditBuild(session, v15, { digest: true }))),
    );
    const before = readFileSync(path, "utf8");
    const r = await call({ targetA: v15, baselinePath: path });
    expect(r.body).toMatchObject({ status: "pass", baseline: { file: path, matched: 4 } });
    expect(r.body["counts"]).toMatchObject({ baselined: 4 });
    expect(readFileSync(path, "utf8")).toBe(before);
    // 1.4.0 has two window-permissive findings the baseline does not have
    const older = await call({ targetA: v14, baselinePath: path });
    expect(older.body["status"]).toBe("fail");
    expect(older.body["counts"]).toMatchObject({ new: 2, baselined: 4 });

    const checkBaseline = join(dir, "check-baseline.json");
    const loaded = parsePolicy(readFileSync(policyPath, "utf8"), policyPath);
    writeFileSync(
      checkBaseline,
      JSON.stringify(createBaseline(await checkRelease(session, v14, v15, loaded))),
    );
    const wrong = await call({ targetA: v15, baselinePath: checkBaseline });
    expect(error(wrong).code).toBe("invalid_input");
    expect(error(wrong).details["issues"]).toEqual([
      expect.stringContaining("written by hexvero check"),
    ]);
    // and the check refuses an audit baseline
    const reverse = await call({ targetA: v14, targetB: v15, policyPath, baselinePath: path });
    expect(error(reverse).code).toBe("invalid_input");
  });

  it("reads policy and baseline only inside the allowed directories, as the check", async () => {
    const roots = mkdtempSync(join(tmpdir(), "hexvero-roots-"));
    const elsewhere = mkdtempSync(join(tmpdir(), "hexvero-elsewhere-"));
    const previous = process.env["HEXVERO_WRITE_ROOTS"];
    process.env["HEXVERO_WRITE_ROOTS"] = roots;
    try {
      const outside = join(elsewhere, "policy.json");
      writeFileSync(outside, JSON.stringify(examplePolicy));
      for (const field of ["policyPath", "baselinePath"]) {
        const r = await call({ targetA: v15, [field]: outside });
        expect(error(r).code).toBe("invalid_input");
        expect(error(r).message).toContain("outside the allowed directories");
      }
      writeFileSync(join(roots, "policy.txt"), JSON.stringify(examplePolicy));
      const txt = await call({ targetA: v15, policyPath: join(roots, "policy.txt") });
      expect(error(txt).message).toContain("must end in .json");
      const both = await call({ targetA: v15, policy: examplePolicy, policyPath });
      expect(error(both).code).toBe("invalid_input");
    } finally {
      if (previous === undefined) delete process.env["HEXVERO_WRITE_ROOTS"];
      else process.env["HEXVERO_WRITE_ROOTS"] = previous;
      rmSync(roots, { recursive: true, force: true });
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("returns SARIF, refuses markdown and refuses unknown for two builds", async () => {
    const sarif = await call({ targetA: v15, format: "sarif" });
    expect(sarif.body).toMatchObject({ status: "fail", format: "sarif" });
    const log = sarif.body["sarif"] as { version: string; runs: Array<{ results: unknown[] }> };
    expect(log.version).toBe("2.1.0");
    expect(log.runs[0]!.results).toHaveLength(4);
    const md = await call({ targetA: v15, format: "markdown" });
    expect(error(md).code).toBe("invalid_input");
    expect(error(md).message).toContain("json or sarif");
    const two = await call({ targetA: v14, targetB: v15, policyPath, unknown: "warn" });
    expect(error(two).code).toBe("invalid_input");
    expect(error(two).message).toContain("policy");
  });

  it("refuses a target that is not an Electron application", async () => {
    const js = (await session.open(join(examples, "notesdesk-1.5.0.bundle.js"))).id;
    const r = await call({ targetA: js });
    expect(r.ok).toBe(false);
    expect(error(r).code).toBe("invalid_input");
    expect(error(r).message).toContain("hexvero audit reads an Electron application");
  });

  it("pages the findings within the byte budget and bounds places per finding", async () => {
    // long window names make each finding large, so 500 of them exceed the budget
    const windows = Array.from(
      { length: 150 },
      (_, i) =>
        `const w${i}_${"x".repeat(400)} = new BrowserWindow({ webPreferences: { nodeIntegration: true, contextIsolation: false } });`,
    );
    const opens = Array.from({ length: 30 }, (_, i) => `shell.openExternal(u${i});`);
    const id = await openApp(
      `const { BrowserWindow, shell } = require("electron");\n${windows.join("\n")}\n${opens.join("\n")}\n`,
    );
    const r = await call({ targetA: id, limit: 500 });
    expect(r.ok).toBe(true);
    expect(Buffer.byteLength(r.text)).toBeLessThanOrEqual(CHECK_RESULT_BYTES);
    const page = r.body["findingsPage"] as { total: number; limit: number; next: number | null };
    // the page was cut to fit, not to the limit asked for
    expect(page.limit).toBeLessThan(Math.min(500, page.total));
    expect(page.next).toBe(page.limit);
    const all = (await auditBuild(session, id)).findings;
    expect(page.total).toBe(all.length);
    const open = all.find((f) => f.rule === "open-external")!;
    const rest = await call({ targetA: id, offset: all.indexOf(open), limit: 1 });
    const shown = (rest.body["findings"] as Array<{ where: unknown[]; whereTotal?: number }>)[0]!;
    expect(open.where.length).toBe(30);
    expect(shown.where).toHaveLength(20);
    expect(shown.whereTotal).toBe(30);
  });
});
