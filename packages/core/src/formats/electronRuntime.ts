/**
 * The Electron runtime a packaged build ships: the Electron, Chromium and Node versions, the
 * fuses, the ASAR integrity record and whether the Electron line is still supported. Read from
 * the bytes of the Electron binary and the bundle's metadata only; nothing is executed.
 *
 * - Versions: the user-agent fragment Electron compiles into its binary
 *   (`Chrome/<chromium> Electron/<electron>\0`) and Node's release URL
 *   (`https://nodejs.org/download/release/v<node>/node-v<node>.tar.gz\0`, `process.release`).
 *   Every occurrence is read (a universal macOS binary holds one per architecture); a value is
 *   known only when all occurrences agree.
 * - Fuses: the wire after the sentinel `dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX`: a schema version
 *   byte, a count byte, then one byte per fuse (`0` off, `1` on, `r` removed). Names follow
 *   Electron's schema version 1 (build/fuses/fuses.json5).
 * - ASAR integrity: macOS `Info.plist` key `ElectronAsarIntegrity`; Windows: the resource
 *   `Integrity/ElectronAsar` of the app's .exe. Electron's hash is the SHA-256 of an archive's
 *   header, which is read (bounded) to say whether the record matches the archive.
 * - Support: Electron's release data, from the offline snapshot in data/electronReleases.ts.
 *
 * Every scan is bounded: the binary is read in windows up to MAX_RUNTIME_BINARY bytes, at most
 * MAX_MARKERS occurrences of a marker are kept (more make that value unknown), and metadata files
 * have their own caps.
 */
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { join, sep } from "node:path";
import { ELECTRON_RELEASES, type ElectronReleaseSnapshot } from "../data/electronReleases.js";
import { AnalysisError, type Limitation } from "../model.js";
import { openAsar, openAsarFile } from "./asar.js";
import { parsePlist, type PlistValue } from "./plist.js";
import type { ZipArchive } from "./zip.js";

export const FUSE_SENTINEL = "dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX";
/** Electron's fuse schema version 1, in wire order (build/fuses/fuses.json5). */
export const FUSES_V1 = [
  "runAsNode",
  "cookieEncryption",
  "nodeOptions",
  "nodeCliInspect",
  "embeddedAsarIntegrityValidation",
  "onlyLoadAppFromAsar",
  "loadBrowserProcessSpecificV8Snapshot",
  "grantFileProtocolExtraPrivileges",
  "wasmTrapHandlers",
] as const;
export type FuseName = (typeof FUSES_V1)[number];
/** The one fuse schema version hexvero names fuses for. */
export const FUSE_SCHEMA_VERSION = 1;

/** A binary larger than this is not scanned: its readings are unknown, and the analysis says so. */
export const MAX_RUNTIME_BINARY = 1 << 30;
/** Occurrences kept per marker; past this the value it gives is unknown, never a pick of some. */
export const MAX_MARKERS = 64;
/**
 * Strings examined per marker kind (` Electron/`, Node's URL prefix) before the value is given up
 * as unknown: each one costs a decode and a regular expression, so a file of repeats stays cheap.
 */
export const MAX_ANCHORS = 4096;
const WINDOW = 8 << 20;
const OVERLAP = 256;
const MAX_PLIST = 1 << 20;
const MAX_ASAR_HEADER = 64 << 20;
const MAX_RESOURCES = 32 << 20;
const MAX_INTEGRITY_JSON = 1 << 20;
/** Names listed in an install directory, and files of 1 MiB or more whose first bytes are read. */
const MAX_NAMES = 5000;
const MAX_PROBES = 64;

/** Bytes to read at offsets: a file on disk or bytes in memory. */
export interface ByteSource {
  size: number;
  read(offset: number, length: number): Uint8Array;
}

export function bytesSource(bytes: Uint8Array): ByteSource {
  return {
    size: bytes.length,
    read: (offset, length) =>
      bytes.subarray(Math.max(0, offset), Math.min(bytes.length, offset + length)),
  };
}

/**
 * Runs `use` with a source reading `path` through one descriptor. The descriptor is opened
 * non-blocking and without following a last link, and must be a regular file: a FIFO or device
 * put in a file's place is refused instead of read without end.
 */
function withFile<T>(path: string, use: (src: ByteSource) => T): T {
  const fd = openSync(
    path,
    constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new AnalysisError("invalid_input", `${path} is not a regular file`);
    const size = st.size;
    return use({
      size,
      read(offset, length) {
        const start = Math.max(0, offset);
        const out = new Uint8Array(Math.max(0, Math.min(length, size - start)));
        const n = out.length ? readSync(fd, out, 0, out.length, start) : 0;
        return out.subarray(0, n);
      },
    });
  } finally {
    closeSync(fd);
  }
}

// ---------------------------------------------------------------------------------------------
// The binary
// ---------------------------------------------------------------------------------------------

export interface Marker {
  value: string;
  offset: number;
}

export interface FuseWire {
  offset: number;
  version: number;
  /** One character per fuse, as stored. */
  wire: string;
  /** False when the file ends before the count the wire declares. */
  whole: boolean;
}

export interface BinaryScan {
  size: number;
  electron: Marker[];
  chromium: Marker[];
  node: Marker[];
  fuses: FuseWire[];
  /** A marker was found more than MAX_MARKERS times: the value it gives is not decided. */
  overflow: { electron: boolean; node: boolean; fuses: boolean };
  /** Why a reading overflowed: too many markers, or too many strings that start like one. */
  overflowWhy?: { electron?: string; node?: string; fuses?: string };
  /** Set when the binary was not scanned (larger than MAX_RUNTIME_BINARY). */
  notScanned?: string;
}

const enc = (s: string): Buffer => Buffer.from(s, "latin1");
const UA_ANCHOR = enc(" Electron/");
const NODE_ANCHOR = enc("https://nodejs.org/download/release/v");
const FUSE_ANCHOR = enc(FUSE_SENTINEL);
const CHROME_BEFORE = /Chrome\/(\d{1,4}\.\d{1,4}\.\d{1,6}\.\d{1,6})$/;
const ELECTRON_AFTER = /^(\d{1,4}\.\d{1,4}\.\d{1,4}(?:-(?:alpha|beta|nightly)\.\d{1,14})?)\0/;
const NODE_AFTER = /^v(\d{1,4}\.\d{1,4}\.\d{1,4})\/node-v\1(?:-headers)?\.tar\.gz\0/;

/**
 * Every version marker and fuse wire of an Electron binary, read in windows of 8 MiB. Nothing
 * past MAX_RUNTIME_BINARY bytes is read: a larger binary is not scanned at all (`notScanned`), so
 * a marker past the cut can never be missed silently.
 */
export function scanRuntimeBinary(src: ByteSource): BinaryScan {
  const out: BinaryScan = {
    size: src.size,
    electron: [],
    chromium: [],
    node: [],
    fuses: [],
    overflow: { electron: false, node: false, fuses: false },
    overflowWhy: {},
  };
  const examined = { ua: 0, node: 0 };
  if (src.size > MAX_RUNTIME_BINARY) {
    out.notScanned = `the binary is ${src.size} bytes, more than the ${MAX_RUNTIME_BINARY >> 20} MiB hexvero reads`;
    return out;
  }
  for (let pos = 0; pos < src.size; pos += WINDOW) {
    const from = Math.max(0, pos - OVERLAP);
    const bytes = src.read(from, pos - from + WINDOW + OVERLAP);
    const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // an anchor counts in the window it starts in; the overlap only supplies context
    const lo = pos - from;
    const hi = lo + WINDOW;
    for (
      let i = out.overflow.electron ? -1 : buf.indexOf(UA_ANCHOR, lo);
      i !== -1 && i < hi;
      i = buf.indexOf(UA_ANCHOR, i + 1)
    ) {
      if (++examined.ua > MAX_ANCHORS) {
        out.overflow.electron = true;
        out.overflowWhy!.electron = `more than ${MAX_ANCHORS} " Electron/" strings`;
        break;
      }
      const before = CHROME_BEFORE.exec(buf.toString("latin1", Math.max(0, i - 40), i));
      const after = ELECTRON_AFTER.exec(
        buf.toString("latin1", i + UA_ANCHOR.length, i + UA_ANCHOR.length + 48),
      );
      if (!before || !after) continue;
      if (out.electron.length >= MAX_MARKERS) {
        out.overflow.electron = true;
        out.overflowWhy!.electron = `more than ${MAX_MARKERS} user-agent markers`;
        break;
      }
      const at = from + i - before[0].length;
      out.chromium.push({ value: before[1]!, offset: at });
      out.electron.push({ value: after[1]!, offset: at });
    }
    for (
      let i = out.overflow.node ? -1 : buf.indexOf(NODE_ANCHOR, lo);
      i !== -1 && i < hi;
      i = buf.indexOf(NODE_ANCHOR, i + 1)
    ) {
      if (++examined.node > MAX_ANCHORS) {
        out.overflow.node = true;
        out.overflowWhy!.node = `more than ${MAX_ANCHORS} Node release URL prefixes`;
        break;
      }
      const m = NODE_AFTER.exec(
        buf.toString("latin1", i + NODE_ANCHOR.length - 1, i + NODE_ANCHOR.length + 64),
      );
      if (!m) continue;
      if (out.node.length >= MAX_MARKERS) {
        out.overflow.node = true;
        out.overflowWhy!.node = `more than ${MAX_MARKERS} Node release URLs`;
        break;
      }
      out.node.push({ value: m[1]!, offset: from + i });
    }
    for (
      let i = out.overflow.fuses ? -1 : buf.indexOf(FUSE_ANCHOR, lo);
      i !== -1 && i < hi;
      i = buf.indexOf(FUSE_ANCHOR, i + 1)
    ) {
      if (out.fuses.length >= MAX_MARKERS) {
        out.overflow.fuses = true;
        out.overflowWhy!.fuses = `more than ${MAX_MARKERS} fuse sentinels`;
        break;
      }
      const at = from + i;
      const head = src.read(at + FUSE_ANCHOR.length, 2);
      if (head.length < 2) {
        out.fuses.push({ offset: at, version: -1, wire: "", whole: false });
        continue;
      }
      const count = head[1]!;
      const wire = src.read(at + FUSE_ANCHOR.length + 2, count);
      out.fuses.push({
        offset: at,
        version: head[0]!,
        wire: Buffer.from(wire.buffer, wire.byteOffset, wire.byteLength).toString("latin1"),
        whole: wire.length === count,
      });
    }
  }
  return out;
}

