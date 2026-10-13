import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  analyzeJavaScriptTree,
  asarTree,
  emptyJsScanFacts,
  type JsAppInfo,
  type JsScanFacts,
} from "../src/javascript/app.js";
import { loadScan, saveScan, scanKey } from "../src/javascript/scanState.js";
import { Session } from "../src/session.js";
import { buildAsar } from "./fixtures/asar.js";

/** An app of 13 JavaScript files in three directories, each with one channel and one endpoint. */
const files = (edit = ""): Record<string, string> => ({
  "package.json": JSON.stringify({ name: "big", main: "main.js" }),
  "main.js": `const { ipcMain, BrowserWindow } = require("electron");\nnew BrowserWindow({ webPreferences: { sandbox: true } });\nipcMain.handle("main:start", () => 1);${edit}`,
  ...Object.fromEntries(
    Array.from({ length: 12 }, (_, i) => [
      `${["src", "src/views", "lib"][i % 3]}/part${String(i).padStart(2, "0")}.js`,
      `const { ipcRenderer } = require("electron");\nipcRenderer.send("part:${i}");\nfetch("https://api.example/part/${i}");\nlocalStorage.setItem("part-${i}", "1");`,
    ]),
  ),
});
const tree = (edit = "") => asarTree(buildAsar(files(edit)), "app.asar");
const clone = (facts: JsScanFacts): JsScanFacts => JSON.parse(JSON.stringify(facts)) as JsScanFacts;
/** What a result says, without the order things were found in and without run bookkeeping. */
const content = (info: JsAppInfo) => ({
  modules: info.modules.map((m) => m.id).toSorted(),
  channels: info.ipcChannels,
  endpoints: info.endpoints.map((e) => `${e.file} ${e.value}`).toSorted(),
  storage: info.storage.map((e) => `${e.file} ${e.value}`).toSorted(),
  settings: info.webPreferences,
  findings: info.findings.map((f) => `${f.kind}: ${f.title}`),
});

const coverageOf = (analysis: Awaited<ReturnType<Session["analyze"]>>) =>
  analysis.data.kind === "javascript-app" ? analysis.data.app.coverage : null;

describe("continued JavaScript scans", () => {
  it("reads a large app in batches without losing or repeating a file", () => {
    const whole = analyzeJavaScriptTree(tree());
    expect(whole.coverage).toMatchObject({ total: 13, scanned: 13, remaining: 0, complete: true });

    let facts: JsScanFacts | undefined;
    const run = (options: Parameters<typeof analyzeJavaScriptTree>[1]) =>
      analyzeJavaScriptTree(tree(), {
        ...options,
        ...(facts ? { resume: clone(facts) } : {}),
        onFacts: (f) => (facts = clone(f)),
      });

    const first = run({ maxJsFiles: 5 });
    expect(first.coverage).toMatchObject({
      scanned: 5,
      remaining: 8,
      complete: false,
      resumed: false,
    });
    // the entry file first, then shallow paths before deep ones
    expect(first.modules.map((m) => m.id)).toEqual([
      "main.js",
      "lib/part02.js",
      "lib/part05.js",
      "lib/part08.js",
      "lib/part11.js",
    ]);
    expect(first.limitations.map((l) => l.code)).toContain("js_files_truncated");
    expect(first.coverage.nextFiles[0]).toBe("src/part00.js");

    const second = run({ maxJsFiles: 5 });
    expect(second.coverage).toMatchObject({
      scanned: 10,
      remaining: 3,
      complete: false,
      resumed: true,
    });
    const third = run({ maxJsFiles: 5 });
    expect(third.coverage).toMatchObject({
      scanned: 13,
      remaining: 0,
      complete: true,
      resumed: true,
    });
    expect(third.limitations.map((l) => l.code)).not.toContain("js_files_truncated");
    // every file exactly once, and the same facts as one uninterrupted scan
    expect(new Set(third.modules.map((m) => m.id)).size).toBe(13);
    expect(facts!.scanned).toHaveLength(13);
    expect(content(third)).toEqual(content(whole));
    // asking again reads nothing and changes nothing
    const again = run({ maxJsFiles: 5 });
    expect(content(again)).toEqual(content(whole));
    expect(facts!.scanned).toHaveLength(13);
  });

  it("reads everything in one call with `all`, storing each batch on the way", () => {
    const stored: number[] = [];
    const info = analyzeJavaScriptTree(tree(), {
      maxJsFiles: 4,
      all: true,
      onFacts: (f) => stored.push(f.scanned.length),
    });
    expect(info.coverage.complete).toBe(true);
    // after each full batch, and once at the end
    expect(stored).toEqual([4, 8, 12, 13]);
  });

  it("reads only the files under a given path when asked to", () => {
    let facts = emptyJsScanFacts();
    const views = analyzeJavaScriptTree(tree(), {
      include: ["src/views"],
      onFacts: (f) => (facts = clone(f)),
    });
    expect(views.modules.map((m) => m.id)).toEqual([
      "src/views/part01.js",
      "src/views/part04.js",
      "src/views/part07.js",
      "src/views/part10.js",
    ]);
    expect(views.coverage).toMatchObject({ scanned: 4, remaining: 9, complete: false });
    const pattern = analyzeJavaScriptTree(tree(), { resume: facts, include: ["lib/*05.js"] });
    expect(pattern.coverage.scanned).toBe(5);
    expect(pattern.modules.map((m) => m.id)).toContain("lib/part05.js");
  });

  it("leaves a file over the per-run byte budget unread instead of skipping it for good", () => {
    const info = analyzeJavaScriptTree(tree(), { maxTotalBytes: 600 });
    expect(info.coverage.complete).toBe(false);
    expect(info.coverage.skipped).toBe(0);
    expect(info.coverage.scanned).toBeGreaterThan(0);
  });
});

