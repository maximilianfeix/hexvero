import { ByteReader } from "../binary/reader.js";
import { AnalysisError } from "../model.js";
import { readStringPool } from "./axml.js";

/**
 * Android resources.arsc reader (ResTable). Decodes packages, type and key
 * names, every entry's default-configuration value for simple types, and the
 * set of configurations (locales, densities) a type is specialised for.
 * Enough to resolve `@0x7f…` references from the manifest to real strings
 * without Apktool.
 */

export interface ArscEntry {
  id: string;
  type: string;
  key: string;
  value: string | null;
  /** Number of alternative configurations (locales, densities, …) for this entry. */
  variants: number;
}

export interface ArscPackage {
  id: number;
  name: string;
  typeCount: number;
  entryCount: number;
  locales: string[];
  densities: string[];
}

export interface ArscInfo {
  packages: ArscPackage[];
  entries: ArscEntry[];
  strings: string[];
  resolve(reference: string): string | null;
}

const RES_STRING_POOL = 0x0001;
const RES_TABLE = 0x0002;
const RES_TABLE_PACKAGE = 0x0200;
const RES_TABLE_TYPE = 0x0201;
const MAX_ENTRIES = 200_000;

function localeOf(config: Uint8Array): string | null {
  const lang = String.fromCharCode(config[8]!, config[9]!).replace(/\0/g, "");
  const country = String.fromCharCode(config[10]!, config[11]!).replace(/\0/g, "");
  if (!lang) return null;
  return country ? `${lang}-${country}` : lang;
}
const DENSITIES: Record<number, string> = {
  120: "ldpi",
  160: "mdpi",
  213: "tvdpi",
  240: "hdpi",
  320: "xhdpi",
  480: "xxhdpi",
  640: "xxxhdpi",
  0xfffe: "anydpi",
  0xffff: "nodpi",
};

const MAX_WORK = 2_000_000;

