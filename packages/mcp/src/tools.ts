import {
  AnalysisError,
  compact,
  compareItems,
  neighborhood,
  originalPositionFor,
  resolveNode,
  Session,
  tracePath,
  type CallGraph,
} from "@hexvero/core";
import { z } from "zod";

/**
 * Tool catalog. Kept deliberately small: fifteen tools whose combined
 * discovery payload stays under 32 KiB so that constrained MCP clients keep
 * working. Lists come back paged; anything bigger goes to a file.
 */

const targetId = z.string().min(3).describe("Target id returned by hexvero_open");
const paging = {
  offset: z.number().int().min(0).optional().describe("First item index (default 0)"),
  limit: z.number().int().min(1).max(2000).optional().describe("Items per page (default 100)"),
  text: z.string().optional().describe("Case-insensitive substring filter on each item"),
};

export const toolSchemas = {
  hexvero_open: {
    title: "Open target",
    description:
      "Register a local file or directory for analysis. Returns its id, size, hash and detected format. Ids are stable per content.",
    input: { path: z.string().describe("Absolute or relative path") },
  },
  hexvero_list: {
    title: "List targets",
    description: "List targets opened in this session.",
    input: {},
  },
  hexvero_close: {
    title: "Close target",
    description: "Release a target and its retained analysis.",
    input: { targetId },
  },
  hexvero_analyze: {
    title: "Analyze target",
    description:
      "Run the built-in analyzer for the target's format (ELF/PE/Mach-O, Go, .NET, WASM, EVM, SQLite, plist, APK, ZIP, Electron ASAR, JavaScript apps, source maps, HAR). Returns a summary, findings with confidence, limitations, a compact overview and the collections available for paging.",
    input: { targetId },
  },
  hexvero_collection: {
    title: "Page a collection",
    description:
      "Page through one named list from the analysis, e.g. symbols, imports, exports, sections, libraries, types, methods, pinvokes, selectors, instructions, tables, columns, requests, endpoints, permissions, components, modules, edges, ipcChannels, findings. Use hexvero_analyze to see which exist.",
    input: { targetId, collection: z.string(), ...paging },
  },
  hexvero_strings: {
    title: "Strings",
    description:
      "Printable ASCII (and optional UTF-16LE) strings with offsets and tags (url, path, email, ip, format, secret-ish, base64-ish).",
    input: {
      targetId,
      ...paging,
      minLength: z.number().int().min(2).max(64).optional(),
      utf16: z.boolean().optional(),
      tag: z.string().optional().describe("Only strings carrying this tag"),
    },
  },
  hexvero_bytes: {
    title: "Read bytes",
    description: "Read a bounded window (max 64 KiB) of the target as hex plus an ASCII gutter.",
    input: {
      targetId,
      offset: z.number().int().min(0),
      length: z.number().int().min(1).max(65536),
    },
  },
  hexvero_export: {
    title: "Export analysis",
    description:
      "Write the complete analysis as JSON to a file and return its path and size. Use this instead of paging when you need everything.",
    input: {
      targetId,
      path: z.string().describe("Absolute destination file path; refused when the file exists"),
      overwrite: z.boolean().optional().describe("Replace an existing file (default false)"),
    },
  },
  hexvero_recover: {
    title: "Recover sources",
    description:
      "Write recoverable sources into a new directory: the modules of a webpack/Rspack/browserify/esbuild bundle (one file each plus hexvero-bundle.json with requires/exports), or the original files embedded in a source map (sourcesContent). No engine needed; nothing is executed.",
    input: { targetId, outputDir: z.string().describe("Absent or empty directory to write into") },
  },
  hexvero_unknowns: {
    title: "Unknowns ledger",
    description:
      "Record a material question the investigation could not answer (with what was already checked), list open or resolved unknowns, or resolve one. Unknowns are exported with the analysis so reports never silently drop them.",
    input: {
      action: z.enum(["record", "list", "resolve", "remove"]),
      targetId: z.string().optional().describe("Target the question belongs to"),
      question: z.string().optional().describe("record: the open question"),
      checked: z
        .array(z.string())
        .optional()
        .describe("record: collections, offsets or tools already examined"),
      id: z.string().optional().describe("resolve: the unknown's id"),
      resolution: z.string().optional().describe("resolve: what settled it, with evidence"),
      status: z.enum(["open", "resolved"]).optional().describe("list: filter by status"),
      offset: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(1000).optional(),
    },
  },
  hexvero_compare: {
    title: "Compare collections",
    description:
      "Diff one collection between two targets: added, removed, changed (with the fields that differ) and unchanged items, matched by key (auto-detected: name, channel, id, path, url, … or pass key). States when the comparison is partial.",
    input: {
      targetA: targetId,
      targetB: targetId,
      collection: z.string(),
      key: z.string().optional().describe("Item field used as identity (default: name, then JSON)"),
      ignore: z
        .array(z.string())
        .optional()
        .describe(
          "Fields whose differences do not count (default: address/value/offset-like fields); [] counts everything",
        ),
    },
  },
  hexvero_sourcemap: {
    title: "Resolve source map position",
    description:
      "Map a generated line/column of a source map target back to its original source, line, column and name.",
    input: {
      targetId,
      line: z.number().int().min(1),
      column: z.number().int().min(0),
    },
  },
  hexvero_providers: {
    title: "Providers",
    description:
      "Detect optional external engines (radare2/rizin, Ghidra) and the operations each supports.",
    input: {},
  },
  hexvero_provider_run: {
    title: "Run provider operation",
    description:
      "Run one engine operation on a target: functions, disassemble, decompile, strings, imports, xrefs (references to an address), callers, callees, callgraph or search (names + strings). Output is bounded and cached.",
    input: {
      targetId,
      provider: z.enum(["radare2", "rizin", "ghidra"]),
      operation: z.enum([
        "functions",
        "disassemble",
        "decompile",
        "strings",
        "imports",
        "xrefs",
        "callers",
        "callees",
        "callgraph",
        "search",
      ]),
      address: z
        .string()
        .optional()
        .describe("Function address or symbol for disassemble/decompile/xrefs/callers/callees"),
      text: z.string().min(1).max(200).optional().describe("Needle for search"),
      timeoutMs: z.number().int().min(1000).max(600_000).optional(),
    },
  },
  hexvero_call_graph: {
    title: "Call graph",
    description:
      "Bounded call-graph neighborhood around a function (callers, callees or both, by depth and node count), or the shortest call path from root to goal. One engine run per target, cached; levels state what was cut.",
    input: {
      targetId,
      provider: z.enum(["radare2", "rizin", "ghidra"]),
      root: z.string().min(1).describe("Function name or address to start from"),
      direction: z.enum(["callers", "callees", "both"]).optional().describe("Default callees"),
      maxDepth: z.number().int().min(0).max(8).optional().describe("Hops from root (default 2)"),
      maxNodes: z.number().int().min(1).max(2000).optional().describe("Default 150"),
      goal: z
        .string()
        .min(1)
        .optional()
        .describe("With goal: shortest path root → goal in the given direction instead"),
      timeoutMs: z.number().int().min(1000).max(600_000).optional(),
    },
  },
} as const;

