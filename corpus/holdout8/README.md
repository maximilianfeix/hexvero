# Eighth hold-out set of the corpus

Ground truth held back from tool development, to be measured once, blind, at the end of sprint 3.
Each case has sources and an `expected.json` that states what the program does. I wrote the
expectations by reading the sources in this directory. I had no access to any analysis tool's
detectors, source code or output.

Author: an independent test-case author (agent E8, Claude Opus 5.5, a coding agent working for
Maxi), on 2026-10-18, on the branch `sprint3/e8-holdout8` (from `main` at `f836715`).

License: MIT, written for this corpus. The code is original and copies no real product. The
patterns come from open-source Electron apps (listed below); no code was copied from them.

## Access rules that were followed

I read these files outside this directory, and nothing else:

- `corpus/README.md`: what the corpus is and which classes are scored.
- `corpus/holdout7/README.md`, `corpus/holdout7/padwright/expected.json`,
  `corpus/holdout7/padwright-v2/expected.json` and `corpus/holdout7/padwright-v2/changes.json`:
  the format only. I did not open the holdout7 sources.
- `corpus/build.mjs`, `corpus/cases.mjs`: how cases are built and loaded.
- `corpus/score.mjs`: only to see the observation format and the scored classes, so that the
  expectations parse.
- `git show 6640046 -- corpus/cases.mjs corpus/score.mjs corpus/build.mjs .oxfmtrc.json`: how
  holdout7 was registered.
- The root `package.json`: its scripts and the pinned esbuild and asar versions.
- `.oxfmtrc.json`: to add this set's sources to its ignore list.

I saw directory listings only of `corpus/holdout7/` (its top level and the two case folders) and,
through `git status` and `git log --oneline -3`, the state of the branch. `git log` printed the
subject line of the last commit on `main`; I read nothing else about it. I did not open or list
anything under `packages/`, `corpus/results/`, `corpus/compare/`, `docs/`, `site/`, `scripts/`,
`e2e/`, `skills/` or `.claude/`, nor `corpus/observe-hexvero.mjs`, `CHANGELOG.md`, the top-level
READMEs or the sources of any other hold-out set. I did not run hexvero (no `npx hexvero`, no
`npm run`), and I did not search the web for it.

Outside the repository I read the source of eight open-source Electron apps through the jsDelivr
mirror (`curl https://cdn.jsdelivr.net/gh/<owner>/<repo>@<branch>/<path>`) and their file lists
through `gh api repos/<o>/<r>/git/trees/<branch>?recursive=1`. Nothing was cloned or run.

Programs I ran, all on this set's own code or on the corpus scripts I was allowed to read; every
scratch script lives outside the repository:

1. `node --check` on every source file, v1 and the derived v2.
2. `make-changes.mjs`. It writes `gristmill-v2/changes.json` from a list of edits. It applies each
   edit to a progressively edited copy, the way `derive()` does, and fails unless each `find`
   matches exactly once. It also writes the derived v2 tree, prepended comment lines included.
3. `harness.cjs`. It runs `main.js`, `preload.js` and `preload-shopping.js` in Node against a
   stand-in for `electron` and `electron-store`, a wrapped `fs` and a stub global `fetch`. It then
   calls every registered handler, every menu item's `click` and every exposed member. It prints
   each `ipcMain.handle` / `on` / `emit`, `webContents.send`, `webContents.ipc.once`,
   `new BrowserWindow` (with the merged `webPreferences`), `net.fetch` and `fetch`, store and
   file access, and the channel each member uses, with `file:line`. I ran it on v1, on the derived
   v2 and on the extracted `gristmill.minified.asar`. The minified build gives the same facts as
   the plain sources, line numbers aside.
4. A listing (`grep`) of every `window.<api>.<member>(…)`, `localStorage` / `sessionStorage` call
   and `fetch` in the renderers, which I read without running them.
5. `make-expected.mjs`. It writes both `expected.json` files from facts I wrote down by hand. Each
   line number is looked up by a piece of text that must occur exactly once in the named file, in
   the v1 tree or in the derived v2 tree.
6. `crosscheck.mjs`. It compares each `expected.json` with the harness output of the same tree:
   - every channel end in `places` against the logged call;
   - every bridge member and its channel;
   - the merged settings of every window;
   - every main-process request;
   - every store and file operation.

   Both versions agree.

7. `node corpus/build.mjs` and `node corpus/build.mjs --check`. Afterwards I extracted the four
   archives: `gristmill.plain.asar` is byte-identical to `gristmill/src`, and
   `gristmill-v2.plain.asar` to the tree from step 2.
