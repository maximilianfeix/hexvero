import { parseDotnet, type DotnetInfo } from "../formats/dotnet.js";
import { parseElf, type ElfInfo } from "../formats/elf.js";
import { parseGoBuildInfo, type GoBuildInfo, type VaResolver } from "../formats/go.js";
import { listFatSlices, parseMacho, type MachoInfo } from "../formats/macho.js";
import { parseObjcMetadata, type ObjcMetadata } from "../formats/machoObjc.js";
import { demangleSwift, type SwiftSymbol } from "../formats/swiftDemangle.js";
import { parsePe, type PeInfo } from "../formats/pe.js";
import { readVersionInfo, type PeVersionInfo } from "../formats/peResources.js";
import { detectToolchain, type ToolchainFacts } from "../formats/toolchain.js";
import { cstringAt } from "../binary/reader.js";
import { AnalysisError, type Analysis, type Finding, type Limitation } from "../model.js";
import type { LoadedTarget } from "../target.js";

type Go = Omit<GoBuildInfo, "findings" | "limitations">;
type Dotnet = Omit<DotnetInfo, "findings" | "limitations">;
type Macho = Omit<MachoInfo, "findings" | "limitations">;
type Toolchain = Omit<ToolchainFacts, "findings">;
type Objc = Omit<ObjcMetadata, "findings" | "limitations">;

export type BinaryData =
  | { kind: "elf"; elf: Omit<ElfInfo, "findings" | "limitations">; go?: Go; toolchain?: Toolchain }
  | {
      kind: "pe";
      pe: Omit<PeInfo, "findings" | "limitations" | "rvaToOffset">;
      go?: Go;
      dotnet?: Dotnet;
      toolchain?: Toolchain;
      versionInfo?: PeVersionInfo;
    }
  | {
      kind: "macho";
      macho: Macho;
      go?: Go;
      toolchain?: Toolchain;
      objc?: Objc;
      swiftSymbols?: SwiftSymbol[];
    }
  | {
      kind: "macho-fat";
      slices: Array<{
        cpu: string;
        offset: number;
        size: number;
        macho: Macho;
        go?: Go;
        toolchain?: Toolchain;
        objc?: Objc;
        swiftSymbols?: SwiftSymbol[];
      }>;
    };

interface Range {
  va: bigint;
  size: number;
  offset: number;
}

const rangeResolver =
  (ranges: Range[]): VaResolver =>
  (va) => {
    for (const r of ranges) {
      if (va >= r.va && va < r.va + BigInt(r.size)) return r.offset + Number(va - r.va);
    }
    return null;
  };

