# Fifth hold-out set of the corpus

Ground truth held back from tool development, written after `corpus/holdout4` to measure the
analyzer on code it has never seen. Each case has sources and an `expected.json` that states what
the program does. The expectations were written by reading the sources in this directory, without
access to any analysis tool's detectors, source code or output.

Author: an independent test-case author (Claude Opus 5.5, a coding agent working for Maxi), on
2026-10-17, on the branch `sprint/e-fixtures`.

License: MIT, written for this corpus. The code is original and copies no real product.

## Access rules that were followed

Read outside this directory, and nothing else:

- `corpus/README.md` (what the corpus is and which classes are scored);
- `corpus/build.mjs` and `corpus/cases.mjs` (how cases are built and loaded);
- `corpus/holdout4/README.md` and `corpus/holdout4/kanban-board/expected.json` (the layout and the
  format of `expected.json`).

Seen as directory listings only: `corpus/holdout4/` (`kanban-board/`, `kanban-board-v2/`,
`README.md`) and `corpus/holdout4/kanban-board/` (`src/`, `expected.json`). Not opened:
`corpus/holdout4/kanban-board-v2/` (so neither its `changes.json` nor its `expected.json`), the
sources of holdout4 and of every other set, and anything under `packages/`, `e2e/`, `scripts/`,
`docs/`, `site/`, `corpus/results/`, `corpus/compare/` and `corpus/round*/`. No analysis tool was
run (no `hexvero`, no `npm run`, nothing from `packages/`), and the web was not searched for it.
`corpus/build.mjs` was not run, so no input of this set has been built yet.

The only programs run were `node --check` on every source and four scratch scripts kept outside
the repository:

1. one that writes the v2 edits into `tidemark-v2/changes.json`, asserting that each `find` matches
   exactly once;
2. a copy of `derive()` from `corpus/build.mjs` that applies `changes.json` to `tidemark/src`. Its
   output was compared with `diff -r` against a v2 tree edited separately, and the two are
   identical;
3. a harness that runs `main.js` and both preloads of v1 and of the derived v2 in Node, against a
   stand-in for the `electron` module, a stub `fetch` and `TIDEMARK_DIAG_CHANNEL` set to a test
   value. It prints every `ipcMain` registration, `webContents.send`, `event.reply`,
   `new BrowserWindow` (with its merged `webPreferences`), request and exposed member (with the
   channel it uses), each with its stack of `file:line`;
4. a generator that writes both `expected.json` files from facts I wrote down by hand. It looks
   up each line number by a piece of text that must occur exactly once in the named file. Every
   line in `interfaceLinks` and `unchangedMoves` was then compared with the harness output, and
   they all agree.

Two files outside this directory were changed, both of them files I was allowed to read, and in
the way `corpus/holdout4/README.md` describes: `"holdout5"` was added to the list of sets in
`corpus/build.mjs` and to the default of `loadCases()` in `corpus/cases.mjs`.

## Cases

| Case                           | Sources                                                | Inputs (`corpus/built/holdout5/`, not built yet)                         |
| ------------------------------ | ------------------------------------------------------ | ------------------------------------------------------------------------ |
| `tidemark` (kind `electron`)   | `tidemark/src/`                                        | `tidemark.plain.asar`, `tidemark.bundled.asar`, `tidemark.minified.asar` |
| `tidemark-v2` (kind `compare`) | `tidemark-v2/changes.json`, applied to `tidemark/src/` | `tidemark-v2.plain.asar`                                                 |

**tidemark** is "Tidemark", an editor for release notes. You keep drafts locally, preview them,
export them, and publish them to a hosted service. It has three windows, all created in
`main/windows.js`:

- `editorWindow`, with `preload.js` and the page `index.html` / `renderer.js`. Its options are
  built with `Object.assign({}, BASE_PREFS, {...})` and set `sandbox: false` and
  `webSecurity: false`.
- `previewWindow`, the instance of `class PreviewWindow`, with `preload-preview.js` and the page
  `preview.html` / `renderer-preview.js`. Its options are a class field
  `{ ...BASE_PREFS, preload }`.
- `helpWindow`, with no preload and the page `help.html`. Its `webPreferences` is a literal.

The main process is split into `main.js` and the modules in `main/`:

- `ipc-router.js`: `class IpcRouter`, a wrapper around `ipcMain`.
- `handlers.js`: every channel registered through the router.
- `windows.js`: the three windows.
- `publish.js`: publishing a draft, with `webContents.send` of the progress.
- `remote.js`: the requests to the service.
- `store.js`: the JSON files.
- `format.js`: the export formats.

