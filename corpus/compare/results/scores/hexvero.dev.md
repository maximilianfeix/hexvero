# hexvero 0.3.0 on the hexvero corpus

Tool: name hexvero · version 0.3.0 · commit a6d9b82 · node v24.21.0 · platform darwin arm64 · engines {"radare2":"radare2 6.2.4 +0 abi:152 @ darwin-arm_64","rizin":"rizin 0.9.1 @ darwin-arm-64, package: 0.9.1_2 (Homebrew)"} · observer corpus/observe-hexvero.mjs of that commit, unmodified

## Per class

| set | class | inputs | hit | missed | false | not found but warned |
| --- | --- | --- | --- | --- | --- | --- |
| dev | changes in imports | 1 | 1 | 0 | 0 |  |
| dev | changes in symbols | 1 | 2 | 0 | 0 |  |
| dev | imports | 4 | 24 | 0 | 0 |  |
| dev | functions | 4 | 28 | 0 | 0 |  |
| dev | call paths | 4 | 16 | 0 | 0 |  |
| dev | direct callers | 4 | 16 | 0 | 0 |  |
| dev | IPC channels | 3 | 18 | 0 | 0 |  |
| dev | IPC senders and receivers | 3 | 33 | 0 | 0 |  |
| dev | window settings | 3 | 21 | 0 | 0 |  |
| dev | bridge members | 3 | 18 | 0 | 0 |  |
| dev | bridge member channel | 3 | 18 | 0 | 0 |  |
| dev | endpoints | 3 | 17 | 1 | 0 |  |
| dev | endpoint method | 3 | 5 | 0 | 0 |  |
| dev | requests with an unknown URL shown | 3 | 3 | 0 | 0 |  |
| dev | storage keys | 3 | 21 | 0 | 0 |  |
| dev | storage read/write/delete | 3 | 18 | 0 | 0 |  |
| dev | changes in ipcChannels | 1 | 2 | 0 | 0 |  |
| dev | changes in contextBridge | 1 | 2 | 0 | 0 |  |
| dev | changes in webPreferences | 1 | 2 | 0 | 0 |  |
| dev | changes in endpoints | 1 | 3 | 0 | 0 |  |
| dev | changes in storage | 1 | 2 | 0 | 0 |  |

## Per input