/** Parses the executable container and returns its layout, symbols and hardening facts. */
export function analyzeBinary(target: LoadedTarget): Analysis<BinaryData> {
  const started = performance.now();
  const { info, bytes } = target;
  const findings: Finding[] = [];
  const limitations: Limitation[] = [];
  let summary = "";

  const collect = <T extends { findings: Finding[]; limitations: Limitation[] }>(
    parsed: T,
    prefix = "",
  ): Omit<T, "findings" | "limitations"> => {
    const { findings: f, limitations: l, ...rest } = parsed;
    findings.push(...(prefix ? f.map((x) => ({ ...x, title: `${prefix} ${x.title}` })) : f));
    limitations.push(...l);
    return rest;
  };
  const goOf = (slice: Uint8Array, resolve: VaResolver, prefix = ""): Go | undefined => {
    const go = parseGoBuildInfo(slice, resolve);
    if (!go) return undefined;
    summary += ` · Go ${go.goVersion.replace(/^go/, "")}${go.mainPath ? ` (${go.mainPath})` : ""}`;
    return collect(go, prefix);
  };
  const machoSlice = (
    slice: Uint8Array,
    prefix = "",
  ): { macho: Macho; go?: Go; toolchain: Toolchain; objc?: Objc; swiftSymbols?: SwiftSymbol[] } => {
    const parsedMacho = parseMacho(slice);
    const macho = collect(parsedMacho, prefix);
    let objc: Objc | undefined;
    const hasObjc = macho.segments.some((sg) =>
      sg.sections.some(
        (x) =>
          x.name === "__objc_classlist" ||
          x.name === "__objc_protolist" ||
          x.name === "__objc_catlist",
      ),
    );
    if (hasObjc) {
      try {
        objc = collect(parseObjcMetadata(slice, parsedMacho), prefix);
      } catch (error) {
        limitations.push({
          code: "objc_unreadable",
          message: `Objective-C metadata: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
    const swiftSymbols = macho.symbols
      .map((x) => demangleSwift(x.name))
      .filter((x): x is SwiftSymbol => x !== null);
    if (swiftSymbols.length) {
      findings.push({
        kind: "swift.symbols",
        title: `${prefix ? `${prefix} ` : ""}${swiftSymbols.length} Swift symbols (names recovered approximately)`,
        detail: [...new Set(swiftSymbols.map((x) => x.readable.split(".")[0]))]
          .slice(0, 6)
          .join(", "),
        confidence: "inferred",
      });
    }
    const toolchain = toolchainOf(slice, {
      sectionNames: macho.segments.flatMap((sg) => [sg.name, ...sg.sections.map((x) => x.name)]),
      symbolNames: macho.symbols.map((x) => x.name),
      libraries: macho.dylibs.map((x) => x.path),
    });
    const go = goOf(
      slice,
      rangeResolver(
        macho.segments.map((s) => ({
          va: BigInt(s.vmaddr),
          size: s.fileSize,
          offset: s.fileOffset,
        })),
      ),
      prefix,
    );
    return {
      macho,
      toolchain,
      ...(go ? { go } : {}),
      ...(objc ? { objc } : {}),
      ...(swiftSymbols.length ? { swiftSymbols } : {}),
    };
  };

  const toolchainOf = (
    slice: Uint8Array,
    ctx: {
      comment?: string;
      sectionNames: string[];
      symbolNames: Iterable<string>;
      libraries: string[];
    },
  ): Toolchain => {
    const { findings: f, ...rest } = detectToolchain(slice, ctx);
    findings.push(...f);
    return rest;
  };

  let data: BinaryData;
  switch (info.format) {
    case "elf": {
      const elf = collect(parseElf(bytes));
      summary = `ELF${elf.class} ${elf.machine} ${elf.type}, ${elf.symbols.length} symbols, needs ${elf.needed.join(", ") || "nothing"}`;
      const loads = elf.segments.filter((s) => s.type === "LOAD");
      const go = goOf(
        bytes,
        rangeResolver(
          loads.map((s) => ({
            va: BigInt(s.vaddr),
            size: s.fileSize,
            offset: s.offset,
          })),
        ),
      );
      const commentSection = elf.sections.find((x) => x.name === ".comment");
      const comment =
        commentSection && commentSection.size < 65536
          ? cstringAt(bytes, commentSection.offset, commentSection.size).replace(/\0/g, " ")
          : undefined;
      const toolchain = toolchainOf(bytes, {
        ...(comment ? { comment } : {}),
        sectionNames: elf.sections.map((x) => x.name),
        symbolNames: elf.symbols.map((x) => x.name),
        libraries: elf.needed,
      });
      data = go ? { kind: "elf", elf, go, toolchain } : { kind: "elf", elf, toolchain };
      break;
    }
    case "pe": {
      const parsed = parsePe(bytes);
      const { rvaToOffset, ...rest } = parsed;
      const pe = collect(rest);
      summary = `PE${pe.bits} ${pe.machine} ${pe.isDll ? "DLL" : "EXE"}${
        pe.isClr ? " (.NET)" : ""
      }, ${pe.imports.length} import DLLs, ${pe.exports.length} exports`;
      data = { kind: "pe", pe };
      data.toolchain = toolchainOf(bytes, {
        sectionNames: pe.sections.map((x) => x.name),
        symbolNames: pe.imports.flatMap((i) => i.functions),
        libraries: pe.imports.map((i) => i.dll),
      });
      const versionInfo = readVersionInfo(bytes, parsed);
      if (versionInfo) {
        data.versionInfo = versionInfo;
        const product =
          versionInfo.strings["ProductName"] ?? versionInfo.strings["FileDescription"];
        if (product) {
          const detail = [
            versionInfo.strings["CompanyName"],
            versionInfo.strings["OriginalFilename"],
          ]
            .filter(Boolean)
            .join(" · ");
          findings.push({
            kind: "pe.version-info",
            title: `${product} ${versionInfo.fileVersion ?? ""}`.trim(),
            detail: detail || undefined,
            confidence: "confirmed",
          });
        }
      }
      if (pe.isClr) {
        try {
          const dotnet = collect(parseDotnet(bytes, parsed));
          data.dotnet = dotnet;
          summary += ` · ${dotnet.assembly?.name ?? "assembly"} ${dotnet.assembly?.version ?? ""}, ${dotnet.types.length} types`;
        } catch (error) {
          limitations.push({
            code: "dotnet_unreadable",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      } else {
        const base = BigInt(pe.imageBase);
        const go = goOf(bytes, (va) => (va >= base ? rvaToOffset(Number(va - base)) : null));
        if (go) data.go = go;
      }
      break;
    }
    case "macho": {
      const slice = machoSlice(bytes);
      summary = `Mach-O ${slice.macho.cpu} ${slice.macho.fileType}, ${slice.macho.dylibs.length} dylibs, ${slice.macho.symbols.length} symbols${summary}`;
      data = { kind: "macho", ...slice };
      break;
    }
    case "macho-fat": {
      const slices = listFatSlices(bytes).map((s) => ({
        cpu: s.cpu,
        offset: s.offset,
        size: s.size,
        ...machoSlice(bytes.subarray(s.offset, s.offset + s.size), `[${s.cpu}]`),
      }));
      summary = `Universal Mach-O with ${slices.length} slices: ${slices.map((s) => s.cpu).join(", ")}${summary}`;
      data = { kind: "macho-fat", slices };
      break;
    }
    default:
      throw new AnalysisError(
        "unsupported_format",
        `${info.format} is not an executable container`,
        {
          format: info.format,
        },
      );
  }

  findings.push(...nativeFindings(data));

  return {
    target: info,
    summary,
    data,
    findings,
    limitations,
    durationMs: Math.round(performance.now() - started),
  };
}

const bare = (name: string): string => name.replace(/^_+/, "").replace(/@.*$/, "");

/** Import names of a native binary, without the platform's leading underscore. */
/** Each imported function with where it was read, as a finding's location names it. */
function importSites(data: BinaryData): Array<{ name: string; where: string }> {
  if (data.kind === "elf")
    return data.elf.symbols
      .filter((s) => s.section === "UND" && s.table === "dynsym")
      .map((s) => ({ name: bare(s.name), where: `.dynsym: ${s.name}` }));
  if (data.kind === "pe")
    return data.pe.imports.flatMap((i) =>
      i.functions.map((f) => ({ name: bare(f), where: `import table: ${i.dll}!${f}` })),
    );
  if (data.kind === "macho")
    return data.macho.symbols
      .filter((s) => s.type === "undefined")
      .map((s) => ({ name: bare(s.name), where: `symbol table: ${s.name} (undefined)` }));
  return [];
}

/** Where the hardening facts of each format are read from. */
const HARDENING_SOURCES: Record<string, string> = {
  elf: "ELF header, program headers (PT_GNU_STACK, PT_GNU_RELRO), .dynamic, .dynsym",
  pe: "optional header DllCharacteristics, load config directory, certificate table",
  macho: "Mach-O header flags, load commands (LC_CODE_SIGNATURE), symbol table",
};

/** Imports that change what a reviewer looks at first; the name decides, nothing else. */
const IMPORT_GROUPS: Array<{ kind: string; what: string; names: RegExp }> = [
  {
    kind: "native.imports.process",
    what: "start other programs or a shell",
    names:
      /^(system|popen|_?wsystem|exec[lv]p?e?|posix_spawnp?|fork|vfork|CreateProcess[AW]?|CreateProcessAsUser[AW]?|ShellExecute(Ex)?[AW]?|WinExec)$/,
  },
  {
    kind: "native.imports.dynamic-code",
    what: "load code at run time",
    names: /^(dlopen|dlsym|NSAddImage|LoadLibrary(Ex)?[AW]?|LdrLoadDll|GetProcAddress)$/,
  },
  {
    kind: "native.imports.memory-protection",
    what: "change memory protection (for example to make data executable)",
    names: /^(mprotect|VirtualProtect(Ex)?|VirtualAlloc(Ex)?|vm_protect|mach_vm_protect)$/,
  },
  {
    kind: "native.imports.network",
    what: "open network connections",
    names:
      /^(socket|connect|getaddrinfo|gethostbyname|WSAStartup|WSAConnect|InternetOpen[AW]?|InternetConnect[AW]?|WinHttpOpen|curl_easy_init|SSL_connect|CFStreamCreatePairWithSocketToHost|nw_connection_create)$/,
  },
];

const flag = (label: string, value: boolean | string | undefined): string | null =>
  value === undefined
    ? null
    : `${label} ${value === true ? "yes" : value === false ? "no" : value}`;

/**
 * What a first look at a native binary should say: how it is hardened, and which imported
 * functions deserve attention. An import says the code can call the function; whether it does,
 * and with what input, is not established by reading the file.
 */
function nativeFindings(data: BinaryData): Finding[] {
  // A universal binary: each architecture is its own program. Equal findings are said once.
  if (data.kind === "macho-fat") {
    const seen = new Map<string, Finding>();
    for (const slice of data.slices)
      for (const f of nativeFindings({ kind: "macho", macho: slice.macho } as BinaryData)) {
        const key = f.title;
        const prior = seen.get(key);
        if (!prior) seen.set(key, { ...f, title: `${slice.cpu}: ${f.title}` });
        else prior.title = prior.title.replace(/^([\w-]+(?:, [\w-]+)*): /, `$1, ${slice.cpu}: `);
      }
    return [...seen.values()];
  }
  const out: Finding[] = [];
  const sites = importSites(data);
  const names = new Set(sites.map((x) => x.name));
  for (const group of IMPORT_GROUPS) {
    const hits = [...names].filter((n) => group.names.test(n)).toSorted();
    if (!hits.length) continue;
    const first = sites.find((x) => x.name === hits[0]);
    out.push({
      ...(first ? { location: first.where } : {}),
      kind: group.kind,
      title: `Imports functions that ${group.what}: ${hits.slice(0, 5).join(", ")}${hits.length > 5 ? ", …" : ""}`,
      detail:
        "Read from the import table. Whether and with what input they are called is not established by static reading; a call graph (hexvero calls) shows who calls them. (collection imports)",
      confidence: "confirmed",
    });
  }
  let parts: Array<string | null> = [];
  if (data.kind === "elf") {
    const m = data.elf.mitigations;
    parts = [
      flag("PIE", m.pie),
      flag("NX", m.nx),
      flag("RELRO", m.relro),
      flag("stack canary", m.canary),
      flag("FORTIFY", m.fortify),
      flag("stripped", m.stripped),
    ];
  } else if (data.kind === "pe") {
    const m = data.pe.mitigations;
    parts = [
      flag("ASLR", m.aslr),
      flag("high-entropy VA", m.highEntropyVa),
      flag("DEP/NX", m.nx),
      flag("CFG", m.cfg),
      flag("SafeSEH", m.seh),
      flag("/GS", m.gs),
      flag("Authenticode", m.authenticode),
    ];
  } else if (data.kind === "macho") {
    const m = data.macho.mitigations;
    parts = [
      flag("PIE", m.pie),
      flag("stack canary", m.canary),
      flag("ARC", m.arc),
      flag("code signature", data.macho.codeSigned),
      flag("stripped", m.stripped),
    ];
  }
  const shown = parts.filter((p): p is string => p !== null);
  if (shown.length)
    out.push({
      location: HARDENING_SOURCES[data.kind],
      kind: "native.hardening",
      title: `Hardening: ${shown.join(", ")}`,
      detail:
        "From headers and imported symbols. A missing symbol alone does not prove a missing protection (for example a binary without stack buffers needs no canary).",
      confidence: "confirmed",
    });
  return out;
}
