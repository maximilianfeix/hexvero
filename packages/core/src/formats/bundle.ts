import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { analyzeBinary, type BinaryData } from "../analyzers/binary.js";
import type { Finding, Limitation } from "../model.js";
import { targetFromBytes } from "../target.js";
import { parsePlist, type PlistValue } from "./plist.js";

export interface BundleInfo {
  platform: "macos" | "ios";
  bundleId: string;
  name: string;
  version: string;
  build: string;
  executable: string;
  minimumOs: string | null;
  category: string | null;
  urlSchemes: string[];
  documentTypes: number;
  permissions: Array<{ key: string; reason: string }>;
  appTransportSecurity: { allowsArbitraryLoads: boolean | null };
  sandboxed: boolean | null;
  hardenedRuntime: boolean | null;
  frameworks: string[];
  embeddedBinaries: string[];
  helpers: string[];
  provisioningProfile: boolean;
  entitlements: Record<string, PlistValue> | null;
  framework: string | null;
  main: { summary: string; binary: BinaryData } | null;
  findings: Finding[];
  limitations: Limitation[];
}

const PRIVACY_KEYS: Record<string, string> = {
  NSCameraUsageDescription: "camera",
  NSMicrophoneUsageDescription: "microphone",
  NSLocationWhenInUseUsageDescription: "location (in use)",
  NSLocationAlwaysAndWhenInUseUsageDescription: "location (always)",
  NSContactsUsageDescription: "contacts",
  NSCalendarsUsageDescription: "calendars",
  NSPhotoLibraryUsageDescription: "photo library",
  NSBluetoothAlwaysUsageDescription: "bluetooth",
  NSAppleEventsUsageDescription: "Apple Events (automation)",
  NSSystemAdministrationUsageDescription: "system administration",
  NSDesktopFolderUsageDescription: "Desktop folder",
  NSDocumentsFolderUsageDescription: "Documents folder",
  NSDownloadsFolderUsageDescription: "Downloads folder",
  NSSpeechRecognitionUsageDescription: "speech recognition",
  NSLocalNetworkUsageDescription: "local network",
  NSUserTrackingUsageDescription: "tracking",
  NSFaceIDUsageDescription: "Face ID",
  NSHealthShareUsageDescription: "health data",
};

const dict = (v: PlistValue | undefined): Record<string, PlistValue> | null =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, PlistValue>)
    : null;
const str = (v: PlistValue | undefined): string =>
  typeof v === "string" ? v : "";

