import { parseAxml, type AxmlElement } from "./axml.js";
import { parseArsc, type ArscEntry } from "./arsc.js";
import { parseDex, type DexClass } from "./dex.js";
import { summarizeFlutter, type FlutterInfo } from "./flutter.js";
import { openZip, type ZipEntry } from "./zip.js";
import type { Finding, Limitation } from "../model.js";
import { AnalysisError } from "../model.js";

export interface ApkComponent {
  kind: "activity" | "service" | "receiver" | "provider";
  name: string;
  exported: boolean | null;
  permission: string | null;
  intentFilters: Array<{
    actions: string[];
    categories: string[];
    schemes: string[];
    hosts: string[];
  }>;
}

export interface ApkInfo {
  package: string;
  versionCode: string;
  versionName: string;
  minSdk: string | null;
  targetSdk: string | null;
  permissions: string[];
  customPermissions: Array<{ name: string; protectionLevel: string }>;
  features: string[];
  application: {
    label: string;
    debuggable: boolean;
    allowBackup: boolean | null;
    cleartextTraffic: boolean | null;
    networkSecurityConfig: string | null;
  };
  components: ApkComponent[];
  nativeLibraries: Record<string, string[]>;
  dexFiles: Array<{
    name: string;
    size: number;
    classes: number;
    methods: number;
  }>;
  classes: DexClass[];
  packages: Array<{ name: string; classes: number }>;
  signatureSchemes: string[];
  resources: {
    packages: string[];
    entries: number;
    strings: number;
    locales: string[];
    densities: string[];
  } | null;
  resourceEntries: ArscEntry[];
  flutter: Omit<FlutterInfo, "findings" | "limitations"> | null;
  fileCount: number;
  largestFiles: Array<{ name: string; size: number }>;
  manifest: AxmlElement;
  findings: Finding[];
  limitations: Limitation[];
}

const DANGEROUS =
  /^android\.permission\.(READ_SMS|SEND_SMS|RECEIVE_SMS|READ_CONTACTS|WRITE_CONTACTS|RECORD_AUDIO|CAMERA|ACCESS_FINE_LOCATION|ACCESS_BACKGROUND_LOCATION|READ_CALL_LOG|READ_PHONE_STATE|SYSTEM_ALERT_WINDOW|REQUEST_INSTALL_PACKAGES|BIND_ACCESSIBILITY_SERVICE|READ_EXTERNAL_STORAGE|MANAGE_EXTERNAL_STORAGE|QUERY_ALL_PACKAGES|BIND_DEVICE_ADMIN)$/;

const bool = (v: string | undefined): boolean | null => (v === undefined ? null : v === "true");
const identity = (value: string | undefined): string | undefined => value;

