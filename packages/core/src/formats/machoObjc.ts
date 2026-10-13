import { ByteReader, cstringAt } from "../binary/reader.js";
import type { Finding, Limitation } from "../model.js";
import type { MachoInfo } from "./macho.js";
import { demangleSwiftClassName } from "./swiftDemangle.js";

/**
 * Static Objective-C metadata from a 64-bit Mach-O: classes with methods,
 * ivars, properties and protocols; standalone protocols; categories. Pointers
 * are decoded through dyld chained fixups when the image uses them, so modern
 * arm64/arm64e binaries work without any engine. Nothing is executed.
 */

export interface ObjcMethod {
  name: string;
  types: string;
  kind: "instance" | "class";
  implementation: string | null;
}

export interface ObjcClass {
  name: string;
  /** Module.Name for Swift classes exposed to Objective-C (`_TtC…`). */
  swiftName: string | null;
  address: string;
  superClass: string | null;
  isSwift: boolean;
  isMeta: boolean;
  methods: ObjcMethod[];
  ivars: Array<{ name: string; type: string; offset: number | null }>;
  properties: Array<{ name: string; attributes: string }>;
  protocols: string[];
}

export interface ObjcProtocol {
  name: string;
  address: string;
  protocols: string[];
  methods: ObjcMethod[];
}

export interface ObjcCategory {
  name: string;
  className: string | null;
  methods: ObjcMethod[];
  protocols: string[];
}

export interface ObjcMetadata {
  pointerFormat: string;
  classes: ObjcClass[];
  protocols: ObjcProtocol[];
  categories: ObjcCategory[];
  selectorCount: number;
  findings: Finding[];
  limitations: Limitation[];
}

const FORMAT_NAMES: Record<number, string> = {
  1: "DYLD_CHAINED_PTR_ARM64E",
  2: "DYLD_CHAINED_PTR_64",
  3: "DYLD_CHAINED_PTR_32",
  6: "DYLD_CHAINED_PTR_64_OFFSET",
  9: "DYLD_CHAINED_PTR_ARM64E_USERLAND",
  12: "DYLD_CHAINED_PTR_ARM64E_USERLAND24",
};
const MAX_CLASSES = 20_000;
const MAX_LIST = 10_000;
const bits = (v: bigint, from: number, count: number): bigint =>
  (v >> BigInt(from)) & ((1n << BigInt(count)) - 1n);

interface Decoded {
  kind: "rebase" | "bind" | "raw";
  target: bigint;
  symbol?: string;
}

