import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { analyzeJavaScriptTree, asarTree, type JsAppInfo } from "../src/javascript/app.js";
import { NOTHING_MISSING, type Limitation } from "../src/model.js";
import {
  FILE_SCOPED_LIMITATIONS,
  Session,
  UNRESOLVED_LIMITATIONS,
  Unresolved,
} from "../src/session.js";
import { buildAsar } from "./fixtures/asar.js";

/**
 * Limitations that say values of a family exist that are not listed leave the other side's
 * one-sided items unknown, not removed, in the files they name (#219). Every code the core can
 * emit is either mapped or exempted here with its reason, so a new one is not forgotten.
 */

const SRC = fileURLToPath(new URL("../src", import.meta.url));

/**
 * Every literal limitation code in the sources: `code: "x"` (or a ternary of them) before
 * `message:`. Its limits: a code built from a template or held in a variable (`code,`, `code:
 * l.code`, the per-code counts of `limitationsUnlisted`, which repeat codes found here) is not
 * found, nor one whose object puts `message` first; such a code must be added here by hand.
 */
function emittedCodes(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith(".ts")) {
        const text = readFileSync(path, "utf8");
        for (const m of text.matchAll(/\bcode:\s*([^,\n]*?)\s*,\s*(?:\/\/[^\n]*\n\s*)*message:/g))
          for (const c of m[1]!.matchAll(/"([a-z0-9_]+)"/g)) {
            const files = out.get(c[1]!) ?? [];
            files.push(path.slice(SRC.length + 1));
            out.set(c[1]!, files);
          }
      }
    }
  };
  walk(SRC);
  return out;
}

/**
 * Codes that are deliberately not in UNRESOLVED_LIMITATIONS, with why. A code here either
 * concerns no collection of an unresolved family (ipc, bridge, window, endpoint, storage), or is
 * covered another way: by the file coverage (`read`/`unreadable`, gaps budget/scan_partial/
 * files_unread), by rows the session reads per file (a channel null, a value computed, a member
 * null), or by nothing being missing when it fires.
 */
