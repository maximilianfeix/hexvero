/**
 * Finding the Electron application inside a packaged build: a macOS `.app`, a Windows or Linux
 * install directory, or an archive of either. Nothing is executed; only names, file types and
 * (for an `.asar`) the archive header are read.
 *
 * Electron itself decides which application it runs (`lib/browser/init.ts`): in its resources
 * directory (`process.resourcesPath`) it tries `app`, then `app.asar`, then `default_app.asar`,
 * and runs the first one whose `package.json` it can load. hexvero applies the same order.
 */
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { openAsar, openAsarFile, type AsarArchive } from "./asar.js";
import type { ZipArchive } from "./zip.js";

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

/**
 * A runtime binary next to them: an `.exe`, or a file every Electron build for Linux or Windows
 * ships. A source tree with a copied `icudtl.dat` has none of these.
 */
const RUNTIME_BINARY = (name: string): boolean =>
  /\.exe$/i.test(name) ||
  ["ffmpeg.dll", "libffmpeg.so", "chrome-sandbox", "chrome_crashpad_handler"].includes(name);

/** package.json files larger than this are not parsed; the candidate is taken as it is. */
const MAX_PACKAGE_JSON = 1 << 20;

export interface ElectronLocation {
  /** The application, relative to the bundle, directory or archive, with `/` separators. */
  entry: string;
  /** An `.asar` archive or an `app/` directory. */
  kind: "asar" | "directory";
  /** `macos`: `<name>.app/Contents/Resources`; `windows-linux`: `resources/` beside the runtime. */
  layout: "macos" | "windows-linux";
  /** Set when something else was there too: what it was and why `entry` was taken. */
  note?: string;
  /** Set when what Electron runs may be another candidate (a fuse hexvero does not read). */
  warning?: string;
  /**
   * Set when the app at `entry` is not read: a link out of the bundle, an entry a ZIP holds
   * twice, an archive that is not one. The build is then read as it is, with this reason.
   */
  refused?: string;
  /** For an `.asar` read out of a ZIP: its bytes. */
  bytes?: Uint8Array;
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
const exists = (path: string): boolean => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

/** Where `path` resolves to when that is outside `root`; null when it stays inside. */
function outside(root: string, path: string): string | null {
  try {
    const real = realpathSync(path);
    const base = realpathSync(root);
    return real === base || real.startsWith(base + sep) ? null : real;
  } catch {
    return null; // a dangling link: nothing to read there, handled as absent
  }
}

/**
 * What a candidate's package.json is. `missing`, `invalid` (not JSON, or unreadable) and
 * `oversized` (larger than MAX_PACKAGE_JSON, not parsed) are passed over, on disk and in a ZIP
 * alike; `unchecked` (an archive whose header or package.json hexvero cannot read) is taken, so
 * the analysis says what is wrong, and the note says it was not checked; `outside`: the file is
 * a link out of the bundle, and the pick stops there.
 */
type PackageState = "valid" | "missing" | "invalid" | "oversized" | "unchecked" | "outside";

const parses = (bytes: Uint8Array): boolean => {
  try {
    JSON.parse(new TextDecoder("utf-8", { fatal: false }).decode(bytes));
    return true;
  } catch {
    return false;
  }
};

function packageInAsar(archive: AsarArchive): PackageState {
  const entry = archive.find("package.json");
  if (!entry) return "missing";
  if (entry.size > MAX_PACKAGE_JSON) return "oversized";
  if (entry.unpacked) return "unchecked";
  try {
    return parses(archive.read(entry, MAX_PACKAGE_JSON)) ? "valid" : "invalid";
  } catch {
    return "invalid";
  }
}

function packageOnDisk(path: string, kind: "asar" | "directory", root: string): PackageState {
  if (kind === "asar") {
    try {
      return packageInAsar(openAsarFile(path));
    } catch {
      return "unchecked"; // an unreadable header: the analysis says why
    }
  }
  const file = join(path, "package.json");
  if (!isFile(file)) return "missing";
  if (outside(root, file) !== null) return "outside";
  try {
    if (statSync(file).size > MAX_PACKAGE_JSON) return "oversized";
    return parses(readFileSync(file)) ? "valid" : "invalid";
  } catch {
    return "invalid";
  }
}

const label = (name: string): string => (name === "app" ? "app/" : name);
const PASSED: Record<string, string> = {
  missing: "no package.json",
  invalid: "package.json is not valid JSON or could not be read",
  oversized: `package.json is larger than ${MAX_PACKAGE_JSON >> 20} MiB and was not parsed`,
};
const passedOver = (state: PackageState): boolean =>
  state === "missing" || state === "invalid" || state === "oversized";

function sentence(
  resources: string,
  chosen: string,
  others: string[],
  skipped: Array<{ name: string; why: string }>,
  unchecked = false,
): string {
  const parts = [
    unchecked
      ? `Electron runs the first of app/, app.asar and default_app.asar in ${resources} whose package.json it can load. hexvero took ${label(chosen)} without checking its package.json (it could not be read here; the analysis says why).`
      : `Electron runs the first of app/, app.asar and default_app.asar in ${resources} whose package.json it can load: ${label(chosen)}.`,
  ];
  if (skipped.length)
    parts.push(`Passed over: ${skipped.map((p) => `${label(p.name)} (${p.why})`).join(", ")}.`);
  if (others.length) parts.push(`Also there, not run by Electron: ${others.join(", ")}.`);
  return parts.join(" ");
}

const FUSE_WARNING =
  "Electron runs app.asar instead of app/ when the fuse OnlyLoadAppFromAsar is on; hexvero does not read fuses and read app/.";

/** True when `dir` holds a Chromium runtime of Windows or Linux beside its `resources/`. */
function runtimeDirectory(dir: string): boolean {
  if (!isDirectory(join(dir, "resources"))) return false;
  if (!RUNTIME_MARKERS.some((m) => isFile(join(dir, m)))) return false;
  let names: string[];
  try {
    names = readdirSync(dir).slice(0, 5000);
  } catch {
    return false;
  }
  return names.some((n) => RUNTIME_BINARY(n) && isFile(join(dir, n)));
}

/**
 * The Electron application of a macOS `.app` or a Windows/Linux install directory, or null when
 * the directory is neither (then it is read as it is today). A candidate that is a link out of
 * the bundle is not read and not passed over either: Electron would follow it, so the result is
 * `refused` with the reason.
 */
export function findElectronApp(dir: string): ElectronLocation | null {
  const layouts: Array<{ resources: string; layout: ElectronLocation["layout"] }> = [];
  // A bundle without its Info.plist (copied in part) is still laid out by its name.
  if (
    isFile(join(dir, "Contents", "Info.plist")) ||
    (dir.endsWith(".app") && isDirectory(join(dir, "Contents", "Resources")))
  )
    layouts.push({ resources: "Contents/Resources", layout: "macos" });
  if (runtimeDirectory(dir)) layouts.push({ resources: "resources", layout: "windows-linux" });
  for (const { resources, layout } of layouts) {
    const base = join(dir, ...resources.split("/"));
    const away = outside(dir, base);
    if (away !== null)
      return {
        entry: resources,
        kind: "directory",
        layout,
        refused: `${resources} is a link to ${away}, outside the bundle; Electron would read the app there, hexvero reads nothing outside the target`,
      };
    const skipped: Array<{ name: string; why: string }> = [];
    let chosen: { name: string; kind: "asar" | "directory"; unchecked: boolean } | null = null;
    const others: string[] = [];
    for (const name of ELECTRON_SEARCH) {
      const path = join(base, name);
      const kind = name === "app" ? "directory" : "asar";
      if (!exists(path)) continue;
      const linked = outside(dir, path);
      if (linked !== null && !chosen)
        return {
          entry: `${resources}/${name}`,
          kind,
          layout,
          refused: `${resources}/${name} is a link to ${linked}, outside the bundle; Electron would follow it, hexvero reads nothing outside the target`,
        };
      if (kind === "directory" ? !isDirectory(path) : !isFile(path)) continue;
      if (chosen) {
        others.push(label(name));
        continue;
      }
      const state = packageOnDisk(path, kind, dir);
      if (state === "outside")
        return {
          entry: `${resources}/${name}`,
          kind,
          layout,
          refused: `${resources}/${name}/package.json is a link outside the bundle; Electron would follow it, hexvero reads nothing outside the target`,
        };
      if (passedOver(state)) skipped.push({ name, why: PASSED[state]! });
      else chosen = { name, kind, unchecked: state === "unchecked" };
    }
    if (!chosen) continue;
    return {
      entry: `${resources}/${chosen.name}`,
      kind: chosen.kind,
      layout,
      ...(skipped.length || others.length || chosen.unchecked
        ? { note: sentence(resources, chosen.name, others, skipped, chosen.unchecked) }
        : {}),
      ...(chosen.name === "app" && others.includes("app.asar") ? { warning: FUSE_WARNING } : {}),
    };
  }
  return null;
}

/** A name from an archive that can stand for a path inside it: relative, no `..`, no `\`. */
const safeName = (name: string): boolean =>
  !name.startsWith("/") &&
  !/[\\\0]/.test(name) &&
  !name.split("/").some((part) => part === ".." || part === ".");

const depth = (resources: string, layout: string): number =>
  resources.split("/").length - (layout === "macos" ? 2 : 1);

/** The groups of candidates in a ZIP: one per resources directory, nearest the root first. */
function zipGroups(
  zip: ZipArchive,
): Array<{ resources: string; layout: ElectronLocation["layout"] }> {
  const names = new Set(zip.entries.filter((e) => safeName(e.name)).map((e) => e.name));
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
    const top = [...names].filter((n) => n.startsWith(root) && !n.slice(root.length).includes("/"));
    if (
      RUNTIME_MARKERS.some((m) => names.has(`${root}${m}`)) &&
      top.some((n) => RUNTIME_BINARY(n.slice(root.length)))
    )
      groups.set(win[1]!, "windows-linux");
  }
  // the depth of the build itself: the `.app`, or the install directory
  return [...groups]
    .map(([resources, layout]) => ({ resources, layout }))
    .toSorted(
      (a, b) =>
        depth(a.resources, a.layout) - depth(b.resources, b.layout) ||
        (a.resources < b.resources ? -1 : 1),
    );
}

