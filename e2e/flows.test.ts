/**
 * The four user flows hexvero has to get right, exercised on real inputs:
 *   1. Electron: open the example app, follow IPC from a finding to the exact source line.
 *   2. Native: a binary compiled here, imports and metadata, call graph and cross-references
 *      through every engine that is actually installed (never a mock).
 *   3. Build comparison: two controlled builds; content changes appear, pure address moves are
 *      classified and shown as such.
 *   4. Coding agent: a real MCP client talking to the built CLI over stdio.
 * What cannot run here (no compiler, no engine) is skipped by name, never faked.
 * Run with `npm run e2e` (builds first).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  compareItems,
  detectProviders,
  loadCallGraph,
  neighborhood,
  openAsar,
  positionalFields,
  resolveNode,
  runProvider,
  Session,
  tracePath,
  type ProviderStatus,
} from "../packages/core/src/index.js";

const root = resolve(import.meta.dirname, "..");
const examples = join(root, "examples");
const bin = join(root, "packages", "cli", "bin", "hexvero.js");
const work = mkdtempSync(join(tmpdir(), "hexvero-e2e-"));
process.env["HEXVERO_CACHE_DIR"] = join(work, "cache");
afterAll(() => rmSync(work, { recursive: true, force: true }));

const compiler = ["cc", "gcc", "clang"].find((c) => spawnSync(c, ["--version"]).status === 0);
const compile = (source: string, out: string): string => {
  execFileSync(compiler!, ["-O0", "-o", out, join(examples, "native", source)]);
  return out;
};
/** A symbol name without platform decoration: `_system` (Mach-O), `system@GLIBC_2.2.5` (ELF). */
const plain = (name: string): string => name.replace(/^_+/, "").replace(/@.*$/, "");
const plainAll = (names: string[]): string[] => names.map(plain);
let engines: ProviderStatus[] = [];
beforeAll(async () => {
  engines = (await detectProviders()).filter((p) => p.available && p.name !== "ghidra");
  console.log(
    `e2e environment: compiler=${compiler ?? "none"}; engines=${engines.map((e) => `${e.name} (${e.version})`).join(", ") || "none"}; ghidra is not exercised here`,
  );
});

