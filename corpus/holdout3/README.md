# Third hold-out set of the corpus

Ground truth that is held back from tool development, written after `corpus/holdout2` to measure
the analyzer on code it has never seen. Each case has sources and an `expected.json` that states
what the program does. The expectations were written by reading the sources in this directory,
without access to any analysis tool's detectors, source code or output.

## Access rules that were followed

Read, outside this directory, and nothing else:

- `corpus/build.mjs` and `corpus/cases.mjs` (how cases are built and loaded);
- `corpus/holdout2/README.md`, `corpus/holdout2/markdown-editor/expected.json`,
  `corpus/holdout2/markdown-editor-v2/changes.json`,
  `corpus/holdout2/markdown-editor-v2/expected.json` (the format of `expected.json` and
  `changes.json`, and the idioms holdout2 already uses, so that this set uses others);
- `corpus/holdout/README.md` (format only; its idiom list was seen while reading it).

Directory listings of `corpus/` and `corpus/holdout2/` were seen; no other file was opened. The
sources of holdout2 and holdout were not opened. Not read: anything under `packages/`, `e2e/`,
`scripts/`, `docs/`, `examples/`, `site/`, `corpus/results/`, `corpus/compare/`;
`corpus/score.mjs`, `corpus/gate.mjs`, `corpus/observe-*.mjs`, `corpus/README.md`, the root
`README.md`, `CHANGELOG.md`. No analysis tool was run on these sources, and the web was not
searched for the analyzer. `corpus/build.mjs` was not run, so no input of this set is built yet
(see Building). The only programs run were `node --check` on the sources and two scratch scripts
outside the repository (one applies `changes.json` the way `derive()` in `corpus/build.mjs` does,
one checks that every line number in `interfaceLinks` points at the call it names).

License: MIT, written for this corpus. The code is original and copies no real project.

## Cases

| Case                                 | Sources                                                            | Inputs (`corpus/built/holdout3/`, not built yet) |
| ------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------ |
| `podcast-player` (kind `electron`)   | `podcast-player/src/`                                              | `podcast-player.plain.asar`                      |
| `podcast-player-v2` (kind `compare`) | `podcast-player-v2/changes.json`, applied to `podcast-player/src/` | `podcast-player-v2.plain.asar`                   |

**podcast-player** is "Driftwood", a desktop podcast player with three windows: the library
(`libraryWindow`, preload `preload.js`, page `renderer.js`), a frameless mini player
(`playerWindow`, preload `preload-player.js`, page `renderer-player.js`) and a guide
(`helpWindow`, no preload, `index.html#help`). `main.js`, both preloads and the modules in
`shared/` are CommonJS; the two renderer scripts are ES modules. Helper modules:
`shared/channels.js` (channel names), `shared/endpoints.js` (addresses), `shared/index.js`
(re-exports both and holds the menu labels). 11 files: 8 JavaScript files with 864 lines, plus
`package.json`, `index.html` and `player.html`. It has 23 IPC channels plus one whose name is
chosen at run time, 14 window settings in three windows, 26 bridge members in two APIs with 26
interface links (25 resolvable, 1 not), 7 addresses plus 2 requests with an unknown address, and
9 storage entries, each class with look-alikes that must not be reported.

**podcast-player-v2** is podcast-player after fifteen listed edits, without prepended comment
lines. The expected differences: one channel and one bridge member added (`playback:skip`,
`player.skip`), one channel and one member removed (`episodes:mark-played`,
`driftwood.markPlayed`), the mini player's `sandbox` turned off (more permissive) and the guide's
`webSecurity` turned on (more restrictive), one address added (`.../v1/charts`) and one
localStorage key removed (`driftwood.lastSearch`). Not differences: the `help:open` listener cut
and pasted from the end of `registerIpc` to its start (line 325 to 292), the renderer's call of
the removed member, and every line shift.

## Idioms this set uses

IPC

- channel names as static fields of classes (`class Library { static LIST = "library:list" }`)
  next to `Object.freeze` objects, in a module that the main process requires through a
  re-exporting module (`module.exports = { ...require("./channels"), ...require("./endpoints"),
  t }`) and the library preload requires directly;
- handlers registered by a loop over an array of `[channel, handler]` pairs
  (`for (const [channel, handler] of routes) ipcMain.handle(channel, handler)`), and by a
  `for...of` over a `Map` of handlers;
- a preload helper `const call = (ch) => (...a) => ipcRenderer.invoke(ch, ...a)` that makes
  members (`listShows: call(Library.LIST)`), in both preloads, one with constants, one with
  literals;
- pushes from class methods: `this.#window.webContents.send(...)` through a private field,
  `sender.send(...)` in a private method where `sender` is a request's `event.sender` passed
  along, and a loop over two windows; and `event.reply` answering a hello message;
- `ipcRenderer.sendSync` at the top level of a preload, answered by `event.returnValue`;
- one channel written nowhere in full: `` `${DOWNLOAD_PREFIX}cancel` `` on both sides;
- one channel no static reading can name: `` `alerts.${crypto.randomBytes(4).toString("hex")}` ``
  in the main process, handed to the preload through the `sendSync` reply and listened to from a
  property of that reply;
- a sandboxed preload that cannot require local modules and therefore writes its names out,
  next to an unsandboxed preload that requires the shared module;
