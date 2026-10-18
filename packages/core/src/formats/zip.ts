import { inflateRawSync } from "node:zlib";
import { ByteReader, latin1, utf8String } from "../binary/reader.js";
import { AnalysisError } from "../model.js";

export interface ZipEntry {
  name: string;
  compressedSize: number;
  size: number;
  method: "stored" | "deflate" | "other";
  crc32: string;
  localHeaderOffset: number;
  isDirectory: boolean;
  encrypted: boolean;
}

export interface ZipArchive {
  entries: ZipEntry[];
  comment: string;
  /** Reads and decompresses one entry, bounded by `maxBytes`. */
  read(entry: ZipEntry, maxBytes?: number): Uint8Array;
  find(name: string): ZipEntry | undefined;
  /** Entries a Unix extractor makes symbolic links (the mode in the external attributes). */
  links: ReadonlySet<ZipEntry>;
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_EOCD = 0x06064b50;

/** Central-directory reader; tolerates prepended data (self-extractors) and ZIP64 sizes. */
/** Total bytes one opened archive may inflate. Entries that share compressed data (an overlap
 * bomb) would otherwise expand the same bytes again for every entry. */
const INFLATE_BUDGET = 1024 * 1024 * 1024;

export function openZip(bytes: Uint8Array, options: { inflateBudget?: number } = {}): ZipArchive {
  let budget = options.inflateBudget ?? INFLATE_BUDGET;
  const eocd = findEocd(bytes);
  if (eocd === -1)
    throw new AnalysisError("malformed", "ZIP end-of-central-directory record not found");
  const r = new ByteReader(bytes, eocd + 4);
  r.skip(6);
  let entryCount = r.u16();
  r.u32();
  let cdOffset = r.u32();
  const commentLength = r.u16();
  const comment = utf8String(bytes.subarray(r.offset, r.offset + commentLength));

  if (entryCount === 0xffff || cdOffset === 0xffffffff) {
    const locator = eocd - 20;
    if (locator >= 0 && new ByteReader(bytes, locator).u32() === ZIP64_LOCATOR) {
      const z64 = new ByteReader(bytes, locator + 8).u64n();
      if (z64 + 56 <= bytes.length && new ByteReader(bytes, z64).u32() === ZIP64_EOCD) {
        const zr = new ByteReader(bytes, z64 + 32);
        entryCount = zr.u64n(); // total entries
        zr.u64(); // central directory size
        cdOffset = zr.u64n();
      }
    }
  }

  const entries: ZipEntry[] = [];
  const links = new Set<ZipEntry>();
  const cr = new ByteReader(bytes, cdOffset);
  for (let i = 0; i < entryCount && cr.remaining >= 46; i++) {
    if (cr.u32() !== CENTRAL) break;
    const madeBy = cr.u16();
    cr.skip(2);
    const flags = cr.u16();
    const method = cr.u16();
    cr.skip(4);
    const crc = cr.u32();
    let compressedSize = cr.u32();
    let size = cr.u32();
    const nameLength = cr.u16();
    const extraLength = cr.u16();
    const commentLen = cr.u16();
    cr.skip(4);
    const external = cr.u32();
    let localHeaderOffset = cr.u32();
    const rawName = cr.bytesAt(nameLength);
    const name = flags & 0x800 ? utf8String(rawName) : latin1(rawName);
    const extra = cr.bytesAt(extraLength);
    cr.skip(commentLen);
    if (size === 0xffffffff || compressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
      const er = new ByteReader(extra, 0);
      while (er.remaining >= 4) {
        const id = er.u16();
        const len = er.u16();
        if (id === 0x0001) {
          if (size === 0xffffffff && er.remaining >= 8) size = er.u64n();
          if (compressedSize === 0xffffffff && er.remaining >= 8) compressedSize = er.u64n();
          if (localHeaderOffset === 0xffffffff && er.remaining >= 8) localHeaderOffset = er.u64n();
          break;
        }
        er.skip(Math.min(len, er.remaining));
      }
    }
    const entry: ZipEntry = {
      name,
      compressedSize,
      size,
      method: method === 0 ? "stored" : method === 8 ? "deflate" : "other",
      crc32: crc.toString(16).padStart(8, "0"),
      localHeaderOffset,
      isDirectory: name.endsWith("/"),
      encrypted: (flags & 1) !== 0,
    };
    entries.push(entry);
    // made on Unix (3) or macOS (19) with the mode S_IFLNK
    const host = madeBy >>> 8;
    if ((host === 3 || host === 19) && ((external >>> 16) & 0o170000) === 0o120000)
      links.add(entry);
  }
  const byName = new Map<string, ZipEntry>();
  for (const e of entries) if (!byName.has(e.name)) byName.set(e.name, e);

  const read = (entry: ZipEntry, maxBytes = 64 * 1024 * 1024): Uint8Array => {
    if (entry.encrypted)
      throw new AnalysisError("unsupported_format", `${entry.name} is encrypted`);
    if (entry.method === "other")
      throw new AnalysisError(
        "unsupported_format",
        `${entry.name} uses an unsupported compression method`,
      );
    if (entry.size > maxBytes)
      throw new AnalysisError(
        "too_large",
        `${entry.name} expands to ${entry.size} bytes (limit ${maxBytes})`,
      );
    const lr = new ByteReader(bytes, entry.localHeaderOffset);
    if (lr.u32() !== LOCAL)
      throw new AnalysisError("malformed", `${entry.name}: local header signature mismatch`);
    lr.skip(22);
    const nameLength = lr.u16();
    const extraLength = lr.u16();
    const start = lr.offset + nameLength + extraLength;
    const data = bytes.subarray(start, start + entry.compressedSize);
    if (data.length < entry.compressedSize)
      throw new AnalysisError("malformed", `${entry.name}: compressed data truncated`);
    if (entry.method === "stored") {
      // a stored entry is its bytes: sizes that differ are a lie about one of them
      if (entry.compressedSize !== entry.size)
        throw new AnalysisError(
          "malformed",
          `${entry.name}: stored entry with ${entry.compressedSize} bytes declares ${entry.size}`,
        );
      return data;
    }
    if (entry.size > budget)
      throw new AnalysisError(
        "too_large",
        `${entry.name}: the archive has used its inflate budget (${options.inflateBudget ?? INFLATE_BUDGET} bytes); entries may share compressed data`,
      );
    budget -= entry.size;
    const out = inflateRawSync(data, {
      maxOutputLength: Math.max(entry.size, 1),
    });
    return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
  };

  return {
    entries,
    comment,
    read,
    find: (name) => byName.get(name),
    links,
  };
}

function findEocd(bytes: Uint8Array): number {
  const min = Math.max(0, bytes.length - 22 - 65535);
  for (let i = bytes.length - 22; i >= min; i--) {
    if (
      bytes[i] === 0x50 &&
      bytes[i + 1] === 0x4b &&
      bytes[i + 2] === 0x05 &&
      bytes[i + 3] === 0x06
    ) {
      const r = new ByteReader(bytes, i);
      if (r.u32() === EOCD) return i;
    }
  }
  return -1;
}