| set | input | class | hit | missed | false | notes |
| --- | --- | --- | --- | --- | --- | --- |
| dev | dev/calls.O2.macho-arm64 → dev/calls-v2.O2.macho-arm64 | changes in imports | 1 | 0 | 0 |  |
| dev | dev/calls.O2.macho-arm64 → dev/calls-v2.O2.macho-arm64 | changes in symbols | 2 | 0 | 0 |  |
| dev | dev/calls.O0.macho-arm64 (radare2) | imports | 6 | 0 | 0 |  |
| dev | dev/calls.O0.macho-arm64 (radare2) | functions | 7 | 0 | 0 |  |
| dev | dev/calls.O0.macho-arm64 (radare2) | call paths | 4 | 0 | 0 |  |
| dev | dev/calls.O0.macho-arm64 (radare2) | direct callers | 4 | 0 | 0 |  |
| dev | dev/calls.O0.macho-arm64 (rizin) | imports | 6 | 0 | 0 |  |
| dev | dev/calls.O0.macho-arm64 (rizin) | functions | 7 | 0 | 0 |  |
| dev | dev/calls.O0.macho-arm64 (rizin) | call paths | 4 | 0 | 0 |  |
| dev | dev/calls.O0.macho-arm64 (rizin) | direct callers | 4 | 0 | 0 | by_pointer: indirect caller main reported |
| dev | dev/calls.O2.macho-arm64 (radare2) | imports | 6 | 0 | 0 |  |
| dev | dev/calls.O2.macho-arm64 (radare2) | functions | 7 | 0 | 0 |  |
| dev | dev/calls.O2.macho-arm64 (radare2) | call paths | 4 | 0 | 0 |  |
| dev | dev/calls.O2.macho-arm64 (radare2) | direct callers | 4 | 0 | 0 |  |
| dev | dev/calls.O2.macho-arm64 (rizin) | imports | 6 | 0 | 0 |  |
| dev | dev/calls.O2.macho-arm64 (rizin) | functions | 7 | 0 | 0 |  |
| dev | dev/calls.O2.macho-arm64 (rizin) | call paths | 4 | 0 | 0 |  |
| dev | dev/calls.O2.macho-arm64 (rizin) | direct callers | 4 | 0 | 0 | by_pointer: indirect caller main reported |
| dev | dev/notes-app.plain.asar | IPC channels | 6 | 0 | 0 |  |
| dev | dev/notes-app.plain.asar | IPC senders and receivers | 11 | 0 | 0 |  |
| dev | dev/notes-app.plain.asar | window settings | 7 | 0 | 0 |  |
| dev | dev/notes-app.plain.asar | bridge members | 6 | 0 | 0 |  |
| dev | dev/notes-app.plain.asar | bridge member channel | 6 | 0 | 0 |  |
| dev | dev/notes-app.plain.asar | endpoints | 6 | 0 | 0 |  |
| dev | dev/notes-app.plain.asar | endpoint method | 2 | 0 | 0 |  |
| dev | dev/notes-app.plain.asar | requests with an unknown URL shown | 1 | 0 | 0 |  |
| dev | dev/notes-app.plain.asar | storage keys | 7 | 0 | 0 |  |
| dev | dev/notes-app.plain.asar | storage read/write/delete | 6 | 0 | 0 |  |
| dev | dev/notes-app.bundled.asar | IPC channels | 6 | 0 | 0 |  |
| dev | dev/notes-app.bundled.asar | IPC senders and receivers | 11 | 0 | 0 |  |
| dev | dev/notes-app.bundled.asar | window settings | 7 | 0 | 0 |  |
| dev | dev/notes-app.bundled.asar | bridge members | 6 | 0 | 0 |  |
| dev | dev/notes-app.bundled.asar | bridge member channel | 6 | 0 | 0 |  |
| dev | dev/notes-app.bundled.asar | endpoints | 6 | 0 | 0 |  |
| dev | dev/notes-app.bundled.asar | endpoint method | 2 | 0 | 0 |  |
| dev | dev/notes-app.bundled.asar | requests with an unknown URL shown | 1 | 0 | 0 |  |
| dev | dev/notes-app.bundled.asar | storage keys | 7 | 0 | 0 |  |
| dev | dev/notes-app.bundled.asar | storage read/write/delete | 6 | 0 | 0 |  |
| dev | dev/notes-app.minified.asar | IPC channels | 6 | 0 | 0 |  |
| dev | dev/notes-app.minified.asar | IPC senders and receivers | 11 | 0 | 0 |  |
| dev | dev/notes-app.minified.asar | window settings | 7 | 0 | 0 |  |
| dev | dev/notes-app.minified.asar | bridge members | 6 | 0 | 0 |  |
| dev | dev/notes-app.minified.asar | bridge member channel | 6 | 0 | 0 |  |
| dev | dev/notes-app.minified.asar | endpoints | 5 | 1 | 0 | missed /v1/login |
| dev | dev/notes-app.minified.asar | endpoint method | 1 | 0 | 0 |  |
| dev | dev/notes-app.minified.asar | requests with an unknown URL shown | 1 | 0 | 0 |  |
| dev | dev/notes-app.minified.asar | storage keys | 7 | 0 | 0 |  |
| dev | dev/notes-app.minified.asar | storage read/write/delete | 6 | 0 | 0 |  |
| dev | dev/notes-app.plain.asar → dev/notes-app-v2.plain.asar | changes in ipcChannels | 2 | 0 | 0 |  |
| dev | dev/notes-app.plain.asar → dev/notes-app-v2.plain.asar | changes in contextBridge | 2 | 0 | 0 |  |
| dev | dev/notes-app.plain.asar → dev/notes-app-v2.plain.asar | changes in webPreferences | 2 | 0 | 0 |  |
| dev | dev/notes-app.plain.asar → dev/notes-app-v2.plain.asar | changes in endpoints | 3 | 0 | 0 |  |
| dev | dev/notes-app.plain.asar → dev/notes-app-v2.plain.asar | changes in storage | 2 | 0 | 0 |  |
