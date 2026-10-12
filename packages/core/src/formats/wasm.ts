import { ByteReader, utf8String } from "../binary/reader.js";
import { AnalysisError, type Finding, type Limitation } from "../model.js";

export interface WasmImport {
  module: string;
  name: string;
  kind: "function" | "table" | "memory" | "global" | "tag";
  type: string;
}

export interface WasmExport {
  name: string;
  kind: "function" | "table" | "memory" | "global" | "tag";
  index: number;
  type: string;
}

export interface WasmInfo {
  version: number;
  sections: Array<{ id: number; name: string; offset: number; size: number }>;
  types: string[];
  imports: WasmImport[];
  exports: WasmExport[];
  functionCount: number;
  memories: Array<{ min: number; max: number | null; shared: boolean }>;
  tables: Array<{ elementType: string; min: number; max: number | null }>;
  globals: Array<{ type: string; mutable: boolean }>;
  start: number | null;
  dataSegments: number;
  customSections: string[];
  producers: Record<string, string[]>;
  findings: Finding[];
  limitations: Limitation[];
}

const SECTION_NAMES = [
  "custom",
  "type",
  "import",
  "function",
  "table",
  "memory",
  "global",
  "export",
  "start",
  "element",
  "code",
  "data",
  "datacount",
  "tag",
];
const VALUE_TYPES: Record<number, string> = {
  0x7f: "i32",
  0x7e: "i64",
  0x7d: "f32",
  0x7c: "f64",
  0x7b: "v128",
  0x70: "funcref",
  0x6f: "externref",
};
const KINDS: WasmImport["kind"][] = [
  "function",
  "table",
  "memory",
  "global",
  "tag",
];

