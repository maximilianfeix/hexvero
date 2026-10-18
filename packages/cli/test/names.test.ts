import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildAsar } from "../../core/test/fixtures/asar.js";
import type { Io } from "../src/format.js";
import { main } from "../src/index.js";

function capture(): Io & { text(): string } {
  const lines: string[] = [];
  return {
    color: false,
    out: (t: string) => void lines.push(t),
    err: (t: string) => void lines.push(t),
    text: () => lines.join("\n"),
  };
}

const dir = mkdtempSync(join(tmpdir(), "hexvero-names-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const policy = join(import.meta.dirname, "..", "..", "..", "examples", "policy.json");

const place = (parent: string, pkg: Record<string, string>): string => {
  // the parent goes into the code too, so two builds are never the same bytes (one target)
  mkdirSync(join(dir, parent), { recursive: true });
  const path = join(dir, parent, "app.asar");
  writeFileSync(
    path,
    buildAsar({
      "package.json": JSON.stringify({ ...pkg, main: "main.js" }),
      "main.js": `require("electron").ipcMain.handle("ping", () => 1); // ${parent}\n`,
    }),
  );
  return path;
};

describe("builds with the same file name", () => {
  it("are named by their package.json name and version in compare and check", async () => {
    const a = place("v1", { name: "notes", version: "1.0.0" });
    const b = place("v2", { name: "notes", version: "2.0.0" });
    const compare = capture();
    expect(await main(["compare", a, b], compare)).toBe(0);
    expect(compare.text()).toContain("a app.asar (notes 1.0.0) · b app.asar (notes 2.0.0)");
    const check = capture();
    await main(["check", a, b, "--policy", policy], check);
    expect(check.text()).toContain("before app.asar (notes 1.0.0) · after app.asar (notes 2.0.0)");
  });

  it("fall back to their parent directories when the packages read the same", async () => {
    const a = place("build-old/out", { name: "same", version: "1.0.0" });
    const b = place("build-new/out", { name: "same", version: "1.0.0" });
    const check = capture();
    await main(["check", a, b, "--policy", policy], check);
    expect(check.text()).toContain("before build-old/out/app.asar · after build-new/out/app.asar");
  });

  it("keep plain file names when those differ", async () => {
    const a = place("x", { name: "p", version: "1" });
    const other = join(dir, "x", "other.asar");
    writeFileSync(
      other,
      buildAsar({ "package.json": JSON.stringify({ name: "p", main: "m.js" }) }),
    );
    const compare = capture();
    expect(await main(["compare", a, other], compare)).toBe(0);
    expect(compare.text()).not.toContain(" · b ");
    const check = capture();
    await main(["check", a, other, "--policy", policy], check);
    expect(check.text()).toContain("before app.asar · after other.asar");
  });

  it("name packaged builds in the report title, not their app.asar (#195 review)", async () => {
    const bundle = (parent: string, version: string): string => {
      const root = join(dir, parent, "Notes.app");
      mkdirSync(join(root, "Contents", "Resources"), { recursive: true });
      writeFileSync(
        join(root, "Contents", "Resources", "app.asar"),
        buildAsar({
          "package.json": JSON.stringify({ name: "notes", version, main: "main.js" }),
          "main.js": `require("electron").ipcMain.handle("ping${version}", () => 1);\n`,
        }),
      );
      return root;
    };
    const [a, b] = [bundle("r1", "1.0.0"), bundle("r2", "2.0.0")];
    for (const report of ["r.html", "r.md"]) {
      const out = join(dir, report);
      expect(await main(["compare", a, b, "--report", out, "--force"], capture())).toBe(0);
      const text = readFileSync(out, "utf8");
      expect(text).toContain("Notes.app (notes 1.0.0)");
      expect(text).toContain("Notes.app (notes 2.0.0)");
      expect(text).not.toContain("app.asar → app.asar");
    }
  });

  it("treat two Unicode spellings of one name as the same name", async () => {
    const { buildLabels } = await import("@hexvero/core");
    const info = (path: string, sha: string) => ({
      info: { path, size: 1, sha256: sha, format: "asar" },
    });
    const stub = (paths: Record<string, string>) =>
      ({
        get: (id: string) => info(paths[id]!, id.repeat(64)),
        analyze: async () => ({ data: { kind: "javascript" } }),
      }) as unknown as Parameters<typeof buildLabels>[0];
    // Caf\u00e9.asar and Cafe\u0301.asar print the same: the parents tell them apart
    expect(
      await buildLabels(stub({ a: "/n1/Caf\u00e9.asar", b: "/n2/Cafe\u0301.asar" }), "a", "b"),
    ).toEqual({ a: "n1/Caf\u00e9.asar", b: "n2/Cafe\u0301.asar", sameName: true });
    // nothing tells them apart but their bytes
    expect(
      await buildLabels(stub({ a: "/x/Caf\u00e9.asar", b: "/x/Cafe\u0301.asar" }), "a", "b"),
    ).toEqual({
      a: "Caf\u00e9.asar (sha256 aaaaaaaaaaaa)",
      b: "Cafe\u0301.asar (sha256 bbbbbbbbbbbb)",
      sameName: true,
    });
  });
});
