import { Builder } from "./builder.js";

/** DEX 035 with three strings, three types and two classes (one obfuscated-looking). */
export function buildDex(): Uint8Array {
  const strings = [
    "Lcom/example/App;",
    "Ljava/lang/Object;",
    "La/b;",
    "App.java",
    "https://api.example.com/v1",
  ];
  const b = new Builder(true);
  b.ascii("dex\n035\0").u32(0).pad(0x20);
  const fileSizeAt = b.length;
  b.u32(0).u32(0x70).u32(0x12345678).u32(0).u32(0).u32(0); // file size, header size, endian, link, map
  const stringIdsAt = b.length;
  b.u32(strings.length).u32(0);
  const typeIdsAt = b.length;
  b.u32(3).u32(0);
  b.u32(0).u32(0); // protos
  b.u32(0).u32(0); // fields
  b.u32(7).u32(0); // methods (count only)
  const classDefsAt = b.length;
  b.u32(2).u32(0);
  b.u32(0).u32(0); // data
  b.pad(0x70);
  // string data
  const offsets: number[] = [];
  for (const s of strings) {
    offsets.push(b.length);
    b.u8(s.length).ascii(s).u8(0);
  }
  b.align(4);
  const stringIdsOff = b.length;
  for (const o of offsets) b.u32(o);
  const typeIdsOff = b.length;
  b.u32(0).u32(1).u32(2);
  const classDefsOff = b.length;
  b.u32(0).u32(0x1).u32(1).u32(0).u32(3).u32(0).u32(0).u32(0);
  b.u32(2).u32(0x10).u32(1).u32(0).u32(0xffffffff).u32(0).u32(0).u32(0);
  b.patchU32(fileSizeAt, b.length)
    .patchU32(stringIdsAt + 4, stringIdsOff)
    .patchU32(typeIdsAt + 4, typeIdsOff)
    .patchU32(classDefsAt + 4, classDefsOff);
  return b.done();
}
