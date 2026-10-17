/**
 * An address another module exports as a template on its own constant
 * (`DIRECTORY_URL: `${API_ROOT}/directory/top``), passed on through a module that spreads it
 * (`module.exports = { ...endpoints }`): holdout3's podcast-player `fetch(DIRECTORY_URL)`.
 * Read only when every name in the template is a constant of that module, declared once and
 * never assigned again; anything else stays an unknown URL.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildSync } from "esbuild";
import { afterAll, describe, expect, it } from "vitest";
import { analyzeJavaScriptTree, asarTree } from "../src/javascript/app.js";
import { buildAsar } from "./fixtures/asar.js";

const dir = mkdtempSync(join(tmpdir(), "hexvero-cross-templates-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const endpoints = (files: Record<string, string>): string[] =>
  analyzeJavaScriptTree(
    asarTree(
      buildAsar({
        "package.json": JSON.stringify({ name: "x", main: "main.js" }),
        ...files,
      }),
      "app.asar",
    ),
  ).endpoints.map((e) => `${e.file} ${e.value ?? `?${e.expression}`} [${e.evidence}]`);

/** The sources bundled by esbuild into main.js, optionally minified. */
function bundled(sources: Record<string, string>, minify: boolean): Record<string, string> {
  const src = mkdtempSync(join(dir, "src-"));
  for (const [name, text] of Object.entries(sources)) {
    mkdirSync(dirname(join(src, name)), { recursive: true });
    writeFileSync(join(src, name), text);
  }
  const outfile = join(src, "out", "main.js");
  buildSync({
    entryPoints: [join(src, "main.js")],
    bundle: true,
    minify,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
  });
  return { "main.js": readFileSync(outfile, "utf8") };
}

const sources = (endpointsJs: string): Record<string, string> => ({
  "main.js": [
    'const { DIRECTORY_URL, ARTWORK } = require("./shared");',
    "async function refresh() {",
    '  const res = await fetch(DIRECTORY_URL, { headers: { accept: "application/json" } });',
    "  return res.json();",
    "}",
    "async function art(id) { return fetch(`${ARTWORK}/${id}.jpg`); }",
    "module.exports = { refresh, art };",
  ].join("\n"),
  "shared/index.js": [
    'const endpoints = require("./endpoints");',
    "const t = (id) => id;",
    "module.exports = { ...endpoints, t };",
  ].join("\n"),
  "shared/endpoints.js": endpointsJs,
});

const GOOD = [
  '"use strict";',
  'const API_ROOT = "https://api.example/v1";',
  "module.exports = {",
  "  API_ROOT,",
  "  DIRECTORY_URL: `${API_ROOT}/directory/top`,",
  '  ARTWORK: "https://img.example",',
  "};",
].join("\n");

describe("templates on another module's constants", () => {
  it("reads the address through the module that spreads it, plain, bundled and minified", () => {
    for (const files of [
      sources(GOOD),
      bundled(sources(GOOD), false),
      bundled(sources(GOOD), true),
    ])
      expect(endpoints(files)).toEqual([
        "main.js https://api.example/v1/directory/top [inferred]",
        "main.js https://img.example/${…}.jpg [template]",
      ]);
  });

  it("keeps the URL unknown when the constant may change or is not one", () => {
    const variants = [
      // assigned again
      GOOD.replace("const API_ROOT", "let API_ROOT").replace(
        "module.exports",
        'if (process.env.STAGING) API_ROOT = "x";\nmodule.exports',
      ),
      GOOD.replace("const API_ROOT", "let API_ROOT").replace(
        "module.exports",
        'API_ROOT += "/staging";\nmodule.exports',
      ),
      // declared twice
      GOOD.replace("const API_ROOT", "var API_ROOT").replace(
        "module.exports",
        'var API_ROOT = "https://other.example";\nmodule.exports',
      ),
      // not a constant at all
      GOOD.replace('"https://api.example/v1"', "process.env.API_ROOT"),
      // another binding of the name around the template
      GOOD.replace(
        "module.exports = {",
        'for (const API_ROOT of ["https://loop.example"]) module.exports = {',
      ),
      GOOD.replace("module.exports = {", "module.exports = ((API_ROOT) => ({").replace(
        "};",
        '}))("https://other.example");',
      ),
      GOOD.replace("module.exports = {", "module.exports = (API_ROOT => ({").replace(
        "};",
        '}))("https://other.example");',
      ),
      // a name that is not this module's
      GOOD.replace("`${API_ROOT}/directory/top`", "`${HOST}/directory/top`"),
      // more than a name in the gap
      GOOD.replace("`${API_ROOT}/directory/top`", "`${API_ROOT.trim()}/directory/top`"),
    ];
    for (const variant of variants)
      for (const files of [sources(variant), bundled(sources(variant), true)]) {
        const rows = endpoints(files);
        expect(rows.some((r) => r.includes("/directory/top"))).toBe(false);
        expect(rows.filter((r) => r.includes("[unknown]"))).toHaveLength(1);
      }
  });
});
