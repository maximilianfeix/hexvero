# hexvero 0.3.0 on the hexvero corpus

Tool: name hexvero · version 0.3.0 · commit 9d596ca · node v25.2.1 · platform darwin arm64 · engines {"radare2":"radare2 6.2.4 +0 abi:152 @ darwin-arm_64","rizin":"rizin 0.9.1 @ darwin-arm-64, package: 0.9.1_2 (Homebrew)"}

## Per class

| set | class | inputs | hit | missed | false | not found but warned |
| --- | --- | --- | --- | --- | --- | --- |
| validation | IPC channels | 3 | 39 | 12 | 1 |  |
| validation | IPC senders and receivers | 3 | 72 | 12 | 0 |  |
| validation | window settings | 3 | 12 | 9 | 4 |  |
| validation | bridge members | 3 | 30 | 9 | 4 |  |
| validation | bridge member channel | 3 | 18 | 12 | 0 |  |
| validation | endpoints | 3 | 26 | 7 | 5 |  |
| validation | endpoint method | 3 | 3 | 3 | 0 |  |
| validation | requests with an unknown URL shown | 3 | 6 | 0 | 5 |  |
| validation | storage keys | 3 | 27 | 6 | 0 |  |
| validation | storage read/write/delete | 3 | 24 | 0 | 0 |  |
| validation | changes in ipcChannels | 1 | 0 | 3 | 0 |  |
| validation | changes in contextBridge | 1 | 2 | 0 | 0 |  |
| validation | changes in webPreferences | 1 | 0 | 2 | 4 |  |
| validation | changes in endpoints | 1 | 4 | 0 | 0 |  |
| validation | changes in storage | 1 | 4 | 0 | 0 |  |
| validation | imports | 4 | 28 | 0 | 0 |  |
| validation | functions | 4 | 40 | 0 | 0 |  |
| validation | call paths | 4 | 52 | 0 | 0 |  |
| validation | direct callers | 4 | 44 | 0 | 0 |  |

## Per input

