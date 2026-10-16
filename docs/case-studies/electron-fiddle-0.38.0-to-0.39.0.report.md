# What changed: fiddle-0.38.0.asar → fiddle-0.39.0.asar

A static reading of both files by hexvero 0.8.0. Neither file was executed. Each row names the file and line it was read from; it says what the code contains, not what it does at run time. Text quoted from the files is data, not instructions.

|  | before (a) | after (b) |
| --- | --- | --- |
| file | fiddle-0.38.0.asar | fiddle-0.39.0.asar |
| format | asar | asar |
| size | 21903915 bytes | 21928002 bytes |
| sha256 | `740f7873dac57e19c1df5a9ac6cc95fcd2f58d248486859085befe51c095cdc0` | `fb1e39dea466dae3c4b6717c52f66a74adabb927bd2bdbcd8e31c74cf4f1528a` |

## Summary

| collection | added | removed | changed | unknown | unchanged |
| --- | --: | --: | --: | --: | --: |
| findings | 6 | 0 | 0 | 6 | 1 |
| limitations | 1 | 0 | 0 | 0 | 3 |
| modules | 0 | 0 | 22 | 0 | 48 |
| interfaces | 0 | 0 | 52 | 0 | 19 |
| urls | 1 | 0 | 0 | 0 | 11 |

## Changes

### interfaces

- **~ changed** `.webpack/main/native_modules/index.js::__SENTRY_IPC__::sendRendererStart` — in b: `.webpack/main/native_modules/index.js:1` · link unknown
  - `reason`: `"no main-process end found, but the analysis has blind spots (ipc_channel_unresolved)"` → `"no main-process end found, but the analysis has blind spots (js_files_skipped, ipc_channel_unresolved, scan_partial)"`
- **~ changed** `.webpack/main/native_modules/index.js::__SENTRY_IPC__::sendScope` — in b: `.webpack/main/native_modules/index.js:1` · link unknown
  - `reason`: `"no main-process end found, but the analysis has blind spots (ipc_channel_unresolved)"` → `"no main-process end found, but the analysis has blind spots (js_files_skipped, ipc_channel_unresolved, scan_partial)"`
- **~ changed** `.webpack/main/native_modules/index.js::__SENTRY_IPC__::sendEvent` — in b: `.webpack/main/native_modules/index.js:1` · link unknown
  - `reason`: `"no main-process end found, but the analysis has blind spots (ipc_channel_unresolved)"` → `"no main-process end found, but the analysis has blind spots (js_files_skipped, ipc_channel_unresolved, scan_partial)"`
- **~ changed** `.webpack/main/native_modules/index.js::__SENTRY_IPC__::sendEnvelope` — in b: `.webpack/main/native_modules/index.js:1` · link unknown
  - `reason`: `"no main-process end found, but the analysis has blind spots (ipc_channel_unresolved)"` → `"no main-process end found, but the analysis has blind spots (js_files_skipped, ipc_channel_unresolved, scan_partial)"`
- **~ changed** `.webpack/main/native_modules/index.js::__SENTRY_IPC__::sendStatus` — in b: `.webpack/main/native_modules/index.js:1` · link unknown
  - `reason`: `"no main-process end found, but the analysis has blind spots (ipc_channel_unresolved)"` → `"no main-process end found, but the analysis has blind spots (js_files_skipped, ipc_channel_unresolved, scan_partial)"`
- **~ changed** `.webpack/main/native_modules/index.js::__SENTRY_IPC__::sendAddMetric` — in b: `.webpack/main/native_modules/index.js:1` · link unknown
  - `reason`: `"no main-process end found, but the analysis has blind spots (ipc_channel_unresolved)"` → `"no main-process end found, but the analysis has blind spots (js_files_skipped, ipc_channel_unresolved, scan_partial)"`
- **~ changed** `.webpack/renderer/main_window/preload.js::ElectronFiddle::addModules` — in b: `.webpack/renderer/main_window/preload.js:1` · link unknown
  - `reason`: `"no main-process end found, but the analysis has blind spots (ipc_channel_unresolved)"` → `"no main-process end found, but the analysis has blind spots (js_files_skipped, ipc_channel_unresolved, scan_partial)"`
