import { describe, expect, it } from "vitest";
import { analyzeInWorker } from "../src/analyzers/worker.js";
import { Session } from "../src/session.js";
import { targetFromBytes } from "../src/target.js";
import { buildElf } from "./fixtures/elf.js";

describe("analyzeInWorker", () => {
  it("returns the same analysis as the in-process path", async () => {
    const target = targetFromBytes(buildElf(), "lib.so");
    const analysis = await analyzeInWorker(target);
    expect(analysis.data.kind).toBe("binary");
    expect(analysis.summary).toContain("ELF64");
    expect(analysis.findings.length).toBeGreaterThan(0);
  });
  it("rejects when the caller has already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      analyzeInWorker(targetFromBytes(buildElf(), "lib.so"), { signal: controller.signal }),
    ).rejects.toThrow(/cancelled/);
  });
  it("stops on timeout with a structured error", async () => {
    await expect(
      analyzeInWorker(targetFromBytes(buildElf(), "lib.so"), { timeoutMs: 1 }),
    ).rejects.toMatchObject({ code: "too_large" });
  });
  it("is used by worker-enabled sessions and shares in-flight analyses", async () => {
    const session = new Session({ worker: true });
    const record = session.register(targetFromBytes(buildElf(), "lib.so"));
    const [a, b] = await Promise.all([session.analyze(record.id), session.analyze(record.id)]);
    expect(a).toBe(b);
    expect(session.get(record.id).analyzed).toBe(true);
  });
});
