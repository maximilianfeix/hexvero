/**
 * Where the MCP server may write. The paths of `hexvero_export` and `hexvero_recover` are chosen
 * by an agent, and an agent reads text from the files it analyzes. The server therefore writes
 * only inside allowed roots (the working directory and the system temp directory, or the
 * directories in HEXVERO_WRITE_ROOTS; the working directory counts only when it is neither the
 * home directory nor the filesystem root), never into a hidden file or directory below a root, and an
 * export always ends in `.json`. The CLI is not limited: there a person chooses the path.
 */
import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { AnalysisError } from "@hexvero/core";

/**
 * The canonical path of an existing location: the native realpath also resolves volume mount
 * points and junctions on Windows and gives each name its case as stored, so `…\ROOT\a.json`
 * compares equal to a root `…\root` on a case-insensitive volume.
 */
const realpath = (p: string): string => realpathSync.native(p);

function roots(): string[] {
  const configured = (process.env["HEXVERO_WRITE_ROOTS"] ?? "")
    .split(delimiter)
    .map((p) => p.trim())
    .filter((p) => p && isAbsolute(p));
  // A server started from the home directory or from / must not treat all of it as writable.
  const cwd = resolve(process.cwd());
  const defaults = cwd === homedir() || dirname(cwd) === cwd ? [tmpdir()] : [cwd, tmpdir()];
  return (configured.length ? configured : defaults).flatMap((p) => {
    try {
      return [realpath(p)];
    } catch {
      return [];
    }
  });
}

/** Splits a path into its root and components the way the platform reads them. */
function split(path: string): { root: string; parts: string[] } {
  // A Windows link target may carry the \\?\ prefix; the rest is an ordinary absolute path.
  const plain = sep === "\\" && path.startsWith("\\\\?\\") ? path.slice(4) : path;
  const { root } = parse(plain);
  const parts = plain
    .slice(root.length)
    .split(sep === "\\" ? /[\\/]/ : "/")
    .filter(Boolean);
  return { root, parts };
}

/** At most this many links are followed for one path (Linux allows 40 as well). */
const MAX_LINKS = 40;

/**
 * Where a write to `path` would land, resolved the way the file system resolves it. Components
 * are taken one at a time: an existing one is examined with lstat; a symbolic link is replaced by
 * the components of its target, which are walked in turn (so a link whose target does not exist
 * yet still counts by where it points); `..` goes to the parent of the real location reached so
 * far, never to a textual parent, so `..` in a link target after a linked directory leads where
 * the file system leads. The input path itself is normalized as text first (`resolve()` removes
 * its `..`); that is the same absolute path the caller then writes to, so check and write agree.
 * Components that do not exist are taken as written; `..` or a link below one cannot be resolved
 * and is refused. The existing part is passed through the native realpath so it compares with the
 * roots (it also expands Windows short names and gives names their stored case).
 */
function realLocation(path: string): string {
  const refuse = (why: string): never => {
    throw new AnalysisError("invalid_input", `${path}: ${why}`, { path });
  };
  const start = split(resolve(path));
  let current = start.root;
  const pending = start.parts;
  // Set once a component does not exist: `current` is then the real existing directory and
  // `tail` what would be created below it.
  let tail: string[] | null = null;
  let links = 0;
  while (pending.length) {
    const part = pending.shift()!;
    if (part === ".") continue;
    if (tail) {
      if (part === "..") refuse("a path below a missing directory leaves it again");
      tail.push(part);
      continue;
    }
    if (part === "..") {
      current = dirname(current);
      continue;
    }
    const next = join(current, part);
    let link: boolean;
    try {
      link = lstatSync(next).isSymbolicLink();
    } catch {
      tail = [part];
      continue;
    }
    if (!link) {
      current = next;
      continue;
    }
    if (++links > MAX_LINKS) refuse("too many symbolic links");
    const target = split(readlinkSync(next));
    if (target.root) current = target.root;
    pending.unshift(...target.parts);
  }
  let real = current;
  try {
    real = realpath(current);
  } catch {
    refuse("the location could not be resolved");
  }
  return tail ? join(real, ...tail) : real;
}

