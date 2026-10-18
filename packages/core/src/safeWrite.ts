import { constants, lstatSync } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { AnalysisError } from "./model.js";

// Not defined on Windows; there the lstat check before opening is what refuses a link.
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const NONBLOCK = constants.O_NONBLOCK ?? 0;

export interface WriteFileOptions {
  /** Replace an existing file. Without it an existing path is refused (EEXIST). */
  overwrite?: boolean | undefined;
  /**
   * Inspect the first bytes of an existing file before it is replaced; return a reason to refuse
   * it, or null to replace it. Only a regular file can be inspected and replaced when this is set.
   */
  inspect?: ((head: string) => string | null) | undefined;
}

/** True when the last component of `path` is a symbolic link (dangling or not). */
export function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Writes `data` to `path` without following a symbolic link in the last component. A new file is
 * created exclusively (O_CREAT|O_EXCL, which never follows a link); an existing one is replaced
 * only with `overwrite`, opened with O_NOFOLLOW where the platform has it. Refusals are
 * AnalysisErrors with code invalid_input and `details.code` EEXIST, ELOOP, ENOTREG or EREFUSED;
 * other file system errors are passed on unchanged.
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
  if (isSymlink(path)) throw linkRefusal();
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o666);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (!options.overwrite) throw refuse("EEXIST", "exists; pass overwrite to replace it");
    // Either the file appeared or a link took its place since the check: O_NOFOLLOW refuses the link.
    if (isSymlink(path)) throw linkRefusal();
    const flags = options.inspect
      ? constants.O_RDWR | NOFOLLOW | NONBLOCK
      : constants.O_WRONLY | constants.O_TRUNC | NOFOLLOW;
    try {
      handle = await open(path, flags);
    } catch (reopen) {
      const code = (reopen as NodeJS.ErrnoException).code;
      if (code === "ELOOP" || code === "EMLINK") throw linkRefusal();
      throw reopen;
    }
    if (options.inspect) {
      try {
        if (!(await handle.stat()).isFile())
          throw refuse("ENOTREG", "is not a regular file; it is not replaced");
        const head = Buffer.alloc(64);
        const { bytesRead } = await handle.read(head, 0, head.length, 0);
        const why = options.inspect(head.subarray(0, bytesRead).toString("utf8"));
        if (why) throw refuse("EREFUSED", why);
        await handle.truncate(0);
      } catch (refused) {
        await handle.close();
        throw refused;
      }
    }
  }
  try {
    await handle.writeFile(data);
  } finally {
    await handle.close();
  }
}