const EXEMPT: Readonly<Record<string, string>> = {
  // binary formats, archives and captures: no collection of an unresolved family
  apk_unsigned: "binary",
  arsc_unreadable: "binary",
  cil_bodies_capped: "binary",
  cil_body_truncated: "binary",
  cil_instructions_capped: "binary",
  cil_malformed: "binary",
  cil_rva_unmapped: "binary",
  cil_truncated: "binary",
  cil_unknown_opcode: "binary",
  class_truncated: "binary",
  class_unreadable: "binary",
  classes_truncated: "binary",
  dart_elf_unreadable: "binary",
  dart_no_snapshots: "binary",
  dart_sdk_version_unmapped: "binary",
  dart_snapshot_hash_mismatch: "binary",
  dart_snapshot_header_invalid: "binary",
  dart_symbol_unmapped: "binary",
  dex_classes_limited: "binary",
  dex_classes_truncated: "binary",
  dex_strings_limited: "binary",
  dex_unreadable: "binary",
  dotnet_clr_version: "binary",
  dotnet_no_blob: "binary",
  dotnet_table_too_large: "binary",
  dotnet_tables_truncated: "binary",
  dotnet_uncompressed_tables: "binary",
  dotnet_unknown_table: "binary",
  dotnet_unreadable: "binary",
  entitlements_unreadable: "binary",
  evm_no_dispatch: "binary",
  evm_truncated: "binary",
  executable_missing: "binary",
  executable_too_large: "binary",
  executable_unreadable: "binary",
  exports_truncated: "binary",
  file_truncated: "binary",
  flutter_engine_unreadable: "binary",
  flutter_lib_unreadable: "binary",
  go_modinfo_unframed: "binary",
  go_no_buildinfo: "binary",
  go_pointer_unresolved: "binary",
  har_truncated: "a capture: its requests are not compared by file",
  load_command_invalid: "binary",
  load_commands_truncated: "binary",
  no_gnu_stack: "binary",
  no_resources: "binary",
  no_sections: "binary",
  objc_32bit: "binary",
  objc_binds_unreadable: "binary",
  objc_budget_exhausted: "binary",
  objc_class_unreadable: "binary",
  objc_classes_truncated: "binary",
  objc_fixups_unreadable: "binary",
  objc_method_entsize: "binary",
  objc_methods_truncated: "binary",
  objc_output_truncated: "binary",
  objc_unreadable: "binary",
  sqlite_table_unreadable: "binary",
  symbols_truncated: "binary",
  wasm_section_truncated: "binary",
  wasm_section_unreadable: "binary",
  wasm_version: "binary",
  // call graphs and decompiler runs (providers): not collections of a build
  address_required: "provider",
  callgraph_aliases_missing: "provider",
  callgraph_empty: "provider",
  callgraph_missing: "provider",
  callgraph_tail_calls_unknown: "provider",
  callgraph_truncated: "provider",
  decompiler_missing: "provider",
  engine_exit: "provider",
  function_ambiguous: "provider",
  function_not_found: "provider",
  ghidra_no_output: "provider",
  neighborhood_depth_capped: "provider",
  neighborhood_nodes_capped: "provider",
  neighborhood_traversal_capped: "provider",
  output_truncated: "provider",
  trace_explored_capped: "provider",
  trace_graph_truncated: "provider",
  // the whole target: no analysis to compare, or not one of an application's files
  electron_app_not_read: "the app was not read: there is no app to compare",
  electron_app_pick_unverified: "which app was read, not what it holds",
  electron_runtime_not_read: "the Electron runtime, not the app's collections",
  malformed: "the analysis failed",
  unknown_format: "no analysis of a known format",
  scan_state_not_saved: "a cache that was not written; the analysis is whole",
  package_json_invalid: "the manifest, read whole or not at all; its fields are not a family",
  // files not read, or read in part: the file coverage (read, unreadable, completeness gaps)
  scan_truncated: "coverage: the files not scanned are not in `read`",
  js_files_skipped: "coverage: the skipped files are `unreadable`",
  js_files_truncated: "coverage: the truncated files are `unreadable`",
  directory_truncated: "coverage: the files past the listing are not in `read`",
  symlinks_skipped: "coverage: links outside the directory are no file of the app",
  unresolved_references: "the edges of the module graph, not a family's values",
  bundle_chunk_only: "coverage: the other chunks are files of their own",
  bundle_modules_not_found: "a bundle read as one module; its rows are in that file",
  // rows the session reads per file (Session.coverage): the value itself is in the collection
  ipc_channel_unresolved: "rows with channel null, read per file by Session.coverage",
  webpreferences_computed: "rows with value null, read per file by Session.coverage",
  window_options_unresolved: "windows with settings computed, read per file by Session.coverage",
  bridge_exposures_undecided: "rows with undecided, read per file by Session.coverage",
  // nothing is missing when it fires: the rows stay and are listed as read
  bridge_global_written:
    "the page rows stay; mapping it hid every one-sided IPC change across the app (#219)",
  webpreferences_unattached: "settings no window takes: no window value is missing",
  navigation_handlers_truncated: "navigationHandlers is no unresolved family",
  remote_enabled_truncated: "remoteEnabled is no unresolved family",
  // storage keys: not mapped (yet); the storage family takes only values computed per file and
  // candidates_truncated. These say keys passed through a wrapper are not read at each call.
  storage_wrappers_capped: "storage wrapper calls past the budget: not mapped yet",
  storage_wrappers_skipped: "storage wrappers of a file not followed: not mapped yet",
  wrapper_method_replaced: "replaced storage wrapper methods: not mapped yet",
  wrapper_replacements_unchecked: "unchecked wrapper replacements: not mapped yet",
  client_calls_skipped: "endpoint client calls not read in a file: not mapped yet",
  client_writes_skipped: "endpoint client writes not read in a file: not mapped yet",
};