- **~ changed** `.webpack/renderer/main_window/preload.js::ElectronFiddle::blockAccelerators` — in b: `.webpack/renderer/main_window/preload.js:1` · link unknown
  - `reason`: `"no main-process end found, but the analysis has blind spots (ipc_channel_unresolved)"` → `"no main-process end found, but the analysis has blind spots (js_files_skipped, ipc_channel_unresolved, scan_partial)"`
- **~ changed** `.webpack/renderer/main_window/preload.js::ElectronFiddle::cleanupDirectory` — in b: `.webpack/renderer/main_window/preload.js:1` · link unknown
  - `reason`: `"no main-process end found, but the analysis has blind spots (ipc_channel_unresolved)"` → `"no main-process end found, but the analysis has blind spots (js_files_skipped, ipc_channel_unresolved, scan_partial)"`
- **~ changed** `.webpack/renderer/main_window/preload.js::ElectronFiddle::confirmQuit` — in b: `.webpack/renderer/main_window/preload.js:1` · link unknown
  - `reason`: `"no main-process end found, but the analysis has blind spots (ipc_channel_unresolved)"` → `"no main-process end found, but the analysis has blind spots (js_files_skipped, ipc_channel_unresolved, scan_partial)"`
- **~ changed** `.webpack/renderer/main_window/preload.js::ElectronFiddle::createThemeFile` — in b: `.webpack/renderer/main_window/preload.js:1` · link unknown
  - `reason`: `"no main-process end found, but the analysis has blind spots (ipc_channel_unresolved)"` → `"no main-process end found, but the analysis has blind spots (js_files_skipped, ipc_channel_unresolved, scan_partial)"`
- **~ changed** `.webpack/renderer/main_window/preload.js::ElectronFiddle::deleteUserData` — in b: `.webpack/renderer/main_window/preload.js:1` · link unknown
  - `reason`: `"no main-process end found, but the analysis has blind spots (ipc_channel_unresolved)"` → `"no main-process end found, but the analysis has blind spots (js_files_skipped, ipc_channel_unresolved, scan_partial)"`
- **~ changed** `.webpack/renderer/main_window/preload.js::ElectronFiddle::downloadVersion` — in b: `.webpack/renderer/main_window/preload.js:1` · link unknown
  - `reason`: `"no main-process end found, but the analysis has blind spots (ipc_channel_unresolved)"` → `"no main-process end found, but the analysis has blind spots (js_files_skipped, ipc_channel_unresolved, scan_partial)"`
- **~ changed** `.webpack/renderer/main_window/preload.js::ElectronFiddle::fetchVersions` — in b: `.webpack/renderer/main_window/preload.js:1` · link unknown
  - `reason`: `"no main-process end found, but the analysis has blind spots (ipc_channel_unresolved)"` → `"no main-process end found, but the analysis has blind spots (js_files_skipped, ipc_channel_unresolved, scan_partial)"`
- **~ changed** `.webpack/renderer/main_window/preload.js::ElectronFiddle::getElectronTypes` — in b: `.webpack/renderer/main_window/preload.js:1` · link unknown
  - `reason`: `"no main-process end found, but the analysis has blind spots (ipc_channel_unresolved)"` → `"no main-process end found, but the analysis has blind spots (js_files_skipped, ipc_channel_unresolved, scan_partial)"`
- **~ changed** `.webpack/renderer/main_window/preload.js::ElectronFiddle::getLatestStable` — in b: `.webpack/renderer/main_window/preload.js:1` · link unknown
  - `reason`: `"no main-process end found, but the analysis has blind spots (ipc_channel_unresolved)"` → `"no main-process end found, but the analysis has blind spots (js_files_skipped, ipc_channel_unresolved, scan_partial)"`
- **~ changed** `.webpack/renderer/main_window/preload.js::ElectronFiddle::getLocalVersionState` — in b: `.webpack/renderer/main_window/preload.js:1` · link unknown
  - `reason`: `"no main-process end found, but the analysis has blind spots (ipc_channel_unresolved)"` → `"no main-process end found, but the analysis has blind spots (js_files_skipped, ipc_channel_unresolved, scan_partial)"`
