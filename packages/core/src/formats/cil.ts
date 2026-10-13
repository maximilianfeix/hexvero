import { createHash } from "node:crypto";
import { ByteReader } from "../binary/reader.js";
import type { Limitation } from "../model.js";

/**
 * CIL (ECMA-335 partition III) instruction decoder for method bodies: tiny and
 * fat headers, exception clauses, every one- and two-byte opcode with its
 * operand kind. Tokens are rendered as `0x06000001` and optionally resolved by
 * the caller into names. Produces a raw IL digest and a normalized tuple digest
 * (opcode, operand kind, operand) that survives re-linking.
 */

export type OperandKind =
  | "none"
  | "i8"
  | "u8"
  | "i32"
  | "i64"
  | "r32"
  | "r64"
  | "var8"
  | "var16"
  | "token"
  | "string"
  | "br8"
  | "br32"
  | "switch";

export interface CilInstruction {
  offset: number;
  opcode: string;
  operandKind: OperandKind;
  operand: string | null;
}

export interface CilBody {
  format: "tiny" | "fat";
  ilOffset: number;
  ilSize: number;
  maxStack: number;
  localsToken: string | null;
  exceptionClauses: Array<{
    kind: string;
    tryOffset: number;
    tryLength: number;
    handlerOffset: number;
    handlerLength: number;
    classToken: string | null;
    /** IL offset of the filter block for filter clauses; null otherwise. */
    filterOffset: number | null;
  }>;
  instructions: CilInstruction[];
  calls: string[];
  strings: string[];
  branches: number;
  ilSha256: string;
  normalizedSha256: string | null;
  limitations: Limitation[];
}

/** Largest IL body decoded per method (ECMA allows 4 GiB; real bodies are far below 16 MiB). */
export const MAX_IL_SIZE = 16 << 20;
const MAX_SWITCH_TARGETS = 100_000;