`shared/channels.js` holds the channel constants and `exportChannel`. The renderer is laid out the
way a bundle's sources would be: `renderer.js` imports `renderer/state.js`,
`renderer/web-store.js` and `renderer/contributors.js`.

The case has 20 files with 930 lines: 15 JavaScript files with 834 lines, plus `package.json`,
`index.html`, `preview.html` and `help.html`. By file:

| File                       | Lines |
| -------------------------- | ----- |
| `renderer.js`              | 234   |
| `main/windows.js`          | 96    |
| `main.js`                  | 73    |
| `main/handlers.js`         | 68    |
| `main/store.js`            | 51    |
| `main/format.js`           | 46    |
| `main/remote.js`           | 41    |
| `preload.js`               | 41    |
| `main/ipc-router.js`       | 40    |
| `renderer-preview.js`      | 31    |
| `shared/channels.js`       | 27    |
| `main/publish.js`          | 25    |
| `renderer/state.js`        | 25    |
| `renderer/web-store.js`    | 15    |
| `renderer/contributors.js` | 12    |
| `preload-preview.js`       | 9     |

**tidemark-v2** is tidemark after 30 listed edits, without prepended comment lines. The expected
differences are:

- **Channels:** `release:duplicate` and `export:text` are added; `release:delete` and
  `editor:dirty` are removed.
- **Bridge members:** `tidemark.duplicateRelease` and `tidemark.exportText` are added;
  `tidemark.deleteRelease` and `tidemark.markDirty` are removed.
- **Window settings:**
  - `previewWindow` `sandbox` changes from true to false (more permissive), so that
    `preload-preview.js` can now require `shared/channels.js`.
  - `editorWindow` `webSecurity` changes from false to true (more restrictive), because the
    override was dropped and the value now comes from `BASE_PREFS`.
- **Endpoints:** one address on a new external host is added,
  `https://api.lingoflow.example/v1/translate` (POST).
- **Storage:** no change.

These are not differences and are listed in `unchangedMoves` or under `changes.*.absent`:

- In `main.js`, the `preview:ping` listener was cut and pasted above the `preview:open` listener.
- In `main/handlers.js`, the settings handlers moved to the top of `registerHandlers`.
- The member `platform` moved from the first to the last member of `preload.js`'s object.
- `applyFontSize` moved in `renderer.js`.
- `preload-preview.js` now names `preview:render` through `CHANNELS.PREVIEW_RENDER` instead of the
  literal. It is the same channel.
- Every line shift.

There is one trap: `export:text` is added without any change to its registration line
(`main/handlers.js` 37, the loop). Only the literal array in `shared/channels.js` changed.

## Idioms this set uses

IPC

- **A wrapper class around `ipcMain`.** `IpcRouter.handle(channel, fn)` and `.on(channel, fn)`
  call `ipcMain.handle` and `ipcMain.on` inside the class (`main/ipc-router.js`). The channels are
  attached in another module (`main/handlers.js`), and the router instance is created in a third
  (`main.js`).
- **Channel names from a frozen constants module** (`CHANNELS.RELEASES_LIST`), which is required
  by the main process and by the unsandboxed preload.
- **Channels from a helper applied in a loop over a literal list.** `for (const format of
  EXPORT_FORMATS) router.handle(exportChannel(format), ...)` registers `export:markdown`,
  `export:html` and `export:json` (plus `export:text` in v2) from one call site. In the preload,
  `exportMarkdown: call(exportChannel("markdown"))`. `export:json` has a receiver and no sender.
- **A curried preload helper.** `call(channel)` returns `(...args) => ipcRenderer.invoke(channel,
  ...args)` and unwraps `{ ok, value }`. The members are `listReleases: call(CHANNELS.X)`, and the
  exposed object is the variable `api`, which `exposeInMainWorld("tidemark", api)` exposes.
- **`webContents.send` back to the renderer** from a module other than the one that created the
  window. `main/publish.js` sends `publish:progress` on a webContents handed in by the handler,
  and `main/handlers.js` sends `preview:render` to the preview window from inside the
  `preview:update` listener.
- **`event.reply`.** `preview:ping` is answered with `preview:pong`, and the preview preload
  listens with `ipcRenderer.once`.
- **A channel whose name is known only at run time:** `process.env.TIDEMARK_DIAG_CHANNEL`, read
  on both sides. Nothing in the source gives a fixed part of it (see the format note below).
- **Look-alikes:**
  - an unused exported constant `sync:legacy-pull`;
  - a comment naming `release:archive`;
  - a disabled menu item with `id: "export:pdf"`;
  - a DOM `CustomEvent("release:changed")`;
  - the template prefix `export:` and the array elements;
  - the router's name `editor`;
  - stage values and a telemetry event name;
  - the environment variable's name;
  - window, app and DOM events.

