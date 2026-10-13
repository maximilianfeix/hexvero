# REA 6.4.0 on the hexvero corpus

Tool: name REA · version 6.4.0 · package rea-agents · cli 6.4.0 · node v24.21.0 · platform darwin arm64 · mapping default · deep providers none installed (Ghidra, Hopper, IDA)

## Per class

| set | class | inputs | hit | missed | false | not found but warned |
| --- | --- | --- | --- | --- | --- | --- |
| validation | IPC channels | 3 | 36 | 15 | 0 |  |
| validation | IPC senders and receivers | 3 | 48 | 30 | 0 |  |
| validation | window settings | 3 | 2 | 19 | 0 |  |
| validation | bridge members | 3 | 30 | 9 | 0 |  |
| validation | bridge member channel | 3 | 6 | 24 | 0 |  |
| validation | endpoints | 3 | 12 | 21 | 18 |  |
| validation | endpoint method | 3 | 0 | 6 | 0 |  |
| validation | requests with an unknown URL shown | 3 | 4 | 2 | 4 |  |
| validation | storage keys | 3 | 15 | 18 | 0 |  |
| validation | storage read/write/delete | 3 | 12 | 0 | 0 |  |
| validation | changes in ipcChannels | 1 | 0 | 3 | 0 |  |
| validation | changes in contextBridge | 1 | 2 | 0 | 0 |  |
| validation | changes in webPreferences | 1 | 1 | 1 | 0 |  |
| validation | changes in endpoints | 1 | 2 | 2 | 2 |  |
| validation | changes in storage | 1 | 2 | 2 | 0 |  |
| validation | imports | 2 | 14 | 0 | 0 |  |
| validation | functions | 2 | 0 | 20 | 0 |  |
| validation | call paths | 2 | 0 | 26 | 0 |  |
| validation | direct callers | 2 | 0 | 22 | 0 |  |

## Per input

