import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildSync } from "esbuild";
import { afterAll, describe, expect, it } from "vitest";
import { analyzeJavaScriptTree, asarTree, type JsAppInfo } from "../src/javascript/app.js";
import { buildAsar } from "./fixtures/asar.js";

/**
 * A constant the code changes before it is used is no constant (issue #198). Every form of
 * write (`=`, every compound assignment, `++`/`--` before and after, array and object patterns,
 * `for (… of|in …)` heads) is applied to the constant every reader takes a value from: an IPC
 * channel and a channel table, a bridge member's channel, an endpoint and the base of one, a
 * storage key and the prefix a key helper adds, a window's webPreferences object, a channel
 * exported by another module, and the channel passed to a function wrapper and a class wrapper.
 * The constant is a `let`, a `var`, or a member of a `const` object. The probes are read as
 * written, bundled by esbuild and minified; the expected values are written from the probe
 * sources, and nothing of them is run.
 */

const dir = mkdtempSync(join(tmpdir(), "hexvero-writes-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

type Build = "plain" | "bundled" | "minified";
const BUILDS: Build[] = ["plain", "bundled", "minified"];
const ENTRIES = ["main.js", "preload.js", "renderer.js"];

function build(sources: Record<string, string>, how: Build): Record<string, string> {
  if (how === "plain") return sources;
  const src = mkdtempSync(join(dir, "src-"));
  for (const [name, text] of Object.entries(sources)) {
    mkdirSync(dirname(join(src, name)), { recursive: true });
    writeFileSync(join(src, name), text);
  }
  const out: Record<string, string> = {};
  for (const entry of ENTRIES.filter((e) => e in sources)) {
    const outfile = join(src, "out", entry);
    buildSync({
      entryPoints: [join(src, entry)],
      bundle: true,
      minify: how === "minified",
      platform: "node",
      format: "cjs",
      external: ["electron"],
      outfile,
      logLevel: "silent",
    });
    out[entry] = readFileSync(outfile, "utf8");
  }
  return out;
}

function analyze(files: Record<string, string>): JsAppInfo {
  return analyzeJavaScriptTree(
    asarTree(
      buildAsar({
        "package.json": JSON.stringify({
          name: "t",
          main: "main.js",
          devDependencies: { electron: "^38.0.0" },
        }),
        ...files,
      }),
      "app.asar",
    ),
  );
}

/** How the constant is declared and written. */
type Binding = "let" | "var" | "member";
const BINDINGS: Binding[] = ["let", "var", "member"];

/** A write to target T (a name or `X.A`) with `v` (a parameter) on the right. */
const FORMS: Record<string, (t: string, name: boolean) => string | null> = {
  none: () => "",
  "=": (t) => `${t} = v;`,
  "+=": (t) => `${t} += v;`,
  "-=": (t) => `${t} -= v;`,
  "*=": (t) => `${t} *= v;`,
  "/=": (t) => `${t} /= v;`,
  "%=": (t) => `${t} %= v;`,
  "**=": (t) => `${t} **= v;`,
  "<<=": (t) => `${t} <<= v;`,
  ">>=": (t) => `${t} >>= v;`,
  ">>>=": (t) => `${t} >>>= v;`,
  "&=": (t) => `${t} &= v;`,
  "|=": (t) => `${t} |= v;`,
  "^=": (t) => `${t} ^= v;`,
  "&&=": (t) => `${t} &&= v;`,
  "||=": (t) => `${t} ||= v;`,
  "??=": (t) => `${t} ??= v;`,
  "x++": (t) => `${t}++;`,
  "++x": (t) => `++${t};`,
  "x--": (t) => `${t}--;`,
  "--x": (t) => `--${t};`,
  "[x] =": (t) => `[${t}] = v;`,
  "[, x] =": (t) => `[, ${t}] = v;`,
  "({ x } =)": (t, name) => (name ? `({ ${t} } = v);` : null),
  "({ k: x } =)": (t) => `({ k: ${t} } = v);`,
  "for of": (t) => `for (${t} of v);`,
  "for in": (t) => `for (${t} in v);`,
};

/**
 * Uses that write nothing of the constant: comparisons, reads into another name, a shadowing
 * declaration, parameter and pattern of its own, a class field. The value stays known.
 */
const READS: Record<string, (t: string, name: boolean) => string | null> = {
  "== / ===": (t) => `if (${t} == v || ${t} === v || ${t} <= v || ${t} >= v) return;`,
  "x = T": (t) => `const copy = ${t}; v = ${t};`,
  "[T] / { k: T }": (t) => `console.log([${t}], { k: ${t} });`,
  "f(T), !T, typeof T": (t) => `console.log(!${t}, typeof ${t}, String(${t}));`,
  "o[T] = v": (t) => `const o = {}; o[${t}] = v; o[${t}] += v; [o[${t}]] = v;`,
  "local const": (t, name) => (name ? `const ${t} = v;` : null),
  "local pattern": (t, name) => (name ? `const { ${t} } = v; let [${t}2] = v;` : null),
  "parameter default": (t, name) => (name ? `const g = (${t} = v) => ${t};` : null),
  "class field": (t, name) => (name ? `class K { ${t} = v; }` : null),
  "for (const T of)": (t, name) => (name ? `for (const ${t} of v);` : null),
  // a local of the same name, as minifiers reuse short names: its writes are its own
  "local let, written": (t, name) => (name ? `let ${t} = 0; ${t}++; ${t} += v;` : null),
  "parameter, written": (t, name) =>
    name ? `const h = (${t}) => { ${t} += v; ${t}++; }; function i(${t}) { [${t}] = v; }` : null,
};
for (const [form, write] of Object.entries(READS)) FORMS[`read: ${form}`] = write;

interface Reader {
  id: string;
  file: "main.js" | "preload.js" | "renderer.js" | "tables.js";
  /** The constant's name and literal. */
  name: string;
  value: string;
  /** The use of the constant; `@` stands for the reference to it. */
  use: string;
  /** For the member binding: the key of the table the value is under. */
  key?: string;
  /** Whether the value is reported (as written) for that build. */
  known: (info: JsAppInfo) => boolean;
}

const ipcKnown =
  (channel: string, wrapper = false) =>
  (info: JsAppInfo): boolean =>
    info.modules.some((m) =>
      m.ipc.some((u) => u.channel === channel && (!wrapper || u.via === "wrapper")),
    );

const READERS: Reader[] = [
  {
    id: "ipc channel",
    file: "main.js",
    name: "CH",
    value: "c:x",
    use: "ipcMain.on(@, () => 1);",
    known: ipcKnown("c:x"),
  },
  {
    id: "ipc table",
    file: "main.js",
    name: "TB",
    value: "t:x",
    key: "OPEN",
    use: "ipcMain.handle(@, () => 1);",
    known: ipcKnown("t:x"),
  },
  {
    id: "bridge member",
    file: "preload.js",
    name: "BR",
    value: "b:x",
    use: 'contextBridge.exposeInMainWorld("api", { go: () => ipcRenderer.invoke(@) });',
    known: (info) => info.contextBridge.some((b) => b.channel === "b:x"),
  },
  {
    id: "endpoint",
    file: "main.js",
    name: "EP",
    value: "https://e.example/x",
    use: "fetch(@);",
    known: (info) => info.endpoints.some((e) => e.value === "https://e.example/x"),
  },
  {
    id: "endpoint base",
    file: "main.js",
    name: "EB",
    value: "https://b.example",
    use: 'fetch(@ + "/x");',
    known: (info) => info.endpoints.some((e) => e.value?.startsWith("https://b.example") ?? false),
  },
  {
    id: "storage key",
    file: "renderer.js",
    name: "SK",
    value: "s.x",
    use: "localStorage.getItem(@);",
    known: (info) => info.storage.some((r) => r.value === "s.x"),
  },
  {
    id: "storage prefix",
    file: "renderer.js",
    name: "SP",
    value: "p.",
    use: 'const keyOf = (n) => @ + n;\nlocalStorage.setItem(keyOf("y"), "1");',
    known: (info) => info.storage.some((r) => r.value === "p.y"),
  },
  {
    id: "window options",
    file: "main.js",
    name: "WP",
    value: "",
    use: "new BrowserWindow({ webPreferences: @ });",
    known: (info) => info.windows.some((w) => w.nodeIntegration === true),
  },
  {
    id: "other module",
    file: "tables.js",
    name: "OM",
    value: "o:x",
    use: "",
    known: ipcKnown("o:x"),
  },
  {
    id: "function wrapper",
    file: "main.js",
    name: "FW",
    value: "w:x",
    use: "onEvent(@, () => 1);",
    known: ipcKnown("w:x"),
  },
  {
    id: "class wrapper",
    file: "main.js",
    name: "CW",
    value: "m:x",
    use: "manager.handle(@, () => 1);",
    known: ipcKnown("m:x", true),
  },
];

/** The declaration of the reader's constant, its reference, and the write target. */
function parts(r: Reader, binding: Binding): { decl: string; ref: string; target: string } {
  const key = r.key ?? "A";
  if (r.id === "window options") {
    const object = "{ nodeIntegration: true, contextIsolation: false }";
    return binding === "member"
      ? { decl: `const WP = ${object};`, ref: "WP", target: "WP.nodeIntegration" }
      : { decl: `${binding} WP = ${object};`, ref: "WP", target: "WP" };
  }
  const literal = JSON.stringify(r.value);
  if (binding === "member")
    return {
      decl: `const ${r.name} = { ${key}: ${literal}, OTHER: "other" };`,
      ref: `${r.name}.${key}`,
      target: `${r.name}.${key}`,
    };
  return { decl: `${binding} ${r.name} = ${literal};`, ref: r.name, target: r.name };
}

/** The probe application for one write form and binding: every reader at once. */
function probe(form: string, binding: Binding): Record<string, string> | null {
  const write = FORMS[form]!;
  const files: Record<
    string,
    { head: string[]; decls: string[]; writes: string[]; uses: string[] }
  > = {
    "main.js": {
      head: [
        'const { ipcMain, BrowserWindow } = require("electron");',
        'const tables = require("./tables.js");',
        "function onEvent(channel, listener) { ipcMain.on(channel, listener); }",
        "class Manager { handle(channel, listener) { ipcMain.handle(channel, listener); } }",
        "const manager = new Manager();",
      ],
      decls: [],
      writes: [],
      uses: [],
    },
    "preload.js": {
      head: ['const { contextBridge, ipcRenderer } = require("electron");'],
      decls: [],
      writes: [],
      uses: [],
    },
    "renderer.js": { head: [], decls: [], writes: [], uses: [] },
    "tables.js": { head: [], decls: [], writes: [], uses: [] },
  };
  for (const r of READERS) {
    const { decl, ref, target } = parts(r, binding);
    const w = write(target, binding !== "member");
    if (w === null) return null;
    const f = files[r.file]!;
    f.decls.push(decl);
    // each in a block of its own, so the declarations of the reads do not collide
    if (w) f.writes.push(`{ ${w} }`);
    if (r.file === "tables.js") {
      // read in main.js through the module's exports
      files["main.js"]!.uses.push(`ipcMain.on(tables.${ref}, () => 1);`);
      // written before the module hands the value out
      f.uses.push(`later(globalThis.input);\nmodule.exports = { ${r.name}, later };`);
    } else f.uses.push(r.use.replaceAll("@", ref));
  }
  const out: Record<string, string> = {};
  for (const [name, f] of Object.entries(files)) {
    const later = `function later(v) {\n  ${f.writes.join("\n  ")}\n}`;
    const exported = name === "tables.js" ? [] : ["module.exports.later = later;"];
    out[name] = [...f.head, ...f.decls, later, ...exported, ...f.uses, ""].join("\n");
  }
  return out;
}

type Cell = "known" | "unknown";
const matrix = new Map<string, Cell>();
const cellOf = (form: string, binding: Binding, how: Build, reader: string): string =>
  `${form}|${binding}|${how}|${reader}`;

for (const form of Object.keys(FORMS))
  for (const binding of BINDINGS) {
    const sources = probe(form, binding);
    if (!sources) continue;
    for (const how of BUILDS) {
      const info = analyze(build(sources, how));
      for (const r of READERS)
        matrix.set(cellOf(form, binding, how, r.id), r.known(info) ? "known" : "unknown");
    }
  }

/** The matrix as text: one line per form and binding, a column per reader and build. */
function table(): string {
  const head = READERS.map((r) => r.id.padEnd(16)).join(" ");
  const lines = [`${"form".padEnd(14)} ${"bind".padEnd(6)} ${head}`];
  for (const form of Object.keys(FORMS))
    for (const binding of BINDINGS) {
      if (!matrix.has(cellOf(form, binding, "plain", READERS[0]!.id))) continue;
      const cells = READERS.map((r) =>
        BUILDS.map((b) => (matrix.get(cellOf(form, binding, b, r.id)) === "known" ? "K" : "."))
          .join("")
          .padEnd(16),
      );
      lines.push(`${form.padEnd(14)} ${binding.padEnd(6)} ${cells.join(" ")}`);
    }
  return lines.join("\n");
}

describe("a constant the code writes to (#198)", () => {
  it("prints the matrix", () => {
    if (process.env.HEXVERO_WRITES_MATRIX)
      writeFileSync(process.env.HEXVERO_WRITES_MATRIX, table());
  });

  it("every reader reports the constant when nothing writes to it", () => {
    const missing = READERS.flatMap((r) =>
      BINDINGS.flatMap((b) =>
        BUILDS.filter((how) => matrix.get(cellOf("none", b, how, r.id)) !== "known").map(
          (how) => `${r.id} ${b} ${how}`,
        ),
      ),
    );
    expect(missing).toEqual([]);
  });

  it("no reader reports the old value after any write", () => {
    const stale = [...matrix]
      .filter(([k, v]) => v === "known" && !k.startsWith("none|") && !k.startsWith("read: "))
      .map(([k]) => k);
    expect(stale).toEqual([]);
  });

  it("a use that writes nothing keeps the value known", () => {
    // The window reader takes any use of a whole options object it does not know (a
    // comparison, a copy, a shadowing binding) as a possible change, as it did before #198.
    const lost = [...matrix]
      .filter(([k, v]) => v === "unknown" && k.startsWith("read: "))
      .filter(([k]) => !(k.endsWith("|window options") && !k.includes("|member|")))
      .map(([k]) => k);
    expect(lost).toEqual([]);
  });
});

/** `name` sections of a probe: `//== file` lines start each file. */
function sections(text: string): Record<string, string> {
  const files: Record<string, string> = {};
  let current: string | null = null;
  for (const line of text.split("\n")) {
    const m = /^\/\/== (\S+)$/.exec(line);
    if (m) files[(current = m[1]!)] = "";
    else if (current) files[current] += `${line}\n`;
  }
  return files;
}

/** Every channel and storage key reported with a value. */
const values = (info: JsAppInfo): string[] => [
  ...info.modules.flatMap((m) => m.ipc.flatMap((u) => (u.channel ? [u.channel] : []))),
  ...info.contextBridge.flatMap((b) => (b.channel ? [b.channel] : [])),
  ...info.storage.flatMap((r) => (r.value ? [r.value] : [])),
];

/**
 * Writes the review of #198 found unseen (RA's probes C, B, D, K, G, J): each reported a value
 * the code changes before it is used.
 */
const REVIEW: Array<{ id: string; source: string; stale: string[] }> = [
  {
    id: "an element written by a function the list is passed to (#191)",
    source: `//== main.js
const { ipcMain } = require("electron");
const ROUTES = [{ kind: "on", channel: "route:a" }, { kind: "on", channel: "route:b" }];
function tweak(list) { list[0].channel = process.env.X; }
tweak(ROUTES);
for (const route of ROUTES) ipcMain[route.kind](route.channel, () => 1);
const R2 = [{ kind: "handle", channel: "r2:a" }];
function grow(list) { list[0].more.push(process.env.X); }
grow(R2);
for (const route of R2) ipcMain[route.kind](route.channel, () => 1);`,
    stale: ["route:a", "r2:a"],
  },
  {
    id: "Object.assign / Reflect.set / Object.defineProperty on a member",
    source: `//== main.js
const { ipcMain } = require("electron");
const ROUTES = [{ channel: "route:a" }, { channel: "route:b" }];
Object.assign(ROUTES[0], { channel: process.env.X });
ROUTES.forEach((r) => ipcMain.handle(r.channel, () => 1));
const T = { a: { ch: "t:a" } };
Reflect.set(T.a, "ch", process.env.Y);
for (const [k, v] of Object.entries(T)) ipcMain.on(v.ch, () => 1);
const L = [{ channel: "l:a" }];
Object.defineProperty(L[0], "channel", { value: process.env.Z });
for (const r of L) ipcMain.handle(r.channel, () => 1);`,
    stale: ["route:a", "t:a", "l:a"],
  },
  {
    id: "a table read by key through an alias or an unread callee",
    source: `//== preload.js
const { contextBridge, ipcRenderer } = require("electron");
const CH = { open: "doc:open", save: "doc:save" };
const C2 = CH;
C2.open = process.env.X;
const api = {};
Object.keys(CH).forEach((k) => { api[k] = (...a) => ipcRenderer.invoke(CH[k], ...a); });
contextBridge.exposeInMainWorld("api", api);
const T = { ping: "app:ping" };
globalThis.mutate(T);
for (const k of Object.keys(T)) ipcRenderer.on(T[k], () => 1);
const B = { b0: "bt:x" };
globalThis.mutate(B);
contextBridge.exposeInMainWorld("api2", { ...Object.fromEntries(Object.entries(B).map(([m, ch]) => [m, (...a) => ipcRenderer.invoke(ch, ...a)])) });`,
    stale: ["doc:open", "app:ping", "bt:x"],
  },
  {
    id: "a module that writes its own exported table",
    source: `//== shared/channels.js
const Channels = { OPEN: "doc:open", SAVE: "doc:save" };
Channels.OPEN = "doc:open2";
module.exports = { Channels };
//== keys.js
export const KEYS = { theme: "theme" };
KEYS.theme = "theme-" + Date.now();
//== main.js
const { ipcMain } = require("electron");
const { Channels } = require("./shared/channels");
ipcMain.handle(Channels.OPEN, () => 1);
const ROUTES = [{ channel: Channels.OPEN }];
for (const r of ROUTES) ipcMain.on(r.channel, () => 1);
//== renderer.js
import { KEYS } from "./keys";
localStorage.getItem(KEYS.theme);`,
    stale: ["doc:open", "theme"],
  },
  {
    id: "route writes through ?., entries(), a named callback, an alias and a pattern",
    source: `//== main.js
const { ipcMain } = require("electron");
const A = [{ kind: "handle", channel: "a:1" }];
for (const [i, r] of A.entries()) r.channel = process.env.X;
for (const r of A) ipcMain[r.kind](r.channel, () => 1);
const B = [{ kind: "handle", channel: "b:1" }];
B.forEach(tweak); function tweak(r) { r.channel = process.env.X; }
for (const r of B) ipcMain[r.kind](r.channel, () => 1);
const C = [{ kind: "handle", channel: "c:1" }];
for (const r of C) { const x = r; x.channel = process.env.X; }
for (const r of C) ipcMain[r.kind](r.channel, () => 1);
const D = [{ kind: "handle", channel: "d:1" }];
[D[0].channel] = [process.env.X];
for (const r of D) ipcMain[r.kind](r.channel, () => 1);
const E = [{ kind: "handle", channel: "e:1" }, { kind: "on", channel: "e:2" }];
E.splice?.(0, 1);
for (const r of E) ipcMain[r.kind](r.channel, () => 1);`,
    stale: ["a:1", "b:1", "c:1", "d:1", "e:1"],
  },
];

describe("writes the review of #198 found", () => {
  for (const review of REVIEW)
    for (const how of BUILDS)
      it(`${review.id} (${how})`, () => {
        const found = values(analyze(build(sections(review.source), how)));
        expect(found.filter((v) => review.stale.includes(v))).toEqual([]);
      });

  it("an unchanged table and a callback that only reads are still read", () => {
    const info = analyze(
      sections(`//== main.js
const { ipcMain } = require("electron");
const ROUTES = [{ kind: "on", channel: "route:a" }];
function show(list) { console.log(list[0].channel); }
show(ROUTES);
ROUTES.forEach(String);
for (const [i, r] of ROUTES.entries()) console.log(i, r.channel);
for (const r of ROUTES) ipcMain[r.kind](r.channel, () => 1);`),
    );
    expect(values(info)).toContain("route:a");
  });
});

/** RW's review of #198: probes `//!plain` are read only as written (a bundler would rewrite them). */
const RW_STALE: Array<{ id: string; source: string; plainOnly?: true; stale: string }> = [
  {
    id: "F2: a var of a method with a computed key is no local of the outer function",
    plainOnly: true,
    source: `//== main.js
const { ipcMain } = require("electron");
let CH = "c:a";
function setup() {
  CH += "b";
  return { [k]() { var CH = 0; } };
}
ipcMain.on(CH, () => 1);`,
    stale: "c:a",
  },
  {
    id: "F2: nor of a getter with a computed key",
    plainOnly: true,
    source: `//== main.js
const { ipcMain } = require("electron");
let CH = "c:a";
function setup() {
  CH += 1
  return { get [k]() { var CH; return 1 } }
}
ipcMain.on(CH, () => 1);`,
    stale: "c:a",
  },
  {
    id: "F2: nor of a class's static block",
    plainOnly: true,
    source: `//== main.js
const { ipcMain } = require("electron");
let CH = "c:a";
function setup() {
  CH += "b";
  class Q { static { var CH = 0; } }
}
ipcMain.on(CH, () => 1);`,
    stale: "c:a",
  },
  {
    id: "F4: a call with a default-looking argument before a block is no method head",
    plainOnly: true,
    source: `//== main.js
const { ipcMain } = require("electron");
let CH = "c:a";
foo(CH = "c:b")
{ }
ipcMain.on(CH, () => 1);`,
    stale: "c:a",
  },
  {
    id: "F5: Object.assign on the table",
    source: `//== main.js
const { ipcMain } = require("electron");
const T = { A: "c:a" };
Object.assign(T, { A: "c:b" });
ipcMain.on(T.A, () => 1);`,
    stale: "c:a",
  },
  {
    id: "F5: Object.defineProperties on the table",
    source: `//== main.js
const { ipcMain } = require("electron");
const T = { A: "c:a" };
Object.setPrototypeOf(T, null); Object.defineProperties(T, { A: { value: "c:b" } });
ipcMain.on(T.A, () => 1);`,
    stale: "c:a",
  },
  {
    id: "F5: a write through another name for the table",
    source: `//== main.js
const { ipcMain } = require("electron");
const T = { A: "c:a" };
const U = T;
U.A = "c:b";
ipcMain.on(T.A, () => 1);`,
    stale: "c:a",
  },
  {
    id: "F5: a write through another name, read by a loop",
    source: `//== main.js
const { ipcMain } = require("electron");
var T = { A: "t:a", B: "t:b" };
const X3 = T; X3.A = "c:b";
for (const k of Object.keys(T)) ipcMain.handle(T[k], () => 1);`,
    stale: "t:a",
  },
  {
    id: "F5: a statement after a line break that ends a declaration list (return)",
    plainOnly: true,
    source: `//== main.js
const { ipcMain } = require("electron");
let CH = "c:a";
function f() {
  let a = 1
  return g(), CH += "x"
}
ipcMain.on(CH, () => 1);`,
    stale: "c:a",
  },
  {
    id: "F5: a var declared again with a value in a block",
    plainOnly: true,
    source: `//== main.js
const { ipcMain } = require("electron");
var CH = "c:a";
if (x) { var CH = "c:b"; }
ipcMain.on(CH, () => 1);`,
    stale: "c:a",
  },
  {
    id: "F5: a name in parentheses",
    source: `//== main.js
const { ipcMain } = require("electron");
let CH = "c:a";
(CH) += "x";
ipcMain.on(CH, () => 1);`,
    stale: "c:a",
  },
  {
    id: "F5: a table in parentheses",
    source: `//== main.js
const { ipcMain } = require("electron");
const T = { A: "c:a" };
(T).A = "c:b";
ipcMain.on(T.A, () => 1);`,
    stale: "c:a",
  },
  {
    id: "F5: a member in parentheses",
    source: `//== main.js
const { ipcMain } = require("electron");
const T = { A: "c:a" };
(T.A) = "c:b";
ipcMain.on(T.A, () => 1);`,
    stale: "c:a",
  },
  {
    id: "F5: exports.CH written again inside a function",
    source: `//== main.js
const { ipcMain } = require("electron");
const t = require("./t");
ipcMain.on(t.CH, () => 1);
//== t.js
exports.CH = "c:a";
exports.later = function () { exports.CH = "c:b"; };`,
    stale: "c:a",
  },
];

/** Locals of the same name: the top-level constant keeps its value. */
const RW_KEPT: Array<{ id: string; source: string; kept: string }> = [
  {
    id: "a var in an else block or a with block is the function's own",
    kept: "c:a",
    source: `//== main.js
const { ipcMain } = require("electron");
let CH = "c:a";
function setup() {
  CH += 1;
  if (a) b(); else { var CH; }
}
function other() {
  CH += 1;
  with (o) { var CH; }
}
ipcMain.on(CH, () => 1);`,
  },
  {
    id: "a catch binding is the catch block's own",
    kept: "c:a",
    source: `//== main.js
const { ipcMain } = require("electron");
let CH = "c:a";
function f(x) { try { g(); } catch (CH) { CH += 1; } }
ipcMain.on(CH, () => 1);`,
  },
  {
    id: "a line break before `++` ends the statement",
    kept: "c:a",
    source: `//== main.js
const { ipcMain } = require("electron");
let CH = "c:a", y = 1;
CH
++y
ipcMain.on(CH, () => 1);`,
  },
  {
    id: "tsc's hoisted `exports.CH = void 0` declares the export",
    kept: "c:a",
    source: `//== main.js
const { ipcMain } = require("electron");
const t = require("./t");
ipcMain.on(t.CH, () => 1);
//== t.js
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CH = exports.OTHER = void 0;
exports.CH = "c:a";
exports.OTHER = "o";`,
  },
];

describe("writes RW's review of #198 found", () => {
  for (const stale of RW_STALE)
    for (const how of stale.plainOnly ? (["plain"] as Build[]) : BUILDS)
      it(`${stale.id} (${how})`, () => {
        expect(values(analyze(build(sections(stale.source), how)))).not.toContain(stale.stale);
      });
  for (const kept of RW_KEPT)
    it(kept.id, () => {
      expect(values(analyze(sections(kept.source)))).toContain(kept.kept);
    });
});

/**
 * RW's re-review of #206 (probes n…): a table handed on in a container or as a function's
 * result is written there; the loop over the table may not read it as written. The probe's
 * `t:b` comes from the loop alone (`ipcMain.on(T.A)` reads the literal key, a separate rule).
 */
const RW_HANDED: Array<{ id: string; source: string }> = [
  {
    id: `n01: function get() { return T; } const r = get(); r.A = "c:b";`,
    source: `//== main.js
const { ipcMain } = require("electron");
var T = { A: "t:a", B: "t:b" };
function get() { return T; } const r = get(); r.A = "c:b";
for (const k of Object.keys(T)) ipcMain.handle(T[k], () => 1);
ipcMain.on(T.A, () => 1);`,
  },
  {
    id: `n02: function get() { return T; } get().A = "c:b";`,
    source: `//== main.js
const { ipcMain } = require("electron");
var T = { A: "t:a", B: "t:b" };
function get() { return T; } get().A = "c:b";
for (const k of Object.keys(T)) ipcMain.handle(T[k], () => 1);
ipcMain.on(T.A, () => 1);`,
  },
  {
    id: `n04: [T][0].A = "c:b";`,
    source: `//== main.js
const { ipcMain } = require("electron");
var T = { A: "t:a", B: "t:b" };
[T][0].A = "c:b";
for (const k of Object.keys(T)) ipcMain.handle(T[k], () => 1);
ipcMain.on(T.A, () => 1);`,
  },
  {
    id: `n05: const L = [T]; L[0].A = "c:b";`,
    source: `//== main.js
const { ipcMain } = require("electron");
var T = { A: "t:a", B: "t:b" };
const L = [T]; L[0].A = "c:b";
for (const k of Object.keys(T)) ipcMain.handle(T[k], () => 1);
ipcMain.on(T.A, () => 1);`,
  },
  {
    id: `n06: ({T}).T.A = "c:b";`,
    source: `//== main.js
const { ipcMain } = require("electron");
var T = { A: "t:a", B: "t:b" };
({T}).T.A = "c:b";
for (const k of Object.keys(T)) ipcMain.handle(T[k], () => 1);
ipcMain.on(T.A, () => 1);`,
  },
  {
    id: `n07: const W = { T }; W.T.A = "c:b";`,
    source: `//== main.js
const { ipcMain } = require("electron");
var T = { A: "t:a", B: "t:b" };
const W = { T }; W.T.A = "c:b";
for (const k of Object.keys(T)) ipcMain.handle(T[k], () => 1);
ipcMain.on(T.A, () => 1);`,
  },
  {
    id: `n08: const W = { x: T }; W.x.B = "c:b";`,
    source: `//== main.js
const { ipcMain } = require("electron");
var T = { A: "t:a", B: "t:b" };
const W = { x: T }; W.x.B = "c:b";
for (const k of Object.keys(T)) ipcMain.handle(T[k], () => 1);
ipcMain.on(T.A, () => 1);`,
  },
  {
    id: `n21: function get() { return T; } const { A } = get(); Object.assign(get(), { A: "c:b" });`,
    source: `//== main.js
const { ipcMain } = require("electron");
var T = { A: "t:a", B: "t:b" };
function get() { return T; } const { A } = get(); Object.assign(get(), { A: "c:b" });
for (const k of Object.keys(T)) ipcMain.handle(T[k], () => 1);
ipcMain.on(T.A, () => 1);`,
  },
  {
    id: `n22: function get() { return T; } get()["B"] = "c:b";`,
    source: `//== main.js
const { ipcMain } = require("electron");
var T = { A: "t:a", B: "t:b" };
function get() { return T; } get()["B"] = "c:b";
for (const k of Object.keys(T)) ipcMain.handle(T[k], () => 1);
ipcMain.on(T.A, () => 1);`,
  },
  {
    id: `n23: function get() { return T; } const r = get(); r[k] = "c:b";`,
    source: `//== main.js
const { ipcMain } = require("electron");
var T = { A: "t:a", B: "t:b" };
function get() { return T; } const r = get(); r[k] = "c:b";
for (const k of Object.keys(T)) ipcMain.handle(T[k], () => 1);
ipcMain.on(T.A, () => 1);`,
  },
];

describe("a table handed on in a container or as a result (RW's re-review of #206)", () => {
  for (const handed of RW_HANDED)
    for (const how of BUILDS)
      it(`${handed.id} (${how})`, () => {
        expect(values(analyze(build(sections(handed.source), how)))).not.toContain("t:b");
      });
  it("a container or result that only feeds reads keeps the loop readable", () => {
    for (const use of [
      "function get() { return T; } get(); const { A } = get(); const r = get(); console.log(r.A);",
      "const L = [T]; console.log(L[0].A, L.length);",
      "const W = { x: T }; console.log(W.x.B);",
      'const z = structuredClone(T); z.A = "c:b";',
    ]) {
      const info = analyze({
        "main.js": `const { ipcMain } = require("electron");\nvar T = { A: "t:a", B: "t:b" };\n${use}\nfor (const k of Object.keys(T)) ipcMain.handle(T[k], () => 1);\n`,
      });
      expect(values(info), use).toContain("t:b");
    }
  });
});