export type ToolName = keyof typeof toolSchemas;

export interface ProviderBridge {
  detect(): Promise<unknown>;
  run(
    args: {
      targetPath: string;
      provider: string;
      operation: string;
      address?: string;
      text?: string;
      timeoutMs?: number;
    },
    signal?: AbortSignal,
  ): Promise<unknown>;
  /** The normalized whole-program call graph (the `callgraph` operation's result). */
  callGraph(
    args: { targetPath: string; provider: string; timeoutMs?: number },
    signal?: AbortSignal,
  ): Promise<CallGraph>;
}

const str = (v: unknown): string => String(v);
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);

const paged = (
  args: Record<string, unknown>,
): { offset?: number; limit?: number; text?: string } => {
  const q: { offset?: number; limit?: number; text?: string } = {};
  const offset = num(args["offset"]);
  if (offset !== undefined) q.offset = offset;
  const limit = num(args["limit"]);
  if (limit !== undefined) q.limit = limit;
  if (typeof args["text"] === "string") q.text = args["text"];
  return q;
};

export function createHandlers(
  session: Session,
  providers: ProviderBridge,
): Record<ToolName, (args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>> {
  return {
    hexvero_open: async (a) => session.open(str(a["path"])),
    hexvero_list: async () => ({ targets: session.list() }),
    hexvero_close: async (a) => ({ closed: session.close(str(a["targetId"])) }),
    hexvero_analyze: async (a, signal) => {
      const id = str(a["targetId"]);
      const analysis = await session.analyze(id, signal);
      return {
        target: session.get(id),
        summary: analysis.summary,
        durationMs: analysis.durationMs,
        findings: analysis.findings,
        limitations: analysis.limitations,
        collections: await session.collections(id),
        overview: compact(analysis.data),
      };
    },
    hexvero_collection: async (a) =>
      session.collection(str(a["targetId"]), str(a["collection"]), paged(a)),
    hexvero_strings: async (a) => {
      const q: Parameters<Session["strings"]>[1] = paged(a);
      const minLength = num(a["minLength"]);
      if (minLength !== undefined) q.minLength = minLength;
      if (typeof a["utf16"] === "boolean") q.utf16 = a["utf16"];
      if (typeof a["tag"] === "string") q.tag = a["tag"];
      return session.strings(str(a["targetId"]), q);
    },
    hexvero_bytes: async (a) =>
      session.bytes(str(a["targetId"]), Number(a["offset"]), Number(a["length"])),
    hexvero_export: async (a) =>
      session.export(str(a["targetId"]), str(a["path"]), { overwrite: a["overwrite"] === true }),
    hexvero_recover: async (a) => {
      const result = await session.recover(str(a["targetId"]), str(a["outputDir"]));
      return {
        ...result,
        written: { count: result.written.length, sample: result.written.slice(0, 50) },
        skipped: { count: result.skipped.length, sample: result.skipped.slice(0, 50) },
        note: "The manifest in outputDir lists every written and skipped file.",
      };
    },
    hexvero_unknowns: async (a) => {
      const action = str(a["action"]);
      const owner = typeof a["targetId"] === "string" ? a["targetId"] : null;
      if (action === "record") {
        if (typeof a["question"] !== "string")
          throw new AnalysisError("invalid_input", "record needs a question");
        const checked = Array.isArray(a["checked"]) ? a["checked"].map(String) : [];
        return session.unknowns.record({ targetId: owner, question: a["question"], checked });
      }
      if (action === "resolve") {
        if (typeof a["id"] !== "string" || typeof a["resolution"] !== "string")
          throw new AnalysisError("invalid_input", "resolve needs id and resolution");
        return session.unknowns.resolve(a["id"], a["resolution"]);
      }
      if (action === "remove") {
        if (typeof a["id"] !== "string")
          throw new AnalysisError("invalid_input", "remove needs id");
        return { removed: session.unknowns.remove(a["id"]) };
      }
      const filter: Parameters<typeof session.unknowns.list>[0] = paged(a);
      if (owner !== null) filter.targetId = owner;
      if (a["status"] === "open" || a["status"] === "resolved") filter.status = a["status"];
      return session.unknowns.list(filter);
    },
    hexvero_compare: async (a) => {
      const name = str(a["collection"]);
      const [left, right] = await Promise.all([
        session.collection(str(a["targetA"]), name, { limit: 2000, maxBytes: 64 << 20 }),
        session.collection(str(a["targetB"]), name, { limit: 2000, maxBytes: 64 << 20 }),
      ]);
      const diff = compareItems(left.items, right.items, {
        key: typeof a["key"] === "string" ? a["key"] : undefined,
        ignore: Array.isArray(a["ignore"]) ? (a["ignore"] as string[]) : undefined,
      });
      if (diff.keyMissing)
        throw new AnalysisError(
          "invalid_input",
          `no item in ${name} has a field "${str(a["key"])}"`,
        );
      return {
        collection: name,
        key: diff.key,
        ignored: diff.ignored,
        left: { total: left.total, compared: left.items.length, truncated: left.truncated },
        right: { total: right.total, compared: right.items.length, truncated: right.truncated },
        unchanged: diff.unchanged,
        relocated: diff.relocated,
        added: { count: diff.added.length, sample: diff.added.slice(0, 50) },
        removed: { count: diff.removed.length, sample: diff.removed.slice(0, 50) },
        changed: {
          count: diff.changed.length,
          sample: diff.changed.slice(0, 25).map((c) => ({
            key: c.key,
            fields: compact(c.fields.slice(0, 8), { maxString: 200, maxItems: 8 }),
          })),
        },
        duplicateKeys: diff.duplicateKeys,
        note:
          left.truncated || right.truncated
            ? "Only the first 2000 items per side were compared; the result is partial."
            : "Complete comparison of both collections.",
      };
    },
    hexvero_sourcemap: async (a) => {
      const id = str(a["targetId"]);
      const analysis = await session.analyze(id);
      if (analysis.data.kind !== "source-map")
        throw new AnalysisError("invalid_input", "Target is not a source map");
      const text = new TextDecoder().decode(session.rawBytes(id));
      return (
        originalPositionFor(text, Number(a["line"]), Number(a["column"])) ?? {
          source: null,
          note: "no mapping at that position",
        }
      );
    },
    hexvero_providers: async () => providers.detect(),
    hexvero_provider_run: async (a, signal) => {
      const target = session.get(str(a["targetId"]));
      const req: Parameters<ProviderBridge["run"]>[0] = {
        targetPath: target.info.path,
        provider: str(a["provider"]),
        operation: str(a["operation"]),
      };
      if (typeof a["address"] === "string") req.address = a["address"];
      if (typeof a["text"] === "string") req.text = a["text"];
      const timeoutMs = num(a["timeoutMs"]);
      if (timeoutMs !== undefined) req.timeoutMs = timeoutMs;
      const result = (await providers.run(req, signal)) as { result?: unknown } | null;
      if (result && typeof result === "object" && "result" in result) {
        return {
          ...result,
          result: compact(result.result, { maxItems: 200, maxString: 20_000 }),
          note: "Large engine results are sampled; use the CLI `hexvero provider --json` for the complete output.",
        };
      }
      return result;
    },
    hexvero_call_graph: async (a, signal) => {
      const target = session.get(str(a["targetId"]));
      const req: Parameters<ProviderBridge["callGraph"]>[0] = {
        targetPath: target.info.path,
        provider: str(a["provider"]),
      };
      const timeoutMs = num(a["timeoutMs"]);
      if (timeoutMs !== undefined) req.timeoutMs = timeoutMs;
      const graph = await providers.callGraph(req, signal);
      const root = resolveNode(graph, str(a["root"]));
      if (!root.node)
        throw new AnalysisError("invalid_input", `No function matches ${str(a["root"])}`, {
          candidates: root.candidates,
          functions: graph.nodes.length,
        });
      if (typeof a["goal"] === "string") {
        const goal = resolveNode(graph, a["goal"]);
        if (!goal.node)
          throw new AnalysisError("invalid_input", `No function matches ${a["goal"]}`, {
            candidates: goal.candidates,
          });
        const direction =
          a["direction"] === "callers" || a["direction"] === "both" ? a["direction"] : "callees";
        return tracePath(graph, root.node, goal.node, direction);
      }
      const options: Parameters<typeof neighborhood>[2] = {};
      if (a["direction"] === "callers" || a["direction"] === "callees" || a["direction"] === "both")
        options.direction = a["direction"];
      const maxDepth = num(a["maxDepth"]);
      if (maxDepth !== undefined) options.maxDepth = maxDepth;
      const maxNodes = num(a["maxNodes"]);
      if (maxNodes !== undefined) options.maxNodes = maxNodes;
      const result = neighborhood(graph, root.node, options);
      return { ...result, functions: graph.nodes.length, edgesTotal: graph.edges.length };
    },
  };
}
