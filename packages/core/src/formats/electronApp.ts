/**
 * Finding the Electron application inside a packaged build: a macOS `.app`, a Windows or Linux
 * install directory, or an archive of either. Nothing is executed; only names, file types and
 * (for an `.asar`) the archive header are read.
 *
 * Electron itself decides which application it runs: in its resources directory
 * (`process.resourcesPath`) it tries `app.asar`, then `app`, then `default_app.asar` (Electron 15
 * and later, `shell/common/node_bindings.cc`; `app` came first up to Electron 14,
 * `lib/browser/init.ts`), and runs the first one whose `package.json` it can load. With the fuse
 * `onlyLoadAppFromAsar` on it tries `app.asar` alone. hexvero applies the same order. When the
 * candidates there would give another pick under another of these orders, it reads the Electron
 * version and that fuse from the runtime binary (formats/electronRuntime.ts) to know which.
 */
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { openAsar, openAsarFile, type AsarArchive } from "./asar.js";
import { pickFactsInZip, pickFactsOnDisk, type PickFacts } from "./electronRuntime.js";
import type { ZipArchive, ZipEntry } from "./zip.js";

/** Electron's search order in its resources directory, Electron 15 and later. */
export const ELECTRON_SEARCH = ["app.asar", "app", "default_app.asar"] as const;
/** The order up to Electron 14. */
export const ELECTRON_SEARCH_BEFORE_15 = ["app", "app.asar", "default_app.asar"] as const;
/** The order with the fuse onlyLoadAppFromAsar on. */
export const ELECTRON_SEARCH_ASAR_ONLY = ["app.asar"] as const;
type Candidate = (typeof ELECTRON_SEARCH)[number];
type Order = readonly Candidate[];

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
  /** Set when what Electron runs may be another candidate (a version or fuse not read). */
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
type PackageState =
  | "valid"
  | "missing"
  | "invalid"
  | "oversized"
  | "unchecked"
  | "outside"
  /** valid JSON, but `null` */
  | "null"
  /** valid JSON, but a list, string, number or boolean */
  | "other";

/**
 * How Electron treats a package.json that is valid JSON but not an object. Electron 45 and later
 * (`app_package.cc`, `is_dict`) pass over any such value (`skip`). Earlier versions load it with
 * Node's `require` and run it unless it is `null`, which makes them run no app at all
 * (`null-stops`: `if (packageJson == null) … "Unable to find a valid app"`).
 */
export type JsonRule = "skip" | "null-stops";
/** The first Electron version whose rule is `skip`. */
export const SKIPS_NON_OBJECT_FROM = 45;

/** What a package.json's bytes are: an object, `null`, another JSON value, or not JSON. */
const jsonState = (bytes: Uint8Array): "valid" | "null" | "other" | "invalid" => {
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: false }).decode(bytes));
    if (value === null) return "null";
    return typeof value === "object" && !Array.isArray(value) ? "valid" : "other";
  } catch {
    return "invalid";
  }
};

function packageInAsar(archive: AsarArchive): PackageState {
  const entry = archive.find("package.json");
  if (!entry) return "missing";
  if (entry.size > MAX_PACKAGE_JSON) return "oversized";
  if (entry.unpacked) return "unchecked";
  try {
    return jsonState(archive.read(entry, MAX_PACKAGE_JSON));
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
    return jsonState(readFileSync(file));
  } catch {
    return "invalid";
  }
}

const label = (name: string): string => (name === "app" ? "app/" : name);
const PASSED: Record<string, string> = {
  missing: "no package.json",
  invalid: "package.json is not valid JSON or could not be read",
  null: `package.json is null, which Electron ${SKIPS_NON_OBJECT_FROM} and later pass over`,
  other: `package.json is not a JSON object, which Electron ${SKIPS_NON_OBJECT_FROM} and later pass over`,
  oversized: `package.json is larger than ${MAX_PACKAGE_JSON >> 20} MiB and was not parsed`,
};
/** What the pick does with a candidate in `state` under `json`: take it, pass over it, or stop. */
function judge(state: PackageState, json: JsonRule): "take" | "pass" | "stop" {
  if (state === "missing" || state === "invalid" || state === "oversized") return "pass";
  if (state === "null") return json === "skip" ? "pass" : "stop";
  if (state === "other") return json === "skip" ? "pass" : "take";
  return "take";
}
const NULL_STOPS = `its package.json is null: Electron before ${SKIPS_NON_OBJECT_FROM} loads it and then runs no app`;