- **~ changed** `.webpack/renderer/main_window/preload.js::ElectronFiddle::getOldestSupportedMajor` — in b: `.webpack/renderer/main_window/preload.js:1` · link unknown
  - `reason`: `"no main-process end found, but the analysis has blind spots (ipc_channel_unresolved)"` → `"no main-process end found, but the analysis has blind spots (js_files_skipped, ipc_channel_unresolved, scan_partial)"`
- **~ changed** `.webpack/renderer/main_window/preload.js::ElectronFiddle::getReleasedVersions` — in b: `.webpack/renderer/main_window/preload.js:1` · link unknown
  - `reason`: `"no main-process end found, but the analysis has blind spots (ipc_channel_unresolved)"` → `"no main-process end found, but the analysis has blind spots (js_files_skipped, ipc_channel_unresolved, scan_partial)"`
- **~ changed** `.webpack/renderer/main_window/preload.js::ElectronFiddle::getReleaseInfo` — in b: `.webpack/renderer/main_window/preload.js:1` · link unknown
  - `reason`: `"no main-process end found, but the analysis has blind spots (ipc_channel_unresolved)"` → `"no main-process end found, but the analysis has blind spots (js_files_skipped, ipc_channel_unresolved, scan_partial)"`
- **~ changed** `.webpack/renderer/main_window/preload.js::ElectronFiddle::getAvailableThemes` — in b: `.webpack/renderer/main_window/preload.js:1` · link unknown
  - `reason`: `"no main-process end found, but the analysis has blind spots (ipc_channel_unresolved)"` → `"no main-process end found, but the analysis has blind spots (js_files_skipped, ipc_channel_unresolved, scan_partial)"`
- **~ changed** `.webpack/renderer/main_window/preload.js::ElectronFiddle::getIsPackageManagerInstalled` — in b: `.webpack/renderer/main_window/preload.js:1` · link unknown
  - `reason`: `"no main-process end found, but the analysis has blind spots (ipc_channel_unresolved)"` → `"no main-process end found, but the analysis has blind spots (js_files_skipped, ipc_channel_unresolved, scan_partial)"`
- **~ changed** `.webpack/renderer/main_window/preload.js::ElectronFiddle::getNodeTypes` — in b: `.webpack/renderer/main_window/preload.js:1` · link unknown
  - `reason`: `"no main-process end found, but the analysis has blind spots (ipc_channel_unresolved)"` → `"no main-process end found, but the analysis has blind spots (js_files_skipped, ipc_channel_unresolved, scan_partial)"`
- **~ changed** `.webpack/renderer/main_window/preload.js::ElectronFiddle::getProjectName` — in b: `.webpack/renderer/main_window/preload.js:1` · link unknown
  - `reason`: `"no main-process end found, but the analysis has blind spots (ipc_channel_unresolved)"` → `"no main-process end found, but the analysis has blind spots (js_files_skipped, ipc_channel_unresolved, scan_partial)"`
- **~ changed** `.webpack/renderer/main_window/preload.js::ElectronFiddle::getTemplate` — in b: `.webpack/renderer/main_window/preload.js:1` · link unknown
  - `reason`: `"no main-process end found, but the analysis has blind spots (ipc_channel_unresolved)"` → `"no main-process end found, but the analysis has blind spots (js_files_skipped, ipc_channel_unresolved, scan_partial)"`
- **~ changed** `.webpack/renderer/main_window/preload.js::ElectronFiddle::getTemplateValues` — in b: `.webpack/renderer/main_window/preload.js:1` · link unknown
  - `reason`: `"no main-process end found, but the analysis has blind spots (ipc_channel_unresolved)"` → `"no main-process end found, but the analysis has blind spots (js_files_skipped, ipc_channel_unresolved, scan_partial)"`
- **~ changed** `.webpack/renderer/main_window/preload.js::ElectronFiddle::isReleasedMajor` — in b: `.webpack/renderer/main_window/preload.js:1` · link unknown
  - `reason`: `"no main-process end found, but the analysis has blind spots (ipc_channel_unresolved)"` → `"no main-process end found, but the analysis has blind spots (js_files_skipped, ipc_channel_unresolved, scan_partial)"`
