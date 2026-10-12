import { describe, expect, it } from "vitest";
import { disassembleEvm, evmBytesFrom, parseEvm } from "../src/formats/evm.js";
import { parseWasm } from "../src/formats/wasm.js";
import { Builder } from "./fixtures/builder.js";

function leb(b: Builder, v: number): Builder {
  while (v >= 0x80) {
    b.u8((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  return b.u8(v);
}
function section(id: number, body: Uint8Array): Uint8Array {
  const b = new Builder().u8(id);
  leb(b, body.length);
  return b.bytes(body).done();
}
function str(b: Builder, s: string): Builder {
  leb(b, s.length);
  return b.ascii(s);
}

function buildWasm(): Uint8Array {
  const out = new Builder().bytes([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]);
  // type: (i32, i32) -> (i32) and () -> ()
  const types = new Builder();
  leb(types, 2).u8(0x60);
  leb(types, 2).u8(0x7f).u8(0x7f);
  leb(types, 1).u8(0x7f);
  types.u8(0x60);
  leb(types, 0);
  leb(types, 0);
  out.bytes(section(1, types.done()));
  // import: wasi fd_write (type 0), env memory
  const imports = new Builder();
  leb(imports, 2);
  str(imports, "wasi_snapshot_preview1");
  str(imports, "fd_write");
  imports.u8(0);
  leb(imports, 0);
  str(imports, "env");
  str(imports, "memory");
  imports.u8(2).u8(1);
  leb(imports, 1);
  leb(imports, 4);
  out.bytes(section(2, imports.done()));
  // function: two local functions using type 1 and type 0
  const funcs = new Builder();
  leb(funcs, 2);
  leb(funcs, 1);
  leb(funcs, 0);
  out.bytes(section(3, funcs.done()));
  // export: _start (func index 1 → local 0 → type 1), add (func 2 → type 0), mem
  const exports = new Builder();
  leb(exports, 3);
  str(exports, "_start");
  exports.u8(0);
  leb(exports, 1);
  str(exports, "add");
  exports.u8(0);
  leb(exports, 2);
  str(exports, "memory");
  exports.u8(2);
  leb(exports, 0);
  out.bytes(section(7, exports.done()));
  // global: i32 mutable = 11 (0x0b inside the immediate), then i64 const -1
  const globals = new Builder();
  leb(globals, 2);
  globals.u8(0x7f).u8(1).u8(0x41).u8(0x0b).u8(0x0b);
  globals.u8(0x7e).u8(0).u8(0x42).u8(0x7f).u8(0x0b);
  out.bytes(section(6, globals.done()));
  // producers custom section
  const producers = new Builder();
  str(producers, "producers");
  leb(producers, 1);
  str(producers, "language");
  leb(producers, 1);
  str(producers, "Rust");
  str(producers, "");
  out.bytes(section(0, producers.done()));
  return out.done();
}

describe("parseWasm", () => {
  it("reads types, imports, exports and producers", () => {
    const w = parseWasm(buildWasm());
    expect(w.version).toBe(1);
    expect(w.types).toEqual(["(i32, i32) -> (i32)", "() -> ()"]);
    expect(w.imports).toEqual([
      {
        module: "wasi_snapshot_preview1",
        name: "fd_write",
        kind: "function",
        type: "(i32, i32) -> (i32)",
      },
      { module: "env", name: "memory", kind: "memory", type: "pages 1..4" },
    ]);
    expect(w.exports).toEqual([
      { name: "_start", kind: "function", index: 1, type: "() -> ()" },
      { name: "add", kind: "function", index: 2, type: "(i32, i32) -> (i32)" },
      { name: "memory", kind: "memory", index: 0, type: "" },
    ]);
    expect(w.producers).toEqual({ language: ["Rust"] });
    expect(w.globals).toEqual([
      { type: "i32", mutable: true },
      { type: "i64", mutable: false },
    ]);
    expect(w.findings.map((f) => f.kind)).toEqual([
      "wasm.wasi",
      "wasm.producers",
    ]);
    expect(w.sections.map((s) => s.name)).toEqual([
      "type",
      "import",
      "function",
      "export",
      "global",
      "custom",
    ]);
  });
  it("reports truncated sections instead of throwing", () => {
    const bytes = buildWasm();
    const w = parseWasm(bytes.subarray(0, bytes.length - 10));
    expect(w.limitations.some((l) => l.code === "wasm_section_truncated")).toBe(
      true,
    );
    expect(w.types).toHaveLength(2);
  });
});

describe("EVM", () => {
  // PUSH1 0 CALLDATALOAD PUSH1 0xe0 SHR DUP1 PUSH4 a9059cbb EQ PUSH2 0x0040 JUMPI DUP1 PUSH4 70a08231 EQ PUSH2 0x0050 JUMPI STOP
  const hex = "60003560e01c8063a9059cbb1461004057806370a08231146100505700f4";
  it("decodes hex input and infers dispatch selectors", () => {
    const info = parseEvm(new TextEncoder().encode("0x" + hex));
    expect(info.selectors).toEqual([
      { selector: "0xa9059cbb", target: 0x40, offset: 7 },
      { selector: "0x70a08231", target: 0x50, offset: 18 },
    ]);
    expect(info.usesDelegatecall).toBe(true);
    expect(info.findings.map((f) => f.kind)).toEqual([
      "evm.delegatecall",
      "evm.selectors",
    ]);
  });
  it("never treats PUSH payload bytes as opcodes", () => {
    const code = evmBytesFrom(new TextEncoder().encode("63a9059cbb00"));
    const ins = disassembleEvm(code);
    expect(ins.map((i) => i.name)).toEqual(["PUSH4", "STOP"]);
    expect(ins[0]!.push).toBe("0xa9059cbb");
  });
  it("strips solc CBOR metadata", () => {
    // a2 64 "ipfs" 58 22 <34 bytes> 64 "solc" 43 00 08 13  → length 0x33 = 51
    const cbor = `a2646970667358221220${"ab".repeat(32)}64736f6c6343000813`;
    const len = (cbor.length / 2).toString(16).padStart(4, "0");
    const info = parseEvm(new TextEncoder().encode(hex + cbor + len));
    expect(info.metadata).toEqual({
      cborLength: cbor.length / 2,
      ipfs: "1220" + "ab".repeat(32),
      solc: "0.8.19",
    });
    expect(info.selectors).toHaveLength(2);
  });
});