/** How the order Electron uses is said in a note. */
const orderText = (order: Order): string =>
  order.length === 1
    ? `only ${label(order[0]!)}`
    : `the first of ${order.slice(0, -1).map(label).join(", ")} and ${label(order.at(-1)!)}`;

function sentence(
  resources: string,
  order: Order,
  basis: string,
  chosen: string,
  others: string[],
  skipped: Array<{ name: string; why: string }>,
  unchecked = false,
): string {
  const runs = `Electron${basis} runs ${orderText(order)} in ${resources}${order.length === 1 ? ", if its package.json loads" : " whose package.json it can load"}`;
  const parts = [
    unchecked
      ? `${runs}. hexvero took ${label(chosen)} without checking its package.json (it could not be read here; the analysis says why).`
      : `${runs}: ${label(chosen)}.`,
  ];
  if (skipped.length)
    parts.push(`Passed over: ${skipped.map((p) => `${label(p.name)} (${p.why})`).join(", ")}.`);
  if (others.length) parts.push(`Also there, not run by Electron: ${others.join(", ")}.`);
  return parts.join(" ");
}

/** The order Electron uses, by what was read of its version and fuse. */
interface OrderChoice {
  order: Order;
  /** Said after "Electron" in the note: ` 44.7.2`, ` 44.7.2 (fuse onlyLoadAppFromAsar on)`. */
  basis: string;
  /** Other orders the build may use, as far as what was read leaves open. */
  alternatives: Array<{ order: Order; when: string }>;
  /** What was not read, for the warning. */
  unread: string | null;
}

/** An order Electron may use, and when it does. */
interface KnownOrder {
  order: Order;
  when: string;
}
const MODERN: KnownOrder = { order: ELECTRON_SEARCH, when: "Electron 15.0.0-beta.6 and later" };
const BEFORE_15: KnownOrder = {
  order: ELECTRON_SEARCH_BEFORE_15,
  when: "Electron before 15.0.0-beta.6",
};
const ASAR_ONLY: KnownOrder = {
  order: ELECTRON_SEARCH_ASAR_ONLY,
  when: "the fuse onlyLoadAppFromAsar on",
};

/**
 * The search order of an Electron version, or null when it is not known from the version alone.
 * The order changed in 15.0.0-beta.6 (electron#30667, backported in #30900): 15.0.0 alphas, betas
 * 1 to 5 and the 15 and 16 nightlies around it may have either.
 */
function orderOfVersion(version: string): KnownOrder | null | "unknown" {
  const v = /^(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta|nightly)\.(\d+))?$/.exec(version);
  if (!v) return "unknown";
  const major = Number(v[1]);
  const pre = v[4];
  if (major <= 14) return BEFORE_15;
  if (major >= 17) return MODERN;
  if (major === 16) return pre === "nightly" ? null : MODERN;
  if (Number(v[2]) > 0 || Number(v[3]) > 0 || !pre) return MODERN;
  return pre === "beta" && Number(v[5]) >= 6 ? MODERN : null;
}

