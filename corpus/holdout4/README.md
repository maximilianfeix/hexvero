# Fourth hold-out set of the corpus

Ground truth that is held back from tool development, written after `corpus/holdout3` to measure
the analyzer on code it has never seen. Each case has sources and an `expected.json` that states
what the program does. The expectations were written by reading the sources in this directory,
without access to any analysis tool's detectors, source code or output.

## Access rules that were followed

Read, outside this directory, and nothing else:

- `corpus/build.mjs` and `corpus/cases.mjs` (how cases are built and loaded);
- `corpus/holdout3/README.md`, `corpus/holdout3/podcast-player/expected.json`,
  `corpus/holdout3/podcast-player-v2/changes.json`,
  `corpus/holdout3/podcast-player-v2/expected.json` (the format of `expected.json` and
  `changes.json`, and the idioms holdout3 already uses, so that this set uses others);
- `corpus/holdout2/README.md` (format and idioms only).

Directory listings of `corpus/`, `corpus/holdout2/` and `corpus/holdout3/` were seen; no other
file was opened. The sources of holdout3, holdout2 and every other set were not opened. Not
read: anything under `packages/`, `e2e/`, `scripts/`, `docs/`, `examples/`, `site/`,
`corpus/results/`, `corpus/compare/`; `corpus/score.mjs`, `corpus/gate.mjs`,
`corpus/observe-*.mjs`, `corpus/README.md`, the root `README.md`, `CHANGELOG.md`. No analysis
tool was run on these sources, and the web was not searched for the analyzer.
`corpus/build.mjs` was not run, so no input of this set is built yet (see Building). The only
programs run were `node --check` on the sources and four scratch scripts outside the repository:
one applies `changes.json` the way `derive()` in `corpus/build.mjs` does, one runs `main.js` and
both preloads of v1 and of the derived v2 in Node against a stand-in for the `electron` module
and prints every registration (with its line), every window's merged `webPreferences` and the
channel of every exposed member, one checks that every line number in `interfaceLinks`,
`unchangedMoves` and the shifted lines named in the v2 file points at the call it names, and
`node -e` with `new URL(...)` to confirm the two addresses built from `SYNC_BASE`.

License: MIT, written for this corpus. The code is original and copies no real project.

## Cases

| Case                               | Sources                                                        | Inputs (`corpus/built/holdout4/`, not built yet)                                     |
| ---------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `kanban-board` (kind `electron`)   | `kanban-board/src/`                                            | `kanban-board.plain.asar`, `kanban-board.bundled.asar`, `kanban-board.minified.asar` |
| `kanban-board-v2` (kind `compare`) | `kanban-board-v2/changes.json`, applied to `kanban-board/src/` | `kanban-board-v2.plain.asar`                                                         |

**kanban-board** is "Lattice", a kanban board with a board window (`boardWindow`, preload
`preload.js`, page `renderer.js`), an activity feed docked in it as a `BrowserView`
(`activityView`, preload `preload-activity.js`, page `renderer-activity.js`), a legacy importer
for Trello exports (`importWindow`, no preload, `nodeIntegration: true`, `contextIsolation:
false`, page `renderer-import.js`) and an offscreen window that prints the board to PDF
(`printWindow`, a local of `savePdf`, no preload, a `data:` page). `main.js`, both preloads and
the modules in `lib/` are CommonJS; `renderer.js` and `renderer-activity.js` are ES modules;
`renderer-import.js` is a classic script that uses `window.require`. Helper modules:
`lib/channels.js` (`defineChannels` and the channel objects it returns), `lib/window-factory.js`
(`makeWindow` and its defaults), `lib/board-model.js` (pure board functions). 13 files: 9
JavaScript files with 920 lines (`main.js` 361, `renderer.js` 216, `lib/board-model.js` 101,
`renderer-activity.js` 58, `preload.js` 53, `renderer-import.js` 53, `lib/window-factory.js` 38,
`lib/channels.js` 26, `preload-activity.js` 14), plus `package.json`, `index.html`,
`activity.html` and `import.html` (1007 lines in all). It has 19 IPC channels plus one whose name
is chosen at run time, 16 window settings in three windows and one view, 22 bridge members in
three APIs with 22 interface links (20 resolvable, 2 not), 7 addresses plus 1 request with an
unknown address, and 6 storage entries, each class with look-alikes that must not be reported.

