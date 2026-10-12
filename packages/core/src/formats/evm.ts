import type { Finding, Limitation } from "../model.js";
import { AnalysisError } from "../model.js";

export interface EvmInstruction {
  offset: number;
  opcode: number;
  name: string;
  push?: string;
}

export interface EvmSelector {
  selector: string;
  /** Jump destination of the dispatch branch, when the PUSH2 preceding JUMPI was decodable. */
  target: number | null;
  offset: number;
}

export interface EvmInfo {
  byteLength: number;
  instructionCount: number;
  selectors: EvmSelector[];
  opcodeHistogram: Record<string, number>;
  usesCreate2: boolean;
  usesDelegatecall: boolean;
  usesSelfdestruct: boolean;
  metadata: {
    cborLength: number;
    ipfs: string | null;
    solc: string | null;
  } | null;
  invalidOpcodes: number;
  findings: Finding[];
  limitations: Limitation[];
}

const OPCODES: Record<number, string> = {
  0x00: "STOP",
  0x01: "ADD",
  0x02: "MUL",
  0x03: "SUB",
  0x04: "DIV",
  0x05: "SDIV",
  0x06: "MOD",
  0x07: "SMOD",
  0x08: "ADDMOD",
  0x09: "MULMOD",
  0x0a: "EXP",
  0x0b: "SIGNEXTEND",
  0x10: "LT",
  0x11: "GT",
  0x12: "SLT",
  0x13: "SGT",
  0x14: "EQ",
  0x15: "ISZERO",
  0x16: "AND",
  0x17: "OR",
  0x18: "XOR",
  0x19: "NOT",
  0x1a: "BYTE",
  0x1b: "SHL",
  0x1c: "SHR",
  0x1d: "SAR",
  0x20: "KECCAK256",
  0x30: "ADDRESS",
  0x31: "BALANCE",
  0x32: "ORIGIN",
  0x33: "CALLER",
  0x34: "CALLVALUE",
  0x35: "CALLDATALOAD",
  0x36: "CALLDATASIZE",
  0x37: "CALLDATACOPY",
  0x38: "CODESIZE",
  0x39: "CODECOPY",
  0x3a: "GASPRICE",
  0x3b: "EXTCODESIZE",
  0x3c: "EXTCODECOPY",
  0x3d: "RETURNDATASIZE",
  0x3e: "RETURNDATACOPY",
  0x3f: "EXTCODEHASH",
  0x40: "BLOCKHASH",
  0x41: "COINBASE",
  0x42: "TIMESTAMP",
  0x43: "NUMBER",
  0x44: "PREVRANDAO",
  0x45: "GASLIMIT",
  0x46: "CHAINID",
  0x47: "SELFBALANCE",
  0x48: "BASEFEE",
  0x49: "BLOBHASH",
  0x4a: "BLOBBASEFEE",
  0x50: "POP",
  0x51: "MLOAD",
  0x52: "MSTORE",
  0x53: "MSTORE8",
  0x54: "SLOAD",
  0x55: "SSTORE",
  0x56: "JUMP",
  0x57: "JUMPI",
  0x58: "PC",
  0x59: "MSIZE",
  0x5a: "GAS",
  0x5b: "JUMPDEST",
  0x5c: "TLOAD",
  0x5d: "TSTORE",
  0x5e: "MCOPY",
  0x5f: "PUSH0",
  0xa0: "LOG0",
  0xa1: "LOG1",
  0xa2: "LOG2",
  0xa3: "LOG3",
  0xa4: "LOG4",
  0xf0: "CREATE",
  0xf1: "CALL",
  0xf2: "CALLCODE",
  0xf3: "RETURN",
  0xf4: "DELEGATECALL",
  0xf5: "CREATE2",
  0xfa: "STATICCALL",
  0xfd: "REVERT",
  0xfe: "INVALID",
  0xff: "SELFDESTRUCT",
};
for (let i = 1; i <= 32; i++) OPCODES[0x5f + i] = `PUSH${i}`;
for (let i = 1; i <= 16; i++) OPCODES[0x7f + i] = `DUP${i}`;
for (let i = 1; i <= 16; i++) OPCODES[0x8f + i] = `SWAP${i}`;

/** Accepts raw bytes or ASCII hex (with or without 0x). */
export function evmBytesFrom(input: Uint8Array): Uint8Array {
  const text = new TextDecoder()
    .decode(input.subarray(0, Math.min(input.length, 4 << 20)))
    .trim();
  if (/^(0x)?[0-9a-fA-F]+$/.test(text) && text.length % 2 === 0) {
    const hexText = text.startsWith("0x") ? text.slice(2) : text;
    const out = new Uint8Array(hexText.length / 2);
    for (let i = 0; i < out.length; i++)
      out[i] = parseInt(hexText.slice(i * 2, i * 2 + 2), 16);
    return out;
  }
  return input;
}

export function disassembleEvm(
  code: Uint8Array,
  max = 200_000,
): EvmInstruction[] {
  const out: EvmInstruction[] = [];
  for (let pc = 0; pc < code.length && out.length < max; ) {
    const opcode = code[pc]!;
    const name = OPCODES[opcode] ?? "INVALID";
    const ins: EvmInstruction = { offset: pc, opcode, name };
    if (opcode >= 0x60 && opcode <= 0x7f) {
      const n = opcode - 0x5f;
      ins.push =
        "0x" +
        Buffer.from(code.subarray(pc + 1, pc + 1 + n))
          .toString("hex")
          .padStart(n * 2, "0");
      pc += 1 + n;
    } else pc += 1;
    out.push(ins);
  }
  return out;
}

