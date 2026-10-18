import {
  constants,
  fstatSync,
  lstatSync,
  statSync,
  unlinkSync,
  writeSync,
  type Stats,
} from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { AnalysisError } from "./model.js";

// Not defined on Windows; there the lstat check before opening is what refuses a link.
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const NONBLOCK = constants.O_NONBLOCK ?? 0;
const WINDOWS = process.platform === "win32";

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
 * are opened through a link: the kernel makes them, and the user named one.
 */
const STREAM_NAME = /^\/dev\/(?:stdout|stderr|null|fd\/\d+)$/;

/** True for `-` and the stream names above: a path that is not resolved against a directory. */
export function isStreamName(path: string): boolean {
  return path === "-" || STREAM_NAME.test(path);
}

/**
 * True when writing to `path` writes to this process's standard output: `-`, `/dev/stdout`,
 * `/dev/fd/1`, or a path that is the same file as descriptor 1 (`--out x > x`). The CLI then
 * prints its own summary to stderr, so the output stays parseable.
 */
export function isStdout(path: string): boolean {
  if (path === "-" || path === "/dev/stdout" || path === "/dev/fd/1") return true;
  try {
    const a = statSync(path);
    const b = fstatSync(1);
    return a.dev === b.dev && a.ino === b.ino;
  } catch {
    return false;
  }
}

/** A reader that went away (`| head`): the rest of the output is not wanted. */
const gone = (error: unknown): boolean => (error as NodeJS.ErrnoException | null)?.code === "EPIPE";

/** True when the last component of `path` is a symbolic link (dangling or not). */
export function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Writes all of `data` to a stream of this process (stdout, stderr). */
function writeStream(stream: NodeJS.WriteStream, data: string | Uint8Array): Promise<void> {
  return new Promise((done, fail) => {
    stream.write(data, (error) => (error && !gone(error) ? fail(error) : done()));
  });
}

/** Writes all of `data` to standard output. */
const writeStdout = (data: string | Uint8Array): Promise<void> => writeStream(process.stdout, data);

/**
 * Writes `data` to `path` without following a symbolic link in the last component.
 *
 * A stream named as such (`-`, `/dev/stdout`, `/dev/stderr`, `/dev/null`, `/dev/fd/N`; not with
 * `inspect`) writes to the descriptor of this process it names (1, 2 or N) as the shell connected
 * it: a terminal, pipe, socket or the regular file of a redirection (`> out.json`). Every other path: a
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
  const opening = async (flags: number | string, mode?: number): Promise<FileHandle> => {
    options.beforeOpen?.();
    return open(path, flags, mode);
  };

  if (!options.inspect && path === "-") return writeStdout(data);
  if (!options.inspect && STREAM_NAME.test(path)) {
    // /dev/stdout, /dev/stderr and /dev/fd/N name a descriptor this process already has. It is
    // written as it is, not opened again: on Linux they are links to `pipe:[n]` or `socket:[n]`,
    // which cannot be opened (a socket gives ENXIO). Whatever the shell connected there is the
    // output, a regular file of a redirection included (`--out /dev/stdout > out.json`).
    const named = /^\/dev\/(?:std(out|err)|fd\/(\d+))$/.exec(path);
    const fd = named ? (named[1] === "out" ? 1 : named[1] === "err" ? 2 : Number(named[2])) : null;
    if (fd === 1) return writeStdout(data);
    if (fd === 2) return writeStream(process.stderr, data);
    if (fd !== null) {
      let st: Stats;
      try {
        st = fstatSync(fd);
      } catch {
        throw refuse("EBADF", "is not an open descriptor of this process");
      }
      if (!st.isCharacterDevice() && !st.isFIFO() && !st.isFile() && !st.isSocket())
        throw refuse("ENOTREG", "is not a file, terminal, pipe, socket or device");
      return writeFd(fd, typeof data === "string" ? Buffer.from(data) : data);
    }
    // /dev/null: a device node of its own
    const sink = await opening(constants.O_WRONLY);
    try {
      await sink.writeFile(data);
    } finally {
      await sink.close();
    }
    return;
  }

  if (isSymlink(path)) throw linkRefusal();
  const careful = options.inspect !== undefined || options.afterOpen !== undefined;
  let handle: FileHandle;
  let created = false;
  try {
    handle = await opening("wx", 0o666);
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (!options.overwrite) throw refuse("EEXIST", "exists; pass overwrite to replace it");
    // Either the file appeared or a link took its place since the check: O_NOFOLLOW refuses the link.
    if (isSymlink(path)) throw linkRefusal();
    // Truncated only after the checks on the opened file. Windows has neither O_NOFOLLOW nor
    // O_NONBLOCK, and its open refuses some numeric flag sets (EINVAL): "r+" there, with the
    // lstat right before as the link check.
    const flags = WINDOWS ? "r+" : constants.O_RDWR | NOFOLLOW | NONBLOCK;
    try {
      handle = await opening(flags);
    } catch (reopen) {
      const code = (reopen as NodeJS.ErrnoException).code;
      if (code === "ELOOP" || code === "EMLINK") throw linkRefusal();
      // a FIFO nothing reads, opened non-blocking: not a file either way
      if (code === "ENXIO")
        throw refuse(
          "ENOTREG",
          "is not a regular file; name a stream as -, /dev/stdout or /dev/fd/N",
        );
      throw reopen;
    }
  }
  try {
    // Only a stream name is written to as a stream: a FIFO or device at any other path is
    // refused (opened non-blocking above, so a FIFO without a reader does not hang).
    if (!created && !(await handle.stat()).isFile())
      throw refuse(
        "ENOTREG",
        "is not a regular file; name a stream as -, /dev/stdout or /dev/fd/N",
      );
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
    }
    if (!created) await handle.truncate(0);
  } catch (refused) {
    const opened = await handle.stat().catch(() => null);
    await handle.close();
    // Remove only the empty file this call created, and only if the path still names it.
    if (created && opened) {
      try {
        const now = lstatSync(path);
        // a volume without file IDs reports inode 0: then only the size is compared
        const ids = now.ino !== 0 && opened.ino !== 0;
        const same = !ids || (now.dev === opened.dev && now.ino === opened.ino);
        if (same && now.size === 0) unlinkSync(path);
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

/** Writes all bytes to a descriptor of this process, waiting while a pipe is full (EAGAIN). */
async function writeFd(fd: number, bytes: Uint8Array): Promise<void> {
  let done = 0;
  let waits = 0;
  while (done < bytes.length) {
    try {
      done += writeSync(fd, bytes, done, bytes.length - done);
      waits = 0;
    } catch (error) {
      if (gone(error)) return;
      if ((error as NodeJS.ErrnoException).code !== "EAGAIN" || ++waits > 30_000) throw error;
      await new Promise((r) => setTimeout(r, 10));
    }
  }
}
