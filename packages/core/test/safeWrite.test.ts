import {
  closeSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { writeFileNoFollow } from "../src/safeWrite.js";

const linksAllowed = (): boolean => {
  const probe = mkdtempSync(join(tmpdir(), "hexvero-links-"));
  try {
    symlinkSync(join(probe, "x"), join(probe, "y"));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
};

describe("writeFileNoFollow", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "hexvero-safewrite-")));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("refuses a link put in place between the check and the open", async (ctx) => {
    if (!linksAllowed()) return ctx.skip();
    const victim = join(dir, "victim.txt");
    writeFileSync(victim, "keep");
    for (const overwrite of [false, true]) {
      const path = join(dir, `swap-${overwrite}.json`);
      await expect(
        writeFileNoFollow(path, "{}", {
          overwrite,
          beforeOpen: () => {
            if (!existsSync(path) && !lstatSafe(path)) symlinkSync(victim, path);
          },
        }),
      ).rejects.toThrow(/symbolic link|exists/);
      expect(readFileSync(victim, "utf8")).toBe("keep");
    }
  });

  it("removes a file it created when the check after opening refuses it", async () => {
    const path = join(dir, "refused.json");
    await expect(
      writeFileNoFollow(path, "{}", {
        afterOpen: () => {
          throw new Error("moved");
        },
      }),
    ).rejects.toThrow("moved");
    expect(existsSync(path)).toBe(false);
  });

  it("writes to a stream name only when a terminal, pipe or device is behind it", async (ctx) => {
    if (process.platform === "win32") return ctx.skip();
    await writeFileNoFollow("/dev/null", "x");
    const file = join(dir, "behind-fd.txt");
    const fd = openSync(file, "w");
    try {
      await expect(writeFileNoFollow(`/dev/fd/${fd}`, "planted")).rejects.toMatchObject({
        details: { code: "ENOTREG" },
      });
    } finally {
      closeSync(fd);
    }
    expect(readFileSync(file, "utf8")).toBe("");
    // a stream name is not a pass for MCP-style writes
    await expect(
      writeFileNoFollow("/dev/null", "x", { overwrite: true, inspect: () => null }),
    ).rejects.toThrow();
  });

  it("refuses to replace a file with another hard link when inspecting", async () => {
    const outside = join(dir, "other.json");
    writeFileSync(outside, '{"hexvero": 1}');
    const { linkSync } = await import("node:fs");
    const inside = join(dir, "hard.json");
    linkSync(outside, inside);
    await expect(
      writeFileNoFollow(inside, "{}", { overwrite: true, inspect: () => null }),
    ).rejects.toMatchObject({ details: { code: "EMLINK" } });
    expect(readFileSync(outside, "utf8")).toBe('{"hexvero": 1}');
  });
});

function lstatSafe(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}
