#!/usr/bin/env node
/**
 * Deterministic adversarial-input harness for the public CLI paths.
 *
 *   npm run build && node scripts/fuzz.mjs [--seed n] [--cases n] [--dir path] [--budget ms]
 *                                          [--jobs n] [--keep]
 *
 * From a seeded PRNG it derives hostile inputs: the example ASARs with a mutated header (huge,
 * negative or non-numeric sizes and offsets, deep nesting, `..`, absolute, backslash and control
 * character names, unpacked entries, links, wrong node types), byte-flipped and truncated
 * archives, JavaScript with pathological tokens, odd package.json files, app folders with
 * symlinks that lead out, and policy and baseline files that are huge, deeply nested or carry
 * prototype keys. Every input goes through the built CLI in a fresh process (analyze, analyze
 * --json, compare --report .md and .html, check --format sarif and markdown, export, recover).
 * Nothing from an input is ever executed: the CLI reads it, the harness reads the CLI's output.
 *
 * A case fails when a command does not finish within the budget, exits with anything but 0-4
 * (70 is an uncaught exception, a signal is a crash or the heap cap), reports a JavaScript
 * runtime error instead of a typed one, writes a file it was not asked to write, prints a
 * control character to the terminal, or writes a report whose format the input escaped (raw
 * markup in HTML or Markdown, a SARIF uri outside hexvero-build/, invalid JSON). The same seed
 * gives the same inputs; failures are listed with the seed and case number to rerun them.
 */
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  lstatSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const bin = join(root, "packages", "cli", "bin", "hexvero.js");
const examples = join(root, "examples");

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const SEED = Number(flag("seed", "1"));
const CASES = Number(flag("cases", "120"));
const BUDGET = Number(flag("budget", "10000"));
const JOBS = Number(flag("jobs", "4"));
const KEEP = argv.includes("--keep");
const DIR = resolve(flag("dir", join(tmpdir(), `hexvero-fuzz-${SEED}`)));

/** mulberry32: small, fast and the same everywhere. */
function prng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (n) => Math.floor(next() * n),
    pick: (list) => list[Math.floor(next() * list.length)],
    chance: (p) => next() < p,
  };
}

// ---------------------------------------------------------------- ASAR read and write

function readAsar(path) {
  const bytes = readFileSync(path);
  const jsonLength = bytes.readUInt32LE(12);
  const headerSize = bytes.readUInt32LE(4);
  const header = JSON.parse(bytes.toString("utf8", 16, 16 + jsonLength));
  return { header, data: bytes.subarray(8 + headerSize) };
}

/** Writes an ASAR from header JSON text (already serialized, so duplicate keys survive). */
function writeAsar(headerText, data) {
  const json = Buffer.from(headerText, "utf8");
  const padded = Math.ceil(json.length / 4) * 4;
  const prefix = Buffer.alloc(16);
  prefix.writeUInt32LE(4, 0);
  prefix.writeUInt32LE(8 + padded, 4);
  prefix.writeUInt32LE(4 + padded, 8);
  prefix.writeUInt32LE(json.length, 12);
  return Buffer.concat([prefix, json, Buffer.alloc(padded - json.length), data]);
}

const leaves = (node, prefix = "") =>
  Object.entries(node.files ?? {}).flatMap(([name, child]) =>
    child && typeof child === "object" && child.files
      ? leaves(child, `${prefix}${name}/`)
      : [[`${prefix}${name}`, child, node, name]],
  );

// ---------------------------------------------------------------- hostile vocabulary

