import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Session } from "../src/session.js";
import { targetFromBytes } from "../src/target.js";
import { openAsarFile } from "../src/formats/asar.js";
import { buildElf } from "./fixtures/elf.js";
import { buildAsar } from "./fixtures/asar.js";

const har = (urls: string[]): string =>
  JSON.stringify({
    log: {
      entries: urls.map((url) => ({
        request: { method: "GET", url, headers: [] },
        response: { status: 200, headers: [], content: { size: 0 } },
      })),
    },
  });

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
      findings: 2, // the import facts and the hardening line
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
      maxBytes: 512,
    });
    expect(tiny.items.length).toBeLessThan(tiny.total);
    expect(tiny.truncated).toBe(true);
    // the byte budget is an upper bound on the serialized page, envelope included
    expect(Buffer.byteLength(JSON.stringify(tiny))).toBeLessThanOrEqual(512);
    expect(tiny.bytes).toBeLessThanOrEqual(512);
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
    // a URL inside a longer string is still a URL
    const js = session.register(
      targetFromBytes(
        new TextEncoder().encode(
          'const BASE = "https://api.example.com/v1";\u0000plain text here\u0000https://%s/api/v2\u0000http://[::1]:8080/x\u0000foo_http://nope\u0000',
        ),
        "u.bin",
      ),
    );
    expect(session.strings(js.id, { tag: "url" }).items.map((s) => s.value)).toEqual([
      'const BASE = "https://api.example.com/v1";',
      "https://%s/api/v2",
      "http://[::1]:8080/x",
    ]);
    // a minified one-line file is one printable run: the value is cut, the length reported
    const oneLine = new Uint8Array(20_000).fill(0x61);
    oneLine[19_999] = 0;
    const big = session.register(targetFromBytes(oneLine, "one-line.js"));
    const run = session.strings(big.id, { limit: 1 });
    expect(run.items[0]?.value).toHaveLength(4096);
    expect(run.items[0]?.length).toBe(19_999);
    expect(run.bytes).toBeLessThan(8192);
    // one oversized item is compacted instead of breaking the budget
    const squeezed = session.strings(big.id, { limit: 1, maxBytes: 512 });
    expect(squeezed.items).toHaveLength(1);
    expect(squeezed.itemTruncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(squeezed))).toBeLessThanOrEqual(512);
    // boundary budgets around the item size: the page never exceeds them and reports its real size
    const run3000 = new Uint8Array(3001).fill(0x62);
    run3000[3000] = 0;
    const multi = session.register(targetFromBytes(run3000, "run.bin"));
    for (const budget of [512, 600, 777, 3148, 3149, 3150, 3151, 3200]) {
      const pg = session.strings(multi.id, { limit: 1, maxBytes: budget, minLength: 1 });
      expect(pg.items).toHaveLength(1);
      expect(Buffer.byteLength(JSON.stringify(pg)), String(budget)).toBeLessThanOrEqual(budget);
      expect(pg.bytes).toBe(Buffer.byteLength(JSON.stringify(pg)));
    }
  });

  it("identifies lazy targets by the full file hash", async () => {
    const { loadTarget } = await import("../src/target.js");
    const { createHash } = await import("node:crypto");
    const path = join(dir, "big.asar");
    const bytes = buildAsar({ "a.js": "x".repeat(4096) });
    writeFileSync(path, bytes);
    const lazy = await loadTarget(path, 16);
    expect(lazy.lazy).toBe(true);
    expect(lazy.info.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
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
    expect(result.path).toBe(out);
    await expect(session.export(record.id, out)).rejects.toThrow(/overwrite/);
    const exportedJson = JSON.parse(readFileSync(out, "utf8"));
    expect(exportedJson.analysis.summary).toContain("Electron ASAR");
    session.unknowns.record({
      targetId: record.id,
      question: "Where is the preload registered?",
      checked: ["modules"],
    });
    await session.export(record.id, out, { overwrite: true });
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

  it("refuses device files and FIFOs instead of reading them", async () => {
    if (process.platform === "win32") return;
    await expect(session.open("/dev/zero")).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("does not allocate a forged ASAR header length", () => {
    const header = new Uint8Array(16);
    const view = new DataView(header.buffer);
    view.setUint32(0, 4, true);
    view.setUint32(4, 200 * 1024 * 1024, true);
    view.setUint32(8, 200 * 1024 * 1024 - 4, true);
    view.setUint32(12, 200 * 1024 * 1024 - 8, true);
    const path = join(dir, "forged.asar");
    writeFileSync(path, header);
    const before = process.memoryUsage().arrayBuffers;
    expect(() => openAsarFile(path)).toThrow(/truncated/);
    expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(64 * 1024 * 1024);
  });

  it("never reports an item as added or removed when the other side was compared only in part", async () => {
    // 2,500 requests in opposite orders: each side's first 2,000 rows hold different requests,
    // although both captures contain exactly the same ones.
    const urls = Array.from({ length: 2500 }, (_, i) => `https://api.example.test/v1/item/${i}`);
    writeFileSync(join(dir, "a.har"), har(urls));
    writeFileSync(join(dir, "b.har"), har(urls.toReversed()));
    const a = await session.open(join(dir, "a.har"));
    const b = await session.open(join(dir, "b.har"));
    const { diff, left, right } = await session.compareCollection(a.id, b.id, "requests");
    expect(left.truncated && right.truncated).toBe(true);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    // First 2,000 of a: 0..1999; of b: 2499..500. Each side has 500 the other did not compare.
    expect(diff.unknown.length).toBe(500 + 500);
    expect(diff.unknown[0]?.reason).toBe("the other side was compared only in part");
    const all = await session.compareAll(a.id, b.id);
    const requests = all.collections.find((c) => c.collection === "requests");
    expect(requests).toMatchObject({ added: 0, removed: 0, unknown: 1000, partial: true });
  });
});
