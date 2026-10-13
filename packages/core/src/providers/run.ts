import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AnalysisError, type Limitation } from "../model.js";
import { type CallGraph, callersOf, calleesOf, normalizeCallGraph, resolveNode } from "./graph.js";
import { detectProviders, type ProviderStatus } from "./index.js";

export type ProviderName = ProviderStatus["name"];
export type ProviderOperation =
  | "functions"
  | "disassemble"
  | "decompile"
  | "strings"
  | "imports"
  | "xrefs"
  | "callers"
  | "callees"
  | "callgraph"
  | "search";

export interface ProviderRequest {
  targetPath: string;
  provider: ProviderName;
  operation: ProviderOperation;
  /** Function address or symbol for disassemble/decompile/xrefs/callers/callees. */
  address?: string | undefined;
  /** Case-insensitive needle for `search` (function names and strings); never passed to a shell. */
  text?: string | undefined;
  timeoutMs?: number | undefined;
  /** Aborting kills the engine's whole process group. */
  signal?: AbortSignal | undefined;
}

/**
 * A hex address or one symbol/flag name. Deliberately excludes radare2's `@@`/`@@@` iterators and
 * `$$`-style variables as well as every shell metacharacter: the value is spliced into an engine
 * command string (argv, never a shell), and iterators turn one function into a whole-program dump.
 */
export const ADDRESS_PATTERN = /^(?:(?:0x)?[0-9a-fA-F]{1,16}|[A-Za-z_.][\w.$:]{0,255})$/;

/** True for one hex address or one symbol name; engine iterators (`@@`), `$$` and shell characters never pass. */
export function isAddress(value: string): boolean {
  return ADDRESS_PATTERN.test(value) && !value.includes("$$") && !value.includes("@");
}

export interface ProviderResult {
  provider: ProviderName;
  operation: ProviderOperation;
  address: string | null;
  durationMs: number;
  /** Parsed JSON when the engine produced it, otherwise the raw text (bounded). */
  result: unknown;
  truncated: boolean;
  limitations: Limitation[];
}

const MAX_OUTPUT = 8 * 1024 * 1024;

interface Exec {
  stdout: string;
  stderr: string;
  code: number | null;
  truncated: boolean;
  timedOut: boolean;
}

/** Engines still running; killed as a group when this process exits or is interrupted. */
const children = new Set<ChildProcess>();
let exitHooksInstalled = false;

function killGroup(child: ChildProcess): void {
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch {
    /* already gone */
  }
}

function installExitHooks(): void {
  if (exitHooksInstalled) return;
  exitHooksInstalled = true;
  // Only the exit hook lives here: signal handling belongs to the entry point (CLI, MCP server),
  // which calls killEngines() before shutting down so the process keeps control of its exit code.
  process.once("exit", killEngines);
}

/** Kills every engine process group still running; entry points call this on SIGINT/SIGTERM. */
export function killEngines(): number {
  const n = children.size;
  for (const c of children) killGroup(c);
  children.clear();
  return n;
}

function exec(
  command: string,
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal,
  cwd?: string,
): Promise<Exec> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AnalysisError("cancelled", "the request was cancelled before the engine started"));
      return;
    }
    installExitHooks();
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      ...(cwd ? { cwd } : {}),
    });
    children.add(child);
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    let cancelled = false;
    const kill = (): void => killGroup(child);
    const onAbort = (): void => {
      cancelled = true;
      kill();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length >= MAX_OUTPUT) {
        truncated = true;
        kill();
        return;
      }
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 64 * 1024) stderr += chunk.toString();
    });
    const done = (): void => {
      clearTimeout(timer);
      children.delete(child);
      signal?.removeEventListener("abort", onAbort);
    };
    child.once("error", (error) => {
      done();
      reject(error);
    });
    child.once("close", (code) => {
      done();
      if (cancelled) reject(new AnalysisError("cancelled", "the engine run was cancelled"));
      else resolve({ stdout, stderr, code, truncated, timedOut });
    });
  });
}

function parseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    // radare2 may print warnings before the JSON; take the last line that parses.
    const lines = trimmed.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        return JSON.parse(lines[i]!);
      } catch {
        /* keep looking */
      }
    }
    return trimmed;
  }
}

/** Every line of stdout that parses as JSON, in order (radare2 prints one document per command). */
function parseJsonDocs(text: string): unknown[] {
  const docs: unknown[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("[") && !t.startsWith("{")) continue;
    try {
      docs.push(JSON.parse(t));
    } catch {
      /* warning or partial line */
    }
  }
  return docs;
}

