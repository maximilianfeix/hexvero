# Hold-out set of the corpus

Ground truth that is held back from tool development and from the tuning that used `corpus/dev`
and `corpus/validation`. Each case has sources and an `expected.json` that states what the
program does. The expectations were written by reading the sources in this directory. They were
written without access to any analysis tool's detectors, source code or output: nothing under
`packages/`, `e2e/`, `scripts/`, `docs/`, `examples/` or `corpus/results/` was read, neither were
`corpus/score.mjs` and `corpus/observe-hexvero.mjs`, and no analysis tool was run on these
sources or on the built inputs. The files read outside this directory were `corpus/build.mjs`,
`corpus/cases.mjs`, `corpus/dev/**` and `corpus/validation/**` (for the layout, the format and
the idioms already covered, so that this set uses others) and the root `package.json`.

License: MIT, written for this corpus.

## Cases

| Case                               | Sources                                                        | Built inputs (`corpus/built/holdout/`)                                               |
| ---------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `time-tracker` (kind `electron`)   | `time-tracker/src/`                                            | `time-tracker.plain.asar`, `time-tracker.bundled.asar`, `time-tracker.minified.asar` |
| `time-tracker-v2` (kind `compare`) | `time-tracker-v2/changes.json`, applied to `time-tracker/src/` | `time-tracker-v2.plain.asar`                                                         |
| `native-exprcalc` (kind `native`)  | `native/exprcalc.c`                                            | `exprcalc.O0.macho-arm64`, `exprcalc.O2.macho-arm64`                                 |

**time-tracker** is "Punchclock", an Electron time tracker with three windows (the main window,
a floating timer widget, an invoice preview). `main.js` is written with `import` statements, as
projects with a bundler write it, and is bundled to CommonJS; `preload.js` uses `require`,
because a preload script has to be CommonJS; `renderer.js` (main window) and
`renderer-widget.js` (widget) are ES modules. Helper modules: `ipc/channels.js`,
`ipc/events.js`, `ipc/index.js` (channel names), `config/windows.js` (CommonJS: window geometry
and the shared web preferences), `config/endpoints.js` (addresses), `lib/keys.js` (storage
keys), `lib/format.js`. It has 24 IPC channels, 11 fixed window settings in three windows, 23
bridge members in two APIs, 14 addresses plus 1 request with an unknown address, and 17 storage
entries, each class with look-alikes that must not be reported.

**time-tracker-v2** is time-tracker after ten listed edits and 30 comment lines in front of
every JavaScript file. Eight edits change the program; one swaps two members of an object and
one changes only a comment.

**native-exprcalc** is a calculator for integer expressions in C (`exprcalc "2 * (3 + 4)"
[trace]`): a tokenizer that is a state machine of functions in a table, a recursive-descent
parser (expression, term, factor, and back to expression), a visitor of two callbacks chosen at
run time, ordinary calls, returns of calls, and a function nobody calls.

## Idioms this set uses that the other two do not

IPC

- handlers registered in the constructor and in a method of a class (`TimerService`);
- handlers from an array of `{ channel, run }` objects and from a `Map` (whose `forEach` passes
  the value first and the key second);
- helpers that take the channel as their second argument, on both sides
  (`secured(scope, channel, handler)`, `request(timeoutMs, channel, ...args)`), with a first
  argument that looks like a channel name (`"scope:billing"`);
- `ipcMain` under a second name through a renamed import (`import { ipcMain as rpc }`), and in
  the bundles the form esbuild gives imports (`import_electron.ipcMain.handle(...)`);
- names from a frozen enum-like object, from the output of a TypeScript string enum
  (`Push["MenuNewEntry"] = "menu:new-entry"`), from a constant re-exported under another name by
  an index module, and names that are written nowhere in full: prefix constant plus literal
  (`TIMER_PREFIX + "tick"`, `` `${TIMER_PREFIX}tick` ``) and a template inside a function that
  returns functions (`project("list")` giving `projects:list`);
- `ipcRenderer.postMessage` and `webContents.postMessage` (a message on a named channel that
  carries a `MessagePort`), `ipcRenderer.addListener`, a destructured `({ sender })` that sends,
  `event.reply` with a constant, optional chaining on a call result
  (`BrowserWindow.getFocusedWindow()?.webContents.send(...)`) and twice in a row
  (`widget?.webContents?.send(...)`);
- a handler that is registered and later removed (`sync:cancel`), a `removeHandler` for a name
  nobody ever registers (`legacy:export`, absent), a channel with a listener and no sender, a
  channel with a sender and no listener, and a channel that exists on one platform only;
