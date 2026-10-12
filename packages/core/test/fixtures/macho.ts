import { Builder } from "./builder.js";

/** Minimal 64-bit little-endian arm64 Mach-O executable with PIE, one dylib, UUID, build version and symbols. */
export function buildMacho(options: { pie?: boolean } = {}): Uint8Array {
  const b = new Builder(true);
  const pie = options.pie ?? true;
  b.u32(0xfeedfacf).u32(0x0100000c).u32(0).u32(2);
  const ncmdsAt = b.length;
  b.u32(0)
    .u32(0)
    .u32((pie ? 0x200000 : 0) | 0x85)
    .u32(0);
  let ncmds = 0;
  // LC_SEGMENT_64 __TEXT with __text section
  b.u32(0x19)
    .u32(72 + 80)
    .fixed("__TEXT", 16)
    .u64(0x100000000)
    .u64(0x4000)
    .u64(0)
    .u64(0x4000)
    .u32(5)
    .u32(5)
    .u32(1)
    .u32(0);
  b.fixed("__text", 16)
    .fixed("__TEXT", 16)
    .u64(0x100001000)
    .u64(0x100)
    .u32(0x1000)
    .u32(2)
    .u32(0)
    .u32(0)
    .u32(0x80000400)
    .u32(0)
    .u32(0)
    .u32(0);
  ncmds++;
  // LC_LOAD_DYLIB
  const dylib = "/usr/lib/libSystem.B.dylib";
  const dylibSize = Math.ceil((24 + dylib.length + 1) / 8) * 8;
  b.u32(0xc)
    .u32(dylibSize)
    .u32(24)
    .u32(2)
    .u32(0x10000)
    .u32(0x10000)
    .cstr(dylib)
    .align(8);
  ncmds++;
  // LC_UUID
  b.u32(0x1b)
    .u32(24)
    .bytes([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
  ncmds++;
  // LC_BUILD_VERSION (macOS 13.0, SDK 14.0, 0 tools)
  b.u32(0x32).u32(24).u32(1).u32(0x000d0000).u32(0x000e0000).u32(0);
  ncmds++;
  // LC_MAIN
  b.u32(0x80000028).u32(24).u64(0x1000).u64(0);
  ncmds++;
  // LC_SYMTAB (patched)
  const symtabAt = b.length;
  b.u32(0x2).u32(24).u32(0).u32(2).u32(0).u32(0);
  ncmds++;
  b.patchU32(ncmdsAt, ncmds).patchU32(ncmdsAt + 4, b.length - 32);
  b.align(16);
  const symoff = b.length;
  // nlist_64: n_strx u32, n_type u8, n_sect u8, n_desc u16, n_value u64
  b.u32(1).u8(0x01).u8(0).u16(0).u64(0); // ___stack_chk_fail: N_UNDF | N_EXT
  b.u32(19).u8(0x0f).u8(1).u16(0).u64(0x100001000); // _main: N_SECT | N_EXT
  const stroff = b.length;
  b.u8(0).cstr("___stack_chk_fail").cstr("_main");
  const strsize = b.length - stroff;
  b.patchU32(symtabAt + 8, symoff)
    .patchU32(symtabAt + 16, stroff)
    .patchU32(symtabAt + 20, strsize);
  b.align(16);
  return b.done();
}

export function buildFat(slices: Uint8Array[]): Uint8Array {
  const b = new Builder(false);
  b.u32(0xcafebabe).u32(slices.length);
  let offset = 0x1000;
  const cpus = [0x0100000c, 0x01000007];
  for (let i = 0; i < slices.length; i++) {
    b.u32(cpus[i]!).u32(0).u32(offset).u32(slices[i]!.length).u32(12);
    offset += Math.ceil(slices[i]!.length / 0x1000) * 0x1000;
  }
  let at = 0x1000;
  for (const s of slices) {
    b.pad(at).bytes(s);
    at += Math.ceil(s.length / 0x1000) * 0x1000;
  }
  return b.done();
}
