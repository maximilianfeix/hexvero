#!/usr/bin/env node
/**
 * Checks the expectations of the time-tracker cases against what the built program does.
 *
 *   node corpus/build.mjs --native && node corpus/holdout/verify.mjs
 *
 * No analysis tool is involved. The bundled and the minified entry files are RUN in Node
 * against small stand-ins for Electron and for the browser (verify/observe-*.{cjs,mjs}); the
 * stand-ins write down every channel that is registered or sent on, the options every window
 * is created with, every exposed API member and the channels it touches, every request and
 * every storage access. What they saw must be exactly what expected.json lists. The plain
 * input cannot be run that way (main.js is written with import statements and __dirname), so
 * for it the script checks the text: the plain sources bundle to the same bytes as the built
 * bundles, and the commented-out look-alikes are in comments only. For the v2 case the script
 * bundles the derived sources itself, observes them the same way and compares the two runs.
 *
 * The native case is checked by hand with nm and otool -tV; see README.md.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { extractAll } from "@electron/asar";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const built = join(here, "..", "built", "holdout");
const expected = JSON.parse(
  readFileSync(join(here, "time-tracker", "expected.json"), "utf8"),
).expect;
const compare = JSON.parse(readFileSync(join(here, "time-tracker-v2", "expected.json"), "utf8"))
  .expect.compare;
const temp = mkdtempSync(join(tmpdir(), "holdout-verify-"));
const problems = [];
const check = (ok, message) => ok || problems.push(message);
const same = (a, b) => JSON.stringify([...a].toSorted()) === JSON.stringify([...b].toSorted());
const SETTINGS = ["preload", "contextIsolation", "nodeIntegration", "sandbox"];

const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });

function run(script, args, env = {}) {
  const out = execFileSync("node", [join(here, "verify", script), ...args], {
    env: { ...process.env, NODE_ENV: "", ...env },
    encoding: "utf8",
  });
  return JSON.parse(out);
}

/** Everything the four entry files of one bundle do. */
function observe(dir, env) {
  const main = run("observe-main.cjs", [join(dir, "main.js")], env);
  const preload = run("observe-preload.cjs", [join(dir, "preload.js")]);
  const page = run("observe-renderer.mjs", [join(dir, "renderer.js"), ""]);
  const widget = run("observe-renderer.mjs", [join(dir, "renderer-widget.js"), "#widget"]);
  // The other script of each page must stay silent.
  for (const [file, hash] of [
    ["renderer.js", "#widget"],
    ["renderer-widget.js", ""],
  ]) {
    const idle = run("observe-renderer.mjs", [join(dir, file), hash]);
    check(idle.requests.length + idle.storage.length === 0, `${file} acts with hash "${hash}"`);
  }

  const channels = new Map();
  const role = (channel, kind, file) => {
    if (!channels.has(channel)) channels.set(channel, { receivers: new Set(), senders: new Set() });
    channels.get(channel)[kind].add(file);
  };
  const removedOnly = new Set(main.ipc.filter(([m]) => m === "removeHandler").map(([, c]) => c));
  for (const [method, channel] of main.ipc)
    if (method !== "removeHandler") role(channel, "receivers", "main.js");
  for (const [, channel] of main.sends) role(channel, "senders", "main.js");
  const bridge = new Map();
  const preloadCall = ([method, channel]) => {
    if (["invoke", "send", "sendSync", "postMessage"].includes(method))
      role(channel, "senders", "preload.js");
    else if (!["off", "removeListener"].includes(method)) role(channel, "receivers", "preload.js");
  };
  preload.outside.forEach(preloadCall);
  for (const [api, members] of Object.entries(preload.apis))
    for (const [member, calls] of Object.entries(members)) {
      calls.forEach(preloadCall);
      bridge.set(`${api}.${member}`, [...new Set(calls.map(([, channel]) => channel))]);
    }
  for (const channel of channels.keys()) removedOnly.delete(channel);

  const windows = new Map();
  for (const { hash, webPreferences } of main.windows) {
    const name = hash === "" ? "main" : hash.replace(/\/.*/, "");
    const prefs = Object.fromEntries(
      SETTINGS.filter((key) => key in webPreferences).map((key) => [
        key,
        key === "preload" ? basename(webPreferences[key]) : webPreferences[key],
      ]),
    );
    windows.set(name, prefs);
  }

  const storage = new Set([
    ...[...page.storage, ...widget.storage].map((entry) => entry.join("|")),
    ...main.store.filter(([op]) => op !== "file").map(([op, key]) => `electron-store|${key}|${op}`),
  ]);
  return {
    channels,
    removedOnly,
    bridge,
    windows,
    storage,
    requests: [...main.requests, ...page.requests, ...widget.requests],
    external: main.external,
    storeFiles: main.store.filter(([op]) => op === "file").map(([, name]) => name),
    windowMessages: preload.windowMessages,
    broadcast: [...page.broadcast, ...widget.broadcast],
  };
}

