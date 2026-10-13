import type { Limitation } from "../model.js";

/**
 * Whole-program call graph normalized from one engine run. REA walks a graph by
 * issuing one engine request per node; hexvero fetches the complete edge list
 * once (radare2/rizin function list + global call graph, Ghidra's reference
 * manager over every function), caches it by content digest, and answers
 * callers, callees, neighborhoods and paths from memory with explicit depth and
 * node bounds. Nodes are identified by `id`: the entry address when the engine
 * reports one, otherwise the engine's unique flag name. Names are labels and may
 * repeat (C++ overloads, `run` in two classes), so lookups by name report
 * ambiguity instead of guessing.
 */

export interface GraphNode {
  /** Unique identity: entry address (`0x1000`, `EXTERNAL:1`) or unique engine name. */
  id: string;
  name: string;
  address: string | null;
  size: number | null;
  external: boolean;
  /** Other engine names for the same address (`main` for `entry0`, `sym._main`, …). */
  aliases?: string[];
}

export interface GraphEdge {
  from: string;
  to: string;
}

export interface CallGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** True when the engine or the output budget cut nodes or edges; relationships may be missing. */
  truncated: boolean;
  limitations: Limitation[];
}

export type GraphDirection = "callers" | "callees" | "both";

export interface NeighborhoodOptions {
  direction?: GraphDirection | undefined;
  /** Hops from the root (default 2, max 8). */
  maxDepth?: number | undefined;
  /** Nodes returned including the root (default 150, max 2000). */
  maxNodes?: number | undefined;
}

export interface Neighborhood {
  root: GraphNode;
  direction: GraphDirection;
  /** Node ids per hop; depth 0 is the root. */
  levels: Array<{ depth: number; ids: string[] }>;
  edges: GraphEdge[];
  nodes: GraphNode[];
  truncated: { depth: boolean; nodes: boolean; graph: boolean };
  /** Distinct functions reachable within maxDepth that maxNodes dropped (exact up to the traversal cap). */
  omitted: number;
  limitations: Limitation[];
}

export interface PathTrace {
  start: GraphNode;
  goal: GraphNode;
  direction: GraphDirection;
  /** Shortest path by node id, or null when the goal is unreachable within the bounds. */
  path: string[] | null;
  status: "found" | "not_reached" | "truncated";
  explored: number;
  limitations: Limitation[];
}

const MAX_NODES = 100_000;
const MAX_EDGES = 500_000;
/** Nodes a neighborhood traversal may visit while counting omissions. */
const TRAVERSAL_CAP = 50_000;

export interface NormalizeOptions {
  /** The engine output was cut (stdout cap, timeout); the graph is partial whatever it contains. */
  partial?: boolean | undefined;
  limitations?: Limitation[] | undefined;
}

