import { afterEach, describe, expect, it, vi } from "vitest";
import { api, HttpError, issuesOf, type PolicyFinding, type PolicyResult } from "./api.js";
import { findingSign, findingWords, incompleteWords, STATUS, tallyWords } from "./check.js";

const finding = (patch: Partial<PolicyFinding>): PolicyFinding => ({
  rule: "new-external-host",
  fingerprint: "f".repeat(32),
  level: "fail",
  state: "new",
  row: "r",
  collection: "endpoints",
  key: "h.example",
  message: "m",
  where: [],
  unknown: false,
  ...patch,
});

describe("release gate words", () => {
  it("gives every status a word and a sign", () => {
    for (const s of Object.values(STATUS)) {
      expect(s.word).toMatch(/^[A-Z]/);
      expect(s.sign).not.toBe("");
    }
    expect(new Set(Object.values(STATUS).map((s) => s.sign)).size).toBe(4);
  });

  it("tells counted, quiet and unknown findings apart", () => {
    expect(findingSign(finding({}))).toBe("✗");
    expect(findingSign(finding({ level: "warn" }))).toBe("!");
    expect(findingSign(finding({ state: "baselined" }))).toBe("·");
    expect(findingSign(finding({ state: "suppression-expired" }))).toBe("✗");
    expect(findingSign(finding({ unknown: true }))).toBe("?");
    expect(findingWords(finding({ unknown: true, state: "suppression-expired" }))).toBe(
      "suppression expired · fail · unknown",
    );
  });

  it("tallies what the status rests on", () => {
    const r = {
      findings: [
        finding({}),
        finding({}),
        finding({ level: "warn" }),
        finding({ state: "suppressed" }),
      ],
      incomplete: [{ rule: "x", collection: "y", gaps: [] }],
    } as unknown as PolicyResult;
    expect(tallyWords(r)).toBe(
      "2 findings at level fail, 1 warning, 1 baselined or suppressed, 1 rule not decided",
    );
    expect(
      incompleteWords({
        rule: "new-external-host",
        collection: "endpoints",
        gaps: ["collection_missing"],
      }),
    ).toBe(
      "new-external-host could not be decided on endpoints: the list is missing from a build, so nothing in it could be compared.",
    );
  });
});

describe("check client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("posts the policy text as the body, with the pair in the query", async () => {
    const fetch = vi.fn(async () => Response.json({ hexvero: "check", status: "pass" }));
    vi.stubGlobal("fetch", fetch);
    const result = await api.check("t_1", "t_2", '{"hexvero":"policy"}');
    expect(result.status).toBe("pass");
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/check?a=t_1&b=t_2");
    expect(init.method).toBe("POST");
    expect(init.body).toBe('{"hexvero":"policy"}');
    expect((init.headers as Record<string, string>)["authorization"]).toMatch(/^Bearer /);
  });

  it("carries the issue list of an invalid policy", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            error: {
              code: "invalid_policy",
              message: "invalid policy policy.json",
              details: { issues: ["version: …", 3] },
            },
          },
          { status: 400 },
        ),
      ),
    );
    const error = await api.check("t_1", "t_2", "{}").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ status: 400, code: "invalid_policy", issues: ["version: …"] });
    expect(issuesOf({ code: "x", message: "y" })).toEqual([]);
  });
});