const CANARY_HTML = "<x-canary onload=alert(1)>";
const CANARY_MD = "[x-canary](http://x-canary.invalid)";
const FORGED = "FORGED-LINE";
const NAMES = [
  "..",
  "../../escape.js",
  "/abs/escape.js",
  "C:\\win\\escape.js",
  "a\\..\\..\\b.js",
  "\u202egnp.js",
  `${CANARY_HTML}.js`,
  `${CANARY_MD}.js`,
  "`tick``s`|pipe*.js",
  "nul\u0000byte.js",
  "\u001b[31mred\u001b]0;title\u0007.js",
  "\u009bcsi.js",
  "line\nbreak.js",
  "__proto__",
  "constructor",
  "prototype",
  "hasOwnProperty",
  "",
  " ",
  "x".repeat(5000),
  "日本語.js",
  "\ud800lone.js",
  "con.js",
  "%2e%2e%2fenc.js",
  `crlf\r\n${FORGED}.js`,
  "zero\u200bwidth\u2066iso\u061c.js",
];
const SIZES = [-1, 0, 1.5, 2 ** 31, 2 ** 32 + 1, 2 ** 53, 1e308, "12", null, true, {}, [], "-5"];
const OFFSETS = ["-1", "1e30", "abc", "999999999", 123, null, "0x10", "", "9007199254740993", {}];

function hostileJs(rng) {
  const parts = [];
  const n = 1 + rng.int(4);
  for (let i = 0; i < n; i++)
    parts.push(
      rng.pick([
        () => `const s = "unterminated ${"a".repeat(rng.int(2000))}`,
        () => "const t = `open ${ `nested ${ `deeper",
        () => `const r = /[unterminated${"\\".repeat(rng.int(3))}`,
        () => `/* unterminated comment ${"*".repeat(rng.int(50))}`,
        () => "(".repeat(1000 + rng.int(60000)),
        () => "[{".repeat(1000 + rng.int(30000)),
        () => `x = ${"a+".repeat(200000 + rng.int(800000))}a;`,
        () => `\u0000\u0000const z = "\u0000";\u0000`,
        () => "${".repeat(5000) + "}".repeat(rng.int(5000)),
        () => `require("${CANARY_HTML}"); require("${CANARY_MD}");`,
        () => `const { ipcRenderer } = require("electron");
ipcRenderer.invoke("\u001b]0;evil\u0007chan", 1);
ipcRenderer.send("${CANARY_HTML}");
ipcRenderer.send(\`tmpl-\${x}\`);`,
        () => `fetch("https://evil.example/${CANARY_MD}"); fetch("https://\u202eevil.example/");
const u = "https://x-canary.invalid/\`\`\`|*_<>";`,
        () => `const { BrowserWindow } = require("electron");
new BrowserWindow({ webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false, ["__proto__"]: { a: 1 }, "${CANARY_HTML}": 1 } });`,
        () =>
          `module.exports = { ${Array.from({ length: 2000 }, (_, k) => `k${k}: require("m${k}")`).join(", ")} };`,
        () => `"use strict"; \ud800\udfff \ufeff const é = '\u2028\u2029';`,
        () =>
          `import x from "${"../".repeat(50)}etc/passwd"; export * from "data:text/javascript,alert(1)";`,
        () =>
          `//# sourceMappingURL=data:application/json;base64,${Buffer.from('{"version":3,"sources":["../../../escape.js","/abs.js"],"sourcesContent":["a","b"],"mappings":"AAAA"}').toString("base64")}`,
        () => `"\\u{110000}" + '\\x' + "\\u12" + \`\\u{\` `,
        () => "#!/usr/bin/env node\n<!-- html comment\n--> also\n",
        // line forging and hidden characters in every kind of target text the CLI prints
        () => `class S { save(k, v) { localStorage.setItem(k, v); } run() { this.save("k\\u200b\\u009b31m\\r\\n${FORGED}::write · literal", 1); this.save("t\\tx\\u202e\\u2066y\\ufeff", 2); } }
new S().run();
const { ipcMain } = require("electron");
ipcMain.handle("c\\n${FORGED} ipc\\u061c", () => 1);
fetch("https://a.example/\\r\\n${FORGED}");`,
      ])(),
    );
  return Buffer.from(parts.join(rng.chance(0.5) ? "\n" : ""), "utf8");
}