/** Builds a CallGraph from the raw engine output of the `callgraph` operation. */
export function normalizeCallGraph(
  provider: string,
  raw: unknown,
  options: NormalizeOptions = {},
): CallGraph {
  const limitations: Limitation[] = [...(options.limitations ?? [])];
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const edgeKeys = new Set<string>();
  let truncated = options.partial === true;
  const addNode = (n: GraphNode): GraphNode | null => {
    const existing = nodes.get(n.id);
    if (existing) {
      if (existing.address === null && n.address !== null) existing.address = n.address;
      if (existing.size === null && n.size !== null) existing.size = n.size;
      return existing;
    }
    if (nodes.size >= MAX_NODES) {
      truncated = true;
      return null;
    }
    nodes.set(n.id, n);
    return n;
  };
  const addEdge = (from: string, to: string): void => {
    if (!nodes.has(from) || !nodes.has(to)) return;
    const key = `${from}\u0000${to}`;
    if (edgeKeys.has(key)) return;
    if (edges.length >= MAX_EDGES) {
      truncated = true;
      return;
    }
    edgeKeys.add(key);
    edges.push({ from, to });
  };

  if (provider === "ghidra") {
    const g = isRecord(raw) ? raw : {};
    for (const n of asArray(g["nodes"])) {
      if (!isRecord(n) || typeof n["address"] !== "string") continue;
      addNode({
        id: n["address"],
        name: typeof n["name"] === "string" ? n["name"] : n["address"],
        address: n["address"],
        size: typeof n["size"] === "number" ? n["size"] : null,
        external: n["external"] === true,
      });
    }
    for (const e of asArray(g["edges"])) {
      if (!isRecord(e) || typeof e["from"] !== "string" || typeof e["to"] !== "string") continue;
      if (!nodes.has(e["to"])) {
        const name = typeof e["toName"] === "string" ? e["toName"] : e["to"];
        addNode({ id: e["to"], name, address: e["to"], size: null, external: true });
      }
      addEdge(e["from"], e["to"]);
    }
    if (g["truncated"] === true || g["edgesTruncated"] === true) truncated = true;
    if (nodes.size === 0 && !options.partial)
      limitations.push({ code: "callgraph_empty", message: "Ghidra reported no functions." });
  } else {
    // radare2/rizin. `raw` is either labelled sections { functions, graph, flags } (what the
    // runner produces from the marker lines it asks the engine to print) or, for older callers,
    // a plain list of JSON documents in command order.
    const sections: Record<string, unknown> = isRecord(raw)
      ? raw
      : (() => {
          const docs = Array.isArray(raw) ? raw : [raw];
          return {
            functions: docs.find((d) => Array.isArray(d) && !isGraph(d)),
            graph: docs.find(isGraph),
          };
        })();
    // Functions are the nodes. Engines know one function under several names (rizin's graph says
    // `sym.func.1000005b0` where its function list says `sym._run_tool`), so every other name is
    // resolved to the function at the same address instead of becoming a second, edgeless node.
    const byAddress = new Map<string, GraphNode>();
    const byName = new Map<string, GraphNode>();
    const alias = (node: GraphNode, name: string): void => {
      // a real function name is never re-pointed by another function's alias
      if (!byName.has(name)) byName.set(name, node);
      if (name === node.name || GENERIC_FLAG.test(name)) return;
      node.aliases ??= [];
      if (!node.aliases.includes(name) && node.aliases.length < 8) node.aliases.push(name);
    };
    let sawFunctions = false;
    for (const item of asArray(sections["functions"])) {
      if (!isRecord(item) || typeof item["name"] !== "string") continue;
      const at = offsetOf(item);
      if (at === null) continue;
      sawFunctions = true;
      const node = addNode({
        id: item["name"],
        name: item["name"],
        address: hex(at),
        size: typeof item["size"] === "number" ? item["size"] : null,
        external: external(item["name"]),
      });
      if (!node) continue;
      byName.set(node.name, node);
      if (at !== 0 && !byAddress.has(hex(at))) byAddress.set(hex(at), node);
    }
    if (sawFunctions && sections["flags"] === undefined && isRecord(raw))
      limitations.push({
        code: "callgraph_aliases_missing",
        message: `${provider} returned no flag list, so functions answer only to the engine's own names (rizin: \`entry0\` rather than \`main\`).`,
      });
    for (const flag of asArray(sections["flags"])) {
      if (!isRecord(flag) || typeof flag["name"] !== "string") continue;
      const at = offsetOf(flag);
      const node = at === null ? undefined : byAddress.get(hex(at));
      if (node) alias(node, flag["name"]);
    }
    /** The node a graph entry refers to: by address first, then by any known name, else a new one. */
    const nodeFor = (name: string, at: number | null, size: number | null): GraphNode | null => {
      // Address 0 means "unresolved" for imports; several of them must not collapse into one.
      const known =
        (at === null || at === 0 ? undefined : byAddress.get(hex(at))) ?? byName.get(name);
      if (known) {
        alias(known, name);
        return known;
      }
      const node = addNode({
        id: name,
        name,
        address: at === null ? null : hex(at),
        size,
        external: external(name),
      });
      if (node) {
        byName.set(name, node);
        if (at !== null && at !== 0) byAddress.set(hex(at), node);
      }
      return node;
    };
    // Tail calls: a function that ends in a jump to another function's entry calls it, but the
    // engines' call graphs list only call instructions. rizin's function list carries every code
    // reference, so those jumps become edges; radare2 6 lists none, which is stated below.
    let sawCodeRefs = false;
    const tailCalls: Array<[string, string]> = [];
    for (const item of asArray(sections["functions"])) {
      if (!isRecord(item) || typeof item["name"] !== "string" || !Array.isArray(item["callrefs"]))
        continue;
      sawCodeRefs = true;
      const from = byName.get(item["name"]);
      if (!from) continue;
      for (const ref of item["callrefs"] as unknown[]) {
        if (!isRecord(ref) || (ref["type"] !== "CODE" && ref["type"] !== "JMP")) continue;
        const to = typeof ref["to"] === "number" ? ref["to"] : ref["addr"];
        const target = typeof to === "number" && to !== 0 ? byAddress.get(hex(to)) : undefined;
        if (target && target !== from) tailCalls.push([from.id, target.id]);
      }
    }
    let sawGraph = false;
    const graph = sections["graph"];
    if (Array.isArray(graph)) {
      // radare2 `agCj`: [{ name, size, imports: [names] }]
      for (const item of graph) {
        if (!isRecord(item) || typeof item["name"] !== "string" || !Array.isArray(item["imports"]))
          continue;
        sawGraph = true;
        const from = nodeFor(
          item["name"],
          null,
          typeof item["size"] === "number" ? item["size"] : null,
        );
        if (!from) continue;
        for (const to of item["imports"]) {
          if (typeof to !== "string") continue;
          const target = nodeFor(to, null, null);
          if (target) addEdge(from.id, target.id);
        }
      }
    } else if (isRecord(graph) && Array.isArray(graph["nodes"])) {
      // rizin `agC json`: { nodes: [{ id, title, offset, out_nodes: [ids] }] }
      sawGraph = true;
      const byId = new Map<number, GraphNode>();
      for (const n of graph["nodes"] as unknown[]) {
        if (!isRecord(n) || typeof n["id"] !== "number" || typeof n["title"] !== "string") continue;
        const node = nodeFor(n["title"], offsetOf(n), null);
        if (node) byId.set(n["id"], node);
      }
      for (const n of graph["nodes"] as unknown[]) {
        if (!isRecord(n) || typeof n["id"] !== "number") continue;
        const from = byId.get(n["id"]);
        if (!from) continue;
        for (const out of asArray(n["out_nodes"])) {
          const to = typeof out === "number" ? byId.get(out) : undefined;
          if (to) addEdge(from.id, to.id);
        }
      }
    }
    if (sawGraph) for (const [from, to] of tailCalls) addEdge(from, to);
    if (sawGraph && sawFunctions && !sawCodeRefs && isRecord(raw))
      limitations.push({
        code: "callgraph_tail_calls_unknown",
        message: `${provider} lists call instructions only: a function that ends in a jump to another function (a tail call, common in optimized builds) has no edge here, so a path may exist that is not shown.`,
      });
    if (!sawGraph && !options.partial)
      limitations.push({
        code: "callgraph_missing",
        message: `${provider} returned no call graph document; only function nodes are available.`,
      });
    if (!sawFunctions && !sawGraph && !options.partial)
      limitations.push({ code: "callgraph_empty", message: `${provider} reported no functions.` });
  }
  if (truncated && !limitations.some((l) => l.code === "callgraph_truncated"))
    limitations.push({
      code: "callgraph_truncated",
      message: options.partial
        ? "The engine output was cut before the graph was complete; relationships may be missing."
        : `The graph was cut at ${MAX_NODES} nodes / ${MAX_EDGES} edges; relationships beyond that are unknown.`,
    });
  return { nodes: [...nodes.values()], edges, truncated, limitations };
}

