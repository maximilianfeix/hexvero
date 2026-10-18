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
    expect(found?.note).toContain("Passed over: app.asar (no package.json)");
  });

  it("reads neither an app/ link out of the bundle nor the candidate after it, and says so", async () => {
    const outside = join(dir, "outside-app");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "package.json"), "{}");
    const root = macApp("Linked.app", { "app.asar": buildAsar(app("api.linked.example")) });
    symlinkSync(outside, join(root, "Contents", "Resources", "app"));
    const found = findElectronApp(root);
    expect(found?.entry).toBe("Contents/Resources/app");
    expect(found?.refused).toContain("outside the bundle");
    const t = await loadTarget(root);
    expect(t.info.format).toBe("directory");
    expect(t.info.container).toBeUndefined();
    const analysis = await analyzeTarget(t);
    expect(analysis.data.kind).toBe("bundle");
    expect(analysis.limitations.find((l) => l.code === "electron_app_not_read")?.message).toContain(
      "Contents/Resources/app is a link to",
    );
  });

  it("refuses an app.asar or a Resources directory that is a link out of the bundle", () => {
    const away = join(dir, "away");
    mkdirSync(join(away, "Res"), { recursive: true });
    writeFileSync(join(away, "evil.asar"), buildAsar(app("evil.example")));
    writeFileSync(join(away, "Res", "app.asar"), buildAsar(app("evil.example")));
    const one = macApp("LinkAsar.app", { ".keep": "" });
    symlinkSync(join(away, "evil.asar"), join(one, "Contents", "Resources", "app.asar"));
    expect(findElectronApp(one)).toMatchObject({ entry: "Contents/Resources/app.asar" });
    expect(findElectronApp(one)?.refused).toContain("outside the bundle");
    const two = join(dir, "LinkRes.app");
    mkdirSync(join(two, "Contents"), { recursive: true });
    writeFileSync(join(two, "Contents", "Info.plist"), plist);
    symlinkSync(join(away, "Res"), join(two, "Contents", "Resources"));
    expect(findElectronApp(two)?.refused).toContain("Contents/Resources is a link to");
    // a link that stays inside the bundle is read
    const three = macApp("LinkInside.app", { ".keep": "" });
    writeFileSync(join(three, "Contents", "inner.asar"), buildAsar(app("inner.example")));
    symlinkSync("../inner.asar", join(three, "Contents", "Resources", "app.asar"));
    expect(findElectronApp(three)).toMatchObject({ entry: "Contents/Resources/app.asar" });
    expect(findElectronApp(three)?.refused).toBeUndefined();
  });

  it("passes over an app/ whose package.json is not JSON, as Electron does", () => {
    const root = macApp("BadJson.app", {
      "app/package.json": "{ not json",
      "app/main.js": "1;\n",
      "app.asar": buildAsar(app("api.asar.example")),
    });
    const found = findElectronApp(root);
    expect(found?.entry).toBe("Contents/Resources/app.asar");
    expect(found?.note).toContain("app/ (package.json is not valid JSON or could not be read)");
    // and inside an archive
    const asar = macApp("BadJsonAsar.app", {
      "app.asar": buildAsar({ "package.json": "{ nope", "main.js": "1;\n" }),
      "default_app.asar": buildAsar(app("default.example")),
    });
    expect(findElectronApp(asar)?.entry).toBe("Contents/Resources/default_app.asar");
  });

  it("passes over an oversized package.json on disk and in a ZIP alike", () => {
    const big = JSON.stringify({ name: "big", main: "main.js", pad: "x".repeat(1_500_000) });
    const root = macApp("Big.app", {
      "app/package.json": big,
      "app/main.js": "1;\n",
      "app.asar": buildAsar(app("api.asar.example")),
    });
    const found = findElectronApp(root);
    expect(found?.entry).toBe("Contents/Resources/app.asar");
    expect(found?.note).toContain("app/ (package.json is larger than 1 MiB and was not parsed)");
    const zip = buildZip({
      "X.app/Contents/Resources/app/package.json": big,
      "X.app/Contents/Resources/app.asar": buildAsar(app("api.asar.example")),
    });
    const inZip = findElectronAppInZip(openZip(zip), 1 << 30);
    expect(inZip?.entry).toBe("X.app/Contents/Resources/app.asar");
    expect(inZip?.refused).toBeUndefined();
    expect(inZip?.note).toContain("app/ (package.json is larger than 1 MiB and was not parsed)");
    // in an archive too
    const asar = macApp("BigAsar.app", {
      "app.asar": buildAsar({ "package.json": big }),
      "default_app.asar": buildAsar(app("default.example")),
    });
    expect(findElectronApp(asar)?.entry).toBe("Contents/Resources/default_app.asar");
  });

  it("does not say Electron can load a package.json hexvero did not check", () => {
    const root = macApp("Unchecked.app", {
      "app.asar": buildAsar(app("u.example"), ["package.json"]),
    });
    const found = findElectronApp(root);
    expect(found?.entry).toBe("Contents/Resources/app.asar");
    expect(found?.note).toContain("without checking its package.json");
  });

  it("stops at a package.json that is a link out of the bundle", () => {
    const away = join(dir, "away-pkg");
    mkdirSync(away, { recursive: true });
    writeFileSync(join(away, "package.json"), "{}");
    const root = macApp("PkgLink.app", {
      "app/main.js": "1;\n",
      "app.asar": buildAsar(app("api.asar.example")),
    });
    symlinkSync(
      join(away, "package.json"),
      join(root, "Contents", "Resources", "app", "package.json"),
    );
    expect(findElectronApp(root)?.refused).toContain("package.json is a link outside the bundle");
  });

  it("warns that a fuse may make Electron run app.asar instead of app/", async () => {
    const root = macApp("Fuse.app", {
      "app/package.json": app("api.dir.example")["package.json"]!,
      "app/main.js": app("api.dir.example")["main.js"]!,
      "app.asar": buildAsar(app("api.asar.example")),
    });
    const t = await loadTarget(root);
    expect(t.info.container?.warning).toContain("OnlyLoadAppFromAsar");
    const analysis = await analyzeTarget(t);
    expect(analysis.limitations.map((l) => l.code)).toContain("electron_app_pick_unverified");
  });

  it("finds resources/app.asar in a Windows or Linux install directory next to the runtime", async () => {
    const root = join(dir, "install");
    mkdirSync(join(root, "resources"), { recursive: true });
    writeFileSync(join(root, "resources", "app.asar"), buildAsar(app("api.win.example")));
    writeFileSync(join(root, "resources.pak"), "pak");
    writeFileSync(join(root, "Fixture.exe"), "MZ");
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

  it("applies the package.json test in a ZIP too", async () => {
    const zip = buildZip({
      "X.app/Contents/Resources/app/package.json": "{ not json",
      "X.app/Contents/Resources/app.asar": buildAsar({ "main.js": "1;\n" }),
      "X.app/Contents/Resources/default_app.asar": buildAsar(app("default.example")),
    });
    const loaded = electronInZip(targetFromBytes(zip, "r.zip"));
    expect(loaded.info.container?.entry).toBe("X.app/Contents/Resources/default_app.asar");
    expect(loaded.info.container?.note).toContain(
      "app/ (package.json is not valid JSON or could not be read)",
    );
    expect(loaded.info.container?.note).toContain("app.asar (no package.json)");
  });

  it("reads a ZIP as a ZIP when an entry of the app occurs twice", async () => {
    const twice = buildZip(
      { "X.app/Contents/Resources/app.asar": buildAsar(app("good.example")) },
      { entries: [["X.app/Contents/Resources/app.asar", buildAsar(app("evil.example"))]] },
    );
    const loaded = electronInZip(targetFromBytes(twice, "r.zip"));
    expect(loaded.info.format).toBe("zip");
    expect(loaded.info.appNotRead?.reason).toContain("more than once");
    const analysis = await analyzeTarget(loaded);
    expect(analysis.limitations.map((l) => l.code)).toContain("electron_app_not_read");
    // two Unicode spellings of one name count as the same name
    const spelled = buildZip({
      "Caf\u00e9.app/Contents/Resources/app.asar": buildAsar(app("good.example")),
      "Cafe\u0301.app/Contents/Resources/app.asar": buildAsar(app("evil.example")),
    });
    expect(electronInZip(targetFromBytes(spelled, "r.zip")).info.appNotRead?.reason).toContain(
      "more than once",
    );
    // an unpacked file held twice is refused as well
    const unpacked = buildZip(
      {
        "X.app/Contents/Resources/app.asar": buildAsar({ ...app("u.example"), "w.js": "1;" }, [
          "w.js",
        ]),
        "X.app/Contents/Resources/app.asar.unpacked/w.js": "1;",
      },
      { entries: [["X.app/Contents/Resources/app.asar.unpacked/w.js", "2;"]] },
    );
    expect(electronInZip(targetFromBytes(unpacked, "r.zip")).info.format).toBe("zip");
  });

  it("falls back to the ZIP for an app.asar entry that is a link or not an archive", async () => {
    const link = buildZip(
      { "X.app/Contents/Resources/app.asar": "../../../../etc/passwd" },
      { links: ["X.app/Contents/Resources/app.asar"] },
    );
    const a = electronInZip(targetFromBytes(link, "r.zip"));
    expect(a.info.format).toBe("zip");
    expect(a.info.appNotRead?.reason).toContain("symbolic link");
    const junk = buildZip({ "X.app/Contents/Resources/app.asar": new Uint8Array(4096) });
    const b = electronInZip(targetFromBytes(junk, "r.zip"));
    expect(b.info.format).toBe("zip");
    expect(b.info.appNotRead?.reason).toContain("not an ASAR archive");
    const analysis = await analyzeTarget(b);
    expect(analysis.data.kind).toBe("zip");
  });

  it("takes no unpacked file that is a link in the ZIP", async () => {
    const files = { ...app("l.example"), "w.js": 'fetch("https://linked.example/");\n' };
    const zip = buildZip(
      {
        "X.app/Contents/Resources/app.asar": buildAsar(files, ["w.js"]),
        "X.app/Contents/Resources/app.asar.unpacked/w.js": files["w.js"],
      },
      { links: ["X.app/Contents/Resources/app.asar.unpacked/w.js"] },
    );
    const loaded = electronInZip(targetFromBytes(zip, "r.zip"));
    expect(loaded.info.format).toBe("asar");
    expect(loaded.unpacked).toEqual({});
    const skipped = (await analyzeTarget(loaded)).limitations.find(
      (l) => l.code === "js_files_skipped",
    );
    expect(skipped?.message).toContain("were not taken from the ZIP it came from");
  });

  it("refuses a stored ZIP entry whose sizes differ", () => {
    const zip = buildZip({ "big.store": "x".repeat(100) });
    // the central directory's uncompressed size, 24 bytes into its header
    const at = Buffer.from(zip).indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    new DataView(zip.buffer, zip.byteOffset).setUint32(at + 24, 40, true);
    const opened = openZip(zip);
    expect(() => opened.read(opened.entries[0]!)).toThrow(/stored entry/);
  });

  it("finds entries of a large ZIP by name in one pass", () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 40_000; i++) files[`d/f${i}.store`] = "";
    const opened = openZip(buildZip(files));
    const started = performance.now();
    for (let i = 0; i < 40_000; i++) expect(opened.find(`d/f${i}.store`)).toBeDefined();
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it("does not take a source tree with a copied runtime file for an install directory", async () => {
    const root = join(dir, "w3");
    mkdirSync(join(root, "resources", "app"), { recursive: true });
    writeFileSync(join(root, "resources", "app", "package.json"), '{"name":"tpl","main":"i.js"}');
    writeFileSync(join(root, "icudtl.dat"), "x");
    writeFileSync(join(root, "package.json"), '{"name":"repo","main":"main.js"}');
    const t = await loadTarget(root);
    expect(t.info.format).toBe("directory");
    expect(t.info.path).toBe(root);
    expect(t.info.container).toBeUndefined();
  });

  it("takes the app nearest the root of an archive with several, and names the others", () => {
    const zip = buildZip({
      "A.app/Contents/Resources/app.asar": buildAsar(app("a.example")),
      "nested/B.app/Contents/Resources/app.asar": buildAsar(app("b.example")),
      "win/resources/app.asar": buildAsar(app("c.example")),
      "win/resources.pak": "pak",
      "win/app.exe": "MZ",
      "other/resources/app.asar": buildAsar(app("d.example")),
    });
    const found = findElectronAppInZip(openZip(zip), 1 << 30);
    expect(found?.entry).toBe("A.app/Contents/Resources/app.asar");
    expect(found?.note).toContain("nested/B.app");
    expect(found?.note).toContain("win");
    // resources/ without a runtime beside it is not an install directory
    expect(found?.note).not.toContain("other/resources");
  });

  it("ignores archive entries that climb out of the archive", () => {
    const zip = buildZip({ "../X.app/Contents/Resources/app.asar": buildAsar(app("x.example")) });
    expect(findElectronAppInZip(openZip(zip), 1 << 30)).toBeNull();
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
