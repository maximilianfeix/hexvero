import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildSync } from "esbuild";
import { afterAll, describe, expect, it } from "vitest";
import { analyzeJavaScriptTree, asarTree, type JsAppInfo } from "../src/javascript/app.js";
import { REPLACEMENT_APP_WORK } from "../src/javascript/wrappers.js";
import { buildAsar } from "./fixtures/asar.js";

/**
 * Storage keys passed through a wrapper class or object that another module defines: read at
 * each call in the importing module, with the key the wrapper's own key expression builds, as
 * written (plain), bundled by esbuild and minified. The expected keys are written from the
 * fixture sources; nothing of them is run.
 */

const dir = mkdtempSync(join(tmpdir(), "hexvero-storage-wrappers-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function analyze(
  files: Record<string, string>,
  options: Parameters<typeof analyzeJavaScriptTree>[1] = {},
): JsAppInfo {
  return analyzeJavaScriptTree(
    asarTree(
      buildAsar({
        "package.json": JSON.stringify({ name: "s", main: "main.js" }),
        "main.js": 'require("electron");\n',
        ...files,
      }),
      "app.asar",
    ),
    options,
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

/** Wrappers and the result of an app for the replacement-budget tests. */
const ROUTER_OF = (n: string): string =>
  `const { ipcMain } = require("electron");\nclass ${n} { handle(ch, f) { ipcMain.handle(ch, f); } }\nmodule.exports = { ${n}, inst: new ${n}() };\n`;
const STORE_OF = (n: string): string =>
  `class ${n} { save(k, v) { localStorage.setItem("${n}." + k, v); } }\nmodule.exports = { ${n}, inst: new ${n}() };\n`;
const result = (info: JsAppInfo): string[] => [
  ...info.ipcChannels.map((c) => c.channel).toSorted(),
  ...info.storage.flatMap((r) => (r.via ? [`${r.file} ${r.value}`] : [])).toSorted(),
  ...info.limitations
    .map((l) => l.code)
    .filter((c) => /wrapper/.test(c))
    .toSorted(),
];

/** IPC channels and whole storage keys of the analysis, sorted. */
const found = (files: Record<string, string>): string[] => {
  const info = analyze(files);
  return [
    ...info.ipcChannels.map((c) => c.channel),
    ...info.storage.flatMap((r) => (r.value && !r.value.includes("${") ? [r.value] : [])),
  ].toSorted();
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

  describe("a member write elsewhere blocks only a receiver that can be the wrapper (R5)", () => {
    const ROUTER = `const { ipcMain } = require("electron");\nclass Router { handle(ch, f) { ipcMain.handle(ch, f); } }\nmodule.exports = { Router, router: new Router() };\n`;
    const SAVE_STORE = `class Store { save(k, v) { localStorage.setItem("app." + k, v); } get(k) { return localStorage.getItem("app." + k); } }\nmodule.exports = { Store };\n`;
    const base = {
      "router.js": ROUTER,
      "store.js": SAVE_STORE,
      "m.js": `const { Router, router } = require("./router");\nnew Router().handle("ok_new", () => 1);\nrouter.handle("ok_single", () => 1);\n`,
      "r.js": `const { Store } = require("./store");\nconst s = new Store();\ns.save("ok_save", 1);\ns.get("ok_get");\n`,
    };
    const ALL = ["app.ok_get", "app.ok_save", "ok_new", "ok_single"];
    it("unrelated objects of the same method names in other modules", () => {
      expect(found(base)).toEqual(ALL);
      expect(found({ ...base, "ui.js": `const srv = {};\nsrv.handle = (req) => req;\n` })).toEqual(
        ALL,
      );
      expect(
        found({
          ...base,
          "ui.js": `const form = {};\nform.save = onSave;\nfunction onSave() {}\n`,
        }),
      ).toEqual(ALL);
      expect(
        found({
          ...base,
          "node_modules/lib/index.js": `function Server() {}\nServer.prototype.handle = function (req) { return req; };\nmodule.exports = Server;\n`,
        }),
      ).toEqual(ALL);
    });
    it("many member names in one module turn nothing off", () => {
      const many = Array.from({ length: 20_001 }, (_, i) => `o.p${i} = f;`).join("\n");
      const info = analyze({ ...base, "big.js": `var o = {};\nfunction f() {}\n${many}\n` });
      expect(info.ipcChannels.map((c) => c.channel).toSorted()).toEqual(["ok_new", "ok_single"]);
      expect(info.storage.some((r) => r.value === "app.ok_save")).toBe(true);
    });
    it("a replacement on the wrapper itself blocks it, and says so", () => {
      const info = analyze({
        ...base,
        "patch.js": `const { Store } = require("./store");\nStore.prototype.save = function (k) { return k; };\n`,
      });
      expect(info.storage.some((r) => r.value === "app.ok_save")).toBe(false);
      expect(info.storage.some((r) => r.value === "app.ok_get")).toBe(true);
      const lim = info.limitations.find((l) => l.code === "wrapper_method_replaced");
      expect(lim?.message).toMatch(/Store\.save/);
      expect(lim?.message).toMatch(/patch\.js/);
    });
  });

  describe("replacements in a module that imports the wrapper (R5, third round)", () => {
    const STORE2 = `class Store { save(k, v) { localStorage.setItem("app." + k, v); } }\nmodule.exports = { Store, store: new Store() };\n`;
    const ROUTER2 = `const { ipcMain } = require("electron");\nclass Router { handle(ch, f) { ipcMain.handle(ch, f); } }\nmodule.exports = { Router, router: new Router() };\n`;
    /** The false keys and channels with the patch, and whether the limitation names the write. */
    const patched = (patch: string, extra: Record<string, string> = {}): [string[], boolean] => {
      const info = analyze({
        "store.js": STORE2,
        "router.js": ROUTER2,
        "patch.js": `${patch}\n`,
        "r.js": `require("./patch");\nconst { Store, store } = require("./store");\nnew Store().save("F_KEY", 1);\nstore.save("F_KEY_single", 1);\n`,
        "m.js": `require("./patch");\nconst { Router, router } = require("./router");\nnew Router().handle("R_CH", 1);\nrouter.handle("R_CH_single", 1);\n`,
        ...extra,
      });
      return [
        [
          ...info.storage.flatMap((r) => (r.value?.includes("F_") ? [r.value] : [])),
          ...info.ipcChannels.flatMap((c) => (c.channel.startsWith("R_") ? [c.channel] : [])),
        ],
        info.limitations.some(
          (l) => l.code === "wrapper_method_replaced" && l.message.includes("patch.js"),
        ),
      ];
    };
    it("a whole CommonJS re-export (`module.exports = require(…)`)", () => {
      expect(
        patched(`const { store } = require("./index");\nstore.save = () => 0;`, {
          "index.js": `module.exports = require("./store");\n`,
        }),
      ).toEqual([["R_CH", "R_CH_single"], true]);
    });
    it("the prototype reached another way", () => {
      for (const patch of [
        `const { Store } = require("./store");\nconst P = Store.prototype;\nP.save = function () {};`,
        `const P = require("./store").Store.prototype;\nP.save = function () {};`,
        `const { store } = require("./store");\nObject.getPrototypeOf(store).save = function () {};`,
        `const { store } = require("./store");\nstore.constructor.prototype.save = function () {};`,
        `const { store } = require("./store");\nstore.__proto__.save = function () {};`,
        `const { Router } = require("./router");\nconst P = Router.prototype;\nP.handle = function () {};\nconst { Store } = require("./store");\nStore.prototype.save = 1;`,
      ])
        expect(patched(patch)[1], patch).toBe(true);
      expect(
        patched(
          `const { store } = require("./store");\nObject.getPrototypeOf(store).save = function () {};`,
        )[0],
      ).toEqual(["R_CH", "R_CH_single"]);
      // IPC: the router's method replaced through an alias of its prototype
      expect(
        patched(
          `const { Router } = require("./router");\nconst P = Router.prototype;\nP.handle = function () {};`,
        )[0].filter((c) => c.startsWith("R_")),
      ).toEqual([]);
    });
    it("a removal: setPrototypeOf and delete", () => {
      for (const patch of [
        `const { store } = require("./store");\nObject.setPrototypeOf(store, { save() {} });`,
        `const { Store } = require("./store");\nObject.setPrototypeOf(Store.prototype, {});`,
        `const { Store } = require("./store");\ndelete Store.prototype.save;`,
        `const { store } = require("./store");\ndelete store.save;`,
      ]) {
        const [falseKeys, said] = patched(patch);
        expect(said, patch).toBe(true);
        expect(
          falseKeys.filter((k) => k.startsWith("app.")),
          patch,
        ).toEqual([]);
      }
    });
    it("a destructuring or logical assignment target", () => {
      for (const patch of [
        `const { store } = require("./store");\nconst o = store;\n[o.save] = [() => 0];`,
        `const { store } = require("./store");\n({ a: store.save } = { a: () => 0 });`,
        `const { store } = require("./store");\nstore.save ||= () => 0;`,
      ]) {
        const [falseKeys, said] = patched(patch);
        expect(said, patch).toBe(true);
        expect(falseKeys, patch).toEqual(["R_CH", "R_CH_single"]);
      }
    });
    it("the export binding itself written: any method", () => {
      for (const patch of [
        `const m = require("./store");\nm.store = new Proxy(m.store, { get: () => () => 0 });`,
        `const m = require("./store");\nm.store = { save: () => 0 };\nm.Store = class { save() {} };`,
      ]) {
        const [falseKeys, said] = patched(patch);
        expect(said, patch).toBe(true);
        expect(
          falseKeys.filter((k) => k.startsWith("app.")),
          patch,
        ).toEqual([]);
      }
    });
  });

  describe("module.exports = require(…) passes a module on only where that is certain (R5)", () => {
    const REAL = `module.exports = { API: "https://real.example", CH: "real-ch" };\n`;
    const FAKE = `module.exports = { API: "https://fake.example", CH: "fake-ch" };\n`;
    const REEXP_USER = `const { API, CH } = require("./index");\nconst { ipcMain } = require("electron");\nfetch(API + "/x");\nipcMain.on(CH, () => 0);\n`;
    /** Endpoints and channels the user module gets through index.js. */
    const through = (index: string, extra: Record<string, string> = {}): string[] => {
      const info = analyze({
        "real.js": REAL,
        "fake.js": FAKE,
        "index.js": index,
        "u.js": REEXP_USER,
        ...extra,
      });
      return [
        ...info.endpoints.filter((r) => r.file === "u.js").map((r) => r.value ?? "?"),
        ...info.ipcChannels.map((c) => c.channel),
      ];
    };
    it("the one write of the exports, at the top of the file", () => {
      expect(through(`module.exports = require("./real");\n`)).toEqual([
        "https://real.example/x",
        "real-ch",
      ]);
      // a member added after it is read as before
      expect(
        through(
          `module.exports = require("./real");\nmodule.exports.API = "https://extra.example";\n`,
        ),
      ).toEqual(["https://extra.example/x", "real-ch"]);
    });
    it.each([
      [
        "replaced later",
        `module.exports = require("./real");\nmodule.exports = require("./fake");\n`,
      ],
      ["under a condition", `if (process.env.DEV) module.exports = require("./fake");\n`],
      [
        "in both branches",
        `if (process.env.DEV) module.exports = require("./fake");\nelse module.exports = require("./real");\n`,
      ],
      ["wrapped", `module.exports = require("./real");\nmodule.exports = wrap(module.exports);\n`],
      ["after &&", `process.env.DEV && (module.exports = require("./fake"));\n`],
      ["in a function", `function load() { module.exports = require("./fake"); }\n`],
      [
        "replaced through module[…]",
        `module.exports = require("./real");\nmodule["exports"] = { API: "https://br.example", CH: "br-ch" };\n`,
      ],
      ["a tagged template on the next line", 'module.exports = require("./real")\n`x`\n'],
      ["a call on the next line", `module.exports = require("./real")\n(1)\n`],
      ["a member on the next line", `module.exports = require("./real")\n.sub\n`],
    ])("%s: not known", (_name, index) => {
      expect(through(index)).toEqual(["${…}/x"]);
    });
    it("replaced through an alias of module: the later object, never the re-exported module", () => {
      const got = through(
        `module.exports = require("./real");\nconst m = module; m.exports = { API: "https://a.example", CH: "a-ch" };\n`,
      );
      expect(got.filter((x) => x.includes("real"))).toEqual([]);
    });
    it("a statement on the next line ends it (ASI)", () => {
      expect(through(`module.exports = require("./real")\nconsole.log(1)\n`)).toEqual([
        "https://real.example/x",
        "real-ch",
      ]);
    });
    it("cycles end", () => {
      expect(
        through(`module.exports = require("./other");\n`, {
          "other.js": `module.exports = require("./index");\n`,
        }),
      ).toEqual(["${…}/x"]);
      expect(through(`module.exports = require("./index");\n`)).toEqual(["${…}/x"]);
    });
    it("for replacements of wrapper methods every form counts", () => {
      const info = analyze({
        "store.js": `class Store { save(k, v) { localStorage.setItem("app." + k, v); } }\nmodule.exports = { Store, store: new Store() };\n`,
        "index.js": `if (process.env.DEV) module.exports = require("./store");\n`,
        "patch.js": `const { store } = require("./index");\nstore.save = () => 0;\n`,
        "r.js": `require("./patch");\nconst { store } = require("./store");\nstore.save("F_cond", 1);\n`,
      });
      expect(info.storage.filter((r) => r.value?.includes("F_"))).toEqual([]);
      expect(info.limitations.map((l) => l.code)).toContain("wrapper_method_replaced");
    });
  });

  it("one replacement budget for the application, and says so when it runs out", () => {
    const writes = Array.from(
      { length: 400 },
      (_, i) => `const o${i} = q${i} || {}; o${i}.save = f; o${i}.x${i} = f;`,
    ).join("\n");
    const files: Record<string, string> = {
      "store.js": `class Store { save(k, v) { localStorage.setItem("app." + k, v); } }\nmodule.exports = { Store, store: new Store() };\n`,
      "r.js": `const { store } = require("./store");\nstore.save("ok_key", 1);\n`,
    };
    for (let i = 0; i < 400; i++)
      files[`p${i}.js`] = `const { store } = require("./store");\n${writes}\n`;
    const started = performance.now();
    const info = analyze(files);
    expect(performance.now() - started).toBeLessThan(30_000);
    const read = info.storage.some((r) => r.value === "app.ok_key");
    const lim = info.limitations.find((l) => l.code === "wrapper_method_replaced");
    // either every importing module was read (no write there is on the store), or the rest is
    // flagged and the method counts as replaced
    if (!read) expect(lim?.message).toMatch(/replacement budget/);
    else expect(lim).toBeUndefined();
  });

  describe("past the application's replacement budget (R5)", () => {
    // The budget is set 200 times smaller than the production one, with modules 200 times
    // smaller than a real application would need to reach it (20 × 70,000 statements).
    const BUDGETS = { budgets: { replacementAppWork: REPLACEMENT_APP_WORK / 200 } };
    const filler = Array.from({ length: 350 }, (_, i) => `o.a${i % 50} = ${i};`).join("\n");
    /** Ten big modules importing the first wrapper, named with the prefix. */
    const bigs = (prefix: string, mod: string): Record<string, string> =>
      Object.fromEntries(
        Array.from({ length: 10 }, (_, i) => [
          `${prefix}${i}.js`,
          `const m = require("./${mod}");\nconst o = {};\n${filler}\n`,
        ]),
      );
    const app = (prefix: string): Record<string, string> => ({
      "r1.js": ROUTER_OF("One"),
      "r2.js": ROUTER_OF("Two"),
      "s1.js": STORE_OF("First"),
      "s2.js": STORE_OF("Second"),
      "c1.js": `const { inst } = require("./r1");\ninst.handle("ch_one", () => 0);\nconst a = require("./s1").inst;\na.save("k1", 1);\n`,
      "c2.js": `const { inst } = require("./r2");\ninst.handle("ch_two", () => 0);\nconst b = require("./s2").inst;\nb.save("k2", 1);\n`,
      ...bigs(prefix, "r1"),
      ...bigs(`${prefix}s`, "s1"),
    });
    it("keeps the production budget", () => {
      expect(REPLACEMENT_APP_WORK).toBe(3_000_000);
      // the small fixture is within the production budget: every replacement is checked
      expect(analyze(app("a_big")).limitations.map((l) => l.code)).not.toContain(
        "wrapper_replacements_unchecked",
      );
    });
    it("IPC keeps its rows and says the replacements were not checked; storage stays conservative, flagged", () => {
      const info = analyze(app("a_big"), BUDGETS);
      expect(info.ipcChannels.map((c) => c.channel).toSorted()).toEqual(["ch_one", "ch_two"]);
      expect(
        info.limitations.find((l) => l.code === "wrapper_replacements_unchecked")?.message,
      ).toMatch(/not checked for replacements/);
      // the store the unread modules import counts as replaced, the other one is read
      const viaKeys = info.storage.flatMap((r) => (r.via ? [r.value] : []));
      expect(viaKeys).not.toContain("First.k1");
      expect(info.limitations.find((l) => l.code === "wrapper_method_replaced")?.message).toMatch(
        /First\.save/,
      );
    });
    it("an importer growing between two builds changes no row", () => {
      const before = app("a_big");
      const after = { ...before, "a_big3.js": `${before["a_big3.js"]}${"// grown\n".repeat(500)}` };
      expect(result(analyze(after, BUDGETS))).toEqual(result(analyze(before, BUDGETS)));
    });
    it("over 200 calling files: the same 200 by path in both builds, whatever their sizes", () => {
      const ROUTER = `const { ipcMain } = require("electron");\nclass Router { handle(ch, f) { ipcMain.handle(ch, f); } }\nmodule.exports = { router: new Router() };\n`;
      const build = (grown: number): Record<string, string> => {
        const files: Record<string, string> = { "router.js": ROUTER };
        for (let i = 0; i < 260; i++) {
          const n = String(i).padStart(3, "0");
          files[`c${n}.js`] =
            `const { router } = require("./router");\nrouter.handle("ch_${n}", () => 0);\n` +
            "// pad\n".repeat(i === grown ? 500 : 260 - i);
        }
        return files;
      };
      const first = analyze(build(-1)).ipcChannels.map((c) => c.channel);
      expect(first).toEqual(
        Array.from({ length: 200 }, (_, i) => `ch_${String(i).padStart(3, "0")}`),
      );
      expect(analyze(build(5)).ipcChannels.map((c) => c.channel)).toEqual(first);
    });
  });

  it("folds the per-file storage_wrappers_capped entries into one", () => {
    const names = Array.from({ length: 16 }, (_, i) => `m${i}`);
    const one =
      `class S { ${names.map((m) => `${m}(k) { return localStorage.getItem("p." + k + window.z); }`).join(" ")} }\nexport default S;\n` +
      Array.from(
        { length: 40 },
        (_, i) =>
          `const s${i} = new S(); ${names.map((m) => `s${i}.${m}("x"); s${i}.${m}("y");`).join(" ")}`,
      ).join("\n");
    const files: Record<string, string> = {};
    for (let i = 0; i < 7; i++) files[`f${i}.js`] = one;
    const caps = analyze(files).limitations.filter((l) => l.code === "storage_wrappers_capped");
    expect(caps).toHaveLength(1);
    expect(caps[0]!.message).toMatch(/^7 file/);
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

// Issue #202: in one bundle, the replacements the stage across modules reads count for the
// file's own storage wrappers as well.
describe("a storage wrapper method replaced in the same bundle (#202)", () => {
  const STORE = `const key = (name) => "app." + name;\nexport const local = { get: (name) => localStorage.getItem(key(name)) };\n`;
  const PATCHES: Record<string, string> = {
    destructuring: "({ a: local.get } = { a: (n) => n });",
    nullish: "local.get ??= (n) => n;",
    assign: "Object.assign(local, globalThis.o);",
    reflect: "Reflect.set(local, globalThis.k, (n) => n);",
  };
  for (const [name, patch] of Object.entries(PATCHES))
    for (const minify of [false, true])
      it(`gives no row through it: ${name}${minify ? ", minified" : ""}`, () => {
        const sources = {
          "store.js": STORE,
          "patch.js": `import { local } from "./store";\n${patch}\n`,
          "renderer.js": `import { local } from "./store";\nimport "./patch";\nlocal.get("theme");\n`,
        };
        // as separate modules (the stage across modules), and as one bundle
        const plain = analyze(sources);
        const one = analyze(bundled(sources, "renderer.js", minify, "esm"));
        for (const info of [plain, one]) {
          expect(keys(info)).not.toContain("localStorage read app.theme");
          expect(info.limitations.map((l) => l.code)).toContain("wrapper_method_replaced");
        }
      });
  it("still reads it when another member is written", () => {
    const sources = {
      "store.js": STORE,
      "patch.js": 'import { local } from "./store";\nlocal.other = 1;\n',
      "renderer.js": `import { local } from "./store";\nimport "./patch";\nlocal.get("theme");\n`,
    };
    for (const minify of [false, true])
      expect(keys(analyze(bundled(sources, "renderer.js", minify, "esm")))).toContain(
        "localStorage read app.theme",
      );
  });
});
