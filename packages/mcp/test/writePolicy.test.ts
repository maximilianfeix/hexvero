import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Session } from "@hexvero/core";
import { checkWritePath } from "../src/writePolicy.js";
import { buildElf } from "../../core/test/fixtures/elf.js";

/** Creates a symlink, or returns false where the platform does not permit it (Windows without rights). */
function trySymlink(target: string, path: string): boolean {
  try {
    symlinkSync(target, path);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES" || code === "ENOTSUP") return false;
    throw error;
  }
}

describe("MCP write policy", () => {
  let root: string;
  let outside: string;
  const saved = process.env["HEXVERO_WRITE_ROOTS"];

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "hexvero-root-")));
    outside = realpathSync(mkdtempSync(join(tmpdir(), "hexvero-outside-")));
    process.env["HEXVERO_WRITE_ROOTS"] = root;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env["HEXVERO_WRITE_ROOTS"];
    else process.env["HEXVERO_WRITE_ROOTS"] = saved;
  });

  it("allows exports and recovery inside the roots", () => {
    expect(checkWritePath(join(root, "out", "report.json"), "export")).toBe(
      join(root, "out", "report.json"),
    );
    expect(checkWritePath(join(root, "recovered"), "recover")).toBe(join(root, "recovered"));
  });

  it("refuses paths outside the roots, hidden paths, other extensions and escaping symlinks", () => {
    expect(() => checkWritePath(join(outside, "report.json"), "export")).toThrow(/outside/);
    expect(() => checkWritePath(join(root, "..", "x.json"), "export")).toThrow(/outside/);
    expect(() => checkWritePath(join(root, ".zshrc"), "export")).toThrow(/hidden/);
    expect(() => checkWritePath(join(root, ".config", "a.json"), "export")).toThrow(/hidden/);
    expect(() => checkWritePath(join(root, ".ssh"), "recover")).toThrow(/hidden/);
    expect(() => checkWritePath(join(root, "run.sh"), "export")).toThrow(/\.json/);
    symlinkSync(outside, join(root, "link"));
    expect(() => checkWritePath(join(root, "link", "report.json"), "export")).toThrow(/outside/);
    expect(() => checkWritePath(join(root, "link"), "recover")).toThrow(/outside/);
  });

  it("replaces only earlier exports when overwriting", async () => {
    const target = join(root, "fixture.elf");
    writeFileSync(target, buildElf());
    const session = new Session();
    const { id } = await session.open(target);
    const notes = join(root, "notes.json");
    writeFileSync(notes, '{"mine": true}');
    await expect(
      session.export(id, notes, { overwrite: true, onlyReplaceExports: true }),
    ).rejects.toThrow(/not an earlier hexvero export/);
    expect(readFileSync(notes, "utf8")).toBe('{"mine": true}');
    const report = join(root, "report.json");
    await session.export(id, report);
    await session.export(id, report, { overwrite: true, onlyReplaceExports: true });
    expect(readFileSync(report, "utf8").startsWith('{\n  "hexvero": 1')).toBe(true);
  });

  it("judges a dangling symlink by where it points and never writes through a link", async (ctx) => {
    const target = join(root, "fixture.elf");
    writeFileSync(target, buildElf());
    const session = new Session();
    const { id } = await session.open(target);
    const exportVia = async (path: string) =>
      session.export(id, checkWritePath(path, "export"), {
        overwrite: true,
        onlyReplaceExports: true,
      });

    // a link to a file outside the roots that does not exist yet
    const missing = join(outside, "planted.json");
    if (!trySymlink(missing, join(root, "dangling.json"))) return ctx.skip();
    expect(() => checkWritePath(join(root, "dangling.json"), "export")).toThrow(/outside/);
    await expect(exportVia(join(root, "dangling.json"))).rejects.toThrow(/outside/);
    expect(existsSync(missing)).toBe(false);

    // a link to an existing file outside the roots
    const existing = join(outside, "existing.json");
    writeFileSync(existing, '{"keep": true}');
    trySymlink(existing, join(root, "existing.json"));
    await expect(exportVia(join(root, "existing.json"))).rejects.toThrow(/outside/);
    expect(readFileSync(existing, "utf8")).toBe('{"keep": true}');

    // a dangling link inside a linked directory chain that leaves the roots
    trySymlink(join(outside, "deeper"), join(root, "dir"));
    expect(() => checkWritePath(join(root, "dir", "a.json"), "export")).toThrow(/outside/);
    expect(() => checkWritePath(join(root, "dir"), "recover")).toThrow(/outside/);

    // a link that stays inside the roots passes the policy, but the export still refuses it
    trySymlink(join(root, "real.json"), join(root, "inside.json"));
    expect(checkWritePath(join(root, "inside.json"), "export")).toBe(join(root, "inside.json"));
    await expect(exportVia(join(root, "inside.json"))).rejects.toThrow(/symbolic link/);
    expect(existsSync(join(root, "real.json"))).toBe(false);
    expect(lstatSync(join(root, "inside.json")).isSymbolicLink()).toBe(true);

    // a link that points at a hidden file inside a root
    trySymlink(join(root, ".zshrc"), join(root, "rc.json"));
    expect(() => checkWritePath(join(root, "rc.json"), "export")).toThrow(/hidden|\.json/);
  });

  it("refuses to recover into a dangling symlink with invalid_input", async (ctx) => {
    const bundle = join(root, "bundle.js");
    writeFileSync(bundle, "console.log(1);\n");
    const session = new Session();
    const { id } = await session.open(bundle);
    if (!trySymlink(join(root, "not-there"), join(root, "out"))) return ctx.skip();
    expect(checkWritePath(join(root, "out"), "recover")).toBe(join(root, "out"));
    await expect(session.recover(id, join(root, "out"))).rejects.toMatchObject({
      code: "invalid_input",
    });
    expect(existsSync(join(root, "not-there"))).toBe(false);
  });
});
