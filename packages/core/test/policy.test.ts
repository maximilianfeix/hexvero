import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  AnalysisError,
  checkRelease,
  comparisonForCheck,
  createBaseline,
  evaluatePolicy,
  fingerprintOf,
  hostAllowed,
  hostOf,
  parseBaseline,
  parsePolicy,
  PolicyError,
  renderPolicyMarkdown,
  Session,
  toSarif,
  type ChangeRow,
  type CheckSides,
  type LoadedPolicy,
  type ReleaseComparison,
} from "../src/index.js";
import type { CollectionComparison, WindowChange } from "../src/session.js";
import { buildAsar } from "./fixtures/asar.js";

const root = join(import.meta.dirname, "..", "..", "..");
const addFormats = addFormatsModule as unknown as (ajv: Ajv | Ajv2020) => void;

const KEYS: Record<string, string> = {
  bridgeExposures: "file+api+member+exposed",
  interfaces: "file+api+member",
  contextBridge: "api+member",
  endpoints: "file+kind+value",
  urls: "file+value",
  windows: "file+windowName",
};

const target = (name: string, sha: string) => ({
  id: name,
  openedAt: "2026-10-17T00:00:00.000Z",
  analyzed: true,
  info: { path: `/builds/${name}`, size: 10, sha256: sha.repeat(64), format: "asar" as const },
});

function comparison(
  parts: {
    changes?: ChangeRow[];
    windowChanges?: WindowChange[];
    limitations?: ReleaseComparison["limitations"];
    /** Coverage gaps per collection, as the comparison reports them (C1). */
    gaps?: Record<string, string[]>;
    partial?: string[];
    partialScan?: { a: boolean; b: boolean };
    completeness?: Record<string, { complete: boolean; gaps: string[] }>;
  } = {},
): ReleaseComparison {
  const collections: CollectionComparison[] = Object.entries(KEYS).map(([collection, key]) => ({
    collection,
    key,
    added: 0,
    removed: 0,
    changed: 0,
    relocated: 0,
    unknown: 0,
    unchanged: 1,
    totals: { a: 1, b: 1 },
    partial: (parts.partial ?? []).includes(collection),
  }));
  return {
    hexvero: "0.8.0",
    a: target("app-1.asar", "a"),
    b: target("app-2.asar", "b"),
    overview: {
      collections,
      onlyA: [],
      onlyB: [],
      partialScan: parts.partialScan ?? { a: false, b: false },
      windowChanges: parts.windowChanges ?? [],
    },
    changes: parts.changes ?? [],
    cut: [],
    limitations: parts.limitations ?? { a: [], b: [] },
    completeness: parts.completeness ?? completenessFrom(parts),
    page: { offset: 0, limit: 5000, total: (parts.changes ?? []).length, next: null },
  } as ReleaseComparison;
}

/** The completeness B's comparison reports, built from the parts a test names. */
function completenessFrom(parts: {
  gaps?: Record<string, string[]>;
  partial?: string[];
  partialScan?: { a: boolean; b: boolean };
}): ReleaseComparison["completeness"] {
  const out: ReleaseComparison["completeness"] = {};
  for (const collection of Object.keys(KEYS)) {
    const gaps = new Set(parts.gaps?.[collection] ?? []);
    if ((parts.partial ?? []).includes(collection)) gaps.add("budget");
    if (parts.partialScan?.a || parts.partialScan?.b) gaps.add("scan_partial");
    out[collection] = {
      compared: { a: 1, b: 1 },
      total: { a: 1, b: 1 },
      complete: gaps.size === 0,
      gaps: [...gaps].toSorted(),
    };
  }
  return out;
}

const member = (name: string, line: number, change: ChangeRow["change"] = "added"): ChangeRow => ({
  collection: "interfaces",
  change,
  key: `preload.js::api::${name}`,
  where: [
    { side: change === "removed" ? "a" : "b", file: "preload.js", line },
    { side: change === "removed" ? "a" : "b", file: "main.js", line: line + 20, role: "handler" },
  ],
  basis: "link direct",
});
const endpoint = (url: string, line: number, file = "main.js"): ChangeRow => ({
  collection: "endpoints",
  change: "added",
  key: `${file}::fetch::${url}`,
  where: [{ side: "b", file, line }],
  basis: "literal",
});

const policyText = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    hexvero: "policy",
    version: 1,
    rules: {
      "new-interface-member": { level: "fail" },
      "new-external-host": { level: "fail", allow: ["api.example.com", "*.cdn.example.com"] },
      "window-more-permissive": { level: "fail" },
    },
    unknown: "fail",
    suppressions: [],
    ...over,
  });
const policy = (over: Record<string, unknown> = {}): LoadedPolicy =>
  parsePolicy(policyText(over), "policy.json");

