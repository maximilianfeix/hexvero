/**
 * Where the MCP server may write. The paths of `hexvero_export` and `hexvero_recover` are chosen
 * by an agent, and an agent reads text from the files it analyzes. The server therefore writes
 * only inside allowed roots (the working directory and the system temp directory, or the
 * directories in HEXVERO_WRITE_ROOTS; the working directory counts only when it is neither the
 * home directory nor the filesystem root), never into a hidden file or directory below a root, and an
 * export always ends in `.json`. The CLI is not limited: there a person chooses the path.
 */
import { existsSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, relative, resolve, sep } from "node:path";
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

/** The real path of a location that may not exist yet, through its nearest existing parent. */
function realLocation(path: string): string {
  const missing: string[] = [];
  let current = path;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    missing.unshift(basename(current));
    current = parent;
  }
  return resolve(realpathSync(current), ...missing);
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
