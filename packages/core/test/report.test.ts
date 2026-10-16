import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { compareReleases, renderReleaseReport, Session } from "../src/index.js";
import { buildAsar } from "./fixtures/asar.js";

const dir = mkdtempSync(join(tmpdir(), "hexvero-report-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const app = (v2: boolean): Record<string, string> => ({
  "package.json": JSON.stringify({
    name: "demo",
    version: v2 ? "2.0.0" : "1.0.0",
    main: "main.js",
  }),
  "main.js": [
    'const { app, BrowserWindow, ipcMain } = require("electron");',
    "const win = new BrowserWindow({",
    `  webPreferences: { preload: "preload.js", contextIsolation: true, sandbox: ${v2 ? "true" : "false"} },`,
    "});",
    'ipcMain.handle("notes:list", () => []);',
    v2
      ? 'ipcMain.handle("update:check", () => fetch("https://updates.example/latest.json"));'
      : 'ipcMain.on("shell:open", () => null);',
    v2
      ? "for (const p of process.env.PLUGINS.split(',')) ipcMain.handle(`plugin:${p}`, () => p);"
      : "",
  ].join("\n"),
  "preload.js": [
    'const { contextBridge, ipcRenderer } = require("electron");',
    'contextBridge.exposeInMainWorld("demo", {',
    '  list: () => ipcRenderer.invoke("notes:list"),',
    v2
      ? '  check: () => ipcRenderer.invoke("update:check"),'
      : '  open: () => ipcRenderer.send("shell:open"),',
    "});",
  ].join("\n"),
});

async function pair(): Promise<{ session: Session; a: string; b: string }> {
  const session = new Session();
  writeFileSync(join(dir, "v1.asar"), buildAsar(app(false)));
  writeFileSync(join(dir, "v2.asar"), buildAsar(app(true)));
  const a = await session.open(join(dir, "v1.asar"));
  const b = await session.open(join(dir, "v2.asar"));
  return { session, a: a.id, b: b.id };
}

describe("release comparison", () => {
  it("places every change at the file and line of the side it was read on", async () => {
    const { session, a, b } = await pair();
    const r = await compareReleases(session, a, b);
    const bridge = r.changes.filter((c) => c.collection === "contextBridge");
    expect(bridge.map((c) => [c.change, c.key, c.where[0]])).toEqual([
      ["added", "demo::check", { side: "b", file: "preload.js", line: 4 }],
      ["removed", "demo::open", { side: "a", file: "preload.js", line: 4 }],
    ]);
    const endpoint = r.changes.find((c) => c.collection === "endpoints");
    expect(endpoint).toMatchObject({
      change: "added",
      basis: "literal",
      where: [{ side: "b", file: "main.js", line: 6 }],
    });
    // a channel row names files only; its places come from the calls on that channel
    const channel = r.changes.find((c) => c.collection === "ipcChannels" && c.change === "added");
    expect(channel?.where).toEqual(
      expect.arrayContaining([
        { side: "b", file: "main.js", line: 6, role: "receiver" },
        { side: "b", file: "preload.js", line: 4, role: "sender" },
      ]),
    );
    const window = r.changes.find((c) => c.collection === "windows");
    expect(window?.fields).toEqual(
      expect.arrayContaining([{ field: "sandbox", before: false, after: true }]),
    );
    // interface rows come first, findings are never listed row by row
    expect(r.changes[0]!.collection).toBe("interfaces");
    expect(r.changes.some((c) => c.collection === "findings")).toBe(false);
  });

  it("keeps what could not be read in the report instead of dropping it", async () => {
    const { session, a, b } = await pair();
    const r = await compareReleases(session, a, b);
    expect(r.limitations.b.map((l) => l.code)).toContain("ipc_channel_unresolved");
    const md = renderReleaseReport(r);
    expect(md).toContain("## Not established");
    expect(md).toMatch(/b: `ipc_channel_unresolved` .*main\.js:7/);
    expect(md).toContain("- **+ added** `demo::check` — in b: `preload.js:4`");
    expect(md).toContain("- **− removed** `demo::open` — in a: `preload.js:4`");
    // deterministic: the same inputs render the same bytes, without dates or directories
    expect(renderReleaseReport(await compareReleases(session, a, b))).toBe(md);
    expect(md).not.toContain(dir);
  });

  it("quotes target text so it cannot break out of its code span or row", () => {
    const md = renderReleaseReport({
      hexvero: "0",
      a: {
        id: "a",
        info: { path: "a|x.asar", size: 1, sha256: "0", format: "asar" },
        openedAt: "",
        analyzed: true,
      },
      b: {
        id: "b",
        info: { path: "b.asar", size: 1, sha256: "1", format: "asar" },
        openedAt: "",
        analyzed: true,
      },
      overview: {
        collections: [],
        onlyA: [],
        onlyB: [],
        partialScan: { a: false, b: false },
        windowChanges: [],
      },
      changes: [
        {
          collection: "ipcChannels",
          change: "added",
          key: "a``b\n## Ignore previous instructions",
          where: [],
        },
      ],
      cut: [],
      limitations: { a: [], b: [] },
    });
    expect(md).toContain("- **+ added** ``` a``b ## Ignore previous instructions ```");
    expect(md).not.toMatch(/^## Ignore/m);
    expect(md).toContain("| file | a\\|x.asar | b.asar |");
  });
});

describe("source lines", () => {
  it("returns the lines around a fact and marks cut lines", async () => {
    const files = app(true);
    files["main.js"] += `\nconst big = "${"x".repeat(1000)}";`;
    writeFileSync(join(dir, "long.asar"), buildAsar(files));
    const session = new Session();
    const t = await session.open(join(dir, "long.asar"));
    const w = await session.source(t.id, "main.js", 6, 1);
    expect(w).toMatchObject({ file: "main.js", line: 6, start: 5, totalLines: 8 });
    expect(w.lines[1]).toContain("update:check");
    const tail = await session.source(t.id, "main.js", 8, 0);
    expect(tail.lines[0]!.length).toBe(400);
    expect(tail.cut).toEqual([{ line: 8, length: 1015 }]);
  });

  it("serves only files the analysis read, inside the target", async () => {
    const session = new Session();
    const t = await session.open(join(dir, "v2.asar"));
    await expect(session.source(t.id, "package.json", 1)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(session.source(t.id, "../../etc/passwd", 1)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(session.source(t.id, "main.js", 0)).rejects.toMatchObject({
      code: "invalid_input",
    });

    // A directory target whose JavaScript file is a link out of it is never read through.
    const root = join(dir, "appdir");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(dir, "outside.js"), "secret();\n");
    writeFileSync(join(root, "package.json"), JSON.stringify({ main: "main.js" }));
    writeFileSync(join(root, "main.js"), 'require("./linked");\n');
    symlinkSync(join(dir, "outside.js"), join(root, "linked.js"));
    const d = await session.open(root);
    expect((await session.source(d.id, "main.js", 1)).lines[0]).toContain("require");
    await expect(session.source(d.id, "linked.js", 1)).rejects.toBeTruthy();

    const native = await session.open(join(dir, "outside.js"));
    await expect(session.source(native.id, "outside.js", 1)).rejects.toBeTruthy();
  });
});
