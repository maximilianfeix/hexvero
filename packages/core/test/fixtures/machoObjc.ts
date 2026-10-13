import { Builder } from "./builder.js";

/**
 * 64-bit Mach-O with one segment holding Objective-C metadata: class `Greeter`
 * (superclass bound to NSObject through an import) with two instance methods,
 * one class method, one ivar, one property and one adopted protocol; protocol
 * `Greeting`; category `Greeter(Extras)`. Pointers are absolute, or encoded
 * as DYLD_CHAINED_PTR_64_OFFSET rebases/binds when `chained` is set.
 */
function uleb(b: Builder, v: number): void {
  while (v >= 0x80) {
    b.u8((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  b.u8(v);
}

export function buildObjcMacho(options: { chained?: boolean } = {}): Uint8Array {
  const chained = options.chained ?? false;
  const BASE = 0x100000000;
  const b = new Builder(true);
  const names = [
    "__objc_classlist",
    "__objc_const",
    "__objc_data",
    "__objc_protolist",
    "__objc_catlist",
    "__objc_selrefs",
    "__objc_classname",
    "__objc_methname",
    "__objc_methtype",
  ];
  const segCmdSize = 72 + names.length * 80;
  const fixupsCmdSize = 16;
  const dyldInfoCmdSize = 48;
  const cmdsSize = segCmdSize + (chained ? fixupsCmdSize : dyldInfoCmdSize);
  // ---- content layout (file offset == vmaddr - BASE) ----
  const DATA = 0x1000;
  const slots: Record<string, number> = {};
  let cursor = DATA;
  const alloc = (name: string, size: number): number => {
    cursor = (cursor + 7) & ~7;
    slots[name] = cursor;
    cursor += size;
    return slots[name]!;
  };
  // strings
  const strings: Record<string, number> = {};
  const strBlob = new Builder();
  const str = (text: string): number => {
    if (strings[text] === undefined) {
      strings[text] = strBlob.length;
      strBlob.cstr(text);
    }
    return strings[text]!;
  };
  for (const t of [
    "Greeter",
    "Greeting",
    "Extras",
    "greet",
    "greet:",
    "shared",
    "wave",
    "name",
    "@16@0:8",
    "v16@0:8",
    '@"NSString"',
    'T@"NSString",&,N,V_name',
  ])
    str(t);
  const strOff = alloc("strings", strBlob.length);
  const S = (t: string): number => BASE + strOff + str(t);
  // method lists
  const methListOff = alloc("inst_methods", 8 + 2 * 24);
  const classMethListOff = alloc("class_methods", 8 + 1 * 24);
  const catMethListOff = alloc("cat_methods", 8 + 1 * 24);
  const protoMethListOff = alloc("proto_methods", 8 + 1 * 24);
  const ivarOffVar = alloc("ivar_offset_var", 4);
  const ivarListOff = alloc("ivars", 8 + 32);
  const propListOff = alloc("props", 8 + 16);
  const protoOff = alloc("protocol", 96);
  const protoListOff = alloc("protocol_list", 8 + 8);
  const roOff = alloc("class_ro", 72);
  const metaRoOff = alloc("meta_ro", 72);
  const classOff = alloc("class", 40);
  const metaOff = alloc("metaclass", 40);
  const catOff = alloc("category", 48);
  const classlistOff = alloc("classlist", 8);
  const protolistOff = alloc("protolist", 8);
  const catlistOff = alloc("catlist", 8);
  const selrefsOff = alloc("selrefs", 16);
  const contentEnd = (cursor + 0xf) & ~0xf;
  // linkedit for fixups
  const linkeditOff = contentEnd;
  const imports = ["_OBJC_CLASS_$_NSObject", "_OBJC_METACLASS_$_NSObject"];

  const ptrSlots: Array<[number, number | { bind: number }]> = [];
  const P = (at: number, target: number | { bind: number }): void => {
    ptrSlots.push([at, target]);
  };
  // header + load commands
  b.u32(0xfeedfacf).u32(0x0100000c).u32(0).u32(2).u32(2).u32(cmdsSize).u32(0x200085).u32(0);
  b.u32(0x19)
    .u32(segCmdSize)
    .fixed("__DATA", 16)
    .u64(BASE)
    .u64(contentEnd + 0x1000)
    .u64(0)
    .u64(contentEnd + 0x1000)
    .u32(3)
    .u32(3)
    .u32(names.length)
    .u32(0);
  const sectionSpan: Record<string, [number, number]> = {
    __objc_classlist: [classlistOff, 8],
    __objc_const: [methListOff, roOff + 72 - methListOff],
    __objc_data: [classOff, 80],
    __objc_protolist: [protolistOff, 8],
    __objc_catlist: [catlistOff, 8],
    __objc_selrefs: [selrefsOff, 16],
    __objc_classname: [strOff, strBlob.length],
    __objc_methname: [strOff, strBlob.length],
    __objc_methtype: [strOff, strBlob.length],
  };
  for (const name of names) {
    const [off, size] = sectionSpan[name]!;
    b.fixed(name, 16)
      .fixed("__DATA", 16)
      .u64(BASE + off)
      .u64(size)
      .u32(off)
      .u32(3)
      .u32(0)
      .u32(0)
      .u32(0)
      .u32(0)
      .u32(0)
      .u32(0);
  }
  if (chained) b.u32(0x80000034).u32(fixupsCmdSize).u32(linkeditOff).u32(0x200);
  else
    b.u32(0x80000022)
      .u32(dyldInfoCmdSize)
      .u32(0)
      .u32(0)
      .u32(linkeditOff)
      .u32(0x100)
      .u32(0)
      .u32(0)
      .u32(0)
      .u32(0)
      .u32(0)
      .u32(0);
  b.pad(DATA);
  // write content
  b.pad(strOff).bytes(strBlob.done());
  const method = (
    listOff: number,
    index: number,
    name: string,
    types: string,
    imp: number,
  ): void => {
    const at = listOff + 8 + index * 24;
    P(at, S(name));
    P(at + 8, S(types));
    P(at + 16, BASE + imp);
  };
  b.pad(methListOff).u32(24).u32(2);
  method(methListOff, 0, "greet", "@16@0:8", 0x4000);
  method(methListOff, 1, "greet:", "v16@0:8", 0x4010);
  b.pad(classMethListOff).u32(24).u32(1);
  method(classMethListOff, 0, "shared", "@16@0:8", 0x4020);
  b.pad(catMethListOff).u32(24).u32(1);
  method(catMethListOff, 0, "wave", "v16@0:8", 0x4030);
  b.pad(protoMethListOff).u32(24).u32(1);
  method(protoMethListOff, 0, "greet", "@16@0:8", 0);
  b.pad(ivarOffVar).u32(8);
  b.pad(ivarListOff).u32(32).u32(1);
  P(ivarListOff + 8, BASE + ivarOffVar);
  P(ivarListOff + 16, S("name"));
  P(ivarListOff + 24, S('@"NSString"'));
  b.pad(ivarListOff + 32)
    .u32(3)
    .u32(8);
  b.pad(propListOff).u32(16).u32(1);
  P(propListOff + 8, S("name"));
  P(propListOff + 16, S('T@"NSString",&,N,V_name'));
  // protocol_t
  b.pad(protoOff);
  P(protoOff + 8, S("Greeting"));
  P(protoOff + 24, BASE + protoMethListOff);
  b.pad(protoOff + 64)
    .u32(96)
    .u32(0);
  // protocol list
  b.pad(protoListOff).u64(1);
  P(protoListOff + 8, BASE + protoOff);
  // class_ro_t: flags, start, size, reserved, ivarLayout, name, methods, protocols, ivars, weakIvarLayout, props
  b.pad(roOff).u32(0).u32(8).u32(16).u32(0);
  P(roOff + 24, S("Greeter"));
  P(roOff + 32, BASE + methListOff);
  P(roOff + 40, BASE + protoListOff);
  P(roOff + 48, BASE + ivarListOff);
  P(roOff + 64, BASE + propListOff);
  b.pad(metaRoOff).u32(1).u32(40).u32(40).u32(0);
  P(metaRoOff + 24, S("Greeter"));
  P(metaRoOff + 32, BASE + classMethListOff);
  // class_t: isa, superclass, cache, vtable, data
  b.pad(classOff);
  P(classOff, BASE + metaOff);
  P(classOff + 8, { bind: 0 });
  P(classOff + 32, BASE + roOff);
  b.pad(metaOff);
  P(metaOff + 8, { bind: 1 });
  P(metaOff + 32, BASE + metaRoOff);
  // category_t: name, cls, instanceMethods, classMethods, protocols, props
  b.pad(catOff);
  P(catOff, S("Extras"));
  P(catOff + 8, BASE + classOff);
  P(catOff + 16, BASE + catMethListOff);
  b.pad(classlistOff);
  P(classlistOff, BASE + classOff);
  b.pad(protolistOff);
  P(protolistOff, BASE + protoOff);
  b.pad(catlistOff);
  P(catlistOff, BASE + catOff);
  b.pad(selrefsOff);
  P(selrefsOff, S("greet"));
  P(selrefsOff + 8, S("wave"));
  b.pad(contentEnd);
  // pointer values; chained slots form one ascending chain (stride 4) with `next` links in bits 51..62
  const ordered = ptrSlots.toSorted((x, y) => x[0] - y[0]);
  ordered.forEach(([at, target], index) => {
    let value: bigint;
    if (!chained) value = typeof target === "number" ? BigInt(target) : 0n;
    else {
      const nextAt = ordered[index + 1]?.[0];
      const next = nextAt === undefined ? 0n : BigInt((nextAt - at) / 4);
      value =
        typeof target === "number" ? BigInt(target - BASE) : (1n << 63n) | BigInt(target.bind);
      value |= next << 51n;
    }
    b.patchU64(at, value);
  });
  const firstSlot = ordered[0]![0];
  if (chained) {
    // dyld_chained_fixups_header + starts (one segment, format 6) + imports (format 1) + symbols
    const h = new Builder();
    const startsOffset = 32;
    const seg = new Builder().u32(24).u16(0x4000).u16(6).u64(0).u32(0).u16(1).u16(firstSlot).done(); // one page starting at the first slot
    const starts = new Builder().u32(1).u32(8).bytes(seg).done();
    const symbols = new Builder();
    const importBlob = new Builder();
    for (const name of imports) {
      importBlob.u32((symbols.length << 9) | 1); // lib ordinal 1, name offset
      symbols.cstr(name);
    }
    const importsOffset = startsOffset + starts.length;
    const symbolsOffset = importsOffset + importBlob.length;
    h.u32(0)
      .u32(startsOffset)
      .u32(importsOffset)
      .u32(symbolsOffset)
      .u32(imports.length)
      .u32(1)
      .u32(0)
      .pad(startsOffset)
      .bytes(starts)
      .bytes(importBlob.done())
      .bytes(symbols.done());
    b.pad(linkeditOff).bytes(h.done());
  }
  if (!chained) {
    // bind stream: segment 0 + offset → symbol, for the class and metaclass superclass slots
    const binds = new Builder();
    const bindAt = (offset: number, symbol: string): void => {
      binds.u8(0x11); // SET_DYLIB_ORDINAL_IMM 1
      binds.u8(0x40).cstr(symbol); // SET_SYMBOL_TRAILING_FLAGS_IMM
      binds.u8(0x51); // SET_TYPE_IMM pointer
      binds.u8(0x70); // SET_SEGMENT_AND_OFFSET_ULEB seg 0
      uleb(binds, offset);
      binds.u8(0x90); // DO_BIND
    };
    bindAt(classOff + 8, imports[0]!);
    bindAt(metaOff + 8, imports[1]!);
    binds.u8(0x00);
    b.pad(linkeditOff).bytes(binds.done());
  }
  b.pad(contentEnd + 0x1000);
  return b.done();
}
