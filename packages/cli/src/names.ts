import type { Session, TargetInfo } from "@hexvero/core";

const segments = (path: string): string[] => path.split(/[\\/]/).filter(Boolean);

/** The path a build was given as: the packaged build for an app found inside one. */
const givenPath = (info: TargetInfo): string => info.container?.path ?? info.path;

/**
 * Names that tell two builds apart in a header. Their file names when those differ; when both
 * are called the same (two `app.asar`), the file name with the app's package.json name and
 * version when those differ, else with as many parent directories as it takes.
 */
export async function buildNames(
  session: Session,
  idA: string,
  idB: string,
): Promise<{ a: string; b: string; sameName?: true }> {
  const [infoA, infoB] = [session.get(idA).info, session.get(idB).info];
  const [pathA, pathB] = [segments(givenPath(infoA)), segments(givenPath(infoB))];
  const [nameA, nameB] = [pathA.at(-1) ?? "", pathB.at(-1) ?? ""];
  if (nameA !== nameB) return { a: nameA, b: nameB };
  const pkg = async (id: string): Promise<string | null> => {
    const { data } = await session.analyze(id);
    const p = data.kind === "javascript-app" ? data.app.package : null;
    return p && (p.name || p.version) ? [p.name, p.version].filter(Boolean).join(" ") : null;
  };
  const [pkgA, pkgB] = await Promise.all([pkg(idA), pkg(idB)]);
  if (pkgA && pkgB && pkgA !== pkgB)
    return { a: `${nameA} (${pkgA})`, b: `${nameB} (${pkgB})`, sameName: true };
  // the shortest tails of both paths that differ
  for (let n = 2; n <= Math.max(pathA.length, pathB.length); n++) {
    const [tailA, tailB] = [pathA.slice(-n).join("/"), pathB.slice(-n).join("/")];
    if (tailA !== tailB) return { a: tailA, b: tailB, sameName: true };
  }
  return { a: nameA, b: nameB, sameName: true };
}
