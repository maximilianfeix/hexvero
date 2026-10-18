import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Session } from "../src/session.js";
import { targetFromBytes } from "../src/target.js";
import { openAsarFile } from "../src/formats/asar.js";
import { buildElf } from "./fixtures/elf.js";
import { buildAsar } from "./fixtures/asar.js";

/** A capture of these requests; `POST url` sends a POST, a bare URL a GET. */
const har = (urls: string[]): string =>
  JSON.stringify({
    log: {
      entries: urls.map((entry) => ({
        request: {
          method: entry.startsWith("POST ") ? "POST" : "GET",
          url: entry.replace(/^POST /, ""),
          headers: [],
        },
        response: { status: 200, headers: [], content: { size: 0 } },
      })),
    },
  });

const long = (tail: string): string => `https://api.example.test/${"ü".repeat(200_000)}${tail}`;
const wide = (i: number): string => `https://api.example.test/${"€".repeat(1000)}/${i}`;
/** An app whose v2 registers a channel through a value read at run time (C2). */
const unresolvedApp = (v2: boolean): Uint8Array =>
  buildAsar({
    "package.json": JSON.stringify({ name: "c2", version: "1.0.0", main: "main.js" }),
    "main.js": [
      'const { ipcMain } = require("electron");',
      'require("./extra.js");',
      v2 ? "ipcMain.handle(process.env.X, () => 1);" : 'ipcMain.handle("a:b", () => 1);',
      v2 ? "" : 'ipcMain.on("c:d", () => 1);',
    ].join("\n"),
    // a real deletion in a file that has no unresolved value on either side
    "extra.js": [
      'const { ipcMain } = require("electron");',
      v2 ? "" : 'ipcMain.on("gone:now", () => 1);',
      'ipcMain.on("stays", () => 1);',
    ].join("\n"),
  });

