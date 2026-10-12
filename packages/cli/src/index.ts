import {
  AnalysisError,
  Session,
  compact,
  runProvider,
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

export const VERSION = "0.1.1";

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
  provider <path> <engine> <op> [--address a]   Run functions/disassemble/decompile/strings/imports
                                                through radare2, rizin or ghidra (if installed)
  mcp                                           Serve the Model Context Protocol over stdio
  ui [--port n] [--open]                        Start the local web UI
  doctor                                        Check the runtime and optional engines
  setup [--client name] [--apply]               Register hexvero with an agent

Options
  --json      Machine-readable output
  --no-color  Disable colors
  -h, --help  Show help
  -v, --version

Exit codes: 0 ok · 1 analysis failed · 2 usage error`;

export async function main(argv: string[], io: Io = defaultIo()): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
    if (args.flags["no-color"]) io.color = false;
    if (args.flags["version"]) {
      io.out(VERSION);
      return 0;
    }
    if (!args.command || args.flags["help"]) {
      io.out(HELP);
      return args.command ? 0 : 2;
    }
    return await run(args, io);
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(`${paint(io, "red", "usage:")} ${error.message}\n\n${HELP}`);
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
      else io.err(`${paint(io, "red", `error (${error.code}):`)} ${error.message}`);
      return 1;
    }
    io.err(
      `${paint(io, "red", "error:")} ${
        error instanceof Error ? (error.stack ?? error.message) : String(error)
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
    if (offset !== undefined) q.offset = offset;
    if (limit !== undefined) q.limit = limit;
    if (text !== undefined) q.text = text;
    return q;
  };

  switch (args.command) {
    case "analyze": {
      const target = await session.open(need(0, "path"));
      const analysis = await session.analyze(target.id);
      const collections = await session.collections(target.id);
      const out = flagString(args.flags, "out");
      if (out) await session.export(target.id, out);
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
        `${heading(io, target.info.path)}\n  ${paint(io, "dim", `${target.info.format} · ${target.info.size} bytes · sha256 ${target.info.sha256.slice(0, 16)}… · ${analysis.durationMs} ms`)}`,
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
        `${heading(io, `${page.collection} ${page.offset + 1}-${page.offset + page.items.length} of ${page.total}`)}${
          page.truncated ? paint(io, "dim", " (more: --offset/--limit)") : ""
        }`,
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
      if (tag) q.tag = tag;
      const page = session.strings(target.id, q);
      if (json) {
        io.out(toJson(page));
        return 0;
      }
      io.out(
        `${heading(io, `strings ${page.offset + 1}-${page.offset + page.items.length} of ${page.total}`)}`,
      );
      for (const s of page.items)
        io.out(
          `  ${paint(io, "dim", s.offset.toString(16).padStart(8, "0"))}  ${s.value}${
            s.tags.length ? paint(io, "cyan", `  [${s.tags.join(",")}]`) : ""
          }`,
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
      if (json) {
        io.out(
          toJson({
            collection: name,
            added,
            removed,
            unchanged: [...l].filter((k) => r.has(k)).length,
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
      return 0;
    }
    case "export": {
      const target = await session.open(need(0, "path"));
      const result = await session.export(target.id, need(1, "out.json"));
      io.out(
        json ? toJson(result) : `${paint(io, "green", "✓")} ${result.path} (${result.bytes} bytes)`,
      );
      return 0;
    }
    case "provider": {
      const target = await session.open(need(0, "path"));
      const provider = need(1, "engine") as ProviderName;
      const operation = need(2, "operation") as ProviderOperation;
      const result = await runProvider({
        targetPath: target.info.path,
        provider,
        operation,
        address: flagString(args.flags, "address"),
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
    case "mcp":
      await serveStdio(session);
      await new Promise(() => {});
      return 0;
    case "ui": {
      const { startUi } = await import("./ui.js");
      return startUi(
        session,
        {
          port: flagNumber(args.flags, "port") ?? 7331,
          open: Boolean(args.flags["open"]),
        },
        io,
      );
    }
    case "doctor": {
      const { doctor } = await import("./doctor.js");
      return doctor(io, json);
    }
    case "setup": {
      const { setup } = await import("./setup.js");
      return setup(io, {
        client: flagString(args.flags, "client"),
        apply: Boolean(args.flags["apply"]),
        json,
      });
    }
    default:
      throw new UsageError(`unknown command "${args.command}"`);
  }
}

export function defaultIo(): Io {
  return {
    out: (text) => process.stdout.write(`${text}\n`),
    err: (text) => process.stderr.write(`${text}\n`),
    color: Boolean(process.stdout.isTTY) && !process.env["NO_COLOR"],
  };
}