describe("policy files", () => {
  const schema = JSON.parse(readFileSync(join(root, "docs", "policy.schema.json"), "utf8"));
  const ajv = new Ajv2020({ allErrors: true, strict: true, allowMatchingProperties: true });
  addFormats(ajv);
  const validate = ajv.compile(schema);

  it("reads the example policy, which the schema accepts", () => {
    const text = readFileSync(join(root, "examples", "policy.json"), "utf8");
    expect(validate(JSON.parse(text))).toBe(true);
    const loaded = parsePolicy(text, "examples/policy.json");
    expect(loaded.policy.rules["new-external-host"].allow).toContain("api.notesdesk.example");
    expect(loaded.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("runs rules that are not listed at level fail and defaults unknown to fail", () => {
    const p = parsePolicy('{"hexvero":"policy","version":1,"rules":{}}', "p.json").policy;
    expect(p.rules["window-more-permissive"].level).toBe("fail");
    expect(p.unknown).toBe("fail");
  });

  // Each invalid policy: the precise message, and the schema agrees it is invalid.
  const invalid: Array<[string, unknown, string]> = [
    ["not an object", [], "the file must be an object"],
    [
      "wrong kind",
      { hexvero: "baseline", version: 1, rules: {} },
      'hexvero: must be "policy", got "baseline"',
    ],
    [
      "future version",
      { hexvero: "policy", version: 2, rules: {} },
      "version: this hexvero reads policy version 1, got 2",
    ],
    ["no rules", { hexvero: "policy", version: 1 }, "rules: missing"],
    [
      "misspelt rule",
      { hexvero: "policy", version: 1, rules: { "new-host": { level: "fail" } } },
      "rules.new-host: unknown rule",
    ],
    [
      "bad level",
      { hexvero: "policy", version: 1, rules: { "new-external-host": { level: "error" } } },
      'rules.new-external-host.level: must be "fail", "warn" or "off", got "error"',
    ],
    [
      "allow on another rule",
      {
        hexvero: "policy",
        version: 1,
        rules: { "new-interface-member": { level: "fail", allow: [] } },
      },
      "rules.new-interface-member.allow: unknown key",
    ],
    [
      "regex in allow",
      {
        hexvero: "policy",
        version: 1,
        rules: { "new-external-host": { level: "fail", allow: ["api.example.com", ".*\\.evil"] } },
      },
      'rules.new-external-host.allow[1]: ".*\\\\.evil" is not a host name',
    ],
    [
      "URL in allow",
      {
        hexvero: "policy",
        version: 1,
        rules: { "new-external-host": { level: "fail", allow: ["https://api.example.com"] } },
      },
      "allow[0]",
    ],
    [
      "wildcard on a TLD",
      {
        hexvero: "policy",
        version: 1,
        rules: { "new-external-host": { level: "fail", allow: ["*.com"] } },
      },
      "allow[0]",
    ],
    [
      "inner wildcard",
      {
        hexvero: "policy",
        version: 1,
        rules: { "new-external-host": { level: "fail", allow: ["api.*.com"] } },
      },
      "allow[0]",
    ],
    [
      "upper case host",
      {
        hexvero: "policy",
        version: 1,
        rules: { "new-external-host": { level: "fail", allow: ["API.example.com"] } },
      },
      "allow[0]",
    ],
    [
      "bad unknown",
      { hexvero: "policy", version: 1, rules: {}, unknown: "ignore" },
      'unknown: must be "fail", "warn" or "allow", got "ignore"',
    ],
    [
      "extra key",
      { hexvero: "policy", version: 1, rules: {}, script: "rm -rf /" },
      "script: unknown key",
    ],
    [
      "suppression without reason",
      {
        hexvero: "policy",
        version: 1,
        rules: {},
        suppressions: [{ rule: "new-external-host", fingerprint: "0".repeat(32), reason: "  " }],
      },
      "suppressions[0].reason: must say why",
    ],
    [
      "short fingerprint",
      {
        hexvero: "policy",
        version: 1,
        rules: {},
        suppressions: [{ rule: "new-external-host", fingerprint: "abc", reason: "ok" }],
      },
      "suppressions[0].fingerprint: must be 32 lower-case hex characters",
    ],
    [
      "impossible date",
      {
        hexvero: "policy",
        version: 1,
        rules: {},
        suppressions: [
          {
            rule: "new-external-host",
            fingerprint: "0".repeat(32),
            reason: "ok",
            expires: "2026-02-30",
          },
        ],
      },
      'suppressions[0].expires: must be a date YYYY-MM-DD, got "2026-02-30"',
    ],
    [
      "unknown suppression rule",
      {
        hexvero: "policy",
        version: 1,
        rules: {},
        suppressions: [{ rule: "all", fingerprint: "0".repeat(32), reason: "ok" }],
      },
      "suppressions[0].rule: must be one of",
    ],
  ];
  for (const [name, doc, message] of invalid)
    it(`refuses a policy: ${name}`, () => {
      expect(validate(doc)).toBe(false);
      let error: unknown;
      try {
        parsePolicy(JSON.stringify(doc), "p.json");
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(PolicyError);
      expect((error as PolicyError).issues.join("\n")).toContain(message);
      expect((error as PolicyError).message).toContain("invalid policy p.json");
    });

  it("reports every problem at once and refuses text that is not JSON", () => {
    expect(() => parsePolicy("{ rules: 1 }", "p.json")).toThrow(/p\.json is not valid JSON/);
    try {
      parsePolicy(JSON.stringify({ hexvero: "x", version: 3, rules: [] }), "p.json");
    } catch (e) {
      expect((e as PolicyError).issues).toHaveLength(3);
    }
  });

  it("accepts the valid policies the schema accepts", () => {
    const valid = [
      JSON.parse(policyText()),
      {
        hexvero: "policy",
        version: 1,
        rules: {
          "new-external-host": {
            level: "off",
            allow: ["[::1]", "10.0.0.1", "xn--bcher-kva.example"],
          },
        },
      },
      {
        hexvero: "policy",
        version: 1,
        rules: {},
        unknown: "allow",
        suppressions: [
          {
            rule: "window-more-permissive",
            fingerprint: "f".repeat(32),
            reason: "known",
            expires: "2026-12-31",
          },
        ],
      },
    ];
    for (const doc of valid) {
      expect(validate(doc)).toBe(true);
      expect(() => parsePolicy(JSON.stringify(doc), "p.json")).not.toThrow();
    }
  });
});

describe("hosts", () => {
  it("reads hosts the way a WHATWG URL parser does, without the two slashes", () => {
    // fetch("http:evil.com") requests evil.com; a check that wanted "//" would wave it through
    for (const v of [
      "http:evil.com/x",
      "https:/evil.com",
      "https:\\\\evil.com\\path",
      "https:///evil.com",
      "ws:evil.com",
    ]) {
      expect(hostOf(v), v).toEqual({ kind: "host", host: new URL(v).hostname });
      expect(new URL(v).hostname, v).toBe("evil.com");
    }
    expect(hostOf("http:${host}/x")).toMatchObject({ kind: "unknown" });
    expect(hostOf("mailto:a@evil.com")).toEqual({ kind: "none" });
    expect(hostOf("C:\\Users\\app")).toEqual({ kind: "none" });
  });
  it("reads the host of a request target, and refuses to guess a computed one", () => {
    expect(hostOf("https://Updates.Example.com:8443/latest.json")).toEqual({
      kind: "host",
      host: "updates.example.com",
    });
    expect(hostOf("wss://user:pw@live.example.com/socket")).toEqual({
      kind: "host",
      host: "live.example.com",
    });
    expect(hostOf("//cdn.example.com/lib.js")).toEqual({ kind: "host", host: "cdn.example.com" });
    expect(hostOf("https://bücher.example/")).toEqual({
      kind: "host",
      host: "xn--bcher-kva.example",
    });
    for (const local of [
      "/api/notes",
      "./x",
      "file:///etc/hosts",
      "data:text/plain,x",
      "app://index.html",
      "http://localhost:3000",
      "http://127.0.0.1/",
      "http://[::1]:8080/",
      "mailto:a@b.c",
    ])
      expect(hostOf(local).kind, local).toBe("none");
    expect(hostOf("https://${region}.api.example.com/v1")).toMatchObject({ kind: "unknown" });
    expect(hostOf("${BASE_URL}/v1/notes")).toMatchObject({ kind: "unknown" });
    // a WHATWG parser skips any number of slashes: fetch("https:///nohost") goes to "nohost"
    expect(hostOf("https:///nohost")).toEqual({ kind: "host", host: "nohost" });
    expect(hostOf("https://")).toMatchObject({ kind: "unknown" });
  });

  it("matches allow entries exactly or as *.domain, never by substring", () => {
    const allow = ["api.example.com", "*.cdn.example.com"];
    expect(hostAllowed("api.example.com", allow)).toBe(true);
    expect(hostAllowed("eu.cdn.example.com", allow)).toBe(true);
    expect(hostAllowed("a.b.cdn.example.com", allow)).toBe(true);
    expect(hostAllowed("cdn.example.com", allow)).toBe(false);
    expect(hostAllowed("evilcdn.example.com", allow)).toBe(false);
    expect(hostAllowed("api.example.com.evil.net", allow)).toBe(false);
    expect(hostAllowed("x.api.example.com", allow)).toBe(false);
  });
});

describe("evaluating a policy", () => {
  it("fails on a new interface member and a new host outside the allow list", () => {
    const r = evaluatePolicy(
      comparison({
        changes: [
          member("checkUpdate", 9),
          endpoint("https://updates.example.net/latest.json", 30),
          endpoint("https://api.example.com/v2", 31),
          endpoint("https://eu.cdn.example.com/a.js", 32),
          endpoint("/relative/path", 33),
        ],
      }),
      policy(),
    );
    expect(r.status).toBe("fail");
    expect(r.findings.map((f) => [f.rule, f.key, f.state, f.level, f.unknown])).toEqual([
      ["new-interface-member", "api.checkUpdate", "new", "fail", false],
      ["new-external-host", "updates.example.net", "new", "fail", false],
    ]);
    expect(r.findings[0]!.fingerprint).toBe(
      fingerprintOf("new-interface-member", "member\0api\0checkUpdate"),
    );
    expect(r.findings[0]!.row).toMatch(/^[0-9a-f]{16}$/);
    expect(r.findings[0]!.basis).toBe("link direct");
  });

  it("passes with nothing new, and a warn-level rule never changes the status", () => {
    expect(evaluatePolicy(comparison(), policy()).status).toBe("pass");
    const warned = evaluatePolicy(
      comparison({ changes: [member("x", 1)] }),
      policy({ rules: { "new-interface-member": { level: "warn" } } }),
    );
    expect(warned.status).toBe("pass");
    expect(warned.findings[0]).toMatchObject({ level: "warn", state: "new" });
    const off = evaluatePolicy(
      comparison({ changes: [member("x", 1)] }),
      policy({ rules: { "new-interface-member": { level: "off" } } }),
    );
    expect(off.findings).toEqual([]);
  });

  it("keeps fingerprints when lines shift and rows reorder: the baseline still matches", () => {
    const first = comparison({
      changes: [member("checkUpdate", 9), endpoint("https://updates.example.net/a", 30)],
      windowChanges: [
        {
          window: "main.js::win",
          setting: "sandboxInEffect",
          before: "on",
          after: "off",
          direction: "more permissive",
        },
      ],
    });
    const moved = comparison({
      changes: [endpoint("https://updates.example.net/a", 130), member("checkUpdate", 109)],
      windowChanges: [
        {
          window: "main.js::win",
          setting: "sandboxInEffect",
          before: "on",
          after: "off",
          direction: "more permissive",
        },
      ],
    });
    const before = evaluatePolicy(first, policy());
    expect(before.status).toBe("fail");
    const baseline = parseBaseline(JSON.stringify(createBaseline(before)), "baseline.json");
    const after = evaluatePolicy(moved, policy(), { baseline });
    expect(after.findings.map((f) => f.fingerprint)).toEqual(
      before.findings.map((f) => f.fingerprint),
    );
    expect(after.findings.every((f) => f.state === "baselined")).toBe(true);
    expect(after.status).toBe("pass");
    expect(after.baseline).toMatchObject({ file: "baseline.json", matched: 3 });
    // without the baseline, a normal run never accepts anything by itself
    expect(evaluatePolicy(moved, policy()).status).toBe("fail");
  });

  it("makes duplicates one finding with every place", () => {
    const r = evaluatePolicy(
      comparison({
        changes: [
          endpoint("https://updates.example.net/a", 30),
          endpoint("https://updates.example.net/b", 40, "renderer.js"),
          {
            collection: "urls",
            change: "added",
            key: "main.js::https://updates.example.net/a",
            where: [{ side: "b", file: "main.js", line: 30 }],
          },
          member("checkUpdate", 9),
          {
            ...member("checkUpdate", 9),
            key: "preload2.js::api::checkUpdate",
            where: [{ side: "b", file: "preload2.js", line: 3 }],
          },
        ],
      }),
      policy(),
    );
    expect(r.findings).toHaveLength(2);
    expect(r.findings.find((f) => f.rule === "new-external-host")!.where).toEqual([
      { side: "b", file: "main.js", line: 30 },
      { side: "b", file: "renderer.js", line: 40 },
    ]);
    expect(r.findings.find((f) => f.rule === "new-interface-member")!.where).toHaveLength(3);
  });

  it("treats a rename as removed plus added: the new name is a new finding", () => {
    const r = evaluatePolicy(
      comparison({ changes: [member("openInShell", 9, "removed"), member("checkUpdate", 9)] }),
      policy(),
    );
    expect(r.findings.map((f) => f.key)).toEqual(["api.checkUpdate"]);
  });

  it("does not depend on the preload file a member is exposed from", () => {
    const one = evaluatePolicy(comparison({ changes: [member("x", 1)] }), policy());
    const other = evaluatePolicy(
      comparison({ changes: [{ ...member("x", 1), key: "bridge/preload.js::api::x" }] }),
      policy(),
    );
    expect(other.findings[0]!.fingerprint).toBe(one.findings[0]!.fingerprint);
  });

  it("falls back to contextBridge when there is no interfaces collection", () => {
    const c = comparison({
      changes: [
        {
          collection: "contextBridge",
          change: "added",
          key: "api::x",
          where: [{ side: "b", file: "preload.js", line: 2 }],
        },
      ],
    });
    c.overview.collections = c.overview.collections.filter((x) => x.collection !== "interfaces");
    const r = evaluatePolicy(c, policy());
    expect(r.findings[0]).toMatchObject({ collection: "contextBridge", key: "api.x" });
    expect(r.findings[0]!.fingerprint).toBe(
      fingerprintOf("new-interface-member", "member\0api\0x"),
    );
  });

  it("fails on a more permissive window; an unclear one is unknown", () => {
    const r = evaluatePolicy(
      comparison({
        windowChanges: [
          {
            window: "main.js::win",
            setting: "contextIsolationInEffect",
            before: "on",
            after: "off",
            direction: "more permissive",
          },
          {
            window: "main.js::win",
            setting: "sandboxInEffect",
            before: "on",
            after: "unknown",
            direction: "unclear",
          },
          {
            window: "main.js::win",
            setting: "nodeIntegrationInEffect",
            before: "on",
            after: "off",
            direction: "less permissive",
          },
        ],
        changes: [
          {
            collection: "windows",
            change: "changed",
            key: "main.js::win",
            where: [{ side: "b", file: "main.js", line: 8 }],
          },
        ],
      }),
      policy(),
    );
    expect(r.findings.map((f) => [f.key, f.unknown])).toEqual([
      ["main.js::win contextIsolationInEffect", false],
      ["main.js::win sandboxInEffect", true],
    ]);
    expect(r.findings[0]!.where).toEqual([{ side: "b", file: "main.js", line: 8 }]);
    expect(r.status).toBe("fail");
  });

  describe("unknown handling", () => {
    const templated = comparison({
      changes: [endpoint("https://${region}.api.example.com/v1", 12)],
    });
    it("fail: a computed host makes the check incomplete, not a pass", () => {
      const r = evaluatePolicy(templated, policy());
      expect(r.status).toBe("incomplete");
      expect(r.findings[0]).toMatchObject({
        unknown: true,
        state: "new",
        key: "https://${region}.api.example.com/v1",
      });
    });
    it("warn and allow: the status passes and the unknown stays listed", () => {
      for (const unknown of ["warn", "allow"]) {
        const r = evaluatePolicy(templated, policy({ unknown }));
        expect(r.status).toBe("pass");
        expect(r.findings).toHaveLength(1);
        expect(r.findings[0]!.unknown).toBe(true);
      }
    });
    it("a definite violation wins over an incomplete one", () => {
      const r = evaluatePolicy(
        comparison({ changes: [endpoint("https://${x}/", 1), member("y", 2)] }),
        policy(),
      );
      expect(r.status).toBe("fail");
    });
    it("an unknown row (one side not read) is an unknown finding", () => {
      const r = evaluatePolicy(
        comparison({
          changes: [{ ...member("z", 3, "unknown"), reason: "file not read on the other side" }],
        }),
        policy(),
      );
      expect(r.status).toBe("incomplete");
      expect(r.findings[0]!.message).toContain("may be new: file not read on the other side");
    });
    it("coverage gaps make a rule undecidable: incomplete under fail, listed under warn", () => {
      const c = comparison({
        partial: ["endpoints"],
        gaps: { contextBridge: ["values_unresolved"] },
      });
      const r = evaluatePolicy(c, policy());
      expect(r.status).toBe("incomplete");
      expect(r.incomplete).toEqual([
        { rule: "new-interface-member", collection: "contextBridge", gaps: ["values_unresolved"] },
        { rule: "new-external-host", collection: "endpoints", gaps: ["budget"] },
        // an unreadable bridge value may hide an exposure; the rule is at warn when not listed
        { rule: "new-bridge-exposure", collection: "contextBridge", gaps: ["values_unresolved"] },
      ]);
      expect(evaluatePolicy(c, policy({ unknown: "warn" }))).toMatchObject({
        status: "pass",
        incomplete: r.incomplete,
      });
      // a gap under a rule that is off or at warn decides nothing
      expect(
        evaluatePolicy(
          c,
          policy({
            rules: {
              "new-interface-member": { level: "warn" },
              "new-external-host": { level: "off" },
            },
          }),
        ).status,
      ).toBe("pass");
    });
    it("an unresolved IPC channel does not make the bridge rule undecidable", () => {
      // which members a preload exposes is read from the bridge, not from channel names
      const r = evaluatePolicy(
        comparison({
          gaps: { interfaces: ["values_unresolved"] },
        }),
        policy(),
      );
      expect(r.incomplete).toEqual([]);
      expect(r.status).toBe("pass");
      // any other gap of the interfaces list still decides the rule
      const cut = evaluatePolicy(comparison({ partial: ["interfaces"] }), policy());
      expect(cut.status).toBe("incomplete");
      expect(cut.incomplete).toEqual([
        { rule: "new-interface-member", collection: "interfaces", gaps: ["budget"] },
      ]);
    });
    it("a partly read app leaves every rule undecidable", () => {
      const r = evaluatePolicy(comparison({ partialScan: { a: false, b: true } }), policy());
      expect(r.status).toBe("incomplete");
      expect(r.incomplete.map((i) => i.collection)).toEqual([
        "interfaces",
        "contextBridge",
        "endpoints",
        "urls",
        "windows",
        "bridgeExposures",
        "contextBridge",
      ]);
    });
    it("uses the comparison's own completeness once it carries one (contract C1/C3)", () => {
      const c = comparison({
        completeness: {
          endpoints: {
            compared: { a: 1, b: 1 },
            total: { a: 2, b: 2 },
            complete: false,
            gaps: ["budget"],
          },
        },
      });
      expect(evaluatePolicy(c, policy()).incomplete).toEqual([
        { rule: "new-external-host", collection: "endpoints", gaps: ["budget"] },
      ]);
    });
  });

  describe("suppressions", () => {
    const c = comparison({ changes: [endpoint("https://updates.example.net/a", 30)] });
    const fp = evaluatePolicy(c, policy()).findings[0]!.fingerprint;
    const sup = (expires?: string) => ({
      suppressions: [
        {
          rule: "new-external-host",
          fingerprint: fp,
          reason: "update server, ticket 42",
          ...(expires ? { expires } : {}),
        },
      ],
    });
    it("a suppression sets the finding aside with its reason", () => {
      const r = evaluatePolicy(c, policy(sup("2026-12-31")), {
        now: new Date("2026-12-31T23:00:00Z"),
      });
      expect(r.status).toBe("pass");
      expect(r.findings[0]).toMatchObject({
        state: "suppressed",
        suppression: { reason: "update server, ticket 42", expires: "2026-12-31" },
      });
    });
    it("an expired suppression counts as new again, even over a baseline", () => {
      const now = new Date("2027-01-01T00:00:01Z");
      const r = evaluatePolicy(c, policy(sup("2026-12-31")), { now });
      expect(r.status).toBe("fail");
      expect(r.findings[0]!.state).toBe("suppression-expired");
      const baseline = parseBaseline(
        JSON.stringify(createBaseline(evaluatePolicy(c, policy()))),
        "b.json",
      );
      expect(
        evaluatePolicy(c, policy(sup("2026-12-31")), { now, baseline }).findings[0]!.state,
      ).toBe("suppression-expired");
    });
    it("a suppression for another rule does not apply", () => {
      const r = evaluatePolicy(
        c,
        policy({ suppressions: [{ rule: "new-interface-member", fingerprint: fp, reason: "x" }] }),
      );
      expect(r.findings[0]!.state).toBe("new");
    });
  });

  it("refuses baselines it cannot read", () => {
    expect(() => parseBaseline("[]", "b.json")).toThrow(/invalid baseline b\.json/);
    const future = {
      hexvero: "baseline",
      version: 2,
      created: "x",
      policy: "p",
      a: "a",
      b: "b",
      fingerprints: [],
    };
    expect(() => parseBaseline(JSON.stringify(future), "b.json")).toThrow(
      /reads baseline version 1, got 2/,
    );
    const bad = {
      ...future,
      version: 1,
      fingerprints: [{ rule: "x", fingerprint: "nothex", key: "k" }],
    };
    expect(() => parseBaseline(JSON.stringify(bad), "b.json")).toThrow(/fingerprints\[0\]/);
  });
});

describe("hostile data from the target", () => {
  const evil =
    "x\n# Approved <script>alert(1)</script> [click](https://evil.example) `rm -rf` | cell\u001b[31m";
  const r = evaluatePolicy(
    comparison({
      changes: [
        {
          collection: "interfaces",
          change: "added",
          key: `preload.js::api::${evil}`,
          where: [{ side: "b", file: `dir/${evil}.js`, line: 3 }],
        },
        endpoint(`https://${"${"}a}.example.com/${evil}`, 4),
      ],
    }),
    policy(),
  );

  it("keeps messages to one plain line", () => {
    for (const f of r.findings) {
      for (const c of ["\n", "\r", "\u001b"]) expect(f.message).not.toContain(c);
      expect(f.message.length).toBeLessThan(700);
    }
  });

  it("quotes target text in Markdown so it cannot add headings, HTML or links", () => {
    const md = renderPolicyMarkdown(r);
    expect(md).not.toMatch(/^# Approved/m);
    // outside code spans (where it is text) nothing from the target is live Markdown or HTML
    const prose = md.replace(/`` .*? ``/g, "").replace(/`[^`\n]*`/g, "");
    expect(prose).not.toContain("<script>");
    expect(prose).not.toMatch(/(?<!\\)\[click\]\(/);
    expect(md).not.toContain("\u001b");
    // the table keeps its six columns: a `|` from the target is inside a code span or escaped
    for (const line of md.split("\n").filter((l) => l.startsWith("| ✗") || l.startsWith("| ?")))
      expect(line.replace(/\\\|/g, "").split("|").length).toBe(8);
  });

  it("writes SARIF whose texts are single lines and whose URIs are encoded", () => {
    const log = toSarif(r, { version: "0.8.0", unknown: "fail" }) as {
      runs: Array<{ results: Array<Record<string, any>> }>;
    };
    const text = JSON.stringify(log);
    expect(text).not.toContain("\\n# Approved");
    const uri = log.runs[0]!.results[0]!["locations"][0].physicalLocation.artifactLocation
      .uri as string;
    expect(uri).not.toMatch(/[\s<>`|]/);
    expect(uri.startsWith("hexvero-build/after/app-2.asar/dir/")).toBe(true);
  });
});

const fp = (log: any, key: string) =>
  log.runs[0].results.find((x: any) => x.properties.key === key).partialFingerprints;

describe("SARIF", () => {
  const schema = JSON.parse(
    readFileSync(join(import.meta.dirname, "fixtures", "sarif-schema-2.1.0.json"), "utf8"),
  );
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  const result = evaluatePolicy(
    comparison({
      changes: [
        member("checkUpdate", 9),
        endpoint("https://updates.example.net/a", 30),
        endpoint("https://${r}.example.net/a", 31),
        { collection: "interfaces", change: "added", key: "preload.js::api::noPlace", where: [] },
        {
          collection: "interfaces",
          change: "added",
          key: "preload.js::api::noLine",
          where: [{ side: "b", file: "../outside.js" }],
        },
      ],
    }),
    policy(),
  );

  it("validates against the SARIF 2.1.0 schema", () => {
    const log = toSarif(result, { version: "0.8.0", unknown: "fail" });
    const ok = validate(log);
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });

  it("names the analyzed build as the base of every location, never the repository", () => {
    const log = toSarif(result, { version: "0.8.0", unknown: "warn" }) as any;
    const run = log.runs[0];
    expect(Object.keys(run.originalUriBaseIds)).toEqual(["HEXVERO_TARGET_A", "HEXVERO_TARGET_B"]);
    expect(run.originalUriBaseIds.HEXVERO_TARGET_B.description.text).toContain(
      "not files of this repository",
    );
    expect(run.properties.hexvero.locations).toContain("not files of the repository");
    const locations = run.results.flatMap((x: any) => x.locations);
    for (const l of locations.filter((loc: any) => loc.physicalLocation))
      expect(l.physicalLocation.artifactLocation.uriBaseId).toBe("HEXVERO_TARGET_B");
    // no invented line: a place without a line has no region; no place has a logical location
    const noLine = run.results.find((x: any) => x.properties.key === "api.noLine");
    expect(noLine.locations[0].physicalLocation.region).toBeUndefined();
    expect(noLine.locations[0].physicalLocation.artifactLocation.uri).toBe(
      "hexvero-build/after/app-2.asar/%2E%2E/outside.js",
    );
    const noPlace = run.results.find((x: any) => x.properties.key === "api.noPlace");
    expect(noPlace.locations[0].logicalLocations[0].name).toBe("api.noPlace");
    // the unknown host is a warning when unknown is "warn"
    expect(run.results.find((x: any) => x.properties.unknown).level).toBe("warning");
    expect(run.results.find((x: any) => !x.properties.unknown).level).toBe("error");
  });

  it("uses the semantic fingerprint as partialFingerprints, the same after lines move", () => {
    const a = toSarif(result, { version: "0.8.0", unknown: "fail" }) as any;
    const moved = evaluatePolicy(comparison({ changes: [member("checkUpdate", 99)] }), policy());
    const b = toSarif(moved, { version: "0.8.0", unknown: "fail" }) as any;
    expect(fp(a, "api.checkUpdate")).toEqual(fp(b, "api.checkUpdate"));
    expect(fp(a, "api.checkUpdate")["hexveroFingerprint/v1"]).toMatch(/^[0-9a-f]{32}$/);
  });

  it("leaves baselined and suppressed findings out of the results and counts them", () => {
    const baseline = parseBaseline(JSON.stringify(createBaseline(result)), "b.json");
    const accepted = evaluatePolicy(comparison({ changes: [member("checkUpdate", 9)] }), policy(), {
      baseline,
    });
    const log = toSarif(accepted, { version: "0.8.0", unknown: "fail" }) as any;
    expect(log.runs[0].results).toEqual([]);
    expect(log.runs[0].properties.hexvero.notReported).toEqual({ baselined: 1, suppressed: 0 });
    expect(validate(log)).toBe(true);
  });
});

describe("the example builds", () => {
  it("1.4.0 → 1.5.0 fails on the update host and the new preload member, and names the unresolved channel", async () => {
    const session = new Session();
    const a = await session.open(join(root, "examples", "notesdesk-1.4.0.asar"));
    const b = await session.open(join(root, "examples", "notesdesk-1.5.0.asar"));
    const loaded = parsePolicy(
      readFileSync(join(root, "examples", "policy.json"), "utf8"),
      "examples/policy.json",
    );
    const r = await checkRelease(session, a.id, b.id, loaded);
    expect(r.status).toBe("fail");
    expect(r.findings.map((f) => [f.rule, f.key, f.state])).toEqual([
      ["new-interface-member", "notesdesk.checkUpdate", "new"],
      ["new-external-host", "updates.notesdesk.example", "new"],
    ]);
    expect(r.findings[1]!.where).toEqual([{ side: "b", file: "main.js", line: 30 }]);
    // the unresolved IPC channel at main.js:33 hides no bridge member, endpoint or window
    expect(r.incomplete).toEqual([]);
    // accepted in a baseline, the same builds pass
    const baseline = parseBaseline(JSON.stringify(createBaseline(r)), "b.json");
    expect((await checkRelease(session, a.id, b.id, loaded, { baseline })).status).toBe("pass");
  });
});

// ---------------------------------------------------------------------------------------------
// Regression tests for the independent review (H3, H4, M4, M5, L2, L6, L7, L9, L11)
// ---------------------------------------------------------------------------------------------

const SAFE = {
  nodeIntegrationInEffect: "off",
  contextIsolationInEffect: "on",
  sandboxInEffect: "on",
  pageRequire: "no",
};
const OPEN = {
  nodeIntegrationInEffect: "on",
  contextIsolationInEffect: "off",
  sandboxInEffect: "off",
  pageRequire: "yes",
};
const win = (name: string, settings: Record<string, string>, line = 2) => ({
  file: "main.js",
  windowName: name,
  window: 1,
  line,
  ...settings,
});
const sides = (
  a: Record<string, unknown[]>,
  b: Record<string, unknown[]>,
  kind: { a: string; b: string } = { a: "javascript-app", b: "javascript-app" },
): CheckSides => ({ kind, items: { a, b } });
const windowRow = (change: ChangeRow["change"], name: string, line = 2): ChangeRow => ({
  collection: "windows",
  change,
  key: `main.js::${name}`,
  where: [{ side: change === "removed" ? "a" : "b", file: "main.js", line }],
});

describe("review H3: windows that are not matched by name", () => {
  it("flags a window renamed while it turned permissive (win → mainWindow)", () => {
    const r = evaluatePolicy(
      comparison({ changes: [windowRow("added", "mainWindow"), windowRow("removed", "win")] }),
      policy(),
      { sides: sides({ windows: [win("win", SAFE)] }, { windows: [win("mainWindow", OPEN)] }) },
    );
    expect(r.status).toBe("fail");
    expect(r.findings.map((f) => [f.key, f.unknown])).toEqual([
      ["main.js::mainWindow contextIsolationInEffect", false],
      ["main.js::mainWindow nodeIntegrationInEffect", false],
      ["main.js::mainWindow pageRequire", false],
      ["main.js::mainWindow sandboxInEffect", false],
    ]);
    expect(r.findings[0]!.where).toEqual([{ side: "b", file: "main.js", line: 2 }]);
  });

  it("flags a brand-new permissive window and ignores a new safe one", () => {
    const r = evaluatePolicy(
      comparison({ changes: [windowRow("added", "extra", 9), windowRow("added", "about", 20)] }),
      policy(),
      {
        sides: sides(
          { windows: [] },
          {
            windows: [
              win("extra", { ...SAFE, sandboxInEffect: "default off" }, 9),
              win("about", SAFE, 20),
            ],
          },
        ),
      },
    );
    expect(r.findings.map((f) => [f.key, f.unknown, f.where[0]!.line])).toEqual([
      ["main.js::extra sandboxInEffect", false, 9],
    ]);
    expect(r.status).toBe("fail");
  });

  it("judges every window of the same file and name, so a safe one cannot hide a permissive one", () => {
    // two `win` variables in two functions of main.js; the safe one is listed first
    const r = evaluatePolicy(comparison({ changes: [windowRow("added", "win", 9)] }), policy(), {
      sides: sides(
        { windows: [] },
        { windows: [win("win", SAFE, 9), win("win", { ...SAFE, sandboxInEffect: "off" }, 40)] },
      ),
    });
    expect(r.findings.map((f) => f.key)).toEqual(["main.js::win sandboxInEffect"]);
    expect(r.status).toBe("fail");
  });

  it("an added window as permissive as a removed one may be a rename: unknown, incomplete", () => {
    const r = evaluatePolicy(
      comparison({ changes: [windowRow("added", "mainWindow"), windowRow("removed", "win")] }),
      policy(),
      { sides: sides({ windows: [win("win", OPEN)] }, { windows: [win("mainWindow", OPEN)] }) },
    );
    expect(r.findings).toHaveLength(4);
    expect(r.findings.every((f) => f.unknown)).toBe(true);
    expect(r.status).toBe("incomplete");
  });

  it("an unknown window row, or an added window whose settings are unknown, is unknown", () => {
    const r = evaluatePolicy(
      comparison({
        changes: [
          { ...windowRow("unknown", "w1"), reason: "file not read on the other side" },
          windowRow("added", "w2"),
        ],
      }),
      policy(),
      {
        sides: sides(
          { windows: [] },
          {
            windows: [win("w1", OPEN), win("w2", { ...SAFE, nodeIntegrationInEffect: "unknown" })],
          },
        ),
      },
    );
    expect(r.findings.length).toBeGreaterThan(0);
    expect(r.findings.every((f) => f.unknown)).toBe(true);
    expect(r.findings.map((f) => f.key)).toContain("main.js::w2 nodeIntegrationInEffect");
    expect(r.status).toBe("incomplete");
  });

  it("an added window whose item cannot be found is unknown, never a pass", () => {
    const r = evaluatePolicy(comparison({ changes: [windowRow("added", "ghost")] }), policy(), {
      sides: sides({ windows: [] }, { windows: [] }),
    });
    expect(r.findings.map((f) => [f.key, f.unknown])).toEqual([["main.js::ghost", true]]);
    expect(r.status).toBe("incomplete");
  });
});

describe("review H4: a target of another kind never passes", () => {
  it("marks every rule collection_missing when the analyses differ in kind", () => {
    const c = comparison();
    c.b = { ...c.b, info: { ...c.b.info, format: "json" } };
    const r = evaluatePolicy(c, policy());
    expect(r.status).toBe("incomplete");
    expect(r.incomplete.map((i) => [i.collection, i.gaps])).toEqual([
      ["interfaces", ["collection_missing"]],
      ["contextBridge", ["collection_missing"]],
      ["endpoints", ["collection_missing"]],
      ["urls", ["collection_missing"]],
      ["windows", ["collection_missing"]],
      ["bridgeExposures", ["collection_missing"]],
      ["contextBridge", ["collection_missing"]],
    ]);
  });

  it("two bundles: the host rule decides, the bridge and window rules are collection_missing", () => {
    const r = evaluatePolicy(comparison(), policy(), {
      sides: sides({}, {}, { a: "javascript", b: "javascript" }),
    });
    expect(r.incomplete.map((i) => i.collection)).toEqual([
      "interfaces",
      "contextBridge",
      "windows",
      "bridgeExposures",
      "contextBridge",
    ]);
    expect(r.incomplete.every((i) => i.gaps.includes("collection_missing"))).toBe(true);
    expect(r.status).toBe("incomplete");
  });

  it("checkRelease refuses (exit 1) a target that is not a JavaScript application", async () => {
    const session = new Session();
    const a = await session.open(join(root, "examples", "notesdesk-1.4.0.asar"));
    const loaded = parsePolicy(readFileSync(join(root, "examples", "policy.json"), "utf8"), "p");
    for (const other of ["README.md", "policy.json", "notesdesk-1.5.0.bundle.js"]) {
      const b = await session.open(join(root, "examples", other));
      await expect(checkRelease(session, a.id, b.id, loaded), other).rejects.toBeInstanceOf(
        AnalysisError,
      );
    }
  });
});

describe("review M4: what already existed in the before build is not new", () => {
  it("a host the before build already named (renamed chunk, other path) is no finding", () => {
    const r = evaluatePolicy(
      comparison({
        changes: [
          endpoint("https://updates.example.net/v2/latest.json", 3, "chunk-9f8e.js"),
          endpoint("https://new.example.net/", 4, "chunk-9f8e.js"),
        ],
      }),
      policy(),
      {
        sides: sides(
          {
            endpoints: [
              {
                file: "chunk-1a2b.js",
                kind: "fetch",
                value: "https://updates.example.net/v1/latest.json",
              },
            ],
            urls: [],
          },
          { endpoints: [], urls: [] },
        ),
      },
    );
    expect(r.findings.map((f) => f.key)).toEqual(["new.example.net"]);
  });

  it("a member the before build exposed from another preload file is no finding", () => {
    const r = evaluatePolicy(
      comparison({
        changes: [
          { ...member("checkUpdate", 3), key: "bridge/preload.js::api::checkUpdate" },
          member("brandNew", 4),
        ],
      }),
      policy(),
      {
        sides: sides(
          {
            interfaces: [{ file: "preload.js", api: "api", member: "checkUpdate" }],
            contextBridge: [],
          },
          { interfaces: [], contextBridge: [] },
        ),
      },
    );
    expect(r.findings.map((f) => f.key)).toEqual(["api.brandNew"]);
  });

  it("without the item lists, the removed rows of the comparison still count as before", () => {
    const r = evaluatePolicy(
      comparison({
        changes: [
          { ...endpoint("https://updates.example.net/a", 1, "old.js"), change: "removed" },
          endpoint("https://updates.example.net/a", 1, "new.js"),
          { ...member("x", 1), key: "old/preload.js::api::x", change: "removed" },
          { ...member("x", 1), key: "new/preload.js::api::x" },
        ],
      }),
      policy(),
    );
    expect(r.findings).toEqual([]);
  });
});

describe("review L2: hosts are read after WHATWG's control-character stripping", () => {
  it("strips leading and trailing C0 controls and spaces and every tab, LF and CR", () => {
    expect(hostOf("\u0001https://evil.example/x")).toEqual({ kind: "host", host: "evil.example" });
    expect(hostOf("ht\ttps://evil2.example")).toEqual({ kind: "host", host: "evil2.example" });
    expect(hostOf(" https://ev\nil3.example/ \u001f")).toEqual({
      kind: "host",
      host: "evil3.example",
    });
    for (const v of ["\u0001https://evil.example/x", "ht\ttps://evil2.example"])
      expect(hostOf(v)).toEqual({ kind: "host", host: new URL(v).hostname });
  });
});

describe("review L7: a baselined unknown does not cover a later definite finding", () => {
  it("gives unknown findings their own fingerprints", () => {
    const maybe = evaluatePolicy(comparison({ changes: [member("x", 1, "unknown")] }), policy());
    const definite = evaluatePolicy(comparison({ changes: [member("x", 1)] }), policy());
    expect(maybe.findings[0]!.fingerprint).not.toBe(definite.findings[0]!.fingerprint);
    const baseline = parseBaseline(JSON.stringify(createBaseline(maybe)), "b.json");
    const later = evaluatePolicy(comparison({ changes: [member("x", 1)] }), policy(), { baseline });
    expect(later.findings[0]!.state).toBe("new");
    expect(later.status).toBe("fail");
  });
});

describe("review L6: a baseline written for something else says so", () => {
  it("warns when the policy or the before build differs from the baseline's", () => {
    const c = comparison({ changes: [member("x", 1)] });
    const written = createBaseline(evaluatePolicy(c, policy()));
    const same = evaluatePolicy(c, policy(), {
      baseline: parseBaseline(JSON.stringify(written), "b"),
    });
    expect(same.baseline!.warnings).toBeUndefined();
    const other = { ...written, policy: "0".repeat(64), a: "1".repeat(64) };
    const r = evaluatePolicy(c, policy(), { baseline: parseBaseline(JSON.stringify(other), "b") });
    expect(r.baseline!.warnings).toEqual([
      "the baseline was written for another policy (sha256 000000000000…)",
      "the baseline was written against another before build (sha256 111111111111…)",
    ]);
  });
});

describe("review M5: SARIF locations cannot land on files of the repository", () => {
  it("prefixes each path with hexvero-build/<side>/<archive>/ and gives the bases file:/// URIs", () => {
    const r = evaluatePolicy(comparison({ changes: [member("x", 1)] }), policy());
    const log = toSarif(r, { version: "0.8.0", unknown: "fail" }) as any;
    const run = log.runs[0];
    expect(run.results[0].locations[0].physicalLocation.artifactLocation).toEqual({
      uri: "hexvero-build/after/app-2.asar/preload.js",
      uriBaseId: "HEXVERO_TARGET_B",
    });
    expect(run.originalUriBaseIds.HEXVERO_TARGET_B.uri).toBe("file:///");
    expect(run.originalUriBaseIds.HEXVERO_TARGET_A.uri).toBe("file:///");
  });
});

const bigApp = (n: number): string =>
  [
    'const { app, ipcMain } = require("electron");',
    ...Array.from(
      { length: n },
      (_, i) =>
        `fetch("https://h${i}.example.net/x"); localStorage.getItem("k${i}"); ipcMain.handle("c${i}", () => 1);`,
    ),
  ].join("\n");
describe("review L9 and L11: one comparison per check, completeness from the comparison", () => {
  const dir = mkdtempSync(join(tmpdir(), "hexvero-policy-pages-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const write = (name: string, n: number): string => {
    const path = join(dir, name);
    writeFileSync(
      path,
      buildAsar({
        "package.json": JSON.stringify({ name: "big", version: "1.0.0", main: "main.js" }),
        "main.js": bigApp(n),
      }),
    );
    return path;
  };
  it("reads every page of a large comparison but compares the builds only once", async () => {
    const session = new Session();
    const a = await session.open(write("a.asar", 1));
    const b = await session.open(write("b.asar", 2000));
    const spy = vi.spyOn(session, "compareAll");
    const r = await comparisonForCheck(session, a.id, b.id);
    expect(r.changes.length).toBeGreaterThan(5000);
    expect(r.page.next).toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
    const loaded = parsePolicy(policyText(), "p.json");
    const result = await checkRelease(session, a.id, b.id, loaded);
    expect(result.findings.filter((f) => f.rule === "new-external-host")).toHaveLength(1999);
  });
});

const exposure = (
  change: ChangeRow["change"],
  name: string,
  exposed: string,
  file = "preload.js",
  line = 4,
): ChangeRow => ({
  collection: "bridgeExposures",
  change,
  key: `${file}::api::${name}::${exposed}`,
  where: [{ side: change === "removed" ? "a" : "b", file, line }],
});
const exposureItem = (name: string, exposed: string, file = "preload.js", extra = {}) => ({
  file,
  api: "api",
  member: name,
  exposed,
  line: 4,
  ...extra,
});

/** A policy that lists the exposure rule at `level`. */
const listed = (level: string) =>
  policy({
    rules: {
      "new-interface-member": { level: "fail" },
      "new-external-host": { level: "fail", allow: [] },
      "window-more-permissive": { level: "fail" },
      "new-bridge-exposure": { level },
    },
  });

describe("new-bridge-exposure", () => {
  it("fails on a privileged object newly handed to pages, with the place", () => {
    const r = evaluatePolicy(
      comparison({ changes: [exposure("added", "ipc", "ipcRenderer")] }),
      listed("fail"),
      {
        sides: sides(
          { bridgeExposures: [] },
          { bridgeExposures: [exposureItem("ipc", "ipcRenderer")] },
        ),
      },
    );
    expect(r.status).toBe("fail");
    expect(r.findings.map((f) => [f.rule, f.key, f.level, f.unknown])).toEqual([
      ["new-bridge-exposure", "api.ipc", "fail", false],
    ]);
    expect(r.findings[0]!.message).toBe(
      "Pages get ipcRenderer as window.api.ipc, handed over as it is, not wrapped.",
    );
    expect(r.findings[0]!.where).toEqual([{ side: "b", file: "preload.js", line: 4 }]);
  });

  it("warns, not fails, under a policy written before the rule existed", () => {
    const r = evaluatePolicy(comparison({ changes: [exposure("added", "fs", "fs")] }), policy(), {
      sides: sides({ bridgeExposures: [] }, { bridgeExposures: [exposureItem("fs", "fs")] }),
    });
    expect(r.status).toBe("pass");
    expect(r.findings.map((f) => [f.rule, f.level])).toEqual([["new-bridge-exposure", "warn"]]);
  });

  it("does not report an exposure that only moved to another preload file", () => {
    const r = evaluatePolicy(
      comparison({
        changes: [
          exposure("added", "ipc", "ipcRenderer", "preload-2.js"),
          exposure("removed", "ipc", "ipcRenderer"),
        ],
      }),
      listed("fail"),
      {
        sides: sides(
          { bridgeExposures: [exposureItem("ipc", "ipcRenderer")] },
          { bridgeExposures: [exposureItem("ipc", "ipcRenderer", "preload-2.js")] },
        ),
      },
    );
    expect(r.findings).toEqual([]);
    expect(r.status).toBe("pass");
  });

  it("reports an exposure hexvero could not decide as one that may be new", () => {
    const r = evaluatePolicy(
      comparison({ changes: [exposure("added", "r", "ipcRenderer")] }),
      listed("fail"),
      {
        sides: sides(
          { bridgeExposures: [] },
          {
            bridgeExposures: [
              exposureItem("r", "ipcRenderer", "preload.js", { undecided: "budget" }),
            ],
          },
        ),
      },
    );
    expect(r.findings.map((f) => [f.key, f.unknown])).toEqual([["api.r", true]]);
    expect(r.findings[0]!.message).toBe(
      "Pages may get ipcRenderer as window.api.r: not decided (budget).",
    );
    // unknown: fail makes the check undecidable, not a plain fail
    expect(r.status).toBe("incomplete");
  });
});