export function orderFor(facts: PickFacts): OrderChoice {
  const fuse = facts.onlyLoadAppFromAsar;
  const wire = facts.fuseWire?.version === 1 ? facts.fuseWire : null;
  const known = facts.electron !== "unknown";
  if (fuse === "on")
    return {
      order: ELECTRON_SEARCH_ASAR_ONLY,
      basis: `${known ? ` ${facts.electron}` : ""} (fuse onlyLoadAppFromAsar on, ${facts.detail})`,
      alternatives: [],
      unread: null,
    };
  // A schema 1 wire tells the order itself: its 6th position, onlyLoadAppFromAsar, came in the
  // same change as the order. Without one, the version tells it, except around that change.
  const byWire = wire ? (wire.positions >= 6 ? MODERN : BEFORE_15) : null;
  const byVersion = orderOfVersion(facts.electron);
  const versionOrder = byVersion === "unknown" ? null : byVersion;
  // A wire and a version that give different orders (a 4-position wire in Electron 30, a
  // 9-position one in Electron 14) leave the order open: neither is trusted over the other.
  const conflict = byWire !== null && versionOrder !== null && byWire !== versionOrder;
  const order = conflict ? null : (byWire ?? versionOrder);
  // The fuse cannot be on where it does not exist (a wire without its position, Electron ≤ 14),
  // nor where the wire reads it off; closed only when what was read does not disagree.
  const fuseClosed = conflict
    ? false
    : wire !== null
      ? wire.positions < 6 || fuse === "off" || fuse === "removed"
      : fuse === "off" || fuse === "removed" || byVersion === BEFORE_15;
  const unread = [
    order === null
      ? conflict
        ? `the search order (the fuse wire of ${wire!.positions} positions and Electron ${facts.electron} disagree)`
        : known
          ? `the search order of Electron ${facts.electron} (it changed in 15.0.0-beta.6, and no fuse wire tells which)`
          : "the Electron version"
      : "",
    fuseClosed ? "" : "the fuse onlyLoadAppFromAsar",
  ]
    .filter(Boolean)
    .join(" and ");
  const basis =
    order === null
      ? ""
      : `${known ? ` ${facts.electron}` : ""}${byWire ? ` (a fuse wire of ${wire!.positions} positions)` : ""}`;
  return {
    order: (order ?? MODERN).order,
    basis,
    alternatives: [...(order === null ? [BEFORE_15] : []), ...(fuseClosed ? [] : [ASAR_ONLY])],
    unread: unread ? `${unread} could not be read (${facts.detail})` : null,
  };
}

/** Two picks are the same when they read the same entry, or refuse it for the same reason. */
const samePick = (a: ElectronLocation | null, b: ElectronLocation | null): boolean =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.entry === b.entry &&
    !!a.refused === !!b.refused &&
    a.kind === b.kind);

/**
 * Picks with the order Electron uses. The candidates are first tried under every order Electron
 * may use; only when they disagree are the version and the fuse read from the runtime binary
 * (`facts`), and what stays open after that is the warning.
 */
