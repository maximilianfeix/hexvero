import type { ReactElement } from "react";
import { useEffect, useRef, useState } from "react";
import { api, type ChangeRow, type Place, type ReleaseComparison } from "../lib/api.js";
import { basisWords, CHANGE, MEANING, show, sidesOf, type Side } from "../lib/compare.js";
import { navigate } from "../lib/route.js";
import { visible } from "../lib/text.js";
import { useAsync } from "../lib/useAsync.js";

const baseName = (path: string): string => path.split(/[\\/]/).pop() ?? path;

/**
 * Before and after of one change, side by side: the places each build was read from with the
 * lines around them, how the item was read and, for an unknown, why nothing more could be said.
 * A side without a recorded position says so; no line is ever made up.
 */
export function EvidencePanel({
  row,
  r,
  position,
  onClose,
}: {
  row: ChangeRow;
  r: ReleaseComparison;
  /** "3 of 12": where the row sits in the filtered list. */
  position: string;
  onClose: () => void;
}): ReactElement {
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => title.current?.focus({ preventScroll: true }), [row.id]);
  const { sign, word } = CHANGE[row.change];
  const { before, after } = sidesOf(row);
  return (
    <aside id="evidence" className="evidence" aria-labelledby="evidence-title">
      <div className="evidence-head">
        <h2 id="evidence-title" ref={title} tabIndex={-1}>
          <span className={`sign ${row.change}`} aria-hidden="true">
            {sign}
          </span>
          <span className="word">{word}</span> <code className="key">{visible(row.key)}</code>
        </h2>
        <button type="button" className="btn quiet" onClick={onClose} aria-keyshortcuts="Escape">
          Close <kbd>Esc</kbd>
        </button>
      </div>
      <p className="evidence-meta">
        <span className="mono">{row.collection}</span>
        {MEANING[row.collection] && <> · {MEANING[row.collection]}</>} · {position}
      </p>
      <dl className="evidence-facts">
        <div>
          <dt>Basis</dt>
          <dd>
            {row.basis && <span className="tag basis">{row.basis}</span>} {basisWords(row.basis)}
          </dd>
        </div>
        {row.reason && (
          <div>
            <dt>Why unknown</dt>
            <dd>{visible(row.reason)}</dd>
          </div>
        )}
      </dl>
      <TracePath row={row} r={r} />
      {row.fields && row.fields.length > 0 && (
        <div className="table-wrap auto">
          <table className="counts evidence-fields">
            <thead>
              <tr>
                <th scope="col">setting</th>
                <th scope="col">before</th>
                <th scope="col">after</th>
              </tr>
            </thead>
            <tbody>
              {row.fields.map((f) => (
                <tr key={f.field}>
                  <th scope="row">{visible(f.field)}</th>
                  <td>{visible(show(f.before))}</td>
                  <td>{visible(show(f.after))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div
        className={`evidence-sides${before.state === "absent" ? " absent-before" : after.state === "absent" ? " absent-after" : ""}`}
      >
        <SidePane
          key={`a:${row.id}`}
          heading="Before"
          name={baseName(r.a.info.path)}
          side={before}
          targetId={r.a.id}
        />
        <SidePane
          key={`b:${row.id}`}
          heading="After"
          name={baseName(r.b.info.path)}
          side={after}
          targetId={r.b.id}
        />
      </div>
      <p className="note">
        Lines as stored in each build, shown as text. Invisible and direction-changing characters
        are written out as ⟨U+…⟩. Nothing was executed.
      </p>
    </aside>
  );
}

/** `file:line`, or the file alone when no line was recorded. */
const at = (p: Place): string => `${p.file}${p.line === undefined ? "" : `:${p.line}`}`;

/**
 * An interface row as window → member → channel → handler, and an added host on a handler's own
 * line (an inference from place, said in the title). Nothing for other rows or older servers.
 */
function TracePath({ row, r }: { row: ChangeRow; r: ReleaseComparison }): ReactElement | null {
  if (row.collection !== "interfaces" || !row.trace) return null;
  const own = row.where.find((p) => p.role === undefined);
  const handlers = row.where.filter((p) => p.role === "handler");
  const hosts = r.changes.filter(
    (c) =>
      c.collection === "endpoints" &&
      c.change === "added" &&
      c.where.some((p) => handlers.some((h) => h.file === p.file && h.line === p.line)),
  );
  const steps: Array<{ role: string; value: string; at?: string; title?: string }> = [];
  if (row.trace.windows.length) steps.push({ role: "window", value: row.trace.windows.join(", ") });
  steps.push({
    role: "preload member",
    value: row.key.split("::").slice(-2).join("."),
    ...(own ? { at: at(own) } : {}),
  });
  if (row.trace.channel) steps.push({ role: "channel", value: row.trace.channel });
  for (const h of handlers) steps.push({ role: "handler", value: at(h) });
  for (const host of hosts)
    steps.push({
      role: "host on the handler's line",
      value: host.key.split("::").slice(2).join("::"),
      title: "on the handler's line: an inference from place, not a traced call",
    });
  return (
    <ol className="trace-path" aria-label="Path from the window to the main process">
      {steps.map((s, i) => (
        <li key={i} title={s.title}>
          <span className="trace-role">{s.role}</span>
          <code>{visible(s.value)}</code>
          {s.at && <span className="trace-at">{visible(s.at)}</span>}
        </li>
      ))}
    </ol>
  );
}

function SidePane({
  heading,
  name,
  side,
  targetId,
}: {
  heading: string;
  name: string;
  side: Side;
  targetId: string;
}): ReactElement {
  const [index, setIndex] = useState(0);
  const places = side.state === "places" ? side.places : [];
  const place = places[index];
  return (
    <section className="side-pane" aria-label={`${heading}: ${name}`}>
      <h3>
        {heading} <span className="mono">{visible(name)}</span>
      </h3>
      {side.state === "absent" && <p className="side-state absent">{side.why}</p>}
      {side.state === "unrecorded" && <p className="side-state unrecorded">{side.why}</p>}
      {places.length > 1 && (
        <div
          className="place-picker"
          role="group"
          aria-label={`Places in ${heading.toLowerCase()}`}
        >
          {places.map((p, i) => (
            <button
              key={i}
              type="button"
              className="chip"
              aria-pressed={i === index}
              onClick={() => setIndex(i)}
            >
              {p.role && <span className="role">{p.role}</span>}
              <code>{visible(placeLabel(p))}</code>
            </button>
          ))}
        </div>
      )}
      {place && <Snippet place={place} targetId={targetId} />}
    </section>
  );
}

const placeLabel = (p: Place): string => `${p.file}${p.line === undefined ? "" : `:${p.line}`}`;

function Snippet({ place, targetId }: { place: Place; targetId: string }): ReactElement {
  const [attempt, setAttempt] = useState(0);
  const line = place.line;
  const source = useAsync(`evidence:${targetId}:${place.file}:${line}:${attempt}`, () =>
    line === undefined ? Promise.resolve(null) : api.source(targetId, place.file, line, 6),
  );
  if (line === undefined)
    return (
      <p className="side-state unrecorded">
        No source position recorded: <code>{visible(place.file)}</code> is named without a line.
      </p>
    );
  return (
    <div className="snippet">
      <div className="snippet-head">
        {place.role && <span className="role">{place.role}</span>}
        <code>{visible(placeLabel(place))}</code>
        <span className="spacer" />
        <a
          href={`/targets/${targetId}/source?file=${encodeURIComponent(place.file)}&line=${line}`}
          onClick={(e) => {
            if (e.metaKey || e.ctrlKey || e.shiftKey) return;
            e.preventDefault();
            navigate(targetId, "source", { file: place.file, line: String(line) });
          }}
        >
          Full view
        </a>
      </div>
      {source.loading && (
        <p className="side-state" aria-busy="true">
          Reading {visible(place.file)}…
        </p>
      )}
      {source.error && (
        <p className="side-state error" role="alert">
          Could not read the lines: {source.error.message}{" "}
          <button type="button" className="btn quiet" onClick={() => setAttempt((n) => n + 1)}>
            Retry
          </button>
        </p>
      )}
      {source.data && (
        <div
          className="source-lines snippet-lines"
          role="region"
          tabIndex={0}
          aria-label={`${place.file} around line ${line}`}
        >
          {source.data.lines.map((text, i) => {
            const n = source.data!.start + i;
            const cut = source.data!.cut.find((c) => c.line === n);
            return (
              <div
                key={n}
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
    </div>
  );
}
