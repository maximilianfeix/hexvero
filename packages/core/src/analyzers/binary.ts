import { parseDotnet, type DotnetInfo } from "../formats/dotnet.js";
import { parseElf, type ElfInfo } from "../formats/elf.js";
import {
  parseGoBuildInfo,
  type GoBuildInfo,
  type VaResolver,
} from "../formats/go.js";
import { listFatSlices, parseMacho, type MachoInfo } from "../formats/macho.js";
import { parsePe, type PeInfo } from "../formats/pe.js";
import {
  AnalysisError,
  type Analysis,
  type Finding,
  type Limitation,
} from "../model.js";
import type { LoadedTarget } from "../target.js";

type Go = Omit<GoBuildInfo, "findings" | "limitations">;
type Dotnet = Omit<DotnetInfo, "findings" | "limitations">;
type Macho = Omit<MachoInfo, "findings" | "limitations">;

export type BinaryData =
  | { kind: "elf"; elf: Omit<ElfInfo, "findings" | "limitations">; go?: Go }
  | {
      kind: "pe";
      pe: Omit<PeInfo, "findings" | "limitations" | "rvaToOffset">;
      go?: Go;
      dotnet?: Dotnet;
    }
  | { kind: "macho"; macho: Macho; go?: Go }
  | {
      kind: "macho-fat";
      slices: Array<{
        cpu: string;
        offset: number;
        size: number;
        macho: Macho;
        go?: Go;
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
      if (va >= r.va && va < r.va + BigInt(r.size))
        return r.offset + Number(va - r.va);
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

  const collect = <
    T extends { findings: Finding[]; limitations: Limitation[] },
  >(
    parsed: T,
    prefix = "",
  ): Omit<T, "findings" | "limitations"> => {
    const { findings: f, limitations: l, ...rest } = parsed;
    findings.push(
      ...(prefix ? f.map((x) => ({ ...x, title: `${prefix} ${x.title}` })) : f),
    );
    limitations.push(...l);
    return rest;
  };
  const goOf = (
    slice: Uint8Array,
    resolve: VaResolver,
    prefix = "",
  ): Go | undefined => {
    const go = parseGoBuildInfo(slice, resolve);
    if (!go) return undefined;
    summary += ` · Go ${go.goVersion.replace(/^go/, "")}${
      go.mainPath ? ` (${go.mainPath})` : ""
    }`;
    return collect(go, prefix);
  };
  const machoSlice = (
    slice: Uint8Array,
    prefix = "",
  ): { macho: Macho; go?: Go } => {
    const macho = collect(parseMacho(slice), prefix);
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
    return go ? { macho, go } : { macho };
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
      data = go ? { kind: "elf", elf, go } : { kind: "elf", elf };
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
        const go = goOf(bytes, (va) =>
          va >= base ? rvaToOffset(Number(va - base)) : null,
        );
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
        ...machoSlice(
          bytes.subarray(s.offset, s.offset + s.size),
          `[${s.cpu}]`,
        ),
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
