#!/usr/bin/env node
/**
 * Builds the corpus inputs from their sources with pinned toolchains.
 *
 *   node corpus/build.mjs            rebuild what this machine can build
 *   node corpus/build.mjs --check    fail if a rebuilt input differs from the committed one
 *
 * JavaScript inputs are built by esbuild and packed by @electron/asar, both pinned to exact
 * versions in package.json; they rebuild byte for byte on any OS. Native inputs are built by the
 * system C compiler, only with --native and only when the binary does not exist yet: two builds
 * of the same source differ in a few bytes, and another compiler version may emit other code.
 * The committed binaries are what the expectations were written against.
 * Every built input is listed with its SHA-256 in corpus/built/SHA256SUMS.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPackageWithOptions } from "@electron/asar";
import { build } from "esbuild";

const root = dirname(fileURLToPath(import.meta.url));
const built = join(root, "built");
const check = process.argv.includes("--check");
const native = process.argv.includes("--native");
const out = check ? mkdtempSync(join(tmpdir(), "hexvero-corpus-")) : built;
const EPOCH = new Date("2026-01-01T00:00:00Z");

const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true })
    .toSorted((a, b) => (a.name < b.name ? -1 : 1))
    .flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));

/** Packs a directory. Times are fixed first, so the archive depends on the content alone. */
async function pack(dir, target) {
  for (const file of walk(dir)) utimesSync(file, EPOCH, EPOCH);
  mkdirSync(dirname(target), { recursive: true });
  rmSync(target, { force: true });
  await createPackageWithOptions(dir, target, { ordering: undefined });
}

/** Applies listed edits to a copy of a source tree; every edit must match exactly once. */
function derive(changesFile, stage) {
  const changes = JSON.parse(readFileSync(changesFile, "utf8"));
  cpSync(resolve(dirname(changesFile), changes.from), stage, { recursive: true });
  for (const edit of changes.edits) {
    const file = join(stage, edit.file);
    const text = readFileSync(file, "utf8");
    if (text.split(edit.find).length !== 2)
      throw new Error(
        `${changesFile}: edit does not match exactly once in ${edit.file}: ${edit.find}`,
      );
    writeFileSync(file, text.replace(edit.find, edit.replace));
  }
  if (changes.prependCommentLines)
    for (const file of walk(stage).filter((f) => f.endsWith(".js")))
      writeFileSync(
        file,
        `${Array.from({ length: changes.prependCommentLines }, (_, i) => `// moved down, line ${i + 1}\n`).join("")}${readFileSync(file, "utf8")}`,
      );
}

/** Bundles the three entry points the way an Electron build would. */
async function bundle(src, stage, minify) {
  mkdirSync(stage, { recursive: true });
  const common = { bundle: true, minify, logLevel: "silent", legalComments: "none" };
  for (const entry of ["main.js", "preload.js"])
    if (existsSync(join(src, entry)))
      await build({
        ...common,
        entryPoints: [join(src, entry)],
        outfile: join(stage, entry),
        platform: "node",
        format: "cjs",
        external: ["electron", "electron-store"],
      });
  for (const entry of readdirSync(src).filter((f) => /^renderer.*\.js$/.test(f)))
    await build({
      ...common,
      entryPoints: [join(src, entry)],
      outfile: join(stage, entry),
      platform: "browser",
      format: "esm",
    });
  for (const file of ["package.json", "index.html"])
    if (existsSync(join(src, file))) cpSync(join(src, file), join(stage, file));
}

