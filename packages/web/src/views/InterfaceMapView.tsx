import type { KeyboardEvent, ReactElement } from "react";
import { useEffect, useMemo, useRef } from "react";
import { api, formatCount, type Page } from "../lib/api.js";
import {
  buildMap,
  clip,
  type Column,
  endsNote,
  filterRows,
  GAP_Y,
  hotEdges,
  type InterfaceMap,
  type InterfaceRow,
  LINK_MEANING,
  LINK_WORDS,
  type MapEdge,
  type MapNode,
  memberId,
  memberPath,
  NODE_H,
  rowsOf,
} from "../lib/interfaceMap.js";
import { nextOffset } from "../lib/pages.js";
import { navigate, updateQuery } from "../lib/route.js";
import { visible } from "../lib/text.js";
import { useAsync } from "../lib/useAsync.js";
import { Toolbar } from "./CollectionView.js";
import { PlaceLink } from "./CompareView.js";

/** Rows read for the map and the list; past this the page says how many were left unread. */
export const MAX_LOAD = 10_000;
const LIST_PAGE = 100;
const PANEL_ROWS = 40;
const COL_W = 216;
const GAP_X = 64;

const COLUMNS: Array<[Column, string]> = [
  ["window", "Windows"],
  ["member", "Preload members"],
  ["channel", "Channels"],
  ["handler", "Main-process ends"],
];

interface Loaded {
  rows: InterfaceRow[];
  total: number;
}

/** Node ids hold target text; the DOM attribute carries them percent-encoded (ASCII only). */
const domKey = (id: string): string => encodeURIComponent(id);

const select = (id: string | null): void =>
  updateQuery({ sel: id ?? undefined }, { replace: true });

/** Follows the pages of the collection (pages can be cut short by the byte budget). */
async function loadAll(targetId: string): Promise<Loaded> {
  const rows: InterfaceRow[] = [];
  let offset: number | null = 0;
  let total = 0;
  while (offset !== null && rows.length < MAX_LOAD) {
    const page: Page<InterfaceRow> = await api.collection<InterfaceRow>(targetId, "interfaces", {
      offset,
      limit: 2000,
    });
    total = page.total;
    rows.push(...page.items);
    const next = nextOffset(page);
    // a page that moves nowhere ends the walk instead of asking for it again
    offset = next !== null && next > page.offset ? next : null;
  }
  return { rows: rows.slice(0, MAX_LOAD), total };
}

/**
 * Which preload member each window can call, which IPC channel the member uses and which
 * main-process code answers on it, drawn from the `interfaces` collection. Each link says how
 * it was read; the map makes no claim about what a call does or whether it is safe.
 */