function hostilePackageJson(rng) {
  return Buffer.from(
    rng.pick([
      () =>
        JSON.stringify({
          name: "n",
          main: rng.pick([
            "../../outside.js",
            "/etc/passwd",
            "C:\\x.js",
            "main.js\u202e",
            "\u0000",
            "",
          ]),
        }),
      () => JSON.stringify({ name: CANARY_HTML, version: CANARY_MD, main: "main.js" }),
      () => JSON.stringify({ name: "n", main: rng.pick([{}, [], 123, null, true]) }),
      () => `{"name":"n","main":"main.js","deep":${"[".repeat(100000)}${"]".repeat(100000)}}`,
      () => `{"name":"n","main":"main.js","x":${'{"a":'.repeat(50000)}1${"}".repeat(50000)}}`,
      () =>
        '{"__proto__":{"main":"evil.js","polluted":true},"constructor":{"prototype":{"x":1}},"main":"main.js"}',
      () => '{"name":"a","name":"b","main":"main.js","main":"other.js"}',
      () => `\ufeff${JSON.stringify({ name: "bom", main: "main.js" })}`,
      () => "{ not json",
      () => "",
      () =>
        JSON.stringify({
          name: "n",
          main: "main.js",
          dependencies: Object.fromEntries(Array.from({ length: 20000 }, (_, i) => [`d${i}`, "*"])),
        }),
      () => JSON.stringify({ name: "x".repeat(2_000_000), main: "main.js" }),
    ])(),
    "utf8",
  );
}

// ---------------------------------------------------------------- input generators

const base = {
  a: join(examples, "notesdesk-1.4.0.asar"),
  b: join(examples, "notesdesk-1.5.0.asar"),
};

/** One mutation of a parsed header tree; returns a description. */
function mutateTree(rng, header, data, extra) {
  const files = leaves(header);
  const [path, leaf, parent, name] = rng.pick(files);
  switch (rng.int(12)) {
    case 0:
      leaf.size = rng.pick(SIZES);
      return `size ${path}`;
    case 1:
      leaf.offset = rng.pick(OFFSETS);
      return `offset ${path}`;
    case 2: {
      const n = rng.pick(NAMES);
      parent.files[n] = { ...leaf };
      return `name ${JSON.stringify(n).slice(0, 40)}`;
    }
    case 3: {
      // written as text: JSON.stringify cannot nest this deep
      const depth = rng.pick([65, 200, 2000, 20000]);
      const marker = `@@deep${extra.deep.length}@@`;
      extra.deep.push([
        marker,
        `${'{"files":{"d":'.repeat(depth)}${JSON.stringify(leaf)}${"}}".repeat(depth)}`,
      ]);
      parent.files[`deep${depth}`] = marker;
      return `nesting ${depth}`;
    }
    case 4:
      leaf.unpacked = true;
      return `unpacked ${path}`;
    case 5:
      parent.files[name] = {
        link: rng.pick(["../../../etc/passwd", "/etc/passwd", "main.js", ""]),
      };
      return `link ${path}`;
    case 6:
      parent.files[name] = rng.pick([
        null,
        "str",
        42,
        [],
        { files: null },
        { files: "x" },
        { files: [1, 2] },
      ]);
      return `node type ${path}`;
    case 7:
      header.files = rng.pick([null, "x", [], 1]);
      return "root files type";
    case 8: {
      const count = rng.pick([1000, 20000, 100000]);
      for (let i = 0; i < count; i++)
        header.files[`f${i}.js`] = { size: leaf.size, offset: leaf.offset };
      return `${count} entries`;
    }
    case 9: {
      // replace package.json or main.js content
      const which = rng.chance(0.5) ? "package.json" : "main.js";
      const body = which === "package.json" ? hostilePackageJson(rng) : hostileJs(rng);
      header.files[which] = { size: body.length, offset: String(data.length + extra.length()) };
      extra.push(body);
      return `content ${which} (${body.length} bytes)`;
    }
    case 10:
      leaf.integrity = rng.pick([
        null,
        "x",
        { algorithm: "SHA256", hash: CANARY_HTML },
        { hash: 1 },
      ]);
      return `integrity ${path}`;
    default:
      leaf.executable = rng.pick([true, "yes", null]);
      return `executable ${path}`;
  }
}

