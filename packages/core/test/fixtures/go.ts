import { Builder } from "./builder.js";

const SENTINEL = [
  0x30, 0x77, 0xaf, 0x0c, 0x92, 0x74, 0x08, 0x02, 0x41, 0xe1, 0xc1, 0x07, 0xe6,
  0xd6, 0x18, 0xe6,
];
export const MODINFO =
  "path\tgithub.com/acme/tool\nmod\tgithub.com/acme/tool\t(devel)\t\ndep\tgolang.org/x/sys\tv0.20.0\th1:abc=\n=>\t./forks/sys\tv0.0.0\nbuild\t-ldflags=-s -w\nbuild\tCGO_ENABLED=1\nbuild\tvcs=git\nbuild\tvcs.revision=0123456789abcdef\nbuild\tvcs.modified=true\n";

function uvarint(b: Builder, v: number): void {
  while (v >= 0x80) {
    b.u8((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  b.u8(v);
}

/** Go 1.18+ inline-string buildinfo blob surrounded by junk. */
export function buildGoInline(): Uint8Array {
  const b = new Builder();
  b.ascii("junk junk ")
    .u8(0xff)
    .ascii(" Go buildinf:")
    .u8(8)
    .u8(2)
    .pad(b.length + 16);
  const version = "go1.22.3";
  uvarint(b, version.length);
  b.ascii(version);
  const mod = new Builder()
    .bytes(SENTINEL)
    .ascii(MODINFO)
    .bytes(SENTINEL)
    .done();
  uvarint(b, mod.length);
  b.bytes(mod).ascii(" trailing");
  return b.done();
}

/** Pre-1.18 pointer layout where virtual addresses equal file offsets. */
export function buildGoPointer(): Uint8Array {
  const b = new Builder();
  b.u8(0xff).ascii(" Go buildinf:").u8(8).u8(0);
  b.u64(64).u64(80); // pointers to string headers
  b.pad(64).u64(96).u64(8); // version header → "go1.17.2"
  b.pad(80).u64(112).u64(0); // modinfo header (empty)
  b.pad(96).ascii("go1.17.2").pad(112);
  return b.done();
}
