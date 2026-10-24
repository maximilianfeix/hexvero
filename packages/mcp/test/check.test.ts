/**
 * `hexvero_check` (the release policy over MCP) and per-list paging of `hexvero_compare`.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Session, checkRelease, createBaseline, parsePolicy } from "@hexvero/core";
import { createHexveroServer } from "../src/index.js";
import { CHECK_RESULT_BYTES } from "../src/check.js";
import { buildAsar } from "../../core/test/fixtures/asar.js";
import { buildZip } from "../../core/test/fixtures/zip.js";

const examples = resolve(import.meta.dirname, "..", "..", "..", "examples");
const policyPath = join(examples, "policy.json");
const examplePolicy = JSON.parse(readFileSync(policyPath, "utf8")) as Record<string, unknown>;

const dir = mkdtempSync(join(tmpdir(), "hexvero-mcp-check-"));
const session = new Session();
const client = new Client({ name: "check-test", version: "0" });
let a = "";
let b = "";
beforeAll(async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createHexveroServer(session).connect(serverTransport);
  await client.connect(clientTransport);
  a = (await session.open(join(examples, "notesdesk-1.4.0.asar"))).id;
  b = (await session.open(join(examples, "notesdesk-1.5.0.asar"))).id;
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** An app that fetches `n` distinct long host names, for a large check. */
const host = (i: number) => `h${i}-${"x".repeat(40)}.unlisted-example.net`;
const app = (hosts: number) =>
  buildAsar({
    "package.json": JSON.stringify({ name: "many", main: "main.js" }),
    "main.js": Array.from(
      { length: hosts },
      (_, i) => `fetch("https://${host(i)}/path/${"p".repeat(60)}");`,
    ).join("\n"),
  });
/** An app that fetches `n` URLs whose host starts with `prefix`. */
const urls = (prefix: string, n: number) =>
  buildAsar({
    "package.json": JSON.stringify({ name: "p", main: "main.js" }),
    "main.js": Array.from(
      { length: n },
      (_, i) => `fetch("https://${prefix}${i}.example.org/x");`,
    ).join("\n"),
  });

const call = async (name: string, args: Record<string, unknown>) => {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
  if (!result.isError)
    expect(result["_meta"]?.["io.github.maximilianfeix.hexvero/untrustedContent"]).toBe(true);
  return { ok: !result.isError, text, body: JSON.parse(text) as Record<string, unknown> };
};

