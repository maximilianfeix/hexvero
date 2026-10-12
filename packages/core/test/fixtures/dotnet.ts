import { Builder } from "./builder.js";

/** Metadata root with #~, #Strings and #US describing assembly MyAsm with types <Module> and Bar.Foo. */
export function buildDotnetMetadata(): Uint8Array {
  const strings = new Builder();
  const idx: Record<string, number> = {};
  for (const s of [
    "",
    "Module",
    "<Module>",
    "Foo",
    "Bar",
    "Main",
    "Run",
    "mscorlib",
    "kernel32.dll",
    "Beep",
    "MyAsm",
    "Object",
    "System",
  ]) {
    idx[s] = strings.length;
    strings.cstr(s);
  }
  strings.align(4);
  const stringsBytes = strings.done();

  const us = new Builder();
  us.u8(0).u8(11);
  for (const c of "Hello") us.u16(c.charCodeAt(0));
  us.u8(0).align(4);
  const usBytes = us.done();

  const t = new Builder();
  t.u32(0).u8(2).u8(0).u8(0).u8(1);
  const present = [0x00, 0x01, 0x02, 0x06, 0x1a, 0x1c, 0x20, 0x23];
  let valid = 0n;
  for (const p of present) valid |= 1n << BigInt(p);
  t.u64(valid).u64(0n);
  const counts: Record<number, number> = {
    0: 1,
    1: 1,
    2: 2,
    6: 2,
    0x1a: 1,
    0x1c: 1,
    0x20: 1,
    0x23: 1,
  };
  for (const p of present) t.u32(counts[p]!);
  // Module
  t.u16(0).u16(idx["Module"]!).u16(1).u16(0).u16(0);
  // TypeRef: ResolutionScope = AssemblyRef#1 (tag 2), System.Object
  t.u16((1 << 2) | 2)
    .u16(idx["Object"]!)
    .u16(idx["System"]!);
  // TypeDef rows
  t.u32(0).u16(idx["<Module>"]!).u16(idx[""]!).u16(0).u16(1).u16(1);
  t.u32(0x100001)
    .u16(idx["Foo"]!)
    .u16(idx["Bar"]!)
    .u16((1 << 2) | 1)
    .u16(1)
    .u16(1);
  // MethodDef rows: rva, implflags, flags, name, sig, paramlist
  t.u32(0x2000).u16(0).u16(0x16).u16(idx["Main"]!).u16(0).u16(1);
  t.u32(0).u16(0).u16(0x2016).u16(idx["Run"]!).u16(0).u16(1);
  // ModuleRef
  t.u16(idx["kernel32.dll"]!);
  // ImplMap: flags, MemberForwarded = MethodDef#2 (tag 1), import name, scope
  t.u16(0x100)
    .u16((2 << 1) | 1)
    .u16(idx["Beep"]!)
    .u16(1);
  // Assembly
  t.u32(0x8004).u16(1).u16(2).u16(3).u16(4).u32(0).u16(0).u16(idx["MyAsm"]!).u16(idx[""]!);
  // AssemblyRef
  t.u16(4).u16(0).u16(0).u16(0).u32(0).u16(0).u16(idx["mscorlib"]!).u16(0).u16(0);
  t.align(4);
  const tablesBytes = t.done();

  const root = new Builder();
  root.ascii("BSJB").u16(1).u16(1).u32(0).u32(12).fixed("v4.0.30319", 12).u16(0).u16(3);
  const headerSize = root.length + 3 * 8 + 4 + 12 + 4; // "#~\0\0" "#Strings\0\0\0\0" "#US\0"
  let offset = headerSize;
  const streams: Array<[string, Uint8Array]> = [
    ["#~", tablesBytes],
    ["#Strings", stringsBytes],
    ["#US", usBytes],
  ];
  for (const [name, bytes] of streams) {
    root.u32(offset).u32(bytes.length).cstr(name).align(4);
    offset += bytes.length;
  }
  if (root.length !== headerSize) throw new Error(`header ${root.length} != ${headerSize}`);
  for (const [, bytes] of streams) root.bytes(bytes);
  return root.done();
}
