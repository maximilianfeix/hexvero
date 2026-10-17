import type { ReactElement } from "react";
import { useEffect, useId, useRef, useState } from "react";
// Embedded at build time: the editor starts from the shipped example, nothing is fetched.
import EXAMPLE_POLICY from "../../../../examples/policy.json?raw";
import { api, HttpError, type PolicyResult, type ReleaseComparison } from "../lib/api.js";
import {
  counts,
  findingSign,
  findingWords,
  incompleteWords,
  RULE,
  STATUS,
  tallyWords,
} from "../lib/check.js";
import { visible } from "../lib/text.js";
import { PlaceLink } from "./PlaceLink.js";

export { EXAMPLE_POLICY };

interface Download {
  busy: string | null;
  error: string | null;
  /** The file name the last download was saved under. */
  saved: string | null;
}

export type GateRun =
  | { state: "idle" }
  | { state: "running" }
  | { state: "invalid"; message: string; issues: string[] }
  | { state: "error"; message: string }
  | { state: "done"; result: PolicyResult; policy: string };

/**
 * The last step of a review: the pair checked against a policy (contract C5/C7). The policy is
 * edited here and sent as the request body; the server reads no policy or baseline path.
 */
export function ReleaseGate({
  r,
  onOpenRow,
  initialPolicy = EXAMPLE_POLICY,
  initialRun = { state: "idle" },
}: {
  r: Pick<ReleaseComparison, "a" | "b">;
  /** Opens the evidence of a change row when it is loaded; false when it is not. */
  onOpenRow?: (id: string) => boolean;
  initialPolicy?: string;
  /** For render tests: a finished run to show. */
  initialRun?: GateRun;
}): ReactElement {
  const [policy, setPolicy] = useState(initialPolicy);
  const [run, setRun] = useState<GateRun>(initialRun);
  const [download, setDownload] = useState<Download>({ busy: null, error: null, saved: null });
  const controller = useRef<AbortController | null>(null);
  const editorId = useId();
  const resultRef = useRef<HTMLDivElement>(null);
  useEffect(() => () => controller.current?.abort(), []);

  const start = (): void => {
    controller.current?.abort();
    const c = new AbortController();
    controller.current = c;
    const sent = policy;
    setRun({ state: "running" });
    setDownload({ busy: null, error: null, saved: null });
    api.check(r.a.id, r.b.id, sent, c.signal).then(
      (result) => {
        if (c.signal.aborted) return;
        setRun({ state: "done", result, policy: sent });
        resultRef.current?.focus({ preventScroll: false });
      },
      (error: unknown) => {
        if (c.signal.aborted) return;
        if (error instanceof HttpError && error.code === "invalid_policy")
          setRun({ state: "invalid", message: error.message, issues: error.issues });
        else
          setRun({
            state: "error",
            message: error instanceof Error ? error.message : String(error),
          });
        resultRef.current?.focus({ preventScroll: false });
      },
    );
  };

  const save = (format: "sarif" | "markdown", text: string): void => {
    setDownload({ busy: format, error: null, saved: null });
    api.downloadCheck(r.a.id, r.b.id, text, format).then(
      (saved) => setDownload({ busy: null, error: null, saved }),
      (e: unknown) =>
        setDownload({ busy: null, error: e instanceof Error ? e.message : String(e), saved: null }),
    );
  };

  const stale = run.state === "done" && run.policy !== policy;
  return (
    <div className="section release-gate" id="release-gate">
      <h3 id="release-gate-title" tabIndex={-1}>
        Release gate
      </h3>
      <p className="note">
        Check this pair against a policy: which new interface members, external hosts and more
        permissive window settings are allowed. Same rules as <code>hexvero check</code>; the policy
        is sent with the request and never read from a path.
      </p>
      <div className="gate-editor">
        <label htmlFor={editorId}>Policy (JSON)</label>
        <textarea
          id={editorId}
          className="input mono"
          spellCheck={false}
          autoComplete="off"
          rows={Math.min(16, Math.max(8, policy.split("\n").length + 1))}
          value={policy}
          aria-describedby={`${editorId}-hint`}
          onChange={(e) => setPolicy(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              start();
            }
          }}
        />
        <p id={`${editorId}-hint`} className="note">
          <kbd>Tab</kbd> leaves the editor · <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>Enter</kbd> runs the
          check
        </p>
        <div className="gate-actions">
          <button
            type="button"
            className="btn primary"
            onClick={start}
            disabled={run.state === "running"}
          >
            {run.state === "running" ? "Checking…" : "Run check"}
          </button>
          <button
            type="button"
            className="btn quiet"
            onClick={() => setPolicy(EXAMPLE_POLICY)}
            disabled={policy === EXAMPLE_POLICY}
          >
            Reset to the example policy
          </button>
        </div>
      </div>

      <div className="gate-result" ref={resultRef} tabIndex={-1} aria-live="polite">
        {run.state === "running" && (
          <p role="status" aria-busy="true">
            Checking both builds against the policy…
          </p>
        )}
        {run.state === "invalid" && (
          <div role="alert" className="gate-invalid">
            <p className="error-text">
              <strong>The policy is not valid.</strong> {visible(run.message)}
            </p>
            {run.issues.length > 0 && (
              <ul className="gaps">
                {run.issues.map((issue, i) => (
                  <li key={i} className="mono">
                    {visible(issue)}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {run.state === "error" && (
          <p role="alert" className="error-text">
            <strong>The check did not run.</strong> {visible(run.message)}
          </p>
        )}
        {run.state === "done" && (
          <GateResult
            result={run.result}
            r={r}
            stale={stale}
            {...(onOpenRow ? { onOpenRow } : {})}
            download={download}
            onDownload={(format) => save(format, run.policy)}
          />
        )}
      </div>
    </div>
  );
}

function GateResult({
  result,
  r,
  stale,
  onOpenRow,
  download,
  onDownload,
}: {
  result: PolicyResult;
  r: Pick<ReleaseComparison, "a" | "b">;
  stale: boolean;
  onOpenRow?: (id: string) => boolean;
  download: Download;
  onDownload: (format: "sarif" | "markdown") => void;
}): ReactElement {
  const status = STATUS[result.status];
  const [missing, setMissing] = useState<string | null>(null);
  return (
    <>
      <p className={`gate-status ${result.status}`} role="status">
        <span className="sign" aria-hidden="true">
          {status.sign}
        </span>
        <strong>{status.word}</strong>: {status.text}.{" "}
        <span className="gate-tally">{tallyWords(result)}.</span>
      </p>
      {stale && (
        <p className="note">
          The policy was edited after this run; the result and the downloads below are for the
          policy as it was run. Run the check again to apply the edit.
        </p>
      )}
      <div className="gate-actions">
        <button
          type="button"
          className="btn"
          onClick={() => onDownload("sarif")}
          disabled={download.busy !== null}
        >
          {download.busy === "sarif" ? "Saving…" : "Download SARIF"}
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => onDownload("markdown")}
          disabled={download.busy !== null}
        >
          {download.busy === "markdown" ? "Saving…" : "Download Markdown"}
        </button>
        <span className="note mono">policy sha256 {result.policy.sha256.slice(0, 12)}</span>
      </div>
      {download.saved && (
        <p className="note" role="status">
          Saved <span className="mono">{visible(download.saved)}</span> to your downloads.
        </p>
      )}
      {download.error && (
        <p role="alert" className="error-text">
          Download failed: {visible(download.error)}
        </p>
      )}

      {result.findings.length === 0 ? (
        <p className="empty">No findings: nothing in the reviewed lists breaks a rule.</p>
      ) : (
        <ul className="gate-findings" aria-label="Policy findings">
          {result.findings.map((f) => (
            <li
              key={`${f.rule}:${f.fingerprint}`}
              className={`gate-finding ${counts(f) ? f.level : "quiet"}${f.unknown ? " unknown" : ""}`}
            >
              <span className="sign" aria-hidden="true">
                {findingSign(f)}
              </span>
              <div className="change-main">
                <p className="gate-head">
                  <span className="mono rule">{f.rule}</span>{" "}
                  <code className="key">{visible(f.key)}</code>{" "}
                  <span className="tag">{findingWords(f)}</span>
                  {f.basis && <span className="tag basis">{visible(f.basis)}</span>}
                </p>
                <p className="gate-message">{visible(f.message)}</p>
                {RULE[f.rule] && <p className="note">Rule: {RULE[f.rule]}.</p>}
                {f.unknown && (
                  <p className="note">
                    Unknown: this finding rests on a comparison that could not be completed, so it
                    may not be a real change.
                  </p>
                )}
                {f.suppression && (
                  <p className="note">
                    Suppressed: {visible(f.suppression.reason)}
                    {f.suppression.expires && ` (until ${f.suppression.expires})`}
                  </p>
                )}
                <div className="places">
                  {f.where.length === 0 ? (
                    <span className="side">no source position recorded</span>
                  ) : (
                    f.where.slice(0, 6).map((p, i) => (
                      <span key={i} className="places-side">
                        {i === 0 && (
                          <span className="side">in {p.side === "a" ? "before" : "after"}</span>
                        )}
                        <PlaceLink place={p} targetId={p.side === "a" ? r.a.id : r.b.id} />
                      </span>
                    ))
                  )}
                  {f.where.length > 6 && <span className="note">+{f.where.length - 6} more</span>}
                </div>
                <p className="gate-meta">
                  <span className="side">fingerprint</span>{" "}
                  <code className="fingerprint">{f.fingerprint}</code>
                  {onOpenRow && (
                    <button
                      type="button"
                      className="btn quiet"
                      onClick={() => setMissing(onOpenRow(f.row) ? null : f.row)}
                    >
                      Show the change
                    </button>
                  )}
                </p>
                {missing === f.row && (
                  <p className="note" role="status">
                    That change is not among the loaded rows; load more rows above to reach it.
                  </p>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {result.incomplete.length > 0 && (
        <div className="partial" role="status">
          <p>
            <strong>Not decidable.</strong> These rules could not be decided because part of the
            comparison is missing:
          </p>
          <ul className="gaps">
            {result.incomplete.map((i) => (
              <li key={`${i.rule}:${i.collection}`}>{incompleteWords(i)}</li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
