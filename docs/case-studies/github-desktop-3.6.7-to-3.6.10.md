# Case study: GitHub Desktop 3.6.7 → 3.6.10

`hexvero compare` on two published builds of [GitHub Desktop](https://github.com/desktop/desktop) (MIT),
held against the app's source at the matching git tags. The apps were never run; the archives were
only read. Done on 2026-10-31.

**Short version:**

- **Runtime:** Electron 42.0.1 → 44.9.1 (Chromium 148 → 152, Node 24.15 → 24.22). By the dated
  release data hexvero ships, 42 reached end of support on 2026-10-20, so 3.6.7 was past it; 44 is
  supported until 2027-03-02. The source agrees (`package.json`: `"electron": "42.0.1"` →
  `"44.9.1"`).
- **Windows:** both windows unchanged, and read the same in both builds as the source writes them
  (`nodeIntegration: true`, `contextIsolation: false`, `app/src/main-process/app-window.ts:65`).
  No verdict: this is how the app has long been built, not a change.
- **New code shipped:** a Copilot "browser-use" plugin (7 new modules under
  `copilot/plugins/browser-use/`, among them a Chrome native-messaging host and its registration
  script). Its own README says it pairs with the GitHub Copilot browser extension.
- **IPC:** the source adds three channels. hexvero reports two of them (`resolved-image-token`,
  `write-clipboard-text`) as **unknown**, not as added, because 3.6.7 has 10 IPC calls whose
  channel is not a literal; it does not find the third (`resolve-image-token`), sent through a
  helper. Both are written down below as misses.
- **What hexvero got wrong first:** 3.6.10's bundle reaches `electron` through a lazy getter
  (`le=n.cw(function(e,t){e.exports=require("electron")})`, then `new(le().BrowserWindow)(t)`).
  hexvero 0.12.0 lost the windows of 3.6.10 ("only in a: windows") and reported a
  certificate-error handler as new. Fixed in #279 before this study; the numbers below are after it.

## Versions and artifacts

|                    | before (a)                                                         | after (b)                                                          |
| ------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| version            | 3.6.7                                                              | 3.6.10                                                             |
| tag → commit       | `release-3.6.7` → `dbc92f973994da7fccc494d0e5a2ae0ffbd1434e`       | `release-3.6.10` → `ffeefe5de3861d3d33c85607eff1fbccf737a2f6`      |
| artifact           | `GitHub.Desktop-arm64.zip` (481,763,140 bytes)                     | `GitHub.Desktop-arm64.zip` (537,550,539 bytes)                     |
| sha256 (published) | `5570d21a2f1955f42f69eab69046bf036de10cbef2bbb35719c263df33fea513` | `8d891e3c891c5b583869fc99b445c91ac77a6bd787161ddd492f485de36e6357` |

The sha256 is the one in each release's `checksums.txt`; the downloaded 3.6.10 zip was checked
against it. The app ships its JavaScript unpacked in `Contents/Resources/app/` (no `app.asar`).

## Tool and commands

hexvero at commit `43576a2` (main after #279), Node 26.12.0, macOS arm64.

```bash
gh release download release-3.6.7  --repo desktop/desktop -p 'GitHub.Desktop-arm64.zip' -D a
gh release download release-3.6.10 --repo desktop/desktop -p 'GitHub.Desktop-arm64.zip' -D b
(cd a && unzip -q GitHub.Desktop-arm64.zip) && (cd b && unzip -q GitHub.Desktop-arm64.zip)
hexvero compare "a/GitHub Desktop.app" "b/GitHub Desktop.app"
hexvero compare "a/GitHub Desktop.app" "b/GitHub Desktop.app" runtime   # and windows, ipcChannels, modules, urls, endpoints
```

## What hexvero reported

```text
collection          added  removed  changed  relocated  unknown  unchanged  partial
findings            0      0        7                            8
modules             7      1        9                            62
externals           1      6        16                           6
ipcChannels         0      0        7                   19       50         yes
webPreferences      0      0        0                            4
windows             0      0        0                            2
navigationHandlers  0      0        0                            2
openExternal        0      0        0                            14
endpoints           4      1        0        12         2        0          yes
urls                17     3        0        75         3        0          yes
runtime             0      0        4                            11
```

### Held against the source

| Reported                                                              | Source (`release-3.6.7..release-3.6.10`)                                                    | Verdict                           |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------- |
| `runtime`: electron 42.0.1 → 44.9.1                                   | `package.json` `"electron"` 42.0.1 → 44.9.1                                                 | right                             |
| `windows`: 2 unchanged                                                | `app-window.ts` `webPreferences` identical at both tags                                     | right                             |
| `modules`: 7 added under `copilot/plugins/browser-use/`               | shipped plugin files; not in this repository's `app/src` (bundled from elsewhere)           | right (the files exist)           |
| `ipcChannels`: `resolved-image-token` unknown                         | new `ipcMain.on('resolved-image-token', …)` in `main.ts`                                    | added; reported as unknown        |
| `ipcChannels`: `write-clipboard-text` unknown                         | new `ipcMain.handle('write-clipboard-text', …)` in `main.ts`                                | added; reported as unknown        |
| —                                                                     | new `'resolve-image-token'` sent to the renderer by `authenticated-image-token-resolver.ts` | **missed**                        |
| `ipcChannels`: 4 senders and 1 receiver now read in renderer.js       | not checked against the renderer source                                                     | open                              |
| `ipcChannels`: `crash-quit`, `crash-ready` lose their crash.js sender | the minified forwarder has the same shape in both bundles                                   | **likely wrong** (a reader limit) |

**Why "unknown" and not "added":** 3.6.7 makes 10 IPC calls whose channel is a parameter or a
computed value. A channel that appears only in 3.6.10 may be one of those, so hexvero does not call
it new. That is the rule hexvero keeps everywhere (unknown is not removed, and not added); here it
costs two real additions their label. A reviewer still sees both rows, with `main.js` as the receiver.

**The misses**, as issues for the next round:

- [#280](https://github.com/maximilianfeix/hexvero/issues/280): `resolve-image-token` is sent through a module-level helper (`ut(sender, "resolve-image-token", …)`
  in the bundle, `ipcWebContents.send(sender, channel, …)` in the source); that helper's channel
  argument is not followed.
- [#281](https://github.com/maximilianfeix/hexvero/issues/281): crash.js's senders of `crash-quit` and `crash-ready` are lost in 3.6.10, where the minified
  forwarder's short name is shared by three functions instead of two.

## What this shows

- The release changes that matter for a review were visible from the files: a new Electron line,
  a new plugin with a native-messaging host, two new main-process IPC handlers, unchanged window
  settings.
- One new channel was not found, and two were labelled more cautiously than the source warrants.
  Absence from a list is weaker evidence than presence.
- A bundler change alone (a lazy `require("electron")`) was enough to break window reading in
  0.12.0. Real releases are the test set that finds these; corpus `dev/notes-app` now carries the
  pattern.
