# REA 6.4.0 on the hexvero corpus

Tool: name REA · version 6.4.0 · package rea-agents · cli 6.4.0 · node v24.21.0 · platform darwin arm64 · mapping alternative: store calls counted as storage · deep providers none installed (Ghidra, Hopper, IDA)

## Per class

| set | class | inputs | hit | missed | false | not found but warned |
| --- | --- | --- | --- | --- | --- | --- |
| dev | comparison | 1 | 0 | 0 | 0 |  |
| dev | imports | 2 | 12 | 0 | 0 |  |
| dev | functions | 2 | 0 | 14 | 0 |  |
| dev | call paths | 2 | 0 | 8 | 0 |  |
| dev | direct callers | 2 | 0 | 8 | 0 |  |
| dev | IPC channels | 3 | 12 | 6 | 0 |  |
| dev | IPC senders and receivers | 3 | 21 | 3 | 0 |  |
| dev | window settings | 3 | 9 | 12 | 0 |  |
| dev | bridge members | 3 | 18 | 0 | 0 |  |
| dev | bridge member channel | 3 | 3 | 15 | 0 |  |
| dev | endpoints | 3 | 15 | 3 | 6 |  |
| dev | endpoint method | 3 | 3 | 3 | 0 |  |
| dev | requests with an unknown URL shown | 3 | 2 | 1 | 2 |  |
| dev | storage keys | 3 | 15 | 6 | 0 |  |
| dev | storage read/write/delete | 3 | 12 | 0 | 0 |  |
| dev | changes in ipcChannels | 1 | 2 | 0 | 0 |  |
| dev | changes in contextBridge | 1 | 2 | 0 | 0 |  |
| dev | changes in webPreferences | 1 | 0 | 2 | 0 |  |
| dev | changes in endpoints | 1 | 3 | 0 | 0 |  |
| dev | changes in storage | 1 | 2 | 0 | 0 |  |

## Per input

