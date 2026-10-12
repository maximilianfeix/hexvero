import { parseDotnet, type DotnetInfo } from "../formats/dotnet.js";
import { parseElf, type ElfInfo } from "../formats/elf.js";
import { parseGoBuildInfo, type GoBuildInfo, type VaResolver } from "../formats/go.js";
import { listFatSlices, parseMacho, type MachoInfo } from "../formats/macho.js";
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
  | { kind: "macho"; macho: Macho; go?: Go; toolchain?: Toolchain }
  | {
      kind: "macho-fat";
      slices: Array<{
        cpu: string;
        offset: number;
        size: number;
        macho: Macho;
        go?: Go;
        toolchain?: Toolchain;
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
  ): { macho: Macho; go?: Go; toolchain: Toolchain } => {
    const macho = collect(parseMacho(slice), prefix);
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
    return go ? { macho, go, toolchain } : { macho, toolchain };
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

  return {
    target: info,
    summary,
    data,
    findings,
    limitations,
    durationMs: Math.round(performance.now() - started),
  };
}