/** Scans of binaries on disk in this process, by path and file identity (size, time, inode). */
const scans = new Map<string, BinaryScan>();
const MAX_CACHED_SCANS = 4;

function scanFile(path: string): BinaryScan {
  const st = lstatSync(path);
  const key = `${path}\0${st.size}:${st.mtimeMs}:${st.ino}`;
  const hit = scans.get(key);
  if (hit) return hit;
  const scan = withFile(path, scanRuntimeBinary);
  if (scans.size >= MAX_CACHED_SCANS) scans.delete(scans.keys().next().value!);
  scans.set(key, scan);
  return scan;
}

// ---------------------------------------------------------------------------------------------
// Readings
// ---------------------------------------------------------------------------------------------

/** A value read from the build, or `unknown` with the reason. */
export interface Reading {
  value: string;
  /** Where it was read (`file@0x…`), or null. */
  evidence: string | null;
  /** Why the value is what it is (all markers agree, they disagree, none found). */
  detail: string;
}

const hex = (n: number): string => `0x${n.toString(16)}`;

function agreed(
  what: string,
  hits: readonly Marker[],
  overflow: string | false,
  binary: string,
  absent: string,
): Reading {
  if (overflow)
    return {
      value: "unknown",
      evidence: null,
      detail: `${what}: ${overflow} in ${binary}; not decided`,
    };
  if (hits.length === 0) return { value: "unknown", evidence: null, detail: `${what}: ${absent}` };
  const values = [...new Set(hits.map((h) => h.value))];
  if (values.length > 1)
    return {
      value: "unknown",
      evidence: `${binary}@${hex(hits[0]!.offset)}`,
      detail: `${what}: the markers in ${binary} disagree (${hits
        .slice(0, 6)
        .map((h) => `${h.value} at ${hex(h.offset)}`)
        .join(", ")}${hits.length > 6 ? ", …" : ""})`,
    };
  return {
    value: values[0]!,
    evidence: `${binary}@${hex(hits[0]!.offset)}`,
    detail: `${what} ${values[0]}: read from ${binary} at ${hits.map((h) => hex(h.offset)).join(", ")}${hits.length > 1 ? " (all agree)" : ""}`,
  };
}

export interface FuseReading {
  /** Fuse name, or `#<n>` (1-based) for a position the schema does not name. */
  name: string;
  value: "on" | "off" | "removed" | "unknown";
  detail: string;
}

export interface FuseReadings {
  /** `unknown` when no single wire was read. */
  version: number | "unknown";
  wire: string | null;
  fuses: FuseReading[];
  evidence: string | null;
  detail: string;
}

const FUSE_STATE: Record<string, FuseReading["value"]> = { "0": "off", "1": "on", r: "removed" };
const printableWire = (wire: string): string =>
  [...wire].map((c) => (/[ -~]/.test(c) ? c : `\\x${c.charCodeAt(0).toString(16)}`)).join("");

const noFuses = (detail: string): FuseReadings => ({
  version: "unknown",
  wire: null,
  fuses: [],
  evidence: null,
  detail,
});

/** The fuses of a binary's wire(s). Positions are named only under schema version 1. */
export function decodeFuses(scan: BinaryScan, binary: string): FuseReadings {
  const none = noFuses;
  if (scan.notScanned) return none(`fuses not read: ${scan.notScanned}`);
  if (scan.overflow.fuses)
    return none(`more than ${MAX_MARKERS} fuse sentinels in ${binary}; not decided`);
  const wires = scan.fuses;
  if (wires.length === 0) return none(`no fuse sentinel in ${binary}`);
  const evidence = `${binary}@${hex(wires[0]!.offset)}`;
  const versions = [...new Set(wires.map((w) => w.version))];
  const counts = new Set(wires.map((w) => w.wire.length));
  const width = Math.max(...wires.map((w) => w.wire.length));
  const sameWire = new Set(wires.map((w) => w.wire)).size === 1;
  const where = wires.map((w) => hex(w.offset)).join(", ");
  if (versions.length > 1 || versions[0]! < 0)
    return {
      ...none(
        versions[0]! < 0
          ? `the fuse wire at ${where} in ${binary} is cut short`
          : `the fuse wires in ${binary} name different schema versions (${versions.join(", ")})`,
      ),
      evidence,
    };
  const version = versions[0]!;
  const known = version === 1;
  const fuses: FuseReading[] = [];
  for (let i = 0; i < width; i++) {
    const name = known && i < FUSES_V1.length ? FUSES_V1[i]! : `#${i + 1}`;
    const chars = [...new Set(wires.map((w) => w.wire[i]))];
    let value: FuseReading["value"];
    let detail: string;
    if (chars.length > 1 || chars[0] === undefined) {
      value = "unknown";
      detail = `the ${wires.length} fuse wires in ${binary} disagree at position ${i + 1}`;
    } else if (!known) {
      value = "unknown";
      detail = `schema version ${version} is not one hexvero knows (it knows version 1); stored as ${printableWire(chars[0])}`;
    } else if (i >= FUSES_V1.length) {
      value = "unknown";
      detail = `position ${i + 1} is past the ${FUSES_V1.length} fuses of schema version 1; stored as ${printableWire(chars[0])}`;
    } else if (!(chars[0] in FUSE_STATE)) {
      value = "unknown";
      detail = `stored as ${printableWire(chars[0])}, which is neither 0, 1 nor r`;
    } else {
      value = FUSE_STATE[chars[0]]!;
      detail = `${name} ${value}: position ${i + 1} of the fuse wire`;
    }
    fuses.push({ name, value, detail });
  }
  const whole = wires.every((w) => w.whole);
  return {
    version,
    wire: sameWire ? printableWire(wires[0]!.wire) : null,
    fuses,
    evidence,
    detail: `fuse wire, schema version ${version}, ${width} fuses, at ${where} in ${binary}${
      wires.length > 1 ? (sameWire ? " (all agree)" : " (they differ)") : ""
    }${counts.size > 1 ? "; the wires differ in length" : ""}${whole ? "" : "; a wire is cut short by the end of the file"}`,
  };
}

// ---------------------------------------------------------------------------------------------
// Support
// ---------------------------------------------------------------------------------------------

export interface SupportReading {
  value: "supported" | "past end of support" | "prerelease" | "unknown";
  eol: string | null;
  detail: string;
}

/** `YYYY-MM-DD` of `date` in UTC. */
export const isoDay = (date: Date): string => date.toISOString().slice(0, 10);

/**
 * Whether the Electron line of `version` is supported on `today`, by Electron's schedule in the
 * snapshot. A line's end of support is the day the next stable line is released, so on that day
 * it is past. A prerelease (alpha, beta, nightly) of a line still supported is a `prerelease`, not
 * a supported release. Never says more than that: no claim about vulnerabilities.
 */
