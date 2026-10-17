# Sixth hold-out set of the corpus

This set's ground truth was held back from tool development. It was written after
`corpus/holdout5` so the analyzer can be measured once, blind, on code it has never seen. Each
case has sources and an `expected.json` that states what the program does. I wrote the
expectations by reading the sources in this directory. I had no access to any analysis tool's
detectors, source code or output.

Author: an independent test-case author (Claude Opus 5.5, a coding agent working for Maxi, role
"E6"), on 2026-10-17, on the branch `sprint/e6-holdout6` (from `main` at `b431ae3`).

License: MIT, written for this corpus. The code is original and copies no real product.

## Access rules that were followed

I read these files outside this directory, and nothing else:

- `corpus/README.md`: what the corpus is and which classes are scored.
- `corpus/holdout5/README.md`: the layout and the conventions to follow.
- `corpus/holdout5/tidemark/expected.json`, `corpus/holdout5/tidemark-v2/expected.json` and
  `corpus/holdout5/tidemark-v2/changes.json`. I used them as a format reference only. I did not
  copy their application or their idioms. For the v2 `expected.json` I printed its top-level
  fields, `changes` and the start of `unchangedMoves`.
- `corpus/build.mjs`, `corpus/cases.mjs` and `corpus/score.mjs`: how cases are built, loaded and
  scored, and the neutral observation format the scorer reads.

I saw two directories as listings only: `corpus/` and `corpus/holdout5/`. I did not open the
sources of holdout5 or of any other set. I opened nothing under `packages/`, `docs/`, `site/`,
`scripts/`, `e2e/`, `skills/`, `.claude/`, `corpus/results/` or `corpus/compare/`. I did not
open `corpus/observe-hexvero.mjs`, `CHANGELOG.md` or the top-level READMEs. I ran no analysis
tool: no `hexvero`, no `npx`, nothing from `packages/`. I did not search the web for it.

The programs I ran were `node --check` on every source, `node corpus/build.mjs` and
`node corpus/build.mjs --check`, `node corpus/score.mjs` on two hand-made observation files, and
these scratch scripts, kept outside the repository:

1. `write-changes.mjs` writes `snapdeck-v2/changes.json`. It asserts that each `find` matches
   exactly once, applying the edits in order.
2. `derive.mjs` is a copy of `derive()` from `corpus/build.mjs`. It produced the v2 tree that the
   v2 line numbers were taken from.
3. `harness.cjs` runs the app in Node against a stand-in for the `electron` module and a stub
   `fetch`. It covers `main.js`, a capture, a share with a webhook set, a delete, and all three
   preloads. It prints each event with its stack of `file:line`:
   - every `ipcMain.handle` / `on` / `once` registration and `webContents.send`;
   - every `new BrowserWindow`, with its merged `webPreferences`;
   - every request;
   - every exposed member, with the channel it invokes, sends on or listens to.

   Results:
   - On v1, its output agrees with every IPC, window, bridge and request expectation.
   - On the derived v2, a diff of its output against v1 shows exactly the listed changes and no
     others.
   - On the extracted `snapdeck.minified.asar`, run in main-and-preloads mode, it gives the same
     sorted IPC, window and bridge facts as on the sources (identical md5).

4. `gen.mjs` writes both `expected.json` files from facts I wrote down by hand. It looks up each
   line number by a piece of text that must occur exactly once in the named file.

Scorer check without any tool output:

- `empty.observations.json` has one empty observation per input and empty change lists. The
  scorer runs and reports every item as missed, with 0 hit and 0 false.
- `perfect.observations.json` is built from the expectations themselves, with file names mapped
  through `bundledFiles` for the bundled inputs. It scores every row as hit, with 0 missed and 0
  false.

Three files outside this directory were changed, all of them files I was allowed to read, in the
same way as for holdout5: `"holdout6"` was added to the list of sets in `corpus/build.mjs`, to
the default of `loadCases()` in `corpus/cases.mjs` and to the default sets of `corpus/score.mjs`.
`corpus/README.md` gained a row in its table. `corpus/built/` gained the four inputs and their
lines in `SHA256SUMS`, and no other line there changed.

## Cases

| Case                           | Sources                                                | Inputs (`corpus/built/holdout6/`)                                        |
| ------------------------------ | ------------------------------------------------------ | ------------------------------------------------------------------------ |
| `snapdeck` (kind `electron`)   | `snapdeck/src/`                                        | `snapdeck.plain.asar`, `snapdeck.bundled.asar`, `snapdeck.minified.asar` |
| `snapdeck-v2` (kind `compare`) | `snapdeck-v2/changes.json`, applied to `snapdeck/src/` | `snapdeck-v2.plain.asar`                                                 |

