import type { ReactElement } from "react";
import { useEffect, useRef } from "react";
import { api } from "../lib/api.js";
import { navigate } from "../lib/route.js";
import { visible } from "../lib/text.js";
import { useAsync } from "../lib/useAsync.js";

/**
 * The lines around a `file:line` a fact was read from. The text is target content: it is
 * rendered as plain text (React escapes it), never as markup, and never run.
 */
export function SourceView({
  targetId,
  query,
}: {
  targetId: string;
  query: URLSearchParams;
}): ReactElement {
  const file = query.get("file") ?? "";
  const line = Number(query.get("line") ?? 0);
  const valid = file !== "" && Number.isInteger(line) && line > 0;
  const source = useAsync(`source:${targetId}:${file}:${line}`, () =>
    valid ? api.source(targetId, file, line) : Promise.reject(new Error("No file:line given.")),
  );
  const marked = useRef<HTMLDivElement>(null);
  // a block body: browsers that return a promise from scrollIntoView would hand React a
  // non-function as the effect's cleanup and crash the page on the next navigation
  useEffect(() => {
    marked.current?.scrollIntoView({ block: "center" });
  }, [source.data]);
  if (!valid)
    return (
      <p className="empty">
        Open a <code>file:line</code> from a finding or a comparison to see the code around it.
      </p>
    );
  return (
    <div className="source">
      <div className="toolbar">
        <code className="source-file">
          {visible(file)}:{line}
        </code>
        {source.data && (
          <span className="status">
            lines {source.data.start}–{source.data.start + source.data.lines.length - 1} of{" "}
            {source.data.totalLines}
          </span>
        )}
        <span className="spacer" />
        <button type="button" className="btn quiet" onClick={() => window.history.back()}>
          Back
        </button>
        <button type="button" className="btn quiet" onClick={() => navigate(targetId, "modules")}>
          All modules
        </button>
      </div>
      {source.loading && <p className="empty">Reading {visible(file)}…</p>}
      {source.error && (
        <p className="empty" role="alert" style={{ color: "var(--alert)" }}>
          {source.error.message}
        </p>
      )}
      {source.data && (
        <div className="source-lines" role="region" aria-label={`${file} around line ${line}`}>
          {source.data.lines.map((text, i) => {
            const n = source.data!.start + i;
            const cut = source.data!.cut.find((c) => c.line === n);
            return (
              <div
                key={n}
                ref={n === line ? marked : undefined}
                className={`source-line${n === line ? " hit" : ""}`}
                aria-current={n === line ? "true" : undefined}
              >
                <span className="ln">{n}</span>
                <span className="code">
                  {visible(text)}
                  {cut && (
                    <span className="cut"> … {cut.length - text.length} more characters</span>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      )}
      <p className="note">
        Read from the file as stored in the target. Text from the target is shown as data; invisible
        and direction-changing characters are written out as ⟨U+…⟩.
      </p>
    </div>
  );
}