export function supportOf(
  version: string,
  today: string,
  snapshot: ElectronReleaseSnapshot = ELECTRON_RELEASES,
): SupportReading {
  const from = `from the snapshot of ${snapshot.snapshot}, as of ${today}`;
  const m = /^(\d+)\.\d+\.\d+(-[a-z]+)?/.exec(version);
  if (!m) return { value: "unknown", eol: null, detail: "the Electron version was not read" };
  const line = snapshot.majors[m[1]!];
  if (!line?.eol)
    return {
      value: "unknown",
      eol: null,
      detail: `Electron ${m[1]} has no end-of-support date in Electron's schedule (${from})`,
    };
  const release = snapshot.versions[version];
  const released = release
    ? `; ${version} was released on ${release[0]}`
    : `; ${version} is not a release listed in the snapshot`;
  const planned = line.eol > snapshot.snapshot;
  const eol = `${planned ? "planned for " : ""}${line.eol}`;
  if (today >= line.eol)
    return {
      value: "past end of support",
      eol: line.eol,
      detail: `Electron ${version} is past its end of support (${eol}, ${from})${released}`,
    };
  if (m[2])
    return {
      value: "prerelease",
      eol: line.eol,
      detail: `Electron ${version} is a prerelease (${m[2].slice(1)}), not a stable release; the end of support of Electron ${m[1]} is ${eol} (${from})${released}`,
    };
  return {
    value: "supported",
    eol: line.eol,
    detail: `Electron ${version} is supported; its end of support is ${eol} (${from})${released}`,
  };
}

/** What Electron's release data says about the versions read, or null when it agrees. */
function crossCheck(electron: string, chromium: string, node: string): string | null {
  const known = ELECTRON_RELEASES.versions[electron];
  if (!known) return null;
  const off: string[] = [];
  if (chromium !== "unknown" && known[1] && known[1] !== chromium) off.push(`Chromium ${known[1]}`);
  if (node !== "unknown" && known[2] && known[2] !== node) off.push(`Node ${known[2]}`);
  return off.length
    ? `Electron's release data lists ${off.join(" and ")} for ${electron} (snapshot of ${ELECTRON_RELEASES.snapshot}); the binary's own markers are reported`
    : null;
}

// ---------------------------------------------------------------------------------------------
// ASAR integrity
// ---------------------------------------------------------------------------------------------

export interface IntegrityEntry {
  /** The archive path as the record names it (`Resources/app.asar`, `resources\app.asar`). */
  path: string;
  algorithm: string;
  hash: string;
}

/** The record as read, or the reason it is unknown. */
type IntegrityRecord =
  | { state: "read"; source: string; entries: IntegrityEntry[] }
  | { state: "none"; source: string }
  | { state: "unknown"; why: string };

/** A plist dictionary (not a date, data or UID value), or null. */
const dict = (v: unknown): Record<string, PlistValue> | null =>
  typeof v === "object" &&
  v !== null &&
  !Array.isArray(v) &&
  !("$date" in v) &&
  !("$data" in v) &&
  !("$uid" in v)
    ? (v as Record<string, PlistValue>)
    : null;

