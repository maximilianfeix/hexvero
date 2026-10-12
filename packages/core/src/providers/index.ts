import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { delimiter, join } from "node:path";

export interface ProviderStatus {
  name: "radare2" | "rizin" | "ghidra";
  available: boolean;
  path?: string;
  version?: string;
  operations: string[];
}

const CANDIDATES: Record<ProviderStatus["name"], string[]> = {
  radare2: ["r2", "radare2"],
  rizin: ["rizin"],
  ghidra: ["analyzeHeadless", "analyzeHeadless.bat"],
};

export async function which(binary: string): Promise<string | null> {
  const extra = process.env["GHIDRA_INSTALL_DIR"]
    ? [join(process.env["GHIDRA_INSTALL_DIR"], "support")]
    : [];
  const dirs = [...(process.env["PATH"] ?? "").split(delimiter), ...extra];
  for (const dir of dirs) {
    if (!dir) continue;
    const full = join(dir, binary);
    try {
      await access(full);
      return full;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

function versionOf(path: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(path, args, { timeout: 5000 }, (error, stdout) =>
      resolve(error ? undefined : stdout.toString().split("\n")[0]?.trim()),
    );
  });
}

/** Looks for optional engines on PATH; never installs anything. */
export async function detectProviders(): Promise<ProviderStatus[]> {
  const out: ProviderStatus[] = [];
  for (const name of Object.keys(CANDIDATES) as ProviderStatus["name"][]) {
    let path: string | null = null;
    for (const bin of CANDIDATES[name]) {
      path = await which(bin);
      if (path) break;
    }
    const operations = !path
      ? []
      : name === "ghidra"
        ? ["functions", "decompile"]
        : ["functions", "disassemble", "decompile", "strings", "imports"];
    const status: ProviderStatus = {
      name,
      available: path !== null,
      operations,
    };
    if (path) {
      status.path = path;
      const version =
        name === "ghidra" ? undefined : await versionOf(path, ["-v"]);
      if (version) status.version = version;
    }
    out.push(status);
  }
  return out;
}