/** The expected address an observed request belongs to: an exact value, or the longest prefix. */
function matchEndpoint(list, [, url, method]) {
  const fits = (entry) => !entry.method || entry.method === method;
  return (
    list.find((entry) => entry.value === url && fits(entry)) ??
    list
      .filter((entry) => entry.prefix && url.startsWith(entry.prefix) && fits(entry))
      .toSorted((a, b) => b.prefix.length - a.prefix.length)[0]
  );
}

function checkAgainstExpected(label, seen) {
  const say = (ok, message) => check(ok, `${label}: ${message}`);

  // IPC: the observed channels are exactly the expected ones, with the same roles. The one
  // listener whose name is made at run time shows up under the name it got in this run.
  const runtime = [...seen.channels.keys()].filter((name) => /^project:\d+:touch$/.test(name));
  say(runtime.length === 1, `run-time channel names: ${runtime}`);
  const names = [...seen.channels.keys()].filter((name) => !runtime.includes(name));
  const want = expected.ipcChannels.present;
  say(
    same(
      names,
      want.map((entry) => entry.channel),
    ),
    `channels differ: ${names.toSorted()}`,
  );
  for (const entry of want) {
    const got = seen.channels.get(entry.channel);
    if (!got) continue;
    say(same(got.receivers, entry.receivers), `${entry.channel} receivers: ${[...got.receivers]}`);
    say(same(got.senders, entry.senders), `${entry.channel} senders: ${[...got.senders]}`);
  }
  for (const { channel } of expected.ipcChannels.absent)
    say(!seen.channels.has(channel), `absent channel ${channel} was used`);
  say(same(seen.removedOnly, ["legacy:export"]), `removeHandler only: ${[...seen.removedOnly]}`);

  // Windows: three, each created with the expected values. The invoice window's sandbox is
  // the one value that is not expected, because it follows NODE_ENV.
  say(
    same(seen.windows.keys(), ["main", "widget", "invoice"]),
    `windows: ${[...seen.windows.keys()]}`,
  );
  const fixed = [...seen.windows].flatMap(([name, prefs]) =>
    Object.entries(prefs)
      .filter(([key]) => !(name === "invoice" && key === "sandbox"))
      .map(([key, value]) => `${key}=${value}`),
  );
  say(
    same(
      fixed,
      expected.webPreferences.present.map((entry) => `${entry.key}=${entry.value}`),
    ),
    `window settings differ: ${fixed.toSorted()}`,
  );
  for (const entry of expected.webPreferences.absent) {
    const count = fixed.filter((item) => item === `${entry.key}=${entry.value}`).length;
    say(count < (entry.count ?? 1), `${entry.key}=${entry.value} occurs ${count} times`);
  }

  // Bridge: the same members, each touching exactly its channel.
  const members = expected.contextBridge.present;
  say(
    same(
      seen.bridge.keys(),
      members.map((entry) => `${entry.api}.${entry.member}`),
    ),
    `bridge members differ: ${[...seen.bridge.keys()].toSorted()}`,
  );
  for (const entry of members) {
    const got = seen.bridge.get(`${entry.api}.${entry.member}`) ?? [];
    say(same(got, entry.channel === null ? [] : [entry.channel]), `${entry.member} -> ${got}`);
  }

  // Requests: every observed request belongs to one expected address, every expected address
  // was requested, and exactly `unreadable` requests went to an address only known at run time.
  const list = expected.endpoints.present;
  const used = new Set();
  let unknown = 0;
  for (const request of seen.requests) {
    const entry = matchEndpoint(list, request);
    if (entry) used.add(entry);
    else if (request[1].startsWith("https://runtime.example/")) unknown += 1;
    else say(false, `unexpected request ${request}`);
  }
  for (const entry of list) say(used.has(entry), `never requested: ${entry.value ?? entry.prefix}`);
  say(unknown === expected.endpoints.unreadable, `${unknown} requests to run-time addresses`);
  for (const { value } of expected.endpoints.absent)
    say(!seen.requests.some(([, url]) => url === value), `absent address ${value} was requested`);
  say(
    same(seen.external, ["https://runtime.example/link", "https://punchclock.example/pricing"]),
    `shell.openExternal: ${seen.external}`,
  );

  // Storage: the same kinds, keys and operations.
  const wantStorage = expected.storage.present.flatMap((entry) =>
    (entry.ops ?? ["open"]).map((op) => `${entry.kind}|${entry.value}|${op}`),
  );
  say(same(seen.storage, wantStorage), `storage differs: ${[...seen.storage].toSorted()}`);
  say(same(seen.storeFiles, ["punchclock", "license"]), `store files: ${seen.storeFiles}`);
  say(same(seen.windowMessages, ["timer-port"]), `window messages: ${seen.windowMessages}`);
  say(same(seen.broadcast, ["ghost:widget-sync"]), `BroadcastChannel: ${seen.broadcast}`);
}