function decide(
  pick: (order: Order, basis: string, json: JsonRule) => ElectronLocation | null,
  facts: () => PickFacts,
): ElectronLocation | null {
  // every order Electron may use, under both rules for a package.json that is not an object
  const picks = [MODERN, BEFORE_15, ASAR_ONLY].flatMap((o) =>
    (["skip", "null-stops"] as const).map((json) => pick(o.order, "", json)),
  );
  if (picks.every((p) => samePick(p, picks[0]!))) {
    // the same pick whatever the order and the rule; the note names Electron's current order
    return picks[0]!;
  }
  const read = facts();
  const choice = orderFor(read);
  const major = /^(\d+)\./.exec(read.electron);
  const json: JsonRule | null = major
    ? Number(major[1]) >= SKIPS_NON_OBJECT_FROM
      ? "skip"
      : "null-stops"
    : null;
  const chosen = pick(choice.order, choice.basis, json ?? "skip");
  const alternatives: Array<{
    when: string;
    other: ElectronLocation | null;
    fuseOnly: boolean;
    rule?: boolean;
  }> = [
    ...choice.alternatives.map((alt) => ({
      when: alt.when,
      other: pick(alt.order, "", json ?? "skip"),
      fuseOnly: alt === ASAR_ONLY,
    })),
    // the version was not read: the rule for a package.json that is not an object is open too
    ...(json === null
      ? [
          {
            when: `Electron before ${SKIPS_NON_OBJECT_FROM}`,
            other: pick(choice.order, "", "null-stops"),
            fuseOnly: false,
            rule: true,
          },
        ]
      : []),
  ];
  const differing = alternatives.filter(({ other }) => !samePick(other, chosen));
  const ruleOpen = differing.some((d) => d.rule);
  const unread =
    !ruleOpen || (choice.unread ?? "").startsWith("the Electron version")
      ? choice.unread
      : choice.unread
        ? `the Electron version and ${choice.unread}`
        : `the Electron version could not be read (${read.detail})`;
  if (!chosen || differing.length === 0 || !unread) return chosen;
  const elsewhere = differing
    .map(({ when, other, fuseOnly }) =>
      other === null || (fuseOnly && other.refused)
        ? `with ${when} Electron finds no app here`
        : other.refused
          ? `with ${when} Electron would run no app hexvero reads (${other.entry})`
          : `with ${when} Electron runs ${other.entry}`,
    )
    .join("; ");
  return {
    ...chosen,
    warning: `${unread[0]!.toUpperCase()}${unread.slice(1)}. hexvero read ${chosen.entry} by Electron's order for ${choice.basis ? `Electron${choice.basis}` : MODERN.when}${ruleOpen ? ` and its rule for package.json (Electron ${SKIPS_NON_OBJECT_FROM} and later)` : ""}; ${elsewhere}.`,
  };
}

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
    const found = decide(
      (order, basis, json) => pickOnDisk(dir, base, resources, layout, order, basis, json),
      () => pickFactsOnDisk(dir, layout),
    );
    if (found) return found;
  }
  return null;
}

/** The first candidate in `order` with a package.json Electron can load, on disk. */
function pickOnDisk(
  dir: string,
  base: string,
  resources: string,
  layout: ElectronLocation["layout"],
  order: Order,
  basis: string,
  json: JsonRule,
): ElectronLocation | null {
  const skipped: Array<{ name: string; why: string }> = [];
  let chosen: { name: string; kind: "asar" | "directory"; unchecked: boolean } | null = null;
  const others: string[] = [];
  for (const name of order) {
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
    const verdict = judge(state, json);
    if (verdict === "stop")
      return {
        entry: `${resources}/${name}`,
        kind,
        layout,
        refused: `${resources}/${name}: ${NULL_STOPS}`,
      };
    if (verdict === "pass") skipped.push({ name, why: PASSED[state]! });
    else chosen = { name, kind, unchecked: state === "unchecked" };
  }
  // candidates the order leaves out (with onlyLoadAppFromAsar on) are there all the same
  for (const name of ELECTRON_SEARCH)
    if (!order.includes(name) && exists(join(base, name))) others.push(label(name));
  if (!chosen) {
    if (order.length === 1 && (skipped.length || others.length))
      return {
        entry: `${resources}/${order[0]}`,
        kind: "asar",
        layout,
        refused: `Electron${basis} runs only app.asar${skipped.length ? `, and app.asar was passed over (${skipped[0]!.why})` : ", and there is no app.asar"}: it finds no app here (also there: ${others.join(", ") || "nothing else"})`,
      };
    return null;
  }
  return {
    entry: `${resources}/${chosen.name}`,
    kind: chosen.kind,
    layout,
    ...(skipped.length || others.length || chosen.unchecked || basis
      ? { note: sentence(resources, order, basis, chosen.name, others, skipped, chosen.unchecked) }
      : {}),
  };
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
  // Each candidate is read once, whichever orders it is tried under.
  const reads = new Map<string, { bytes: Uint8Array } | { error: string }>();
  const readOnce = (entry: ZipEntry, max: number): { bytes: Uint8Array } | { error: string } => {
    const key = `${entry.name}\0${max}`;
    let hit = reads.get(key);
    if (!hit) {
      try {
        hit = { bytes: zip.read(entry, max) };
      } catch (error) {
        hit = { error: error instanceof Error ? error.message : String(error) };
      }
      reads.set(key, hit);
    }
    return hit;
  };
  const prefix = resources.replace(/(?:Contents\/Resources|resources)$/, "");
  return decide(
    (order, basis, json) =>
      pickInZip(zip, resources, layout, order, basis, json, maxBytes, more, refuse, readOnce),
    () => pickFactsInZip(zip, prefix, layout, maxBytes),
  );
}

