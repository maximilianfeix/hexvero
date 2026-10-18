import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { analyzeTarget } from "../src/analyzers/dispatch.js";
import { asarTree } from "../src/javascript/app.js";
import { scanKey } from "../src/javascript/scanState.js";
import { findElectronApp, findElectronAppInZip } from "../src/formats/electronApp.js";
import { openZip } from "../src/formats/zip.js";
import { Session, electronInZip, loadTarget, targetFromBytes } from "../src/index.js";
import { buildAsar } from "./fixtures/asar.js";
import { buildMacho } from "./fixtures/macho.js";
import { buildZip } from "./fixtures/zip.js";

const dir = mkdtempSync(join(tmpdir(), "hexvero-container-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const app = (host: string): Record<string, string> => ({
  "package.json": JSON.stringify({ name: "fixture", version: "1.0.0", main: "main.js" }),
  "main.js": `const { ipcMain } = require("electron");\nipcMain.handle("app:ping", () => fetch("https://${host}/x"));\n`,
});

const plist = `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>com.example.fixture</string>
  <key>CFBundleName</key><string>Fixture</string>
  <key>CFBundleShortVersionString</key><string>1.0.0</string>
  <key>CFBundleExecutable</key><string>Fixture</string>
  <key>NSCameraUsageDescription</key><string>calls</string>
</dict></plist>`;

/** A macOS bundle: Info.plist, a Mach-O executable, an Electron framework and `resources`. */
function macApp(name: string, resources: Record<string, Uint8Array | string>): string {
  const root = join(dir, name);
  mkdirSync(join(root, "Contents", "MacOS"), { recursive: true });
  mkdirSync(join(root, "Contents", "Frameworks", "Electron Framework.framework"), {
    recursive: true,
  });
  writeFileSync(join(root, "Contents", "Info.plist"), plist);
  writeFileSync(join(root, "Contents", "MacOS", "Fixture"), buildMacho());
  for (const [path, bytes] of Object.entries(resources)) {
    const full = join(root, "Contents", "Resources", ...path.split("/"));
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, bytes);
  }
  return root;
}

