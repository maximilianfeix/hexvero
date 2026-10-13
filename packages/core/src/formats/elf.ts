import { ByteReader, cstringAt, hex } from "../binary/reader.js";
import { AnalysisError, type Finding, type Limitation } from "../model.js";

export interface ElfSection {
  index: number;
  name: string;
  type: number;
  typeName: string;
  flags: string;
  address: string;
  offset: number;
  size: number;
}

export interface ElfSegment {
  type: string;
  flags: string;
  offset: number;
  vaddr: string;
  fileSize: number;
  memSize: number;
}

export interface ElfSymbol {
  name: string;
  value: string;
  size: number;
  type: string;
  binding: string;
  section: string;
  table: "symtab" | "dynsym";
}

export interface ElfInfo {
  class: 32 | 64;
  endian: "little" | "big";
  osabi: string;
  type: string;
  machine: string;
  entry: string;
  interpreter: string | null;
  buildId: string | null;
  soname: string | null;
  needed: string[];
  rpath: string[];
  sections: ElfSection[];
  segments: ElfSegment[];
  symbols: ElfSymbol[];
  mitigations: Record<
    "nx" | "pie" | "relro" | "canary" | "fortify" | "stripped",
    boolean | "partial"
  >;
  findings: Finding[];
  limitations: Limitation[];
}

const MACHINES: Record<number, string> = {
  0x03: "x86",
  0x08: "mips",
  0x14: "powerpc",
  0x15: "powerpc64",
  0x28: "arm",
  0x2a: "superh",
  0x32: "ia64",
  0x3e: "x86-64",
  0xb7: "aarch64",
  0xf3: "riscv",
  0xf7: "bpf",
  0x102: "loongarch",
};
const TYPES: Record<number, string> = {
  1: "relocatable",
  2: "executable",
  3: "shared-object",
  4: "core",
};
const SECTION_TYPES: Record<number, string> = {
  0: "NULL",
  1: "PROGBITS",
  2: "SYMTAB",
  3: "STRTAB",
  4: "RELA",
  5: "HASH",
  6: "DYNAMIC",
  7: "NOTE",
  8: "NOBITS",
  9: "REL",
  11: "DYNSYM",
  14: "INIT_ARRAY",
  15: "FINI_ARRAY",
  0x6ffffff6: "GNU_HASH",
  0x6ffffffe: "VERNEED",
  0x6fffffff: "VERSYM",
};
const SEGMENT_TYPES: Record<number, string> = {
  1: "LOAD",
  2: "DYNAMIC",
  3: "INTERP",
  4: "NOTE",
  6: "PHDR",
  7: "TLS",
  0x6474e550: "GNU_EH_FRAME",
  0x6474e551: "GNU_STACK",
  0x6474e552: "GNU_RELRO",
  0x6474e553: "GNU_PROPERTY",
};
const SYMBOL_TYPES = ["NOTYPE", "OBJECT", "FUNC", "SECTION", "FILE", "COMMON", "TLS"];
const BINDINGS = ["LOCAL", "GLOBAL", "WEAK"];
const OSABI: Record<number, string> = {
  0: "SysV",
  3: "Linux",
  9: "FreeBSD",
  12: "OpenBSD",
};

const segFlags = (f: number): string =>
  `${f & 4 ? "r" : "-"}${f & 2 ? "w" : "-"}${f & 1 ? "x" : "-"}`;
const secFlags = (f: bigint): string =>
  [f & 1n ? "W" : "", f & 2n ? "A" : "", f & 4n ? "X" : "", f & 0x400n ? "T" : ""].join("");