const MARK = (section: string): string => `==hexvero:${section}==`;
// The flag list is read last and from the symbols flagspace only: that is where `main` lives,
// and it is a fraction of the full list, so a large binary does not hit the output cap on it.
// The jump references come last: on a large binary they are the longest part, so an output cut
// by the size limit loses them and nothing else (the graph then says tail calls are unknown).
const RADARE_GRAPH = `aaa; ?e ${MARK("functions")}; aflj; ?e ${MARK("graph")}; agCj; ?e ${MARK("flags")}; fs symbols; fj; ?e ${MARK("jumps")}; ax~CODE:; ?e ${MARK("jumpsEnd")}`;
const RIZIN_GRAPH = `aaa; echo ${MARK("functions")}; aflj; echo ${MARK("graph")}; agC json; echo ${MARK("flags")}; fs symbols; flj`;

/**
 * Splits engine stdout into the labelled JSON documents. Returns null when the engine printed no
 * markers (then the caller falls back to document order).
 */
export function graphSections(stdout: string): Record<string, unknown> | null {
  const sections: Record<string, unknown> = {};
  let current: string | null = null;
  let seen = false;
  for (const line of stdout.split("\n")) {
    const text = line.trim();
    const marker = /^==hexvero:(\w+)==$/.exec(text);
    if (marker) {
      current = marker[1]!;
      seen = true;
      // Two sections are plain text: the jump references, and the marker that proves they
      // were printed to the end.
      if (current === "jumps") sections[current] = [];
      if (current === "jumpsEnd") sections[current] = true;
      continue;
    }
    if (current === "jumps") {
      if (text) (sections[current] as string[]).push(text);
      continue;
    }
    if (current === null || sections[current] !== undefined) continue;
    if (!text.startsWith("[") && !text.startsWith("{")) continue;
    try {
      sections[current] = JSON.parse(text);
    } catch {
      /* a cut or non-JSON line: the section stays missing */
    }
  }
  return seen ? sections : null;
}

const RADARE_COMMANDS: Record<ProviderOperation, (address: string | null) => string> = {
  functions: () => "aaa; aflj",
  disassemble: (a) => `aaa; pdfj @ ${a ?? "entry0"}`,
  decompile: (a) => `aaa; pdgj @ ${a ?? "entry0"}`,
  strings: () => "izj",
  imports: () => "iij",
  // references to an address or symbol from anywhere; the function list maps each source
  // address to its function (rizin's axtj carries no function name)
  xrefs: (a) => `aaa; aflj; axtj @ ${a ?? "entry0"}`,
  // callers/callees/callgraph share one whole-program read: functions with addresses, the global
  // call graph and the flag list (other names of the same addresses, e.g. `main`). Marker lines
  // label the three documents so a missing one cannot be mistaken for another.
  callers: () => RADARE_GRAPH,
  callees: () => RADARE_GRAPH,
  callgraph: () => RADARE_GRAPH,
  // function names and strings; the needle is applied client-side, never interpolated
  search: () => "aaa; aflj; izj",
};

/** rizin renamed the JSON call graph (`agC json`), echo (`echo`) and the flag list (`flj`). */
const RIZIN_COMMANDS: typeof RADARE_COMMANDS = {
  ...RADARE_COMMANDS,
  callers: () => RIZIN_GRAPH,
  callees: () => RIZIN_GRAPH,
  callgraph: () => RIZIN_GRAPH,
};

const ADDRESS_OPERATIONS: ReadonlySet<ProviderOperation> = new Set([
  "disassemble",
  "decompile",
  "xrefs",
  "callers",
  "callees",
]);

const MAX_XREFS = 20_000;
const MAX_SEARCH_RESULTS = 5_000;
const MAX_STRING_VALUE = 256;

interface FunctionRange {
  name: string;
  start: number;
  end: number;
}

/** Function ranges from an `aflj` document (radare2 ≥ 6 says `addr`, older builds and rizin `offset`). */
function functionRanges(doc: unknown): FunctionRange[] {
  if (!Array.isArray(doc)) return [];
  const out: FunctionRange[] = [];
  for (const item of doc as unknown[]) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    const start = typeof r["offset"] === "number" ? r["offset"] : r["addr"];
    if (typeof r["name"] !== "string" || typeof start !== "number") continue;
    const size = typeof r["size"] === "number" ? r["size"] : 1;
    out.push({ name: r["name"], start, end: start + Math.max(1, size) });
  }
  return out;
}

const hex = (n: number): string => `0x${n.toString(16)}`;

