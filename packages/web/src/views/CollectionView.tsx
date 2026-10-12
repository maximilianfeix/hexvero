import type { ReactElement } from "react";
import { useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { api, formatCount, type Page } from "../lib/api.js";
import { navigate } from "../lib/route.js";
import { useAsync } from "../lib/useAsync.js";

const PAGE = 500;
type Row = Record<string, unknown>;

export function CollectionView({
  targetId,
  name,
  query,
}: {
  targetId: string;
  name: string;
  query: URLSearchParams;
}): ReactElement {
  const text = query.get("q") ?? "";
  const offset = Number(query.get("offset") ?? 0);
  const page = useAsync(`${targetId}:${name}:${offset}:${text}`, () =>
    api.collection<Row>(targetId, name, { offset, limit: PAGE, text }),
  );
  const setQuery = (q: string, off = 0): void =>
    navigate(targetId, name, { q: q || undefined, offset: off ? String(off) : undefined }, true);
  return (
    <>
      <Toolbar
        text={text}
        onText={(q) => setQuery(q)}
        status={
          page.data ? statusLine(page.data, text) : page.error ? page.error.message : "Loading…"
        }
      />
      <Table rows={page.data?.items ?? []} loading={page.loading} />
      {page.data && (page.data.truncated || offset > 0) && (
        <div className="pager">
          <button
            className="btn"
            disabled={offset === 0}
            onClick={() => setQuery(text, Math.max(0, offset - PAGE))}
          >
            Previous
          </button>
          <button
            className="btn"
            disabled={!page.data.truncated}
            onClick={() => setQuery(text, offset + PAGE)}
          >
            Next {PAGE}
          </button>
        </div>
      )}
    </>
  );
}

export function statusLine(page: Page<unknown>, text: string): string {
  const from = page.total === 0 ? 0 : page.offset + 1;
  const to = page.offset + page.items.length;
  return `${formatCount(from)}–${formatCount(to)} of ${formatCount(page.total)}${
    text ? " matching" : ""
  }${page.truncated ? " · more below" : ""}`;
}

export function Toolbar({
  text,
  onText,
  status,
  children,
}: {
  text: string;
  onText: (q: string) => void;
  status: string;
  children?: React.ReactNode;
}): ReactElement {
  const [draft, setDraft] = useState(text);
  useEffect(() => setDraft(text), [text]);
  useEffect(() => {
    const t = setTimeout(() => draft !== text && onText(draft), 180);
    return () => clearTimeout(t);
  }, [draft, text, onText]);
  return (
    <div className="toolbar">
      <input
        className="input"
        type="search"
        placeholder="Filter…"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        aria-label="Filter rows"
      />
      {children}
      <span className="status" aria-live="polite">
        {status}
      </span>
    </div>
  );
}

const cellText = (v: unknown): string =>
  v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);

export function Table({ rows, loading }: { rows: Row[]; loading: boolean }): ReactElement {
  const parentRef = useRef<HTMLDivElement>(null);
  const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((c) =>
    rows.some((r) => r[c] !== undefined && r[c] !== null),
  );
  const widths = columns.map((c) => {
    const longest = rows
      .slice(0, 200)
      .reduce((m, r) => Math.max(m, cellText(r[c]).length), c.length);
    return `${Math.min(Math.max(longest * 7.6 + 24, 72), 560)}px`;
  });
  const numeric = columns.map((c) =>
    rows.slice(0, 50).every((r) => typeof r[c] === "number" || r[c] === undefined),
  );
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 31,
    overscan: 12,
  });
  const cols = widths.join(" ");
  return (
    <div className="table-wrap" ref={parentRef} role="grid" aria-busy={loading}>
      {rows.length === 0 ? (
        <p className="empty" style={{ padding: 24 }}>
          {loading ? "Loading…" : "No rows match."}
        </p>
      ) : (
        <div className="table" style={{ ["--cols" as string]: cols }}>
          <div className="row head" role="row">
            {columns.map((c, i) => (
              <div key={c} className={`cell${numeric[i] ? " num" : ""}`} role="columnheader">
                {c}
              </div>
            ))}
          </div>
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualizer.getVirtualItems().map((item) => {
              const row = rows[item.index]!;
              return (
                <div
                  key={item.key}
                  className="row"
                  role="row"
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    right: 0,
                    transform: `translateY(${item.start}px)`,
                    height: item.size,
                  }}
                >
                  {columns.map((c, i) => (
                    <div
                      key={c}
                      className={`cell${numeric[i] ? " num" : ""}`}
                      role="gridcell"
                      title={cellText(row[c])}
                    >
                      <Cell value={row[c]} />
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function Cell({ value }: { value: unknown }): ReactElement {
  if (typeof value === "boolean")
    return <span className={value ? "bool-true" : "bool-false"}>{value ? "yes" : "no"}</span>;
  if (Array.isArray(value) && value.every((v) => typeof v === "string") && value.length <= 6) {
    return (
      <>
        {(value as string[]).map((v) => (
          <span key={v} className="tag">
            {v}
          </span>
        ))}
      </>
    );
  }
  return <>{cellText(value)}</>;
}