describe("flow 1: Electron app", () => {
  const session = new Session();
  const v14 = join(examples, "notesdesk-1.4.0.asar");
  const v15 = join(examples, "notesdesk-1.5.0.asar");

  it("explains the app and points every finding at its source line", async () => {
    const target = await session.open(v14);
    const analysis = await session.analyze(target.id);
    expect(analysis.summary).toBe("Electron ASAR: 4 JavaScript modules, 6 IPC channels");
    const byKind = new Map(analysis.findings.map((f) => [f.kind, f]));
    expect([...byKind.keys()]).toEqual([
      "electron.node-integration",
      "electron.sandbox",
      "electron.ipc",
      "electron.context-bridge",
      "electron.preload",
      "js.endpoints",
      "js.storage",
    ]);
    // endpoints and storage keys of an archive, each with the file, line and column it was read at
    const endpoints = (await session.collection(target.id, "endpoints")).items as Array<{
      value: string | null;
      kind: string;
      evidence: string;
      file: string;
      line: number;
      column: number;
    }>;
    expect(endpoints.map((e) => `${e.kind} ${e.value} [${e.evidence}]`)).toContain(
      "fetch https://telemetry.notesdesk.example/collect [literal]",
    );
    for (const e of endpoints) {
      expect(e.file).toBe("renderer/app.bundle.js");
      expect(e.line).toBeGreaterThan(0);
      expect(e.column).toBeGreaterThan(0);
    }
    expect(
      ((await session.collection(target.id, "storage")).items as Array<{ value: string }>).map(
        (s) => s.value,
      ),
    ).toEqual(["notesdesk.token"]);
    // a small app is read completely, and says so
    expect(
      analysis.data.kind === "javascript-app" ? analysis.data.app.coverage : null,
    ).toMatchObject({ total: 4, scanned: 4, remaining: 0, complete: true });
    // every location names a file and line whose text really is the evidence
    const archive = openAsar(new Uint8Array(readFileSync(v14)));
    const lineOf = (location: string): string => {
      const [file, line] = location.split(":");
      const entry = archive.files.find((f) => f.path === file)!;
      return new TextDecoder().decode(archive.read(entry)).split("\n")[Number(line) - 1]!;
    };
    expect(lineOf(byKind.get("electron.node-integration")!.location!)).toContain(
      "nodeIntegration: true",
    );
    expect(lineOf(byKind.get("electron.sandbox")!.location!)).toContain("sandbox: false");
    expect(lineOf(byKind.get("electron.ipc")!.location!)).toContain("ipcMain.handle(");
    expect(lineOf(byKind.get("electron.preload")!.location!)).toContain("preload.js");
    expect(byKind.get("electron.ipc")!.confidence).toBe("confirmed");
    expect(byKind.get("electron.node-integration")!.confidence).toBe("inferred");
  });

  it("connects renderer, preload and main through IPC and finds the files again", async () => {
    const target = await session.open(v15);
    const modules = await session.collection(target.id, "modules");
    const roles = Object.fromEntries(
      (modules.items as Array<{ id: string; role: string }>).map((m) => [m.id, m.role]),
    );
    expect(roles).toMatchObject({ "main.js": "main", "preload.js": "preload" });
    const channels = await session.collection(target.id, "ipcChannels", { text: "update:check" });
    expect(channels.items).toEqual([
      { channel: "update:check", senders: ["preload.js"], receivers: ["main.js"] },
    ]);
    const sites = (await session.collection(target.id, "ipc", { text: "update:check" }))
      .items as Array<{
      module: string;
      api: string;
      line: number;
    }>;
    expect(sites.map((s) => `${s.module} ${s.api}`).toSorted()).toEqual([
      "main.js ipcMain.handle",
      "preload.js ipcRenderer.invoke",
    ]);
    const prefs = (await session.collection(target.id, "webPreferences")).items as Array<{
      key: string;
      value: unknown;
      file: string;
      line: number;
    }>;
    expect(Object.fromEntries(prefs.map((p) => [p.key, p.value]))).toEqual({
      preload: "preload.js",
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    });
    const bridge = (await session.collection(target.id, "contextBridge")).items as Array<{
      api: string;
      member: string;
      channel: string;
    }>;
    expect(bridge.map((b) => `${b.api}.${b.member} → ${b.channel}`)).toEqual([
      "notesdesk.getSetting → settings:get",
      "notesdesk.setSetting → settings:set",
      "notesdesk.listNotes → notes:list",
      "notesdesk.saveNote → notes:save",
      "notesdesk.quit → app:quit",
      "notesdesk.checkUpdate → update:check",
    ]);
    // 1.5.0 has no risky flags, so no such finding is invented
    const kinds = (await session.analyze(target.id)).findings.map((f) => f.kind);
    expect(kinds).not.toContain("electron.node-integration");
    expect(kinds).not.toContain("electron.sandbox");
  });

  it("recovers the renderer bundle into its four module files", async () => {
    const target = await session.open(join(examples, "notesdesk-1.5.0.bundle.js"));
    const out = join(work, "recovered");
    const result = await session.recover(target.id, out);
    expect(result.written.map((w) => w.path).toSorted()).toEqual([
      "src/api.js",
      "src/editor.js",
      "src/index.js",
      "src/util.js",
    ]);
    expect(readFileSync(join(out, "src", "api.js"), "utf8")).toContain("api.notesdesk.example");
  });
});