- **~ changed** `.webpack/renderer/main_window/preload.js::ElectronFiddle::getTestTemplate` — in b: `.webpack/renderer/main_window/preload.js:1` · link unknown
  - `reason`: `"no main-process end found, but the analysis has blind spots (ipc_channel_unresolved)"` → `"no main-process end found, but the analysis has blind spots (js_files_skipped, ipc_channel_unresolved, scan_partial)"`
- **~ changed** `.webpack/renderer/main_window/preload.js::ElectronFiddle::getUsername` — in b: `.webpack/renderer/main_window/preload.js:1` · link unknown
  - `reason`: `"no main-process end found, but the analysis has blind spots (ipc_channel_unresolved)"` → `"no main-process end found, but the analysis has blind spots (js_files_skipped, ipc_channel_unresolved, scan_partial)"`
- **~ changed** `.webpack/renderer/main_window/preload.js::ElectronFiddle::getVersionState` — in b: `.webpack/renderer/main_window/preload.js:1` · link unknown
  - `reason`: `"no main-process end found, but the analysis has blind spots (ipc_channel_unresolved)"` → `"no main-process end found, but the analysis has blind spots (js_files_skipped, ipc_channel_unresolved, scan_partial)"`
- **~ changed** `.webpack/renderer/main_window/preload.js::ElectronFiddle::isDevMode` — in b: `.webpack/renderer/main_window/preload.js:1` · link unknown
  - `reason`: `"no main-process end found, but the analysis has blind spots (ipc_channel_unresolved)"` → `"no main-process end found, but the analysis has blind spots (js_files_skipped, ipc_channel_unresolved, scan_partial)"`
- **~ changed** `.webpack/renderer/main_window/preload.js::ElectronFiddle::macTitlebarClicked` — in b: `.webpack/renderer/main_window/preload.js:1` · link unknown
  - `reason`: `"no main-process end found, but the analysis has blind spots (ipc_channel_unresolved)"` → `"no main-process end found, but the analysis has blind spots (js_files_skipped, ipc_channel_unresolved, scan_partial)"`
- **~ changed** `.webpack/renderer/main_window/preload.js::ElectronFiddle::onGetFiles` — in b: `.webpack/renderer/main_window/preload.js:1` · link unknown
  - `reason`: `"no main-process end found, but the analysis has blind spots (ipc_channel_unresolved)"` → `"no main-process end found, but the analysis has blind spots (js_files_skipped, ipc_channel_unresolved, scan_partial)"`
- **~ changed** `.webpack/renderer/main_window/preload.js::ElectronFiddle::openThemeFolder` — in b: `.webpack/renderer/main_window/preload.js:1` · link unknown
  - `reason`: `"no main-process end found, but the analysis has blind spots (ipc_channel_unresolved)"` → `"no main-process end found, but the analysis has blind spots (js_files_skipped, ipc_channel_unresolved, scan_partial)"`
- **~ changed** `.webpack/renderer/main_window/preload.js::ElectronFiddle::packageRun` — in b: `.webpack/renderer/main_window/preload.js:1` · link unknown
  - `reason`: `"no main-process end found, but the analysis has blind spots (ipc_channel_unresolved)"` → `"no main-process end found, but the analysis has blind spots (js_files_skipped, ipc_channel_unresolved, scan_partial)"`
- **~ changed** `.webpack/renderer/main_window/preload.js::ElectronFiddle::pathExists` — in b: `.webpack/renderer/main_window/preload.js:1` · link unknown
  - `reason`: `"no main-process end found, but the analysis has blind spots (ipc_channel_unresolved)"` → `"no main-process end found, but the analysis has blind spots (js_files_skipped, ipc_channel_unresolved, scan_partial)"`
- **~ changed** `.webpack/renderer/main_window/preload.js::ElectronFiddle::pushOutputEntry` — in b: `.webpack/renderer/main_window/preload.js:1` · link unknown
  - `reason`: `"no main-process end found, but the analysis has blind spots (ipc_channel_unresolved)"` → `"no main-process end found, but the analysis has blind spots (js_files_skipped, ipc_channel_unresolved, scan_partial)"`