function asarCase(rng) {
  const { header, data } = readAsar(rng.chance(0.5) ? base.a : base.b);
  const chunks = [];
  let added = 0;
  const extra = {
    push: (b) => (chunks.push(b), (added += b.length)),
    length: () => added,
    deep: [],
  };
  const notes = [];
  const n = 1 + rng.int(3);
  for (let i = 0; i < n; i++) {
    try {
      notes.push(mutateTree(rng, header, data, extra));
    } catch {
      notes.push("mutation skipped");
    }
  }
  let text = JSON.stringify(header);
  for (const [marker, deep] of extra.deep) text = text.replace(`"${marker}"`, () => deep);
  if (rng.chance(0.15)) {
    // duplicate keys survive only in text
    text = text.replace('"main.js":', '"main.js":{"size":1,"offset":"0"},"main.js":');
    notes.push("duplicate key");
  }
  return {
    kind: "asar",
    note: notes.join("; "),
    name: "app.asar",
    bytes: writeAsar(text, Buffer.concat([data, ...chunks])),
  };
}

function bytesCase(rng) {
  const bytes = Buffer.from(readFileSync(rng.chance(0.5) ? base.a : base.b));
  const how = rng.int(4);
  if (how === 0) {
    const cut = rng.int(bytes.length);
    return {
      kind: "asar",
      note: `truncated at ${cut}`,
      name: "app.asar",
      bytes: bytes.subarray(0, cut),
    };
  }
  if (how === 1) {
    const field = rng.pick([4, 8, 12]);
    bytes.writeUInt32LE(rng.pick([0, 1, 0xffffffff, 0x7fffffff, 300, 100000000]), field);
    return { kind: "asar", note: `pickle field @${field}`, name: "app.asar", bytes };
  }
  const flips = 1 + rng.int(40);
  const headerOnly = how === 2;
  for (let i = 0; i < flips; i++) {
    const at = headerOnly ? 16 + rng.int(300) : rng.int(bytes.length);
    bytes[at] = rng.int(256);
  }
  return {
    kind: "asar",
    note: `${flips} byte flips${headerOnly ? " in header" : ""}`,
    name: "app.asar",
    bytes,
  };
}

function jsCase(rng) {
  const bytes = hostileJs(rng);
  return {
    kind: "js",
    note: `js ${bytes.length} bytes`,
    name: rng.pick(["bundle.js", "x.mjs", "app.cjs"]),
    bytes,
  };
}

function dirCase(rng) {
  return {
    kind: "dir",
    note: "app folder with links out",
    name: "app",
    tree: {
      "package.json": rng.chance(0.5)
        ? hostilePackageJson(rng)
        : Buffer.from('{"name":"d","main":"main.js"}'),
      "main.js": hostileJs(rng),
      [rng.pick(["n.js", `${CANARY_HTML}.js`, "\u001b[2Jclear.js"])]:
        Buffer.from("require('./main.js')"),
    },
    links: { "outside.js": "/etc/passwd", up: "../..", loop: "loop" },
  };
}

const CASE_KINDS = [asarCase, asarCase, asarCase, bytesCase, jsCase, jsCase, dirCase];

// ---------------------------------------------------------------- running

