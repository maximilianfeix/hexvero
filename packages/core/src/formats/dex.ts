import { ByteReader, latin1 } from "../binary/reader.js";
import { AnalysisError, type Finding, type Limitation } from "../model.js";

export interface DexClass {
  name: string;
  superClass: string | null;
  flags: string[];
  sourceFile: string | null;
}

export interface DexInfo {
  version: string;
  counts: {
    strings: number;
    types: number;
    protos: number;
    fields: number;
    methods: number;
    classes: number;
  };
  classes: DexClass[];
  packages: Array<{ name: string; classes: number }>;
  strings: string[];
  findings: Finding[];
  limitations: Limitation[];
}

const ACCESS: Array<[number, string]> = [
  [0x1, "public"],
  [0x10, "final"],
  [0x200, "interface"],
  [0x400, "abstract"],
  [0x1000, "synthetic"],
  [0x2000, "annotation"],
  [0x4000, "enum"],
];

/** Converts a JVM type descriptor like `Lcom/example/Foo;` into `com.example.Foo`. */
export const descriptorToName = (d: string): string =>
  d.startsWith("L") && d.endsWith(";") ? d.slice(1, -1).replace(/\//g, ".") : d;

/** Reads a DEX file header, string/type tables and class definitions. Code is not decoded. */
export function parseDex(
  bytes: Uint8Array,
  options: { maxClasses?: number; maxStrings?: number } = {},
): DexInfo {
  if (bytes.length < 0x70 || latin1(bytes.subarray(0, 4)) !== "dex\n")
    throw new AnalysisError("malformed", "not a DEX file");
  const version = latin1(bytes.subarray(4, 7));
  const r = new ByteReader(bytes, 0x28, true);
  const endianTag = r.u32();
  if (endianTag === 0x78563412)
    throw new AnalysisError("unsupported_format", "big-endian DEX is not supported");
  r.seek(0x38);
  const stringsSize = r.u32();
  const stringsOff = r.u32();
  const typesSize = r.u32();
  const typesOff = r.u32();
  const protosSize = r.u32();
  r.u32();
  const fieldsSize = r.u32();
  r.u32();
  const methodsSize = r.u32();
  r.u32();
  const classesSize = r.u32();
  const classesOff = r.u32();
  const limitations: Limitation[] = [];
  const findings: Finding[] = [];
  const maxStrings = options.maxStrings ?? 20_000;
  const maxClasses = options.maxClasses ?? 20_000;

  const readString = (index: number): string => {
    const at = stringsOff + index * 4;
    if (index >= stringsSize || at + 4 > bytes.length) return "";
    const off = new ByteReader(bytes, at, true).u32();
    if (off >= bytes.length) return "";
    const sr = new ByteReader(bytes, off, true);
    const utf16Length = sr.uleb128();
    const start = sr.offset;
    let end = start;
    while (end < bytes.length && bytes[end] !== 0 && end - start < utf16Length * 3) end++;
    return mutf8(bytes.subarray(start, end));
  };
  const typeName = (index: number): string => {
    const at = typesOff + index * 4;
    if (index >= typesSize || at + 4 > bytes.length) return "";
    return descriptorToName(readString(new ByteReader(bytes, at, true).u32()));
  };

  const classes: DexClass[] = [];
  const packages = new Map<string, number>();
  const count = Math.min(classesSize, maxClasses);
  for (let i = 0; i < count; i++) {
    const at = classesOff + i * 32;
    if (at + 32 > bytes.length) {
      limitations.push({
        code: "dex_classes_truncated",
        message: "class_defs run past the end of the file",
      });
      break;
    }
    const cr = new ByteReader(bytes, at, true);
    const name = typeName(cr.u32());
    const flags = cr.u32();
    const superIdx = cr.u32();
    cr.u32();
    const sourceIdx = cr.u32();
    const pkg = name.includes(".") ? name.slice(0, name.lastIndexOf(".")) : "(default)";
    packages.set(pkg, (packages.get(pkg) ?? 0) + 1);
    classes.push({
      name,
      superClass: superIdx === 0xffffffff ? null : typeName(superIdx),
      flags: ACCESS.filter(([bit]) => flags & bit).map(([, n]) => n),
      sourceFile: sourceIdx === 0xffffffff ? null : readString(sourceIdx),
    });
  }
  if (classesSize > maxClasses)
    limitations.push({
      code: "dex_classes_limited",
      message: `Listed ${maxClasses} of ${classesSize} classes.`,
    });
  const strings: string[] = [];
  for (let i = 0; i < Math.min(stringsSize, maxStrings); i++) strings.push(readString(i));
  if (stringsSize > maxStrings)
    limitations.push({
      code: "dex_strings_limited",
      message: `Listed ${maxStrings} of ${stringsSize} strings.`,
    });

  const urls = strings.filter((s) => /^https?:\/\//.test(s));
  if (urls.length)
    findings.push({
      kind: "dex.urls",
      title: `${urls.length} URL constants`,
      detail: urls.slice(0, 5).join(", "),
      confidence: "confirmed",
    });
  const obfuscated = classes.filter((c) => /(^|\.)[a-z]{1,2}$/.test(c.name)).length;
  if (classes.length > 20 && obfuscated / classes.length > 0.4)
    findings.push({
      kind: "dex.obfuscated",
      title: "Most class names are one or two letters (ProGuard/R8)",
      confidence: "inferred",
    });
  const packageList = [...packages]
    .map(([name, n]) => ({ name, classes: n }))
    .toSorted((a, b) => b.classes - a.classes);
  const sdks = packageList
    .map((p) => p.name)
    .filter((n) =>
      /^(com\.google\.firebase|com\.facebook|com\.unity3d|io\.flutter|com\.crashlytics|com\.appsflyer|com\.adjust|com\.onesignal|com\.stripe|com\.braintree)/.test(
        n,
      ),
    );
  if (sdks.length)
    findings.push({
      kind: "dex.sdks",
      title: "Third-party SDKs",
      detail: [...new Set(sdks.map((s) => s.split(".").slice(0, 3).join(".")))].join(", "),
      confidence: "inferred",
    });
  return {
    version,
    counts: {
      strings: stringsSize,
      types: typesSize,
      protos: protosSize,
      fields: fieldsSize,
      methods: methodsSize,
      classes: classesSize,
    },
    classes,
    packages: packageList,
    strings,
    findings,
    limitations,
  };
}

/** Modified UTF-8 as used by the JVM and DEX: NUL is encoded as C0 80, supplementary chars as surrogate pairs. */
function mutf8(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length;) {
    const b = bytes[i]!;
    if (b < 0x80) {
      out += String.fromCharCode(b);
      i++;
    } else if ((b & 0xe0) === 0xc0) {
      out += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i + 1]! & 0x3f));
      i += 2;
    } else if ((b & 0xf0) === 0xe0) {
      out += String.fromCharCode(
        ((b & 0x0f) << 12) | ((bytes[i + 1]! & 0x3f) << 6) | (bytes[i + 2]! & 0x3f),
      );
      i += 3;
    } else {
      out += "�";
      i++;
    }
  }
  return out;
}