/** The first candidate in `order` with a package.json Electron can load, in a ZIP. */
function pickInZip(
  zip: ZipArchive,
  resources: string,
  layout: ElectronLocation["layout"],
  order: Order,
  basis: string,
  json: JsonRule,
  maxBytes: number,
  more: string | undefined,
  refuse: (entry: string, reason: string) => ElectronLocation,
  readOnce: (entry: ZipEntry, max: number) => { bytes: Uint8Array } | { error: string },
): ElectronLocation | null {
  const candidate = (n: Candidate): string =>
    n === "app" ? `${resources}/app/package.json` : `${resources}/${n}`;
  const skipped: Array<{ name: string; why: string }> = [];
  for (const [i, name] of order.entries()) {
    const entryName = candidate(name);
    const entry = zip.find(entryName);
    if (!entry || entry.isDirectory) continue;
    const at = `${resources}/${name}`;
    if (zip.links.has(entry)) return refuse(at, `${entryName} is a symbolic link in the archive`);
    if (entry.encrypted) return refuse(at, "the entry is encrypted");
    if (entry.method === "other")
      return refuse(at, "the entry uses an unsupported compression method");
    const others = [...order.slice(i + 1), ...ELECTRON_SEARCH.filter((n) => !order.includes(n))]
      .filter((n) => zip.find(candidate(n)))
      .map(label);
    const note = [
      skipped.length || others.length || basis
        ? sentence(resources, order, basis, name, others, skipped)
        : "",
      more ?? "",
    ]
      .filter(Boolean)
      .join(" ");
    if (name === "app") {
      let state: PackageState = "oversized";
      if (entry.size <= MAX_PACKAGE_JSON) {
        const read = readOnce(entry, MAX_PACKAGE_JSON);
        state = "bytes" in read ? jsonState(read.bytes) : "invalid";
      }
      const verdict = judge(state, json);
      if (verdict === "stop") return refuse(at, NULL_STOPS);
      if (verdict === "pass") {
        skipped.push({ name, why: PASSED[state]! });
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
    const read = readOnce(entry, maxBytes);
    if ("error" in read) return refuse(at, `it could not be read (${read.error})`);
    const bytes = read.bytes;
    let archive: AsarArchive;
    try {
      archive = openAsar(bytes);
    } catch (error) {
      return refuse(
        at,
        `it is not an ASAR archive (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    const state = packageInAsar(archive);
    const verdict = judge(state, json);
    if (verdict === "stop") return refuse(at, NULL_STOPS);
    if (verdict === "pass") {
      skipped.push({ name, why: PASSED[state]! });
      continue;
    }
    const said =
      state === "unchecked"
        ? [sentence(resources, order, basis, name, others, skipped, true), more ?? ""]
            .filter(Boolean)
            .join(" ")
        : note;
    return { entry: at, kind: "asar", layout, bytes, ...(said ? { note: said } : {}) };
  }
  const left = ELECTRON_SEARCH.filter((n) => !order.includes(n) && zip.find(candidate(n)));
  if (order.length === 1 && (skipped.length || left.length))
    return refuse(
      `${resources}/${order[0]}`,
      `Electron${basis} runs only app.asar${skipped.length ? `, and app.asar was passed over (${skipped[0]!.why})` : ", and there is no app.asar"}: it finds no app here (also there: ${left.map(label).join(", ") || "nothing else"})`,
    );
  return skipped.length
    ? refuse(
        `${resources}/${order[0]}`,
        `no candidate has a package.json Electron could load (${skipped.map((p) => `${label(p.name)}: ${p.why}`).join(", ")})`,
      )
    : null;
}