/**
 * A directory where another user could swap an entry for a link between the check and the
 * write: not sticky, and owned by someone else or writable by everyone. (A shared temp root such
 * as /tmp is sticky, so only an entry's owner can rename or remove it there.)
 */
function swappable(dir: string): boolean {
  const uid = process.getuid?.();
  if (uid === undefined) return false; // Windows: no POSIX ownership to judge by
  try {
    const st = lstatSync(dir);
    if (!st.isDirectory() || st.mode & 0o1000) return false;
    return st.uid !== uid || (st.mode & 0o002) !== 0;
  } catch {
    return false;
  }
}

function resolveWrite(
  target: string,
  kind: "export" | "recover",
): { absolute: string; real: string } {
  const absolute = resolve(target);
  const allowed = roots();
  const refuse = (why: string): never => {
    throw new AnalysisError(
      "invalid_input",
      `${kind} refused for ${absolute}: ${why}. Allowed roots: ${allowed.join(", ")}; set HEXVERO_WRITE_ROOTS to change them, or use the CLI.`,
      { path: absolute },
    );
  };
  const real = realLocation(absolute);
  const root = allowed.find((r) => real === r || real.startsWith(r + sep));
  if (!root) refuse("the path is outside the allowed roots");
  const parts = relative(root!, real).split(sep).filter(Boolean);
  if (parts.some((part) => part.startsWith(".")))
    refuse("hidden files and directories are not written");
  if (kind === "export" && !real.toLowerCase().endsWith(".json"))
    refuse("an export must end in .json");
  // The root and every existing directory below it on the way to the target.
  let dir = root!;
  for (const part of ["", ...parts.slice(0, -1)]) {
    dir = part ? join(dir, part) : dir;
    if (swappable(dir))
      refuse(
        `${dir} can be changed by other users (not sticky, not owned by you or writable by all)`,
      );
  }
  return { absolute, real };
}

/** Checks a path an agent chose for `hexvero_export` or `hexvero_recover`; returns it absolute. */
export function checkWritePath(target: string, kind: "export" | "recover"): string {
  return resolveWrite(target, kind).absolute;
}

/**
 * After a file was opened for writing: the policy holds again for its path, and the file opened
 * is the one at the real location the policy resolved (same device and inode). Catches a
 * directory on the way that was swapped for a link between the check and the open.
 */
export function verifyOpened(
  target: string,
  kind: "export" | "recover",
  opened: { dev: number; ino: number },
): void {
  const { absolute, real } = resolveWrite(target, kind);
  let now: { dev: number; ino: number } | null = null;
  try {
    now = lstatSync(real);
  } catch {
    // checked below
  }
  if (!now || now.dev !== opened.dev || now.ino !== opened.ino)
    throw new AnalysisError(
      "invalid_input",
      `${kind} refused for ${absolute}: the path changed while it was opened`,
      { path: absolute },
    );
}

/**
 * Where the MCP server may read a policy or baseline (`hexvero_check`). The same roots as for
 * writes, plus the directories of the targets opened in the session (a policy usually sits next
 * to the builds it checks). Only `.json` files are read; a symlink that leads out of the roots is
 * refused, because the real path is what is checked. Hidden directories are allowed here
 * (`.github/hexvero-policy.json`), unlike for writes.
 */
export function checkReadPath(
  target: string,
  kind: "policy" | "baseline",
  extraDirs: readonly string[] = [],
): string {
  const absolute = resolve(target);
  const real = realLocation(absolute);
  const extra = extraDirs.flatMap((p) => {
    try {
      return [realpath(p)];
    } catch {
      return [];
    }
  });
  const allowed = [...new Set([...roots(), ...extra])];
  const refuse = (why: string): never => {
    throw new AnalysisError(
      "invalid_input",
      `${kind} refused for ${absolute}: ${why}. Allowed: ${allowed.join(", ")} (the write roots and the directories of opened targets); set HEXVERO_WRITE_ROOTS to change the roots, or use the CLI.`,
      { path: absolute },
    );
  };
  if (!allowed.some((r) => real === r || real.startsWith(r.endsWith(sep) ? r : r + sep)))
    refuse("the path is outside the allowed directories");
  if (!real.toLowerCase().endsWith(".json")) refuse(`a ${kind} file must end in .json`);
  return real;
}