- **~ changed** `.webpack/renderer/main_window/preload.js::ElectronFiddle::reloadWindows` — in b: `.webpack/renderer/main_window/preload.js:1` · link unknown
  - `reason`: `"no main-process end found, but the analysis has blind spots (ipc_channel_unresolved)"` → `"no main-process end found, but the analysis has blind spots (js_files_skipped, ipc_channel_unresolved, scan_partial)"`
- **~ changed** `.webpack/renderer/main_window/preload.js::ElectronFiddle::readThemeFile` — in b: `.webpack/renderer/main_window/preload.js:1` · link unknown
  - `reason`: `"no main-process end found, but the analysis has blind spots (ipc_channel_unresolved)"` → `"no main-process end found, but the analysis has blind spots (js_files_skipped, ipc_channel_unresolved, scan_partial)"`
- **~ changed** `.webpack/renderer/main_window/preload.js::ElectronFiddle::removeVersion` — in b: `.webpack/renderer/main_window/preload.js:1` · link unknown
  - `reason`: `"no main-process end found, but the analysis has blind spots (ipc_channel_unresolved)"` → `"no main-process end found, but the analysis has blind spots (js_files_skipped, ipc_channel_unresolved, scan_partial)"`
- **~ changed** `.webpack/renderer/main_window/preload.js::ElectronFiddle::saveFilesToTemp` — in b: `.webpack/renderer/main_window/preload.js:1` · link unknown
  - `reason`: `"no main-process end found, but the analysis has blind spots (ipc_channel_unresolved)"` → `"no main-process end found, but the analysis has blind spots (js_files_skipped, ipc_channel_unresolved, scan_partial)"`
- **~ changed** `.webpack/renderer/main_window/preload.js::ElectronFiddle::selectLocalVersion` — in b: `.webpack/renderer/main_window/preload.js:1` · link unknown
  - `reason`: `"no main-process end found, but the analysis has blind spots (ipc_channel_unresolved)"` → `"no main-process end found, but the analysis has blind spots (js_files_skipped, ipc_channel_unresolved, scan_partial)"`
- **~ changed** `.webpack/renderer/main_window/preload.js::ElectronFiddle::setNativeTheme` — in b: `.webpack/renderer/main_window/preload.js:1` · link unknown
  - `reason`: `"no main-process end found, but the analysis has blind spots (ipc_channel_unresolved)"` → `"no main-process end found, but the analysis has blind spots (js_files_skipped, ipc_channel_unresolved, scan_partial)"`
- **~ changed** `.webpack/renderer/main_window/preload.js::ElectronFiddle::setShowMeTemplate` — in b: `.webpack/renderer/main_window/preload.js:1` · link unknown
  - `reason`: `"no main-process end found, but the analysis has blind spots (ipc_channel_unresolved)"` → `"no main-process end found, but the analysis has blind spots (js_files_skipped, ipc_channel_unresolved, scan_partial)"`
- **~ changed** `.webpack/renderer/main_window/preload.js::ElectronFiddle::showWarningDialog` — in b: `.webpack/renderer/main_window/preload.js:1` · link unknown
  - `reason`: `"no main-process end found, but the analysis has blind spots (ipc_channel_unresolved)"` → `"no main-process end found, but the analysis has blind spots (js_files_skipped, ipc_channel_unresolved, scan_partial)"`
- **~ changed** `.webpack/renderer/main_window/preload.js::ElectronFiddle::showWindow` — in b: `.webpack/renderer/main_window/preload.js:1` · link unknown
  - `reason`: `"no main-process end found, but the analysis has blind spots (ipc_channel_unresolved)"` → `"no main-process end found, but the analysis has blind spots (js_files_skipped, ipc_channel_unresolved, scan_partial)"`
- **~ changed** `.webpack/renderer/main_window/preload.js::ElectronFiddle::startFiddle` — in b: `.webpack/renderer/main_window/preload.js:1` · link unknown
  - `reason`: `"no main-process end found, but the analysis has blind spots (ipc_channel_unresolved)"` → `"no main-process end found, but the analysis has blind spots (js_files_skipped, ipc_channel_unresolved, scan_partial)"`
