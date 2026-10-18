/**
 * Words for the release gate (`POST /api/check`, contract C5/C7): a status is a word and a sign,
 * never a color alone, and each finding says whether it counts against the policy.
 */
import type { PolicyFinding, PolicyResult } from "./api.js";
import { gapWords } from "./compare.js";

export const STATUS: Record<PolicyResult["status"], { sign: string; word: string; text: string }> =
  {
    pass: { sign: "✓", word: "Pass", text: "no new finding at level fail" },
    fail: { sign: "✗", word: "Fail", text: "the policy is violated" },
    incomplete: {
      sign: "?",
      word: "Incomplete",
      text: "the check could not be decided: part of a comparison is missing and the policy says unknown: fail",
    },
    error: { sign: "!", word: "Error", text: "the check did not run" },
  };

/** What each rule looks for, in the reader's terms. */
export const RULE: Record<string, string> = {
  "new-interface-member": "a member pages can call that the before build did not have",
  "new-external-host": "a host the after build talks to that is not in the allow list",
  "window-more-permissive": "a window setting that became more permissive",
  "new-bridge-exposure":
    "a privileged object (ipcRenderer, shell, a Node module) handed to pages as it is",
  "fuse-weakened":
    "a packaged build's runtime less locked down: a fuse, the ASAR integrity record, end of support",
  "remote-enabled": "@electron/remote newly enabled for a webContents",
};

const STATE: Record<PolicyFinding["state"], string> = {
  new: "new",
  "suppression-expired": "suppression expired",
  baselined: "baselined",
  suppressed: "suppressed",
};

/** True when the finding counts against the policy: new, or its suppression has run out. */
export const counts = (f: PolicyFinding): boolean =>
  f.state === "new" || f.state === "suppression-expired";

/** The sign in front of a finding; `aria-hidden`, the words next to it say the same. */
export function findingSign(f: PolicyFinding): string {
  if (f.unknown) return "?";
  if (!counts(f)) return "·";
  return f.level === "fail" ? "✗" : "!";
}

/** "new · fail", "suppressed · warn", "new · fail · unknown". */
export function findingWords(f: PolicyFinding): string {
  return [STATE[f.state], f.level, ...(f.unknown ? ["unknown"] : [])].join(" · ");
}

/** One sentence for a rule that could not be decided. */
export function incompleteWords(i: PolicyResult["incomplete"][number]): string {
  return `${i.rule} could not be decided on ${i.collection}: ${i.gaps.map(gapWords).join("; ")}.`;
}

const n = (v: number, one: string, many: string): string => `${v} ${v === 1 ? one : many}`;

/** "2 findings at level fail, 1 warning" — what the status rests on. */
export function tallyWords(r: PolicyResult): string {
  const failing = r.findings.filter((f) => counts(f) && f.level === "fail").length;
  const warning = r.findings.filter((f) => counts(f) && f.level === "warn").length;
  const quiet = r.findings.length - failing - warning;
  const parts = [n(failing, "finding at level fail", "findings at level fail")];
  if (warning) parts.push(n(warning, "warning", "warnings"));
  if (quiet) parts.push(`${quiet} baselined or suppressed`);
  if (r.incomplete.length)
    parts.push(n(r.incomplete.length, "rule not decided", "rules not decided"));
  return parts.join(", ");
}
