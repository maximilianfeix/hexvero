import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
});
