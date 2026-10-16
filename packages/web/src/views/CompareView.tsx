import type { ReactElement } from "react";
import { useState } from "react";
import {
  api,
  type ChangeRow,
  type Place,
  type ReleaseComparison,
  type TargetRecord,
} from "../lib/api.js";
import { navigate, navigateCompare } from "../lib/route.js";
import { useAsync } from "../lib/useAsync.js";

const baseName = (path: string): string => path.split(/[\\/]/).pop() ?? path;

/** Words next to the sign, so a change never depends on color alone. */
const CHANGE: Record<ChangeRow["change"], { sign: string; word: string }> = {
  added: { sign: "+", word: "added" },
  removed: { sign: "−", word: "removed" },
  changed: { sign: "~", word: "changed" },
  unknown: { sign: "?", word: "unknown" },
};

/** What each reviewed collection means, in the reader's terms. */
const MEANING: Record<string, string> = {
  interfaces: "What pages can call: preload members with their channel and main-process handler",
  contextBridge: "Members the preload script exposes to web content",
  ipcChannels: "IPC channels with their senders and receivers",
  windows: "BrowserWindow settings that decide what a page may do",
  webPreferences: "webPreferences keys as written in the code",
  endpoints: "Network endpoints the code calls",
  storage: "Storage keys the code reads or writes",
  urls: "URL literals in the code",
};

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

