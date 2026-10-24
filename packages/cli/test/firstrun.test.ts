import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { buildAsar } from "../../core/test/fixtures/asar.js";
import { appRoots, findApps, PERMITTED, runApps } from "../src/apps.js";
import type { Io } from "../src/format.js";
import { main } from "../src/index.js";
import { startProgress } from "../src/progress.js";
import { buildOfExecutable, installerHint } from "../src/quick.js";
import { closest, distance, fastMain, startScreen, VERSION } from "../src/usage.js";

const examples = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "examples");
const v14 = join(examples, "notesdesk-1.4.0.asar");
const v15 = join(examples, "notesdesk-1.5.0.asar");

/** An analyze --json document without what differs from run to run. */
const strip = (t: string[]): unknown => {
  const doc = JSON.parse(t.join("\n"));
  delete doc.durationMs;
  delete doc.target.openedAt;
  return doc;
};

/** A macOS bundle that holds Electron Framework, as an empty directory tree. */
const electron = (app: string): void =>
  void mkdirSync(join(app, "Contents", "Frameworks", "Electron Framework.framework"), {
    recursive: true,
  });

function capture(): Io & { stdout: string[]; stderr: string[]; statuses: Array<string | null> } {
  const io = {
    stdout: [] as string[],
    stderr: [] as string[],
    statuses: [] as Array<string | null>,
    color: false,
    out: (t: string) => void io.stdout.push(t),
    err: (t: string) => void io.stderr.push(t),
  };
  return io;
}

