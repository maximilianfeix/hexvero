import { describe, expect, it } from "vitest";
import { detectFormat } from "../src/formats/detect.js";
import { parseElf } from "../src/formats/elf.js";
import { parseMacho, parseMachoFat } from "../src/formats/macho.js";
import { parsePe } from "../src/formats/pe.js";
import { classifyString, extractStrings } from "../src/binary/strings.js";
import { analyzeBinary } from "../src/analyzers/binary.js";
import { targetFromBytes } from "../src/target.js";
import { buildElf } from "./fixtures/elf.js";
import { buildFat, buildMacho } from "./fixtures/macho.js";
import { buildPe } from "./fixtures/pe.js";

describe("detectFormat", () => {
  it("recognizes magic numbers before file names", () => {
    expect(detectFormat(buildElf(), "weird.txt")).toBe("elf");
    expect(detectFormat(buildPe(), "x")).toBe("pe");
    expect(detectFormat(buildMacho(), "x")).toBe("macho");
    expect(detectFormat(buildFat([buildMacho()]), "x")).toBe("macho-fat");
    expect(
      detectFormat(new TextEncoder().encode("SQLite format 3\0"), "a.db"),
    ).toBe("sqlite");
    expect(detectFormat(new TextEncoder().encode("0x6080604052"), "x")).toBe(
      "evm-hex",
    );
    expect(
      detectFormat(new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]), "x"),
    ).toBe("wasm");
    expect(detectFormat(new Uint8Array(), "app.js")).toBe("javascript");
  });
  it("tells Java class files from fat Mach-O", () => {
    expect(
      detectFormat(
        new Uint8Array([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 65]),
        "A.class",
      ),
    ).toBe("unknown");
  });
});

describe("parseElf", () => {
  it("reads a 64-bit little-endian shared object", () => {
    const elf = parseElf(buildElf());
    expect(elf.class).toBe(64);
    expect(elf.machine).toBe("x86-64");
    expect(elf.type).toBe("shared-object");
    expect(elf.interpreter).toBe("/lib64/ld-linux-x86-64.so.2");
    expect(elf.needed).toEqual(["libc.so.6", "libm.so.6"]);
    expect(elf.soname).toBe("libfixture.so");
    expect(elf.rpath).toEqual(["$ORIGIN/lib"]);
    expect(elf.buildId).toBe("0102030405060708");
    expect(elf.sections.map((s) => s.name)).toContain(".dynamic");
    expect(elf.symbols.map((s) => s.name)).toEqual([
      "__stack_chk_fail",
      "main",
    ]);
    expect(elf.symbols[1]).toMatchObject({
      type: "FUNC",
      binding: "GLOBAL",
      section: ".dynsym",
      size: 32,
    });
    expect(elf.mitigations).toEqual({
      nx: true,
      pie: true,
      relro: true,
      canary: true,
      fortify: false,
      stripped: true,
    });
  });
  it("reads a 32-bit big-endian file and reports an executable stack", () => {
    const elf = parseElf(buildElf({ bits: 32, little: false, nx: false }));
    expect(elf.class).toBe(32);
    expect(elf.endian).toBe("big");
    expect(elf.machine).toBe("arm");
    expect(elf.needed).toEqual(["libc.so.6", "libm.so.6"]);
    expect(elf.mitigations.nx).toBe(false);
  });
  it("rejects truncated headers", () => {
    expect(() => parseElf(buildElf().subarray(0, 40))).toThrow(/truncated/);
  });
});

