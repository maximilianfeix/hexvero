# Validation half of the corpus

Ground truth that is held back from tool development. Each case has sources and an
`expected.json` that states what the program does. The expectations were written by reading the
sources in this directory. They were written without access to any analysis tool's detectors,
source code or output: nothing under `packages/`, `e2e/`, `scripts/`, `docs/` or `examples/` was
read, and no analysis tool was run on these sources or on the built inputs. The only files read
outside this directory were `corpus/build.mjs`, `corpus/dev/**` (for the layout and the format)
and the root `package.json`.

License: MIT, written for this corpus.

## Cases

| Case                              | Sources                                                | Built inputs (`corpus/built/validation/`)                                |
| --------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------ |
| `chat-app` (kind `electron`)      | `chat-app/src/`                                        | `chat-app.plain.asar`, `chat-app.bundled.asar`, `chat-app.minified.asar` |
| `chat-app-v2` (kind `compare`)    | `chat-app-v2/changes.json`, applied to `chat-app/src/` | `chat-app-v2.plain.asar`                                                 |
| `native-dispatch` (kind `native`) | `native/dispatch.c`                                    | `dispatch.O0.macho-arm64`, `dispatch.O2.macho-arm64`                     |

**chat-app** is an Electron chat client: `main.js` (two windows, IPC handlers, update check,
electron-store), `preload.js` (two exposed APIs), `renderer.js` (requests and browser storage of
the main window), `renderer-settings.js` (the settings dialog, which runs with Node integration
and takes `ipcRenderer` from `window.require("electron")`), and two helper modules:
`ipc-names.js` (channel-name constants) and `net.js` (address constants, a Map-backed cache, a
header helper). It has 17 IPC channels, 7 window settings, 13 bridge members, 11 addresses plus
2 requests with an unknown address, and 11 storage entries, each with look-alikes that must not
be reported.

**chat-app-v2** is chat-app after ten listed edits and 40 comment lines in front of every
JavaScript file. Nine edits change the program; one changes only a comment.

**native-dispatch** is a command dispatcher in C (`dispatch <double|env> [argument]`) with
ordinary calls, returns of calls, a function that calls itself, two handlers reached only
through a table of pointers, and a function nobody calls.

## What a reader must know to trust the ground truth

- **Truth, not detectability.** An expectation is present when the program does the thing, also
  through a wrapper (`route()`, `call()`, `broadcast()`), another name (`emit`, `ls`, `httpGet`),
  a table of handlers, or a constant from another file. It is absent when it only looks like a
  finding; every absent entry says why.
- **File attribution.** Roles are attributed to the entry files `main.js`, `preload.js`,
  `renderer.js`, `renderer-settings.js`. The helper modules contain no IPC call, window, bridge
  call, request or storage access, so the attribution is the same for the plain input and for
  the bundles. In the plain input the constants (`CHANNELS.*`, `API_ROOT`, `GATEWAY_URL`,
  `HELP_URL`) are defined in `ipc-names.js` and `net.js`; in the bundles they are inside the
  entry files.
- **What bundling changes (checked by reading the built files).** After `node corpus/build.mjs`
  the three archives were extracted with `@electron/asar` and read. In the bundled and in the
  minified files every expected channel name, address and storage key is still present as a
  string in the entry file it is attributed to; esbuild removed no call and no helper (every
  function in the sources is reached from the entry points). Minification renames local
  variables (`ipcMain` becomes a one-letter name, `CHANNELS.HISTORY` becomes `h.HISTORY`), keeps
  property names, and keeps the constants as variables rather than writing their values into the
  calls. The commented-out calls (`ghost:commented-out`, `ghost:preload-comment`,
  `ghost:debug-dump`, `https://ghost.chat.example/in-a-comment`, `ghost.commented-out`) exist in
  the plain input only. The bundled input still has a few comments (those inside object literals,
  and one path comment per source file); the minified input has none.
- **Window settings.** Only `preload`, `contextIsolation`, `nodeIntegration` and `sandbox` are
  listed, and the list is complete for these four keys. The sources also set `spellcheck` (main
  window) and `webSecurity` (settings dialog). The expected value is the one the window is
  created with: `basePreferences()` contains `sandbox: false`, but its only call replaces it with
  `sandbox: true`, so the main window has `sandbox: true` and `sandbox: false` exists once (the
  settings dialog).
- **Addresses.** `value` is a fully known address, `prefix` the known start of one that ends in
  run-time parts. `unreadable` counts calls whose address is entirely unknown at the call
  (`fetch(attachment.href)`, `navigator.sendBeacon(target, payload)`). No request goes through a
  wrapper function that takes the address as a parameter, so the count does not depend on whether
  a reader follows wrappers.
- **Native: verified by disassembly.** The statements in `native/expected.json` about symbols and
  about which calls are `bl` and which are `b` were read from `nm` and `otool -tV` on the two
  built files in `corpus/built/validation/`. In the `-O2` file: `main` jumps to `usage` and to
  `finish`, `usage` jumps to `emit`, `cmd_env` jumps to `emit`, `emit` jumps to `puts`; all other
  direct calls are `bl`; the call through the table is `blr`; `tree_sum` keeps one `bl` to itself
  (the second recursive call became a loop). In the `-O0` file every call is `bl`/`blr`. Both
  files import exactly `atoi`, `getenv`, `printf`, `puts`, `remove`, `strcmp`, `strlen`.
- **Native: paths and callers mean direct calls and jumps.** `cmd_double` and `cmd_env` run when
  the program is used, but only through the pointer table, so their expected callers are empty
  and no path question depends on the indirect call. `tree_sum` is listed as its own caller.
- **Native binaries do not rebuild to the same bytes.** Two builds of the same C file with the
  same compiler differ in the Mach-O UUID and the ad-hoc code signature; the instructions are the
  same. `corpus/build.mjs --check` skips native inputs for this reason. The expectations were
  checked against the files listed in `corpus/built/SHA256SUMS`.

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
```
