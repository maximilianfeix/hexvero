# Seventh hold-out set of the corpus

Ground truth held back from tool development, to be measured once, blind, at the end of sprint 2.
Each case has sources and an `expected.json` that states what the program does. I wrote the
expectations by reading the sources in this directory. I had no access to any analysis tool's
detectors, source code or output.

Author: an independent test-case author (agent E7, Claude Opus 5.5, a coding agent working for
Maxi), on 2026-10-17, on the branch `sprint2/e7-holdout7` (from `main` at `5fe4692`).

License: MIT, written for this corpus. The code is original and copies no real product.

## Access rules that were followed

I read these files outside this directory, and nothing else:

- `corpus/README.md`: what the corpus is and which classes are scored.
- `corpus/holdout5/README.md`, `corpus/holdout5/tidemark/expected.json` and
  `corpus/holdout5/tidemark-v2/expected.json`, `corpus/holdout5/tidemark-v2/changes.json`: the
  format only. I did not open the holdout5 sources.
- `corpus/build.mjs`, `corpus/cases.mjs`: how cases are built and loaded.
- `corpus/score.mjs`: only to see the observation format and the scored classes, so that the
  expectations parse.
- The root `package.json`: its scripts and the pinned esbuild and asar versions.
- `.oxfmtrc.json`: to add this set's sources to its ignore list.

I saw directory listings only of `corpus/` (its top level) and `corpus/holdout5/`. I did not open
or list anything under `packages/`, `corpus/results/`, `corpus/compare/`, `docs/`, `site/`,
`scripts/`, `e2e/`, `.claude/` or `skills/`, nor `corpus/observe-hexvero.mjs`, `CHANGELOG.md`, the
top-level READMEs or `corpus/holdout6/`. The only thing I know about holdout6 is its row in the
`corpus/README.md` table. I did not run hexvero (no `npx hexvero`, no `npm run`), and I did not
search the web for it.

Programs I ran, all on this set's own code or on the corpus scripts I was allowed to read:

1. `node --check` on every source file, v1 and the derived v2.
2. `make-changes.mjs` (scratch, outside the repository). It writes `padwright-v2/changes.json`.
   It applies each edit to a progressively edited copy, the way `derive()` does, and fails unless
   each `find` matches exactly once. It also writes the derived v2 tree, prepended comment lines
   included.
3. `harness.cjs` (scratch). It runs `main.js`, `preload.js` and `preload-flasher.js` in Node
   against a stand-in for `electron`, `node:https` and `node:fs` and a stub `fetch`. It then
   calls every registered handler and listener and every exposed member. It prints each
   `ipcMain.handle`/`on`, `webContents.send`, `new BrowserWindow` (with the merged
   `webPreferences`), `https.get`, `net.request`, `fetch` and file access, and the channel each
   member uses, with `file:line`. I ran it on v1, on the derived v2 and on the extracted
   `padwright.minified.asar`. Every output agrees with the expectations.
4. `renderer-check.mjs` (scratch). It imports `renderer/gallery.js`, `renderer/keymap-view.js`
   and `renderer/settings-store.js` with stubbed `window.localStorage`, `fetch`,
   `BroadcastChannel` and `document`, and prints each storage call and request. I read
   `renderer.js`, `renderer-flasher.js` and `renderer-diagnostics.js` without running them.
5. `make-expected.mjs` (scratch). It writes both `expected.json` files from facts I wrote down by
   hand. Each line number is looked up by a piece of text that must occur exactly once in the
   named file, in the v1 tree or in the derived v2 tree. The lines of channel ends,
   `unchangedMoves` and windows were then compared with the harness output, and they agree.
6. `node corpus/build.mjs` and `node corpus/build.mjs --check`. Afterwards I extracted the four
   archives: `padwright.plain.asar` is byte-identical to `padwright/src`, and
   `padwright-v2.plain.asar` to the tree from step 2.
7. `node corpus/score.mjs <obs> --set holdout7` on three hand-made observation files, all in the
   scratchpad:
   - an empty one: every input NOT RUN;
   - one with empty lists: everything missed, nothing false;
   - one built from the expectations themselves: everything hit, nothing false, and no row for
     payloads.

Files outside this directory that I changed: `"holdout7"` was added to the list of sets in
`corpus/build.mjs`, to the default of `loadCases()` in `corpus/cases.mjs` and to the default sets
of `corpus/score.mjs`. `corpus/holdout7/*/src/**` was added to the ignore list of `.oxfmtrc.json`.
The set got a row in the table of `corpus/README.md`. `corpus/built/SHA256SUMS` gained four lines
(no other line changed), and `corpus/built/holdout7/` holds the four archives. The scorer's
classes are unchanged.

## Cases

| Case                            | Sources                                                 | Inputs (`corpus/built/holdout7/`)                                           |
| ------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------- |
| `padwright` (kind `electron`)   | `padwright/src/`                                        | `padwright.plain.asar`, `padwright.bundled.asar`, `padwright.minified.asar` |
| `padwright-v2` (kind `compare`) | `padwright-v2/changes.json`, applied to `padwright/src` | `padwright-v2.plain.asar`                                                   |

