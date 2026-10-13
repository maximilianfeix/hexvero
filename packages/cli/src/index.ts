import {
  AnalysisError,
  Session,
  compact,
  loadCallGraph,
  neighborhood,
  PROVIDER_OPERATIONS,
  resolveNode,
  runProvider,
  STRING_TAGS,
  tracePath,
  type ProviderName,
  type ProviderOperation,
} from "@hexvero/core";
import { serveStdio } from "@hexvero/mcp";
import { flagNumber, flagString, parseArgs, UsageError, type ParsedArgs } from "./args.js";
import {
  formatFindings,
  formatLimitations,
  heading,
  hexdump,
  paint,
  table,
  toJson,
  type Io,
} from "./format.js";

export const VERSION = "0.2.1";

const HELP = `hexvero ${VERSION} — reverse engineer anything, locally.

Usage: hexvero <command> [options]

Commands
  analyze <path> [--json] [--out file.json]     Summary, findings, limitations and overview
  collection <path> <name> [--text s] [--limit n] [--offset n] [--json]
                                                Page one list (symbols, imports, exports, ...)
  strings <path> [--min n] [--utf16] [--tag t] [--text s] [--limit n] [--json]
  bytes <path> <offset> [length]                Hex dump of a byte window
  compare <a> <b> <collection> [--key field]    Diff a collection between two targets
  export <path> <out.json>                      Write the complete analysis to a file
  recover <path> <outdir>                       Split a JS bundle into module files or write a
                                                source map's original sources (no engine needed)
  provider <path> <engine> <op> [--address a] [--text s]
                                                Run functions/disassemble/decompile/strings/imports/
                                                xrefs/callers/callees/callgraph/search through
                                                radare2, rizin or ghidra (if installed)
  calls <path> <engine> <root> [--direction callers|callees|both] [--depth n] [--max n] [--goal g]
                                                Bounded call-graph neighborhood, or the shortest
                                                call path from root to goal
  mcp                                           Serve the Model Context Protocol over stdio
  ui [--port n] [--host h] [--open]             Start the local web UI (loopback by default)
  doctor                                        Check the runtime and optional engines
  setup [--client name] [--apply] [--all]       Register the MCP server with detected agent clients
  setup --skill [--client name] [--apply]       Install the investigation skill for agents

Options
  --json      Machine-readable output
  --no-color  Disable colors
  -h, --help  Show help
  -v, --version

Exit codes: 0 ok · 1 analysis failed · 2 usage error · HEXVERO_DEBUG=1 prints stack traces`;

export async function main(argv: string[], io: Io = defaultIo()): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
    if (args.flags["no-color"]) io.color = false;
    if (args.flags["version"]) {
      io.out(VERSION);
      return 0;
    }
    if (args.flags["help"]) {
      io.out(HELP);
      return 0;
    }
    if (!args.command) {
      io.err(HELP);
      return 2;
    }
    return await run(args, io);
  } catch (error) {
    if (error instanceof UsageError) {
      const command = args!.command;
      const lines: string[] = [];
      if (command) {
        const all = HELP.split("\n");
        for (let i = 0; i < all.length; i++) {
          if (!all[i]!.trim().startsWith(`${command} `)) continue;
          lines.push(all[i]!);
          // continuation lines are indented past the command column and name no command
          for (let j = i + 1; j < all.length && /^\s{40,}\S/.test(all[j]!); j++)
            lines.push(all[j]!);
        }
      }
      io.err(
        `${paint(io, "red", "usage:")} ${error.message}${
          lines.length ? `\n\n${lines.join("\n")}` : ""
        }\n\n${paint(io, "dim", 'Run "hexvero --help" for all commands.')}`,
      );
      return 2;
    }
    if (error instanceof AnalysisError) {
      if (args!.flags["json"])
        io.out(
          toJson({
            error: {
              code: error.code,
              message: error.message,
              details: error.details,
            },
          }),
        );
      else {
        const candidates = (error.details as { candidates?: unknown } | undefined)?.candidates;
        io.err(
          `${paint(io, "red", `error (${error.code}):`)} ${error.message}${
            Array.isArray(candidates) && candidates.length
              ? `\n  did you mean: ${candidates.slice(0, 5).join(", ")}`
              : ""
          }`,
        );
      }
      return 1;
    }
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "EADDRINUSE") {
      io.err(`${paint(io, "red", "error:")} the port is already in use; pick another with --port`);
      return 1;
    }
    io.err(
      `${paint(io, "red", "error:")} ${
        error instanceof Error
          ? process.env["HEXVERO_DEBUG"]
            ? (error.stack ?? error.message)
            : error.message
          : String(error)
      }`,
    );
    return 1;
  }
}