8. `node corpus/score.mjs <obs> --set holdout8` on three hand-made observation files:
   - an empty one: every input NOT RUN;
   - one with empty lists: everything missed, nothing false;
   - one built from the expectations themselves: everything hit, nothing false.
9. `node_modules/.bin/oxfmt` on this directory's `README.md` and JSON files, so that they pass the
   repository's format check. The sources are in the ignore list.

Files outside this directory that I changed:

- `"holdout8"` was added to the list of sets in `corpus/build.mjs`, to the default of
  `loadCases()` in `corpus/cases.mjs` and to the default sets of `corpus/score.mjs`.
- `corpus/holdout8/*/src/**` was added to the ignore list of `.oxfmtrc.json`.
- The set got a row in the table of `corpus/README.md`.
- `corpus/built/SHA256SUMS` gained four lines (no other line changed), and
  `corpus/built/holdout8/` holds the four archives.

The scorer's classes are unchanged.

## Cases

| Case                            | Sources                                                 | Inputs (`corpus/built/holdout8/`)                                           |
| ------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------- |
| `gristmill` (kind `electron`)   | `gristmill/src/`                                        | `gristmill.plain.asar`, `gristmill.bundled.asar`, `gristmill.minified.asar` |
| `gristmill-v2` (kind `compare`) | `gristmill-v2/changes.json`, applied to `gristmill/src` | `gristmill-v2.plain.asar`                                                   |

**gristmill** is "Gristmill", a recipe library, meal planner and shopping list. With it you:

- keep recipes and import them from a web page (JSON-LD);
- plan a week by drag and drop;
- run cooking timers;
- look up nutrition facts;
- export a recipe as PDF;
- keep a shopping list in a small always-on-top window;
- sync with an account.

The app has 34 files with 1543 lines: 30 JavaScript files with 1420 lines, plus `package.json`,
`index.html`, `settings.html` and `shopping.html`.

Languages:

- The main process, `preload.js` and `common/` are CommonJS in the shape `tsc` emits, with
  `esModuleInterop`:
  - `"use strict"` and `exports.X = void 0` headers;
  - `__importDefault(require("path"))` used as `path_1.default`;
  - imported functions called as `(0, mod_1.fn)(…)`;
  - a string enum and a numeric enum compiled to IIFEs.
- Two files are still plain JavaScript (`allowJs`), as in apps halfway through a TypeScript move:
  `main/ipc/shopping.js` and `preload-shopping.js`.
- The renderers are ES modules.
- `electron-store` is required by `main/store.js`. `corpus/build.mjs` keeps it external, and it is
  not packed.

Modules:

- `main.js`: app lifecycle, single-instance lock; calls `registerIpcHandlers`, `buildMenu`,
  `createMainWindow`, `checkForUpdates` and a first sync.
- `common/channels.js`: `IPC_CHANNELS`, a plain object of request channel names.
- `common/messages.js`: the compiled enums `MessageToWebApp` (main-to-renderer pushes) and
  `SyncState` (numeric).
- `main/ipc/index.js`: `registerIpcHandlers`, which calls one register function per feature module.
- `main/ipc/recipes.js`, `shopping.js`, `sync.js`, `timers.js` (with `class TimerService`),
  `shell.js`, `window.js`, `store-bridge.js`: the handlers.
- `main/store.js`: the `electron-store` instance with a schema, a migration and the
  renderer-key allowlist.
- `main/library.js`: `recipes.json` in `userData/library`.
- `main/importer.js`: `net.fetch` of a pasted address, JSON-LD parsing.
- `main/sync/api-client.js`: `class ApiClient` (base URL, token, `net.fetch`) and its instance
  `api`.
- `main/sync/sync-engine.js`: pull, push, delete, status broadcast.
- `main/updates.js`: update check with the main-process global `fetch` and a retry timer.
- `main/config.js`: frozen window options (`mainWinOptions`, the unused `onboardingWinOptions`).
- `main/app-window.js`: `class AppWindow`, a wrapper that creates its own `BrowserWindow`.
- `main/windows.js`: the main window built by hand from `mainWinOptions`; the settings and
  shopping windows through `AppWindow`.
- `main/pdf-export.js`: a hidden print window.
- `main/menu.js`: the application menu.
- `preload.js`: the main and settings window preload (not sandboxed). It exposes `recipes`, `sync`,
  `timers`, `desktop`, `settingsStore` and, inside `process.once("loaded")`, `gristmillEvents`.
