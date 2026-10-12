import { ByteReader, cstringAt, hex, latin1 } from "../binary/reader.js";
import { AnalysisError, type Finding, type Limitation } from "../model.js";

export interface PeSection {
  name: string;
  virtualAddress: string;
  virtualSize: number;
  rawOffset: number;
  rawSize: number;
  flags: string;
  entropy: number;
}

export interface PeImport {
  dll: string;
  functions: string[];
}

export interface PeExport {
  name: string;
  ordinal: number;
  rva: string;
  forwarder?: string;
}

export interface PeInfo {
  machine: string;
  bits: 32 | 64;
  subsystem: string;
  timestamp: string;
  entry: string;
  imageBase: string;
  isDll: boolean;
  isClr: boolean;
  pdbPath: string | null;
  sections: PeSection[];
  imports: PeImport[];
  exports: PeExport[];
  dataDirectories: Record<string, { rva: string; size: number }>;
  mitigations: Record<
    "aslr" | "highEntropyVa" | "nx" | "cfg" | "seh" | "gs" | "authenticode",
    boolean | "unknown"
  >;
  clrHeaderRva: number | null;
  findings: Finding[];
  limitations: Limitation[];
  /** Converts an RVA into a file offset; null when it lies outside every section. */
  rvaToOffset(rva: number): number | null;
}

const MACHINES: Record<number, string> = {
  0x14c: "x86",
  0x8664: "x86-64",
  0x1c0: "arm",
  0x1c4: "armv7-thumb2",
  0xaa64: "arm64",
  0x200: "ia64",
  0x5064: "riscv64",
};
const SUBSYSTEMS: Record<number, string> = {
  1: "native",
  2: "windows-gui",
  3: "windows-console",
  7: "posix",
  9: "windows-ce",
  10: "efi-application",
  11: "efi-boot-driver",
  12: "efi-runtime-driver",
  16: "windows-boot-application",
};
const DIRECTORIES = [
  "export",
  "import",
  "resource",
  "exception",
  "security",
  "basereloc",
  "debug",
  "architecture",
  "globalptr",
  "tls",
  "loadconfig",
  "boundimport",
  "iat",
  "delayimport",
  "clr",
  "reserved",
];

export function shannonEntropy(bytes: Uint8Array): number {
  if (bytes.length === 0) return 0;
  const counts = new Uint32Array(256);
  for (const b of bytes) counts[b]!++;
  let entropy = 0;
  for (const c of counts) {
    if (c === 0) continue;
    const p = c / bytes.length;
    entropy -= p * Math.log2(p);
  }
  return Math.round(entropy * 100) / 100;
}