function run(args, cwd) {
  return new Promise((done) => {
    const started = Date.now();
    const child = spawn(process.execPath, ["--max-old-space-size=1024", bin, ...args], {
      cwd,
      env: { ...process.env, HEXVERO_CACHE_DIR: join(DIR, "cache"), NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out = [];
    const err = [];
    let outBytes = 0;
    child.stdout.on("data", (d) => {
      outBytes += d.length;
      if (outBytes < 64 << 20) out.push(d);
    });
    child.stderr.on("data", (d) => err.push(d));
    const timer = setTimeout(() => child.kill("SIGKILL"), BUDGET);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      done({
        code,
        signal,
        ms: Date.now() - started,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        timedOut: Date.now() - started >= BUDGET,
      });
    });
  });
}

const RUNTIME_ERROR =
  /Cannot read propert|Cannot convert|is not a function|is not iterable|is not defined|Maximum call stack|Invalid (array|string|typed array) length|out of memory|Array buffer allocation|RangeError|TypeError|ReferenceError|SyntaxError: (?!.*JSON)/;
const TERMINAL_CONTROL =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/;
/** A line of output that starts with text a target tried to put on a line of its own. */
const FORGED_LINE = new RegExp(`^[\\s+~?-]*${FORGED}`, "m");

function checkRun(label, r, failures) {
  if (r.timedOut) failures.push(`${label}: timeout after ${BUDGET} ms`);
  else if (r.signal) failures.push(`${label}: killed by ${r.signal}`);
  else if (![0, 1, 2, 3, 4].includes(r.code))
    failures.push(`${label}: exit ${r.code}: ${r.stderr.slice(0, 300)}`);
  if (RUNTIME_ERROR.test(r.stderr))
    failures.push(`${label}: runtime error: ${r.stderr.slice(0, 300)}`);
  if (TERMINAL_CONTROL.test(r.stdout) || TERMINAL_CONTROL.test(r.stderr))
    failures.push(
      `${label}: control or hidden character on the terminal: ${around(r.stdout + r.stderr, TERMINAL_CONTROL)}`,
    );
  if (FORGED_LINE.test(r.stdout) || FORGED_LINE.test(r.stderr))
    failures.push(
      `${label}: target text forged a line: ${around(r.stdout + r.stderr, FORGED_LINE)}`,
    );
}

// eslint-disable-next-line no-control-regex
const FILE_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
// eslint-disable-next-line no-control-regex
const URI_CONTROL = /[\u0000-\u001f\\]/;
/** The text around the first match, for the failure message. */
const around = (text, pattern) => {
  const at = text.search(pattern);
  return JSON.stringify(text.slice(Math.max(0, at - 30), at + 30));
};

/** Markdown outside code spans must not carry raw markup taken from the input. */
function markdownEscapes(text) {
  for (const line of text.split("\n")) {
    let rest = "";
    for (let i = 0; i < line.length;) {
      if (line[i] === "`") {
        let n = 0;
        while (line[i + n] === "`") n++;
        const fence = "`".repeat(n);
        let j = line.indexOf(fence, i + n);
        while (j >= 0 && line[j + n] === "`") j = line.indexOf(fence, j + n + 1);
        if (j < 0) {
          rest += line.slice(i);
          break;
        }
        i = j + n;
      } else rest += line[i++];
    }
    if (/(?<!\\)<x-canary/.test(rest) || /(?<!\\)\]\(http:\/\/x-canary/.test(rest))
      return line.slice(0, 200);
  }
  return null;
}

function checkOutputs(dir, outputs, failures) {
  for (const [file, format] of Object.entries(outputs)) {
    const path = join(dir, file);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf8");
    if (format !== "json" && FILE_CONTROL.test(text))
      failures.push(`${file}: raw control character ${around(text, FILE_CONTROL)}`);
    if (/root:\*?:0:0:/.test(text)) failures.push(`${file}: content of /etc/passwd`);
    if (format === "html" && /<x-canary/i.test(text))
      failures.push(`${file}: unescaped markup from the input`);
    if (format !== "json" && format !== "sarif" && FORGED_LINE.test(text))
      failures.push(`${file}: target text forged a line: ${around(text, FORGED_LINE)}`);
    if (format === "md") {
      const bad = markdownEscapes(text);
      if (bad) failures.push(`${file}: Markdown from the input: ${JSON.stringify(bad)}`);
    }
    if (format === "json" || format === "sarif") {
      let doc;
      try {
        doc = JSON.parse(text);
      } catch (error) {
        failures.push(`${file}: not JSON (${error.message})`);
        continue;
      }
      if (format === "sarif") {
        const uris = [];
        JSON.stringify(doc, (k, v) => (k === "uri" && typeof v === "string" && uris.push(v), v));
        for (const uri of uris) {
          if (uri === "file:///") continue;
          const resolved = new URL(uri, "file:///repo/").href;
          if (!resolved.startsWith("file:///repo/hexvero-build/") || URI_CONTROL.test(uri))
            failures.push(
              `${file}: uri escapes hexvero-build/: ${JSON.stringify(uri).slice(0, 120)}`,
            );
        }
      }
    }
  }
}

function listTree(dir, prefix = "") {
  const out = [];
  for (const name of readdirSync(dir)) {
    const rel = prefix ? `${prefix}/${name}` : name;
    out.push(rel);
    const st = lstatSync(join(dir, name));
    if (st.isDirectory() && !st.isSymbolicLink()) out.push(...listTree(join(dir, name), rel));
  }
  return out;
}

async function runCase(index) {
  const rng = prng((SEED * 0x9e3779b1 + index) >>> 0);
  const input = rng.pick(CASE_KINDS)(rng);
  const dir = join(DIR, `case-${index}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const target = join(dir, input.name);
  if (input.tree) {
    mkdirSync(target);
    for (const [name, bytes] of Object.entries(input.tree))
      writeFileSync(join(target, name), bytes);
    for (const [name, to] of Object.entries(input.links)) symlinkSync(to, join(target, name));
  } else writeFileSync(target, input.bytes);
  if (input.kind === "asar") {
    // where Electron keeps unpacked files: links that lead out must not be followed
    mkdirSync(`${target}.unpacked/lib`, { recursive: true });
    symlinkSync("/etc/passwd", `${target}.unpacked/main.js`);
    symlinkSync("../../../../../../../../etc/passwd", `${target}.unpacked/preload.js`);
    symlinkSync("/etc", `${target}.unpacked/lib/store.js`);
  }
  mkdirSync(join(dir, "out"));
  const before = new Set(listTree(dir));
  const failures = [];
  const outputs = {
    "out/r.md": "md",
    "out/r.html": "html",
    "out/c.sarif": "sarif",
    "out/c.md": "md",
    "out/e.json": "json",
  };
  const policy = join(examples, "policy.json");
  const commands = [
    ["analyze", target],
    ["analyze", target, "--json"],
    ["compare", base.a, target, "--report", "out/r.md"],
    ["compare", target, base.b, "--report", "out/r.html"],
    ["check", base.a, target, "--policy", policy, "--format", "sarif", "--out", "out/c.sarif"],
    ["check", target, base.b, "--policy", policy, "--format", "markdown", "--out", "out/c.md"],
    ["check", base.a, target, "--policy", policy],
    ["export", target, "out/e.json"],
  ];
  if (input.kind === "js") commands.push(["recover", target, "out/rec"]);
  let ms = 0;
  for (const args of commands) {
    const r = await run(args, dir);
    ms = Math.max(ms, r.ms);
    checkRun(`${args[0]} ${args.slice(-2).join(" ")}`, r, failures);
    if (/root:\*?:0:0:/.test(r.stdout)) failures.push(`${args[0]}: printed /etc/passwd`);
    if (args[0] === "analyze" && args.includes("--json") && r.code === 0) {
      try {
        JSON.parse(r.stdout);
      } catch (error) {
        failures.push(`analyze --json: stdout is not JSON (${error.message})`);
      }
    }
  }
  checkOutputs(dir, outputs, failures);
  const allowed = (p) =>
    before.has(p) || p in outputs || p === "out/rec" || p.startsWith("out/rec/");
  for (const p of listTree(dir))
    if (!allowed(p)) failures.push(`unexpected file written: ${JSON.stringify(p)}`);
  if (!KEEP && !failures.length) rmSync(dir, { recursive: true, force: true });
  return { index, kind: input.kind, note: input.note, failures, ms };
}

// ---------------------------------------------------------------- policy and baseline lane

const deep = (d) => `${"[".repeat(d)}${"]".repeat(d)}`;
const deepObj = (d) => `${'{"a":'.repeat(d)}1${"}".repeat(d)}`;

function policyCases() {
  const ok = JSON.parse(readFileSync(join(examples, "policy.json"), "utf8"));
  const baselineOk = {
    hexvero: "baseline",
    version: 1,
    created: "x",
    policy: "p",
    a: "a",
    b: "b",
    fingerprints: [],
  };
  const fp = { rule: "new-external-host", fingerprint: "0".repeat(32), key: "k" };
  return [
    ["policy deep array value", "policy", `{"hexvero":${deep(200000)},"version":1,"rules":{}}`],
    [
      "policy deep object value",
      "policy",
      `{"hexvero":"policy","version":${deepObj(100000)},"rules":{}}`,
    ],
    [
      "policy deep rule config",
      "policy",
      `{"hexvero":"policy","version":1,"rules":{"new-external-host":{"level":${deep(100000)}}}}`,
    ],
    [
      "policy deep suppression",
      "policy",
      `{"hexvero":"policy","version":1,"rules":{},"suppressions":[{"rule":${deep(100000)},"fingerprint":"x","reason":"r"}]}`,
    ],
    [
      "policy deep allow entry",
      "policy",
      `{"hexvero":"policy","version":1,"rules":{"new-external-host":{"level":"fail","allow":[${deep(100000)}]}}}`,
    ],
    [
      "policy __proto__ keys",
      "policy",
      JSON.stringify(ok).replace(
        '"rules":{',
        '"__proto__":{"unknown":"allow"},"rules":{"__proto__":{"level":"off"},"constructor":{"level":"off"},',
      ),
    ],
    [
      "policy prototype rule names",
      "policy",
      '{"hexvero":"policy","version":1,"rules":{"toString":{"level":"off"},"hasOwnProperty":{"level":"off"}}}',
    ],
    ["policy over 1 MiB", "policy", JSON.stringify({ ...ok, $schema: "x".repeat(1 << 20) })],
    [
      "policy many unknown keys",
      "policy",
      JSON.stringify(Object.fromEntries(Array.from({ length: 60000 }, (_, i) => [`k${i}`, 1]))),
    ],
    [
      "policy control characters in keys",
      "policy",
      JSON.stringify({ ...ok, "\u001b[2J\u001b]0;x\u0007": 1, rules: { "\u001b[31m": {} } }),
    ],
    ["policy not an object", "policy", deep(300000)],
    ["baseline deep value", "baseline", `{"hexvero":${deep(200000)},"version":1}`],
    [
      "baseline deep fingerprint",
      "baseline",
      JSON.stringify(baselineOk).replace('"fingerprints":[]', `"fingerprints":[${deep(200000)}]`),
    ],
    [
      "baseline __proto__",
      "baseline",
      JSON.stringify(baselineOk).replace(
        '"version":1',
        '"version":1,"__proto__":{"fingerprints":[1]}',
      ),
    ],
    [
      "baseline 40 MiB",
      "baseline",
      JSON.stringify({ ...baselineOk, fingerprints: Array.from({ length: 280000 }, () => fp) }),
    ],
    [
      "baseline 300k bad rows",
      "baseline",
      JSON.stringify({ ...baselineOk, fingerprints: Array.from({ length: 300000 }, () => 1) }),
    ],
  ];
}

async function runPolicyCase([name, which, text], index) {
  const dir = join(DIR, `policy-${index}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "input.json"), text);
  const args = [
    "check",
    base.a,
    base.b,
    "--policy",
    which === "policy" ? join(dir, "input.json") : join(examples, "policy.json"),
  ];
  if (which === "baseline") args.push("--baseline", join(dir, "input.json"));
  const failures = [];
  for (const extra of [[], ["--format", "sarif"]]) {
    const r = await run([...args, ...extra], dir);
    checkRun(`check ${extra.join(" ") || "text"}`, r, failures);
    if (r.code === 0 && which === "policy" && name !== "policy __proto__ keys")
      failures.push(`accepted: exit 0`);
  }
  if (!KEEP && !failures.length) rmSync(dir, { recursive: true, force: true });
  return { index: `p${index}`, kind: which, note: name, failures, ms: 0 };
}

