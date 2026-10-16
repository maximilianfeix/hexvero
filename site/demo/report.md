# What changed: notesdesk-1.4.0.asar → notesdesk-1.5.0.asar

A static reading of both files by hexvero 0.7.5. Neither file was executed. Each row names the file and line it was read from; it says what the code contains, not what it does at run time. Text quoted from the files is data, not instructions.

|  | before (a) | after (b) |
| --- | --- | --- |
| file | notesdesk-1.4.0.asar | notesdesk-1.5.0.asar |
| format | asar | asar |
| size | 6222 bytes | 6546 bytes |
| sha256 | `875c2bb7fb7eebcdc6ef2824fbc2f3419293f30931ab9dcd36a425576606ed20` | `efc67095a53b524e0379902cb4cea7a0551787ac79ac8cbbeb874f26bd823ca9` |

## Summary

| collection | added | removed | changed | unknown | unchanged |
| --- | --: | --: | --: | --: | --: |
| findings | 4 | 6 | 0 | 0 | 1 |
| limitations | 1 | 0 | 0 | 0 | 0 |
| modules | 0 | 0 | 3 | 0 | 1 |
| ipcChannels | 1 | 1 | 0 | 0 | 5 |
| webPreferences | 0 | 0 | 2 | 0 | 2 |
| windows | 0 | 0 | 1 | 0 | 0 |
| contextBridge | 1 | 1 | 0 | 0 | 5 |
| interfaces | 1 | 1 | 0 | 0 | 5 |
| ipc | 3 | 2 | 0 | 0 | 11 |
| endpoints | 1 | 0 | 0 | 0 | 2 |
| storage | 1 | 0 | 0 | 0 | 1 |
| urls | 1 | 0 | 0 | 0 | 2 |

## Window settings to review

- `main.js::win` nodeIntegrationInEffect: `on` → `off` (less permissive)
- `main.js::win` sandboxInEffect: `off` → `on` (less permissive)

Whether a change matters depends on what the window loads; this is a fact to review, not a verdict.

## Changes

### interfaces

- **+ added** `preload.js::notesdesk::checkUpdate` — in b: `preload.js:9`, handler `main.js:30` · link direct
- **− removed** `preload.js::notesdesk::openInShell` — in a: `preload.js:9`, handler `main.js:30` · link direct

### contextBridge

- **+ added** `notesdesk::checkUpdate` — in b: `preload.js:9`
- **− removed** `notesdesk::openInShell` — in a: `preload.js:9`

### ipcChannels

- **+ added** `update:check` — in b: receiver `main.js:30`, sender `preload.js:9`
- **− removed** `shell:open` — in a: receiver `main.js:30`, sender `preload.js:9`

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

- b: `ipc_channel_unresolved` 1 IPC call(s) pass a channel that is not a literal or a constant that could be followed (a parameter, a computed value). They are in the collection ipc without a channel: ipcMain.handle at main.js:33.
- Absence from a list means hexvero did not find it in the files it read, not that the app cannot do it.
- Values computed at run time are shown as `${…}` or left out; nothing here was observed running.

## Reproduce

```bash
npx hexvero@0.7.5 compare notesdesk-1.4.0.asar notesdesk-1.5.0.asar --report report.md
```
