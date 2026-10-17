/**
 * Regression tests for inputs found by scripts/fuzz.mjs: each one used to end in a JavaScript
 * runtime error (a TypeError or a stack overflow) instead of a typed error or a result.
 */
import { describe, expect, it } from "vitest";
import { openAsar } from "../src/formats/asar.js";
import { AnalysisError } from "../src/model.js";
import { parseBaseline, parsePolicy, PolicyError } from "../src/policy.js";
import { Session } from "../src/session.js";
import { targetFromBytes } from "../src/target.js";

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
    expect(performance.now() - started).toBeLessThan(5_000);
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
    expect(performance.now() - started).toBeLessThan(5_000);
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
      expect((caught as PolicyError).issues.join("\n")).toMatch(/a nested list/);
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
