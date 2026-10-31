/**
 * `hexvero <path>`: a short first look at one build (what `analyze` prints, cut to what a first
 * reader needs), the hints for the paths people try first by mistake (an installer, an app's
 * executable, a folder that holds no app), and the answer for a path that does not exist.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import {
  hostOf,
  shellWord,
  type AnyAnalysis,
  type NextStep,
  type Session,
  type TargetRecord,
} from "@hexvero/core";
import { formatFindings, heading, paint, printable, suggest, type Io } from "./format.js";
import { closest } from "./usage.js";

const TOP_FINDINGS = 5;

/** A path that names an installer or a package rather than an installed app, and what to do. */
export function installerHint(path: string): string | null {
  const name = basename(path).toLowerCase();
  if (name.endsWith(".dmg"))
    return "This is a disk image (an installer). Open it so it mounts under /Volumes, then point hexvero at the app inside, for example: hexvero /Volumes/<Name>/<Name>.app";
  if (name.endsWith(".pkg") || name.endsWith(".mpkg"))
    return "This is a macOS installer package. Install it, then point hexvero at the installed .app (hexvero apps lists them).";
  if (name.endsWith(".appimage"))
    return "This is an AppImage: the app sits in a compressed file system that hexvero does not unpack. Point hexvero at an extracted or installed copy, the folder that holds resources/app.asar.";
  if (/\.(deb|rpm|snap|flatpak)$/.test(name))
    return "This is a Linux package. Install or extract it, then point hexvero at the folder that holds resources/app.asar (often under /opt; hexvero apps lists installed ones).";
  if (
    name.endsWith(".msi") ||
    name.endsWith(".msix") ||
    (name.endsWith(".exe") && /setup|install/.test(name))
  )
    return "This looks like an installer. Install the app, then point hexvero at its install folder (often %LOCALAPPDATA%\\Programs\\<App>) or at resources\\app.asar inside it; hexvero apps lists installed ones.";
  return null;
}

/**
 * The build an app's own executable belongs to: `X.app` for a path inside its bundle, the install
 * folder for an executable next to resources/app.asar. Null when the path is no such executable.
 */
export function buildOfExecutable(path: string): string | null {
  const full = resolve(path);
  const bundle = /^(.*?\.app)(?:[\\/]Contents[\\/].*)$/i.exec(full);
  if (
    bundle?.[1] &&
    existsSync(join(bundle[1], "Contents", "Frameworks", "Electron Framework.framework"))
  )
    return bundle[1];
  const folder = dirname(full);
  return existsSync(join(folder, "resources", "app.asar")) ? folder : null;
}

/** A line or two for a build that is not what a first look expects, else none. */
export function firstLookHints(io: Io, target: TargetRecord, analysis: AnyAnalysis): string[] {
  const path = target.info.container?.path ?? target.info.path;
  const out: string[] = [];
  const installer = installerHint(path);
  if (installer) out.push(installer);
  const data = analysis.data;
  if (!installer && (data.kind === "binary" || target.info.format === "unknown")) {
    const build = buildOfExecutable(path);
    if (build)
      out.push(
        `This is the app's executable; its Electron code is read from the whole build: ${suggest(io, shellWord(build))}`,
      );
  }
  if (data.kind === "bundle")
    out.push(
      `This .app holds no Electron Framework, so it is not an Electron app; below are its native bundle facts. ${suggest(io, "apps")} lists the Electron apps installed here.`,
    );
  if (
    data.kind === "javascript-app" &&
    target.info.format === "directory" &&
    !target.info.container &&
    !data.app.package &&
    data.app.modules.length === 0
  )
    out.push(
      `This folder holds no app: no app.asar, no package.json, no JavaScript. Point hexvero at YourApp.app, an install folder or resources/app.asar; ${suggest(io, "apps")} lists installed Electron apps.`,
    );
  return out;
}

/**
 * The external hosts a build sends requests to (`endpoints`), as `init` and policies count them,
 * and how many requests go to a host built at run time (not counted as hosts).
 */
