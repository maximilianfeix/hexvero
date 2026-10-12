import { ByteReader, cstringAt, latin1 } from "../binary/reader.js";
import { AnalysisError, type Finding, type Limitation } from "../model.js";
import type { PeInfo } from "./pe.js";

export interface DotnetType {
  namespace: string;
  name: string;
  visibility: "public" | "nested" | "internal";
  kind: "class" | "interface" | "enum" | "struct" | "delegate" | "unknown";
  extends: string | null;
  methods: string[];
}

export interface DotnetPInvoke {
  dll: string;
  entryPoint: string;
  method: string;
}

export interface DotnetInfo {
  runtimeVersion: string;
  assembly: {
    name: string;
    version: string;
    culture: string;
    publicKey: boolean;
  } | null;
  entryPointToken: string | null;
  flags: { ilOnly: boolean; requires32Bit: boolean; strongNameSigned: boolean };
  streams: Array<{ name: string; offset: number; size: number }>;
  tableRows: Record<string, number>;
  assemblyRefs: Array<{ name: string; version: string }>;
  moduleRefs: string[];
  types: DotnetType[];
  pinvokes: DotnetPInvoke[];
  userStrings: string[];
  findings: Finding[];
  limitations: Limitation[];
}

type Col =
  | "u2"
  | "u4"
  | "str"
  | "guid"
  | "blob"
  | { t: number }
  | { c: string };
const T = (t: number): Col => ({ t });
const C = (c: string): Col => ({ c });

/** ECMA-335 II.22 table schemas, indexed by table number. */
const TABLES: Record<number, [name: string, cols: Col[]]> = {
  0x00: ["Module", ["u2", "str", "guid", "guid", "guid"]],
  0x01: ["TypeRef", [C("ResolutionScope"), "str", "str"]],
  0x02: ["TypeDef", ["u4", "str", "str", C("TypeDefOrRef"), T(0x04), T(0x06)]],
  0x03: ["FieldPtr", [T(0x04)]],
  0x04: ["Field", ["u2", "str", "blob"]],
  0x05: ["MethodPtr", [T(0x06)]],
  0x06: ["MethodDef", ["u4", "u2", "u2", "str", "blob", T(0x08)]],
  0x07: ["ParamPtr", [T(0x08)]],
  0x08: ["Param", ["u2", "u2", "str"]],
  0x09: ["InterfaceImpl", [T(0x02), C("TypeDefOrRef")]],
  0x0a: ["MemberRef", [C("MemberRefParent"), "str", "blob"]],
  0x0b: ["Constant", ["u2", C("HasConstant"), "blob"]],
  0x0c: [
    "CustomAttribute",
    [C("HasCustomAttribute"), C("CustomAttributeType"), "blob"],
  ],
  0x0d: ["FieldMarshal", [C("HasFieldMarshal"), "blob"]],
  0x0e: ["DeclSecurity", ["u2", C("HasDeclSecurity"), "blob"]],
  0x0f: ["ClassLayout", ["u2", "u4", T(0x02)]],
  0x10: ["FieldLayout", ["u4", T(0x04)]],
  0x11: ["StandAloneSig", ["blob"]],
  0x12: ["EventMap", [T(0x02), T(0x14)]],
  0x13: ["EventPtr", [T(0x14)]],
  0x14: ["Event", ["u2", "str", C("TypeDefOrRef")]],
  0x15: ["PropertyMap", [T(0x02), T(0x17)]],
  0x16: ["PropertyPtr", [T(0x17)]],
  0x17: ["Property", ["u2", "str", "blob"]],
  0x18: ["MethodSemantics", ["u2", T(0x06), C("HasSemantics")]],
  0x19: ["MethodImpl", [T(0x02), C("MethodDefOrRef"), C("MethodDefOrRef")]],
  0x1a: ["ModuleRef", ["str"]],
  0x1b: ["TypeSpec", ["blob"]],
  0x1c: ["ImplMap", ["u2", C("MemberForwarded"), "str", T(0x1a)]],
  0x1d: ["FieldRVA", ["u4", T(0x04)]],
  0x1e: ["EncLog", ["u4", "u4"]],
  0x1f: ["EncMap", ["u4"]],
  0x20: [
    "Assembly",
    ["u4", "u2", "u2", "u2", "u2", "u4", "blob", "str", "str"],
  ],
  0x21: ["AssemblyProcessor", ["u4"]],
  0x22: ["AssemblyOS", ["u4", "u4", "u4"]],
  0x23: [
    "AssemblyRef",
    ["u2", "u2", "u2", "u2", "u4", "blob", "str", "str", "blob"],
  ],
  0x24: ["AssemblyRefProcessor", ["u4", T(0x23)]],
  0x25: ["AssemblyRefOS", ["u4", "u4", "u4", T(0x23)]],
  0x26: ["File", ["u4", "str", "blob"]],
  0x27: ["ExportedType", ["u4", "u4", "str", "str", C("Implementation")]],
  0x28: ["ManifestResource", ["u4", "u4", "str", C("Implementation")]],
  0x29: ["NestedClass", [T(0x02), T(0x02)]],
  0x2a: ["GenericParam", ["u2", "u2", C("TypeOrMethodDef"), "str"]],
  0x2b: ["MethodSpec", [C("MethodDefOrRef"), "blob"]],
  0x2c: ["GenericParamConstraint", [T(0x2a), C("TypeDefOrRef")]],
};