- `preload-shopping.js`: the sandboxed shopping preload with a channel allowlist; it exposes
  `shopping`.
- `renderer.js` with `renderer/library-view.js`, `renderer/planner.js` and `renderer/nutrition.js`;
  `renderer-settings.js`; `renderer-shopping.js`.

Windows:

- `mainWindow` (`main/windows.js`): `Object.assign({}, config_1.mainWinOptions)`, then mutated,
  then `new BrowserWindow(winOptions)`. Its `webPreferences` come from `main/config.js`:
  `preload.js`, `contextIsolation: true`, `nodeIntegration: false`, and `sandbox: false` from
  `...(isTesting() ? undefined : { sandbox: false })`.
- `settingsWindow` and `shoppingWindow`: `new AppWindow({…, webPreferences: {…}})`. The class calls
  `new BrowserWindow({ ...rest, webPreferences: { contextIsolation: true, nodeIntegration: false, ...rest.webPreferences } })`.
  - The settings window loads `preload.js` and writes no sandbox key.
  - The shopping window loads `preload-shopping.js` with `sandbox: true`.
- `printWindow` (`main/pdf-export.js`): hidden, no preload,
  `{ nodeIntegration: false, sandbox: false }`.

**gristmill-v2** is gristmill after 33 listed edits, plus 2 comment lines in front of every `.js`
file (`prependCommentLines: 2`), so every fact moves. The release adds "duplicate recipe", renames
"delete" to "move to trash" in the preload, makes the shopping list's clear button keep unchecked
items, uploads recipe photos and remembers recent searches. It also replaces the feedback form by
a mail link, sandboxes the print window and calls the sync engine from the menu directly. The
expected differences:

- **Channels:**
  - `recipes:duplicate` is added.
  - `shopping:clear` is renamed to `shopping:clear-checked`, on all three places. That is one
    removed and one added.
  - `menu:sync-now` is removed (the listener and the `ipcMain.emit`).
- **Bridge members:**
  - `recipes.duplicate` is added.
  - `recipes.remove` is renamed to `recipes.trash`. The channel `recipes:delete` stays, so this is
    a bridge change and not a channel change.
- **Window settings:** the `printWindow` `sandbox` setting changes from false to true, which is
  more restrictive.
- **Endpoints:**
  - `https://media.gristmill.example/v1/upload` (POST) is added, through a second `ApiClient`
    instance on a new host.
  - `https://api.gristmill.example/v2/feedback` (POST) is removed.
- **Storage:**
  - `localStorage` `gristmill.recentSearches` (read, write) is added.
  - `sessionStorage` `gristmill.search` is removed.
  - `electron-store` `sync.lastPulledAt` is changed: sign-out now also deletes it, so its
    operations go from read, write to read, write, delete. It is listed under
    `changes.storage.changed`.
- **IPC payload (not scored):** `recipes:import-url` gains `tags`. This is listed under
  `expect.ipcPayloadChangesUnscored`.

These are not differences. They are listed in `unchangedMoves` (23 entries with `fromLine` and
`toLine`) and under `changes.*.absent`:

- an enum member moved to the top of its enum;
- two handlers moved within their register function;
- `desktop.isMac` moved from the first to the last member;
- the `shopping.items` delete moved into an else branch, with the same operations;
- the payload field;
- every line shift.

## Where the patterns come from