describe.skipIf(!compiler)("flow 2: native binary compiled here", () => {
  const session = new Session();
  let v2 = "";
  beforeAll(() => {
    v2 = compile("demo-v2.c", join(work, "demo-v2"));
  });

  it("reads format, imports and libraries without an engine", async () => {
    const target = await session.open(v2);
    expect(["macho", "elf", "pe"]).toContain(target.info.format);
    const imports = (await session.collection(target.id, "imports", { limit: 2000 }))
      .items as Array<{
      name: string;
    }>;
    const names = imports.map((i) => plain(i.name));
    for (const expected of ["system", "getenv", "puts"])
      expect(names, expected).toContain(expected);
    expect((await session.collection(target.id, "libraries")).total).toBeGreaterThan(0);
    const strings = session.strings(target.id, { text: "demo 1.1.0" });
    expect(strings.items[0]?.value).toBe("demo 1.1.0");
  });

  it("builds the same call graph through every installed engine", async () => {
    if (engines.length === 0) {
      console.log(
        "SKIPPED (no engine installed): call graph and cross-references were not verified",
      );
      return;
    }
    for (const engine of engines) {
      const { graph, cached } = await loadCallGraph(
        { targetPath: v2, provider: engine.name },
        engines,
      );
      expect(cached, engine.name).toBe(false);
      const main = resolveNode(graph, "main");
      expect(main.node, `${engine.name}: main (${main.candidates.join(", ")})`).not.toBeNull();
      const system = resolveNode(graph, "system").node!;
      const runTool = resolveNode(graph, "run_tool").node!;
      const readConfig = resolveNode(graph, "read_config").node!;
      const hood = neighborhood(graph, main.node!, { maxDepth: 1 });
      expect(hood.levels[1]!.ids, engine.name).toEqual(
        expect.arrayContaining([
          runTool.id,
          readConfig.id,
          resolveNode(graph, "checksum").node!.id,
        ]),
      );
      const path = tracePath(graph, main.node!, system);
      expect(path.status, engine.name).toBe("found");
      expect(path.path, engine.name).toEqual([main.node!.id, runTool.id, system.id]);
      expect(system.external).toBe(true);
      // not reachable is a definite answer on a complete graph …
      const reverse = tracePath(graph, system, main.node!);
      expect(reverse.status).toBe("not_reached");
      // both engines' graphs include tail calls (rizin lists them per function, radare2 as
      // jump references), so the answer needs no reservation
      expect(
        reverse.limitations.map((l) => l.code),
        engine.name,
      ).toEqual([]);
      // … and an explicit "cannot tell" on a partial one
      const partial = tracePath({ ...graph, truncated: true }, system, main.node!);
      expect(partial.limitations.map((l) => l.code)).toContain("trace_graph_truncated");
      // cross-references to system come from run_tool
      const xrefs = await runProvider(
        { targetPath: v2, provider: engine.name, operation: "xrefs", address: system.name },
        engines,
      );
      const references = (
        xrefs.result as { references: Array<{ function: string | null; type: string }> }
      ).references;
      expect(references.length, `${engine.name} xrefs`).toBeGreaterThan(0);
      expect(
        references.some(
          (r) => r.function !== null && plain(r.function.replace(/^sym\./, "")) === "run_tool",
        ),
      ).toBe(true);
    }
  });

  it("caches per content and engine, shares concurrent runs and survives a cancelled caller", async () => {
    if (engines.length === 0) {
      console.log(
        "SKIPPED (no engine installed): cache behaviour with a real engine was not verified",
      );
      return;
    }
    const engine = engines[0]!;
    const path = join(work, "cache-subject");
    copyFileSync(v2, path);
    // concurrent callers share one run; aborting one does not fail the other
    const controller = new AbortController();
    const first = loadCallGraph(
      { targetPath: path, provider: engine.name, signal: controller.signal },
      engines,
    );
    const second = loadCallGraph({ targetPath: path, provider: engine.name }, engines);
    controller.abort();
    await expect(first).rejects.toThrow(/cancelled/);
    const graph = (await second).graph;
    expect(graph.nodes.length).toBeGreaterThan(3);
    // warm: same content, same engine → no engine run
    const warm = await loadCallGraph({ targetPath: path, provider: engine.name }, engines);
    expect(warm.cached).toBe(true);
    expect(warm.graph).toBe(graph);
    // another engine build must not reuse the graph
    const upgraded = engines.map((e) =>
      e.name === engine.name ? { ...e, version: `${e.version} (other build)` } : e,
    );
    expect(
      (await loadCallGraph({ targetPath: path, provider: engine.name }, upgraded)).cached,
    ).toBe(false);
    // the file changes → new content digest → the old graph is not served
    compile("demo-v1.c", path);
    const changed = await loadCallGraph({ targetPath: path, provider: engine.name }, engines);
    expect(changed.cached).toBe(false);
    expect(resolveNode(changed.graph, "read_config").node).toBeNull();
    expect(resolveNode(graph, "read_config").node).not.toBeNull();
  });
});