describe("stored scan state", () => {
  let cache: string;
  let dir: string;
  const previous = process.env["HEXVERO_CACHE_DIR"];
  beforeAll(() => {
    cache = mkdtempSync(join(tmpdir(), "hexvero-scan-cache-"));
    dir = mkdtempSync(join(tmpdir(), "hexvero-scan-app-"));
    process.env["HEXVERO_CACHE_DIR"] = cache;
  });
  afterAll(() => {
    if (previous === undefined) delete process.env["HEXVERO_CACHE_DIR"];
    else process.env["HEXVERO_CACHE_DIR"] = previous;
    rmSync(cache, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });

  it("is keyed by the content of the input and ignores damaged or foreign files", () => {
    const info = { path: "app.asar", size: 1, sha256: "a".repeat(64), format: "asar" as const };
    const key = scanKey(info, tree())!;
    expect(scanKey({ ...info, sha256: "b".repeat(64) }, tree())).not.toBe(key);
    expect(loadScan(key, tree())).toBeNull();
    let facts = emptyJsScanFacts();
    analyzeJavaScriptTree(tree(), { maxJsFiles: 3, onFacts: (f) => (facts = clone(f)) });
    saveScan(key, facts);
    expect(loadScan(key, tree())?.scanned).toHaveLength(3);
    // no temporary file is left behind by the atomic replace
    expect(readdirSync(join(cache, "scans")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    // a state that names a file the input does not have is not this input's state
    saveScan(key, { ...facts, scanned: [...facts.scanned, "not/in/the/app.js"] });
    expect(loadScan(key, tree())).toBeNull();
    // a file listed twice would be read twice
    saveScan(key, { ...facts, scanned: [...facts.scanned, facts.scanned[0]!] });
    expect(loadScan(key, tree())).toBeNull();
    writeFileSync(join(cache, "scans", `${key}.json`), "{ not json");
    expect(loadScan(key, tree())).toBeNull();
  });

  it("continues across sessions, and a changed input starts from nothing", async () => {
    const path = join(dir, "app.asar");
    writeFileSync(path, buildAsar(files()));
    const open = async () => {
      const session = new Session();
      const target = await session.open(path);
      return { session, id: target.id };
    };
    // a small app read in one run stores nothing
    const before = readdirSync(join(cache, "scans")).length;
    const a = await open();
    expect(coverageOf(await a.session.analyze(a.id))?.complete).toBe(true);
    expect(readdirSync(join(cache, "scans"))).toHaveLength(before);

    // a partial run is stored and a second process continues it
    const b = await open();
    const partial = await b.session.continueAnalysis(b.id, {
      fresh: true,
      continue: true,
      maxJsFiles: 6,
    });
    expect(coverageOf(partial)).toMatchObject({ scanned: 6, remaining: 7, complete: false });
    expect(partial.summary).toMatch(/partial: 6 of 13/);
    const c = await open();
    // without asking for more, the stored state is shown as it stands
    expect(coverageOf(await c.session.analyze(c.id))).toMatchObject({ scanned: 6, resumed: true });
    const more = await c.session.continueAnalysis(c.id, { continue: true, maxJsFiles: 6 });
    expect(coverageOf(more)).toMatchObject({ scanned: 12, remaining: 1 });
    // the collections of the session follow the continued scan
    expect((await c.session.collections(c.id))["modules"]).toBe(12);
    const done = await c.session.continueAnalysis(c.id, { all: true });
    expect(coverageOf(done)).toMatchObject({ scanned: 13, complete: true });
    expect(done.summary).not.toMatch(/partial/);

    // the same path with other content is another input: nothing of the old scan applies
    writeFileSync(path, buildAsar(files('\nipcMain.handle("main:new", () => 2);')));
    const d = await open();
    const fresh = await d.session.continueAnalysis(d.id, { continue: true, maxJsFiles: 6 });
    expect(coverageOf(fresh)).toMatchObject({ scanned: 6, resumed: false });
    expect(
      fresh.data.kind === "javascript-app" && fresh.data.app.ipcChannels.map((x) => x.channel),
    ).toContain("main:new");
  });
});
