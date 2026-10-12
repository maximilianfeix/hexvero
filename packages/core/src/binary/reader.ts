/** Bounds-checked cursor over a byte buffer with switchable endianness. */
export class ByteReader {
  readonly view: DataView;
  readonly bytes: Uint8Array;
  littleEndian: boolean;
  offset: number;

  constructor(bytes: Uint8Array, offset = 0, littleEndian = true) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.offset = offset;
    this.littleEndian = littleEndian;
  }

  get length(): number {
    return this.bytes.byteLength;
  }

  get remaining(): number {
    return this.length - this.offset;
  }

  seek(offset: number): this {
    if (offset < 0 || offset > this.length) {
      throw new RangeError(`seek(${offset}) outside buffer of ${this.length} bytes`);
    }
    this.offset = offset;
    return this;
  }

  skip(count: number): this {
    return this.seek(this.offset + count);
  }

  private take(size: number): number {
    const at = this.offset;
    if (at + size > this.length) {
      throw new RangeError(`read of ${size} bytes at ${at} exceeds buffer of ${this.length}`);
    }
    this.offset = at + size;
    return at;
  }

  u8(): number {
    return this.view.getUint8(this.take(1));
  }

  u16(): number {
    return this.view.getUint16(this.take(2), this.littleEndian);
  }

  u32(): number {
    return this.view.getUint32(this.take(4), this.littleEndian);
  }

  i32(): number {
    return this.view.getInt32(this.take(4), this.littleEndian);
  }

  u64(): bigint {
    return this.view.getBigUint64(this.take(8), this.littleEndian);
  }

  /** Reads a 64-bit value as a JS number; throws if it exceeds the safe range. */
  u64n(): number {
    const value = this.u64();
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new RangeError(`64-bit value ${value} exceeds Number.MAX_SAFE_INTEGER`);
    }
    return Number(value);
  }

  bytesAt(count: number): Uint8Array {
    const at = this.take(count);
    return this.bytes.subarray(at, at + count);
  }

  /** Fixed-width field, NUL padded (ELF section names, Mach-O segment names). */
  fixedString(width: number): string {
    const raw = this.bytesAt(width);
    const end = raw.indexOf(0);
    return latin1(end === -1 ? raw : raw.subarray(0, end));
  }

  /** Unsigned LEB128 (WASM, DWARF). */
  uleb128(): number {
    let result = 0;
    let shift = 0;
    for (;;) {
      const byte = this.u8();
      result += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7;
      if (shift > 56) throw new RangeError("uleb128 value too large");
    }
  }

  /** Signed LEB128; values beyond 32 bits are consumed but return a truncated number. */
  sleb128(): number {
    let result = 0;
    let shift = 0;
    let byte = 0;
    do {
      byte = this.u8();
      if (shift < 32) result |= (byte & 0x7f) << shift;
      shift += 7;
      if (shift > 70) throw new RangeError("sleb128 value too long");
    } while (byte & 0x80);
    if (shift < 32 && byte & 0x40) result |= -1 << shift;
    return result;
  }
}

export function latin1(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
}

const utf8 = new TextDecoder("utf-8", { fatal: false });

export function utf8String(bytes: Uint8Array): string {
  return utf8.decode(bytes);
}

/** Reads a NUL-terminated string from a string table at `offset`. */
export function cstringAt(bytes: Uint8Array, offset: number, max = 4096): string {
  if (offset < 0 || offset >= bytes.length) return "";
  let end = offset;
  const limit = Math.min(bytes.length, offset + max);
  while (end < limit && bytes[end] !== 0) end++;
  return utf8String(bytes.subarray(offset, end));
}

export function hex(value: number | bigint, width = 0): string {
  const text = value.toString(16);
  return `0x${width > 0 ? text.padStart(width, "0") : text}`;
}
