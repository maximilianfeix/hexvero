# REA 6.5.0 on the hexvero corpus

Tool: name REA · version 6.5.0 · package rea-agents · cli 6.5.0 · node v25.2.1 · platform darwin arm64 · mapping default · deep providers none installed (Ghidra, Hopper, IDA)

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
| dev | endpoints | 3 | 15 | 3 | 9 |  |
| dev | endpoint method | 3 | 3 | 3 | 0 |  |
| dev | requests with an unknown URL shown | 3 | 2 | 1 | 2 |  |
| dev | storage keys | 3 | 12 | 9 | 0 |  |
| dev | storage read/write/delete | 3 | 9 | 0 | 0 |  |
| dev | changes in ipcChannels | 1 | 2 | 0 | 0 |  |
| dev | changes in contextBridge | 1 | 2 | 0 | 0 |  |
| dev | changes in webPreferences | 1 | 0 | 2 | 0 |  |
| dev | changes in endpoints | 1 | 3 | 0 | 0 |  |
| dev | changes in storage | 1 | 2 | 0 | 0 |  |
| validation | IPC channels | 3 | 39 | 12 | 0 |  |
| validation | IPC senders and receivers | 3 | 54 | 30 | 0 |  |
| validation | window settings | 3 | 2 | 19 | 0 |  |
| validation | bridge members | 3 | 30 | 9 | 0 |  |
| validation | bridge member channel | 3 | 6 | 24 | 0 |  |
| validation | endpoints | 3 | 18 | 15 | 18 |  |
| validation | endpoint method | 3 | 0 | 6 | 0 |  |
| validation | requests with an unknown URL shown | 3 | 4 | 2 | 4 |  |
| validation | storage keys | 3 | 15 | 18 | 0 |  |
| validation | storage read/write/delete | 3 | 12 | 0 | 0 |  |
| validation | changes in ipcChannels | 1 | 2 | 1 | 0 |  |
| validation | changes in contextBridge | 1 | 2 | 0 | 0 |  |
| validation | changes in webPreferences | 1 | 1 | 1 | 0 |  |
| validation | changes in endpoints | 1 | 4 | 0 | 2 |  |
| validation | changes in storage | 1 | 2 | 2 | 0 |  |
| validation | imports | 2 | 14 | 0 | 0 |  |
| validation | functions | 2 | 0 | 20 | 0 |  |
| validation | call paths | 2 | 0 | 26 | 0 |  |
| validation | direct callers | 2 | 0 | 22 | 0 |  |
| holdout | imports | 2 | 11 | 0 | 0 |  |
| holdout | functions | 2 | 0 | 34 | 0 |  |
| holdout | call paths | 2 | 0 | 36 | 0 |  |
| holdout | direct callers | 2 | 0 | 46 | 0 |  |
| holdout | IPC channels | 3 | 35 | 37 | 0 |  |
| holdout | IPC senders and receivers | 3 | 53 | 14 | 0 |  |
| holdout | window settings | 3 | 0 | 33 | 0 |  |
| holdout | bridge members | 3 | 0 | 69 | 0 |  |
| holdout | bridge member channel | 3 | 0 | 0 | 0 |  |
| holdout | endpoints | 3 | 12 | 30 | 30 |  |
| holdout | endpoint method | 3 | 0 | 6 | 0 |  |
| holdout | requests with an unknown URL shown | 3 | 2 | 1 | 16 |  |
| holdout | storage keys | 3 | 12 | 39 | 0 |  |
| holdout | storage read/write/delete | 3 | 6 | 3 | 0 |  |
| holdout | changes in ipcChannels | 1 | 0 | 3 | 1 |  |
| holdout | changes in contextBridge | 1 | 0 | 3 | 0 |  |
| holdout | changes in webPreferences | 1 | 0 | 2 | 0 |  |
| holdout | changes in endpoints | 1 | 0 | 8 | 0 |  |
| holdout | changes in storage | 1 | 0 | 2 | 0 |  |
| holdout2 | electron analysis | 6 | 0 | 0 | 0 |  |
| holdout2 | comparison | 1 | 0 | 0 | 0 |  |
| damaged | damaged input | 6 | 6 | 0 | 0 |  |

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
| dev | dev/notes-app.plain.asar | endpoints | 5 | 1 | 3 | missed https://api.notes.example/v1/users/…; false window.bounds; false /local/route; false items |
| dev | dev/notes-app.plain.asar | endpoint method | 1 | 1 | 0 | https://upload.notes.example/blob: expected PUT |
| dev | dev/notes-app.plain.asar | requests with an unknown URL shown | 1 | 0 | 1 |  |
| dev | dev/notes-app.plain.asar | storage keys | 4 | 3 | 0 | missed cookie document.cookie; missed electron-store window.lastOpened; missed electron-store window.bounds |
| dev | dev/notes-app.plain.asar | storage read/write/delete | 3 | 0 | 0 | tool reported the analysis as partial |
| dev | dev/notes-app.bundled.asar | IPC channels | 4 | 2 | 0 | missed doc:save; missed app:pong |
| dev | dev/notes-app.bundled.asar | IPC senders and receivers | 7 | 1 | 0 | doc:changed: sender main.js missed |
| dev | dev/notes-app.bundled.asar | window settings | 4 | 3 | 0 | missed main.js nodeIntegration=true; missed main.js contextIsolation=false; missed main.js sandbox=false |
| dev | dev/notes-app.bundled.asar | bridge members | 6 | 0 | 0 |  |
| dev | dev/notes-app.bundled.asar | bridge member channel | 1 | 5 | 0 | notes.open: expected doc:open, got null; notes.save: expected doc:save, got null; notes.rename: expected doc:rename, got null; notes.ping: expected app:ping, got null; notes.onChanged: expected doc:changed, got null |
| dev | dev/notes-app.bundled.asar | endpoints | 5 | 1 | 3 | missed https://api.notes.example/v1/users/…; false window.bounds; false items; false /local/route |
| dev | dev/notes-app.bundled.asar | endpoint method | 1 | 1 | 0 | https://upload.notes.example/blob: expected PUT |
| dev | dev/notes-app.bundled.asar | requests with an unknown URL shown | 1 | 0 | 1 |  |
| dev | dev/notes-app.bundled.asar | storage keys | 4 | 3 | 0 | missed cookie document.cookie; missed electron-store window.lastOpened; missed electron-store window.bounds |
| dev | dev/notes-app.bundled.asar | storage read/write/delete | 3 | 0 | 0 | tool reported the analysis as partial |
| dev | dev/notes-app.minified.asar | IPC channels | 4 | 2 | 0 | missed doc:save; missed app:pong |
| dev | dev/notes-app.minified.asar | IPC senders and receivers | 7 | 1 | 0 | doc:changed: sender main.js missed |
| dev | dev/notes-app.minified.asar | window settings | 1 | 6 | 0 | missed main.js contextIsolation=true; missed main.js nodeIntegration=false; missed main.js sandbox=true; missed main.js nodeIntegration=true; missed main.js contextIsolation=false; missed main.js sandbox=false |
| dev | dev/notes-app.minified.asar | bridge members | 6 | 0 | 0 |  |
| dev | dev/notes-app.minified.asar | bridge member channel | 1 | 5 | 0 | notes.open: expected doc:open, got null; notes.save: expected doc:save, got null; notes.rename: expected doc:rename, got null; notes.ping: expected app:ping, got null; notes.onChanged: expected doc:changed, got null |
| dev | dev/notes-app.minified.asar | endpoints | 5 | 1 | 3 | missed https://api.notes.example/v1/users/…; false window.bounds; false /local/route; false items |
| dev | dev/notes-app.minified.asar | endpoint method | 1 | 1 | 0 | https://upload.notes.example/blob: expected PUT |
| dev | dev/notes-app.minified.asar | requests with an unknown URL shown | 0 | 1 | 0 |  |
| dev | dev/notes-app.minified.asar | storage keys | 4 | 3 | 0 | missed cookie document.cookie; missed electron-store window.lastOpened; missed electron-store window.bounds |
| dev | dev/notes-app.minified.asar | storage read/write/delete | 3 | 0 | 0 | tool reported the analysis as partial |
| dev | dev/notes-app.plain.asar → dev/notes-app-v2.plain.asar | changes in ipcChannels | 2 | 0 | 0 |  |
| dev | dev/notes-app.plain.asar → dev/notes-app-v2.plain.asar | changes in contextBridge | 2 | 0 | 0 |  |
| dev | dev/notes-app.plain.asar → dev/notes-app-v2.plain.asar | changes in webPreferences | 0 | 2 | 0 | missed ~nodeIntegration: true -> false; missed ~sandbox: false -> true |
| dev | dev/notes-app.plain.asar → dev/notes-app-v2.plain.asar | changes in endpoints | 3 | 0 | 0 |  |
| dev | dev/notes-app.plain.asar → dev/notes-app-v2.plain.asar | changes in storage | 2 | 0 | 0 |  |
| validation | validation/chat-app.plain.asar | IPC channels | 13 | 4 | 0 | missed chat:send-message; missed chat:history; missed settings:saved; missed telemetry:hit |
| validation | validation/chat-app.plain.asar | IPC senders and receivers | 18 | 10 | 0 | rooms:join: receiver main.js missed; rooms:leave: receiver main.js missed; presence:typing: sender preload.js missed; app:locale: sender renderer-settings.js missed; auth:sign-out: sender renderer-settings.js missed; settings:reset: sender renderer-settings.js missed; settings:save: sender renderer-settings.js missed; chat:incoming: sender main.js missed; presence:update: sender main.js missed; presence:update: receiver renderer-settings.js missed |
| validation | validation/chat-app.plain.asar | window settings | 1 | 6 | 0 | missed main.js preload=preload.js; missed main.js contextIsolation=true; missed main.js nodeIntegration=false; missed main.js sandbox=true; missed main.js nodeIntegration=true; missed main.js contextIsolation=false |
| validation | validation/chat-app.plain.asar | bridge members | 10 | 3 | 0 | missed session.bootstrap; missed session.signOut; missed session.onPresence; 1 entry reported as unreadable |
| validation | validation/chat-app.plain.asar | bridge member channel | 2 | 8 | 0 | chat.sendMessage: expected chat:send-message, got null; chat.listRooms: expected rooms:list, got null; chat.history: expected chat:history, got null; chat.join: expected rooms:join, got null; chat.leave: expected rooms:leave, got null; chat.typing: expected presence:typing, got null; chat.onIncoming: expected chat:incoming, got null; chat.openSettings: expected settings:open, got null |
| validation | validation/chat-app.plain.asar | endpoints | 6 | 5 | 6 | missed https://api.chat.example/v2/rooms/…; missed https://api.chat.example/v2/users/…; missed https://status.chat.example/health.json; missed wss://gateway.chat.example/socket; missed https://updates.chat.example/desktop/report; false ui.zoom; false https://ghost.chat.example/cache-key; false window.bounds; false https://ghost.chat.example/cache-open; false ghost.map-key; false auth.refreshToken |
| validation | validation/chat-app.plain.asar | endpoint method | 0 | 2 | 0 | https://api.chat.example/v2/messages: expected POST; https://api.chat.example/v2/session: expected DELETE |
| validation | validation/chat-app.plain.asar | requests with an unknown URL shown | 2 | 0 | 2 |  |
| validation | validation/chat-app.plain.asar | storage keys | 5 | 6 | 0 | missed localStorage auth.token; missed indexedDB chat-cache-v1; missed cookie document.cookie; missed electron-store window.bounds; missed electron-store ui.zoom; missed electron-store auth.refreshToken |
| validation | validation/chat-app.plain.asar | storage read/write/delete | 4 | 0 | 0 | tool reported the analysis as partial |
| validation | validation/chat-app.bundled.asar | IPC channels | 13 | 4 | 0 | missed chat:send-message; missed chat:history; missed settings:saved; missed telemetry:hit |
| validation | validation/chat-app.bundled.asar | IPC senders and receivers | 18 | 10 | 0 | rooms:join: receiver main.js missed; rooms:leave: receiver main.js missed; presence:typing: sender preload.js missed; app:locale: sender renderer-settings.js missed; auth:sign-out: sender renderer-settings.js missed; settings:reset: sender renderer-settings.js missed; settings:save: sender renderer-settings.js missed; chat:incoming: sender main.js missed; presence:update: sender main.js missed; presence:update: receiver renderer-settings.js missed |
| validation | validation/chat-app.bundled.asar | window settings | 1 | 6 | 0 | missed main.js preload=preload.js; missed main.js contextIsolation=true; missed main.js nodeIntegration=false; missed main.js sandbox=true; missed main.js nodeIntegration=true; missed main.js contextIsolation=false |
| validation | validation/chat-app.bundled.asar | bridge members | 10 | 3 | 0 | missed session.bootstrap; missed session.signOut; missed session.onPresence; 1 entry reported as unreadable |
| validation | validation/chat-app.bundled.asar | bridge member channel | 2 | 8 | 0 | chat.sendMessage: expected chat:send-message, got null; chat.listRooms: expected rooms:list, got null; chat.history: expected chat:history, got null; chat.join: expected rooms:join, got null; chat.leave: expected rooms:leave, got null; chat.typing: expected presence:typing, got null; chat.onIncoming: expected chat:incoming, got null; chat.openSettings: expected settings:open, got null |
| validation | validation/chat-app.bundled.asar | endpoints | 6 | 5 | 6 | missed https://api.chat.example/v2/rooms/…; missed https://api.chat.example/v2/users/…; missed https://status.chat.example/health.json; missed wss://gateway.chat.example/socket; missed https://updates.chat.example/desktop/report; false https://ghost.chat.example/cache-open; false auth.refreshToken; false ghost.map-key; false window.bounds; false https://ghost.chat.example/cache-key; false ui.zoom |
| validation | validation/chat-app.bundled.asar | endpoint method | 0 | 2 | 0 | https://api.chat.example/v2/messages: expected POST; https://api.chat.example/v2/session: expected DELETE |
| validation | validation/chat-app.bundled.asar | requests with an unknown URL shown | 2 | 0 | 2 |  |
| validation | validation/chat-app.bundled.asar | storage keys | 5 | 6 | 0 | missed localStorage auth.token; missed indexedDB chat-cache-v1; missed cookie document.cookie; missed electron-store window.bounds; missed electron-store ui.zoom; missed electron-store auth.refreshToken |
| validation | validation/chat-app.bundled.asar | storage read/write/delete | 4 | 0 | 0 | tool reported the analysis as partial |
| validation | validation/chat-app.minified.asar | IPC channels | 13 | 4 | 0 | missed chat:send-message; missed chat:history; missed settings:saved; missed telemetry:hit |
| validation | validation/chat-app.minified.asar | IPC senders and receivers | 18 | 10 | 0 | rooms:join: receiver main.js missed; rooms:leave: receiver main.js missed; presence:typing: sender preload.js missed; app:locale: sender renderer-settings.js missed; auth:sign-out: sender renderer-settings.js missed; settings:reset: sender renderer-settings.js missed; settings:save: sender renderer-settings.js missed; chat:incoming: sender main.js missed; presence:update: sender main.js missed; presence:update: receiver renderer-settings.js missed |
| validation | validation/chat-app.minified.asar | window settings | 0 | 7 | 0 | missed main.js preload=preload.js; missed main.js contextIsolation=true; missed main.js nodeIntegration=false; missed main.js sandbox=true; missed main.js nodeIntegration=true; missed main.js contextIsolation=false; missed main.js sandbox=false |
| validation | validation/chat-app.minified.asar | bridge members | 10 | 3 | 0 | missed session.bootstrap; missed session.signOut; missed session.onPresence; 1 entry reported as unreadable |
| validation | validation/chat-app.minified.asar | bridge member channel | 2 | 8 | 0 | chat.sendMessage: expected chat:send-message, got null; chat.listRooms: expected rooms:list, got null; chat.history: expected chat:history, got null; chat.join: expected rooms:join, got null; chat.leave: expected rooms:leave, got null; chat.typing: expected presence:typing, got null; chat.onIncoming: expected chat:incoming, got null; chat.openSettings: expected settings:open, got null |
| validation | validation/chat-app.minified.asar | endpoints | 6 | 5 | 6 | missed https://api.chat.example/v2/rooms/…; missed https://api.chat.example/v2/users/…; missed https://status.chat.example/health.json; missed wss://gateway.chat.example/socket; missed https://updates.chat.example/desktop/report; false https://ghost.chat.example/cache-open; false auth.refreshToken; false https://ghost.chat.example/cache-key; false ghost.map-key; false ui.zoom; false window.bounds |
| validation | validation/chat-app.minified.asar | endpoint method | 0 | 2 | 0 | https://api.chat.example/v2/messages: expected POST; https://api.chat.example/v2/session: expected DELETE |
| validation | validation/chat-app.minified.asar | requests with an unknown URL shown | 0 | 2 | 0 |  |
| validation | validation/chat-app.minified.asar | storage keys | 5 | 6 | 0 | missed localStorage auth.token; missed indexedDB chat-cache-v1; missed cookie document.cookie; missed electron-store window.bounds; missed electron-store ui.zoom; missed electron-store auth.refreshToken |
| validation | validation/chat-app.minified.asar | storage read/write/delete | 4 | 0 | 0 | tool reported the analysis as partial |
| validation | validation/chat-app.plain.asar → validation/chat-app-v2.plain.asar | changes in ipcChannels | 2 | 1 | 0 | missed -telemetry:hit |
| validation | validation/chat-app.plain.asar → validation/chat-app-v2.plain.asar | changes in contextBridge | 2 | 0 | 0 |  |
| validation | validation/chat-app.plain.asar → validation/chat-app-v2.plain.asar | changes in webPreferences | 1 | 1 | 0 | missed ~contextIsolation: false -> true |
| validation | validation/chat-app.plain.asar → validation/chat-app-v2.plain.asar | changes in endpoints | 4 | 0 | 2 | false +auth.sessionKey; false -auth.refreshToken |
| validation | validation/chat-app.plain.asar → validation/chat-app-v2.plain.asar | changes in storage | 2 | 2 | 0 | missed +electron-store auth.sessionKey; missed -electron-store auth.refreshToken |
| validation | validation/dispatch.O0.macho-arm64 (inspect-macho) | imports | 7 | 0 | 0 |  |
| validation | validation/dispatch.O0.macho-arm64 (inspect-macho) | functions | 0 | 10 | 0 | missed main; missed lookup; missed plausible; missed usage; missed emit; missed finish; missed tree_sum; missed cmd_double; missed cmd_env; missed audit_cleanup |
| validation | validation/dispatch.O0.macho-arm64 (inspect-macho) | call paths | 0 | 13 | 0 | main → strlen: no answer; main → strcmp: no answer; main → printf: no answer; main → puts: no answer; main → tree_sum: no answer; cmd_env → puts: no answer; audit_cleanup → remove: no answer; main → remove: no answer; main → audit_cleanup: no answer; lookup → printf: no answer; finish → strcmp: no answer; usage → getenv: no answer; tree_sum → printf: no answer |
| validation | validation/dispatch.O0.macho-arm64 (inspect-macho) | direct callers | 0 | 11 | 0 | audit_cleanup: function not found; cmd_double: function not found; cmd_env: function not found; plausible: function not found; lookup: function not found; finish: function not found; usage: function not found; emit: function not found; tree_sum: function not found |
| validation | validation/dispatch.O2.macho-arm64 (inspect-macho) | imports | 7 | 0 | 0 |  |
| validation | validation/dispatch.O2.macho-arm64 (inspect-macho) | functions | 0 | 10 | 0 | missed main; missed lookup; missed plausible; missed usage; missed emit; missed finish; missed tree_sum; missed cmd_double; missed cmd_env; missed audit_cleanup |
| validation | validation/dispatch.O2.macho-arm64 (inspect-macho) | call paths | 0 | 13 | 0 | main → strlen: no answer; main → strcmp: no answer; main → printf: no answer; main → puts: no answer; main → tree_sum: no answer; cmd_env → puts: no answer; audit_cleanup → remove: no answer; main → remove: no answer; main → audit_cleanup: no answer; lookup → printf: no answer; finish → strcmp: no answer; usage → getenv: no answer; tree_sum → printf: no answer |
| validation | validation/dispatch.O2.macho-arm64 (inspect-macho) | direct callers | 0 | 11 | 0 | audit_cleanup: function not found; cmd_double: function not found; cmd_env: function not found; plausible: function not found; lookup: function not found; finish: function not found; usage: function not found; emit: function not found; tree_sum: function not found |
| holdout | holdout/exprcalc.O0.macho-arm64 (inspect-macho) | imports | 6 | 0 | 0 |  |
| holdout | holdout/exprcalc.O0.macho-arm64 (inspect-macho) | functions | 0 | 17 | 0 | missed main; missed evaluate; missed next_token; missed state_blank; missed state_digits; missed state_punctuation; missed parse_expression; missed parse_term; missed parse_factor; missed apply; missed trace_number; missed trace_binary; missed count_number; missed count_binary; missed report; missed complain; missed debug_level |
| holdout | holdout/exprcalc.O0.macho-arm64 (inspect-macho) | call paths | 0 | 18 | 0 | main → fputs: no answer; report → fputs: no answer; main → printf: no answer; main → parse_factor: no answer; main → apply: no answer; parse_factor → parse_term: no answer; parse_term → parse_expression: no answer; parse_expression → next_token: no answer; debug_level → atoi: no answer; main → getenv: no answer; main → atoi: no answer; main → debug_level: no answer; complain → printf: no answer; evaluate → fputs: no answer; evaluate → report: no answer; next_token → parse_expression: no answer; report → strtol: no answer; apply → next_token: no answer |
| holdout | holdout/exprcalc.O0.macho-arm64 (inspect-macho) | direct callers | 0 | 23 | 0 | debug_level: function not found; state_blank: function not found; state_digits: function not found; state_punctuation: function not found; trace_number: function not found; count_number: function not found; trace_binary: function not found; count_binary: function not found; parse_expression: function not found; parse_term: function not found; parse_factor: function not found; next_token: function not found; apply: function not found; evaluate: function not found; report: function not found; complain: function not found |
| holdout | holdout/exprcalc.O2.macho-arm64 (inspect-macho) | imports | 5 | 0 | 0 |  |
| holdout | holdout/exprcalc.O2.macho-arm64 (inspect-macho) | functions | 0 | 17 | 0 | missed main; missed evaluate; missed next_token; missed state_blank; missed state_digits; missed state_punctuation; missed parse_expression; missed parse_term; missed parse_factor; missed apply; missed trace_number; missed trace_binary; missed count_number; missed count_binary; missed report; missed complain; missed debug_level |
| holdout | holdout/exprcalc.O2.macho-arm64 (inspect-macho) | call paths | 0 | 18 | 0 | main → fputs: no answer; report → fputs: no answer; main → printf: no answer; main → parse_factor: no answer; main → apply: no answer; parse_factor → parse_term: no answer; parse_term → parse_expression: no answer; parse_expression → next_token: no answer; debug_level → atoi: no answer; main → getenv: no answer; main → atoi: no answer; main → debug_level: no answer; complain → printf: no answer; evaluate → fputs: no answer; evaluate → report: no answer; next_token → parse_expression: no answer; report → strtol: no answer; apply → next_token: no answer |
| holdout | holdout/exprcalc.O2.macho-arm64 (inspect-macho) | direct callers | 0 | 23 | 0 | debug_level: function not found; state_blank: function not found; state_digits: function not found; state_punctuation: function not found; trace_number: function not found; count_number: function not found; trace_binary: function not found; count_binary: function not found; parse_expression: function not found; parse_term: function not found; parse_factor: function not found; next_token: function not found; apply: function not found; evaluate: function not found; report: function not found; complain: function not found |
| holdout | holdout/time-tracker.plain.asar | IPC channels | 11 | 13 | 0 | missed timer:start; missed timer:stop; missed timer:tick; missed projects:list; missed projects:create; missed projects:rename; missed invoice:create; missed invoice:export; missed sync:progress; missed config:get-sync; missed menu:new-entry; missed update:ready; missed theme:changed |
| holdout | holdout/time-tracker.plain.asar | IPC senders and receivers | 17 | 4 | 0 | widget:pin: receiver main.js missed; widget:close: receiver main.js missed; invoice:exported: sender main.js missed; timer:port: sender main.js missed |
| holdout | holdout/time-tracker.plain.asar | window settings | 0 | 11 | 0 | missed main.js preload=preload.js; missed main.js contextIsolation=true; missed main.js nodeIntegration=false; missed main.js sandbox=true; missed main.js preload=preload.js; missed main.js contextIsolation=true; missed main.js sandbox=false; missed main.js nodeIntegration=false; missed main.js preload=preload.js; missed main.js contextIsolation=true; missed main.js nodeIntegration=false |
| holdout | holdout/time-tracker.plain.asar | bridge members | 0 | 23 | 0 | missed tracker.startTimer; missed tracker.stopTimer; missed tracker.onTick; missed tracker.listProjects; missed tracker.createProject; missed tracker.renameProject; missed tracker.createInvoice; missed tracker.exportInvoice; missed tracker.onceExported; missed tracker.startSync; missed tracker.cancelSync; missed tracker.onSyncProgress; missed tracker.setting; missed tracker.activate; missed tracker.onNewEntry; missed tracker.onUpdateReady; missed tracker.setBadge; missed tracker.formatDuration; missed tracker.copy; missed tracker.runtime; missed widget.pin; missed widget.close; missed widget.connect; 2 entries reported as unreadable |
| holdout | holdout/time-tracker.plain.asar | bridge member channel | 0 | 0 | 0 |  |
| holdout | holdout/time-tracker.plain.asar | endpoints | 4 | 10 | 10 | missed https://api.punchclock.example/v3/projects/…; missed https://rates.punchclock.example/latest?base=…; missed https://api.punchclock.example/v3/clients; missed https://api.punchclock.example/v3/timesheets/current…; missed https://api.punchclock.example/v3/entries; missed https://api.punchclock.example/v3/entries/…; missed https://files.punchclock.example/invoices; missed wss://live.punchclock.example/team/…; missed https://status.punchclock.example/api/v2/summary.json; missed https://updates.punchclock.example/feed/stable.json; false /entries/changed; false hours; false ghost.form-field; false ui.currency; false window.main; false sync.interval; false license.key; false note; false ui.locale; false window.widget |
| holdout | holdout/time-tracker.plain.asar | endpoint method | 0 | 2 | 0 | https://api.punchclock.example/v3/me/preferences: expected PATCH; https://hooks.punchclock.example/invoice-exported: expected POST |
| holdout | holdout/time-tracker.plain.asar | requests with an unknown URL shown | 1 | 0 | 8 |  |
| holdout | holdout/time-tracker.plain.asar | storage keys | 4 | 13 | 0 | missed localStorage punch.theme; missed localStorage punch.session; missed localStorage sidebarWidth; missed indexedDB punchclock-entries; missed indexedDB punchclock-v3; missed cookie document.cookie; missed electron-store window.main; missed electron-store window.widget; missed electron-store sync.interval; missed electron-store sync.lastRun; missed electron-store ui.locale; missed electron-store ui.currency; missed electron-store license.key |
| holdout | holdout/time-tracker.plain.asar | storage read/write/delete | 2 | 1 | 0 | sessionStorage widget.position: expected read+write+delete, got write; tool reported the analysis as partial |
| holdout | holdout/time-tracker.bundled.asar | IPC channels | 12 | 12 | 0 | missed timer:start; missed timer:stop; missed timer:tick; missed projects:list; missed projects:create; missed projects:rename; missed invoice:export; missed sync:progress; missed config:get-sync; missed menu:new-entry; missed update:ready; missed theme:changed |
| holdout | holdout/time-tracker.bundled.asar | IPC senders and receivers | 18 | 5 | 0 | widget:pin: receiver main.js missed; widget:close: receiver main.js missed; invoice:create: sender preload.js missed; invoice:exported: sender main.js missed; timer:port: sender main.js missed |
| holdout | holdout/time-tracker.bundled.asar | window settings | 0 | 11 | 0 | missed main.js preload=preload.js; missed main.js contextIsolation=true; missed main.js nodeIntegration=false; missed main.js sandbox=true; missed main.js preload=preload.js; missed main.js contextIsolation=true; missed main.js sandbox=false; missed main.js nodeIntegration=false; missed main.js preload=preload.js; missed main.js contextIsolation=true; missed main.js nodeIntegration=false |
| holdout | holdout/time-tracker.bundled.asar | bridge members | 0 | 23 | 0 | missed tracker.startTimer; missed tracker.stopTimer; missed tracker.onTick; missed tracker.listProjects; missed tracker.createProject; missed tracker.renameProject; missed tracker.createInvoice; missed tracker.exportInvoice; missed tracker.onceExported; missed tracker.startSync; missed tracker.cancelSync; missed tracker.onSyncProgress; missed tracker.setting; missed tracker.activate; missed tracker.onNewEntry; missed tracker.onUpdateReady; missed tracker.setBadge; missed tracker.formatDuration; missed tracker.copy; missed tracker.runtime; missed widget.pin; missed widget.close; missed widget.connect; 2 entries reported as unreadable |
| holdout | holdout/time-tracker.bundled.asar | bridge member channel | 0 | 0 | 0 |  |
| holdout | holdout/time-tracker.bundled.asar | endpoints | 4 | 10 | 10 | missed https://api.punchclock.example/v3/projects/…; missed https://rates.punchclock.example/latest?base=…; missed https://api.punchclock.example/v3/clients; missed https://api.punchclock.example/v3/timesheets/current…; missed https://api.punchclock.example/v3/entries; missed https://api.punchclock.example/v3/entries/…; missed https://files.punchclock.example/invoices; missed wss://live.punchclock.example/team/…; missed https://status.punchclock.example/api/v2/summary.json; missed https://updates.punchclock.example/feed/stable.json; false ghost.form-field; false ui.locale; false license.key; false ui.currency; false window.main; false note; false /entries/changed; false sync.interval; false hours; false window.widget |
| holdout | holdout/time-tracker.bundled.asar | endpoint method | 0 | 2 | 0 | https://api.punchclock.example/v3/me/preferences: expected PATCH; https://hooks.punchclock.example/invoice-exported: expected POST |
| holdout | holdout/time-tracker.bundled.asar | requests with an unknown URL shown | 1 | 0 | 8 |  |
| holdout | holdout/time-tracker.bundled.asar | storage keys | 4 | 13 | 0 | missed localStorage punch.theme; missed localStorage punch.session; missed localStorage sidebarWidth; missed indexedDB punchclock-entries; missed indexedDB punchclock-v3; missed cookie document.cookie; missed electron-store window.main; missed electron-store window.widget; missed electron-store sync.interval; missed electron-store sync.lastRun; missed electron-store ui.locale; missed electron-store ui.currency; missed electron-store license.key |
| holdout | holdout/time-tracker.bundled.asar | storage read/write/delete | 2 | 1 | 0 | sessionStorage widget.position: expected read+write+delete, got write; tool reported the analysis as partial |
| holdout | holdout/time-tracker.minified.asar | IPC channels | 12 | 12 | 0 | missed timer:start; missed timer:stop; missed timer:tick; missed projects:list; missed projects:create; missed projects:rename; missed invoice:export; missed sync:progress; missed config:get-sync; missed menu:new-entry; missed update:ready; missed theme:changed |
| holdout | holdout/time-tracker.minified.asar | IPC senders and receivers | 18 | 5 | 0 | widget:pin: receiver main.js missed; widget:close: receiver main.js missed; invoice:create: sender preload.js missed; invoice:exported: sender main.js missed; timer:port: sender main.js missed |
| holdout | holdout/time-tracker.minified.asar | window settings | 0 | 11 | 0 | missed main.js preload=preload.js; missed main.js contextIsolation=true; missed main.js nodeIntegration=false; missed main.js sandbox=true; missed main.js preload=preload.js; missed main.js contextIsolation=true; missed main.js sandbox=false; missed main.js nodeIntegration=false; missed main.js preload=preload.js; missed main.js contextIsolation=true; missed main.js nodeIntegration=false |
| holdout | holdout/time-tracker.minified.asar | bridge members | 0 | 23 | 0 | missed tracker.startTimer; missed tracker.stopTimer; missed tracker.onTick; missed tracker.listProjects; missed tracker.createProject; missed tracker.renameProject; missed tracker.createInvoice; missed tracker.exportInvoice; missed tracker.onceExported; missed tracker.startSync; missed tracker.cancelSync; missed tracker.onSyncProgress; missed tracker.setting; missed tracker.activate; missed tracker.onNewEntry; missed tracker.onUpdateReady; missed tracker.setBadge; missed tracker.formatDuration; missed tracker.copy; missed tracker.runtime; missed widget.pin; missed widget.close; missed widget.connect; 2 entries reported as unreadable |
| holdout | holdout/time-tracker.minified.asar | bridge member channel | 0 | 0 | 0 |  |
| holdout | holdout/time-tracker.minified.asar | endpoints | 4 | 10 | 10 | missed https://api.punchclock.example/v3/projects/…; missed https://rates.punchclock.example/latest?base=…; missed https://api.punchclock.example/v3/clients; missed https://api.punchclock.example/v3/timesheets/current…; missed https://api.punchclock.example/v3/entries; missed https://api.punchclock.example/v3/entries/…; missed https://files.punchclock.example/invoices; missed wss://live.punchclock.example/team/…; missed https://status.punchclock.example/api/v2/summary.json; missed https://updates.punchclock.example/feed/stable.json; false ghost.form-field; false license.key; false ui.locale; false window.widget; false sync.interval; false window.main; false ui.currency; false note; false hours; false /entries/changed |
| holdout | holdout/time-tracker.minified.asar | endpoint method | 0 | 2 | 0 | https://api.punchclock.example/v3/me/preferences: expected PATCH; https://hooks.punchclock.example/invoice-exported: expected POST |
| holdout | holdout/time-tracker.minified.asar | requests with an unknown URL shown | 0 | 1 | 0 |  |
| holdout | holdout/time-tracker.minified.asar | storage keys | 4 | 13 | 0 | missed localStorage punch.theme; missed localStorage punch.session; missed localStorage sidebarWidth; missed indexedDB punchclock-entries; missed indexedDB punchclock-v3; missed cookie document.cookie; missed electron-store window.main; missed electron-store window.widget; missed electron-store sync.interval; missed electron-store sync.lastRun; missed electron-store ui.locale; missed electron-store ui.currency; missed electron-store license.key |
| holdout | holdout/time-tracker.minified.asar | storage read/write/delete | 2 | 1 | 0 | sessionStorage widget.position: expected read+write+delete, got write; tool reported the analysis as partial |
| holdout | holdout/time-tracker.plain.asar → holdout/time-tracker-v2.plain.asar | changes in ipcChannels | 0 | 3 | 1 | missed +projects:retitle; missed -projects:rename; missed ~widget:close; false -widget:close |
| holdout | holdout/time-tracker.plain.asar → holdout/time-tracker-v2.plain.asar | changes in contextBridge | 0 | 3 | 0 | missed +tracker.retitleProject; missed -tracker.renameProject; missed -widget.close |
| holdout | holdout/time-tracker.plain.asar → holdout/time-tracker-v2.plain.asar | changes in webPreferences | 0 | 2 | 0 | missed ~sandbox: false -> true; missed ~contextIsolation: true -> false |
| holdout | holdout/time-tracker.plain.asar → holdout/time-tracker-v2.plain.asar | changes in endpoints | 0 | 8 | 0 | missed +https://api.punchclock.example/v4/projects/; missed +https://api.punchclock.example/v4/clients; missed +https://api.punchclock.example/v4/timesheets/current; missed +https://api.punchclock.example/v4/entries/; missed -https://api.punchclock.example/v3/projects/; missed -https://api.punchclock.example/v3/clients; missed -https://api.punchclock.example/v3/timesheets/current; missed -https://api.punchclock.example/v3/entries/ |
| holdout | holdout/time-tracker.plain.asar → holdout/time-tracker-v2.plain.asar | changes in storage | 0 | 2 | 0 | missed +electron-store ui.weekStart; missed -indexedDB punchclock-v3 |
| holdout2 | holdout2/markdown-editor.plain.asar | electron analysis | 0 | 0 | 0 | NOT RUN: no observation |
| holdout2 | holdout2/markdown-editor.bundled.asar | electron analysis | 0 | 0 | 0 | NOT RUN: no observation |
| holdout2 | holdout2/markdown-editor.minified.asar | electron analysis | 0 | 0 | 0 | NOT RUN: no observation |
| holdout2 | holdout2/markdown-editor.plain.asar → holdout2/markdown-editor-v2.plain.asar | comparison | 0 | 0 | 0 | NOT RUN: no observation |
| holdout2 | holdout2/music-player.plain.asar | electron analysis | 0 | 0 | 0 | NOT RUN: no observation |
| holdout2 | holdout2/music-player.bundled.asar | electron analysis | 0 | 0 | 0 | NOT RUN: no observation |
| holdout2 | holdout2/music-player.minified.asar | electron analysis | 0 | 0 | 0 | NOT RUN: no observation |
| damaged | damaged/empty.asar | damaged input | 1 | 0 | 0 | error artifact_operation_failed |
| damaged | damaged/header-cut.asar | damaged input | 1 | 0 | 0 | error artifact_operation_failed |
| damaged | damaged/header-length-lies.asar | damaged input | 1 | 0 | 0 | error artifact_operation_failed |
| damaged | damaged/contents-cut.asar | damaged input | 1 | 0 | 0 | error artifact_operation_failed |
| damaged | damaged/load-commands-cut.macho-arm64 | damaged input | 1 | 0 | 0 | error target_unavailable |
| damaged | damaged/body-cut.macho-arm64 | damaged input | 1 | 0 | 0 | error execution_failure |
