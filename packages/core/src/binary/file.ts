import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { AnalysisError } from "../model.js";

/**
 * Reads a regular file of at most `maxBytes` through one file descriptor. The descriptor is
 * opened non-blocking and checked with fstat, so a FIFO, socket or device that took the file's
 * place (or was put there by a hostile archive layout) is refused instead of blocking or reading
 * without end, and the checked file is the one that is read.
 */
export function readRegularFile(path: string, maxBytes: number, label = path): Uint8Array {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new AnalysisError("invalid_input", `${label} is not a regular file`);
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
