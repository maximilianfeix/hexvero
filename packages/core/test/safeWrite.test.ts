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

  it("writes to what the shell connected to a stream name, a file included", async (ctx) => {
    if (process.platform === "win32") return ctx.skip();
    await writeFileNoFollow("/dev/null", "x");
    // `--out /dev/fd/3 3> file` and `3>> file`: the file the shell opened is the output
    const file = join(dir, "behind-fd.txt");
    for (const [flags, before, after] of [
      ["w", "", "out"],
      ["a", "head\n", "head\nout"],
    ] as const) {
      writeFileSync(file, before);
      const fd = openSync(file, flags);
      try {
        await writeFileNoFollow(`/dev/fd/${fd}`, "out");
      } finally {
        closeSync(fd);
      }
      expect(readFileSync(file, "utf8")).toBe(after);
    }
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

  it("refuses a FIFO at a path that is not a stream name instead of blocking", async (ctx) => {
    if (process.platform === "win32") return ctx.skip();
    const fifo = join(dir, "not-a-stream.md");
    const { execFileSync } = await import("node:child_process");
    execFileSync("mkfifo", [fifo]);
    await expect(writeFileNoFollow(fifo, "x", { overwrite: true })).rejects.toMatchObject({
      details: { code: "ENOTREG" },
    });
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
