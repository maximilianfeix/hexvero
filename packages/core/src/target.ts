import { readFile, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { detectFormat } from "./formats/detect.js";
import { findElectronApp, findElectronAppInZip } from "./formats/electronApp.js";
import { readRuntimeInZip, type ElectronRuntime } from "./formats/electronRuntime.js";
import { openAsar } from "./formats/asar.js";
import { openZip, type ZipArchive } from "./formats/zip.js";
import { createHash as hash } from "node:crypto";
import { closeSync, createReadStream, openSync, readSync } from "node:fs";
import { AnalysisError, type FormatId, type Limitation, type TargetInfo } from "./model.js";

export interface LoadedTarget {
  info: TargetInfo;
  /** Whole file contents, or an empty array when `lazy` is set. */
  bytes: Uint8Array;
  /** Set for files above the in-memory limit that a streaming reader can still handle (ASAR). */
  lazy?: boolean;
  /**
   * For a lazy target: size, modification time and inode when it was opened. A later read from
   * disk that finds other values refuses, so no excerpt comes from a build that was not analyzed.
   */
  stamp?: string;
  /**
   * For an archive read out of a ZIP: the files it keeps in `<archive>.unpacked/`, taken from the
   * same ZIP, by their path inside the archive. Only files the JavaScript scan reads are taken.
   */
  unpacked?: Record<string, Uint8Array>;
  /**
   * For an app read out of a ZIP of a packaged build: the Electron runtime of that build, read
   * when the ZIP was opened (its binary is in the ZIP, which is not kept). A build on disk has
   * its runtime read by the analysis.
   */
  runtime?: { runtime: ElectronRuntime; limitations: Limitation[] };
}

/** What `stamp` records about a file on disk. */
export const fileStamp = (s: { size: number; mtimeMs: number; ino: number }): string =>
  `${s.size}:${s.mtimeMs}:${s.ino}`;

/** Formats whose readers work from disk offsets and therefore have no size limit. */
const LAZY_FORMATS = new Set<FormatId>(["asar"]);

export const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;

/**
 * Reads one file, hashes it and detects its format. Directories are reported, not read. A
 * packaged Electron build (a macOS `.app`, a Windows/Linux install directory, a ZIP of either)
 * is opened as the Electron application inside it, by Electron's own search order; `container`
 * then names the build and the entry that was read.
 */
export async function loadTarget(
  path: string,
  maxBytes = DEFAULT_MAX_BYTES,
): Promise<LoadedTarget> {
  const plain = await loadFile(path, maxBytes);
  if (plain.info.format === "directory") {
    const found = findElectronApp(plain.info.path);
    if (!found) return plain;
    if (found.refused)
      return {
        ...plain,
        info: { ...plain.info, appNotRead: { entry: found.entry, reason: found.refused } },
      };
    const container = {
      path: plain.info.path,
      format: "directory" as const,
      entry: found.entry,
      layout: found.layout,
      ...(found.note ? { note: found.note } : {}),
      ...(found.warning ? { warning: found.warning } : {}),
    };
    const inner = await loadFile(join(plain.info.path, ...found.entry.split("/")), maxBytes);
    return { ...inner, info: { ...inner.info, container } };
  }
  return electronInZip(plain, maxBytes);
}

/**
 * A ZIP archive with a packaged Electron build in it, as that build's `app.asar` read from the
 * archive, with the files of `app.asar.unpacked/` the scan reads; any other target is returned
 * as it is. When the archive holds an app that is not read (an `app/` directory, an entry held
 * twice, a link, an archive that is not one), the ZIP is returned with `appNotRead`.
 */
export function electronInZip(loaded: LoadedTarget, maxBytes = DEFAULT_MAX_BYTES): LoadedTarget {
  if (loaded.info.format !== "zip" || loaded.lazy || loaded.bytes.length === 0) return loaded;
  let zip;
  try {
    zip = openZip(loaded.bytes);
  } catch {
    return loaded; // the ZIP analysis reports what is wrong with it
  }
  const found = findElectronAppInZip(zip, maxBytes);
  if (!found) return loaded;
  if (found.refused || !found.bytes)
    return {
      ...loaded,
      info: {
        ...loaded.info,
        appNotRead: { entry: found.entry, reason: found.refused ?? "it could not be read" },
      },
    };
  const bytes = found.bytes;
  // Not a path on disk: nothing beside it (no `.unpacked` directory) is ever looked up. The name
  // ends in `.asar`, and the bytes were opened as an archive by the finder.
  const inner = targetFromBytes(bytes, `${basename(loaded.info.path)}!/${found.entry}`);
  const unpacked = unpackedFromZip(zip, bytes, `${found.entry}.unpacked/`);
  const prefix = found.entry.replace(/(?:Contents\/Resources|resources)\/[^/]+$/, "");
  const runtime = readRuntimeInZip(
    zip,
    prefix,
    found.layout,
    found.entry.slice(prefix.length),
    found.kind,
    maxBytes,
    bytes,
  );
  return {
    ...inner,
    ...(unpacked ? { unpacked } : {}),
    runtime,
    info: {
      ...inner.info,
      format: "asar",
      container: {
        path: loaded.info.path,
        format: "zip",
        entry: found.entry,
        layout: found.layout,
        ...(found.note ? { note: found.note } : {}),
        ...(found.warning ? { warning: found.warning } : {}),
      },
    },
  };
}

/** Unpacked files the JavaScript scan reads: sources, manifests and source maps. */
const SCANNED_UNPACKED = /\.(?:[cm]?js|jsx|json|map)$/i;
const MAX_UNPACKED_FILE = 16 << 20;
const MAX_UNPACKED_TOTAL = 256 << 20;

/**
 * The files an archive lists as unpacked, read from `<prefix>` in the ZIP it came from. Only
 * those the scan reads, each up to 16 MiB and 256 MiB in all; the rest stay unread and the
 * analysis says so, as for a missing `.unpacked` directory.
 */
function unpackedFromZip(
  zip: ZipArchive,
  asar: Uint8Array,
  prefix: string,
): Record<string, Uint8Array> | undefined {
  let listed: string[];
  try {
    listed = openAsar(asar)
      .files.filter((f) => f.unpacked)
      .map((f) => f.path);
  } catch {
    return undefined; // the analysis reports the unreadable header
  }
  if (listed.length === 0) return undefined;
  const out: Record<string, Uint8Array> = {};
  let total = 0;
  for (const path of listed) {
    if (!SCANNED_UNPACKED.test(path)) continue;
    const entry = zip.find(`${prefix}${path}`);
    if (!entry || entry.isDirectory || entry.encrypted || entry.method === "other") continue;
    // a link is no file of the app here: an extractor makes it point anywhere
    if (zip.links.has(entry)) continue;
    if (entry.size > MAX_UNPACKED_FILE || total + entry.size > MAX_UNPACKED_TOTAL) continue;
    try {
      const bytes = zip.read(entry, MAX_UNPACKED_FILE);
      // the bytes returned count, not the size the entry declares
      if (bytes.length > MAX_UNPACKED_FILE || total + bytes.length > MAX_UNPACKED_TOTAL) continue;
      out[path] = bytes;
      total += bytes.length;
    } catch {
      // left unread; the scan lists it with the reason
    }
  }
  return out;
}

async function loadFile(path: string, maxBytes: number): Promise<LoadedTarget> {
  const absolute = resolve(path);
  let size: number;
  let stamp = "";
  try {
    const s = await stat(absolute);
    stamp = fileStamp(s);
    if (s.isDirectory()) {
      return {
        info: { path: absolute, size: 0, sha256: "", format: "directory" },
        bytes: new Uint8Array(),
      };
    }
    // Devices, pipes and sockets report no meaningful size and can be read without end.
    if (!s.isFile())
      throw new AnalysisError("invalid_input", `${absolute} is not a regular file or directory`, {
        path: absolute,
      });
    size = s.size;
  } catch (error) {
    if (error instanceof AnalysisError) throw error;
    throw new AnalysisError("not_found", `No file at ${absolute}`, {
      path: absolute,
    });
  }
  if (size > maxBytes) {
    const head = readHead(absolute, 64 * 1024);
    const format = detectFormat(head, absolute);
    if (!LAZY_FORMATS.has(format)) {
      throw new AnalysisError("too_large", `${absolute} is ${size} bytes; limit is ${maxBytes}`, {
        size,
        maxBytes,
        format,
      });
    }
    // Lazy targets are still identified by the SHA-256 of the whole file, streamed from disk, so
    // two archives that share a header never collide and a changed archive gets a new identity.
    const sha256 = await hashFile(absolute);
    return {
      info: { path: absolute, size, sha256, format },
      bytes: new Uint8Array(),
      lazy: true,
      stamp,
    };
  }
  const bytes = new Uint8Array(await readFile(absolute));
  const sha256 = hash("sha256").update(bytes).digest("hex");
  return {
    info: {
      path: absolute,
      size,
      sha256,
      format: detectFormat(bytes, absolute),
    },
    bytes,
  };
}

export function targetFromBytes(bytes: Uint8Array, name: string): LoadedTarget {
  return {
    info: {
      path: name,
      size: bytes.length,
      sha256: hash("sha256").update(bytes).digest("hex"),
      format: detectFormat(bytes, name),
    },
    bytes,
  };
}

/** Reads `length` bytes at `offset` straight from disk; used for lazy targets. */
export function readWindow(path: string, offset: number, length: number): Uint8Array {
  const fd = openSync(path, "r");
  try {
    const out = new Uint8Array(length);
    const n = readSync(fd, out, 0, length, offset);
    return out.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

/** SHA-256 of a whole file without holding it in memory. */
async function hashFile(path: string): Promise<string> {
  const digest = hash("sha256");
  for await (const chunk of createReadStream(path, { highWaterMark: 4 << 20 }))
    digest.update(chunk as Buffer);
  return digest.digest("hex");
}

function readHead(path: string, length: number): Uint8Array {
  return readWindow(path, 0, length);
}