/**
 * The Electron application inside a ZIP archive of a packaged build (`Name.app/…` from a macOS
 * release, or an install directory with `resources/app.asar` beside the runtime), by the same
 * order and package.json test as on disk. With several applications in one archive, the one
 * nearest the archive root is taken and the others are named in `note`. The pick is `refused`
 * (the archive is read as an archive) when an entry of that app occurs twice (also as two
 * spellings of one Unicode name: extractors keep one, hexvero would read the other), when a
 * candidate is a symbolic link, cannot be read, or is not an ASAR archive. `maxBytes` bounds
 * the archive read out of the ZIP.
 */
export function findElectronAppInZip(zip: ZipArchive, maxBytes: number): ElectronLocation | null {
  const groups = zipGroups(zip);
  if (groups.length === 0) return null;
  const [{ resources, layout }, ...rest] = groups as [(typeof groups)[number], ...typeof groups];
  const more = rest.length
    ? `The archive holds ${groups.length} Electron applications; the one nearest its root was read, not ${rest.map((g) => g.resources.replace(/\/(?:Contents\/Resources|resources)$/, "")).join(", ")}.`
    : undefined;
  const refuse = (entry: string, reason: string): ElectronLocation => ({
    entry,
    kind: "asar",
    layout,
    refused: reason,
    ...(more ? { note: more } : {}),
  });
  const counts = new Map<string, number>();
  for (const e of zip.entries) {
    const key = e.name.normalize("NFC");
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const twice = zip.entries.find(
    (e) =>
      e.name.normalize("NFC").startsWith(`${resources.normalize("NFC")}/`) &&
      (counts.get(e.name.normalize("NFC")) ?? 0) > 1,
  );
  if (twice)
    return refuse(
      twice.name,
      `the archive holds ${twice.name} more than once (or in two Unicode spellings); an extractor keeps one copy, and which one hexvero would read is not the one installed`,
    );
  const skipped: Array<{ name: string; why: string }> = [];
  for (const [i, name] of ELECTRON_SEARCH.entries()) {
    const entryName = name === "app" ? `${resources}/app/package.json` : `${resources}/${name}`;
    const entry = zip.find(entryName);
    if (!entry || entry.isDirectory) continue;
    const at = `${resources}/${name}`;
    if (zip.links.has(entry)) return refuse(at, `${entryName} is a symbolic link in the archive`);
    if (entry.encrypted) return refuse(at, "the entry is encrypted");
    if (entry.method === "other")
      return refuse(at, "the entry uses an unsupported compression method");
    const others = ELECTRON_SEARCH.slice(i + 1)
      .filter((n) => zip.find(n === "app" ? `${resources}/app/package.json` : `${resources}/${n}`))
      .map(label);
    const note = [
      skipped.length || others.length ? sentence(resources, name, others, skipped) : "",
      more ?? "",
    ]
      .filter(Boolean)
      .join(" ");
    if (name === "app") {
      let ok = false;
      if (entry.size <= MAX_PACKAGE_JSON)
        try {
          ok = parses(zip.read(entry, MAX_PACKAGE_JSON));
        } catch {
          ok = false;
        }
      if (!ok) {
        skipped.push({
          name,
          why: PASSED[entry.size > MAX_PACKAGE_JSON ? "oversized" : "invalid"]!,
        });
        continue;
      }
      return {
        entry: at,
        kind: "directory",
        layout,
        refused: `it is an app/ directory, which hexvero reads from disk only. Extract the archive and analyze ${resources.replace(/\/(?:Contents\/Resources|resources)$/, "") || "the extracted directory"}`,
        ...(note ? { note } : {}),
      };
    }
    if (entry.size > maxBytes)
      return refuse(at, `it expands to ${entry.size} bytes, more than hexvero reads into memory`);
    let bytes: Uint8Array;
    let archive: AsarArchive;
    try {
      bytes = zip.read(entry, maxBytes);
    } catch (error) {
      return refuse(
        at,
        `it could not be read (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    try {
      archive = openAsar(bytes);
    } catch (error) {
      return refuse(
        at,
        `it is not an ASAR archive (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    const state = packageInAsar(archive);
    if (passedOver(state)) {
      skipped.push({ name, why: PASSED[state]! });
      continue;
    }
    const said =
      state === "unchecked"
        ? [sentence(resources, name, others, skipped, true), more ?? ""].filter(Boolean).join(" ")
        : note;
    return { entry: at, kind: "asar", layout, bytes, ...(said ? { note: said } : {}) };
  }
  return skipped.length
    ? refuse(
        `${resources}/${ELECTRON_SEARCH[0]}`,
        `no candidate has a package.json Electron could load (${skipped.map((p) => `${label(p.name)}: ${p.why}`).join(", ")})`,
      )
    : null;
}