export function InterfaceMapView({
  targetId,
  query,
}: {
  targetId: string;
  query: URLSearchParams;
}): ReactElement {
  const loaded = useAsync(`${targetId}:interface-map`, () => loadAll(targetId));
  const text = query.get("q") ?? "";
  const view = query.get("view") === "list" ? "list" : "map";
  const sel = query.get("sel");
  const page = Math.max(0, Number(query.get("page") ?? 0) || 0);
  const rows = loaded.data?.rows;
  const filtered = useMemo(() => (rows ? filterRows(rows, text) : []), [rows, text]);
  const map = useMemo(() => buildMap(rows ?? [], filtered), [rows, filtered]);

  if (loaded.error) return <p className="empty">{loaded.error.message}</p>;
  if (!loaded.data || !rows) return <p className="empty">Reading the interface rows…</p>;
  if (rows.length === 0) return <p className="empty">No preload members were found to draw.</p>;

  const selRows = sel ? selectedRows(map, rows, sel) : [];
  const status = `${formatCount(filtered.length)} of ${formatCount(rows.length)} members${
    text ? " matching" : ""
  }`;

  return (
    <div className="imap">
      <Toolbar
        text={text}
        onText={(q) => updateQuery({ q: q || undefined, page: undefined }, { replace: true })}
        status={status}
        placeholder="Search members, channels, handlers"
        label="Search members, channels and handlers"
      >
        <div className="segmented" role="group" aria-label="Show as">
          {(["map", "list"] as const).map((v) => (
            <button
              key={v}
              type="button"
              className="chip"
              aria-pressed={view === v}
              onClick={() => updateQuery({ view: v === "map" ? undefined : v }, { replace: true })}
            >
              {v === "map" ? "Map" : "List"}
            </button>
          ))}
        </div>
      </Toolbar>
      <p className="legend imap-legend">
        <span>What the code wires, and how each link was read:</span>
        <span>
          <svg width="28" height="8" aria-hidden="true">
            <line x1="0" y1="4" x2="28" y2="4" className="key-line" />
          </svg>{" "}
          literal channel
        </span>
        <span>
          <svg width="28" height="8" aria-hidden="true">
            <line x1="0" y1="4" x2="28" y2="4" className="key-line" />
            <circle cx="14" cy="4" r="3" className="key-mark" />
          </svg>{" "}
          resolved (constant, alias, wrapper)
        </span>
        <span>
          <svg width="28" height="8" aria-hidden="true">
            <line x1="0" y1="4" x2="28" y2="4" className="key-line dashed" />
          </svg>{" "}
          not read: the reason is on the line
        </span>
        {loaded.data.total > rows.length && (
          <span>
            · {formatCount(rows.length)} of {formatCount(loaded.data.total)} rows read; the rest are
            not drawn or listed
          </span>
        )}
        {view === "map" && map.shown < map.matched && (
          <span role="status">
            · showing the first {formatCount(map.shown)} of {formatCount(map.matched)} members; the
            list shows all of them
          </span>
        )}
      </p>
      <div className={`imap-layout${sel ? " with-evidence" : ""}`}>
        {view === "map" ? (
          <MapCanvas map={map} rows={rows} sel={sel} onSelect={select} />
        ) : (
          <ListTable
            rows={rows}
            indexes={filtered}
            page={page}
            sel={sel}
            onSelect={select}
            onPage={(p) => updateQuery({ page: p ? String(p) : undefined }, { replace: true })}
          />
        )}
        {sel && (
          <InterfaceEvidence
            targetId={targetId}
            id={sel}
            map={map}
            rows={selRows.map((i) => rows[i]!)}
            onClose={() => {
              select(null);
              requestAnimationFrame(() =>
                (
                  document.querySelector(`[data-id="${domKey(sel)}"]`) as HTMLElement | null
                )?.focus(),
              );
            }}
          />
        )}
      </div>
    </div>
  );
}

/** The rows behind a selection; a member outside the drawn part (capped, filtered) still resolves. */
export function selectedRows(
  map: InterfaceMap,
  rows: readonly InterfaceRow[],
  sel: string,
): number[] {
  const drawn = rowsOf(map, sel);
  if (drawn.length || !sel.startsWith("m:")) return drawn;
  const out: number[] = [];
  rows.forEach((row, i) => {
    if (memberId(row) === sel) out.push(i);
  });
  return out;
}

const colX = (k: number): number => 24 + k * (COL_W + GAP_X);