- look-alikes: port messages, a window message, a `CustomEvent`, a `BroadcastChannel`, an
  in-page publish/subscribe object, a print spooler with `send()`, `powerMonitor`, `nativeTheme`,
  `globalShortcut`, `process.on`, a `ClientRequest`'s `on("error")`.

Window settings

- a class field built with `Object.assign` from a frozen object of a CommonJS config module;
- a function whose destructured parameter has defaults (`{ sandbox = true, nodeIntegration =
  false, preload } = {}`) and returns shorthand properties; the call overrides one default and
  leaves the other;
- a variable passed as a shorthand `webPreferences`, with one value that is a conditional on the
  environment (not expected, see below);
- look-alikes: options of a mail provider (`sandbox`, `preload`), and two objects that report
  the settings of the running process under the same key names.

contextBridge

- an API object built in a variable, a member added afterwards inside a platform condition,
  members that are results of helper calls, a shorthand member that is an imported function, a
  member that is an object;
- a second API exposed as `exposeInMainWorld(widgetBridge.key, widgetBridge.api)`.

Requests

- `fetch` with a literal, a template, a concatenation whose constant is the host, an inline
  `new URL(path, base)`, a `URL` variable that gets a query parameter, a `Request` object,
  options with a method, `window.fetch`, a constant imported from a config module;
- Electron's `net.fetch` through a renamed import, `https.request(url, { method })`,
  `XMLHttpRequest.open` and `WebSocket` with a property of a config object, `sendBeacon`;
- look-alikes: `shell.openExternal`, an address built with `new URL` that is only displayed, two
  addresses passed to loggers, an in-page `post(path, body)`, an unused constant, a host in the
  Content-Security-Policy, `loadFile`.

Storage

- a key used as a property of `localStorage` (read and assignment), keys from an object of
  constants in another module, `sessionStorage` destructured from `window` under another name,
  `window.indexedDB`, a database name and version from constants;
- electron-store as a default import, `get` with a fallback, `set` with an object of keys, a key
  held in a constant, and a second store in a private class field (`this.#store`);
- look-alikes: `FormData`, `URLSearchParams.set`, a `Set`, the stores' file names, a cookie
  name, request headers.

Native

- calls through a table of state functions and through a struct of callbacks chosen at run time;
- recursion through three functions, and a function that also calls itself;
- a libc function that the optimized program reaches only by jumps (`fputs`), a jump to libc in
  a function nobody calls (`atoi`), an import that only the unoptimized file has (`strchr`), and
  an imported data symbol (`___stderrp`).

## What a reader must know to trust the ground truth

- **Truth, not detectability.** An expectation is present when the program does the thing, also
  through a helper, another name, a table, a class, or a constant from another file. It is
  absent when it only looks like a finding; every absent entry says why.
- **File attribution.** Roles are attributed to the entry files `main.js`, `preload.js`,
  `renderer.js`, `renderer-widget.js`. The helper modules contain no IPC call, no window, no
  bridge call, no request and no storage access, so the attribution is the same for the plain
  input and for the bundles. A window setting is attributed to the file that creates the window
  (`main.js`), also where its value is written in `config/windows.js`.
- **Window settings.** Only `preload`, `contextIsolation`, `nodeIntegration` and `sandbox` are
  listed: one entry per window and key that the code fixes, so `contextIsolation: true` is
  listed three times. The invoice window's `sandbox` is `isDev ? false : true` and follows
  `NODE_ENV` at run time; it is not listed, and the two absent entries with a `count` say that
  no second fixed `sandbox: true` and no second fixed `sandbox: false` exists.
- **Platform conditions.** `dock:badge` and `tracker.setBadge` are inside
  `if (process.platform === "darwin")`. They are listed as present, with that remark: the code is
  in the program, and unlike a setting there is no second value it could have.
- **`shell.openExternal`.** It hands an address to the operating system. The application
  requests nothing, so these addresses are absent and the call counts neither as a request nor
  as an unreadable one.
- **Addresses.** `value` is a fully known address, `prefix` the known start of one that ends in
  run-time text. For `loadTimesheet` the prefix is the address without its query
  (`.../timesheets/current`): the code then adds `?tz=` and a run-time value. `unreadable` is 1
  (`fetch(receipt.downloadUrl)`). No request goes through a function that takes the address as a
  parameter.
- **A name that is only removed.** `rpc.removeHandler("legacy:export")` is the only use of that
  name. Nothing handles it and nothing sends it, so it is absent.
- **v2, a channel that changes.** Deleting `widget.close` from the preload script leaves the
  listener in `main.js`. `widget:close` is therefore in both versions and is listed under
  `changed` (its senders go from `preload.js` to none), not under `removed`.