describe("parsePe", () => {
  it("reads imports, exports, forwarders and hardening flags", () => {
    const pe = parsePe(buildPe());
    expect(pe.machine).toBe("x86-64");
    expect(pe.bits).toBe(64);
    expect(pe.isDll).toBe(true);
    expect(pe.subsystem).toBe("windows-gui");
    expect(pe.sections.map((s) => s.name)).toEqual([".text", ".rdata"]);
    expect(pe.imports).toEqual([
      { dll: "KERNEL32.dll", functions: ["CreateFileW", "ReadFile", "#17"] },
    ]);
    expect(pe.exports).toEqual([
      { name: "Hello", ordinal: 1, rva: "0x1100" },
      {
        name: "Forwarded",
        ordinal: 2,
        rva: expect.any(String),
        forwarder: "NTDLL.RtlZeroMemory",
      },
    ]);
    expect(pe.mitigations).toMatchObject({
      aslr: true,
      highEntropyVa: true,
      nx: true,
      cfg: false,
      gs: false,
    });
    expect(pe.isClr).toBe(false);
  });
  it("flags the CLR header", () => {
    const pe = parsePe(buildPe({ clr: true }));
    expect(pe.isClr).toBe(true);
    expect(pe.findings.map((f) => f.kind)).toContain("pe.clr");
  });
  it("rejects DOS-only files", () => {
    expect(() =>
      parsePe(new TextEncoder().encode("MZ" + "\0".repeat(100))),
    ).toThrow(/PE signature/);
  });
});

describe("parseMacho", () => {
  it("reads load commands and symbols", () => {
    const m = parseMacho(buildMacho());
    expect(m.cpu).toBe("arm64");
    expect(m.fileType).toBe("executable");
    expect(m.uuid).toBe("01020304-0506-0708-090a-0b0c0d0e0f10");
    expect(m.platform).toEqual({
      name: "macOS",
      minOs: "13.0.0",
      sdk: "14.0.0",
    });
    expect(m.entry).toBe("0x1000");
    expect(m.dylibs).toEqual([
      { path: "/usr/lib/libSystem.B.dylib", kind: "load" },
    ]);
    expect(m.segments[0]).toMatchObject({ name: "__TEXT", protection: "r-x" });
    expect(m.segments[0]!.sections[0]).toMatchObject({
      name: "__text",
      address: "0x100001000",
    });
    expect(m.symbols).toEqual([
      {
        name: "___stack_chk_fail",
        value: "0x0",
        type: "undefined",
        section: 0,
      },
      { name: "_main", value: "0x100001000", type: "external", section: 1 },
    ]);
    expect(m.mitigations).toMatchObject({ pie: true, canary: true });
    expect(parseMacho(buildMacho({ pie: false })).mitigations.pie).toBe(false);
  });
  it("enumerates fat slices", () => {
    const fat = parseMachoFat(buildFat([buildMacho(), buildMacho()]));
    expect(fat.slices.map((s) => s.cpu)).toEqual(["arm64", "x86-64"]);
    expect(fat.slices[1]!.info.dylibs).toHaveLength(1);
  });
});

describe("analyzeBinary", () => {
  it("wraps parsers in the common result model", () => {
    const result = analyzeBinary(targetFromBytes(buildElf(), "fixture.so"));
    expect(result.target.format).toBe("elf");
    expect(result.target.sha256).toHaveLength(64);
    expect(result.summary).toContain("ELF64 x86-64");
    expect(result.data.kind).toBe("elf");
  });
  it("refuses non-executables", () => {
    expect(() =>
      analyzeBinary(targetFromBytes(new Uint8Array(10), "x.bin")),
    ).toThrow(/not an executable/);
  });
});

describe("strings", () => {
  it("extracts ascii and utf16 runs and classifies them", () => {
    const text =
      "hello https://example.com/x \0\0 ab \0 p\0a\0s\0s\0w\0o\0r\0d\0=\0 ";
    const bytes = new TextEncoder().encode(text);
    const strings = extractStrings(bytes, { utf16: true });
    expect(strings.map((s) => s.value)).toContain(
      "hello https://example.com/x ",
    );
    expect(strings.find((s) => s.encoding === "utf16le")?.value).toBe(
      "password=",
    );
    expect(classifyString("https://example.com")).toEqual(["url"]);
    expect(classifyString("api_key=%s")).toEqual(["format", "secret-ish"]);
  });
});
