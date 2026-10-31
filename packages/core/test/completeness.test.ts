/**
 * Cases from the independent review of the continued-scan work: places where something
 * incomplete could look complete, or a guess could look like a fact.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  analyzeJavaScriptTree,
  asarTree,
  directoryTree,
  emptyJsScanFacts,
  type FileTree,
} from "../src/javascript/app.js";
import { findCandidates } from "../src/javascript/candidates.js";
import { loadScan, saveScan } from "../src/javascript/scanState.js";
import { scanJavaScript, tokenize } from "../src/javascript/scan.js";
import { normalizeCallGraph } from "../src/providers/graph.js";
import { buildAsar } from "./fixtures/asar.js";
import { Session } from "../src/session.js";
import { timeLimit } from "./timeLimit.js";

const ipc = (source: string): string[] =>
  scanJavaScript(source)
    .ipc.filter((u) => u.channel !== null)
    .map((u) => `${u.api} ${u.channel}`);
const app = (files: Record<string, string>) =>
  asarTree(
    buildAsar({ "package.json": JSON.stringify({ name: "x", main: "main.js" }), ...files }),
    "a.asar",
  );

const jumpSections = (jumps: string[]) => ({
  functions: [
    { name: "sym.a", offset: 0x1000, size: 8 },
    { name: "sym.b", offset: 0x1010, size: 8 },
  ],
  graph: [
    { name: "sym.a", size: 8, imports: [] },
    { name: "sym.b", size: 8, imports: [] },
  ],
  flags: [],
  jumps,
  jumpsEnd: true,
});
describe("a scan that did not read everything says so", () => {
  it("is not complete when a file could not be read", () => {
    const tree = app({ "main.js": 'ipcMain.handle("a", f);', "big.js": "x".repeat(4000) });
    const info = analyzeJavaScriptTree(tree, { maxFileBytes: 1000 });
    expect(info.coverage).toMatchObject({
      total: 2,
      scanned: 2,
      remaining: 0,
      skipped: 1,
      complete: false,
    });
    expect(info.limitations.map((l) => l.code)).toContain("js_files_skipped");
  });

  it("is not complete when the directory walk was cut, and does not spend its limit on node_modules", () => {
    const dir = mkdtempSync(join(tmpdir(), "hexvero-walk-"));
    try {
      mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true });
      mkdirSync(join(dir, "src"));
      for (let i = 0; i < 30; i++)
        writeFileSync(join(dir, "node_modules", "pkg", `f${i}.txt`), "x");
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", main: "src/main.js" }));
      writeFileSync(
        join(dir, "src", "main.js"),
        'require("electron").ipcMain.handle("secret:chan", f);',
      );
      for (let i = 0; i < 10; i++) writeFileSync(join(dir, "src", `m${i}.js`), "1;");
      // dependencies do not count against the limit: the application's own file is found
      const roomy = analyzeJavaScriptTree(directoryTree(dir, { maxFiles: 20 }));
      expect(roomy.ipcChannels.map((c) => c.channel)).toEqual(["secret:chan"]);
      expect(roomy.coverage.complete).toBe(true);
      // a walk that stops early is reported and the result is not complete
      const cut = analyzeJavaScriptTree(directoryTree(dir, { maxFiles: 5 }));
      expect(cut.coverage.complete).toBe(false);
      expect(cut.limitations.map((l) => l.code)).toContain("directory_truncated");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("marks counts of a partial scan as partial", () => {
    const tree = app({
      "main.js": 'ipcMain.handle("a", f); fetch("https://x.example/a");',
      "b.js": 'ipcMain.handle("b", f);',
    });
    const partial = analyzeJavaScriptTree(tree, { maxJsFiles: 1 });
    expect(partial.coverage.complete).toBe(false);
    for (const f of partial.findings.filter((x) =>
      /^(electron\.ipc|js\.endpoints)$/.test(x.kind),
    )) {
      expect(f.title).toMatch(/in the scanned part/);
      expect(f.confidence).toBe("inferred");
    }
    const whole = analyzeJavaScriptTree(tree);
    expect(whole.findings.find((f) => f.kind === "electron.ipc")?.title).toBe("2 IPC channels");
  });

  it("makes progress when one file is larger than the budget of a run", () => {
    const tree = app({ "main.js": "y".repeat(500), "b.js": "1;" });
    let facts = emptyJsScanFacts();
    const first = analyzeJavaScriptTree(tree, {
      maxTotalBytes: 50,
      onFacts: (f) => (facts = structuredClone(f)),
    });
    expect(first.coverage.scanned).toBe(1);
    const second = analyzeJavaScriptTree(tree, { maxTotalBytes: 50, resume: facts });
    expect(second.coverage.scanned).toBe(2);
  });

  it("matches include patterns without backtracking blow-up", () => {
    const path = `${"a".repeat(123)}.js`;
    const tree = app({ "main.js": "1;", [path]: "2;" });
    const started = performance.now();
    const info = analyzeJavaScriptTree(tree, { include: ["*a*a*a*a*a*a*a*a*a*b"] });
    expect(performance.now() - started).toBeLessThan(timeLimit(1000));
    expect(info.coverage.scanned).toBe(0);
    expect(analyzeJavaScriptTree(tree, { include: ["a*a.js"] }).coverage.scanned).toBe(1);
  });

  it("drops stored state that does not hang together", () => {
    const cache = mkdtempSync(join(tmpdir(), "hexvero-state-"));
    const previous = process.env["HEXVERO_CACHE_DIR"];
    process.env["HEXVERO_CACHE_DIR"] = cache;
    try {
      const tree = app({ "main.js": 'ipcMain.handle("a", f);', "b.js": "1;" });
      let facts = emptyJsScanFacts();
      analyzeJavaScriptTree(tree, { onFacts: (f) => (facts = structuredClone(f)) });
      saveScan("k", facts);
      expect(loadScan("k", tree)).not.toBeNull();
      const { endpoints: _dropped, ...withoutField } = facts;
      saveScan("k", withoutField as typeof facts);
      expect(loadScan("k", tree)).toBeNull();
      // files said to be unread while their results are in the state would be read twice
      saveScan("k", { ...facts, scanned: [] });
      expect(loadScan("k", tree)).toBeNull();
    } finally {
      if (previous === undefined) delete process.env["HEXVERO_CACHE_DIR"];
      else process.env["HEXVERO_CACHE_DIR"] = previous;
      rmSync(cache, { recursive: true, force: true });
    }
  });
});

describe("an unwritable cache directory", () => {
  // chmod cannot make a directory read-only on Windows
  it.skipIf(process.platform === "win32")(
    "keeps the analysis and says that its state could not be stored",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "hexvero-ro-"));
      const cache = join(dir, "cache");
      mkdirSync(cache);
      chmodSync(cache, 0o555);
      const previous = process.env["HEXVERO_CACHE_DIR"];
      process.env["HEXVERO_CACHE_DIR"] = cache;
      try {
        const path = join(dir, "app.asar");
        writeFileSync(
          path,
          buildAsar({
            "package.json": JSON.stringify({ name: "x", main: "main.js" }),
            "main.js": 'require("electron").ipcMain.handle("a", f);',
            "b.js": "1;",
          }),
        );
        const session = new Session();
        const target = await session.open(path);
        const analysis = await session.continueAnalysis(target.id, {
          continue: true,
          maxJsFiles: 1,
        });
        expect(analysis.summary).toMatch(/partial: 1 of 2/);
        expect(analysis.limitations.map((l) => l.code)).toContain("scan_state_not_saved");
      } finally {
        chmodSync(cache, 0o755);
        if (previous === undefined) delete process.env["HEXVERO_CACHE_DIR"];
        else process.env["HEXVERO_CACHE_DIR"] = previous;
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

describe("a guess is not reported as a fact", () => {
  it("takes a helper for a channel forwarder only when it passes the parameter on unchanged", () => {
    // Not a forwarder, but every call site of it can be read: the channel is what the code builds.
    expect(
      ipc(
        'function emit(ns, name) { ipcRenderer.send(ns + ":" + name); }\nemit("settings", "changed");',
      ),
    ).toEqual(["ipcRenderer.send settings:changed"]);
    // one call site that cannot be read: only what can be read is reported
    expect(
      ipc(
        'function emit(ns, name) { ipcRenderer.send(ns + ":" + name); }\nemit("a", "b"); emit(x, "c");',
      ),
    ).toEqual(["ipcRenderer.send a:b"]);
    expect(
      ipc('function emit(m) { ipcRenderer.send(m.channel, m.data); }\nemit("hello");'),
    ).toEqual([]);
    expect(ipc('function emit(c) { ipcRenderer.send(c ? "a" : "b"); }\nemit("hello");')).toEqual(
      [],
    );
    expect(ipc('function emit(c, d) { ipcRenderer.send(c, d); }\nemit("ok", 1);')).toEqual([
      "ipcRenderer.send ok",
    ]);
  });

  it("hoists var to its function when deciding what a name means", () => {
    expect(
      ipc(
        'const { ipcMain: n } = require("electron");\nfunction f() { if (1) { var n = other(); } n.on("x", g); }\nn.on("real", g);',
      ),
    ).toEqual(["ipcMain.on real"]);
  });

  it("does not resolve a name that is assigned again", () => {
    expect(ipc('let CH = "a"; CH = "b"; ipcMain.on(CH, f);')).toEqual([]);
    expect(ipc('const T = { A: "a" }; T.A = "z"; ipcMain.on(T.A, f);')).toEqual([]);
    expect(ipc('const T = { A: "a" }; ipcMain.on(T.A, f);')).toEqual(["ipcMain.on a"]);
  });

  it("reads table keys as channels only when the loop variable is the key and is passed as it is", () => {
    // `CH[k]` is the value under the key, read per key: the channel is "doc:save", never "SAVE"
    expect(
      ipc(
        'const CH = { SAVE: "doc:save" };\nfor (const k of Object.keys(CH)) { ipcMain.on(CH[k], f); }',
      ),
    ).toEqual(["ipcMain.on doc:save"]);
    expect(
      ipc(
        'const CH = { SAVE: "doc:save" };\nfor (const k of Object.keys(CH)) { ipcMain.on(CH[k + "x"], f); }',
      ),
    ).toEqual([]);
    // A string method outside the evaluation subset is not read …
    expect(
      ipc(
        'const H = { a: f };\nfor (const [id, fn] of Object.entries(H)) ipcMain.handle(id.normalize("NFC"), fn);',
      ),
    ).toEqual([]);
    // … one inside it is (resolve.ts lists them): the loop registers exactly "A".
    expect(
      ipc(
        "const H = { a: f };\nfor (const [id, fn] of Object.entries(H)) ipcMain.handle(id.toUpperCase(), fn);",
      ),
    ).toEqual(["ipcMain.handle A"]);
    expect(
      ipc(
        "const opts = { a: 1, b: 2 };\nObject.keys(opts).forEach((k) => use(k));\nipcMain.on(k, f);",
      ),
    ).toEqual([]);
    expect(
      ipc(
        'const H = { "x:1": f, "x:2": g };\nfor (const [id, fn] of Object.entries(H)) ipcMain.handle(id, fn);',
      ),
    ).toEqual(["ipcMain.handle x:1", "ipcMain.handle x:2"]);
    expect(ipc('const H = { "y:1": f };\nfor (const id in H) ipcMain.on(id, H[id]);')).toEqual([
      "ipcMain.on y:1",
    ]);
  });

  it("does not take a map or header lookup for a request", () => {
    const source = [
      'cache.get("https://example.com/x");',
      'seen.delete("https://example.org/y");',
      'res.headers.get("https://x.example/z");',
      'https.get("https://updates.example/latest.json", cb);',
      'client.post("https://api.example/items", body);',
    ].join("\n");
    expect(
      findCandidates(tokenize(source).tokens, source).endpoints.map(
        (e) => `${e.method} ${e.value}`,
      ),
    ).toEqual(["GET https://updates.example/latest.json", "POST https://api.example/items"]);
  });

  it("does not let a base object the window overrides decide the app-wide flags", () => {
    const info = analyzeJavaScriptTree(
      app({
        "main.js":
          "const base = { webPreferences: { nodeIntegration: true, contextIsolation: false } };\nnew BrowserWindow({ ...base, webPreferences: { nodeIntegration: false, contextIsolation: true } });\nnew BrowserWindow({ webPreferences: { sandbox: true && flag } });",
      }),
    );
    expect(info.electron).toMatchObject({
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: null,
    });
    expect(info.findings.map((f) => f.kind)).not.toContain("electron.node-integration");
  });

  it("does not read an unparseable jump list as 'no tail calls'", () => {
    const good = normalizeCallGraph(
      "radare2",
      jumpSections(["sym.a+4 0x1004 > CODE:--x > 0x1010 sym.b"]),
    );
    expect(good.edges).toEqual([{ from: "sym.a", to: "sym.b" }]);
    expect(good.limitations.map((l) => l.code)).not.toContain("callgraph_tail_calls_unknown");
    const odd = normalizeCallGraph(
      "radare2",
      jumpSections(["0x1004 -> CODE -> 0x1010 sym.b", "ERROR: something"]),
    );
    expect(odd.limitations.map((l) => l.code)).toContain("callgraph_tail_calls_unknown");
    // no jumps at all is a real answer
    expect(
      normalizeCallGraph("radare2", jumpSections([])).limitations.map((l) => l.code),
    ).not.toContain("callgraph_tail_calls_unknown");
  });
});

describe("hostile input stays fast", () => {
  it(
    "bounds the reading of short-named enums and of bindings by scope",
    { timeout: 30_000 },
    () => {
      for (const hostile of [
        // many enums under one short name in one block, and in many blocks (aliases.ts settleScoped)
        `function m(){${'var a;(function(e){e.X="x"})(a||(a={}));'.repeat(20_000)}${"ipcMain.on(a.X,f);".repeat(20_000)}}`,
        `${'{var a;(function(e){e.X="x"})(a||(a={}));ipcMain.on(a.X,f)}'.repeat(30_000)}`,
        // a name written in thousands of nested functions, asked for at every one (resolve.ts
        // binding): took more than two minutes before the scans were cached
        `class C{handle(c,f){ipcMain.handle(c,f)}}function g(){${'function h(){x=1;x.handle("a",f)}'.repeat(20_000)}}`,
        // block-scoped declarations of one name in thousands of blocks, and one block of thousands
        `class C{handle(c,f){ipcMain.handle(c,f)}}function m(){${'if(x){const r=new C;r.handle("a",f)}'.repeat(20_000)}r.handle("b",f)}`,
        `class C{handle(c,f){ipcMain.handle(c,f)}}function m(){if(x){${"var r=1;".repeat(20_000)}}${'r.handle("b",f);'.repeat(2000)}}`,
      ]) {
        const started = performance.now();
        analyzeJavaScriptTree(app({ "main.js": hostile }) as FileTree);
        // about 0.3 s each here; unbounded, the last one takes minutes
        expect(performance.now() - started).toBeLessThan(timeLimit(5_000));
      }
    },
  );

  it(
    "bounds the reading of lazy getters (`X().app`, `new (X().BrowserWindow)(…)`)",
    { timeout: 30_000 },
    () => {
      const statements = "a=a+1;".repeat(2000);
      const huge = `(${"x,".repeat(1500)}x)`;
      for (const hostile of [
        // a large function called as a getter at thousands of places: its body is not walked
        // past the few statements a getter has
        `function big(){${statements}return require("electron")}${'big().app.on("certificate-error",h);big().shell.openExternal(u);new (big().BrowserWindow)(o);'.repeat(5000)}`,
        // a getter whose statements are one long comma sequence each
        `function seq(){var d=${huge};seq=function(){return d};return d}${"seq().app.commandLine.appendSwitch(s);".repeat(5000)}`,
        // getters that return each other, and themselves
        `function f(){return g()}function g(){return f()}function s(){return s()}${'f().app.on("certificate-error",h);s().shell.openExternal(u);'.repeat(5000)}`,
      ]) {
        const started = performance.now();
        const info = analyzeJavaScriptTree(app({ "main.js": hostile }) as FileTree);
        expect(performance.now() - started).toBeLessThan(5_000);
        // none of these getters is read as electron's
        expect(info.switches.filter((r) => r.targetKind === "app")).toEqual([]);
      }
    },
  );

  it(
    "tells a write from a local's quickly in deeply nested functions (#198)",
    { timeout: 60_000 },
    () => {
      // 63 nested functions with 125 parameters each and 80,000 writes in the innermost: every
      // write asked each function around it for its parameters, 12 s before they were kept
      const params = Array.from({ length: 125 }, (_, i) => `p${i}`).join(",");
      const hostile = `const { ipcMain } = require("electron");\nlet CH = "c:x";\n${`function q(${params}){`.repeat(63)}${"CH += 1;".repeat(80_000)}${"}".repeat(63)}\nipcMain.on(CH, f);\n`;
      const started = performance.now();
      const info = analyzeJavaScriptTree(app({ "main.js": hostile }) as FileTree);
      expect(performance.now() - started).toBeLessThan(timeLimit(5_000));
      expect(info.modules.flatMap((m) => m.ipc.map((u) => u.channel))).toEqual([null]);
    },
  );

  it("bounds the listener, helper and window scans", { timeout: 90_000 }, () => {
    for (const hostile of [
      // twice the size at which each of these took 3 to 14 seconds before it was bounded
      'ipcMain.on("a",(e)=>{'.repeat(120_000),
      "const a=x=>(".repeat(120_000),
      "new BrowserWindow({".repeat(120_000),
      `new BrowserWindow({webPreferences:{${Array.from({ length: 4000 }, (_, i) => `...h${i}()`).join(",")}}});${"filler(1);".repeat(240_000)}`,
      // IPC wrapper classes (wrappers.ts): many same-named functions with a receiver parameter,
      // a property key defined over and over, a chain of methods that return this
      `class C{handle(c,f){ipcMain.handle(c,f);return this}}${'function g(r){r.handle("x",f)}g(new C);'.repeat(30_000)}`,
      `class C{handle(c,f){ipcMain.handle(c,f)}}${'a.k=new C;a.k.handle("x",f);'.repeat(60_000)}`,
      `class C{handle(c,f){ipcMain.handle(c,f);return this}}new C()${'.handle("a",f)'.repeat(60_000)};`,
      // window options read through class fields, names bound by scope and Object.assign
      `class W{p={sandbox:!0};${"m(){return new BrowserWindow({webPreferences:this.p})}".repeat(3000)}}`,
      `const K={sandbox:!0};${"function a(){let e=Object.assign({},K,{x:1});return new BrowserWindow({webPreferences:e})}".repeat(3000)}${"function b(e){e.k=1}".repeat(20_000)}`,
      `const K={sandbox:!0};const p=Object.assign({},${"K,".repeat(60_000)}{});new BrowserWindow({webPreferences:p});`,
      // navigation handlers (navigationHandlers): unclosed web-contents-created callbacks and
      // window-open handlers, and one handler with thousands of returns
      'app.on("web-contents-created",(e,c)=>{c.setWindowOpenHandler(()=>{'.repeat(60_000),
      `w.webContents.setWindowOpenHandler(()=>{${"if(x)return(a,b,{action:'deny'});".repeat(60_000)}});`,
      // contextBridge exposures: an exposed object of many members over many declarations
      `const{ipcRenderer:r}=require("electron");${"var a=r,b=r;".repeat(20_000)}contextBridge.exposeInMainWorld("x",{${"m:r,".repeat(20_000)}});`,
    ]) {
      const started = performance.now();
      analyzeJavaScriptTree(app({ "main.js": hostile }) as FileTree);
      // generous, because CI machines are slow and busy; unbounded, these take minutes
      expect(performance.now() - started).toBeLessThan(timeLimit(15_000));
    }
  });
});

describe("caps that keep a count instead of dropping silently", () => {
  it("keeps one limitation of every code when one code fills the per-file list", () => {
    const files: Record<string, string> = { "main.js": "" };
    // 201 files with a webPreferences object no window takes: one more than the list keeps
    for (let i = 0; i < 201; i++)
      files[`w/f${String(i).padStart(3, "0")}.js`] =
        "new BrowserWindow({});\nconst table = { webPreferences: { sandbox: true } };\n";
    // read last (deepest path): a file whose IPC wrapper's replacements cannot all be checked
    files["z/z/z/late.js"] =
      'const { ipcMain } = require("electron");\nclass Ipc { set(k, v) { this[k] = v; } handle(ch, fn) { ipcMain.handle(ch, fn); } }\nconst w = new Ipc();\nw.set("title", "x");\nw.handle("kept:h", () => 1);\nmodule.exports = { w };\n';
    const info = analyzeJavaScriptTree(app(files));
    const codes = info.limitations.map((l) => l.code);
    expect(codes).toContain("wrapper_replacements_unchecked");
    const unattached = info.limitations.filter((l) => l.code === "webpreferences_unattached");
    // 200 listed one by one (the list is full), the 201st counted in one entry
    expect(unattached.length).toBe(201);
    expect(unattached.at(-1)!.message).toMatch(/^1 more file has this limitation/);
  });

  it("counts every file read in part, also past the 200 it names, and says some are not named", () => {
    const files: Record<string, string> = { "main.js": "" };
    for (let i = 0; i < 202; i++)
      files[`p/f${String(i).padStart(3, "0")}.js`] = `const a${i} = [${"1,".repeat(20)}];\n`;
    const info = analyzeJavaScriptTree(app(files), { budgets: { fileTokens: 10 } });
    expect(info.coverage.partial).toBe(202);
    expect(info.coverage.partialFiles.length).toBe(200);
    expect(info.coverage.filesUnlisted).toBe(true);
    const named = analyzeJavaScriptTree(
      app({ "main.js": "", "a.js": "const a = [1,2,3,4,5,6];" }),
      {
        budgets: { fileTokens: 10 },
      },
    );
    expect(named.coverage).toMatchObject({
      partial: 1,
      partialFiles: ["a.js"],
      filesUnlisted: false,
    });
  });
});
