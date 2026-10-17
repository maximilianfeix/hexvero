import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildSync } from "esbuild";
import { afterAll, describe, expect, it } from "vitest";
import { analyzeJavaScriptTree, asarTree, type JsAppInfo } from "../src/javascript/app.js";
import { buildAsar } from "./fixtures/asar.js";

/**
 * Storage keys passed through a wrapper class or object that another module defines: read at
 * each call in the importing module, with the key the wrapper's own key expression builds, as
 * written (plain), bundled by esbuild and minified. The expected keys are written from the
 * fixture sources; nothing of them is run.
 */

const dir = mkdtempSync(join(tmpdir(), "hexvero-storage-wrappers-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function analyze(files: Record<string, string>): JsAppInfo {
  return analyzeJavaScriptTree(
    asarTree(
      buildAsar({
        "package.json": JSON.stringify({ name: "s", main: "main.js" }),
        "main.js": 'require("electron");\n',
        ...files,
      }),
      "app.asar",
    ),
  );
}

/** The sources bundled by esbuild from `entry`, optionally minified, as that one file. */
function bundled(
  sources: Record<string, string>,
  entry: string,
  minify: boolean,
  format: "cjs" | "esm" = "cjs",
): Record<string, string> {
  const src = mkdtempSync(join(dir, "src-"));
  for (const [name, text] of Object.entries(sources)) {
    mkdirSync(dirname(join(src, name)), { recursive: true });
    writeFileSync(join(src, name), text);
  }
  const outfile = join(src, "out", entry);
  buildSync({
    entryPoints: [join(src, entry)],
    bundle: true,
    minify,
    platform: "browser",
    format,
    outfile,
    logLevel: "silent",
  });
  return { [entry]: readFileSync(outfile, "utf8") };
}

/** `kind op key` of every row with a whole key, sorted. */
const keys = (info: JsAppInfo): string[] =>
  [
    ...new Set(
      info.storage
        .filter((r) => r.value !== null && !r.value.includes("${…}"))
        .map((r) => `${r.kind} ${r.op} ${r.value}`),
    ),
  ].toSorted();

/** The rows read at calls of a wrapper (`via`), as `file kind op key via`. */
const via = (info: JsAppInfo): string[] =>
  info.storage
    .filter((r) => r.via)
    .map((r) => `${r.file} ${r.kind} ${r.op} ${r.value ?? `?${r.expression}`}`)
    .toSorted();

const WEB_STORE = `// every key carries the prefix
const PREFIX = "app.";
const key = (name) => \`\${PREFIX}\${name}\`;
export const local = {
  get: (name) => localStorage.getItem(key(name)),
  set: (name, value) => localStorage.setItem(key(name), String(value)),
  remove: (name) => localStorage.removeItem(key(name)),
};
`;

const RENDERER = `import { local } from "./web-store.js";
const LAST = "lastProject";
const SIZE = "fontSize";
document.title = local.get(LAST) ?? "";
local.set(SIZE, 14);
local.remove(SIZE);
`;

const ESM_KEYS = [
  "localStorage delete app.fontSize",
  "localStorage read app.lastProject",
  "localStorage write app.fontSize",
];

/** The rows read at calls in renderer.js. */
const look = (renderer: string, store = WEB_STORE): string[] =>
  via(analyze({ "web-store.js": store, "renderer.js": renderer })).filter((r) =>
    r.startsWith("renderer.js"),
  );

describe("storage wrappers of another module", () => {
  it("reads an imported object literal at each call (ESM, plain)", () => {
    const info = analyze({ "web-store.js": WEB_STORE, "renderer.js": RENDERER });
    expect(keys(info)).toEqual(ESM_KEYS);
    expect(via(info)).toEqual([
      "renderer.js localStorage delete app.fontSize",
      "renderer.js localStorage read app.lastProject",
      "renderer.js localStorage write app.fontSize",
    ]);
    const row = info.storage.find((r) => r.value === "app.lastProject")!;
    expect(row).toMatchObject({ line: 4, via: "local.get", evidence: "inferred" });
    // the storage call inside the wrapper keeps its unread row, as in 0.9.6
    expect(info.storage.some((r) => r.file === "web-store.js" && r.value !== null)).toBe(true);
  });

  for (const minify of [false, true])
    it(`reads the same keys bundled by esbuild${minify ? " and minified" : ""}`, () => {
      const info = analyze(
        bundled({ "web-store.js": WEB_STORE, "renderer.js": RENDERER }, "renderer.js", minify),
      );
      expect(keys(info)).toEqual(ESM_KEYS);
    });

  const STORE = `class SettingsStore {
  get(key) { return JSON.parse(localStorage.getItem("settings:" + key) || "null"); }
  set(key, value) { localStorage.setItem("settings:" + key, JSON.stringify(value)); }
}
module.exports = { SettingsStore };
`;
  const USER = `const { SettingsStore } = require("./store");
const settings = new SettingsStore();
settings.set("theme", "dark");
console.log(settings.get("theme"));
`;
  it("reads a class required by name and made with new (CommonJS)", () => {
    const info = analyze({ "store.js": STORE, "renderer.js": USER });
    expect(keys(info)).toEqual([
      "localStorage read settings:theme",
      "localStorage write settings:theme",
    ]);
    expect(info.storage.find((r) => r.value === "settings:theme" && r.op === "write")?.via).toBe(
      "SettingsStore.set",
    );
  });

  for (const minify of [false, true])
    it(`reads the class through esbuild's __commonJS wrapper${minify ? ", minified" : ""}`, () => {
      const info = analyze(
        bundled({ "store.js": STORE, "renderer.js": USER }, "renderer.js", minify),
      );
      expect(keys(info)).toEqual([
        "localStorage read settings:theme",
        "localStorage write settings:theme",
      ]);
    });

  it('reads new (require("./store").SettingsStore)() on the spot', () => {
    const info = analyze({
      "store.js": STORE,
      "renderer.js": `new (require("./store").SettingsStore)().set("zoom", 2);\n`,
    });
    expect(keys(info)).toEqual(["localStorage write settings:zoom"]);
  });

  const SINGLETON = `class Store {
  read(name) { return sessionStorage.getItem(name); }
  write(name, v) { sessionStorage.setItem(name, v); }
}
module.exports = new Store();
`;
  const SINGLE_USER = `const store = require("./singleton");
store.write("cursor", "0");
store.read("cursor");
`;
  it("reads a singleton module.exports = new Store() used as store.read(…)", () => {
    const info = analyze({ "singleton.js": SINGLETON, "renderer.js": SINGLE_USER });
    expect(keys(info)).toEqual(["sessionStorage read cursor", "sessionStorage write cursor"]);
    for (const minify of [false, true])
      expect(
        keys(
          analyze(
            bundled(
              { "singleton.js": SINGLETON, "renderer.js": SINGLE_USER },
              "renderer.js",
              minify,
            ),
          ),
        ),
      ).toEqual(["sessionStorage read cursor", "sessionStorage write cursor"]);
  });

  it("reads a key that is a member of a string enum of the wrapper's module", () => {
    const info = analyze({
      "settings.js": `export var StorageKey;
(function (StorageKey) {
  StorageKey["Theme"] = "snap:theme";
})(StorageKey || (StorageKey = {}));
export const settings = {
  get(key, fallback) { const raw = localStorage.getItem(key); return raw === null ? fallback : raw; },
};
`,
      "renderer.js": `import { settings, StorageKey } from "./settings.js";
settings.get(StorageKey.Theme, "light");
`,
    });
    expect(keys(info)).toEqual(["localStorage read snap:theme"]);
  });

  it("keeps a call whose key cannot be read as an unknown row at the call", () => {
    const info = analyze({
      "web-store.js": WEB_STORE,
      "renderer.js": `import { local } from "./web-store.js";
export function load(name) { return local.get(name + window.suffix); }
`,
    });
    const at = info.storage.filter((r) => r.file === "renderer.js");
    expect(at).toHaveLength(1);
    expect(at[0]).toMatchObject({ value: null, evidence: "unknown", via: "local.get" });
  });

  describe("look-alikes stay unread", () => {
    it("a parameter, local, destructuring, for-of or catch binding of the name", () => {
      expect(
        look(`import { local } from "./web-store.js";
function a(local) { local.get("p"); }
function b() { const local = window.other; local.get("l"); }
function c() { const { local } = window.mod; local.get("d"); }
function d(list) { for (const local of list) local.get("f"); }
function e() { try { x(); } catch (local) { local.get("c"); } }
`),
      ).toEqual([]);
    });
    it("a member assigned in the calling module, or in the wrapper's module", () => {
      expect(
        look(`import { local } from "./web-store.js";
local.get = (k) => k;
local.get("m");
`),
      ).toEqual([]);
      expect(
        look(
          `import { local } from "./web-store.js";\nlocal.get("n");\n`,
          `${WEB_STORE}local.get = (k) => k;\n`,
        ),
      ).toEqual([]);
    });
    it("a binding assigned again, and a method another class defines", () => {
      expect(
        via(
          analyze({
            "store.js": STORE,
            "renderer.js": `const { SettingsStore } = require("./store");
let s = new SettingsStore();
s = window.other;
s.get("re");
class Other { get(k) { return k; } }
new Other().get("other");
const o = { get: (k) => k };
o.get("obj");
`,
          }),
        ).filter((r) => r.startsWith("renderer.js")),
      ).toEqual([]);
    });
    it("a module that is not the wrapper's (another specifier)", () => {
      expect(
        look(`import { local } from "./other-store.js";
local.get("x");
`),
      ).toEqual([]);
    });
  });

  it("stays linear and says so when calls are capped", () => {
    const calls = Array.from({ length: 5000 }, (_, i) => `local.get("k${i}");`).join("\n");
    const started = performance.now();
    const info = analyze({
      "web-store.js": WEB_STORE,
      "renderer.js": `import { local } from "./web-store.js";\n${calls}\n`,
    });
    expect(performance.now() - started).toBeLessThan(10_000);
    const rows = info.storage.filter((r) => r.file === "renderer.js");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThanOrEqual(2000);
    expect(info.limitations.map((l) => l.code)).toContain("storage_wrappers_capped");
    for (const r of rows) expect(r.value).toMatch(/^app\.k\d+$/);
  });
});