const dir = mkdtempSync(join(tmpdir(), "hexvero-unresolved-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const unresolvedOf = (limitations: Limitation[]): Map<string, Set<string>> => {
  const u = new Unresolved();
  u.fromLimitations(limitations);
  return u.map as Map<string, Set<string>>;
};

function analyze(files: Record<string, string>): JsAppInfo {
  return analyzeJavaScriptTree(
    asarTree(
      buildAsar({ "package.json": JSON.stringify({ name: "u", main: "main.js" }), ...files }),
      "app.asar",
    ),
  );
}

const of = (info: JsAppInfo, code: string): Limitation[] =>
  info.limitations.filter((l) => l.code === code);

const MAIN = `const { ipcMain } = require("electron");
ipcMain.handle("x", () => 1);
`;
const ONE_PRELOAD = `const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("api", { call: (channel, ...a) => ipcRenderer.invoke(channel, ...a) });
`;
const OTHER_PRELOAD = `const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("api", { call: (channel, ...a) => ipcRenderer.send(channel, ...a) });
`;

/** An ES module app whose preload exposes `{ sub: api, k }` with `api` from `specifier`. */
const moduleApp = (specifier: string): Uint8Array =>
  buildAsar({
    "package.json": JSON.stringify({ name: "u", main: "main.js", type: "module" }),
    "main.js": `import { ipcMain } from "electron";\nipcMain.handle("x", () => 1);\n`,
    "preload.js": `import { contextBridge } from "electron";
import { api } from "${specifier}";
const k = () => 1;
contextBridge.exposeInMainWorld("x", { sub: api, k });
`,
    "api.js": `export const api = { a: () => 1, call: () => 2 };\n`,
  });

/** An app whose v2 makes the page's forwarder ambiguous and drops a main-process handler. */
const ambiguousApp = (v2: boolean): Uint8Array =>
  buildAsar({
    "package.json": JSON.stringify({ name: "u", main: "main.js" }),
    "main.js": v2 ? MAIN : `${MAIN}ipcMain.on("gone", () => 1);\n`,
    "preload.js": ONE_PRELOAD,
    ...(v2 ? { "preload2.js": OTHER_PRELOAD } : {}),
    "renderer.js": `window.api.call("x");\n`,
  });

describe("limitation codes and the unresolved map", () => {
  it("maps or exempts every code the core can emit", () => {
    const codes = emittedCodes();
    // the walk finds the codes it should (a broken pattern would pass on nothing)
    for (const known of ["ipc_wrappers_capped", "bridge_calls_capped", "file_truncated"])
      expect(codes.has(known), known).toBe(true);
    const forgotten = [...codes]
      .filter(([c]) => !(c in UNRESOLVED_LIMITATIONS) && !(c in EXEMPT))
      .map(([c, files]) => `${c} (${[...new Set(files)].join(", ")})`);
    expect(forgotten).toEqual([]);
    // an exemption names a code that exists and is not also mapped
    expect(Object.keys(EXEMPT).filter((c) => !codes.has(c) || c in UNRESOLVED_LIMITATIONS)).toEqual(
      [],
    );
    for (const c of FILE_SCOPED_LIMITATIONS) expect(c in UNRESOLVED_LIMITATIONS, c).toBe(true);
  });

  it("keeps a code without files app-wide, and one that lists only some", () => {
    expect(
      unresolvedOf([
        {
          code: "ipc_wrappers_capped",
          message:
            "2 file(s) that use IPC wrappers of other modules were not read to the end for calls of them (a budget or the file limit of 200): a.js, b.js.",
        },
      ]),
    ).toEqual(new Map([["ipc", new Set(["*"])]]));
    expect(
      unresolvedOf([
        {
          code: "bridge_calls_capped",
          message: "… missing at a.js:1, at b.js:1 … and 3 more.",
        },
      ]),
    ).toEqual(new Map([["ipc", new Set(["a.js", "b.js", "*"])]]));
    // a file-scoped code that names no file applies anywhere, as any other code does
    for (const code of FILE_SCOPED_LIMITATIONS)
      expect(unresolvedOf([{ code, message: "Some values were not read." }]), code).toEqual(
        new Map([[UNRESOLVED_LIMITATIONS[code]!, new Set(["*"])]]),
      );
    // ... and nowhere only when its emitter wrote that nothing is missing
    for (const code of FILE_SCOPED_LIMITATIONS)
      expect(
        unresolvedOf([{ code, message: `Some values were not read. ${NOTHING_MISSING}` }]),
        code,
      ).toEqual(new Map());
    // the sentinel means nothing for a code that is not file-scoped
    expect(
      unresolvedOf([{ code: "ipc_wrappers_capped", message: `x. ${NOTHING_MISSING}` }]),
    ).toEqual(new Map([["ipc", new Set(["*"])]]));
  });

  it("scopes bridge_forwarder_ambiguous to the page scripts that name the api", () => {
    const info = analyze({
      "main.js": MAIN,
      "preload.js": ONE_PRELOAD,
      "preload2.js": OTHER_PRELOAD,
      "renderer.js": `window.api.call("x");\n`,
      "other.js": `console.log("no bridge here");\n`,
    });
    const [l] = of(info, "bridge_forwarder_ambiguous");
    expect(l?.message).toContain("at renderer.js:1.");
    expect(unresolvedOf([l!])).toEqual(new Map([["ipc", new Set(["renderer.js"])]]));
    // no page names it: nothing is missing anywhere
    const unnamed = analyze({
      "main.js": MAIN,
      "preload.js": ONE_PRELOAD,
      "preload2.js": OTHER_PRELOAD,
    });
    const [none] = of(unnamed, "bridge_forwarder_ambiguous");
    expect(none?.message).toContain("No page script read names its api.");
    expect(none?.message.endsWith(NOTHING_MISSING)).toBe(true);
    expect(unresolvedOf([none!])).toEqual(new Map());
  });

  it("scopes bridge_calls_unread to the files not read", () => {
    const info = analyze({
      "main.js": MAIN,
      "preload.js": ONE_PRELOAD,
      "renderer.js": `with (window) { api.call("x"); }\n`,
      "page.js": `window.api.call("x");\n`,
    });
    const [l] = of(info, "bridge_calls_unread");
    expect(l?.message).toContain("(a with statement");
    expect(unresolvedOf([l!])).toEqual(new Map([["ipc", new Set(["renderer.js"])]]));
    // a worker that was not located only: its calls are read as a page's, nothing is missing
    const worker = analyze({
      "main.js": MAIN,
      "preload.js": ONE_PRELOAD,
      "renderer.js": `new Worker("gone.js");\nwindow.api.call("x");\n`,
    });
    const [w] = of(worker, "bridge_calls_unread");
    expect(w?.message).toContain("gone.js (a worker script named in renderer.js");
    expect(w?.message.endsWith(NOTHING_MISSING)).toBe(true);
    expect(unresolvedOf([w!])).toEqual(new Map());
  });

  it("scopes context_bridge_module_unread to the exposing entry and the module", () => {
    const info = analyzeJavaScriptTree(
      asarTree(
        buildAsar({
          "package.json": JSON.stringify({ name: "u", main: "main.js", type: "module" }),
          "main.js": `import { ipcMain } from "electron";\nipcMain.handle("x", () => 1);\n`,
          "preload.js": `import { contextBridge } from "electron";
import { api } from "./api.js";
contextBridge.exposeInMainWorld("api", api);
`,
          "api.js": `export const api = { a: () => 1 };\n`,
          "patch.js": `import { api } from "./api.js";\napi.extra = () => 1;\n`,
        }),
        "app.asar",
      ),
    );
    const [l] = of(info, "context_bridge_module_unread");
    expect(l?.message).toContain("at preload.js:3, at api.js:1.");
    expect(unresolvedOf([l!])).toEqual(new Map([["bridge", new Set(["preload.js", "api.js"])]]));
  });

  it("applies context_bridge_module_unread anywhere when the module was not located or is too deep", async () => {
    // RZ's probe: v2 imports a module that is not there, while api.js still is
    writeFileSync(join(dir, "m1.asar"), moduleApp("./api.js"));
    writeFileSync(join(dir, "m2.asar"), moduleApp("./missing.js"));
    const session = new Session();
    const m1 = (await session.open(join(dir, "m1.asar"))).id;
    const m2 = (await session.open(join(dir, "m2.asar"))).id;
    expect((await session.coverage(m2))?.unresolved.get("bridge")).toEqual(new Set(["*"]));
    const bridge = (await session.compareCollection(m1, m2, "contextBridge")).diff;
    expect(bridge.removed).toEqual([]);
    expect(bridge.unknown.map((u) => u.key).toSorted()).toEqual(
      expect.arrayContaining([
        expect.stringContaining("sub.a"),
        expect.stringContaining("sub.call"),
      ]),
    );
    // more modules deep than are read
    const deep = analyzeJavaScriptTree(
      asarTree(
        buildAsar({
          "package.json": JSON.stringify({ name: "u", main: "main.js", type: "module" }),
          "main.js": `import { ipcMain } from "electron";\nipcMain.handle("x", () => 1);\n`,
          "preload.js": `import { contextBridge } from "electron";\nimport { a } from "./a.js";\ncontextBridge.exposeInMainWorld("api", { a });\n`,
          "a.js": `import { b } from "./b.js";\nexport const a = { b };\n`,
          "b.js": `import { c } from "./c.js";\nexport const b = { c };\n`,
          "c.js": `import { d } from "./d.js";\nexport const c = { d };\n`,
          "d.js": `export const d = { e: () => 1 };\n`,
        }),
        "app.asar",
      ),
    );
    const [l] = of(deep, "context_bridge_module_unread");
    expect(l?.message).toContain("modules deep");
    expect(unresolvedOf([l!])).toEqual(new Map([["bridge", new Set(["*"])]]));
  });

  it("scopes bridge_calls_capped to the page scripts not read", () => {
    // more than 2000 calls in one file: that file is not read to its end
    const calls = Array.from({ length: 2001 }, (_, i) => `window.api.call("c${i}");`).join("\n");
    const info = analyze({
      "main.js": MAIN,
      "preload.js": ONE_PRELOAD,
      "renderer.js": `${calls}\n`,
    });
    const [l] = of(info, "bridge_calls_capped");
    expect(l?.message).toContain("at renderer.js:1.");
    expect(unresolvedOf([l!])).toEqual(new Map([["ipc", new Set(["renderer.js"])]]));
  });

  it("leaves a main-process change removed when only a page's bridge calls were not read", async () => {
    writeFileSync(join(dir, "v1.asar"), ambiguousApp(false));
    writeFileSync(join(dir, "v2.asar"), ambiguousApp(true));
    const session = new Session();
    const v1 = (await session.open(join(dir, "v1.asar"))).id;
    const v2 = (await session.open(join(dir, "v2.asar"))).id;
    const ipc = (await session.compareCollection(v1, v2, "ipc")).diff;
    expect(ipc.removed).toEqual(["main.js::ipcMain.on::gone"]);
    expect(ipc.unknown.map((u) => [u.key, u.file])).toEqual([
      ["renderer.js::ipcRenderer.invoke::x", "renderer.js"],
    ]);
  });
});