// ---------------------------------------------------------------- output path lane

async function outputPathCases() {
  const dir = join(DIR, "paths");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "real"), { recursive: true });
  symlinkSync(join(dir, "real"), join(dir, "linked"));
  writeFileSync(join(dir, "real", "keep.md"), "keep");
  symlinkSync(join(dir, "real", "keep.md"), join(dir, "link-to-keep.md"));
  symlinkSync(join(dir, "real", "missing.md"), join(dir, "dangling.md"));
  const results = [];
  const expect = async (note, args, check) => {
    const r = await run(args, dir);
    const failures = [];
    checkRun(args[0], r, failures);
    const problem = check(r);
    if (problem) failures.push(problem);
    results.push({ index: `o${results.length}`, kind: "output", note, failures, ms: r.ms });
  };
  const keep = () => readFileSync(join(dir, "real", "keep.md"), "utf8") === "keep";
  const cmp = ["compare", base.a, base.b, "--report"];
  await expect("report into symlinked dir", [...cmp, "linked/r.md"], (r) =>
    r.code === 0 && existsSync(join(dir, "real", "r.md")) ? null : `exit ${r.code}`,
  );
  await expect("report over an existing file", [...cmp, "real/keep.md"], (r) =>
    r.code === 2 && keep() ? null : `exit ${r.code}, kept ${keep()}`,
  );
  await expect("report through a symlink to an existing file", [...cmp, "link-to-keep.md"], (r) =>
    r.code === 2 && keep() ? null : `exit ${r.code}, kept ${keep()}`,
  );
  await expect("report through a dangling symlink", [...cmp, "dangling.md"], (r) =>
    r.code !== 0 && !existsSync(join(dir, "real", "missing.md"))
      ? null
      : `exit ${r.code}, created the link target`,
  );
  await expect("report with .. in the name", [...cmp, "real/../dotdot.md"], (r) =>
    r.code === 0 && existsSync(join(dir, "dotdot.md")) ? null : `exit ${r.code}`,
  );
  await expect("report into a missing dir", [...cmp, "nope/r.md"], (r) =>
    r.code === 1 ? null : `exit ${r.code}`,
  );
  await expect("report onto a directory", [...cmp, "real"], (r) =>
    r.code !== 0 ? null : `exit ${r.code}`,
  );
  await expect(
    "check --out over an existing file",
    [
      "check",
      base.a,
      base.b,
      "--policy",
      join(examples, "policy.json"),
      "--format",
      "sarif",
      "--out",
      "real/keep.md",
    ],
    (r) => (r.code === 2 && keep() ? null : `exit ${r.code}, kept ${keep()}`),
  );
  await expect("report with control characters in the name", [...cmp, "\u001b[31mred.md"], (r) =>
    r.code === 0 ? null : `exit ${r.code}`,
  );
  return results;
}