/** True when the directory is a macOS or iOS application bundle. */
export function isAppBundle(dir: string): boolean {
  return (
    existsSync(join(dir, "Contents", "Info.plist")) ||
    (existsSync(join(dir, "Info.plist")) && dir.endsWith(".app"))
  );
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Reads Info.plist, the main executable and the embedded code of an .app bundle. Nothing is executed. */
export function analyzeAppBundle(dir: string): BundleInfo {
  const macos = existsSync(join(dir, "Contents", "Info.plist"));
  const root = macos ? join(dir, "Contents") : dir;
  const limitations: Limitation[] = [];
  const findings: Finding[] = [];
  const info =
    dict(parsePlist(new Uint8Array(readFileSync(join(root, "Info.plist"))))) ??
    {};
  const executable = str(info["CFBundleExecutable"]);
  const executablePath = macos
    ? join(root, "MacOS", executable)
    : join(root, executable);

  let main: BundleInfo["main"] = null;
  if (executable && existsSync(executablePath)) {
    try {
      const size = statSync(executablePath).size;
      if (size > 512 << 20)
        limitations.push({
          code: "executable_too_large",
          message: `${executable} is ${size} bytes; skipped.`,
        });
      else {
        const result = analyzeBinary(
          targetFromBytes(
            new Uint8Array(readFileSync(executablePath)),
            executablePath,
          ),
        );
        main = { summary: result.summary, binary: result.data };
        findings.push(
          ...result.findings.map((f) => ({
            ...f,
            title: `${executable}: ${f.title}`,
          })),
        );
        limitations.push(...result.limitations);
      }
    } catch (error) {
      limitations.push({
        code: "executable_unreadable",
        message: `${executable}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }
  } else
    limitations.push({
      code: "executable_missing",
      message: `CFBundleExecutable ${executable || "(unset)"} not found.`,
    });

  const frameworks = listDir(join(root, "Frameworks"))
    .filter((n) => !n.startsWith("."))
    .toSorted();
  const embeddedBinaries = frameworks.filter((n) => n.endsWith(".dylib"));
  const helpers = [
    ...listDir(join(root, "Library", "LoginItems")),
    ...listDir(join(root, "XPCServices")),
    ...listDir(join(root, "Helpers")),
  ].toSorted();
  const plugins = listDir(join(root, "PlugIns"));
  const provisioningProfile =
    existsSync(join(root, "embedded.provisionprofile")) ||
    existsSync(join(dir, "embedded.mobileprovision"));
  let entitlements: Record<string, PlistValue> | null = null;
  for (const candidate of [
    join(root, "Resources", `${executable}.entitlements`),
    join(root, "Entitlements.plist"),
    join(dir, "archived-expanded-entitlements.xcent"),
  ]) {
    if (!existsSync(candidate)) continue;
    try {
      entitlements = dict(parsePlist(new Uint8Array(readFileSync(candidate))));
      break;
    } catch {
      limitations.push({
        code: "entitlements_unreadable",
        message: `${candidate} could not be parsed.`,
      });
    }
  }

  const permissions = Object.entries(PRIVACY_KEYS)
    .filter(([key]) => info[key] !== undefined)
    .map(([key, reason]) => ({ key, reason: `${reason}: ${str(info[key])}` }));
  const urlSchemes = (
    (info["CFBundleURLTypes"] as PlistValue[] | undefined) ?? []
  )
    .flatMap((t) =>
      ((dict(t)?.["CFBundleURLSchemes"] as PlistValue[] | undefined) ?? []).map(
        str,
      ),
    )
    .filter(Boolean);
  const ats = dict(info["NSAppTransportSecurity"]);
  const frameworkNames = frameworks.map((f) => f.toLowerCase());
  const framework = frameworkNames.some((f) => f.includes("electron"))
    ? "Electron"
    : frameworkNames.some((f) => f.includes("flutter"))
      ? "Flutter"
      : frameworkNames.some((f) => f.startsWith("qt"))
        ? "Qt"
        : frameworkNames.some((f) => f.includes("react"))
          ? "React Native"
          : frameworkNames.some((f) => f.includes("unityframework"))
            ? "Unity"
            : existsSync(join(root, "Resources", "app.asar"))
              ? "Electron"
              : existsSync(join(root, "MacOS", "Tauri"))
                ? "Tauri"
                : null;
  const sandboxed = entitlements
    ? entitlements["com.apple.security.app-sandbox"] === true
    : null;
  const hardenedRuntime =
    main && main.binary.kind !== "macho-fat" && "macho" in main.binary
      ? main.binary.macho.codeSigned
      : null;

  if (ats?.["NSAllowsArbitraryLoads"] === true)
    findings.push({
      kind: "bundle.ats-off",
      title: "App Transport Security allows arbitrary loads (plain HTTP)",
      confidence: "confirmed",
    });
  if (permissions.length)
    findings.push({
      kind: "bundle.permissions",
      title: `Requests ${permissions.length} privacy permissions`,
      detail: permissions.map((p) => p.reason.split(":")[0]).join(", "),
      confidence: "confirmed",
    });
  if (urlSchemes.length)
    findings.push({
      kind: "bundle.url-schemes",
      title: `Registers URL schemes ${urlSchemes.slice(0, 6).join(", ")}`,
      confidence: "confirmed",
    });
  if (framework)
    findings.push({
      kind: "bundle.framework",
      title: `Built with ${framework}`,
      confidence: "inferred",
    });
  if (sandboxed === false)
    findings.push({
      kind: "bundle.no-sandbox",
      title: "Not sandboxed (no app-sandbox entitlement)",
      confidence: "confirmed",
    });
  if (
    entitlements?.["com.apple.security.cs.allow-unsigned-executable-memory"] ===
      true ||
    entitlements?.["com.apple.security.cs.disable-library-validation"] === true
  ) {
    findings.push({
      kind: "bundle.weak-hardening",
      title:
        "Entitlements weaken the hardened runtime (unsigned memory or disabled library validation)",
      confidence: "confirmed",
    });
  }
  if (helpers.length)
    findings.push({
      kind: "bundle.helpers",
      title: `${helpers.length} helper/XPC processes`,
      detail: helpers.slice(0, 6).join(", "),
      confidence: "confirmed",
    });
  if (plugins.length)
    findings.push({
      kind: "bundle.plugins",
      title: `${plugins.length} app extensions`,
      detail: plugins.slice(0, 6).join(", "),
      confidence: "confirmed",
    });

  return {
    platform: macos ? "macos" : "ios",
    bundleId: str(info["CFBundleIdentifier"]),
    name: str(info["CFBundleDisplayName"]) || str(info["CFBundleName"]),
    version: str(info["CFBundleShortVersionString"]),
    build: str(info["CFBundleVersion"]),
    executable,
    minimumOs:
      str(info["LSMinimumSystemVersion"]) ||
      str(info["MinimumOSVersion"]) ||
      null,
    category: str(info["LSApplicationCategoryType"]) || null,
    urlSchemes,
    documentTypes: (
      (info["CFBundleDocumentTypes"] as PlistValue[] | undefined) ?? []
    ).length,
    permissions,
    appTransportSecurity: {
      allowsArbitraryLoads: ats ? ats["NSAllowsArbitraryLoads"] === true : null,
    },
    sandboxed,
    hardenedRuntime,
    frameworks,
    embeddedBinaries,
    helpers,
    provisioningProfile,
    entitlements,
    framework,
    main,
    findings,
    limitations,
  };
}
