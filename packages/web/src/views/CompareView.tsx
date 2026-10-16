import type { ReactElement } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  type ChangeRow,
  type Place,
  type ReleaseComparison,
  type TargetRecord,
} from "../lib/api.js";
import {
  basisValue,
  CHANGE,
  completenessWords,
  filterQuery,
  isFiltered,
  KINDS,
  matches,
  MEANING,
  readFilter,
  show,
  summarize,
  tally,
  toggle,
  type CompareFilter,
  type SummaryFigure,
} from "../lib/compare.js";
import { navigate, navigateCompare, updateQuery } from "../lib/route.js";
import { visible } from "../lib/text.js";
import { EvidencePanel } from "./EvidencePanel.js";

const baseName = (path: string): string => path.split(/[\\/]/).pop() ?? path;
const plural = (n: number, word: string): string =>
  `${n.toLocaleString("en-US")} ${word}${n === 1 ? "" : "s"}`;
const rowsLabel = (n: number): string => (n === 1 ? "row" : "rows");
const same = (x: readonly string[] | undefined, y: readonly string[]): boolean =>
  (x ?? []).length === y.length && y.every((v) => (x ?? []).includes(v));
/** Rows per request; the server sends at most 500. */
const PAGE = 200;
/** Marks the history entry that opened the evidence panel, so closing it can go Back. */
const EVIDENCE_STATE = "hexveroEvidence";

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
  // Picking or swapping builds keeps the filter; a selected row belongs to the old pair.
  const keep = filterQuery(readFilter(query));
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
            {visible(baseName(t.info.path))}
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
          {picker("Before", a, (id) => navigateCompare(id, b, true, keep))}
          <button
            type="button"
            className="btn quiet"
            aria-label="Swap before and after"
            title="Swap before and after"
            disabled={!a && !b}
            onClick={() => navigateCompare(b, a, false, keep)}
          >
            ⇄
          </button>
          {picker("After", b, (id) => navigateCompare(a, id, true, keep))}
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
          <Comparison key={`${a}:${b}`} a={a} b={b} query={query} />
        )}
      </section>
    </>
  );
}

type Load =
  | { state: "loading" }
  | { state: "cancelled" }
  | { state: "error"; message: string }
  | { state: "ready"; first: ReleaseComparison; rows: ChangeRow[]; next: number | null };