/** `ElectronAsarIntegrity` of a macOS Info.plist. */
export function plistIntegrity(bytes: Uint8Array, source: string): IntegrityRecord {
  let plist: PlistValue;
  try {
    plist = parsePlist(bytes);
  } catch (error) {
    return {
      state: "unknown",
      why: `${source} could not be read (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  const top = dict(plist);
  if (!top) return { state: "unknown", why: `${source} is not a dictionary` };
  if (top["ElectronAsarIntegrity"] === undefined) return { state: "none", source };
  const raw = dict(top["ElectronAsarIntegrity"]);
  if (!raw)
    return { state: "unknown", why: `ElectronAsarIntegrity in ${source} is not a dictionary` };
  const entries: IntegrityEntry[] = [];
  for (const [path, value] of Object.entries(raw).slice(0, 256)) {
    const v = dict(value);
    const algorithm = typeof v?.["algorithm"] === "string" ? v["algorithm"] : "";
    const hash = typeof v?.["hash"] === "string" ? v["hash"] : "";
    entries.push({ path, algorithm, hash });
  }
  return { state: "read", source, entries };
}

/**
 * The resource `Integrity/ElectronAsar` of a Windows executable: a JSON list of
 * `{ file, alg, value }`. Only the resource directory and that one entry are read.
 */
const u16 = (b: Uint8Array, at: number): number => b[at]! | (b[at + 1]! << 8);
const u32 = (b: Uint8Array, at: number): number =>
  (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)) >>> 0;

export function peIntegrity(src: ByteSource, source: string): IntegrityRecord {
  const unknown = (why: string): IntegrityRecord => ({
    state: "unknown",
    why: `${source}: ${why}`,
  });
  const dos = src.read(0, 64);
  if (dos.length < 64 || dos[0] !== 0x4d || dos[1] !== 0x5a) return unknown("not a PE file");
  const pe = u32(dos, 0x3c);
  const head = src.read(pe, 24 + 240);
  if (head.length < 24 || u32(head, 0) !== 0x00004550) return unknown("no PE header");
  const sections = u16(head, 6);
  const optSize = u16(head, 20);
  const opt = src.read(pe + 24, optSize);
  if (opt.length < optSize || optSize < 2) return unknown("the optional header is cut short");
  const magic = u16(opt, 0);
  const dirs = magic === 0x20b ? 112 : magic === 0x10b ? 96 : -1;
  if (dirs < 0 || opt.length < dirs + 24) return unknown("no data directories");
  if (u32(opt, dirs - 4) < 3) return { state: "none", source };
  const rsrcRva = u32(opt, dirs + 16);
  const rsrcSize = u32(opt, dirs + 20);
  if (rsrcRva === 0 || rsrcSize === 0) return { state: "none", source };
  const table = src.read(pe + 24 + optSize, Math.min(sections, 96) * 40);
  const toOffset = (rva: number): number | null => {
    for (let s = 0; s + 40 <= table.length; s += 40) {
      const vsize = u32(table, s + 8);
      const va = u32(table, s + 12);
      const rawSize = u32(table, s + 16);
      const raw = u32(table, s + 20);
      if (rva >= va && rva < va + Math.max(vsize, rawSize)) return raw + (rva - va);
    }
    return null;
  };
  const base = toOffset(rsrcRva);
  if (base === null) return unknown("the resource directory lies in no section");
  if (rsrcSize > MAX_RESOURCES)
    return unknown(`the resource directory is ${rsrcSize} bytes, more than hexvero reads`);
  const rs = src.read(base, rsrcSize);
  const nameAt = (offset: number): string => {
    if (offset + 2 > rs.length) return "";
    const n = Math.min(u16(rs, offset), 256);
    let text = "";
    for (let i = 0; i < n && offset + 2 + i * 2 + 1 < rs.length; i++)
      text += String.fromCharCode(u16(rs, offset + 2 + i * 2));
    return text;
  };
  const entries = (
    offset: number,
  ): Array<{ name: string | null; offset: number; dir: boolean }> => {
    if (offset + 16 > rs.length) return [];
    const count = Math.min(u16(rs, offset + 12) + u16(rs, offset + 14), 512);
    const out = [];
    for (let i = 0; i < count; i++) {
      const at = offset + 16 + i * 8;
      if (at + 8 > rs.length) break;
      const id = u32(rs, at);
      const value = u32(rs, at + 4);
      out.push({
        name: id & 0x80000000 ? nameAt(id & 0x7fffffff) : null,
        offset: value & 0x7fffffff,
        dir: (value & 0x80000000) !== 0,
      });
    }
    return out;
  };
  const named = (offset: number, name: string) =>
    entries(offset).find((e) => e.dir && e.name?.toUpperCase() === name);
  const type = named(0, "INTEGRITY");
  if (!type) return { state: "none", source };
  const item = named(type.offset, "ELECTRONASAR");
  if (!item) return { state: "none", source };
  const lang = entries(item.offset).find((e) => !e.dir);
  if (!lang || lang.offset + 16 > rs.length) return unknown("the integrity resource has no data");
  const dataRva = u32(rs, lang.offset);
  const size = u32(rs, lang.offset + 4);
  const at = toOffset(dataRva);
  if (at === null) return unknown("the integrity resource lies in no section");
  if (size > MAX_INTEGRITY_JSON)
    return unknown(`the integrity resource is ${size} bytes, more than hexvero reads`);
  const data = src.read(at, size);
  let list: unknown;
  try {
    list = JSON.parse(new TextDecoder("utf-8", { fatal: false }).decode(data));
  } catch {
    return unknown("the integrity resource is not JSON hexvero can read");
  }
  if (!Array.isArray(list)) return unknown("the integrity resource is not a list");
  const out: IntegrityEntry[] = [];
  for (const e of list.slice(0, 256)) {
    if (typeof e !== "object" || e === null || Array.isArray(e)) continue;
    const r = e as Record<string, unknown>;
    if (typeof r["file"] !== "string" || r["file"] === "") continue;
    out.push({
      path: r["file"],
      algorithm: typeof r["alg"] === "string" ? r["alg"] : "",
      hash: typeof r["value"] === "string" ? r["value"] : "",
    });
  }
  return { state: "read", source: `${source} resource Integrity/ElectronAsar`, entries: out };
}

/** SHA-256 of an ASAR archive's header string: the hash Electron's integrity record holds. */
export function asarHeaderHash(src: ByteSource): string | null {
  const head = src.read(0, 16);
  if (head.length < 16) return null;
  const view = new DataView(head.buffer, head.byteOffset, 16);
  if (view.getUint32(0, true) !== 4) return null;
  const length = view.getUint32(12, true);
  if (length === 0 || length > MAX_ASAR_HEADER || 16 + length > src.size) return null;
  const header = src.read(16, length);
  if (header.length !== length) return null;
  return createHash("sha256").update(header).digest("hex");
}

// ---------------------------------------------------------------------------------------------
// The runtime of a build
// ---------------------------------------------------------------------------------------------

export interface RuntimeRow {
  /** `electron`, `chromium`, `node`, `support`, `fuses`, `fuse.<name>`, `asarIntegrity`,
   *  `asarIntegrity:<archive>`. */
  item: string;
  value: string;
  detail: string;
  evidence: string | null;
  /** `asarIntegrity:<archive>` rows. */
  algorithm?: string;
  hash?: string;
  /** Whether `hash` is the SHA-256 of that archive's header: `matches`, `differs`, `archive absent`,
   *  `not compared`. */
  header?: string;
  /** `support`: the end-of-support date of the Electron line. */
  eol?: string | null;
}

export interface ElectronRuntime {
  /** False for an input that is no packaged build (an archive or app directory alone). */
  shipped: boolean;
  /** Why nothing is listed, or what could not be read. */
  note?: string;
  /** The binary read, relative to the build, with `/` separators. */
  binary: string | null;
  platform: "macos" | "windows" | "linux" | null;
  electron: string;
  chromium: string;
  node: string;
  support: SupportReading["value"];
  fuses: Record<string, FuseReading["value"]>;
  asarIntegrity: string;
  /** The fuse wire read: its schema version and number of positions; null when none was. */
  fuseWire: { version: number; positions: number } | null;
  rows: RuntimeRow[];
}

/** The runtime of an input that is no packaged build. */
export const NOT_SHIPPED: ElectronRuntime = {
  shipped: false,
  note: "not shipped in this input: it is an app archive or directory, not a packaged build. Analyze the .app, the install directory or the release ZIP to read the Electron runtime",
  binary: null,
  platform: null,
  electron: "unknown",
  chromium: "unknown",
  node: "unknown",
  support: "unknown",
  fuses: {},
  asarIntegrity: "unknown",
  fuseWire: null,
  rows: [],
};

/** Where the runtime of a build is, and how to read its files. */
interface BuildFiles {
  layout: "macos" | "windows-linux";
  /** The app Electron loads, relative to the build (`Contents/Resources/app.asar`). */
  entry: string;
  kind: "asar" | "directory";
  binary:
    | {
        rel: string;
        platform: ElectronRuntime["platform"];
        scan: () => BinaryScan;
        source: <T>(use: (s: ByteSource) => T) => T;
        /** How this file was told to be the runtime (its name, its integrity resource, markers). */
        basis?: string;
      }
    | { missing: string };
  /** Info.plist bytes (macOS), or why it could not be read. */
  plist: () => Uint8Array | string | null;
  /** An archive of the build, for its header hash; null when absent, a string when not compared. */
  /**
   * An archive of the build, for its header hash: `key` names the file it resolves to (one hash
   * per file, however many entries name it), `read` gives its header within `budget` bytes, or
   * why not. Null when absent; a string when it is not compared at all.
   */
  archive: (
    rel: string,
  ) => { key: string; read: (budget: number) => ByteSource | string } | null | string;
}

/** Header bytes hashed per build, all integrity entries together. */
const MAX_HEADERS_TOTAL = 64 << 20;

/** The header length an ASAR's first 16 bytes declare, or null. */
function headerLength(head: Uint8Array): number | null {
  if (head.length < 16) return null;
  const view = new DataView(head.buffer, head.byteOffset, 16);
  return view.getUint32(0, true) === 4 ? view.getUint32(12, true) : null;
}

export interface RuntimeOptions {
  /** The day support is judged against (`YYYY-MM-DD`); default today (UTC). */
  today?: string;
}

const UNREAD = "unknown";

function readRuntime(
  files: BuildFiles,
  options: RuntimeOptions,
): { runtime: ElectronRuntime; limitations: Limitation[] } {
  const today = options.today ?? isoDay(new Date());
  const limitations: Limitation[] = [];
  const rows: RuntimeRow[] = [];
  let binaryRel: string | null = null;
  let platform: ElectronRuntime["platform"] = files.layout === "macos" ? "macos" : null;
  let electron: Reading;
  let chromium: Reading;
  let node: Reading;
  let fuses: FuseReadings;
  let note: string | undefined;
  /** The binary read holds an Electron marker: it is Electron's, not some other large file. */
  let isElectron = false;
  if ("missing" in files.binary) {
    const missing = files.binary.missing;
    note = missing;
    const none = (what: string): Reading => ({
      value: UNREAD,
      evidence: null,
      detail: `${what}: ${missing}`,
    });
    electron = none("Electron");
    chromium = none("Chromium");
    node = none("Node");
    fuses = {
      version: "unknown",
      wire: null,
      fuses: [],
      evidence: null,
      detail: `fuses not read: ${note}`,
    };
    limitations.push({
      code: "electron_runtime_not_read",
      message: `The Electron runtime was not read: ${note}. Its versions, fuses and support status are unknown.`,
    });
  } else {
    binaryRel = files.binary.rel;
    platform = files.binary.platform;
    const scan = files.binary.scan();
    isElectron = scan.electron.length > 0;
    const absent = (marker: string): string =>
      scan.notScanned ?? `no ${marker} marker in ${binaryRel}`;
    electron = agreed(
      "Electron",
      scan.electron,
      scan.overflow.electron && (scan.overflowWhy?.electron ?? "too many markers"),
      binaryRel,
      absent("`Chrome/… Electron/…`"),
    );
    chromium = agreed(
      "Chromium",
      scan.chromium,
      scan.overflow.electron && (scan.overflowWhy?.electron ?? "too many markers"),
      binaryRel,
      absent("`Chrome/… Electron/…`"),
    );
    node = agreed(
      "Node",
      scan.node,
      scan.overflow.node && (scan.overflowWhy?.node ?? "too many markers"),
      binaryRel,
      absent("Node release URL"),
    );
    fuses = decodeFuses(scan, binaryRel);
    if (scan.notScanned) {
      note = scan.notScanned;
      limitations.push({
        code: "electron_runtime_not_read",
        message: `The Electron runtime in ${binaryRel} was not read: ${scan.notScanned}. Its versions, fuses and support status are unknown.`,
      });
    }
    const off =
      electron.value !== UNREAD ? crossCheck(electron.value, chromium.value, node.value) : null;
    if (off) {
      chromium = { ...chromium, detail: `${chromium.detail}; ${off}` };
      node = { ...node, detail: `${node.detail}; ${off}` };
    }
  }
  if (!("missing" in files.binary) && files.binary.basis)
    electron = { ...electron, detail: `${electron.detail}; ${files.binary.basis}` };
  rows.push({ item: "electron", ...electron });
  rows.push({ item: "chromium", ...chromium });
  rows.push({ item: "node", ...node });
  const support =
    electron.value === UNREAD
      ? { value: "unknown" as const, eol: null, detail: "the Electron version was not read" }
      : supportOf(electron.value, today);
  rows.push({
    item: "support",
    value: support.value,
    detail: support.detail,
    evidence: electron.evidence,
    eol: support.eol,
  });
  rows.push({
    item: "fuses",
    // a schema version hexvero does not know names no fuse: the row says so, so every fuse a
    // reader (the policy) looks for is unknown there, never absent
    value:
      fuses.version === FUSE_SCHEMA_VERSION
        ? `schema ${fuses.version}, ${fuses.fuses.length} fuses`
        : UNREAD,
    detail: `${fuses.detail}${fuses.wire !== null ? `; wire ${fuses.wire}` : ""}`,
    evidence: fuses.evidence,
  });
  for (const f of fuses.fuses)
    rows.push({
      item: `fuse.${f.name}`,
      value: f.value,
      detail: f.detail,
      evidence: fuses.evidence,
    });
  const fuseState = (name: FuseName): FuseReading["value"] | "absent" =>
    fuses.version === "unknown"
      ? "unknown"
      : (fuses.fuses.find((f) => f.name === name)?.value ?? "absent");
  rows.push(
    ...integrityRows(files, platform, fuseState("embeddedAsarIntegrityValidation"), isElectron),
  );
  const summary = rows.find((r) => r.item === "asarIntegrity")!;
  return {
    runtime: {
      shipped: true,
      ...(note ? { note } : {}),
      binary: binaryRel,
      platform,
      electron: electron.value,
      chromium: chromium.value,
      node: node.value,
      support: support.value,
      fuses: Object.fromEntries(fuses.fuses.map((f) => [f.name, f.value])),
      asarIntegrity: summary.value,
      fuseWire:
        fuses.version === "unknown"
          ? null
          : { version: fuses.version, positions: fuses.fuses.length },
      rows,
    },
    limitations,
  };
}

/** How the build's integrity record names the archive Electron loads. */
function recordKey(files: BuildFiles, platform: ElectronRuntime["platform"]): string {
  return platform === "macos"
    ? files.entry.replace(/^Contents\//, "")
    : files.entry.replace(/\//g, "\\").toLowerCase();
}

function integrityRows(
  files: BuildFiles,
  platform: ElectronRuntime["platform"],
  fuse: FuseReading["value"] | "absent",
  isElectron: boolean,
): RuntimeRow[] {
  const fuseSays =
    fuse === "on"
      ? "The fuse embeddedAsarIntegrityValidation is on."
      : fuse === "off"
        ? "The fuse embeddedAsarIntegrityValidation is off."
        : fuse === "absent"
          ? "This build's fuse wire has no embeddedAsarIntegrityValidation."
          : `The fuse embeddedAsarIntegrityValidation is ${fuse}.`;
  let record: IntegrityRecord;
  if (platform === "macos") {
    const bytes = files.plist();
    record =
      bytes === null
        ? { state: "unknown", why: "the bundle has no Contents/Info.plist" }
        : typeof bytes === "string"
          ? { state: "unknown", why: bytes }
          : plistIntegrity(bytes, "Contents/Info.plist");
  } else if (platform === "windows" && !("missing" in files.binary) && !isElectron)
    record = {
      state: "unknown",
      why: `${files.binary.rel} holds no Electron version marker, so it may not be the app's executable and its resources are not taken as the integrity record`,
    };
  else if (platform === "windows" && !("missing" in files.binary)) {
    const rel = files.binary.rel;
    const source = files.binary.source;
    try {
      record = source((s) => peIntegrity(s, rel));
    } catch (error) {
      record = {
        state: "unknown",
        why: `${rel} could not be read (${error instanceof Error ? error.message : String(error)})`,
      };
    }
  } else
    record = {
      state: "unknown",
      why:
        platform === "linux"
          ? "hexvero reads ASAR integrity records of macOS builds (Info.plist) and Windows builds (an .exe resource) only"
          : "the runtime binary was not found, so the platform and its integrity record are not known",
    };
  if (record.state === "unknown")
    return [
      {
        item: "asarIntegrity",
        value: UNREAD,
        detail: `${record.why}. ${fuseSays}`,
        evidence: null,
      },
    ];
  if (record.state === "none")
    return [
      {
        item: "asarIntegrity",
        value: "no record",
        detail: `${record.source} has no ASAR integrity record. ${fuseSays}`,
        evidence: record.source,
      },
    ];
  const key = recordKey(files, platform);
  const norm = (p: string): string =>
    platform === "macos" ? p : p.toLowerCase().replace(/\//g, "\\");
  const covering = record.entries.find((e) => norm(e.path) === key);
  const listed = record.entries.map((e) => e.path).join(", ") || "none";
  const loaded = platform === "macos" ? key : files.entry;
  const summary: RuntimeRow =
    files.kind === "directory"
      ? {
          item: "asarIntegrity",
          value: "does not cover the loaded app",
          detail: `Electron loads ${files.entry}, a directory; an integrity record covers archives (entries: ${listed}). ${fuseSays}`,
          evidence: record.source,
        }
      : covering
        ? {
            item: "asarIntegrity",
            value: "covers the loaded archive",
            detail: `${record.source} has an entry for ${covering.path}, the archive Electron loads. ${fuseSays}`,
            evidence: record.source,
          }
        : {
            item: "asarIntegrity",
            value: "does not cover the loaded archive",
            detail: `${record.source} lists ${listed}, not ${loaded}, the archive Electron loads. ${fuseSays}`,
            evidence: record.source,
          };
  const out = [summary];
  // one hash per archive file, and all headers of the build within MAX_HEADERS_TOTAL
  const hashes = new Map<string, { hash: string | null; why?: string }>();
  let budget = MAX_HEADERS_TOTAL;
  const hashOf = (file: string, read: (budget: number) => ByteSource | string) => {
    const hit = hashes.get(file);
    if (hit) return hit;
    let got: { hash: string | null; why?: string };
    const src = read(budget);
    if (typeof src === "string") got = { hash: null, why: src };
    else {
      const length = headerLength(src.read(0, 16));
      if (length === null) got = { hash: null, why: "not an ASAR header" };
      else if (length > budget)
        got = {
          hash: null,
          why: `its header of ${length} bytes is past the ${MAX_HEADERS_TOTAL >> 20} MiB of headers hexvero hashes for one build`,
        };
      else {
        budget -= length;
        got = { hash: asarHeaderHash(src) };
      }
    }
    hashes.set(file, got);
    return got;
  };
  for (const e of record.entries) {
    // the path as Electron joins it: separators unified, `.` and `..` resolved
    const rel = normalize(platform === "macos" ? `Contents/${e.path}` : e.path.replace(/\\/g, "/"));
    let header: string;
    let why: string | undefined;
    if (e.algorithm.toUpperCase() !== "SHA256" || !/^[0-9a-f]{64}$/i.test(e.hash))
      header = "not compared";
    else if (rel === null) {
      header = "not compared";
      why = "the path leads out of the build";
    } else {
      const found = files.archive(rel);
      if (found === null) header = "archive absent";
      else if (typeof found === "string") {
        header = "not compared";
        why = found;
      } else {
        const { hash: actual, why: reason } = hashOf(found.key, found.read);
        why = reason;
        header =
          actual === null
            ? "not compared"
            : actual === e.hash.toLowerCase()
              ? "matches"
              : "differs";
      }
    }
    out.push({
      item: `asarIntegrity:${e.path}`,
      value: e.algorithm || UNREAD,
      detail: `${record.source}: ${e.path}, ${e.algorithm || "no algorithm"} ${e.hash ? `${e.hash.slice(0, 16)}…` : "no hash"}; ${
        header === "matches"
          ? "the archive's header hashes to it"
          : header === "differs"
            ? "the archive's header does not hash to it"
            : header === "archive absent"
              ? "the build has no such archive"
              : `not compared with the archive${why ? ` (${why})` : ""}`
      }`,
      evidence: record.source,
      algorithm: e.algorithm,
      hash: e.hash,
      header,
    });
  }
  return out;
}

/** `a/./b/../c` as `a/c`; null when it climbs out of the build. */
function normalize(rel: string): string | null {
  const out: string[] = [];
  for (const part of rel.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length === 0) return null;
      out.pop();
    } else out.push(part);
  }
  return out.join("/");
}