export function parseElf(bytes: Uint8Array): ElfInfo {
  if (bytes.length < 52) throw new AnalysisError("malformed", "ELF header truncated");
  const cls = bytes[4] === 2 ? 64 : bytes[4] === 1 ? 32 : 0;
  if (cls === 0) throw new AnalysisError("malformed", `unknown ELF class ${bytes[4]}`);
  const little = bytes[5] === 1;
  const r = new ByteReader(bytes, 16, little);
  const limitations: Limitation[] = [];
  const findings: Finding[] = [];
  const word = (): number => (cls === 64 ? r.u64n() : r.u32());

  const type = r.u16();
  const machine = r.u16();
  r.u32(); // version
  const entry = word();
  const phoff = word();
  const shoff = word();
  r.u32(); // flags
  r.u16(); // ehsize
  const phentsize = r.u16();
  const phnum = r.u16();
  const shentsize = r.u16();
  const shnum = r.u16();
  const shstrndx = r.u16();

  // Program headers
  const segments: ElfSegment[] = [];
  const rawSegments: Array<{
    type: number;
    flags: number;
    offset: number;
    fileSize: number;
  }> = [];
  for (let i = 0; i < phnum && phoff + (i + 1) * phentsize <= bytes.length; i++) {
    r.seek(phoff + i * phentsize);
    const ptype = r.u32();
    let flags: number;
    let offset: number;
    let vaddr: number;
    let fileSize: number;
    let memSize: number;
    if (cls === 64) {
      flags = r.u32();
      offset = r.u64n();
      vaddr = r.u64n();
      r.u64(); // paddr
      fileSize = r.u64n();
      memSize = r.u64n();
    } else {
      offset = r.u32();
      vaddr = r.u32();
      r.u32(); // paddr
      fileSize = r.u32();
      memSize = r.u32();
      flags = r.u32();
    }
    rawSegments.push({ type: ptype, flags, offset, fileSize });
    segments.push({
      type: SEGMENT_TYPES[ptype] ?? hex(ptype),
      flags: segFlags(flags),
      offset,
      vaddr: hex(vaddr),
      fileSize,
      memSize,
    });
  }

  // Section headers
  type RawSection = ElfSection & {
    link: number;
    entsize: number;
    nameOffset: number;
  };
  const raw: RawSection[] = [];
  for (let i = 0; i < shnum && shoff + (i + 1) * shentsize <= bytes.length; i++) {
    r.seek(shoff + i * shentsize);
    const nameOffset = r.u32();
    const stype = r.u32();
    const flags = cls === 64 ? r.u64() : BigInt(r.u32());
    const addr = word();
    const offset = word();
    const size = word();
    const link = r.u32();
    r.u32(); // info
    word(); // addralign
    const entsize = word();
    raw.push({
      index: i,
      name: "",
      nameOffset,
      type: stype,
      typeName: SECTION_TYPES[stype] ?? hex(stype),
      flags: secFlags(flags),
      address: hex(addr),
      offset,
      size,
      link,
      entsize,
    });
  }
  const shstr = raw[shstrndx];
  for (const s of raw) {
    s.name = shstr ? cstringAt(bytes, shstr.offset + s.nameOffset) : "";
  }
  if (shnum === 0)
    limitations.push({
      code: "no_sections",
      message: "No section headers (stripped or packed).",
    });

  // Symbols
  const symbols: ElfSymbol[] = [];
  const readSymbols = (sec: RawSection, table: "symtab" | "dynsym"): void => {
    const strtab = raw[sec.link];
    if (!strtab) return;
    const entSize = cls === 64 ? 24 : 16;
    const count = Math.min(Math.floor(sec.size / entSize), 200_000);
    if (sec.size / entSize > count) {
      limitations.push({
        code: "symbols_truncated",
        message: `${table} truncated to ${count} entries.`,
      });
    }
    for (let i = 0; i < count; i++) {
      const at = sec.offset + i * entSize;
      if (at + entSize > bytes.length) break;
      r.seek(at);
      const nameOff = r.u32();
      let info: number;
      let shndx: number;
      let value: number;
      let size: number;
      if (cls === 64) {
        info = r.u8();
        r.u8();
        shndx = r.u16();
        value = r.u64n();
        size = r.u64n();
      } else {
        value = r.u32();
        size = r.u32();
        info = r.u8();
        r.u8();
        shndx = r.u16();
      }
      const name = cstringAt(bytes, strtab.offset + nameOff);
      if (!name) continue;
      symbols.push({
        name,
        value: hex(value),
        size,
        type: SYMBOL_TYPES[info & 0xf] ?? `type${info & 0xf}`,
        binding: BINDINGS[info >> 4] ?? `bind${info >> 4}`,
        section:
          shndx === 0 ? "UND" : shndx === 0xfff1 ? "ABS" : (raw[shndx]?.name ?? String(shndx)),
        table,
      });
    }
  };
  for (const s of raw) {
    if (s.type === 2) readSymbols(s, "symtab");
    if (s.type === 11) readSymbols(s, "dynsym");
  }

  // Dynamic section
  const needed: string[] = [];
  const rpath: string[] = [];
  let soname: string | null = null;
  let bindNow = false;
  let dtFlagsPie = false;
  const dynamic = raw.find((s) => s.type === 6);
  if (dynamic) {
    const dynstr = raw[dynamic.link];
    const entSize = cls === 64 ? 16 : 8;
    for (
      let at = dynamic.offset;
      at + entSize <= Math.min(bytes.length, dynamic.offset + dynamic.size);
      at += entSize
    ) {
      r.seek(at);
      const tag = cls === 64 ? r.u64n() : r.u32();
      const val = cls === 64 ? r.u64n() : r.u32();
      if (tag === 0) break;
      const str = (): string => (dynstr ? cstringAt(bytes, dynstr.offset + val) : "");
      if (tag === 1) needed.push(str());
      else if (tag === 14) soname = str();
      else if (tag === 15 || tag === 29) rpath.push(str());
      else if (tag === 24) bindNow = true;
      else if (tag === 30 && val & 0x8) bindNow = true;
      else if (tag === 0x6ffffffb && val & 0x08000000) dtFlagsPie = true;
    }
  }

  // Interpreter and notes
  const interpSeg = rawSegments.find((s) => s.type === 3);
  const interpreter = interpSeg ? cstringAt(bytes, interpSeg.offset) : null;
  let buildId: string | null = null;
  for (const s of raw) {
    if (s.type !== 7 || s.size < 12 || s.offset + s.size > bytes.length) continue;
    r.seek(s.offset);
    const end = s.offset + s.size;
    while (r.offset + 12 <= end) {
      const namesz = r.u32();
      const descsz = r.u32();
      const ntype = r.u32();
      if (namesz > end - r.offset || descsz > end - r.offset) break; // sizes past the section
      const name = cstringAt(bytes, r.offset, namesz);
      r.skip(Math.min(end - r.offset, Math.ceil(namesz / 4) * 4));
      const desc = r.bytesAt(Math.min(descsz, end - r.offset));
      r.seek(Math.min(end, r.offset + Math.ceil(descsz / 4) * 4 - desc.length));
      if (name === "GNU" && ntype === 3) buildId = Buffer.from(desc).toString("hex");
      if (name === "Go" && ntype === 4) {
        findings.push({
          kind: "go.buildid",
          title: "Go build ID note",
          detail: Buffer.from(desc).toString(),
          confidence: "confirmed",
        });
      }
    }
  }

  const gnuStack = rawSegments.find((s) => s.type === 0x6474e551);
  const relro = rawSegments.some((s) => s.type === 0x6474e552);
  const hasSymtab = raw.some((s) => s.type === 2);
  const names = new Set(symbols.map((s) => s.name));
  const mitigations: ElfInfo["mitigations"] = {
    nx: gnuStack ? (gnuStack.flags & 1) === 0 : false,
    pie: type === 3 && (dtFlagsPie || interpreter !== null),
    relro: relro ? (bindNow ? true : "partial") : false,
    canary: names.has("__stack_chk_fail"),
    fortify: [...names].some((n) => /^__[a-z_]+_chk$/.test(n)),
    stripped: !hasSymtab,
  };

  if (interpreter)
    findings.push({
      kind: "elf.interpreter",
      title: `Dynamic linker ${interpreter}`,
      confidence: "confirmed",
    });
  if (!gnuStack)
    limitations.push({
      code: "no_gnu_stack",
      message: "No PT_GNU_STACK; NX state unknown.",
    });

  return {
    class: cls,
    endian: little ? "little" : "big",
    osabi: OSABI[bytes[7]!] ?? `abi${bytes[7]}`,
    type: TYPES[type] ?? hex(type),
    machine: MACHINES[machine] ?? hex(machine),
    entry: hex(entry),
    interpreter,
    buildId,
    soname,
    needed,
    rpath,
    sections: raw.map(({ link: _l, entsize: _e, nameOffset: _n, ...s }) => s),
    segments,
    symbols,
    mitigations,
    findings,
    limitations,
  };
}