export function parseWasm(bytes: Uint8Array): WasmInfo {
  if (bytes.length < 8)
    throw new AnalysisError("malformed", "WASM header truncated");
  const r = new ByteReader(bytes, 4, true);
  const version = r.u32();
  const limitations: Limitation[] = [];
  const findings: Finding[] = [];
  const info: WasmInfo = {
    version,
    sections: [],
    types: [],
    imports: [],
    exports: [],
    functionCount: 0,
    memories: [],
    tables: [],
    globals: [],
    start: null,
    dataSegments: 0,
    customSections: [],
    producers: {},
    findings,
    limitations,
  };
  if (version !== 1)
    limitations.push({
      code: "wasm_version",
      message: `Unexpected version ${version}; parsed as version 1.`,
    });

  const valType = (): string => VALUE_TYPES[r.u8()] ?? "unknown";
  const limits = (): { min: number; max: number | null; shared: boolean } => {
    const flag = r.u8();
    const min = r.uleb128();
    const max = flag & 1 ? r.uleb128() : null;
    return { min, max, shared: (flag & 2) !== 0 };
  };
  const funcType = (): string => {
    if (r.u8() !== 0x60)
      throw new AnalysisError(
        "malformed",
        "function type must start with 0x60",
      );
    const params = Array.from({ length: r.uleb128() }, valType);
    const results = Array.from({ length: r.uleb128() }, valType);
    return `(${params.join(", ")}) -> (${results.join(", ")})`;
  };
  const name = (): string => utf8String(r.bytesAt(r.uleb128()));

  const functionTypeIndices: number[] = [];
  let importedFunctions = 0;
  while (r.remaining > 0) {
    const sectionStart = r.offset;
    const id = r.u8();
    const size = r.uleb128();
    const payloadStart = r.offset;
    const end = payloadStart + size;
    if (end > bytes.length) {
      limitations.push({
        code: "wasm_section_truncated",
        message: `Section ${id} at ${sectionStart} exceeds the file.`,
      });
      break;
    }
    const sectionName = SECTION_NAMES[id] ?? `unknown(${id})`;
    info.sections.push({ id, name: sectionName, offset: sectionStart, size });
    try {
      switch (id) {
        case 0: {
          const custom = name();
          info.customSections.push(custom);
          if (custom === "producers") {
            const fields = r.uleb128();
            for (let i = 0; i < fields; i++) {
              const field = name();
              const values = Array.from({ length: r.uleb128() }, () => {
                const v = name();
                const ver = name();
                return ver ? `${v} ${ver}` : v;
              });
              info.producers[field] = values;
            }
          }
          break;
        }
        case 1:
          info.types = Array.from({ length: r.uleb128() }, funcType);
          break;
        case 2: {
          const count = r.uleb128();
          for (let i = 0; i < count; i++) {
            const module = name();
            const field = name();
            const kind = KINDS[r.u8()] ?? "function";
            let type = "";
            if (kind === "function") {
              type = info.types[r.uleb128()] ?? "?";
              importedFunctions++;
            } else if (kind === "table") {
              const et = valType();
              const l = limits();
              type = `${et}[${l.min}${l.max === null ? "" : `..${l.max}`}]`;
            } else if (kind === "memory") {
              const l = limits();
              type = `pages ${l.min}${l.max === null ? "" : `..${l.max}`}${
                l.shared ? " shared" : ""
              }`;
            } else if (kind === "global") {
              const t = valType();
              type = `${r.u8() ? "mut " : ""}${t}`;
            } else {
              r.u8();
              type = info.types[r.uleb128()] ?? "?";
            }
            info.imports.push({ module, name: field, kind, type });
          }
          break;
        }
        case 3: {
          const count = r.uleb128();
          for (let i = 0; i < count; i++) functionTypeIndices.push(r.uleb128());
          info.functionCount = count;
          break;
        }
        case 4:
          info.tables = Array.from({ length: r.uleb128() }, () => {
            const elementType = valType();
            const l = limits();
            return { elementType, min: l.min, max: l.max };
          });
          break;
        case 5:
          info.memories = Array.from({ length: r.uleb128() }, limits);
          break;
        case 6: {
          const count = r.uleb128();
          for (let i = 0; i < count; i++) {
            const type = valType();
            const mutable = r.u8() === 1;
            info.globals.push({ type, mutable });
            // skip the constant initializer expression up to 0x0b
            while (r.offset < end && r.u8() !== 0x0b);
          }
          break;
        }
        case 7: {
          const count = r.uleb128();
          for (let i = 0; i < count; i++) {
            const field = name();
            const kind = KINDS[r.u8()] ?? "function";
            const index = r.uleb128();
            let type = "";
            if (kind === "function") {
              const local = index - importedFunctions;
              type =
                local >= 0
                  ? (info.types[functionTypeIndices[local] ?? -1] ?? "?")
                  : (info.imports.filter((x) => x.kind === "function")[index]
                      ?.type ?? "?");
            }
            info.exports.push({ name: field, kind, index, type });
          }
          break;
        }
        case 8:
          info.start = r.uleb128();
          break;
        case 11:
          info.dataSegments = r.uleb128();
          break;
        default:
          break;
      }
    } catch (error) {
      limitations.push({
        code: "wasm_section_unreadable",
        message: `${sectionName}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }
    r.seek(end);
  }

  const importModules = new Set(info.imports.map((i) => i.module));
  if (
    importModules.has("wasi_snapshot_preview1") ||
    importModules.has("wasi_unstable")
  ) {
    findings.push({
      kind: "wasm.wasi",
      title: "WASI module (imports wasi_snapshot_preview1)",
      confidence: "confirmed",
    });
  }
  if (
    importModules.has("env") &&
    info.imports.some(
      (i) => i.name.startsWith("emscripten_") || i.name === "__syscall_openat",
    )
  ) {
    findings.push({
      kind: "wasm.emscripten",
      title: "Emscripten-compiled module",
      confidence: "inferred",
    });
  }
  if (info.producers["language"])
    findings.push({
      kind: "wasm.producers",
      title: `Source language: ${info.producers["language"].join(", ")}`,
      detail: info.producers["processed-by"]?.join(", "),
      confidence: "confirmed",
    });
  if (info.exports.some((e) => e.name === "__wbindgen_malloc"))
    findings.push({
      kind: "wasm.wasm-bindgen",
      title: "Rust wasm-bindgen exports",
      confidence: "confirmed",
    });
  if (info.customSections.includes("name"))
    findings.push({
      kind: "wasm.names",
      title: "Debug name section present (function names recoverable)",
      confidence: "confirmed",
    });
  if (info.memories.some((m) => m.shared))
    findings.push({
      kind: "wasm.threads",
      title: "Shared memory (threads)",
      confidence: "confirmed",
    });
  return info;
}