**padwright** is "Padwright", a configurator for programmable USB macro keypads. With it you:

- list the attached pads;
- edit their key layers by drag and drop and write them to the pad;
- browse and share layouts in a public gallery;
- update a pad's firmware in a modal flasher window;
- open a legacy diagnostics console.

The HID layer is simulated by a loopback transport, so the program needs no native module.

The main process is CommonJS in the shape `tsc` emits: `"use strict"`,
`Object.defineProperty(exports, "__esModule", …)`, `exports.X = …`, string and numeric enums
compiled to IIFEs, and imported functions called as `(0, mod_1.fn)(…)`. The renderers are ES
modules as a bundler's sources would be.

- `main.js`: the app, the IPC registration through the table, three channels registered
  directly, and the device-attached push.
- `main/ipc-table.js`: the registration table (`buildTable`) and the loop that registers it
  (`registerAll`).
- `main/windows.js`: the three windows.
- `main/device-bus.js`: the simulated device bus, an `EventEmitter`.
- `main/firmware.js`: the firmware feed (`node:https`) and the image download (Electron `net`).
- `main/flash-session.js`: the flash progress pushed to the flasher window.
- `main/telemetry.js`: usage events and the team webhook (`fetch`).
- `main/settings-file.js`: the settings JSON file.
- `main/menu.js`: the application menu.
- `common/ipc-contract.js`: the compiled `Channel` and `FlashStage` enums.
- `preload/ipc-client.js`: `class IpcClient`, the small SDK layer around `ipcRenderer`.
- `preload.js`: the unsandboxed main preload, the API `padwright`.
- `preload-flasher.js`: the sandboxed preload, the API `flasher`.
- `renderer.js` with `renderer/settings-store.js` (a `localStorage` wrapper with key constants),
  `renderer/keymap-view.js` and `renderer/gallery.js`.
- `renderer-flasher.js` and `renderer-diagnostics.js`.

The app has 23 files with 795 lines: 19 JavaScript files with 722 lines, plus `package.json`,
`index.html`, `flasher.html` and `diagnostics.html`.

Windows:

- `mainWindow`: options in a variable, `webPreferences: prefsFor("preload.js", { sandbox: false })`.
  The helper `prefsFor` returns `{ ...SECURE_DEFAULTS, preload, ...overrides }`.
- `flasherWindow`: `flasherPrefs = prefsFor("preload-flasher.js")`, sandboxed.
- `diagnosticsWindow`: the deliberately permissive window,
  `legacyPrefs = { nodeIntegration: true, contextIsolation: false }`, with no preload. Its page
  calls `window.require("electron").ipcRenderer.invoke(…)`.

**padwright-v2** is padwright after 26 listed edits, plus 3 comment lines in front of every `.js`
file (`prependCommentLines: 3`), so every fact moves. The expected differences:

- **Channels:**
  - `keymap:reset` is added (enum member, table entry, member `resetKeymap`).
  - `diag:snapshot` is renamed to `diag:collect`, on both ends. That is one removed and one added.
  - `flash:cancel` is removed (the listener in `main.js`, the member `flasher.cancel` and its
    button).
- **Bridge members:** `padwright.resetKeymap` is added, and `flasher.cancel` is removed.
- **Window settings:** the `flasherWindow` `sandbox` setting changes from true to false, which is
  more permissive.
- **Endpoints:** one address on a new host is added, `https://crash.padwright.example/v1/reports`
  (POST, through `node:https` `request`).
- **Storage:** one key is added, `localStorage` `padwright.lastLayer` (read, write). It is a new
  key constant, used from `renderer/keymap-view.js`.
- **IPC payload (not scored):** `keymap:write` gains the field `dryRun`. This is listed under
  `expect.ipcPayloadChangesUnscored`, outside `changes`, because the scorer scores every list
  under `changes`.

These are not differences. They are listed in `unchangedMoves` (22 entries with `fromLine` and
`toLine`) and under `changes.*.absent`:

- the enum member `DeviceAttached` moved to the end of the enum;
- the two settings entries moved to the top of the table;
- the telemetry listener moved below the diagnostics handler;
- the member `isMac` moved from the first to the last member;
- `applyTheme` moved in `renderer.js`;
- the new payload field in `keymap:write` (same channel, same ends);
- every line shift.

The `device:attached` send in `main.js` keeps line 28, because 3 lines were prepended and 3
removed. It guards against reporting a fact as changed merely because its line did not move.

## Idioms this set uses

IPC:

- **A registration table.** `buildTable(deps)` returns an array of
  `{ channel, kind: "handle" | "on", run }`. `registerAll(table)` loops over it and calls
  `ipcMain.handle(entry.channel, …)` or `ipcMain.on(entry.channel, …)`.
- **Channel names from a compiled TypeScript string enum.** The pattern is
  `Channel["ListDevices"] = "device:list"` inside
  `(function (Channel) {…})(Channel || (exports.Channel = Channel = {}))`, used as
  `ipc_contract_1.Channel.X` by the main process and the unsandboxed preload.