**snapdeck** is "Snapdeck", a screenshot tool. You pick a region on a see-through overlay, and
the capture opens in an annotator where you draw arrows, boxes and strokes. The library window
keeps every capture, and a capture can be shared to a hosted service, with an optional webhook
the user configures. It has three windows, all created in `main/windows.js`:

- `libraryWindow`: preload `preload-library.js` (sandboxed), page `library.html` /
  `renderer-library.js`. Its options come from the helper `windowOptions(preload, prefs, extra)`,
  which spreads `SECURE_DEFAULTS` into `webPreferences`.
- `annotatorWindow`: preload `preload-annotator.js`, page `annotator.html` /
  `renderer-annotator.js`. It uses `windowOptions` with `{ sandbox: false }`, because the preload
  reads the PNG with `fs`.
- `overlayWindow`: preload `preload-overlay.js` (sandboxed), page `overlay.html` /
  `renderer-overlay.js`. Its options are a local `webPreferences` variable passed in shorthand.
  It has the deliberately permissive `webSecurity: false`.

The case has 24 files: 20 JavaScript files with 911 lines, plus `package.json` and the three
HTML pages.

| File                    | Lines |
| ----------------------- | ----- |
| `renderer-annotator.js` | 127   |
| `renderer-library.js`   | 124   |
| `main/windows.js`       | 91    |
| `main/library.js`       | 71    |
| `main/services.js`      | 56    |
| `main/menu.js`          | 44    |
| `main.js`               | 40    |
| `main/prefs.js`         | 40    |
| `renderer-overlay.js`   | 37    |
| `main/ipc.js`           | 35    |
| `main/capture.js`       | 35    |
| `preload-library.js`    | 34    |
| `preload-annotator.js`  | 32    |
| `main/updates.js`       | 32    |
| `renderer/settings.js`  | 30    |
| `shared/channels.js`    | 25    |
| `main/navigation.js`    | 19    |
| `renderer/gallery.js`   | 18    |
| `main/policy.js`        | 13    |
| `preload-overlay.js`    | 8     |

**snapdeck-v2** is snapdeck after 27 listed edits, with `prependCommentLines: 3`, so every
`.js` file starts with three comment lines. The expected differences are:

- **Channels:**
  - Added: `shot:ocr` and `annotator:modified`.
  - Removed: `library:reveal` and `annotator:dirty`.
  - The second pair is a rename: the value of `Channels.ANNOTATOR_DIRTY` changed, and both call
    sites stayed the same.
- **Bridge members:**
  - Added: `annotator.recognizeText`.
  - Removed: `snapdeck.revealShot`.
  - Changed: `annotator.setDirty` now forwards to `annotator:modified`. It is listed under
    `changes.contextBridge.changed`, which `cases.mjs` turns into `~annotator.setDirty`.
- **Window settings:** `annotatorWindow` `nodeIntegration` changes from false to true (more
  permissive).
- **Endpoints:** `https://ocr.textlens.example/v2/recognize` (POST) is added, on a new host.
- **Storage:** `localStorage snapdeck:ocrLanguage` (read, write) is added, through a new enum
  member.

These edits are not differences, and are listed under `changes.*.absent` and `unchangedMoves`:

- The `ROUTES` rows in `main/ipc.js` were reordered. The `capture:start` row moved to the top.
  With the three comment lines, that row stays on line 14, a deliberate guard.
- The constant keys `PREFS_GET` / `PREFS_SET` were renamed to `PREFERENCES_GET` /
  `PREFERENCES_SET` everywhere. The channel strings did not change.
- The overlay's `webPreferences` moved from a local variable to the module constant
  `OVERLAY_PREFS`, with the same values.
- `platform` moved from the first to the last member of `snapdeck`.
- `renderer-overlay.js` now names `overlay.lastRegion` through a constant instead of the
  literal.
- Every line shift.

## Idioms this set uses

IPC

- **A registration table.** `ROUTES` holds `{ channel, kind, fn }` rows, registered by
  `for (const route of ROUTES) ipcMain[route.kind](route.channel, route.fn)`. That is a computed
  method name with `"handle"` or `"on"`.
- **A wrapper function.** `handleSafe(channel, fn)` calls `ipcMain.handle(channel, ...)` and
  wraps the answer in `{ ok, value }`. The preload's `request(channel)` unwraps it.
- **A class that is handed `ipcMain`.** `PrefsService.register(ipc)` calls `ipc.handle(...)`,
  and `main.js` calls `prefs.register(ipcMain)`.