describe.skipIf(!compiler)("flow 3: comparing two controlled builds", () => {
  const session = new Session();
  it("shows the content changes and classifies pure address moves", async () => {
    const a = await session.open(compile("demo-v1.c", join(work, "cmp-v1")));
    const b = await session.open(compile("demo-v2.c", join(work, "cmp-v2")));
    const formats = [a.info.format, b.info.format];
    const diff = async (collection: string, strict = false) => {
      const [left, right] = await Promise.all([
        session.collection(a.id, collection, { limit: 2000, maxBytes: 8 << 20 }),
        session.collection(b.id, collection, { limit: 2000, maxBytes: 8 << 20 }),
      ]);
      return compareItems(left.items, right.items, {
        collection,
        positional: strict ? [] : positionalFields(collection, formats),
      });
    };
    // known change 1: v2 imports getenv
    const imports = await diff("imports");
    // (strlen is also new on macOS; gcc on Linux reduces `strlen(x) ? …` to a byte test)
    expect(plainAll(imports.added)).toContain("getenv");
    expect(imports.removed).toEqual([]);
    // known change 2: v2 defines read_config
    const symbols = await diff("symbols");
    expect(plainAll(symbols.added)).toContain("read_config");
    // functions that exist in both builds moved: reported as relocated with a sample, not hidden
    expect(symbols.relocated).toBeGreaterThan(0);
    expect(symbols.relocatedSample[0]!.fields[0]!.field).toBe("value");
    expect(symbols.positional).toEqual(["value"]);
    // strict mode counts those moves as changes instead
    const strict = await diff("symbols", true);
    expect(strict.relocated).toBe(0);
    expect(strict.changed.length).toBeGreaterThanOrEqual(symbols.relocated);
    // known change 3: the version string
    const before = session.strings(a.id, { text: "demo 1." }).items.map((s) => s.value);
    const after = session.strings(b.id, { text: "demo 1." }).items.map((s) => s.value);
    expect(before).toContain("demo 1.0.0");
    expect(after).toContain("demo 1.1.0");
  });

  it("explains what changed between the two Electron builds", async () => {
    const a = await session.open(join(examples, "notesdesk-1.4.0.asar"));
    const b = await session.open(join(examples, "notesdesk-1.5.0.asar"));
    const items = async (id: string, name: string): Promise<unknown[]> =>
      (await session.collection(id, name)).items;
    const channels = compareItems(
      await items(a.id, "ipcChannels"),
      await items(b.id, "ipcChannels"),
      {
        collection: "ipcChannels",
      },
    );
    expect(channels).toMatchObject({
      key: "channel",
      added: ["update:check"],
      removed: ["shell:open"],
      unchanged: 5,
    });
    const bridge = compareItems(
      await items(a.id, "contextBridge"),
      await items(b.id, "contextBridge"),
      {
        collection: "contextBridge",
      },
    );
    expect(bridge).toMatchObject({
      key: "api+member",
      added: ["notesdesk::checkUpdate"],
      removed: ["notesdesk::openInShell"],
      changed: [],
      unchanged: 5,
    });
    // settings are matched by key; a value that flips is a change, never a "relocation"
    const prefs = compareItems(
      await items(a.id, "webPreferences"),
      await items(b.id, "webPreferences"),
      {
        key: "key",
        positional: positionalFields("webPreferences", [a.info.format, b.info.format]),
      },
    );
    expect(prefs.relocated).toBe(0);
    expect(
      prefs.changed
        .map(
          (c) =>
            `${c.key}: ${c.fields.find((f) => f.field === "value")?.before} → ${c.fields.find((f) => f.field === "value")?.after}`,
        )
        .toSorted(),
    ).toEqual(["nodeIntegration: true → false", "sandbox: false → true"]);
  });
});