Window settings

- `Object.assign({}, FROZEN_BASE, overrides)` in a function, then passed in shorthand
  (`{ ..., webPreferences }`).
- A class field `webPreferences = { ...BASE_PREFS, preload: ... }`, read as `this.webPreferences`
  in a method.
- A plain literal.
- Look-alike: `HARDENING` in `renderer.js`, an object with the same keys that is only displayed.

contextBridge

- Two APIs. `tidemark` is built in a variable, mostly from a helper, and has two members without a
  channel (`platform`, a value, and `sendDiagnostics`, which uses the run-time channel).
  `preview` is an inline literal in a sandboxed preload that uses literal channel names.

Requests

- **Main process:**
  - a template on a module constant, giving a prefix;
  - a POST to `${API_BASE}/releases`;
  - `fetch(new Request(TELEMETRY_URL, { method: "POST" }))`, where `TELEMETRY_URL = new URL("/v1/events", origin).href`;
  - a literal update feed.
- **Renderer:**
  - `fetch(new URL(\`repos/${repo}/contributors\`, CODE_API))`, where the relative path keeps
    `/api/v1/`;
  - a template prefix in the preview;
  - one HEAD request to whatever link the author wrote (unreadable).
- **Look-alikes:**
  - an unused staging constant;
  - `shell.openExternal`;
  - the API base shown as text;
  - the base given to `new URL`;
  - the wrong reading of the relative URL;
  - an HTML placeholder;
  - `loadFile`.

Storage

- Two JSON files in `userData`, each read and written whole (kind `file`, as in holdout4).
- localStorage and sessionStorage keys made by a helper in `renderer/web-store.js`. The helper
  writes `` `${PREFIX}${name}` `` with `PREFIX = "tidemark."`, and `renderer.js` passes a
  constant. One key is also removed.
- A plain localStorage key in the preview.
- Look-alikes:
  - the bare names given to the helper;
  - the prefix;
  - fields of the settings file;
  - the `app.getPath` argument;
  - a drag-and-drop format;
  - a header;
  - a query parameter.

## What a reader must know to trust the ground truth

- **Truth, not detectability.** An expectation is present when the program does the thing, also
  through a wrapper class, a curried helper, a loop or a class field. It is absent when it only
  looks like a finding, and every absent entry says why.
- **File attribution (differs from holdout4).** holdout4 kept every fact in entry files. This set
  deliberately splits the main process and the renderer into modules, so facts are attributed to
  the source file a reader sees them in:
  - Receivers of router channels name `main/handlers.js`, where the channel is attached.
  - `interfaceLinks` ends give the `ipcMain` call in `main/ipc-router.js` as `file`/`line`, plus
    `entryFile`/`entryLine` for the `router.handle` / `router.on` call. `entryFile` is new; in
    holdout4 the helper and its caller were in the same file.
  - All window settings name `main/windows.js`.
  - The sender of `publish:progress` is `main/publish.js`.
  - `endpoints` and `storage` carry no file, as in holdout4.

  The bundled and minified inputs merge these modules into their entry file, so each
  `expected.json` has a top-level `bundledFiles` map from module to entry file. Before scoring
  those two inputs, a scorer must apply this map; line numbers apply only to the plain inputs.

- **The run-time channel.** The holdout4 format lists such a channel as an absent entry under a
  fixed prefix (`zoom:`). Here no fixed part exists. `ipcChannels` therefore gets a field
  `unknown: 1` with `unknownWhy`, modelled on `endpoints.unreadable`. The environment variable's
  name is listed as absent, because naming the channel with it is wrong. The bridge member
  `sendDiagnostics` has `channel: null`, and its interface link has `resolvable: false`.
- **Window settings.** The keys are `preload`, `contextIsolation`, `nodeIntegration`, `sandbox`,
  `webSecurity` and `allowRunningInsecureContent`. There is one entry per window and key that the
  code writes, with `window` naming the variable; for the class, that is the instance
  `previewWindow`. `count` in an absent entry follows holdout4: one more than the number of windows
  that have that value.

## Format questions (not settled, because the v2 format of holdout4 was not read)

