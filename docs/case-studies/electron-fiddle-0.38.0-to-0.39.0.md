# Case study: Electron Fiddle 0.38.0 → 0.39.0

A check of what `hexvero compare` reports for two published builds of a real Electron app, held against the app's source at the matching git tags. Each reported change was looked up in the source, and the source diff was then searched for changes hexvero did not report. The apps were never run. The archives were only read.

**Short version:** hexvero reported no changes to IPC channels, contextBridge members, windows, webPreferences, endpoints or storage keys. For channel names, member names and window settings, the source agrees. But three real changes in these areas were not reported: a new field in an IPC payload, a new localStorage key, and a new network endpoint in a JavaScript file shipped outside the archive. Most of the "changes" hexvero did report (58 of 82) are changes in its own analysis wording, not in the code. The two reported items that do matter, a new URL and a JavaScript file that could not be read, are both real and both point at the main feature of this release.

## Why this app

- **License:** MIT ([LICENSE](https://github.com/electron/fiddle/blob/v0.39.0/LICENSE)), so short code quotes are fine.
- **Public builds:** each GitHub release ships macOS zips that contain `Electron Fiddle.app/Contents/Resources/app.asar`, and every release has a git tag.
- **IPC surface:** the app has a sizeable one: a preload that exposes `window.ElectronFiddle` (about 60 members) over `ipcRenderer.invoke/send`, an `IpcEvents` enum of channels, and one main `BrowserWindow`.
- **The release adds a feature that crosses process boundaries:** the 0.39.0 notes list "feat: add Socket Firewall integration for secure package installation" ([#1880](https://github.com/electron/fiddle/pull/1880)) and "feat: rework local builds" ([#1854](https://github.com/electron/fiddle/pull/1854)). Both touch the renderer and the main process.

**Why these versions:** `v0.38.1` is a git tag, but it has no GitHub release and no artifacts (`gh release view v0.38.1` → "release not found"). So 0.38.0 is the nearest published build before 0.39.0. The diff below therefore also includes the 0.38.1 commits, for example "fix: don't concatenate args in `addModules`" ([#1853](https://github.com/electron/fiddle/pull/1853)).

## Versions and artifacts

|                      | before (a)                                                                                                                                      | after (b)                                                                                                                                       |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| version              | 0.38.0                                                                                                                                          | 0.39.0                                                                                                                                          |
| tag → commit         | `v0.38.0` → `45c58bc7b0205489cdbcf42d2251bedd9dfa1c12`                                                                                          | `v0.39.0` → `b8a0703a63d614c32c897666593a94cf21c61590`                                                                                          |
| artifact             | [Electron.Fiddle-darwin-arm64-0.38.0.zip](https://github.com/electron/fiddle/releases/download/v0.38.0/Electron.Fiddle-darwin-arm64-0.38.0.zip) | [Electron.Fiddle-darwin-arm64-0.39.0.zip](https://github.com/electron/fiddle/releases/download/v0.39.0/Electron.Fiddle-darwin-arm64-0.39.0.zip) |
| zip size             | 117526427 bytes                                                                                                                                 | 117759874 bytes                                                                                                                                 |
| zip sha256           | `2a6ca62f16eb44c1ff4ecd01e81d79cb2cdefaa26e897bc15c88ab3d39b24c6a`                                                                              | `98206b1b49729c0bb011c3302f06bc84c1b79bd8805c908f43a8dc196eaf7fda`                                                                              |
| `app.asar` size      | 21903915 bytes                                                                                                                                  | 21928002 bytes                                                                                                                                  |
| `app.asar` sha256    | `740f7873dac57e19c1df5a9ac6cc95fcd2f58d248486859085befe51c095cdc0`                                                                              | `fb1e39dea466dae3c4b6717c52f66a74adabb927bd2bdbcd8e31c74cf4f1528a`                                                                              |
| `app.asar.unpacked/` | none                                                                                                                                            | `.webpack/sfw/dist/sfw.mjs` (31601 bytes), `.webpack/sfw/package.json`                                                                          |

The sha256 of each zip matches the `digest` that GitHub publishes for the asset (`gh release view <tag> --json assets`).

## Tool version

- hexvero 0.8.0 (`packages/cli`), built from this repository at commit `9efca3b` (`git rev-parse --short HEAD` on `sprint/g-case` before this study was added).
- Node 22.17.1, macOS (Darwin 25.5, arm64).

## Commands

The downloads and extraction went into a scratch directory outside the repository, with a fresh, empty directory for each archive. Nothing from the archives was executed.

```bash
gh release download v0.38.0 -R electron/fiddle -p 'Electron.Fiddle-darwin-arm64-0.38.0.zip' -D dl-0.38.0
gh release download v0.39.0 -R electron/fiddle -p 'Electron.Fiddle-darwin-arm64-0.39.0.zip' -D dl-0.39.0
shasum -a 256 dl-*/*.zip

# only the archive and its unpacked side files, into fresh directories
unzip -q dl-0.38.0/*.zip '*/Contents/Resources/app.asar' -d x-0.38.0
unzip -q dl-0.39.0/*.zip '*/Contents/Resources/app.asar' '*/Contents/Resources/app.asar.unpacked/*' -d x-0.39.0
cp "x-0.38.0/Electron Fiddle.app/Contents/Resources/app.asar" asar/fiddle-0.38.0.asar
cp "x-0.39.0/Electron Fiddle.app/Contents/Resources/app.asar" asar/fiddle-0.39.0.asar

H="node packages/cli/bin/hexvero.js"
$H analyze asar/fiddle-0.38.0.asar
$H analyze asar/fiddle-0.39.0.asar
$H compare asar/fiddle-0.38.0.asar asar/fiddle-0.39.0.asar
for c in interfaces ipcChannels contextBridge windows webPreferences endpoints storage findings limitations urls modules; do
  $H compare asar/fiddle-0.38.0.asar asar/fiddle-0.39.0.asar $c
done
$H compare asar/fiddle-0.38.0.asar asar/fiddle-0.39.0.asar --report report.md

# source, read only (blobless clone, no checkout, nothing built or run)
git clone --filter=blob:none --no-checkout https://github.com/electron/fiddle.git
git -C fiddle diff v0.38.0 v0.39.0 -- src forge.config.ts package.json tools/webpack
```

To check hexvero's results independently, the study used three small read-only helpers. They parse the asar header and copy bytes out; they never load the archive's code. They are in [`scripts/case-study/`](../../scripts/case-study/):

- `asar-files.mjs <a> <b>` lists JavaScript files added or removed between two archives and counts the ones whose integrity hash or size changed.
- `asar-extract.mjs <archive> <outdir> <path>…` copies single files out of an asar.
- `ctx.mjs <file> <needle> [width]` prints each occurrence of a string with some context around it.

I also ran `analyze` and `compare` on the in-place `app.asar` with `app.asar.unpacked/` next to it, and `analyze --all`. The results were identical (see "Limitations of hexvero seen here").

## What hexvero reported

`analyze`, both sides: 63 IPC channels, 71 contextBridge members (`window.ElectronFiddle`, `window.__SENTRY_IPC__`, `window.clipboard`, `window.electron`), 1 preload, 23 window items, 10 webPreferences, 8 endpoints (4 with an unreadable value), 10 storage calls whose key could not be read, and 1 shipped source map. For 0.39.0 it also reported coverage as "incomplete: 1 of 71 JavaScript files could not be read" (`.webpack/sfw/dist/sfw.mjs`).

`compare` overview:

```text
15 shared collection(s), 5 with differences
  collection      added  removed  changed  relocated  unknown  unchanged
  --------------  -----  -------  -------  ---------  -------  ---------
  findings        6      0        0                   6        1
  limitations     1      0        0                            3
  modules         0      0        22                           48
  edges           0      0        0                            7
  externals       0      0        0                            34
  ipcChannels     0      0        0                            63
  webPreferences  0      0        0                            10
  windows         0      0        0                            23
  contextBridge   0      0        0                            71
  interfaces      0      0        52                           19
  ipc             0      0        0                            90
  endpoints       0      0        0        6                   2
  storage         0      0        0        10                  0
  urls            1      0        0        1441                11
  sourceMaps      0      0        0                            1
  ! a JavaScript app was read only in part; run analyze --all on both first
```

Excerpt from the generated report ([full report](electron-fiddle-0.38.0-to-0.39.0.report.md)). The 52 interface entries all have the same form:

```markdown
- **~ changed** `.webpack/renderer/main_window/preload.js::ElectronFiddle::addModules` — in b: `.webpack/renderer/main_window/preload.js:1` · link unknown
  - `reason`: `"no main-process end found, but the analysis has blind spots (ipc_channel_unresolved)"` → `"no main-process end found, but the analysis has blind spots (js_files_skipped, ipc_channel_unresolved, scan_partial)"`
    …

### urls

- **+ added** `.webpack/renderer/183/index.js::https://github.com/SocketDev/sfw-free` — in b: `.webpack/renderer/183/index.js:1` · literal
```

## Confirmation table

Every item is checked against the source at the tags (links point to the line at the tag) and, where useful, against the built bundle. A **confirmed** item is one that is true of the code. A **refuted** item is reported as a change but is not a change in the code. **Cannot tell** means the item could not be decided either way.

### Reported changes

| #     | hexvero reported                                                                         | verdict                                       | evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----- | ---------------------------------------------------------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | `urls` **+** `https://github.com/SocketDev/sfw-free` in `.webpack/renderer/183/index.js` | **confirmed**                                 | New link in the Socket Firewall settings card: [`src/renderer/components/settings-execution.tsx:371`](https://github.com/electron/fiddle/blob/v0.39.0/src/renderer/components/settings-execution.tsx#L371) at v0.39.0. It is absent at v0.38.0, and it is the only URL added anywhere in `git diff v0.38.0 v0.39.0 -- src`. It is an `<a href>` in the UI, not a request, and hexvero files it correctly under `urls`, not `endpoints`.                                                                                                                                                                                      |
| 2     | `limitations` **+** `js_files_skipped` for `.webpack/sfw/dist/sfw.mjs`                   | **confirmed, but the stated reason is wrong** | The file is new in 0.39.0: [`tools/webpack/webpack.main.config.ts:35-36`](https://github.com/electron/fiddle/blob/v0.39.0/tools/webpack/webpack.main.config.ts#L35) copies `node_modules/sfw/dist/sfw.mjs`, and [`forge.config.ts:76`](https://github.com/electron/fiddle/blob/v0.39.0/forge.config.ts#L76) sets `asar: { unpack: '**/.webpack/sfw/**' }`. The message says the file "exceed[s] the per-file size limit or could not be decoded". In fact it is 31601 bytes and is marked `unpacked` in the asar header. hexvero did not read it from `app.asar.unpacked/` even when that directory sat next to the archive. |
| 3–24  | `modules` **~** 22 JavaScript files changed in size, 48 unchanged                        | **confirmed** (22 items)                      | Independent header comparison (`asar-files.mjs`): exactly 22 JS files differ in integrity hash or size and 48 are identical. Spot check: `.webpack/main/index.js` 2849451 → 2885520 bytes matches the extracted file. These are byte-level facts. They do not say what changed (the webpack 5.94 → 5.104.1 bump alone rebuilds every chunk).                                                                                                                                                                                                                                                                                 |
| 25–76 | `interfaces` **~** 52 members changed (`__SENTRY_IPC__.*` ×6, `ElectronFiddle.*` ×46)    | **refuted as code changes** (52 items)        | The only field that differs is `reason`, hexvero's own explanation for "link unknown". It now names `js_files_skipped` and `scan_partial` because of item 2. No member was added, removed or renamed: `src/preload/preload.ts` changes only in `addModules` ([`preload.ts:78-86`](https://github.com/electron/fiddle/blob/v0.39.0/src/preload/preload.ts#L78)), and `@sentry/electron` is unchanged in `package.json`. The report does show the field and both values, so a careful reader can tell. But the summary table counts 52 "changed" interfaces when none changed.                                                 |
| 77–82 | `findings` **+** 6 added (and the 6 old titles as **?** unknown)                         | **refuted as code changes** (6 items)         | Each "added" finding is an older finding with " in the scanned part (71 of 71 files)" added to its title. The counts are identical (63 channels, 71 members, 1 preload, 4 endpoints, 10 storage calls, 24 minified bundles). hexvero itself marks the old wording as "unknown: the other side was read only in part".                                                                                                                                                                                                                                                                                                        |

**Totals:** 82 reported change items. 24 confirmed (1 URL, 1 limitation, 22 module size changes), 58 refuted as code changes (52 interface `reason` strings, 6 finding titles), 0 cannot tell. The 58 refuted items are not invented code changes. They are hexvero's analysis metadata changing because one file went unread on side b. Still, they come out as "changed"/"added" rows in the summary and the report.

### Reported "no change" in the requested categories

| collection       | hexvero                            | verdict                                                                        | evidence                                                                                                                                                                                                                                                      |
| ---------------- | ---------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ipcChannels`    | 0 added / 0 removed, 63 unchanged  | **confirmed for channel names**                                                | [`src/ipc-events.ts`](https://github.com/electron/fiddle/blob/v0.39.0/src/ipc-events.ts) is byte-identical between the tags (`git diff --quiet`), and so is `src/main/ipc.ts`. The built preload's `IpcEvents` object lists the same channels in both builds. |
| `contextBridge`  | 0 added / 0 removed, 71 unchanged  | **confirmed for member names** (but see miss M1)                               | No member is added or removed in `src/preload/preload.ts`. The diff touches only the body of `addModules`.                                                                                                                                                    |
| `windows`        | 23 unchanged                       | **confirmed**                                                                  | [`src/main/windows.ts`](https://github.com/electron/fiddle/blob/v0.39.0/src/main/windows.ts#L57) is identical between the tags. No other `BrowserWindow` construction was added in `src/`.                                                                    |
| `webPreferences` | 10 unchanged                       | **confirmed**                                                                  | Same file, same `webPreferences` block (`windows.ts:57`).                                                                                                                                                                                                     |
| `endpoints`      | 0 added / 0 removed (6 relocated)  | **confirmed for the files read**, wrong for the build as shipped (see miss M3) | No `fetch`/request URL is added in `git diff -- src`. The new endpoint is in the unread `sfw.mjs`.                                                                                                                                                            |
| `storage`        | 0 added / 0 removed (10 relocated) | **cannot tell from hexvero; the source shows a new key** (miss M2)             | hexvero reads no storage key names in this app ("10 storage key calls with a value that could not be read"), so "no change" here only means "nothing readable changed".                                                                                       |

## Misses (real changes in the source that hexvero did not report)

| #   | category                    | change                                                                                                                                                                                                                                                  | source (v0.39.0)                                                                                                                                                                                                                                                                                                                                                                                                                   | built code (0.39.0 asar)                                                                                                                                                                                                                                                                    | why hexvero did not see it                                                                                                                                                                                                                                                                                                                                                  |
| --- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1  | IPC payload / contextBridge | `ElectronFiddle.addModules` and the `NPM_ADD_MODULES` invoke now send a third field, `useSocketFirewall`. The main-process handler forwards it, and when it is true the handler runs the install through `node sfw.mjs …` instead of npm/yarn directly. | [`src/preload/preload.ts:79,84`](https://github.com/electron/fiddle/blob/v0.39.0/src/preload/preload.ts#L79), [`src/main/npm.ts:106-111`](https://github.com/electron/fiddle/blob/v0.39.0/src/main/npm.ts#L106), [`src/main/npm.ts:83-88`](https://github.com/electron/fiddle/blob/v0.39.0/src/main/npm.ts#L83), [`src/interfaces.ts:216`](https://github.com/electron/fiddle/blob/v0.39.0/src/interfaces.ts#L216)                 | `.webpack/renderer/main_window/preload.js` offset 5917: `addModules:({dir:_,packageManager:T,useSocketFirewall:S},...n)=>E.ipcRenderer.invoke(e.IpcEvents.NPM_ADD_MODULES,{dir:_,packageManager:T,useSocketFirewall:S},...n)`. In 0.38.0 the payload object was `{dir:_,packageManager:T}`. | hexvero records channel, api and member, but not the shape of the arguments. The preload grew by 32 bytes, which shows only as a `modules` size change. The main-process end is also not linked ("no main-process end found") because Fiddle registers handlers through its own wrapper, `ipcMainManager.handle(...)`, not `ipcMain.handle`. That is true in both versions. |
| M2  | storage                     | New persisted setting `isUsingSocketFirewall` (default `true`), read with `this.retrieve(GlobalSetting.isUsingSocketFirewall)` and written with `this.save(...)`. Both go through `localStorage.getItem/setItem(key)`.                                  | [`src/interfaces.ts:247`](https://github.com/electron/fiddle/blob/v0.39.0/src/interfaces.ts#L247), [`src/renderer/state.ts:102-103`](https://github.com/electron/fiddle/blob/v0.39.0/src/renderer/state.ts#L102), [`state.ts:507-511`](https://github.com/electron/fiddle/blob/v0.39.0/src/renderer/state.ts#L507), wrapper at [`state.ts:1209,1221`](https://github.com/electron/fiddle/blob/v0.39.0/src/renderer/state.ts#L1209) | `.webpack/renderer/main_window/index.js`: `this.save(c.GlobalSetting.isUsingSocketFirewall,this.isUsingSocketFirewall)` (10 occurrences of the name, 0 in 0.38.0)                                                                                                                           | The key goes through a parameter (`save(key, …)` / `retrieve(key)`) and an enum member, so hexvero lists the call as "value could not be read" in both builds. It says so, but it does not show that a key was added.                                                                                                                                                       |
| M3  | endpoints                   | The shipped app now contains a third-party CLI (`sfw` 2.0.4, MIT) that references `https://api.github.com/repos/SocketDev/sfw-free/releases/latest`.                                                                                                    | [`package.json:75`](https://github.com/electron/fiddle/blob/v0.39.0/package.json#L75) (`"sfw": "^2.0.4"`), [`tools/webpack/webpack.main.config.ts:35`](https://github.com/electron/fiddle/blob/v0.39.0/tools/webpack/webpack.main.config.ts#L35)                                                                                                                                                                                   | `app.asar.unpacked/.webpack/sfw/dist/sfw.mjs` (only URL in the file)                                                                                                                                                                                                                        | The file is asar-unpacked, and hexvero does not read unpacked files. It is reported as a skipped file (item 2), so the gap is flagged, but the endpoint itself is not reported.                                                                                                                                                                                             |
| M4  | modules (inventory)         | A JavaScript file was added to the app: `.webpack/sfw/dist/sfw.mjs` (unpacked).                                                                                                                                                                         | as M3                                                                                                                                                                                                                                                                                                                                                                                                                              | asar header entry marked `"unpacked": true`                                                                                                                                                                                                                                                 | `modules` shows `0 added`. The file appears only in `limitations`.                                                                                                                                                                                                                                                                                                          |

**Outside the requested categories, for context:** in 0.38.1/0.39.0 the main process switched npm/yarn installs from `child_process.exec` with a joined command string to `execFile(cmd, args)` ([`src/main/utils/exec.ts:47-59`](https://github.com/electron/fiddle/blob/v0.39.0/src/main/utils/exec.ts#L47); built: `return i?await(0,r.execFile)(e,"node",[c(),t,...o]):await(0,r.execFile)(e,t,o)`). This removes shell interpretation of module names, which is a security-relevant change. hexvero has no child-process collection, and `externals` (34, unchanged) does not show it because `child_process` was already imported. `forge.config.ts` also gained an `AudioCapture` usage description. That lives in `Info.plist`, outside the asar.

**How thorough the search for misses was:** I read the full `git diff v0.38.0 v0.39.0` for `src/main/`, `src/preload/`, `src/ipc-events.ts`, `src/interfaces.ts`, `src/ambient.d.ts`, `src/renderer/state.ts`, `src/renderer/runner.ts`, `src/renderer/remote-loader.ts`, `src/renderer/components/settings-execution.tsx`, `forge.config.ts`, `tools/webpack/` and `package.json`. For the other five changed renderer components (`version-select`, `settings-electron`, `history`, `dialog-add-version`, `commands-action-button`), I only grepped their added and removed lines for `http`, `ElectronFiddle.`, `ipc`, `Storage`, `BrowserWindow`, `webPreferences` and `fetch`, with no hits. I did **not** inspect transitive dependency changes from `yarn.lock` that end up bundled (for example `simple-git` 3.18 → 3.32.3, `flatted`, `picomatch`), or the Monaco/TypeScript worker bundles. Those could contain endpoint or storage changes that neither hexvero nor this study found. This study does not show that hexvero found all changes, and it should not be read that way.

## False reports

No reported item claims a change in IPC, contextBridge, windows, webPreferences, endpoints or storage that the code does not have. The 58 refuted items are noise from hexvero's own metadata:

- **52 `interfaces` "changed"**: only the `reason` text changed. That text is hexvero's explanation of why a link is unknown, so this compares the analysis, not the app. The interfaces line is the first thing a reader sees under "Changes" in the report, and the count suggests the interface changed in 52 places.
- **6 `findings` "added"** (+6 "unknown"): only the title wording changed, from "63 IPC channels" to "63 IPC channels in the scanned part (71 of 71 files)".

## Unknowns

- What the 22 changed modules actually changed is not described beyond byte size. Most of it is likely the webpack 5.94 → 5.104.1 bump, but this study did not diff the bundles chunk by chunk.
- Whether `sfw.mjs` contacts any host other than the GitHub API URL at run time (for example, through a downloaded binary) cannot be told statically. The study did not run it.
- hexvero links no `ElectronFiddle` member to a main-process handler in either build ("link unknown" for all 46), so it cannot say which members reach privileged code. The source shows that they do, through `ipcMainManager.handle`. (Read since then: 45 of 46 are linked, see [IPC wrapper classes: before and after](#ipc-wrapper-classes-before-and-after).)

## Timings

| step                                                             | wall time            |
| ---------------------------------------------------------------- | -------------------- |
| `analyze` 0.38.0 (cold)                                          | 2.74 s (user 8.57 s) |
| `analyze` 0.39.0 (cold)                                          | 2.77 s (user 8.09 s) |
| `analyze` again (cached scan)                                    | about 0.03 s         |
| `compare` overview                                               | 0.58 s               |
| `compare --report`                                               | 0.33 s               |
| manual source check (diff reading, built-code lookups, write-up) | roughly 1.5 h        |

## Limitations of hexvero seen here

1. **asar-unpacked files are not read**, even when `app.asar.unpacked/` sits next to the archive, and the limitation message gives the wrong reason ("exceed the per-file size limit or could not be decoded"). The `--all` hint printed by `compare` does not help: `analyze --all` gives the same result.
2. **Metadata churn shows up as changes.** When coverage changes on one side, every interface's `reason` and every finding title count as changed or added. In this case that was 58 of 82 reported items, which buries the 2 items that matter (the new URL and the skipped file).
3. **IPC argument shapes are not compared**, so a new payload field on an existing channel (M1) is invisible.
4. **Storage keys passed through wrappers or enums are unreadable**, so a new persisted setting (M2) is invisible. hexvero says the values could not be read, which is honest, but there is nothing to diff.
5. **Custom IPC wrappers** (`ipcMainManager.handle`) are not followed to their handler, so no member of the app's main bridge is linked to a main-process end. (Read since then, see the next section.)

## IPC wrapper classes: before and after

Limitation 5 was taken up afterwards (sprint branch `sprint/a2-wrappers`, base commit `aa88007`).
Fiddle registers its main-process handlers through a singleton:
[`src/main/ipc.ts`](https://github.com/electron/fiddle/blob/v0.39.0/src/main/ipc.ts) defines
`class IpcMainManager extends EventEmitter` whose `handle(channel, listener)` calls
`ipcMain.removeHandler(channel)` and `ipcMain.handle(channel, listener)`, and whose constructor
calls `ipcMain.on(name, …)` for every name of `ipcMainEvents`
([`src/ipc-events.ts`](https://github.com/electron/fiddle/blob/v0.39.0/src/ipc-events.ts)) and
re-emits it. The module exports `ipcMainManager = new IpcMainManager()`, and 25 calls in 10 other
modules register `ipcMainManager.handle(IpcEvents.X, …)`. In the webpack build the class is the
one-letter `l` of module `76675`, the instance is `n.ipcMainManager`, and the calls read
`a.ipcMainManager.handle(c.IpcEvents.X, …)` with `a = i(76675)`.

hexvero now reads a method that passes its parameter on, whole, as the channel of an IPC call as
a wrapper, and records each call of it on an instance as a row of that IPC API, at the call, with
`via: "wrapper"` and `wrapper: "ipcMainManager.handle"`. For the constructor's loop it now reads
webpack's `i(57755)` as that module of the bundle and the one-letter enum `i` inside it, so
`r.ipcMainEvents.forEach((e) => ipcMain.on(e, …))` gives one `ipcMain.on` row per listed channel.

Command (the archives as described under [Commands](#commands); the script only reads them
through hexvero's own `@hexvero/core`; `<base>` is a worktree of `aa88007`, built):

```bash
node scripts/case-study/bridge-links.mjs <base>/packages/core ElectronFiddle asar/fiddle-0.38.0.asar asar/fiddle-0.39.0.asar
node scripts/case-study/bridge-links.mjs packages/core ElectronFiddle asar/fiddle-0.38.0.asar asar/fiddle-0.39.0.asar
```

| `ElectronFiddle` (both builds the same)             | before (`aa88007`)       | after                                                                                                                                                               |
| --------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| members / with a channel                            | 51 / 46                  | 51 / 46                                                                                                                                                             |
| members linked to a main-process end                | 0                        | 45                                                                                                                                                                  |
| interface `link`                                    | unknown 46, unresolved 5 | resolved 45, unknown 1, unresolved 5                                                                                                                                |
| linked members, by their end                        | none                     | 25 with an `ipcMain.handle` end via wrapper `ipcMainManager.handle`, 43 with an `ipcMain.on` end (the constructor's loop, `via: "resolved"`, element); 23 have both |
| IPC channels / IPC rows / rows without a channel    | 63 / 90 / 12             | 64 / 157 / 10                                                                                                                                                       |
| `analyze` in-process (`analyzeMs`, 0.38.0 / 0.39.0) | 2571 / 2820 ms           | 2771 / 2226 ms (run to run noise; no consistent change)                                                                                                             |

Every link was checked against the source at `v0.39.0`: the 45 linked channels are exactly the
channels of the 25 `ipcMainManager.handle(…)` calls in `src/main` together with the 43 names of
`ipcMainEvents` (45 names in all); none is linked that is in neither. The one member left unknown, `onGetFiles`
(`GET_FILES`), is correct: the main process sends that channel to the page through
`ipcMainManager.send`, which writes to a `webContents` parameter; there is no main-process
receiver. The 64th channel is `WEBCONTENTS_READY_FOR_IPC_SIGNAL`, the constructor's own
`ipcMain.on(r.WEBCONTENTS_READY_FOR_IPC_SIGNAL, …)`, now read through `i(57755)` as well.
`ipcMainManager.on(…)` (EventEmitter's own method, not one of the class's) gives no row of its
own, and neither does `ipcMainManager.send(…)`.

The comparison changes with it. `compare asar/fiddle-0.38.0.asar asar/fiddle-0.39.0.asar`
before (`aa88007`): interfaces 0 changed, but `webPreferences` 1 added and `windows` 1 changed,
because the webpack 5.104 build of 0.39.0 writes its modules as methods (`76675(e,n,i){…}`),
which `aa88007` did not read as functions, so the main window's options (returned by a helper)
were read as opaque in 0.39.0 only. After: both builds are read the same way, `webPreferences`
and `windows` show no difference (the source has none), and the summary is `findings` 6 changed,
`limitations` 1 added, `modules` 22 changed, `urls` 1 added, everything else unchanged
(`ipcChannels` 64, `interfaces` 71, `ipc` 157).

## Limitations of the study

- One app, one pair of versions, one platform build (darwin-arm64). Other platforms ship the same asar content in principle, but this was not checked.
- The miss search was manual and bounded (see "How thorough the search for misses was"). Misses in dependency code were not looked for.
- A refuted or confirmed verdict rests on reading source at the tag and the minified built files. Built code was located by string search, not by a parser.
- The person who chose the app also wrote the verdicts. A second reader was not involved.
