import { ByteReader, utf8String } from "../binary/reader.js";
import { AnalysisError, type Finding, type Limitation } from "../model.js";
import { openZip, type ZipArchive } from "./zip.js";

export interface JavaMember {
  name: string;
  descriptor: string;
  flags: string[];
}

export interface JavaClassInfo {
  name: string;
  superClass: string | null;
  interfaces: string[];
  version: { major: number; minor: number; java: string };
  flags: string[];
  sourceFile: string | null;
  fields: JavaMember[];
  methods: JavaMember[];
  strings: string[];
  referencedClasses: string[];
  referencedMethods: string[];
  findings: Finding[];
  limitations: Limitation[];
}

const JAVA_VERSIONS: Record<number, string> = {
  45: "1.1",
  46: "1.2",
  47: "1.3",
  48: "1.4",
  49: "5",
  50: "6",
  51: "7",
  52: "8",
  53: "9",
  54: "10",
  55: "11",
  56: "12",
  57: "13",
  58: "14",
  59: "15",
  60: "16",
  61: "17",
  62: "18",
  63: "19",
  64: "20",
  65: "21",
  66: "22",
  67: "23",
  68: "24",
  69: "25",
};
const CLASS_FLAGS: Array<[number, string]> = [
  [0x1, "public"],
  [0x10, "final"],
  [0x20, "super"],
  [0x200, "interface"],
  [0x400, "abstract"],
  [0x1000, "synthetic"],
  [0x2000, "annotation"],
  [0x4000, "enum"],
  [0x8000, "module"],
];
const MEMBER_FLAGS: Array<[number, string]> = [
  [0x1, "public"],
  [0x2, "private"],
  [0x4, "protected"],
  [0x8, "static"],
  [0x10, "final"],
  [0x20, "synchronized"],
  [0x40, "volatile/bridge"],
  [0x80, "transient/varargs"],
  [0x100, "native"],
  [0x400, "abstract"],
  [0x800, "strict"],
  [0x1000, "synthetic"],
];
const flagsOf = (value: number, table: Array<[number, string]>): string[] =>
  table.filter(([bit]) => value & bit).map(([, name]) => name);

type Constant =
  | { tag: 1; value: string }
  | { tag: 7 | 8 | 16 | 19 | 20; index: number }
  | { tag: 9 | 10 | 11 | 12 | 17 | 18; a: number; b: number }
  | { tag: 3 | 4 | 5 | 6 | 15; raw: string };

