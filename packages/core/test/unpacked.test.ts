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