describe("first run", () => {
  const dir = mkdtempSync(join(tmpdir(), "hexvero-firstrun-"));
  afterAll(() => {
    try {
      chmodSync(join(dir, "apps-mac", "Locked"), 0o755);
    } catch {
      // not made on this platform
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("shows a short start screen without arguments, and the full help on --help and help", async () => {
    const io = capture();
    expect(await main([], io)).toBe(2);
    expect(io.stdout).toEqual([]); // stdout stays empty for scripts
    const screen = io.stderr.join("\n");
    expect(screen.split("\n").length).toBeLessThanOrEqual(15);
    expect(screen).toContain(VERSION);
    for (const command of [
      "hexvero demo",
      "hexvero <YourApp.app | app.asar>",
      "hexvero compare <old> <new>",
      "hexvero apps",
      "hexvero --help",
    ])
      expect(screen).toContain(command);
    expect(screen).not.toContain("Usage: hexvero");
    expect(screen).not.toContain("\u001b"); // no color without a terminal
    // under npx the commands say npx
    const npx = { ...capture(), invocation: "npx hexvero" };
    expect(await main([], npx)).toBe(2);
    expect(npx.stderr.join("\n")).toContain("  npx hexvero demo");
    // fastMain (the bin's path that skips the analyzers) prints the same and the version
    const fast = capture();
    expect(fastMain([], fast)).toBe(2);
    expect(fast.stderr.join("\n")).toBe(screen);
    const version = capture();
    expect(fastMain(["--version", "--no-color"], version)).toBe(0);
    expect(version.stdout).toEqual([VERSION]);
    expect(fastMain(["demo"], capture())).toBeUndefined();
    expect(fastMain(["--help"], capture())).toBeUndefined();
    for (const argv of [["--help"], ["help"]]) {
      const help = capture();
      expect(await main(argv, help)).toBe(0);
      expect(help.stdout.join("\n")).toContain("Usage: hexvero");
      expect(help.stdout.join("\n")).toMatch(/\n {2}apps \[--json\]/);
      expect(help.stderr).toEqual([]);
    }
    expect(startScreen({ ...capture(), color: true })).toContain("\u001b[36m");
  });

  it("gives a quick look at one build for hexvero <path>, and analyze's JSON with --json", async () => {
    const io = capture();
    expect(await main([v15], io)).toBe(0);
    const text = io.stdout.join("\n");
    expect(text).toMatch(/^.*notesdesk-1\.5\.0\.asar {2}\d+ ms/);
    expect(text).toContain("1 window · 6 bridge members · 6 IPC channels · 3 external hosts");
    expect(text).toContain("Top findings");
    expect(text).toContain("6 members exposed to pages as window.notesdesk");
    expect(text).toMatch(/Next\n {2}hexvero analyze \S*notesdesk-1\.5\.0\.asar\n/);
    expect(text).toMatch(/hexvero compare \S*notesdesk-1\.5\.0\.asar <newer build>/);
    expect(io.stderr).toEqual([]);
    // shorter than analyze, and no explanation lines
    const full = capture();
    expect(await main(["analyze", v15], full)).toBe(0);
    expect(text.split("\n").length).toBeLessThan(full.stdout.join("\n").split("\n").length);
    // --json: the same document as analyze --json
    const quick = capture();
    const analyze = capture();
    expect(await main([v15, "--json"], quick)).toBe(0);
    expect(await main(["analyze", v15, "--json"], analyze)).toBe(0);
    expect(strip(quick.stdout)).toEqual(strip(analyze.stdout));
  });

  it("answers a typo with the closest command and a missing path with the closest names", async () => {
    const typo = capture();
    expect(await main(["anaylze", v15], typo)).toBe(2); // a command typo, even with a path after it
    expect(typo.stderr.join("\n")).toContain('unknown command "anaylze"');
    expect(typo.stderr.join("\n")).toContain("did you mean: hexvero analyze");
    const prefix = capture();
    expect(await main(["dem"], prefix)).toBe(2);
    expect(prefix.stderr.join("\n")).toContain("did you mean: hexvero demo");
    const nothing = capture();
    expect(await main(["zzzzzz"], nothing)).toBe(2);
    expect(nothing.stderr.join("\n")).toContain('no command and no file or folder named "zzzzzz"');
    expect(nothing.stderr.join("\n")).toContain("hexvero apps");
    expect(nothing.stdout).toEqual([]);

    const missing = capture();
    expect(await main([join(examples, "notesdesk-1.5.0.asr")], missing)).toBe(2);
    const said = missing.stderr.join("\n");
    expect(said).toContain("no file or folder named");
    // the closest name first
    expect(said).toMatch(/did you mean: \S*notesdesk-1\.5\.0\.asar, \S*notesdesk-1\.4\.0\.asar/);
    // a dangling link is an entry: analyze says what is wrong with it (exit 1), no "did you mean"
    if (process.platform !== "win32") {
      const dangling = join(dir, "dangling.asar");
      symlinkSync(join(dir, "nowhere"), dangling);
      const io = capture();
      expect(await main([dangling], io)).toBe(1);
      expect(io.stderr.join("\n")).toContain("error (not_found)");
      expect(io.stderr.join("\n")).not.toContain("did you mean");
    }
    // a usage error in a quick look shows analyze's lines
    const batch = capture();
    expect(await main([v15, "--batch", "0"], batch)).toBe(2);
    expect(batch.stderr.join("\n")).toContain("analyze <path>");
    expect(await main(["apps", "extra"], capture())).toBe(2);
    const two = capture();
    expect(await main([v14, v15], two)).toBe(2);
    expect(two.stderr.join("\n")).toContain("hexvero compare <a> <b>");
    // a control character in what was typed is shown escaped
    const odd = capture();
    expect(await main(["x\u001b[2J/y"], odd)).toBe(2);
    expect(odd.stderr.join("\n")).toContain("\\u001b[2J");
  });

  it("says what to do with an installer, an app's executable or a folder that holds no app", async () => {
    expect(installerHint("Foo-1.2.dmg")).toContain("/Volumes");
    expect(installerHint("FooSetup-1.2.exe")).toContain("install folder");
    expect(installerHint("foo.msi")).toContain("install folder");
    expect(installerHint("Foo.AppImage")).toContain("does not unpack");
    expect(installerHint("foo_1.2_amd64.deb")).toContain("Linux package");
    expect(installerHint("Foo.exe")).toBeNull(); // an app's own executable, not an installer
    expect(installerHint("app.asar")).toBeNull();

    const dmg = join(dir, "Foo.dmg");
    writeFileSync(dmg, Buffer.alloc(4096, 7));
    const io = capture();
    expect(await main([dmg], io)).toBe(0);
    expect(io.stdout.join("\n")).toContain("This is a disk image (an installer)");

    const empty = join(dir, "notes");
    mkdirSync(empty);
    writeFileSync(join(empty, "todo.txt"), "milk");
    const folder = capture();
    expect(await main([empty], folder)).toBe(0);
    const text = folder.stdout.join("\n");
    expect(text).toContain("This folder holds no app");
    expect(text).not.toContain("IPC channels"); // no counts of an app that is not there

    // an executable next to resources/app.asar belongs to the install folder
    const install = join(dir, "install");
    mkdirSync(join(install, "resources"), { recursive: true });
    writeFileSync(join(install, "resources", "app.asar"), "x");
    writeFileSync(join(install, "Foo.exe"), "not really an executable");
    expect(buildOfExecutable(join(install, "Foo.exe"))).toBe(install);
    expect(buildOfExecutable(join(empty, "todo.txt"))).toBeNull();
    const exe = capture();
    expect(await main([join(install, "Foo.exe")], exe)).toBe(0);
    expect(exe.stdout.join("\n")).toContain("This is the app's executable");
  });

  it("warns on stderr when compare is handed two different apps, never in --json", async () => {
    const other = join(dir, "other.asar");
    writeFileSync(
      other,
      buildAsar({
        "package.json": JSON.stringify({ name: "otherapp", main: "main.js" }),
        "main.js": 'require("electron").ipcMain.on("x", () => {});\n',
      }),
    );
    const io = capture();
    expect(await main(["compare", v15, other], io)).toBe(0);
    expect(io.stderr.join("\n")).toContain(
      'look like two different apps ("notesdesk" and "otherapp")',
    );
    const same = capture();
    expect(await main(["compare", v14, v15], same)).toBe(0);
    expect(same.stderr).toEqual([]);
    const json = capture();
    expect(await main(["compare", v15, other, "--json"], json)).toBe(0);
    expect(json.stderr).toEqual([]);
    expect(() => JSON.parse(json.stdout.join("\n"))).not.toThrow();
  });

  it("finds installed Electron apps read-only, bounded, without following links further", () => {
    const mac = join(dir, "apps-mac");
    electron(join(mac, "Alpha.app"));
    mkdirSync(join(mac, "Native.app", "Contents", "MacOS"), { recursive: true });
    electron(join(mac, "Suite", "Beta.app")); // one folder down
    electron(join(mac, "A", "B", "Deep.app")); // past the depth
    // an Electron helper inside a bundle is not an app of its own
    electron(join(mac, "Alpha.app", "Contents", "Frameworks", "Helper.app"));
    if (process.platform !== "win32") {
      symlinkSync(join(mac, "Alpha.app"), join(mac, "Linked.app"));
      symlinkSync(mac, join(mac, "loop")); // a link back up: never walked
      mkdirSync(join(mac, "Locked"));
      chmodSync(join(mac, "Locked"), 0);
    }
    const found = findApps([{ path: mac, layout: "macos" }]);
    expect(found.apps.map((a) => a.name)).toEqual(
      process.platform === "win32" ? ["Alpha", "Beta"] : ["Alpha", "Beta", "Linked"],
    );
    expect(found.truncated).toBe(false);
    if (process.platform !== "win32" && process.getuid?.() !== 0) expect(found.unreadable).toBe(1);
    expect(
      findApps([{ path: mac, layout: "macos" }], { maxDepth: 3 }).apps.map((a) => a.name),
    ).toContain("Deep");
    const capped = findApps([{ path: mac, layout: "macos" }], { maxApps: 1 });
    expect(capped.apps).toHaveLength(1);
    expect(capped.truncated).toBe(true);
    // out of time: stops, says so
    let t = 0;
    expect(
      findApps([{ path: mac, layout: "macos" }], { timeMs: 5, now: () => (t += 10) }).truncated,
    ).toBe(true);
    // one wide folder is bounded by time and entries too, not only between folders
    const wide = join(dir, "apps-wide");
    mkdirSync(wide);
    for (let i = 0; i < 300; i++) writeFileSync(join(wide, `f${i}`), "");
    let clock = 0;
    const slow = findApps([{ path: wide, layout: "asar" }], {
      timeMs: 100,
      now: () => (clock += 1),
    });
    expect(slow.truncated).toBe(true);
    // one folder listed (under maxEntries), 300 entries looked at (over 20 × 10)
    expect(findApps([{ path: wide, layout: "asar" }], { maxEntries: 10 }).truncated).toBe(true);
    expect(findApps([{ path: wide, layout: "asar" }], { maxEntries: 20 }).truncated).toBe(false);
    // a missing root is skipped
    expect(findApps([{ path: join(dir, "nope"), layout: "macos" }]).apps).toEqual([]);

    const win = join(dir, "apps-win");
    for (const app of [join(win, "Slacky", "app-4.1.0"), join(win, "Programs", "Codey")])
      mkdirSync(join(app, "resources"), { recursive: true });
    writeFileSync(join(win, "Slacky", "app-4.1.0", "resources", "app.asar"), "x");
    writeFileSync(join(win, "Programs", "Codey", "resources", "app.asar"), "x");
    mkdirSync(join(win, "NotElectron", "resources"), { recursive: true });
    const installs = findApps([{ path: win, layout: "asar" }]);
    expect(installs.apps).toEqual([
      { name: "Codey", path: join(win, "Programs", "Codey") },
      { name: "Slacky", path: join(win, "Slacky", "app-4.1.0") },
    ]);
  });

  it("lists the apps with the command for each and the reminder to examine only permitted software", () => {
    const mac = join(dir, "apps-list");
    mkdirSync(join(mac, "My App.app", "Contents", "Frameworks", "Electron Framework.framework"), {
      recursive: true,
    });
    const io = capture();
    expect(runApps(io, false, [{ path: mac, layout: "macos" }])).toBe(0);
    const text = io.stdout.join("\n");
    expect(text).toContain("1 Electron app(s)");
    if (process.platform !== "win32")
      expect(text).toContain(`hexvero '${join(mac, "My App.app")}'`);
    expect(text).toContain(PERMITTED);
    expect(PERMITTED).toContain("explicitly authorized"); // DISCLAIMER.md's wording
    const json = capture();
    expect(runApps(json, true, [{ path: mac, layout: "macos" }])).toBe(0);
    const doc = JSON.parse(json.stdout.join("\n"));
    expect(doc.apps[0].name).toBe("My App");
    expect(doc.apps[0].command).toMatch(/^hexvero /);
    expect(doc.notice).toBe(PERMITTED);
    const none = capture();
    expect(runApps(none, false, [{ path: join(dir, "nope"), layout: "asar" }])).toBe(0);
    expect(none.stdout.join("\n")).toContain("No Electron apps found");
    expect(none.stdout.join("\n")).toContain("hexvero demo");

    expect(appRoots("darwin", {}, "/home/u").map((r) => r.path)).toEqual([
      "/Applications",
      join("/home/u", "Applications"),
    ]);
    expect(appRoots("linux", {}, "/home/u").map((r) => r.path)).toEqual([
      "/opt",
      "/usr/lib",
      join("/home/u", ".local", "share"),
    ]);
    const win = appRoots(
      "win32",
      { LOCALAPPDATA: "L", ProgramFiles: "P", "ProgramFiles(x86)": "Q" },
      "H",
    );
    expect(win.map((r) => r.path)).toEqual([join("L", "Programs"), "L", "P", "Q"]);
    expect(win.every((r) => r.layout === "asar")).toBe(true);
  });

  it("shows a progress line only after a second, only with a status line, and clears it", () => {
    expect(startProgress(capture()).onProgress).toBeUndefined(); // not a terminal: nothing
    const io = capture();
    io.status = (line) => void io.statuses.push(line);
    let now = 0;
    const progress = startProgress(io, { now: () => now });
    progress.onProgress!("scanning", 1, 10);
    expect(io.statuses).toEqual([]); // under a second
    now = 1500;
    progress.onProgress!("scanning", 2, 10);
    expect(io.statuses).toEqual(["hexvero: scanning JavaScript 2/10 files · 1 s"]);
    now = 1550;
    progress.onProgress!("scanning", 3, 10); // within 100 ms: not redrawn
    expect(io.statuses).toHaveLength(1);
    now = 1700;
    progress.onProgress!("linking", 10, 10);
    expect(io.statuses.at(-1)).toBe("hexvero: linking modules (10 files read) · 1 s");
    progress.stop();
    expect(io.statuses.at(-1)).toBeNull();
    progress.onProgress!("scanning", 4, 10);
    expect(io.statuses.at(-1)).toBeNull(); // stopped for good
  });

  it("never draws a progress line with --json or for a quick analysis", async () => {
    for (const argv of [
      [v15, "--json"],
      ["analyze", v15, "--json"],
      [v15],
      ["compare", v14, v15],
    ]) {
      const io = capture();
      io.status = (line) => void io.statuses.push(line);
      expect(await main(argv, io)).toBe(0);
      expect(io.statuses, argv.join(" ")).toEqual([]);
    }
  });

  it("measures typos by edit distance", () => {
    expect(distance("analyze", "anaylze")).toBe(1);
    expect(distance("compare", "comapre")).toBe(1);
    expect(distance("a", "abcdefgh", 2)).toBe(3);
    expect(closest("comapre", ["compare", "check", "cache"])).toEqual(["compare"]);
    expect(closest("x", ["export"])).toEqual([]);
    expect(closest("ui", ["ui", "apps"])).toEqual(["ui"]);
    expect(closest("Discord.APP", ["Discord.app", "Other.app"])).toEqual(["Discord.app"]);
  });
});