async function run(args: ParsedArgs, io: Io): Promise<number> {
  const session = new Session();
  const json = Boolean(args.flags["json"]);
  const need = (index: number, name: string): string => {
    const v = args.positionals[index];
    if (!v) throw new UsageError(`missing <${name}>`);
    return v;
  };
  const paging = (): { offset?: number; limit?: number; text?: string } => {
    const q: { offset?: number; limit?: number; text?: string } = {};
    const offset = flagNumber(args.flags, "offset");
    const limit = flagNumber(args.flags, "limit");
    const text = flagString(args.flags, "text");
    if (offset !== undefined) {
      if (offset < 0 || !Number.isInteger(offset))
        throw new UsageError("--offset must be a whole number >= 0");
      q.offset = offset;
    }
    if (limit !== undefined) {
      if (limit < 1 || limit > 2000 || !Number.isInteger(limit))
        throw new UsageError("--limit must be a whole number between 1 and 2000");
      q.limit = limit;
    }
    if (text !== undefined) q.text = text;
    return q;
  };

  switch (args.command) {
    case "analyze": {
      const target = await session.open(need(0, "path"));
      const analysis = await session.analyze(target.id);
      const collections = await session.collections(target.id);
      const out = flagString(args.flags, "out");
      if (out) await session.export(target.id, out, { overwrite: true });
      if (json) {
        io.out(
          toJson({
            target,
            summary: analysis.summary,
            durationMs: analysis.durationMs,
            findings: analysis.findings,
            limitations: analysis.limitations,
            collections,
            overview: compact(analysis.data),
            exported: out ?? null,
          }),
        );
        return 0;
      }
      io.out(
        `${heading(io, target.info.path)}\n  ${paint(
          io,
          "dim",
          target.info.format === "directory"
            ? `directory · ${analysis.durationMs} ms`
            : `${target.info.format} · ${formatBytes(target.info.size)} · sha256 ${target.info.sha256.slice(0, 16)}… · ${analysis.durationMs} ms`,
        )}`,
      );
      io.out(`\n${heading(io, "Summary")}\n  ${analysis.summary}`);
      io.out(`\n${heading(io, "Findings")}\n${formatFindings(io, analysis.findings).join("\n")}`);
      if (analysis.limitations.length)
        io.out(
          `\n${heading(io, "Limitations")}\n${formatLimitations(io, analysis.limitations).join("\n")}`,
        );
      const lists = Object.entries(collections)
        .filter(([, n]) => n > 0)
        .map(([name, n]) => `${name} (${n})`);
      io.out(
        `\n${heading(io, "Collections")}\n  ${lists.join(", ") || "(none)"}\n  ${paint(io, "dim", `hexvero collection <path> <name> to page through one`)}`,
      );
      if (out) io.out(`\n${paint(io, "green", "✓")} exported to ${out}`);
      return 0;
    }
    case "collection":
    case "list": {
      const target = await session.open(need(0, "path"));
      const page = await session.collection(target.id, need(1, "collection"), paging());
      if (json) {
        io.out(toJson(page));
        return 0;
      }
      io.out(
        `${heading(io, `${page.collection} ${rangeLabel(page)}`)}${
          page.truncated ? paint(io, "dim", " (more: --offset/--limit)") : ""
        }${page.itemTruncated ? paint(io, "yellow", " (an item was cut to fit the byte budget; use --json for its full form)") : ""}`,
      );
      io.out(table(page.items as Array<Record<string, unknown>>).join("\n"));
      return 0;
    }
    case "strings": {
      const target = await session.open(need(0, "path"));
      const q: Parameters<Session["strings"]>[1] = paging();
      const min = flagNumber(args.flags, "min");
      const tag = flagString(args.flags, "tag");
      if (min !== undefined) q.minLength = min;
      if (args.flags["utf16"]) q.utf16 = true;
      if (tag) {
        if (!(STRING_TAGS as readonly string[]).includes(tag))
          throw new UsageError(`unknown tag "${tag}"; known: ${STRING_TAGS.join(", ")}`);
        q.tag = tag;
      }
      const page = session.strings(target.id, q);
      if (json) {
        io.out(toJson(page));
        return 0;
      }
      io.out(
        `${heading(io, `strings ${rangeLabel(page)}`)}${
          page.truncated ? paint(io, "dim", " (more: --offset/--limit)") : ""
        }`,
      );
      for (const s of page.items)
        io.out(
          `  ${paint(io, "dim", s.offset.toString(16).padStart(8, "0"))}  ${s.value}${
            s.length ? paint(io, "dim", `… (+${s.length - s.value.length} chars)`) : ""
          }${s.tags.length ? paint(io, "cyan", `  [${s.tags.join(",")}]`) : ""}`,
        );
      return 0;
    }
    case "bytes": {
      const target = await session.open(need(0, "path"));
      const offset = Number(need(1, "offset"));
      if (!Number.isFinite(offset))
        throw new UsageError("offset must be a number (decimal or 0x hex)");
      const length = args.positionals[2] ? Number(args.positionals[2]) : 256;
      if (!Number.isFinite(length) || length <= 0)
        throw new UsageError("length must be a positive number");
      const window = session.bytes(target.id, offset, length);
      if (json) {
        io.out(toJson(window));
        return 0;
      }
      io.out(hexdump(window.hex, window.ascii, window.offset).join("\n"));
      if (window.length < length && window.offset + window.length < target.info.size)
        io.out(
          paint(
            io,
            "yellow",
            `  window clamped to ${window.length} bytes (max 65536 per call); continue with offset ${window.offset + window.length}`,
          ),
        );
      return 0;
    }
    case "compare": {
      const a = await session.open(need(0, "a"));
      const b = await session.open(need(1, "b"));
      const name = need(2, "collection");
      const key = flagString(args.flags, "key") ?? "name";
      const [left, right] = await Promise.all([
        session.collection(a.id, name, { limit: 2000, maxBytes: 64 << 20 }),
        session.collection(b.id, name, { limit: 2000, maxBytes: 64 << 20 }),
      ]);
      const keyOf = (item: unknown): string => {
        const o = item as Record<string, unknown>;
        return o && typeof o === "object" && key in o ? String(o[key]) : JSON.stringify(item);
      };
      const l = new Set(left.items.map(keyOf));
      const r = new Set(right.items.map(keyOf));
      const added = [...r].filter((k) => !l.has(k));
      const removed = [...l].filter((k) => !r.has(k));
      const truncated = left.truncated || right.truncated;
      if (json) {
        io.out(
          toJson({
            collection: name,
            key,
            added,
            removed,
            unchanged: [...l].filter((k) => r.has(k)).length,
            compared: { a: left.items.length, b: right.items.length },
            totals: { a: left.total, b: right.total },
            truncated,
          }),
        );
        return 0;
      }
      io.out(
        heading(
          io,
          `${name}: ${added.length} added, ${removed.length} removed, ${[...l].filter((k) => r.has(k)).length} unchanged`,
        ),
      );
      for (const k of added) io.out(`  ${paint(io, "green", "+")} ${k}`);
      for (const k of removed) io.out(`  ${paint(io, "red", "-")} ${k}`);
      if (truncated)
        io.out(
          paint(
            io,
            "yellow",
            `  ! compared only the first ${left.items.length} of ${left.total} (a) and ${right.items.length} of ${right.total} (b) items; the result is partial`,
          ),
        );
      return 0;
    }
    case "export": {
      const target = await session.open(need(0, "path"));
      const result = await session.export(target.id, need(1, "out.json"), { overwrite: true });
      io.out(
        json ? toJson(result) : `${paint(io, "green", "✓")} ${result.path} (${result.bytes} bytes)`,
      );
      return 0;
    }
    case "provider": {
      const provider = engineName(need(1, "engine"));
      const operation = need(2, "operation") as ProviderOperation;
      const target = await session.open(need(0, "path"));
      if (!(PROVIDER_OPERATIONS[provider] as readonly string[]).includes(operation))
        throw new UsageError(
          `${provider} does not support "${operation}"; operations: ${PROVIDER_OPERATIONS[provider].join(", ")}`,
        );
      const result = await runProvider({
        targetPath: target.info.path,
        provider,
        operation,
        address: flagString(args.flags, "address"),
        text: flagString(args.flags, "text"),
        timeoutMs: flagNumber(args.flags, "timeout"),
      });
      if (json) {
        io.out(toJson(result));
        return 0;
      }
      io.out(
        heading(
          io,
          `${provider} ${operation}${
            result.address ? ` @ ${result.address}` : ""
          } · ${result.durationMs} ms`,
        ),
      );
      const r = result.result as unknown;
      if (typeof r === "string") io.out(r);
      else if (operation === "decompile" && r && typeof r === "object" && "code" in r)
        io.out(String((r as { code: unknown }).code ?? ""));
      else if (Array.isArray(r))
        io.out(table(r.slice(0, 200) as Array<Record<string, unknown>>).join("\n"));
      else io.out(toJson(compact(r)));
      if (result.limitations.length)
        io.out(`\n${formatLimitations(io, result.limitations).join("\n")}`);
      return 0;
    }
    case "calls": {
      const provider = engineName(need(1, "engine"));
      const target = await session.open(need(0, "path"));
      const rootSpec = need(2, "root");
      const graphRun = await loadCallGraph({
        targetPath: target.info.path,
        provider,
        timeoutMs: flagNumber(args.flags, "timeout"),
      });
      const graph = graphRun.graph;
      const root = resolveNode(graph, rootSpec);
      if (!root.node)
        throw new AnalysisError("invalid_input", `No function matches ${rootSpec}`, {
          candidates: root.candidates,
        });
      const directionFlag = flagString(args.flags, "direction");
      const goalSpec = flagString(args.flags, "goal");
      if (goalSpec !== undefined) {
        const goal = resolveNode(graph, goalSpec);
        if (!goal.node)
          throw new AnalysisError("invalid_input", `No function matches ${goalSpec}`, {
            candidates: goal.candidates,
          });
        const trace = tracePath(
          graph,
          root.node,
          goal.node,
          directionFlag === "callers" || directionFlag === "both" ? directionFlag : "callees",
        );
        if (json) {
          io.out(toJson(trace));
          return 0;
        }
        io.out(
          heading(io, `${provider} path ${root.node.name} → ${goal.node.name} · ${trace.status}`),
        );
        if (trace.path)
          trace.path.forEach((n, i) => io.out(`${"  ".repeat(i)}${i ? "└ " : ""}${n}`));
        else io.out(paint(io, "yellow", `no path (${trace.explored} functions explored)`));
        if (trace.limitations.length)
          io.out(`\n${formatLimitations(io, trace.limitations).join("\n")}`);
        return 0;
      }
      const options: Parameters<typeof neighborhood>[2] = {
        maxDepth: flagNumber(args.flags, "depth"),
        maxNodes: flagNumber(args.flags, "max"),
      };
      if (directionFlag === "callers" || directionFlag === "callees" || directionFlag === "both")
        options.direction = directionFlag;
      const hood = neighborhood(graph, root.node, options);
      if (json) {
        io.out(toJson(hood));
        return 0;
      }
      io.out(
        heading(
          io,
          `${provider} ${hood.direction} of ${root.node.name} · ${hood.nodes.length} functions, ${hood.edges.length} edges · ${graphRun.durationMs} ms`,
        ),
      );
      for (const level of hood.levels) {
        io.out(paint(io, "dim", `depth ${level.depth}`));
        for (const id of level.ids) {
          const node = hood.nodes.find((n) => n.id === id);
          const address = node?.address && node.address !== node.name ? ` ${node.address}` : "";
          io.out(
            `  ${node?.name ?? id}${paint(io, "dim", address)}${node?.external ? paint(io, "dim", " (external)") : ""}`,
          );
        }
      }
      if (hood.limitations.length)
        io.out(`\n${formatLimitations(io, hood.limitations).join("\n")}`);
      return 0;
    }
    case "recover": {
      const target = await session.open(need(0, "path"));
      const result = await session.recover(target.id, need(1, "outdir"));
      if (json) {
        io.out(toJson(result));
        return 0;
      }
      if (result.written.length === 0) {
        io.out(
          result.skipped.length
            ? `${paint(io, "yellow", "!")} ${result.skipped.length} sources listed in the map carry no embedded content (sourcesContent); nothing but the manifest was written to ${result.outputDir}.`
            : `${paint(io, "yellow", "!")} no module boundaries recognised; nothing but the manifest was written to ${result.outputDir}. Supported: webpack 4/5, Rspack, browserify, esbuild bundles and source maps with embedded sources.`,
        );
        return 0;
      }
      io.out(
        `${paint(io, "green", "✓")} ${result.written.length} files written to ${result.outputDir} (manifest ${result.manifest})`,
      );
      for (const w of result.written.slice(0, 30))
        io.out(`  ${paint(io, "dim", String(w.bytes).padStart(8))}  ${w.path}`);
      if (result.written.length > 30)
        io.out(paint(io, "dim", `  … ${result.written.length - 30} more`));
      if (result.skipped.length)
        io.out(
          paint(io, "yellow", `  ${result.skipped.length} sources skipped (no embedded content)`),
        );
      return 0;
    }
    case "mcp":
      await serveStdio(new Session({ worker: true }));
      await new Promise(() => {});
      return 0;
    case "ui": {
      const { startUi } = await import("./ui.js");
      const host = flagString(args.flags, "host");
      if (host && !isLoopback(host))
        io.err(
          paint(
            io,
            "yellow",
            `! binding to ${host} exposes the token-protected API to that network; only loopback is recommended`,
          ),
        );
      return startUi(
        session,
        {
          port: flagNumber(args.flags, "port") ?? 7331,
          open: Boolean(args.flags["open"]),
          ...(host ? { host } : {}),
        },
        io,
      );
    }
    case "doctor": {
      const { doctor } = await import("./doctor.js");
      return doctor(io, json);
    }
    case "setup": {
      if (args.flags["skill"]) {
        const { installSkill } = await import("./skill.js");
        return installSkill(io, {
          client: flagString(args.flags, "client"),
          apply: Boolean(args.flags["apply"]),
          json,
        });
      }
      const { setup } = await import("./setup.js");
      return setup(io, {
        client: flagString(args.flags, "client"),
        apply: Boolean(args.flags["apply"]),
        all: Boolean(args.flags["all"]),
        json,
      });
    }
    default:
      throw new UsageError(`unknown command "${args.command}"`);
  }
}

