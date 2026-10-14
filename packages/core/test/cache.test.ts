import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cacheEntries, ensurePrivateDir, pruneCache } from "../src/cache.js";
import { saveScan } from "../src/javascript/scanState.js";
import { emptyJsScanFacts } from "../src/javascript/app.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe("cache", () => {
  let root: string;
  const saved = process.env["HEXVERO_CACHE_DIR"];
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hexvero-cache-"));
    process.env["HEXVERO_CACHE_DIR"] = root;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env["HEXVERO_CACHE_DIR"];
    else process.env["HEXVERO_CACHE_DIR"] = saved;
    rmSync(root, { recursive: true, force: true });
  });

  const put = (area: string, name: string, bytes: number, ageMs: number): string => {
    mkdirSync(join(root, area), { recursive: true });
    const path = join(root, area, name);
    writeFileSync(path, Buffer.alloc(bytes));
    const t = new Date(Date.now() - ageMs);
    utimesSync(path, t, t);
    return path;
  };

  it("removes what is too old, then the oldest until under budget, never the last hour", () => {
    const old = put("scans", `${"a".repeat(40)}.json`, 100, 40 * DAY);
    const older = put("graphs", `radare2-${"b".repeat(16)}-${"c".repeat(10)}.json`, 500, 3 * DAY);
    const newer = put("scans", `${"d".repeat(40)}.json`, 500, 2 * DAY);
    const fresh = put("scans", `${"e".repeat(40)}.json`, 2_000, 10 * 60 * 1000);
    const result = pruneCache({ maxBytes: 1_000, maxAgeMs: 30 * DAY });
    expect(result.removed.map((e) => e.path)).toEqual([old, older, newer]);
    expect(existsSync(fresh)).toBe(true); // over budget alone, but written minutes ago
    expect(result.bytes).toBe(2_000);
  });

  it("touches only what hexvero names and never follows a link", () => {
    const outside = mkdtempSync(join(tmpdir(), "hexvero-outside-"));
    writeFileSync(join(outside, "keep.txt"), "mine");
    mkdirSync(join(root, "ghidra"), { recursive: true });
    symlinkSync(outside, join(root, "ghidra", "0123456789abcdef"));
    const foreign = put("scans", "notes.txt", 10, 400 * DAY);
    const stale = put("scans", `${"f".repeat(40)}.json.123.456.tmp`, 10, 2 * DAY);
    const project = join(root, "ghidra", "fedcba9876543210");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "hexvero.gpr"), "x");
    const t = new Date(Date.now() - 90 * DAY);
    utimesSync(project, t, t);
    expect(cacheEntries().map((e) => e.name)).toEqual([
      "fedcba9876543210",
      `${"f".repeat(40)}.json.123.456.tmp`,
    ]);
    pruneCache();
    expect(existsSync(project)).toBe(false);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(foreign)).toBe(true);
    expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("mine");
    rmSync(outside, { recursive: true, force: true });
  });

  it.skipIf(process.platform === "win32")(
    "keeps scan state private and tightens older directories",
    () => {
      mkdirSync(join(root, "scans"), { recursive: true, mode: 0o755 });
      chmodSync(root, 0o755);
      chmodSync(join(root, "scans"), 0o755);
      saveScan("0".repeat(40), emptyJsScanFacts());
      expect(statSync(root).mode & 0o777).toBe(0o700);
      expect(statSync(join(root, "scans")).mode & 0o777).toBe(0o700);
      expect(statSync(join(root, "scans", `${"0".repeat(40)}.json`)).mode & 0o777).toBe(0o600);
      ensurePrivateDir(join(root, "graphs"));
      expect(statSync(join(root, "graphs")).mode & 0o777).toBe(0o700);
    },
  );
});
