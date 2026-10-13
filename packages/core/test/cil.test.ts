import { describe, expect, it } from "vitest";
import { decodeMethodBody } from "../src/formats/cil.js";
import { parseDotnet } from "../src/formats/dotnet.js";
import { parsePe } from "../src/formats/pe.js";
import { Builder } from "./fixtures/builder.js";
import { buildDotnetMetadata } from "./fixtures/dotnet.js";
import { buildPe } from "./fixtures/pe.js";

// Main: ldstr "Hello"; call Bar.Foo::Run; ret  (tiny header)
const mainIl = new Builder().u8(0x72).u32(0x70000001).u8(0x28).u32(0x06000002).u8(0x2a).done();
const mainBody = new Builder()
  .u8((mainIl.length << 2) | 0x2)
  .bytes(mainIl)
  .done();
// Run: fat header with one catch clause; body: nop; br.s +0; ldc.i4 7; pop; ret
const runIl = new Builder().u8(0x00).u8(0x2b).u8(0x00).u8(0x20).u32(7).u8(0x26).u8(0x2a).done();
const runBody = (() => {
  const b = new Builder();
  b.u16(0x3003 | 0x8)
    .u16(2)
    .u32(runIl.length)
    .u32(0x11000001)
    .bytes(runIl); // flags: fat (0x3), header size 3*4, more sections (0x8)
  b.align(4);
  b.u8(0x01)
    .u8(4 + 12)
    .u16(0); // small exception section: kind 1, size 16
  b.u16(0).u16(0).u8(runIl.length).u16(0).u8(1).u32(0x01000001); // catch: try 0..len, handler, class System.Object (TypeRef#1)
  return b.done();
})();

const wrap = (il: Uint8Array): Uint8Array =>
  new Builder()
    .u8((il.length << 2) | 0x2)
    .bytes(il)
    .done();
// ldc.i4.0; switch (a, b); ret; ret
const sw = (a: number, b: number): Uint8Array =>
  new Builder().u8(0x16).u8(0x45).u32(2).u32(a).u32(b).u8(0x2a).u8(0x2a).done();
// ldstr <strTok>; call <callTok>; ret
const il = (strTok: number, callTok: number): Uint8Array =>
  new Builder()
    .u8((11 << 2) | 0x2)
    .u8(0x72)
    .u32(strTok)
    .u8(0x28)
    .u32(callTok)
    .u8(0x2a)
    .done();
const resolver = (hello: string) => ({
  name: (t: number) => (t === 0x06000002 || t === 0x0a000005 ? "Bar.Foo::Run" : null),
  userString: (t: number) => (t === 0x70000001 || t === 0x70000009 ? hello : null),
});

