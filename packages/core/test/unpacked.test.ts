import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Session, targetFromBytes } from "../src/index.js";
import { buildAsar } from "./fixtures/asar.js";

const dir = mkdtempSync(join(tmpdir(), "hexvero-unpacked-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// The Electron Fiddle 0.39.0 case: a module listed in the archive as unpacked, its bytes in
// app.asar.unpacked/ beside the archive.
const files = {
  "package.json": JSON.stringify({ name: "x", version: "1.0.0", main: "main.js" }),
  "main.js": 'const { ipcMain } = require("electron");\nrequire("./worker/run.js");\n',
  "worker/run.js":
    'const { ipcMain } = require("electron");\nipcMain.handle("worker:run", () => fetch("https://api.unpacked.example/x"));\n',
};

function place(name: string, withUnpacked: boolean): string {
  const root = join(dir, name);
  mkdirSync(root, { recursive: true });
  const asar = join(root, "app.asar");
  writeFileSync(asar, buildAsar(files, ["worker/run.js"]));
  if (withUnpacked) {
    mkdirSync(join(root, "app.asar.unpacked", "worker"), { recursive: true });
    writeFileSync(join(root, "app.asar.unpacked", "worker", "run.js"), files["worker/run.js"]);
  }
  return asar;
}

describe("unpacked ASAR entries", () => {
  it("reads them from <archive>.unpacked beside the archive", async () => {
    const session = new Session();
    const t = await session.open(place("with", true));
    const analysis = await session.analyze(t.id);
    expect(analysis.limitations.map((l) => l.code)).not.toContain("js_files_skipped");
    const channels = await session.collection(t.id, "ipcChannels");
    expect(channels.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ channel: "worker:run" })]),
    );
    const endpoints = await session.collection(t.id, "endpoints");
    expect(endpoints.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ file: "worker/run.js", value: "https://api.unpacked.example/x" }),
      ]),
    );
    const w = await session.source(t.id, "worker/run.js", 2, 0);
    expect(w.lines[0]).toContain("worker:run");
  });

  it("names the real reason when the .unpacked directory is missing", async () => {
    const session = new Session();
    const t = await session.open(place("without", false));
    const skipped = (await session.analyze(t.id)).limitations.find(
      (l) => l.code === "js_files_skipped",
    );
    expect(skipped?.message).toContain(
      "1 are stored outside the archive in its .unpacked directory, which was not found next to it (e.g. worker/run.js)",
    );
    expect(skipped?.message).not.toContain("exceed the per-file size limit");
  });

  it("reads them once the .unpacked directory appears, although the archive bytes are the same", async () => {
    // the stored scan of an archive must not hide files that arrived in .unpacked later
    const asar = place("later", false);
    const first = new Session();
    const t1 = await first.open(asar);
    expect((await first.analyze(t1.id)).limitations.map((l) => l.code)).toContain(
      "js_files_skipped",
    );
    mkdirSync(join(dir, "later", "app.asar.unpacked", "worker"), { recursive: true });
    writeFileSync(
      join(dir, "later", "app.asar.unpacked", "worker", "run.js"),
      files["worker/run.js"],
    );
    const second = new Session();
    const t2 = await second.open(asar);
    await second.analyze(t2.id);
    expect((await second.collection(t2.id, "ipcChannels")).items).toEqual(
      expect.arrayContaining([expect.objectContaining({ channel: "worker:run" })]),
    );
  });

  it.skipIf(process.platform === "win32")(
    "refuses a FIFO in place of a file instead of blocking on it",
    async () => {
      // an archive layout may put a named pipe where an unpacked module or app file should be
      const asar = place("fifo", false);
      mkdirSync(join(dir, "fifo", "app.asar.unpacked", "worker"), { recursive: true });
      execFileSync("mkfifo", [join(dir, "fifo", "app.asar.unpacked", "worker", "run.js")]);
      const session = new Session();
      const t = await session.open(asar);
      const skipped = (await session.analyze(t.id)).limitations.find(
        (l) => l.code === "js_files_skipped",
      );
      expect(skipped?.message).toContain("worker/run.js");
      // the same for an application folder
      const folder = join(dir, "fifo-dir");
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, "package.json"), JSON.stringify({ main: "main.js" }));
      execFileSync("mkfifo", [join(folder, "main.js")]);
      const d = await session.open(folder);
      await expect(session.analyze(d.id)).resolves.toBeTruthy();
    },
    10_000,
  );

  it("never follows a link out of the .unpacked directory", async () => {
    const asar = place("link", false);
    writeFileSync(
      join(dir, "secret.js"),
      'require("electron").ipcMain.handle("secret:leak", f);\n',
    );
    mkdirSync(join(dir, "link", "app.asar.unpacked", "worker"), { recursive: true });
    symlinkSync(join(dir, "secret.js"), join(dir, "link", "app.asar.unpacked", "worker", "run.js"));
    const session = new Session();
    const t = await session.open(asar);
    await session.analyze(t.id);
    const channels = await session.collection(t.id, "ipcChannels");
    expect(channels.items.map((c) => (c as { channel: string }).channel)).not.toContain(
      "secret:leak",
    );
  });

  it("leaves them unread for an archive known only by name (an upload)", async () => {
    const session = new Session();
    const t = session.register(targetFromBytes(buildAsar(files, ["worker/run.js"]), "app.asar"));
    const skipped = (await session.analyze(t.id)).limitations.find(
      (l) => l.code === "js_files_skipped",
    );
    expect(skipped?.message).toContain("stored outside the archive");
  });
});