export function parseApk(bytes: Uint8Array): ApkInfo {
  const zip = openZip(bytes);
  const limitations: Limitation[] = [];
  const findings: Finding[] = [];
  const manifestEntry = zip.find("AndroidManifest.xml");
  if (!manifestEntry) throw new AnalysisError("malformed", "APK has no AndroidManifest.xml");
  const manifest = parseAxml(zip.read(manifestEntry, 8 << 20));
  // resources.arsc resolves @0x7f… references (labels, permission descriptions) without Apktool
  let resources: ApkInfo["resources"] = null;
  let resourceEntries: ArscEntry[] = [];
  let resolve: (value: string | undefined) => string | undefined = identity;
  const arscEntry = zip.find("resources.arsc");
  if (arscEntry) {
    try {
      const arsc = parseArsc(zip.read(arscEntry, 64 << 20));
      resourceEntries = arsc.entries;
      resources = {
        packages: arsc.packages.map((p) => p.name),
        entries: arsc.entries.length,
        strings: arsc.entries.filter((e) => e.type === "string").length,
        locales: [...new Set(arsc.packages.flatMap((p) => p.locales))].toSorted(),
        densities: [...new Set(arsc.packages.flatMap((p) => p.densities))].toSorted(),
      };
      resolve = (value) =>
        value && value.startsWith("@") ? (arsc.resolve(value) ?? value) : value;
    } catch (error) {
      limitations.push({
        code: "arsc_unreadable",
        message: `resources.arsc: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  const resolveTree = (el: AxmlElement): void => {
    for (const [k, v] of Object.entries(el.attributes)) {
      if (v.startsWith("@0x")) {
        const r = resolve(v);
        if (r !== undefined && r !== v) el.attributes[k] = r;
      }
    }
    el.children.forEach(resolveTree);
  };
  resolveTree(manifest);
  const a = manifest.attributes;
  const app = manifest.children.find((c) => c.tag === "application") ?? {
    tag: "application",
    attributes: {},
    children: [],
  };

  const components: ApkComponent[] = [];
  for (const child of app.children) {
    const kind = child.tag as ApkComponent["kind"];
    if (!["activity", "service", "receiver", "provider"].includes(kind)) continue;
    const intentFilters = child.children
      .filter((c) => c.tag === "intent-filter")
      .map((f) => ({
        actions: f.children
          .filter((c) => c.tag === "action")
          .map((c) => c.attributes["android:name"] ?? ""),
        categories: f.children
          .filter((c) => c.tag === "category")
          .map((c) => c.attributes["android:name"] ?? ""),
        schemes: f.children
          .filter((c) => c.tag === "data")
          .map((c) => c.attributes["android:scheme"] ?? "")
          .filter(Boolean),
        hosts: f.children
          .filter((c) => c.tag === "data")
          .map((c) => c.attributes["android:host"] ?? "")
          .filter(Boolean),
      }));
    const exportedAttr = bool(child.attributes["android:exported"]);
    components.push({
      kind,
      name: child.attributes["android:name"] ?? "",
      exported: exportedAttr ?? (intentFilters.length > 0 ? true : null),
      permission: child.attributes["android:permission"] ?? null,
      intentFilters,
    });
  }

  const nativeLibraries: Record<string, string[]> = {};
  const dexFiles: ApkInfo["dexFiles"] = [];
  const classes: DexClass[] = [];
  const packageCounts = new Map<string, number>();
  const signatureSchemes: string[] = [];
  for (const e of zip.entries) {
    const lib = /^lib\/([^/]+)\/(.+\.so)$/.exec(e.name);
    if (lib) (nativeLibraries[lib[1]!] ??= []).push(lib[2]!);
    if (/^classes\d*\.dex$/.test(e.name)) {
      try {
        const dex = parseDex(zip.read(e, 64 << 20), {
          maxClasses: 5000,
          maxStrings: 0,
        });
        dexFiles.push({
          name: e.name,
          size: e.size,
          classes: dex.counts.classes,
          methods: dex.counts.methods,
        });
        if (classes.length < 10_000) classes.push(...dex.classes);
        for (const p of dex.packages)
          packageCounts.set(p.name, (packageCounts.get(p.name) ?? 0) + p.classes);
        for (const f of dex.findings)
          if (!findings.some((x) => x.kind === f.kind)) findings.push(f);
        limitations.push(...dex.limitations);
      } catch (error) {
        dexFiles.push({ name: e.name, size: e.size, classes: 0, methods: 0 });
        limitations.push({
          code: "dex_unreadable",
          message: `${e.name}: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
    if (/^META-INF\/.+\.(RSA|DSA|EC)$/.test(e.name)) signatureSchemes.push("v1 (JAR)");
  }
  if (hasApkSigningBlock(bytes)) signatureSchemes.push("v2/v3 (APK Signing Block)");
  let flutter: ApkInfo["flutter"] = null;
  const flutterLibs = zip.entries.filter((e) => /^lib\/[^/]+\/lib(app|flutter)\.so$/.test(e.name));
  if (flutterLibs.some((e) => e.name.endsWith("libflutter.so"))) {
    const loaded: Array<{ abi: string; name: string; bytes: Uint8Array }> = [];
    for (const e of flutterLibs) {
      const parts = e.name.split("/");
      try {
        loaded.push({ abi: parts[1]!, name: parts[2]!, bytes: zip.read(e, 256 << 20) });
      } catch (error) {
        limitations.push({
          code: "flutter_lib_unreadable",
          message: `${e.name}: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
    const { findings: f, limitations: l, ...rest } = summarizeFlutter(loaded);
    findings.push(...f);
    limitations.push(...l);
    flutter = rest;
  }
  if (!signatureSchemes.length)
    limitations.push({
      code: "apk_unsigned",
      message: "No signature found; the APK may be unsigned or use an unrecognized scheme.",
    });

  const permissions = manifest.children
    .filter((c) => c.tag === "uses-permission" || c.tag === "uses-permission-sdk-23")
    .map((c) => c.attributes["android:name"] ?? "");
  const customPermissions = manifest.children
    .filter((c) => c.tag === "permission")
    .map((c) => ({
      name: c.attributes["android:name"] ?? "",
      protectionLevel: c.attributes["android:protectionLevel"] ?? "normal",
    }));
  const usesSdk = manifest.children.find((c) => c.tag === "uses-sdk");
  const info: ApkInfo = {
    package: a["package"] ?? "",
    versionCode: a["android:versionCode"] ?? "",
    versionName: a["android:versionName"] ?? "",
    minSdk: usesSdk?.attributes["android:minSdkVersion"] ?? null,
    targetSdk: usesSdk?.attributes["android:targetSdkVersion"] ?? null,
    permissions,
    customPermissions,
    features: manifest.children
      .filter((c) => c.tag === "uses-feature")
      .map((c) => c.attributes["android:name"] ?? ""),
    application: {
      label: app.attributes["android:label"] ?? "",
      debuggable: app.attributes["android:debuggable"] === "true",
      allowBackup: bool(app.attributes["android:allowBackup"]),
      cleartextTraffic: bool(app.attributes["android:usesCleartextTraffic"]),
      networkSecurityConfig: app.attributes["android:networkSecurityConfig"] ?? null,
    },
    components,
    nativeLibraries,
    dexFiles,
    classes,
    packages: [...packageCounts]
      .map(([name, n]) => ({ name, classes: n }))
      .toSorted((x, y) => y.classes - x.classes),
    signatureSchemes,
    resources,
    resourceEntries,
    flutter,
    fileCount: zip.entries.length,
    largestFiles: zip.entries
      .filter((e) => !e.isDirectory)
      .toSorted((x, y) => y.size - x.size)
      .slice(0, 10)
      .map((e) => ({ name: e.name, size: e.size })),
    manifest,
    findings,
    limitations,
  };

  if (info.application.debuggable)
    findings.push({
      kind: "apk.debuggable",
      title: "android:debuggable=true",
      detail: "Debugger attachable; usually a development build.",
      confidence: "confirmed",
    });
  if (info.application.cleartextTraffic === true)
    findings.push({
      kind: "apk.cleartext",
      title: "Cleartext HTTP traffic allowed",
      confidence: "confirmed",
    });
  if (
    info.application.allowBackup !== false &&
    (info.targetSdk === null || Number(info.targetSdk) < 31)
  )
    findings.push({
      kind: "apk.backup",
      title: "App data backup not disabled",
      confidence: "inferred",
    });
  const dangerous = permissions.filter((p) => DANGEROUS.test(p));
  if (dangerous.length)
    findings.push({
      kind: "apk.dangerous-permissions",
      title: `${dangerous.length} dangerous permissions`,
      detail: dangerous.map((p) => p.replace("android.permission.", "")).join(", "),
      confidence: "confirmed",
    });
  const exposed = components.filter(
    (c) =>
      c.exported === true &&
      !c.permission &&
      !c.intentFilters.some((f) => f.actions.includes("android.intent.action.MAIN")),
  );
  if (exposed.length)
    findings.push({
      kind: "apk.exported-components",
      title: `${exposed.length} exported components without a permission`,
      detail: exposed
        .slice(0, 6)
        .map((c) => `${c.kind} ${c.name}`)
        .join(", "),
      confidence: "confirmed",
    });
  const deepLinks = components.flatMap((c) =>
    c.intentFilters.flatMap((f) => f.schemes.map((s) => `${s}://${f.hosts[0] ?? ""}`)),
  );
  if (deepLinks.length)
    findings.push({
      kind: "apk.deep-links",
      title: `${deepLinks.length} deep link schemes`,
      detail: [...new Set(deepLinks)].slice(0, 8).join(", "),
      confidence: "confirmed",
    });
  const abis = Object.keys(nativeLibraries);
  if (abis.length)
    findings.push({
      kind: "apk.native",
      title: `Native libraries for ${abis.join(", ")}`,
      detail: [...new Set(Object.values(nativeLibraries).flat())].slice(0, 8).join(", "),
      confidence: "confirmed",
    });
  const frameworks = detectFrameworks(zip.entries);
  if (frameworks.length)
    findings.push({
      kind: "apk.framework",
      title: `Built with ${frameworks.join(", ")}`,
      confidence: "inferred",
    });
  return info;
}

function detectFrameworks(entries: ZipEntry[]): string[] {
  const names = new Set(entries.map((e) => e.name));
  const some = (re: RegExp): boolean => entries.some((e) => re.test(e.name));
  const out: string[] = [];
  if (some(/libflutter\.so$/)) out.push("Flutter");
  if (some(/libreactnativejni\.so$|index\.android\.bundle$/)) out.push("React Native");
  if (some(/^assets\/www\/cordova\.js$/)) out.push("Cordova");
  if (some(/libil2cpp\.so$|libunity\.so$/)) out.push("Unity");
  if (some(/libmonodroid\.so$|libxamarin-app\.so$/)) out.push("Xamarin/.NET");
  if (some(/libapp\.so$/) && names.has("assets/flutter_assets/kernel_blob.bin"))
    out.push("Flutter (debug)");
  if (some(/^assets\/.*\.hbc$/)) out.push("Hermes bytecode");
  if (some(/libgodot_android\.so$/)) out.push("Godot");
  if (some(/^kotlin\//)) out.push("Kotlin");
  return [...new Set(out)];
}

/** The APK Signing Block sits right before the central directory and ends with the magic "APK Sig Block 42". */
function hasApkSigningBlock(bytes: Uint8Array): boolean {
  const magic = "APK Sig Block 42";
  const text = new TextDecoder("latin1").decode(
    bytes.subarray(Math.max(0, bytes.length - (4 << 20))),
  );
  return text.includes(magic);
}
