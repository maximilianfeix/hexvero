// Runs a bundled renderer script against stand-ins for the browser and prints the requests it
// made and the storage it touched. Part of corpus/holdout/verify.mjs.
//   node observe-renderer.mjs <file> <location.hash>
import { pathToFileURL } from "node:url";

// The program logs; only the result may go to standard output.
console.log = console.info = console.warn = () => {};

const seen = { requests: [], storage: [], broadcast: [], unknownRequests: 0 };
const handlers = [];
const starters = [];
const define = (name, value) =>
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });

function storage(kind) {
  const data = {};
  const note = (key, op) => seen.storage.push([kind, key, op]);
  const methods = {
    getItem: (key) => (note(key, "read"), data[key] ?? null),
    setItem: (key, value) => (note(key, "write"), void (data[key] = String(value))),
    removeItem: (key) => (note(key, "delete"), void delete data[key]),
  };
  return new Proxy(methods, {
    get: (target, key) => (key in target ? target[key] : (note(key, "read"), data[key])),
    set: (_target, key, value) => (note(key, "write"), (data[key] = String(value)), true),
  });
}

const element = () => ({
  addEventListener: (_name, fn) => handlers.push(fn),
  dataset: {},
  style: {},
  classList: { add() {} },
  elements: { hours: { focus() {} } },
  offsetWidth: 240,
});
const elements = new Map();
const api = new Proxy(
  {},
  {
    get:
      (_target, name) =>
      (...args) => {
        for (const arg of args)
          if (typeof arg === "function") arg({ label: "0:00:01", done: 1, version: "9", file: "f" });
        return name === "setting" ? "EUR" : Promise.resolve({ id: 1 });
      },
  },
);

define("window", globalThis);
define("location", { hash: process.argv[3] ?? "" });
define("localStorage", storage("localStorage"));
define("sessionStorage", storage("sessionStorage"));
define("tracker", api);
define("widget", api);
define("moveTo", () => {});
define("addEventListener", (name, fn) => (name === "DOMContentLoaded" ? starters : handlers).push(fn));
define("document", {
  getElementById: (id) => elements.get(id) ?? elements.set(id, element()).get(id),
  documentElement: { dataset: {} },
  body: { classList: { add() {} } },
  get cookie() {
    seen.storage.push(["cookie", "document.cookie", "read"]);
    return "punch_sid=abc";
  },
  set cookie(_value) {
    seen.storage.push(["cookie", "document.cookie", "write"]);
  },
});
define("indexedDB", {
  open: (name) => (seen.storage.push(["indexedDB", name, "open"]), {}),
  deleteDatabase: (name) => (seen.storage.push(["indexedDB", name, "delete"]), {}),
});
define("fetch", async (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  const method = init?.method ?? (input instanceof Request ? input.method : null);
  seen.requests.push(["fetch", url, method]);
  return {
    ok: true,
    json: async () => ({ token: "t", theme: "dark", currency: "EUR", team: "t1", rate: 1, total: 2 }),
  };
});
define(
  "XMLHttpRequest",
  class {
    open(method, url) {
      seen.requests.push(["XMLHttpRequest", String(url), method]);
    }
    setRequestHeader() {}
    send() {}
  },
);
define(
  "WebSocket",
  class {
    constructor(url) {
      seen.requests.push(["WebSocket", String(url), null]);
    }
    addEventListener(_name, fn) {
      handlers.push(fn);
    }
  },
);
define(
  "BroadcastChannel",
  class {
    constructor(name) {
      seen.broadcast.push(name);
    }
    postMessage() {}
  },
);
define(
  "FormData",
  class extends Map {
    constructor() {
      super();
    }
  },
);
define("navigator", {
  sendBeacon: (url) => seen.requests.push(["sendBeacon", String(url), null]),
  clipboard: { writeText: async () => {} },
});

await import(pathToFileURL(process.argv[2]).href);
for (const fn of starters) await fn({});
const event = () => ({
  preventDefault() {},
  target: { dataset: { project: "2", entry: "7", receipt: "https://runtime.example/receipt.pdf" } },
  data: "timer-port",
  ports: [{ postMessage() {} }],
});
for (const fn of [...handlers]) await Promise.resolve(fn(event())).catch(() => {});
process.stdout.write(JSON.stringify(seen));
process.exit(0);
