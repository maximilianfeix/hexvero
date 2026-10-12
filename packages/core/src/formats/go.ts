import { latin1, utf8String } from "../binary/reader.js";
import type { Finding, Limitation } from "../model.js";

export interface GoModule {
  path: string;
  version: string;
  sum?: string;
  replacement?: { path: string; version: string };
}

export interface GoBuildInfo {
  goVersion: string;
  /** How the version was found; the buildinfo blob is authoritative, a string scan is not. */
  source: "buildinfo" | "string-scan";
  mainPath: string | null;
  mainModule: GoModule | null;
  dependencies: GoModule[];
  settings: Record<string, string>;
  findings: Finding[];
  limitations: Limitation[];
}

const MAGIC = "\xff Go buildinf:";
const SENTINEL =
  "\x30\x77\xaf\x0c\x92\x74\x08\x02\x41\xe1\xc1\x07\xe6\xd6\x18\xe6";

/** Maps a virtual address to a file offset, provided by the container parser. */
export type VaResolver = (va: bigint) => number | null;

function indexOf(hay: Uint8Array, needle: string, from = 0): number {
  const first = needle.charCodeAt(0);
  outer: for (
    let i = hay.indexOf(first, from);
    i !== -1;
    i = hay.indexOf(first, i + 1)
  ) {
    for (let j = 1; j < needle.length; j++) {
      if (hay[i + j] !== needle.charCodeAt(j)) continue outer;
    }
    return i;
  }
  return -1;
}

function hasSentinel(bytes: Uint8Array, at: number): boolean {
  for (let i = 0; i < 16; i++)
    if (bytes[at + i] !== SENTINEL.charCodeAt(i)) return false;
  return true;
}

function uvarint(bytes: Uint8Array, at: number): [value: number, next: number] {
  let value = 0;
  let shift = 0;
  for (let i = at; i < bytes.length && shift < 64; i++) {
    const b = bytes[i]!;
    value += (b & 0x7f) * 2 ** shift;
    if ((b & 0x80) === 0) return [value, i + 1];
    shift += 7;
  }
  throw new RangeError("uvarint truncated");
}

/**
 * Recovers `go version -m` facts from the `\xff Go buildinf:` blob embedded by
 * the Go linker (Go 1.13+, inline strings since 1.18). Returns null when the
 * magic is absent.
 */
export function parseGoBuildInfo(
  bytes: Uint8Array,
  resolveVa: VaResolver,
): GoBuildInfo | null {
  const at = indexOf(bytes, MAGIC);
  if (at === -1 || at + 32 > bytes.length) return scanVersionString(bytes);
  const limitations: Limitation[] = [];
  const findings: Finding[] = [];
  const ptrSize = bytes[at + 14]!;
  const flags = bytes[at + 15]!;
  const bigEndian = (flags & 1) !== 0;
  const inline = (flags & 2) !== 0;

  let version = "";
  let modinfoBytes: Uint8Array = new Uint8Array();
  if (inline) {
    const [len1, next1] = uvarint(bytes, at + 32);
    version = utf8String(bytes.subarray(next1, next1 + len1));
    const [len2, next2] = uvarint(bytes, next1 + len1);
    modinfoBytes = bytes.subarray(next2, next2 + len2);
  } else {
    const readPtr = (off: number): bigint => {
      const view = new DataView(bytes.buffer, bytes.byteOffset + off, ptrSize);
      return ptrSize === 8
        ? view.getBigUint64(0, !bigEndian)
        : BigInt(view.getUint32(0, !bigEndian));
    };
    const readGoString = (headerVa: bigint): Uint8Array | null => {
      const off = resolveVa(headerVa);
      if (off === null || off + ptrSize * 2 > bytes.length) return null;
      const dataOff = resolveVa(readPtr(off));
      const len = Number(readPtr(off + ptrSize));
      if (dataOff === null || len > 1 << 24 || dataOff + len > bytes.length)
        return null;
      return bytes.subarray(dataOff, dataOff + len);
    };
    const versionBytes = readGoString(readPtr(at + 16));
    version = versionBytes ? utf8String(versionBytes) : "";
    modinfoBytes = readGoString(readPtr(at + 16 + ptrSize)) ?? new Uint8Array();
    if (!version)
      limitations.push({
        code: "go_pointer_unresolved",
        message: "Could not resolve the version string pointer.",
      });
  }

  let modinfo: string;
  if (
    modinfoBytes.length >= 32 &&
    hasSentinel(modinfoBytes, 0) &&
    hasSentinel(modinfoBytes, modinfoBytes.length - 16)
  ) {
    modinfo = utf8String(modinfoBytes.subarray(16, -16));
  } else {
    modinfo = utf8String(modinfoBytes);
    if (modinfo) {
      limitations.push({
        code: "go_modinfo_unframed",
        message:
          "Module info lacks the expected sentinels; parsed best-effort.",
      });
    }
  }

  const info: GoBuildInfo = {
    goVersion: version,
    source: "buildinfo",
    mainPath: null,
    mainModule: null,
    dependencies: [],
    settings: {},
    findings,
    limitations,
  };
  let last: GoModule | null = null;
  for (const line of modinfo.split("\n")) {
    const [kind, ...rest] = line.split("\t");
    switch (kind) {
      case "path":
        info.mainPath = rest[0] ?? null;
        break;
      case "mod":
        last = { path: rest[0] ?? "", version: rest[1] ?? "" };
        if (rest[2]) last.sum = rest[2];
        info.mainModule = last;
        break;
      case "dep":
        last = { path: rest[0] ?? "", version: rest[1] ?? "" };
        if (rest[2]) last.sum = rest[2];
        info.dependencies.push(last);
        break;
      case "=>":
        if (last)
          last.replacement = { path: rest[0] ?? "", version: rest[1] ?? "" };
        break;
      case "build": {
        const eq = (rest[0] ?? "").indexOf("=");
        if (eq > 0)
          info.settings[rest[0]!.slice(0, eq)] = rest[0]!.slice(eq + 1);
        break;
      }
      default:
        break;
    }
  }
  if (
    info.settings["-ldflags"]?.includes("-s") ||
    info.settings["-ldflags"]?.includes("-w")
  ) {
    findings.push({
      kind: "go.stripped",
      title: "Built with -ldflags stripping symbols/DWARF",
      detail: info.settings["-ldflags"],
      confidence: "confirmed",
    });
  }
  if (info.settings["CGO_ENABLED"] === "1")
    findings.push({
      kind: "go.cgo",
      title: "cgo enabled (links C code)",
      confidence: "confirmed",
    });
  if (info.settings["vcs.revision"]) {
    const vcs: Finding = {
      kind: "go.vcs",
      title: `Built from ${info.settings["vcs"] ?? "vcs"} revision ${info.settings["vcs.revision"].slice(0, 12)}`,
      confidence: "confirmed",
    };
    if (info.settings["vcs.modified"] === "true")
      vcs.detail = "working tree was modified";
    findings.push(vcs);
  }
  return info;
}

function scanVersionString(bytes: Uint8Array): GoBuildInfo | null {
  const match = /go1\.\d+(\.\d+)?(rc\d+|beta\d+)?/.exec(
    latin1(bytes.subarray(0, Math.min(bytes.length, 64 << 20))),
  );
  if (!match) return null;
  return {
    goVersion: match[0],
    source: "string-scan",
    mainPath: null,
    mainModule: null,
    dependencies: [],
    settings: {},
    findings: [],
    limitations: [
      {
        code: "go_no_buildinfo",
        message:
          "No buildinfo blob; version comes from a string scan and may belong to an embedded toolchain string.",
      },
    ],
  };
}