/** Normalizes radare2/rizin `axtj` rows (last document) into the shape shared with Ghidra. */
function radareXrefs(docs: unknown[]): unknown {
  const rows = docs.at(-1);
  if (!Array.isArray(rows) || docs.length < 2)
    return { references: [], truncated: false, note: "engine returned no reference list" };
  const ranges = functionRanges(docs[0]);
  const containing = (addr: number): string | null =>
    ranges.find((f) => addr >= f.start && addr < f.end)?.name ?? null;
  const references = rows.slice(0, MAX_XREFS).flatMap((x) => {
    if (typeof x !== "object" || x === null) return [];
    const r = x as Record<string, unknown>;
    const from = typeof r["from"] === "number" ? r["from"] : null;
    return [
      {
        from: from === null ? null : hex(from),
        type: typeof r["type"] === "string" ? r["type"] : null,
        function:
          typeof r["fcn_name"] === "string"
            ? r["fcn_name"]
            : from === null
              ? null
              : containing(from),
        opcode: typeof r["opcode"] === "string" ? r["opcode"] : null,
      },
    ];
  });
  return { references, truncated: rows.length > MAX_XREFS };
}

/** Applies the search needle to the `aflj` + `izj` documents with one shared result budget. */
function radareSearch(docs: unknown[], needle: string): unknown {
  const lower = needle.toLowerCase();
  const functions: Array<{ name: string; address: string }> = [];
  const strings: Array<{ value: string; address: string }> = [];
  let truncated = false;
  for (const f of functionRanges(docs[0])) {
    if (!f.name.toLowerCase().includes(lower)) continue;
    if (functions.length >= MAX_SEARCH_RESULTS) {
      truncated = true;
      break;
    }
    functions.push({ name: f.name, address: hex(f.start) });
  }
  const stringsDoc = docs.at(-1);
  for (const item of Array.isArray(stringsDoc) && docs.length > 1
    ? (stringsDoc as unknown[])
    : []) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    if (typeof r["string"] !== "string" || !r["string"].toLowerCase().includes(lower)) continue;
    if (functions.length + strings.length >= MAX_SEARCH_RESULTS) {
      truncated = true;
      break;
    }
    strings.push({
      value: r["string"].slice(0, MAX_STRING_VALUE),
      address: typeof r["vaddr"] === "number" ? hex(r["vaddr"]) : "?",
    });
  }
  return { needle, functions, strings, truncated };
}

/** Projects callers or callees of `spec` out of a normalized call graph. */
function relation(
  graph: CallGraph,
  spec: string | null,
  kind: "callers" | "callees",
  limitations: Limitation[],
): unknown {
  if (spec === null) {
    limitations.push({ code: "address_required", message: `${kind} needs an address or symbol.` });
    return null;
  }
  const { node, candidates } = resolveNode(graph, spec);
  if (!node) {
    limitations.push({
      code: candidates.length ? "function_ambiguous" : "function_not_found",
      message: `No single function matches ${spec}${candidates.length ? `; candidates: ${candidates.slice(0, 5).join(", ")}` : "."}`,
    });
    return { function: null, candidates, [kind]: [] };
  }
  const ids = kind === "callers" ? callersOf(graph, node.id) : calleesOf(graph, node.id);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  return {
    function: node,
    [kind]: ids.map(
      (id) => byId.get(id) ?? { id, name: id, address: null, size: null, external: true },
    ),
    coverage: graph.truncated ? "partial" : "complete",
  };
}

async function contentDigest(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex")
    .slice(0, 16);
}

/** Bump when the engine commands or the normalized graph shape change: old caches become unreachable. */
const GRAPH_SCHEMA = 6;

/** Normalized graphs per provider, content digest, engine build and schema; concurrent requests share one engine run. */
const graphCache = new Map<string, Promise<CallGraph>>();

/** Rejects with `cancelled` when the caller aborts while others keep waiting for the shared run. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted)
    return Promise.reject(new AnalysisError("cancelled", "the request was cancelled"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void =>
      reject(new AnalysisError("cancelled", "the request was cancelled while the engine ran"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

export interface CallGraphResult {
  graph: CallGraph;
  /** True when no engine ran because the graph was already known for this content. */
  cached: boolean;
  durationMs: number;
}

/**
 * The whole-program call graph for a target, read from the engine once per content digest and
 * kept in memory and under the cache directory. radare2/rizin otherwise re-run `aaa` on every
 * question and Ghidra re-exports its project.
 */
