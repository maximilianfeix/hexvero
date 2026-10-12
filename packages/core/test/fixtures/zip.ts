import { deflateRawSync } from "node:zlib";
import { Builder } from "./builder.js";

export function crc32(bytes: Uint8Array): number {
  let crc = ~0;
  for (const b of bytes) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

/** Builds a ZIP with the given files; names ending in ".store" stay uncompressed. */
export function buildZip(
  files: Record<string, Uint8Array | string>,
  options: { prefix?: Uint8Array; comment?: string; zip64?: boolean } = {},
): Uint8Array {
  const b = new Builder();
  if (options.prefix) b.bytes(options.prefix);
  const central: Uint8Array[] = [];
  for (const [name, raw] of Object.entries(files)) {
    const data = typeof raw === "string" ? new TextEncoder().encode(raw) : raw;
    const stored = name.endsWith(".store");
    const packed = stored ? data : new Uint8Array(deflateRawSync(data));
    const offset = b.length;
    const nameBytes = new TextEncoder().encode(name);
    b.u32(0x04034b50)
      .u16(20)
      .u16(0x800)
      .u16(stored ? 0 : 8)
      .u32(0)
      .u32(crc32(data))
      .u32(packed.length)
      .u32(data.length)
      .u16(nameBytes.length)
      .u16(0)
      .bytes(nameBytes)
      .bytes(packed);
    const c = new Builder();
    c.u32(0x02014b50)
      .u16(20)
      .u16(20)
      .u16(0x800)
      .u16(stored ? 0 : 8)
      .u32(0)
      .u32(crc32(data))
      .u32(packed.length)
      .u32(data.length)
      .u16(nameBytes.length)
      .u16(0)
      .u16(0)
      .u16(0)
      .u16(0)
      .u32(0)
      .u32(offset)
      .bytes(nameBytes);
    central.push(c.done());
  }
  const cdOffset = b.length;
  for (const c of central) b.bytes(c);
  const cdSize = b.length - cdOffset;
  const comment = new TextEncoder().encode(options.comment ?? "");
  if (options.zip64) {
    // ZIP64 end of central directory record + locator, with sentinels in the classic EOCD.
    const z64 = b.length;
    b.u32(0x06064b50)
      .u64(44)
      .u16(45)
      .u16(45)
      .u32(0)
      .u32(0)
      .u64(central.length)
      .u64(central.length)
      .u64(cdSize)
      .u64(cdOffset);
    b.u32(0x07064b50).u32(0).u64(z64).u32(1);
    b.u32(0x06054b50)
      .u16(0)
      .u16(0)
      .u16(0xffff)
      .u16(0xffff)
      .u32(0xffffffff)
      .u32(0xffffffff)
      .u16(comment.length)
      .bytes(comment);
    return b.done();
  }
  b.u32(0x06054b50)
    .u16(0)
    .u16(0)
    .u16(central.length)
    .u16(central.length)
    .u32(cdSize)
    .u32(cdOffset)
    .u16(comment.length)
    .bytes(comment);
  return b.done();
}