- **~ changed** `.webpack/renderer/main_window/preload.js::ElectronFiddle::stopFiddle` — in b: `.webpack/renderer/main_window/preload.js:1` · link unknown
  - `reason`: `"no main-process end found, but the analysis has blind spots (ipc_channel_unresolved)"` → `"no main-process end found, but the analysis has blind spots (js_files_skipped, ipc_channel_unresolved, scan_partial)"`
- **~ changed** `.webpack/renderer/main_window/preload.js::ElectronFiddle::taskDone` — in b: `.webpack/renderer/main_window/preload.js:1` · link unknown
  - `reason`: `"no main-process end found, but the analysis has blind spots (ipc_channel_unresolved)"` → `"no main-process end found, but the analysis has blind spots (js_files_skipped, ipc_channel_unresolved, scan_partial)"`
- **~ changed** `.webpack/renderer/main_window/preload.js::ElectronFiddle::themePath` — in b: `.webpack/renderer/main_window/preload.js:1` · link unknown
  - `reason`: `"no main-process end found, but the analysis has blind spots (ipc_channel_unresolved)"` → `"no main-process end found, but the analysis has blind spots (js_files_skipped, ipc_channel_unresolved, scan_partial)"`
- **~ changed** `.webpack/renderer/main_window/preload.js::ElectronFiddle::uncacheTypes` — in b: `.webpack/renderer/main_window/preload.js:1` · link unknown
  - `reason`: `"no main-process end found, but the analysis has blind spots (ipc_channel_unresolved)"` → `"no main-process end found, but the analysis has blind spots (js_files_skipped, ipc_channel_unresolved, scan_partial)"`
- **~ changed** `.webpack/renderer/main_window/preload.js::ElectronFiddle::unwatchElectronTypes` — in b: `.webpack/renderer/main_window/preload.js:1` · link unknown
  - `reason`: `"no main-process end found, but the analysis has blind spots (ipc_channel_unresolved)"` → `"no main-process end found, but the analysis has blind spots (js_files_skipped, ipc_channel_unresolved, scan_partial)"`

### urls

- **+ added** `.webpack/renderer/183/index.js::https://github.com/SocketDev/sfw-free` — in b: `.webpack/renderer/183/index.js:1` · literal

## Not established

- A JavaScript app was read only in part; items in unread files are unknown, not absent. Run `hexvero analyze <path> --all` on both first.
- a: `ipc_channel_unresolved` 12 IPC call(s) pass a channel that is not a literal or a constant that could be followed (a parameter, a computed value). They are in the collection ipc without a channel: ipcMain.on at .webpack/main/index.js:2, ipcMain.on at .webpack/main/index.js:2, ipcMain.on at .webpack/main/index.js:2, ipcMain.on at .webpack/main/index.js:2, ipcMain.on at .webpack/main/index.js:2 … and 7 more.
- a: `window_options_unresolved` 1 window(s) take options that could not be followed (a parameter, a call, a condition, a spread of something not declared in the file), so settings not written after that are not known and read as computed: e at .webpack/main/index.js:2.
- a: `unresolved_references` 7 relative or dynamic references could not be resolved to files.
- b: `js_files_skipped` 1 files were not read because they exceed the per-file size limit or could not be decoded (e.g. .webpack/sfw/dist/sfw.mjs).
- b: `ipc_channel_unresolved` 12 IPC call(s) pass a channel that is not a literal or a constant that could be followed (a parameter, a computed value). They are in the collection ipc without a channel: ipcMain.on at .webpack/main/index.js:2, ipcMain.on at .webpack/main/index.js:2, ipcMain.on at .webpack/main/index.js:2, ipcMain.on at .webpack/main/index.js:2, ipcMain.on at .webpack/main/index.js:2 … and 7 more.
- b: `window_options_unresolved` 1 window(s) take options that could not be followed (a parameter, a call, a condition, a spread of something not declared in the file), so settings not written after that are not known and read as computed: e at .webpack/main/index.js:2.
- b: `unresolved_references` 7 relative or dynamic references could not be resolved to files.
- Absence from a list means hexvero did not find it in the files it read, not that the app cannot do it.
- Values computed at run time are shown as `${…}` or left out; nothing here was observed running.

## Reproduce

```bash
npx hexvero@0.8.0 compare fiddle-0.38.0.asar fiddle-0.39.0.asar --report report.md
```