// ---------------------------------------------------------------------------------------------
// Finding the binary
// ---------------------------------------------------------------------------------------------

/** The Electron Framework binary of a macOS bundle, real file first, then the links to it. */
export const MAC_FRAMEWORK = [
  "Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework",
  "Contents/Frameworks/Electron Framework.framework/Versions/Current/Electron Framework",
  "Contents/Frameworks/Electron Framework.framework/Electron Framework",
] as const;

/** Files beside a Windows or Linux runtime that are executables but not the app's own. */
const HELPERS = new Set([
  "chrome-sandbox",
  "chrome_crashpad_handler",
  "crashpad_handler",
  "update.exe",
  "squirrel.exe",
  "elevate.exe",
]);
const NOT_BINARY =
  /\.(?:so(?:\.\d+)*|dll|pak|dat|bin|json|txt|html|png|ico|icns|asar|sig|pdb|node)$/i;

const platformOf = (head: Uint8Array): ElectronRuntime["platform"] =>
  head[0] === 0x4d && head[1] === 0x5a
    ? "windows"
    : head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46
      ? "linux"
      : null;

function inside(root: string, path: string): string | null {
  try {
    const real = realpathSync(path);
    const base = realpathSync(root);
    return real.startsWith(base + sep) ? real : null;
  } catch {
    return null;
  }
}

