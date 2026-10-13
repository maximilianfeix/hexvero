import { Builder } from "./builder.js";

/** UTF-16 ResStringPool chunk. */
function stringPool(strings: string[]): Uint8Array {
  const data = new Builder();
  const offsets: number[] = [];
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
  const b = new Builder();
  b.u16(0x0001)
    .u16(headerSize)
    .u32(stringsStart + dataBytes.length)
    .u32(strings.length)
    .u32(0)
    .u32(0)
    .u32(stringsStart)
    .u32(0);
  for (const o of offsets) b.u32(o);
  b.bytes(dataBytes);
  return b.done();
}

/** ResTable_config of `size` bytes with optional language/country and density. */
function config(locale?: [string, string], density = 0): Uint8Array {
  const b = new Builder();
  b.u32(64).u16(0).u16(0); // size, mcc, mnc
  if (locale)
    b.u8(locale[0].charCodeAt(0))
      .u8(locale[0].charCodeAt(1))
      .u8(locale[1].charCodeAt(0))
      .u8(locale[1].charCodeAt(1));
  else b.u32(0);
  b.u8(0).u8(0).u16(density); // orientation, touchscreen, density
  b.pad(64);
  return b.done();
}

/** Type chunk with `entries` [key index, dataType, data] for one configuration. */
function typeChunk(
  typeId: number,
  cfg: Uint8Array,
  entries: Array<[number, number, number] | null>,
): Uint8Array {
  const body = new Builder();
  const offsets: number[] = [];
  for (const e of entries) {
    if (!e) {
      offsets.push(0xffffffff);
      continue;
    }
    offsets.push(body.length);
    body.u16(8).u16(0).u32(e[0]); // entry size, flags, key
    body.u16(8).u8(0).u8(e[1]).u32(e[2]); // Res_value
  }
  const headerSize = 20 + cfg.length;
  const entriesStart = headerSize + offsets.length * 4;
  const bodyBytes = body.done();
  const b = new Builder();
  b.u16(0x0201)
    .u16(headerSize)
    .u32(entriesStart + bodyBytes.length)
    .u8(typeId)
    .u8(0)
    .u16(0)
    .u32(entries.length)
    .u32(entriesStart)
    .bytes(cfg);
  for (const o of offsets) b.u32(o);
  b.bytes(bodyBytes);
  return b.done();
}

function typeSpec(id: number, count: number): Uint8Array {
  const b = new Builder();
  b.u16(0x0202)
    .u16(16)
    .u32(16 + count * 4)
    .u8(id)
    .u8(0)
    .u16(0)
    .u32(count);
  for (let i = 0; i < count; i++) b.u32(0);
  return b.done();
}

/**
 * resources.arsc for package com.example.demo (0x7f) with types string and
 * color: app_name (default + de + fr), hello (default only), primary color.
 */
export function buildArsc(options: { modern?: boolean; typeIdOffset?: number } = {}): Uint8Array {
  const globalStrings = ["Demo App", "Hello", "Demo-App", "Appli Demo"];
  const pool = stringPool(globalStrings);
  const typeStrings = stringPool(["string", "color"]);
  const keyStrings = stringPool(["app_name", "hello", "primary"]);
  const modern = options.modern ?? false;
  const layout = { offset16: modern, compact: modern };
  const chunks = [
    typeSpec(1, 2),
    // qualified configurations first: the default must still win
    typeChunk(1, config(["de", "DE"]), [[0, 0x03, 2], null], layout),
    typeChunk(
      1,
      config(),
      [
        [0, 0x03, 0],
        [1, 0x03, 1],
      ],
      layout,
    ),
    typeChunk(1, config(["fr", "\0\0"]), [[0, 0x03, 3], null], layout),
    typeSpec(2, 1),
    typeChunk(2, config(undefined, 480), [[2, 0x1c, 0xff336699]], layout),
  ];
  const pkgHeaderSize = 288;
  const pkg = new Builder();
  const chunkBytes = chunks.reduce((n, c) => n + c.length, 0);
  pkg
    .u16(0x0200)
    .u16(pkgHeaderSize)
    .u32(pkgHeaderSize + typeStrings.length + keyStrings.length + chunkBytes)
    .u32(0x7f);
  const name = new Builder();
  for (const ch of "com.example.demo") name.u16(ch.charCodeAt(0));
  name.pad(256);
  pkg.bytes(name.done());
  pkg
    .u32(pkgHeaderSize)
    .u32(2)
    .u32(pkgHeaderSize + typeStrings.length)
    .u32(3)
    .u32(options.typeIdOffset ?? 0); // typeStrings, lastPublicType, keyStrings, lastPublicKey, typeIdOffset
  pkg.pad(pkgHeaderSize).bytes(typeStrings).bytes(keyStrings);
  for (const c of chunks) pkg.bytes(c);
  const pkgBytes = pkg.done();
  const table = new Builder();
  table
    .u16(0x0002)
    .u16(12)
    .u32(12 + pool.length + pkgBytes.length)
    .u32(1)
    .bytes(pool)
    .bytes(pkgBytes);
  return table.done();
}