/** Coded index → [tag bits, referenced tables]. -1 marks an unused tag slot. */
const CODED: Record<string, [bits: number, tables: number[]]> = {
  TypeDefOrRef: [2, [0x02, 0x01, 0x1b]],
  HasConstant: [2, [0x04, 0x08, 0x17]],
  HasCustomAttribute: [
    5,
    [
      0x06, 0x04, 0x01, 0x02, 0x08, 0x09, 0x0a, 0x00, 0x0e, 0x17, 0x14, 0x11,
      0x1a, 0x1b, 0x20, 0x23, 0x26, 0x27, 0x28, 0x2a, 0x2c, 0x2b,
    ],
  ],
  HasFieldMarshal: [1, [0x04, 0x08]],
  HasDeclSecurity: [2, [0x02, 0x06, 0x20]],
  MemberRefParent: [3, [0x02, 0x01, 0x1a, 0x06, 0x1b]],
  HasSemantics: [1, [0x14, 0x17]],
  MethodDefOrRef: [1, [0x06, 0x0a]],
  MemberForwarded: [1, [0x04, 0x06]],
  Implementation: [2, [0x26, 0x23, 0x27]],
  CustomAttributeType: [3, [-1, -1, 0x06, 0x0a, -1]],
  ResolutionScope: [2, [0x00, 0x1a, 0x23, 0x01]],
  TypeOrMethodDef: [1, [0x02, 0x06]],
};

const typeName = (ns: string, name: string): string =>
  ns ? `${ns}.${name}` : name;

interface Row {
  values: number[];
}

