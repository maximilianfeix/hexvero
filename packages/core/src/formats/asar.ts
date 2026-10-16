import { closeSync, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { basename, join, sep } from "node:path";
import { readRegularFile } from "../binary/file.js";
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
  const { headerSize, files, dataStart } = parseHeader(bytes.subarray(0, 16), (off, len) =>
    bytes.subarray(off, off + len),
  );
  const read = (file: AsarFile, maxBytes = 64 * 1024 * 1024): Uint8Array => {
    checkReadable(file, maxBytes);
    if (file.offset === null || file.offset < 0)
      throw new AnalysisError("malformed", `${file.path} has no valid offset`);
    const start = dataStart + file.offset!;
    if (start + file.size > bytes.length)
      throw new AnalysisError("malformed", `${file.path} extends past the archive`);
    return bytes.subarray(start, start + file.size);
  };
  return {
    headerSize,
    files,
    read,
    find: (path) => files.find((f) => f.path === path.replace(/\\/g, "/")),
  };
}

/** Same archive view, but reading from disk on demand so multi-gigabyte ASARs never load fully. */
export function openAsarFile(path: string): AsarArchive {
  const fd = openSync(path, "r");
  const fileSize = fstatSync(fd).size;
  // Never allocate more than the file can supply: a forged header length must not cost memory.
  const readAt = (off: number, len: number): Uint8Array => {
    const out = new Uint8Array(Math.max(0, Math.min(len, fileSize - off)));
    const n = readSync(fd, out, 0, out.length, off);
    return out.subarray(0, n);
  };
  let header: ReturnType<typeof parseHeader>;
  try {
    header = parseHeader(readAt(0, 16), readAt);
  } finally {
    closeSync(fd);
  }
  const { headerSize, files, dataStart } = header;
  const read = (file: AsarFile, maxBytes = 64 * 1024 * 1024): Uint8Array => {
    checkReadable(file, maxBytes);
    if (file.offset === null || file.offset < 0)
      throw new AnalysisError("malformed", `${file.path} has no valid offset`);
    const h = openSync(path, "r");
    try {
      const out = new Uint8Array(file.size);
      const n = readSync(h, out, 0, file.size, dataStart + file.offset!);
      if (n < file.size)
        throw new AnalysisError("malformed", `${file.path} extends past the archive`);
      return out;
    } finally {
      closeSync(h);
    }
  };
  return {
    headerSize,
    files,
    read,
    find: (p) => files.find((f) => f.path === p.replace(/\\/g, "/")),
  };
}

/**
 * A file the archive lists as unpacked, read from `<archive>.unpacked/` next to it, where
 * Electron puts such files. The path is resolved and must stay inside that directory; links that
 * lead out of it are refused. Throws `not_found` when the directory or the file is missing.
 */
export function readUnpacked(archivePath: string, file: AsarFile, maxBytes: number): Uint8Array {
  const dir = `${archivePath}.unpacked`;
  let root: string;
  try {
    root = realpathSync(dir);
  } catch {
    throw new AnalysisError(
      "not_found",
      `${file.path} is stored in ${basename(dir)}, which is not next to the archive`,
      { unpacked: true },
    );
  }
  let real: string;
  try {
    real = realpathSync(join(dir, ...file.path.split("/")));
  } catch {
    throw new AnalysisError("not_found", `${file.path} is missing from ${basename(dir)}`, {
      unpacked: true,
    });
  }
  if (real !== root && !real.startsWith(root + sep))
    throw new AnalysisError("invalid_input", `${file.path} resolves outside ${basename(dir)}`);
  return readRegularFile(real, maxBytes, file.path);
}

function checkReadable(file: AsarFile, maxBytes: number): void {
  if (file.offset === null)
    throw new AnalysisError("not_found", `${file.path} is stored outside the archive (unpacked)`);
  if (file.size > maxBytes)
    throw new AnalysisError("too_large", `${file.path} is ${file.size} bytes (limit ${maxBytes})`);
}

function parseHeader(
  prefix: Uint8Array,
  readAt: (offset: number, length: number) => Uint8Array,
): { headerSize: number; files: AsarFile[]; dataStart: number } {
  if (prefix.length < 16) throw new AnalysisError("malformed", "ASAR header truncated");
  const r = new ByteReader(prefix, 0, true);
  r.u32(); // pickle size header (always 4)
  const headerSize = r.u32();
  r.u32(); // string pickle size
  const jsonLength = r.u32();
  if (jsonLength > headerSize || jsonLength > 256 * 1024 * 1024)
    throw new AnalysisError("malformed", "ASAR header length out of range");
  const jsonBytes = readAt(16, jsonLength);
  if (jsonBytes.length < jsonLength) throw new AnalysisError("malformed", "ASAR header truncated");
  let tree: Node;
  try {
    tree = JSON.parse(utf8String(jsonBytes));
  } catch {
    throw new AnalysisError("malformed", "ASAR header is not valid JSON");
  }
  const files: AsarFile[] = [];
  const walk = (node: Node, prefixPath: string, depth: number): void => {
    if (depth > 64 || !node.files) return;
    for (const [name, child] of Object.entries(node.files)) {
      const filePath = prefixPath ? `${prefixPath}/${name}` : name;
      if (child.files) {
        walk(child, filePath, depth + 1);
        continue;
      }
      if (child.link !== undefined) continue;
      files.push({
        path: filePath,
        size: child.size ?? 0,
        offset: child.offset !== undefined && !child.unpacked ? safeOffset(child.offset) : null,
        unpacked: Boolean(child.unpacked),
        executable: Boolean(child.executable),
        integrity: child.integrity?.hash ?? null,
      });
    }
  };
  walk(tree, "", 0);
  return { headerSize, files, dataStart: 8 + headerSize };
}

/** ASAR offsets are JSON strings; anything but a non-negative safe integer is treated as absent. */
function safeOffset(raw: unknown): number | null {
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}