function regular(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

/** At most this many files named like the app (or carrying the integrity resource) are scanned. */
const MAX_IDENTIFIED = 4;
/** The largest this many PE or ELF files are scanned for Electron markers, named files or not. */
const MAX_UNNAMED_SCANS = 3;
/** When no file named after the app holds markers, this many unnamed files are scanned. */
const MAX_UNNAMED_EXTRA = 8;
/** Bytes scanned for the runtime binary of one build on disk, all candidates together. */
const MAX_SCAN_TOTAL = 2 * 1024 * 1024 * 1024;
/** `.exe` files whose resources are looked at for `Integrity/ElectronAsar`, largest first. */
const MAX_INTEGRITY_PROBES = 8;

/** What a file name becomes when a packager writes it (`sanitize-filename`: no `/\?<>:*|"`). */
const sanitize = (name: string): string =>
  [...name]
    .filter((c) => {
      const code = c.charCodeAt(0);
      return !'/\\?<>:*|"'.includes(c) && code >= 0x20 && !(code >= 0x7f && code < 0xa0);
    })
    .join("")
    .replace(/[. ]+$/, "")
    .trim();

/** The value at `keys` of nested objects, or undefined. */
const at = (o: unknown, ...keys: string[]): unknown =>
  keys.reduce<unknown>(
    (v, k) =>
      typeof v === "object" && v !== null && !Array.isArray(v)
        ? (v as Record<string, unknown>)[k]
        : undefined,
    o,
  );

/**
 * The executable names the app's package.json leads a packager to: electron-builder writes
 * `<productName>.exe` on Windows (productName defaults to name) and `<name>` in lower case on
 * Linux, unless `build.executableName` (or `build.win` / `build.linux`) says otherwise;
 * @electron/packager and Electron Forge use `executableName` or the app name (productName or
 * name). Lower case, compared without case.
 */
export function executableStems(pkg: unknown): Set<string> {
  const out = new Set<string>();
  if (typeof pkg !== "object" || pkg === null || Array.isArray(pkg)) return out;
  const p = pkg as Record<string, unknown>;
  for (const v of [
    p["productName"],
    p["name"],
    at(p, "build", "productName"),
    at(p, "build", "executableName"),
    at(p, "build", "win", "executableName"),
    at(p, "build", "linux", "executableName"),
    at(p, "config", "forge", "packagerConfig", "executableName"),
    at(p, "config", "forge", "packagerConfig", "name"),
  ]) {
    if (typeof v !== "string" || v.length === 0 || v.length > 256) continue;
    const stem = sanitize(v.normalize("NFC")).toLowerCase();
    if (stem) out.add(stem);
  }
  return out;
}

const parseJson = (bytes: Uint8Array | null): unknown => {
  if (!bytes) return null;
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: false }).decode(bytes));
  } catch {
    return null;
  }
};

/** A file next to `resources/` that may be the runtime binary. */
interface Candidate {
  rel: string;
  size: number;
  /** `named`: like the app; `integrity`: an .exe with Integrity/ElectronAsar; `size`: neither. */
  how: "named" | "integrity" | "size";
}

const named = (rel: string, stems: ReadonlySet<string>): boolean => {
  // a name from macOS (NFD) and one from package.json (usually NFC) are the same name
  const lower = rel.normalize("NFC").toLowerCase();
  return stems.has(lower.endsWith(".exe") ? lower.slice(0, -4) : lower);
};

/** What tells two scans apart: every version and fuse wire they hold. */
const fingerprint = (scan: BinaryScan): string =>
  JSON.stringify([
    [...new Set(scan.electron.map((m) => m.value))].toSorted(),
    [...new Set(scan.chromium.map((m) => m.value))].toSorted(),
    [...new Set(scan.node.map((m) => m.value))].toSorted(),
    [...new Set(scan.fuses.map((f) => `${f.version}:${f.wire}`))].toSorted(),
  ]);

type Found = Exclude<BuildFiles["binary"], { missing: string }>;

/**
 * The runtime binary among `candidates`. Files the packaging names (the app's executable name,
 * or an .exe with the integrity resource) are taken over larger ones; without any, the largest
 * few PE or ELF files are scanned and the one with Electron markers is taken. When two files
 * that are scanned hold Electron markers that disagree, which is the runtime is not known:
 * nothing is taken, and the reason says so.
 */
function resolveBinary(
  candidates: readonly Candidate[],
  open: (c: Candidate) => Found | null,
  where: string,
  release: (c: Candidate) => void = () => {},
): BuildFiles["binary"] {
  const identified = candidates.filter((c) => c.how !== "size");
  const sized = candidates.filter((c) => c.how === "size");
  const opened: Opened[] = [];
  const tried = new Set<Candidate>();
  let budget = MAX_SCAN_TOTAL;
  const skipped: Candidate[] = [];
  const scanOne = (c: Candidate): Opened | null => {
    // every file scanned for one build counts against one byte budget, by the bytes it is read
    // (a file over MAX_RUNTIME_BINARY is not read at all)
    const cost = c.size > MAX_RUNTIME_BINARY ? 0 : c.size;
    if (cost > budget) {
      skipped.push(c);
      return null;
    }
    budget -= cost;
    tried.add(c);
    const b = open(c);
    if (!b) return null;
    const o = { c, b, scan: b.scan() };
    opened.push(o);
    return o;
  };
  // What a candidate cost to open or scan (bytes inflated out of a ZIP) is given back on every
  // path, except for the binary taken, which the runtime reads again (its integrity resource).
  let keep: Candidate | null = null;
  try {
    for (const c of identified.slice(0, MAX_IDENTIFIED)) scanOne(c);
    // The largest unnamed files are scanned too, next to the named ones: a file that holds other
    // Electron markers than the named binary makes the reading unknown, never a silent pick.
    for (const c of sized.slice(0, MAX_UNNAMED_SCANS)) scanOne(c);
    // Nothing named holds markers: the file is told by its markers alone, so every unnamed file
    // up to MAX_UNNAMED_EXTRA is scanned (not only until one qualifies), and another one with
    // other markers makes the reading unknown.
    const byMarkers = !opened.some((o) => o.c.how !== "size" && hasMarkers(o));
    if (byMarkers) for (const c of sized.slice(MAX_UNNAMED_SCANS, MAX_UNNAMED_EXTRA)) scanOne(c);
    // A file of the cross-check that was not read (over the budget, or over MAX_RUNTIME_BINARY)
    // may hold other markers: the reading is not decided, whether a named file was found or not.
    const unreadNow = [
      ...skipped.map(
        (c) => `${c.rel} (over the ${MAX_SCAN_TOTAL / (1 << 20)} MiB hexvero reads for one build)`,
      ),
      ...opened
        .filter((o) => o.c.how === "size" && o.scan.notScanned)
        .map((o) => `${o.c.rel} (${o.scan.notScanned})`),
    ];
    if (unreadNow.length)
      return {
        missing: `${unreadNow.join(", ")} could not be scanned, so which file is the runtime is not known`,
      };
    const result = pickAmong(opened, sized.length, where);
    if (!("missing" in result)) keep = result.candidate;
    return "missing" in result ? result : result.binary;
  } finally {
    for (const c of tried) if (c !== keep) release(c);
  }
}

interface Opened {
  c: Candidate;
  b: Found;
  scan: BinaryScan;
}
const hasMarkers = (o: Opened): boolean => o.scan.electron.length > 0 || o.scan.fuses.length > 0;
/**
 * An unnamed file is taken as the runtime only with a user agent and a fuse wire: Electron has
 * had fuses since version 12, while a helper or another tool can hold a user-agent string alone.
 */
const qualifies = (o: Opened): boolean =>
  o.c.how === "size" && o.scan.electron.length > 0 && o.scan.fuses.length > 0;