export function CompareView({
  targets,
  query,
  onDemo,
  demoBusy,
}: {
  targets: TargetRecord[];
  query: URLSearchParams;
  onDemo: () => void;
  demoBusy: boolean;
}): ReactElement {
  const a = query.get("a") ?? "";
  const b = query.get("b") ?? "";
  const known = (id: string): boolean => targets.some((t) => t.id === id);
  const ready = known(a) && known(b) && a !== b;
  const picker = (label: string, value: string, set: (id: string) => void): ReactElement => (
    <label>
      <span>{label}</span>
      <select
        className="input mono"
        value={known(value) ? value : ""}
        onChange={(e) => set(e.target.value)}
      >
        <option value="">Choose a target…</option>
        {targets.map((t) => (
          <option key={t.id} value={t.id}>
            {baseName(t.info.path)}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <>
      <div className="target-header">
        <h1 className="verdict">Compare two builds</h1>
        <p className="lede">
          Pick the build before and the build after. Each change links to the file and line it was
          read from. Nothing is executed.
        </p>
        <div className="compare-pick">
          {picker("Before", a, (id) => navigateCompare(id, b, true))}
          <button
            type="button"
            className="btn quiet"
            aria-label="Swap before and after"
            disabled={!a && !b}
            onClick={() => navigateCompare(b, a, true)}
          >
            ⇄
          </button>
          {picker("After", b, (id) => navigateCompare(a, id, true))}
        </div>
      </div>
      <section className="panel compare" aria-label="Comparison">
        {targets.length < 2 ? (
          <div className="empty">
            <p>
              <strong>Open two builds of the same app</strong> (drop both files, or open their paths
              above), or start with the example: two versions of a small Electron app.
            </p>
            <button type="button" className="btn primary" onClick={onDemo} disabled={demoBusy}>
              {demoBusy ? "Opening…" : "Open the example builds"}
            </button>
          </div>
        ) : !ready ? (
          <p className="empty">
            {a && a === b
              ? "Before and after are the same target; pick two different ones."
              : "Choose both builds to compare them."}
          </p>
        ) : (
          <Comparison a={a} b={b} />
        )}
      </section>
    </>
  );
}

function Comparison({ a, b }: { a: string; b: string }): ReactElement {
  const result = useAsync(`compare:${a}:${b}`, () => api.compare(a, b));
  const [text, setText] = useState("");
  const [reportError, setReportError] = useState<string | null>(null);
  if (result.loading)
    return (
      <p className="empty" aria-busy="true">
        Reading both builds and comparing them…
      </p>
    );
  if (result.error || !result.data)
    return (
      <p className="empty" role="alert" style={{ color: "var(--alert)" }}>
        {result.error?.message ?? "The comparison failed."}
      </p>
    );
  const r = result.data;
  const needle = text.trim().toLowerCase();
  const rows = needle
    ? r.changes.filter(
        (c) =>
          c.key.toLowerCase().includes(needle) ||
          c.where.some((p) => p.file.toLowerCase().includes(needle)),
      )
    : r.changes;
  const groups = new Map<string, ChangeRow[]>();
  for (const row of rows) groups.set(row.collection, [...(groups.get(row.collection) ?? []), row]);
  const lists = new Set(r.changes.map((c) => c.collection)).size;
  const limits = [
    ...r.limitations.a.map((l) => ({ side: "a" as const, ...l })),
    ...r.limitations.b.map((l) => ({ side: "b" as const, ...l })),
  ];
  const unknown = r.changes.filter((c) => c.change === "unknown").length;
  const open = limits.length + unknown;
  return (
    <div className="compare-body">
      <div className="compare-summary">
        <p>
          <strong>
            {baseName(r.a.info.path)} → {baseName(r.b.info.path)}
          </strong>
          {": "}
          {r.changes.length === 0
            ? "no row-level changes in the reviewed lists"
            : `${plural(r.changes.length, "change")} in ${plural(lists, "list")}`}
          {open > 0 && (
            <>
              {" · "}
              <a href="#not-established">{open} not established</a>
            </>
          )}
        </p>
        <button
          type="button"
          className="btn"
          onClick={() => {
            setReportError(null);
            api
              .downloadReport(a, b)
              .catch((e: unknown) => setReportError(e instanceof Error ? e.message : String(e)));
          }}
        >
          Download report (.md)
        </button>
      </div>
      {reportError && (
        <p role="alert" style={{ color: "var(--alert)" }}>
          Report failed: {reportError}
        </p>
      )}
      {(r.overview.partialScan.a || r.overview.partialScan.b) && (
        <div className="partial" role="status">
          <p>
            <strong>Partial comparison.</strong> A build was read only in part; items in unread
            files are listed as unknown, not as added or removed. Open that build and read all
            remaining files first.
          </p>
        </div>
      )}

      {r.overview.windowChanges.length > 0 && (
        <div className="section">
          <h3>Window settings to review</h3>
          <ul className="window-changes">
            {r.overview.windowChanges.map((w) => (
              <li key={`${w.window}:${w.setting}`}>
                <code>{w.window}</code> <span className="mono">{w.setting}</span>{" "}
                <code>{w.before}</code> → <code>{w.after}</code>{" "}
                <span className={`direction ${w.direction.replace(" ", "-")}`}>{w.direction}</span>
              </li>
            ))}
          </ul>
          <p className="note">
            Whether a change matters depends on what the window loads. This is a fact to review, not
            a verdict.
          </p>
        </div>
      )}

      <div className="section">
        <h3>Changes</h3>
        <div className="toolbar">
          <input
            type="search"
            className="input"
            placeholder="Filter by name or file"
            aria-label="Filter changes"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <span className="status">
            {needle
              ? `${rows.length} of ${r.changes.length} shown`
              : plural(r.changes.length, "row")}
          </span>
        </div>
        {[...groups].map(([collection, list]) => (
          <div key={collection} className="change-group">
            <h4>
              <span className="mono">{collection}</span>
              {MEANING[collection] && <span className="meaning">{MEANING[collection]}</span>}
            </h4>
            <ul className="changes">
              {list.map((row, i) => (
                <ChangeItem key={`${row.change}:${row.key}:${i}`} row={row} r={r} />
              ))}
            </ul>
            {r.cut
              .filter((c) => c.collection === collection)
              .map((c) => (
                <p key={c.collection} className="note">
                  {c.shown} of {c.total} rows shown; the report and{" "}
                  <code>hexvero compare &lt;a&gt; &lt;b&gt; {c.collection} --json</code> list all.
                </p>
              ))}
          </div>
        ))}
        {rows.length === 0 && r.changes.length > 0 && <p className="empty">No change matches.</p>}
      </div>

      <div className="section" id="not-established">
        <h3>Not established</h3>
        <ul className="findings">
          {limits.map((l, i) => (
            <li key={i} className="finding limitation">
              <span className="dot" />
              <div>
                <span className="title">
                  {l.side === "a" ? "Before" : "After"}: {l.message}
                </span>
                <span className="kind">{l.code}</span>
              </div>
            </li>
          ))}
          {unknown > 0 && (
            <li className="finding limitation">
              <span className="dot" />
              <div>
                <span className="title">
                  {unknown === 1 ? "1 item was" : `${unknown} items were`} found on one side in a
                  file the other side did not read: neither added nor removed.
                </span>
              </div>
            </li>
          )}
          <li className="finding limitation">
            <span className="dot" />
            <div>
              <span className="title">
                Absence from a list means hexvero did not find it in the files it read, not that the
                app cannot do it. Nothing here was observed running.
              </span>
            </div>
          </li>
        </ul>
      </div>

      <div className="section">
        <h3>Every list both builds have</h3>
        <div className="table-wrap auto">
          <table className="counts">
            <thead>
              <tr>
                <th scope="col">list</th>
                <th scope="col">added</th>
                <th scope="col">removed</th>
                <th scope="col">changed</th>
                <th scope="col">unknown</th>
                <th scope="col">unchanged</th>
              </tr>
            </thead>
            <tbody>
              {r.overview.collections.map((c) => (
                <tr key={c.collection}>
                  <th scope="row" className="mono">
                    {c.collection}
                    {c.partial && <span className="tag">partial</span>}
                  </th>
                  <td>{c.added || "·"}</td>
                  <td>{c.removed || "·"}</td>
                  <td>{c.changed || "·"}</td>
                  <td>{c.unknown || "·"}</td>
                  <td>{c.unchanged}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {(r.overview.onlyA.length > 0 || r.overview.onlyB.length > 0) && (
          <p className="note">
            {r.overview.onlyA.length > 0 && `Only before: ${r.overview.onlyA.join(", ")}. `}
            {r.overview.onlyB.length > 0 && `Only after: ${r.overview.onlyB.join(", ")}.`}
          </p>
        )}
      </div>
    </div>
  );
}

function ChangeItem({ row, r }: { row: ChangeRow; r: ReleaseComparison }): ReactElement {
  const { sign, word } = CHANGE[row.change];
  return (
    <li className={`change ${row.change}`}>
      <span className="sign" aria-hidden="true">
        {sign}
      </span>
      <div className="change-main">
        <div className="change-head">
          <span className="word">{word}</span> <code className="key">{row.key}</code>
          {row.basis && (
            <span
              className={`tag basis ${row.basis.split(" ").pop()}`}
              title={
                row.basis === "inferred"
                  ? "Built from a pattern or a computed part, not a literal"
                  : "How the parser read it"
              }
            >
              {row.basis}
            </span>
          )}
        </div>
        {row.fields && row.fields.length > 0 && (
          <ul className="fields">
            {row.fields.map((f) => (
              <li key={f.field}>
                <span className="mono">{f.field}</span> <code>{show(f.before)}</code> →{" "}
                <code>{show(f.after)}</code>
              </li>
            ))}
          </ul>
        )}
        {row.reason && <div className="note">{row.reason}</div>}
        {row.where.length > 0 && (
          <div className="places">
            <span className="side">in {row.where[0]!.side === "a" ? "before" : "after"}</span>
            {row.where.slice(0, 6).map((p, i) => (
              <PlaceLink key={i} place={p} targetId={p.side === "a" ? r.a.id : r.b.id} />
            ))}
            {row.where.length > 6 && <span className="note">+{row.where.length - 6} more</span>}
          </div>
        )}
      </div>
    </li>
  );
}

const show = (v: unknown): string => (v === undefined ? "not written" : JSON.stringify(v));

/** A file:line that opens the source lines around it in the target it was read from. */
export function PlaceLink({ place, targetId }: { place: Place; targetId: string }): ReactElement {
  const label = `${place.file}${place.line === undefined ? "" : `:${place.line}`}`;
  return (
    <span className="place">
      {place.role && <span className="role">{place.role}</span>}
      {place.line === undefined ? (
        <code>{label}</code>
      ) : (
        <a
          href={`/targets/${targetId}/source?file=${encodeURIComponent(place.file)}&line=${place.line}`}
          onClick={(e) => {
            if (e.metaKey || e.ctrlKey || e.shiftKey) return;
            e.preventDefault();
            navigate(targetId, "source", { file: place.file, line: String(place.line) });
          }}
        >
          <code>{label}</code>
        </a>
      )}
    </span>
  );
}
