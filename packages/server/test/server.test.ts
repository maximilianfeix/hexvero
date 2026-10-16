import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
