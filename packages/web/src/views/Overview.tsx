import type { ReactElement } from "react";
import type { AnalysisResponse } from "../lib/api.js";

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null;

/** Overview renders the fact sheet for the format plus findings and limitations. */
export function Overview({
  analysis,
  findingsOnly = false,
}: {
  analysis: AnalysisResponse;
  findingsOnly?: boolean;
}): ReactElement {
  const facts = findingsOnly ? [] : factsFor(analysis.data);
  const marks = findingsOnly ? [] : marksFor(analysis.data);
  return (
    <div>
      {facts.length > 0 && (
        <dl className="facts">
          {facts.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      )}
      {marks.length > 0 && (
        <div className="section">
          <h3>Hardening</h3>
          <ul className="marks">
            {marks.map((m) => (
              <li key={m.name} className={`mark ${m.state}`}>
                <i /> <span>{m.name}</span> {m.word}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="section">
        <h3>Findings</h3>
        {analysis.findings.length === 0 ? (
          <p className="empty">
            <strong>Nothing stood out.</strong> The parser read the file; the
            collections above hold the raw facts.
          </p>
        ) : (
          <ul className="findings">
            {analysis.findings.map((f, i) => (
              <li
                key={i}
                className={`finding ${f.confidence}`}
                title={
                  f.confidence === "confirmed"
                    ? "Confirmed by parsing"
                    : "Inferred from patterns"
                }
              >
                <span className="dot" />
                <div>
                  <span className="title">{f.title}</span>
                  <span className="confidence">{f.confidence}</span>
                  <span className="kind">{f.kind}</span>
                  {f.detail && <div className="detail">{f.detail}</div>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      {analysis.limitations.length > 0 && (
        <div className="section">
          <h3>Could not establish</h3>
          <ul className="findings">
            {analysis.limitations.map((l, i) => (
              <li key={i} className="finding limitation">
                <span className="dot" />
                <div>
                  <span className="title">{l.message}</span>
                  <span className="kind">{l.code}</span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function factsFor(data: Obj): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const add = (k: string, v: unknown): void => {
    if (v === undefined || v === null || v === "") return;
    out.push([k, typeof v === "object" ? JSON.stringify(v) : String(v)]);
  };
  switch (data["kind"]) {
    case "binary": {
      const b = obj(data["binary"]) ?? {};
      const elf = obj(b["elf"]);
      const pe = obj(b["pe"]);
      const macho =
        obj(b["macho"]) ??
        obj(
          (obj(
            (b["slices"] as Obj | undefined)?.["$sample"] ??
              (b["slices"] as unknown[] | undefined)?.[0],
          ) ?? {})["macho"],
        );
      if (elf) {
        add("Class", `ELF${elf["class"]} ${elf["endian"]}-endian`);
        add("Machine", elf["machine"]);
        add("Type", elf["type"]);
        add("Entry", elf["entry"]);
        add("Interpreter", elf["interpreter"]);
        add("Build ID", elf["buildId"]);
        add("SONAME", elf["soname"]);
        add("RPATH", (elf["rpath"] as string[])?.join(", "));
      }
      if (pe) {
        add("Machine", `${pe["machine"]} (${pe["bits"]}-bit)`);
        add("Subsystem", pe["subsystem"]);
        add("Linked", pe["timestamp"]);
        add("Entry", pe["entry"]);
        add("Image base", pe["imageBase"]);
        add("PDB path", pe["pdbPath"]);
      }
      if (macho) {
        add("CPU", macho["cpu"]);
        add("File type", macho["fileType"]);
        const platform = obj(macho["platform"]);
        if (platform)
          add(
            "Platform",
            `${platform["name"]} ≥ ${platform["minOs"]} (SDK ${platform["sdk"]})`,
          );
        add("UUID", macho["uuid"]);
        add("Entry", macho["entry"]);
        add("Code signed", macho["codeSigned"] ? "yes" : "no");
      }
      const go = obj(b["go"]);
      if (go) {
        add("Go version", go["goVersion"]);
        add("Main package", go["mainPath"]);
        const mod = obj(go["mainModule"]);
        if (mod) add("Main module", `${mod["path"]} ${mod["version"]}`);
        const settings = obj(go["settings"]) ?? {};
        for (const key of [
          "GOOS",
          "GOARCH",
          "CGO_ENABLED",
          "-ldflags",
          "-trimpath",
          "vcs.revision",
        ])
          add(key, settings[key]);
      }
      const dotnet = obj(b["dotnet"]);
      if (dotnet) {
        const asm = obj(dotnet["assembly"]);
        if (asm) add("Assembly", `${asm["name"]} ${asm["version"]}`);
        add("Runtime", dotnet["runtimeVersion"]);
        add("Entry point", dotnet["entryPointToken"]);
        const flags = obj(dotnet["flags"]);
        if (flags) add("IL only", flags["ilOnly"] ? "yes" : "no (mixed mode)");
      }
      break;
    }
    case "apk": {
      const apk = obj(data["apk"]) ?? {};
      add("Package", apk["package"]);
      add("Version", `${apk["versionName"]} (${apk["versionCode"]})`);
      add("SDK", `min ${apk["minSdk"]} · target ${apk["targetSdk"]}`);
      add("Signatures", (apk["signatureSchemes"] as string[])?.join(", "));
      const app = obj(apk["application"]);
      if (app) add("Label", app["label"]);
      break;
    }
    case "javascript-app": {
      const app = obj(data["app"]) ?? {};
      const pkg = obj(app["package"]);
      if (pkg) {
        add("Package", `${pkg["name"]} ${pkg["version"]}`);
        add("Main", pkg["main"]);
      }
      const electron = obj(app["electron"]);
      if (electron) {
        add("Electron", electron["version"] ?? "detected");
        add(
          "Preload scripts",
          (electron["preloadScripts"] as string[])?.join(", "),
        );
      }
      const totals = obj(app["totals"]);
      if (totals)
        add(
          "Files",
          `${totals["files"]} total · ${totals["javascript"]} JavaScript`,
        );
      break;
    }
    case "sqlite": {
      const db = obj(data["sqlite"]) ?? {};
      add("Page size", db["pageSize"]);
      add("Encoding", db["encoding"]);
      add("Journal mode", db["journalMode"]);
      add("user_version", db["userVersion"]);
      break;
    }
    case "wasm": {
      const w = obj(data["wasm"]) ?? {};
      add("Functions", w["functionCount"]);
      add("Start function", w["start"]);
      add("Custom sections", (w["customSections"] as string[])?.join(", "));
      const producers = obj(w["producers"]);
      if (producers)
        for (const [k, v] of Object.entries(producers))
          add(k, (v as string[]).join(", "));
      break;
    }
    case "evm": {
      const e = obj(data["evm"]) ?? {};
      add("Bytes", e["byteLength"]);
      add("Instructions", e["instructionCount"]);
      const meta = obj(e["metadata"]);
      if (meta) {
        add("solc", meta["solc"]);
        add("IPFS", meta["ipfs"]);
      }
      break;
    }
    case "har": {
      const h = obj(data["har"]) ?? {};
      add("Creator", h["creator"]);
      add("Pages", h["pages"]);
      add("Methods", JSON.stringify(h["methods"]));
      add("Status", JSON.stringify(h["statuses"]));
      break;
    }
    case "plist": {
      const p = obj(data["plist"]);
      if (p)
        for (const [k, v] of Object.entries(p).slice(0, 24))
          add(k, typeof v === "object" ? JSON.stringify(v).slice(0, 120) : v);
      break;
    }
    default:
      break;
  }
  return out;
}

function marksFor(
  data: Obj,
): Array<{ name: string; state: "on" | "off" | "partial"; word: string }> {
  if (data["kind"] !== "binary") return [];
  const b = obj(data["binary"]) ?? {};
  const container =
    obj(b["elf"]) ??
    obj(b["pe"]) ??
    obj(b["macho"]) ??
    obj((obj((b["slices"] as unknown[] | undefined)?.[0]) ?? {})["macho"]);
  const m = obj(container?.["mitigations"]);
  if (!m) return [];
  const names: Record<string, string> = {
    nx: "NX",
    pie: "PIE",
    relro: "RELRO",
    canary: "Stack canary",
    fortify: "FORTIFY",
    stripped: "Symbols",
    aslr: "ASLR",
    highEntropyVa: "High-entropy VA",
    cfg: "Control Flow Guard",
    seh: "SafeSEH",
    gs: "/GS cookie",
    authenticode: "Authenticode",
    arc: "ARC",
    restrict: "__RESTRICT",
  };
  return Object.entries(m)
    .filter(([k]) => names[k])
    .map(([k, v]) => {
      const good = k === "stripped" ? v === false : v === true;
      const state: "on" | "off" | "partial" =
        v === "partial" ? "partial" : good ? "on" : "off";
      const word = k === "stripped" ? (good ? "kept" : "stripped") : state;
      return { name: names[k]!, state, word };
    });
}