async function hostCount(
  session: Session,
  id: string,
  lists: Record<string, number>,
): Promise<{ hosts: number; computed: number }> {
  if (!lists["endpoints"]) return { hosts: 0, computed: 0 };
  const hosts = new Set<string>();
  let computed = 0;
  for (const item of await session.items(id, "endpoints")) {
    const v = (item as { value?: unknown } | null)?.value;
    const reading = typeof v === "string" ? hostOf(v) : null;
    if (reading?.kind === "host") hosts.add(reading.host);
    else if (reading === null || reading.kind === "unknown") computed++;
  }
  return { hosts: hosts.size, computed };
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** The quick look: name and runtime, the counts that matter, the first findings, what to run next. */
export async function printQuickLook(
  io: Io,
  session: Session,
  target: TargetRecord,
  analysis: AnyAnalysis,
  collections: Record<string, number>,
  next: NextStep[],
  shown: string,
): Promise<number> {
  const quoted = shellWord(shown);
  const seconds =
    analysis.durationMs >= 1000
      ? `${(analysis.durationMs / 1000).toFixed(1)} s`
      : `${analysis.durationMs} ms`;
  io.out(`${heading(io, printable(shown))}  ${paint(io, "dim", seconds)}`);
  io.out(`  ${printable(analysis.summary)}`);
  const data = analysis.data;
  if (data.kind === "javascript-app") {
    const runtime = data.runtime;
    if (runtime?.shipped) {
      const flag =
        runtime.support === "past end of support"
          ? paint(io, "yellow", "  (past end of support)")
          : runtime.support === "prerelease"
            ? paint(io, "dim", "  (prerelease)")
            : "";
      io.out(
        `  Electron ${printable(runtime.electron)} · Chromium ${printable(runtime.chromium)} · Node ${printable(runtime.node)}${flag}`,
      );
    }
    const empty = !data.app.package && data.app.modules.length === 0;
    const counts = [
      plural(collections["windows"] ?? 0, "window"),
      plural(collections["contextBridge"] ?? 0, "bridge member"),
      plural(collections["ipcChannels"] ?? 0, "IPC channel"),
    ];
    const { hosts, computed } = await hostCount(session, target.id, collections);
    counts.push(
      `${plural(hosts, "external host")}${computed ? paint(io, "dim", ` (+${computed} request(s) to a computed host)`) : ""}`,
    );
    if (!empty) io.out(`  ${counts.join(" · ")}`);
    const coverage = data.app.coverage;
    if (!coverage.complete)
      io.out(
        `  ${paint(io, "yellow", "partial")}: ${coverage.scanned} of ${coverage.total} JavaScript files read; ${
          coverage.remaining > 0
            ? `${suggest(io, `analyze ${quoted} --all`)} reads the rest`
            : `${coverage.skipped === 1 ? "1 file exceeds" : `${coverage.skipped} files exceed`} the per-file size limit or could not be decoded`
        }`,
      );
  }
  for (const hint of firstLookHints(io, target, analysis))
    io.out(`  ${paint(io, "yellow", "!")} ${printable(hint)}`);

  const findings = analysis.findings;
  if (findings.length) {
    io.out(`\n${heading(io, "Top findings")}`);
    // the claim and where it was read; the explanations are in `analyze`
    io.out(
      formatFindings(
        io,
        findings.slice(0, TOP_FINDINGS).map((f) => ({ ...f, detail: "" })),
      ).join("\n"),
    );
    if (findings.length > TOP_FINDINGS)
      io.out(paint(io, "dim", `  … ${findings.length - TOP_FINDINGS} more`));
  }
  if (analysis.limitations.length)
    io.out(
      paint(
        io,
        "dim",
        `  ${plural(analysis.limitations.length, "limitation")}: what could not be read is listed by analyze`,
      ),
    );

  const steps: Array<[string, string]> = [
    [`analyze ${quoted}`, "every finding, limitation and list"],
  ];
  for (const step of next.slice(0, 2))
    steps.push([step.cli.replace(/^hexvero /, "").replace("<path>", () => quoted), step.question]);
  if (data.kind === "javascript-app")
    steps.push([`compare ${quoted} <newer build>`, "what changed in the next release"]);
  io.out(`\n${heading(io, "Next")}`);
  for (const [command, why] of steps)
    io.out(
      `  ${paint(io, "cyan", printable(suggest(io, command)))}\n    ${paint(io, "dim", printable(why))}`,
    );
  return 0;
}

/**
 * `hexvero <word>` where <word> is no command and no existing path: a typo'd command gets the
 * closest commands, a path the closest names in its folder; both get the ways to start.
 */
export function notFound(io: Io, word: string, commands: readonly string[]): number {
  const looksLikePath = /[\\/.~]/.test(word) || word.includes(sep);
  const commandGuess = looksLikePath ? [] : closest(word, commands);
  const lines: string[] = [];
  if (commandGuess.length) {
    lines.push(`${paint(io, "red", "usage:")} unknown command "${printable(word)}"`);
    lines.push(
      `  did you mean: ${commandGuess.map((c) => paint(io, "cyan", suggest(io, c))).join(", ")}`,
    );
  } else {
    lines.push(
      `${paint(io, "red", "usage:")} ${looksLikePath ? "no file or folder" : "no command and no file or folder"} named "${printable(word)}"`,
    );
    const nearby = similarEntries(word);
    if (nearby.length)
      lines.push(
        `  did you mean: ${nearby.map((p) => paint(io, "cyan", printable(p))).join(", ")}`,
      );
  }
  lines.push(
    "",
    `  ${paint(io, "dim", "Electron apps installed here:")} ${paint(io, "cyan", suggest(io, "apps"))}`,
    `  ${paint(io, "dim", "Example builds to try:")}       ${paint(io, "cyan", suggest(io, "demo"))}`,
    `  ${paint(io, "dim", "Every command:")}               ${paint(io, "cyan", suggest(io, "--help"))}`,
  );
  io.err(lines.join("\n"));
  return 2;
}

/** Names in the folder of `path` that differ from its last part in case or a letter or two. */
function similarEntries(path: string): string[] {
  const dir = dirname(path);
  const name = basename(path);
  if (!name) return [];
  let entries: string[];
  try {
    if (!statSync(dir).isDirectory()) return [];
    entries = readdirSync(dir).slice(0, 5000);
  } catch {
    return [];
  }
  return closest(name, entries)
    .slice(0, 3)
    .map((e) => (dir === "." && !path.startsWith(".") ? e : join(dir, e)));
}

/**
 * A warning when two builds handed to `compare` name different apps (package.json name, else
 * the bundle id of a .app): the diff of two unrelated apps is all noise. Null when either side
 * names none or both name the same (case aside); an app renamed between releases warns too.
 */
export async function differentApps(
  session: Session,
  idA: string,
  idB: string,
): Promise<string | null> {
  const name = async (id: string): Promise<string | null> => {
    const { data } = await session.analyze(id);
    if (data.kind === "javascript-app")
      return data.app.package?.name || data.native?.bundleId || null;
    if (data.kind === "bundle") return data.bundle.bundleId || null;
    return null;
  };
  const [a, b] = await Promise.all([name(idA), name(idB)]);
  if (!a || !b || a.toLowerCase() === b.toLowerCase()) return null;
  return `a and b look like two different apps ("${a}" and "${b}"). compare is meant for two releases of the same app; if one was renamed, read on.`;
}
