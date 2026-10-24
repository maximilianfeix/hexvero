/**
 * What hexvero prints before it reads anything: the version, the start screen without arguments,
 * the closest command to a typo. Nothing here imports @hexvero/core, so `hexvero` and
 * `hexvero --version` start without loading the analyzers (bin/hexvero.js uses fastMain).
 */
import { defaultIo, paint, suggest, type Io } from "./format.js";

export const VERSION = "0.11.1";

/** The screen for `hexvero` without arguments: what it does and three ways to start. */
export function startScreen(io: Io): string {
  const cmd = (rest: string): string => paint(io, "cyan", suggest(io, rest));
  const rows: Array<[string, string]> = [
    ["demo", "compare two example builds (no app of your own needed)"],
    ["<YourApp.app | app.asar>", "a quick look at one Electron build"],
    ["compare <old> <new>", "what changed between two releases"],
  ];
  const width = Math.max(...rows.map(([c]) => suggest(io, c).length));
  return [
    `${paint(io, "bold", "hexvero")} ${VERSION} — see what an Electron app exposes and what changed between two`,
    "releases: IPC channels, preload bridge, window settings, network hosts. Reads files only;",
    "it never runs the app.",
    "",
    "Start here:",
    ...rows.map(
      ([c, what]) =>
        `  ${cmd(c)}${" ".repeat(width - suggest(io, c).length)}  ${paint(io, "dim", what)}`,
    ),
    "",
    `${paint(io, "dim", "No build at hand?")} ${cmd("apps")} ${paint(io, "dim", "lists the Electron apps installed here.")}`,
    `Every command: ${cmd("--help")}`,
  ].join("\n");
}

/**
 * `hexvero` and `hexvero --version` (with `--no-color` at most), answered without the analyzers;
 * undefined for anything else, which `main` handles.
 */
export function fastMain(argv: readonly string[], io: Io = defaultIo()): number | undefined {
  const rest = argv.filter((a) => a !== "--no-color");
  if (rest.length !== argv.length) io.color = false;
  if (rest.length === 0) {
    io.err(startScreen(io));
    return 2;
  }
  if (rest.length === 1 && (rest[0] === "--version" || rest[0] === "-v")) {
    io.out(VERSION);
    return 0;
  }
  return undefined;
}

/** Edit distance with transpositions, cut off once it is over `max`. */
export function distance(a: string, b: string, max = 3): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_row, i) =>
    Array.from({ length: b.length + 1 }, (_cell, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        v = Math.min(v, d[i - 2]![j - 2]! + 1);
      d[i]![j] = v;
    }
  return d[a.length]![b.length]!;
}

/**
 * The known names closest to `word` (a typo'd command, a misspelt file name), closest first:
 * the same name in other case, a prefix, or two edits at most (one for words of up to 3 letters).
 */
export function closest(word: string, known: readonly string[]): string[] {
  const w = word.toLowerCase();
  if (w.length < 2) return [];
  return known
    .map((k) => {
      const l = k.toLowerCase();
      return { k, d: l === w ? 0 : l.startsWith(w) && w.length >= 3 ? 0.5 : distance(w, l, 2) };
    })
    .filter((x) => x.d <= (w.length <= 3 ? 1 : 2))
    .toSorted((x, y) => x.d - y.d || x.k.localeCompare(y.k))
    .map((x) => x.k)
    .slice(0, 3);
}
