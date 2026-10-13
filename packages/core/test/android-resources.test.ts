import { describe, expect, it } from "vitest";
import { parseApk } from "../src/formats/apk.js";
import { parseArsc } from "../src/formats/arsc.js";
import {
  inspectDartLibrary,
  readDartSnapshotHeader,
  summarizeFlutter,
} from "../src/formats/flutter.js";
import { buildArsc } from "./fixtures/arsc.js";
import { buildAxml } from "./fixtures/axml.js";
import { Builder } from "./fixtures/builder.js";
import { buildElf } from "./fixtures/elf.js";
import { buildZip } from "./fixtures/zip.js";

describe("parseArsc", () => {
  it("reads packages, default values, locales and densities and resolves references", () => {
    const arsc = parseArsc(buildArsc());
    expect(arsc.packages).toEqual([
      {
        id: 0x7f,
        name: "com.example.demo",
        typeCount: 2,
        entryCount: 3,
        locales: ["de-DE", "fr"],
        densities: ["xxhdpi"],
      },
    ]);
    expect(
      arsc.entries.map((e) => `${e.id} ${e.type}/${e.key} = ${e.value} (+${e.variants})`),
    ).toEqual([
      "0x7f010000 string/app_name = Demo App (+2)",
      "0x7f010001 string/hello = Hello (+0)",
      "0x7f020000 color/primary = #ff336699 (+0)",
    ]);
    expect(arsc.resolve("@0x7f010000")).toBe("Demo App");
    expect(arsc.resolve("@7f010001")).toBe("Hello");
    expect(arsc.resolve("@0x7f0100ff")).toBeNull();
    expect(arsc.resolve("plain")).toBeNull();
  });
  it("decodes AAPT2 offset16/compact layouts and typeIdOffset", () => {
    const modern = parseArsc(buildArsc({ modern: true }));
    expect(modern.entries.map((e) => `${e.key}=${e.value}`)).toEqual([
      "app_name=Demo App",
      "hello=Hello",
      "primary=#ff336699",
    ]);
    const split = parseArsc(buildArsc({ typeIdOffset: 2 }));
    expect(split.entries.map((e) => e.id)).toEqual(["0x7f030000", "0x7f030001", "0x7f040000"]);
  });
  it("rejects other data", () => {
    expect(() => parseArsc(new Uint8Array(32))).toThrow(/resources\.arsc/);
  });
  it("resolves the application label through the APK analyzer", () => {
    const manifest = buildAxml({
      tag: "manifest",
      attrs: [["package", "com.example.demo", false]],
      children: [{ tag: "application", attrs: [["label", "@0x7f010000"]] }],
    });
    const apk = buildZip({
      "AndroidManifest.xml": manifest,
      "resources.arsc": buildArsc(),
      "classes.dex": "x",
    });
    const info = parseApk(apk);
    expect(info.application.label).toBe("Demo App");
    expect(info.resources).toMatchObject({ entries: 3, locales: ["de-DE", "fr"], strings: 2 });
  });
});

const snapshot = (length = 100, kind = 2): Uint8Array => {
  const b = new Builder();
  b.bytes([0xf5, 0xf5, 0xdc, 0xdc])
    .u64(length)
    .u64(kind)
    .ascii("8ee4ef7a67df9845fba331734198a953")
    .cstr("product no-code_comments arm64 dwarf-stack-traces");
  b.pad(length + 4);
  return b.done();
};

describe("Flutter facts", () => {
  it("reads a snapshot header", () => {
    const h = readDartSnapshotHeader(snapshot(), 0)!;
    expect(h).toEqual({
      size: 104,
      kind: "full-aot",
      kindId: 2,
      versionHash: "8ee4ef7a67df9845fba331734198a953",
      features: "product no-code_comments arm64 dwarf-stack-traces",
    });
    expect(readDartSnapshotHeader(new Uint8Array(40), 0)).toBeNull();
    expect(readDartSnapshotHeader(snapshot(1), 0)).toBeNull();
    expect(readDartSnapshotHeader(snapshot(60), 0)?.features).toBeNull();
  });
  it("reports libraries without snapshot symbols as limitations and summarizes an APK's Flutter payload", () => {
    const plain = inspectDartLibrary(buildElf(), "arm64-v8a");
    expect(plain.snapshots).toEqual([]);
    expect(plain.limitations[0]?.code).toBe("dart_no_snapshots");
    const summary = summarizeFlutter([
      { abi: "arm64-v8a", name: "libflutter.so", bytes: buildElf() },
      { abi: "arm64-v8a", name: "libapp.so", bytes: buildElf() },
    ]);
    expect(summary.abis).toEqual(["arm64-v8a"]);
    expect(summary.engineBuildIds).toEqual({ "arm64-v8a": "0102030405060708" });
    expect(Object.keys(summary.libraryDigests)).toEqual([
      "arm64-v8a/libflutter.so",
      "arm64-v8a/libapp.so",
    ]);
    expect(summary.snapshotHash).toBeNull();
  });
});
