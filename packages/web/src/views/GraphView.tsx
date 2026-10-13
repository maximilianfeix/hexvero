import type { ReactElement } from "react";
import { useMemo, useState } from "react";
import { api } from "../lib/api.js";
import { useAsync } from "../lib/useAsync.js";

interface Module {
  id: string;
  role: string;
  size: number;
  references: number;
  ipc: number;
}
interface Edge {
  from: string;
  to: string;
  resolved: boolean;
  kind: string;
}

const COLUMNS: Array<[role: string, title: string]> = [
  ["main", "Main process"],
  ["preload", "Preload"],
  ["renderer", "Renderer"],
  ["unknown", "Other modules"],
];
const NODE_W = 220;
const NODE_H = 34;
const GAP_Y = 10;
const GAP_X = 90;
const MAX_NODES = 400;

/**
 * Deterministic layered layout: modules sit in a column per role, ordered by
 * fan-in so that shared modules cluster at the top. Selecting a node
 * highlights its edges; everything else stays quiet.
 */
export function GraphView({ targetId }: { targetId: string }): ReactElement {
  const modules = useAsync(`${targetId}:graph:modules`, () =>
    api.collection<Module>(targetId, "modules", { limit: 2000 }),
  );
  const edges = useAsync(`${targetId}:graph:edges`, () =>
    api.collection<Edge>(targetId, "edges", { limit: 2000 }),
  );
  const [selected, setSelected] = useState<string | null>(null);

  const layout = useMemo(() => {
    const mods = (modules.data?.items ?? []).slice(0, MAX_NODES);
    const resolvedEdges = (edges.data?.items ?? []).filter((e) => e.resolved);
    const fanIn = new Map<string, number>();
    for (const e of resolvedEdges) fanIn.set(e.to, (fanIn.get(e.to) ?? 0) + 1);
    const pos = new Map<string, { x: number; y: number }>();
    let x = 24;
    let height = 0;
    const columns = COLUMNS.map(([role, title]) => {
      const inColumn = mods
        .filter((m) => m.role === role)
        .toSorted(
          (a, b) => (fanIn.get(b.id) ?? 0) - (fanIn.get(a.id) ?? 0) || a.id.localeCompare(b.id),
        );
      inColumn.forEach((m, i) => pos.set(m.id, { x, y: 40 + i * (NODE_H + GAP_Y) }));
      height = Math.max(height, 40 + inColumn.length * (NODE_H + GAP_Y));
      const column = { role, title, x, items: inColumn };
      if (inColumn.length) x += NODE_W + GAP_X;
      return column;
    }).filter((c) => c.items.length);
    return {
      columns,
      pos,
      edges: resolvedEdges.filter((e) => pos.has(e.from) && pos.has(e.to)),
      width: x + 24,
      height: height + 24,
      truncated: (modules.data?.total ?? 0) > MAX_NODES,
    };
  }, [modules.data, edges.data]);

  if (modules.error || edges.error)
    return <p className="empty">{(modules.error ?? edges.error)!.message}</p>;
  if (!modules.data || !edges.data) return <p className="empty">Laying out modules…</p>;
  if (layout.columns.length === 0)
    return <p className="empty">No JavaScript modules were found to draw.</p>;

  const hot = new Set<string>();
  if (selected)
    for (const e of layout.edges)
      if (e.from === selected || e.to === selected) hot.add(`${e.from}→${e.to}`);

  return (
    <>
      <div className="legend">
        <span>
          {layout.edges.length} resolved imports between {layout.pos.size} modules
        </span>
        {layout.truncated && <span>· showing the first {MAX_NODES} modules</span>}
        {edges.data?.truncated && (
          <span>
            · {edges.data.items.length} of {edges.data.total} imports loaded; relationships beyond
            that are not drawn
          </span>
        )}
        <span>· select a module (click or Tab + Enter) to trace its imports</span>
      </div>
      <div className="graph">
        <svg
          width={layout.width}
          height={layout.height}
          role="group"
          aria-label="Module dependency graph"
        >
          {layout.columns.map((c) => (
            <text key={c.role} className="column-title" x={c.x} y={24}>
              {c.title} ({c.items.length})
            </text>
          ))}
          {layout.edges.map((e, i) => {
            const a = layout.pos.get(e.from)!;
            const b = layout.pos.get(e.to)!;
            const key = `${e.from}→${e.to}`;
            const x1 = a.x + NODE_W;
            const y1 = a.y + NODE_H / 2;
            const x2 = b.x;
            const y2 = b.y + NODE_H / 2;
            const sameColumn = a.x === b.x;
            const d = sameColumn
              ? `M${a.x + NODE_W},${y1} C${a.x + NODE_W + 40},${y1} ${a.x + NODE_W + 40},${y2} ${a.x + NODE_W},${y2}`
              : `M${x1},${y1} C${x1 + GAP_X / 2},${y1} ${x2 - GAP_X / 2},${y2} ${x2},${y2}`;
            return (
              <path
                key={i}
                className={`edge${hot.has(key) ? " hot" : ""}${
                  e.kind === "dynamic-import" ? " unresolved" : ""
                }`}
                d={d}
              />
            );
          })}
          {layout.columns.flatMap((c) =>
            c.items.map((m) => {
              const p = layout.pos.get(m.id)!;
              const name = m.id.length > 30 ? `…${m.id.slice(-29)}` : m.id;
              return (
                <g
                  key={m.id}
                  className={`node${m.role === "main" ? " main" : ""}${
                    selected === m.id ? " selected" : ""
                  }`}
                  transform={`translate(${p.x},${p.y})`}
                  onClick={() => setSelected(selected === m.id ? null : m.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setSelected(selected === m.id ? null : m.id);
                    }
                  }}
                  tabIndex={0}
                  role="button"
                  aria-pressed={selected === m.id}
                  aria-label={`${m.id}, ${m.references} references`}
                  style={{ cursor: "pointer" }}
                >
                  <rect width={NODE_W} height={NODE_H} />
                  <title>{`${m.id}\n${m.references} references · ${m.ipc} IPC calls · ${m.size} bytes`}</title>
                  <text x={10} y={14}>
                    {name}
                  </text>
                  <text className="role" x={10} y={27}>
                    {m.references} refs{m.ipc ? ` · ${m.ipc} ipc` : ""}
                  </text>
                </g>
              );
            }),
          )}
        </svg>
      </div>
    </>
  );
}
