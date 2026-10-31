import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ajv } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { afterAll, describe, expect, it } from "vitest";
import {
  AUDIT_RULES,
  auditBuild,
  auditToSarif,
  createAuditBaseline,
  createBaseline,
  parseAuditBaseline,
  parseBaseline,
  parsePolicy,
  PolicyError,
  Session,
  type AuditOptions,
  type AuditResult,
} from "../src/index.js";
import { checkRelease } from "../src/policy.js";
import { buildAsar } from "./fixtures/asar.js";

/**
 * `hexvero audit --policy / --baseline`: the policy's `audit` section (levels, unknown,
 * suppressions) and audit baselines, with check's semantics. Expected states are written from
 * the example builds' findings (`hexvero audit examples/notesdesk-1.5.0.asar` lists
 * open-external, permission-handler-missing, csp-missing and navigation-unlimited).
 */

const addFormats = addFormatsModule as unknown as (ajv: Ajv | Ajv2020) => void;
const root = join(import.meta.dirname, "..", "..", "..");
const v15 = join(root, "examples", "notesdesk-1.5.0.asar");
const v14 = join(root, "examples", "notesdesk-1.4.0.asar");
const dir = mkdtempSync(join(tmpdir(), "hexvero-audit-policy-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const policyOf = (audit: unknown, extra: Record<string, unknown> = {}) =>
  parsePolicy(JSON.stringify({ hexvero: "policy", version: 1, audit, ...extra }), "p.json");

const run = async (path: string, options: AuditOptions = {}): Promise<AuditResult> => {
  const session = new Session();
  const { id } = await session.open(path);
  return auditBuild(session, id, options);
};
const states = (r: AuditResult): string[] => r.findings.map((f) => `${f.rule} ${f.state}`);
const baselineOf = (r: AuditResult) =>
  parseAuditBaseline(JSON.stringify(createAuditBaseline(r)), "audit-baseline.json");
/** A baseline written before `rule` had a finding: every finding of `r` except that rule's. */
const baselineWithout = (r: AuditResult, rule: string) => {
  const file = createAuditBaseline(r);
  file.fingerprints = file.fingerprints.filter((f) => f.rule !== rule);
  return parseAuditBaseline(JSON.stringify(file), "audit-baseline.json");
};

const OPEN = "open-external";

describe("audit with a policy", () => {
  it("without a policy, every finding is new at level fail (as before)", async () => {
    const r = await run(v15);
    expect(r.status).toBe("fail");
    expect(r.findings.every((f) => f.state === "new" && f.level === "fail")).toBe(true);
    expect(r.policy).toBeUndefined();
    expect(r.baseline).toBeUndefined();
    expect(r.findings.some((f) => "baselineState" in f)).toBe(false);
  });

  it("a rule at off gives no finding and no gap; at warn it is listed and does not fail", async () => {
    const off = await run(v15, {
      policy: policyOf({
        rules: {
          "open-external": { level: "off" },
          "permission-handler-missing": { level: "warn" },
          "csp-missing": { level: "warn" },
          "navigation-unlimited": { level: "warn" },
        },
      }),
    });
    expect(off.findings.map((f) => f.rule)).not.toContain(OPEN);
    expect(off.incomplete.map((i) => i.rule)).not.toContain(OPEN);
    expect(off.findings.every((f) => f.level === "warn" && f.state === "new")).toBe(true);
    expect(off.status).toBe("pass");
    expect(off.policy?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("suppresses a finding by fingerprint with its reason; an expired one counts again", async () => {
    const first = await run(v15);
    const open = first.findings.find((f) => f.rule === OPEN)!;
    const others = first.findings
      .filter((f) => f.rule !== OPEN)
      .map((f) => ({ rule: f.rule, fingerprint: f.fingerprint, reason: "tracked in #1" }));
    const suppressions = [
      { rule: OPEN, fingerprint: open.fingerprint, reason: "URL checked", expires: "2026-06-30" },
      ...others,
    ];
    const policy = policyOf({ suppressions });
    const before = await run(v15, { policy, now: new Date("2026-06-30T23:00:00Z") });
    expect(before.status).toBe("pass");
    expect(before.findings.find((f) => f.rule === OPEN)).toMatchObject({
      state: "suppressed",
      suppression: { reason: "URL checked", expires: "2026-06-30" },
    });
    const after = await run(v15, { policy, now: new Date("2026-07-01T00:00:00Z") });
    expect(after.status).toBe("fail");
    expect(after.findings.find((f) => f.rule === OPEN)).toMatchObject({
      state: "suppression-expired",
      suppression: { reason: "URL checked", expires: "2026-06-30" },
    });
    // a suppression for another rule with the same fingerprint suppresses nothing
    const wrong = await run(v15, {
      policy: policyOf({
        suppressions: [{ rule: "csp-weak", fingerprint: open.fingerprint, reason: "x" }],
      }),
    });
    expect(wrong.findings.find((f) => f.rule === OPEN)?.state).toBe("new");
  });

  it("takes unknown from the audit section, else the policy, and --unknown over both", async () => {
    const section = policyOf({ unknown: "warn" }, { unknown: "allow" });
    expect((await run(v15, { policy: section })).unknown).toBe("warn");
    const top = parsePolicy('{"hexvero":"policy","version":1,"rules":{},"unknown":"allow"}', "p");
    expect((await run(v15, { policy: top })).unknown).toBe("allow");
    expect((await run(v15, { policy: section, unknown: "fail" })).unknown).toBe("fail");
  });
});

describe("audit baselines", () => {
  it("accepts every finding there now; the next run passes with each one baselined", async () => {
    const first = await run(v15);
    const written = createAuditBaseline(first, new Date("2026-10-31T00:00:00Z"));
    expect(written).toMatchObject({
      hexvero: "baseline",
      version: 1,
      command: "audit",
      created: "2026-10-31T00:00:00.000Z",
      policy: null,
      build: first.target.sha256,
    });
    expect(written.fingerprints.map((f) => f.rule).toSorted()).toEqual(
      first.findings.map((f) => f.rule).toSorted(),
    );
    const again = await run(v15, { baseline: baselineOf(first) });
    expect(again.status).toBe("pass");
    expect(states(again).every((s) => s.endsWith(" baselined"))).toBe(true);
    expect(again.findings.every((f) => f.baselineState === "unchanged")).toBe(true);
    expect(again.baseline).toMatchObject({ file: "audit-baseline.json", matched: 4 });
    expect(again.baseline?.warnings).toBeUndefined();
  });

  it("fails on a finding the baseline does not have", async () => {
    const r = await run(v15, { baseline: baselineWithout(await run(v15), OPEN) });
    expect(r.status).toBe("fail");
    const open = r.findings.find((f) => f.rule === OPEN)!;
    expect(open).toMatchObject({ state: "new", baselineState: "new" });
    // what both builds have is accepted
    expect(r.findings.filter((f) => f.state === "baselined").length).toBe(3);
    // the older build has the same open-external call: its baseline accepts it
    expect((await run(v15, { baseline: baselineOf(await run(v14)) })).status).toBe("pass");
  });

  it("does not accept a suppressed finding, and an expired suppression wins over the baseline", async () => {
    const first = await run(v15);
    const open = first.findings.find((f) => f.rule === OPEN)!;
    const sup = { rule: OPEN, fingerprint: open.fingerprint, reason: "ok", expires: "2026-01-01" };
    const policy = policyOf({ suppressions: [sup] });
    const live = await run(v15, { policy, now: new Date("2025-12-31T00:00:00Z") });
    expect(createAuditBaseline(live).fingerprints.map((f) => f.rule)).not.toContain(OPEN);
    // a baseline written while it was expired accepts it, but it still counts while named
    const lapsed = await run(v15, { policy, now: new Date("2026-02-01T00:00:00Z") });
    const accepted = baselineOf(lapsed);
    expect(accepted.baseline.fingerprints.map((f) => f.rule)).toContain(OPEN);
    const r = await run(v15, { policy, baseline: accepted, now: new Date("2026-02-01T00:00:00Z") });
    expect(r.findings.find((f) => f.rule === OPEN)).toMatchObject({
      state: "suppression-expired",
      baselineState: "unchanged",
    });
    expect(r.status).toBe("fail");
  });

  it("says when the baseline was written for another policy", async () => {
    const first = await run(v15);
    const policy = policyOf({ rules: { "csp-missing": { level: "warn" } } });
    const r = await run(v15, { policy, baseline: baselineOf(first) });
    expect(r.baseline?.warnings).toEqual(["the baseline was written without a policy"]);
    const other = await run(v15, {
      policy: policyOf({}),
      baseline: baselineOf(await run(v15, { policy })),
    });
    expect(other.baseline?.warnings?.[0]).toContain("the baseline was written for another policy");
  });

  it("never reads a check baseline as an audit baseline, nor the other way", async () => {
    const session = new Session();
    const a = await session.open(v14);
    const b = await session.open(v15);
    const loaded = parsePolicy(readFileSync(join(root, "examples", "policy.json"), "utf8"), "x");
    const check = createBaseline(await checkRelease(session, a.id, b.id, loaded));
    expect(() => parseAuditBaseline(JSON.stringify(check), "b.json")).toThrow(
      /written by hexvero check/,
    );
    const audit = createAuditBaseline(await run(v15));
    expect(() => parseBaseline(JSON.stringify(audit), "b.json")).toThrow(PolicyError);
    try {
      parseBaseline(JSON.stringify(audit), "b.json");
    } catch (e) {
      expect((e as PolicyError).issues.join("\n")).toContain("written by hexvero audit");
    }
  });

  it("refuses a malformed audit baseline with each problem", () => {
    const bad = {
      hexvero: "baseline",
      version: 2,
      command: "audit",
      created: 1,
      policy: 5,
      build: "x",
      fingerprints: [{ rule: "new-external-host", fingerprint: "0".repeat(32), key: "k" }],
    };
    try {
      parseAuditBaseline(JSON.stringify(bad), "b.json");
      expect.unreachable();
    } catch (e) {
      const issues = (e as PolicyError).issues.join("\n");
      expect(issues).toContain("version: this hexvero reads baseline version 1, got 2");
      expect(issues).toContain("created: must be a string");
      expect(issues).toContain("policy: must be a sha256 string or null");
      expect(issues).toContain('fingerprints[0]: must be { "rule" (an audit rule)');
    }
    expect(() => parseAuditBaseline("{", "b.json")).toThrow(/not valid JSON/);
  });

  it("gives an app directory a content digest for the baseline", async () => {
    const app = join(dir, "app");
    const asar = join(dir, "app.asar");
    writeFileSync(
      asar,
      buildAsar({
        "package.json": JSON.stringify({ name: "a", main: "main.js" }),
        "main.js": 'require("electron").shell.openExternal(process.argv[2]);\n',
      }),
    );
    // the same app as a directory: extract the two files
    const { mkdirSync } = await import("node:fs");
    mkdirSync(app, { recursive: true });
    writeFileSync(join(app, "package.json"), JSON.stringify({ name: "a", main: "main.js" }));
    writeFileSync(
      join(app, "main.js"),
      'require("electron").shell.openExternal(process.argv[2]);\n',
    );
    const plain = await run(app);
    expect(plain.target.sha256).toBe("");
    const digested = await run(app, { digest: true });
    expect(digested.target.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(createAuditBaseline(digested).build).toBe(digested.target.sha256);
  });
});

/** A policy with only an audit section of these rules. */
const parse = (rules: Record<string, unknown>) =>
  parsePolicy(JSON.stringify({ hexvero: "policy", version: 1, audit: { rules } }), "p.json").policy;

describe("the policy's audit section", () => {
  const schema = JSON.parse(readFileSync(join(root, "docs", "policy.schema.json"), "utf8"));
  const ajv = new Ajv2020({ allErrors: true, strict: true, allowMatchingProperties: true });
  addFormats(ajv);
  const validate = ajv.compile(schema);

  it("lists every audit rule in the schema", () => {
    const section = schema.properties.audit;
    expect(Object.keys(section.properties.rules.properties)).toEqual([...AUDIT_RULES]);
    expect(section.properties.suppressions.items.properties.rule.enum).toEqual([...AUDIT_RULES]);
  });

  it("runs unlisted audit rules at fail, and needs no check rules", () => {
    const doc = {
      hexvero: "policy",
      version: 1,
      audit: { rules: { "csp-weak": { level: "warn" } } },
    };
    expect(validate(doc)).toBe(true);
    const p = parsePolicy(JSON.stringify(doc), "p.json").policy;
    expect(p.audit?.rules["csp-weak"].level).toBe("warn");
    expect(p.audit?.rules["csp-missing"].level).toBe("fail");
    expect(p.audit?.unknown).toBe("fail");
    // a policy without an audit section still needs rules
    expect(validate({ hexvero: "policy", version: 1 })).toBe(false);
  });

  it("runs audit rules added after 0.12.0 at warn when a section does not list them", () => {
    expect(parse({}).audit?.rules["dangerous-call"].level).toBe("warn");
    expect(parse({}).audit?.rules["navigation-unlimited"].level).toBe("fail");
    expect(
      parse({ "dangerous-call": { level: "fail" } }).audit?.rules["dangerous-call"].level,
    ).toBe("fail");
    const p = parsePolicy(
      JSON.stringify({
        hexvero: "policy",
        version: 1,
        audit: { rules: { "custom-protocol": { level: "fail" } } },
      }),
      "p.json",
    ).policy;
    expect(p.audit?.rules["webview-insecure"].level).toBe("warn");
    expect(p.audit?.rules["custom-protocol"].level).toBe("fail");
    expect(p.audit?.rules["navigation-unlimited"].level).toBe("fail");
    expect(p.audit?.rules["http-resource"].level).toBe("warn");
  });

  it("accepts the valid sections the schema accepts", () => {
    const valid = [
      { hexvero: "policy", version: 1, rules: {}, audit: {} },
      {
        hexvero: "policy",
        version: 1,
        audit: {
          rules: { "open-external": { level: "off" }, "remote-enabled": { level: "warn" } },
          unknown: "allow",
          suppressions: [
            {
              rule: "csp-missing",
              fingerprint: "a".repeat(32),
              reason: "server sets it",
              expires: "2027-01-31",
            },
          ],
        },
      },
    ];
    for (const doc of valid) {
      expect(validate(doc)).toBe(true);
      expect(() => parsePolicy(JSON.stringify(doc), "p.json")).not.toThrow();
    }
  });

  const invalid: Array<[string, unknown, string]> = [
    ["not an object", { hexvero: "policy", version: 1, audit: [] }, "audit: must be an object"],
    [
      "extra key",
      { hexvero: "policy", version: 1, audit: { level: "fail" } },
      "audit.level: unknown key",
    ],
    [
      "check rule in audit.rules",
      { hexvero: "policy", version: 1, audit: { rules: { "csp-weakened": { level: "fail" } } } },
      "audit.rules.csp-weakened: unknown audit rule",
    ],
    [
      "bad level",
      { hexvero: "policy", version: 1, audit: { rules: { "csp-weak": { level: "error" } } } },
      'audit.rules.csp-weak.level: must be "fail", "warn" or "off"',
    ],
    [
      "allow on an audit rule",
      {
        hexvero: "policy",
        version: 1,
        audit: { rules: { "csp-weak": { level: "fail", allow: [] } } },
      },
      "audit.rules.csp-weak.allow: unknown key",
    ],
    [
      "bad unknown",
      { hexvero: "policy", version: 1, audit: { unknown: "ignore" } },
      'audit.unknown: must be "fail", "warn" or "allow"',
    ],
    [
      "check rule in an audit suppression",
      {
        hexvero: "policy",
        version: 1,
        audit: {
          suppressions: [{ rule: "new-open-external", fingerprint: "0".repeat(32), reason: "x" }],
        },
      },
      "audit.suppressions[0].rule: must be one of window-permissive",
    ],
    [
      "audit rule in a check suppression",
      {
        hexvero: "policy",
        version: 1,
        rules: {},
        suppressions: [{ rule: "csp-missing", fingerprint: "0".repeat(32), reason: "x" }],
      },
      "suppressions[0].rule: must be one of new-interface-member",
    ],
    [
      "suppression without reason",
      {
        hexvero: "policy",
        version: 1,
        audit: { suppressions: [{ rule: "csp-missing", fingerprint: "0".repeat(32), reason: "" }] },
      },
      "audit.suppressions[0].reason: must say why",
    ],
    [
      "impossible expiry",
      {
        hexvero: "policy",
        version: 1,
        audit: {
          suppressions: [
            {
              rule: "csp-missing",
              fingerprint: "0".repeat(32),
              reason: "x",
              expires: "2026-13-01",
            },
          ],
        },
      },
      'audit.suppressions[0].expires: must be a date YYYY-MM-DD, got "2026-13-01"',
    ],
  ];
  for (const [name, doc, message] of invalid)
    it(`refuses an audit section: ${name}`, () => {
      expect(validate(doc)).toBe(false);
      let error: unknown;
      try {
        parsePolicy(JSON.stringify(doc), "p.json");
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(PolicyError);
      expect((error as PolicyError).issues.join("\n")).toContain(message);
    });
});

describe("audit SARIF with a policy and a baseline", () => {
  const schema = JSON.parse(
    readFileSync(join(import.meta.dirname, "fixtures", "sarif-schema-2.1.0.json"), "utf8"),
  );
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(schema);

  it("leaves baselined and suppressed findings out of the results and counts them, as check", async () => {
    const first = await run(v15);
    const csp = first.findings.find((f) => f.rule === "csp-missing")!;
    const policy = policyOf({
      rules: { "navigation-unlimited": { level: "warn" } },
      suppressions: [
        { rule: "csp-missing", fingerprint: csp.fingerprint, reason: "server sets it" },
      ],
    });
    // a baseline that accepts only permission-handler-missing
    const file = createAuditBaseline(first);
    file.fingerprints = file.fingerprints.filter((f) => f.rule === "permission-handler-missing");
    const baseline = parseAuditBaseline(JSON.stringify(file), "audit-baseline.json");
    const r = await run(v15, { policy, baseline });
    expect(states(r)).toEqual([
      "open-external new",
      "permission-handler-missing baselined",
      "csp-missing suppressed",
      "navigation-unlimited new",
    ]);
    const log = auditToSarif(r, { version: "0.0.0" }) as any;
    const ok = validate(log);
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
    const results = log.runs[0].results as any[];
    // code scanning reads neither suppressions nor baselineState: an accepted finding there
    // would reopen an alert, so only counted findings are results
    expect(results.map((x) => x.ruleId)).toEqual([OPEN, "navigation-unlimited"]);
    expect(results.every((x) => x.suppressions === undefined)).toBe(true);
    expect(results.every((x) => x.baselineState === undefined)).toBe(true);
    expect(results[0].level).toBe("error");
    expect(results[1].level).toBe("warning");
    expect(log.runs[0].properties.hexvero.notReported).toEqual({ baselined: 1, suppressed: 1 });
    expect(log.runs[0].properties.hexvero.policy).toBe(policy.sha256);
    // everything accepted: no results at all, still valid
    const all = await run(v15, { baseline: baselineOf(first) });
    const empty = auditToSarif(all, { version: "0.0.0" }) as any;
    expect(empty.runs[0].results).toEqual([]);
    expect(empty.runs[0].properties.hexvero.notReported).toEqual({ baselined: 4, suppressed: 0 });
    expect(validate(empty)).toBe(true);
  });

  it("reports a finding whose suppression expired, and says it expired", async () => {
    const first = await run(v15);
    const open = first.findings.find((f) => f.rule === OPEN)!;
    const policy = policyOf({
      suppressions: [
        { rule: OPEN, fingerprint: open.fingerprint, reason: "ok", expires: "2020-01-01" },
      ],
    });
    const log = auditToSarif(await run(v15, { policy }), { version: "0.0.0" }) as any;
    expect(validate(log)).toBe(true);
    const result = log.runs[0].results.find((x: any) => x.ruleId === OPEN);
    expect(result.suppressions).toBeUndefined();
    expect(result.baselineState).toBeUndefined();
    expect(result.properties).toMatchObject({
      state: "suppression-expired",
      suppressionExpired: { reason: "ok", expires: "2020-01-01" },
    });
  });
});
