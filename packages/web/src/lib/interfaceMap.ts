/**
 * Layout of the interface map: windows → preload members → IPC channels → main-process ends,
 * built from the `interfaces` collection (mirrors `InterfaceRow` of @hexvero/core; the UI does
 * not import core code). Pure functions only, so the grouping, the caps and the order are tested
 * without a browser.
 *
 * The map draws what the code wires and how each link was read. It joins nothing itself: every
 * node and edge comes from a row, and every row keeps the file:line it was read at.
 */

export interface InterfaceEnd {
  file: string;
  line: number;
  api: string;
  via?: string;
}

export type Link = "direct" | "resolved" | "unresolved" | "unknown" | "none";

export interface InterfaceRow {
  api: string;
  member: string | null;
  world: "main" | "isolated";
  file: string;
  line: number;
  windows: string[];
  channel: string | null;
  direction: "to-main" | "to-renderer" | "both" | null;
  ends: InterfaceEnd[];
  endsTotal: number;
  endsTruncated: boolean;
  link: Link;
  reason?: string;
}

export type Column = "window" | "member" | "channel" | "handler";

export interface MapNode {
  id: string;
  column: Column;
  /** What the node shows (raw target text; pass it through `visible` before rendering). */
  label: string;
  /** Second line: how the node was read. */
  note: string;
  /** Indexes into the rows the map was built from. */
  rows: number[];
  /** A placeholder for something that could not be read, not a place in the code. */
  placeholder: boolean;
  y: number;
}

/** How an edge was read; drawn solid, solid with a marker, or dashed. */
export type EdgeKind = "window" | "direct" | "resolved" | "unresolved" | "unknown";

export interface MapEdge {
  id: string;
  from: string;
  to: string;
  kind: EdgeKind;
  rows: number[];
  /** Why the edge is dashed. */
  reason?: string;
}

export interface InterfaceMap {
  columns: Record<Column, MapNode[]>;
  nodes: Map<string, MapNode>;
  edges: MapEdge[];
  /** Members drawn and members that matched: `shown < matched` means the map is capped. */
  shown: number;
  matched: number;
}

export const MAX_MEMBERS = 300;
export const NODE_H = 36;
export const GAP_Y = 10;
export const TOP = 40;

export const CHANNEL_UNREAD = "c?";
export const END_NOT_FOUND = "h?";

/** `window.api.member` as the page calls it. */
export const memberPath = (row: Pick<InterfaceRow, "api" | "member">): string =>
  `window.${row.api}${row.member === null ? "" : `.${row.member}`}`;

/**
 * The identity a comparison reports an interface row under (`file::api::member`, the compare
 * key of the collection), so a change row can open the map at its member.
 */
export const rowKey = (row: Pick<InterfaceRow, "file" | "api" | "member">): string =>
  `${row.file}::${row.api}::${String(row.member ?? null)}`;

export const memberId = (row: Pick<InterfaceRow, "file" | "api" | "member">): string =>
  `m:${rowKey(row)}`;
const windowId = (w: string): string => `w:${w}`;
const channelId = (c: string): string => `c:${c}`;
const endId = (e: InterfaceEnd): string => `h:${e.file}:${e.line}:${e.api}`;
const edgeId = (from: string, to: string): string => `e:${from}→${to}`;

/** How a member's link reads, in words (never only a color or a line style). */
export const LINK_WORDS: Record<Link, string> = {
  direct: "direct",
  resolved: "resolved",
  unresolved: "channel not read",
  unknown: "end not found",
  none: "no handler found",
};

export const LINK_MEANING: Record<Link, string> = {
  direct: "every end names the channel as a literal",
  resolved: "an end was reached through a constant, an alias, a wrapper or the resolver",
  unresolved: "the member's own channel could not be read",
  unknown: "no end was found, but the analysis could not read everything, so one may exist",
  none: "no end for this channel in any file read",
};

/** Case-insensitive match on member, channel, windows and handler places. */
export function matches(row: InterfaceRow, text: string): boolean {
  const q = text.trim().toLowerCase();
  if (!q) return true;
  const hay = [
    memberPath(row),
    row.file,
    row.channel ?? "",
    ...row.windows,
    ...row.ends.flatMap((e) => [`${e.file}:${e.line}`, e.api, e.via ?? ""]),
  ];
  return hay.some((h) => h.toLowerCase().includes(q));
}

/** Indexes of the rows that match `text`, in collection order. */
export function filterRows(rows: readonly InterfaceRow[], text: string): number[] {
  const out: number[] = [];
  rows.forEach((row, i) => {
    if (matches(row, text)) out.push(i);
  });
  return out;
}

/**
 * Lays out the rows at `indexes` (at most `max` members). Members keep collection order (file,
 * then line); every other column is ordered by the first member it connects to, which keeps the
 * edges short and the layout the same for the same data.
 */
