import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildSync } from "esbuild";
import { afterAll, describe, expect, it } from "vitest";
import { analyzeJavaScriptTree, asarTree, type JsAppInfo } from "../src/javascript/app.js";
import { auditBuild, checkRelease, parsePolicy, POLICY_RULES, Session } from "../src/index.js";
import { buildAsar } from "./fixtures/asar.js";

/**
 * Custom protocols (`protocols`): privileged schemes, protocol handlers and default protocol
 * clients. Expected rows are written from the fixture sources; nothing is run.
 */

const dir = mkdtempSync(join(tmpdir(), "hexvero-protocols-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const analyze = (main: string): JsAppInfo =>
  analyzeJavaScriptTree(
    asarTree(
      buildAsar({
        "package.json": JSON.stringify({ name: "p", main: "main.js" }),
        "main.js": main,
      }),
      "app.asar",
    ),
  );

function bundled(source: string, minify: boolean): string {
  const src = mkdtempSync(join(dir, "src-"));
  mkdirSync(dirname(join(src, "main.js")), { recursive: true });
  writeFileSync(join(src, "main.js"), source);
  const outfile = join(src, "out.js");
  buildSync({
    entryPoints: [join(src, "main.js")],
    bundle: true,
    minify,
    platform: "node",
    format: "cjs",
    external: ["electron"],
    outfile,
    logLevel: "silent",
  });
  return readFileSync(outfile, "utf8");
}

const variants = (source: string): Array<[string, string]> => [
  ["plain", source],
  ["bundled", bundled(source, false)],
  ["minified", bundled(source, true)],
];

/** A protocols row in a few words. */
const protos = (info: JsAppInfo): string[] =>
  info.protocols.map(
    (r) =>
      `${r.kind} ${r.method} ${r.targetKind} ${r.scheme ?? "?"}${
        r.privileges === undefined
          ? ""
          : r.privileges === null
            ? " privileges?"
            : ` {${Object.entries(r.privileges)
                .map(([k, v]) => `${k}=${String(v)}`)
                .join(",")}}`
      }`,
  );

export const PROTOCOLS = `import { app, protocol, session, ipcMain, net } from "electron";
const SCHEMES = [{ scheme: "files", privileges: { standard: true, secure: true } }];
protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, bypassCSP: true, supportFetchAPI: true } },
  { scheme: "media", privileges: { stream: true, corsEnabled: false } },
  { scheme: "plain" },
]);
protocol.registerSchemesAsPrivileged(SCHEMES);
export function setup(list, flag) {
  protocol.registerSchemesAsPrivileged(list);
  protocol.registerSchemesAsPrivileged([{ scheme: "x", privileges: { bypassCSP: flag } }]);
  app.whenReady().then(() => {
    protocol.handle("app", (req) => net.fetch(req.url));
    protocol.registerFileProtocol("files", (req, cb) => cb({ path: req.url.slice(8) }));
    session.fromPartition("p").protocol.handle("media", () => new Response(""));
    ipcMain.handle("app", () => 1);
  });
  app.setAsDefaultProtocolClient("myapp");
}
`;

describe("protocols", () => {
  it("reads privileged schemes, handlers and default protocol clients, plain, bundled and minified", () => {
    for (const [name, source] of variants(PROTOCOLS))
      expect(protos(analyze(source)), name).toEqual([
        "privileged registerSchemesAsPrivileged protocol app {standard=true,secure=true,bypassCSP=true,supportFetchAPI=true}",
        "privileged registerSchemesAsPrivileged protocol media {corsEnabled=false,stream=true}",
        "privileged registerSchemesAsPrivileged protocol plain {}",
        "privileged registerSchemesAsPrivileged protocol files {standard=true,secure=true}",
        "privileged registerSchemesAsPrivileged protocol ? privileges?",
        "privileged registerSchemesAsPrivileged protocol x {bypassCSP=null}",
        "handler handle protocol app",
        "handler registerFileProtocol protocol files",
        "handler handle session media",
        "default-client setAsDefaultProtocolClient app myapp",
      ]);
  });

  it("reads a scheme object bound to a name inside the array", () => {
    const source = `const { protocol } = require("electron");
const clip = { scheme: "clip", privileges: { secure: true, bypassCSP: true } };
protocol.registerSchemesAsPrivileged([clip]);
`;
    for (const [name, code] of variants(source))
      expect(protos(analyze(code)), name).toEqual([
        "privileged registerSchemesAsPrivileged protocol clip {secure=true,bypassCSP=true}",
      ]);
  });

  it("gives look-alikes no row and an unproven receiver of a distinctive method an unknown one", () => {
    const info = analyze(`const fake = { handle() {}, registerFileProtocol() {} };
fake.handle("app");
fake.registerFileProtocol("app");
export function f(p, a) {
  p.handle("x");
  p.registerHttpProtocol("y", () => {});
  a.setAsDefaultProtocolClient("z");
}
`);
    expect(protos(info)).toEqual([
      "handler registerHttpProtocol unknown y",
      "default-client setAsDefaultProtocolClient unknown z",
    ]);
  });
});

let n = 0;
const writeApp = (main: string): string => {
  const path = join(dir, `app-${n++}.asar`);
  writeFileSync(
    path,
    buildAsar({ "package.json": JSON.stringify({ name: "p", main: "main.js" }), "main.js": main }),
  );
  return path;
};
const auditOf = async (path: string) => {
  const session = new Session();
  return auditBuild(session, (await session.open(path)).id);
};
const found = (r: Awaited<ReturnType<typeof auditOf>>) =>
  r.findings
    .filter((f) => f.rule === "custom-protocol")
    .map((f) => `${f.unknown ? "?" : "!"} ${f.key}`);

describe("audit custom-protocol", () => {
  it("reports bypassCSP and privileges it cannot read, nothing for handlers or clients", async () => {
    for (const [name, source] of variants(PROTOCOLS)) {
      const r = await auditOf(writeApp(source));
      expect(found(r), name).toEqual([
        "? privileged scheme (not read)",
        "! privileged scheme app bypassCSP",
        "? privileged scheme x",
      ]);
    }
  });

  it("keeps fingerprints when the code moves", async () => {
    const a = await auditOf(writeApp(PROTOCOLS));
    const b = await auditOf(writeApp(`// moved\n\n${PROTOCOLS}`));
    const fp = (r: typeof a) =>
      r.findings.filter((f) => f.rule === "custom-protocol").map((f) => f.fingerprint);
    expect(fp(b)).toEqual(fp(a));
  });
});

describe("check new-custom-protocol", () => {
  const policy = parsePolicy(
    JSON.stringify({
      hexvero: "policy",
      version: 1,
      rules: Object.fromEntries(
        POLICY_RULES.map((id) => [id, { level: id === "new-custom-protocol" ? "fail" : "off" }]),
      ),
    }),
    "policy.json",
  );
  const check = async (a: string, b: string) => {
    const session = new Session();
    const [x, y] = [await session.open(a), await session.open(b)];
    return checkRelease(session, x.id, y.id, policy);
  };
  const BEFORE = `const { app, protocol } = require("electron");
protocol.registerSchemesAsPrivileged([{ scheme: "app", privileges: { standard: true } }]);
app.setAsDefaultProtocolClient("notes");
`;

  it("reports a new privileged scheme, bypassCSP newly given and a new default client", async () => {
    expect((await check(writeApp(BEFORE), writeApp(BEFORE))).findings).toEqual([]);
    const after = `const { app, protocol } = require("electron");
protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, bypassCSP: true } },
  { scheme: "media", privileges: { stream: true } },
]);
app.setAsDefaultProtocolClient("notes");
app.setAsDefaultProtocolClient("notes-dev");
`;
    const r = await check(writeApp(BEFORE), writeApp(after));
    expect(r.findings.map((f) => `${f.unknown ? "?" : "!"} ${f.key}`).toSorted()).toEqual([
      "! default protocol client notes-dev",
      "! privileged scheme app bypassCSP",
      "! privileged scheme media",
    ]);
    expect(r.status).toBe("fail");
  });
});