describe("Session", () => {
  const dir = mkdtempSync(join(tmpdir(), "hexvero-session-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const session = new Session();
  const open = async (name: string, list: string[]): Promise<string> => {
    writeFileSync(join(dir, name), har(list));
    return (await session.open(join(dir, name))).id;
  };

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

  describe("compares whole collections, not their first page (C1)", () => {
    const urls = Array.from({ length: 2600 }, (_, i) => `https://api.example.test/v1/item/${i}`);
    it("finds the only change when it sits after item 2,000", async () => {
      const changed = urls.map((u, i) => (i === 2300 ? `${u}?v=2` : u));
      const [a, b] = [await open("c1-a.har", urls), await open("c1-b.har", changed)];
      const { diff, left, right } = await session.compareCollection(a, b, "requests");
      expect(diff.removed).toEqual([urls[2300]]);
      expect(diff.added).toEqual([`${urls[2300]}?v=2`]);
      expect([diff.unknown, diff.changed]).toEqual([[], []]);
      expect(diff.unchanged).toBe(2599);
      expect(diff.completeness).toEqual({
        compared: { a: 2600, b: 2600 },
        total: { a: 2600, b: 2600 },
        complete: true,
        gaps: [],
      });
      // the pages stay a bounded preview for callers that print items
      expect([left.items.length, right.items.length]).toEqual([2000, 2000]);
      const all = await session.compareAll(a, b);
      expect(all.collections.find((c) => c.collection === "requests")).toMatchObject({
        added: 1,
        removed: 1,
        unknown: 0,
        partial: false,
        totals: { a: 2600, b: 2600 },
        completeness: { complete: true, gaps: [] },
      });
    });

    it("reports nothing when the items were only reordered", async () => {
      const [a, b] = [await open("c1-r1.har", urls), await open("c1-r2.har", urls.toReversed())];
      const { diff } = await session.compareCollection(a, b, "requests");
      expect([diff.added, diff.removed, diff.unknown, diff.changed]).toEqual([[], [], [], []]);
      // a request's index is its position in the capture: it moved, nothing else
      expect(diff.unchanged + diff.relocated).toBe(2600);
      expect(diff.completeness.complete).toBe(true);
    });

    it("pairs duplicate identities that sit on different sides of the old page boundary", async () => {
      // the same URL twice per side, as a GET and as a POST, at positions that used to fall
      // into different pages: a page-by-page comparison paired the GET with the POST
      const dup = "https://api.example.test/dup";
      const left = [...urls];
      left[10] = dup;
      left[2200] = `POST ${dup}`;
      const right = [...urls];
      right[5] = `POST ${dup}`;
      right[2400] = dup;
      right[10] = urls[5]!;
      right[2200] = urls[2400]!;
      const [a, b] = [await open("c1-d1.har", left), await open("c1-d2.har", right)];
      const { diff } = await session.compareCollection(a, b, "requests");
      expect([diff.added, diff.removed, diff.unknown, diff.changed]).toEqual([[], [], [], []]);
      expect(diff.duplicateKeys).toBe(1);
    });

    it("compares long UTF-8 fields to their last character", async () => {
      const head = urls.slice(0, 2400);
      const [a, b] = [
        await open("c1-u1.har", [...head, long("a")]),
        await open("c1-u2.har", [...head, long("b")]),
      ];
      const { diff } = await session.compareCollection(a, b, "requests");
      expect(diff.removed.map((k) => k.slice(-2))).toEqual(["üa"]);
      expect(diff.added.map((k) => k.slice(-2))).toEqual(["üb"]);
      expect(diff.completeness.complete).toBe(true);
    });

    it("says it compared only part when a side exceeds the budget, and never calls the rest gone", async () => {
      const shifted = [...urls.slice(1), "https://api.example.test/new"];
      const [a, b] = [await open("c1-b1.har", urls), await open("c1-b2.har", shifted)];
      const { diff } = await session.compareCollection(a, b, "requests", {
        budget: { items: 100, bytes: 256 << 20 },
      });
      expect(diff.completeness).toEqual({
        compared: { a: 100, b: 100 },
        total: { a: 2600, b: 2600 },
        complete: false,
        gaps: ["budget"],
      });
      expect([diff.added, diff.removed]).toEqual([[], []]);
      expect(diff.unknown.map((u) => u.reason)).toEqual(
        Array(2).fill("the other side was compared only in part"),
      );
      // the byte budget counts UTF-8 bytes of the serialized items, not characters
      const many = Array.from({ length: 50 }, (_, i) => wide(i));
      const [c, d] = [await open("c1-w1.har", many), await open("c1-w2.har", many)];
      const bytes = (
        await session.compareCollection(c, d, "requests", {
          // ~1,100 characters but ~3,100 bytes per item: 20 items by characters, 7 by bytes
          budget: { items: 1000, bytes: 22_000 },
        })
      ).diff.completeness;
      expect(bytes.complete).toBe(false);
      expect(bytes.gaps).toEqual(["budget"]);
      expect(bytes.compared.a).toBeLessThan(8);
    });
  });

  it("calls a channel unknown, not removed, when the other build registers one it cannot read there (C2)", async () => {
    writeFileSync(join(dir, "c2-v1.asar"), unresolvedApp(false));
    writeFileSync(join(dir, "c2-v2.asar"), unresolvedApp(true));
    const v1 = (await session.open(join(dir, "c2-v1.asar"))).id;
    const v2 = (await session.open(join(dir, "c2-v2.asar"))).id;
    const reason = "the other side has values there that could not be resolved";
    for (const [a, b, side] of [
      [v1, v2, "a"],
      [v2, v1, "b"],
    ] as const) {
      const ipc = (await session.compareCollection(a, b, "ipc")).diff;
      const gone = side === "a" ? ipc.removed : ipc.added;
      expect(gone).toEqual(["extra.js::ipcMain.on::gone:now"]);
      expect(ipc.unknown.filter((u) => u.side === side).map((u) => [u.key, u.reason])).toEqual([
        ["main.js::ipcMain.handle::a:b", reason],
        ["main.js::ipcMain.on::c:d", reason],
      ]);
      expect(ipc.completeness.gaps).toEqual(["values_unresolved"]);
      const channels = (await session.compareCollection(a, b, "ipcChannels")).diff;
      expect(side === "a" ? channels.removed : channels.added).toEqual(["gone:now"]);
      expect(channels.unknown.map((u) => [u.key, u.reason]).toSorted()).toEqual([
        ["a:b", reason],
        ["c:d", reason],
      ]);
    }
    expect((await session.coverage(v2))?.unresolved.get("ipc")).toEqual(new Set(["main.js"]));
    expect((await session.coverage(v1))?.unresolved.get("ipc") ?? new Set()).toEqual(new Set());
  });

  it("exports the same bytes for the same input, apart from the fields it names as volatile", async () => {
    const path = join(dir, "stable.so");
    writeFileSync(path, buildElf());
    const read = async (out: string): Promise<Record<string, unknown>> => {
      const fresh = new Session();
      const record = await fresh.open(path);
      await fresh.export(record.id, join(dir, out));
      const doc = JSON.parse(readFileSync(join(dir, out), "utf8")) as Record<string, unknown>;
      for (const field of doc["volatile"] as string[]) {
        const parts = field.split(".");
        let holder = doc as Record<string, unknown>;
        for (const part of parts.slice(0, -1)) holder = holder[part] as Record<string, unknown>;
        expect(holder).toHaveProperty(parts.at(-1)!);
        delete holder[parts.at(-1)!];
      }
      return doc;
    };
    const first = await read("one.json");
    expect(JSON.stringify(await read("two.json"))).toBe(JSON.stringify(first));
    expect(first["generator"]).toMatchObject({ name: "@hexvero/core" });
    expect(first).toMatchObject({ hexvero: 1, complete: true, incomplete: [] });
  });

  it("marks an export incomplete and names why when the analysis has limitations", async () => {
    const path = join(dir, "dynamic.js");
    writeFileSync(
      path,
      'const { ipcMain } = require("electron");\nipcMain.handle(process.env.CHANNEL, () => 1);\n',
    );
    const record = await session.open(path);
    const analysis = await session.analyze(record.id);
    await session.export(record.id, join(dir, "dynamic.json"));
    const doc = JSON.parse(readFileSync(join(dir, "dynamic.json"), "utf8"));
    expect(analysis.limitations.length).toBeGreaterThan(0);
    expect(doc.complete).toBe(false);
    expect(doc.incomplete).toEqual([...new Set(analysis.limitations.map((l) => l.code))]);
  });

  it("lists window settings that changed what pages may do, with the direction of the change", async () => {
    const examples = join(import.meta.dirname, "..", "..", "..", "examples");
    const a = await session.open(join(examples, "notesdesk-1.4.0.asar"));
    const b = await session.open(join(examples, "notesdesk-1.5.0.asar"));
    const forward = await session.compareAll(a.id, b.id);
    expect(forward.windowChanges).toContainEqual({
      window: "main.js::win",
      setting: "sandboxInEffect",
      before: "off",
      after: "on",
      direction: "less permissive",
    });
    const back = await session.compareAll(b.id, a.id);
    expect(back.windowChanges.map((w) => w.direction)).toEqual(
      forward.windowChanges.map(() => "more permissive"),
    );
  });
});

describe("a comparison where one side calls an IPC registration past the sites read", () => {
  const dir = mkdtempSync(join(tmpdir(), "hexvero-session-cap-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const session = new Session();
  const build = async (calls: number): Promise<string> => {
    const path = join(dir, `reg-${calls}.asar`);
    writeFileSync(
      path,
      buildAsar({
        "package.json": JSON.stringify({ name: "r", main: "main.js" }),
        "main.js": [
          'const { ipcMain } = require("electron");',
          'function reg(ipc) { ipc.handle("fixed", () => 1); }',
          ...Array.from({ length: calls }, () => "reg(ipcMain);"),
        ].join("\n"),
      }),
    );
    return (await session.open(path)).id;
  };

  it("leaves the channel unknown, not removed", async () => {
    const [a, b] = [await build(64), await build(65)];
    const { diff } = await session.compareCollection(a, b, "ipcChannels");
    expect(diff.removed).toEqual([]);
    expect(diff.unknown).toMatchObject([{ side: "a" }]);
    expect(diff.completeness.gaps).toContain("values_unresolved");
  });
});
