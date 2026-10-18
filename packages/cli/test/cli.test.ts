import { execFileSync } from "node:child_process";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildAsar } from "../../core/test/fixtures/asar.js";
import { buildElf } from "../../core/test/fixtures/elf.js";
import { invocationFrom, table, type Io } from "../src/format.js";
import { main } from "../src/index.js";

function capture(): Io & { stdout: string[]; stderr: string[] } {
  const io = {
    stdout: [] as string[],
    stderr: [] as string[],
    color: false,
    out: (t: string) => void io.stdout.push(t),
    err: (t: string) => void io.stderr.push(t),
  };
  return io;
}

/** A one-file app whose IPC payload gains keys that are terminal control text. */
const payloadApp = (v2: boolean): Buffer =>
  buildAsar({
    "package.json": JSON.stringify({ name: "p", main: "main.js" }),
    "main.js":
      'const { ipcRenderer } = require("electron");\n' +
      `ipcRenderer.send("save", { d${v2 ? ', ok\u202egnp, "\\u001b[31mred": 1' : ""} });\n`,
  });

/** A word in POSIX single quotes, written out by hand to compare with the CLI's quoting. */
const posix = (word: string): string => `'${word.replace(/'/g, "'\\''")}'`;

describe("hexvero CLI", () => {
  const dir = mkdtempSync(join(tmpdir(), "hexvero-cli-"));
  const so = join(dir, "lib.so");
  writeFileSync(so, buildElf());
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("copies the example builds for the demo and never replaces a different file", async () => {
    const target = join(dir, "demo");
    const first = capture();
    expect(await main(["demo", target], first)).toBe(0);
    const text = first.stdout.join("\n");
    expect(text).toContain("+ notesdesk::checkUpdate");
    expect(text).toContain("ipc_channel_unresolved");
    expect(text).toContain(`--report report.md`);
    // a second run with the same files is fine; a different file under that name is kept
    expect(await main(["demo", target], capture())).toBe(0);
    writeFileSync(join(target, "notesdesk-1.5.0.asar"), "mine");
    const refused = capture();
    expect(await main(["demo", target], refused)).toBe(2);
    expect(refused.stderr.join("\n")).toContain("exists with other content");
  });

  it("suggests commands the way it was started (npx or installed)", async () => {
    expect(invocationFrom({ npm_command: "exec" })).toBe("npx hexvero");
    expect(invocationFrom({})).toBe("hexvero");
    const target = join(dir, "demo-npx");
    const npx = { ...capture(), invocation: "npx hexvero" };
    expect(await main(["demo", target], npx)).toBe(0);
    const demoText = npx.stdout.join("\n");
    expect(demoText).toContain("    npx hexvero compare ");
    expect(demoText).toContain("    npx hexvero ui --demo --open");
    expect(demoText).not.toMatch(/^ {4}hexvero /m);
    const analyzed = { ...capture(), invocation: "npx hexvero" };
    expect(await main(["analyze", join(target, "notesdesk-1.4.0.asar")], analyzed)).toBe(0);
    const analyzeText = analyzed.stdout.join("\n");
    expect(analyzeText).toContain("    npx hexvero collection ");
    expect(analyzeText).toContain("npx hexvero collection <path> <name> to page through one");
    // installed: unchanged
    const plain = capture();
    expect(await main(["demo", target], plain)).toBe(0);
    expect(plain.stdout.join("\n")).toMatch(/^ {4}hexvero compare /m);
  });

  it("quotes paths in suggested commands for a POSIX shell", async () => {
    const target = join(dir, "demo-q $(touch PWNED) `id` it's");
    const demo = capture();
    expect(await main(["demo", target], demo)).toBe(0);
    const a = join(target, "notesdesk-1.4.0.asar");
    const b = join(target, "notesdesk-1.5.0.asar");
    const text = demo.stdout.join("\n");
    expect(text).toContain(`compare ${posix(a)} ${posix(b)} interfaces`);
    expect(text).toContain(`--policy ${posix(join(target, "policy.json"))}`);
    expect(text).not.toContain(JSON.stringify(a));
    // a name with replacement patterns (`$&`, `$'`) and quotes, in text and in --json
    const odd = join(dir, `b'q"$&$'.asar`);
    writeFileSync(odd, readFileSync(a));
    const json = capture();
    expect(await main(["analyze", odd, "--json"], json)).toBe(0);
    const next: Array<{ command: string }> = JSON.parse(json.stdout.join("\n")).next;
    expect(next.length).toBeGreaterThan(0);
    for (const step of next) {
      expect(step.command).toContain(` ${posix(odd)}`);
      expect(step.command).not.toContain("<path>");
    }
  });

  it("escapes target text in the compare summary so it cannot forge lines", async () => {
    const file = "w\nFORGED: approved\u001b[2J.js";
    const build = (open: boolean): Buffer =>
      buildAsar({
        "package.json": JSON.stringify({ name: "f", main: file }),
        [file]: `const { BrowserWindow } = require("electron");\nconst win = new BrowserWindow({ webPreferences: { nodeIntegration: ${open} } });\n`,
      });
    const a = join(dir, "forge-a.asar");
    const b = join(dir, "forge-b.asar");
    writeFileSync(a, build(false));
    writeFileSync(b, build(true));
    const io = capture();
    expect(await main(["compare", a, b], io)).toBe(0);
    const text = io.stdout.join("\n");
    expect(text).toContain("window settings that changed what pages may do");
    expect(text).toContain("nodeIntegration");
    expect(text).not.toMatch(/^FORGED/m);
    expect(text).not.toContain("\u001b[2J");
  });

  it("shows a changed IPC payload with the target's key names escaped", async () => {
    const a = join(dir, "payload-a.asar");
    const b = join(dir, "payload-b.asar");
    writeFileSync(a, payloadApp(false));
    writeFileSync(b, payloadApp(true));
    const io = capture();
    expect(await main(["compare", a, b, "ipc"], io)).toBe(0);
    const text = io.stdout.join("\n");
    expect(text).toContain("0 added, 0 removed, 1 changed");
    expect(text).toContain("args:");
    expect(text).toContain("\\u202e");
    expect(text.includes("\u001b") || text.includes("\u202e")).toBe(false);
  });

  it("writes a compare report and refuses to overwrite it without --force", async () => {
    const a = join(dir, "demo-r", "notesdesk-1.4.0.asar");
    const b = join(dir, "demo-r", "notesdesk-1.5.0.asar");
    expect(await main(["demo", join(dir, "demo-r")], capture())).toBe(0);
    const out = join(dir, "report.md");
    expect(await main(["compare", a, b, "--report", out], capture())).toBe(0);
    expect(readFileSync(out, "utf8")).toContain("## Not established");
    writeFileSync(out, "keep me");
    const refused = capture();
    expect(await main(["compare", a, b, "--report", out], refused)).toBe(2);
    expect(readFileSync(out, "utf8")).toBe("keep me");
    expect(await main(["compare", a, b, "--report", out, "--force"], capture())).toBe(0);
    expect(readFileSync(out, "utf8")).toContain("# What changed");
    expect(await main(["compare", a, b, "ipc", "--report", out], capture())).toBe(2);
  });

  it("never writes a report or an export through a symbolic link, even with --force", async (ctx) => {
    const a = join(dir, "demo-l", "notesdesk-1.4.0.asar");
    const b = join(dir, "demo-l", "notesdesk-1.5.0.asar");
    expect(await main(["demo", join(dir, "demo-l")], capture())).toBe(0);
    const elsewhere = mkdtempSync(join(tmpdir(), "hexvero-cli-elsewhere-"));
    const missing = join(elsewhere, "planted.md");
    const kept = join(elsewhere, "kept.md");
    writeFileSync(kept, "keep me");
    try {
      symlinkSync(missing, join(dir, "dangling.md"));
      symlinkSync(kept, join(dir, "kept.md"));
      symlinkSync(missing, join(dir, "dangling.json"));
    } catch (error) {
      if (["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) ctx.skip();
      throw error;
    }
    for (const out of ["dangling.md", "kept.md"]) {
      const io = capture();
      expect(await main(["compare", a, b, "--report", join(dir, out), "--force"], io)).not.toBe(0);
      expect(io.stderr.join("\n")).toContain("symbolic link");
    }
    const io = capture();
    expect(await main(["export", a, join(dir, "dangling.json")], io)).not.toBe(0);
    expect(io.stderr.join("\n")).toContain("symbolic link");
    expect(existsSync(missing)).toBe(false);
    expect(existsSync(missing.replace(/md$/, "json"))).toBe(false);
    expect(readFileSync(kept, "utf8")).toBe("keep me");
    rmSync(elsewhere, { recursive: true, force: true });
  });

  it("writes to a terminal, pipe or /dev/null, also through a link", async (ctx) => {
    if (process.platform === "win32") return ctx.skip();
    const a = join(dir, "demo-dev", "notesdesk-1.4.0.asar");
    const b = join(dir, "demo-dev", "notesdesk-1.5.0.asar");
    expect(await main(["demo", join(dir, "demo-dev")], capture())).toBe(0);
    const devnull = join(dir, "devnull.md");
    symlinkSync("/dev/null", devnull);
    expect(await main(["compare", a, b, "--report", devnull], capture())).toBe(0);
    expect(await main(["export", a, devnull], capture())).toBe(0);
    expect(await main(["compare", a, b, "--report", "/dev/null"], capture())).toBe(0);
    // a FIFO, as process substitution gives, read by another side
    const fifo = join(dir, "pipe.md");
    execFileSync("mkfifo", [fifo]);
    const link = join(dir, "pipe-link.md");
    symlinkSync(fifo, link);
    const read = new Promise<string>((done, fail) => {
      const chunks: Buffer[] = [];
      createReadStream(fifo)
        .on("data", (c) => chunks.push(c as Buffer))
        .on("end", () => done(Buffer.concat(chunks).toString("utf8")))
        .on("error", fail);
    });
    const code = await main(["compare", a, b, "--report", link], capture());
    if (code !== 0) writeFileSync(fifo, ""); // let the reader finish so the test fails, not hangs
    expect(code).toBe(0);
    expect(await read).toContain("# What changed");
  });

  it("writes an HTML report for .html/.htm, with the same --force and paging rules", async () => {
    const a = join(dir, "demo-h", "notesdesk-1.4.0.asar");
    const b = join(dir, "demo-h", "notesdesk-1.5.0.asar");
    expect(await main(["demo", join(dir, "demo-h")], capture())).toBe(0);
    const out = join(dir, "report.HTML");
    expect(await main(["compare", a, b, "--report", out, "--limit", "3"], capture())).toBe(0);
    const html = readFileSync(out, "utf8");
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<strong>3 of 12 rows shown</strong> (rows 1–3)");
    expect(html).toContain("--offset 3 --limit 3");
    expect(html).toContain('<figure class="src">');
    const refused = capture();
    expect(await main(["compare", a, b, "--report", out], refused)).toBe(2);
    expect(refused.stderr.join("\n")).toContain("pass --force");
    const htm = join(dir, "page.htm");
    expect(await main(["compare", a, b, "--report", htm, "--offset", "3"], capture())).toBe(0);
    expect(readFileSync(htm, "utf8")).toContain("9 of 12 rows shown");
    const md = join(dir, "page.txt");
    expect(await main(["compare", a, b, "--report", md], capture())).toBe(0);
    expect(readFileSync(md, "utf8")).toContain("# What changed");
  });

  it("shows the cache and clears it only with --apply", async () => {
    const root = join(dir, "cache");
    mkdirSync(join(root, "scans"), { recursive: true });
    const entry = join(root, "scans", `${"a".repeat(40)}.json`);
    writeFileSync(entry, "{}");
    const saved = process.env["HEXVERO_CACHE_DIR"];
    process.env["HEXVERO_CACHE_DIR"] = root;
    try {
      const shown = capture();
      expect(await main(["cache", "--json"], shown)).toBe(0);
      expect(JSON.parse(shown.stdout.join(""))).toMatchObject({
        root,
        areas: { scans: { count: 1 } },
      });
      const dry = capture();
      expect(await main(["cache", "--clear"], dry)).toBe(0);
      expect(dry.stdout.join("\n")).toContain("Would remove 1 entries");
      expect(existsSync(entry)).toBe(true);
      expect(await main(["cache", "--clear", "--apply"], capture())).toBe(0);
      expect(existsSync(entry)).toBe(false);
    } finally {
      if (saved === undefined) delete process.env["HEXVERO_CACHE_DIR"];
      else process.env["HEXVERO_CACHE_DIR"] = saved;
    }
  });

  it("shows lists of plain values as a column and leaves nested objects to --json", () => {
    const lines = table([
      {
        channel: "notes:save",
        senders: ["preload.js"],
        receivers: ["main.js", "worker.js"],
        meta: { a: 1 },
      },
    ]);
    expect(lines[0]).toMatch(/channel\s+senders\s+receivers$/);
    expect(lines[2]).toContain("main.js, worker.js");
    expect(lines.join("\n")).not.toContain("meta");
  });

  it("prints help and version", async () => {
    const io = capture();
    expect(await main([], io)).toBe(2);
    expect(io.stderr[0]).toContain("Usage: hexvero");
    const help = capture();
    expect(await main(["--help"], help)).toBe(0);
    expect(help.stdout[0]).toContain("Usage: hexvero");
    expect(await main(["--version"], io)).toBe(0);
    expect(io.stdout.at(-1)).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("turns silent clamps into usage errors and reports partial output", async () => {
    for (const argv of [
      ["collection", so, "symbols", "--limit", "0"],
      ["collection", so, "symbols", "--offset", "-1"],
      ["strings", so, "--tag", "nope"],
      ["strings", so, "--text"],
      ["provider", so, "hopper", "functions"],
      ["provider", so, "ghidra", "strings"],
    ]) {
      const io = capture();
      expect(await main(argv, io), argv.join(" ")).toBe(2);
      expect(io.stderr[0]).toMatch(/usage:/);
      expect(io.stderr[0]).not.toContain("Usage: hexvero"); // short, not the whole help
    }
    const empty = capture();
    expect(await main(["collection", so, "symbols", "--text", "zzz-none"], empty)).toBe(0);
    expect(empty.stdout[0]).toContain("symbols 0 of 0");
    const map = join(dir, "app.js.map");
    writeFileSync(
      map,
      JSON.stringify({
        version: 3,
        sources: ["a.ts"],
        sourcesContent: ["let a = 1;"],
        names: [],
        mappings: "AAAA",
      }),
    );
    const linker = join(dir, "linker.map");
    writeFileSync(linker, "Archive member included to satisfy reference by file\n");
    const lio = capture();
    expect(await main(["analyze", linker, "--json"], lio)).toBe(0);
    expect(JSON.parse(lio.stdout.join("")).target.info.format).toBe("unknown");
    const bio = capture();
    expect(await main(["bytes", so, "0", "100000"], bio)).toBe(0);
    expect(bio.stdout.join("\n")).not.toContain("clamped"); // the file ends first
    const cio = capture();
    expect(await main(["compare", so, so, "symbols", "--json"], cio)).toBe(0);
    expect(JSON.parse(cio.stdout.join(""))).toMatchObject({
      truncated: false,
      compared: { a: 2, b: 2 },
    });
    const mio = capture();
    expect(await main(["analyze", map, "--json"], mio)).toBe(0);
    expect(JSON.parse(mio.stdout.join("")).target.info.format).toBe("json");
    expect(JSON.parse(mio.stdout.join("")).summary.toLowerCase()).toContain("source map");
  });

  it("analyzes a file in human and JSON form", async () => {
    const io = capture();
    expect(await main(["analyze", so], io)).toBe(0);
    const text = io.stdout.join("\n");
    expect(text).toContain("ELF64 x86-64 shared-object");
    expect(text).toContain("symbols (2)");
    const jio = capture();
    expect(await main(["analyze", so, "--json", "--out", join(dir, "a.json")], jio)).toBe(0);
    const parsed = JSON.parse(jio.stdout.join(""));
    expect(parsed.summary).toContain("ELF64");
    expect(parsed.overview.kind).toBe("binary");
    expect(existsSync(join(dir, "a.json"))).toBe(true);
  });

  it("names the Electron app it read inside a packaged build", async () => {
    const app = join(dir, "Pkg.app");
    mkdirSync(join(app, "Contents", "Resources"), { recursive: true });
    writeFileSync(
      join(app, "Contents", "Resources", "app.asar"),
      buildAsar({
        "package.json": JSON.stringify({ name: "pkg", version: "2.0.0", main: "main.js" }),
        "main.js": 'require("electron").ipcMain.handle("pkg:ping", () => 1);\n',
      }),
    );
    writeFileSync(join(app, "Contents", "Resources", "default_app.asar"), buildAsar({}));
    const io = capture();
    expect(await main(["analyze", app], io)).toBe(0);
    const text = io.stdout.join("\n");
    expect(text).toContain("Electron app: Contents/Resources/app.asar");
    expect(text).toContain("Also there, not run by Electron: default_app.asar");
    expect(text).toContain(
      "macOS app · Electron app Contents/Resources/app.asar: 1 JavaScript modules",
    );
    expect(text).toContain("ipcChannels (1)");
    const json = capture();
    expect(await main(["analyze", app, "--json"], json)).toBe(0);
    const body = JSON.parse(json.stdout.join("")) as { target: { info: { container: unknown } } };
    expect(body.target.info.container).toMatchObject({ entry: "Contents/Resources/app.asar" });
  });

  it("reads a large JavaScript app in batches and never shows a partial scan as complete", async () => {
    const cache = mkdtempSync(join(tmpdir(), "hexvero-cli-cache-"));
    const previous = process.env["HEXVERO_CACHE_DIR"];
    process.env["HEXVERO_CACHE_DIR"] = cache;
    try {
      const app = join(dir, "app.asar");
      writeFileSync(
        app,
        buildAsar({
          "package.json": JSON.stringify({ name: "big", main: "main.js" }),
          "main.js": 'require("electron").ipcMain.handle("main:start", () => 1);',
          ...Object.fromEntries(
            Array.from({ length: 6 }, (_, i) => [
              `src/part${i}.js`,
              `require("electron").ipcRenderer.send("part:${i}");`,
            ]),
          ),
        }),
      );
      const first = capture();
      expect(await main(["analyze", app, "--batch", "3", "--continue"], first)).toBe(0);
      const text = first.stdout.join("\n");
      expect(text).toContain("partial: 3 of 7 JavaScript files scanned");
      expect(text).toContain("partial: 3 of 7 JavaScript files scanned (42%), 4 unread");
      expect(text).toContain("--continue");
      expect(text).toContain("(js_files_truncated)");
      // a later, separate invocation sees the stored state and still says partial
      const json = capture();
      expect(await main(["analyze", app, "--json"], json)).toBe(0);
      const stored = JSON.parse(json.stdout.join(""));
      expect(stored.complete).toBe(false);
      expect(stored.coverage).toMatchObject({ scanned: 3, remaining: 4, resumed: true });
      // other commands read the same state, and say that it is partial
      const channels = capture();
      expect(await main(["collection", app, "ipcChannels", "--json"], channels)).toBe(0);
      const page = JSON.parse(channels.stdout.join(""));
      expect(page.total).toBe(3);
      expect(page.partial).toEqual({ scanned: 3, total: 7, remaining: 4, skipped: 0 });
      const listed = capture();
      expect(await main(["collection", app, "ipcChannels"], listed)).toBe(0);
      expect(listed.stdout.join("\n")).toContain(
        "partial: this list covers 3 of 7 JavaScript files",
      );
      // a comparison that involves a partly read side warns that differences may be unread files
      const compared = capture();
      expect(await main(["compare", app, app, "ipcChannels"], compared)).toBe(0);
      expect(compared.stdout.join("\n")).toContain(
        "was read only in part (3 of 7 JavaScript files)",
      );
      const comparedJson = capture();
      expect(await main(["compare", app, app, "ipcChannels", "--json"], comparedJson)).toBe(0);
      expect(JSON.parse(comparedJson.stdout.join(""))).toMatchObject({
        complete: false,
        partialScan: { a: { scanned: 3, total: 7 } },
      });
      // files under one path only
      const picked = capture();
      expect(await main(["analyze", app, "--include", "src/part5.js", "--json"], picked)).toBe(0);
      expect(JSON.parse(picked.stdout.join("")).coverage.scanned).toBe(4);
      const all = capture();
      expect(await main(["analyze", app, "--all"], all)).toBe(0);
      expect(all.stdout.join("\n")).toContain("all 7 JavaScript files scanned");
      expect(all.stdout.join("\n")).not.toContain("partial");
      const done = capture();
      expect(await main(["collection", app, "ipcChannels", "--json"], done)).toBe(0);
      expect(JSON.parse(done.stdout.join("")).total).toBe(7);
      // --fresh forgets the stored scan
      const fresh = capture();
      expect(
        await main(["analyze", app, "--fresh", "--batch", "2", "--continue", "--json"], fresh),
      ).toBe(0);
      expect(JSON.parse(fresh.stdout.join("")).coverage).toMatchObject({
        scanned: 2,
        resumed: false,
      });
      const bad = capture();
      expect(await main(["analyze", app, "--batch", "0"], bad)).toBe(2);
    } finally {
      if (previous === undefined) delete process.env["HEXVERO_CACHE_DIR"];
      else process.env["HEXVERO_CACHE_DIR"] = previous;
      rmSync(cache, { recursive: true, force: true });
    }
  });

  it("pages collections, strings and bytes", async () => {
    const io = capture();
    expect(await main(["collection", so, "symbols", "--limit", "1"], io)).toBe(0);
    expect(io.stdout[0]).toContain("symbols 1-1 of 2");
    expect(io.stdout[1]).toContain("__stack_chk_fail");
    const sio = capture();
    expect(await main(["strings", so, "--tag", "path", "--json"], sio)).toBe(0);
    expect(JSON.parse(sio.stdout.join("")).items[0].value).toBe("/lib64/ld-linux-x86-64.so.2");
    const bio = capture();
    expect(await main(["bytes", so, "0", "16"], bio)).toBe(0);
    expect(bio.stdout[0]).toMatch(/^ {2}00000000 {2}7f 45 4c 46/);
  });

  it("reports usage and analysis errors with exit codes", async () => {
    const io = capture();
    expect(await main(["collection", so], io)).toBe(2);
    expect(io.stderr[0]).toContain("missing <collection>");
    const nio = capture();
    expect(await main(["analyze", join(dir, "nope.bin")], nio)).toBe(1);
    expect(nio.stderr[0]).toContain("error (not_found)");
    const jio = capture();
    expect(await main(["analyze", join(dir, "nope.bin"), "--json"], jio)).toBe(1);
    expect(JSON.parse(jio.stdout.join("")).error.code).toBe("not_found");
    expect(await main(["frobnicate"], capture())).toBe(2);
  });

  it("compares collections and runs doctor/setup dry runs", async () => {
    const other = join(dir, "other.so");
    writeFileSync(other, buildElf({ nx: false }));
    const io = capture();
    expect(await main(["compare", so, other, "findings", "--key", "kind", "--json"], io)).toBe(0);
    expect(JSON.parse(io.stdout.join("")).unchanged).toBe(1);
    // without a collection: counts for every collection both targets share
    const overview = capture();
    expect(await main(["compare", so, other, "--json"], overview)).toBe(0);
    const all = JSON.parse(overview.stdout.join(""));
    const findings = all.collections.find(
      (c: { collection: string }) => c.collection === "findings",
    );
    expect(findings.added + findings.removed + findings.changed).toBeGreaterThan(0);
    expect(
      all.collections.find((c: { collection: string }) => c.collection === "sections"),
    ).toMatchObject({
      added: 0,
      removed: 0,
    });
    const text = capture();
    expect(await main(["compare", so, other], text)).toBe(0);
    expect(text.stdout.join("\n")).toMatch(/shared collection\(s\), \d+ with differences/);
    expect(text.stdout.join("\n")).toContain("details: hexvero compare <a> <b> ");
    const dio = capture();
    expect(await main(["doctor", "--json"], dio)).toBe(0);
    expect(JSON.parse(dio.stdout.join("")).node.ok).toBe(true);
    const sio = capture();
    expect(await main(["setup", "--client", "cursor"], sio)).toBe(0);
    expect(sio.stdout.join("\n")).toContain("Dry run");
    const cio = capture();
    expect(await main(["setup", "--client", "codex"], cio)).toBe(0);
    expect(cio.stdout[0]).toMatch(/codex\s+would (add hexvero|create)\s+.*config\.toml/);
  });
});

describe("setup --skill", () => {
  it("dry-runs and installs the skill into a temporary home", async () => {
    const { installSkill, skillTargets } = await import("../src/skill.js");
    const home = mkdtempSync(join(tmpdir(), "hexvero-skill-"));
    const targets = skillTargets(home);
    expect(targets.map((t) => t.id)).toEqual(["claude-code", "codex", "agents"]);
    const io = capture();
    expect(installSkill(io, { client: "claude-code", apply: false, json: true })).toBe(0);
    expect(JSON.parse(io.stdout.join("")).results[0].action).toBe("would install");
    rmSync(home, { recursive: true, force: true });
  });
});
