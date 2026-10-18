import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { findElectronApp, findElectronAppInZip, orderFor } from "../src/formats/electronApp.js";
import {
  FUSE_SENTINEL,
  MAX_ANCHORS,
  MAX_MARKERS,
  asarHeaderHash,
  bytesSource,
  decodeFuses,
  executableStems,
  peIntegrity,
  plistIntegrity,
  readRuntimeInZip,
  readRuntimeOnDisk,
  scanRuntimeBinary,
  supportOf,
} from "../src/formats/electronRuntime.js";
import { openZip } from "../src/formats/zip.js";
import { openAsarFile } from "../src/formats/asar.js";
import { execFileSync } from "node:child_process";
import { Session, checkRelease, parsePolicy } from "../src/index.js";
import { buildAsar } from "./fixtures/asar.js";
import { buildMacho } from "./fixtures/macho.js";
import { buildZip } from "./fixtures/zip.js";

const dir = mkdtempSync(join(tmpdir(), "hexvero-runtime-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const latin1 = (s: string): Buffer => Buffer.from(s, "latin1");

interface Runtime {
  electron?: string;
  chrome?: string;
  node?: string;
  version?: number;
  wire?: string;
  /** No fuse sentinel at all (Electron before 12, or a helper). */
  noWire?: boolean;
}

/** The markers of an Electron binary: user agent, Node release URL, fuse wire. Synthetic bytes. */
function markers(r: Runtime = {}): Buffer {
  const electron = r.electron ?? "30.1.0";
  const chrome = r.chrome ?? "124.0.6367.243";
  const node = r.node ?? "20.14.0";
  const wire = r.wire ?? "010011011";
  return Buffer.concat([
    latin1(
      `isRunAsNodeEnabled\0Chrome/${chrome} Electron/${electron}\0%s/%s Chrome/%s Electron/${electron}\0`,
    ),
    latin1(`https://nodejs.org/download/release/v${node}/node-v${node}.tar.gz\0`),
    latin1(`https://nodejs.org/download/release/v${node}/node-v${node}-headers.tar.gz\0`),
    ...(r.noWire
      ? []
      : [latin1(FUSE_SENTINEL), Buffer.from([r.version ?? 1, wire.length]), latin1(wire)]),
    Buffer.alloc(4),
  ]);
}

/** A Mach-O-looking framework binary of `size` bytes with the markers in the middle. */
function framework(r: Runtime = {}, size = 1 << 20): Buffer {
  const m = markers(r);
  return Buffer.concat([
    Buffer.from(buildMacho()),
    Buffer.alloc(size >> 1),
    m,
    Buffer.alloc(size >> 2),
  ]);
}

const app = (host: string): Record<string, string> => ({
  "package.json": JSON.stringify({ name: "fixture", version: "1.0.0", main: "main.js" }),
  "main.js": `const { ipcMain } = require("electron");\nipcMain.handle("app:ping", () => fetch("https://${host}/x"));\n`,
});

const plist = (integrity: Record<string, string> | null): string =>
  `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>com.example.fixture</string>
  <key>CFBundleName</key><string>Fixture</string>
  <key>CFBundleShortVersionString</key><string>1.0.0</string>
  <key>CFBundleExecutable</key><string>Fixture</string>${
    integrity
      ? `<key>ElectronAsarIntegrity</key><dict>${Object.entries(integrity)
          .map(
            ([path, hash]) =>
              `<key>${path}</key><dict><key>algorithm</key><string>SHA256</string><key>hash</key><string>${hash}</string></dict>`,
          )
          .join("")}</dict>`
      : ""
  }
</dict></plist>`;

/** A macOS bundle with an Electron framework binary (or none) and `resources`. */
function macApp(
  name: string,
  resources: Record<string, Uint8Array | string>,
  options: { runtime?: Runtime | null; integrity?: Record<string, string> | null } = {},
): string {
  const root = join(dir, name);
  mkdirSync(join(root, "Contents", "MacOS"), { recursive: true });
  const fw = join(root, "Contents", "Frameworks", "Electron Framework.framework", "Versions", "A");
  mkdirSync(fw, { recursive: true });
  if (options.runtime !== null)
    writeFileSync(join(fw, "Electron Framework"), framework(options.runtime));
  writeFileSync(join(root, "Contents", "Info.plist"), plist(options.integrity ?? null));
  writeFileSync(join(root, "Contents", "MacOS", "Fixture"), buildMacho());
  for (const [path, bytes] of Object.entries(resources)) {
    const full = join(root, "Contents", "Resources", ...path.split("/"));
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, bytes);
  }
  return root;
}

const headerHash = (asar: Uint8Array): string => {
  const length = Buffer.from(asar).readUInt32LE(12);
  return createHash("sha256")
    .update(asar.subarray(16, 16 + length))
    .digest("hex");
};

/**
 * A PE32+ file with one section `.rsrc` holding `Integrity/ElectronAsar` (when `json` is given),
 * padded to `size` bytes with the runtime markers after the section.
 */
function windowsExe(json: string | null, r: Runtime = {}, size = 1 << 20): Buffer {
  const head = Buffer.alloc(0x200);
  head.write("MZ", 0, "latin1");
  head.writeUInt32LE(0x40, 0x3c);
  head.write("PE\0\0", 0x40, "latin1");
  head.writeUInt16LE(0x8664, 0x44); // machine
  head.writeUInt16LE(1, 0x46); // sections
  head.writeUInt16LE(240, 0x54); // optional header size
  const opt = 0x58;
  head.writeUInt16LE(0x20b, opt);
  head.writeUInt32LE(16, opt + 108); // NumberOfRvaAndSizes
  const rsrc = Buffer.alloc(0x400);
  const name = (at: number, text: string): void => {
    rsrc.writeUInt16LE(text.length, at);
    for (let i = 0; i < text.length; i++) rsrc.writeUInt16LE(text.charCodeAt(i), at + 2 + i * 2);
  };
  const dirAt = (at: number, named: number, ids: number): void => {
    rsrc.writeUInt16LE(named, at + 12);
    rsrc.writeUInt16LE(ids, at + 14);
  };
  if (json !== null) {
    dirAt(0x00, 1, 0);
    rsrc.writeUInt32LE((0x58 | 0x80000000) >>> 0, 0x10); // name "INTEGRITY"
    rsrc.writeUInt32LE((0x18 | 0x80000000) >>> 0, 0x14);
    dirAt(0x18, 1, 0);
    rsrc.writeUInt32LE((0x6c | 0x80000000) >>> 0, 0x28); // name "ELECTRONASAR"
    rsrc.writeUInt32LE((0x30 | 0x80000000) >>> 0, 0x2c);
    dirAt(0x30, 0, 1);
    rsrc.writeUInt32LE(1033, 0x40);
    rsrc.writeUInt32LE(0x48, 0x44); // data entry
    const data = latin1(json);
    rsrc.writeUInt32LE(0x1000 + 0x88, 0x48);
    rsrc.writeUInt32LE(data.length, 0x4c);
    name(0x58, "INTEGRITY");
    name(0x6c, "ELECTRONASAR");
    data.copy(rsrc, 0x88);
  } else dirAt(0x00, 0, 0);
  // data directory 2 (resources) and the section table
  head.writeUInt32LE(0x1000, opt + 112 + 16);
  head.writeUInt32LE(rsrc.length, opt + 112 + 20);
  const table = opt + 240;
  head.write(".rsrc", table, "latin1");
  head.writeUInt32LE(rsrc.length, table + 8);
  head.writeUInt32LE(0x1000, table + 12);
  head.writeUInt32LE(rsrc.length, table + 16);
  head.writeUInt32LE(0x200, table + 20);
  const body = Buffer.concat([head, rsrc, markers(r)]);
  return Buffer.concat([body, Buffer.alloc(Math.max(0, size - body.length))]);
}

describe("the runtime binary", () => {
  it("reads the versions and the fuse wire, with where they are", () => {
    const bytes = framework({ electron: "44.7.2", chrome: "152.0.7977.149", node: "24.21.0" });
    const scan = scanRuntimeBinary(bytesSource(bytes));
    expect(scan.electron.map((m) => m.value)).toEqual(["44.7.2"]);
    expect(scan.chromium.map((m) => m.value)).toEqual(["152.0.7977.149"]);
    // the release URL and the headers URL
    expect(scan.node.map((m) => m.value)).toEqual(["24.21.0", "24.21.0"]);
    expect(scan.fuses).toEqual([
      { offset: bytes.indexOf(FUSE_SENTINEL), version: 1, wire: "010011011", whole: true },
    ]);
    expect(scan.electron[0]!.offset).toBe(bytes.indexOf("Chrome/152"));
  });

  it("finds a marker that straddles two read windows", () => {
    const m = markers({ electron: "33.4.11" });
    const at = (8 << 20) - 20; // the user agent starts 20 bytes before the second window
    const bytes = Buffer.alloc(at + m.length + 100);
    m.copy(bytes, at - "isRunAsNodeEnabled\0".length);
    const scan = scanRuntimeBinary(bytesSource(bytes));
    expect(scan.electron.map((x) => x.value)).toEqual(["33.4.11"]);
    expect(scan.fuses).toHaveLength(1);
  });

  it("is unknown when the markers disagree (two slices of a universal binary)", () => {
    const bytes = Buffer.concat([markers({ electron: "40.1.0" }), markers({ electron: "40.1.1" })]);
    const scan = scanRuntimeBinary(bytesSource(bytes));
    const root = macApp(
      "Disagree.app",
      { "app.asar": buildAsar(app("a.example")) },
      { runtime: null },
    );
    writeFileSync(
      join(
        root,
        "Contents",
        "Frameworks",
        "Electron Framework.framework",
        "Versions",
        "A",
        "Electron Framework",
      ),
      bytes,
    );
    expect(scan.electron).toHaveLength(2);
    const { runtime } = readRuntimeOnDisk(root, "macos", "Contents/Resources/app.asar", "asar", {
      today: "2026-10-18",
    });
    expect(runtime.electron).toBe("unknown");
    expect(runtime.rows.find((r) => r.item === "electron")?.detail).toMatch(
      /disagree \(40\.1\.0 at 0x13, 40\.1\.1 at 0x127\)$/,
    );
    expect(runtime.support).toBe("unknown");
    // the same Chromium and fuse wire in both: those are known
    expect(runtime.chromium).toBe("124.0.6367.243");
    expect(runtime.fuses["runAsNode"]).toBe("off");
  });

  it("decides nothing past MAX_MARKERS occurrences of a marker", () => {
    const one = markers();
    const scan = scanRuntimeBinary(
      bytesSource(Buffer.concat(Array.from({ length: MAX_MARKERS + 1 }, () => one))),
    );
    expect(scan.overflow).toEqual({ electron: true, node: true, fuses: true });
    expect(decodeFuses(scan, "bin").fuses).toEqual([]);
  });

  it("is unknown without any marker, and says so", () => {
    const scan = scanRuntimeBinary(bytesSource(Buffer.alloc(4096)));
    expect(scan.electron).toEqual([]);
    expect(decodeFuses(scan, "bin").detail).toBe("no fuse sentinel in bin");
  });
});

const decode = (version: number, wire: string) =>
  decodeFuses(scanRuntimeBinary(bytesSource(markers({ version, wire }))), "bin");

describe("the fuse wire", () => {
  it("names the fuses of schema version 1 in order (Claude 44.7.2: 010011011)", () => {
    const f = decode(1, "010011011");
    expect(f.fuses.map((x) => [x.name, x.value])).toEqual([
      ["runAsNode", "off"],
      ["cookieEncryption", "on"],
      ["nodeOptions", "off"],
      ["nodeCliInspect", "off"],
      ["embeddedAsarIntegrityValidation", "on"],
      ["onlyLoadAppFromAsar", "on"],
      ["loadBrowserProcessSpecificV8Snapshot", "off"],
      ["grantFileProtocolExtraPrivileges", "on"],
      ["wasmTrapHandlers", "on"],
    ]);
  });

  it("lists the fuses an older wire has (8 in LM Studio's Electron 37) and `r` as removed", () => {
    const f = decode(1, "1r110001");
    expect(f.fuses).toHaveLength(8);
    expect(f.fuses[1]).toMatchObject({ name: "cookieEncryption", value: "removed" });
  });

  it("marks positions past the schema and unknown characters unknown, never guessed", () => {
    const f = decode(1, "0100110110X");
    expect(f.fuses.slice(9).map((x) => [x.name, x.value])).toEqual([
      ["#10", "unknown"],
      ["#11", "unknown"],
    ]);
    const odd = decode(1, "0x0");
    expect(odd.fuses[1]).toMatchObject({ name: "cookieEncryption", value: "unknown" });
  });

  it("names nothing under another schema version", () => {
    const f = decode(2, "0100");
    expect(f.version).toBe(2);
    expect(f.fuses.map((x) => [x.name, x.value])).toEqual([
      ["#1", "unknown"],
      ["#2", "unknown"],
      ["#3", "unknown"],
      ["#4", "unknown"],
    ]);
  });

  it("is unknown at a position where two wires differ", () => {
    const scan = scanRuntimeBinary(
      bytesSource(Buffer.concat([markers({ wire: "010" }), markers({ wire: "110" })])),
    );
    const f = decodeFuses(scan, "bin");
    expect(f.fuses.map((x) => x.value)).toEqual(["unknown", "on", "off"]);
    expect(f.wire).toBeNull();
  });
});

describe("support status", () => {
  const snapshot = {
    snapshot: "2026-10-18",
    sources: [],
    versions: { "37.7.1": ["2025-10-21", "138.0.7204.251", "22.20.0"] as [string, string, string] },
    majors: {
      "37": { stable: "2025-06-23", eol: "2026-01-15" },
      "42": { stable: "2026-05-05", eol: "2026-10-20" },
    },
  };
  it("is past end of support after the line's end-of-life date, with the snapshot date", () => {
    expect(supportOf("37.7.1", "2026-10-18", snapshot)).toEqual({
      value: "past end of support",
      eol: "2026-01-15",
      detail:
        "Electron 37.7.1 is past its end of support (2026-01-15, from the snapshot of 2026-10-18, as of 2026-10-18); 37.7.1 was released on 2025-10-21",
    });
  });
  it("is supported up to that date, which is planned when it is after the snapshot", () => {
    const s = supportOf("42.11.8", "2026-10-19", snapshot);
    expect(s.value).toBe("supported");
    expect(s.detail).toContain(
      "planned for 2026-10-20 (from the snapshot of 2026-10-18, as of 2026-10-19)",
    );
    // the end-of-life day is the next stable line's release day: past on that day
    expect(supportOf("42.11.8", "2026-10-20", snapshot).value).toBe("past end of support");
  });
  it("calls a prerelease a prerelease, not supported", () => {
    const s = supportOf("42.0.0-beta.3", "2026-04-01", snapshot);
    expect(s.value).toBe("prerelease");
    expect(s.detail).toContain("is a prerelease (beta), not a stable release");
    expect(supportOf("37.0.0-alpha.1", "2026-10-18", snapshot).value).toBe("past end of support");
  });
  it("is unknown for a line the snapshot does not have", () => {
    expect(supportOf("47.0.0", "2026-10-18", snapshot)).toMatchObject({
      value: "unknown",
      eol: null,
    });
    expect(supportOf("unknown", "2026-10-18", snapshot).value).toBe("unknown");
  });
});

describe("ASAR integrity", () => {
  it("reads the Info.plist record", () => {
    const r = plistIntegrity(
      latin1(plist({ "Resources/app.asar": "ab".repeat(32) })),
      "Contents/Info.plist",
    );
    expect(r).toEqual({
      state: "read",
      source: "Contents/Info.plist",
      entries: [{ path: "Resources/app.asar", algorithm: "SHA256", hash: "ab".repeat(32) }],
    });
    expect(plistIntegrity(latin1(plist(null)), "Contents/Info.plist").state).toBe("none");
  });

  it("reads the resource Integrity/ElectronAsar of a Windows executable", () => {
    const json = JSON.stringify([
      { file: "resources\\app.asar", alg: "SHA256", value: "cd".repeat(32) },
    ]);
    expect(peIntegrity(bytesSource(windowsExe(json)), "Fixture.exe")).toEqual({
      state: "read",
      source: "Fixture.exe resource Integrity/ElectronAsar",
      entries: [{ path: "resources\\app.asar", algorithm: "SHA256", hash: "cd".repeat(32) }],
    });
    expect(peIntegrity(bytesSource(windowsExe(null)), "Fixture.exe").state).toBe("none");
    expect(peIntegrity(bytesSource(Buffer.from("not a PE")), "x.exe").state).toBe("unknown");
  });

  it("hashes an archive's header as Electron does", () => {
    const asar = buildAsar(app("h.example"));
    expect(asarHeaderHash(bytesSource(asar))).toBe(headerHash(asar));
    expect(asarHeaderHash(bytesSource(new Uint8Array(8)))).toBeNull();
  });
});

describe("the runtime of a packaged build", () => {
  it("lists versions, fuses, integrity and support of a macOS .app", () => {
    const asar = buildAsar(app("mac.example"));
    const root = macApp(
      "Runtime.app",
      { "app.asar": asar },
      { runtime: {}, integrity: { "Resources/app.asar": headerHash(asar) } },
    );
    const { runtime, limitations } = readRuntimeOnDisk(
      root,
      "macos",
      "Contents/Resources/app.asar",
      "asar",
      {
        today: "2026-10-18",
      },
    );
    expect(limitations).toEqual([]);
    expect(runtime).toMatchObject({
      shipped: true,
      binary: "Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework",
      platform: "macos",
      electron: "30.1.0",
      chromium: "124.0.6367.243",
      node: "20.14.0",
      support: "past end of support",
      asarIntegrity: "covers the loaded archive",
    });
    expect(runtime.fuses).toMatchObject({
      runAsNode: "off",
      embeddedAsarIntegrityValidation: "on",
    });
    const row = (item: string) => runtime.rows.find((r) => r.item === item);
    expect(row("electron")?.evidence).toMatch(/Versions\/A\/Electron Framework@0x[0-9a-f]+$/);
    expect(row("support")?.detail).toMatch(
      /^Electron 30\.1\.0 is past its end of support \(\d{4}-\d{2}-\d{2}, from the snapshot of \d{4}-\d{2}-\d{2}, as of \d{4}-\d{2}-\d{2}\)/,
    );
    expect(row("asarIntegrity:Resources/app.asar")).toMatchObject({
      header: "matches",
      algorithm: "SHA256",
    });
    expect(row("asarIntegrity")?.detail).toContain("embeddedAsarIntegrityValidation is on");
  });

  it("says the record does not cover the archive Electron loads (Discord: default_app.asar only)", () => {
    const root = macApp(
      "OtherArchive.app",
      { "app.asar": buildAsar(app("d.example")) },
      {
        runtime: { wire: "001000011" },
        integrity: { "Resources/default_app.asar": "0c".repeat(32) },
      },
    );
    const { runtime } = readRuntimeOnDisk(root, "macos", "Contents/Resources/app.asar", "asar");
    expect(runtime.asarIntegrity).toBe("does not cover the loaded archive");
    expect(
      runtime.rows.find((r) => r.item === "asarIntegrity:Resources/default_app.asar")?.header,
    ).toBe("archive absent");
    const differs = macApp(
      "Differs.app",
      { "app.asar": buildAsar(app("e.example")) },
      { runtime: {}, integrity: { "Resources/app.asar": "00".repeat(32) } },
    );
    const read = readRuntimeOnDisk(differs, "macos", "Contents/Resources/app.asar", "asar").runtime;
    expect(read.asarIntegrity).toBe("covers the loaded archive");
    expect(read.rows.find((r) => r.item === "asarIntegrity:Resources/app.asar")?.header).toBe(
      "differs",
    );
  });

  it("is unknown, with a limitation, when the bundle has no framework binary", () => {
    const root = macApp(
      "NoBinary.app",
      { "app.asar": buildAsar(app("n.example")) },
      { runtime: null },
    );
    const { runtime, limitations } = readRuntimeOnDisk(
      root,
      "macos",
      "Contents/Resources/app.asar",
      "asar",
    );
    expect(runtime.electron).toBe("unknown");
    expect(runtime.fuses).toEqual({});
    expect(limitations.map((l) => l.code)).toEqual(["electron_runtime_not_read"]);
    expect(runtime.rows.find((r) => r.item === "fuses")?.value).toBe("unknown");
  });

  it("reads a Windows install directory: the .exe, its integrity resource", () => {
    const root = join(dir, "win");
    mkdirSync(join(root, "resources"), { recursive: true });
    writeFileSync(join(root, "resources", "app.asar"), buildAsar(app("w.example")));
    writeFileSync(join(root, "resources.pak"), "pak");
    const json = JSON.stringify([
      { file: "resources\\app.asar", alg: "SHA256", value: "cd".repeat(32) },
    ]);
    writeFileSync(join(root, "Fixture.exe"), windowsExe(json, { electron: "31.0.0" }));
    writeFileSync(join(root, "Update.exe"), windowsExe(null, { electron: "1.0.0" }, 2 << 20));
    const { runtime } = readRuntimeOnDisk(root, "windows-linux", "resources/app.asar", "asar");
    expect(runtime).toMatchObject({
      binary: "Fixture.exe",
      platform: "windows",
      electron: "31.0.0",
      asarIntegrity: "covers the loaded archive",
    });
    expect(runtime.rows.find((r) => r.item === "asarIntegrity:resources\\app.asar")?.header).toBe(
      "differs",
    );
  });

  it("does not take the resources of an .exe without an Electron marker as the record", () => {
    const root = join(dir, "win-other");
    mkdirSync(join(root, "resources"), { recursive: true });
    writeFileSync(join(root, "resources", "app.asar"), buildAsar(app("o.example")));
    writeFileSync(join(root, "resources.pak"), "pak");
    // named like the app, but without markers and without a record
    const named = windowsExe(null, {}, 3 << 20);
    named.fill(0, 0x600);
    writeFileSync(join(root, "Fixture.exe"), named);
    const { runtime } = readRuntimeOnDisk(root, "windows-linux", "resources/app.asar", "asar");
    expect(runtime).toMatchObject({
      binary: "Fixture.exe",
      electron: "unknown",
      asarIntegrity: "unknown",
    });
    expect(runtime.rows.find((r) => r.item === "asarIntegrity")?.detail).toContain(
      "Fixture.exe holds no Electron version marker",
    );
  });

  it("takes no unnamed file without a user agent and a fuse wire (a helper)", () => {
    const helper = Buffer.concat([
      windowsExe(null, {}, 2 << 20).fill(0, 0x600),
      latin1("Chrome/144.0.7559.96 Electron/28.0.0\0"),
    ]);
    const root = winDir("win-helper", { "helper.exe": helper });
    const { runtime, limitations } = readRuntimeOnDisk(
      root,
      "windows-linux",
      "resources/app.asar",
      "asar",
    );
    expect(runtime.electron).toBe("unknown");
    expect(runtime.support).toBe("unknown");
    expect(limitations[0]?.message).toContain(
      "none of the 1 largest PE or ELF files scanned (helper.exe) holds both an Electron user agent and a fuse wire",
    );
  });

  it("does not scan a binary over 1 GiB, and says so", () => {
    const root = macApp(
      "Huge.app",
      { "app.asar": buildAsar(app("huge.example")) },
      { runtime: {} },
    );
    const bin = join(
      root,
      "Contents",
      "Frameworks",
      "Electron Framework.framework",
      "Versions",
      "A",
      "Electron Framework",
    );
    truncateSync(bin, (1 << 30) + 1); // sparse: nothing is written, and nothing must be read
    const { runtime, limitations } = readRuntimeOnDisk(
      root,
      "macos",
      "Contents/Resources/app.asar",
      "asar",
    );
    expect(runtime.electron).toBe("unknown");
    expect(limitations[0]?.message).toContain("more than the 1024 MiB hexvero reads");
  });

  it("reads a Linux install directory and says integrity is not read there", () => {
    const root = join(dir, "linux");
    mkdirSync(join(root, "resources"), { recursive: true });
    writeFileSync(join(root, "resources", "app.asar"), buildAsar(app("l.example")));
    writeFileSync(join(root, "icudtl.dat"), "icu");
    const elf = Buffer.concat([
      Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
      Buffer.alloc(1 << 20),
      markers(),
    ]);
    writeFileSync(join(root, "fixture"), elf);
    writeFileSync(join(root, "chrome-sandbox"), elf);
    const { runtime } = readRuntimeOnDisk(root, "windows-linux", "resources/app.asar", "asar");
    expect(runtime).toMatchObject({ binary: "fixture", platform: "linux", electron: "30.1.0" });
    expect(runtime.asarIntegrity).toBe("unknown");
    expect(runtime.rows.find((r) => r.item === "asarIntegrity")?.detail).toContain(
      "hexvero reads ASAR integrity records of macOS builds (Info.plist) and Windows builds (an .exe resource) only",
    );
  });

  it("reads the runtime of a .app inside a ZIP, the binary inflated within the cap", () => {
    const asar = buildAsar(app("z.example"));
    const zip = openZip(
      buildZip({
        "Fixture.app/Contents/Info.plist": plist({ "Resources/app.asar": headerHash(asar) }),
        "Fixture.app/Contents/Resources/app.asar": asar,
        "Fixture.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework":
          framework({ electron: "35.0.0" }),
      }),
    );
    const { runtime } = readRuntimeInZip(
      zip,
      "Fixture.app/",
      "macos",
      "Contents/Resources/app.asar",
      "asar",
      1 << 30,
      asar,
    );
    expect(runtime).toMatchObject({
      electron: "35.0.0",
      asarIntegrity: "covers the loaded archive",
    });
    expect(runtime.rows.find((r) => r.item === "asarIntegrity:Resources/app.asar")?.header).toBe(
      "matches",
    );
    const capped = readRuntimeInZip(
      zip,
      "Fixture.app/",
      "macos",
      "Contents/Resources/app.asar",
      "asar",
      1024,
      asar,
    );
    expect(capped.runtime.electron).toBe("unknown");
    expect(capped.limitations[0]?.message).toContain(
      "more than the 0 MiB hexvero reads out of an archive",
    );
  });
});

const both = (host: string) => ({
  "app/package.json": app(host)["package.json"]!,
  "app/main.js": app(host)["main.js"]!,
  "app.asar": buildAsar(app("asar.example")),
});

describe("the app Electron runs, by its version and fuse", () => {
  it("Electron 15 and later run app.asar before app/", () => {
    const root = macApp("Modern.app", both("dir.example"), {
      runtime: { electron: "30.1.0", wire: "010000011" },
    });
    const found = findElectronApp(root);
    expect(found).toMatchObject({ entry: "Contents/Resources/app.asar", kind: "asar" });
    expect(found?.warning).toBeUndefined();
    expect(found?.note).toContain(
      "Electron 30.1.0 (a fuse wire of 9 positions) runs the first of app.asar, app/ and default_app.asar",
    );
  });

  it("Electron 14 and earlier run app/ first", () => {
    const root = macApp("Old.app", both("dir.example"), {
      runtime: { electron: "14.2.9", wire: "0000" },
    });
    expect(findElectronApp(root)).toMatchObject({
      entry: "Contents/Resources/app",
      kind: "directory",
    });
  });

  it("with onlyLoadAppFromAsar on, Electron runs app.asar or nothing", () => {
    const root = macApp(
      "AsarOnly.app",
      { "app/package.json": app("d.example")["package.json"]!, "app/main.js": "1;\n" },
      { runtime: { electron: "30.1.0", wire: "000001" } },
    );
    expect(findElectronApp(root)?.refused).toMatch(
      /runs only app\.asar, and there is no app\.asar: it finds no app here/,
    );
    const fine = macApp("AsarOnly2.app", both("x.example"), { runtime: { wire: "000001" } });
    expect(findElectronApp(fine)).toMatchObject({ entry: "Contents/Resources/app.asar" });
  });

  it("warns when the version and the fuse cannot be read and the pick depends on them", () => {
    const root = macApp("Unread.app", both("dir.example"), { runtime: null });
    const found = findElectronApp(root);
    expect(found?.entry).toBe("Contents/Resources/app.asar");
    expect(found?.warning).toMatch(
      /^The Electron version and the fuse onlyLoadAppFromAsar could not be read \(the bundle has no .*\)\. hexvero read Contents\/Resources\/app\.asar by Electron's order for Electron 15\.0\.0-beta\.6 and later; with Electron before 15\.0\.0-beta\.6 Electron runs Contents\/Resources\/app\.$/,
    );
  });

  it("reads no binary when every order gives the same app", () => {
    // only app.asar: the framework binary is not even there, and no warning is needed
    const root = macApp(
      "Plain.app",
      { "app.asar": buildAsar(app("p.example")) },
      { runtime: null },
    );
    expect(findElectronApp(root)).toEqual({
      entry: "Contents/Resources/app.asar",
      kind: "asar",
      layout: "macos",
    });
  });

  it("orders a ZIP's candidates the same way", () => {
    const zip = openZip(
      buildZip({
        "F.app/Contents/Info.plist": plist(null),
        "F.app/Contents/Resources/app/package.json": app("d.example")["package.json"]!,
        "F.app/Contents/Resources/app.asar": buildAsar(app("asar.example")),
        "F.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework":
          framework({ electron: "13.6.9", wire: "0000" }),
      }),
    );
    // Electron 13 runs app/ first, which hexvero does not read out of a ZIP
    expect(findElectronAppInZip(zip, 1 << 30)?.refused).toContain("app/ directory");
  });

  it("chooses the order from what was read", () => {
    expect(
      orderFor({ electron: "40.0.0", onlyLoadAppFromAsar: "off", detail: "" }).alternatives,
    ).toEqual([]);
    expect(
      orderFor({ electron: "unknown", onlyLoadAppFromAsar: "off", detail: "" }).alternatives,
    ).toHaveLength(1);
    expect(orderFor({ electron: "40.0.0", onlyLoadAppFromAsar: "on", detail: "x" }).order).toEqual([
      "app.asar",
    ]);
  });
});

describe("the runtime collection", () => {
  it("is listed for a packaged build and compared by item", async () => {
    const session = new Session();
    const a = await session.open(
      macApp(
        "A.app",
        { "app.asar": buildAsar(app("a.example")) },
        { runtime: { wire: "010011011" } },
      ),
    );
    const b = await session.open(
      macApp(
        "B.app",
        { "app.asar": buildAsar(app("a.example")) },
        { runtime: { wire: "110011011", node: "20.15.0" } },
      ),
    );
    const analysis = await session.analyze(a.id);
    expect(analysis.data.kind === "javascript-app" && analysis.data.runtime?.electron).toBe(
      "30.1.0",
    );
    expect((await session.collections(a.id))["runtime"]).toBe(
      analysis.data.kind === "javascript-app" ? analysis.data.runtime!.rows.length : -1,
    );
    const { diff } = await session.compareCollection(a.id, b.id, "runtime");
    expect(diff.key).toBe("item");
    expect(
      diff.changed.map((c) => [c.key, c.fields.map((f) => [f.field, f.before, f.after])]),
    ).toEqual([
      ["node", [["value", "20.14.0", "20.15.0"]]],
      ["fuse.runAsNode", [["value", "off", "on"]]],
    ]);
    expect(diff.completeness.complete).toBe(true);
  });

  it("is not listed for an archive alone, whose analysis says the runtime is not in it", async () => {
    const path = join(dir, "alone.asar");
    writeFileSync(path, buildAsar(app("alone.example")));
    const session = new Session();
    const t = await session.open(path);
    const analysis = await session.analyze(t.id);
    expect(analysis.data.kind === "javascript-app" && analysis.data.runtime).toMatchObject({
      shipped: false,
      rows: [],
    });
    expect(analysis.data.kind === "javascript-app" && analysis.data.runtime?.note).toMatch(
      /^not shipped in this input/,
    );
    expect("runtime" in (await session.collections(t.id))).toBe(false);
  });
});

describe("policy rule fuse-weakened", () => {
  const policy = parsePolicy(
    '{"hexvero":"policy","version":1,"rules":{"fuse-weakened":{"level":"fail"}}}',
    "p.json",
  );

  it("fails on a fuse moved to its less safe state and on lost integrity coverage", async () => {
    const asar = buildAsar(app("p.example"));
    const session = new Session();
    const a = await session.open(
      macApp(
        "PA.app",
        { "app.asar": asar },
        { runtime: { wire: "010011011" }, integrity: { "Resources/app.asar": headerHash(asar) } },
      ),
    );
    const b = await session.open(
      macApp(
        "PB.app",
        { "app.asar": asar },
        {
          runtime: { wire: "110010011" },
          integrity: { "Resources/default_app.asar": headerHash(asar) },
        },
      ),
    );
    const r = await checkRelease(session, a.id, b.id, policy);
    expect(r.status).toBe("fail");
    expect(
      r.findings
        .filter((f) => f.rule === "fuse-weakened")
        .map((f) => [f.key, f.unknown, f.message]),
    ).toEqual([
      [
        "asarIntegrity",
        false,
        expect.stringMatching(
          /^The ASAR integrity record no longer covers what Electron loads: does not cover the loaded archive/,
        ),
      ],
      [
        "fuse.onlyLoadAppFromAsar",
        false,
        expect.stringMatching(/^Fuse onlyLoadAppFromAsar moved on → off: /),
      ],
      [
        "fuse.runAsNode",
        false,
        expect.stringMatching(/^Fuse runAsNode moved off → on: ELECTRON_RUN_AS_NODE/),
      ],
    ]);
    // the reverse is not a weakening
    const back = await checkRelease(session, b.id, a.id, policy);
    expect(back.findings.filter((f) => f.rule === "fuse-weakened")).toEqual([]);
  });

  it("gives an unknown finding when the after build's fuse cannot be read", async () => {
    const session = new Session();
    const asar = buildAsar(app("q.example"));
    const a = await session.open(macApp("QA.app", { "app.asar": asar }, { runtime: {} }));
    const b = await session.open(macApp("QB.app", { "app.asar": asar }, { runtime: null }));
    const r = await checkRelease(session, a.id, b.id, policy);
    const fuse = r.findings.filter((f) => f.rule === "fuse-weakened" && f.key.startsWith("fuse."));
    expect(fuse.map((f) => [f.key, f.unknown])).toEqual(
      [
        "fuse.cookieEncryption",
        "fuse.embeddedAsarIntegrityValidation",
        "fuse.grantFileProtocolExtraPrivileges",
        "fuse.nodeCliInspect",
        "fuse.nodeOptions",
        "fuse.onlyLoadAppFromAsar",
        "fuse.runAsNode",
      ]
        .filter((k) => !["fuse.grantFileProtocolExtraPrivileges"].includes(k))
        .map((k) => [k, true]),
    );
    expect(r.status).toBe("incomplete");
  });

  it("is undecidable when only one build is packaged, and silent when neither is", async () => {
    const session = new Session();
    const asar = buildAsar(app("r.example"));
    const path = join(dir, "r.asar");
    writeFileSync(path, asar);
    const plain = await session.open(path);
    const packaged = await session.open(macApp("R.app", { "app.asar": asar }, { runtime: {} }));
    const r = await checkRelease(session, plain.id, packaged.id, policy);
    expect(r.incomplete).toContainEqual({
      rule: "fuse-weakened",
      collection: "runtime",
      gaps: ["collection_missing"],
    });
    const same = await checkRelease(session, plain.id, plain.id, policy);
    expect(same.incomplete.filter((i) => i.rule === "fuse-weakened")).toEqual([]);
  });
});

const elf = (r: Runtime, size: number) =>
  Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(size), markers(r)]);