/** The first page, then more on request; cancelling stops the wait, not the server. */
function useComparison(a: string, b: string) {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  const controller = useRef<AbortController | null>(null);
  const [more, setMore] = useState<{ busy: boolean; error: string | null }>({
    busy: false,
    error: null,
  });
  useEffect(() => {
    const c = new AbortController();
    controller.current = c;
    setLoad({ state: "loading" });
    api.compare(a, b, { offset: 0, limit: PAGE, signal: c.signal }).then(
      (first) =>
        !c.signal.aborted &&
        setLoad({ state: "ready", first, rows: first.changes, next: first.page.next }),
      (error: unknown) => {
        if (c.signal.aborted) return;
        setLoad({
          state: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      },
    );
    return () => c.abort();
  }, [a, b, attempt]);
  const cancel = (): void => {
    controller.current?.abort();
    setLoad({ state: "cancelled" });
  };
  const retry = (): void => setAttempt((n) => n + 1);
  const loadMore = (): void => {
    if (load.state !== "ready" || load.next === null || more.busy) return;
    const offset = load.next;
    setMore({ busy: true, error: null });
    api.compare(a, b, { offset, limit: PAGE }).then(
      (page) => {
        setLoad((l) =>
          l.state === "ready" && l.next === offset
            ? { ...l, rows: [...l.rows, ...page.changes], next: page.page.next }
            : l,
        );
        setMore({ busy: false, error: null });
      },
      (error: unknown) =>
        setMore({ busy: false, error: error instanceof Error ? error.message : String(error) }),
    );
  };
  return { load, cancel, retry, loadMore, more };
}

function Comparison({
  a,
  b,
  query,
}: {
  a: string;
  b: string;
  query: URLSearchParams;
}): ReactElement {
  const { load, cancel, retry, loadMore, more } = useComparison(a, b);
  const filter = readFilter(query);
  const sel = query.get("sel");
  // A new entry is not the one that opened the evidence: closing from it must not go Back.
  const setFilter = (patch: Partial<CompareFilter>, replace = false): void =>
    updateQuery(filterQuery({ ...filter, ...patch }), {
      replace,
      state: replace ? ((history.state as Record<string, unknown> | null) ?? {}) : {},
    });

  if (load.state === "loading")
    return (
      <div className="empty" aria-busy="true" role="status">
        <p>Reading both builds and comparing them…</p>
        <button type="button" className="btn" onClick={cancel}>
          Cancel
        </button>
      </div>
    );
  if (load.state === "cancelled")
    return (
      <div className="empty" role="status">
        <p>
          <strong>Comparison cancelled.</strong> Nothing is shown for these two builds yet.
        </p>
        <button type="button" className="btn primary" onClick={retry}>
          Compare again
        </button>
      </div>
    );
  if (load.state === "error")
    return (
      <div className="empty" role="alert">
        <p className="error-text">
          <strong>The comparison failed.</strong> {load.message}
        </p>
        <button type="button" className="btn primary" onClick={retry}>
          Retry
        </button>
      </div>
    );
  return (
    <Ready
      a={a}
      b={b}
      r={load.first}
      rows={load.rows}
      next={load.next}
      filter={filter}
      setFilter={setFilter}
      sel={sel}
      loadMore={loadMore}
      more={more}
    />
  );
}

function Ready({
  a,
  b,
  r,
  rows,
  next,
  filter,
  setFilter,
  sel,
  loadMore,
  more,
}: {
  a: string;
  b: string;
  r: ReleaseComparison;
  rows: ChangeRow[];
  next: number | null;
  filter: CompareFilter;
  setFilter: (patch: Partial<CompareFilter>, replace?: boolean) => void;
  sel: string | null;
  loadMore: () => void;
  more: { busy: boolean; error: string | null };
}): ReactElement {
  const [reportError, setReportError] = useState<string | null>(null);
  const [active, setActive] = useState<string | null>(sel);
  const listRef = useRef<HTMLDivElement>(null);
  const shown = useMemo(() => rows.filter((row) => matches(row, filter)), [rows, filter]);
  const selected = sel ? (rows.find((row) => row.id === sel) ?? null) : null;
  const total = r.page.total;

  const focusRow = useCallback((id: string): void => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-row="${CSS.escape(id)}"]`);
    el?.focus({ preventScroll: true });
    el?.scrollIntoView({ block: "nearest" });
  }, []);

  const open = useCallback(
    (id: string): void => {
      setActive(id);
      if (sel) updateQuery({ sel: id }, { replace: true, state: history.state });
      else updateQuery({ sel: id }, { state: { [EVIDENCE_STATE]: true } });
    },
    [sel],
  );
  const close = useCallback((): void => {
    if ((history.state as Record<string, unknown> | null)?.[EVIDENCE_STATE]) history.back();
    else updateQuery({ sel: undefined }, { replace: true });
  }, []);

  // Back, Esc or Close: the focus returns to the row the evidence belonged to.
  const lastSel = useRef(sel);
  useEffect(() => {
    if (lastSel.current && !sel) focusRow(lastSel.current);
    lastSel.current = sel;
  }, [sel, focusRow]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.altKey || e.metaKey || e.ctrlKey) return;
      const target = e.target as HTMLElement | null;
      if (e.key === "Escape" && sel) {
        e.preventDefault();
        close();
        return;
      }
      if (target?.closest("input, textarea, select, [contenteditable]")) return;
      const inList = !!target?.closest(".changes, .evidence");
      const step =
        e.key === "j" || (inList && e.key === "ArrowDown")
          ? 1
          : e.key === "k" || (inList && e.key === "ArrowUp")
            ? -1
            : 0;
      if (!step || shown.length === 0) return;
      e.preventDefault();
      const at = shown.findIndex((row) => row.id === (sel ?? active));
      const nextRow =
        shown[
          at === -1
            ? step > 0
              ? 0
              : shown.length - 1
            : Math.max(0, Math.min(shown.length - 1, at + step))
        ]!;
      setActive(nextRow.id);
      if (sel) {
        updateQuery({ sel: nextRow.id }, { replace: true, state: history.state });
        listRef.current
          ?.querySelector(`[data-row="${CSS.escape(nextRow.id)}"]`)
          ?.scrollIntoView({ block: "nearest" });
      } else focusRow(nextRow.id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shown, sel, active, close, focusRow]);

  const groups = new Map<string, ChangeRow[]>();
  for (const row of shown) groups.set(row.collection, [...(groups.get(row.collection) ?? []), row]);
  const limits = [
    ...r.limitations.a.map((l) => ({ side: "a" as const, ...l })),
    ...r.limitations.b.map((l) => ({ side: "b" as const, ...l })),
  ];
  const figures = summarize(r);
  const incomplete = r.overview.collections
    .map((c) => ({
      collection: c.collection,
      words: completenessWords(r.completeness?.[c.collection], c.partial),
    }))
    .filter((c): c is { collection: string; words: string } => c.words !== null);
  const position = selected
    ? (() => {
        const i = shown.findIndex((row) => row.id === selected.id);
        return i === -1
          ? "not in the filtered list"
          : `${i + 1} of ${shown.length}${isFiltered(filter) ? " filtered" : ""}`;
      })()
    : "";

  return (
    <div className={`compare-layout${sel ? " with-evidence" : ""}`}>
      <div className="compare-body" ref={listRef}>
        <div className="compare-summary">
          <p>
            <strong>
              {visible(baseName(r.a.info.path))} → {visible(baseName(r.b.info.path))}
            </strong>
            {": "}
            {total === 0
              ? "no row-level changes in the reviewed lists"
              : `${plural(total, "change")} in ${plural(new Set(rows.map((c) => c.collection)).size, "list")}${next !== null ? " so far" : ""}`}
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
          <p role="alert" className="error-text">
            Report failed: {reportError}
          </p>
        )}

        <SummaryBar figures={figures} filter={filter} setFilter={setFilter} />

        {(r.overview.partialScan.a || r.overview.partialScan.b) && (
          <div className="partial" role="status">
            <p>
              <strong>Partial comparison.</strong> The{" "}
              {r.overview.partialScan.a && r.overview.partialScan.b
                ? "before and after builds were"
                : r.overview.partialScan.a
                  ? "before build was"
                  : "after build was"}{" "}
              read only in part; items in unread files are listed as unknown, not as added or
              removed. Open that build and read all remaining files first.
            </p>
            <p>
              <button
                type="button"
                className="btn"
                onClick={() => navigate(r.overview.partialScan.a ? r.a.id : r.b.id, "overview")}
              >
                Open the {r.overview.partialScan.a ? "before" : "after"} build
              </button>
            </p>
          </div>
        )}
        {incomplete.length > 0 && (
          <div className="partial" role="status">
            <p>
              <strong>Not compared whole.</strong> These lists may hold more differences than are
              shown:
            </p>
            <ul className="gaps">
              {incomplete.map((c) => (
                <li key={c.collection}>
                  <span className="mono">{c.collection}</span>: {c.words}
                </li>
              ))}
            </ul>
          </div>
        )}

        {r.overview.windowChanges.length > 0 && (
          <div className="section">
            <h3>Window settings to review</h3>
            <ul className="window-changes">
              {r.overview.windowChanges.map((w) => (
                <li key={`${w.window}:${w.setting}`}>
                  <code>{visible(w.window)}</code> <span className="mono">{w.setting}</span>{" "}
                  <code>{visible(w.before)}</code> → <code>{visible(w.after)}</code>{" "}
                  <span className={`direction ${w.direction.replace(" ", "-")}`}>
                    {w.direction}
                  </span>
                </li>
              ))}
            </ul>
            <p className="note">
              Whether a change matters depends on what the window loads. This is a fact to review,
              not a verdict.
            </p>
          </div>
        )}

        <div className="section">
          <h3 id="changes-title">Changes</h3>
          <Filters rows={rows} filter={filter} setFilter={setFilter} />
          <p className="status-line" role="status">
            {isFiltered(filter)
              ? `${shown.length} of ${rows.length} loaded ${rowsLabel(rows.length)} match`
              : `${plural(rows.length, "row")} loaded`}
            {" · "}
            {rows.length.toLocaleString("en-US")} of {total.toLocaleString("en-US")} shown
            {next !== null && isFiltered(filter) && "; filters apply to the loaded rows only"}
          </p>
          <p className="keys-hint">
            <kbd>j</kbd>/<kbd>k</kbd> or arrows move · <kbd>Enter</kbd> evidence · <kbd>Esc</kbd>{" "}
            close · <kbd>/</kbd> search
          </p>
          {[...groups].map(([collection, list]) => {
            const words = completenessWords(
              r.completeness?.[collection],
              r.overview.collections.find((c) => c.collection === collection)?.partial ?? false,
            );
            return (
              <div key={collection} className="change-group">
                <h4>
                  <span className="mono">{collection}</span>
                  {MEANING[collection] && <span className="meaning">{MEANING[collection]}</span>}
                </h4>
                {words && <p className="gap-note">{words}</p>}
                <ul className="changes" aria-label={`${collection} changes`}>
                  {list.map((row) => (
                    <ChangeItem
                      key={row.id}
                      row={row}
                      r={r}
                      selected={row.id === sel}
                      tabbable={row.id === (active ?? shown[0]?.id)}
                      onOpen={() => open(row.id)}
                    />
                  ))}
                </ul>
                {r.cut
                  .filter((c) => c.collection === collection)
                  .map((c) => (
                    <p key={c.collection} className="note">
                      {c.shown} of {c.total} rows shown; the report and{" "}
                      <code>hexvero compare &lt;a&gt; &lt;b&gt; {c.collection} --json</code> list
                      all.
                    </p>
                  ))}
              </div>
            );
          })}
          {total === 0 && (
            <p className="empty">
              <strong>No row-level changes</strong> in the reviewed lists. The counts below cover
              every list both builds have.
            </p>
          )}
          {rows.length > 0 && shown.length === 0 && (
            <div className="empty">
              <p>No loaded row matches these filters.</p>
              <button
                type="button"
                className="btn"
                onClick={() => setFilter({ kinds: [], lists: [], bases: [], text: "" })}
              >
                Clear filters
              </button>
            </div>
          )}
          <div className="pager">
            <span>
              {rows.length.toLocaleString("en-US")} of {total.toLocaleString("en-US")} rows shown
              {next === null && rows.length < total && " (the rest is cut; see the notes above)"}
            </span>
            {next !== null && (
              <button type="button" className="btn" onClick={loadMore} disabled={more.busy}>
                {more.busy ? "Loading…" : `Load ${Math.min(PAGE, total - rows.length)} more`}
              </button>
            )}
            {more.error && (
              <span role="alert" className="error-text">
                Could not load more: {more.error}{" "}
                <button type="button" className="btn quiet" onClick={loadMore}>
                  Retry
                </button>
              </span>
            )}
          </div>
        </div>

        <div className="section" id="not-established">
          <h3>Not established</h3>
          <ul className="findings">
            {limits.map((l, i) => (
              <li key={i} className="finding limitation">
                <span className="dot" />
                <div>
                  <span className="title">
                    {l.side === "a" ? "Before" : "After"}: {visible(l.message)}
                  </span>
                  <span className="kind">{l.code}</span>
                </div>
              </li>
            ))}
            {figures[3]!.count - limits.length > 0 && (
              <li className="finding limitation">
                <span className="dot" />
                <div>
                  <span className="title">
                    {plural(figures[3]!.count - limits.length, "item")} found on one side only where
                    the other side could not be read or resolved: neither added nor removed.
                  </span>
                </div>
              </li>
            )}
            <li className="finding limitation">
              <span className="dot" />
              <div>
                <span className="title">
                  Absence from a list means hexvero did not find it in the files it read, not that
                  the app cannot do it. Nothing here was observed running.
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
                      {(c.partial || r.completeness?.[c.collection]?.complete === false) && (
                        <span className="tag">partial</span>
                      )}
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
      {sel &&
        (selected ? (
          <EvidencePanel row={selected} r={r} position={position} onClose={close} />
        ) : (
          <aside id="evidence" className="evidence" aria-label="Evidence">
            <div className="evidence-head">
              <h2>Change not loaded</h2>
              <button type="button" className="btn quiet" onClick={close}>
                Close <kbd>Esc</kbd>
              </button>
            </div>
            <p className="side-state unrecorded">
              The selected change is not among the {rows.length} loaded rows
              {next !== null
                ? "; load more rows to reach it"
                : ", or these builds no longer have it"}
              .
            </p>
          </aside>
        ))}
    </div>
  );
}

function SummaryBar({
  figures,
  filter,
  setFilter,
}: {
  figures: SummaryFigure[];
  filter: CompareFilter;
  setFilter: (patch: Partial<CompareFilter>) => void;
}): ReactElement {
  const pressed = (f: SummaryFigure): boolean =>
    same(f.filter.lists, filter.lists) && same(f.filter.kinds, filter.kinds);
  return (
    <ul className="summary-bar" aria-label="Summary">
      {figures.map((f) => (
        <li key={f.id}>
          <button
            type="button"
            className={`figure${f.count > 0 ? " nonzero" : ""}`}
            aria-pressed={pressed(f)}
            title={pressed(f) ? "Show all changes" : `Show only: ${f.label.toLowerCase()}`}
            onClick={() =>
              setFilter(
                pressed(f)
                  ? { kinds: [], lists: [] }
                  : { kinds: f.filter.kinds ?? [], lists: f.filter.lists ?? [] },
              )
            }
          >
            <span className="figure-label">{f.label}</span>
            <span className="figure-count">{f.count.toLocaleString("en-US")}</span>
            <span className="figure-detail">{f.detail}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function Filters({
  rows,
  filter,
  setFilter,
}: {
  rows: ChangeRow[];
  filter: CompareFilter;
  setFilter: (patch: Partial<CompareFilter>, replace?: boolean) => void;
}): ReactElement {
  const kinds = new Map(tally(rows, (row) => row.change));
  const lists = tally(rows, (row) => row.collection);
  const bases = tally(rows, basisValue);
  // Typing replaces the history entry: Back goes to the last chip pressed, not every keystroke.
  const [text, setText] = useState(filter.text);
  useEffect(() => setText(filter.text), [filter.text]);
  return (
    <div className="filters">
      <fieldset>
        <legend>Change</legend>
        {KINDS.map((k) => (
          <button
            key={k}
            type="button"
            className={`chip kind ${k}`}
            aria-pressed={filter.kinds.includes(k)}
            onClick={() => setFilter({ kinds: toggle(filter.kinds, k) })}
          >
            <span className="sign" aria-hidden="true">
              {CHANGE[k].sign}
            </span>
            {CHANGE[k].word} <span className="n">{kinds.get(k) ?? 0}</span>
          </button>
        ))}
      </fieldset>
      <fieldset>
        <legend>List</legend>
        {lists.map(([name, n]) => (
          <button
            key={name}
            type="button"
            className="chip mono"
            aria-pressed={filter.lists.includes(name)}
            onClick={() => setFilter({ lists: toggle(filter.lists, name) })}
          >
            {name} <span className="n">{n}</span>
          </button>
        ))}
      </fieldset>
      <fieldset>
        <legend>Basis</legend>
        {bases.map(([name, n]) => (
          <button
            key={name}
            type="button"
            className={`chip basis ${name.split(" ").pop()}`}
            aria-pressed={filter.bases.includes(name)}
            onClick={() => setFilter({ bases: toggle(filter.bases, name) })}
          >
            {name === "none" ? "not recorded" : name} <span className="n">{n}</span>
          </button>
        ))}
      </fieldset>
      <div className="toolbar">
        <input
          type="search"
          className="input"
          placeholder="Filter by name or file"
          aria-label="Filter changes by name or file"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setFilter({ text: e.target.value }, true);
          }}
        />
        {isFiltered(filter) && (
          <button
            type="button"
            className="btn quiet"
            onClick={() => setFilter({ kinds: [], lists: [], bases: [], text: "" })}
          >
            Clear filters
          </button>
        )}
      </div>
    </div>
  );
}

function ChangeItem({
  row,
  r,
  selected,
  tabbable,
  onOpen,
}: {
  row: ChangeRow;
  r: ReleaseComparison;
  selected: boolean;
  tabbable: boolean;
  onOpen: () => void;
}): ReactElement {
  const { sign, word } = CHANGE[row.change];
  const places = [...(row.whereBefore ?? []), ...row.where];
  return (
    <li className={`change ${row.change}${selected ? " selected" : ""}`}>
      <span className="sign" aria-hidden="true">
        {sign}
      </span>
      <div className="change-main">
        <button
          type="button"
          className="change-open"
          data-row={row.id}
          tabIndex={tabbable ? 0 : -1}
          aria-current={selected ? "true" : undefined}
          aria-controls={selected ? "evidence" : undefined}
          onClick={onOpen}
        >
          <span className="word">{word}</span> <code className="key">{visible(row.key)}</code>
          {row.basis && (
            <span className={`tag basis ${row.basis.split(" ").pop()}`}>{row.basis}</span>
          )}
          {selected && <span className="open-hint">evidence open</span>}
        </button>
        {row.fields && row.fields.length > 0 && (
          <ul className="fields">
            {row.fields.map((f) => (
              <li key={f.field}>
                <span className="mono">{visible(f.field)}</span>{" "}
                <code>{visible(show(f.before))}</code> → <code>{visible(show(f.after))}</code>
              </li>
            ))}
          </ul>
        )}
        {row.reason && <div className="note">{visible(row.reason)}</div>}
        {row.collection === "interfaces" && row.change !== "removed" && (
          <a
            className="imap-link"
            href={`/targets/${r.b.id}/interface-map?sel=${encodeURIComponent(`m:${row.key}`)}`}
            onClick={(e) => {
              if (e.metaKey || e.ctrlKey || e.shiftKey) return;
              e.preventDefault();
              navigate(r.b.id, "interface-map", { sel: `m:${row.key}` });
            }}
          >
            show in interface map
          </a>
        )}
        {places.length > 0 ? (
          <div className="places">
            {(["a", "b"] as const).map((side) => {
              const on = places.filter((p) => p.side === side);
              if (!on.length) return null;
              return (
                <span key={side} className="places-side">
                  <span className="side">in {side === "a" ? "before" : "after"}</span>
                  {on.slice(0, 6).map((p, i) => (
                    <PlaceLink key={i} place={p} targetId={side === "a" ? r.a.id : r.b.id} />
                  ))}
                  {on.length > 6 && <span className="note">+{on.length - 6} more</span>}
                </span>
              );
            })}
          </div>
        ) : (
          <div className="places">
            <span className="side">no source position recorded</span>
          </div>
        )}
      </div>
    </li>
  );
}

/** A file:line that opens the source lines around it in the target it was read from. */
export function PlaceLink({ place, targetId }: { place: Place; targetId: string }): ReactElement {
  const label = visible(`${place.file}${place.line === undefined ? "" : `:${place.line}`}`);
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