describe("hexvero_check", () => {
  it("is listed as the sixteenth, read-only tool within the catalog budget", async () => {
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(16);
    const check = tools.find((t) => t.name === "hexvero_check")!;
    expect(check.annotations?.readOnlyHint).toBe(true);
    expect(check.annotations?.destructiveHint).toBe(false);
    expect(Object.keys(check.inputSchema.properties ?? {})).toEqual([
      "targetA",
      "targetB",
      "policy",
      "policyPath",
      "baselinePath",
      "format",
      "offset",
      "limit",
    ]);
    expect(Buffer.byteLength(JSON.stringify(tools))).toBeLessThan(32 * 1024);
  });

  it("fails the example release with an inline policy, as the CLI does", async () => {
    const r = await call("hexvero_check", { targetA: a, targetB: b, policy: examplePolicy });
    expect(r.ok).toBe(true);
    expect(r.body).toMatchObject({ hexvero: "check", version: 1, status: "fail" });
    const findings = r.body["findings"] as Array<{ rule: string; key: string; state: string }>;
    expect(findings.map((f) => [f.rule, f.key, f.state])).toEqual([
      ["new-interface-member", "notesdesk.checkUpdate", "new"],
      ["new-external-host", "updates.notesdesk.example", "new"],
    ]);
    expect(r.body["policy"]).toMatchObject({ file: "inline" });
    expect(r.body["findingsPage"]).toMatchObject({ offset: 0, total: 2, next: null });
    // same model as `hexvero check --format json`
    const direct = await checkRelease(
      session,
      a,
      b,
      parsePolicy(JSON.stringify(examplePolicy), "inline"),
    );
    expect(findings).toEqual(direct.findings);
  });

  it("passes when the policy allows what changed, and reads a policy file", async () => {
    const lenient = {
      ...examplePolicy,
      rules: {
        "new-interface-member": { level: "warn" },
        "new-external-host": {
          level: "fail",
          allow: ["api.notesdesk.example", "*.notesdesk.example"],
        },
        "window-more-permissive": { level: "fail" },
      },
    };
    const pass = await call("hexvero_check", { targetA: a, targetB: b, policy: lenient });
    expect(pass.body["status"]).toBe("pass");
    expect(pass.body["counts"]).toMatchObject({ warn: 1, fail: 0 });
    const same = await call("hexvero_check", { targetA: a, targetB: a, policyPath });
    expect(same.body).toMatchObject({ status: "pass", findings: [] });
    expect((same.body["policy"] as { file: string }).file).toBe(policyPath);
  });

  it("matches a baseline it reads and never writes one", async () => {
    const missing = join(dir, "baseline.json");
    const none = await call("hexvero_check", {
      targetA: a,
      targetB: b,
      policyPath,
      baselinePath: missing,
    });
    expect(none.ok).toBe(false);
    expect(none.body["error"]).toMatchObject({ code: "not_found" });
    expect((none.body["error"] as { message: string }).message).toContain("--update-baseline");
    expect(existsSync(missing)).toBe(false);
    const loaded = parsePolicy(readFileSync(policyPath, "utf8"), policyPath);
    writeFileSync(
      missing,
      JSON.stringify(createBaseline(await checkRelease(session, a, b, loaded))),
    );
    const before = readFileSync(missing, "utf8");
    const r = await call("hexvero_check", {
      targetA: a,
      targetB: b,
      policyPath,
      baselinePath: missing,
    });
    expect(r.body).toMatchObject({ status: "pass", baseline: { matched: 2 } });
    expect(readFileSync(missing, "utf8")).toBe(before);
  });

  it("renders markdown and SARIF over the same result", async () => {
    const md = await call("hexvero_check", {
      targetA: a,
      targetB: b,
      policy: examplePolicy,
      format: "markdown",
    });
    expect(md.body).toMatchObject({ status: "fail", format: "markdown" });
    expect(md.body["text"]).toContain("# hexvero check: fail");
    const sarif = await call("hexvero_check", {
      targetA: a,
      targetB: b,
      policy: examplePolicy,
      format: "sarif",
    });
    const log = sarif.body["sarif"] as { version: string; runs: Array<{ results: unknown[] }> };
    expect(log.version).toBe("2.1.0");
    expect(log.runs[0]!.results).toHaveLength(2);
  });

  it("refuses an invalid policy with every problem named", async () => {
    const r = await call("hexvero_check", {
      targetA: a,
      targetB: b,
      policy: { hexvero: "policy", version: 2, rules: { "new-hosts": { level: "fail" } } },
    });
    expect(r.ok).toBe(false);
    const error = r.body["error"] as {
      code: string;
      message: string;
      details: { issues: string[] };
    };
    expect(error.code).toBe("invalid_input");
    expect(error.message).toBe("invalid policy inline");
    expect(error.details.issues).toEqual([
      "version: this hexvero reads policy version 1, got 2",
      "rules.new-hosts: unknown rule (known: new-interface-member, new-external-host, window-more-permissive, new-bridge-exposure, fuse-weakened, remote-enabled, new-unsafe-switch, new-open-external, permission-handler-grants-all, csp-weakened)",
    ]);
    const both = await call("hexvero_check", {
      targetA: a,
      targetB: b,
      policy: examplePolicy,
      policyPath,
    });
    expect(both.body["error"]).toMatchObject({ code: "invalid_input" });
    const neither = await call("hexvero_check", { targetA: a, targetB: b });
    expect(neither.body["error"]).toMatchObject({ code: "invalid_input" });
  });

  it("reports a policy path that does not exist", async () => {
    const path = join(dir, "no-such-policy.json");
    const r = await call("hexvero_check", { targetA: a, targetB: b, policyPath: path });
    expect(r.ok).toBe(false);
    expect(r.body["error"]).toMatchObject({ code: "not_found" });
    expect((r.body["error"] as { details: { path: string } }).details.path).toMatch(
      /no-such-policy\.json$/,
    );
    const notFile = await call("hexvero_check", { targetA: a, targetB: b, policyPath: dir });
    expect(notFile.body["error"]).toMatchObject({ code: "invalid_input" });
  });

  it("reads policy and baseline files only inside the allowed directories", async () => {
    const roots = mkdtempSync(join(tmpdir(), "hexvero-roots-"));
    const elsewhere = mkdtempSync(join(tmpdir(), "hexvero-elsewhere-"));
    const previous = process.env["HEXVERO_WRITE_ROOTS"];
    process.env["HEXVERO_WRITE_ROOTS"] = roots;
    try {
      const policyText = readFileSync(policyPath, "utf8");
      const outside = join(elsewhere, "policy.json");
      writeFileSync(outside, policyText);
      const refused = await call("hexvero_check", { targetA: a, targetB: b, policyPath: outside });
      expect(refused.body["error"]).toMatchObject({ code: "invalid_input" });
      expect((refused.body["error"] as { message: string }).message).toContain(
        "outside the allowed directories",
      );
      const baselineOutside = await call("hexvero_check", {
        targetA: a,
        targetB: b,
        policy: examplePolicy,
        baselinePath: join(elsewhere, "baseline.json"),
      });
      expect((baselineOutside.body["error"] as { message: string }).message).toContain(
        "outside the allowed directories",
      );
      // a symlink inside a root that leads out of it is judged by where it leads
      const link = join(roots, "policy.json");
      symlinkSync(outside, link);
      const viaLink = await call("hexvero_check", { targetA: a, targetB: b, policyPath: link });
      expect((viaLink.body["error"] as { message: string }).message).toContain(
        "outside the allowed directories",
      );
      // only .json files are read
      writeFileSync(join(roots, "policy.txt"), policyText);
      const txt = await call("hexvero_check", {
        targetA: a,
        targetB: b,
        policyPath: join(roots, "policy.txt"),
      });
      expect((txt.body["error"] as { message: string }).message).toContain("must end in .json");
      // the directory of an opened target is readable: a policy next to the builds it checks
      writeFileSync(
        join(elsewhere, "app.asar"),
        buildAsar({ "package.json": JSON.stringify({ name: "beside", main: "main.js" }) }),
      );
      await session.open(join(elsewhere, "app.asar"));
      const beside = await call("hexvero_check", { targetA: a, targetB: b, policyPath: outside });
      expect(beside.body["status"]).toBe("fail");
    } finally {
      if (previous === undefined) delete process.env["HEXVERO_WRITE_ROOTS"];
      else process.env["HEXVERO_WRITE_ROOTS"] = previous;
      rmSync(roots, { recursive: true, force: true });
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("reads a policy next to a ZIP whose Electron app was opened", async () => {
    const roots = mkdtempSync(join(tmpdir(), "hexvero-roots-"));
    const elsewhere = mkdtempSync(join(tmpdir(), "hexvero-zip-"));
    const previous = process.env["HEXVERO_WRITE_ROOTS"];
    process.env["HEXVERO_WRITE_ROOTS"] = roots;
    try {
      const outside = join(elsewhere, "policy.json");
      writeFileSync(outside, readFileSync(policyPath, "utf8"));
      const zip = join(elsewhere, "release.zip");
      writeFileSync(
        zip,
        buildZip({
          "X.app/Contents/Resources/app.asar": buildAsar({
            "package.json": JSON.stringify({ name: "zipped", main: "main.js" }),
          }),
        }),
      );
      const opened = await session.open(zip);
      expect(opened.info.container?.format).toBe("zip");
      const beside = await call("hexvero_check", { targetA: a, targetB: b, policyPath: outside });
      expect(beside.body["status"]).toBe("fail");
    } finally {
      if (previous === undefined) delete process.env["HEXVERO_WRITE_ROOTS"];
      else process.env["HEXVERO_WRITE_ROOTS"] = previous;
      rmSync(roots, { recursive: true, force: true });
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("never quotes a file it could not use", async () => {
    const notJson = join(dir, "secret.json");
    writeFileSync(notJson, "{\n  TOKEN=s3cr3t-value\n}");
    const r = await call("hexvero_check", { targetA: a, targetB: b, policyPath: notJson });
    expect(r.body["error"]).toMatchObject({ code: "invalid_input" });
    expect((r.body["error"] as { message: string }).message).toMatch(
      /not valid JSON at line 2 col 3$/,
    );
    expect(r.text).not.toContain("s3cr3t");
    expect(r.text).not.toContain("TOKEN");
    const otherJson = join(dir, "config.json");
    writeFileSync(otherJson, JSON.stringify({ apiKey: "s3cr3t-value", hexvero: "x" }));
    for (const field of ["policyPath", "baselinePath"]) {
      const o = await call("hexvero_check", {
        targetA: a,
        targetB: b,
        ...(field === "policyPath" ? {} : { policy: examplePolicy }),
        [field]: otherJson,
      });
      expect(o.body["error"]).toMatchObject({ code: "invalid_input" });
      expect((o.body["error"] as { message: string }).message).toContain("is not a hexvero");
      expect(o.text).not.toContain("s3cr3t");
      expect(o.text).not.toContain("apiKey");
    }
  });

  it.skipIf(process.platform === "win32")("refuses a FIFO without blocking on it", async () => {
    const fifo = join(dir, "fifo.json");
    execFileSync("mkfifo", [fifo]);
    const r = await call("hexvero_check", { targetA: a, targetB: b, policyPath: fifo });
    expect(r.body["error"]).toMatchObject({ code: "invalid_input" });
    expect((r.body["error"] as { message: string }).message).toContain("not a regular file");
  });

  it("keeps a large result within its byte budget and pages the findings", async () => {
    writeFileSync(join(dir, "few.asar"), app(1));
    writeFileSync(join(dir, "many.asar"), app(1200));
    const few = (await session.open(join(dir, "few.asar"))).id;
    const many = (await session.open(join(dir, "many.asar"))).id;
    const r = await call("hexvero_check", {
      targetA: few,
      targetB: many,
      policy: examplePolicy,
      limit: 500,
    });
    expect(r.ok).toBe(true);
    expect(Buffer.byteLength(r.text)).toBeLessThanOrEqual(CHECK_RESULT_BYTES);
    expect(r.body["status"]).toBe("fail");
    const page = r.body["findingsPage"] as { total: number; limit: number; next: number | null };
    expect(page.total).toBe(1199);
    expect(page.limit).toBeLessThan(500);
    expect(page.next).toBe(page.limit);
    expect(r.body["counts"]).toMatchObject({ new: 1199 });
    const second = await call("hexvero_check", {
      targetA: few,
      targetB: many,
      policy: examplePolicy,
      offset: page.next,
      limit: 2,
    });
    expect(second.body["findingsPage"]).toMatchObject({ offset: page.next, total: 1199 });
    expect((second.body["findings"] as unknown[]).length).toBe(2);
  });
});

describe("hexvero_compare paging", () => {
  it("pages each list on its own", async () => {
    writeFileSync(join(dir, "old.asar"), urls("old", 7));
    writeFileSync(join(dir, "new.asar"), urls("new", 3));
    const x = (await session.open(join(dir, "old.asar"))).id;
    const y = (await session.open(join(dir, "new.asar"))).id;
    const base = { targetA: x, targetB: y, collection: "endpoints", limit: 2 };
    const first = await call("hexvero_compare", base);
    expect(first.ok).toBe(true);
    const removed = first.body["removed"] as { count: number; sample: unknown[]; next?: number };
    const added = first.body["added"] as { count: number; sample: unknown[]; next?: number };
    expect([removed.count, added.count]).toEqual([7, 3]);
    expect([removed.next, added.next]).toEqual([2, 2]);
    expect(first.body["completeness"]).toMatchObject({ complete: true });
    expect(first.body["shown"]).toContain('removed 2 of 7 (next: list "removed", offset 2)');
    // an offset without its list is refused rather than applied to every list
    const ambiguous = await call("hexvero_compare", { ...base, offset: 2 });
    expect(ambiguous.body["error"]).toMatchObject({ code: "invalid_input" });
    // following removed's own next reaches every removed item exactly once
    const seen = [...removed.sample];
    let next = removed.next;
    while (next !== undefined) {
      const page = await call("hexvero_compare", { ...base, list: "removed", offset: next });
      const r = page.body["removed"] as { sample: unknown[]; next?: number };
      // the other lists only report their counts on a page of one list
      expect(page.body["added"]).toEqual({ count: 3 });
      seen.push(...r.sample);
      next = r.next;
    }
    expect(seen).toHaveLength(7);
    expect(new Set(seen.map((s) => JSON.stringify(s))).size).toBe(7);
    // added has its own cursor: offset 2 of added is its third item, not removed's
    const addedRest = await call("hexvero_compare", { ...base, list: "added", offset: 2 });
    const rest = addedRest.body["added"] as { sample: unknown[]; next?: number };
    expect(rest.sample).toHaveLength(1);
    expect(rest.next).toBeUndefined();
  });
});
