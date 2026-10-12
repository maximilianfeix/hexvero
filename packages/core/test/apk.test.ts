import { describe, expect, it } from "vitest";
import { parseApk } from "../src/formats/apk.js";
import { parseAxml } from "../src/formats/axml.js";
import { detectFormat } from "../src/formats/detect.js";
import { openZip } from "../src/formats/zip.js";
import { buildAxml } from "./fixtures/axml.js";
import { buildDex } from "./fixtures/dex.js";
import { buildZip } from "./fixtures/zip.js";

const manifest = buildAxml({
  tag: "manifest",
  attrs: [
    ["package", "com.example.demo", false],
    ["versionCode", 42],
    ["versionName", "1.2.3"],
  ],
  children: [
    {
      tag: "uses-sdk",
      attrs: [
        ["minSdkVersion", 24],
        ["targetSdkVersion", 34],
      ],
    },
    {
      tag: "uses-permission",
      attrs: [["name", "android.permission.INTERNET"]],
    },
    { tag: "uses-permission", attrs: [["name", "android.permission.CAMERA"]] },
    {
      tag: "application",
      attrs: [
        ["label", "Demo"],
        ["debuggable", true],
        ["usesCleartextTraffic", true],
        ["allowBackup", false],
      ],
      children: [
        {
          tag: "activity",
          attrs: [
            ["name", ".MainActivity"],
            ["exported", true],
          ],
          children: [
            {
              tag: "intent-filter",
              children: [
                {
                  tag: "action",
                  attrs: [["name", "android.intent.action.MAIN"]],
                },
              ],
            },
            {
              tag: "intent-filter",
              children: [
                {
                  tag: "action",
                  attrs: [["name", "android.intent.action.VIEW"]],
                },
                {
                  tag: "data",
                  attrs: [
                    ["scheme", "demo"],
                    ["host", "open"],
                  ],
                },
              ],
            },
          ],
        },
        {
          tag: "service",
          attrs: [
            ["name", ".SyncService"],
            ["exported", true],
          ],
        },
        {
          tag: "receiver",
          attrs: [
            ["name", ".BootReceiver"],
            ["permission", "com.example.PRIV"],
          ],
          children: [
            {
              tag: "intent-filter",
              children: [
                {
                  tag: "action",
                  attrs: [["name", "android.intent.action.BOOT_COMPLETED"]],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
});

describe("openZip", () => {
  it("lists and inflates entries, including stored ones and prepended data", () => {
    const zip = openZip(
      buildZip(
        { "a.txt": "hello hello hello", "raw.store": "stored" },
        { prefix: new TextEncoder().encode("#!/bin/sh\n"), comment: "c" },
      ),
    );
    expect(zip.comment).toBe("c");
    expect(zip.entries.map((e) => `${e.name}:${e.method}:${e.size}`)).toEqual([
      "a.txt:deflate:17",
      "raw.store:stored:6",
    ]);
    expect(new TextDecoder().decode(zip.read(zip.entries[0]!))).toBe("hello hello hello");
    expect(new TextDecoder().decode(zip.read(zip.entries[1]!))).toBe("stored");
    expect(() => zip.read(zip.entries[0]!, 4)).toThrow(/expands to/);
  });
  it("reads ZIP64 central directories", () => {
    const zip = openZip(buildZip({ "a.txt": "alpha", "b.txt": "beta" }, { zip64: true }));
    expect(zip.entries.map((e) => e.name)).toEqual(["a.txt", "b.txt"]);
    expect(new TextDecoder().decode(zip.read(zip.entries[1]!))).toBe("beta");
  });
  it("rejects non-zip data", () => {
    expect(() => openZip(new Uint8Array(100))).toThrow(/end-of-central-directory/);
  });
});

describe("parseAxml", () => {
  it("decodes elements, namespaced attributes and typed values", () => {
    const root = parseAxml(manifest);
    expect(root.tag).toBe("manifest");
    expect(root.attributes).toEqual({
      package: "com.example.demo",
      "android:versionCode": "42",
      "android:versionName": "1.2.3",
    });
    expect(root.children[0]!.attributes).toEqual({
      "android:minSdkVersion": "24",
      "android:targetSdkVersion": "34",
    });
    expect(root.children[3]!.attributes["android:debuggable"]).toBe("true");
  });
});

describe("parseApk", () => {
  const apk = buildZip({
    "AndroidManifest.xml": manifest,
    "classes.dex": buildDex(),
    "classes2.dex": "dex\n035",
    "lib/arm64-v8a/libnative.so": new Uint8Array(100),
    "lib/arm64-v8a/libflutter.so": new Uint8Array(10),
    "META-INF/CERT.RSA": new Uint8Array(8),
    "resources.arsc": new Uint8Array(4),
  });
  it("prefers the archive extension for jar-like names", () => {
    expect(detectFormat(apk, "library.aar")).toBe("jar");
  });
  it("is detected as an APK", () => {
    expect(detectFormat(apk, "demo.apk")).toBe("apk");
    expect(detectFormat(apk, "demo.zip")).toBe("apk");
  });
  it("summarizes manifest, components, libraries and security findings", () => {
    const info = parseApk(apk);
    expect(info).toMatchObject({
      package: "com.example.demo",
      versionCode: "42",
      versionName: "1.2.3",
      minSdk: "24",
      targetSdk: "34",
    });
    expect(info.permissions).toEqual(["android.permission.INTERNET", "android.permission.CAMERA"]);
    expect(info.application).toEqual({
      label: "Demo",
      debuggable: true,
      allowBackup: false,
      cleartextTraffic: true,
      networkSecurityConfig: null,
    });
    expect(info.components.map((c) => `${c.kind}:${c.name}:${c.exported}:${c.permission}`)).toEqual(
      [
        "activity:.MainActivity:true:null",
        "service:.SyncService:true:null",
        "receiver:.BootReceiver:true:com.example.PRIV",
      ],
    );
    expect(info.components[0]!.intentFilters[1]).toEqual({
      actions: ["android.intent.action.VIEW"],
      categories: [],
      schemes: ["demo"],
      hosts: ["open"],
    });
    expect(info.nativeLibraries).toEqual({
      "arm64-v8a": ["libnative.so", "libflutter.so"],
    });
    expect(info.dexFiles.map((d) => d.name)).toEqual(["classes.dex", "classes2.dex"]);
    expect(info.signatureSchemes).toEqual(["v1 (JAR)"]);
    expect(info.findings.map((f) => f.kind)).toEqual([
      "apk.debuggable",
      "apk.cleartext",
      "apk.dangerous-permissions",
      "apk.exported-components",
      "apk.deep-links",
      "apk.native",
      "apk.framework",
    ]);
    expect(info.findings.find((f) => f.kind === "apk.exported-components")?.detail).toBe(
      "service .SyncService",
    );
    expect(info.findings.find((f) => f.kind === "apk.framework")?.title).toBe("Built with Flutter");
  });
  it("requires a manifest", () => {
    expect(() => parseApk(buildZip({ "a.txt": "x" }))).toThrow(/AndroidManifest/);
  });
});
