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

/** Keys and channels of the analysis that the fixture marks as false (`F_…`). */
const falseOnes = (files: Record<string, string>): string[] => {
  const info = analyze(files);
  return [
    ...info.storage.flatMap((r) => (r.value?.includes("F_") ? [r.value] : [])),
    ...info.ipcChannels.flatMap((c) => (c.channel.includes("F_") ? [c.channel] : [])),
  ];
};

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

  describe("look-alikes found in review (R5), shared with the IPC wrappers", () => {
    const STORE_CJS = `class Store { get(k) { return localStorage.getItem("app." + k); } }\nmodule.exports = { Store };\n`;
    const ESTORE = `export class Store { get(k) { return localStorage.getItem("app." + k); } }\n`;
    const ROUTER = `const { ipcMain } = require("electron");\nclass Router { handle(ch, f) { ipcMain.handle(ch, f); } }\nmodule.exports = { Router };\n`;
    it("a static method is no method of an instance", () => {
      expect(
        falseOnes({
          "store.js": `class Store { static get(k) { return localStorage.getItem("app." + k); } get(k) { return k; } }\nmodule.exports = { Store };\n`,
          "r.js": `const { Store } = require("./store");\nnew Store().get("F_static");\n`,
        }),
      ).toEqual([]);
      expect(
        falseOnes(
          bundled(
            {
              "a.js": `export class Store { static get(k) { return localStorage.getItem("app." + k); } get(k) { return k; } }\n`,
              "entry.js": `import { Store } from "./a.js";\nnew Store().get("F_static_inst");\n`,
            },
            "entry.js",
            true,
          ),
        ),
      ).toEqual([]);
      expect(
        falseOnes({
          "router.js": `const { ipcMain } = require("electron");\nclass Router { static handle(ch, f) { ipcMain.handle(ch, f); } handle(ch, f) { return ch; } }\nmodule.exports = { Router };\n`,
          "m.js": `const { Router } = require("./router");\nnew Router().handle("F_static_inst", 1);\n`,
        }),
      ).toEqual([]);
    });
    it("a method replaced from a third module", () => {
      expect(
        falseOnes({
          "store.js": STORE_CJS,
          "patch.js": `const { Store } = require("./store");\nStore.prototype.get = function (k) { return k; };\n`,
          "r.js": `require("./patch");\nconst { Store } = require("./store");\nnew Store().get("F_proto_third");\n`,
        }),
      ).toEqual([]);
      expect(
        falseOnes({
          "store.js": `class Store { get(k) { return localStorage.getItem("app." + k); } }\nmodule.exports = new Store();\n`,
          "patch.js": `const s = require("./store");\ns.get = (k) => k;\n`,
          "r.js": `require("./patch");\nconst s = require("./store");\ns.get("F_inst_third");\n`,
        }),
      ).toEqual([]);
      expect(
        falseOnes({
          "store.js": STORE_CJS,
          "r.js": `const { Store } = require("./store");\nconst s = new Store();\nReflect.set(s, "get", (k) => k);\ns.get("F_reflect");\n`,
        }),
      ).toEqual([]);
      expect(
        falseOnes({
          "router.js": ROUTER,
          "patch.js": `const { Router } = require("./router");\nRouter.prototype.handle = function (c) { return c; };\n`,
          "m.js": `require("./patch");\nconst { Router } = require("./router");\nnew Router().handle("F_proto", 1);\n`,
        }),
      ).toEqual([]);
    });
    it("export *: the module's own export wins, two sources of one name are ambiguous", () => {
      expect(
        falseOnes({
          "store.js": ESTORE,
          "index.js": `export * from "./store.js";\nexport class Store { get(k) { return k; } }\n`,
          "r.js": `import { Store } from "./index.js";\nnew Store().get("F_star_local_wins");\n`,
        }),
      ).toEqual([]);
      expect(
        falseOnes({
          "store.js": ESTORE,
          "other.js": `export class Store { get(k) { return k; } }\n`,
          "index.js": `export * from "./store.js";\nexport * from "./other.js";\n`,
          "r.js": `import { Store } from "./index.js";\nnew Store().get("F_star_ambiguous");\n`,
        }),
      ).toEqual([]);
      // one source only still counts
      expect(
        keys(
          analyze({
            "store.js": ESTORE,
            "index.js": `export * from "./store.js";\n`,
            "r.js": `import { Store } from "./index.js";\nnew Store().get("star_ok");\n`,
          }),
        ),
      ).toContain("localStorage read app.star_ok");
    });
    it("a parameter the callee assigns, or that other calls pass something else for", () => {
      expect(
        falseOnes({
          "store.js": STORE_CJS,
          "use.js": `exports.use = function (s) { s = new Map(); s.get("F_seed_reassigned"); };\n`,
          "r.js": `const { Store } = require("./store");\nconst { use } = require("./use");\nuse(new Store());\n`,
        }),
      ).toEqual([]);
      expect(
        falseOnes({
          "store.js": STORE_CJS,
          "use.js": `exports.use = function (s) { s.get("F_mixed"); };\n`,
          "r.js": `const { Store } = require("./store");\nconst { use } = require("./use");\nuse(new Store());\nuse(new Map());\n`,
        }),
      ).toEqual([]);
      expect(
        falseOnes({
          "router.js": ROUTER,
          "use.js": `exports.use = function (r) { r = new Map(); r.handle("F_ipc_seed_reassigned", 1); };\n`,
          "m.js": `const { Router } = require("./router");\nconst { use } = require("./use");\nuse(new Router());\n`,
        }),
      ).toEqual([]);
      // the plain seeded case still reads
      expect(
        keys(
          analyze({
            "store.js": STORE_CJS,
            "use.js": `exports.use = function (s) { s.get("seed_ok"); };\n`,
            "r.js": `const { Store } = require("./store");\nconst { use } = require("./use");\nuse(new Store());\n`,
          }),
        ),
      ).toContain("localStorage read app.seed_ok");
    });
  });

  it("caps the calls of a file's own wrappers and says so", () => {
    const names = Array.from({ length: 16 }, (_, i) => `m${i}`);
    const source =
      `class S { ${names.map((m) => `${m}(k) { return localStorage.getItem("p." + k + window.z); }`).join(" ")} }\nexport default S;\n` +
      Array.from(
        { length: 400 },
        (_, i) => `const s${i} = new S(); ${names.map((m) => `s${i}.${m}(q${i});`).join(" ")}`,
      ).join("\n");
    const started = performance.now();
    const info = analyze({ "e.js": source });
    expect(performance.now() - started).toBeLessThan(10_000);
    expect(info.limitations.map((l) => l.code)).toContain("storage_wrappers_capped");
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
