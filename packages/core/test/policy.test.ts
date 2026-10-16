import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { describe, expect, it } from "vitest";
import {
  checkRelease,
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
  type LoadedPolicy,
  type ReleaseComparison,
} from "../src/index.js";
import type { CollectionComparison, WindowChange } from "../src/session.js";

const root = join(import.meta.dirname, "..", "..", "..");
const addFormats = addFormatsModule as unknown as (ajv: Ajv | Ajv2020) => void;

const KEYS: Record<string, string> = {
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
    ...(parts.completeness ? { completeness: parts.completeness } : {}),
  } as ReleaseComparison;
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
        limitations: {
          a: [],
          b: [{ code: "context_bridge_members_unreadable", message: "members not readable" }],
        },
      });
      const r = evaluatePolicy(c, policy());
      expect(r.status).toBe("incomplete");
      expect(r.incomplete).toEqual([
        { rule: "new-interface-member", collection: "contextBridge", gaps: ["values_unresolved"] },
        { rule: "new-external-host", collection: "endpoints", gaps: ["budget"] },
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
          limitations: { a: [], b: [{ code: "ipc_channel_unresolved", message: "1 IPC call" }] },
        }),
        policy(),
      );
      expect(r.incomplete).toEqual([]);
      expect(r.status).toBe("pass");
    });
    it("a partly read app leaves every rule undecidable", () => {
      const r = evaluatePolicy(comparison({ partialScan: { a: false, b: true } }), policy());
      expect(r.status).toBe("incomplete");
      expect(r.incomplete.map((i) => i.collection)).toEqual([
        "contextBridge",
        "endpoints",
        "urls",
        "windows",
      ]);
    });
    it("uses the comparison's own completeness once it carries one (contract C1/C3)", () => {
      const c = comparison({
        partialScan: { a: true, b: true },
        completeness: { endpoints: { complete: false, gaps: ["budget"] } },
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
    expect(uri.startsWith("dir/")).toBe(true);
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
    expect(noLine.locations[0].physicalLocation.artifactLocation.uri).toBe("%2E%2E/outside.js");
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