type Op = [name: string, operand: OperandKind];
const ONE: Record<number, Op> = {
  0x00: ["nop", "none"],
  0x01: ["break", "none"],
  0x02: ["ldarg.0", "none"],
  0x03: ["ldarg.1", "none"],
  0x04: ["ldarg.2", "none"],
  0x05: ["ldarg.3", "none"],
  0x06: ["ldloc.0", "none"],
  0x07: ["ldloc.1", "none"],
  0x08: ["ldloc.2", "none"],
  0x09: ["ldloc.3", "none"],
  0x0a: ["stloc.0", "none"],
  0x0b: ["stloc.1", "none"],
  0x0c: ["stloc.2", "none"],
  0x0d: ["stloc.3", "none"],
  0x0e: ["ldarg.s", "var8"],
  0x0f: ["ldarga.s", "var8"],
  0x10: ["starg.s", "var8"],
  0x11: ["ldloc.s", "var8"],
  0x12: ["ldloca.s", "var8"],
  0x13: ["stloc.s", "var8"],
  0x14: ["ldnull", "none"],
  0x15: ["ldc.i4.m1", "none"],
  0x16: ["ldc.i4.0", "none"],
  0x17: ["ldc.i4.1", "none"],
  0x18: ["ldc.i4.2", "none"],
  0x19: ["ldc.i4.3", "none"],
  0x1a: ["ldc.i4.4", "none"],
  0x1b: ["ldc.i4.5", "none"],
  0x1c: ["ldc.i4.6", "none"],
  0x1d: ["ldc.i4.7", "none"],
  0x1e: ["ldc.i4.8", "none"],
  0x1f: ["ldc.i4.s", "i8"],
  0x20: ["ldc.i4", "i32"],
  0x21: ["ldc.i8", "i64"],
  0x22: ["ldc.r4", "r32"],
  0x23: ["ldc.r8", "r64"],
  0x25: ["dup", "none"],
  0x26: ["pop", "none"],
  0x27: ["jmp", "token"],
  0x28: ["call", "token"],
  0x29: ["calli", "token"],
  0x2a: ["ret", "none"],
  0x2b: ["br.s", "br8"],
  0x2c: ["brfalse.s", "br8"],
  0x2d: ["brtrue.s", "br8"],
  0x2e: ["beq.s", "br8"],
  0x2f: ["bge.s", "br8"],
  0x30: ["bgt.s", "br8"],
  0x31: ["ble.s", "br8"],
  0x32: ["blt.s", "br8"],
  0x33: ["bne.un.s", "br8"],
  0x34: ["bge.un.s", "br8"],
  0x35: ["bgt.un.s", "br8"],
  0x36: ["ble.un.s", "br8"],
  0x37: ["blt.un.s", "br8"],
  0x38: ["br", "br32"],
  0x39: ["brfalse", "br32"],
  0x3a: ["brtrue", "br32"],
  0x3b: ["beq", "br32"],
  0x3c: ["bge", "br32"],
  0x3d: ["bgt", "br32"],
  0x3e: ["ble", "br32"],
  0x3f: ["blt", "br32"],
  0x40: ["bne.un", "br32"],
  0x41: ["bge.un", "br32"],
  0x42: ["bgt.un", "br32"],
  0x43: ["ble.un", "br32"],
  0x44: ["blt.un", "br32"],
  0x45: ["switch", "switch"],
  0x46: ["ldind.i1", "none"],
  0x47: ["ldind.u1", "none"],
  0x48: ["ldind.i2", "none"],
  0x49: ["ldind.u2", "none"],
  0x4a: ["ldind.i4", "none"],
  0x4b: ["ldind.u4", "none"],
  0x4c: ["ldind.i8", "none"],
  0x4d: ["ldind.i", "none"],
  0x4e: ["ldind.r4", "none"],
  0x4f: ["ldind.r8", "none"],
  0x50: ["ldind.ref", "none"],
  0x51: ["stind.ref", "none"],
  0x52: ["stind.i1", "none"],
  0x53: ["stind.i2", "none"],
  0x54: ["stind.i4", "none"],
  0x55: ["stind.i8", "none"],
  0x56: ["stind.r4", "none"],
  0x57: ["stind.r8", "none"],
  0x58: ["add", "none"],
  0x59: ["sub", "none"],
  0x5a: ["mul", "none"],
  0x5b: ["div", "none"],
  0x5c: ["div.un", "none"],
  0x5d: ["rem", "none"],
  0x5e: ["rem.un", "none"],
  0x5f: ["and", "none"],
  0x60: ["or", "none"],
  0x61: ["xor", "none"],
  0x62: ["shl", "none"],
  0x63: ["shr", "none"],
  0x64: ["shr.un", "none"],
  0x65: ["neg", "none"],
  0x66: ["not", "none"],
  0x67: ["conv.i1", "none"],
  0x68: ["conv.i2", "none"],
  0x69: ["conv.i4", "none"],
  0x6a: ["conv.i8", "none"],
  0x6b: ["conv.r4", "none"],
  0x6c: ["conv.r8", "none"],
  0x6d: ["conv.u4", "none"],
  0x6e: ["conv.u8", "none"],
  0x6f: ["callvirt", "token"],
  0x70: ["cpobj", "token"],
  0x71: ["ldobj", "token"],
  0x72: ["ldstr", "string"],
  0x73: ["newobj", "token"],
  0x74: ["castclass", "token"],
  0x75: ["isinst", "token"],
  0x76: ["conv.r.un", "none"],
  0x79: ["unbox", "token"],
  0x7a: ["throw", "none"],
  0x7b: ["ldfld", "token"],
  0x7c: ["ldflda", "token"],
  0x7d: ["stfld", "token"],
  0x7e: ["ldsfld", "token"],
  0x7f: ["ldsflda", "token"],
  0x80: ["stsfld", "token"],
  0x81: ["stobj", "token"],
  0x82: ["conv.ovf.i1.un", "none"],
  0x83: ["conv.ovf.i2.un", "none"],
  0x84: ["conv.ovf.i4.un", "none"],
  0x85: ["conv.ovf.i8.un", "none"],
  0x86: ["conv.ovf.u1.un", "none"],
  0x87: ["conv.ovf.u2.un", "none"],
  0x88: ["conv.ovf.u4.un", "none"],
  0x89: ["conv.ovf.u8.un", "none"],
  0x8a: ["conv.ovf.i.un", "none"],
  0x8b: ["conv.ovf.u.un", "none"],
  0x8c: ["box", "token"],
  0x8d: ["newarr", "token"],
  0x8e: ["ldlen", "none"],
  0x8f: ["ldelema", "token"],
  0x90: ["ldelem.i1", "none"],
  0x91: ["ldelem.u1", "none"],
  0x92: ["ldelem.i2", "none"],
  0x93: ["ldelem.u2", "none"],
  0x94: ["ldelem.i4", "none"],
  0x95: ["ldelem.u4", "none"],
  0x96: ["ldelem.i8", "none"],
  0x97: ["ldelem.i", "none"],
  0x98: ["ldelem.r4", "none"],
  0x99: ["ldelem.r8", "none"],
  0x9a: ["ldelem.ref", "none"],
  0x9b: ["stelem.i", "none"],
  0x9c: ["stelem.i1", "none"],
  0x9d: ["stelem.i2", "none"],
  0x9e: ["stelem.i4", "none"],
  0x9f: ["stelem.i8", "none"],
  0xa0: ["stelem.r4", "none"],
  0xa1: ["stelem.r8", "none"],
  0xa2: ["stelem.ref", "none"],
  0xa3: ["ldelem", "token"],
  0xa4: ["stelem", "token"],
  0xa5: ["unbox.any", "token"],
  0xb3: ["conv.ovf.i1", "none"],
  0xb4: ["conv.ovf.u1", "none"],
  0xb5: ["conv.ovf.i2", "none"],
  0xb6: ["conv.ovf.u2", "none"],
  0xb7: ["conv.ovf.i4", "none"],
  0xb8: ["conv.ovf.u4", "none"],
  0xb9: ["conv.ovf.i8", "none"],
  0xba: ["conv.ovf.u8", "none"],
  0xc2: ["refanyval", "token"],
  0xc3: ["ckfinite", "none"],
  0xc6: ["mkrefany", "token"],
  0xd0: ["ldtoken", "token"],
  0xd1: ["conv.u2", "none"],
  0xd2: ["conv.u1", "none"],
  0xd3: ["conv.i", "none"],
  0xd4: ["conv.ovf.i", "none"],
  0xd5: ["conv.ovf.u", "none"],
  0xd6: ["add.ovf", "none"],
  0xd7: ["add.ovf.un", "none"],
  0xd8: ["mul.ovf", "none"],
  0xd9: ["mul.ovf.un", "none"],
  0xda: ["sub.ovf", "none"],
  0xdb: ["sub.ovf.un", "none"],
  0xdc: ["endfinally", "none"],
  0xdd: ["leave", "br32"],
  0xde: ["leave.s", "br8"],
  0xdf: ["stind.i", "none"],
  0xe0: ["conv.u", "none"],
};
const TWO: Record<number, Op> = {
  0x00: ["arglist", "none"],
  0x01: ["ceq", "none"],
  0x02: ["cgt", "none"],
  0x03: ["cgt.un", "none"],
  0x04: ["clt", "none"],
  0x05: ["clt.un", "none"],
  0x06: ["ldftn", "token"],
  0x07: ["ldvirtftn", "token"],
  0x09: ["ldarg", "var16"],
  0x0a: ["ldarga", "var16"],
  0x0b: ["starg", "var16"],
  0x0c: ["ldloc", "var16"],
  0x0d: ["ldloca", "var16"],
  0x0e: ["stloc", "var16"],
  0x0f: ["localloc", "none"],
  0x11: ["endfilter", "none"],
  0x12: ["unaligned.", "u8"],
  0x13: ["volatile.", "none"],
  0x14: ["tail.", "none"],
  0x15: ["initobj", "token"],
  0x16: ["constrained.", "token"],
  0x17: ["cpblk", "none"],
  0x18: ["initblk", "none"],
  0x19: ["no.", "u8"],
  0x1a: ["rethrow", "none"],
  0x1c: ["sizeof", "token"],
  0x1d: ["refanytype", "none"],
  0x1e: ["readonly.", "none"],
};

