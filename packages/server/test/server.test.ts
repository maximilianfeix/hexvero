import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildAsar } from "../../core/test/fixtures/asar.js";
import { buildElf } from "../../core/test/fixtures/elf.js";
import { startServer, type RunningServer } from "../src/index.js";

const appFiles = (v: string): Record<string, string> => ({
  "package.json": JSON.stringify({ name: "x", version: v, main: "main.js" }),
  "main.js": `require("electron").ipcMain.handle("${v === "1" ? "old" : "new"}:ping", () => 1);\n`,
});

describe("hexvero HTTP API", () => {
  const dir = mkdtempSync(join(tmpdir(), "hexvero-http-"));
  let running: RunningServer;
  let targetId = "";
  beforeAll(async () => {
    writeFileSync(join(dir, "index.html"), "<!doctype html><title>ui</title>");
    running = await startServer({ staticDir: dir });
  });
  afterAll(async () => {
    await running.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const api = async (
    path: string,
    init: RequestInit = {},
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const res = await fetch(`${running.url}/api${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${running.token}`,
        ...init.headers,
      },
    });
    return {
      status: res.status,
      body: (await res.json()) as Record<string, unknown>,
    };
  };

  it("rejects requests without the token and cross-origin callers", async () => {
    const res = await fetch(`${running.url}/api/health`);
    expect(res.status).toBe(401);
    const cross = await fetch(`${running.url}/api/health`, {
      headers: {
        authorization: `Bearer ${running.token}`,
        origin: "http://evil.example",
      },
    });
    expect(cross.status).toBe(403);
    expect((await api("/health")).body).toMatchObject({ ok: true });
    // DNS rebinding: Host and Origin agree but neither is the loopback host
    const port = new URL(running.url).port;
    const rebound = await fetch(`${running.url}/api/health`, {
      headers: {
        authorization: `Bearer ${running.token}`,
        host: `evil.test:${port}`,
        origin: `http://evil.test:${port}`,
      },
    });
    expect(rebound.status).toBe(403);
    // a token in the query string unlocks nothing, the export download included
    expect((await fetch(`${running.url}/api/health?token=${running.token}`)).status).toBe(401);
    const badJson = await api("/targets", {
      method: "POST",
      body: "{bad json",
      headers: { "content-type": "application/json" },
    });
    expect(badJson.status).toBe(400);
    expect((badJson.body["error"] as { code: string }).code).toBe("invalid_input");
  });

  it("registers targets by path and by upload", async () => {
    const path = join(dir, "lib.so");
    writeFileSync(path, buildElf());
    const opened = await api("/targets", {
      method: "POST",
      body: JSON.stringify({ path }),
    });
    expect(opened.status).toBe(201);
    targetId = opened.body["id"] as string;
    const uploaded = await api("/uploads?name=mem.so", {
      method: "POST",
      body: buildElf({ nx: false }),
    });
    expect(uploaded.status).toBe(201);
    expect((uploaded.body["info"] as { format: string }).format).toBe("elf");
    expect(((await api("/targets")).body["targets"] as unknown[]).length).toBe(2);
  });

  it("serves analysis, collections, strings, bytes and export", async () => {
    const analysis = await api(`/targets/${targetId}/analysis`);
    expect(analysis.status).toBe(200);
    expect(analysis.body["summary"]).toContain("ELF64");
    expect((analysis.body["data"] as { kind: string }).kind).toBe("binary");
    const page = await api(`/targets/${targetId}/collections/symbols?limit=1`);
    expect(page.body).toMatchObject({ total: 2, truncated: true });
    const strings = await api(`/targets/${targetId}/strings?tag=path`);
    expect((strings.body["items"] as Array<{ value: string }>)[0]?.value).toContain("ld-linux");
    const bytes = await api(`/targets/${targetId}/bytes?offset=0&length=4`);
    expect(bytes.body["hex"]).toBe("7f454c46");
    const exported = await fetch(`${running.url}/api/targets/${targetId}/export`, {
      headers: { authorization: `Bearer ${running.token}` },
    });
    expect(exported.headers.get("content-disposition")).toContain("attachment");
    expect(((await exported.json()) as { hexvero: number }).hexvero).toBe(1);
    const missing = await api(`/targets/t_nope/analysis`);
    expect(missing.status).toBe(404);
    expect((await api(`/targets/${targetId}/bytes?offset=abc`)).status).toBe(400);
    const byQuery = await fetch(
      `${running.url}/api/targets/${targetId}/export?token=${running.token}`,
    );
    expect(byQuery.status).toBe(401);
    const download = await fetch(`${running.url}/api/targets/${targetId}/export`, {
      headers: { authorization: `Bearer ${running.token}` },
    });
    expect(download.status).toBe(200);
    expect(download.headers.get("content-disposition")).toContain(".hexvero.json");
  });

  it("serves the static UI with an SPA fallback", async () => {
    const index = await fetch(`${running.url}/`);
    expect(index.headers.get("content-type")).toContain("text/html");
    const deep = await fetch(`${running.url}/targets/abc/strings`);
    expect(await deep.text()).toContain("<title>ui</title>");
    const traversal = await fetch(`${running.url}/../../etc/passwd`);
    expect(await traversal.text()).toContain("<title>ui</title>");
  });

  it("compares two targets, writes the report and opens only read source files", async () => {
    writeFileSync(join(dir, "a.asar"), buildAsar(appFiles("1")));
    writeFileSync(join(dir, "b.asar"), buildAsar(appFiles("2")));
    const demo = await startServer({
      staticDir: dir,
      demoFiles: [join(dir, "a.asar"), join(dir, "b.asar")],
    });
    try {
      const call = (path: string, init: RequestInit = {}): Promise<Response> =>
        fetch(`${demo.url}/api${path}`, {
          ...init,
          headers: { authorization: `Bearer ${demo.token}` },
        });
      expect((await call("/demo")).status).toBe(404); // GET is not a route
      const opened = (await (await call("/demo", { method: "POST" })).json()) as {
        a: { id: string };
        b: { id: string };
      };
      const { a, b } = { a: opened.a.id, b: opened.b.id };
      expect((await call(`/compare?a=${a}`)).status).toBe(400);
      expect((await call(`/compare?a=${a}&b=${a}`)).status).toBe(400);
      const comparison = (await (await call(`/compare?a=${a}&b=${b}`)).json()) as {
        changes: Array<{ change: string; key: string }>;
      };
      expect(comparison.changes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ change: "added", key: "new:ping" }),
          expect.objectContaining({ change: "removed", key: "old:ping" }),
        ]),
      );
      const report = await call(`/compare/report?a=${a}&b=${b}`);
      expect(report.headers.get("content-type")).toContain("text/markdown");
      expect(report.headers.get("content-disposition")).toContain('filename="a-to-b.md"');
      expect(await report.text()).toContain("# What changed: a.asar → b.asar");
      const source = (await (await call(`/targets/${b}/source?file=main.js&line=1`)).json()) as {
        lines: string[];
      };
      expect(source.lines[0]).toContain("new:ping");
      expect((await call(`/targets/${b}/source?file=package.json&line=1`)).status).toBe(404);
      expect((await fetch(`${demo.url}/api/compare?a=${a}&b=${b}`)).status).toBe(401);
    } finally {
      await demo.close();
    }
    expect((await api("/demo", { method: "POST" })).status).toBe(404);
  });

  it("pages the comparison with offset and limit and checks both", async () => {
    writeFileSync(join(dir, "p1.asar"), buildAsar(appFiles("1")));
    writeFileSync(join(dir, "p2.asar"), buildAsar(appFiles("2")));
    const a = (
      await api("/targets", {
        method: "POST",
        body: JSON.stringify({ path: join(dir, "p1.asar") }),
      })
    ).body["id"] as string;
    const b = (
      await api("/targets", {
        method: "POST",
        body: JSON.stringify({ path: join(dir, "p2.asar") }),
      })
    ).body["id"] as string;
    type Paged = {
      changes: Array<{ key: string }>;
      page: { offset: number; limit: number; total: number; next: number | null };
    };
    const all = (await api(`/compare?a=${a}&b=${b}`)).body as unknown as Paged;
    expect(all.page).toMatchObject({ offset: 0, limit: 500, next: null });
    expect(all.page.total).toBe(all.changes.length);
    expect(all.page.total).toBeGreaterThan(1);
    const first = (await api(`/compare?a=${a}&b=${b}&offset=0&limit=1`)).body as unknown as Paged;
    expect(first.changes).toHaveLength(1);
    expect(first.page).toEqual({ offset: 0, limit: 1, total: all.page.total, next: 1 });
    const second = (await api(`/compare?a=${a}&b=${b}&offset=1&limit=1`)).body as unknown as Paged;
    expect(second.changes[0]?.key).toBe(all.changes[1]?.key);
    const last = (await api(`/compare?a=${a}&b=${b}&offset=${all.page.total - 1}&limit=5`))
      .body as unknown as Paged;
    expect(last.page.next).toBeNull();
    // the server's own maximum holds, whatever the client asks for
    expect(
      ((await api(`/compare?a=${a}&b=${b}&limit=100000`)).body as unknown as Paged).page.limit,
    ).toBe(500);
    for (const bad of ["offset=-1", "offset=1.5", "limit=abc", "limit=0"])
      expect((await api(`/compare?a=${a}&b=${b}&${bad}`)).status, bad).toBe(400);
    // the token and origin checks still guard the paged route
    expect((await fetch(`${running.url}/api/compare?a=${a}&b=${b}&offset=0&limit=1`)).status).toBe(
      401,
    );
    const cross = await fetch(`${running.url}/api/compare?a=${a}&b=${b}&limit=1`, {
      headers: { authorization: `Bearer ${running.token}`, origin: "http://evil.example" },
    });
    expect(cross.status).toBe(403);
  });

  it("returns hostile names and file text as data, never as markup", async () => {
    const hostile = {
      img: "<img src=x onerror=alert(1)>",
      md: "**bold** [x](javascript:alert(1))",
      bidi: `safe${String.fromCharCode(0x202e)}exe.txt`,
    };
    const long = `const pad = "${"A".repeat(5000)}";`;
    writeFileSync(
      join(dir, "h1.asar"),
      buildAsar({
        "package.json": JSON.stringify({ name: "h", version: "1", main: "main.js" }),
        "main.js": 'require("electron").ipcMain.handle("old:ping", () => 1);\n',
      }),
    );
    writeFileSync(
      join(dir, "h2.asar"),
      buildAsar({
        "package.json": JSON.stringify({ name: "h", version: "2", main: "main.js" }),
        "main.js": [
          'const { ipcMain } = require("electron");',
          ...Object.values(hostile).map((c) => `ipcMain.handle(${JSON.stringify(c)}, () => 1);`),
          long,
          "",
        ].join("\n"),
      }),
    );
    const id = async (name: string): Promise<string> =>
      (await api("/targets", { method: "POST", body: JSON.stringify({ path: join(dir, name) }) }))
        .body["id"] as string;
    const [a, b] = [await id("h1.asar"), await id("h2.asar")];
    const res = await fetch(`${running.url}/api/compare?a=${a}&b=${b}`, {
      headers: { authorization: `Bearer ${running.token}` },
    });
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
    const comparison = (await res.json()) as { changes: Array<{ key: string; change: string }> };
    const keys = comparison.changes.filter((c) => c.change === "added").map((c) => c.key);
    // verbatim: the API neither strips nor interprets what the build contains
    for (const value of Object.values(hostile)) expect(keys).toContain(value);
    const report = await (
      await fetch(`${running.url}/api/compare/report?a=${a}&b=${b}`, {
        headers: { authorization: `Bearer ${running.token}` },
      })
    ).text();
    // in the Markdown report target text sits in code spans: no tag, link or emphasis of its own
    expect(report).toContain("`<img src=x onerror=alert(1)>`");
    expect(report).toContain("`**bold** [x](javascript:alert(1))`");
    expect(report.replace(/`[^`\n]*`/g, "")).not.toMatch(/<img|\]\(javascript:/);
    const lines = (
      await api(`/targets/${b}/source?file=main.js&line=${Object.keys(hostile).length + 2}`)
    ).body as { lines: string[]; cut: Array<{ line: number; length: number }> };
    // a very long line comes back cut, with its full length named
    expect(lines.cut).toEqual([{ line: Object.keys(hostile).length + 2, length: long.length }]);
    expect(Math.max(...lines.lines.map((l) => l.length))).toBeLessThanOrEqual(400);
    expect(lines.lines.join("\n")).toContain(hostile.img);
  });

  it("accepts the configured bind host and the loopback names", async () => {
    const custom = await startServer({ host: "127.0.0.1", staticDir: dir });
    try {
      const port = new URL(custom.url).port;
      for (const h of [
        `localhost:${port}`,
        `127.0.0.1:${port}`,
        `[::1]:${port}`,
        `localhost.:${port}`,
      ]) {
        const r = await fetch(`${custom.url}/api/health`, {
          headers: { authorization: `Bearer ${custom.token}`, host: h },
        });
        expect(r.status, h).toBe(200);
      }
    } finally {
      await custom.close();
    }
  });
});

describe("POST /api/check (contract C7)", () => {
  const examples = join(import.meta.dirname, "../../../examples");
  const policyText = readFileSync(join(examples, "policy.json"), "utf8");
  let running: RunningServer;
  let a = "";
  let b = "";
  const call = (path: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`${running.url}/api${path}`, {
      ...init,
      headers: { authorization: `Bearer ${running.token}`, ...init.headers },
    });
  const check = (query: string, body: string = policyText): Promise<Response> =>
    call(`/check?${query}`, { method: "POST", body });
  beforeAll(async () => {
    running = await startServer({
      demoFiles: [join(examples, "notesdesk-1.4.0.asar"), join(examples, "notesdesk-1.5.0.asar")],
    });
    const opened = (await (await call("/demo", { method: "POST" })).json()) as {
      a: { id: string };
      b: { id: string };
    };
    a = opened.a.id;
    b = opened.b.id;
  });
  afterAll(async () => {
    await running.close();
  });

  it("checks the example builds against the example policy", async () => {
    const res = await check(`a=${a}&b=${b}`);
    expect(res.status).toBe(200);
    const result = (await res.json()) as {
      hexvero: string;
      status: string;
      findings: Array<{ rule: string; key: string; fingerprint: string; where: unknown[] }>;
      policy: { file: string; sha256: string };
    };
    expect(result.hexvero).toBe("check");
    expect(result.status).toBe("fail");
    expect(result.findings.map((f) => `${f.rule} ${f.key}`).toSorted()).toEqual([
      "new-external-host updates.notesdesk.example",
      "new-interface-member notesdesk.checkUpdate",
    ]);
    for (const f of result.findings) {
      expect(f.fingerprint).toMatch(/^[0-9a-f]{32}$/);
      expect(f.where.length).toBeGreaterThan(0);
    }
    // the policy came in the body: the result names no client path
    expect(result.policy.file).toBe("policy.json");
  });

  it("passes when the policy allows what changed", async () => {
    const policy = JSON.parse(policyText) as {
      rules: Record<string, { level: string; allow?: string[] }>;
    };
    policy.rules["new-interface-member"]!.level = "warn";
    policy.rules["new-external-host"]!.allow!.push("updates.notesdesk.example");
    const result = (await (await check(`a=${a}&b=${b}`, JSON.stringify(policy))).json()) as {
      status: string;
      findings: Array<{ level: string }>;
    };
    expect(result.status).toBe("pass");
    expect(result.findings.map((f) => f.level)).toEqual(["warn"]);
  });

  it("downloads Markdown and SARIF with a file name", async () => {
    const md = await check(`a=${a}&b=${b}&format=markdown`);
    expect(md.status).toBe(200);
    expect(md.headers.get("content-type")).toContain("text/markdown");
    expect(md.headers.get("content-disposition")).toBe(
      'attachment; filename="notesdesk-1.4.0-to-notesdesk-1.5.0.hexvero-check.md"',
    );
    expect(await md.text()).toContain("notesdesk.checkUpdate");
    const sarif = await check(`a=${a}&b=${b}&format=sarif`);
    expect(sarif.status).toBe(200);
    expect(sarif.headers.get("content-type")).toContain("application/sarif+json");
    expect(sarif.headers.get("content-disposition")).toContain(".hexvero-check.sarif");
    const log = (await sarif.json()) as { version: string; runs: Array<{ results: unknown[] }> };
    expect(log.version).toBe("2.1.0");
    expect(log.runs[0]!.results).toHaveLength(2);
  });

  it("answers an invalid policy with 400 and every issue", async () => {
    const res = await check(
      `a=${a}&b=${b}`,
      JSON.stringify({ hexvero: "policy", version: 2, rules: { "no-such-rule": {} }, extra: 1 }),
    );
    expect(res.status).toBe(400);
    const { error } = (await res.json()) as {
      error: { code: string; message: string; details: { issues: string[] } };
    };
    expect(error.code).toBe("invalid_policy");
    expect(error.message).toBe("invalid policy policy.json");
    expect(error.details.issues).toEqual(
      expect.arrayContaining([
        expect.stringContaining("extra: unknown key"),
        expect.stringContaining("version: this hexvero reads policy version 1"),
        expect.stringContaining("no-such-rule"),
      ]),
    );
    const notJson = await check(`a=${a}&b=${b}`, "{nope");
    expect(notJson.status).toBe(400);
    expect(((await notJson.json()) as { error: { code: string } }).error.code).toBe(
      "invalid_policy",
    );
  });

  it("refuses bad requests with the documented status codes", async () => {
    expect((await check(`a=${a}`)).status).toBe(400);
    expect((await check(`a=${a}&b=${a}`)).status).toBe(400);
    expect((await check(`a=${a}&b=${b}&format=html`)).status).toBe(400);
    expect((await check(`a=${a}&b=t_missing`)).status).toBe(404);
    expect((await call(`/check?a=${a}&b=${b}`)).status).toBe(405);
    // larger than any policy: refused before it is parsed
    expect((await check(`a=${a}&b=${b}`, " ".repeat((1 << 20) + 1))).status).toBe(413);
    // the same guards as every other route
    expect(
      (await fetch(`${running.url}/api/check?a=${a}&b=${b}`, { method: "POST", body: policyText }))
        .status,
    ).toBe(401);
    expect(
      (
        await fetch(`${running.url}/api/check?a=${a}&b=${b}`, {
          method: "POST",
          body: policyText,
          headers: { authorization: `Bearer ${running.token}`, origin: "http://evil.example" },
        })
      ).status,
    ).toBe(403);
  });
});