function pickAmong(
  opened: readonly Opened[],
  unnamed: number,
  where: string,
): { missing: string } | { candidate: Candidate; binary: Found } {
  const unread = opened
    .filter((o) => o.scan.notScanned)
    .map((o) => `${o.c.rel} (${o.scan.notScanned})`);
  const notRead = unread.length ? `; not read: ${unread.join(", ")}` : "";
  if (opened.length === 0)
    return { missing: `no executable of 1 MiB or more (PE or ELF) ${where}` };
  const marked = opened.filter(hasMarkers);
  const prints = new Set(marked.map((o) => fingerprint(o.scan)));
  if (prints.size > 1)
    return {
      missing: `${marked.map((o) => o.c.rel).join(", ")} all hold Electron markers and disagree (${marked
        .map(
          (o) =>
            `${o.c.rel}: Electron ${[...new Set(o.scan.electron.map((m) => m.value))].join("/") || "none"}, fuse wire ${[...new Set(o.scan.fuses.map((f) => f.wire))].join("/") || "none"}`,
        )
        .join("; ")}); which one is the runtime is not known${notRead}`,
    };
  const chosen =
    marked.find((o) => o.c.how !== "size") ??
    opened.find(qualifies) ??
    opened.find((o) => o.c.how !== "size");
  if (!chosen)
    return {
      missing: `no file named after the app, and none of the ${opened.length} largest PE or ELF files scanned (${opened
        .map((o) => o.c.rel)
        .join(", ")}) holds both an Electron user agent and a fuse wire${notRead}`,
    };
  const how = chosen.c.how;
  const others = opened
    .filter((o) => o !== chosen)
    .map(
      (o) =>
        `${o.c.rel} (${o.scan.notScanned ? "not read" : marked.includes(o) ? "the same markers" : "no Electron markers"})`,
    );
  const scannedNote = others.length ? `; also scanned: ${others.join(", ")}` : "";
  const scannedUnnamed = opened.filter((o) => o.c.how === "size").length;
  const basis =
    how === "named"
      ? `${chosen.c.rel} is named after the app (its package.json)${scannedNote}`
      : how === "integrity"
        ? `${chosen.c.rel} carries the resource Integrity/ElectronAsar${scannedNote}`
        : `${chosen.c.rel} was taken by its Electron user agent and fuse wire, not by a name the app's package.json gives: the ${scannedUnnamed} largest of ${unnamed} PE or ELF files were scanned${scannedNote}`;
  return { candidate: chosen.c, binary: { ...chosen.b, basis: `${basis}${notRead}` } };
}

/** package.json of the app Electron loads (`entry`), or of every candidate when not known. */
function diskPackages(root: string, entry: string, kind: "asar" | "directory"): unknown[] {
  const targets: Array<{ rel: string; kind: "asar" | "directory" }> = entry
    ? [{ rel: entry, kind }]
    : [
        { rel: "resources/app.asar", kind: "asar" },
        { rel: "resources/app", kind: "directory" },
      ];
  const out: unknown[] = [];
  for (const t of targets) {
    const path = inside(root, join(root, ...t.rel.split("/")));
    if (!path) continue;
    try {
      if (t.kind === "asar") {
        const archive = openAsarFile(path);
        const file = archive.find("package.json");
        if (file && !file.unpacked && file.size <= MAX_PLIST)
          out.push(parseJson(archive.read(file, MAX_PLIST)));
      } else {
        const file = inside(root, join(path, "package.json"));
        if (file)
          out.push(
            parseJson(withFile(file, (s) => (s.size <= MAX_PLIST ? s.read(0, s.size) : null))),
          );
      }
    } catch {
      // unreadable: no name from it
    }
  }
  return out;
}

/**
 * The candidates for the app's executable beside a Windows or Linux runtime: PE or ELF files of
 * 1 MiB or more, largest first, those named after the app or carrying the integrity resource
 * marked as such. At most MAX_NAMES names are listed and MAX_PROBES files opened; when nothing
 * is found within those caps the reason says so.
 */
function installCandidates(
  root: string,
  stems: ReadonlySet<string>,
): { candidates: Candidate[]; platforms: Map<string, "windows" | "linux">; where: string } {
  let names: string[];
  const platforms = new Map<string, "windows" | "linux">();
  try {
    names = readdirSync(root);
  } catch {
    return { candidates: [], platforms, where: "(the install directory could not be listed)" };
  }
  const sized: Array<{ name: string; size: number }> = [];
  for (const name of names.slice(0, MAX_NAMES)) {
    if (HELPERS.has(name.toLowerCase()) || NOT_BINARY.test(name)) continue;
    try {
      const st = lstatSync(join(root, name));
      if (st.isFile() && st.size >= 1 << 20) sized.push({ name, size: st.size });
    } catch {
      // gone or unreadable: not a candidate
    }
  }
  sized.sort((x, y) => y.size - x.size || (x.name < y.name ? -1 : 1));
  const candidates: Candidate[] = [];
  let integrityProbes = 0;
  for (const { name, size } of sized.slice(0, MAX_PROBES)) {
    let platform: ElectronRuntime["platform"];
    try {
      platform = withFile(join(root, name), (s) => platformOf(s.read(0, 4)));
    } catch {
      continue; // unreadable: not the binary hexvero can read
    }
    if (platform !== "windows" && platform !== "linux") continue;
    platforms.set(name, platform);
    let how: Candidate["how"] = named(name, stems) ? "named" : "size";
    if (how === "size" && platform === "windows" && integrityProbes++ < MAX_INTEGRITY_PROBES)
      try {
        if (withFile(join(root, name), (s) => peIntegrity(s, name)).state === "read")
          how = "integrity";
      } catch {
        // unreadable resources: by size only
      }
    candidates.push({ rel: name, size, how });
  }
  const capped = [
    names.length > MAX_NAMES
      ? `only the first ${MAX_NAMES} of ${names.length} names were listed`
      : "",
    sized.length > MAX_PROBES
      ? `only the ${MAX_PROBES} largest of ${sized.length} files were opened`
      : "",
  ].filter(Boolean);
  return {
    candidates,
    platforms,
    where: `next to resources/${capped.length ? ` (${capped.join("; ")})` : ""}`,
  };
}

/**
 * The runtime of a packaged build on disk: `root` is the `.app` or install directory, `entry`
 * the app Electron loads in it. Files are read only inside `root`.
 */
export function readRuntimeOnDisk(
  root: string,
  layout: "macos" | "windows-linux",
  entry: string,
  kind: "asar" | "directory",
  options: RuntimeOptions = {},
): { runtime: ElectronRuntime; limitations: Limitation[] } {
  let binary: BuildFiles["binary"];
  if (layout === "macos") {
    const rel = MAC_FRAMEWORK.find(
      (r) =>
        inside(root, join(root, ...r.split("/"))) &&
        regular(realpathSync(join(root, ...r.split("/")))),
    );
    binary = rel
      ? diskBinary(root, rel, "macos")
      : {
          missing:
            "the bundle has no Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework",
        };
  } else {
    const stems = new Set(diskPackages(root, entry, kind).flatMap((p) => [...executableStems(p)]));
    const { candidates, platforms, where } = installCandidates(root, stems);
    binary = resolveBinary(
      candidates,
      (c) => diskBinary(root, c.rel, platforms.get(c.rel) ?? null) as Found,
      where,
    );
  }
  return readRuntime(
    {
      layout,
      entry,
      kind,
      binary,
      plist: () => {
        const real = inside(root, join(root, "Contents", "Info.plist"));
        if (!real) return null;
        try {
          return withFile(real, (s) =>
            s.size > MAX_PLIST
              ? `Contents/Info.plist is larger than ${MAX_PLIST >> 20} MiB`
              : s.read(0, s.size),
          );
        } catch (error) {
          return `Contents/Info.plist could not be read (${error instanceof Error ? error.message : String(error)})`;
        }
      },
      archive: (rel) => {
        const real = inside(root, join(root, ...rel.split("/")));
        if (!real || !regular(real)) return null;
        return {
          key: real,
          read: (budget) => {
            try {
              return withFile(real, (s) => {
                // only the header: a pickle of 16 bytes and the header string, within the budget
                const head = s.read(0, 16);
                const length = headerLength(head);
                if (length === null) return "not an ASAR header";
                if (length > Math.min(MAX_ASAR_HEADER, budget))
                  return `its header of ${length} bytes is past what hexvero hashes (${Math.min(MAX_ASAR_HEADER, budget)} bytes left)`;
                return bytesSource(s.read(0, 16 + length));
              });
            } catch {
              return "not readable";
            }
          },
        };
      },
    },
    options,
  );
}

function diskBinary(
  root: string,
  rel: string,
  platform: ElectronRuntime["platform"],
): BuildFiles["binary"] {
  const real = realpathSync(join(root, ...rel.split("/")));
  return {
    rel,
    platform,
    scan: () => {
      try {
        return scanFile(real);
      } catch (error) {
        return {
          size: 0,
          electron: [],
          chromium: [],
          node: [],
          fuses: [],
          overflow: { electron: false, node: false, fuses: false },
          notScanned: `${rel} could not be read (${error instanceof Error ? error.message : String(error)})`,
        };
      }
    },
    source: (use) => withFile(real, use),
  };
}