/** Parses one `.class` file (JVM spec chapter 4). */
export function parseJavaClass(bytes: Uint8Array): JavaClassInfo {
  const r = new ByteReader(bytes, 0, false);
  if (bytes.length < 24 || r.u32() !== 0xcafebabe)
    throw new AnalysisError("malformed", "not a Java class file");
  const minor = r.u16();
  const major = r.u16();
  const limitations: Limitation[] = [];
  const findings: Finding[] = [];
  const count = r.u16();
  const pool: Array<Constant | null> = [null];
  for (let i = 1; i < count; i++) {
    const tag = r.u8();
    switch (tag) {
      case 1: {
        const len = r.u16();
        pool.push({ tag, value: utf8String(r.bytesAt(len)) });
        break;
      }
      case 3:
      case 4:
        pool.push({ tag, raw: Buffer.from(r.bytesAt(4)).toString("hex") });
        break;
      case 5:
      case 6:
        pool.push({ tag, raw: Buffer.from(r.bytesAt(8)).toString("hex") });
        pool.push(null);
        i++;
        break;
      case 7:
      case 8:
      case 16:
      case 19:
      case 20:
        pool.push({ tag, index: r.u16() });
        break;
      case 9:
      case 10:
      case 11:
      case 12:
      case 17:
      case 18:
        pool.push({ tag, a: r.u16(), b: r.u16() });
        break;
      case 15:
        pool.push({ tag, raw: `${r.u8()}:${r.u16()}` });
        break;
      default:
        throw new AnalysisError(
          "malformed",
          `unknown constant pool tag ${tag} at entry ${i}`,
        );
    }
  }
  const utf8 = (index: number): string => {
    const c = pool[index];
    return c && c.tag === 1 ? c.value : "";
  };
  const className = (index: number): string => {
    const c = pool[index];
    return c && c.tag === 7 ? utf8(c.index).replace(/\//g, ".") : "";
  };
  const nameAndType = (index: number): string => {
    const c = pool[index];
    return c && c.tag === 12 ? `${utf8(c.a)}${utf8(c.b)}` : "";
  };

  const access = r.u16();
  const name = className(r.u16());
  const superIndex = r.u16();
  const interfaces = Array.from({ length: r.u16() }, () => className(r.u16()));
  const members = (): JavaMember[] =>
    Array.from({ length: r.u16() }, () => {
      const flags = r.u16();
      const member: JavaMember = {
        name: utf8(r.u16()),
        descriptor: utf8(r.u16()),
        flags: flagsOf(flags, MEMBER_FLAGS),
      };
      skipAttributes(r);
      return member;
    });
  let fields: JavaMember[] = [];
  let methods: JavaMember[] = [];
  let sourceFile: string | null = null;
  try {
    fields = members();
    methods = members();
    const attributes = r.u16();
    for (let i = 0; i < attributes; i++) {
      const attrName = utf8(r.u16());
      const len = r.u32();
      if (attrName === "SourceFile" && len === 2) sourceFile = utf8(r.u16());
      else r.skip(len);
    }
  } catch (error) {
    limitations.push({
      code: "class_truncated",
      message: `Member tables truncated: ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
  }

  const strings: string[] = [];
  const referencedClasses = new Set<string>();
  const referencedMethods = new Set<string>();
  for (const c of pool) {
    if (!c) continue;
    if (c.tag === 8) strings.push(utf8(c.index));
    else if (c.tag === 7)
      referencedClasses.add(utf8(c.index).replace(/\//g, "."));
    else if (c.tag === 10 || c.tag === 11)
      referencedMethods.add(`${className(c.a)}.${nameAndType(c.b)}`);
  }
  referencedClasses.delete(name);

  const info: JavaClassInfo = {
    name,
    superClass: superIndex ? className(superIndex) : null,
    interfaces,
    version: { major, minor, java: JAVA_VERSIONS[major] ?? `class ${major}` },
    flags: flagsOf(access, CLASS_FLAGS),
    sourceFile,
    fields,
    methods,
    strings,
    referencedClasses: [...referencedClasses].toSorted(),
    referencedMethods: [...referencedMethods].toSorted(),
    findings,
    limitations,
  };
  if (methods.some((m) => m.flags.includes("native")))
    findings.push({
      kind: "java.native",
      title: "Declares native methods (JNI)",
      detail: methods
        .filter((m) => m.flags.includes("native"))
        .map((m) => m.name)
        .join(", "),
      confidence: "confirmed",
    });
  if (
    [...referencedMethods].some((m) =>
      /^java\.lang\.Runtime\.exec|^java\.lang\.ProcessBuilder\./.test(m),
    )
  )
    findings.push({
      kind: "java.exec",
      title: "Spawns processes (Runtime.exec / ProcessBuilder)",
      confidence: "confirmed",
    });
  if (
    [...referencedMethods].some((m) =>
      /^java\.lang\.reflect\.|^java\.lang\.Class\.forName/.test(m),
    )
  )
    findings.push({
      kind: "java.reflection",
      title: "Uses reflection",
      confidence: "confirmed",
    });
  if (
    [...referencedClasses].some((c) =>
      /^java\.net\.|^javax\.net\.|okhttp3\./.test(c),
    )
  )
    findings.push({
      kind: "java.network",
      title: "References networking classes",
      confidence: "confirmed",
    });
  return info;
}

function skipAttributes(r: ByteReader): void {
  const count = r.u16();
  for (let i = 0; i < count; i++) {
    r.u16();
    r.skip(r.u32());
  }
}

export interface JarInfo {
  manifest: Record<string, string>;
  mainClass: string | null;
  classCount: number;
  packages: Array<{ name: string; classes: number }>;
  classes: Array<{
    name: string;
    superClass: string | null;
    java: string;
    methods: number;
    flags: string[];
  }>;
  resources: number;
  nestedJars: string[];
  signed: boolean;
  findings: Finding[];
  limitations: Limitation[];
}

/** Inventories a JAR/WAR/AAR: manifest, packages and a bounded set of parsed classes. */
export function parseJar(
  bytes: Uint8Array,
  options: { maxClasses?: number } = {},
): JarInfo {
  const zip = openZip(bytes);
  return inventoryJar(zip, options);
}

export function inventoryJar(
  zip: ZipArchive,
  options: { maxClasses?: number } = {},
): JarInfo {
  const maxClasses = options.maxClasses ?? 2000;
  const limitations: Limitation[] = [];
  const findings: Finding[] = [];
  const manifest: Record<string, string> = {};
  const manifestEntry = zip.find("META-INF/MANIFEST.MF");
  if (manifestEntry) {
    const text = new TextDecoder()
      .decode(zip.read(manifestEntry, 1 << 20))
      .replace(/\r?\n /g, "");
    for (const line of text.split(/\r?\n/)) {
      const colon = line.indexOf(":");
      if (colon > 0)
        manifest[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
    }
  }
  const classEntries = zip.entries.filter(
    (e) => e.name.endsWith(".class") && !e.isDirectory,
  );
  const packages = new Map<string, number>();
  const classes: JarInfo["classes"] = [];
  const allFindings = new Map<string, Finding>();
  for (const [i, entry] of classEntries.entries()) {
    const pkg = entry.name.includes("/")
      ? entry.name.slice(0, entry.name.lastIndexOf("/")).replace(/\//g, ".")
      : "(default)";
    packages.set(pkg, (packages.get(pkg) ?? 0) + 1);
    if (i >= maxClasses) continue;
    try {
      const c = parseJavaClass(zip.read(entry, 8 << 20));
      classes.push({
        name: c.name,
        superClass: c.superClass,
        java: c.version.java,
        methods: c.methods.length,
        flags: c.flags,
      });
      for (const f of c.findings) {
        const existing = allFindings.get(f.kind);
        if (existing)
          existing.detail = `${existing.detail ?? ""}${
            existing.detail ? ", " : ""
          }${c.name}`.slice(0, 400);
        else allFindings.set(f.kind, { ...f, detail: c.name });
      }
    } catch (error) {
      limitations.push({
        code: "class_unreadable",
        message: `${entry.name}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
      if (limitations.length > 20) break;
    }
  }
  if (classEntries.length > maxClasses)
    limitations.push({
      code: "classes_truncated",
      message: `Parsed ${maxClasses} of ${classEntries.length} classes.`,
    });
  findings.push(...allFindings.values());
  const signed = zip.entries.some((e) =>
    /^META-INF\/.+\.(RSA|DSA|EC|SF)$/.test(e.name),
  );
  const nestedJars = zip.entries
    .filter((e) => /\.(jar|war|aar)$/.test(e.name))
    .map((e) => e.name);
  if (manifest["Main-Class"])
    findings.push({
      kind: "jar.main",
      title: `Entry point ${manifest["Main-Class"]}`,
      confidence: "confirmed",
    });
  if (manifest["Premain-Class"] || manifest["Agent-Class"])
    findings.push({
      kind: "jar.agent",
      title: "Java agent (instruments other JVMs)",
      confidence: "confirmed",
    });
  if (nestedJars.length)
    findings.push({
      kind: "jar.nested",
      title: `${nestedJars.length} nested archives (fat/shaded JAR)`,
      confidence: "confirmed",
    });
  const versions = new Set(classes.map((c) => c.java));
  if (versions.size)
    findings.push({
      kind: "jar.version",
      title: `Compiled for Java ${[...versions].toSorted((a, b) => Number(a) - Number(b)).join(", ")}`,
      confidence: "confirmed",
    });
  return {
    manifest,
    mainClass: manifest["Main-Class"] ?? null,
    classCount: classEntries.length,
    packages: [...packages]
      .map(([name, count]) => ({ name, classes: count }))
      .toSorted((a, b) => b.classes - a.classes),
    classes,
    resources: zip.entries.filter(
      (e) => !e.isDirectory && !e.name.endsWith(".class"),
    ).length,
    nestedJars,
    signed,
    findings,
    limitations,
  };
}