export function MapCanvas({
  map,
  rows,
  sel,
  onSelect,
}: {
  map: InterfaceMap;
  rows: readonly InterfaceRow[];
  sel: string | null;
  onSelect: (id: string | null) => void;
}): ReactElement {
  const wrap = useRef<HTMLDivElement>(null);
  const hot = hotEdges(map, sel);
  const pos = (id: string): { x: number; y: number } | null => {
    const n = map.nodes.get(id);
    if (!n) return null;
    return { x: colX(COLUMNS.findIndex(([c]) => c === n.column)), y: n.y };
  };
  const longest = Math.max(1, ...COLUMNS.map(([c]) => map.columns[c].length));
  const width = colX(COLUMNS.length) - GAP_X + 24;
  const height = 40 + longest * (NODE_H + GAP_Y) + 24;

  // the selection (also one opened from a comparison) is scrolled into view
  useEffect(() => {
    if (!sel) return;
    wrap.current
      ?.querySelector(`[data-id="${domKey(sel)}"]`)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [sel]);

  const move = (event: KeyboardEvent<SVGGElement>, n: MapNode): void => {
    const list = map.columns[n.column];
    const k = list.indexOf(n);
    const col = COLUMNS.findIndex(([c]) => c === n.column);
    let target: string | undefined;
    if (event.key === "ArrowDown") target = list[k + 1]?.id;
    else if (event.key === "ArrowUp") target = list[k - 1]?.id;
    else if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      const right = event.key === "ArrowRight";
      const next = COLUMNS[col + (right ? 1 : -1)]?.[0];
      const linked = map.edges
        .filter((e) => (right ? e.from === n.id : e.to === n.id))
        .map((e) => (right ? e.to : e.from));
      target =
        linked.map((id) => map.nodes.get(id)).find((m) => m?.column === next)?.id ??
        (next ? map.columns[next][0]?.id : undefined);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelect(sel === n.id ? null : n.id);
      return;
    } else if (event.key === "Escape" && sel) {
      event.preventDefault();
      onSelect(null);
      return;
    }
    if (!target) return;
    event.preventDefault();
    (wrap.current?.querySelector(`[data-id="${domKey(target)}"]`) as SVGGElement | null)?.focus();
  };

  const path = (e: MapEdge): string | null => {
    const a = pos(e.from);
    const b = pos(e.to);
    if (!a || !b) return null;
    const x1 = a.x + COL_W;
    const y1 = a.y + NODE_H / 2;
    const x2 = b.x;
    const y2 = b.y + NODE_H / 2;
    return `M${x1},${y1} C${x1 + GAP_X / 2},${y1} ${x2 - GAP_X / 2},${y2} ${x2},${y2}`;
  };
  const mid = (e: MapEdge): { x: number; y: number } => {
    const a = pos(e.from)!;
    const b = pos(e.to)!;
    return { x: (a.x + COL_W + b.x) / 2, y: (a.y + b.y) / 2 + NODE_H / 2 };
  };
  const edgeLabel = (e: MapEdge): string => {
    const from = map.nodes.get(e.from)!;
    const to = map.nodes.get(e.to)!;
    const how =
      e.kind === "window"
        ? "loads the preload"
        : e.kind === "resolved"
          ? "resolved"
          : e.kind === "direct"
            ? "literal channel"
            : `${LINK_WORDS[e.kind]}${e.reason ? `: ${e.reason}` : ""}`;
    return visible(`${from.label} → ${to.label}, ${how}`);
  };

  return (
    <div className="graph imap-graph" ref={wrap}>
      <svg width={width} height={height} role="group" aria-label="Interface map">
        {COLUMNS.map(([c, title], k) => (
          <text key={c} className="column-title" x={colX(k)} y={24}>
            {title} ({map.columns[c].length})
          </text>
        ))}
        {map.columns.window.length === 0 && (
          <text className="column-empty" x={colX(0)} y={60}>
            No window names a preload
          </text>
        )}
        {map.edges.map((e) => {
          const d = path(e);
          if (!d) return null;
          const m = mid(e);
          return (
            <g key={e.id} className={`imap-edge ${e.kind}${hot.has(e.id) ? " hot" : ""}`}>
              <path className="edge" d={d} />
              {e.kind === "resolved" && (
                <>
                  <circle className="edge-mark" cx={m.x} cy={m.y} r={3} />
                  <text className="edge-word" x={m.x + 6} y={m.y - 4}>
                    resolved
                  </text>
                </>
              )}
              {(e.kind === "unresolved" || e.kind === "unknown") && (
                <text className="edge-word" x={m.x - 4} y={m.y - 4}>
                  ?
                </text>
              )}
            </g>
          );
        })}
        {COLUMNS.flatMap(([c], k) =>
          map.columns[c].map((n) => (
            <g
              key={n.id}
              data-id={domKey(n.id)}
              className={`node imap-node ${n.column}${n.placeholder ? " placeholder" : ""}${
                sel === n.id ? " selected" : ""
              }${n.column === "member" && rows[n.rows[0]!]?.link === "none" ? " orphan" : ""}`}
              transform={`translate(${colX(k)},${n.y})`}
              onClick={() => onSelect(sel === n.id ? null : n.id)}
              onKeyDown={(e) => move(e, n)}
              tabIndex={0}
              role="button"
              aria-pressed={sel === n.id}
              aria-label={visible(`${n.label}, ${n.note}`)}
            >
              <rect width={COL_W} height={NODE_H} />
              <title>{`${visible(n.label)}\n${visible(n.note)}`}</title>
              <text x={10} y={15}>
                {visible(clip(n.label, 28))}
              </text>
              <text className="role" x={10} y={29}>
                {visible(clip(n.note, 33))}
              </text>
            </g>
          )),
        )}
        {/* hit areas after the nodes: Tab reaches the nodes first, then every edge */}
        {map.edges.map((e) => {
          const d = path(e);
          if (!d) return null;
          return (
            <path
              key={e.id}
              data-id={domKey(e.id)}
              className="edge-hit"
              d={d}
              tabIndex={0}
              role="button"
              aria-pressed={sel === e.id}
              aria-label={edgeLabel(e)}
              onClick={() => onSelect(sel === e.id ? null : e.id)}
              onKeyDown={(ev) => {
                if (ev.key === "Enter" || ev.key === " ") {
                  ev.preventDefault();
                  onSelect(sel === e.id ? null : e.id);
                } else if (ev.key === "Escape" && sel) {
                  ev.preventDefault();
                  onSelect(null);
                }
              }}
            >
              <title>{edgeLabel(e)}</title>
            </path>
          );
        })}
      </svg>
    </div>
  );
}

