import { describe, expect, it } from "vitest";
import { analyzeBinary } from "../src/analyzers/binary.js";
import { parsePe } from "../src/formats/pe.js";
import { readVersionInfo } from "../src/formats/peResources.js";
import { detectToolchain } from "../src/formats/toolchain.js";
import { targetFromBytes } from "../src/target.js";
import { Builder } from "./fixtures/builder.js";
import { buildElf } from "./fixtures/elf.js";
import { buildPe } from "./fixtures/pe.js";

const text = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("detectToolchain", () => {
  it("reads compiler, Rust, DWARF and build paths", () => {
    const facts = detectToolchain(
      text(
        "junk /rustc/0123456789abcdef0123456789abcdef01234567/library/core/src/panicking.rs /home/dev/project/src/main.rs",
      ),
      {
        comment: "GCC: (Ubuntu 13.2.0-23ubuntu4) 13.2.0",
        sectionNames: [".text", ".debug_info", ".comment"],
        symbolNames: ["_ZN4core9panicking5panic17h0123456789abcdefE"],
        libraries: ["libc.so.6"],
      },
    );
    expect(facts.compiler).toBe("GCC: (Ubuntu 13.2.0-23ubuntu4) 13.2.0");
    expect(facts.rust).toBe("commit 012345678");
    expect(facts.debugInfo).toBe(true);
    expect(facts.findings.map((f) => `${f.kind}:${f.confidence}`)).toEqual([
      "toolchain.compiler:confirmed",
      "toolchain.rust:confirmed",
      "toolchain.dwarf:confirmed",
      "toolchain.build-path:confirmed",
    ]);
    expect(facts.findings[3]?.detail).toBe("/home/dev/project/src/main.rs");
  });
  it("detects clang from strings and Swift/ObjC from Mach-O sections", () => {
    const facts = detectToolchain(text("Apple clang version 16.0.0 (clang-1600.0.26.3)"), {
      sectionNames: ["__TEXT", "__text", "__objc_classlist", "__swift5_typeref"],
      symbolNames: [],
      libraries: ["/usr/lib/swift/libswiftCore.dylib"],
    });
    expect(facts.compiler).toBe("Apple clang version 16.0.0");
    expect(facts.swift).toBe(true);
    expect(facts.objc).toBe(true);
    expect(facts.findings[0]?.confidence).toBe("inferred");
  });
  it("is attached to ELF analyses", () => {
    const result = analyzeBinary(targetFromBytes(buildElf(), "lib.so"));
    expect(result.data.kind === "elf" && result.data.toolchain?.debugInfo).toBe(false);
  });
});

const w = (b: Builder, s: string): Builder => {
  for (const c of s) b.u16(c.charCodeAt(0));
  return b.u16(0);
};

/** Builds a VS_VERSIONINFO block with a fixed-file-info header and two strings. */
function buildVersionBlock(): Uint8Array {
  const str = (key: string, value: string): Uint8Array => {
    const b = new Builder();
    b.u16(0)
      .u16(value.length + 1)
      .u16(1);
    w(b, key).align(4);
    w(b, value).align(4);
    const out = b.done();
    new DataView(out.buffer).setUint16(0, out.length, true);
    return out;
  };
  const table = new Builder().u16(0).u16(0).u16(1);
  w(table, "040904b0").align(4);
  table.bytes(str("CompanyName", "Example Corp")).bytes(str("ProductName", "Example Tool"));
  const tableBytes = table.done();
  new DataView(tableBytes.buffer).setUint16(0, tableBytes.length, true);
  const sfi = new Builder().u16(0).u16(0).u16(1);
  w(sfi, "StringFileInfo").align(4);
  sfi.bytes(tableBytes);
  const sfiBytes = sfi.done();
  new DataView(sfiBytes.buffer).setUint16(0, sfiBytes.length, true);
  const root = new Builder().u16(0).u16(52).u16(0);
  w(root, "VS_VERSION_INFO").align(4);
  root.u32(0xfeef04bd).u32(0x10000).u32(0x00010002).u32(0x00030004).u32(0x00050006).u32(0x00070008);
  for (let i = 0; i < 7; i++) root.u32(0);
  root.align(4).bytes(sfiBytes);
  const out = root.done();
  new DataView(out.buffer).setUint16(0, out.length, true);
  return out;
}

/** Resource directory: type RT_VERSION → name 1 → lang → data entry pointing at the version block. */
function buildResources(rvaBase: number): Uint8Array {
  const b = new Builder();
  const dir = (count: number): void => b.u32(0).u32(0).u16(0).u16(0).u16(0).u16(count);
  dir(1);
  b.u32(16).u32(0x80000000 | 24); // RT_VERSION → subdir at 24
  dir(1);
  b.u32(1).u32(0x80000000 | 48); // name 1 → subdir at 48
  dir(1);
  b.u32(0x409).u32(72); // lang → data entry at 72
  b.u32(rvaBase + 88)
    .u32(0)
    .u32(0)
    .u32(0); // data entry: rva, size (patched), codepage, reserved
  b.pad(88);
  const block = buildVersionBlock();
  b.bytes(block);
  const out = b.done();
  new DataView(out.buffer).setUint32(76, block.length, true);
  return out;
}

describe("readVersionInfo", () => {
  it("decodes fixed version numbers and StringFileInfo", () => {
    const resources = buildResources(0x2500);
    const bytes = buildPe({ resources });
    const pe = parsePe(bytes);
    const info = readVersionInfo(bytes, pe);
    expect(info).toEqual({
      fileVersion: "1.2.3.4",
      productVersion: "5.6.7.8",
      strings: { CompanyName: "Example Corp", ProductName: "Example Tool" },
    });
    const result = analyzeBinary(targetFromBytes(bytes, "tool.dll"));
    expect(result.findings.find((f) => f.kind === "pe.version-info")).toMatchObject({
      title: "Example Tool 1.2.3.4",
      detail: "Example Corp",
    });
  });
});