/** radare2/rizin flag names of imported or relocated symbols. */
function external(name: string): boolean {
  return /^sym\.imp\.|^reloc\./.test(name);
}

/** True for either engine's call-graph document (rizin: `{nodes}`, radare2: `[{imports}]`). */
function isGraph(d: unknown): boolean {
  return (
    (isRecord(d) && Array.isArray(d["nodes"])) ||
    (Array.isArray(d) && d.some((i) => isRecord(i) && Array.isArray(i["imports"])))
  );
}

/** Entry address of an engine record: radare2 ≥ 6 says `addr`, older radare2 and rizin `offset`. */
function offsetOf(item: Record<string, unknown>): number | null {
  const at = typeof item["offset"] === "number" ? item["offset"] : item["addr"];
  return typeof at === "number" ? at : null;
}

const hex = (n: number): string => `0x${n.toString(16)}`;

/** Engine-internal flag names that say nothing about a function's identity. */
const GENERIC_FLAG =
  /^(pc|sp|bp|lr|entry\d*|section\.|segment\.|loc\.|str\.|sym\.func\.|fcn\.[0-9a-f]+$|reloc\.|obj\.)/i;

/** Lower-cased name without engine prefixes (`sym.imp.`, `sym.`, `fcn.`, `FUN_`, leading underscores), applied repeatedly. */
function bare(name: string): string {
  let out = name.toLowerCase();
  for (let i = 0; i < 4; i++) {
    const next = out.replace(/^(sym\.imp\.|sym\.|fcn\.|fun_|_+)/, "");
    if (next === out) break;
    out = next;
  }
  return out;
}