function isLoopback(host: string): boolean {
  return /^(127\.\d+\.\d+\.\d+|localhost\.?|\[?::1\]?)$/i.test(host);
}

function engineName(value: string): ProviderName {
  const known = Object.keys(PROVIDER_OPERATIONS);
  if (known.includes(value)) return value as ProviderName;
  throw new UsageError(`unknown engine "${value}"; known: ${known.join(", ")}`);
}

function rangeLabel(page: { offset: number; items: unknown[]; total: number }): string {
  if (page.items.length === 0)
    return page.offset > 0 && page.offset >= page.total
      ? `0 of ${page.total} (offset ${page.offset} is past the end)`
      : `0 of ${page.total}`;
  return `${page.offset + 1}-${page.offset + page.items.length} of ${page.total}`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} bytes`;
  const units = ["KiB", "MiB", "GiB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const shown = v.toFixed(v >= 100 ? 0 : 1);
  return `${shown === "1024.0" || shown === "1024" ? `${(v / 1024).toFixed(1)} ${units[Math.min(i + 1, units.length - 1)]}` : `${shown} ${units[i]}`} (${n} bytes)`;
}

export function defaultIo(): Io {
  return {
    out: (text) => process.stdout.write(`${text}\n`),
    err: (text) => process.stderr.write(`${text}\n`),
    color: Boolean(process.stdout.isTTY) && !process.env["NO_COLOR"],
  };
}