- **`ipcMain.once`** inside a Promise executor in `main/capture.js`, followed by
  `removeAllListeners`.
- **`webContents.send`** from three modules: `main/windows.js`, `main/capture.js` (inside
  `did-finish-load`), and `main/menu.js` to the focused window.
- **`ipcRenderer.sendSync`** with `event.returnValue`.
- **Channel constants** from `shared/channels.js`, some built as `LIBRARY + "list"`. The
  sandboxed preloads write the channel names as literals.
- **Look-alikes:**
  - an unused constant `capture:done`;
  - a comment naming `library:export`;
  - the menu item id `capture:region`;
  - a DOM `BroadcastChannel("library:refresh")` between pages;
  - the `EventEmitter` event `upload:progress`;
  - the prefix `library:`;
  - the command values sent on `menu:command`;
  - `net.request` events, webContents, window, app and DOM events.

Window settings

- A helper that returns options, with `{ ...SECURE_DEFAULTS, preload, ...prefs }`.
- A local variable passed in shorthand, after `...display.bounds`.
- Look-alike: `EXPECTED` in `main/policy.js`, which has the same keys and only checks
  `getLastWebPreferences()` in development.

contextBridge

- `snapdeck`: an `api` variable. Five of its members are made by `invokers(INVOKE)` from a table
  of member names to channels. The others are explicit members: `sendSync`, a method with
  `on` / `removeListener`, and the value `platform`.
- `annotator`: a literal inside `exposeInMainWorld`, using the helpers `request` and `listen`.
  `loadImage` exposes `fs.promises.readFile` of any path the page passes. It is more than a
  channel call (`channel: null`).
- `overlay`: a literal with literal channel names.

Requests

- Fully known:
  - `net.request(FEED_URL)`, where `FEED_URL` is a template on a module constant;
  - a POST to `${this.base}/shots`, with the base coming from a constructor default;
  - the gallery's trending URL with a query string.
- Partly known: a DELETE to `${this.base}/shots/${id}`, and the sticker CDN template.
- Unknown: a webhook POST to an address the user types in (`unreadable: 1`).
- Look-alikes:
  - the docs URL given to `shell.openExternal`;
  - the share-page URL, which is only shown and copied;
  - the bases;
  - the CSP `connect-src`;
  - the navigation allowlist prefixes;
  - an HTML link and a placeholder;
  - `loadFile`.

Storage

- Two JSON files in `userData`, each read and written whole (kind `file`, as in holdout4 and
  holdout5).
- `localStorage` through a `settings` wrapper whose keys come from a TypeScript-compiled string
  enum (`StorageKey["Theme"] = "snapdeck:theme"`). The same wrapper is also used with a key
  constant (`RECENT_COLORS`). One key is also removed.
- `sessionStorage` and `localStorage` called directly with literals.
- Look-alikes:
  - an unused enum member (`snapdeck:layout`);
  - enum member names;
  - an in-memory `Map` key;
  - fields of the prefs file;
  - the `app.getPath` arguments;
  - a drag format;
  - a header.

Navigation (extra, unscored)

- `setWindowOpenHandler` denies every window and hands an allowlisted https URL to
  `shell.openExternal`.
- `will-navigate` prevents every navigation that is not to `file://`.

## What a reader must know to trust the ground truth

- **Truth, not detectability.** An expectation is present when the program does the thing, also
  when it happens through a table, a computed method name, a helper, or a class handed `ipcMain`.
  Every absent entry says why it is absent.
- **File attribution** follows holdout5. Facts are attributed to the source file a reader sees
  them in, and `bundledFiles` maps each module to its entry file for the bundled and minified
  inputs. `shared/channels.js` and `renderer/settings.js` end up in two entry files each, and no
  scored fact names them.
- **No unknown channel.** No channel name is chosen at run time, so `ipcChannels` has no
  `unknown` field. The helpers pass parameter channels, but every call site gives a resolvable
  constant.
- **Storage is not exhaustive.** `main/library.js` also writes and deletes one PNG per capture,
  at a path made at run time (`pictures/Snapdeck/<id>.png`). No fixed key exists for it.
- **`navigation`** and **`interfaceLinks`** are extra classes. The scorer does not read them. In
  v2, line numbers are those of the derived files, including the three comment lines.

## Toolchain

| Tool                    | Version                                                       |
| ----------------------- | ------------------------------------------------------------- |
| node                    | v22.17.1 for building and scoring; v25.2.1 for `node --check` |
| esbuild, @electron/asar | as pinned in `package.json` (through `corpus/build.mjs`)      |
