import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { analyzeTarget } from "../src/analyzers/dispatch.js";
import { directoryTree, readFileTokens } from "../src/javascript/app.js";
import { scanJavaScript, tokenize } from "../src/javascript/scan.js";
import { PARALLEL_MIN_BYTES, readTokensInParallel } from "../src/javascript/tokenPool.js";
import { loadTarget } from "../src/target.js";

/** Minified-looking application code: short names, nesting, IPC, requests, constants. */
function bundle(seed: number, functions: number): string {
  const out: string[] = [`const CH${seed}={SAVE:"doc:save:${seed}",OPEN:"doc:open:${seed}"};`];
  out.push(`const {ipcMain:m${seed}}=require("electron");`);
  for (let i = 0; i < functions; i++)
    out.push(
      `function f${seed}_${i}(e,t,n){const r=e+t*${i};if(r>=n&&t!==void 0){for(let o=0;o<n;o++)t+=o<<2;` +
        `return fetch("https://api.example.com/v${i % 7}/items",{method:"POST"}).then(e=>e.json())}` +
        `m${seed}.handle(${i % 3 === 0 ? `CH${seed}.SAVE` : `"ch:${seed}:${i}"`},(e,t)=>t??n);` +
        `return localStorage.getItem("k${i % 5}")||'x\\'y'}`,
    );
  return out.join("\n");
}

/** Fastest of five runs of the whole per-file read. */
const best = (source: string): number => {
  let min = Number.POSITIVE_INFINITY;
  for (let r = 0; r < 5; r++) {
    const started = performance.now();
    scanJavaScript(source);
    readFileTokens("main.js", source);
    min = Math.min(min, performance.now() - started);
  }
  return min;
};

describe("JavaScript scan performance", () => {
  const dir = mkdtempSync(join(tmpdir(), "hexvero-perf-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("tokenizes punctuation, strings and identifiers as before", () => {
    const { tokens } = tokenize(
      `a>>>=b; c ??= d?.e; f **= 2; g !== h; ...i; j=>k; 'it\\'s' "a\\"b" \\u0041 ä𝒳1 $_ x.y`,
    );
    expect(tokens.map((t) => t.value)).toEqual([
      "a",
      ">>>",
      "=",
      "b",
      ";",
      "c",
      "??=",
      "d",
      "?.",
      "e",
      ";",
      "f",
      "**=",
      "2",
      ";",
      "g",
      "!==",
      "h",
      ";",
      "...",
      "i",
      ";",
      "j",
      "=>",
      "k",
      ";",
      "it's",
      'a"b',
      "\\",
      "u0041",
      "ä𝒳1",
      "$_",
      "x",
      ".",
      "y",
    ]);
    // an unterminated string ends at the line end and keeps everything up to it
    expect(tokenize('"abc\\n').tokens[0]?.value).toBe("abcn");
    expect(tokenize('"ab\ncd"').tokens[0]?.value).toBe("ab");
  });

  it("grows linearly with the size of a file", () => {
    const small = bundle(1, 2_000);
    const large = bundle(1, 8_000);
    best(small); // warm up the JIT
    const ratio = best(large) / best(small);
    // four times the input; a quadratic step would show as ~16. Generous for busy machines.
    expect(ratio).toBeLessThan(9);
  });

  it("ends a helper's body at its brace however many functions came before", () => {
    // Enough top-level functions that a shared visit budget for finding body ends would run out;
    // past it, a body was taken as the next 4,000 tokens and reached into the code below.
    const filler = Array.from(
      { length: 2_500 },
      (_, i) => `function g${i}(a){${"a=a+1;".repeat(40)}return a}`,
    ).join("\n");
    const source = `${filler}
function late(c){return c}
ipcMain.handle(c, h);
late("ghost:channel");`;
    const channels = scanJavaScript(source).ipc.map((u) => u.channel);
    expect(channels).not.toContain("ghost:channel");
  });

  it("gives the same analysis with and without worker threads", async () => {
    const app = join(dir, "app");
    mkdirSync(join(app, "src"), { recursive: true });
    writeFileSync(join(app, "package.json"), JSON.stringify({ name: "perf", main: "main.js" }));
    let bytes = 0;
    for (let i = 0; i < 8; i++) {
      const source = bundle(i, 2_500);
      bytes += source.length;
      writeFileSync(join(app, i === 0 ? "main.js" : `src/part${i}.js`), source);
    }
    expect(bytes).toBeGreaterThan(PARALLEL_MIN_BYTES);
    // The pool really runs (it needs the built worker, which `tsc -b` emits before the tests).
    const tree = directoryTree(app);
    const files = tree.files.filter((f) => f.path.endsWith(".js"));
    const pooled = await readTokensInParallel(
      files.map((f) => ({
        path: f.path,
        size: f.size,
        read: () => new TextDecoder().decode(tree.read(f.path)),
      })),
      2,
    );
    expect(pooled.size).toBe(files.length);
    for (const f of files)
      expect(pooled.get(f.path)).toEqual(
        readFileTokens(f.path, new TextDecoder().decode(tree.read(f.path))),
      );

    const run = async (threads: string): Promise<unknown> => {
      const saved = process.env["HEXVERO_JS_THREADS"];
      process.env["HEXVERO_JS_THREADS"] = threads;
      process.env["HEXVERO_CACHE_DIR"] = join(dir, `cache-${threads}`);
      try {
        const analysis = await analyzeTarget(await loadTarget(app));
        return { ...analysis, durationMs: 0 };
      } finally {
        if (saved === undefined) delete process.env["HEXVERO_JS_THREADS"];
        else process.env["HEXVERO_JS_THREADS"] = saved;
        delete process.env["HEXVERO_CACHE_DIR"];
      }
    };
    const sequential = await run("0");
    const parallel = await run("3");
    expect(parallel).toEqual(sequential);
    expect(JSON.stringify(sequential)).toContain("doc:save:3");
  });
});
