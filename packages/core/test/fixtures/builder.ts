/** Tiny growable buffer for synthesizing binary fixtures in tests. */
export class Builder {
  private buf = new Uint8Array(4096);
  private view = new DataView(this.buf.buffer);
  length = 0;
  constructor(readonly little = true) {}

  private ensure(size: number): void {
    if (this.length + size <= this.buf.length) return;
    const next = new Uint8Array(Math.max(this.buf.length * 2, this.length + size));
    next.set(this.buf);
    this.buf = next;
    this.view = new DataView(next.buffer);
  }
  u8(v: number): this {
    this.ensure(1);
    this.view.setUint8(this.length, v);
    this.length += 1;
    return this;
  }
  u16(v: number): this {
    this.ensure(2);
    this.view.setUint16(this.length, v, this.little);
    this.length += 2;
    return this;
  }
  u32(v: number): this {
    this.ensure(4);
    this.view.setUint32(this.length, v >>> 0, this.little);
    this.length += 4;
    return this;
  }
  u64(v: number | bigint): this {
    this.ensure(8);
    this.view.setBigUint64(this.length, BigInt(v), this.little);
    this.length += 8;
    return this;
  }
  bytes(b: Uint8Array | number[]): this {
    const arr = b instanceof Uint8Array ? b : Uint8Array.from(b);
    this.ensure(arr.length);
    this.buf.set(arr, this.length);
    this.length += arr.length;
    return this;
  }
  ascii(s: string): this {
    return this.bytes(Uint8Array.from(s, (c) => c.charCodeAt(0)));
  }
  cstr(s: string): this {
    return this.ascii(s).u8(0);
  }
  fixed(s: string, width: number): this {
    const b = new Uint8Array(width);
    for (let i = 0; i < Math.min(width, s.length); i++) b[i] = s.charCodeAt(i);
    return this.bytes(b);
  }
  pad(to: number): this {
    while (this.length < to) this.u8(0);
    return this;
  }
  align(n: number): this {
    return this.pad(Math.ceil(this.length / n) * n);
  }
  patchU32(at: number, v: number): this {
    this.view.setUint32(at, v >>> 0, this.little);
    return this;
  }
  patchU64(at: number, v: number): this {
    this.view.setBigUint64(at, BigInt(v), this.little);
    return this;
  }
  done(): Uint8Array {
    return this.buf.slice(0, this.length);
  }
}
