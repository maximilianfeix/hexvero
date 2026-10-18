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
      return [realpathSync(p)];
    } catch {
      return [];
    }
  });
}

/**
 * Where a write to `path` would land: every existing component is examined with lstat and each
 * symbolic link is followed by reading it, so a link whose target does not exist yet (which
 * realpath cannot resolve) still counts by where it points. Components that do not exist are
 * taken as written. The existing part is passed through realpath so it compares with the roots.
 */
// In realLocation, a location is either an existing directory whose links are resolved, or one
// below a link target that does not exist (then there is nothing left to resolve).
function realOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function realLocation(path: string): string {
  let hops = 0;
  const walk = (target: string): string => {
    const absolute = resolve(target);
    const { root } = parse(absolute);
    const parts = absolute.slice(root.length).split(sep).filter(Boolean);
    let current = root;
    for (let i = 0; i < parts.length; i++) {
      const next = join(current, parts[i]!);
      let link = false;
      try {
        link = lstatSync(next).isSymbolicLink();
      } catch {
        // realpath also expands short names (Windows), so the result compares with the roots
        return resolve(realOrSelf(current), ...parts.slice(i));
      }
      if (!link) {
        current = next;
        continue;
      }
      if (++hops > 40)
        throw new AnalysisError("invalid_input", `too many symbolic links in ${path}`, { path });
      current = walk(resolve(current, readlinkSync(next)));
    }
    return realOrSelf(current);
  };
  return walk(path);
}

export function checkWritePath(target: string, kind: "export" | "recover"): string {
  const absolute = resolve(target);
  const real = realLocation(absolute);
  const allowed = roots();
  const root = allowed.find((r) => real === r || real.startsWith(r + sep));
  const refuse = (why: string): never => {
    throw new AnalysisError(
      "invalid_input",
      `${kind} refused for ${absolute}: ${why}. Allowed roots: ${allowed.join(", ")}; set HEXVERO_WRITE_ROOTS to change them, or use the CLI.`,
      { path: absolute },
    );
  };
  if (!root) refuse("the path is outside the allowed roots");
  const parts = relative(root!, real).split(sep).filter(Boolean);
  if (parts.some((part) => part.startsWith(".")))
    refuse("hidden files and directories are not written");
  if (kind === "export" && !real.toLowerCase().endsWith(".json"))
    refuse("an export must end in .json");
  return absolute;
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
      return [realpathSync(p)];
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