| set | input | class | hit | missed | false | notes |
| --- | --- | --- | --- | --- | --- | --- |
| validation | validation/chat-app.plain.asar | IPC channels | 12 | 5 | 0 | missed chat:send-message; missed chat:history; missed rooms:list; missed settings:saved; missed telemetry:hit |
| validation | validation/chat-app.plain.asar | IPC senders and receivers | 16 | 10 | 0 | rooms:join: receiver main.js missed; rooms:leave: receiver main.js missed; presence:typing: sender preload.js missed; app:locale: sender renderer-settings.js missed; auth:sign-out: sender renderer-settings.js missed; settings:reset: sender renderer-settings.js missed; settings:save: sender renderer-settings.js missed; chat:incoming: sender main.js missed; presence:update: sender main.js missed; presence:update: receiver renderer-settings.js missed |
| validation | validation/chat-app.plain.asar | window settings | 1 | 6 | 0 | missed main.js preload=preload.js; missed main.js contextIsolation=true; missed main.js nodeIntegration=false; missed main.js sandbox=true; missed main.js nodeIntegration=true; missed main.js contextIsolation=false |
| validation | validation/chat-app.plain.asar | bridge members | 10 | 3 | 0 | missed session.bootstrap; missed session.signOut; missed session.onPresence; 1 entry reported as unreadable |
| validation | validation/chat-app.plain.asar | bridge member channel | 2 | 8 | 0 | chat.sendMessage: expected chat:send-message, got null; chat.listRooms: expected rooms:list, got null; chat.history: expected chat:history, got null; chat.join: expected rooms:join, got null; chat.leave: expected rooms:leave, got null; chat.typing: expected presence:typing, got null; chat.onIncoming: expected chat:incoming, got null; chat.openSettings: expected settings:open, got null |
| validation | validation/chat-app.plain.asar | endpoints | 4 | 7 | 6 | missed https://api.chat.example/v2/rooms/…; missed https://api.chat.example/v2/users/…; missed https://status.chat.example/health.json; missed wss://gateway.chat.example/socket; missed https://events.chat.example/presence/stream; missed https://metrics.chat.example/collect; missed https://updates.chat.example/desktop/report; false https://ghost.chat.example/cache-key; false ghost.map-key; false https://ghost.chat.example/cache-open; false ui.zoom; false auth.refreshToken; false window.bounds |
| validation | validation/chat-app.plain.asar | endpoint method | 0 | 2 | 0 | https://api.chat.example/v2/messages: expected POST; https://api.chat.example/v2/session: expected DELETE |
| validation | validation/chat-app.plain.asar | requests with an unknown URL shown | 2 | 0 | 2 |  |
| validation | validation/chat-app.plain.asar | storage keys | 5 | 6 | 0 | missed localStorage auth.token; missed indexedDB chat-cache-v1; missed cookie document.cookie; missed electron-store window.bounds; missed electron-store ui.zoom; missed electron-store auth.refreshToken |
| validation | validation/chat-app.plain.asar | storage read/write/delete | 4 | 0 | 0 | tool reported the analysis as partial |
| validation | validation/chat-app.bundled.asar | IPC channels | 12 | 5 | 0 | missed chat:send-message; missed chat:history; missed rooms:list; missed settings:saved; missed telemetry:hit |
| validation | validation/chat-app.bundled.asar | IPC senders and receivers | 16 | 10 | 0 | rooms:join: receiver main.js missed; rooms:leave: receiver main.js missed; presence:typing: sender preload.js missed; app:locale: sender renderer-settings.js missed; auth:sign-out: sender renderer-settings.js missed; settings:reset: sender renderer-settings.js missed; settings:save: sender renderer-settings.js missed; chat:incoming: sender main.js missed; presence:update: sender main.js missed; presence:update: receiver renderer-settings.js missed |
| validation | validation/chat-app.bundled.asar | window settings | 1 | 6 | 0 | missed main.js preload=preload.js; missed main.js contextIsolation=true; missed main.js nodeIntegration=false; missed main.js sandbox=true; missed main.js nodeIntegration=true; missed main.js contextIsolation=false |
| validation | validation/chat-app.bundled.asar | bridge members | 10 | 3 | 0 | missed session.bootstrap; missed session.signOut; missed session.onPresence; 1 entry reported as unreadable |
| validation | validation/chat-app.bundled.asar | bridge member channel | 2 | 8 | 0 | chat.sendMessage: expected chat:send-message, got null; chat.listRooms: expected rooms:list, got null; chat.history: expected chat:history, got null; chat.join: expected rooms:join, got null; chat.leave: expected rooms:leave, got null; chat.typing: expected presence:typing, got null; chat.onIncoming: expected chat:incoming, got null; chat.openSettings: expected settings:open, got null |
| validation | validation/chat-app.bundled.asar | endpoints | 4 | 7 | 6 | missed https://api.chat.example/v2/rooms/…; missed https://api.chat.example/v2/users/…; missed https://status.chat.example/health.json; missed wss://gateway.chat.example/socket; missed https://events.chat.example/presence/stream; missed https://metrics.chat.example/collect; missed https://updates.chat.example/desktop/report; false ghost.map-key; false window.bounds; false auth.refreshToken; false https://ghost.chat.example/cache-open; false ui.zoom; false https://ghost.chat.example/cache-key |
| validation | validation/chat-app.bundled.asar | endpoint method | 0 | 2 | 0 | https://api.chat.example/v2/messages: expected POST; https://api.chat.example/v2/session: expected DELETE |
| validation | validation/chat-app.bundled.asar | requests with an unknown URL shown | 2 | 0 | 2 |  |
| validation | validation/chat-app.bundled.asar | storage keys | 5 | 6 | 0 | missed localStorage auth.token; missed indexedDB chat-cache-v1; missed cookie document.cookie; missed electron-store window.bounds; missed electron-store ui.zoom; missed electron-store auth.refreshToken |
| validation | validation/chat-app.bundled.asar | storage read/write/delete | 4 | 0 | 0 | tool reported the analysis as partial |
| validation | validation/chat-app.minified.asar | IPC channels | 12 | 5 | 0 | missed chat:send-message; missed chat:history; missed rooms:list; missed settings:saved; missed telemetry:hit |
| validation | validation/chat-app.minified.asar | IPC senders and receivers | 16 | 10 | 0 | rooms:join: receiver main.js missed; rooms:leave: receiver main.js missed; presence:typing: sender preload.js missed; app:locale: sender renderer-settings.js missed; auth:sign-out: sender renderer-settings.js missed; settings:reset: sender renderer-settings.js missed; settings:save: sender renderer-settings.js missed; chat:incoming: sender main.js missed; presence:update: sender main.js missed; presence:update: receiver renderer-settings.js missed |
| validation | validation/chat-app.minified.asar | window settings | 0 | 7 | 0 | missed main.js preload=preload.js; missed main.js contextIsolation=true; missed main.js nodeIntegration=false; missed main.js sandbox=true; missed main.js nodeIntegration=true; missed main.js contextIsolation=false; missed main.js sandbox=false |
| validation | validation/chat-app.minified.asar | bridge members | 10 | 3 | 0 | missed session.bootstrap; missed session.signOut; missed session.onPresence; 1 entry reported as unreadable |
| validation | validation/chat-app.minified.asar | bridge member channel | 2 | 8 | 0 | chat.sendMessage: expected chat:send-message, got null; chat.listRooms: expected rooms:list, got null; chat.history: expected chat:history, got null; chat.join: expected rooms:join, got null; chat.leave: expected rooms:leave, got null; chat.typing: expected presence:typing, got null; chat.onIncoming: expected chat:incoming, got null; chat.openSettings: expected settings:open, got null |
| validation | validation/chat-app.minified.asar | endpoints | 4 | 7 | 6 | missed https://api.chat.example/v2/rooms/…; missed https://api.chat.example/v2/users/…; missed https://status.chat.example/health.json; missed wss://gateway.chat.example/socket; missed https://events.chat.example/presence/stream; missed https://metrics.chat.example/collect; missed https://updates.chat.example/desktop/report; false auth.refreshToken; false window.bounds; false ghost.map-key; false https://ghost.chat.example/cache-open; false https://ghost.chat.example/cache-key; false ui.zoom |
| validation | validation/chat-app.minified.asar | endpoint method | 0 | 2 | 0 | https://api.chat.example/v2/messages: expected POST; https://api.chat.example/v2/session: expected DELETE |
| validation | validation/chat-app.minified.asar | requests with an unknown URL shown | 0 | 2 | 0 |  |
| validation | validation/chat-app.minified.asar | storage keys | 5 | 6 | 0 | missed localStorage auth.token; missed indexedDB chat-cache-v1; missed cookie document.cookie; missed electron-store window.bounds; missed electron-store ui.zoom; missed electron-store auth.refreshToken |
| validation | validation/chat-app.minified.asar | storage read/write/delete | 4 | 0 | 0 | tool reported the analysis as partial |
| validation | validation/chat-app.plain.asar → validation/chat-app-v2.plain.asar | changes in ipcChannels | 0 | 3 | 0 | missed +rooms:directory; missed -rooms:list; missed -telemetry:hit |
| validation | validation/chat-app.plain.asar → validation/chat-app-v2.plain.asar | changes in contextBridge | 2 | 0 | 0 |  |
| validation | validation/chat-app.plain.asar → validation/chat-app-v2.plain.asar | changes in webPreferences | 1 | 1 | 0 | missed ~contextIsolation: false -> true |
| validation | validation/chat-app.plain.asar → validation/chat-app-v2.plain.asar | changes in endpoints | 2 | 2 | 2 | missed +https://metrics.chat.example/v2/batch; missed -https://metrics.chat.example/collect; false +auth.sessionKey; false -auth.refreshToken |
| validation | validation/chat-app.plain.asar → validation/chat-app-v2.plain.asar | changes in storage | 2 | 2 | 0 | missed +electron-store auth.sessionKey; missed -electron-store auth.refreshToken |
| validation | validation/dispatch.O0.macho-arm64 (inspect-macho) | imports | 7 | 0 | 0 |  |
| validation | validation/dispatch.O0.macho-arm64 (inspect-macho) | functions | 0 | 10 | 0 | missed main; missed lookup; missed plausible; missed usage; missed emit; missed finish; missed tree_sum; missed cmd_double; missed cmd_env; missed audit_cleanup |
| validation | validation/dispatch.O0.macho-arm64 (inspect-macho) | call paths | 0 | 13 | 0 | main → strlen: no answer; main → strcmp: no answer; main → printf: no answer; main → puts: no answer; main → tree_sum: no answer; cmd_env → puts: no answer; audit_cleanup → remove: no answer; main → remove: no answer; main → audit_cleanup: no answer; lookup → printf: no answer; finish → strcmp: no answer; usage → getenv: no answer; tree_sum → printf: no answer |
| validation | validation/dispatch.O0.macho-arm64 (inspect-macho) | direct callers | 0 | 11 | 0 | audit_cleanup: function not found; cmd_double: function not found; cmd_env: function not found; plausible: function not found; lookup: function not found; finish: function not found; usage: function not found; emit: function not found; tree_sum: function not found |
| validation | validation/dispatch.O2.macho-arm64 (inspect-macho) | imports | 7 | 0 | 0 |  |
| validation | validation/dispatch.O2.macho-arm64 (inspect-macho) | functions | 0 | 10 | 0 | missed main; missed lookup; missed plausible; missed usage; missed emit; missed finish; missed tree_sum; missed cmd_double; missed cmd_env; missed audit_cleanup |
| validation | validation/dispatch.O2.macho-arm64 (inspect-macho) | call paths | 0 | 13 | 0 | main → strlen: no answer; main → strcmp: no answer; main → printf: no answer; main → puts: no answer; main → tree_sum: no answer; cmd_env → puts: no answer; audit_cleanup → remove: no answer; main → remove: no answer; main → audit_cleanup: no answer; lookup → printf: no answer; finish → strcmp: no answer; usage → getenv: no answer; tree_sum → printf: no answer |
| validation | validation/dispatch.O2.macho-arm64 (inspect-macho) | direct callers | 0 | 11 | 0 | audit_cleanup: function not found; cmd_double: function not found; cmd_env: function not found; plausible: function not found; lookup: function not found; finish: function not found; usage: function not found; emit: function not found; tree_sum: function not found |