/** A Windows install directory with `files` (name → bytes) next to resources/app.asar. */
function winDir(
  name: string,
  files: Record<string, Uint8Array>,
  pkg: Record<string, unknown> = {},
): string {
  const root = join(dir, name);
  mkdirSync(join(root, "resources"), { recursive: true });
  writeFileSync(
    join(root, "resources", "app.asar"),
    buildAsar({
      ...app(`${name}.example`),
      "package.json": JSON.stringify({ name: "fixture", main: "main.js", ...pkg }),
    }),
  );
  writeFileSync(join(root, "resources.pak"), "pak");
  for (const [file, bytes] of Object.entries(files)) writeFileSync(join(root, file), bytes);
  return root;
}

describe("which file is the runtime binary (Windows, Linux)", () => {
  it("names executables as electron-builder, packager and Forge do", () => {
    expect(
      [...executableStems({ name: "lm-studio", productName: "LM Studio" })].toSorted(),
    ).toEqual(["lm studio", "lm-studio"]);
    expect(
      executableStems({ name: "x", build: { win: { executableName: "Y:Z" } } }).has("yz"),
    ).toBe(true);
    expect(executableStems(null).size).toBe(0);
  });

  it("reads the .exe named after the app, and scans the larger unnamed files too", () => {
    const tool = windowsExe(null, {}, 4 << 20).fill(0, 0x600);
    const root = winDir("win-named", {
      "Fixture.exe": windowsExe(null, { electron: "31.0.0" }),
      "tool.exe": tool,
    });
    const { runtime } = readRuntimeOnDisk(root, "windows-linux", "resources/app.asar", "asar");
    expect(runtime).toMatchObject({ binary: "Fixture.exe", electron: "31.0.0" });
    expect(runtime.rows.find((r) => r.item === "electron")?.detail).toContain(
      "Fixture.exe is named after the app (its package.json); also scanned: tool.exe (no Electron markers)",
    );
  });

  it("is unknown when a larger unnamed file holds another fuse wire than the named .exe", () => {
    const root = winDir("win-decoy", {
      "Fixture.exe": windowsExe(null, { electron: "31.0.0" }),
      "decoy.exe": windowsExe(null, { electron: "31.0.0", wire: "111111111" }, 4 << 20),
    });
    const { runtime, limitations } = readRuntimeOnDisk(
      root,
      "windows-linux",
      "resources/app.asar",
      "asar",
    );
    expect(runtime.electron).toBe("unknown");
    expect(runtime.fuses).toEqual({});
    expect(limitations[0]?.message).toMatch(
      /Fixture\.exe, decoy\.exe all hold Electron markers and disagree .*fuse wire 111111111/,
    );
  });

  it("takes the .exe carrying Integrity/ElectronAsar when no name matches", () => {
    const json = JSON.stringify([
      { file: "resources\\app.asar", alg: "SHA256", value: "cd".repeat(32) },
    ]);
    const root = winDir("win-integrity", {
      "Renamed.exe": windowsExe(json, { electron: "32.0.0" }),
      "big.exe": windowsExe(null, {}, 4 << 20).fill(0, 0x600),
    });
    const { runtime } = readRuntimeOnDisk(root, "windows-linux", "resources/app.asar", "asar");
    expect(runtime).toMatchObject({ binary: "Renamed.exe", electron: "32.0.0" });
  });

  it("is unknown when files that could be the runtime hold disagreeing markers", () => {
    const root = winDir("win-conflict", {
      "one.exe": windowsExe(null, { electron: "31.0.0" }, 2 << 20),
      "two.exe": windowsExe(null, { electron: "31.0.0", wire: "110011011" }, 3 << 20),
    });
    const { runtime, limitations } = readRuntimeOnDisk(
      root,
      "windows-linux",
      "resources/app.asar",
      "asar",
    );
    expect(runtime.electron).toBe("unknown");
    expect(runtime.rows.find((r) => r.item === "fuses")?.value).toBe("unknown");
    expect(limitations[0]?.message).toMatch(
      /two\.exe, one\.exe all hold Electron markers and disagree/,
    );
    // two named files disagree too
    const named = winDir(
      "win-named-conflict",
      {
        "Fixture.exe": windowsExe(null, { electron: "31.0.0" }),
        "fixture-app.exe": windowsExe(null, { electron: "30.0.0" }),
      },
      { productName: "fixture-app" },
    );
    expect(
      readRuntimeOnDisk(named, "windows-linux", "resources/app.asar", "asar").runtime.electron,
    ).toBe("unknown");
  });

  it("takes the largest file only by its markers when nothing is named, and says so", () => {
    const root = winDir("win-unnamed", {
      "app.exe": windowsExe(null, { electron: "31.0.0" }, 2 << 20),
      "tool.exe": windowsExe(null, {}, 3 << 20).fill(0, 0x600),
    });
    const { runtime } = readRuntimeOnDisk(root, "windows-linux", "resources/app.asar", "asar");
    expect(runtime).toMatchObject({ binary: "app.exe", electron: "31.0.0" });
    expect(runtime.rows.find((r) => r.item === "electron")?.detail).toContain(
      "app.exe was taken by its Electron user agent and fuse wire, not by a name the app's package.json gives: the 2 largest of 2 PE or ELF files were scanned",
    );
  });

  it("keeps the pick warning when the runtime cannot be told", () => {
    const root = winDir("win-pick", {
      "one.exe": windowsExe(null, { electron: "13.0.0" }, 2 << 20),
      "two.exe": windowsExe(null, { electron: "31.0.0" }, 3 << 20),
    });
    mkdirSync(join(root, "resources", "app"), { recursive: true });
    writeFileSync(
      join(root, "resources", "app", "package.json"),
      app("d.example")["package.json"]!,
    );
    const found = findElectronApp(root);
    expect(found?.entry).toBe("resources/app.asar");
    expect(found?.warning).toMatch(
      /could not be read \(two\.exe, one\.exe all hold Electron markers and disagree/,
    );
  });

  it("names the Linux binary after the package name in lower case", () => {
    const root = join(dir, "linux-named");
    mkdirSync(join(root, "resources"), { recursive: true });
    writeFileSync(
      join(root, "resources", "app.asar"),
      buildAsar({
        ...app("ln.example"),
        "package.json": JSON.stringify({ name: "Fixture-App", main: "main.js" }),
      }),
    );
    writeFileSync(join(root, "icudtl.dat"), "icu");
    writeFileSync(join(root, "fixture-app"), elf({ electron: "33.0.0" }, 1 << 20));
    writeFileSync(join(root, "sidecar"), elf({ electron: "33.0.0" }, 4 << 20));
    const { runtime } = readRuntimeOnDisk(root, "windows-linux", "resources/app.asar", "asar");
    expect(runtime).toMatchObject({ binary: "fixture-app", platform: "linux", electron: "33.0.0" });
    // a sidecar with other markers makes the reading unknown
    writeFileSync(join(root, "sidecar"), elf({ electron: "99.0.0" }, 4 << (20 + 1)));
    expect(
      readRuntimeOnDisk(root, "windows-linux", "resources/app.asar", "asar").runtime.electron,
    ).toBe("unknown");
  });
});

describe("files that are not regular", () => {
  it.skipIf(process.platform === "win32")(
    "refuses an app.asar that is a FIFO at once, without blocking",
    () => {
      const root = join(dir, "fifo");
      mkdirSync(join(root, "resources"), { recursive: true });
      writeFileSync(join(root, "resources.pak"), "pak");
      writeFileSync(join(root, "Fixture.exe"), windowsExe(null, { electron: "31.0.0" }));
      execFileSync("mkfifo", [join(root, "resources", "app.asar")]);
      const started = performance.now();
      expect(() => openAsarFile(join(root, "resources", "app.asar"))).toThrow(/not a regular file/);
      const { runtime } = readRuntimeOnDisk(root, "windows-linux", "resources/app.asar", "asar");
      expect(runtime.binary).toBe("Fixture.exe");
      expect(performance.now() - started).toBeLessThan(5000);
    },
  );
});

describe("fuse-weakened does not skip a fuse the after build does not name", () => {
  const policy = parsePolicy(
    '{"hexvero":"policy","version":1,"rules":{"fuse-weakened":{"level":"fail"}}}',
    "p.json",
  );
  it("an unknown schema version: every watched fuse is unknown", async () => {
    const asar = buildAsar(app("s.example"));
    const session = new Session();
    const a = await session.open(
      macApp("SA.app", { "app.asar": asar }, { runtime: { wire: "000000000" } }),
    );
    const b = await session.open(
      macApp("SB.app", { "app.asar": asar }, { runtime: { version: 2, wire: "111111111" } }),
    );
    const rows = (await session.collection(b.id, "runtime")).items as Array<{
      item: string;
      value: string;
    }>;
    expect(rows.find((r) => r.item === "fuses")?.value).toBe("unknown");
    const r = await checkRelease(session, a.id, b.id, policy);
    const fuse = r.findings.filter((f) => f.key.startsWith("fuse."));
    // every watched fuse that was in its safe state before (all off: cookieEncryption,
    // embeddedAsarIntegrityValidation and onlyLoadAppFromAsar were already less safe)
    expect(fuse.map((f) => [f.key, f.unknown])).toEqual([
      ["fuse.grantFileProtocolExtraPrivileges", true],
      ["fuse.nodeCliInspect", true],
      ["fuse.nodeOptions", true],
      ["fuse.runAsNode", true],
    ]);
    expect(r.status).toBe("incomplete");
  });

  it("a wire shorter than the before build's", async () => {
    const asar = buildAsar(app("t.example"));
    const session = new Session();
    const a = await session.open(
      macApp("TA.app", { "app.asar": asar }, { runtime: { wire: "010011010" } }),
    );
    const b = await session.open(
      macApp("TB.app", { "app.asar": asar }, { runtime: { wire: "0100" } }),
    );
    const r = await checkRelease(session, a.id, b.id, policy);
    expect(
      r.findings.filter((f) => f.key.startsWith("fuse.")).map((f) => [f.key, f.unknown]),
    ).toEqual([
      ["fuse.embeddedAsarIntegrityValidation", true],
      ["fuse.onlyLoadAppFromAsar", true],
    ]);
  });
});

/** The archive with `read` counted: every byte inflated or returned whole. */
const counted = (bytes: Uint8Array) => {
  const zip = openZip(bytes);
  const seen = { bytes: 0, calls: 0 };
  return {
    seen,
    zip: {
      ...zip,
      read: (e: Parameters<typeof zip.read>[0], max?: number) => {
        const out = zip.read(e, max);
        seen.bytes += out.length;
        seen.calls++;
        return out;
      },
    },
  };
};

describe("runtime candidates in a ZIP are bounded", () => {
  it("reads the first bytes of an entry without inflating it", () => {
    const zip = openZip(
      buildZip({
        "big.bin": Buffer.concat([latin1("MZ"), Buffer.alloc(4 << 20)]),
        "s.store": "ELFxyz",
      }),
    );
    expect(Buffer.from(zip.head(zip.find("big.bin")!, 4)!)).toEqual(
      Buffer.from([0x4d, 0x5a, 0, 0]),
    );
    expect(Buffer.from(zip.head(zip.find("s.store")!, 3)!).toString()).toBe("ELF");
  });

  it("inflates no candidate that is not a PE or ELF file", () => {
    const files: Record<string, Uint8Array | string> = {
      "inst/resources/app.asar": buildAsar(app("zb.example")),
      "inst/resources.pak": "pak",
    };
    // 40 MiB in all, more than the 16 MiB cap below
    for (let i = 0; i < 20; i++) files[`inst/blob${i}`] = Buffer.alloc(2 << 20, i);
    const { zip, seen } = counted(buildZip(files));
    const { runtime, limitations } = readRuntimeInZip(
      zip,
      "inst/",
      "windows-linux",
      "resources/app.asar",
      "asar",
      16 << 20,
      null,
    );
    expect(seen.bytes).toBe(0);
    expect(runtime.electron).toBe("unknown");
    expect(limitations[0]?.message).toContain(
      "no executable of 1 MiB or more (PE or ELF) next to resources/ in the archive",
    );
  });

  it("counts every candidate it inflates against one cap", () => {
    const { zip, seen } = counted(
      buildZip({
        "inst/resources/app.asar": buildAsar(app("zc.example")),
        "inst/a.exe": windowsExe(null, { electron: "31.0.0" }, 3 << 20),
        "inst/b.exe": windowsExe(null, { electron: "31.0.0" }, 3 << 20),
        "inst/c.exe": windowsExe(null, { electron: "31.0.0" }, 3 << 20),
      }),
    );
    const cap = 7 << 20;
    const { runtime, limitations } = readRuntimeInZip(
      zip,
      "inst/",
      "windows-linux",
      "resources/app.asar",
      "asar",
      cap,
      null,
    );
    expect(seen.bytes).toBeLessThanOrEqual(cap);
    // the two read agree, but the third was not read within the cap: it may hold other
    // markers, so which file is the runtime is not decided
    expect(runtime.electron).toBe("unknown");
    expect(limitations[0]?.message).toMatch(
      /c\.exe \(c\.exe expands to \d+ bytes, and the candidates read before it already took .*\) could not be scanned/,
    );
  });
});

const facts = (
  electron: string,
  wire: { version: number; positions: number } | null,
  fuse = "unknown",
) => orderFor({ electron, onlyLoadAppFromAsar: fuse as "unknown", fuseWire: wire, detail: "d" });

const buildJson = (name: string, text: string, runtime: Runtime | null) =>
  findElectronApp(
    macApp(
      name,
      {
        "app.asar": buildAsar({ "package.json": text, "main.js": "1;\n" }),
        "default_app.asar": buildAsar(app("default.example")),
      },
      { runtime },
    ),
  );

describe("review RF: the order change in 15.0.0-beta.6, and more", () => {
  it("decides the order by the fuse wire's length, and by the version only without a wire", () => {
    // a schema 1 wire with the 6th position: app.asar first, whatever the version string says
    expect(facts("15.0.0-beta.2", { version: 1, positions: 6 }, "off").order[0]).toBe("app.asar");
    // fewer positions: app/ first, and onlyLoadAppFromAsar cannot exist
    const old = facts("15.0.0-beta.2", { version: 1, positions: 5 });
    expect(old.order[0]).toBe("app");
    expect(old.alternatives).toEqual([]);
    expect(old.unread).toBeNull();
    // no wire: the version decides, except around the change
    expect(facts("15.0.0-beta.6", null).order[0]).toBe("app.asar");
    expect(facts("15.0.0", null).order[0]).toBe("app.asar");
    for (const open of [
      "15.0.0-beta.5",
      "15.0.0-alpha.9",
      "15.0.0-nightly.20210601",
      "16.0.0-nightly.20210908",
    ]) {
      const c = facts(open, null);
      expect(
        c.alternatives.map((a) => a.when),
        open,
      ).toContain("Electron before 15.0.0-beta.6");
      expect(c.unread, open).toContain(
        `the search order of Electron ${open} (it changed in 15.0.0-beta.6`,
      );
    }
  });

  it("treats the fuse as closed where it cannot exist (Electron 14 and earlier)", () => {
    const c = facts("14.2.9", null);
    expect(c.order[0]).toBe("app");
    expect(c.alternatives).toEqual([]);
    expect(c.unread).toBeNull();
    const root = macApp("Old14.app", both("dir.example"), {
      runtime: { electron: "14.2.9", noWire: true },
    });
    const found = findElectronApp(root);
    expect(found).toMatchObject({ entry: "Contents/Resources/app", kind: "directory" });
    expect(found?.warning).toBeUndefined();
    // a 4-position wire: the same
    const wired = macApp("Old14w.app", both("dir.example"), {
      runtime: { electron: "14.2.9", wire: "0000" },
    });
    expect(findElectronApp(wired)?.warning).toBeUndefined();
  });

  it("gives up on a file of repeated ` Electron/` strings quickly, and says so", () => {
    const repeat = latin1("xx Electron/1.0.0\0");
    const bytes = Buffer.concat(Array.from({ length: MAX_ANCHORS + 10 }, () => repeat));
    const started = performance.now();
    const scan = scanRuntimeBinary(bytesSource(bytes));
    expect(performance.now() - started).toBeLessThan(2000);
    expect(scan.overflow.electron).toBe(true);
    expect(scan.overflowWhy?.electron).toBe(`more than ${MAX_ANCHORS} " Electron/" strings`);
  });

  it("scans every unnamed file (up to 8) when nothing named holds markers", () => {
    const blank = (size: number) => windowsExe(null, {}, size).fill(0, 0x600);
    const root = winDir("win-many", {
      // the real one is the 4th largest; a bigger file carries other complete markers
      "s1.exe": blank(6 << 20),
      "s2.exe": blank(5 << 20),
      "s3.exe": windowsExe(null, { electron: "28.0.0" }, 4 << 20),
      "launcher.exe": windowsExe(null, { electron: "40.1.0" }, 2 << 20),
    });
    const { runtime, limitations } = readRuntimeOnDisk(
      root,
      "windows-linux",
      "resources/app.asar",
      "asar",
    );
    expect(runtime.electron).toBe("unknown");
    expect(limitations[0]?.message).toMatch(
      /s3\.exe, launcher\.exe all hold Electron markers and disagree/,
    );
  });

  it("matches names in either Unicode form (Café)", () => {
    const nfd = "Cafe\u0301.exe";
    const root = winDir(
      "win-cafe",
      { [nfd]: windowsExe(null, { electron: "31.0.0" }) },
      { productName: "Caf\u00e9" },
    );
    const { runtime } = readRuntimeOnDisk(root, "windows-linux", "resources/app.asar", "asar");
    expect(runtime.electron).toBe("31.0.0");
    expect(runtime.rows.find((r) => r.item === "electron")?.detail).toContain(
      "is named after the app",
    );
  });

  it("treats a package.json that is not an object by the Electron version (#216)", () => {
    let n = 0;
    for (const text of ["null", "[]", '"app"', "1"]) {
      // Electron 45 and later pass over any value that is not an object
      const v45 = buildJson(`J45-${n++}.app`, text, { electron: "45.0.0", wire: "010010011" });
      expect(v45?.entry, text).toBe("Contents/Resources/default_app.asar");
      expect(v45?.note, text).toMatch(
        /app\.asar \(package\.json is (null|not a JSON object), which Electron 45 and later pass over\)/,
      );
      // Electron 40 runs a list, string or number; null makes it run no app
      const v40 = buildJson(`J40-${n++}.app`, text, { electron: "40.0.0", wire: "010010011" });
      if (text === "null") {
        expect(v40?.refused, text).toContain(
          "its package.json is null: Electron before 45 loads it and then runs no app",
        );
      } else {
        expect(v40?.entry, text).toBe("Contents/Resources/app.asar");
        expect(v40?.refused, text).toBeUndefined();
      }
    }
    // the version unknown: the rule stays open, with the warning
    const open = buildJson("Jx.app", "[]", null);
    expect(open?.entry).toBe("Contents/Resources/default_app.asar");
    expect(open?.warning).toMatch(
      /^The Electron version and the fuse onlyLoadAppFromAsar could not be read .* and its rule for package\.json \(Electron 45 and later\); .*with Electron before 45 Electron runs Contents\/Resources\/app\.asar/,
    );
  });

  it("fuse-weakened: a fuse marked removed before is not a definite move", async () => {
    const policy = parsePolicy(
      '{"hexvero":"policy","version":1,"rules":{"fuse-weakened":{"level":"fail"}}}',
      "p.json",
    );
    const asar = buildAsar(app("rm.example"));
    const session = new Session();
    const a = await session.open(
      macApp("RA.app", { "app.asar": asar }, { runtime: { wire: "0r0011011" } }),
    );
    const b = await session.open(
      macApp("RB.app", { "app.asar": asar }, { runtime: { wire: "000011011" } }),
    );
    const r = await checkRelease(session, a.id, b.id, policy);
    const f = r.findings.filter((x) => x.key === "fuse.cookieEncryption");
    expect(f.map((x) => [x.unknown, x.message])).toEqual([
      [true, expect.stringContaining("in the before build it was marked removed (no effect)")],
    ]);
    expect(r.status).not.toBe("fail");
  });
});

describe("review 307435e", () => {
  it("leaves the order open when the fuse wire and the version disagree", () => {
    for (const [electron, positions] of [
      ["30.1.0", 4],
      ["14.2.9", 9],
    ] as const) {
      const c = orderFor({
        electron,
        onlyLoadAppFromAsar: positions >= 6 ? "off" : "unknown",
        fuseWire: { version: 1, positions },
        detail: "d",
      });
      expect(c.unread, electron).toContain(
        `the search order (the fuse wire of ${positions} positions and Electron ${electron} disagree)`,
      );
      expect(
        c.alternatives.map((a) => a.when),
        electron,
      ).toEqual(["Electron before 15.0.0-beta.6", "the fuse onlyLoadAppFromAsar on"]);
    }
    // agreeing: closed, no alternatives
    expect(
      orderFor({
        electron: "30.1.0",
        onlyLoadAppFromAsar: "off",
        fuseWire: { version: 1, positions: 9 },
        detail: "d",
      }).alternatives,
    ).toEqual([]);
  });

  it("fuse-weakened: removed before and not read after is an unknown finding", async () => {
    const policy = parsePolicy(
      '{"hexvero":"policy","version":1,"rules":{"fuse-weakened":{"level":"fail"}}}',
      "p.json",
    );
    const asar = buildAsar(app("ru.example"));
    const session = new Session();
    const a = await session.open(
      macApp("RUA.app", { "app.asar": asar }, { runtime: { wire: "0r0011011" } }),
    );
    const b = await session.open(
      macApp("RUB.app", { "app.asar": asar }, { runtime: { wire: "0x0011011" } }),
    );
    const r = await checkRelease(session, a.id, b.id, policy);
    expect(
      r.findings.filter((x) => x.key === "fuse.cookieEncryption").map((x) => x.unknown),
    ).toEqual([true]);
  });

  // sparse files: instant on APFS and ext4; NTFS would read 2 GiB of zeros
  it.skipIf(process.platform === "win32")(
    "does not decide when a cross-check file is over the budget, even with a named binary",
    () => {
      // a named file of 1 GiB uses up most of the 2 GiB; sparse files are not read past the cap
      const root = winDir("win-budget", {});
      const named = join(root, "Fixture.exe");
      writeFileSync(named, windowsExe(null, { electron: "31.0.0" }));
      truncateSync(named, 1 << 30);
      const big = join(root, "other.exe");
      writeFileSync(big, windowsExe(null, {}, 2 << 20).fill(0, 0x600));
      truncateSync(big, (1 << 30) - 1);
      const third = join(root, "third.exe");
      writeFileSync(third, windowsExe(null, {}, 2 << 20).fill(0, 0x600));
      truncateSync(third, (1 << 30) - 2);
      const { runtime, limitations } = readRuntimeOnDisk(
        root,
        "windows-linux",
        "resources/app.asar",
        "asar",
      );
      expect(runtime.electron).toBe("unknown");
      expect(limitations[0]?.message).toContain(
        "third.exe (over the 2048 MiB hexvero reads for one build)",
      );
    },
  );
});

/** An archive whose header is `size` bytes of a JSON string (only the header is ever read). */
const bigHeader = (size: number): Buffer => {
  const body = Buffer.alloc(size, 0x61);
  body[0] = 0x22;
  body[size - 1] = 0x22;
  const head = Buffer.alloc(16);
  head.writeUInt32LE(4, 0);
  head.writeUInt32LE(size + 8, 4);
  head.writeUInt32LE(size + 4, 8);
  head.writeUInt32LE(size, 12);
  return Buffer.concat([head, body]);
};

const hashOfHeader = (b: Buffer): string =>
  createHash("sha256").update(b.subarray(16)).digest("hex");

describe("ASAR integrity entries are hashed once per archive, within one budget", () => {
  it("hashes an archive named by many entries once (paths normalized)", () => {
    const archive = bigHeader(25 << 20);
    const hash = hashOfHeader(archive);
    const integrity: Record<string, string> = {};
    // 200 entries, three spellings of one path: without one hash per file, 25 MiB each would
    // use up the 64 MiB budget after two
    for (let i = 0; i < 200; i++)
      integrity[i % 3 === 0 ? `Resources/./app.asar#${i}` : `Resources/x${i}/../app.asar`] = hash;
    integrity["Resources/app.asar"] = hash;
    const root = macApp("ManyEntries.app", { "app.asar": archive }, { runtime: {}, integrity });
    // the `#i` spellings name no file: absent; every other one is the same archive
    const { runtime } = readRuntimeOnDisk(root, "macos", "Contents/Resources/app.asar", "asar");
    const rows = runtime.rows.filter((r) => r.item.startsWith("asarIntegrity:"));
    expect(rows.filter((r) => r.header === "matches").length).toBe(134);
    expect(rows.filter((r) => r.header === "not compared")).toEqual([]);
  });

  it("stops hashing past 64 MiB of headers, and says why", () => {
    const a = bigHeader(30 << 20);
    const b = bigHeader(30 << 20);
    const c = bigHeader(30 << 20);
    const root = macApp(
      "BigHeaders.app",
      { "a.asar": a, "b.asar": b, "c.asar": c },
      {
        runtime: {},
        integrity: {
          "Resources/a.asar": hashOfHeader(a),
          "Resources/b.asar": hashOfHeader(b),
          "Resources/c.asar": hashOfHeader(c),
        },
      },
    );
    const { runtime } = readRuntimeOnDisk(root, "macos", "Contents/Resources/a.asar", "asar");
    const rows = runtime.rows.filter((r) => r.item.startsWith("asarIntegrity:"));
    expect(rows.map((r) => r.header)).toEqual(["matches", "matches", "not compared"]);
    expect(rows[2]?.detail).toContain("past what hexvero hashes");
  });
});
