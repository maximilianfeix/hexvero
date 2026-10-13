import { createHash } from "node:crypto";
import { latin1 } from "../binary/reader.js";
import { parseElf } from "./elf.js";
import type { Finding, Limitation } from "../model.js";

/**
 * Flutter/Dart AOT facts by pure parsing: the Dart snapshot version hash and
 * feature string from libapp.so's `_kDart*Snapshot*` symbols, the engine's
 * build id from libflutter.so, and per-ABI digests. The snapshot hash is what
 * maps to a Dart SDK release through external tables; the mapping itself is
 * reported as unknown rather than guessed.
 */
export interface DartSnapshot {
  abi: string;
  symbol: string;
  offset: number;
  size: number | null;
  kind: string | null;
  versionHash: string | null;
  features: string | null;
}

export interface FlutterInfo {
  abis: string[];
  snapshots: DartSnapshot[];
  snapshotHash: string | null;
  engineBuildIds: Record<string, string>;
  libraryDigests: Record<string, string>;
  findings: Finding[];
  limitations: Limitation[];
}

// Dart writes the magic as the byte sequence f5 f5 dc dc.
const SNAPSHOT_MAGIC = [0xf5, 0xf5, 0xdc, 0xdc];
// Snapshot::Kind changed across SDKs (kFullCore was removed in Dart 3); the number is reported with the modern names.
const KINDS: Record<number, string> = { 0: "full", 1: "full-jit", 2: "full-aot", 3: "none" };

/** Reads the Dart snapshot header: magic, length (u64), kind (u64), 32-char version hash, feature string. */
export function readDartSnapshotHeader(
  bytes: Uint8Array,
  offset: number,
  limit = bytes.length,
): (Pick<DartSnapshot, "size" | "kind" | "versionHash" | "features"> & { kindId: number }) | null {
  const end = Math.min(limit, bytes.length);
  if (offset < 0 || offset + 52 > end) return null;
  if (!SNAPSHOT_MAGIC.every((b, i) => bytes[offset + i] === b)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 20);
  const length = view.getBigUint64(4, true);
  const kindBig = view.getBigUint64(12, true);
  if (length < 48n || length > BigInt(end - offset - 4) || kindBig > 16n) return null;
  const size = Number(length) + 4; // stored length excludes the magic
  const kindId = Number(kindBig);
  const hash = latin1(bytes.subarray(offset + 20, offset + 52));
  const versionHash = /^[0-9a-f]{32}$/.test(hash) ? hash : null;
  let features: string | null = null;
  if (versionHash) {
    const featuresEnd = Math.min(offset + size, end);
    const nul = bytes.subarray(offset + 52, featuresEnd).indexOf(0);
    features = nul === -1 ? null : latin1(bytes.subarray(offset + 52, offset + 52 + nul));
  }
  return { size, kind: KINDS[kindId] ?? `kind${kindId}`, kindId, versionHash, features };
}

export function inspectDartLibrary(
  bytes: Uint8Array,
  abi: string,
): { snapshots: DartSnapshot[]; limitations: Limitation[] } {
  const limitations: Limitation[] = [];
  const snapshots: DartSnapshot[] = [];
  let elf;
  try {
    elf = parseElf(bytes);
  } catch (error) {
    limitations.push({
      code: "dart_elf_unreadable",
      message: `${abi}: ${error instanceof Error ? error.message : String(error)}`,
    });
    return { snapshots, limitations };
  }
  const loads = elf.segments.filter((s) => s.type === "LOAD");
  const toOffset = (va: bigint): number | null => {
    for (const s of loads) {
      const base = BigInt(s.vaddr);
      if (va >= base && va < base + BigInt(s.fileSize)) return s.offset + Number(va - base);
    }
    return null;
  };
  for (const sym of elf.symbols) {
    if (!/^_kDart(Vm|Isolate)Snapshot(Data|Instructions)$/.test(sym.name) || sym.table !== "dynsym")
      continue;
    const offset = toOffset(BigInt(sym.value));
    if (offset === null) {
      limitations.push({
        code: "dart_symbol_unmapped",
        message: `${abi}: ${sym.name} is outside every LOAD segment.`,
      });
      continue;
    }
    const header = sym.name.endsWith("Data") ? readDartSnapshotHeader(bytes, offset) : null;
    if (sym.name.endsWith("Data") && !header)
      limitations.push({
        code: "dart_snapshot_header_invalid",
        message: `${abi}: ${sym.name} does not start with a valid snapshot header.`,
      });
    snapshots.push({
      abi,
      symbol: sym.name,
      offset,
      size: header?.size ?? (sym.size || null),
      kind: header?.kind ?? null,
      versionHash: header?.versionHash ?? null,
      features: header?.features ?? null,
    });
  }
  if (!snapshots.length)
    limitations.push({
      code: "dart_no_snapshots",
      message: `${abi}: no _kDart*Snapshot* symbols; the library may be stripped or not a Dart AOT image.`,
    });
  return { snapshots, limitations };
}

/** Summarises Flutter facts from the APK's per-ABI libapp.so / libflutter.so contents. */
export function summarizeFlutter(
  libs: Array<{ abi: string; name: string; bytes: Uint8Array }>,
): FlutterInfo {
  const findings: Finding[] = [];
  const limitations: Limitation[] = [];
  const snapshots: DartSnapshot[] = [];
  const engineBuildIds: Record<string, string> = {};
  const libraryDigests: Record<string, string> = {};
  const abis = [...new Set(libs.map((l) => l.abi))].toSorted();
  for (const lib of libs) {
    libraryDigests[`${lib.abi}/${lib.name}`] = createHash("sha256").update(lib.bytes).digest("hex");
    if (lib.name === "libapp.so") {
      const r = inspectDartLibrary(lib.bytes, lib.abi);
      snapshots.push(...r.snapshots);
      limitations.push(...r.limitations);
    } else if (lib.name === "libflutter.so") {
      try {
        const elf = parseElf(lib.bytes);
        if (elf.buildId) engineBuildIds[lib.abi] = elf.buildId;
      } catch {
        limitations.push({
          code: "flutter_engine_unreadable",
          message: `${lib.abi}/libflutter.so could not be parsed.`,
        });
      }
    }
  }
  const hashes = [
    ...new Set(snapshots.map((s) => s.versionHash).filter((h): h is string => h !== null)),
  ];
  const snapshotHash = hashes[0] ?? null;
  if (hashes.length > 1)
    limitations.push({
      code: "dart_snapshot_hash_mismatch",
      message: `ABIs carry different snapshot hashes: ${hashes.join(", ")}`,
    });
  if (snapshotHash) {
    const features = snapshots.find((s) => s.features)?.features ?? "";
    findings.push({
      kind: "flutter.snapshot",
      title: `Dart AOT snapshot ${snapshotHash.slice(0, 12)}… (${/product/.test(features) ? "release" : "debug/profile"} build)`,
      detail: features.split(" ").slice(0, 8).join(" "),
      confidence: "confirmed",
    });
    limitations.push({
      code: "dart_sdk_version_unmapped",
      message:
        "The snapshot hash identifies the Dart SDK build; mapping it to a version needs an external table (e.g. reFlutter's).",
    });
  }
  return { abis, snapshots, snapshotHash, engineBuildIds, libraryDigests, findings, limitations };
}
