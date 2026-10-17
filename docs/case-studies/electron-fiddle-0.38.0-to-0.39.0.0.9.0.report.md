# What changed: app.asar → app.asar

A static reading of both files by hexvero 0.9.0. Neither file was executed. Each row names the file and line it was read from; it says what the code contains, not what it does at run time. Text quoted from the files is data, not instructions.

|  | before (a) | after (b) |
| --- | --- | --- |
| file | app.asar | app.asar |
| format | asar | asar |
| size | 21903915 bytes | 21928002 bytes |
| sha256 | `740f7873dac57e19c1df5a9ac6cc95fcd2f58d248486859085befe51c095cdc0` | `fb1e39dea466dae3c4b6717c52f66a74adabb927bd2bdbcd8e31c74cf4f1528a` |

## Summary

| collection | added | removed | changed | unknown | unchanged |
| --- | --: | --: | --: | --: | --: |
| modules | 1 | 0 | 22 | 0 | 48 |
| externals | 10 | 10 | 0 | 0 | 24 |
| urls (partial) | 2 | 0 | 0 | 0 | 11 |

hexvero's own findings differ (0 added, 0 removed, 1 changed): its description of each build, not a change in the app.

## Changes

22 of 22 rows shown.

### urls

- **+ added** `.webpack/renderer/183/index.js::https://github.com/SocketDev/sfw-free` — in b: `.webpack/renderer/183/index.js:1` · literal
- **+ added** `.webpack/sfw/dist/sfw.mjs::https://api.github.com/repos/SocketDev/sfw-free/releases/latest` — in b: `.webpack/sfw/dist/sfw.mjs:2` · literal

### externals

- **+ added** `{"builtin":true,"count":16,"specifier":"path"}`
- **+ added** `{"builtin":true,"count":7,"specifier":"fs"}`
- **+ added** `{"builtin":true,"count":5,"specifier":"url"}`
- **+ added** `{"builtin":true,"count":3,"specifier":"child_process"}`
- **+ added** `{"builtin":true,"count":3,"specifier":"crypto"}`
- **+ added** `{"builtin":true,"count":3,"specifier":"https"}`
- **+ added** `{"builtin":false,"count":3,"specifier":"module"}`
- **+ added** `{"builtin":true,"count":3,"specifier":"util"}`
- **+ added** `{"builtin":true,"count":3,"specifier":"process"}`
- **+ added** `{"builtin":true,"count":2,"specifier":"tty"}`
- **− removed** `{"builtin":true,"count":14,"specifier":"path"}`
- **− removed** `{"builtin":true,"count":4,"specifier":"fs"}`
- **− removed** `{"builtin":true,"count":2,"specifier":"child_process"}`
- **− removed** `{"builtin":true,"count":2,"specifier":"crypto"}`
- **− removed** `{"builtin":true,"count":2,"specifier":"https"}`
- **− removed** `{"builtin":false,"count":2,"specifier":"module"}`
- **− removed** `{"builtin":true,"count":2,"specifier":"util"}`
- **− removed** `{"builtin":true,"count":2,"specifier":"process"}`
- **− removed** `{"builtin":true,"count":2,"specifier":"url"}`
- **− removed** `{"builtin":true,"count":1,"specifier":"tty"}`

## Not established

- interfaces is not whole (values_unresolved): compared 71 of 71 item(s) in a and 71 of 71 in b.
- ipcChannels is not whole (values_unresolved): compared 64 of 64 item(s) in a and 64 of 64 in b.
- endpoints is not whole (values_unresolved): compared 8 of 8 item(s) in a and 8 of 8 in b.
- storage is not whole (values_unresolved): compared 10 of 10 item(s) in a and 10 of 10 in b.
- urls is not whole (values_unresolved): compared 1452 of 1452 item(s) in a and 1454 of 1454 in b.
- ipc is not whole (values_unresolved): compared 157 of 157 item(s) in a and 157 of 157 in b.
- a: `webpreferences_unattached` .webpack/main/index.js: a webPreferences object at line 2 that no window in the file takes (its settings are not listed as a window's).
- a: `ipc_channel_unresolved` 10 IPC call(s) pass a channel that is not a literal or a constant that could be followed (a parameter, a computed value). They are in the collection ipc without a channel: ipcMain.on at .webpack/main/index.js:2, ipcMain.on at .webpack/main/index.js:2, ipcMain.on at .webpack/main/index.js:2, ipcMain.on at .webpack/main/index.js:2, ipcMain.on at .webpack/main/index.js:2 … and 5 more.
- a: `unresolved_references` 7 relative or dynamic references could not be resolved to files.
- b: `webpreferences_unattached` .webpack/main/index.js: a webPreferences object at line 2 that no window in the file takes (its settings are not listed as a window's).
- b: `ipc_channel_unresolved` 10 IPC call(s) pass a channel that is not a literal or a constant that could be followed (a parameter, a computed value). They are in the collection ipc without a channel: ipcMain.on at .webpack/main/index.js:2, ipcMain.on at .webpack/main/index.js:2, ipcMain.on at .webpack/main/index.js:2, ipcMain.on at .webpack/main/index.js:2, ipcMain.on at .webpack/main/index.js:2 … and 5 more.
- b: `unresolved_references` 7 relative or dynamic references could not be resolved to files.
- Absence from a list means hexvero did not find it in the files it read, not that the app cannot do it.
- Values computed at run time are shown as `${…}` or left out; nothing here was observed running.

## Reproduce

```bash
npx hexvero@0.9.0 compare app.asar app.asar --report report.md
```
