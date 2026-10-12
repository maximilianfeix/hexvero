import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { detectFormat } from "./formats/detect.js";
import { AnalysisError, type TargetInfo } from "./model.js";

export interface LoadedTarget {
  info: TargetInfo;
  bytes: Uint8Array;
}

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
    size = s.size;
  } catch {
    throw new AnalysisError("not_found", `No file at ${absolute}`, {
      path: absolute,
    });
  }
  if (size > maxBytes) {
    throw new AnalysisError(
      "too_large",
      `${absolute} is ${size} bytes; limit is ${maxBytes}`,
      { size, maxBytes },
    );
  }
  const bytes = new Uint8Array(await readFile(absolute));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
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
      sha256: createHash("sha256").update(bytes).digest("hex"),
      format: detectFormat(bytes, name),
    },
    bytes,
  };
}
