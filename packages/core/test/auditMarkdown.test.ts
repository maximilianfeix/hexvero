import { describe, expect, it } from "vitest";
import { renderAuditMarkdown, type AuditResult } from "../src/index.js";

const HOSTILE = "<script>alert(1)</script> | [x](javascript:alert(1)) \n# Approved";

describe("audit Markdown", () => {
  it("keeps text from the build in code spans or escaped, and the table at six columns", () => {
    const result: AuditResult = {
      hexvero: "audit",
      version: 1,
      status: "fail",
      unknown: "fail",
      findings: [
        {
          rule: "open-external",
          fingerprint: "f".repeat(32),
          unknown: false,
          key: `shell.openExternal(${HOSTILE})`,
          message: `opens ${HOSTILE}`,
          collection: "openExternal",
          where: [{ file: `${HOSTILE}.js`, line: 3 }],
          level: "fail",
          state: "suppressed",
          suppression: { reason: HOSTILE, expires: "2030-01-01" },
        },
      ],
      incomplete: [{ rule: "csp-missing", collection: "csp", gaps: ["scan_partial"] }],
      target: { path: `/x/${HOSTILE}.asar`, size: 1, sha256: "a".repeat(64), format: "asar" },
    } as AuditResult;
    const md = renderAuditMarkdown(result);
    expect(md).not.toMatch(/^# Approved/m);
    const prose = md.replace(/`` .*? ``/g, "").replace(/`[^`\n]*`/g, "");
    expect(prose).not.toContain("<script>");
    expect(prose).not.toMatch(/(?<!\\)\[x\]\(/);
    for (const line of md.split("\n").filter((l) => l.startsWith("| ·")))
      expect(line.replace(/\\\|/g, "").split("|").length).toBe(8);
    expect(md).toContain("## Not decidable");
    expect(md).toContain("- csp-missing on csp: scan_partial");
    expect(md).toContain("(until 2030-01-01)");
  });
});