export function buildMap(
  rows: readonly InterfaceRow[],
  indexes: readonly number[],
  max = MAX_MEMBERS,
): InterfaceMap {
  const nodes = new Map<string, MapNode & { order: number }>();
  const edges = new Map<string, MapEdge>();
  const drawn = indexes.slice(0, Math.max(0, max));
  const node = (
    id: string,
    column: Column,
    label: string,
    note: string,
    row: number,
    order: number,
    placeholder = false,
  ): void => {
    const n = nodes.get(id);
    if (n) {
      if (!n.rows.includes(row)) n.rows.push(row);
      return;
    }
    nodes.set(id, { id, column, label, note, rows: [row], placeholder, y: 0, order });
  };
  const edge = (from: string, to: string, kind: EdgeKind, row: number, reason?: string): void => {
    const id = edgeId(from, to);
    const e = edges.get(id);
    if (e) {
      if (!e.rows.includes(row)) e.rows.push(row);
      return;
    }
    edges.set(id, { id, from, to, kind, rows: [row], ...(reason ? { reason } : {}) });
  };

  drawn.forEach((i, order) => {
    const row = rows[i]!;
    const m = memberId(row);
    node(m, "member", memberPath(row), `${row.world} world · ${LINK_WORDS[row.link]}`, i, order);
    for (const w of row.windows) {
      node(windowId(w), "window", w, "loads this preload", i, order);
      edge(windowId(w), m, "window", i);
    }
    if (row.channel === null) {
      node(
        CHANNEL_UNREAD,
        "channel",
        "channel not read",
        "built at run time or absent",
        i,
        order,
        true,
      );
      edge(m, CHANNEL_UNREAD, "unresolved", i, row.reason);
      return;
    }
    const c = channelId(row.channel);
    node(c, "channel", row.channel, row.direction ?? "no end", i, order);
    edge(m, c, row.link === "resolved" ? "resolved" : "direct", i);
    if (row.link === "unknown") {
      node(END_NOT_FOUND, "handler", "end not found", "analysis has blind spots", i, order, true);
      edge(c, END_NOT_FOUND, "unknown", i, row.reason);
    }
    for (const e of row.ends) {
      node(
        endId(e),
        "handler",
        `${e.file}:${e.line}`,
        e.via ? `${e.api} · via ${e.via}` : e.api,
        i,
        order,
      );
      edge(c, endId(e), e.via ? "resolved" : "direct", i);
    }
  });

  const columns: Record<Column, MapNode[]> = { window: [], member: [], channel: [], handler: [] };
  for (const n of nodes.values()) columns[n.column].push(n);
  for (const list of Object.values(columns)) {
    // placeholders go last so real places stay together
    list.sort(
      (a, b) =>
        Number(a.placeholder) - Number(b.placeholder) ||
        (a as MapNode & { order: number }).order - (b as MapNode & { order: number }).order ||
        a.label.localeCompare(b.label),
    );
    list.forEach((n, k) => (n.y = TOP + k * (NODE_H + GAP_Y)));
  }
  return {
    columns,
    nodes,
    edges: [...edges.values()],
    shown: drawn.length,
    matched: indexes.length,
  };
}

/** The rows a node or an edge stands for, in collection order. */
export function rowsOf(map: InterfaceMap, id: string): number[] {
  const item = map.nodes.get(id) ?? map.edges.find((e) => e.id === id);
  return item ? item.rows.toSorted((a, b) => a - b) : [];
}

/** The edges touching `id` (or the edge itself): what a selection highlights. */
export function hotEdges(map: InterfaceMap, id: string | null): Set<string> {
  const hot = new Set<string>();
  if (!id) return hot;
  if (id.startsWith("e:")) {
    hot.add(id);
    return hot;
  }
  const rows = new Set(map.nodes.get(id)?.rows ?? []);
  for (const e of map.edges)
    if (e.from === id || e.to === id || (id.startsWith("m:") && e.rows.some((r) => rows.has(r))))
      hot.add(e.id);
  return hot;
}

/**
 * "3 of 41 ends shown; all of them are in the ipc list" when the collection kept only the first
 * ends of a row (contract C4): every end is a row of the `ipc` collection with this channel.
 */
export const endsNote = (row: Pick<InterfaceRow, "ends" | "endsTotal" | "endsTruncated">): string =>
  row.endsTruncated
    ? `${row.ends.length} of ${row.endsTotal} ends shown; all of them are in the ipc list`
    : "";

/** Shortens a label from the left (paths end in the part that tells them apart). */
export const clip = (text: string, max: number): string =>
  text.length > max ? `…${text.slice(-(max - 1))}` : text;
