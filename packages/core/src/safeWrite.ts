import { constants, lstatSync, unlinkSync, type Stats } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { AnalysisError } from "./model.js";

// Not defined on Windows; there the lstat check before opening is what refuses a link.
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const NONBLOCK = constants.O_NONBLOCK ?? 0;
const NOCTTY = constants.O_NOCTTY ?? 0;

export interface WriteFileOptions {
  /** Replace an existing file. Without it an existing path is refused (EEXIST). */
  overwrite?: boolean | undefined;
  /**
   * Inspect the first bytes of an existing file before it is replaced; return a reason to refuse
   * it, or null to replace it. When this is set only a regular file with one link (no other hard
   * link to it elsewhere) is inspected and replaced, and streams are not written to.
   */
  inspect?: ((head: string) => string | null) | undefined;
  /** Called right before each open; throw to refuse (re-check a write policy at the last moment). */
  beforeOpen?: (() => void) | undefined;
  /**
   * Called with fstat of the opened file before anything is written or truncated; throw to
   * refuse (compare device and inode with where the policy says the path lands). A file this
   * call created is removed again.
   */
  afterOpen?: ((opened: Stats) => void) | undefined;
}

/**
 * Output names that stand for a stream of this process: `-` (standard output), `/dev/stdout`,
 * `/dev/stderr`, `/dev/null` and `/dev/fd/N` (also what process substitution passes). Only these
 * are opened through a link, and only a terminal, pipe or device behind them is written to.
 */
const STREAM_NAME = /^\/dev\/(?:stdout|stderr|null|fd\/\d+)$/;

/** True for `-` and the stream names above: a path that is not resolved against a directory. */
export function isStreamName(path: string): boolean {
  return path === "-" || STREAM_NAME.test(path);
}

/** True when the last component of `path` is a symbolic link (dangling or not). */
export function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Writes all of `data` to standard output. */
function writeStdout(data: string | Uint8Array): Promise<void> {
  return new Promise((done, fail) => {
    process.stdout.write(data, (error) => (error ? fail(error) : done()));
  });
}

/**
 * Writes `data` to `path` without following a symbolic link in the last component.
 *
 * A stream named as such (`-`, `/dev/stdout`, `/dev/stderr`, `/dev/null`, `/dev/fd/N`; not with
 * `inspect`) is opened once and written to only when fstat of that descriptor says it is a
 * character device or FIFO; a regular file behind such a name is refused. Every other path: a
 * new file is created exclusively (O_CREAT|O_EXCL, which never follows a link); an existing one
 * is replaced only with `overwrite`, opened with O_NOFOLLOW where the platform has it. Refusals
 * are AnalysisErrors with code invalid_input and `details.code` EEXIST, ELOOP, ENOTREG, ENXIO,
 * EMLINK or EREFUSED; other file system errors are passed on unchanged.
 */
export async function writeFileNoFollow(
  path: string,
  data: string | Uint8Array,
  options: WriteFileOptions = {},
): Promise<void> {
  const refuse = (code: string, why: string): AnalysisError =>
    new AnalysisError("invalid_input", `${path} ${why}`, { path, code });
  const linkRefusal = (): AnalysisError =>
    refuse("ELOOP", "is a symbolic link; hexvero does not write through one");
  const opening = async (flags: number, mode?: number): Promise<FileHandle> => {
    options.beforeOpen?.();
    return open(path, flags, mode);
  };

  if (!options.inspect && path === "-") return writeStdout(data);
  if (!options.inspect && STREAM_NAME.test(path)) {
    let stream: FileHandle;
    try {
      // Never blocks: a FIFO with no reader fails with ENXIO instead.
      stream = await opening(constants.O_WRONLY | NONBLOCK | NOCTTY);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENXIO")
        throw refuse("ENXIO", "is a pipe that nothing reads");
      throw error;
    }
    try {
      const st = await stream.stat();
      if (!st.isCharacterDevice() && !st.isFIFO())
        throw refuse(
          "ENOTREG",
          "is not a terminal, pipe or device; name the file itself, or - for standard output",
        );
      await writeAll(stream, typeof data === "string" ? Buffer.from(data) : data);
    } finally {
      await stream.close();
    }
    return;
  }

  if (isSymlink(path)) throw linkRefusal();
  const careful = options.inspect !== undefined || options.afterOpen !== undefined;
  let handle: FileHandle;
  let created = false;
  try {
    handle = await opening(constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o666);
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (!options.overwrite) throw refuse("EEXIST", "exists; pass overwrite to replace it");
    // Either the file appeared or a link took its place since the check: O_NOFOLLOW refuses the link.
    if (isSymlink(path)) throw linkRefusal();
    // A careful replace truncates only after the checks on the opened file.
    const flags = careful
      ? constants.O_RDWR | NOFOLLOW | NONBLOCK
      : constants.O_WRONLY | constants.O_TRUNC | NOFOLLOW;
    try {
      handle = await opening(flags);
    } catch (reopen) {
      const code = (reopen as NodeJS.ErrnoException).code;
      if (code === "ELOOP" || code === "EMLINK") throw linkRefusal();
      throw reopen;
    }
  }
  try {
    if (careful) {
      const st = await handle.stat();
      options.afterOpen?.(st);
      if (!created && options.inspect) {
        if (!st.isFile()) throw refuse("ENOTREG", "is not a regular file; it is not replaced");
        if (st.nlink > 1)
          throw refuse("EMLINK", "has other hard links; replacing it would change them too");
        const head = Buffer.alloc(64);
        const { bytesRead } = await handle.read(head, 0, head.length, 0);
        const why = options.inspect(head.subarray(0, bytesRead).toString("utf8"));
        if (why) throw refuse("EREFUSED", why);
      }
      if (!created) await handle.truncate(0);
    }
  } catch (refused) {
    const opened = await handle.stat().catch(() => null);
    await handle.close();
    // Remove only the empty file this call created, and only if the path still names it.
    if (created && opened) {
      try {
        const now = lstatSync(path);
        if (now.dev === opened.dev && now.ino === opened.ino && now.size === 0) unlinkSync(path);
      } catch {
        // gone already
      }
    }
    throw refused;
  }
  try {
    await handle.writeFile(data);
  } finally {
    await handle.close();
  }
}

/** Writes all bytes to a stream opened non-blocking, waiting while a pipe is full (EAGAIN). */
async function writeAll(handle: FileHandle, bytes: Uint8Array): Promise<void> {
  let done = 0;
  let waits = 0;
  while (done < bytes.length) {
    try {
      const { bytesWritten } = await handle.write(bytes, done, bytes.length - done);
      done += bytesWritten;
      waits = 0;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EAGAIN" || ++waits > 30_000) throw error;
      await new Promise((r) => setTimeout(r, 10));
    }
  }
}
