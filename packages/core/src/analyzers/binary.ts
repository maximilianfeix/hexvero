import { parseElf, type ElfInfo } from "../formats/elf.js";
import { parseMacho, parseMachoFat, type MachoFatInfo, type MachoInfo } from "../formats/macho.js";
import { parsePe, type PeInfo } from "../formats/pe.js";
import { AnalysisError, type Analysis, type Finding, type Limitation } from "../model.js";
import type { LoadedTarget } from "../target.js";

export type BinaryData =
  | { kind: "elf"; elf: Omit<ElfInfo, "findings" | "limitations"> }
  | { kind: "pe"; pe: Omit<PeInfo, "findings" | "limitations" | "rvaToOffset"> }
  | { kind: "macho"; macho: Omit<MachoInfo, "findings" | "limitations"> }
  | {
      kind: "macho-fat";
      slices: Array<{ cpu: string; offset: number; size: number; macho: Omit<MachoInfo, "findings" | "limitations"> }>;
    };

/** Parses the executable container and returns its layout, symbols and hardening facts. */
export function analyzeBinary(target: LoadedTarget): Analysis<BinaryData> {
  const started = performance.now();
  const { info, bytes } = target;
  let data: BinaryData;
  let summary: string;
  const findings: Finding[] = [];
  const limitations: Limitation[] = [];

  switch (info.format) {
    case "elf": {
      const { findings: f, limitations: l, ...elf } = parseElf(bytes);
      findings.push(...f);
      limitations.push(...l);
      data = { kind: "elf", elf };
      summary = `ELF${elf.class} ${elf.machine} ${elf.type}, ${elf.symbols.length} symbols, needs ${elf.needed.join(", ") || "nothing"}`;
      break;
    }
    case "pe": {
      const { findings: f, limitations: l, rvaToOffset: _r, ...pe } = parsePe(bytes);
      findings.push(...f);
      limitations.push(...l);
      data = { kind: "pe", pe };
      summary = `PE${pe.bits} ${pe.machine} ${pe.isDll ? "DLL" : "EXE"}${pe.isClr ? " (.NET)" : ""}, ${pe.imports.length} import DLLs, ${pe.exports.length} exports`;
      break;
    }
    case "macho": {
      const { findings: f, limitations: l, ...macho } = parseMacho(bytes);
      findings.push(...f);
      limitations.push(...l);
      data = { kind: "macho", macho };
      summary = `Mach-O ${macho.cpu} ${macho.fileType}, ${macho.dylibs.length} dylibs, ${macho.symbols.length} symbols`;
      break;
    }
    case "macho-fat": {
      const fat: MachoFatInfo = parseMachoFat(bytes);
      const slices = fat.slices.map((s) => {
        const { findings: f, limitations: l, ...macho } = s.info;
        findings.push(...f.map((x) => ({ ...x, title: `[${s.cpu}] ${x.title}` })));
        limitations.push(...l);
        return { cpu: s.cpu, offset: s.offset, size: s.size, macho };
      });
      data = { kind: "macho-fat", slices };
      summary = `Universal Mach-O with ${slices.length} slices: ${slices.map((s) => s.cpu).join(", ")}`;
      break;
    }
    default:
      throw new AnalysisError("unsupported_format", `${info.format} is not an executable container`, {
        format: info.format,
      });
  }

  return { target: info, summary, data, findings, limitations, durationMs: Math.round(performance.now() - started) };
}
