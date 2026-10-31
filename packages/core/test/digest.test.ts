import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { directoryDigest } from "../src/digest.js";
import { timeLimit } from "./timeLimit.js";

describe("directory digest", () => {
  const dir = mkdtempSync(join(tmpdir(), "hexvero-digest-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const app = (name: string, files: Record<string, string>): string => {
    const root = join(dir, name);
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(join(root, file, ".."), { recursive: true });
      writeFileSync(join(root, file), text);
    }
    mkdirSync(root, { recursive: true });
    return root;
  };

  it("depends on paths and bytes, and not on skipped directories", () => {
    const a = directoryDigest(app("a", { "package.json": "{}", "main.js": "1" }));
    const same = directoryDigest(app("same", { "main.js": "1", "package.json": "{}" }));
    const other = directoryDigest(app("other", { "package.json": "{}", "main.js": "2" }));
    const renamed = directoryDigest(app("renamed", { "package.json": "{}", "index.js": "1" }));
    const git = directoryDigest(
      app("git", { "package.json": "{}", "main.js": "1", ".git/HEAD": "x" }),
    );
    expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(a.partial).toBeUndefined();
    expect(same.sha256).toBe(a.sha256);
    expect(git.sha256).toBe(a.sha256);
    expect(other.sha256).not.toBe(a.sha256);
    expect(renamed.sha256).not.toBe(a.sha256);
  });

  it("stays within the listing limits of the analysis and says when it is partial", () => {
    let deep = "";
    for (let i = 0; i < 40; i++) deep += `d${i}/`;
    const nested = directoryDigest(app("deep", { "main.js": "1", [`${deep}x.js`]: "2" }));
    expect(nested.partial).toContain("deeper than 32 levels");
    const many: Record<string, string> = {};
    for (let i = 0; i < 300; i++) many[`f${String(i).padStart(3, "0")}.js`] = String(i);
    const root = app("many", many);
    const started = performance.now();
    const cut = directoryDigest(root, { maxFiles: 100 });
    expect(performance.now() - started).toBeLessThan(timeLimit(5_000));
    expect(cut.partial).toContain("more than 100 files");
    const bytes = directoryDigest(root, { maxBytes: 50 });
    expect(bytes.partial).toContain("byte budget");
    expect(directoryDigest(root).partial).toBeUndefined();
  });

  it("never follows a symlinked file out of the build", (ctx) => {
    const outside = join(dir, "outside.js");
    writeFileSync(outside, "secret 1");
    const root = app("linked", { "package.json": "{}", "main.js": "1" });
    try {
      symlinkSync(outside, join(root, "out.js"));
      symlinkSync(join(root, "main.js"), join(root, "in.js"));
    } catch (error) {
      if (["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) ctx.skip();
      throw error;
    }
    const before = directoryDigest(root);
    writeFileSync(outside, "secret 2");
    expect(directoryDigest(root).sha256).toBe(before.sha256);
    // the link inside the build is read like the analysis reads it: its target's bytes count
    writeFileSync(join(root, "main.js"), "2");
    expect(directoryDigest(root).sha256).not.toBe(before.sha256);
  });

  it("reads names in NFC and says when links out of the build are past the named ones", (ctx) => {
    const nfd = directoryDigest(app("nfd", { "package.json": "{}", "cafe\u0301.js": "1" }));
    const nfc = directoryDigest(app("nfc", { "package.json": "{}", "caf\u00e9.js": "1" }));
    expect(nfd.sha256).toBe(nfc.sha256);
    const root = app("links", { "package.json": "{}", "main.js": "1" });
    const outside = join(dir, "outside-many.js");
    writeFileSync(outside, "x");
    try {
      for (let i = 0; i < 205; i++) symlinkSync(outside, join(root, `l${i}.js`));
    } catch (error) {
      if (["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) ctx.skip();
      throw error;
    }
    expect(directoryDigest(root).partial).toContain("links lead out of it");
  });
});