export async function loadCallGraph(
  request: Omit<ProviderRequest, "operation" | "address" | "text">,
  statuses?: ProviderStatus[],
): Promise<CallGraphResult> {
  const started = performance.now();
  const digest = await contentDigest(request.targetPath);
  // A cached graph is only valid for the same file content, the same engine build and the same
  // way hexvero asks for and normalizes the graph (GRAPH_SCHEMA), so each of them is in the key.
  const providers = statuses ?? (await detectProviders());
  const engine = providers.find((p) => p.name === request.provider);
  // Size and modification time of the engine binary cover engines that report no version (Ghidra).
  const binary = engine?.path ? await stat(engine.path).catch(() => null) : null;
  const variant = createHash("sha256")
    .update(
      `${GRAPH_SCHEMA}\u0000${engine?.version ?? "unknown"}\u0000${engine?.path ?? ""}\u0000${binary ? `${binary.size}:${Math.round(binary.mtimeMs)}` : ""}`,
    )
    .digest("hex")
    .slice(0, 10);
  const key = `${request.provider}:${digest}:${variant}`;
  const diskPath = join(cacheRoot(), "graphs", `${request.provider}-${digest}-${variant}.json`);
  let cached = true;
  let pending = graphCache.get(key);
  if (!pending) {
    cached = false;
    pending = (async (): Promise<CallGraph> => {
      try {
        const fromDisk = JSON.parse(await readFile(diskPath, "utf8")) as CallGraph;
        if (Array.isArray(fromDisk.nodes) && Array.isArray(fromDisk.edges)) {
          cached = true;
          return fromDisk;
        }
      } catch {
        /* not cached yet */
      }
      // The run is shared by every concurrent caller, so it must not die with one caller's signal.
      const run = await runProvider(
        { ...request, operation: "callgraph", signal: undefined },
        providers,
      );
      const graph = run.result as CallGraph | null;
      if (!graph || !Array.isArray(graph.nodes))
        throw new AnalysisError(
          "provider_unavailable",
          `${request.provider} produced no call graph`,
          {
            limitations: run.limitations,
          },
        );
      if (!graph.truncated && run.limitations.length === 0) {
        try {
          await mkdir(dirname(diskPath), { recursive: true });
          await writeFile(diskPath, JSON.stringify(graph));
        } catch {
          /* cache is best effort */
        }
      }
      return graph;
    })();
    graphCache.set(key, pending);
    pending.catch(() => graphCache.delete(key));
  }
  const graph = await abortable(pending, request.signal);
  return { graph, cached, durationMs: Math.round(performance.now() - started) };
}

export function cacheRoot(): string {
  return process.env["HEXVERO_CACHE_DIR"] ?? join(homedir(), ".cache", "hexvero");
}

/** Location of the packaged Ghidra export script. */
export function ghidraScriptDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "ghidra");
}

/**
 * Runs one bounded operation through an installed engine. radare2/rizin run
 * in quiet batch mode; Ghidra runs headless against a per-digest project that
 * is reused on later calls so the expensive import happens once.
 */