| set | input | class | hit | missed | false | notes |
| --- | --- | --- | --- | --- | --- | --- |
| validation | validation/chat-app.plain.asar | IPC channels | 13 | 4 | 0 | missed chat:send-message; missed chat:history; missed rooms:list; missed telemetry:hit |
| validation | validation/chat-app.plain.asar | IPC senders and receivers | 24 | 4 | 0 | rooms:join: receiver main.js missed; rooms:leave: receiver main.js missed; presence:typing: sender preload.js missed; presence:update: sender main.js missed |
| validation | validation/chat-app.plain.asar | window settings | 4 | 3 | 2 | missed main.js preload=preload.js; missed main.js contextIsolation=true; missed main.js nodeIntegration=false; false main.js sandbox=true; false main.js sandbox=false |
| validation | validation/chat-app.plain.asar | bridge members | 10 | 3 | 2 | missed session.bootstrap; missed session.signOut; missed session.onPresence; false [SESSION_API].bootstrap; false [SESSION_API].signOut |
| validation | validation/chat-app.plain.asar | bridge member channel | 6 | 4 | 0 | chat.sendMessage: expected chat:send-message, got null; chat.listRooms: expected rooms:list, got null; chat.history: expected chat:history, got null; chat.typing: expected presence:typing, got null |
| validation | validation/chat-app.plain.asar | endpoints | 7 | 4 | 3 | missed https://api.chat.example/v2/rooms/…; missed https://api.chat.example/v2/users/…; missed wss://gateway.chat.example/socket; missed https://updates.chat.example/desktop/report; false ${…}/rooms/${…}/messages?limit=50; false ${…}/users/${…}; false https://ghost.chat.example/cache-open |
| validation | validation/chat-app.plain.asar | endpoint method | 1 | 1 | 0 | https://api.chat.example/v2/messages: expected POST |
| validation | validation/chat-app.plain.asar | requests with an unknown URL shown | 2 | 0 | 2 |  |
| validation | validation/chat-app.plain.asar | storage keys | 9 | 2 | 0 | missed localStorage auth.token; missed indexedDB chat-cache-v1 |
| validation | validation/chat-app.plain.asar | storage read/write/delete | 8 | 0 | 0 |  |
| validation | validation/chat-app.bundled.asar | IPC channels | 13 | 4 | 0 | missed chat:send-message; missed chat:history; missed rooms:list; missed telemetry:hit |
| validation | validation/chat-app.bundled.asar | IPC senders and receivers | 24 | 4 | 0 | rooms:join: receiver main.js missed; rooms:leave: receiver main.js missed; presence:typing: sender preload.js missed; presence:update: sender main.js missed |
| validation | validation/chat-app.bundled.asar | window settings | 4 | 3 | 2 | missed main.js preload=preload.js; missed main.js contextIsolation=true; missed main.js nodeIntegration=false; false main.js sandbox=true; false main.js sandbox=false |
| validation | validation/chat-app.bundled.asar | bridge members | 10 | 3 | 2 | missed session.bootstrap; missed session.signOut; missed session.onPresence; false [SESSION_API].bootstrap; false [SESSION_API].signOut |
| validation | validation/chat-app.bundled.asar | bridge member channel | 6 | 4 | 0 | chat.sendMessage: expected chat:send-message, got null; chat.listRooms: expected rooms:list, got null; chat.history: expected chat:history, got null; chat.typing: expected presence:typing, got null |
| validation | validation/chat-app.bundled.asar | endpoints | 10 | 1 | 1 | missed https://updates.chat.example/desktop/report; false https://ghost.chat.example/cache-open |
| validation | validation/chat-app.bundled.asar | endpoint method | 1 | 1 | 0 | https://api.chat.example/v2/messages: expected POST |
| validation | validation/chat-app.bundled.asar | requests with an unknown URL shown | 2 | 0 | 1 |  |
| validation | validation/chat-app.bundled.asar | storage keys | 9 | 2 | 0 | missed localStorage auth.token; missed indexedDB chat-cache-v1 |
| validation | validation/chat-app.bundled.asar | storage read/write/delete | 8 | 0 | 0 |  |
| validation | validation/chat-app.minified.asar | IPC channels | 13 | 4 | 1 | missed chat:send-message; missed chat:history; missed rooms:list; missed telemetry:hit; false Register with ipcMain.on('ghost:in-a-string', listener) in main.js |
| validation | validation/chat-app.minified.asar | IPC senders and receivers | 24 | 4 | 0 | rooms:join: receiver main.js missed; rooms:leave: receiver main.js missed; presence:typing: sender preload.js missed; presence:update: sender main.js missed |
| validation | validation/chat-app.minified.asar | window settings | 4 | 3 | 0 | missed main.js preload=preload.js; missed main.js contextIsolation=true; missed main.js nodeIntegration=false |
| validation | validation/chat-app.minified.asar | bridge members | 10 | 3 | 0 | missed session.bootstrap; missed session.signOut; missed session.onPresence; 1 entry reported as unreadable |
| validation | validation/chat-app.minified.asar | bridge member channel | 6 | 4 | 0 | chat.sendMessage: expected chat:send-message, got null; chat.listRooms: expected rooms:list, got null; chat.history: expected chat:history, got null; chat.typing: expected presence:typing, got null |
| validation | validation/chat-app.minified.asar | endpoints | 9 | 2 | 1 | missed wss://gateway.chat.example/socket; missed https://updates.chat.example/desktop/report; false https://ghost.chat.example/cache-open |
| validation | validation/chat-app.minified.asar | endpoint method | 1 | 1 | 0 | https://api.chat.example/v2/messages: expected POST |
| validation | validation/chat-app.minified.asar | requests with an unknown URL shown | 2 | 0 | 2 |  |
| validation | validation/chat-app.minified.asar | storage keys | 9 | 2 | 0 | missed localStorage auth.token; missed indexedDB chat-cache-v1 |
| validation | validation/chat-app.minified.asar | storage read/write/delete | 8 | 0 | 0 |  |
| validation | validation/chat-app.plain.asar → validation/chat-app-v2.plain.asar | changes in ipcChannels | 0 | 3 | 0 | missed +rooms:directory; missed -rooms:list; missed -telemetry:hit |
| validation | validation/chat-app.plain.asar → validation/chat-app-v2.plain.asar | changes in contextBridge | 2 | 0 | 0 |  |
| validation | validation/chat-app.plain.asar → validation/chat-app-v2.plain.asar | changes in webPreferences | 0 | 2 | 4 | missed ~contextIsolation: false -> true; missed ~sandbox: false -> true; false +{"file":"main.js","key":"contextIsolation","line":93,"value":true,"window":2}; false +{"file":"main.js","key":"sandbox","line":101,"value":true,"window":2}; false -{"file":"main.js","key":"contextIsolation","line":53,"value":false,"window":2}; false -{"file":"main.js","key":"sandbox","line":61,"value":false,"window":2} |
| validation | validation/chat-app.plain.asar → validation/chat-app-v2.plain.asar | changes in endpoints | 4 | 0 | 0 |  |
| validation | validation/chat-app.plain.asar → validation/chat-app-v2.plain.asar | changes in storage | 4 | 0 | 0 |  |
| validation | validation/dispatch.O0.macho-arm64 (radare2) | imports | 7 | 0 | 0 |  |
| validation | validation/dispatch.O0.macho-arm64 (radare2) | functions | 10 | 0 | 0 |  |
| validation | validation/dispatch.O0.macho-arm64 (radare2) | call paths | 13 | 0 | 0 |  |
| validation | validation/dispatch.O0.macho-arm64 (radare2) | direct callers | 11 | 0 | 0 |  |
| validation | validation/dispatch.O0.macho-arm64 (rizin) | imports | 7 | 0 | 0 |  |
| validation | validation/dispatch.O0.macho-arm64 (rizin) | functions | 10 | 0 | 0 |  |
| validation | validation/dispatch.O0.macho-arm64 (rizin) | call paths | 13 | 0 | 0 |  |
| validation | validation/dispatch.O0.macho-arm64 (rizin) | direct callers | 11 | 0 | 0 |  |
| validation | validation/dispatch.O2.macho-arm64 (radare2) | imports | 7 | 0 | 0 |  |
| validation | validation/dispatch.O2.macho-arm64 (radare2) | functions | 10 | 0 | 0 |  |
| validation | validation/dispatch.O2.macho-arm64 (radare2) | call paths | 13 | 0 | 0 |  |
| validation | validation/dispatch.O2.macho-arm64 (radare2) | direct callers | 11 | 0 | 0 |  |
| validation | validation/dispatch.O2.macho-arm64 (rizin) | imports | 7 | 0 | 0 |  |
| validation | validation/dispatch.O2.macho-arm64 (rizin) | functions | 10 | 0 | 0 |  |
| validation | validation/dispatch.O2.macho-arm64 (rizin) | call paths | 13 | 0 | 0 |  |
| validation | validation/dispatch.O2.macho-arm64 (rizin) | direct callers | 11 | 0 | 0 |  |