| Pattern                                                                                                                                                                   | Real app and file                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Channel names in an exported object (`IPC_MAIN_CHANNELS`), handlers registered by feature modules' `init…Handlers()`                                                      | Responsively, [`common/constants.ts`](https://github.com/responsively-org/responsively-app/blob/main/desktop-app/src/common/constants.ts), [`main/app-meta/index.ts`](https://github.com/responsively-org/responsively-app/blob/main/desktop-app/src/main/app-meta/index.ts)                                                                               |
| A store bridge: `ipcRenderer.sendSync(STORE_GET)` answered with `event.returnValue`, an allowlist of renderer keys, `electron-store` with a schema and dot paths          | Responsively, [`main/preload.ts`](https://github.com/responsively-org/responsively-app/blob/main/desktop-app/src/main/preload.ts), [`store/index.ts`](https://github.com/responsively-org/responsively-app/blob/main/desktop-app/src/store/index.ts)                                                                                                       |
| `"ns::area::verb"` channel literals, local `invoke` / `send` helpers in the preload, one `exposeInMainWorld` per API group inside `try`, a `registerXHandlers` aggregator | Mark Text, [`preload/index.ts`](https://github.com/marktext/marktext/blob/develop/packages/desktop/src/preload/index.ts), [`main/ipc/index.ts`](https://github.com/marktext/marktext/blob/develop/packages/desktop/src/main/ipc/index.ts), [`main/ipc/shell.ts`](https://github.com/marktext/marktext/blob/develop/packages/desktop/src/main/ipc/shell.ts) |
| Frozen window options in a config module, copied with `Object.assign({}, …)` and then mutated                                                                             | Mark Text, [`main/config.ts`](https://github.com/marktext/marktext/blob/develop/packages/desktop/src/main/config.ts), [`main/windows/setting.ts`](https://github.com/marktext/marktext/blob/develop/packages/desktop/src/main/windows/setting.ts)                                                                                                          |
| A string enum for main-to-renderer messages, `set…Handler` members wrapping `ipcRenderer.on`, exposure inside `process.once("loaded")`                                    | Standard Notes, [`Shared/IpcMessages.ts`](https://github.com/standardnotes/app/blob/main/packages/desktop/app/javascripts/Shared/IpcMessages.ts), [`Renderer/Preload.ts`](https://github.com/standardnotes/app/blob/main/packages/desktop/app/javascripts/Renderer/Preload.ts)                                                                             |
| `ipcMain: ipc` aliasing in plain JS, a settings change broadcast to every other window                                                                                    | Min, [`main/main.js`](https://github.com/minbrowser/min/blob/master/main/main.js), [`js/util/settings/settingsMain.js`](https://github.com/minbrowser/min/blob/master/js/util/settings/settingsMain.js)                                                                                                                                                    |
| Per-window IPC (`webContents.ipc.on`)                                                                                                                                     | Min, [`main/main.js`](https://github.com/minbrowser/min/blob/master/main/main.js) (`mainView.webContents.ipc.on('set-window-title', …)`)                                                                                                                                                                                                                   |
| A conditional spread in `webPreferences` (`...(isTesting() ? undefined : { sandbox: false })`), `ipcMain.emit` inside the main process, `net.fetch`                       | YouTube Music, [`src/index.ts`](https://github.com/th-ch/youtube-music/blob/master/src/index.ts), [`plugins/utils/main/fetch.ts`](https://github.com/th-ch/youtube-music/blob/master/src/plugins/utils/main/fetch.ts)                                                                                                                                      |
| `electron-store` migrations that read, rewrite and delete an old key                                                                                                      | YouTube Music, [`src/config/store.ts`](https://github.com/th-ch/youtube-music/blob/master/src/config/store.ts)                                                                                                                                                                                                                                             |
| A window wrapper class whose constructor spreads the caller's `webPreferences` over defaults, a registry of windows, a "mounted" handshake                                | Kap, [`main/windows/kap-window.ts`](https://github.com/wulkano/Kap/blob/main/main/windows/kap-window.ts), [`main/windows/preferences.ts`](https://github.com/wulkano/Kap/blob/main/main/windows/preferences.ts)                                                                                                                                            |
| A periodic fetch with version headers and a `setTimeout` retry                                                                                                            | Hyper, [`app/notifications.ts`](https://github.com/vercel/hyper/blob/canary/app/notifications.ts)                                                                                                                                                                                                                                                          |
| A sandboxed preload with a `validChannels` allowlist and generic `send` / `receive` members, plus value members (`isMac`)                                                 | Simplenote, [`desktop/preload.js`](https://github.com/Automattic/simplenote-electron/blob/trunk/desktop/preload.js)                                                                                                                                                                                                                                        |

These are app code of my own: the API client class with a base URL, the JSON-LD importer, the
`data:` URL print window, the localStorage planner with a migration, and the renderer fetches. They
follow what the apps above do without copying any of them.

## Idioms this set uses

The mix is meant to be what these apps have: most channels are direct
`ipcMain.handle` / `ipcRenderer.invoke` pairs with names from one constants module, and a few
parts are hard.

IPC:

- **Channel names from an exported object.** `channels_1.IPC_CHANNELS.X`, defined in
  `common/channels.js` and used by the main process and the unsandboxed preload.
- **Channel names from a compiled TypeScript enum:**
  `MessageToWebApp["TimerTick"] = "timer-tick"` inside an IIFE.
- **Literal `ns::area::verb` names** on both ends.
- **Local helpers in the preload.** `invoke` / `send` take the channel from the member.
- **Six bridge objects:**
  - five exposed inside a `try`, one exposed inside `process.once("loaded")`;
  - the shopping bridge with generic members that take the channel from the renderer.
- **Another name for `ipcMain`** in plain JS: `const { ipcMain: ipc } = require('electron')`.
- **Pushes from the main process from five modules:**
  - a class method sending to the requesting window;
  - a loop over `BrowserWindow.getAllWindows()`;
  - a getter function `getWindow()?.webContents`;
  - the shopping window through `windows.getShoppingWindow()`;
  - a broadcast that skips the sender.
- **A synchronous message** (`sendSync` and `event.returnValue`).
- **`webContents.ipc.once`** on one window instead of `ipcMain`, with the name in a module
  constant and two preloads sending it.
- **A channel with a receiver and no IPC sender:** `ipcMain.emit` from the menu (v1).
- **Look-alikes:**
  - an unused constant and an unused enum member;
  - an allowlisted channel nobody uses;
  - numeric enum names;
  - menu ids;
  - process, DOM, window and app events;
  - the bridge API name.

Window settings:

- a frozen config object copied with `Object.assign`, with a conditional spread for `sandbox`;
- a wrapper class with defaults and the caller's settings spread last;
- the caller's settings in a different file from the `new BrowserWindow`;
- an inline literal in a local variable.

The look-alikes are an unused frozen options object and the config objects themselves.

contextBridge:

- named API objects with members through helpers;
- direct `sendSync`;
- listener registrars;
- value members;
- generic members with no channel of their own.

Requests:

- an `ApiClient` instance with a base URL whose `request` calls `net.fetch` of a template, called
  with a POST to a known path and with three templated paths;
- the main-process global `fetch` of a template;
- a renderer `fetch` with a query template;
- a renderer POST to a known address;
- a `net.fetch` of an address the user pasted, which is unreadable.

The look-alikes are the bases, a JSON-LD `@context` value, `shell.openExternal` addresses, CSP
origins, a text attribution, `loadFile` and a `data:` URL.

Storage:

- one JSON file in `userData` (kind `file`);
- `electron-store` keys as dot paths (kind `electron-store`), read and written in the main process
  and, through the store bridge, from renderers;
- a migration key that is only read and deleted;
- `localStorage` with a migration key that is only read and deleted;
- one `sessionStorage` key.

The look-alikes are an allowlisted key nobody uses, schema groups, electron-store's default file
name, the `getPath` argument, a drag format, header names and a constant name.

## Format notes

The format is holdout7's, with these differences:

- **Window settings `file`** is the file whose code calls `new BrowserWindow`.
  - Where the value is written in another file, `lineFile` names the file that `line` refers to:
    `main/config.js` for `mainWindow`, `main/windows.js` for the callers of `AppWindow`.
  - Both AppWindows are therefore attributed to `main/app-window.js`.
- **`places.senders` may be empty** (`menu:sync-now`). `places.notIpc` then gives the
  `ipcMain.emit` that is not IPC.
- **Generic bridge members** (`shopping.send`, `request`, `receive`) have `channel: null`. The
  channels they carry are attributed to `renderer-shopping.js`, where each channel is named.
  `places` gives the `ipcRenderer` call in `preload-shopping.js` and the `entry` in the renderer.
- **Storage kinds** are `file`, `electron-store`, `localStorage` and `sessionStorage`.
  `changes.storage.changed` has `fromOps` / `toOps`.
- **The `prependCommentLines`** count is 2.
- **No `ipcChannels.unknown` and no `interfaceLinks`.** No channel name is computed at run time.

## Toolchain

| Tool           | Version                                          |
| -------------- | ------------------------------------------------ |
| node           | v22.17.1                                         |
| esbuild        | 0.28.2 (pinned in `package.json`, via the build) |
| @electron/asar | 4.3.1 (pinned in `package.json`, via the build)  |

SHA-256 of the built inputs (from `corpus/built/SHA256SUMS`):

```
52624a686a868c038ff15f998397ae0ab8bbd1bd7f3591c02ef762cb36fbacba  holdout8/gristmill.plain.asar
bd5bc8a0d5452a096237f3f674c2418ac0513015278b7c07ab998291277a79b2  holdout8/gristmill.bundled.asar
98a6f40ce816822f4adb2d81af53103ea8358f09d058bb69f6ba4e6f8eda885a  holdout8/gristmill.minified.asar
67727161d120051d6962276de6e529dac8f5e152f60338663bc549020beeab33  holdout8/gristmill-v2.plain.asar
```