export async function runProvider(
  request: ProviderRequest,
  statuses?: ProviderStatus[],
): Promise<ProviderResult> {
  const started = performance.now();
  const providers = statuses ?? (await detectProviders());
  const status = providers.find((p) => p.name === request.provider);
  if (!status?.available || !status.path) {
    throw new AnalysisError(
      "provider_unavailable",
      `${request.provider} is not installed or not on PATH`,
      { provider: request.provider },
    );
  }
  if (!status.operations.includes(request.operation)) {
    throw new AnalysisError(
      "invalid_input",
      `${request.provider} does not support ${request.operation}; supported: ${status.operations.join(", ")}`,
    );
  }
  if (request.address !== undefined && !isAddress(request.address)) {
    throw new AnalysisError(
      "invalid_input",
      "address must be a hex address (0x…) or a single symbol name; engine iterators such as @@ are not accepted",
    );
  }
  if (request.operation === "search") {
    if (!request.text || request.text.length > 200)
      throw new AnalysisError("invalid_input", "search needs text of 1..200 characters");
  } else if (request.text !== undefined) {
    throw new AnalysisError("invalid_input", "text is only accepted by the search operation");
  }
  if (ADDRESS_OPERATIONS.has(request.operation) && request.address === undefined) {
    throw new AnalysisError(
      "invalid_input",
      `${request.operation} needs an address or symbol name`,
    );
  }
  const timeoutMs = request.timeoutMs ?? (request.provider === "ghidra" ? 300_000 : 120_000);
  const limitations: Limitation[] = [];
  const address = request.address ?? null;
  const needle = request.operation === "search" ? (request.text ?? "") : null;

  let run: Exec;
  let result: unknown;
  let graphOutputComplete = false;
  if (request.provider === "ghidra") {
    const digest = await contentDigest(request.targetPath);
    const projectDir = join(cacheRoot(), "ghidra", digest);
    const key =
      needle !== null
        ? createHash("sha256").update(needle).digest("hex").slice(0, 12)
        : (address ?? "all");
    // callers/callees are projected client-side from the whole graph so one export serves both
    const scriptOperation =
      request.operation === "callers" || request.operation === "callees"
        ? "callgraph"
        : request.operation;
    const outputPath = join(
      projectDir,
      `${scriptOperation}-${key.replace(/[^\w.$@-]/g, "_")}.json`,
    );
    await mkdir(projectDir, { recursive: true });
    await rm(outputPath, { force: true });
    const exists = await readFile(join(projectDir, "hexvero.gpr")).then(
      () => true,
      () => false,
    );
    const args = [
      projectDir,
      "hexvero",
      ...(exists ? ["-process", "-noanalysis"] : ["-import", request.targetPath]),
      "-scriptPath",
      ghidraScriptDir(),
      "-postScript",
      "HexveroExport.java",
      scriptOperation,
      // prefixed so a needle like "-scriptlog" can never be taken for a headless option
      needle !== null ? `text:${needle}` : (address ?? "-"),
      outputPath,
    ];
    run = await exec(status.path, args, timeoutMs, request.signal);
    if (!run.timedOut) {
      try {
        const size = (await stat(outputPath)).size;
        if (size > MAX_OUTPUT) {
          run.truncated = true;
          result = null;
          limitations.push({
            code: "output_truncated",
            message: `The export is ${size} bytes, above the ${MAX_OUTPUT} byte limit; narrow the request.`,
          });
        } else {
          result = JSON.parse(await readFile(outputPath, "utf8"));
          if (scriptOperation === "callgraph") {
            const graph = normalizeCallGraph("ghidra", result, { limitations });
            result =
              request.operation === "callgraph"
                ? graph
                : relation(graph, address, request.operation as "callers" | "callees", limitations);
          }
        }
      } catch {
        result = null;
        limitations.push({
          code: "ghidra_no_output",
          message: `The export script wrote no result. stderr: ${run.stderr.slice(-400)}`,
        });
      }
    }
    if (!exists && (run.timedOut || run.code !== 0))
      await rm(projectDir, { recursive: true, force: true });
  } else {
    const command = (request.provider === "rizin" ? RIZIN_COMMANDS : RADARE_COMMANDS)[
      request.operation
    ](address);
    run = await exec(
      status.path,
      [
        "-q",
        "-N",
        "-e",
        "scr.color=0",
        "-e",
        "scr.interactive=false",
        "-c",
        command,
        request.targetPath,
      ],
      timeoutMs,
      request.signal,
    );
    result = parseJson(run.stdout);
    const docs = parseJsonDocs(run.stdout);
    const partial = run.truncated;
    switch (request.operation) {
      case "xrefs":
        result = radareXrefs(docs);
        break;
      case "search":
        result = radareSearch(docs, needle ?? "");
        break;
      case "callgraph":
      case "callers":
      case "callees": {
        // The run is partial only when the function list or the graph itself was cut. Losing the
        // trailing flag list costs aliases, which the graph reports as a limitation of its own.
        const sections = graphSections(run.stdout);
        const whole =
          sections !== null &&
          sections["functions"] !== undefined &&
          sections["graph"] !== undefined;
        const graph = normalizeCallGraph(request.provider, sections ?? docs, {
          partial: partial && !whole,
        });
        if (partial && whole) graphOutputComplete = true;
        result =
          request.operation === "callgraph"
            ? graph
            : relation(graph, address, request.operation, limitations);
        break;
      }
      default:
        break;
    }
    if (request.operation === "decompile" && (result === null || typeof result === "string")) {
      limitations.push({
        code: "decompiler_missing",
        message: "pdgj returned nothing; install the r2ghidra/rz-ghidra plugin or use disassemble.",
      });
    }
  }
  if (run.timedOut)
    throw new AnalysisError(
      "provider_unavailable",
      `${request.provider} exceeded ${timeoutMs} ms and was killed`,
      { timeoutMs },
    );
  if (run.truncated && !graphOutputComplete)
    limitations.push({
      code: "output_truncated",
      message: `Engine output exceeded ${MAX_OUTPUT} bytes and was cut.`,
    });
  if (run.code !== 0)
    limitations.push({
      code: "engine_exit",
      message: `${request.provider} exited with ${run.code}: ${run.stderr.trim().slice(-400)}`,
    });
  return {
    provider: request.provider,
    operation: request.operation,
    address,
    durationMs: Math.round(performance.now() - started),
    result: result ?? null,
    truncated: run.truncated,
    limitations,
  };
}
