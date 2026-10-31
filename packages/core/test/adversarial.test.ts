/**
 * Regression tests for inputs found by scripts/fuzz.mjs: each one used to end in a JavaScript
 * runtime error (a TypeError or a stack overflow) instead of a typed error or a result.
 */
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openAsar } from "../src/formats/asar.js";
import { collectReleaseSources } from "../src/htmlReport.js";
import { interfaceMap } from "../src/javascript/interfaces.js";
import { AnalysisError } from "../src/model.js";
import { parseBaseline, parsePolicy, PolicyError } from "../src/policy.js";
import { compareReleases, renderReleaseReport, visibleControls } from "../src/report.js";
import { Session } from "../src/session.js";
import { targetFromBytes } from "../src/target.js";
import { timeLimit } from "./timeLimit.js";

/** An ASAR from header JSON text as written, so forged node types and values survive. */
function rawAsar(headerText: string, data = "abcdefgh"): Uint8Array {
  const json = Buffer.from(headerText);
  const padded = Math.ceil(json.length / 4) * 4;
  const prefix = Buffer.alloc(16);
  prefix.writeUInt32LE(4, 0);
  prefix.writeUInt32LE(8 + padded, 4);
  prefix.writeUInt32LE(4 + padded, 8);
  prefix.writeUInt32LE(json.length, 12);
  return Buffer.concat([prefix, json, Buffer.alloc(padded - json.length), Buffer.from(data)]);
}

describe("ASAR header with forged node types", () => {
  it("skips nodes that are not objects instead of failing on them", () => {
    const archive = openAsar(
      rawAsar(
        '{"files":{"a.js":{"size":2,"offset":"0"},"n":null,"s":"str","x":42,"l":[1],"d":{"files":null},"e":{"files":"abc"}}}',
      ),
    );
    // "d" has a files key that is null: a file with no size; "e" a directory with no entries
    expect(archive.files.map((f) => f.path)).toEqual(["a.js", "d"]);
    expect(new TextDecoder().decode(archive.read(archive.find("a.js")!))).toBe("ab");
  });

  it("reads a root whose files are not an object as an empty archive", () => {
    for (const root of ['{"files":null}', '{"files":"x"}', '{"files":[1,2]}', "null", "[]", "7"])
      expect(openAsar(rawAsar(root)).files).toEqual([]);
  });

  it("refuses to read a file whose size is not a non-negative integer", () => {
    for (const size of ["-1", "1.5", '"4"', "1e308", "{}", "null"]) {
      const archive = openAsar(rawAsar(`{"files":{"a.js":{"size":${size},"offset":"0"}}}`));
      const file = archive.find("a.js")!;
      expect(file.offset).toBeNull();
      expect(() => archive.read(file)).toThrow(AnalysisError);
      expect(() => archive.read(file)).toThrow(/no valid offset or size/);
    }
  });

  it("looks up every file of a 100,000-entry archive in linear time", () => {
    const entries = Array.from({ length: 100_000 }, (_, i) => `"f${i}.js":{"size":1,"offset":"0"}`);
    const archive = openAsar(rawAsar(`{"files":{${entries.join(",")}}}`));
    const started = performance.now();
    for (const f of archive.files) expect(archive.find(f.path)).toBe(f);
    // a linear search per lookup made this loop quadratic
    expect(performance.now() - started).toBeLessThan(timeLimit(5_000));
  });

  it("parses an archive's header once for many source windows", async () => {
    const main = 'const { ipcMain } = require("electron");\nipcMain.handle("a", () => 1);\n';
    const pkg = '{"name":"x","main":"main.js"}';
    const filler = Array.from({ length: 100_000 }, (_, i) => `"f${i}.txt":{"size":1,"offset":"0"}`);
    const header = `{"files":{"package.json":{"size":${pkg.length},"offset":"0"},"main.js":{"size":${main.length},"offset":"${pkg.length}"},${filler.join(",")}}}`;
    const session = new Session();
    const { id } = session.register(targetFromBytes(rawAsar(header, pkg + main), "big.asar"));
    await session.analyze(id);
    const started = performance.now();
    for (let i = 0; i < 200; i++)
      expect((await session.source(id, "main.js", 2)).lines).toHaveLength(3);
    // parsing the 100,000-entry header for each of the 200 windows an HTML report reads took 15 s
    expect(performance.now() - started).toBeLessThan(timeLimit(5_000));
  });

  it("keeps only string integrity hashes", () => {
    const archive = openAsar(
      rawAsar('{"files":{"a.js":{"size":1,"offset":"0","integrity":{"hash":{"x":1}}}}}'),
    );
    expect(archive.files[0]!.integrity).toBeNull();
  });
});