const token = (v: number): string => `0x${(v >>> 0).toString(16).padStart(8, "0")}`;
const CLAUSE_KINDS: Record<number, string> = { 0: "catch", 1: "filter", 2: "finally", 4: "fault" };

export interface CilResolver {
  /** Human-readable name for a metadata token (method/field/type), or null when unknown. */
  name(tokenValue: number): string | null;
  /** #US heap string for an ldstr token (low 24 bits are the heap offset). */
  userString(tokenValue: number): string | null;
}

/** Decodes a method body located at `offset` (its header's first byte) inside `bytes`. */
export function decodeMethodBody(
  bytes: Uint8Array,
  offset: number,
  resolver?: CilResolver,
  maxInstructions = 100_000,
  maxIlBytes = MAX_IL_SIZE,
): CilBody | null {
  if (offset < 0 || offset >= bytes.length) return null;
  const limitations: Limitation[] = [];
  const first = bytes[offset]!;
  let format: CilBody["format"];
  let ilOffset: number;
  let ilSize: number;
  let maxStack = 8;
  let localsToken: string | null = null;
  let moreSections = false;
  let complete = true;
  if ((first & 0x3) === 0x2) {
    format = "tiny";
    ilSize = first >> 2;
    ilOffset = offset + 1;
  } else if ((first & 0x3) === 0x3) {
    format = "fat";
    // ECMA-335 II.25.4.3: the fat header is 12 bytes; its size field counts 4-byte units.
    if (offset + 12 > bytes.length) return null;
    const r = new ByteReader(bytes, offset, true);
    const flagsAndSize = r.u16();
    const headerSize = (flagsAndSize >> 12) * 4;
    if (headerSize < 12) return null;
    moreSections = (flagsAndSize & 0x8) !== 0;
    maxStack = r.u16();
    ilSize = r.u32();
    const locals = r.u32();
    localsToken = locals ? token(locals) : null;
    ilOffset = offset + headerSize;
    if (ilOffset > bytes.length) return null;
  } else return null;
  const ilCap = Math.max(0, Math.min(MAX_IL_SIZE, maxIlBytes));
  if (ilSize > ilCap) {
    limitations.push({
      code: "cil_body_truncated",
      message: `IL body at ${offset} claims ${ilSize} bytes; decoding is capped at ${ilCap}.`,
    });
    ilSize = ilCap;
    complete = false;
  }
  if (ilOffset + ilSize > bytes.length) {
    limitations.push({
      code: "cil_body_truncated",
      message: `IL body at ${offset} claims ${ilSize} bytes beyond the file.`,
    });
    ilSize = Math.max(0, bytes.length - ilOffset);
    complete = false;
  }
  const il = bytes.subarray(ilOffset, ilOffset + ilSize);
  const r = new ByteReader(il, 0, true);
  const instructions: CilInstruction[] = [];
  const calls: string[] = [];
  const strings: string[] = [];
  let branches = 0;
  // Normalized tuples: opcode, operand kind, and the resolved operand (name or string content) when
  // available so the digest survives re-linking and tracks string content rather than heap offsets.
  const normalized: Array<[string, OperandKind, string | null]> = [];
  try {
    while (r.offset < il.length && instructions.length < maxInstructions) {
      const start = r.offset;
      let code = r.u8();
      let op: Op | undefined;
      if (code === 0xfe) {
        code = r.u8();
        op = TWO[code];
      } else op = ONE[code];
      if (!op) {
        limitations.push({
          code: "cil_unknown_opcode",
          message: `Unknown CIL opcode 0x${code.toString(16)} at IL offset ${start}.`,
        });
        complete = false;
        break;
      }
      const [name, kind] = op;
      let operand: string | null = null;
      let canonical: string | null = null;
      switch (kind) {
        case "none":
          break;
        case "i8":
          operand = String((r.u8() << 24) >> 24);
          break;
        case "u8":
        case "var8":
          operand = String(r.u8());
          break;
        case "var16":
          operand = String(r.u16());
          break;
        case "i32":
          operand = String(r.i32());
          break;
        case "i64":
          operand = r.view.getBigInt64(r.offset, true).toString();
          r.skip(8);
          break;
        case "r32":
          operand = String(r.view.getFloat32(r.offset, true));
          r.skip(4);
          break;
        case "r64":
          operand = String(r.view.getFloat64(r.offset, true));
          r.skip(8);
          break;
        case "br8": {
          const target = r.offset + 1 + ((r.u8() << 24) >> 24);
          operand = String(target);
          branches++;
          break;
        }
        case "br32": {
          const rel = r.i32();
          operand = String(r.offset + rel);
          branches++;
          break;
        }
        case "switch": {
          const count = r.u32();
          if (count > MAX_SWITCH_TARGETS || r.offset + count * 4 > il.length)
            throw new RangeError("switch table too large");
          const base = r.offset + count * 4;
          const targets: number[] = [];
          for (let i = 0; i < count; i++) targets.push(base + r.i32());
          operand = targets.join(",");
          branches += count;
          break;
        }
        case "token":
        case "string": {
          const value = r.u32();
          operand = token(value);
          if (kind === "string") {
            const s = resolver?.userString(value) ?? null;
            if (s !== null) strings.push(s);
            canonical = s === null ? `unresolved:${operand}` : `us:${s}`;
          } else if (
            name === "call" ||
            name === "callvirt" ||
            name === "newobj" ||
            name === "ldftn" ||
            name === "jmp"
          ) {
            const resolved = resolver?.name(value);
            calls.push(resolved ?? operand);
            canonical =
              resolved === null || resolved === undefined
                ? `unresolved:${operand}`
                : `ref:${resolved}`;
          } else {
            const resolved = resolver?.name(value);
            canonical =
              resolved === null || resolved === undefined
                ? `unresolved:${operand}`
                : `ref:${resolved}`;
          }
          break;
        }
        default:
          break;
      }
      instructions.push({ offset: start, opcode: name, operandKind: kind, operand });
      normalized.push([name, kind, canonical ?? operand]);
    }
    if (r.offset < il.length && instructions.length >= maxInstructions) {
      limitations.push({
        code: "cil_truncated",
        message: `Decoding stopped after ${maxInstructions} instructions.`,
      });
      complete = false;
    }
  } catch (error) {
    limitations.push({
      code: "cil_malformed",
      message: `IL decoding failed at offset ${r.offset}: ${error instanceof Error ? error.message : String(error)}`,
    });
    complete = false;
  }

  const exceptionClauses: CilBody["exceptionClauses"] = [];
  if (moreSections) {
    let at = (ilOffset + ilSize + 3) & ~3;
    let guard = 0;
    while (at + 4 <= bytes.length && guard++ < 64) {
      const kindByte = bytes[at]!;
      const fat = (kindByte & 0x40) !== 0;
      const more = (kindByte & 0x80) !== 0;
      const size = fat
        ? bytes[at + 1]! | (bytes[at + 2]! << 8) | (bytes[at + 3]! << 16)
        : bytes[at + 1]!;
      if ((kindByte & 0x3f) === 1) {
        const clauseSize = fat ? 24 : 12;
        const count = Math.floor((size - 4) / clauseSize);
        for (let i = 0; i < Math.min(count, 1000); i++) {
          const ca = at + 4 + i * clauseSize;
          if (ca + clauseSize > bytes.length) break;
          const cr = new ByteReader(bytes, ca, true);
          const flags = fat ? cr.u32() : cr.u16();
          const tryOffset = fat ? cr.u32() : cr.u16();
          const tryLength = fat ? cr.u32() : cr.u8();
          const handlerOffset = fat ? cr.u32() : cr.u16();
          const handlerLength = fat ? cr.u32() : cr.u8();
          const classOrFilter = cr.u32();
          exceptionClauses.push({
            kind: CLAUSE_KINDS[flags] ?? `flags${flags}`,
            tryOffset,
            tryLength,
            handlerOffset,
            handlerLength,
            classToken:
              flags === 0 ? (resolver?.name(classOrFilter) ?? token(classOrFilter)) : null,
            filterOffset: flags === 1 ? classOrFilter : null,
          });
        }
      }
      if (!more) break;
      at += size;
    }
  }
  const ilSha256 = createHash("sha256").update(il).digest("hex");
  const normalizedSha256 = complete
    ? createHash("sha256").update(JSON.stringify(normalized)).digest("hex")
    : null;
  return {
    format,
    ilOffset,
    ilSize,
    maxStack,
    localsToken,
    exceptionClauses,
    instructions,
    calls,
    strings,
    branches,
    ilSha256,
    normalizedSha256,
    limitations,
  };
}
