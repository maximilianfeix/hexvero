# hexvero 0.3.0 on the hexvero corpus

Tool: name hexvero · version 0.3.0 · commit a6d9b82 · node v24.21.0 · platform darwin arm64 · engines {"radare2":"radare2 6.2.4 +0 abi:152 @ darwin-arm_64","rizin":"rizin 0.9.1 @ darwin-arm-64, package: 0.9.1_2 (Homebrew)"} · observer corpus/observe-hexvero.mjs of that commit, unmodified

## Per class

| set | class | inputs | hit | missed | false | not found but warned |
| --- | --- | --- | --- | --- | --- | --- |
| validation | IPC channels | 3 | 51 | 0 | 0 |  |
| validation | IPC senders and receivers | 3 | 105 | 0 | 0 |  |
| validation | window settings | 3 | 21 | 0 | 0 |  |
| validation | bridge members | 3 | 39 | 0 | 0 |  |
| validation | bridge member channel | 3 | 39 | 0 | 0 |  |
| validation | endpoints | 3 | 33 | 0 | 0 |  |
| validation | endpoint method | 3 | 9 | 0 | 0 |  |
| validation | requests with an unknown URL shown | 3 | 6 | 0 | 0 |  |
| validation | storage keys | 3 | 33 | 0 | 0 |  |
| validation | storage read/write/delete | 3 | 30 | 0 | 0 |  |
| validation | changes in ipcChannels | 1 | 3 | 0 | 0 |  |
| validation | changes in contextBridge | 1 | 2 | 0 | 0 |  |
| validation | changes in webPreferences | 1 | 2 | 0 | 0 |  |
| validation | changes in endpoints | 1 | 4 | 0 | 0 |  |
| validation | changes in storage | 1 | 4 | 0 | 0 |  |
| validation | imports | 4 | 28 | 0 | 0 |  |
| validation | functions | 4 | 40 | 0 | 0 |  |
| validation | call paths | 4 | 52 | 0 | 0 |  |
| validation | direct callers | 4 | 44 | 0 | 0 |  |

## Per input

| set | input | class | hit | missed | false | notes |
| --- | --- | --- | --- | --- | --- | --- |
| validation | validation/chat-app.plain.asar | IPC channels | 17 | 0 | 0 |  |
| validation | validation/chat-app.plain.asar | IPC senders and receivers | 35 | 0 | 0 |  |
| validation | validation/chat-app.plain.asar | window settings | 7 | 0 | 0 |  |
| validation | validation/chat-app.plain.asar | bridge members | 13 | 0 | 0 |  |
| validation | validation/chat-app.plain.asar | bridge member channel | 13 | 0 | 0 |  |
| validation | validation/chat-app.plain.asar | endpoints | 11 | 0 | 0 |  |
| validation | validation/chat-app.plain.asar | endpoint method | 3 | 0 | 0 |  |
| validation | validation/chat-app.plain.asar | requests with an unknown URL shown | 2 | 0 | 0 |  |
| validation | validation/chat-app.plain.asar | storage keys | 11 | 0 | 0 |  |
| validation | validation/chat-app.plain.asar | storage read/write/delete | 10 | 0 | 0 |  |
| validation | validation/chat-app.bundled.asar | IPC channels | 17 | 0 | 0 |  |
| validation | validation/chat-app.bundled.asar | IPC senders and receivers | 35 | 0 | 0 |  |
| validation | validation/chat-app.bundled.asar | window settings | 7 | 0 | 0 |  |
| validation | validation/chat-app.bundled.asar | bridge members | 13 | 0 | 0 |  |
| validation | validation/chat-app.bundled.asar | bridge member channel | 13 | 0 | 0 |  |
| validation | validation/chat-app.bundled.asar | endpoints | 11 | 0 | 0 |  |
| validation | validation/chat-app.bundled.asar | endpoint method | 3 | 0 | 0 |  |
| validation | validation/chat-app.bundled.asar | requests with an unknown URL shown | 2 | 0 | 0 |  |
| validation | validation/chat-app.bundled.asar | storage keys | 11 | 0 | 0 |  |
| validation | validation/chat-app.bundled.asar | storage read/write/delete | 10 | 0 | 0 |  |
| validation | validation/chat-app.minified.asar | IPC channels | 17 | 0 | 0 |  |
| validation | validation/chat-app.minified.asar | IPC senders and receivers | 35 | 0 | 0 |  |
| validation | validation/chat-app.minified.asar | window settings | 7 | 0 | 0 |  |
| validation | validation/chat-app.minified.asar | bridge members | 13 | 0 | 0 |  |
| validation | validation/chat-app.minified.asar | bridge member channel | 13 | 0 | 0 |  |
| validation | validation/chat-app.minified.asar | endpoints | 11 | 0 | 0 |  |
| validation | validation/chat-app.minified.asar | endpoint method | 3 | 0 | 0 |  |
| validation | validation/chat-app.minified.asar | requests with an unknown URL shown | 2 | 0 | 0 |  |
| validation | validation/chat-app.minified.asar | storage keys | 11 | 0 | 0 |  |
| validation | validation/chat-app.minified.asar | storage read/write/delete | 10 | 0 | 0 |  |
| validation | validation/chat-app.plain.asar → validation/chat-app-v2.plain.asar | changes in ipcChannels | 3 | 0 | 0 |  |
| validation | validation/chat-app.plain.asar → validation/chat-app-v2.plain.asar | changes in contextBridge | 2 | 0 | 0 |  |
| validation | validation/chat-app.plain.asar → validation/chat-app-v2.plain.asar | changes in webPreferences | 2 | 0 | 0 |  |
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