export function ListTable({
  rows,
  indexes,
  page,
  sel,
  onSelect,
  onPage,
}: {
  rows: readonly InterfaceRow[];
  indexes: readonly number[];
  page: number;
  sel: string | null;
  onSelect: (id: string | null) => void;
  onPage: (page: number) => void;
}): ReactElement {
  const pages = Math.max(1, Math.ceil(indexes.length / LIST_PAGE));
  const p = Math.min(page, pages - 1);
  const shown = indexes.slice(p * LIST_PAGE, (p + 1) * LIST_PAGE);
  const body = useRef<HTMLTableSectionElement>(null);
  const onKey = (event: KeyboardEvent<HTMLButtonElement>, k: number): void => {
    const to =
      event.key === "ArrowDown"
        ? k + 1
        : event.key === "ArrowUp"
          ? k - 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? shown.length - 1
              : null;
    if (to === null) {
      if (event.key === "Escape" && sel) {
        event.preventDefault();
        onSelect(null);
      }
      return;
    }
    event.preventDefault();
    body.current?.querySelectorAll<HTMLButtonElement>("button.row-open")[to]?.focus();
  };
  if (indexes.length === 0) return <p className="empty">No member matches the search.</p>;
  return (
    <div className="imap-list">
      <div className="table-wrap auto">
        <table className="counts imap-table">
          <thead>
            <tr>
              <th scope="col">Member</th>
              <th scope="col">Exposed at</th>
              <th scope="col">Windows</th>
              <th scope="col">Channel</th>
              <th scope="col">Link</th>
              <th scope="col">Main-process ends</th>
            </tr>
          </thead>
          <tbody ref={body}>
            {shown.map((i, k) => {
              const row = rows[i]!;
              const id = memberId(row);
              return (
                <tr key={`${id}:${i}`} className={sel === id ? "selected" : undefined}>
                  <th scope="row">
                    <button
                      type="button"
                      className="row-open"
                      data-id={domKey(id)}
                      aria-pressed={sel === id}
                      onClick={() => onSelect(sel === id ? null : id)}
                      onKeyDown={(e) => onKey(e, k)}
                    >
                      <code>{visible(memberPath(row))}</code>
                    </button>
                  </th>
                  <td>
                    <code>{visible(`${row.file}:${row.line}`)}</code>
                  </td>
                  <td>{row.windows.length ? visible(row.windows.join(", ")) : "none named"}</td>
                  <td>
                    {row.channel === null ? <em>not read</em> : <code>{visible(row.channel)}</code>}
                  </td>
                  <td>
                    <span className={`tag link ${row.link}`}>{LINK_WORDS[row.link]}</span>
                  </td>
                  <td>
                    {row.ends.length === 0
                      ? "—"
                      : visible(
                          row.ends
                            .slice(0, 3)
                            .map((e) => `${e.file}:${e.line} ${e.api}`)
                            .join(", "),
                        )}
                    {row.ends.length > 3 && ` +${row.ends.length - 3}`}
                    {row.endsTruncated && <span className="note"> · {endsNote(row)}</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {pages > 1 && (
        <div className="pager">
          <button type="button" className="btn" disabled={p === 0} onClick={() => onPage(p - 1)}>
            Previous
          </button>
          <button
            type="button"
            className="btn"
            disabled={p >= pages - 1}
            onClick={() => onPage(p + 1)}
          >
            Next
          </button>
          <span>
            {formatCount(p * LIST_PAGE + 1)}–{formatCount(p * LIST_PAGE + shown.length)} of{" "}
            {formatCount(indexes.length)}
          </span>
        </div>
      )}
    </div>
  );
}

const KIND_WORDS: Record<Column, string> = {
  window: "Window",
  member: "Preload member",
  channel: "IPC channel",
  handler: "Main-process end",
};

/** The rows behind the selected node or edge, each with the places it was read at. */
export function InterfaceEvidence({
  targetId,
  id,
  map,
  rows,
  onClose,
}: {
  targetId: string;
  id: string;
  map: InterfaceMap;
  rows: InterfaceRow[];
  onClose: () => void;
}): ReactElement {
  const node = map.nodes.get(id);
  const edge = map.edges.find((e) => e.id === id);
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    title.current?.focus({ preventScroll: true });
  }, [id]);
  const heading = node
    ? node.label
    : edge
      ? `${map.nodes.get(edge.from)?.label ?? ""} → ${map.nodes.get(edge.to)?.label ?? ""}`
      : rows[0]
        ? memberPath(rows[0])
        : id.replace(/^[a-z]:/, "");
  const kind = node ? KIND_WORDS[node.column] : edge ? "Link" : "Preload member";
  return (
    <aside
      id="evidence"
      className="evidence imap-evidence"
      aria-labelledby="imap-evidence-title"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onClose();
        }
      }}
    >
      <div className="evidence-head">
        <h2 id="imap-evidence-title" ref={title} tabIndex={-1}>
          <span className="word">{kind}</span> <code className="key">{visible(heading)}</code>
        </h2>
        <button type="button" className="btn quiet" onClick={onClose} aria-keyshortcuts="Escape">
          Close <kbd>Esc</kbd>
        </button>
      </div>
      {edge && (
        <dl className="evidence-facts">
          <div>
            <dt>How read</dt>
            <dd>
              {edge.kind === "window"
                ? "the window's resolved preload path is this member's file"
                : edge.kind === "direct"
                  ? "the channel is named as a literal at both places"
                  : edge.kind === "resolved"
                    ? "the channel was reached through a constant, an alias, a wrapper or the resolver"
                    : LINK_MEANING[edge.kind]}
            </dd>
          </div>
          {edge.reason && (
            <div>
              <dt>Why</dt>
              <dd>{visible(edge.reason)}</dd>
            </div>
          )}
        </dl>
      )}
      {node?.placeholder && (
        <p className="side-state unrecorded">
          Not a place in the code: it stands for {node.column === "channel" ? "channels" : "ends"}{" "}
          hexvero could not read. Each member below says why.
        </p>
      )}
      {node?.column === "window" && (
        <p className="side-state">
          Named as <code>{visible(node.label)}</code> (file and the variable the window is assigned
          to); this list records no line for it.
        </p>
      )}
      {rows.length === 0 && (
        <p className="side-state unrecorded">
          This member is not in this build&apos;s interface map. It may have been removed, or the
          search hides it.
        </p>
      )}
      <ol className="imap-rows">
        {rows.slice(0, PANEL_ROWS).map((row, k) => (
          <li key={k}>
            <p className="imap-row-head">
              <code>{visible(memberPath(row))}</code>{" "}
              <span className={`tag link ${row.link}`}>{LINK_WORDS[row.link]}</span>
            </p>
            <dl className="evidence-facts">
              <div>
                <dt>Exposed at</dt>
                <dd>
                  <PlaceLink
                    place={{ side: "b", file: row.file, line: row.line }}
                    targetId={targetId}
                  />{" "}
                  <span className="note">{row.world} world</span>
                </dd>
              </div>
              <div>
                <dt>Windows</dt>
                <dd>
                  {row.windows.length
                    ? visible(row.windows.join(", "))
                    : "no window was found that names this preload"}
                </dd>
              </div>
              <div>
                <dt>Channel</dt>
                <dd>
                  {row.channel === null ? "not read" : <code>{visible(row.channel)}</code>}
                  {row.direction && <span className="note"> · {row.direction}</span>}
                </dd>
              </div>
              <div>
                <dt>Link</dt>
                <dd>
                  {LINK_MEANING[row.link]}
                  {row.reason && (
                    <>
                      <br />
                      <span className="note">{visible(row.reason)}</span>
                    </>
                  )}
                </dd>
              </div>
              <div>
                <dt>Ends</dt>
                <dd>
                  {row.ends.length === 0 ? (
                    "none found"
                  ) : (
                    <ul className="imap-ends">
                      {row.ends.map((e, j) => (
                        <li key={j}>
                          <PlaceLink
                            place={{ side: "b", file: e.file, line: e.line, role: e.api }}
                            targetId={targetId}
                          />
                          {e.via && <span className="note"> via {visible(e.via)}</span>}
                        </li>
                      ))}
                    </ul>
                  )}
                  {row.endsTruncated && row.channel !== null && (
                    <p className="note">
                      {endsNote(row)}{" "}
                      <button
                        type="button"
                        className="btn quiet"
                        onClick={() => navigate(targetId, "ipc", { q: row.channel ?? undefined })}
                      >
                        Open the ipc list for {visible(row.channel)}
                      </button>
                    </p>
                  )}
                </dd>
              </div>
            </dl>
          </li>
        ))}
      </ol>
      {rows.length > PANEL_ROWS && (
        <p className="note">
          {PANEL_ROWS} of {rows.length} members shown here; the list view has all of them.
        </p>
      )}
      <p className="note">
        Places as stored in the build, shown as text; invisible and direction-changing characters
        are written out as ⟨U+…⟩. The map records how the code is wired, not what a call does.
        Nothing was executed.
      </p>
    </aside>
  );
}