/** Bundles a source tree exactly as corpus/build.mjs does. */
async function bundle(src, out, minify) {
  const common = { bundle: true, minify, logLevel: "silent", legalComments: "none" };
  for (const entry of ["main.js", "preload.js"])
    await build({
      ...common,
      entryPoints: [join(src, entry)],
      outfile: join(out, entry),
      platform: "node",
      format: "cjs",
      external: ["electron", "electron-store"],
    });
  for (const entry of readdirSync(src).filter((f) => /^renderer.*\.js$/.test(f)))
    await build({
      ...common,
      entryPoints: [join(src, entry)],
      outfile: join(out, entry),
      platform: "browser",
      format: "esm",
    });
}

/** The same file without the comments esbuild writes to name each source file. */
const code = (file) =>
  readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => !/^\s*(\/\/ |")\S*(src|holdout-verify-\w+)\/\S*\.js"?(\(.*)?$/.test(line))
    .join("\n");

try {
  const dirs = {};
  for (const name of ["time-tracker.plain", "time-tracker.bundled", "time-tracker.minified"]) {
    dirs[name] = join(temp, name);
    extractAll(join(built, `${name}.asar`), dirs[name]);
  }
  dirs.v2 = join(temp, "v2");
  extractAll(join(built, "time-tracker-v2.plain.asar"), dirs.v2);

  // 1. The bundles do what expected.json says, with and without NODE_ENV=development.
  const runs = {};
  for (const variant of ["bundled", "minified"]) {
    runs[variant] = observe(dirs[`time-tracker.${variant}`]);
    checkAgainstExpected(variant, runs[variant]);
    const dev = observe(dirs[`time-tracker.${variant}`], { NODE_ENV: "development" });
    checkAgainstExpected(`${variant} (development)`, dev);
    check(
      runs[variant].windows.get("invoice").sandbox === true &&
        dev.windows.get("invoice").sandbox === false,
      `${variant}: the invoice window's sandbox does not follow NODE_ENV`,
    );
  }

  // 2. The plain input is the source of those bundles: bundling it again gives the same code.
  for (const [variant, minify] of [
    ["bundled", false],
    ["minified", true],
  ]) {
    const out = join(temp, `re-${variant}`);
    await bundle(dirs["time-tracker.plain"], out, minify);
    for (const file of readdirSync(out))
      check(
        code(join(out, file)) === code(join(dirs[`time-tracker.${variant}`], file)),
        `plain does not bundle to the built ${variant}/${file}`,
      );
  }

  // 3. Look-alikes in comments: in the plain input on comment lines only, in the bundles gone.
  const commented = [
    "ghost:disabled-handler",
    "ghost:debug-reload",
    "https://ghost.punchclock.example/disabled",
    "ghost.disabled-key",
  ];
  for (const text of commented) {
    const lines = walk(dirs["time-tracker.plain"])
      .filter((file) => file.endsWith(".js"))
      .flatMap((file) => readFileSync(file, "utf8").split("\n"))
      .filter((line) => line.includes(text));
    check(lines.length === 1 && lines[0].trim().startsWith("//"), `${text}: not only a comment`);
    for (const variant of ["bundled", "minified"])
      for (const file of walk(dirs[`time-tracker.${variant}`]))
        check(!readFileSync(file, "utf8").includes(text), `${text} is in ${variant}`);
  }
  // Every other absent name that is a string in the sources is still a string in the bundles:
  // the look-alike is there to be seen and not to be reported.
  const kept = [
    "ghost:documented",
    "ghost:print-job",
    "ghost:port-ready",
    "ghost:port-hello",
    "ghost:port-ack",
    "ghost:bridge-ready",
    "ghost:widget-sync",
    "legacy:export",
    "scope:billing",
    "projects:archive",
    "https://ghost.punchclock.example/console-tip",
    "https://ghost.punchclock.example/logged-only",
    "https://staging-api.punchclock.example/v3/",
    "ghost.documented-key",
    "ghost.form-field",
  ];
  for (const text of kept)
    for (const variant of ["bundled", "minified"])
      check(
        walk(dirs[`time-tracker.${variant}`]).some((file) =>
          readFileSync(file, "utf8").includes(text),
        ),
        `${text} is missing from ${variant}`,
      );

  // 4. v2: only the edited files differ from v1 once the 30 comment lines are taken off.
  const changes = JSON.parse(readFileSync(join(here, "time-tracker-v2", "changes.json"), "utf8"));
  const edited = new Set(changes.edits.map((edit) => edit.file));
  for (const file of walk(dirs.v2)) {
    const name = relative(dirs.v2, file);
    const before = readFileSync(join(dirs["time-tracker.plain"], name), "utf8");
    let after = readFileSync(file, "utf8");
    if (name.endsWith(".js")) {
      const lines = after.split("\n");
      const head = lines.slice(0, changes.prependCommentLines);
      check(
        head.every((line) => line.startsWith("// moved down, line ")),
        `${name}: head`,
      );
      after = lines.slice(changes.prependCommentLines).join("\n");
    }
    check((before !== after) === edited.has(name), `${name}: changed=${before !== after}`);
  }
  check(existsSync(join(dirs.v2, "main.js")), "v2 has no main.js");

  // 5. v2 does what the compare expectations say: bundle it, observe it, compare the two runs.
  const v2 = join(temp, "v2-bundled");
  await bundle(dirs.v2, v2, false);
  const a = runs.bundled;
  const b = observe(v2);
  const diff = (before, after) => ({
    added: [...after].filter((item) => !before.has(item)),
    removed: [...before].filter((item) => !after.has(item)),
  });
  const expectDiff = (what, got, want) => {
    for (const key of Object.keys(got))
      check(same(got[key], want[key]), `v2 ${what} ${key}: ${got[key].toSorted()}`);
  };
  const stable = (name) => !/^project:\d+:touch$/.test(name);
  const roles = (seen, name) =>
    JSON.stringify(["receivers", "senders"].map((kind) => [...seen.channels.get(name)[kind]]));
  const namesA = new Set([...a.channels.keys()].filter(stable));
  const namesB = new Set([...b.channels.keys()].filter(stable));
  expectDiff(
    "ipcChannels",
    {
      ...diff(namesA, namesB),
      changed: [...namesA].filter((name) => namesB.has(name) && roles(a, name) !== roles(b, name)),
    },
    compare.ipcChannels,
  );
  const membersA = new Set(a.bridge.keys());
  const membersB = new Set(b.bridge.keys());
  expectDiff(
    "contextBridge",
    {
      ...diff(membersA, membersB),
      changed: [...membersA].filter(
        (member) => membersB.has(member) && !same(a.bridge.get(member), b.bridge.get(member)),
      ),
    },
    compare.contextBridge,
  );
  const settings = (seen) =>
    new Map(
      [...seen.windows].flatMap(([name, prefs]) =>
        Object.entries(prefs).map(([key, value]) => [`${name} ${key}`, value]),
      ),
    );
  const settingsA = settings(a);
  const settingsB = settings(b);
  expectDiff(
    "webPreferences",
    {
      ...diff(new Set(settingsA.keys()), new Set(settingsB.keys())),
      changed: [...settingsA.keys()]
        .filter((key) => settingsB.has(key) && settingsA.get(key) !== settingsB.get(key))
        .map((key) => `${key.split(" ")[1]}: ${settingsA.get(key)} -> ${settingsB.get(key)}`),
    },
    compare.webPreferences,
  );
  // Addresses: an observed address stands for the expected entry it belongs to. What v2
  // requests and v1's list does not know must be one of the added strings, and the other way.
  const list = expected.endpoints.present;
  const listB = [
    ...list,
    ...compare.endpoints.added.map((text) =>
      text.endsWith("/clients") ? { value: text } : { prefix: text },
    ),
  ];
  const keyOf = (entries) => (request) => {
    const entry = matchEndpoint(entries, request);
    return entry ? (entry.value ?? entry.prefix) : `run-time`;
  };
  const addressesA = new Set(a.requests.map(keyOf(list)));
  const addressesB = new Set(b.requests.map(keyOf(listB)));
  check(
    !b.requests.some((r) => !matchEndpoint(listB, r) && !r[1].startsWith("https://runtime.")),
    `v2 requests an address in no list: ${b.requests.map(([, url]) => url)}`,
  );
  expectDiff("endpoints", diff(addressesA, addressesB), compare.endpoints);
  const keys = (seen) =>
    new Set([...seen.storage].map((entry) => entry.split("|").slice(0, 2).join(" ")));
  const ops = (seen, key) =>
    [...seen.storage].filter((entry) => entry.split("|").slice(0, 2).join(" ") === key).toSorted();
  expectDiff(
    "storage",
    {
      ...diff(keys(a), keys(b)),
      changed: [...keys(a)].filter((key) => keys(b).has(key) && !same(ops(a, key), ops(b, key))),
    },
    compare.storage,
  );

  if (problems.length) {
    console.error(`holdout: ${problems.length} problem(s):\n${problems.join("\n")}`);
    process.exitCode = 1;
  } else {
    const counts = Object.entries(expected)
      .map(([name, value]) => `${name} ${value.present.length}/${value.absent.length}`)
      .join(", ");
    console.log(`holdout: bundled and minified time-tracker do what expected.json lists`);
    console.log(`holdout: present/absent per class: ${counts}`);
    console.log(`holdout: v2 differs from v1 exactly as time-tracker-v2/expected.json lists`);
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}
