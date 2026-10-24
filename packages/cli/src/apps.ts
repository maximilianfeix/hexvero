import { readdirSync, statSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { shellWord } from "@hexvero/core";
import { heading, paint, printable, suggest, toJson, type Io } from "./format.js";

/** Where installed Electron apps usually live, and how one is recognised there. */
export interface AppRoot {
  path: string;
  /** `macos`: `X.app` bundles holding Electron Framework; `asar`: folders with resources/app.asar */
  layout: "macos" | "asar";
}

export interface FoundApp {
  name: string;
  /** What to hand to hexvero: the .app bundle or the install folder. */
  path: string;
}

export interface AppSearch {
  apps: FoundApp[];
  roots: string[];
  /** More apps than `maxApps`, more folders than `maxEntries`, or out of time: the list is cut. */
  truncated: boolean;
  /** Folders that could not be listed (permissions); they are skipped, never forced. */
  unreadable: number;
}

/** The usual install locations for this platform. */
export function appRoots(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): AppRoot[] {
  if (platform === "darwin")
    return [
      { path: "/Applications", layout: "macos" },
      { path: join(home, "Applications"), layout: "macos" },
    ];
  if (platform === "win32") {
    const local = env["LOCALAPPDATA"];
    return [
      ...(local
        ? [
            { path: join(local, "Programs"), layout: "asar" as const },
            // Squirrel installs (Slack, Discord, ...): %LOCALAPPDATA%\Name\app-1.2.3\resources
            { path: local, layout: "asar" as const },
          ]
        : []),
      ...[env["ProgramFiles"], env["ProgramFiles(x86)"]]
        .filter((p): p is string => Boolean(p))
        .map((path) => ({ path, layout: "asar" as const })),
    ];
  }
  return [
    { path: "/opt", layout: "asar" },
    { path: "/usr/lib", layout: "asar" },
    { path: join(home, ".local", "share"), layout: "asar" },
  ];
}

const isDir = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};
const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/**
 * Lists installed Electron apps under `roots`: read-only (directory listings and stat calls, no
 * file is opened or run), at most `maxDepth` folders deep, at most `maxEntries` folders listed,
 * `maxApps` apps and `timeMs` milliseconds. Symbolic links are followed to test a candidate (an
 * `X.app` linked into /Applications is an app), never to walk further, so a link loop cannot hold
 * the search.
 */
export function findApps(
  roots: readonly AppRoot[],
  limits: {
    maxDepth?: number;
    maxEntries?: number;
    maxApps?: number;
    timeMs?: number;
    now?: () => number;
  } = {},
): AppSearch {
  const maxDepth = limits.maxDepth ?? 2;
  const maxEntries = limits.maxEntries ?? 5000;
  const maxApps = limits.maxApps ?? 200;
  const timeMs = limits.timeMs ?? 3000;
  const now = limits.now ?? Date.now;
  const started = now();
  const found = new Map<string, FoundApp>();
  let listed = 0;
  let unreadable = 0;
  let truncated = false;

  const add = (app: FoundApp): void => {
    if (found.size >= maxApps) truncated = true;
    else found.set(app.path, app);
  };
  const visit = (dir: string, layout: AppRoot["layout"], depth: number): void => {
    if (truncated) return;
    if (listed >= maxEntries || now() - started > timeMs) {
      truncated = true;
      return;
    }
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
      listed++;
    } catch {
      unreadable++;
      return;
    }
    for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
      if (truncated) return;
      const path = join(dir, entry.name);
      const linked = entry.isSymbolicLink();
      if (!entry.isDirectory() && !linked) continue;
      if (layout === "macos" && entry.name.endsWith(".app")) {
        if (isDir(join(path, "Contents", "Frameworks", "Electron Framework.framework")))
          add({ name: entry.name.slice(0, -4), path });
        continue; // never into a bundle: its frameworks hold helper apps
      }
      if (layout === "asar" && isFile(join(path, "resources", "app.asar"))) {
        // a Squirrel install names its folder app-1.2.3; the app's name is the folder above
        const name = /^app-\d/.test(entry.name) ? basename(dirname(path)) : entry.name;
        add({ name, path });
        continue;
      }
      if (!linked && depth < maxDepth) visit(path, layout, depth + 1);
    }
  };
  for (const root of roots) if (isDir(root.path)) visit(root.path, root.layout, 1);
  return {
    apps: [...found.values()].toSorted(
      (a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) ||
        a.path.localeCompare(b.path),
    ),
    roots: roots.map((r) => r.path),
    truncated,
    unreadable,
  };
}

/** DISCLAIMER.md in one sentence: printed with every list of apps. */
export const PERMITTED =
  "Only examine software you own, that is open source, or that you are explicitly authorized to examine (see DISCLAIMER.md).";

/** `hexvero apps [--json]`: the installed Electron apps and the command that reads each. */
export function runApps(io: Io, json: boolean, roots: readonly AppRoot[] = appRoots()): number {
  const search = findApps(roots);
  const command = (path: string): string => suggest(io, shellWord(path));
  if (json) {
    io.out(
      toJson({
        ...search,
        apps: search.apps.map((a) => ({ ...a, command: command(a.path) })),
        notice: PERMITTED,
      }),
    );
    return 0;
  }
  const where = search.roots.map(printable).join(", ");
  if (!search.apps.length) {
    io.out(`No Electron apps found in ${where}.`);
    io.out(
      `  ${paint(io, "dim", "Try the example builds:")} ${paint(io, "cyan", suggest(io, "demo"))}`,
    );
    io.out(
      `  ${paint(io, "dim", "Or point hexvero at a build:")} ${paint(io, "cyan", suggest(io, "path/to/app.asar"))}`,
    );
  } else {
    io.out(heading(io, `${search.apps.length} Electron app(s) in ${where}`));
    const width = Math.min(28, Math.max(...search.apps.map((a) => printable(a.name).length)));
    for (const app of search.apps) {
      const name = printable(app.name);
      io.out(
        `  ${name}${" ".repeat(Math.max(1, width - name.length + 2))}${paint(io, "cyan", printable(command(app.path)))}`,
      );
    }
  }
  if (search.truncated)
    io.out(
      paint(
        io,
        "yellow",
        "  ! the search stopped early (too many folders, apps or seconds); the list may be incomplete",
      ),
    );
  io.out("");
  io.out(paint(io, "dim", `${PERMITTED} hexvero only reads the files; it never starts the app.`));
  return 0;
}