export function parsePe(bytes: Uint8Array): PeInfo {
  if (bytes.length < 0x40 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) {
    throw new AnalysisError("malformed", "Missing MZ header");
  }
  const r = new ByteReader(bytes, 0x3c);
  const peOffset = r.u32();
  if (
    peOffset + 24 > bytes.length ||
    latin1(bytes.subarray(peOffset, peOffset + 4)) !== "PE\0\0"
  ) {
    throw new AnalysisError(
      "malformed",
      "Missing PE signature (DOS-only executable?)",
    );
  }
  const limitations: Limitation[] = [];
  const findings: Finding[] = [];
  r.seek(peOffset + 4);
  const machine = r.u16();
  const sectionCount = r.u16();
  const timestamp = r.u32();
  r.u32(); // symbol table ptr
  r.u32(); // symbol count
  const optionalSize = r.u16();
  const characteristics = r.u16();

  const optStart = r.offset;
  const magic = r.u16();
  const bits: 32 | 64 = magic === 0x20b ? 64 : 32;
  if (magic !== 0x10b && magic !== 0x20b)
    throw new AnalysisError(
      "malformed",
      `Unknown optional header magic ${hex(magic)}`,
    );
  r.seek(optStart + 16);
  const entry = r.u32();
  r.seek(bits === 64 ? optStart + 24 : optStart + 28);
  const imageBase = bits === 64 ? r.u64n() : r.u32();
  r.seek(optStart + 68);
  const subsystem = r.u16();
  const dllCharacteristics = r.u16();
  r.seek(bits === 64 ? optStart + 108 : optStart + 92);
  const dirCount = Math.min(r.u32(), 16);
  const dirs: Array<{ rva: number; size: number }> = [];
  for (let i = 0; i < dirCount; i++) dirs.push({ rva: r.u32(), size: r.u32() });

  // Sections
  const sections: PeSection[] = [];
  const rawSections: Array<{
    va: number;
    vsize: number;
    raw: number;
    rawSize: number;
  }> = [];
  r.seek(optStart + optionalSize);
  for (let i = 0; i < sectionCount && r.remaining >= 40; i++) {
    const name = r.fixedString(8);
    const vsize = r.u32();
    const va = r.u32();
    const rawSize = r.u32();
    const raw = r.u32();
    r.skip(12);
    const flags = r.u32();
    rawSections.push({ va, vsize, raw, rawSize });
    const body = bytes.subarray(raw, Math.min(bytes.length, raw + rawSize));
    sections.push({
      name,
      virtualAddress: hex(va),
      virtualSize: vsize,
      rawOffset: raw,
      rawSize,
      flags: `${flags & 0x40000000 ? "r" : "-"}${
        flags & 0x80000000 ? "w" : "-"
      }${flags & 0x20000000 ? "x" : "-"}`,
      entropy: shannonEntropy(body),
    });
  }
  const rvaToOffset = (rva: number): number | null => {
    for (const s of rawSections) {
      const span = Math.max(s.vsize, s.rawSize);
      if (rva >= s.va && rva < s.va + span) {
        const off = s.raw + (rva - s.va);
        return off < bytes.length ? off : null;
      }
    }
    return rva < bytes.length && rawSections.length === 0 ? rva : null;
  };
  const readString = (rva: number): string => {
    const off = rvaToOffset(rva);
    return off === null ? "" : cstringAt(bytes, off);
  };

  // Imports
  const imports: PeImport[] = [];
  const importDir = dirs[1];
  if (importDir && importDir.rva) {
    let at = rvaToOffset(importDir.rva);
    for (
      let n = 0;
      at !== null && at + 20 <= bytes.length && n < 512;
      n++, at += 20
    ) {
      r.seek(at);
      const oft = r.u32();
      r.skip(8);
      const nameRva = r.u32();
      const ft = r.u32();
      if (nameRva === 0 && ft === 0) break;
      const functions: string[] = [];
      let thunk = rvaToOffset(oft || ft);
      const step = bits === 64 ? 8 : 4;
      for (
        let i = 0;
        thunk !== null && thunk + step <= bytes.length && i < 4096;
        i++, thunk += step
      ) {
        r.seek(thunk);
        const value = bits === 64 ? r.u64() : BigInt(r.u32());
        if (value === 0n) break;
        const byOrdinal = bits === 64 ? value >> 63n : value >> 31n;
        if (byOrdinal) functions.push(`#${Number(value & 0xffffn)}`);
        else functions.push(readString(Number(value & 0x7fffffffn) + 2));
      }
      imports.push({ dll: readString(nameRva), functions });
    }
  }

  // Exports
  const exports: PeExport[] = [];
  const exportDir = dirs[0];
  if (exportDir && exportDir.rva) {
    const at = rvaToOffset(exportDir.rva);
    if (at !== null && at + 40 <= bytes.length) {
      r.seek(at + 16);
      const base = r.u32();
      const funcCount = r.u32();
      const nameCount = r.u32();
      const funcs = rvaToOffset(r.u32());
      const names = rvaToOffset(r.u32());
      const ords = rvaToOffset(r.u32());
      const limit = Math.min(nameCount, 20_000);
      if (nameCount > limit)
        limitations.push({
          code: "exports_truncated",
          message: `Exports truncated to ${limit}.`,
        });
      const tables =
        names !== null && ords !== null && funcs !== null
          ? { names, ords, funcs }
          : null;
      for (let i = 0; tables && i < limit; i++) {
        r.seek(tables.names + i * 4);
        const name = readString(r.u32());
        r.seek(tables.ords + i * 2);
        const ordinal = r.u16();
        if (ordinal >= funcCount) continue;
        r.seek(tables.funcs + ordinal * 4);
        const rva = r.u32();
        const inExportDir =
          rva >= exportDir.rva && rva < exportDir.rva + exportDir.size;
        const item: PeExport = { name, ordinal: ordinal + base, rva: hex(rva) };
        if (inExportDir) item.forwarder = readString(rva);
        exports.push(item);
      }
    }
  }

  // Debug directory → PDB path
  let pdbPath: string | null = null;
  const debugDir = dirs[6];
  if (debugDir && debugDir.rva) {
    const at = rvaToOffset(debugDir.rva) ?? -1;
    const count = at < 0 ? 0 : Math.min(Math.floor(debugDir.size / 28), 16);
    for (let i = 0; i < count && at + (i + 1) * 28 <= bytes.length; i++) {
      r.seek(at + i * 28 + 12);
      const dtype = r.u32();
      const size = r.u32();
      r.u32();
      const ptr = r.u32();
      if (
        dtype === 2 &&
        ptr + size <= bytes.length &&
        latin1(bytes.subarray(ptr, ptr + 4)) === "RSDS"
      ) {
        pdbPath = cstringAt(bytes, ptr + 24);
      }
    }
  }

  // Load config → /GS cookie
  let gs: boolean | "unknown" = "unknown";
  const loadConfig = dirs[10];
  if (loadConfig && loadConfig.rva) {
    const at = rvaToOffset(loadConfig.rva);
    const cookieOffset = bits === 64 ? 88 : 60;
    if (at !== null && at + cookieOffset + 8 <= bytes.length) {
      r.seek(at + cookieOffset);
      gs = (bits === 64 ? r.u64() : BigInt(r.u32())) !== 0n;
    }
  } else gs = false;

  const clr = dirs[14];
  const isClr = Boolean(clr && clr.rva && clr.size);
  const dataDirectories: PeInfo["dataDirectories"] = {};
  dirs.forEach((d, i) => {
    if (d.rva || d.size)
      dataDirectories[DIRECTORIES[i]!] = { rva: hex(d.rva), size: d.size };
  });
  if (isClr)
    findings.push({
      kind: "pe.clr",
      title: ".NET assembly (CLR header present)",
      confidence: "confirmed",
    });
  if (pdbPath)
    findings.push({
      kind: "pe.pdb",
      title: "PDB path embedded",
      detail: pdbPath,
      confidence: "confirmed",
    });
  const packed = sections.filter((s) => s.entropy > 7.2 && s.rawSize > 4096);
  if (packed.length) {
    findings.push({
      kind: "pe.high-entropy",
      title: `High-entropy sections: ${packed.map((s) => s.name || "?").join(", ")}`,
      detail: "Possible packing, compression or embedded encrypted payload.",
      confidence: "inferred",
    });
  }
  if (!dirs[2]?.rva)
    limitations.push({
      code: "no_resources",
      message: "No resource directory; version info unavailable.",
    });

  return {
    machine: MACHINES[machine] ?? hex(machine),
    bits,
    subsystem: SUBSYSTEMS[subsystem] ?? String(subsystem),
    timestamp: new Date(timestamp * 1000).toISOString(),
    entry: hex(entry),
    imageBase: hex(imageBase),
    isDll: (characteristics & 0x2000) !== 0,
    isClr,
    pdbPath,
    sections,
    imports,
    exports,
    dataDirectories,
    mitigations: {
      aslr: (dllCharacteristics & 0x40) !== 0,
      highEntropyVa: (dllCharacteristics & 0x20) !== 0,
      nx: (dllCharacteristics & 0x100) !== 0,
      cfg: (dllCharacteristics & 0x4000) !== 0,
      seh: (dllCharacteristics & 0x400) === 0,
      gs,
      authenticode: Boolean(dirs[4]?.size),
    },
    clrHeaderRva: isClr ? clr!.rva : null,
    findings,
    limitations,
    rvaToOffset,
  };
}