- **Native: paths and callers mean direct calls and jumps.** The state functions and the visitor
  callbacks run when the program is used, but only through pointers; their expected callers are
  empty, with the functions that make the indirect call under `indirect`. No path question
  depends on an indirect call: every `no-path` also holds when the pointers are followed.
  `parse_factor` is listed as its own caller.
- **Native binaries do not rebuild to the same bytes.** `corpus/build.mjs --check` skips native
  inputs for this reason. The expectations were checked against the files listed in
  `corpus/built/SHA256SUMS`.

## What was verified, and how

Electron cases: `node corpus/holdout/verify.mjs` (after `node corpus/build.mjs --native`). It
uses node, the pinned esbuild and @electron/asar, and nothing else. It extracts the built
archives and

1. **runs** the bundled and the minified `main.js`, `preload.js`, `renderer.js` and
   `renderer-widget.js` in Node against stand-ins for Electron, electron-store, `node:https` and
   the browser (`verify/observe-*.{cjs,mjs}`). The stand-ins record every channel registered or
   sent on and by which file, the options of every `new BrowserWindow`, every exposed API member
   and the channels it touches, every request with its method, every `shell.openExternal`, and
   every storage access. The script fails unless that record is exactly what `expected.json`
   lists as present (channels with roles, settings per window, members with channels, storage
   kinds, keys and operations), unless every observed request belongs to one expected address
   and every expected address was requested, unless exactly one request went to a run-time
   address, and if anything listed as absent was observed. It does this with and without
   `NODE_ENV=development` and checks that only the invoice window's `sandbox` follows it. The
   run was made on macOS, so the macOS-only channel and member were observed;
2. bundles the extracted plain input again and compares the result with the built bundles
   (same code), so the plain input is the source of what was run;
3. checks that the four commented-out look-alikes are on comment lines in the plain input and
   nowhere in the bundles, and that the other look-alike strings are still in the bundles;
4. checks that v2 minus its 30 comment lines differs from v1 in exactly the edited files;
5. bundles v2, runs it the same way, and fails unless the differences between the two runs are
   exactly the `added`, `removed` and `changed` lists of `time-tracker-v2/expected.json`.

The checks were tried against wrong expectations (ten single changes to the two expected files,
each restored afterwards); each made the script fail.

In addition the bundled and minified files were read. Bundling renames nothing that an
expectation rests on: `ipcMain` becomes `import_electron.ipcMain` (minified `o.ipcMain`, and
`i.ipcMain` for the import named `rpc`), `Channel.TimerStart` stays a property access, the
constants stay variables rather than being written into the calls, `isDev ? false : true`
becomes `!L` in the minified file, and esbuild removed no call (every function in the sources
is reached from an entry point). The bundled input keeps the comments that sit inside
expressions and gains one path comment per source file; the minified input has none.

Native case, by hand on the two files in `corpus/built/holdout/`:

- `nm -u`: `-O0` imports `_atoi _fputs _getenv _printf _strchr _strtol` and the data symbol
  `___stderrp`; `-O2` the same without `_strchr`.
- `nm`: both files have `_main` and the sixteen static functions.
- `otool -tV`, every `bl`, `blr` and every `b` to a symbol, listed per function. `-O0`: every
  source call is a `bl`; the four calls through pointers are `blr`. `-O2`: jumps are
  `main -> complain`, `main -> report`, `report -> complain`, `complain -> fputs`,
  `debug_level -> atoi`; everything else stays `bl`/`blr` (the full list is in the `method` of
  `native/expected.json`); there is no `br` and no conditional branch to another function.
- Both files were run: `exprcalc "2 * (3 + 4) - -5"` prints `19 (7 steps)`, with a second
  argument it prints the trace, with a third the usage message on standard error, and
  `"2 * (3 + "` gives the syntax error.

Not verified: how a scorer reads these files. `corpus/score.mjs` was not read, so the meaning
it gives to repeated window settings, to `count`, to `changed` for a channel and to prefix
strings in the compare lists is taken from the two other sets' files alone.

## Toolchain

| Tool           | Version                                                                         |
| -------------- | ------------------------------------------------------------------------------- |
| node           | v25.2.1                                                                         |
| esbuild        | 0.28.2 (pinned in `package.json`)                                               |
| @electron/asar | 4.3.1 (pinned in `package.json`)                                                |
| cc             | Apple clang version 17.0.0 (clang-1700.3.19.1), target arm64-apple-darwin25.5.0 |

Build and check from the repository root (the bundles contain source paths relative to it):

```
node corpus/build.mjs --native
node corpus/build.mjs --check
node corpus/holdout/verify.mjs
```