**kanban-board-v2** is kanban-board after fourteen listed edits, without prepended comment
lines. The expected differences: one channel and one bridge member added (`board:export`,
`lattice.exportBoard`), one channel and one member removed (`board:archive`,
`lattice.archiveBoard`), the activity view's `sandbox` turned off (more permissive) and the
importer's `allowRunningInsecureContent` turned off (more restrictive), one address added
(`https://api.lattice.example/v1/changelog`) and one sessionStorage key removed
(`lattice.scrollTop`). Not differences: the `import:open` listener cut and pasted further down
`registerIpc` (line 171 to 214), the renderer's archive button now calling `exportBoard`, and
every line shift. A trap: the new `board:export` handler lands on line 163, the line of the
removed `board:archive` handler, and both go through the same `ipcMain.handle` on line 92.

## Idioms this set uses

IPC

- channel names produced by a function call, `const board = defineChannels("board", ["list",
  "move", ...])`, which returns a frozen `{ list: "board:list", ... }` built with a template in
  a loop, with a dash-to-camel key (`"link-preview"` gives `card.linkPreview`,
  `"card:link-preview"`); no full channel name is written anywhere in `main.js` or `preload.js`.
  These names are recorded as resolvable: the function is pure and every argument is a literal,
  so they follow from the source text by evaluation, although not from any single string;
- handlers registered by a curried, decorator-like helper, `handle(board.list)(async () =>
  ...)`, with `ipcMain.handle` inside the helper (11 channels go through one call site);
- a class whose constructor registers `ipcMain.on` for every channel of an array
  (`new LaneListeners(LANE_CHANNELS, boardStore)`), and that compares the channel inside;
- `webContents.send` through an EventEmitter bridge: `forward("board-changed", board.changed,
  () => boardWindow)` subscribes to a main-process bus and sends on every emit, to a window and
  to a `BrowserView`; the bus event names are look-alikes;
- a bridge API built from a `Proxy` whose `get` trap invokes `card[member]`; its properties are
  read into the exposed object at expose time (`create: cardRemote.create`). Recorded as
  resolvable (the property names are literals), with the reason in each entry;
- a channel no static reading can name, `` `zoom:${crypto.randomUUID()}` ``, handed to the
  preload through `webPreferences.additionalArguments` and read from `process.argv`; both the
  listener member and the sender member are `channel: null`, `resolvable: false`;
- an IPC sender in a page rather than a preload: `window.require("electron").ipcRenderer.invoke`
  in the importer page with `nodeIntegration`;
- a preload member written in method shorthand (`onPush(listener) { ... }`) and `ipcRenderer.off`;
- look-alikes: a `BroadcastChannel("lattice-tabs")`, keyboard command ids in a keymap
  (`board:focus-search`, `card:new-inline`), a channel in a comment (`board:export`, real in v2),
  the fallback `zoom:none`, the arguments of `defineChannels`, a command-line flag, an
  EventSource event type, values sent on a channel, a log message, window, app and DOM events.

Window settings

- a factory `makeWindow({ preload, sandbox, ...more }, frame)` in a helper module that spreads
  frozen defaults, then the caller's rest object, then writes `preload` and
  `sandbox: sandbox ?? DEFAULT.sandbox`; one window passes `sandbox: false`, another passes only
  `webSecurity: false` (so it gets `sandbox: true` from `??` and `webSecurity: false` from the
  rest spread, and `preload: undefined`, which is no preload);
- a `BrowserView` with its own `webPreferences` literal;
- one window with `nodeIntegration: true`, `contextIsolation: false`, `webSecurity: false` and
  `allowRunningInsecureContent: true`. `allowRunningInsecureContent` is a sixth key (holdout3
  listed five).

contextBridge

- three APIs: an object literal with 15 members, an object of Proxy-read functions, and a
  sandboxed preload's literal with a shorthand method and a value member;
- members that are values (`version`, `locale`), listed with `channel: null` and no ends.

Requests

- main process: `fetch(new URL("boards/<id>", BASE), { method: "PUT" })` (relative path keeps
  `/api/`) and `fetch(new URL("/health", BASE))` (leading slash drops it; the wrong reading is an
  absent entry), a GraphQL POST, and Electron's `net.fetch` of a pasted link (unreadable);
- renderer: an axios-style client made by `createClient({ baseURL })` with `client.get("/x")`
  and `client.post("/y", body)`, an `EventSource` with a template on a constant, and a plain
  `http://` fetch in the importer;
- look-alikes: `shell.openExternal`, an unused constant, the cookie's url (an origin), an SVG
  `xmlns`, a placeholder in HTML, a `data:` URL loaded into a window, `loadFile`.

Storage

- the app's own JSON settings file read and written whole with `fs` in `main.js`, recorded as
  kind `file` with the file name as value; its fields are absent entries;