- look-alikes: i18n label ids `menu:file`, `menu:help.guide`, ...; log messages
  `"settings:open is not a window; ..."` and `"help:open failed"`; an unused static field and a
  commented-out handler (`library:import-opml`); a DOM `CustomEvent("episode:selected")`; a
  localStorage key `driftwood:view`; menu item ids sent as values; WebSocket, stream, window,
  app and DOM events.

Window settings

- a frozen `SECURE_DEFAULTS` merged with `Object.assign({}, SECURE_DEFAULTS, { preload, sandbox:
  false })` in one window and with a spread in another; a plain literal in the third;
- `webSecurity` listed as a fifth key (holdout2 listed four), with one window that turns it off;
- look-alike: `store.delete("windows.nodeIntegration")`, a storage key with a setting's name.

contextBridge

- an API made by `Object.assign(api, episodesApi)` inside the `exposeInMainWorld` call;
- an API that is an `Object.freeze({...})` literal written inside the call;
- members that are values or pure functions (`platform`, `formatDuration`), listed with
  `channel: null` and no ends.

Requests

- Node's `https.get` inside a small redirect-following helper whose callers pass run-time feed
  addresses (unreadable), and `fetch` of a run-time enclosure address (unreadable);
- main-process `fetch` with a constant re-exported through `shared/index.js`, with a template on
  a CDN constant, and the global `WebSocket` with a template and a query;
- renderer `fetch` with a template ending in `URLSearchParams`, a literal with conditional
  headers (ETag), a POST, and a template on a constant of the other renderer;
- look-alikes: `shell.openExternal`, an `href` in generated HTML, a placeholder text, an unused
  constant, `loadFile`.

Storage

- electron-store with keys read and written inside class methods, inside a `[channel, handler]`
  table (one key holds an object whose fields are set from IPC arguments), a dotted key, and a
  `delete` at start;
- localStorage keys in constants of the page, one of them with a colon; IndexedDB with a name
  and version from constants;
- look-alikes: the fields passed over IPC (`speed`), the store's file name, response headers read
  with `headers.get`, an object store and index name, query parameters.

## What a reader must know to trust the ground truth

- **Truth, not detectability.** An expectation is present when the program does the thing, also
  through a table, a class field, a re-export, a template or a value received at run time. It is
  absent when it only looks like a finding; every absent entry says why.
- **File attribution.** Roles are attributed to the entry files (`main.js`, `preload.js`,
  `preload-player.js`, `renderer.js`, `renderer-player.js`). The `shared/` modules contain no IPC
  call, no window, no bridge call, no request and no storage access. A window setting is
  attributed to `main.js`, also where its value comes from `SECURE_DEFAULTS`.
- **interfaceLinks** (new in this set). One entry per bridge member: `api`, `member`, `channel`
  (null for a member without IPC or with a run-time channel), `preload`, `memberLine`, `ends` and
  `resolvable`. `ends` are the main-process calls on the member's channel: `ipcMain.handle`/
  `ipcMain.on` for members that invoke or send; `webContents.send` (also `sender.send` on a
  WebContents) and `event.reply` for members that listen. A handler registered by a loop over a
  table has the line of the `ipcMain.handle` inside the loop as `line` and the line of its table
  entry as `entryLine`. `playback:state` has two ends for both listening members, although at run
  time the `event.reply` reaches only the mini player; the entry says so. `driftwood.onAlert` has
  `channel: null`, `resolvable: false` and one end that is known by reading the program, not
  from the channel text.
- **Window settings.** Keys `preload`, `contextIsolation`, `nodeIntegration`, `sandbox`,
  `webSecurity`; one entry per window and key the code writes, with an extra field `window`
  (the variable). The guide writes no `preload`; Electron's defaults are not listed. `count` in
  an absent entry follows holdout2: that many entries of this key and value would be too many.
- **Storage kind names.** `electron-store` is used as the kind for `new Store(...)` of the
  electron-store package; holdout2's expected file had no electron-store entry, so the exact kind
  string a scorer expects was not seen.
- **Compare additions.** `podcast-player-v2/expected.json` adds `webPreferences.windowChanges`
  (window, setting, before, after, direction), `unchangedMoves` (facts that moved line only) and
  an `interfaceLinks` section.

## Building

`corpus/build.mjs` was not modified (this set may change no file outside `corpus/holdout3/`) and
was not run. Two things are needed before these cases can be scored:

1. add `"holdout3"` to the list of sets in `corpus/build.mjs` (`for (const set of ["dev",
   "validation", "holdout", "holdout2"])`) and in the default of `loadCases()` in
   `corpus/cases.mjs`;
2. only for bundled inputs: `bundle()` builds `main.js` and `preload.js` only, so a bundled
   input would not contain `preload-player.js`. That is why `expected.json` lists the plain input
   alone. To add `podcast-player.bundled.asar` and `.minified.asar`, `bundle()` would also have
   to build every `preload*.js` (with the same options as `preload.js`).

Not verified: how a scorer reads these files. `corpus/score.mjs` was not read, so the meaning it
gives to the new fields (`window`, `interfaceLinks`, `windowChanges`, `unchangedMoves`,
`entryLine`, `memberLine`) is as stated here only.

## Toolchain

| Tool | Version                                            |
| ---- | -------------------------------------------------- |
| node | v25.2.1 (for `node --check` and the scratch checks) |
