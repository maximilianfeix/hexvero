import { Builder } from "./builder.js";

/**
 * Minimal ELF with .dynstr/.dynsym/.dynamic/.note/.shstrtab, PT_INTERP,
 * PT_GNU_STACK and PT_GNU_RELRO. 64-bit little-endian by default; 32-bit big
 * endian when requested, which exercises every layout branch.
 */
export function buildElf(
  options: { bits?: 32 | 64; little?: boolean; nx?: boolean } = {},
): Uint8Array {
  const bits = options.bits ?? 64;
  const little = options.little ?? true;
  const nx = options.nx ?? true;
  const b = new Builder(little);
  const word = (v: number): Builder => (bits === 64 ? b.u64(v) : b.u32(v));
  const ehsize = bits === 64 ? 64 : 52;
  const phentsize = bits === 64 ? 56 : 32;
  const shentsize = bits === 64 ? 64 : 40;

  // e_ident
  b.bytes([
    0x7f,
    0x45,
    0x4c,
    0x46,
    bits === 64 ? 2 : 1,
    little ? 1 : 2,
    1,
    0,
  ]).pad(16);
  b.u16(3); // ET_DYN
  b.u16(bits === 64 ? 0x3e : 0x28); // x86-64 or arm
  b.u32(1);
  word(0x1000); // entry
  const phoffAt = b.length;
  word(0); // phoff (patched)
  const shoffAt = b.length;
  word(0); // shoff (patched)
  b.u32(0).u16(ehsize).u16(phentsize);
  b.u16(4); // phnum
  b.u16(shentsize);
  b.u16(6); // shnum
  b.u16(5); // shstrndx

  // Data blobs
  const interpOff = b.length;
  b.cstr("/lib64/ld-linux-x86-64.so.2");
  const dynstrOff = b.length;
  const dynstr = [
    "",
    "libc.so.6",
    "libm.so.6",
    "__stack_chk_fail",
    "main",
    "libfixture.so",
    "$ORIGIN/lib",
  ];
  const strIndex: Record<string, number> = {};
  for (const s of dynstr) {
    strIndex[s] = b.length - dynstrOff;
    b.cstr(s);
  }
  const dynstrSize = b.length - dynstrOff;
  b.align(8);
  const dynsymOff = b.length;
  const sym = (
    name: string,
    value: number,
    size: number,
    info: number,
    shndx: number,
  ): void => {
    if (bits === 64)
      b.u32(strIndex[name]!).u8(info).u8(0).u16(shndx).u64(value).u64(size);
    else b.u32(strIndex[name]!).u32(value).u32(size).u8(info).u8(0).u16(shndx);
  };
  sym("", 0, 0, 0, 0);
  sym("__stack_chk_fail", 0, 0, 0x12, 0); // GLOBAL FUNC UND
  sym("main", 0x1000, 32, 0x12, 1); // GLOBAL FUNC in section 1
  const dynsymSize = b.length - dynsymOff;
  b.align(8);
  const dynamicOff = b.length;
  const dyn = (tag: number, val: number): void => {
    if (bits === 64) b.u64(tag).u64(val);
    else b.u32(tag).u32(val);
  };
  dyn(1, strIndex["libc.so.6"]!);
  dyn(1, strIndex["libm.so.6"]!);
  dyn(14, strIndex["libfixture.so"]!);
  dyn(29, strIndex["$ORIGIN/lib"]!);
  dyn(24, 0); // BIND_NOW → full RELRO
  dyn(0x6ffffffb, 0x08000000); // DT_FLAGS_1 PIE
  dyn(0, 0);
  const dynamicSize = b.length - dynamicOff;
  b.align(4);
  const noteOff = b.length;
  b.u32(4).u32(8).u32(3).ascii("GNU\0").bytes([1, 2, 3, 4, 5, 6, 7, 8]);
  const noteSize = b.length - noteOff;
  const shstrOff = b.length;
  const names = [
    "",
    ".dynsym",
    ".dynstr",
    ".dynamic",
    ".note.gnu.build-id",
    ".shstrtab",
  ];
  const nameIndex: number[] = [];
  for (const n of names) {
    nameIndex.push(b.length - shstrOff);
    b.cstr(n);
  }
  const shstrSize = b.length - shstrOff;
  b.align(8);

  // Program headers
  const phoff = b.length;
  const ph = (
    type: number,
    flags: number,
    offset: number,
    filesz: number,
  ): void => {
    if (bits === 64)
      b.u32(type)
        .u32(flags)
        .u64(offset)
        .u64(offset)
        .u64(offset)
        .u64(filesz)
        .u64(filesz)
        .u64(8);
    else
      b.u32(type)
        .u32(offset)
        .u32(offset)
        .u32(offset)
        .u32(filesz)
        .u32(filesz)
        .u32(flags)
        .u32(8);
  };
  ph(3, 4, interpOff, 28); // PT_INTERP
  ph(2, 6, dynamicOff, dynamicSize); // PT_DYNAMIC
  ph(0x6474e551, nx ? 6 : 7, 0, 0); // PT_GNU_STACK
  ph(0x6474e552, 4, dynamicOff, dynamicSize); // PT_GNU_RELRO

  // Section headers
  const shoff = b.length;
  const sh = (
    name: number,
    type: number,
    flags: number,
    addr: number,
    off: number,
    size: number,
    link: number,
    entsize: number,
  ): void => {
    b.u32(name).u32(type);
    if (bits === 64)
      b.u64(flags)
        .u64(addr)
        .u64(off)
        .u64(size)
        .u32(link)
        .u32(0)
        .u64(8)
        .u64(entsize);
    else
      b.u32(flags)
        .u32(addr)
        .u32(off)
        .u32(size)
        .u32(link)
        .u32(0)
        .u32(4)
        .u32(entsize);
  };
  sh(0, 0, 0, 0, 0, 0, 0, 0);
  sh(
    nameIndex[1]!,
    11,
    2,
    0x200,
    dynsymOff,
    dynsymSize,
    2,
    bits === 64 ? 24 : 16,
  );
  sh(nameIndex[2]!, 3, 2, 0x300, dynstrOff, dynstrSize, 0, 0);
  sh(
    nameIndex[3]!,
    6,
    3,
    0x400,
    dynamicOff,
    dynamicSize,
    2,
    bits === 64 ? 16 : 8,
  );
  sh(nameIndex[4]!, 7, 2, 0x500, noteOff, noteSize, 0, 0);
  sh(nameIndex[5]!, 3, 0, 0, shstrOff, shstrSize, 0, 0);

  if (bits === 64) b.patchU64(phoffAt, phoff).patchU64(shoffAt, shoff);
  else b.patchU32(phoffAt, phoff).patchU32(shoffAt, shoff);
  return b.done();
}