export function parseArsc(bytes: Uint8Array): ArscInfo {
  const r = new ByteReader(bytes, 0, true);
  if (bytes.length < 12 || r.u16() !== RES_TABLE)
    throw new AnalysisError("malformed", "not a resources.arsc table");
  const headerSize = r.u16();
  const fileSize = Math.min(r.u32(), bytes.length);
  const packageCount = r.u32();
  r.seek(Math.min(headerSize, fileSize));
  let strings: string[] = [];
  const packages: ArscPackage[] = [];
  const entries: ArscEntry[] = [];
  const byId = new Map<number, ArscEntry>();
  const hasDefault = new Set<number>();
  let work = 0;
  const spend = (n = 1): boolean => (work += n) <= MAX_WORK;

  const decodeValue = (dataType: number, data: number): string | null => {
    switch (dataType) {
      case 0x03:
        return strings[data] ?? null;
      case 0x01:
        return `@0x${data.toString(16).padStart(8, "0")}`;
      case 0x10:
        return String(data | 0);
      case 0x11:
        return `0x${(data >>> 0).toString(16)}`;
      case 0x12:
        return data !== 0 ? "true" : "false";
      case 0x05:
        return `${data >> 8}${["px", "dip", "sp", "pt", "in", "mm"][data & 0xf] ?? ""}`;
      case 0x1c:
      case 0x1d:
      case 0x1e:
      case 0x1f:
        return `#${(data >>> 0).toString(16).padStart(8, "0")}`;
      case 0x04:
        return String(new DataView(new Uint32Array([data]).buffer).getFloat32(0, true));
      default:
        return null;
    }
  };
  const poolAt = (at: number, end: number): string[] => {
    if (at + 8 > end) return [];
    const pr = new ByteReader(bytes, at, true);
    if (pr.u16() !== RES_STRING_POOL) return [];
    pr.u16();
    const size = pr.u32();
    if (size < 28 || at + size > end) return [];
    return readStringPool(pr, at, size);
  };

  while (r.offset + 8 <= fileSize && packages.length <= packageCount && spend()) {
    const chunkStart = r.offset;
    const type = r.u16();
    const chunkHeaderSize = r.u16();
    const chunkSize = r.u32();
    if (chunkSize < 8 || chunkStart + chunkSize > fileSize) break;
    const end = chunkStart + chunkSize;
    if (type === RES_STRING_POOL) strings = readStringPool(r, chunkStart, chunkSize);
    else if (
      type === RES_TABLE_PACKAGE &&
      chunkHeaderSize >= 284 &&
      chunkStart + chunkHeaderSize <= end
    ) {
      const id = r.u32();
      let name = "";
      for (let i = 0; i < 128; i++) {
        const c = r.u16();
        if (c && !name.includes("\0")) name += String.fromCharCode(c);
      }
      const typeStringsOffset = r.u32();
      r.u32(); // lastPublicType
      const keyStringsOffset = r.u32();
      r.u32(); // lastPublicKey
      const typeIdOffset = chunkHeaderSize >= 288 ? r.u32() : 0;
      const typeNames = typeStringsOffset ? poolAt(chunkStart + typeStringsOffset, end) : [];
      const keyNames = keyStringsOffset ? poolAt(chunkStart + keyStringsOffset, end) : [];
      const pkg: ArscPackage = {
        id,
        name,
        typeCount: typeNames.length,
        entryCount: 0,
        locales: [],
        densities: [],
      };
      const locales = new Set<string>();
      const densities = new Set<string>();
      let at = chunkStart + chunkHeaderSize;
      while (at + 8 <= end && spend()) {
        const sr = new ByteReader(bytes, at, true);
        const subType = sr.u16();
        const subHeader = sr.u16();
        const subSize = sr.u32();
        if (subSize < 8 || at + subSize > end || subHeader < 8 || subHeader > subSize) break;
        const subEnd = at + subSize;
        if (subType === RES_TABLE_TYPE && subHeader >= 20) {
          const typeId = sr.u8() + typeIdOffset;
          const typeFlags = sr.u8();
          sr.u16();
          const entryCount = sr.u32();
          const entriesStart = sr.u32();
          const configSize = sr.u32();
          const configAt = sr.offset - 4;
          if (configSize < 4 || configAt + configSize > at + subHeader) {
            at = subEnd;
            continue;
          }
          const config = bytes.subarray(configAt, configAt + configSize);
          const locale = config.length >= 12 ? localeOf(config) : null;
          const density = config.length >= 16 ? config[14]! | (config[15]! << 8) : 0;
          if (locale) locales.add(locale);
          if (density) densities.add(DENSITIES[density] ?? `${density}dpi`);
          // the default configuration has every qualifier byte zero
          const isDefault = config.subarray(4).every((b) => b === 0);
          const typeName = typeNames[typeId - typeIdOffset - 1] ?? `type${typeId}`;
          const sparse = (typeFlags & 0x01) !== 0;
          const offset16 = (typeFlags & 0x02) !== 0;
          const offsetWidth = offset16 ? 2 : 4;
          const offsetsAt = at + subHeader;
          if (entriesStart > subSize || offsetsAt + entryCount * offsetWidth > at + entriesStart) {
            at = subEnd;
            continue;
          }
          for (let i = 0; i < entryCount && spend(); i++) {
            let entryIndex = i;
            let entryOffset: number;
            const or = new ByteReader(bytes, offsetsAt + i * offsetWidth, true);
            if (sparse) {
              const packed = or.u32();
              entryIndex = packed & 0xffff;
              entryOffset = (packed >>> 16) * 4;
            } else if (offset16) {
              const v = or.u16();
              if (v === 0xffff) continue;
              entryOffset = v * 4;
            } else {
              entryOffset = or.u32();
              if (entryOffset === 0xffffffff) continue;
            }
            const ea = at + entriesStart + entryOffset;
            if (ea + 8 > subEnd) continue;
            const er = new ByteReader(bytes, ea, true);
            const first = er.u16();
            const flags = er.u16();
            const compact = (flags & 0x0008) !== 0;
            let key: number;
            let value: string | null;
            if (compact) {
              // compact entry: key u16, type u16 (flags low, dataType high), data u32
              key = first;
              value = decodeValue(flags >> 8, er.u32());
            } else {
              const entrySize = first;
              key = er.u32();
              if (flags & 0x0001) value = "{complex}";
              else if (entrySize >= 8 && ea + entrySize + 8 <= subEnd) {
                er.seek(ea + entrySize);
                er.u16();
                er.u8();
                const dataType = er.u8();
                value = decodeValue(dataType, er.u32());
              } else value = null;
            }
            const resId = (((id & 0xff) << 24) | (typeId << 16) | entryIndex) >>> 0;
            const keyName = keyNames[key] ?? `key${key}`;
            const existing = byId.get(resId);
            if (!existing) {
              if (entries.length >= MAX_ENTRIES) break;
              const entry: ArscEntry = {
                id: `0x${resId.toString(16).padStart(8, "0")}`,
                type: typeName,
                key: keyName,
                value,
                variants: 0,
              };
              byId.set(resId, entry);
              entries.push(entry);
              if (isDefault) hasDefault.add(resId);
            } else {
              existing.variants++;
              if (isDefault && !hasDefault.has(resId)) {
                existing.value = value;
                hasDefault.add(resId);
              }
            }
          }
        }
        at = subEnd;
      }
      pkg.entryCount = entries.filter((e) => parseInt(e.id, 16) >>> 24 === (id & 0xff)).length;
      pkg.locales = [...locales].toSorted();
      pkg.densities = [...densities].toSorted();
      packages.push(pkg);
    }
    r.seek(end);
  }

  const resolve = (reference: string, depth = 0): string | null => {
    const m = /^@(?:0x)?([0-9a-fA-F]{8})$/.exec(reference.trim());
    if (!m) return null;
    const entry = byId.get(parseInt(m[1]!, 16) >>> 0);
    if (!entry || entry.value === null) return null;
    if (entry.value.startsWith("@") && depth < 8)
      return resolve(entry.value, depth + 1) ?? entry.value;
    return entry.value;
  };
  return { packages, entries, strings, resolve };
}
