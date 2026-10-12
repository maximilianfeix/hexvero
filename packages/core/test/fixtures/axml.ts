import { Builder } from "./builder.js";

/** Builds a binary AndroidManifest.xml from a tiny element tree using a UTF-16 string pool. */
export interface El {
  tag: string;
  attrs?: Array<[name: string, value: string | number | boolean, ns?: boolean]>;
  children?: El[];
}

export function buildAxml(root: El): Uint8Array {
  const ANDROID_NS = "http://schemas.android.com/apk/res/android";
  const strings: string[] = ["android", ANDROID_NS];
  const index = (s: string): number => {
    let i = strings.indexOf(s);
    if (i === -1) {
      strings.push(s);
      i = strings.length - 1;
    }
    return i;
  };
  const walk = (el: El): void => {
    index(el.tag);
    for (const [n, v] of el.attrs ?? []) {
      index(n);
      if (typeof v === "string") index(v);
    }
    el.children?.forEach(walk);
  };
  walk(root);

  const pool = new Builder();
  const offsets: number[] = [];
  const data = new Builder();
  for (const s of strings) {
    offsets.push(data.length);
    data.u16(s.length);
    for (const ch of s) data.u16(ch.charCodeAt(0));
    data.u16(0);
  }
  data.align(4);
  const dataBytes = data.done();
  const headerSize = 28;
  const stringsStart = headerSize + offsets.length * 4;
  pool
    .u16(0x0001)
    .u16(headerSize)
    .u32(stringsStart + dataBytes.length)
    .u32(strings.length)
    .u32(0)
    .u32(0)
    .u32(stringsStart)
    .u32(0);
  for (const o of offsets) pool.u32(o);
  pool.bytes(dataBytes);

  const body = new Builder();
  body
    .u16(0x0100)
    .u16(16)
    .u32(24)
    .u32(0)
    .u32(0xffffffff)
    .u32(index("android"))
    .u32(index(ANDROID_NS));
  const emit = (el: El): void => {
    const attrs = el.attrs ?? [];
    const start = body.length;
    body
      .u16(0x0102)
      .u16(16)
      .u32(0)
      .u32(0)
      .u32(0xffffffff)
      .u32(0xffffffff)
      .u32(index(el.tag))
      .u16(20)
      .u16(20)
      .u16(attrs.length)
      .u16(0)
      .u16(0)
      .u16(0);
    for (const [n, v, ns] of attrs) {
      body.u32(ns === false ? 0xffffffff : index(ANDROID_NS)).u32(index(n));
      if (typeof v === "string")
        body.u32(index(v)).u16(8).u8(0).u8(0x03).u32(index(v));
      else if (typeof v === "boolean")
        body
          .u32(0xffffffff)
          .u16(8)
          .u8(0)
          .u8(0x12)
          .u32(v ? 0xffffffff : 0);
      else body.u32(0xffffffff).u16(8).u8(0).u8(0x10).u32(v);
    }
    body.patchU32(start + 4, body.length - start);
    el.children?.forEach(emit);
    body
      .u16(0x0103)
      .u16(16)
      .u32(24)
      .u32(0)
      .u32(0xffffffff)
      .u32(0xffffffff)
      .u32(index(el.tag));
  };
  emit(root);
  const poolBytes = pool.done();
  const bodyBytes = body.done();
  const out = new Builder();
  out
    .u16(0x0003)
    .u16(8)
    .u32(8 + poolBytes.length + bodyBytes.length)
    .bytes(poolBytes)
    .bytes(bodyBytes);
  return out.done();
}