| set | input | class | hit | missed | false | notes |
| --- | --- | --- | --- | --- | --- | --- |
| dev | dev/calls.O2.macho-arm64 → dev/calls-v2.O2.macho-arm64 | comparison | 0 | 0 | 0 | NOT RUN: no observation |
| dev | dev/calls.O0.macho-arm64 (inspect-macho) | imports | 6 | 0 | 0 |  |
| dev | dev/calls.O0.macho-arm64 (inspect-macho) | functions | 0 | 7 | 0 | missed main; missed parse; missed validate; missed dispatch; missed run_command; missed unused_helper; missed by_pointer |
| dev | dev/calls.O0.macho-arm64 (inspect-macho) | call paths | 0 | 4 | 0 | main → validate: no answer; main → system: no answer; main → puts: no answer; parse → system: no answer |
| dev | dev/calls.O0.macho-arm64 (inspect-macho) | direct callers | 0 | 4 | 0 | unused_helper: function not found; by_pointer: function not found; validate: function not found; run_command: function not found |
| dev | dev/calls.O2.macho-arm64 (inspect-macho) | imports | 6 | 0 | 0 |  |
| dev | dev/calls.O2.macho-arm64 (inspect-macho) | functions | 0 | 7 | 0 | missed main; missed parse; missed validate; missed dispatch; missed run_command; missed unused_helper; missed by_pointer |
| dev | dev/calls.O2.macho-arm64 (inspect-macho) | call paths | 0 | 4 | 0 | main → validate: no answer; main → system: no answer; main → puts: no answer; parse → system: no answer |
| dev | dev/calls.O2.macho-arm64 (inspect-macho) | direct callers | 0 | 4 | 0 | unused_helper: function not found; by_pointer: function not found; validate: function not found; run_command: function not found |
| dev | dev/notes-app.plain.asar | IPC channels | 4 | 2 | 0 | missed doc:save; missed app:pong |
| dev | dev/notes-app.plain.asar | IPC senders and receivers | 7 | 1 | 0 | doc:changed: sender main.js missed |
| dev | dev/notes-app.plain.asar | window settings | 4 | 3 | 0 | missed main.js nodeIntegration=true; missed main.js contextIsolation=false; missed main.js sandbox=false |
| dev | dev/notes-app.plain.asar | bridge members | 6 | 0 | 0 |  |
| dev | dev/notes-app.plain.asar | bridge member channel | 1 | 5 | 0 | notes.open: expected doc:open, got null; notes.save: expected doc:save, got null; notes.rename: expected doc:rename, got null; notes.ping: expected app:ping, got null; notes.onChanged: expected doc:changed, got null |
| dev | dev/notes-app.plain.asar | endpoints | 5 | 1 | 2 | missed https://api.notes.example/v1/users/…; false /local/route; false items |
| dev | dev/notes-app.plain.asar | endpoint method | 1 | 1 | 0 | https://upload.notes.example/blob: expected PUT |
| dev | dev/notes-app.plain.asar | requests with an unknown URL shown | 1 | 0 | 1 |  |
| dev | dev/notes-app.plain.asar | storage keys | 5 | 2 | 0 | missed cookie document.cookie; missed electron-store window.lastOpened |
| dev | dev/notes-app.plain.asar | storage read/write/delete | 4 | 0 | 0 | tool reported the analysis as partial |
| dev | dev/notes-app.bundled.asar | IPC channels | 4 | 2 | 0 | missed doc:save; missed app:pong |
| dev | dev/notes-app.bundled.asar | IPC senders and receivers | 7 | 1 | 0 | doc:changed: sender main.js missed |
| dev | dev/notes-app.bundled.asar | window settings | 4 | 3 | 0 | missed main.js nodeIntegration=true; missed main.js contextIsolation=false; missed main.js sandbox=false |
| dev | dev/notes-app.bundled.asar | bridge members | 6 | 0 | 0 |  |
| dev | dev/notes-app.bundled.asar | bridge member channel | 1 | 5 | 0 | notes.open: expected doc:open, got null; notes.save: expected doc:save, got null; notes.rename: expected doc:rename, got null; notes.ping: expected app:ping, got null; notes.onChanged: expected doc:changed, got null |
| dev | dev/notes-app.bundled.asar | endpoints | 5 | 1 | 2 | missed https://api.notes.example/v1/users/…; false /local/route; false items |
| dev | dev/notes-app.bundled.asar | endpoint method | 1 | 1 | 0 | https://upload.notes.example/blob: expected PUT |
| dev | dev/notes-app.bundled.asar | requests with an unknown URL shown | 1 | 0 | 1 |  |
| dev | dev/notes-app.bundled.asar | storage keys | 5 | 2 | 0 | missed cookie document.cookie; missed electron-store window.lastOpened |
| dev | dev/notes-app.bundled.asar | storage read/write/delete | 4 | 0 | 0 | tool reported the analysis as partial |
| dev | dev/notes-app.minified.asar | IPC channels | 4 | 2 | 0 | missed doc:save; missed app:pong |
| dev | dev/notes-app.minified.asar | IPC senders and receivers | 7 | 1 | 0 | doc:changed: sender main.js missed |
| dev | dev/notes-app.minified.asar | window settings | 1 | 6 | 0 | missed main.js contextIsolation=true; missed main.js nodeIntegration=false; missed main.js sandbox=true; missed main.js nodeIntegration=true; missed main.js contextIsolation=false; missed main.js sandbox=false |
| dev | dev/notes-app.minified.asar | bridge members | 6 | 0 | 0 |  |
| dev | dev/notes-app.minified.asar | bridge member channel | 1 | 5 | 0 | notes.open: expected doc:open, got null; notes.save: expected doc:save, got null; notes.rename: expected doc:rename, got null; notes.ping: expected app:ping, got null; notes.onChanged: expected doc:changed, got null |
| dev | dev/notes-app.minified.asar | endpoints | 5 | 1 | 2 | missed https://api.notes.example/v1/users/…; false items; false /local/route |
| dev | dev/notes-app.minified.asar | endpoint method | 1 | 1 | 0 | https://upload.notes.example/blob: expected PUT |
| dev | dev/notes-app.minified.asar | requests with an unknown URL shown | 0 | 1 | 0 |  |
| dev | dev/notes-app.minified.asar | storage keys | 5 | 2 | 0 | missed cookie document.cookie; missed electron-store window.lastOpened |
| dev | dev/notes-app.minified.asar | storage read/write/delete | 4 | 0 | 0 | tool reported the analysis as partial |
| dev | dev/notes-app.plain.asar → dev/notes-app-v2.plain.asar | changes in ipcChannels | 2 | 0 | 0 |  |
| dev | dev/notes-app.plain.asar → dev/notes-app-v2.plain.asar | changes in contextBridge | 2 | 0 | 0 |  |
| dev | dev/notes-app.plain.asar → dev/notes-app-v2.plain.asar | changes in webPreferences | 0 | 2 | 0 | missed ~nodeIntegration: true -> false; missed ~sandbox: false -> true |
| dev | dev/notes-app.plain.asar → dev/notes-app-v2.plain.asar | changes in endpoints | 3 | 0 | 0 |  |
| dev | dev/notes-app.plain.asar → dev/notes-app-v2.plain.asar | changes in storage | 2 | 0 | 0 |  |
