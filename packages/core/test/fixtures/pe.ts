import { Builder } from "./builder.js";

/** Minimal PE32+ DLL with one import DLL (two names, one ordinal) and exports (one named, one forwarder). */
export function buildPe(
  options: { clr?: boolean | Uint8Array } = {},
): Uint8Array {
  const b = new Builder(true);
  b.ascii("MZ").pad(0x3c).u32(0x40).pad(0x40);
  b.ascii("PE\0\0");
  b.u16(0x8664).u16(2).u32(1_700_000_000).u32(0).u32(0).u16(240).u16(0x2022);
  const opt = b.length;
  b.u16(0x20b)
    .u8(14)
    .u8(0)
    .u32(0x200)
    .u32(0x200)
    .u32(0)
    .u32(0x1000)
    .u32(0x1000);
  b.u64(0x180000000); // image base
  b.u32(0x1000).u32(0x200);
  b.u16(6)
    .u16(0)
    .u16(0)
    .u16(0)
    .u16(6)
    .u16(0)
    .u32(0)
    .u32(0x3000)
    .u32(0x400)
    .u32(0);
  b.u16(2).u16(0x160); // subsystem GUI, DLL chars: HIGH_ENTROPY|DYNAMIC_BASE|NX
  b.u64(0x100000).u64(0x1000).u64(0x100000).u64(0x1000).u32(0).u32(16);
  const dirs = b.length;
  for (let i = 0; i < 16; i++) b.u32(0).u32(0);
  if (b.length - opt !== 240)
    throw new Error(`optional header is ${b.length - opt}`);

  // Section table: .text (RVA 0x1000, raw 0x200) and .rdata (RVA 0x2000, raw 0x400)
  const section = (
    name: string,
    va: number,
    raw: number,
    flags: number,
  ): void => {
    b.fixed(name, 8)
      .u32(0x200)
      .u32(va)
      .u32(0x200)
      .u32(raw)
      .u32(0)
      .u32(0)
      .u16(0)
      .u16(0)
      .u32(flags);
  };
  section(".text", 0x1000, 0x200, 0x60000020);
  section(".rdata", 0x2000, 0x400, 0x40000040);
  b.patchU32(b.length - 24, 0x800); // .rdata raw size
  b.pad(0x200);

  // .text: import directory at RVA 0x1000
  const textRva = 0x1000;
  const rva = (fileOff: number): number => textRva + (fileOff - 0x200);
  b.pad(0x200 + 0x40); // descriptors at 0x1000..; leave 0x40 for two descriptors
  const iltOff = b.length;
  const ilt = rva(iltOff);
  b.u64(0).u64(0).u64(0x8000000000000011n).u64(0); // names patched later, ordinal 17
  const kernelNameOff = b.length;
  b.cstr("KERNEL32.dll");
  b.align(2);
  const hint1 = b.length;
  b.u16(0).cstr("CreateFileW");
  b.align(2);
  const hint2 = b.length;
  b.u16(0).cstr("ReadFile");
  b.patchU64(iltOff, rva(hint1)).patchU64(iltOff + 8, rva(hint2));
  // import descriptor at file offset 0x200 (RVA 0x1000)
  const full = b;
  full
    .patchU32(0x200, ilt)
    .patchU32(0x204, 0)
    .patchU32(0x208, 0)
    .patchU32(0x20c, rva(kernelNameOff))
    .patchU32(0x210, ilt);
  full.patchU32(dirs + 8, 0x1000).patchU32(dirs + 12, 0x40);
  full.pad(0x400);

  // .rdata: export directory at RVA 0x2000
  const rdataRva = 0x2000;
  const rva2 = (fileOff: number): number => rdataRva + (fileOff - 0x400);
  const exportDirOff = b.length;
  b.pad(exportDirOff + 40);
  const funcsOff = b.length;
  b.u32(0x1100).u32(0); // second patched to forwarder string
  const namesOff = b.length;
  b.u32(0).u32(0);
  const ordsOff = b.length;
  b.u16(0).u16(1);
  const dllName = b.length;
  b.cstr("fixture.dll");
  const n1 = b.length;
  b.cstr("Hello");
  const n2 = b.length;
  b.cstr("Forwarded");
  const fwd = b.length;
  b.cstr("NTDLL.RtlZeroMemory");
  b.patchU32(funcsOff + 4, rva2(fwd));
  b.patchU32(namesOff, rva2(n1)).patchU32(namesOff + 4, rva2(n2));
  b.patchU32(exportDirOff + 12, rva2(dllName))
    .patchU32(exportDirOff + 16, 1)
    .patchU32(exportDirOff + 20, 2)
    .patchU32(exportDirOff + 24, 2);
  b.patchU32(exportDirOff + 28, rva2(funcsOff))
    .patchU32(exportDirOff + 32, rva2(namesOff))
    .patchU32(exportDirOff + 36, rva2(ordsOff));
  const exportSize = b.length - exportDirOff;
  b.patchU32(dirs, 0x2000).patchU32(dirs + 4, exportSize);
  if (options.clr) {
    b.patchU32(dirs + 14 * 8, 0x2100).patchU32(dirs + 14 * 8 + 4, 72);
    b.pad(0x500);
    const metadata =
      options.clr instanceof Uint8Array ? options.clr : new Uint8Array();
    // CLR header: cb, major 2, minor 5, metadata RVA/size, flags ILONLY, entry token
    b.u32(72)
      .u16(2)
      .u16(5)
      .u32(0x2148)
      .u32(metadata.length)
      .u32(1)
      .u32(0x06000001)
      .pad(0x548);
    b.bytes(metadata);
  }
  b.pad(0xc00);
  return b.done();
}