/** The version and the fuse that decide which app Electron runs, for the pick in a bundle. */
export interface PickFacts {
  electron: string;
  onlyLoadAppFromAsar: FuseReading["value"];
  /** The fuse wire read (schema version, positions), or null: the 6th position came with the
   *  change of the search order in Electron 15.0.0-beta.6. */
  fuseWire: { version: number; positions: number } | null;
  /** Where they were read, or why not. */
  detail: string;
}

/** `PickFacts` of a build on disk; reads (and caches) the same scan as the runtime. */
export function pickFactsOnDisk(root: string, layout: "macos" | "windows-linux"): PickFacts {
  const { runtime } = readRuntimeOnDisk(root, layout, "", "asar", {});
  return pickFactsOf(runtime);
}

function pickFactsOf(runtime: ElectronRuntime): PickFacts {
  const fuse = runtime.fuses["onlyLoadAppFromAsar"] ?? "unknown";
  return {
    electron: runtime.electron,
    onlyLoadAppFromAsar: fuse,
    fuseWire: runtime.fuseWire,
    detail: runtime.binary
      ? runtime.note
        ? `${runtime.binary}: ${runtime.note}`
        : `read from ${runtime.binary}`
      : (runtime.note ?? "the runtime binary was not found"),
  };
}

/**
 * The runtime of a packaged build inside a ZIP: `prefix` is the build's path in the archive
 * (`Name.app/` or the install directory, may be empty), `entry` the app relative to it. The
 * binary is inflated within `maxBytes`; `loaded` holds the bytes of the archive read.
 */
export function readRuntimeInZip(
  zip: ZipArchive,
  prefix: string,
  layout: "macos" | "windows-linux",
  entry: string,
  kind: "asar" | "directory",
  maxBytes: number,
  loaded: Uint8Array | null,
  options: RuntimeOptions = {},
): { runtime: ElectronRuntime; limitations: Limitation[] } {
  const usable = (name: string) => {
    const e = zip.find(name);
    return e && !e.isDirectory && !e.encrypted && e.method !== "other" && !zip.links.has(e)
      ? e
      : null;
  };
  let binary: BuildFiles["binary"];
  /** Bytes inflated for runtime candidates of this build, all counted against one cap. */
  const spent = inflatedTotal(zip, prefix);
  const zipBinary = (rel: string, platform: ElectronRuntime["platform"]): BuildFiles["binary"] => {
    const e = usable(`${prefix}${rel}`)!;
    const cap = Math.min(maxBytes, MAX_RUNTIME_BINARY);
    const load = (): Uint8Array | string => {
      let cached = inflated.get(zip);
      if (!cached) inflated.set(zip, (cached = new Map()));
      const key = `${e.name}\0${cap}`;
      const hit = cached.get(key);
      if (hit !== undefined) return hit;
      let out: Uint8Array | string;
      if (e.size > cap)
        out = `${rel} expands to ${e.size} bytes, more than the ${cap >> 20} MiB hexvero reads out of an archive`;
      else if (!spent.seen.has(e.name) && spent.n + e.size > cap)
        out = `${rel} expands to ${e.size} bytes, and the candidates read before it already took ${spent.n} of the ${cap >> 20} MiB hexvero reads out of an archive`;
      else
        try {
          out = zip.read(e, cap);
          // an entry read again (by the pick, then the runtime) is counted once
          if (!spent.seen.has(e.name)) spent.n += out.length;
          spent.seen.add(e.name);
        } catch (error) {
          out = `${rel} could not be read out of the archive (${error instanceof Error ? error.message : String(error)})`;
        }
      cached.set(key, out);
      return out;
    };
    let scanned: BinaryScan | null = null;
    return {
      rel,
      platform,
      scan: () => (scanned ??= scanOnce()),
      source: (use) => {
        const b = load();
        return use(bytesSource(typeof b === "string" ? new Uint8Array() : b));
      },
    };
    function scanOnce(): BinaryScan {
      const b = load();
      return typeof b !== "string"
        ? scanRuntimeBinary(bytesSource(b))
        : {
            size: e.size,
            electron: [],
            chromium: [],
            node: [],
            fuses: [],
            overflow: { electron: false, node: false, fuses: false },
            notScanned: b,
          };
    }
  };
  if (layout === "macos") {
    // by name; an entry a ZIP marks as a link (the two links to Versions/A) is never usable
    const rel = MAC_FRAMEWORK.find((r) => usable(`${prefix}${r}`));
    binary = rel
      ? zipBinary(rel, "macos")
      : {
          missing:
            "the archive has no Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework",
        };
  } else {
    // the app's names: from the archive read, or from app/package.json in the ZIP
    const pkgs: unknown[] = [];
    if (loaded)
      try {
        const archive = openAsar(loaded);
        const file = archive.find("package.json");
        if (file && !file.unpacked && file.size <= MAX_PLIST)
          pkgs.push(parseJson(archive.read(file, MAX_PLIST)));
      } catch {
        // no name from it
      }
    const appPkg = usable(`${prefix}resources/app/package.json`);
    if ((!loaded || kind === "directory") && appPkg && appPkg.size <= MAX_PLIST)
      try {
        pkgs.push(parseJson(zip.read(appPkg, MAX_PLIST)));
      } catch {
        // no name from it
      }
    const stems = new Set(pkgs.flatMap((p) => [...executableStems(p)]));
    const candidates: Candidate[] = [];
    for (const e of zip.entries) {
      if (!e.name.startsWith(prefix)) continue;
      const rel = e.name.slice(prefix.length);
      if (rel.includes("/") || rel === "" || HELPERS.has(rel.toLowerCase()) || NOT_BINARY.test(rel))
        continue;
      if (!usable(e.name) || e.size < 1 << 20) continue;
      candidates.push({ rel, size: e.size, how: named(rel, stems) ? "named" : "size" });
    }
    candidates.sort((x, y) => y.size - x.size || (x.rel < y.rel ? -1 : 1));
    binary = resolveBinary(
      candidates.slice(0, MAX_PROBES),
      (c) => {
        // the platform from the entry's first bytes, before anything is inflated whole
        const e = usable(`${prefix}${c.rel}`);
        const first = e ? zip.head(e, 4) : null;
        const platform = first ? platformOf(first) : null;
        if (!platform) return null;
        const b = zipBinary(c.rel, platform);
        return "missing" in b ? null : b;
      },
      "next to resources/ in the archive",
      // a candidate's inflated bytes are dropped once it is scanned: only the scan is kept
      (c) =>
        inflated.get(zip)?.delete(`${prefix}${c.rel}\0${Math.min(maxBytes, MAX_RUNTIME_BINARY)}`),
    );
  }
  return readRuntime(
    {
      layout,
      entry,
      kind,
      binary,
      plist: () => {
        const e = usable(`${prefix}Contents/Info.plist`);
        if (!e) return null;
        if (e.size > MAX_PLIST) return `Contents/Info.plist is larger than ${MAX_PLIST >> 20} MiB`;
        try {
          return zip.read(e, MAX_PLIST);
        } catch (error) {
          return `Contents/Info.plist could not be read (${error instanceof Error ? error.message : String(error)})`;
        }
      },
      archive: (rel) => {
        if (rel === normalize(entry) && loaded)
          return { key: `${prefix}${rel}`, read: () => bytesSource(loaded) };
        return usable(`${prefix}${rel}`) ? "not read out of the archive" : null;
      },
    },
    options,
  );
}

/**
 * Binaries inflated out of a ZIP, per opened archive: the pick and the runtime of one build read
 * the same binary, which is inflated once. Held only as long as the archive object is.
 */
const inflated = new WeakMap<ZipArchive, Map<string, Uint8Array | string>>();

/** Bytes inflated per archive and build prefix, across the pick and the runtime of that build. */
const totals = new WeakMap<ZipArchive, Map<string, { n: number; seen: Set<string> }>>();
function inflatedTotal(zip: ZipArchive, prefix: string): { n: number; seen: Set<string> } {
  let m = totals.get(zip);
  if (!m) totals.set(zip, (m = new Map()));
  let t = m.get(prefix);
  if (!t) m.set(prefix, (t = { n: 0, seen: new Set() }));
  return t;
}

/** `PickFacts` of a build in a ZIP. */
export function pickFactsInZip(
  zip: ZipArchive,
  prefix: string,
  layout: "macos" | "windows-linux",
  maxBytes: number,
): PickFacts {
  return pickFactsOf(readRuntimeInZip(zip, prefix, layout, "", "asar", maxBytes, null).runtime);
}
