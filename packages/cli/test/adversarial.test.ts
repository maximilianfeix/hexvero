/** Regression tests for CLI output found by scripts/fuzz.mjs. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildAsar } from "../../core/test/fixtures/asar.js";
import { paint, printable, table, terminalSafe, type Io } from "../src/format.js";
import { main } from "../src/index.js";

function capture(): Io & { stdout: string[]; stderr: string[] } {
  const io = {
    stdout: [] as string[],
    stderr: [] as string[],
    color: false,
    out: (t: string) => void io.stdout.push(t),
    err: (t: string) => void io.stderr.push(t),
  };
  return io;
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;

const app = (source: string) =>
  buildAsar({ "package.json": JSON.stringify({ name: "x", main: "main.js" }), "main.js": source });

describe("names with control characters on the terminal", () => {
  const dir = mkdtempSync(join(tmpdir(), "hexvero-adv-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const a = join(dir, "a.asar");
  const b = join(dir, "b.asar");
  writeFileSync(a, app("module.exports = 1;"));
  writeFileSync(b, app("module.exports = 2;"));

  it("shows them as escapes", () => {
    expect(printable("a\u001b[31mb\u0007c\u009bd\ne\tf")).toBe(
      "a\\u001b[31mb\\u0007c\\u009bd\\u000ae\\u0009f",
    );
  });

  it("keeps only hexvero's own color codes at the terminal", () => {
    const io = { out() {}, err() {}, color: true };
    const own = paint(io, "red", "error:");
    expect(terminalSafe(own)).toBe("\u001b[31merror:\u001b[0m");
    // the same code from a target is escaped, as is every other control sequence
    expect(terminalSafe(`\u001b[31m \u001b]0;title\u0007 \u001b[2J`)).toBe(
      "\\u001b[31m \\u001b]0;title\\u0007 \\u001b[2J",
    );
    // JSON stays JSON: a C1 character JSON.stringify leaves raw becomes its JSON escape
    expect(JSON.parse(terminalSafe(JSON.stringify("a\u0085b")))).toBe("a\u0085b");
  });

  it("does not echo a report name's escape sequences", async () => {
    const name = join(dir, "\u001b]0;retitled\u0007\u001b[2J.md");
    for (let i = 0; i < 2; i++) {
      // the second run refuses to replace the file and names it in the usage error
      const io = capture();
      expect(await main(["compare", a, b, "--report", name], io)).toBe(i === 0 ? 0 : 2);
      expect([...io.stdout, ...io.stderr].join("\n")).not.toMatch(CONTROL);
      expect([...io.stdout, ...io.stderr].join("\n")).toContain("\\u001b]0;retitled\\u0007");
    }
  });

  it("does not echo an export name's or an error's escape sequences", async () => {
    const io = capture();
    expect(await main(["export", a, join(dir, "\u001b[31mred.json")], io)).toBe(0);
    const missing = capture();
    expect(await main(["analyze", join(dir, "\u001b[2Jmissing.asar")], missing)).toBe(1);
    for (const run of [io, missing]) {
      expect([...run.stdout, ...run.stderr].join("\n")).not.toMatch(CONTROL);
      expect([...run.stdout, ...run.stderr].join("\n")).toContain("\\u001b");
    }
  });
});

const save = (keys: string[]) =>
  `class S { save(k, v) { localStorage.setItem(k, v); } run() { ${keys.map((k) => `this.save(${JSON.stringify(k)}, 1);`).join(" ")} } }\nnew S().run();\n`;

describe("target text cannot forge lines or hide characters", () => {
  const dir = mkdtempSync(join(tmpdir(), "hexvero-lines-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const a = join(dir, "a.js");
  const b = join(dir, "b.js");
  const forged = "new​key\u009b31m\r\nFORGED::write · literal\tx‮";
  writeFileSync(a, save(["old"]));
  writeFileSync(b, save(["old", forged]));
  // eslint-disable-next-line no-control-regex
  const hidden = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f؜​-‏‪-‮⁦-⁩﻿]/;

  for (const args of [
    ["compare", a, b, "storage"],
    ["compare", a, b],
    ["collection", b, "storage"],
  ])
    it(`${args[0]} ${args.length > 3 ? args[3] : ""} keeps a key with newlines on its own line`, async () => {
      const io = capture();
      expect(await main(args, io)).toBe(0);
      const lines = [...io.stdout, ...io.stderr].join("\n").split("\n");
      expect(lines.filter((l) => /^\s*FORGED/.test(l))).toEqual([]);
      for (const l of lines) expect(l).not.toMatch(hidden);
      if (args[0] !== "compare" || args[3]) expect(lines.join("\n")).toContain("\\u200b");
    });

  it("escapes bidi and zero-width characters and line breaks at the terminal", () => {
    expect(printable("a​b‮c\nd\te\r")).toBe("a\\u200bb\\u202ec\\u000ad\\u0009e\\u000d");
    // terminalSafe keeps hexvero's own line breaks, not hidden characters
    expect(terminalSafe("a⁦b\nc؜")).toBe("a\\u2066b\nc\\u061c");
  });

  it("aligns table columns by the printed width of escaped cells", () => {
    const rows = table([
      { value: "a\u0007b", kind: "x" },
      { value: "plain", kind: "y" },
    ]);
    const at = rows.map((r) =>
      r.indexOf(r.includes("kind") ? "kind" : r.includes("x") ? "x" : "y"),
    );
    expect(new Set(at.filter((_, i) => i !== 1)).size).toBe(1);
    expect(rows[2]).toContain("a\\u0007b");
  });

  it("cuts a long table cell between escapes, never inside one", () => {
    const [, , row] = table([{ value: `${"x".repeat(55)}\u0007\u0007` }], 60);
    expect(row).toMatch(/x{55}(\\u0007)?…$/);
  });
});