export function parseDotnet(bytes: Uint8Array, pe: PeInfo): DotnetInfo {
  if (pe.clrHeaderRva === null)
    throw new AnalysisError("unsupported_format", "PE has no CLR header");
  const clrOff = pe.rvaToOffset(pe.clrHeaderRva);
  if (clrOff === null || clrOff + 72 > bytes.length)
    throw new AnalysisError("malformed", "CLR header outside file");
  const limitations: Limitation[] = [];
  const findings: Finding[] = [];
  const r = new ByteReader(bytes, clrOff + 4);
  const major = r.u16();
  const minor = r.u16();
  const metaRva = r.u32();
  const metaSize = r.u32();
  const clrFlags = r.u32();
  const entryToken = r.u32();
  const metaOff = pe.rvaToOffset(metaRva);
  if (
    metaOff === null ||
    metaOff + 16 > bytes.length ||
    latin1(bytes.subarray(metaOff, metaOff + 4)) !== "BSJB"
  ) {
    throw new AnalysisError(
      "malformed",
      "Metadata root signature BSJB not found",
    );
  }
  r.seek(metaOff + 12);
  const versionLength = r.u32();
  const runtimeVersion = cstringAt(bytes, r.offset, versionLength);
  r.skip((versionLength + 3) & ~3);
  r.u16();
  const streamCount = r.u16();
  const streams: DotnetInfo["streams"] = [];
  for (let i = 0; i < streamCount && i < 16; i++) {
    const offset = r.u32();
    const size = r.u32();
    const name = cstringAt(bytes, r.offset, 32);
    r.skip((name.length + 1 + 3) & ~3);
    streams.push({ name, offset, size });
  }
  const stream = (name: string): Uint8Array | null => {
    const s = streams.find((x) => x.name === name);
    if (!s) return null;
    const start = metaOff + s.offset;
    return bytes.subarray(
      start,
      Math.min(bytes.length, start + s.size, metaOff + metaSize),
    );
  };
  const strings = stream("#Strings") ?? new Uint8Array();
  const blobs = stream("#Blob") ?? new Uint8Array();
  const us = stream("#US");
  const tables = stream("#~");
  const info: DotnetInfo = {
    runtimeVersion,
    assembly: null,
    entryPointToken: entryToken
      ? `0x${entryToken.toString(16).padStart(8, "0")}`
      : null,
    flags: {
      ilOnly: (clrFlags & 1) !== 0,
      requires32Bit: (clrFlags & 2) !== 0,
      strongNameSigned: (clrFlags & 8) !== 0,
    },
    streams,
    tableRows: {},
    assemblyRefs: [],
    moduleRefs: [],
    types: [],
    pinvokes: [],
    userStrings: us ? readUserStrings(us) : [],
    findings,
    limitations,
  };
  if (!tables) {
    limitations.push({
      code: "dotnet_uncompressed_tables",
      message: stream("#-")
        ? "Uncompressed #- metadata (edit-and-continue) is not supported."
        : "No #~ stream.",
    });
    return info;
  }

  // #~ header
  const tr = new ByteReader(tables, 6);
  const heapSizes = tr.u8();
  tr.u8();
  const valid = tr.u64();
  tr.u64(); // sorted
  const rows: number[] = Array.from({ length: 64 }, () => 0);
  for (let i = 0; i < 64; i++)
    if (valid & (1n << BigInt(i))) rows[i] = tr.u32();
  for (let i = 0x2d; i < 64; i++) {
    if (rows[i])
      limitations.push({
        code: "dotnet_unknown_table",
        message: `Table 0x${i.toString(16)} is present but not modeled; later tables were skipped.`,
      });
  }
  const strIdx = heapSizes & 1 ? 4 : 2;
  const guidIdx = heapSizes & 2 ? 4 : 2;
  const blobIdx = heapSizes & 4 ? 4 : 2;
  const colSize = (c: Col): number => {
    if (c === "u2") return 2;
    if (c === "u4") return 4;
    if (c === "str") return strIdx;
    if (c === "guid") return guidIdx;
    if (c === "blob") return blobIdx;
    if ("t" in c) return rows[c.t]! < 65536 ? 2 : 4;
    const [bits, refs] = CODED[c.c]!;
    const maxRows = Math.max(...refs.map((t) => (t < 0 ? 0 : rows[t]!)));
    return maxRows < 1 << (16 - bits) ? 2 : 4;
  };
  const data: Record<number, Row[]> = {};
  for (let t = 0; t <= 0x2c; t++) {
    const count = rows[t]!;
    if (!count) continue;
    const schema = TABLES[t]![1];
    const sizes = schema.map(colSize);
    const rowSize = sizes.reduce((a, b) => a + b, 0);
    if (tr.offset + rowSize * count > tables.length) {
      limitations.push({
        code: "dotnet_tables_truncated",
        message: `${TABLES[t]![0]} table runs past the #~ stream.`,
      });
      break;
    }
    const list: Row[] = [];
    const keep = count <= 200_000;
    for (let i = 0; i < count; i++) {
      const values: number[] = [];
      for (const size of sizes) values.push(size === 2 ? tr.u16() : tr.u32());
      if (keep) list.push({ values });
    }
    if (!keep)
      limitations.push({
        code: "dotnet_table_too_large",
        message: `${TABLES[t]![0]} has ${count} rows; skipped.`,
      });
    data[t] = list;
    info.tableRows[TABLES[t]![0]] = count;
  }

  const str = (index: number): string => cstringAt(strings, index);

  for (const row of data[0x20] ?? []) {
    const v = row.values;
    info.assembly = {
      name: str(v[7]!),
      version: `${v[1]}.${v[2]}.${v[3]}.${v[4]}`,
      culture: str(v[8]!),
      publicKey: v[6]! !== 0,
    };
  }
  for (const row of data[0x23] ?? []) {
    const v = row.values;
    info.assemblyRefs.push({
      name: str(v[6]!),
      version: `${v[0]}.${v[1]}.${v[2]}.${v[3]}`,
    });
  }
  for (const row of data[0x1a] ?? []) info.moduleRefs.push(str(row.values[0]!));

  const methods = data[0x06] ?? [];
  const typeRefs = data[0x01] ?? [];
  const typeDefs = data[0x02] ?? [];
  const resolveTypeDefOrRef = (coded: number): string | null => {
    const tag = coded & 3;
    const index = coded >> 2;
    if (index === 0) return null;
    if (tag === 0) {
      const t = typeDefs[index - 1];
      return t ? typeName(str(t.values[2]!), str(t.values[1]!)) : null;
    }
    if (tag === 1) {
      const t = typeRefs[index - 1];
      return t ? typeName(str(t.values[2]!), str(t.values[1]!)) : null;
    }
    return "<TypeSpec>";
  };
  for (let i = 0; i < typeDefs.length; i++) {
    const v = typeDefs[i]!.values;
    const flags = v[0]!;
    const name = str(v[1]!);
    const ns = str(v[2]!);
    const base = resolveTypeDefOrRef(v[3]!);
    const first = v[5]! - 1;
    const last = (typeDefs[i + 1]?.values[5] ?? methods.length + 1) - 1;
    const vis = flags & 7;
    const kind: DotnetType["kind"] =
      flags & 0x20
        ? "interface"
        : base === "System.Enum"
          ? "enum"
          : base === "System.ValueType"
            ? "struct"
            : base === "System.MulticastDelegate"
              ? "delegate"
              : base !== null || name === "<Module>"
                ? "class"
                : "unknown";
    info.types.push({
      namespace: ns,
      name,
      visibility: vis === 1 ? "public" : vis >= 2 ? "nested" : "internal",
      kind,
      extends: base,
      methods: methods
        .slice(Math.max(0, first), Math.max(first, last))
        .map((m) => str(m.values[3]!)),
    });
  }

  for (const row of data[0x1c] ?? []) {
    const v = row.values;
    const forwarded = v[1]!;
    const method = forwarded & 1 ? methods[(forwarded >> 1) - 1] : undefined;
    const moduleRef = data[0x1a]?.[v[3]! - 1];
    info.pinvokes.push({
      dll: moduleRef ? str(moduleRef.values[0]!) : "?",
      entryPoint: str(v[2]!),
      method: method ? str(method.values[3]!) : "?",
    });
  }

  if (info.pinvokes.length)
    findings.push({
      kind: "dotnet.pinvoke",
      title: `${info.pinvokes.length} P/Invoke declarations into ${new Set(info.pinvokes.map((p) => p.dll)).size} native libraries`,
      confidence: "confirmed",
    });
  const shortNames = info.types.filter(
    (t) => t.name.length <= 2 || /[^\x20-\x7e]/.test(t.name),
  ).length;
  if (info.types.length > 10 && shortNames / info.types.length > 0.5) {
    findings.push({
      kind: "dotnet.obfuscated",
      title:
        "Most type names are one or two characters or non-ASCII (obfuscated)",
      confidence: "inferred",
    });
  }
  if (!info.flags.ilOnly)
    findings.push({
      kind: "dotnet.mixed",
      title: "Mixed-mode assembly (contains native code)",
      confidence: "confirmed",
    });
  if (major !== 2 || minor !== 5)
    limitations.push({
      code: "dotnet_clr_version",
      message: `Unexpected CLR header version ${major}.${minor}.`,
    });
  if (blobs.length === 0)
    limitations.push({
      code: "dotnet_no_blob",
      message: "No #Blob heap; signatures unavailable.",
    });
  return info;
}

/** #US heap: blob-length-prefixed UTF-16LE strings with a trailing flag byte. */
function readUserStrings(us: Uint8Array, max = 5000): string[] {
  const out: string[] = [];
  let at = 1;
  while (at < us.length && out.length < max) {
    const first = us[at]!;
    let len: number;
    let header: number;
    if ((first & 0x80) === 0) {
      len = first;
      header = 1;
    } else if ((first & 0xc0) === 0x80) {
      len = ((first & 0x3f) << 8) | us[at + 1]!;
      header = 2;
    } else {
      len =
        ((first & 0x1f) << 24) |
        (us[at + 1]! << 16) |
        (us[at + 2]! << 8) |
        us[at + 3]!;
      header = 4;
    }
    const start = at + header;
    if (len === 0 || start + len > us.length) {
      at = start + Math.max(len, 1);
      continue;
    }
    const chars = us.subarray(start, start + len - 1);
    let s = "";
    for (let i = 0; i + 1 < chars.length; i += 2)
      s += String.fromCharCode(chars[i]! | (chars[i + 1]! << 8));
    if (s.trim()) out.push(s);
    at = start + len;
  }
  return out;
}
