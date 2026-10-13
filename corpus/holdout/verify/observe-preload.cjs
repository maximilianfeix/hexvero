// Runs a bundled preload.js against a stand-in for electron and prints, for every member of
// every exposed API, the channels it touched. Part of corpus/holdout/verify.mjs.
"use strict";
const Module = require("node:module");
const path = require("node:path");

// The program logs; only the result may go to standard output.
console.log = console.info = console.warn = () => {};

const seen = { apis: {}, outside: [], windowMessages: [] };
let context = seen.outside;
const later = [];

const ipcRenderer = {};
for (const method of ["invoke", "send", "sendSync", "postMessage"])
  ipcRenderer[method] = (channel) => {
    context.push([method, channel]);
    return method === "invoke" ? Promise.resolve({}) : undefined;
  };
for (const method of ["on", "once", "addListener", "off", "removeListener"])
  ipcRenderer[method] = (channel, fn) => {
    context.push([method, channel]);
    if (context === seen.outside) later.push(() => fn({ ports: [] }));
  };

const apis = {};
const electron = {
  ipcRenderer,
  contextBridge: { exposeInMainWorld: (name, api) => (apis[name] = api) },
};

globalThis.window = {
  addEventListener: (_name, fn) => later.push(fn),
  postMessage: (message) => seen.windowMessages.push(message),
  dispatchEvent() {},
};
globalThis.CustomEvent = class {};
globalThis.requestAnimationFrame = (fn) => fn();
Object.defineProperty(globalThis, "navigator", {
  value: { clipboard: { writeText: async () => {} } },
  configurable: true,
});

const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === "electron") return electron;
  return load.call(this, request, ...rest);
};

require(path.resolve(process.argv[2]));

for (const fn of later) fn({});
for (const [name, api] of Object.entries(apis)) {
  seen.apis[name] = {};
  for (const [member, value] of Object.entries(api)) {
    context = seen.apis[name][member] = [];
    if (typeof value !== "function") continue;
    const result = value(() => {}, 1, 2);
    if (typeof result === "function") result();
    if (result instanceof Promise) result.catch(() => {});
  }
}
process.stdout.write(JSON.stringify(seen));
process.exit(0);
