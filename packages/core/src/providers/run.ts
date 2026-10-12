import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AnalysisError, type Limitation } from "../model.js";
import { detectProviders, type ProviderStatus } from "./index.js";

export type ProviderName = ProviderStatus["name"];
export type ProviderOperation =
  | "functions"
  | "disassemble"
  | "decompile"
  | "strings"
  | "imports";

export interface ProviderRequest {
  targetPath: string;
  provider: ProviderName;
  operation: ProviderOperation;
  address?: string | undefined;
  timeoutMs?: number | undefined;
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

function exec(
  command: string,
  args: string[],
  timeoutMs: number,
  cwd?: string,
): Promise<Exec> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      ...(cwd ? { cwd } : {}),
    });
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    const kill = (): void => {
      try {
        if (process.platform !== "win32" && child.pid)
          process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    };
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
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code, truncated, timedOut });
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

const RADARE_COMMANDS: Record<
  ProviderOperation,
  (address: string | null) => string
> = {
  functions: () => "aaa; aflj",
  disassemble: (a) => `aaa; pdfj @ ${a ?? "entry0"}`,
  decompile: (a) => `aaa; pdgj @ ${a ?? "entry0"}`,
  strings: () => "izj",
  imports: () => "iij",
};

export function cacheRoot(): string {
  return (
    process.env["HEXVERO_CACHE_DIR"] ?? join(homedir(), ".cache", "hexvero")
  );
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
  if (request.address !== undefined && !/^[\w.$@]+$/.test(request.address)) {
    throw new AnalysisError(
      "invalid_input",
      "address must be a hex address or a symbol name",
    );
  }
  const timeoutMs =
    request.timeoutMs ?? (request.provider === "ghidra" ? 300_000 : 120_000);
  const limitations: Limitation[] = [];
  const address = request.address ?? null;

  let run: Exec;
  let result: unknown;
  if (request.provider === "ghidra") {
    const digest = createHash("sha256")
      .update(request.targetPath)
      .digest("hex")
      .slice(0, 16);
    const projectDir = join(cacheRoot(), "ghidra", digest);
    const outputPath = join(
      projectDir,
      `${request.operation}-${address ?? "all"}.json`,
    );
    await mkdir(projectDir, { recursive: true });
    const exists = await readFile(join(projectDir, "hexvero.gpr")).then(
      () => true,
      () => false,
    );
    const args = [
      projectDir,
      "hexvero",
      ...(exists
        ? ["-process", "-noanalysis"]
        : ["-import", request.targetPath]),
      "-scriptPath",
      ghidraScriptDir(),
      "-postScript",
      "HexveroExport.java",
      request.operation,
      address ?? "-",
      outputPath,
    ];
    run = await exec(status.path, args, timeoutMs);
    if (!run.timedOut) {
      try {
        result = JSON.parse(await readFile(outputPath, "utf8"));
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
    const command = RADARE_COMMANDS[request.operation](address);
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
    );
    result = parseJson(run.stdout);
    if (
      request.operation === "decompile" &&
      (result === null || typeof result === "string")
    ) {
      limitations.push({
        code: "decompiler_missing",
        message:
          "pdgj returned nothing; install the r2ghidra/rz-ghidra plugin or use disassemble.",
      });
    }
  }
  if (run.timedOut)
    throw new AnalysisError(
      "provider_unavailable",
      `${request.provider} exceeded ${timeoutMs} ms and was killed`,
      { timeoutMs },
    );
  if (run.truncated)
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
