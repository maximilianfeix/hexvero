import { describe, expect, it } from "vitest";
import {
  callersOf,
  calleesOf,
  neighborhood,
  normalizeCallGraph,
  resolveNode,
  tracePath,
} from "../src/providers/graph.js";

const radareDocs = [
  [
    { name: "main", addr: 0x1000, size: 40 }, // radare2 >= 6 says addr; older builds and rizin say offset
    { name: "sym.parse", offset: 0x1100, size: 80 },
    { name: "fcn.00001200", offset: 0x1200, size: 8 },
  ],
  [
    { name: "main", size: 40, imports: ["sym.parse", "sym.imp.puts"] },
    { name: "sym.parse", size: 80, imports: ["fcn.00001200", "sym.imp.strlen"] },
    { name: "fcn.00001200", size: 8, imports: ["sym.imp.puts"] },
  ],
];

describe("call graph", () => {
  const graph = normalizeCallGraph("radare2", radareDocs);

  it("normalizes radare2 and Ghidra output into one shape", () => {
    expect(graph.nodes.map((n) => `${n.name}@${n.address}${n.external ? "!" : ""}`)).toEqual([
      "main@0x1000",
      "sym.parse@0x1100",
      "fcn.00001200@0x1200",
      "sym.imp.puts@null!",
      "sym.imp.strlen@null!",
    ]);
    expect(graph.edges).toHaveLength(5);
    expect(graph.limitations).toEqual([]);
    const onlyFunctions = normalizeCallGraph("rizin", [radareDocs[0]]);
    expect(onlyFunctions.limitations[0]?.code).toBe("callgraph_missing");
    // rizin: `agC json` graph with numeric node ids
    const rizin = normalizeCallGraph("rizin", [
      radareDocs[0],
      {
        nodes: [
          { id: 0, title: "main", offset: 0x1000, out_nodes: [1] },
          { id: 1, title: "sym.imp.puts", offset: 0x3000, out_nodes: [] },
        ],
      },
    ]);
    expect(rizin.edges).toEqual([{ from: "main", to: "sym.imp.puts" }]);
    expect(rizin.nodes.find((n) => n.name === "sym.imp.puts")?.address).toBe("0x3000");
    // Ghidra: nodes keyed by address; two functions may share a name
    const ghidra = normalizeCallGraph("ghidra", {
      nodes: [
        { name: "run", address: "00101000" },
        { name: "run", address: "00102000" },
      ],
      edges: [{ from: "00102000", to: "EXTERNAL:00000001", toName: "system" }],
      truncated: true,
    });
    expect(ghidra.nodes.map((n) => `${n.id}:${n.name}`)).toEqual([
      "00101000:run",
      "00102000:run",
      "EXTERNAL:00000001:system",
    ]);
    expect(ghidra.truncated).toBe(true);
    expect(ghidra.limitations.map((l) => l.code)).toEqual(["callgraph_truncated"]);
    expect(resolveNode(ghidra, "run").node).toBeNull();
    expect(resolveNode(ghidra, "run").candidates).toEqual(["run (00101000)", "run (00102000)"]);
    expect(resolveNode(ghidra, "0x101000").node?.id).toBe("00101000");
    expect(normalizeCallGraph("ghidra", null).limitations[0]?.code).toBe("callgraph_empty");
    const partial = normalizeCallGraph("radare2", [radareDocs[0]], { partial: true });
    expect(partial.truncated).toBe(true);
    expect(partial.limitations.map((l) => l.code)).toEqual(["callgraph_truncated"]);
  });

  it("resolves nodes by name, address and bare name", () => {
    expect(resolveNode(graph, "main").node?.name).toBe("main");
    expect(resolveNode(graph, "0x1100").node?.name).toBe("sym.parse");
    expect(resolveNode(graph, "1200").node?.name).toBe("fcn.00001200");
    expect(resolveNode(graph, "parse").node?.name).toBe("sym.parse");
    expect(resolveNode(graph, "PUTS").node?.name).toBe("sym.imp.puts");
    expect(resolveNode(graph, "sym")).toEqual({
      node: null,
      candidates: [
        "sym.parse (sym.parse)",
        "sym.imp.puts (sym.imp.puts)",
        "sym.imp.strlen (sym.imp.strlen)",
      ],
    });
    expect(resolveNode(graph, "  ").node).toBeNull();
  });

  it("lists direct relationships", () => {
    expect(callersOf(graph, "sym.imp.puts")).toEqual(["fcn.00001200", "main"]);
    expect(calleesOf(graph, "sym.parse")).toEqual(["fcn.00001200", "sym.imp.strlen"]);
    expect(calleesOf(graph, "sym.imp.puts")).toEqual([]);
  });

  it("bounds neighborhoods by depth and node count and says what was cut", () => {
    const main = resolveNode(graph, "main").node!;
    const full = neighborhood(graph, main, { maxDepth: 3, maxNodes: 50 });
    expect(full.levels).toEqual([
      { depth: 0, ids: ["main"] },
      { depth: 1, ids: ["sym.imp.puts", "sym.parse"] },
      { depth: 2, ids: ["fcn.00001200", "sym.imp.strlen"] },
    ]);
    expect(full.edges).toHaveLength(5);
    expect(full.truncated).toEqual({ depth: false, nodes: false, graph: false });
    const shallow = neighborhood(graph, main, { maxDepth: 1 });
    expect(shallow.levels).toHaveLength(2);
    expect(shallow.truncated.depth).toBe(true);
    expect(shallow.limitations.map((l) => l.code)).toEqual(["neighborhood_depth_capped"]);
    // Distinct reachable functions within depth 3 are 5; a cap of 2 omits exactly 3, and the
    // depth cut is judged independently of the node cap.
    const tiny = neighborhood(graph, main, { maxDepth: 3, maxNodes: 2 });
    expect(tiny.nodes.map((n) => n.name)).toEqual(["main", "sym.imp.puts"]);
    expect(tiny.omitted).toBe(3);
    expect(tiny.truncated).toEqual({ depth: false, nodes: true, graph: false });
    const diamond = normalizeCallGraph("radare2", [
      [],
      [
        { name: "r", imports: ["a", "b"] },
        { name: "a", imports: ["x"] },
        { name: "b", imports: ["x"] },
      ],
    ]);
    const capped = neighborhood(diamond, resolveNode(diamond, "r").node!, {
      maxDepth: 2,
      maxNodes: 3,
    });
    expect(capped.omitted).toBe(1);
    const up = neighborhood(graph, resolveNode(graph, "puts").node!, {
      direction: "callers",
      maxDepth: 8,
    });
    expect(up.levels.map((l) => l.ids)).toEqual([
      ["sym.imp.puts"],
      ["fcn.00001200", "main"],
      ["sym.parse"],
    ]);
    const both = neighborhood(graph, resolveNode(graph, "parse").node!, {
      direction: "both",
      maxDepth: 1,
    });
    expect(both.levels[1]?.ids).toEqual(["fcn.00001200", "main", "sym.imp.strlen"]);
  });

  it("traces shortest paths and reports unreachable goals honestly", () => {
    const main = resolveNode(graph, "main").node!;
    const strlen = resolveNode(graph, "strlen").node!;
    const found = tracePath(graph, main, strlen);
    expect(found.status).toBe("found");
    expect(found.path).toEqual(["main", "sym.parse", "sym.imp.strlen"]);
    const reverse = tracePath(graph, strlen, main, "callers");
    expect(reverse.path).toEqual(["sym.imp.strlen", "sym.parse", "main"]);
    const none = tracePath(graph, strlen, main);
    expect(none.status).toBe("not_reached");
    expect(none.path).toBeNull();
    expect(tracePath(graph, strlen, main, "both").path).toEqual([
      "sym.imp.strlen",
      "sym.parse",
      "main",
    ]);
    const capped = tracePath(graph, main, strlen, "callees", 2);
    expect(capped.status).toBe("truncated");
    expect(capped.explored).toBeLessThanOrEqual(2);
    expect(capped.limitations.map((l) => l.code)).toEqual(["trace_explored_capped"]);
    // A goal discovered within the budget is found even when the budget would end the search next.
    const star = normalizeCallGraph("radare2", [[], [{ name: "r", imports: ["a", "z"] }]]);
    const direct = tracePath(
      star,
      resolveNode(star, "r").node!,
      resolveNode(star, "z").node!,
      "callees",
      3,
    );
    expect(direct.status).toBe("found");
    expect(direct.path).toEqual(["r", "z"]);
    expect(tracePath(graph, main, main).path).toEqual(["main"]);
  });

  it("merges engine aliases by address so rizin graphs keep their edges (regression)", () => {
    // Real rizin 0.9.1 output shape: the function list says sym._run_tool, the graph says
    // sym.func.1000005b0 for the same address, and main only exists as a flag on entry0.
    const rz = normalizeCallGraph("rizin", {
      functions: [
        { name: "sym._run_tool", offset: 0x1000005b0, size: 76 },
        { name: "entry0", offset: 0x1000005fc, size: 108 },
        { name: "sym.imp.system", offset: 0x10000068c, size: 12 },
      ],
      graph: {
        nodes: [
          { id: 0, title: "entry0", offset: 0x1000005fc, out_nodes: [1] },
          { id: 1, title: "sym.func.1000005b0", offset: 0x1000005b0, out_nodes: [] },
          { id: 2, title: "sym._run_tool", offset: 0x1000005b0, out_nodes: [3] },
          { id: 3, title: "sym.imp.system", offset: 0x10000068c, out_nodes: [] },
        ],
      },
      flags: [
        { name: "main", offset: 0x1000005fc },
        { name: "sym._main", offset: 0x1000005fc },
        { name: "pc", offset: 0x1000005fc },
        { name: "sym.func.1000005fc", offset: 0x1000005fc },
      ],
    });
    expect(rz.nodes.map((n) => n.name)).toEqual(["sym._run_tool", "entry0", "sym.imp.system"]);
    expect(rz.edges).toEqual([
      { from: "entry0", to: "sym._run_tool" },
      { from: "sym._run_tool", to: "sym.imp.system" },
    ]);
    const main = resolveNode(rz, "main").node!;
    expect(main.name).toBe("entry0");
    expect(main.aliases).toEqual(["main", "sym._main"]);
    expect(resolveNode(rz, "run_tool").node?.name).toBe("sym._run_tool");
    expect(tracePath(rz, main, resolveNode(rz, "system").node!).path).toEqual([
      "entry0",
      "sym._run_tool",
      "sym.imp.system",
    ]);
    // a missing graph section is reported, never mistaken for the function list
    const noGraph = normalizeCallGraph("rizin", { functions: [{ name: "entry0", offset: 1 }] });
    expect(noGraph.limitations.map((l) => l.code).toSorted()).toEqual([
      "callgraph_aliases_missing",
      "callgraph_missing",
    ]);
  });

  it("does not merge unresolved imports at address 0 and reports a missing alias list", () => {
    const g = normalizeCallGraph("rizin", {
      functions: [{ name: "entry0", offset: 0x1000, size: 8 }],
      graph: {
        nodes: [
          { id: 0, title: "entry0", offset: 0x1000, out_nodes: [1, 2] },
          { id: 1, title: "sym.imp.__gmon_start__", offset: 0, out_nodes: [] },
          { id: 2, title: "sym.imp.puts", offset: 0, out_nodes: [] },
        ],
      },
    });
    expect(g.edges).toEqual([
      { from: "entry0", to: "sym.imp.__gmon_start__" },
      { from: "entry0", to: "sym.imp.puts" },
    ]);
    expect(g.limitations.map((l) => l.code)).toEqual(["callgraph_aliases_missing"]);
    expect(g.truncated).toBe(false);
    // an alias never re-points another function's real name
    const clash = normalizeCallGraph("radare2", {
      functions: [
        { name: "fcn.1000", addr: 0x1000 },
        { name: "foo", addr: 0x2000 },
      ],
      graph: [{ name: "fcn.1000", imports: ["foo"] }],
      flags: [{ name: "foo", addr: 0x1000 }],
    });
    expect(clash.edges).toEqual([{ from: "fcn.1000", to: "foo" }]);
  });
});