/** Strips the trailing CBOR metadata block solc appends (length in the last two bytes). */
function readMetadata(code: Uint8Array): EvmInfo["metadata"] {
  if (code.length < 4) return null;
  const len = (code[code.length - 2]! << 8) | code[code.length - 1]!;
  if (len === 0 || len + 2 > code.length || len > 512) return null;
  const cbor = code.subarray(code.length - 2 - len, code.length - 2);
  if ((cbor[0]! & 0xe0) !== 0xa0) return null; // CBOR map
  const hex = Buffer.from(cbor).toString("hex");
  const ipfs = /64697066735822(1220[0-9a-f]{64})/.exec(hex);
  const solc = /736f6c6343(..)(..)(..)/.exec(hex);
  return {
    cborLength: len,
    ipfs: ipfs ? Buffer.from(ipfs[1]!, "hex").toString("hex") : null,
    solc: solc
      ? `${parseInt(solc[1]!, 16)}.${parseInt(solc[2]!, 16)}.${parseInt(solc[3]!, 16)}`
      : null,
  };
}

export function parseEvm(input: Uint8Array): EvmInfo {
  const code = evmBytesFrom(input);
  if (code.length === 0)
    throw new AnalysisError("malformed", "Empty EVM bytecode");
  const limitations: Limitation[] = [];
  const findings: Finding[] = [];
  const metadata = readMetadata(code);
  const body = metadata
    ? code.subarray(0, code.length - 2 - metadata.cborLength)
    : code;
  const instructions = disassembleEvm(body);
  if (instructions.length >= 200_000)
    limitations.push({
      code: "evm_truncated",
      message: "Disassembly stopped after 200000 instructions.",
    });

  const histogram: Record<string, number> = {};
  for (const ins of instructions)
    histogram[ins.name] = (histogram[ins.name] ?? 0) + 1;

  // Dispatch pattern: PUSH4 <sel> ... EQ ... PUSH2 <dest> JUMPI (DUP1 may sit in between)
  const selectors: EvmSelector[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < instructions.length; i++) {
    const ins = instructions[i]!;
    if (ins.name !== "PUSH4" || !ins.push) continue;
    const window = instructions.slice(i + 1, i + 6);
    const eqAt = window.findIndex((w) => w.name === "EQ");
    if (eqAt === -1) continue;
    const jumpi = window.slice(eqAt).find((w) => w.name === "JUMPI");
    if (!jumpi) continue;
    const pushTarget = window
      .slice(eqAt)
      .find(
        (w) => w.name === "PUSH2" || w.name === "PUSH1" || w.name === "PUSH3",
      );
    if (seen.has(ins.push)) continue;
    seen.add(ins.push);
    selectors.push({
      selector: ins.push,
      target: pushTarget?.push ? parseInt(pushTarget.push, 16) : null,
      offset: ins.offset,
    });
  }
  if (selectors.length === 0 && histogram["CALLDATALOAD"]) {
    limitations.push({
      code: "evm_no_dispatch",
      message:
        "No PUSH4/EQ/JUMPI dispatch found; the dispatcher may be optimized or the input may be creation code.",
    });
  }
  const invalid = histogram["INVALID"] ?? 0;
  const info: EvmInfo = {
    byteLength: code.length,
    instructionCount: instructions.length,
    selectors,
    opcodeHistogram: histogram,
    usesCreate2: Boolean(histogram["CREATE2"]),
    usesDelegatecall: Boolean(histogram["DELEGATECALL"]),
    usesSelfdestruct: Boolean(histogram["SELFDESTRUCT"]),
    metadata,
    invalidOpcodes: invalid,
    findings,
    limitations,
  };
  if (histogram["CODECOPY"] && histogram["RETURN"] && selectors.length === 0) {
    findings.push({
      kind: "evm.creation",
      title:
        "Looks like creation (deploy) code; supply the runtime bytecode for selectors",
      confidence: "inferred",
    });
  }
  if (info.usesDelegatecall)
    findings.push({
      kind: "evm.delegatecall",
      title: "Uses DELEGATECALL (proxy or library pattern)",
      confidence: "confirmed",
    });
  if (info.usesSelfdestruct)
    findings.push({
      kind: "evm.selfdestruct",
      title: "Contains SELFDESTRUCT",
      confidence: "confirmed",
    });
  if (metadata?.solc)
    findings.push({
      kind: "evm.solc",
      title: `Compiled with solc ${metadata.solc}`,
      detail: metadata.ipfs ? `ipfs ${metadata.ipfs}` : undefined,
      confidence: "confirmed",
    } as Finding);
  if (selectors.length)
    findings.push({
      kind: "evm.selectors",
      title: `${selectors.length} dispatch selectors`,
      detail: selectors
        .slice(0, 8)
        .map((s) => s.selector)
        .join(", "),
      confidence: "inferred",
    });
  return info;
}

export const EVM_OPCODES = OPCODES;