const deep = (d: number) => `${"[".repeat(d)}${"]".repeat(d)}`;

describe("policy and baseline files nested deeper than the stack", () => {
  const cases: Array<[string, (text: string) => unknown, string]> = [
    ["policy hexvero", (t) => parsePolicy(t, "p.json"), `{"hexvero":${deep(200_000)}}`],
    [
      "policy rule level",
      (t) => parsePolicy(t, "p.json"),
      `{"hexvero":"policy","version":1,"rules":{"new-external-host":{"level":${deep(200_000)}}}}`,
    ],
    [
      "policy suppression rule",
      (t) => parsePolicy(t, "p.json"),
      `{"hexvero":"policy","version":1,"rules":{},"suppressions":[{"rule":${deep(200_000)}}]}`,
    ],
    ["baseline hexvero", (t) => parseBaseline(t, "b.json"), `{"hexvero":${deep(200_000)}}`],
  ];
  for (const [name, parse, text] of cases)
    it(`reports ${name} as an invalid file, not a stack overflow`, () => {
      let caught: unknown;
      try {
        parse(text);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(PolicyError);
      // Whether JSON.stringify can write the value back depends on the runtime (Node 25 can):
      // the quote is then a prefix cut short, otherwise the fallback text.
      expect((caught as PolicyError).issues.join("\n")).toMatch(/a nested list|\[{59}…/);
    });

  it("ignores __proto__ and constructor keys as unknown keys", () => {
    const text =
      '{"hexvero":"policy","version":1,"__proto__":{"unknown":"allow"},"rules":{"__proto__":{"level":"off"},"constructor":{"level":"off"}}}';
    let caught: unknown;
    try {
      parsePolicy(text, "p.json");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PolicyError);
    const issues = (caught as PolicyError).issues.join("\n");
    expect(issues).toContain("__proto__: unknown key");
    expect(issues).toContain("rules.__proto__: unknown rule");
    expect(issues).toContain("rules.constructor: unknown rule");
    expect(({} as Record<string, unknown>)["unknown"]).toBeUndefined();
  });
});

describe("Markdown report text", () => {
  it("shows bidi and zero-width characters as escapes, as the HTML report does", () => {
    expect(visibleControls("evil\u202etxt.exe\u200b\u2066\ufeff\u061c")).toBe(
      "evil\\u{202e}txt.exe\\u{200b}\\u{2066}\\u{feff}\\u{61c}",
    );
    expect(visibleControls("plain 日本語 é")).toBe("plain 日本語 é");
  });
});

/** A script that writes the given localStorage keys. */
const save = (keys: string[]) =>
  new TextEncoder().encode(
    `class S { save(k, v) { localStorage.setItem(k, v); } run() { ${keys.map((k) => `this.save(${JSON.stringify(k)}, 1);`).join(" ")} } }\nnew S().run();\n`,
  );

describe("Markdown report code spans", () => {
  it("cut long target text before escaping it, never inside an escape", async () => {
    const long = `${"x".repeat(270)}\u0007\u0007\u0007\u0007\u0007\u0007\u0007\u0007\u0007\u0007`;
    const session = new Session();
    const a = session.register(targetFromBytes(save(["old"]), "a.js"));
    const b = session.register(targetFromBytes(save(["old", long]), "b.js"));
    const text = renderReleaseReport(await compareReleases(session, a.id, b.id));
    expect(text).toContain("x".repeat(270));
    // the cut counts 300 characters of text, so all ten escapes stay whole
    expect(text).toMatch(/x{270}(\\u\{7\}){10}::writ`/);
  });
});

/** The error a source call ends in, or undefined. */
async function failure(call: Promise<unknown>): Promise<AnalysisError | undefined> {
  try {
    await call;
  } catch (error) {
    return error as AnalysisError;
  }
  return undefined;
}

describe("a target rebuilt on disk after it was analyzed", () => {
  const first = 'const { ipcMain } = require("electron");\nipcMain.handle("one", () => 1);\n';
  const second = `// a longer header comment moves every offset\n${first.replace("one", "two")}`;

  it("refuses source windows from an archive rebuilt in place", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hexvero-rebuilt-"));
    try {
      const pkg = '{"name":"x","main":"main.js"}';
      const asar = (main: string) =>
        rawAsar(
          `{"files":{"package.json":{"size":${pkg.length},"offset":"0"},"main.js":{"size":${Buffer.byteLength(main)},"offset":"${pkg.length}"}}}`,
          pkg + main,
        );
      const path = join(dir, "app.asar");
      writeFileSync(path, asar(first));
      // maxBytes below the file size: the archive is read from disk on demand (lazy)
      const session = new Session({ maxBytes: 64 });
      const { id } = await session.open(path);
      await session.analyze(id);
      expect((await session.source(id, "main.js", 2)).lines.join("\n")).toContain('"one"');
      writeFileSync(path, asar(second));
      utimesSync(path, new Date(), new Date(Date.now() + 5_000));
      // the excerpt would come from another build than the one the analysis describes
      const error = await failure(session.source(id, "main.js", 2));
      expect(error).toBeInstanceOf(AnalysisError);
      expect(error!.message).toBe("app.asar changed on disk since it was analyzed; open it again");
      expect(error!.details).toMatchObject({ reason: "changed_on_disk" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses an HTML report's excerpts rather than mixing builds", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hexvero-rebuilt-report-"));
    try {
      const app = (name: string, main: string) => {
        mkdirSync(join(dir, name));
        writeFileSync(join(dir, name, "package.json"), '{"name":"x","main":"main.js"}');
        writeFileSync(join(dir, name, "main.js"), main);
        return join(dir, name);
      };
      const session = new Session();
      const a = await session.open(app("a", first));
      const b = await session.open(app("b", first.replace("one", "two")));
      const comparison = await compareReleases(session, a.id, b.id);
      expect((await collectReleaseSources(session, comparison)).size).toBeGreaterThan(0);
      writeFileSync(join(dir, "b", "main.js"), second);
      const error = await failure(collectReleaseSources(session, comparison));
      expect(error?.details).toMatchObject({ reason: "changed_on_disk" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses source windows from a file of a directory target that changed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hexvero-rebuilt-dir-"));
    try {
      writeFileSync(join(dir, "package.json"), '{"name":"x","main":"main.js"}');
      writeFileSync(join(dir, "main.js"), first);
      const session = new Session();
      const { id } = await session.open(dir);
      await session.analyze(id);
      expect((await session.source(id, "main.js", 2)).lines.join("\n")).toContain('"one"');
      writeFileSync(join(dir, "main.js"), second);
      const error = await failure(session.source(id, "main.js", 2));
      expect(error?.message).toBe("main.js changed on disk since it was analyzed; open it again");
      expect(error?.details).toMatchObject({ reason: "changed_on_disk" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("interface map of an archive with thousands of copies of one preload", () => {
  it("maps every bridge member without sorting every end for each one", () => {
    const n = 20_000;
    const modules = Array.from({ length: n }, (_, i) => ({
      id: `p${i}.js`,
      ipc: [{ api: "ipcMain.handle", channel: "ping", line: 1 }],
    }));
    const contextBridge = modules.map((m) => ({
      api: "contextBridge.exposeInMainWorld",
      member: "ping",
      world: "api",
      file: m.id,
      line: 2,
      channel: "ping",
    }));
    const started = performance.now();
    const rows = interfaceMap(
      {
        modules,
        contextBridge,
        windows: [],
        coverage: { complete: true },
      } as unknown as Parameters<typeof interfaceMap>[0],
      [],
    );
    // a filter and sort of all 20,000 ends per member took 75 s
    expect(performance.now() - started).toBeLessThan(timeLimit(2_000));
    expect(rows).toHaveLength(n);
    expect(rows[0]).toMatchObject({ direction: "to-main", endsTotal: n - 1, endsTruncated: true });
    expect(rows[0]!.ends.map((e) => e.file)).toEqual(
      modules
        .slice(1)
        .map((m) => m.id)
        .toSorted((x, y) => x.localeCompare(y))
        .slice(0, 20),
    );
  });
});
