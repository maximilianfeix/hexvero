import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Session } from "../src/session.js";
import { targetFromBytes } from "../src/target.js";
import { buildElf } from "./fixtures/elf.js";
import { buildAsar } from "./fixtures/asar.js";

describe("Session", () => {
  const dir = mkdtempSync(join(tmpdir(), "hexvero-session-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const session = new Session();

  it("opens files with content-derived ids and analyzes once", async () => {
    const path = join(dir, "lib.so");
    writeFileSync(path, buildElf());
    const record = await session.open(path);
    expect(record.id).toMatch(/^t_[0-9a-f]{12}$/);
    expect(record.info.format).toBe("elf");
    expect((await session.open(path)).id).toBe(record.id);
    const analysis = await session.analyze(record.id);
    expect(analysis.data.kind).toBe("binary");
    expect(await session.analyze(record.id)).toBe(analysis);
    expect(session.get(record.id).analyzed).toBe(true);
    expect(await session.collections(record.id)).toMatchObject({
      findings: 1,
      symbols: 2,
      libraries: 2,
      imports: 1,
      exports: 1,
    });
  });

  it("pages and filters collections with a byte budget", async () => {
    const record = session.register(targetFromBytes(buildElf(), "mem.so"));
    const all = await session.collection(record.id, "symbols");
    expect(all.total).toBe(2);
    expect(all.truncated).toBe(false);
    const one = await session.collection(record.id, "symbols", { limit: 1 });
    expect(one.items).toHaveLength(1);
    expect(one.truncated).toBe(true);
    const filtered = await session.collection(record.id, "symbols", {
      text: "stack_chk",
    });
    expect(filtered.items).toHaveLength(1);
    const tiny = await session.collection(record.id, "sections", {
      maxBytes: 150,
    });
    expect(tiny.items.length).toBeLessThan(tiny.total);
    expect(tiny.truncated).toBe(true);
    await expect(session.collection(record.id, "nope")).rejects.toThrow(/available: findings/);
  });

  it("serves strings and byte windows", () => {
    const record = session.register(targetFromBytes(buildElf(), "mem2.so"));
    const strings = session.strings(record.id, { text: "libc" });
    expect(strings.items.map((s) => s.value)).toEqual(["libc.so.6"]);
    const paths = session.strings(record.id, { tag: "path" });
    expect(paths.items[0]?.value).toBe("/lib64/ld-linux-x86-64.so.2");
    const window = session.bytes(record.id, 0, 4);
    expect(window).toMatchObject({
      offset: 0,
      length: 4,
      hex: "7f454c46",
      ascii: ".ELF",
    });
    expect(() => session.bytes(record.id, 1 << 20, 4)).toThrow(/outside/);
  });

  it("exports the analysis as JSON and closes targets", async () => {
    const asar = join(dir, "app.asar");
    writeFileSync(
      asar,
      buildAsar({
        "package.json": JSON.stringify({ name: "x", main: "main.js" }),
        "main.js": "require('fs')",
      }),
    );
    const record = await session.open(asar);
    const analysis = await session.analyze(record.id);
    expect(analysis.data.kind).toBe("javascript-app");
    const out = join(dir, "export.json");
    const result = await session.export(record.id, out);
    expect(result.bytes).toBeGreaterThan(100);
    const exportedJson = JSON.parse(readFileSync(out, "utf8"));
    expect(exportedJson.analysis.summary).toContain("Electron ASAR");
    session.unknowns.record({
      targetId: record.id,
      question: "Where is the preload registered?",
      checked: ["modules"],
    });
    await session.export(record.id, out);
    expect(JSON.parse(readFileSync(out, "utf8")).unknowns).toHaveLength(1);
    expect(session.close(record.id)).toBe(true);
    expect(() => session.get(record.id)).toThrow(/No open target/);
  });

  it("falls back to unknown for unrecognized bytes", async () => {
    const record = session.register(
      targetFromBytes(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), "blob.bin"),
    );
    const analysis = await session.analyze(record.id);
    expect(analysis.data.kind).toBe("unknown");
    expect(analysis.limitations[0]?.code).toBe("unknown_format");
  });
});