function canonicalAddress(text: string): string | null {
  const m = /^(?:0x)?([0-9a-f]+)$/i.exec(text.trim());
  return m ? `0x${m[1]!.toLowerCase().replace(/^0+(?=.)/, "")}` : null;
}

/**
 * Finds the node a user means: exact id, exact name, address (with or without `0x`/leading
 * zeros), case-insensitive name, then the bare name behind engine prefixes. Several matches are
 * reported as candidates instead of picking one.
 */
export function resolveNode(
  graph: CallGraph,
  spec: string,
): { node: GraphNode | null; candidates: string[] } {
  const wanted = spec.trim();
  if (!wanted) return { node: null, candidates: [] };
  const pick = (list: GraphNode[]): { node: GraphNode | null; candidates: string[] } | null => {
    if (list.length === 1) return { node: list[0]!, candidates: [] };
    if (list.length > 1)
      return { node: null, candidates: list.slice(0, 20).map((n) => `${n.name} (${n.id})`) };
    return null;
  };
  const names = (n: GraphNode): string[] => [n.name, ...(n.aliases ?? [])];
  const byId = graph.nodes.find((n) => n.id === wanted);
  if (byId) return { node: byId, candidates: [] };
  const exact = pick(graph.nodes.filter((n) => names(n).includes(wanted)));
  if (exact) return exact;
  const address = canonicalAddress(wanted);
  if (address) {
    const byAddress = pick(
      graph.nodes.filter((n) => n.address !== null && canonicalAddress(n.address) === address),
    );
    if (byAddress) return byAddress;
  }
  const lower = wanted.toLowerCase();
  const loose = pick(
    graph.nodes.filter((n) =>
      names(n).some((x) => x.toLowerCase() === lower || bare(x) === bare(lower)),
    ),
  );
  if (loose) return loose;
  const contains = graph.nodes.filter((n) => names(n).some((x) => x.toLowerCase().includes(lower)));
  return { node: null, candidates: contains.slice(0, 20).map((n) => `${n.name} (${n.id})`) };
}

interface Adjacency {
  out: Map<string, string[]>;
  in: Map<string, string[]>;
}

/** Sorted, de-duplicated neighbor lists built in linear time. */
function adjacency(graph: CallGraph): Adjacency {
  const out = new Map<string, Set<string>>();
  const inc = new Map<string, Set<string>>();
  for (const e of graph.edges) {
    (out.get(e.from) ?? out.set(e.from, new Set()).get(e.from)!).add(e.to);
    (inc.get(e.to) ?? inc.set(e.to, new Set()).get(e.to)!).add(e.from);
  }
  return { out: sortedLists(out), in: sortedLists(inc) };
}

function sortedLists(m: Map<string, Set<string>>): Map<string, string[]> {
  return new Map([...m].map(([k, v]) => [k, [...v].toSorted()]));
}

function nextOf(adj: Adjacency, direction: GraphDirection, id: string): string[] {
  if (direction === "callees") return adj.out.get(id) ?? [];
  if (direction === "callers") return adj.in.get(id) ?? [];
  const both = new Set([...(adj.out.get(id) ?? []), ...(adj.in.get(id) ?? [])]);
  return [...both].toSorted();
}

/** Direct callers (ids) of a node, sorted. */
export function callersOf(graph: CallGraph, id: string): string[] {
  return [...new Set(graph.edges.filter((e) => e.to === id).map((e) => e.from))].toSorted();
}

/** Direct callees (ids) of a node, sorted. */
export function calleesOf(graph: CallGraph, id: string): string[] {
  return [...new Set(graph.edges.filter((e) => e.from === id).map((e) => e.to))].toSorted();
}

/**
 * Bounded breadth-first neighborhood around `root`. The traversal visits every node within
 * maxDepth (up to a traversal cap) so `omitted` counts distinct reachable functions that maxNodes
 * dropped; depth truncation is judged independently of the node cap.
 */