describe("the Electron app inside a packaged build", () => {
  it("opens a macOS .app as its Contents/Resources/app.asar and keeps the bundle's facts", async () => {
    const root = macApp("Fixture.app", { "app.asar": buildAsar(app("api.mac.example")) });
    const session = new Session();
    const t = await session.open(root);
    expect(t.info.format).toBe("asar");
    expect(t.info.path).toBe(join(root, "Contents", "Resources", "app.asar"));
    expect(t.info.container).toMatchObject({
      path: root,
      format: "directory",
      entry: "Contents/Resources/app.asar",
      layout: "macos",
    });
    const analysis = await session.analyze(t.id);
    expect(analysis.summary).toContain("macOS app Fixture 1.0.0 (com.example.fixture)");
    expect(analysis.summary).toContain("Electron app Contents/Resources/app.asar:");
    expect(analysis.findings.map((f) => f.title)).toContain("Built with Electron");
    const lists = await session.collections(t.id);
    // the app's lists and the bundle's
    expect(lists["ipcChannels"]).toBe(1);
    expect(lists["permissions"]).toBe(1);
    expect(lists["frameworks"]).toBe(1);
    const endpoints = await session.collection(t.id, "endpoints");
    expect(endpoints.items).toEqual([
      expect.objectContaining({ value: "https://api.mac.example/x" }),
    ]);
    // source lines come from the archive that was read
    expect((await session.source(t.id, "main.js", 2, 0)).lines[0]).toContain("app:ping");
  });

  it("is a target of its own: the same archive opened alone has another id", async () => {
    const root = macApp("Twice.app", { "app.asar": buildAsar(app("api.twice.example")) });
    const session = new Session();
    const inBundle = await session.open(root);
    const alone = await session.open(join(root, "Contents", "Resources", "app.asar"));
    expect(alone.id).not.toBe(inBundle.id);
    expect(alone.info.container).toBeUndefined();
    expect((await session.analyze(alone.id)).data).not.toHaveProperty("native");
  });

  it("reads files the archive keeps in app.asar.unpacked beside it", async () => {
    const files = {
      ...app("api.packed.example"),
      "worker.js": 'fetch("https://api.unpacked.example/y");\n',
    };
    const root = macApp("Unpacked.app", {
      "app.asar": buildAsar(files, ["worker.js"]),
      "app.asar.unpacked/worker.js": files["worker.js"],
    });
    const session = new Session();
    const t = await session.open(root);
    const values = (await session.collection(t.id, "endpoints")).items.map(
      (i) => (i as { value: string }).value,
    );
    expect(values).toContain("https://api.unpacked.example/y");
  });

  it("takes app/ before app.asar, as Electron does, and says what else was there", async () => {
    const root = macApp("Both.app", {
      "app.asar": buildAsar(app("api.asar.example")),
      "app/package.json": app("api.dir.example")["package.json"]!,
      "app/main.js": app("api.dir.example")["main.js"]!,
    });
    const found = findElectronApp(root);
    expect(found).toMatchObject({ entry: "Contents/Resources/app", kind: "directory" });
    expect(found?.note).toContain("app/");
    expect(found?.note).toContain("Also there, not run by Electron: app.asar");
    const t = await loadTarget(root);
    expect(t.info.format).toBe("directory");
    expect(t.info.path).toBe(join(root, "Contents", "Resources", "app"));
    const analysis = await analyzeTarget(t);
    expect(analysis.data.kind).toBe("javascript-app");
    expect(analysis.summary).toContain("Electron app Contents/Resources/app:");
  });

  it("passes over an archive without package.json to default_app.asar", () => {
    const root = macApp("Default.app", {
      "app.asar": buildAsar({ "main.js": "1;\n" }),
      "default_app.asar": buildAsar(app("default.example")),
    });
    const found = findElectronApp(root);
    expect(found?.entry).toBe("Contents/Resources/default_app.asar");
    expect(found?.note).toContain("Passed over (no package.json): app.asar");
  });

  it("does not follow an app/ link that leads out of the bundle", () => {
    const outside = join(dir, "outside-app");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "package.json"), "{}");
    const root = macApp("Linked.app", { "app.asar": buildAsar(app("api.linked.example")) });
    symlinkSync(outside, join(root, "Contents", "Resources", "app"));
    expect(findElectronApp(root)?.entry).toBe("Contents/Resources/app.asar");
  });

  it("finds resources/app.asar in a Windows or Linux install directory next to the runtime", async () => {
    const root = join(dir, "install");
    mkdirSync(join(root, "resources"), { recursive: true });
    writeFileSync(join(root, "resources", "app.asar"), buildAsar(app("api.win.example")));
    writeFileSync(join(root, "resources.pak"), "pak");
    const t = await loadTarget(root);
    expect(t.info.format).toBe("asar");
    expect(t.info.container).toMatchObject({
      entry: "resources/app.asar",
      layout: "windows-linux",
    });
    expect((await analyzeTarget(t)).summary).toContain(
      "Windows/Linux install directory · Electron app resources/app.asar:",
    );
  });

  it("reads a directory with resources/ but no runtime beside it as the directory it is", async () => {
    const root = join(dir, "source-tree");
    mkdirSync(join(root, "resources"), { recursive: true });
    writeFileSync(join(root, "resources", "app.asar"), buildAsar(app("api.src.example")));
    writeFileSync(join(root, "main.js"), "1;\n");
    const t = await loadTarget(root);
    expect(t.info.format).toBe("directory");
    expect(t.info.path).toBe(root);
    expect(t.info.container).toBeUndefined();
  });

  it("leaves a .app without an Electron app as the bundle it is", async () => {
    const root = macApp("Native.app", { "icon.icns": "x" });
    const t = await loadTarget(root);
    expect(t.info.format).toBe("directory");
    expect(t.info.container).toBeUndefined();
    expect((await analyzeTarget(t)).data.kind).toBe("bundle");
  });

  it("reads app.asar and its unpacked files out of a ZIP of a macOS release", async () => {
    const files = {
      ...app("api.zip.example"),
      "worker.js": 'fetch("https://api.zipped.example/z");\n',
    };
    const zip = buildZip({
      "Fixture.app/Contents/Info.plist": plist,
      "Fixture.app/Contents/Resources/app.asar": buildAsar(files, ["worker.js"]),
      "Fixture.app/Contents/Resources/app.asar.unpacked/worker.js": files["worker.js"],
    });
    const path = join(dir, "Fixture-1.0.0.zip");
    writeFileSync(path, zip);
    const session = new Session();
    const t = await session.open(path);
    expect(t.info.format).toBe("asar");
    expect(t.info.container).toMatchObject({
      path,
      format: "zip",
      entry: "Fixture.app/Contents/Resources/app.asar",
      layout: "macos",
    });
    const analysis = await session.analyze(t.id);
    expect(analysis.summary).toContain(
      "ZIP archive · Electron app Fixture.app/Contents/Resources/app.asar:",
    );
    const values = (await session.collection(t.id, "endpoints")).items.map(
      (i) => (i as { value: string }).value,
    );
    expect(values).toEqual(
      expect.arrayContaining(["https://api.zip.example/x", "https://api.zipped.example/z"]),
    );
    expect((await session.source(t.id, "worker.js", 1, 0)).lines[0]).toContain("api.zipped");
    // the same in a worker thread
    const worker = new Session({ worker: true });
    const w = await worker.open(path);
    const fromWorker = (await worker.collection(w.id, "endpoints")).items.map(
      (i) => (i as { value: string }).value,
    );
    expect(fromWorker).toContain("https://api.zipped.example/z");
  });

  it("says where the app is when a ZIP holds it as an app/ directory", async () => {
    const zip = buildZip({
      "Fixture.app/Contents/Resources/app/package.json": app("x.example")["package.json"]!,
      "Fixture.app/Contents/Resources/app/main.js": app("x.example")["main.js"]!,
    });
    const loaded = electronInZip(targetFromBytes(zip, "release.zip"));
    expect(loaded.info.format).toBe("zip");
    const analysis = await analyzeTarget(loaded);
    const note = analysis.limitations.find((l) => l.code === "electron_app_not_read");
    expect(note?.message).toContain("Fixture.app/Contents/Resources/app");
    expect(note?.message).toContain("analyze Fixture.app");
  });

  it("takes the app nearest the root of an archive with several, and names the others", () => {
    const zip = buildZip({
      "A.app/Contents/Resources/app.asar": buildAsar(app("a.example")),
      "nested/B.app/Contents/Resources/app.asar": buildAsar(app("b.example")),
      "win/resources/app.asar": buildAsar(app("c.example")),
      "win/resources.pak": "pak",
      "other/resources/app.asar": buildAsar(app("d.example")),
    });
    const found = findElectronAppInZip(openZip(zip).entries);
    expect(found?.entry).toBe("A.app/Contents/Resources/app.asar");
    expect(found?.note).toContain("nested/B.app/Contents/Resources/app.asar");
    expect(found?.note).toContain("win/resources/app.asar");
    // resources/ without a runtime beside it is not an install directory
    expect(found?.note).not.toContain("other/resources");
  });

  it("ignores archive entries that climb out of the archive", () => {
    const zip = buildZip({ "../X.app/Contents/Resources/app.asar": buildAsar(app("x.example")) });
    expect(findElectronAppInZip(openZip(zip).entries)).toBeNull();
  });

  it("keys a stored scan by the unpacked files taken from a ZIP", () => {
    const asar = buildAsar({ ...app("k.example"), "w.js": "1;\n" }, ["w.js"]);
    const info = targetFromBytes(asar, "r.zip!/X.app/Contents/Resources/app.asar").info;
    const one = scanKey(
      info,
      asarTree(asar, info.path, { "w.js": new TextEncoder().encode("1;\n") }),
    );
    const two = scanKey(
      info,
      asarTree(asar, info.path, { "w.js": new TextEncoder().encode("2;\n") }),
    );
    expect(one).not.toBe(two);
  });
});