describe("decodeMethodBody", () => {
  it("decodes tiny bodies with token resolution", () => {
    const body = decodeMethodBody(mainBody, 0, {
      name: (t) => (t === 0x06000002 ? "Bar.Foo::Run" : null),
      userString: (t) => (t === 0x70000001 ? "Hello" : null),
    })!;
    expect(body.format).toBe("tiny");
    expect(
      body.instructions.map((i) => `${i.offset}:${i.opcode}${i.operand ? ` ${i.operand}` : ""}`),
    ).toEqual(["0:ldstr 0x70000001", "5:call 0x06000002", "10:ret"]);
    expect(body.calls).toEqual(["Bar.Foo::Run"]);
    expect(body.strings).toEqual(["Hello"]);
    expect(body.normalizedSha256).toHaveLength(64);
  });
  it("decodes fat bodies with exception clauses and branch targets", () => {
    const body = decodeMethodBody(runBody, 0)!;
    expect(body.format).toBe("fat");
    expect(body.maxStack).toBe(2);
    expect(body.localsToken).toBe("0x11000001");
    expect(body.instructions.map((i) => i.opcode)).toEqual(["nop", "br.s", "ldc.i4", "pop", "ret"]);
    expect(body.instructions[1]).toMatchObject({ operandKind: "br8", operand: "3" });
    expect(body.branches).toBe(1);
    expect(body.exceptionClauses).toEqual([
      {
        kind: "catch",
        tryOffset: 0,
        tryLength: runIl.length,
        handlerOffset: 0,
        handlerLength: 1,
        classToken: "0x01000001",
        filterOffset: null,
      },
    ]);
  });
  it("rejects truncated headers without throwing and marks clipped bodies incomplete", () => {
    expect(decodeMethodBody(new Uint8Array([0x03]), 0)).toBeNull(); // fat marker, no header
    expect(decodeMethodBody(new Uint8Array([0x03, 0x30, 0, 0, 1, 0, 0, 0]), 0)).toBeNull();
    const clipped = decodeMethodBody(new Uint8Array([0x0a, 0x2a]), 0)!; // tiny, claims 2 bytes, has 1
    expect(clipped.limitations[0]?.code).toBe("cil_body_truncated");
    expect(clipped.instructions.map((i) => i.opcode)).toEqual(["ret"]);
    expect(clipped.normalizedSha256).toBeNull();
    const capped = decodeMethodBody(mainBody, 0, undefined, 100_000, 4)!;
    expect(capped.ilSize).toBe(4);
    expect(capped.normalizedSha256).toBeNull();
  });
  it("decodes every switch target so differing tables hash differently", () => {
    const one = decodeMethodBody(wrap(sw(0, 1)), 0)!;
    const two = decodeMethodBody(wrap(sw(1, 0)), 0)!;
    expect(one.instructions[1]).toMatchObject({ operandKind: "switch", operand: "14,15" });
    expect(one.branches).toBe(2);
    expect(one.normalizedSha256).not.toBe(two.normalizedSha256);
    const overflow = decodeMethodBody(wrap(new Builder().u8(0x45).u32(0xffff).u8(0x2a).done()), 0)!;
    expect(overflow.limitations[0]?.code).toBe("cil_malformed");
    expect(overflow.normalizedSha256).toBeNull();
  });
  it("normalizes over resolved operands, not raw tokens or heap offsets", () => {
    const a = decodeMethodBody(il(0x70000001, 0x06000002), 0, resolver("Hello"))!;
    const relinked = decodeMethodBody(il(0x70000009, 0x0a000005), 0, resolver("Hello"))!;
    const changed = decodeMethodBody(il(0x70000001, 0x06000002), 0, resolver("Bye"))!;
    expect(a.ilSha256).not.toBe(relinked.ilSha256);
    expect(a.normalizedSha256).toBe(relinked.normalizedSha256);
    expect(a.normalizedSha256).not.toBe(changed.normalizedSha256);
    const unresolved = decodeMethodBody(il(0x70000001, 0x06000002), 0)!;
    expect(unresolved.normalizedSha256).not.toBe(a.normalizedSha256);
  });
  it("exposes filter offsets on filter clauses", () => {
    const b = new Builder();
    const nopRet = new Builder().u8(0x00).u8(0x2a).done();
    b.u16(0x3003 | 0x8)
      .u16(1)
      .u32(nopRet.length)
      .u32(0)
      .bytes(nopRet);
    b.align(4);
    b.u8(0x01).u8(16).u16(0);
    b.u16(1).u16(0).u8(1).u16(1).u8(1).u32(0x40); // filter clause, filter block at IL offset 0x40
    const body = decodeMethodBody(b.done(), 0)!;
    expect(body.exceptionClauses[0]).toMatchObject({
      kind: "filter",
      classToken: null,
      filterOffset: 0x40,
    });
  });
  it("reports unknown opcodes and truncation as limitations", () => {
    const bad = decodeMethodBody(
      new Builder()
        .u8((3 << 2) | 0x2)
        .u8(0xfe)
        .u8(0x7f)
        .u8(0x2a)
        .done(),
      0,
    )!;
    expect(bad.limitations[0]?.code).toBe("cil_unknown_opcode");
    expect(bad.normalizedSha256).toBeNull();
    expect(decodeMethodBody(new Uint8Array([0x00]), 0)).toBeNull();
  });
  it("attaches decoded bodies to .NET types", () => {
    const bytes = buildPe({
      clr: buildDotnetMetadata(),
      bodies: [
        { fileOffset: 0x700, bytes: mainBody },
        { fileOffset: 0x740, bytes: runBody },
      ],
    });
    const info = parseDotnet(bytes, parsePe(bytes));
    const foo = info.types[1]!;
    expect(foo.members.map((m) => `${m.name}:${m.flags.join("|")}`)).toEqual([
      "Main:public|static",
      "Run:public|static|pinvoke",
    ]);
    expect(foo.members[0]!.il).toMatchObject({
      size: 11,
      instructions: 3,
      calls: ["Bar.Foo::Run"],
      strings: ["Hello"],
      exceptionClauses: 0,
    });
    expect(foo.members[1]!.il).toBeNull(); // P/Invoke methods have no IL
    expect(info.instructions.map((i) => `${i.method} ${i.opcode}`)).toEqual([
      "Bar.Foo::Main ldstr",
      "Bar.Foo::Main call",
      "Bar.Foo::Main ret",
    ]);
  });
  it("bounds forged MethodList ranges to the retained MethodDef table", () => {
    const metadata = buildDotnetMetadata();
    // The second TypeDef row's MethodList (u16) is the last field of the row; forge it to 0xffff.
    const needle = new Builder().u32(0x100001).done();
    let at = -1;
    for (let i = 0; i + 4 <= metadata.length; i++) {
      if (
        metadata[i] === needle[0] &&
        metadata[i + 1] === needle[1] &&
        metadata[i + 2] === needle[2] &&
        metadata[i + 3] === needle[3]
      ) {
        at = i;
        break;
      }
    }
    expect(at).toBeGreaterThan(0);
    const forged = new Uint8Array(metadata);
    forged[at + 4 + 2 + 2 + 2 + 2] = 0xff; // flags(4) name(2) ns(2) extends(2) fieldList(2) -> methodList
    forged[at + 4 + 2 + 2 + 2 + 2 + 1] = 0xff;
    const bytes = buildPe({ clr: forged });
    const info = parseDotnet(bytes, parsePe(bytes)!)!;
    const foo = info.types.find((t) => t.name === "Foo")!;
    expect(foo.members).toEqual([]);
    expect(info.types[0]!.members.map((m) => m.name)).toEqual(["Main", "Run"]);
  });
});
