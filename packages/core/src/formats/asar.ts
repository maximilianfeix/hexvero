import { ByteReader, utf8String } from "../binary/reader.js";
import { AnalysisError } from "../model.js";

export interface AsarFile {
  path: string;
  size: number;
  offset: number | null;
  unpacked: boolean;
  executable: boolean;
  integrity: string | null;
}

export interface AsarArchive {
  headerSize: number;
  files: AsarFile[];
  read(file: AsarFile, maxBytes?: number): Uint8Array;
  find(path: string): AsarFile | undefined;
}

interface Node {
  files?: Record<string, Node>;
  size?: number;
  offset?: string;
  unpacked?: boolean;
  executable?: boolean;
  link?: string;
  integrity?: { algorithm?: string; hash?: string };
}

/**
 * Electron ASAR: a Chromium Pickle (u32 payload size, u32 header size, u32 string
 * length) followed by the JSON tree, then concatenated file contents.
 */
export function openAsar(bytes: Uint8Array): AsarArchive {
  if (bytes.length < 16)
    throw new AnalysisError("malformed", "ASAR header truncated");
  const r = new ByteReader(bytes, 0, true);
  r.u32(); // pickle size header (always 4)
  const headerSize = r.u32();
  r.u32(); // string pickle size
  const jsonLength = r.u32();
  if (jsonLength > headerSize || 16 + jsonLength > bytes.length)
    throw new AnalysisError("malformed", "ASAR header length out of range");
  let tree: Node;
  try {
    tree = JSON.parse(utf8String(bytes.subarray(16, 16 + jsonLength)));
  } catch {
    throw new AnalysisError("malformed", "ASAR header is not valid JSON");
  }
  const dataStart = 8 + headerSize;
  const files: AsarFile[] = [];
  const walk = (node: Node, prefix: string, depth: number): void => {
    if (depth > 64 || !node.files) return;
    for (const [name, child] of Object.entries(node.files)) {
      const path = prefix ? `${prefix}/${name}` : name;
      if (child.files) {
        walk(child, path, depth + 1);
        continue;
      }
      if (child.link !== undefined) continue;
      files.push({
        path,
        size: child.size ?? 0,
        offset:
          child.offset !== undefined && !child.unpacked
            ? Number(child.offset)
            : null,
        unpacked: Boolean(child.unpacked),
        executable: Boolean(child.executable),
        integrity: child.integrity?.hash ?? null,
      });
    }
  };
  walk(tree, "", 0);
  const read = (file: AsarFile, maxBytes = 64 * 1024 * 1024): Uint8Array => {
    if (file.offset === null)
      throw new AnalysisError(
        "not_found",
        `${file.path} is stored outside the archive (unpacked)`,
      );
    if (file.size > maxBytes)
      throw new AnalysisError(
        "too_large",
        `${file.path} is ${file.size} bytes (limit ${maxBytes})`,
      );
    const start = dataStart + file.offset;
    if (start + file.size > bytes.length)
      throw new AnalysisError(
        "malformed",
        `${file.path} extends past the archive`,
      );
    return bytes.subarray(start, start + file.size);
  };
  return {
    headerSize,
    files,
    read,
    find: (path) => files.find((f) => f.path === path.replace(/\\/g, "/")),
  };
}