class Image {
  readonly base: bigint;
  readonly segments: Array<{ va: bigint; size: number; offset: number; index: number }>;
  readonly formats = new Map<number, number>();
  /** Virtual addresses that are real chained-fixup slots; other pointers are plain values. */
  readonly fixupSlots = new Set<bigint>();
  readonly imports: string[] = [];
  readonly binds = new Map<bigint, string>();
  readonly reader: ByteReader;
  /** Shared work budget so hostile images cannot make decoding quadratic. */
  budget = 5_000_000;
  constructor(
    readonly bytes: Uint8Array,
    readonly macho: MachoInfo,
    readonly limitations: Limitation[],
  ) {
    this.reader = new ByteReader(bytes, 0, true);
    this.segments = macho.segments.map((s, index) => ({
      va: BigInt(s.vmaddr),
      size: s.fileSize,
      offset: s.fileOffset,
      index,
    }));
    this.base =
      this.segments.find((s) => macho.segments[s.index]!.name === "__TEXT")?.va ??
      this.segments[0]?.va ??
      0n;
    try {
      if (macho.chainedFixups)
        this.readFixups(macho.chainedFixups.offset, macho.chainedFixups.size);
    } catch (error) {
      limitations.push({
        code: "objc_fixups_unreadable",
        message: `Chained fixups: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    for (const stream of macho.bindStreams) {
      try {
        this.readBindOpcodes(stream.offset, stream.size, stream.kind);
      } catch (error) {
        limitations.push({
          code: "objc_binds_unreadable",
          message: `${stream.kind} bind stream: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
  }

  spend(units = 1): boolean {
    this.budget -= units;
    if (this.budget >= 0) return true;
    if (this.budget === -1)
      this.limitations.push({
        code: "objc_budget_exhausted",
        message: "Decoding work budget exhausted; results are partial.",
      });
    return false;
  }

  /** LC_DYLD_INFO bind opcodes (BIND_OPCODE_*): records which image address receives which symbol. */
  private readBindOpcodes(offset: number, size: number, kind: "bind" | "weak" | "lazy"): void {
    const end = Math.min(this.bytes.length, offset + size);
    let symbol = "";
    let segment = 0;
    let address = 0n;
    const segBase = (index: number): bigint => this.segments[index]?.va ?? 0n;
    const doBind = (): void => {
      if (symbol && this.binds.size < 500_000) this.binds.set(address, symbol);
    };
    const reader = new ByteReader(this.bytes.subarray(0, end), offset, true); // operand reads cannot pass the stream end
    while (reader.offset < end && this.spend()) {
      const r = reader;
      const byte = r.u8();
      const opcode = byte & 0xf0;
      const imm = byte & 0x0f;
      switch (opcode) {
        case 0x00:
          if (kind !== "lazy") return; // BIND_OPCODE_DONE ends normal and weak streams
          symbol = "";
          break;
        case 0x10:
        case 0x30:
          break;
        case 0x20:
          r.uleb128();
          break;
        case 0x40:
          symbol = cstringAt(this.bytes, r.offset, 1024);
          r.skip(symbol.length + 1);
          break;
        case 0x50:
          break;
        case 0x60:
          r.sleb128();
          break;
        case 0x70:
          segment = imm;
          address = segBase(segment) + BigInt(r.uleb128());
          break;
        case 0x80:
          address += BigInt(r.uleb128());
          break;
        case 0x90:
          doBind();
          address += 8n;
          break;
        case 0xa0:
          doBind();
          address += 8n + BigInt(r.uleb128());
          break;
        case 0xb0:
          doBind();
          address += 8n + BigInt(imm) * 8n;
          break;
        case 0xc0: {
          const count = r.uleb128();
          const skip = BigInt(r.uleb128());
          for (let i = 0; i < count && this.spend(); i++) {
            doBind();
            address += 8n + skip;
          }
          break;
        }
        default:
          return; // unknown opcode: stop rather than misattribute
      }
    }
  }

  private readFixups(offset: number, size: number): void {
    const end = Math.min(this.bytes.length, offset + size);
    if (offset + 28 > end) return;
    const r = new ByteReader(this.bytes, offset, true);
    r.u32(); // fixups_version
    const startsOffset = r.u32();
    const importsOffset = r.u32();
    const symbolsOffset = r.u32();
    const importsCount = r.u32();
    const importsFormat = r.u32();
    // starts in image
    const starts = offset + startsOffset;
    if (starts + 4 > end) return;
    r.seek(starts);
    const segCount = r.u32();
    const segInfoOffsets: number[] = [];
    for (let i = 0; i < segCount && r.offset + 4 <= end; i++) segInfoOffsets.push(r.u32());
    segInfoOffsets.forEach((segInfoOffset, i) => {
      if (!segInfoOffset) return;
      const at = starts + segInfoOffset;
      if (at + 24 > end) return;
      const sr = new ByteReader(this.bytes, at, true);
      sr.u32(); // size
      const pageSize = sr.u16();
      const pointerFormat = sr.u16();
      const segmentOffset = sr.u64();
      sr.u32(); // max_valid_pointer
      const pageCount = sr.u16();
      this.formats.set(i, pointerFormat);
      const stride = pointerFormat === 2 || pointerFormat === 6 ? 4n : 8n;
      const segment = this.segments[i];
      if (!segment) return;
      for (let page = 0; page < pageCount && sr.offset + 2 <= end; page++) {
        const pageStart = sr.u16();
        if (pageStart === 0xffff) continue;
        let va =
          segment.va +
          (segmentOffset - BigInt(segment.index === i ? 0 : 0)) +
          BigInt(page * pageSize + pageStart);
        // segment_offset is the segment's file offset from the Mach-O header; va already includes it
        va = this.base + segmentOffset + BigInt(page * pageSize + pageStart);
        let guard = 0;
        while (guard++ < 65536 && this.spend()) {
          this.fixupSlots.add(va);
          const off = this.fileOffset(va);
          if (off === null || off + 8 > this.bytes.length) break;
          const raw = this.reader.seek(off).u64();
          const next =
            pointerFormat === 2 || pointerFormat === 6 ? bits(raw, 51, 12) : bits(raw, 51, 11);
          if (next === 0n) break;
          va += next * stride;
        }
      }
    });
    // imports
    const entrySize = importsFormat === 3 ? 16 : importsFormat === 2 ? 8 : 4;
    const importsAt = offset + importsOffset;
    const symbolsAt = offset + symbolsOffset;
    for (let i = 0; i < Math.min(importsCount, 200_000); i++) {
      const at = importsAt + i * entrySize;
      if (at + entrySize > end) break;
      const ir = new ByteReader(this.bytes, at, true);
      let nameOffset: number;
      if (importsFormat === 3) {
        ir.u32();
        nameOffset = ir.u32();
      } else {
        nameOffset = Number(bits(BigInt(ir.u32()), 9, 23));
      }
      this.imports.push(cstringAt(this.bytes, symbolsAt + nameOffset, 512));
    }
  }

  fileOffset(va: bigint): number | null {
    for (const s of this.segments) {
      if (va >= s.va && va < s.va + BigInt(s.size)) return s.offset + Number(va - s.va);
    }
    return null;
  }

  private formatAt(va: bigint): number {
    const seg = this.segments.find((s) => va >= s.va && va < s.va + BigInt(s.size));
    return seg ? (this.formats.get(seg.index) ?? 0) : 0;
  }

  u32(va: bigint): number | null {
    const off = this.fileOffset(va);
    if (off === null || off + 4 > this.bytes.length) return null;
    return this.reader.seek(off).u32();
  }

  /** Reads and decodes the 64-bit pointer stored at `va`. */
  pointer(va: bigint): Decoded | null {
    const off = this.fileOffset(va);
    if (off === null || off + 8 > this.bytes.length) return null;
    const raw = this.reader.seek(off).u64();
    const bound = this.binds.get(va);
    if (bound) return { kind: "bind", target: 0n, symbol: bound };
    if (raw === 0n) return null;
    const format = this.formatAt(va);
    if (!format || !this.fixupSlots.has(va))
      return { kind: "raw", target: raw & 0x0000ffffffffffffn };
    if (format === 2 || format === 6) {
      const bind = bits(raw, 63, 1) === 1n;
      if (bind) {
        const ordinal = Number(bits(raw, 0, 24));
        return { kind: "bind", target: 0n, symbol: this.imports[ordinal] ?? `import#${ordinal}` };
      }
      const target = bits(raw, 0, 36) | (bits(raw, 36, 8) << 56n);
      return { kind: "rebase", target: format === 6 ? target + this.base : target };
    }
    if (format === 1 || format === 9 || format === 12) {
      // dyld_chained_ptr_arm64e_*: bind is bit 62, auth is bit 63
      const auth = bits(raw, 63, 1) === 1n;
      const bind = bits(raw, 62, 1) === 1n;
      if (bind) {
        const ordinal = Number(format === 12 ? bits(raw, 0, 24) : bits(raw, 0, 16));
        return { kind: "bind", target: 0n, symbol: this.imports[ordinal] ?? `import#${ordinal}` };
      }
      if (auth) return { kind: "rebase", target: bits(raw, 0, 32) + this.base };
      const target = bits(raw, 0, 43) | (bits(raw, 43, 8) << 56n);
      return { kind: "rebase", target: format === 1 ? target : target + this.base };
    }
    return { kind: "raw", target: raw & 0x0000ffffffffffffn };
  }

  /** Pointer that must land inside the image; binds and nulls give null. */
  ref(va: bigint): bigint | null {
    const d = this.pointer(va);
    return d && d.kind !== "bind" && d.target !== 0n ? d.target : null;
  }

  string(va: bigint | null): string {
    if (va === null) return "";
    const off = this.fileOffset(va);
    return off === null ? "" : cstringAt(this.bytes, off, 4096);
  }
}

const hex = (v: bigint): string => `0x${v.toString(16)}`;
const externalClassName = (symbol: string): string =>
  symbol.replace(/^_OBJC_CLASS_\$_/, "").replace(/^_OBJC_METACLASS_\$_/, "");

function readMethods(
  img: Image,
  listVa: bigint | null,
  kind: ObjcMethod["kind"],
  limitations: Limitation[],
): ObjcMethod[] {
  if (listVa === null) return [];
  const flagsAndSize = img.u32(listVa);
  const count = img.u32(listVa + 4n);
  if (flagsAndSize === null || count === null) return [];
  const relative = (flagsAndSize & 0x80000000) !== 0;
  const directSelectors = (flagsAndSize & 0x40000000) !== 0;
  const entsize = flagsAndSize & 0x3fffffff & ~3;
  if (entsize !== (relative ? 12 : 24)) {
    limitations.push({
      code: "objc_method_entsize",
      message: `Unexpected method entry size ${entsize} at ${hex(listVa)}.`,
    });
    return [];
  }
  const out: ObjcMethod[] = [];
  for (let i = 0; i < Math.min(count, MAX_LIST) && img.spend(); i++) {
    const entry = listVa + 8n + BigInt(i * entsize);
    if (relative) {
      const rel = (field: bigint): bigint | null => {
        const v = img.u32(field);
        return v === null ? null : field + BigInt(v | 0);
      };
      const nameRef = rel(entry);
      const selector = nameRef === null ? null : directSelectors ? nameRef : img.ref(nameRef);
      const types = rel(entry + 4n);
      const imp = rel(entry + 8n);
      out.push({
        name: img.string(selector),
        types: img.string(types),
        kind,
        implementation: imp === null ? null : hex(imp),
      });
    } else {
      const imp = img.ref(entry + 16n);
      out.push({
        name: img.string(img.ref(entry)),
        types: img.string(img.ref(entry + 8n)),
        kind,
        implementation: imp === null ? null : hex(imp),
      });
    }
  }
  if (count > MAX_LIST)
    limitations.push({
      code: "objc_methods_truncated",
      message: `Method list at ${hex(listVa)} truncated to ${MAX_LIST} entries.`,
    });
  return out.filter((m) => m.name);
}

function readProtocolNames(img: Image, listVa: bigint | null, depth = 0): string[] {
  if (listVa === null || depth > 4) return [];
  const countOff = img.fileOffset(listVa);
  if (countOff === null || countOff + 8 > img.bytes.length) return [];
  const count = Number(img.reader.seek(countOff).u64());
  const names: string[] = [];
  for (let i = 0; i < Math.min(count, 256); i++) {
    const proto = img.ref(listVa + 8n + BigInt(i * 8));
    if (proto === null) continue;
    const name = img.string(img.ref(proto + 8n));
    if (name) names.push(name);
  }
  return names;
}

function readProtocol(img: Image, va: bigint, limitations: Limitation[]): ObjcProtocol | null {
  const name = img.string(img.ref(va + 8n));
  if (!name) return null;
  return {
    name,
    address: hex(va),
    protocols: readProtocolNames(img, img.ref(va + 16n)),
    methods: [
      ...readMethods(img, img.ref(va + 24n), "instance", limitations),
      ...readMethods(img, img.ref(va + 32n), "class", limitations),
      ...readMethods(img, img.ref(va + 40n), "instance", limitations),
      ...readMethods(img, img.ref(va + 48n), "class", limitations),
    ],
  };
}

function sectionVas(macho: MachoInfo, name: string): Array<{ va: bigint; size: number }> {
  return macho.segments.flatMap((s) =>
    s.sections.filter((x) => x.name === name).map((x) => ({ va: BigInt(x.address), size: x.size })),
  );
}

export function parseObjcMetadata(bytes: Uint8Array, macho: MachoInfo): ObjcMetadata {
  const limitations: Limitation[] = [];
  const findings: Finding[] = [];
  const img = new Image(bytes, macho, limitations);
  const formats = [...new Set(img.formats.values())].map((f) => FORMAT_NAMES[f] ?? `format ${f}`);
  const pointerFormat =
    formats.join(", ") || (macho.dyldInfo ? "absolute (dyld_info)" : "absolute");
  if (macho.bits !== 64) {
    limitations.push({
      code: "objc_32bit",
      message: "Objective-C metadata decoding supports 64-bit images only.",
    });
    return {
      pointerFormat,
      classes: [],
      protocols: [],
      categories: [],
      selectorCount: 0,
      findings,
      limitations,
    };
  }

  const classNameAt = new Map<string, string>();
  const className = (classVa: bigint): string | null => {
    const key = hex(classVa);
    const cached = classNameAt.get(key);
    if (cached !== undefined) return cached;
    const data = img.pointer(classVa + 32n);
    if (!data || data.kind === "bind") return null;
    const ro = data.target & ~7n;
    const name = img.string(img.ref(ro + 24n)) || null;
    if (name) classNameAt.set(key, name);
    return name;
  };
  const readClass = (classVa: bigint): ObjcClass | null => {
    const data = img.pointer(classVa + 32n);
    if (!data || data.kind === "bind") return null;
    const ro = data.target & ~7n;
    const flags = img.u32(ro);
    if (flags === null) return null;
    const name = img.string(img.ref(ro + 24n));
    if (!name) return null;
    const superPtr = img.pointer(classVa + 8n);
    const superClass = !superPtr
      ? null
      : superPtr.kind === "bind"
        ? externalClassName(superPtr.symbol ?? "")
        : className(superPtr.target);
    const ivars: ObjcClass["ivars"] = [];
    const ivarList = img.ref(ro + 48n);
    if (ivarList !== null) {
      const entsize = img.u32(ivarList) ?? 0;
      const count = img.u32(ivarList + 4n) ?? 0;
      for (let i = 0; i < Math.min(count, MAX_LIST) && entsize >= 24; i++) {
        const entry = ivarList + 8n + BigInt(i * entsize);
        const offsetPtr = img.ref(entry);
        ivars.push({
          name: img.string(img.ref(entry + 8n)),
          type: img.string(img.ref(entry + 16n)),
          offset: offsetPtr === null ? null : img.u32(offsetPtr),
        });
      }
    }
    const properties: ObjcClass["properties"] = [];
    const propList = img.ref(ro + 64n);
    if (propList !== null) {
      const entsize = img.u32(propList) ?? 0;
      const count = img.u32(propList + 4n) ?? 0;
      for (let i = 0; i < Math.min(count, MAX_LIST) && entsize >= 16; i++) {
        const entry = propList + 8n + BigInt(i * entsize);
        properties.push({
          name: img.string(img.ref(entry)),
          attributes: img.string(img.ref(entry + 8n)),
        });
      }
    }
    const methods = readMethods(img, img.ref(ro + 32n), "instance", limitations);
    const meta = img.ref(classVa); // isa → metaclass
    if (meta !== null) {
      const metaData = img.pointer(meta + 32n);
      if (metaData && metaData.kind !== "bind")
        methods.push(
          ...readMethods(img, img.ref((metaData.target & ~7n) + 32n), "class", limitations),
        );
    }
    return {
      name,
      swiftName: demangleSwiftClassName(name),
      address: hex(classVa),
      superClass,
      isSwift: (data.target & 3n) !== 0n,
      isMeta: (flags & 1) !== 0,
      methods,
      ivars: ivars.filter((v) => v.name),
      properties: properties.filter((p) => p.name),
      protocols: readProtocolNames(img, img.ref(ro + 40n)),
    };
  };

  const classes: ObjcClass[] = [];
  const seenClasses = new Set<bigint>();
  let totalMethods = 0;
  for (const sec of sectionVas(macho, "__objc_classlist")) {
    const count = Math.floor(sec.size / 8);
    for (let i = 0; i < Math.min(count, MAX_CLASSES) && img.spend(); i++) {
      const classVa = img.ref(sec.va + BigInt(i * 8));
      if (classVa === null || seenClasses.has(classVa)) continue;
      seenClasses.add(classVa);
      if (totalMethods > 2_000_000) {
        limitations.push({
          code: "objc_output_truncated",
          message: "Method output cap reached; remaining classes were skipped.",
        });
        break;
      }
      try {
        const cls = readClass(classVa);
        if (cls) {
          classes.push(cls);
          totalMethods += cls.methods.length;
        }
      } catch (error) {
        limitations.push({
          code: "objc_class_unreadable",
          message: `${hex(classVa)}: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
    if (count > MAX_CLASSES)
      limitations.push({
        code: "objc_classes_truncated",
        message: `Class list truncated to ${MAX_CLASSES}.`,
      });
  }
  const protocols: ObjcProtocol[] = [];
  const seenProtocols = new Set<bigint>();
  for (const sec of sectionVas(macho, "__objc_protolist")) {
    for (let i = 0; i < Math.min(Math.floor(sec.size / 8), MAX_CLASSES) && img.spend(); i++) {
      const va = img.ref(sec.va + BigInt(i * 8));
      if (va === null || seenProtocols.has(va)) continue;
      seenProtocols.add(va);
      const p = readProtocol(img, va, limitations);
      if (p) protocols.push(p);
    }
  }
  const categories: ObjcCategory[] = [];
  const seenCategories = new Set<bigint>();
  for (const sec of sectionVas(macho, "__objc_catlist")) {
    for (let i = 0; i < Math.min(Math.floor(sec.size / 8), MAX_CLASSES) && img.spend(); i++) {
      const va = img.ref(sec.va + BigInt(i * 8));
      if (va === null || seenCategories.has(va)) continue;
      seenCategories.add(va);
      const name = img.string(img.ref(va));
      if (!name) continue;
      const clsPtr = img.pointer(va + 8n);
      categories.push({
        name,
        className: !clsPtr
          ? null
          : clsPtr.kind === "bind"
            ? externalClassName(clsPtr.symbol ?? "")
            : className(clsPtr.target),
        methods: [
          ...readMethods(img, img.ref(va + 16n), "instance", limitations),
          ...readMethods(img, img.ref(va + 24n), "class", limitations),
        ],
        protocols: readProtocolNames(img, img.ref(va + 32n)),
      });
    }
  }
  const selectorCount = sectionVas(macho, "__objc_selrefs").reduce(
    (n, s) => n + Math.floor(s.size / 8),
    0,
  );
  if (classes.length) {
    findings.push({
      kind: "objc.classes",
      title: `${classes.length} Objective-C classes${classes.some((c) => c.isSwift) ? " (incl. Swift-backed)" : ""}`,
      detail: classes
        .slice(0, 6)
        .map((c) => c.name)
        .join(", "),
      confidence: "confirmed",
    });
  }
  const interesting = classes
    .flatMap((c) => c.methods.map((m) => m.name))
    .filter((m) =>
      /^(application:.*|observeValueForKeyPath|webView:|URLSession:|canOpenURL|setValue:forUndefinedKey)/.test(
        m,
      ),
    );
  if (interesting.length)
    findings.push({
      kind: "objc.entry-points",
      title: `${new Set(interesting).size} delegate/entry-point selectors`,
      detail: [...new Set(interesting)].slice(0, 5).join(", "),
      confidence: "confirmed",
    });
  return { pointerFormat, classes, protocols, categories, selectorCount, findings, limitations };
}