export function neighborhood(
  graph: CallGraph,
  root: GraphNode,
  options: NeighborhoodOptions = {},
): Neighborhood {
  const direction = options.direction ?? "callees";
  const maxDepth = clamp(options.maxDepth ?? 2, 0, 8);
  const maxNodes = clamp(options.maxNodes ?? 150, 1, 2000);
  const adj = adjacency(graph);
  const visited = new Set<string>([root.id]);
  const kept = new Set<string>([root.id]);
  const levels: Array<{ depth: number; ids: string[] }> = [{ depth: 0, ids: [root.id] }];
  let frontier = [root.id];
  let traversalCapped = false;
  for (let depth = 1; depth <= maxDepth && frontier.length > 0 && !traversalCapped; depth++) {
    const next: string[] = [];
    const keptHere: string[] = [];
    for (const id of frontier) {
      for (const n of nextOf(adj, direction, id)) {
        if (visited.has(n)) continue;
        if (visited.size >= TRAVERSAL_CAP) {
          traversalCapped = true;
          break;
        }
        visited.add(n);
        next.push(n);
        if (kept.size < maxNodes) {
          kept.add(n);
          keptHere.push(n);
        }
      }
      if (traversalCapped) break;
    }
    if (keptHere.length > 0) levels.push({ depth, ids: keptHere });
    frontier = next;
  }
  const depthTruncated =
    !traversalCapped &&
    frontier.some((id) => nextOf(adj, direction, id).some((n) => !visited.has(n)));
  const omitted = visited.size - kept.size;
  const nodesTruncated = omitted > 0 || traversalCapped;
  const edges = graph.edges.filter((e) => kept.has(e.from) && kept.has(e.to));
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const nodes = [...kept].map(
    (id) => byId.get(id) ?? { id, name: id, address: null, size: null, external: true },
  );
  const limitations: Limitation[] = [...graph.limitations];
  if (omitted > 0)
    limitations.push({
      code: "neighborhood_nodes_capped",
      message: `${omitted}${traversalCapped ? "+" : ""} reachable function(s) within ${maxDepth} hop(s) omitted by maxNodes=${maxNodes}; raise maxNodes or lower maxDepth.`,
    });
  if (traversalCapped)
    limitations.push({
      code: "neighborhood_traversal_capped",
      message: `Traversal stopped after ${TRAVERSAL_CAP} functions; omitted counts are lower bounds.`,
    });
  if (depthTruncated)
    limitations.push({
      code: "neighborhood_depth_capped",
      message: `Functions beyond ${maxDepth} hop(s) exist and are not shown.`,
    });
  return {
    root,
    direction,
    levels,
    edges,
    nodes,
    truncated: { depth: depthTruncated, nodes: nodesTruncated, graph: graph.truncated },
    omitted,
    limitations,
  };
}

/**
 * Shortest path from start to goal following calls (callees), reverse (callers) or either
 * (both). The budget bounds discovered nodes; a goal is recognized the moment it is discovered.
 */
export function tracePath(
  graph: CallGraph,
  start: GraphNode,
  goal: GraphNode,
  direction: GraphDirection = "callees",
  maxExplored = 50_000,
): PathTrace {
  const adj = adjacency(graph);
  const parent = new Map<string, string | null>([[start.id, null]]);
  const queue = [start.id];
  let head = 0;
  let status: PathTrace["status"] = start.id === goal.id ? "found" : "not_reached";
  search: while (head < queue.length && status === "not_reached") {
    const id = queue[head++]!;
    for (const n of nextOf(adj, direction, id)) {
      if (parent.has(n)) continue;
      if (parent.size >= maxExplored) {
        status = "truncated";
        break search;
      }
      parent.set(n, id);
      if (n === goal.id) {
        status = "found";
        break search;
      }
      queue.push(n);
    }
  }
  let path: string[] | null = null;
  if (status === "found") {
    path = [];
    for (let at: string | null = goal.id; at !== null; at = parent.get(at) ?? null)
      path.unshift(at);
  }
  const limitations: Limitation[] = [...graph.limitations];
  if (status === "truncated")
    limitations.push({
      code: "trace_explored_capped",
      message: `Search stopped after discovering ${maxExplored} functions without reaching the goal.`,
    });
  if (status === "not_reached" && graph.truncated)
    limitations.push({
      code: "trace_graph_truncated",
      message: "The goal was not reached, but the graph is partial, so a path may still exist.",
    });
  return { start, goal, direction, path, status, explored: parent.size, limitations };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.floor(Number.isFinite(n) ? n : lo)));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
