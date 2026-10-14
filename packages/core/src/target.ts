import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { detectFormat } from "./formats/detect.js";
import { createHash as hash } from "node:crypto";
import { closeSync, createReadStream, openSync, readSync } from "node:fs";
import { AnalysisError, type FormatId, type TargetInfo } from "./model.js";

export interface LoadedTarget {
  info: TargetInfo;
  /** Whole file contents, or an empty array when `lazy` is set. */
  bytes: Uint8Array;
  /** Set for files above the in-memory limit that a streaming reader can still handle (ASAR). */
  lazy?: boolean;
}

/** Formats whose readers work from disk offsets and therefore have no size limit. */
const LAZY_FORMATS = new Set<FormatId>(["asar"]);

export const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;

/** Reads one file, hashes it and detects its format. Directories are reported, not read. */
export async function loadTarget(
  path: string,
  maxBytes = DEFAULT_MAX_BYTES,
): Promise<LoadedTarget> {
  const absolute = resolve(path);
  let size: number;
  try {
    const s = await stat(absolute);
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
