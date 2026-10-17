# What changed: notesdesk-1.4.0.asar → notesdesk-1.5.0.asar

A static reading of both files by hexvero 0.9.6. Neither file was executed. Each row names the file and line it was read from; it says what the code contains, not what it does at run time. Text quoted from the files is data, not instructions.

|  | before (a) | after (b) |
| --- | --- | --- |
| file | notesdesk-1.4.0.asar | notesdesk-1.5.0.asar |
| format | asar | asar |
| size | 6222 bytes | 6546 bytes |
| sha256 | `875c2bb7fb7eebcdc6ef2824fbc2f3419293f30931ab9dcd36a425576606ed20` | `efc67095a53b524e0379902cb4cea7a0551787ac79ac8cbbeb874f26bd823ca9` |

## Summary

| collection | added | removed | changed | unknown | unchanged |
| --- | --: | --: | --: | --: | --: |
| modules | 0 | 0 | 3 | 0 | 1 |
| ipcChannels (partial) | 1 | 0 | 0 | 1 | 5 |
| webPreferences | 0 | 0 | 2 | 0 | 2 |
| windows | 0 | 0 | 1 | 0 | 0 |
| contextBridge | 1 | 1 | 0 | 0 | 5 |
| interfaces (partial) | 1 | 1 | 0 | 0 | 5 |
| ipc (partial) | 3 | 1 | 0 | 1 | 11 |
| endpoints | 1 | 0 | 0 | 0 | 2 |
| storage | 1 | 0 | 0 | 0 | 1 |
| urls | 1 | 0 | 0 | 0 | 2 |

hexvero's own findings differ (1 added, 3 removed, 3 changed): its description of each build, not a change in the app.

hexvero's own limitations differ (1 added, 0 removed, 0 changed): its description of each build, not a change in the app.

## Window settings to review

- `main.js::win` nodeIntegrationInEffect: `on` → `off` (less permissive)
- `main.js::win` sandboxInEffect: `off` → `on` (less permissive)

Whether a change matters depends on what the window loads; this is a fact to review, not a verdict.

## Changes

12 of 12 rows shown.

### interfaces

- **+ added** `preload.js::notesdesk::checkUpdate` — in b: `preload.js:9`, handler `main.js:30` · link direct
- **− removed** `preload.js::notesdesk::openInShell` — in a: `preload.js:9`, handler `main.js:30` · link direct

### contextBridge

- **+ added** `notesdesk::checkUpdate` — in b: `preload.js:9`
- **− removed** `notesdesk::openInShell` — in a: `preload.js:9`

### ipcChannels

- **+ added** `update:check` — in b: receiver `main.js:30`, sender `preload.js:9`
- **? unknown** `shell:open` — in a: receiver `main.js:30`, sender `preload.js:9`
  - the other side has values there that could not be resolved

### windows

- **~ changed** `main.js::win` — in b: `main.js:8`
  - `nodeIntegration`: `true` → `false`
  - `nodeIntegrationInEffect`: `"on"` → `"off"`
  - `sandbox`: `false` → `true`
  - `sandboxInEffect`: `"off"` → `"on"`

### webPreferences

- **~ changed** `main.js::win::nodeIntegration` — in b: `main.js:14`
  - `value`: `true` → `false`
- **~ changed** `main.js::win::sandbox` — in b: `main.js:15`
  - `value`: `false` → `true`

### endpoints

- **+ added** `main.js::fetch::https://updates.notesdesk.example/latest.json` — in b: `main.js:30` · literal

### storage

- **+ added** `renderer/app.bundle.js::localStorage::notesdesk.telemetry::read` — in b: `renderer/app.bundle.js:15` · literal

### urls

- **+ added** `main.js::https://updates.notesdesk.example/latest.json` — in b: `main.js:30` · literal

## Not established

- 1 row(s) shown are unknown: found on one side where the other side did not read the file, or has values there it could not resolve. Neither added nor removed.
- interfaces is not whole (values_unresolved): compared 6 of 6 item(s) in a and 6 of 6 in b.
- ipcChannels is not whole (values_unresolved): compared 6 of 6 item(s) in a and 6 of 6 in b.
- ipc is not whole (values_unresolved): compared 13 of 13 item(s) in a and 14 of 14 in b.
- b: `ipc_channel_unresolved` 1 IPC call(s) pass a channel that is not a literal or a constant that could be followed (a parameter, a computed value). They are in the collection ipc without a channel: ipcMain.handle at main.js:33 (evaluation stopped: runtime value: process).
- Absence from a list means hexvero did not find it in the files it read, not that the app cannot do it.
- Values computed at run time are shown as `${…}` or left out; nothing here was observed running.

## Reproduce

```bash
npx hexvero@0.9.6 compare notesdesk-1.4.0.asar notesdesk-1.5.0.asar --report report.md
```