- `tidemark-v2/expected.json` has kind `compare`, `inputs` (the v2 plain input) and `base` (the v1
  plain input). Its `expect` holds the full v2 facts in the same classes as v1, and also:
  - `changes`: per class, `added` / `removed` (or, for `webPreferences`, `changed` with `from`,
    `to` and `direction`) and `absent`, meaning items that must not be reported as a change;
  - `unchangedMoves`: `file`, `fromLine`, `toLine`, `what`. Some entries keep the same line on
    purpose, as a guard against reporting them as changes.

  I designed this structure from the holdout4 README's description, not from its file. If
  holdout4's v2 file uses other field names, the content maps one to one.

- These fields are new: `ipcChannels.unknown` / `unknownWhy`, `ends[].entryFile`, and top-level
  `bundledFiles`. A scorer that does not know them should ignore them, rather than count the
  run-time channel as missed.

## Building

`corpus/build.mjs` (with `holdout5` added to its list) packs `tidemark/src` as written. It also
bundles `main.js`, `preload.js` and `preload-preview.js` for Node, and `renderer.js` and
`renderer-preview.js` for the browser, then copies `package.json` and the HTML pages. The
`main/`, `shared/` and `renderer/` modules are bundled into those entry files. `tidemark-v2` is
derived from `changes.json` and packed plain. None of this has been run.

## Toolchain

| Tool | Version                                             |
| ---- | --------------------------------------------------- |
| node | v25.2.1 (for `node --check` and the scratch checks) |

## Scoring

Added by the evaluator (agent H of the 10-hour sprint, 2026-10-17) before the first measurement
and without looking at any tool output on this set. The scorer was then frozen; the measurement
is in `corpus/results/round4/`. Every change is generic (no case, channel or file name of this set
appears in the code) and leaves the rows of all other sets unchanged: rescoring the committed
`corpus/results/hexvero.observations.json` gives the committed `hexvero.json` rows byte for byte.

- **`base` and `inputs` of the comparison case** (`corpus/cases.mjs`). A `compare` case without
  `a`/`b` takes `a` from `base` and `b` from its single input.
- **`changes`** (`corpus/cases.mjs`). Turned into the `expect.compare` strings the scorer already
  uses: a channel, `api.member`, `key: from -> to` for a changed window setting (the window and
  `direction` are not compared, as in holdout4, because the observation names only the key and
  the two values), the address or its `prefix` (a reported address that starts with it counts),
  `kind value` for storage. `changes.*.absent` needs no rule: the change lists are scored
  exhaustively, so every reported change beyond the expected ones is false, the absent entries
  among them.
- **`unchangedMoves`** is not read by the scorer. Its entries are prose (`what`) and cannot be
  matched to a reported change mechanically; exhaustive scoring of the change lists already
  counts a move reported as a change as false. Which false change (if any) belongs to which move
  is read by hand in `corpus/results/round4/README.md`.
- **The v2 single-build facts** (`corpus/score.mjs`, `corpus/observe-hexvero.mjs`). A `compare`
  case that also lists single-build classes has its `inputs` observed and scored like an Electron
  case, so `tidemark-v2.plain.asar` gets the same rows as the v1 inputs.
- **`bundledFiles`** (`corpus/score.mjs`). For an input that is not the plain build, the file of
  an expected sender, receiver or window setting is mapped through it before comparison. The
  entry of `shared/channels.js` names several files (`"main.js, preload.js (and
  preload-preview.js in v2)"`); a module merged into more than one entry file keeps its own name.
  No scored fact names `shared/channels.js`, so this has no effect here. Line numbers are not
  scored in any class.
- **`ipcChannels.unknown`** (`corpus/score.mjs`, `corpus/observe-hexvero.mjs`). The observer now
  also records IPC calls the tool lists without a channel (`ipcUnreadable`, with their places).
  A new row, _IPC channels with an unknown name shown_, counts all `unknown` channels as hit when
  the tool shows at least one such call and as missed when it shows none (one false when a case
  has `unknown: 0` and the tool shows some). Calls cannot be grouped into channels without
  knowing the name, so the row asks only whether the tool says that a channel it cannot name
  exists; the number and places of the calls are in the notes. The channel list itself is scored
  as before: a name the tool invents for this channel (the environment variable's name) is false.
- **`ends[].entryFile`** is not read: `interfaceLinks` is not a scored class in any set (holdout3
  and holdout4 included), and adding it would be a new class rather than a reading of this one.
- **Window settings** need no change: the scorer already scores every key a case lists, which
  here includes `webSecurity` and `allowRunningInsecureContent`. `count` in absent entries is not
  read (as for holdout4); every reported value beyond the expected multiset is false.
- **`holdout5` in the scorer's default sets**, matching `loadCases()`.

The observer also gained `--core <dir>`, which loads `dist/` of another `packages/core` (an older
commit in its own worktree) and reads the version and commit from there.