// ---------------------------------------------------------------- main

async function main() {
  if (!existsSync(bin) || !existsSync(join(root, "packages", "cli", "dist", "index.js"))) {
    console.error("build first: npm run build");
    process.exit(2);
  }
  mkdirSync(DIR, { recursive: true });
  const started = Date.now();
  const results = [];
  let next = 0;
  const worker = async () => {
    while (next < CASES) {
      const i = next++;
      const r = await runCase(i);
      results.push(r);
      if (r.failures.length)
        console.log(`FAIL case ${i} (${r.kind}: ${r.note})\n  ${r.failures.join("\n  ")}`);
    }
  };
  await Promise.all(Array.from({ length: JOBS }, worker));
  const policies = policyCases();
  for (let i = 0; i < policies.length; i++) {
    const r = await runPolicyCase(policies[i], i);
    results.push(r);
    if (r.failures.length)
      console.log(`FAIL policy ${i} (${r.note})\n  ${r.failures.join("\n  ")}`);
  }
  for (const r of await outputPathCases()) {
    results.push(r);
    if (r.failures.length) console.log(`FAIL output (${r.note})\n  ${r.failures.join("\n  ")}`);
  }
  const failed = results.filter((r) => r.failures.length);
  const slowest = Math.max(...results.map((r) => r.ms));
  console.log(
    `seed ${SEED}: ${results.length} cases (${CASES} inputs, ${policies.length} policy/baseline, ${results.length - CASES - policies.length} output paths), ${failed.length} failed, slowest command ${slowest} ms, ${Math.round((Date.now() - started) / 1000)} s; inputs in ${DIR}`,
  );
  process.exit(failed.length ? 1 : 0);
}

await main();
