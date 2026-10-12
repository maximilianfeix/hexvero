import { latin1 } from "../binary/reader.js";
import type { Finding } from "../model.js";

/**
 * Toolchain facts shared by every executable container: which compiler built
 * it, whether debug info shipped, and which language runtimes are linked.
 * Everything here is a string or section observation, so each finding states
 * its confidence honestly.
 */
export interface ToolchainFacts {
  compiler: string | null;
  rust: string | null;
  swift: boolean;
  objc: boolean;
  debugInfo: boolean;
  findings: Finding[];
}

const COMPILER_PATTERNS: Array<[RegExp, string]> = [
  [/GCC: \(([^)]*)\) ([\d.]+)/, "GCC"],
  [/Apple (?:clang|LLVM) version ([\d.]+)/, "Apple clang"],
  [/clang version ([\d.]+)/, "clang"],
  [/Microsoft \(R\) (?:Optimizing Compiler|C\/C\+\+) Version ([\d.]+)/, "MSVC"],
  [/Go cmd\/compile|go1\.\d+/, "Go"],
  [/\.NET (?:Framework|Core)|mscoree\.dll/, ".NET"],
];

// Printable-ASCII classes keep binary noise (NULs, high bytes) out of the captured path.
const BUILD_PATH = /(\/(?:home|Users)\/[\x21-\x2e\x30-\x7e]+\/[\x21-\x7e]{0,60})/;

export function detectToolchain(
  bytes: Uint8Array,
  context: {
    comment?: string;
    sectionNames: string[];
    symbolNames: Iterable<string>;
    libraries: string[];
  },
): ToolchainFacts {
  const findings: Finding[] = [];
  const probe = latin1(bytes.subarray(0, Math.min(bytes.length, 48 << 20)));
  const names = new Set(context.sectionNames);

  let compiler: string | null = null;
  const comment = context.comment ?? "";
  for (const [re, name] of COMPILER_PATTERNS) {
    const m = re.exec(comment) ?? re.exec(probe);
    if (!m) continue;
    compiler = m[0].length < 80 ? m[0].trim() : `${name} ${m[1] ?? ""}`.trim();
    findings.push({
      kind: "toolchain.compiler",
      title: `Compiled with ${compiler}`,
      confidence: comment && re.test(comment) ? "confirmed" : "inferred",
    });
    break;
  }

  let rust: string | null = null;
  const rustc = /rustc\/([0-9a-f]{40})|rustc version ([\d.]+(?:-[\w.]+)?)/.exec(probe);
  const rustSymbol = [...context.symbolNames].some((s) =>
    /^_?(_ZN4core|_ZN3std|rust_panic|__rust_alloc)/.test(s),
  );
  if (rustc || rustSymbol) {
    rust = rustc?.[2] ?? (rustc?.[1] ? `commit ${rustc[1].slice(0, 9)}` : "detected");
    findings.push({
      kind: "toolchain.rust",
      title: `Rust binary${rustc?.[2] ? ` (rustc ${rustc[2]})` : rustc?.[1] ? ` (rustc ${rustc[1].slice(0, 9)})` : ""}`,
      confidence: rustSymbol || rustc ? "confirmed" : "inferred",
    });
  }

  const debugInfo = [...names].some(
    (n) =>
      n.startsWith(".debug_") ||
      n.startsWith(".zdebug_") ||
      n === "__debug_info" ||
      n === "__DWARF",
  );
  if (debugInfo)
    findings.push({
      kind: "toolchain.dwarf",
      title: "DWARF debug information present",
      detail: "Source paths, types and line tables are recoverable.",
      confidence: "confirmed",
    });

  const swift =
    context.libraries.some((l) => l.includes("libswiftCore")) ||
    names.has("__swift5_typeref") ||
    [...names].some((n) => n.startsWith("__swift5_"));
  const objc = [...names].some((n) => n.startsWith("__objc_"));
  const buildPath = BUILD_PATH.exec(probe)?.[1];
  if (buildPath) {
    findings.push({
      kind: "toolchain.build-path",
      title: "Build machine paths embedded",
      detail: buildPath,
      confidence: "confirmed",
    });
  }
  return { compiler, rust, swift, objc, debugInfo, findings };
}
