/**
 * Finding the Electron application inside a packaged build: a macOS `.app`, a Windows or Linux
 * install directory, or an archive of either. Nothing is executed; only names, file types and
 * (for an `.asar`) the archive header are read.
 *
 * Electron itself decides which application it runs (`lib/browser/init.ts`): in its resources
 * directory (`process.resourcesPath`) it tries `app`, then `app.asar`, then `default_app.asar`,
 * and runs the first one whose `package.json` it can load. hexvero applies the same order.
 */
import { realpathSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { openAsarFile } from "./asar.js";
import type { ZipEntry } from "./zip.js";

/** Electron's search order in its resources directory. */
export const ELECTRON_SEARCH = ["app", "app.asar", "default_app.asar"] as const;

/**
 * Files a Chromium-based runtime ships next to its executable on Windows and Linux. A directory
 * with `resources/app.asar` is taken as an install directory only when one of these is there too,
 * so a source tree that happens to have a `resources/` folder is still read as source.
 */
export const RUNTIME_MARKERS = [
  "resources.pak",
  "chrome_100_percent.pak",
  "icudtl.dat",
  "v8_context_snapshot.bin",
  "snapshot_blob.bin",
] as const;

export interface ElectronLocation {
  /** The application, relative to the bundle, directory or archive, with `/` separators. */
  entry: string;
  /** An `.asar` archive or an `app/` directory. */
  kind: "asar" | "directory";
  /** `macos`: `<name>.app/Contents/Resources`; `windows-linux`: `resources/` beside the runtime. */
  layout: "macos" | "windows-linux";
  /** Set when something else was there too: what it was and why `entry` was taken. */
  note?: string;
}

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};
const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/** True when `path` resolves to a place inside `root` (links that lead out are not followed). */
function inside(root: string, path: string): boolean {
  try {
    const real = realpathSync(path);
    const base = realpathSync(root);
    return real === base || real.startsWith(base + sep);
  } catch {
    return false;
  }
}

/** Whether Electron could load `package.json` from this candidate; `null`: the header is unreadable. */
function hasPackageJson(path: string, kind: "asar" | "directory"): boolean | null {
  if (kind === "directory") return isFile(join(path, "package.json"));
  try {
    return openAsarFile(path).find("package.json") !== undefined;
  } catch {
    return null;
  }
}

const label = (name: string): string => (name === "app" ? "app/" : name);

function sentence(resources: string, chosen: string, others: string[], skipped: string[]): string {
  const parts = [
    `Electron runs the first of app/, app.asar and default_app.asar in ${resources} that has a package.json: ${label(chosen)}.`,
  ];
  if (skipped.length) parts.push(`Passed over (no package.json): ${skipped.join(", ")}.`);
  if (others.length) parts.push(`Also there, not run by Electron: ${others.join(", ")}.`);
  return parts.join(" ");
}

/**
 * The Electron application of a macOS `.app` or a Windows/Linux install directory, or null when
 * the directory is neither (then it is read as it is today).
 */
export function findElectronApp(dir: string): ElectronLocation | null {
  const layouts: Array<{ resources: string; layout: ElectronLocation["layout"] }> = [];
  // A bundle without its Info.plist (copied in part) is still laid out by its name.
  if (
    isFile(join(dir, "Contents", "Info.plist")) ||
    (dir.endsWith(".app") && isDirectory(join(dir, "Contents", "Resources")))
  )
    layouts.push({ resources: "Contents/Resources", layout: "macos" });
  if (isDirectory(join(dir, "resources")) && RUNTIME_MARKERS.some((m) => isFile(join(dir, m))))
    layouts.push({ resources: "resources", layout: "windows-linux" });
  for (const { resources, layout } of layouts) {
    const base = join(dir, ...resources.split("/"));
    const present: Array<{ name: string; kind: "asar" | "directory"; ok: boolean | null }> = [];
    for (const name of ELECTRON_SEARCH) {
      const path = join(base, name);
      const kind = name === "app" ? "directory" : "asar";
      if (kind === "directory" ? !isDirectory(path) : !isFile(path)) continue;
      // a link that leads out of the bundle is not part of it
      if (!inside(dir, path)) continue;
      present.push({ name, kind, ok: hasPackageJson(path, kind) });
    }
    if (present.length === 0) continue;
    // An archive whose header cannot be read is taken anyway, so the analysis says why it fails
    // instead of silently reading the next candidate.
    const chosen = present.find((p) => p.ok !== false);
    if (!chosen) continue;
    const skipped = present.slice(0, present.indexOf(chosen)).map((p) => label(p.name));
    const others = present.slice(present.indexOf(chosen) + 1).map((p) => label(p.name));
    return {
      entry: `${resources}/${chosen.name}`,
      kind: chosen.kind,
      layout,
      ...(skipped.length || others.length
        ? { note: sentence(resources, chosen.name, others, skipped) }
        : {}),
    };
  }
  return null;
}

/** A name from an archive that can stand for a path inside it: relative, no `..`, no `\`. */
const safeName = (name: string): boolean =>
  !name.startsWith("/") &&
  !/[\\\0]/.test(name) &&
  !name.split("/").some((part) => part === ".." || part === ".");

/**
 * The Electron application inside a ZIP archive of a packaged build (`Name.app/…` from a macOS
 * release, or an install directory with `resources/app.asar` beside the runtime). With several
 * applications in one archive, the one nearest the archive root is taken and the others are
 * named in `note`.
 */
export function findElectronAppInZip(entries: readonly ZipEntry[]): ElectronLocation | null {
  const names = new Set(entries.filter((e) => safeName(e.name)).map((e) => e.name));
  const groups = new Map<string, ElectronLocation["layout"]>();
  for (const name of names) {
    const mac =
      /^(.*?[^/]+\.app\/Contents\/Resources)\/(?:app\.asar|default_app\.asar|app\/package\.json)$/.exec(
        name,
      );
    if (mac) {
      groups.set(mac[1]!, "macos");
      continue;
    }
    const win = /^((?:.*\/)?resources)\/(?:app\.asar|default_app\.asar|app\/package\.json)$/.exec(
      name,
    );
    if (!win) continue;
    const root = win[1]!.slice(0, -"resources".length);
    if (RUNTIME_MARKERS.some((m) => names.has(`${root}${m}`))) groups.set(win[1]!, "windows-linux");
  }
  const found: ElectronLocation[] = [];
  for (const [resources, layout] of groups) {
    const present = ELECTRON_SEARCH.filter((name) =>
      names.has(name === "app" ? `${resources}/app/package.json` : `${resources}/${name}`),
    );
    const chosen = present[0]!;
    const others = present.slice(1).map(label);
    found.push({
      entry: `${resources}/${chosen}`,
      kind: chosen === "app" ? "directory" : "asar",
      layout,
      ...(others.length ? { note: sentence(resources, chosen, others, []) } : {}),
    });
  }
  if (found.length === 0) return null;
  // the depth of the build itself: the `.app`, or the install directory
  const depth = (l: ElectronLocation): number =>
    l.entry.split("/").length - (l.layout === "macos" ? 3 : 2);
  found.sort((a, b) => depth(a) - depth(b) || (a.entry < b.entry ? -1 : 1));
  const [first, ...rest] = found;
  if (rest.length === 0) return first!;
  const more = `The archive holds ${found.length} Electron applications; the one nearest its root was read, not ${rest.map((l) => l.entry).join(", ")}.`;
  return { ...first!, note: first!.note ? `${first!.note} ${more}` : more };
}
