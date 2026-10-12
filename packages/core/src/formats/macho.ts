import { ByteReader, cstringAt, hex } from "../binary/reader.js";
import { AnalysisError, type Finding, type Limitation } from "../model.js";

export interface MachoSegment {
  name: string;
  vmaddr: string;
  vmsize: number;
  fileOffset: number;
  fileSize: number;
  protection: string;
  sections: Array<{
    name: string;
    address: string;
    size: number;
    offset: number;
  }>;
}

export interface MachoSymbol {
  name: string;
  value: string;
  type: "external" | "undefined" | "local" | "absolute";
  section: number;
}

export interface MachoInfo {
  bits: 32 | 64;
  cpu: string;
  fileType: string;
  flags: string[];
  uuid: string | null;
  platform: { name: string; minOs: string; sdk: string } | null;
  entry: string | null;
  dylibs: Array<{ path: string; kind: "load" | "weak" | "reexport" | "id" }>;
  rpaths: string[];
  segments: MachoSegment[];
  symbols: MachoSymbol[];
  encrypted: boolean;
  codeSigned: boolean;
  mitigations: Record<
    "pie" | "canary" | "arc" | "restrict" | "stripped",
    boolean
  >;
  findings: Finding[];
  limitations: Limitation[];
}

export interface MachoFatInfo {
  slices: Array<{ cpu: string; offset: number; size: number; info: MachoInfo }>;
}

const CPUS: Record<number, string> = {
  7: "x86",
  0x01000007: "x86-64",
  12: "arm",
  0x0100000c: "arm64",
  0x0200000c: "arm64_32",
  18: "powerpc",
  0x01000012: "powerpc64",
};
const FILE_TYPES: Record<number, string> = {
  1: "object",
  2: "executable",
  6: "dylib",
  7: "dylinker",
  8: "bundle",
  9: "dsym",
  11: "kext",
};
const PLATFORMS: Record<number, string> = {
  1: "macOS",
  2: "iOS",
  3: "tvOS",
  4: "watchOS",
  5: "bridgeOS",
  6: "Mac Catalyst",
  7: "iOS Simulator",
  8: "tvOS Simulator",
  9: "watchOS Simulator",
  11: "visionOS",
};
const prot = (p: number): string =>
  `${p & 1 ? "r" : "-"}${p & 2 ? "w" : "-"}${p & 4 ? "x" : "-"}`;
const version = (v: number): string =>
  `${v >> 16}.${(v >> 8) & 0xff}.${v & 0xff}`;

/** Reads the fat header without parsing the slices. */
export function listFatSlices(
  bytes: Uint8Array,
): Array<{ cpu: string; offset: number; size: number }> {
  const r = new ByteReader(bytes, 4, false);
  const count = r.u32();
  const slices: Array<{ cpu: string; offset: number; size: number }> = [];
  for (let i = 0; i < count; i++) {
    const cpu = r.u32();
    r.u32();
    const offset = r.u32();
    const size = r.u32();
    r.u32();
    if (offset + size > bytes.length)
      throw new AnalysisError("malformed", `fat slice ${i} exceeds file`);
    slices.push({ cpu: CPUS[cpu] ?? hex(cpu), offset, size });
  }
  return slices;
}

export function parseMachoFat(bytes: Uint8Array): MachoFatInfo {
  return {
    slices: listFatSlices(bytes).map((s) => ({
      ...s,
      info: parseMacho(bytes.subarray(s.offset, s.offset + s.size)),
    })),
  };
}