- **Channel constants from another module:** `flash_session_1.FLASH_START` (`main/flash-session.js`)
  in the table, and `telemetry_1.TELEMETRY_CHANNEL` (`main/telemetry.js`) in `main.js`.
- **Another name for `ipcMain`:** `const ipc = electron_1.ipcMain`.
- **A wrapper class in the preload.** `IpcClient.invoke` / `send` / `subscribe` call
  `ipcRenderer?.invoke` (optional chaining), `ipcRenderer?.send` and `ipcRenderer.on`. The bridge
  object is returned by `createApi(client)` and exposed inline:
  `exposeInMainWorld("padwright", createApi(new IpcClient("padwright")))`.
- **`webContents.send` from a module other than the one that created the window.**
  `FlashSession.report` sends to the window found by `BrowserWindow.fromWebContents(event.sender)`,
  and `main.js` sends through `windows.main?.webContents`.
- **IPC from a renderer that is not a preload:** `window.require("electron")` in the
  nodeIntegration window.
- **Look-alikes:**
  - an unused exported array of channel names;
  - device protocol commands given to `transport.send`;
  - `EventEmitter` events (`attach`, `detach`);
  - a `BroadcastChannel` named `keymap:sync`;
  - menu item ids;
  - a payload field named `channel` whose value is `"stable"`;
  - the client's label;
  - numeric enum names;
  - telemetry event names;
  - window and `net` events.

Window settings:

- options in a variable;
- a spread of a frozen base inside a helper, with overrides spread last;
- a variable passed by name;
- a literal in a variable.

The look-alike is `RECOMMENDED` in `renderer-diagnostics.js`, which is only displayed.

contextBridge:

- `padwright`: built by a function, members through the client class, one member that is a
  value.
- `flasher`: an inline literal with the channel names written out.

Requests:

- `node:https` `get` of a template, which gives a prefix;
- Electron `net.request({ method, url })` with a template, which gives a prefix;
- `fetch` of a template on two constants, which is fully known;
- renderer `fetch` with a query template, which gives a prefix;
- a POST to a known address;
- a `fetch` of a webhook address taken from the settings file, which is unreadable;
- in v2, `https.request` to a literal.

The look-alikes are an unused beta feed, `shell.openExternal`, a base shown as text, a CSP
origin, base constants and `loadFile`.

Storage:

- one JSON file in `userData` (kind `file`, as in holdout4 and holdout5);
- a `localStorage` wrapper whose keys are full constants (`Keys.THEME = "padwright.theme"`, no
  prefix), called from three modules, one key also removed through `prefs.clear`;
- a direct `localStorage.removeItem` of a legacy key, which is only deleted;
- a direct `sessionStorage` key that is read, written and removed.

The look-alikes are the constant names, the `getPath` argument, settings fields, a drag format, a
header, a query parameter and an in-memory `Map`.

## Format notes

The format is holdout5's, with these differences:

- **`places`** on each channel gives `file` and `line` of the ends. For ends that go through a
  wrapper, `line` is the `ipcMain` / `ipcRenderer` call inside the wrapper, and `entry` is where
  the channel is handed to it. `constant` gives where the name is defined. Nothing scores
  `places`.
- `line` on window settings, bridge members and endpoints is the line of the fact in the plain
  input.
- **`ipcPayloadsUnscored`** (v1 and v2) and **`ipcPayloadChangesUnscored`** (v2) list the object
  literals sent over IPC by field name. The scorer has no class for them, and I did not add one.
- There is no `interfaceLinks` and no `ipcChannels.unknown`. No channel name in this app is
  computed at run time, and the scorer adds the unknown-channel row only when the field exists.
  If a tool lists the `IpcClient` calls without a channel, that is not scored.
- **Attribution:** senders and receivers that go through `IpcClient` name `preload.js`, where the
  channel is handed to the client. The `ipcRenderer` calls themselves are in
  `preload/ipc-client.js`. Receivers of table channels name `main/ipc-table.js`. `bundledFiles`
  maps every module to its entry file for the bundled and minified inputs.
- **`webPreferences` absent:**
  - `count` follows holdout4 and holdout5.
  - The entry `preload: null` for `diagnosticsWindow` only documents that the window has no
    preload. The scorer does not read absent window entries.

## Toolchain

| Tool           | Version                                          |
| -------------- | ------------------------------------------------ |
| node           | v22.17.1                                         |
| esbuild        | 0.28.2 (pinned in `package.json`, via the build) |
| @electron/asar | 4.3.1 (pinned in `package.json`, via the build)  |

SHA-256 of the built inputs (from `corpus/built/SHA256SUMS`):

```
d002fbd524a506a814fa33b4881ea72203cbf2384f1ed445ab5a44314d21d6f0  holdout7/padwright.plain.asar
cc12ff706efcff0c0ecbdda8cc6f5c015a1af8b6fb010705d292103592babfc9  holdout7/padwright.bundled.asar
7ce9c32a01bf32f28536663f9e50c987bfa4007a336b78ce2a651d5fb8be6c81  holdout7/padwright.minified.asar
374e9464471a95f4e267be71247761159cb0b43bfed715444ce96b68703d3084  holdout7/padwright-v2.plain.asar
```