describe("flow 4: a coding agent over MCP stdio", () => {
  it("opens, analyzes, asks, reads evidence, records limits and exports", async () => {
    expect(
      existsSync(join(root, "packages", "cli", "dist", "index.js")),
      "run `npm run build` first",
    ).toBe(true);
    const client = new Client({ name: "e2e-agent", version: "0" });
    await client.connect(
      new StdioClientTransport({ command: process.execPath, args: [bin, "mcp"], cwd: work }),
    );
    try {
      const call = async (name: string, args: Record<string, unknown>) => {
        const result = await client.callTool({ name, arguments: args });
        const text = (result.content as Array<{ text: string }>)[0]!.text;
        return { ok: !result.isError, text, body: JSON.parse(text) as Record<string, unknown> };
      };
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain("hexvero_call_graph");
      expect(Buffer.byteLength(JSON.stringify(tools))).toBeLessThan(32 * 1024);

      // open → analyze
      const opened = await call("hexvero_open", { path: join(examples, "notesdesk-1.4.0.asar") });
      const id = opened.body["id"] as string;
      const analysis = await call("hexvero_analyze", { targetId: id });
      expect(analysis.body["summary"]).toContain("6 IPC channels");
      const findings = analysis.body["findings"] as Array<{
        kind: string;
        location?: string;
        confidence: string;
      }>;
      const risky = findings.find((f) => f.kind === "electron.node-integration")!;
      expect(risky.location).toMatch(/^main\.js:\d+$/);
      expect(Buffer.byteLength(analysis.text)).toBeLessThan(64 * 1024);

      // ask a targeted question, within a budget
      const page = await call("hexvero_collection", {
        targetId: id,
        collection: "ipc",
        text: "shell:open",
        maxBytes: 2048,
      });
      expect(Buffer.byteLength(page.text)).toBeLessThanOrEqual(2048);
      expect(
        (page.body["items"] as Array<{ module: string }>).map((i) => i.module).toSorted(),
      ).toEqual(["main.js", "preload.js"]);

      // read the evidence as bytes: the ASAR header is a pickle, the JSON index follows
      const bytes = await call("hexvero_bytes", { targetId: id, offset: 16, length: 9 });
      expect(bytes.body["ascii"]).toBe('{"files":');
      const strings = await call("hexvero_strings", {
        targetId: id,
        text: "nodeIntegration",
        limit: 3,
      });
      expect((strings.body["items"] as unknown[]).length).toBeGreaterThan(0);

      // capture what is not known
      const limitations = await call("hexvero_collection", {
        targetId: id,
        collection: "limitations",
      });
      expect(Array.isArray(limitations.body["items"])).toBe(true);
      const unknown = await call("hexvero_unknowns", {
        action: "record",
        targetId: id,
        question: "Is shell:open reachable from untrusted content?",
        checked: ["ipc", "webPreferences"],
      });
      expect(unknown.ok).toBe(true);

      // compare with the next version
      const next = await call("hexvero_open", { path: join(examples, "notesdesk-1.5.0.asar") });
      const diff = await call("hexvero_compare", {
        targetA: id,
        targetB: next.body["id"],
        collection: "ipcChannels",
      });
      expect((diff.body["added"] as { sample: string[] }).sample).toEqual(["update:check"]);
      expect((diff.body["removed"] as { sample: string[] }).sample).toEqual(["shell:open"]);

      // export, and a second export does not clobber the first
      const out = join(work, "agent-export.json");
      const exported = await call("hexvero_export", { targetId: id, path: out });
      expect(exported.ok).toBe(true);
      const file = JSON.parse(readFileSync(out, "utf8")) as {
        unknowns: unknown[];
        analysis: { findings: unknown[] };
      };
      expect(file.unknowns).toHaveLength(1);
      expect(file.analysis.findings).toHaveLength(7);
      expect((await call("hexvero_export", { targetId: id, path: out })).ok).toBe(false);

      // errors are structured, never a crash
      const missing = await call("hexvero_collection", { targetId: id, collection: "nope" });
      expect(missing.ok).toBe(false);
      expect((missing.body["error"] as { code: string }).code).toBe("invalid_input");
    } finally {
      await client.close();
    }
  });
});
