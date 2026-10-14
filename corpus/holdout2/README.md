# Second hold-out set of the corpus

Ground truth that is held back from tool development, written after `corpus/holdout` to measure
the analyzer once more on code it has never seen. Each case has sources and an `expected.json`
that states what the program does. The expectations were written by reading the sources in this
directory, without access to any analysis tool's detectors, source code or output.

## Access rules that were followed

Read, outside this directory:

- `corpus/build.mjs` and `corpus/cases.mjs` (how cases are built and loaded);
- `corpus/dev/notes-app/src/*`, `corpus/dev/notes-app/expected.json`,
  `corpus/dev/notes-app-v2/changes.json`, `corpus/dev/notes-app-v2/expected.json`;
- `corpus/validation/README.md`, `corpus/validation/chat-app/src/*.js`,
  `corpus/validation/chat-app/expected.json`, `corpus/validation/chat-app-v2/changes.json`,
  `corpus/validation/chat-app-v2/expected.json`;
- `corpus/holdout/README.md`, `corpus/holdout/time-tracker/src/**`,
  `corpus/holdout/time-tracker/expected.json`, `corpus/holdout/time-tracker-v2/changes.json`,
  `corpus/holdout/time-tracker-v2/expected.json`, and the first 150 lines of
  `corpus/holdout/verify.mjs` (to see how that set checked its expectations);
- the root `package.json`.

These were read for the layout, the format of `expected.json` and `changes.json`, and the idioms
the three earlier sets already cover, so that this set uses others. The native cases of the
other sets were not opened. Not read: anything under `packages/`, `e2e/`, `scripts/`, `docs/`,
`examples/`, `site/`, `skills/`, `corpus/results/`, `corpus/compare/`; `corpus/score.mjs`,
`corpus/gate.mjs`, `corpus/observe-hexvero.mjs`, `corpus/README.md`, the root `README.md`,
`CHANGELOG.md`, `PROGRESS.md`. No analysis tool was run on these sources or on the built inputs.
`node corpus/build.mjs` was run to build the inputs (it writes only under `corpus/built/`,
including `corpus/built/SHA256SUMS`).

License: MIT, written for this corpus. The code is original and copies no real project.

## Cases

| Case                                  | Sources                                                              | Built inputs (`corpus/built/holdout2/`)                                                       |
| ------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `music-player` (kind `electron`)      | `music-player/src/`                                                  | `music-player.plain.asar`, `music-player.bundled.asar`, `music-player.minified.asar`          |
| `markdown-editor` (kind `electron`)   | `markdown-editor/src/`                                               | `markdown-editor.plain.asar`, `markdown-editor.bundled.asar`, `markdown-editor.minified.asar` |
| `markdown-editor-v2` (kind `compare`) | `markdown-editor-v2/changes.json`, applied to `markdown-editor/src/` | `markdown-editor-v2.plain.asar`                                                               |

**music-player** is "Cadence", a desktop music player with a main window, a mini player and an
about box. `main.js`, `preload.js` and the helper modules are written as `tsc` emits TypeScript
compiled to CommonJS (`electron_1.ipcMain.handle(...)`, `exports.NAME = "..."`,
`__importDefault`, `(0, mod_1.fn)(...)`); the two renderer scripts `renderer.js` and
`renderer-mini.js` are ES modules, as a Vite build of a renderer would be. Helper modules:
`shared/ipc.js` (channel names), `shared/endpoints.js` (addresses), `shared/time.js`
(formatting), `main/window-options.js` (window defaults merged with a spread), `lib/keys.js`
(storage names). 9 files, 835 lines of JavaScript. It has 20 IPC channels, 12 window settings in
three windows, 22 bridge members in two APIs, 10 addresses plus 1 request with an unknown
address, and 11 storage entries, each class with look-alikes that must not be reported.