- a cookie set, read and removed through `session.defaultSession.cookies`, kind `cookie`;
- two sessionStorage keys, one localStorage key in the view, IndexedDB with a name and version
  from constants;
- look-alikes: the object store, the save dialog's default file name, `app.getPath`'s argument,
  request headers, a drag-and-drop data format, a query parameter.

## What a reader must know to trust the ground truth

- **Truth, not detectability.** An expectation is present when the program does the thing, also
  through a factory, a decorator, a constructor loop, a Proxy, an event bus or a value received
  at run time. It is absent when it only looks like a finding; every absent entry says why.
- **File attribution.** Roles are attributed to the entry files. The `lib/` modules contain no
  IPC call, no window, no bridge call, no request and no storage access; `makeWindow` only
  returns an object that `main.js` passes to `new BrowserWindow`. A window setting is attributed
  to `main.js`, also where its value comes from `lib/window-factory.js`.
- **interfaceLinks.** As in holdout3: one entry per bridge member with `api`, `member`,
  `channel`, `preload`, `memberLine`, `ends`, `resolvable`. A receiver or sender reached through
  a helper has the line of the call inside the helper as `line` and the line where the channel
  is handed to the helper as `entryLine` (the `handle(...)` call, the `LANE_CHANNELS` array, the
  `forward(...)` call). This means many links share `line` 92 and differ only in `entryLine`.
- **Window settings.** Keys `preload`, `contextIsolation`, `nodeIntegration`, `sandbox`,
  `webSecurity`, `allowRunningInsecureContent`; one entry per window or view and key the code
  writes, with `window` naming the variable. `additionalArguments` is written for the board
  window but is not a listed key. `count` in an absent entry follows holdout2 and holdout3.
- **Format additions.** Storage kinds `file` (the app's own settings file) and `cookie`
  (Electron's cookie store); the window setting `allowRunningInsecureContent`. The README of
  holdout2 says its JSON settings file was listed neither as present nor absent; this set lists
  it, under a kind of its own, because the program does store its settings there. A scorer that
  knows no `file` or `cookie` kind should leave those two entries out rather than count them
  missed.

## Building

`corpus/build.mjs` was not modified (this set may change no file outside `corpus/holdout4/`) and
was not run. As read, `bundle()` builds `main.js` and every `preload*.js`, so the bundled and
minified inputs contain both preloads, and `expected.json` lists all three inputs. Before these
cases can be scored, add `"holdout4"` to the list of sets in `corpus/build.mjs` (`for (const set
of ["dev", "validation", "holdout", "holdout2", "holdout3"])`) and to the default of
`loadCases()` in `corpus/cases.mjs`.

Not verified: how a scorer reads these files. `corpus/score.mjs` was not read, so the meaning it
gives to the new kinds and key, to `entryLine` shared by many links, and to `unchangedMoves` is
as stated here only. The bundles were not built, so `renderer-import.js` (which uses
`window.require`, not `require`, so that esbuild leaves it alone) was checked by reading only.

## Toolchain

| Tool | Version                                             |
| ---- | --------------------------------------------------- |
| node | v25.2.1 (for `node --check` and the scratch checks) |

## Blind result

Measured once at 09:05 CEST on 2026-10-15, with `main` at `806a6b5` (the analysis of hexvero
0.7.3; the only later analyzer change touched `compare`), after the expectations were committed
(`514345e`) and before any change was made because of this set. Totals over the plain, bundled
and minified builds:

| Class                                | Hit | Missed | False |
| ------------------------------------ | --- | ------ | ----- |
| IPC channels                         | 12  | 45     | 0     |
| IPC senders and receivers            | 18  | 6      | 0     |
| window settings                      | 36  | 12     | 4     |
| bridge members                       | 66  | 0      | 0     |
| bridge member channel                | 21  | 45     | 0     |
| endpoints                            | 12  | 9      | 0     |
| requests with an unknown URL shown   | 3   | 0      | 5     |
| storage keys                         | 12  | 6      | 0     |
| changes in ipcChannels (plain v1→v2) | 0   | 2      | 0     |
| changes in contextBridge             | 2   | 0      | 0     |
| changes in webPreferences            | 2   | 0      | 0     |
| changes in endpoints                 | 0   | 1      | 0     |
| changes in storage                   | 1   | 0      | 0     |

The four false window settings are the defaults object of `lib/window-factory.js`, reported in
that file without a window instead of as settings of the windows `main.js` creates through the
factory. Channels built by `defineChannels(...)` were not read, which is most of the missed IPC
channels and bridge channels. From this point on the set counts as a development set.