const temp = mkdtempSync(join(tmpdir(), "hexvero-corpus-stage-"));
try {
  for (const set of ["dev", "validation", "holdout", "holdout2"]) {
    const setDir = join(root, set);
    if (!existsSync(setDir)) continue;
    for (const name of readdirSync(setDir).toSorted()) {
      const dir = join(setDir, name);
      if (!statSync(dir).isDirectory()) continue;
      // An Electron application: packed as written, bundled, and bundled and minified.
      if (existsSync(join(dir, "src", "package.json"))) {
        const src = join(dir, "src");
        const plain = join(temp, set, name, "plain");
        cpSync(src, plain, { recursive: true });
        await pack(plain, join(out, set, `${name}.plain.asar`));
        for (const [variant, minify] of [
          ["bundled", false],
          ["minified", true],
        ]) {
          const stage = join(temp, set, name, variant);
          await bundle(src, stage, minify);
          await pack(stage, join(out, set, `${name}.${variant}.asar`));
        }
      }
      // A later version derived from another case by listed edits.
      if (existsSync(join(dir, "changes.json"))) {
        const stage = join(temp, set, name, "derived");
        derive(join(dir, "changes.json"), stage);
        await pack(stage, join(out, set, `${name}.plain.asar`));
      }
      // C programs, only on request: -O0 keeps every call, -O2 turns returns of calls into jumps.
      if (native)
        for (const file of readdirSync(dir).filter(
          (f) => f.endsWith(".c") || f.endsWith(".c.patch.json"),
        )) {
          let source = join(dir, file);
          let base = file.replace(/\.c$/, "");
          if (file.endsWith(".patch.json")) {
            const patch = JSON.parse(readFileSync(source, "utf8"));
            let text = readFileSync(join(dir, patch.from), "utf8");
            for (const edit of patch.edits) {
              if (text.split(edit.find).length !== 2)
                throw new Error(`${file}: edit does not match once: ${edit.find}`);
              text = text.replace(edit.find, edit.replace);
            }
            base = file.replace(/\.c\.patch\.json$/, "");
            source = join(temp, `${base}.c`);
            writeFileSync(source, text);
          }
          mkdirSync(join(out, set), { recursive: true });
          for (const level of ["O0", "O2"]) {
            const binary = join(out, set, `${base}.${level}.macho-arm64`);
            // Two builds of the same source differ in a few bytes (the linker's identifiers), and
            // the expectations were checked against the committed file. An existing binary is
            // therefore never replaced; delete it by hand to rebuild it.
            if (!existsSync(binary)) execFileSync("cc", [`-${level}`, "-o", binary, source]);
          }
        }
    }
  }

  // Damaged inputs, cut from the built ones at fixed places.
  const damaged = join(out, "damaged");
  mkdirSync(damaged, { recursive: true });
  const asar = readFileSync(join(out, "dev", "notes-app.plain.asar"));
  const headerEnd = 16 + asar.readUInt32LE(12);
  writeFileSync(join(damaged, "empty.asar"), new Uint8Array());
  // The directory is intact, the file contents stop halfway.
  writeFileSync(
    join(damaged, "contents-cut.asar"),
    asar.subarray(0, headerEnd + Math.floor((asar.length - headerEnd) / 2)),
  );
  // The directory itself stops halfway.
  writeFileSync(join(damaged, "header-cut.asar"), asar.subarray(0, Math.floor(headerEnd / 2)));
  // The header announces a directory far longer than the file.
  const lying = Buffer.from(asar);
  lying.writeUInt32LE(0x7fffffff, 12);
  writeFileSync(join(damaged, "header-length-lies.asar"), lying);
  const machoPath = join(built, "dev", "calls.O2.macho-arm64");
  if (existsSync(machoPath)) {
    const macho = readFileSync(machoPath);
    // Stops inside the load commands.
    writeFileSync(join(damaged, "load-commands-cut.macho-arm64"), macho.subarray(0, 600));
    // Headers intact, sections and symbol table missing.
    writeFileSync(
      join(damaged, "body-cut.macho-arm64"),
      macho.subarray(0, Math.floor(macho.length / 3)),
    );
  }

  const sums = walk(out)
    .filter((f) => !f.endsWith("SHA256SUMS"))
    .map(
      (f) =>
        `${createHash("sha256").update(readFileSync(f)).digest("hex")}  ${relative(out, f).replaceAll("\\", "/")}`,
    )
    .join("\n");
  if (check) {
    const committed = readFileSync(join(built, "SHA256SUMS"), "utf8").trim().split("\n");
    const rebuilt = new Set(sums.split("\n"));
    // Native inputs are not rebuilt in a check; everything else must match.
    const wrong = committed.filter((line) => !/macho-arm64$/.test(line) && !rebuilt.has(line));
    if (wrong.length) {
      console.error(
        `corpus: ${wrong.length} committed input(s) do not rebuild to the same bytes:\n${wrong.join("\n")}`,
      );
      process.exit(1);
    }
    console.log(`corpus: ${committed.length} inputs, all rebuildable ones match`);
  } else {
    writeFileSync(join(built, "SHA256SUMS"), `${sums}\n`);
    console.log(
      `corpus: wrote ${sums.split("\n").length} inputs to ${relative(process.cwd(), built)}`,
    );
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
  if (check) rmSync(out, { recursive: true, force: true });
}
