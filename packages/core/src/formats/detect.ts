import type { FormatId } from "../model.js";
import { latin1 } from "../binary/reader.js";

const MAGIC: Array<[FormatId, number[]]> = [
  ["elf", [0x7f, 0x45, 0x4c, 0x46]],
  ["wasm", [0x00, 0x61, 0x73, 0x6d]],
  ["macho", [0xfe, 0xed, 0xfa, 0xce]],
  ["macho", [0xfe, 0xed, 0xfa, 0xcf]],
  ["macho", [0xce, 0xfa, 0xed, 0xfe]],
  ["macho", [0xcf, 0xfa, 0xed, 0xfe]],
  ["macho-fat", [0xca, 0xfe, 0xba, 0xbe]],
  ["zip", [0x50, 0x4b, 0x03, 0x04]],
  ["zip", [0x50, 0x4b, 0x05, 0x06]],
];

function startsWith(bytes: Uint8Array, magic: number[]): boolean {
  if (bytes.length < magic.length) return false;
  return magic.every((value, index) => bytes[index] === value);
}

/**
 * Detects the container format from content first and the filename second.
 * Content wins so that a misnamed `.txt` that is really an ELF is still parsed.
 */
export function detectFormat(bytes: Uint8Array, name = ""): FormatId {
  for (const [format, magic] of MAGIC) {
    if (startsWith(bytes, magic)) return refine(format, bytes, name);
  }
  if (startsWith(bytes, [0x4d, 0x5a])) return "pe";
  if (latin1(bytes.subarray(0, 16)) === "SQLite format 3\0") return "sqlite";
  if (latin1(bytes.subarray(0, 4)) === "dex\n") return "dex";
  if (latin1(bytes.subarray(0, 6)) === "bplist") return "plist-binary";

  const head = latin1(bytes.subarray(0, 512)).trimStart();
  if (head.startsWith("<?xml") && head.includes("<plist")) return "plist-xml";
  if (
    /^(0x)?[0-9a-fA-F]{8,}\s*$/.test(
      latin1(bytes.subarray(0, Math.min(bytes.length, 65536))),
    )
  ) {
    return "evm-hex";
  }
  const lower = name.toLowerCase();
  if (lower.endsWith(".asar") || isAsarHeader(bytes)) return "asar";
  if (lower.endsWith(".json") || lower.endsWith(".har")) return "json";
  if (/\.(m?js|cjs|jsx|ts|tsx)$/.test(lower)) return "javascript";
  if (lower.endsWith(".plist")) return "plist-xml";
  return "unknown";
}

function refine(format: FormatId, bytes: Uint8Array, name: string): FormatId {
  if (format === "zip") {
    const lower = name.toLowerCase();
    if (/\.(jar|war|ear|aar)$/.test(lower)) return "jar";
    if (lower.endsWith(".apk") || hasApkManifest(bytes)) return "apk";
    if (hasJarManifest(bytes)) return "jar";
  }
  if (format === "macho-fat" && bytes.length >= 8) {
    // Java class files share the CAFEBABE magic; fat headers have a small arch count.
    const count =
      (bytes[4]! << 24) | (bytes[5]! << 16) | (bytes[6]! << 8) | bytes[7]!;
    if (count > 32) return "java-class";
  }
  return format;
}

function hasJarManifest(bytes: Uint8Array): boolean {
  return latin1(bytes.subarray(0, Math.min(bytes.length, 1 << 20))).includes(
    "META-INF/MANIFEST.MF",
  );
}

function hasApkManifest(bytes: Uint8Array): boolean {
  const probe = latin1(bytes.subarray(0, Math.min(bytes.length, 1 << 20)));
  return probe.includes("AndroidManifest.xml") || probe.includes("classes.dex");
}

/** Electron ASAR: u32 header-size pickle followed by a JSON tree starting with `{"files"`. */
function isAsarHeader(bytes: Uint8Array): boolean {
  if (bytes.length < 24) return false;
  return latin1(bytes.subarray(16, 24)).startsWith('{"files"');
}