export function parseMacho(bytes: Uint8Array): MachoInfo {
  if (bytes.length < 28)
    throw new AnalysisError("malformed", "Mach-O header truncated");
  const m =
    ((bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!) >>>
    0;
  const little = m === 0xcefaedfe || m === 0xcffaedfe;
  const bits: 32 | 64 = m === 0xfeedfacf || m === 0xcffaedfe ? 64 : 32;
  const r = new ByteReader(bytes, 4, little);
  const findings: Finding[] = [];
  const limitations: Limitation[] = [];
  const cpu = r.u32();
  r.u32(); // subtype
  const fileType = r.u32();
  const ncmds = r.u32();
  r.u32(); // sizeofcmds
  const flags = r.u32();
  if (bits === 64) r.u32();

  const segments: MachoSegment[] = [];
  const dylibs: MachoInfo["dylibs"] = [];
  const rpaths: string[] = [];
  const symbols: MachoSymbol[] = [];
  let uuid: string | null = null;
  let platform: MachoInfo["platform"] = null;
  let entry: string | null = null;
  let encrypted = false;
  let codeSigned = false;

  for (let i = 0; i < ncmds; i++) {
    const start = r.offset;
    if (start + 8 > bytes.length) {
      limitations.push({
        code: "load_commands_truncated",
        message: `Load command ${i} runs past the end.`,
      });
      break;
    }
    const cmd = r.u32();
    const size = r.u32();
    if (size < 8 || start + size > bytes.length) {
      limitations.push({
        code: "load_command_invalid",
        message: `Load command ${hex(cmd)} has invalid size ${size}.`,
      });
      break;
    }
    const lcString = (): string => {
      r.seek(start + 8);
      const off = r.u32();
      return cstringAt(bytes, start + off, size - off);
    };
    switch (cmd) {
      case 0x1:
      case 0x19: {
        const is64 = cmd === 0x19;
        const name = r.fixedString(16);
        const vmaddr = is64 ? r.u64() : BigInt(r.u32());
        const vmsize = is64 ? r.u64n() : r.u32();
        const fileOffset = is64 ? r.u64n() : r.u32();
        const fileSize = is64 ? r.u64n() : r.u32();
        r.u32(); // maxprot
        const initprot = r.u32();
        const nsects = r.u32();
        r.u32(); // flags
        const sections: MachoSegment["sections"] = [];
        for (let s = 0; s < nsects; s++) {
          const sectName = r.fixedString(16);
          r.fixedString(16);
          const addr = is64 ? r.u64() : BigInt(r.u32());
          const sectSize = is64 ? r.u64n() : r.u32();
          const offset = r.u32();
          r.skip(is64 ? 28 : 24); // align, reloff, nreloc, flags, reserved1..3 (64-bit adds reserved3)
          sections.push({
            name: sectName,
            address: hex(addr),
            size: sectSize,
            offset,
          });
        }
        segments.push({
          name,
          vmaddr: hex(vmaddr),
          vmsize,
          fileOffset,
          fileSize,
          protection: prot(initprot),
          sections,
        });
        break;
      }
      case 0x2: {
        const symoff = r.u32();
        const declared = r.u32();
        const nsyms = Math.min(declared, 200_000);
        if (declared > nsyms) {
          limitations.push({
            code: "symbols_truncated",
            message: `Symbol table truncated to ${nsyms} of ${declared} entries.`,
          });
        }
        const stroff = r.u32();
        const entSize = bits === 64 ? 16 : 12;
        for (
          let s = 0;
          s < nsyms && symoff + (s + 1) * entSize <= bytes.length;
          s++
        ) {
          r.seek(symoff + s * entSize);
          const strx = r.u32();
          const ntype = r.u8();
          const sect = r.u8();
          r.u16();
          const value = bits === 64 ? r.u64() : BigInt(r.u32());
          if (ntype & 0xe0) continue; // debugging (stab) entries
          const name = cstringAt(bytes, stroff + strx);
          if (!name) continue;
          const kind = ntype & 0x0e;
          symbols.push({
            name,
            value: hex(value),
            type:
              kind === 0
                ? "undefined"
                : kind === 2
                  ? "absolute"
                  : ntype & 1
                    ? "external"
                    : "local",
            section: sect,
          });
        }
        break;
      }
      case 0xc:
        dylibs.push({ path: lcString(), kind: "load" });
        break;
      case 0xd:
        dylibs.push({ path: lcString(), kind: "id" });
        break;
      case 0x80000018:
        dylibs.push({ path: lcString(), kind: "weak" });
        break;
      case 0x8000001f:
        dylibs.push({ path: lcString(), kind: "reexport" });
        break;
      case 0x8000001c:
        rpaths.push(lcString());
        break;
      case 0x1b:
        uuid = Buffer.from(r.bytesAt(16))
          .toString("hex")
          .replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5");
        break;
      case 0x32:
        platform = {
          name: PLATFORMS[r.u32()] ?? "unknown",
          minOs: version(r.u32()),
          sdk: version(r.u32()),
        };
        break;
      case 0x24:
      case 0x25:
      case 0x2f:
      case 0x30:
        if (!platform) {
          const names: Record<number, string> = {
            0x24: "macOS",
            0x25: "iOS",
            0x2f: "tvOS",
            0x30: "watchOS",
          };
          platform = {
            name: names[cmd]!,
            minOs: version(r.u32()),
            sdk: version(r.u32()),
          };
        }
        break;
      case 0x80000028:
        entry = hex(r.u64());
        break;
      case 0x1d:
        codeSigned = true;
        break;
      case 0x21:
      case 0x2c:
        r.skip(8);
        encrypted = r.u32() !== 0;
        break;
      default:
        break;
    }
    r.seek(start + size);
  }

  const names = new Set(symbols.map((s) => s.name));
  const flagNames: string[] = [];
  if (flags & 0x200000) flagNames.push("PIE");
  if (flags & 0x1) flagNames.push("NOUNDEFS");
  if (flags & 0x4) flagNames.push("DYLDLINK");
  if (flags & 0x80) flagNames.push("TWOLEVEL");
  if (flags & 0x800000) flagNames.push("NO_HEAP_EXECUTION");

  const hasLocalFuncs = symbols.some((s) => s.type === "local");
  if (encrypted)
    findings.push({
      kind: "macho.encrypted",
      title: "Encrypted with FairPlay (cryptid != 0)",
      detail: "Decrypt on a device before static analysis.",
      confidence: "confirmed",
    });
  if (names.has("_ptrace") || names.has("_sysctl")) {
    findings.push({
      kind: "macho.anti-debug",
      title: "Imports ptrace/sysctl (possible anti-debugging)",
      confidence: "inferred",
    });
  }
  const swift = dylibs.some((d) => d.path.includes("libswiftCore"));
  if (swift)
    findings.push({
      kind: "macho.swift",
      title: "Links Swift runtime",
      confidence: "confirmed",
    });
  const objc = segments.some((s) =>
    s.sections.some((x) => x.name.startsWith("__objc_")),
  );
  if (objc)
    findings.push({
      kind: "macho.objc",
      title: "Contains Objective-C metadata sections",
      confidence: "confirmed",
    });

  return {
    bits,
    cpu: CPUS[cpu] ?? hex(cpu),
    fileType: FILE_TYPES[fileType] ?? hex(fileType),
    flags: flagNames,
    uuid,
    platform,
    entry,
    dylibs,
    rpaths,
    segments,
    symbols,
    encrypted,
    codeSigned,
    mitigations: {
      pie: (flags & 0x200000) !== 0,
      canary: names.has("___stack_chk_fail"),
      arc: names.has("_objc_release") || names.has("_objc_retain"),
      restrict: segments.some((s) => s.name === "__RESTRICT"),
      stripped: !hasLocalFuncs,
    },
    findings,
    limitations,
  };
}
