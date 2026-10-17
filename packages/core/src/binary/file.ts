import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { AnalysisError } from "../model.js";

/**
 * Reads a regular file of at most `maxBytes` through one file descriptor. The descriptor is
 * opened non-blocking and checked with fstat, so a FIFO, socket or device that took the file's
 * place (or was put there by a hostile archive layout) is refused instead of blocking or reading
 * without end, and the checked file is the one that is read.
 */
export function readRegularFile(path: string, maxBytes: number, label = path): Uint8Array {
  // `path` is already resolved by the caller (realpath, confined to a root). O_NOFOLLOW refuses a
  // link swapped in at the last component since then, and the descriptor must still be the file
  // the path names now (same device and inode), so a swap of a parent directory is caught too.
  const fd = openSync(
    path,
    constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new AnalysisError("invalid_input", `${label} is not a regular file`);
    let now: ReturnType<typeof statSync>;
    try {
      now = statSync(realpathSync(path));
    } catch {
      throw new AnalysisError("invalid_input", `${label} changed while it was opened`);
    }
    if (realpathSync(path) !== path || now.ino !== st.ino || now.dev !== st.dev)
      throw new AnalysisError("invalid_input", `${label} changed while it was opened`);
    if (st.size > maxBytes)
      throw new AnalysisError("too_large", `${label} is ${st.size} bytes (limit ${maxBytes})`);
    const out = new Uint8Array(st.size);
    let done = 0;
    while (done < out.length) {
      const n = readSync(fd, out, done, out.length - done, done);
      if (n === 0) break;
      done += n;
    }
    return out.subarray(0, done);
  } finally {
    closeSync(fd);
  }
}
