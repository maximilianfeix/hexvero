import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PolicyFinding, PolicyResult } from "../lib/api.js";
import { EXAMPLE_POLICY, ReleaseGate, type GateRun } from "./ReleaseGate.js";

/** Built at run time: the source holds no direction-changing character. */
const RLO = String.fromCharCode(0x202e);
const HOSTILE = "<img src=x onerror=alert(1)>";

const info = (path: string) => ({ path, size: 1, sha256: "0".repeat(64), format: "asar" });
const target = (id: string, path: string) => ({
  id,
  info: info(path),
  openedAt: "",
  analyzed: true,
});
const r = { a: target("t_a", "/x/a.asar"), b: target("t_b", `/x/${HOSTILE}.asar`) };

const finding = (patch: Partial<PolicyFinding>): PolicyFinding => ({
  rule: "new-interface-member",
  fingerprint: "40aa15f76bfd9988f9302d187c03c61d",
  level: "fail",
  state: "new",
  row: "r1",
  collection: "interfaces",
  key: "notesdesk.checkUpdate",
  message: "New interface member notesdesk.checkUpdate is exposed to pages.",
  where: [{ side: "b", file: "preload.js", line: 9 }],
  unknown: false,
  ...patch,
});

const result = (patch: Partial<PolicyResult>): PolicyResult => ({
  hexvero: "check",
  version: 1,
  status: "fail",
  findings: [],
  incomplete: [],
  policy: { file: "policy.json", sha256: "ab".repeat(32) },
  a: info("/x/a.asar"),
  b: info("/x/b.asar"),
  ...patch,
});

const render = (run: GateRun, policy?: string): string =>
  renderToStaticMarkup(
    createElement(ReleaseGate, {
      r,
      initialRun: run,
      ...(policy === undefined ? {} : { initialPolicy: policy }),
      onOpenRow: () => true,
    }),
  );

describe("release gate rendering", () => {
  it("starts from the example policy with a labelled editor and the run button", () => {
    const html = render({ state: "idle" });
    expect(JSON.parse(EXAMPLE_POLICY)).toMatchObject({ hexvero: "policy", version: 1 });
    expect(html).toContain("api.notesdesk.example");
    expect(html).toMatch(/<label for="[^"]+">Policy \(JSON\)<\/label><textarea id="[^"]+"/);
    expect(html).toContain("Run check");
    expect(html).not.toContain("Download SARIF");
  });

  it("states fail in words and a sign, lists rule, key, places and fingerprint", () => {
    const html = render({
      state: "done",
      policy: EXAMPLE_POLICY,
      result: result({
        findings: [
          finding({}),
          finding({
            rule: "new-external-host",
            fingerprint: "68312dcec55422c3b8affec165b21b83",
            key: "updates.notesdesk.example",
            message: "New external host updates.notesdesk.example, not in the allow list.",
            where: [{ side: "b", file: "main.js", line: 30 }],
            basis: "literal",
          }),
        ],
      }),
    });
    expect(html).toContain("<strong>Fail</strong>: the policy is violated.");
    expect(html).toContain("2 findings at level fail.");
    expect(html).toContain('aria-hidden="true">✗</span>');
    expect(html).toContain("40aa15f76bfd9988f9302d187c03c61d");
    expect(html).toContain('href="/targets/t_b/source?file=preload.js&amp;line=9"');
    expect(html).toContain('href="/targets/t_b/source?file=main.js&amp;line=30"');
    expect(html).toContain("Download SARIF");
    expect(html).toContain("Download Markdown");
  });

  it("marks unknown findings and says why a rule was not decided", () => {
    const html = render({
      state: "done",
      policy: EXAMPLE_POLICY,
      result: result({
        status: "incomplete",
        findings: [finding({ unknown: true, where: [] })],
        incomplete: [
          { rule: "new-external-host", collection: "endpoints", gaps: ["scan_partial", "odd"] },
        ],
      }),
    });
    expect(html).toContain("<strong>Incomplete</strong>");
    expect(html).toContain("new · fail · unknown");
    expect(html).toContain(
      "Unknown: this finding rests on a comparison that could not be completed",
    );
    expect(html).toContain("no source position recorded");
    expect(html).toContain(
      "new-external-host could not be decided on endpoints: a build was read only in part; items in unread files are unknown; coverage gap: odd.",
    );
  });

  it("renders hostile keys, messages, files and policy text as text", () => {
    const html = render(
      {
        state: "done",
        policy: "x",
        result: result({
          findings: [
            finding({
              key: `${HOSTILE} **b** safe${RLO}exe`,
              message: `<script>alert(1)</script>`,
              where: [{ side: "a", file: `${HOSTILE}.js`, line: 1 }],
              basis: "<b>x</b>",
              suppression: { reason: `${HOSTILE}${RLO}` },
              state: "suppressed",
            }),
          ],
        }),
      },
      `{"x": "${HOSTILE}"}`,
    );
    expect(html).not.toMatch(/<img|<script|<b>/);
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain(RLO);
    expect(html).toContain("safe⟨U+202E⟩exe");
    // a suppressed finding does not count: a quiet sign, its state in words
    expect(html).toContain("suppressed · fail");
    expect(html).toContain('href="/targets/t_a/source?file=');
    // the run's policy differs from the editor: the result says it is stale
    expect(html).toContain("The policy was edited after this run");
  });

  it("lists every issue of an invalid policy", () => {
    const html = render({
      state: "invalid",
      message: "invalid policy policy.json",
      issues: [`version: this hexvero reads policy version 1, got 2`, `${HOSTILE}: unknown key`],
    });
    expect(html).toContain("The policy is not valid.");
    expect(html).toContain("version: this hexvero reads policy version 1, got 2");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;: unknown key");
    expect(html).toContain('role="alert"');
  });
});
