import { describe, expect, it } from "vitest";
import { electronOutdatedDrafts } from "../src/audit.js";

const runtime = (version: string, support: string, detail = "by the snapshot") => [
  { item: "electron", value: version, evidence: "Contents/Frameworks/Electron Framework@0x1" },
  {
    item: "support",
    value: support,
    detail,
    evidence: "Contents/Frameworks/Electron Framework@0x1",
  },
];

describe("electron-outdated", () => {
  it("fails a packaged runtime past its end of support, at the binary it was read from", () => {
    const [d] = electronOutdatedDrafts(runtime("42.0.1", "past end of support", "eol 2026-10-20"));
    expect(d).toMatchObject({
      rule: "electron-outdated",
      unknown: false,
      key: "Electron 42.0.1",
      collection: "runtime",
      where: [{ file: "Contents/Frameworks/Electron Framework" }],
    });
    expect(d!.message).toContain("eol 2026-10-20");
    expect(d!.message).toContain("section 16");
    // the fingerprint names the major line, not the patch: 42.0.2 is the same finding
    const [e] = electronOutdatedDrafts(runtime("42.0.2", "past end of support"));
    expect(e!.identity).toBe(d!.identity);
  });

  it("is unknown when support cannot be told, and silent when supported or a prerelease", () => {
    expect(electronOutdatedDrafts(runtime("99.0.0", "unknown"))[0]?.unknown).toBe(true);
    expect(electronOutdatedDrafts(runtime("44.9.1", "supported"))).toEqual([]);
    expect(electronOutdatedDrafts(runtime("45.0.0-beta.1", "prerelease"))).toEqual([]);
  });

  it("judges nothing without a packaged runtime (an .asar or app directory alone)", () => {
    expect(electronOutdatedDrafts(null)).toEqual([]);
    expect(electronOutdatedDrafts([{ item: "electron", value: "33.0.0" }])).toEqual([]);
  });
});
