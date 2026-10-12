import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { analyzeTarget } from "../src/analyzers/dispatch.js";
import { analyzeAppBundle, isAppBundle } from "../src/formats/bundle.js";
import { loadTarget } from "../src/target.js";
import { buildMacho } from "./fixtures/macho.js";

const plist = (body: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0">${body}</plist>`;

describe("app bundles", () => {
  const dir = mkdtempSync(join(tmpdir(), "hexvero-bundle-"));
  const app = join(dir, "Demo.app");
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
  mkdirSync(
    join(app, "Contents", "Frameworks", "Electron Framework.framework"),
    { recursive: true },
  );
  mkdirSync(join(app, "Contents", "Resources"), { recursive: true });
  mkdirSync(join(app, "Contents", "XPCServices", "Helper.xpc"), {
    recursive: true,
  });
  writeFileSync(
    join(app, "Contents", "Info.plist"),
    plist(`<dict>
      <key>CFBundleIdentifier</key><string>com.example.demo</string>
      <key>CFBundleName</key><string>Demo</string>
      <key>CFBundleShortVersionString</key><string>2.1.0</string>
      <key>CFBundleVersion</key><string>210</string>
      <key>CFBundleExecutable</key><string>Demo</string>
      <key>LSMinimumSystemVersion</key><string>12.0</string>
      <key>NSCameraUsageDescription</key><string>Video calls</string>
      <key>NSAppTransportSecurity</key><dict><key>NSAllowsArbitraryLoads</key><true/></dict>
      <key>CFBundleURLTypes</key><array><dict><key>CFBundleURLSchemes</key><array><string>demo</string></array></dict></array>
    </dict>`),
  );
  writeFileSync(join(app, "Contents", "MacOS", "Demo"), buildMacho());
  writeFileSync(
    join(app, "Contents", "Resources", "Demo.entitlements"),
    plist(
      `<dict><key>com.apple.security.app-sandbox</key><false/><key>com.apple.security.cs.disable-library-validation</key><true/></dict>`,
    ),
  );

  it("recognizes bundles and reads Info.plist, executable, frameworks and entitlements", () => {
    expect(isAppBundle(app)).toBe(true);
    expect(isAppBundle(dir)).toBe(false);
    const b = analyzeAppBundle(app);
    expect(b).toMatchObject({
      platform: "macos",
      bundleId: "com.example.demo",
      name: "Demo",
      version: "2.1.0",
      build: "210",
      executable: "Demo",
      minimumOs: "12.0",
      framework: "Electron",
      sandboxed: false,
    });
    expect(b.main?.summary).toContain("Mach-O arm64 executable");
    expect(b.frameworks).toEqual(["Electron Framework.framework"]);
    expect(b.helpers).toEqual(["Helper.xpc"]);
    expect(b.urlSchemes).toEqual(["demo"]);
    expect(b.permissions).toEqual([
      { key: "NSCameraUsageDescription", reason: "camera: Video calls" },
    ]);
    expect(b.findings.map((f) => f.kind)).toEqual([
      "bundle.ats-off",
      "bundle.permissions",
      "bundle.url-schemes",
      "bundle.framework",
      "bundle.no-sandbox",
      "bundle.weak-hardening",
      "bundle.helpers",
    ]);
  });

  it("routes .app directories through analyzeTarget", async () => {
    const analysis = await analyzeTarget(await loadTarget(app));
    expect(analysis.data.kind).toBe("bundle");
    expect(analysis.summary).toContain(
      "macOS app Demo 2.1.0 (com.example.demo)",
    );
  });
});