**markdown-editor** is "Inkwell", a markdown editor with a live preview pane (a
`WebContentsView` inside the editor window), a lazily created settings window, a vault of notes
and plug-ins. `main.js` and `preload.js` are plain CommonJS; `renderer.js` (editor),
`renderer-preview.js` (preview pane) and `renderer-settings.js` (settings window) are ES
modules. Helper modules: `ipc/channels.js` (nested channel constants), `config/defaults.js`
(window defaults and storage names), `config/endpoints.js` (addresses), `lib/markdown.js` (a
small markdown renderer), `lib/settings-file.js` (the app's own JSON settings file). 10 files,
997 lines of JavaScript. It has 22 IPC channels, 9 window settings in two windows and one view,
23 bridge members in three APIs, 9 addresses plus 1 request with an unknown address, and 8
storage entries, each class with look-alikes.

**markdown-editor-v2** is markdown-editor after eleven listed edits and 20 comment lines in
front of every JavaScript file. Eight edits change the program (a channel and a bridge member
added, a channel and its bridge member removed, a window setting changed, two addresses changed,
a storage access removed); three change nothing a tool should report (a renderer call of the
removed member replaced by `document.title = ...`, two members swapped, a comment rewritten).

## Idioms this set uses

The mix is meant to look like real code: roughly 60% of the channels and window settings are in
the most common direct style (literal names in `ipcMain.handle/on` and in `ipcRenderer.invoke/
send` inside the preload, `webPreferences` literals in `new BrowserWindow({...})`), the rest in
other styles that real Electron code uses and that the three earlier sets do not.

IPC

- main process and preload compiled by `tsc` to CommonJS: every call reads
  `electron_1.ipcMain.handle(...)` / `electron_1.ipcRenderer.invoke(...)`, channel names are
  `exports.PLAYER_STATE = "player:state"` and properties of `exports.Channels` read as
  `ipc_1.PLAYER_STATE` and `ipc_1.Channels.SettingsGet`;
- a table of handlers with computed keys from those constants
  (`{ [ipc_1.Channels.SettingsGet]: ... }`) registered with
  `for (const channel of Object.keys(handlers)) ipcMain.handle(channel, handlers[channel])`;
- a handler on one window's own IPC, `win.webContents.ipc.handle(...)`, instead of `ipcMain`;
- a small router class (`new IpcRouter("vault").handle("list", ...).handle("search", ...)
  .on("reveal", ...)`) that puts its namespace in front of each name, in a chain, so the full
  names `vault:list`, `vault:search`, `vault:reveal`, `plugins:list` are written nowhere in
  `main.js`;
- channel names as properties of a nested object (`channels.settings.get`);
- a push to every page through Electron's `webContents.getAllWebContents()`, and pushes to a
  `WebContentsView`'s `webContents`;
- a push from a click handler returned by a factory (`menuAction("save")`), from a
  `globalShortcut` callback inside a loop, and from `event.sender.send` inside a handler;
- `ipcMain.once` registered inside a window's `close` listener, answered from the page;
- a channel whose name is built at run time from plug-in ids read from disk, on both sides
  (`plugin:${pluginId}:event`), next to a fixed channel with the same start (`plugin:invoke`);
- look-alikes: an in-page event emitter of the audio engine (`engine.on("track:ended")`), an
  in-page command registry with VS Code-like command ids (`editor:toggle-bold`),
  `navigator.mediaSession.setActionHandler`, the namespace and name arguments of the router,
  values sent on a channel (`"play-pause"`, `"save-as"`), unused constants, a channel name in a
  log message, calls in comments, and system, window, page and tray events.

Window settings

- secondary windows built by a helper that merges `{ ...defaults, ...overrides,
  webPreferences: { ...BASE_WEB_PREFERENCES, ...overrides.webPreferences } }`: one window
  overrides the default `sandbox`, another keeps it;
- the same pattern in plain CommonJS (`createWindow(options)` with `WEB_DEFAULTS`), where the
  window replaces the default `sandbox` with a run-time condition read from the user's settings
  (not expected, see below);
- a `WebContentsView` with its own `webPreferences`;
- a settings window created on first use that writes only `preload` and `sandbox`;
- look-alikes: an object named `webPreferences` inside the shape of an old plug-in manifest that
  is only compared with, and `audio.preload = "metadata"` in a renderer.

contextBridge

- an API object made by spreading four part objects and adding two members;
- members generated with `Object.fromEntries(Object.entries(map).map(...))` from a map of member
  name to channel, spread into the API;
- the `electron-vite` style of exposing: `if (process.contextIsolated) { try {
  exposeInMainWorld(...) } catch {} } else { window.x = api }`, with three APIs;
- a member named `send`, a member that is a function imported from a helper module, a member
  whose channel name is made at run time;
- members that subscribe through a helper `on(channel, listener)` of the preload.

Requests

- an axios-like client class written in the app (`new ApiClient(API_ROOT)` with `get`, `post`,
  `delete`, one `fetch` inside `request(path, init)`), and a two-function JSON helper
  (`http.getJson(url)`, `http.postJson(url, body)`) called with literal addresses;
- Node's global `fetch` in the main process with a constant and with a concatenation that ends in
  a query string built from `URLSearchParams`;
- `EventSource` and `WebSocket` with a template on a constant, `new URL("/oembed", base)` with
  query parameters, `fetch` with `PUT` and `HEAD`;
- look-alikes: `shell.openExternal` from a menu and from `will-navigate`, an address put on the
  clipboard, a markdown link in a welcome note, a placeholder text, a tooltip, a log message,
  unused constants, a comment.

Storage

- electron-store through `tsc`'s default-import interop (`new electron_store_1.default(...)`),
  with a delete at start and keys read and written inside a handler table;
- localStorage through a small wrapper that puts a prefix in front of the name
  (`prefs.get("theme")` reads `inkwell.theme`), keys from constants of a helper module, a
  sessionStorage key in a constant of the same file;
- IndexedDB opened with a name and version from constants, and an old database deleted;
- look-alikes: a `Map` used as a memo, object store names, query parameters, the bare names given
  to the wrapper, the prefix alone, the store's file name, a field of a stored object.

## What a reader must know to trust the ground truth

- **Truth, not detectability.** An expectation is present when the program does the thing, also
  through a helper, a router, a spread, a table or a constant from another file. It is absent
  when it only looks like a finding; every absent entry says why.
- **File attribution.** Roles are attributed to the entry files (`main.js`, `preload.js`,
  `renderer*.js`). The helper modules contain no IPC call, no window or view, no bridge call, no
  request and no storage access of the listed kinds (the IpcRouter class and the window helpers
  are written in `main.js`, the API client and the `http` and `prefs` helpers in `renderer.js`),
  so the attribution is the same for the plain input and for the bundles. A window setting is
  attributed to the file that creates the window (`main.js`), also where its value is written in
  a helper module.
- **Window settings.** Only `preload`, `contextIsolation`, `nodeIntegration` and `sandbox` are
  listed: one entry per window or view and key that the code writes, directly or through the
  defaults a helper merges in. Keys the code does not write are not listed with Electron's
  defaults (Inkwell's settings window writes two keys). The preview `WebContentsView` is listed
  like a window. The Inkwell editor window's `sandbox` is `unsafePlugins ? false : true` and
  follows the user's settings file at run time; it is not listed, and the absent entries say that
  no fixed `sandbox: false` exists and how many fixed `sandbox: true` exist.
- **Requests through the app's own helpers.** Each request made through `ApiClient` or `http` is
  listed with the address it goes to; the `fetch` inside those helpers is not counted as
  unreadable, because every caller passes a literal (or a template that starts with one). This
  differs from the earlier sets, which avoided such helpers; a tool that does not follow them
  will report the known leading part (`https://api.cadence.example/v2`) or an unknown address
  instead. The `unreadable` count (1 per app) is a `fetch` whose address is a run-time value
  everywhere in the program (`episode.enclosureUrl`, a link from the note).
- **Storage the format has no kind for.** Inkwell's main process keeps its settings in a JSON
  file through its own class `SettingsFile`, not through electron-store. Its keys are listed
  neither as present nor as absent. `audio.src = track.path` (a local file) is not a request.
- **A member whose channel is made at run time.** `plugins.onEvent` listens on
  `plugin:${pluginId}:event`; it is listed as a member with `channel: null` and a why that says
  so, and `plugin:` is an absent channel, as `corpus/holdout` records run-time names.
- **Platform.** Inkwell's `file:opened` is sent only after the app's `open-file` event, which
  macOS emits; it is listed as present, with that remark.

## What was verified, and how

- `node corpus/build.mjs` builds all three cases without errors (every edit of `changes.json`
  matches exactly once).
- The bundled and the minified `main.js` and `preload.js` of both apps were extracted and run in
  Node against stand-ins for Electron and electron-store (a scratch script outside the
  repository, not kept). The registered channels, the channels invoked or listened to by each
  exposed member, the exposed members, the web preferences of every window and view (after the
  helpers' merges), the electron-store accesses at start and the main process's start-up request
  were exactly the expected ones, and the same for both bundles.
- The commented-out look-alikes (`library:remove-folder`, `dev:reload`, `legacy-feed`,
  `inkwell.legacyTheme`, `v0/changelog`) are absent from both bundles; every expected channel
  name, storage key and address host is still present as a string in the bundles.
- v2: the derived sources minus their 20 comment lines differ from v1 in exactly `main.js`,
  `preload.js`, `renderer.js` and `config/endpoints.js`; the v2 `main.js` and `preload.js` were
  bundled and run the same way, and the differences from v1 were exactly `vault:rename` added,
  `app:set-title` removed, `inkwell.renameNote` added, `inkwell.setTitle` removed, and the
  settings window's `sandbox` going from `true` to `false`.
- Requests and storage of the renderers, and the main-to-renderer sends inside handlers, were
  checked by reading every line of the sources, and `new URL(...)` results with node.

Not verified: how a scorer reads these files. `corpus/score.mjs` was not read, so the meaning it
gives to repeated window settings, to `count`, to `channel: null` for a member, to a view's
settings and to prefix strings in the compare lists is taken from the earlier sets' files alone.

## Toolchain

| Tool           | Version                           |
| -------------- | --------------------------------- |
| node           | v25.2.1                           |
| esbuild        | 0.28.2 (pinned in `package.json`) |
| @electron/asar | 4.3.1 (pinned in `package.json`)  |

Build from the repository root:

```
node corpus/build.mjs
```
