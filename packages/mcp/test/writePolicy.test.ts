import { mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Session } from "@hexvero/core";
import { checkWritePath } from "../src/writePolicy.js";
import { buildElf } from "../../core/test/fixtures/elf.js";

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
});
