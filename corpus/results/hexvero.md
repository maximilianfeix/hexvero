# hexvero 0.8.0 on the hexvero corpus

Tool: name hexvero · version 0.8.0 · commit 05c31b4+uncommitted · node v22.17.1 · platform darwin arm64 · engines {"radare2":"radare2 6.2.4 +0 abi:152 @ darwin-arm_64","rizin":"rizin 0.9.1 @ darwin-arm-64, package: 0.9.1_2 (Homebrew)"}

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
| holdout | imports | 4 | 22 | 0 | 0 |  |
| holdout | functions | 4 | 68 | 0 | 0 |  |
| holdout | call paths | 4 | 70 | 2 | 0 |  |
| holdout | direct callers | 4 | 91 | 0 | 1 |  |
| holdout | IPC channels | 3 | 64 | 8 | 0 |  |
| holdout | IPC senders and receivers | 3 | 105 | 20 | 0 |  |
| holdout | window settings | 3 | 27 | 6 | 0 |  |
| holdout | bridge members | 3 | 60 | 9 | 0 |  |
| holdout | bridge member channel | 3 | 40 | 20 | 0 |  |
| holdout | endpoints | 3 | 36 | 6 | 0 |  |
| holdout | endpoint method | 3 | 9 | 3 | 0 |  |
| holdout | requests with an unknown URL shown | 3 | 3 | 0 | 5 |  |
| holdout | storage keys | 3 | 51 | 0 | 0 |  |
| holdout | storage read/write/delete | 3 | 39 | 6 | 0 |  |
| holdout | changes in ipcChannels | 1 | 3 | 0 | 0 |  |
| holdout | changes in contextBridge | 1 | 2 | 1 | 0 |  |
| holdout | changes in webPreferences | 1 | 2 | 0 | 0 |  |
| holdout | changes in endpoints | 1 | 4 | 4 | 0 |  |
| holdout | changes in storage | 1 | 1 | 1 | 0 |  |
| holdout2 | IPC channels | 6 | 118 | 8 | 0 |  |
| holdout2 | IPC senders and receivers | 6 | 219 | 17 | 0 |  |
| holdout2 | window settings | 6 | 52 | 11 | 0 |  |
| holdout2 | bridge members | 6 | 129 | 6 | 0 |  |
| holdout2 | bridge member channel | 6 | 121 | 8 | 0 |  |
| holdout2 | endpoints | 6 | 54 | 3 | 0 |  |
| holdout2 | endpoint method | 6 | 9 | 9 | 0 |  |
| holdout2 | requests with an unknown URL shown | 6 | 6 | 0 | 2 |  |
| holdout2 | storage keys | 6 | 53 | 4 | 0 |  |
| holdout2 | storage read/write/delete | 6 | 48 | 0 | 0 |  |
| holdout2 | changes in ipcChannels | 1 | 2 | 0 | 0 |  |
| holdout2 | changes in contextBridge | 1 | 1 | 1 | 0 |  |
| holdout2 | changes in webPreferences | 1 | 1 | 0 | 0 |  |
| holdout2 | changes in endpoints | 1 | 4 | 0 | 0 |  |
| holdout2 | changes in storage | 1 | 1 | 0 | 0 |  |
| holdout3 | IPC channels | 3 | 69 | 0 | 0 |  |
| holdout3 | IPC senders and receivers | 3 | 138 | 3 | 0 |  |
| holdout3 | window settings | 3 | 42 | 0 | 0 |  |
| holdout3 | bridge members | 3 | 78 | 0 | 0 |  |
| holdout3 | bridge member channel | 3 | 78 | 0 | 0 |  |
| holdout3 | endpoints | 3 | 18 | 3 | 0 |  |
| holdout3 | endpoint method | 3 | 3 | 0 | 0 |  |
| holdout3 | requests with an unknown URL shown | 3 | 6 | 0 | 0 |  |
| holdout3 | storage keys | 3 | 27 | 0 | 0 |  |
| holdout3 | storage read/write/delete | 3 | 24 | 0 | 0 |  |
| holdout3 | changes in ipcChannels | 1 | 2 | 0 | 0 |  |
| holdout3 | changes in contextBridge | 1 | 2 | 0 | 0 |  |
| holdout3 | changes in interfaceLinks | 1 | 0 | 2 | 0 |  |
| holdout3 | changes in webPreferences | 1 | 2 | 0 | 0 |  |
| holdout3 | changes in endpoints | 1 | 1 | 0 | 0 |  |
| holdout3 | changes in storage | 1 | 1 | 0 | 0 |  |
| holdout4 | IPC channels | 3 | 12 | 45 | 0 |  |
| holdout4 | IPC senders and receivers | 3 | 18 | 6 | 0 |  |
| holdout4 | window settings | 3 | 48 | 0 | 0 |  |
| holdout4 | bridge members | 3 | 66 | 0 | 0 |  |
| holdout4 | bridge member channel | 3 | 21 | 45 | 0 |  |
| holdout4 | endpoints | 3 | 15 | 6 | 0 |  |
| holdout4 | endpoint method | 3 | 6 | 0 | 0 |  |
| holdout4 | requests with an unknown URL shown | 3 | 3 | 0 | 2 |  |
| holdout4 | storage keys | 3 | 12 | 6 | 0 |  |
| holdout4 | storage read/write/delete | 3 | 9 | 0 | 0 |  |
| holdout4 | changes in ipcChannels | 1 | 0 | 2 | 0 |  |
| holdout4 | changes in contextBridge | 1 | 2 | 0 | 0 |  |
| holdout4 | changes in interfaceLinks | 1 | 0 | 2 | 0 |  |
| holdout4 | changes in webPreferences | 1 | 2 | 0 | 0 |  |
| holdout4 | changes in endpoints | 1 | 0 | 1 | 0 |  |
| holdout4 | changes in storage | 1 | 1 | 0 | 0 |  |
| damaged | damaged input | 6 | 6 | 0 | 0 |  |

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
| validation | validation/chat-app.plain.asar | IPC channels | 17 | 0 | 0 |  |
| validation | validation/chat-app.plain.asar | IPC senders and receivers | 35 | 0 | 0 |  |
| validation | validation/chat-app.plain.asar | window settings | 7 | 0 | 0 | not scored: 1 row(s) with other keys |
| validation | validation/chat-app.plain.asar | bridge members | 13 | 0 | 0 |  |
| validation | validation/chat-app.plain.asar | bridge member channel | 13 | 0 | 0 |  |
| validation | validation/chat-app.plain.asar | endpoints | 11 | 0 | 0 |  |
| validation | validation/chat-app.plain.asar | endpoint method | 3 | 0 | 0 |  |
| validation | validation/chat-app.plain.asar | requests with an unknown URL shown | 2 | 0 | 0 |  |
| validation | validation/chat-app.plain.asar | storage keys | 11 | 0 | 0 |  |
| validation | validation/chat-app.plain.asar | storage read/write/delete | 10 | 0 | 0 |  |
| validation | validation/chat-app.bundled.asar | IPC channels | 17 | 0 | 0 |  |
| validation | validation/chat-app.bundled.asar | IPC senders and receivers | 35 | 0 | 0 |  |
| validation | validation/chat-app.bundled.asar | window settings | 7 | 0 | 0 | not scored: 1 row(s) with other keys |
| validation | validation/chat-app.bundled.asar | bridge members | 13 | 0 | 0 |  |
| validation | validation/chat-app.bundled.asar | bridge member channel | 13 | 0 | 0 |  |
| validation | validation/chat-app.bundled.asar | endpoints | 11 | 0 | 0 |  |
| validation | validation/chat-app.bundled.asar | endpoint method | 3 | 0 | 0 |  |
| validation | validation/chat-app.bundled.asar | requests with an unknown URL shown | 2 | 0 | 0 |  |
| validation | validation/chat-app.bundled.asar | storage keys | 11 | 0 | 0 |  |
| validation | validation/chat-app.bundled.asar | storage read/write/delete | 10 | 0 | 0 |  |
| validation | validation/chat-app.minified.asar | IPC channels | 17 | 0 | 0 |  |
| validation | validation/chat-app.minified.asar | IPC senders and receivers | 35 | 0 | 0 |  |
| validation | validation/chat-app.minified.asar | window settings | 7 | 0 | 0 | not scored: 1 row(s) with other keys |
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
| holdout | holdout/exprcalc.O0.macho-arm64 (radare2) | imports | 6 | 0 | 0 |  |
| holdout | holdout/exprcalc.O0.macho-arm64 (radare2) | functions | 17 | 0 | 0 |  |
| holdout | holdout/exprcalc.O0.macho-arm64 (radare2) | call paths | 18 | 0 | 0 |  |
| holdout | holdout/exprcalc.O0.macho-arm64 (radare2) | direct callers | 23 | 0 | 0 |  |
| holdout | holdout/exprcalc.O0.macho-arm64 (rizin) | imports | 6 | 0 | 0 |  |
| holdout | holdout/exprcalc.O0.macho-arm64 (rizin) | functions | 17 | 0 | 0 |  |
| holdout | holdout/exprcalc.O0.macho-arm64 (rizin) | call paths | 18 | 0 | 0 |  |
| holdout | holdout/exprcalc.O0.macho-arm64 (rizin) | direct callers | 22 | 0 | 1 | count_binary: caller next_token false |
| holdout | holdout/exprcalc.O2.macho-arm64 (radare2) | imports | 5 | 0 | 0 |  |
| holdout | holdout/exprcalc.O2.macho-arm64 (radare2) | functions | 17 | 0 | 0 |  |
| holdout | holdout/exprcalc.O2.macho-arm64 (radare2) | call paths | 18 | 0 | 0 |  |
| holdout | holdout/exprcalc.O2.macho-arm64 (radare2) | direct callers | 23 | 0 | 0 |  |
| holdout | holdout/exprcalc.O2.macho-arm64 (rizin) | imports | 5 | 0 | 0 |  |
| holdout | holdout/exprcalc.O2.macho-arm64 (rizin) | functions | 17 | 0 | 0 |  |
| holdout | holdout/exprcalc.O2.macho-arm64 (rizin) | call paths | 16 | 2 | 0 | debug_level → atoi: path not found, stated without warning (no function atoi); main → atoi: not answered (no function atoi) |
| holdout | holdout/exprcalc.O2.macho-arm64 (rizin) | direct callers | 23 | 0 | 0 | state_blank: indirect caller next_token reported |
| holdout | holdout/time-tracker.plain.asar | IPC channels | 23 | 1 | 0 | missed theme:changed |
| holdout | holdout/time-tracker.plain.asar | IPC senders and receivers | 39 | 6 | 0 | timer:tick: sender main.js missed; projects:list: sender preload.js missed; projects:create: sender preload.js missed; projects:rename: sender preload.js missed; invoice:exported: sender main.js missed; update:ready: receiver preload.js missed |
| holdout | holdout/time-tracker.plain.asar | window settings | 11 | 0 | 0 |  |
| holdout | holdout/time-tracker.plain.asar | bridge members | 20 | 3 | 0 | missed widget.pin; missed widget.close; missed widget.connect; 1 entry reported as unreadable |
| holdout | holdout/time-tracker.plain.asar | bridge member channel | 16 | 4 | 0 | tracker.listProjects: expected projects:list, got null; tracker.createProject: expected projects:create, got null; tracker.renameProject: expected projects:rename, got null; tracker.createInvoice: expected invoice:create, got null |
| holdout | holdout/time-tracker.plain.asar | endpoints | 10 | 4 | 0 | missed https://api.punchclock.example/v3/clients; missed https://api.punchclock.example/v3/timesheets/current…; missed https://api.punchclock.example/v3/entries; missed https://updates.punchclock.example/feed/stable.json |
| holdout | holdout/time-tracker.plain.asar | endpoint method | 3 | 1 | 0 | https://hooks.punchclock.example/invoice-exported: expected POST |
| holdout | holdout/time-tracker.plain.asar | requests with an unknown URL shown | 1 | 0 | 3 |  |
| holdout | holdout/time-tracker.plain.asar | storage keys | 17 | 0 | 0 |  |
| holdout | holdout/time-tracker.plain.asar | storage read/write/delete | 13 | 2 | 0 | electron-store ui.locale: expected read+write, got read; electron-store ui.currency: expected read+write, got read |
| holdout | holdout/time-tracker.bundled.asar | IPC channels | 23 | 1 | 0 | missed theme:changed |
| holdout | holdout/time-tracker.bundled.asar | IPC senders and receivers | 40 | 5 | 0 | projects:list: sender preload.js missed; projects:create: sender preload.js missed; projects:rename: sender preload.js missed; invoice:exported: sender main.js missed; update:ready: receiver preload.js missed |
| holdout | holdout/time-tracker.bundled.asar | window settings | 8 | 3 | 0 | missed main.js sandbox=true; missed main.js contextIsolation=true; missed main.js nodeIntegration=false |
| holdout | holdout/time-tracker.bundled.asar | bridge members | 20 | 3 | 0 | missed widget.pin; missed widget.close; missed widget.connect; 1 entry reported as unreadable |
| holdout | holdout/time-tracker.bundled.asar | bridge member channel | 16 | 4 | 0 | tracker.listProjects: expected projects:list, got null; tracker.createProject: expected projects:create, got null; tracker.renameProject: expected projects:rename, got null; tracker.createInvoice: expected invoice:create, got null |
| holdout | holdout/time-tracker.bundled.asar | endpoints | 13 | 1 | 0 | missed https://api.punchclock.example/v3/entries |
| holdout | holdout/time-tracker.bundled.asar | endpoint method | 3 | 1 | 0 | https://hooks.punchclock.example/invoice-exported: expected POST |
| holdout | holdout/time-tracker.bundled.asar | requests with an unknown URL shown | 1 | 0 | 1 |  |
| holdout | holdout/time-tracker.bundled.asar | storage keys | 17 | 0 | 0 |  |
| holdout | holdout/time-tracker.bundled.asar | storage read/write/delete | 13 | 2 | 0 | electron-store ui.locale: expected read+write, got read; electron-store ui.currency: expected read+write, got read |
| holdout | holdout/time-tracker.minified.asar | IPC channels | 18 | 6 | 0 | missed projects:list; missed projects:create; missed projects:rename; missed menu:new-entry; missed update:ready; missed theme:changed |
| holdout | holdout/time-tracker.minified.asar | IPC senders and receivers | 26 | 9 | 0 | timer:start: sender preload.js missed; timer:stop: sender preload.js missed; timer:tick: receiver preload.js missed; widget:pin: receiver main.js missed; widget:close: receiver main.js missed; invoice:export: sender preload.js missed; invoice:exported: sender main.js missed; sync:progress: receiver preload.js missed; config:get-sync: sender preload.js missed |
| holdout | holdout/time-tracker.minified.asar | window settings | 8 | 3 | 0 | missed main.js sandbox=true; missed main.js contextIsolation=true; missed main.js nodeIntegration=false |
| holdout | holdout/time-tracker.minified.asar | bridge members | 20 | 3 | 0 | missed widget.pin; missed widget.close; missed widget.connect; 1 entry reported as unreadable |
| holdout | holdout/time-tracker.minified.asar | bridge member channel | 8 | 12 | 0 | tracker.startTimer: expected timer:start, got null; tracker.stopTimer: expected timer:stop, got null; tracker.onTick: expected timer:tick, got null; tracker.listProjects: expected projects:list, got null; tracker.createProject: expected projects:create, got null; tracker.renameProject: expected projects:rename, got null; tracker.createInvoice: expected invoice:create, got null; tracker.exportInvoice: expected invoice:export, got null; tracker.onSyncProgress: expected sync:progress, got null; tracker.setting: expected config:get-sync, got null; tracker.onNewEntry: expected menu:new-entry, got null; tracker.onUpdateReady: expected update:ready, got null |
| holdout | holdout/time-tracker.minified.asar | endpoints | 13 | 1 | 0 | missed https://api.punchclock.example/v3/entries |
| holdout | holdout/time-tracker.minified.asar | endpoint method | 3 | 1 | 0 | https://hooks.punchclock.example/invoice-exported: expected POST |
| holdout | holdout/time-tracker.minified.asar | requests with an unknown URL shown | 1 | 0 | 1 |  |
| holdout | holdout/time-tracker.minified.asar | storage keys | 17 | 0 | 0 |  |
| holdout | holdout/time-tracker.minified.asar | storage read/write/delete | 13 | 2 | 0 | electron-store ui.locale: expected read+write, got read; electron-store ui.currency: expected read+write, got read |
| holdout | holdout/time-tracker.plain.asar → holdout/time-tracker-v2.plain.asar | changes in ipcChannels | 3 | 0 | 0 |  |
| holdout | holdout/time-tracker.plain.asar → holdout/time-tracker-v2.plain.asar | changes in contextBridge | 2 | 1 | 0 | missed -widget.close |
| holdout | holdout/time-tracker.plain.asar → holdout/time-tracker-v2.plain.asar | changes in webPreferences | 2 | 0 | 0 |  |
| holdout | holdout/time-tracker.plain.asar → holdout/time-tracker-v2.plain.asar | changes in endpoints | 4 | 4 | 0 | missed +https://api.punchclock.example/v4/clients; missed +https://api.punchclock.example/v4/timesheets/current; missed -https://api.punchclock.example/v3/clients; missed -https://api.punchclock.example/v3/timesheets/current |
| holdout | holdout/time-tracker.plain.asar → holdout/time-tracker-v2.plain.asar | changes in storage | 1 | 1 | 0 | missed +electron-store ui.weekStart |
| holdout2 | holdout2/markdown-editor.plain.asar | IPC channels | 22 | 0 | 0 |  |
| holdout2 | holdout2/markdown-editor.plain.asar | IPC senders and receivers | 42 | 2 | 0 | settings:changed: sender main.js missed; vault:reveal: receiver main.js missed |
| holdout2 | holdout2/markdown-editor.plain.asar | window settings | 9 | 0 | 0 |  |
| holdout2 | holdout2/markdown-editor.plain.asar | bridge members | 21 | 2 | 0 | missed inkwell.listNotes; missed inkwell.searchNotes; 1 entry reported as unreadable |
| holdout2 | holdout2/markdown-editor.plain.asar | bridge member channel | 21 | 0 | 0 |  |
| holdout2 | holdout2/markdown-editor.plain.asar | endpoints | 8 | 1 | 0 | missed https://embed.inkwell.example/oembed… |
| holdout2 | holdout2/markdown-editor.plain.asar | endpoint method | 3 | 0 | 0 |  |
| holdout2 | holdout2/markdown-editor.plain.asar | requests with an unknown URL shown | 1 | 0 | 1 |  |
| holdout2 | holdout2/markdown-editor.plain.asar | storage keys | 8 | 0 | 0 |  |
| holdout2 | holdout2/markdown-editor.plain.asar | storage read/write/delete | 7 | 0 | 0 |  |
| holdout2 | holdout2/markdown-editor.bundled.asar | IPC channels | 22 | 0 | 0 |  |
| holdout2 | holdout2/markdown-editor.bundled.asar | IPC senders and receivers | 42 | 2 | 0 | settings:changed: sender main.js missed; vault:reveal: receiver main.js missed |
| holdout2 | holdout2/markdown-editor.bundled.asar | window settings | 9 | 0 | 0 |  |
| holdout2 | holdout2/markdown-editor.bundled.asar | bridge members | 21 | 2 | 0 | missed inkwell.listNotes; missed inkwell.searchNotes; 1 entry reported as unreadable |
| holdout2 | holdout2/markdown-editor.bundled.asar | bridge member channel | 21 | 0 | 0 |  |
| holdout2 | holdout2/markdown-editor.bundled.asar | endpoints | 9 | 0 | 0 |  |
| holdout2 | holdout2/markdown-editor.bundled.asar | endpoint method | 3 | 0 | 0 |  |
| holdout2 | holdout2/markdown-editor.bundled.asar | requests with an unknown URL shown | 1 | 0 | 0 |  |
| holdout2 | holdout2/markdown-editor.bundled.asar | storage keys | 8 | 0 | 0 |  |
| holdout2 | holdout2/markdown-editor.bundled.asar | storage read/write/delete | 7 | 0 | 0 |  |
| holdout2 | holdout2/markdown-editor.minified.asar | IPC channels | 22 | 0 | 0 |  |
| holdout2 | holdout2/markdown-editor.minified.asar | IPC senders and receivers | 41 | 3 | 0 | settings:changed: sender main.js missed; vault:search: receiver main.js missed; vault:reveal: receiver main.js missed |
| holdout2 | holdout2/markdown-editor.minified.asar | window settings | 8 | 1 | 0 | missed main.js preload=preload.js |
| holdout2 | holdout2/markdown-editor.minified.asar | bridge members | 21 | 2 | 0 | missed inkwell.listNotes; missed inkwell.searchNotes; 1 entry reported as unreadable |
| holdout2 | holdout2/markdown-editor.minified.asar | bridge member channel | 21 | 0 | 0 |  |
| holdout2 | holdout2/markdown-editor.minified.asar | endpoints | 9 | 0 | 0 |  |
| holdout2 | holdout2/markdown-editor.minified.asar | endpoint method | 3 | 0 | 0 |  |
| holdout2 | holdout2/markdown-editor.minified.asar | requests with an unknown URL shown | 1 | 0 | 0 |  |
| holdout2 | holdout2/markdown-editor.minified.asar | storage keys | 4 | 4 | 0 | missed localStorage inkwell.theme; missed localStorage inkwell.sidebarWidth; missed localStorage inkwell.recent; missed indexedDB inkwell-search |
| holdout2 | holdout2/markdown-editor.minified.asar | storage read/write/delete | 4 | 0 | 0 |  |
| holdout2 | holdout2/markdown-editor.plain.asar → holdout2/markdown-editor-v2.plain.asar | changes in ipcChannels | 2 | 0 | 0 |  |
| holdout2 | holdout2/markdown-editor.plain.asar → holdout2/markdown-editor-v2.plain.asar | changes in contextBridge | 1 | 1 | 0 | missed +inkwell.renameNote |
| holdout2 | holdout2/markdown-editor.plain.asar → holdout2/markdown-editor-v2.plain.asar | changes in webPreferences | 1 | 0 | 0 |  |
| holdout2 | holdout2/markdown-editor.plain.asar → holdout2/markdown-editor-v2.plain.asar | changes in endpoints | 4 | 0 | 0 |  |
| holdout2 | holdout2/markdown-editor.plain.asar → holdout2/markdown-editor-v2.plain.asar | changes in storage | 1 | 0 | 0 |  |
| holdout2 | holdout2/music-player.plain.asar | IPC channels | 20 | 0 | 0 |  |
| holdout2 | holdout2/music-player.plain.asar | IPC senders and receivers | 35 | 5 | 0 | playlists:list: receiver main.js missed; playlists:save: receiver main.js missed; settings:get: receiver main.js missed; settings:set: receiver main.js missed; mini:get-artwork: receiver main.js missed |
| holdout2 | holdout2/music-player.plain.asar | window settings | 12 | 0 | 0 |  |
| holdout2 | holdout2/music-player.plain.asar | bridge members | 22 | 0 | 0 |  |
| holdout2 | holdout2/music-player.plain.asar | bridge member channel | 22 | 0 | 0 |  |
| holdout2 | holdout2/music-player.plain.asar | endpoints | 10 | 0 | 0 |  |
| holdout2 | holdout2/music-player.plain.asar | endpoint method | 0 | 3 | 0 | https://api.cadence.example/v2/scrobbles: expected POST; https://api.cadence.example/v2/me/likes/…: expected POST; https://api.cadence.example/v2/me/likes/…: expected DELETE |
| holdout2 | holdout2/music-player.plain.asar | requests with an unknown URL shown | 1 | 0 | 0 |  |
| holdout2 | holdout2/music-player.plain.asar | storage keys | 11 | 0 | 0 |  |
| holdout2 | holdout2/music-player.plain.asar | storage read/write/delete | 10 | 0 | 0 |  |
| holdout2 | holdout2/music-player.bundled.asar | IPC channels | 20 | 0 | 0 |  |
| holdout2 | holdout2/music-player.bundled.asar | IPC senders and receivers | 35 | 5 | 0 | playlists:list: receiver main.js missed; playlists:save: receiver main.js missed; settings:get: receiver main.js missed; settings:set: receiver main.js missed; mini:get-artwork: receiver main.js missed |
| holdout2 | holdout2/music-player.bundled.asar | window settings | 7 | 5 | 0 | missed main.js contextIsolation=true; missed main.js nodeIntegration=false; missed main.js contextIsolation=true; missed main.js nodeIntegration=false; missed main.js sandbox=true |
| holdout2 | holdout2/music-player.bundled.asar | bridge members | 22 | 0 | 0 |  |
| holdout2 | holdout2/music-player.bundled.asar | bridge member channel | 22 | 0 | 0 |  |
| holdout2 | holdout2/music-player.bundled.asar | endpoints | 10 | 0 | 0 |  |
| holdout2 | holdout2/music-player.bundled.asar | endpoint method | 0 | 3 | 0 | https://api.cadence.example/v2/scrobbles: expected POST; https://api.cadence.example/v2/me/likes/…: expected POST; https://api.cadence.example/v2/me/likes/…: expected DELETE |
| holdout2 | holdout2/music-player.bundled.asar | requests with an unknown URL shown | 1 | 0 | 0 |  |
| holdout2 | holdout2/music-player.bundled.asar | storage keys | 11 | 0 | 0 |  |
| holdout2 | holdout2/music-player.bundled.asar | storage read/write/delete | 10 | 0 | 0 |  |
| holdout2 | holdout2/music-player.minified.asar | IPC channels | 12 | 8 | 0 | missed playlists:list; missed playlists:save; missed settings:get; missed settings:set; missed settings:changed; missed player:state-changed; missed player:state; missed mini:get-artwork |
| holdout2 | holdout2/music-player.minified.asar | IPC senders and receivers | 24 | 0 | 0 |  |
| holdout2 | holdout2/music-player.minified.asar | window settings | 7 | 5 | 0 | missed main.js contextIsolation=true; missed main.js nodeIntegration=false; missed main.js contextIsolation=true; missed main.js nodeIntegration=false; missed main.js sandbox=true |
| holdout2 | holdout2/music-player.minified.asar | bridge members | 22 | 0 | 0 |  |
| holdout2 | holdout2/music-player.minified.asar | bridge member channel | 14 | 8 | 0 | cadence.listPlaylists: expected playlists:list, got null; cadence.savePlaylist: expected playlists:save, got null; cadence.reportState: expected player:state-changed, got null; cadence.getSettings: expected settings:get, got null; cadence.updateSettings: expected settings:set, got null; cadence.onSettingsChanged: expected settings:changed, got null; mini.onState: expected player:state, got null; mini.getArtwork: expected mini:get-artwork, got null |
| holdout2 | holdout2/music-player.minified.asar | endpoints | 8 | 2 | 0 | missed https://lyrics.cadence.example/v1/search?…; missed https://updates.cadence.example/stable/latest.json |
| holdout2 | holdout2/music-player.minified.asar | endpoint method | 0 | 3 | 0 | https://api.cadence.example/v2/scrobbles: expected POST; https://api.cadence.example/v2/me/likes/…: expected POST; https://api.cadence.example/v2/me/likes/…: expected DELETE |
| holdout2 | holdout2/music-player.minified.asar | requests with an unknown URL shown | 1 | 0 | 1 |  |
| holdout2 | holdout2/music-player.minified.asar | storage keys | 11 | 0 | 0 |  |
| holdout2 | holdout2/music-player.minified.asar | storage read/write/delete | 10 | 0 | 0 |  |
| holdout3 | holdout3/podcast-player.plain.asar | IPC channels | 23 | 0 | 0 |  |
| holdout3 | holdout3/podcast-player.plain.asar | IPC senders and receivers | 46 | 1 | 0 | download:progress: sender main.js missed |
| holdout3 | holdout3/podcast-player.plain.asar | window settings | 14 | 0 | 0 |  |
| holdout3 | holdout3/podcast-player.plain.asar | bridge members | 26 | 0 | 0 |  |
| holdout3 | holdout3/podcast-player.plain.asar | bridge member channel | 26 | 0 | 0 |  |
| holdout3 | holdout3/podcast-player.plain.asar | endpoints | 6 | 1 | 0 | missed https://api.driftwood.example/v1/directory/top |
| holdout3 | holdout3/podcast-player.plain.asar | endpoint method | 1 | 0 | 0 |  |
| holdout3 | holdout3/podcast-player.plain.asar | requests with an unknown URL shown | 2 | 0 | 0 |  |
| holdout3 | holdout3/podcast-player.plain.asar | storage keys | 9 | 0 | 0 |  |
| holdout3 | holdout3/podcast-player.plain.asar | storage read/write/delete | 8 | 0 | 0 |  |
| holdout3 | holdout3/podcast-player.bundled.asar | IPC channels | 23 | 0 | 0 |  |
| holdout3 | holdout3/podcast-player.bundled.asar | IPC senders and receivers | 46 | 1 | 0 | download:progress: sender main.js missed |
| holdout3 | holdout3/podcast-player.bundled.asar | window settings | 14 | 0 | 0 |  |
| holdout3 | holdout3/podcast-player.bundled.asar | bridge members | 26 | 0 | 0 |  |
| holdout3 | holdout3/podcast-player.bundled.asar | bridge member channel | 26 | 0 | 0 |  |
| holdout3 | holdout3/podcast-player.bundled.asar | endpoints | 6 | 1 | 0 | missed https://api.driftwood.example/v1/directory/top |
| holdout3 | holdout3/podcast-player.bundled.asar | endpoint method | 1 | 0 | 0 |  |
| holdout3 | holdout3/podcast-player.bundled.asar | requests with an unknown URL shown | 2 | 0 | 0 |  |
| holdout3 | holdout3/podcast-player.bundled.asar | storage keys | 9 | 0 | 0 |  |
| holdout3 | holdout3/podcast-player.bundled.asar | storage read/write/delete | 8 | 0 | 0 |  |
| holdout3 | holdout3/podcast-player.minified.asar | IPC channels | 23 | 0 | 0 |  |
| holdout3 | holdout3/podcast-player.minified.asar | IPC senders and receivers | 46 | 1 | 0 | download:progress: sender main.js missed |
| holdout3 | holdout3/podcast-player.minified.asar | window settings | 14 | 0 | 0 |  |
| holdout3 | holdout3/podcast-player.minified.asar | bridge members | 26 | 0 | 0 |  |
| holdout3 | holdout3/podcast-player.minified.asar | bridge member channel | 26 | 0 | 0 |  |
| holdout3 | holdout3/podcast-player.minified.asar | endpoints | 6 | 1 | 0 | missed https://api.driftwood.example/v1/directory/top |
| holdout3 | holdout3/podcast-player.minified.asar | endpoint method | 1 | 0 | 0 |  |
| holdout3 | holdout3/podcast-player.minified.asar | requests with an unknown URL shown | 2 | 0 | 0 |  |
| holdout3 | holdout3/podcast-player.minified.asar | storage keys | 9 | 0 | 0 |  |
| holdout3 | holdout3/podcast-player.minified.asar | storage read/write/delete | 8 | 0 | 0 |  |
| holdout3 | holdout3/podcast-player.plain.asar → holdout3/podcast-player-v2.plain.asar | changes in ipcChannels | 2 | 0 | 0 |  |
| holdout3 | holdout3/podcast-player.plain.asar → holdout3/podcast-player-v2.plain.asar | changes in contextBridge | 2 | 0 | 0 |  |
| holdout3 | holdout3/podcast-player.plain.asar → holdout3/podcast-player-v2.plain.asar | changes in interfaceLinks | 0 | 2 | 0 | missed +[object Object]; missed -[object Object] |
| holdout3 | holdout3/podcast-player.plain.asar → holdout3/podcast-player-v2.plain.asar | changes in webPreferences | 2 | 0 | 0 |  |
| holdout3 | holdout3/podcast-player.plain.asar → holdout3/podcast-player-v2.plain.asar | changes in endpoints | 1 | 0 | 0 |  |
| holdout3 | holdout3/podcast-player.plain.asar → holdout3/podcast-player-v2.plain.asar | changes in storage | 1 | 0 | 0 |  |
| holdout4 | holdout4/kanban-board.plain.asar | IPC channels | 4 | 15 | 0 | missed board:list; missed board:move; missed board:archive; missed board:changed; missed card:create; missed card:rename; missed card:remove; missed card:link-preview; missed lane:collapse; missed lane:expand; missed lane:reorder; missed prefs:load; missed prefs:save; missed auth:sign-in; missed auth:sign-out |
| holdout4 | holdout4/kanban-board.plain.asar | IPC senders and receivers | 6 | 2 | 0 | activity:push: sender main.js missed; activity:clear: receiver main.js missed |
| holdout4 | holdout4/kanban-board.plain.asar | window settings | 16 | 0 | 0 | not scored: 1 row(s) with a computed value |
| holdout4 | holdout4/kanban-board.plain.asar | bridge members | 22 | 0 | 0 |  |
| holdout4 | holdout4/kanban-board.plain.asar | bridge member channel | 7 | 15 | 0 | lattice.listBoards: expected board:list, got null; lattice.moveCard: expected board:move, got null; lattice.archiveBoard: expected board:archive, got null; lattice.onBoardChanged: expected board:changed, got null; lattice.collapseLane: expected lane:collapse, got null; lattice.expandLane: expected lane:expand, got null; lattice.reorderLanes: expected lane:reorder, got null; lattice.loadPrefs: expected prefs:load, got null; lattice.savePrefs: expected prefs:save, got null; lattice.signIn: expected auth:sign-in, got null; lattice.signOut: expected auth:sign-out, got null; cards.create: expected card:create, got null; cards.rename: expected card:rename, got null; cards.remove: expected card:remove, got null; cards.linkPreview: expected card:link-preview, got null |
| holdout4 | holdout4/kanban-board.plain.asar | endpoints | 5 | 2 | 0 | missed https://api.lattice.example/v1/templates; missed https://api.lattice.example/v1/feedback |
| holdout4 | holdout4/kanban-board.plain.asar | endpoint method | 2 | 0 | 0 |  |
| holdout4 | holdout4/kanban-board.plain.asar | requests with an unknown URL shown | 1 | 0 | 1 |  |
| holdout4 | holdout4/kanban-board.plain.asar | storage keys | 4 | 2 | 0 | missed file lattice-settings.json; missed cookie lattice_sid |
| holdout4 | holdout4/kanban-board.plain.asar | storage read/write/delete | 3 | 0 | 0 |  |
| holdout4 | holdout4/kanban-board.bundled.asar | IPC channels | 4 | 15 | 0 | missed board:list; missed board:move; missed board:archive; missed board:changed; missed card:create; missed card:rename; missed card:remove; missed card:link-preview; missed lane:collapse; missed lane:expand; missed lane:reorder; missed prefs:load; missed prefs:save; missed auth:sign-in; missed auth:sign-out |
| holdout4 | holdout4/kanban-board.bundled.asar | IPC senders and receivers | 6 | 2 | 0 | activity:push: sender main.js missed; activity:clear: receiver main.js missed |
| holdout4 | holdout4/kanban-board.bundled.asar | window settings | 16 | 0 | 0 |  |
| holdout4 | holdout4/kanban-board.bundled.asar | bridge members | 22 | 0 | 0 |  |
| holdout4 | holdout4/kanban-board.bundled.asar | bridge member channel | 7 | 15 | 0 | lattice.listBoards: expected board:list, got null; lattice.moveCard: expected board:move, got null; lattice.archiveBoard: expected board:archive, got null; lattice.onBoardChanged: expected board:changed, got null; lattice.collapseLane: expected lane:collapse, got null; lattice.expandLane: expected lane:expand, got null; lattice.reorderLanes: expected lane:reorder, got null; lattice.loadPrefs: expected prefs:load, got null; lattice.savePrefs: expected prefs:save, got null; lattice.signIn: expected auth:sign-in, got null; lattice.signOut: expected auth:sign-out, got null; cards.create: expected card:create, got null; cards.rename: expected card:rename, got null; cards.remove: expected card:remove, got null; cards.linkPreview: expected card:link-preview, got null |
| holdout4 | holdout4/kanban-board.bundled.asar | endpoints | 5 | 2 | 0 | missed https://api.lattice.example/v1/templates; missed https://api.lattice.example/v1/feedback |
| holdout4 | holdout4/kanban-board.bundled.asar | endpoint method | 2 | 0 | 0 |  |
| holdout4 | holdout4/kanban-board.bundled.asar | requests with an unknown URL shown | 1 | 0 | 1 |  |
| holdout4 | holdout4/kanban-board.bundled.asar | storage keys | 4 | 2 | 0 | missed file lattice-settings.json; missed cookie lattice_sid |
| holdout4 | holdout4/kanban-board.bundled.asar | storage read/write/delete | 3 | 0 | 0 |  |
| holdout4 | holdout4/kanban-board.minified.asar | IPC channels | 4 | 15 | 0 | missed board:list; missed board:move; missed board:archive; missed board:changed; missed card:create; missed card:rename; missed card:remove; missed card:link-preview; missed lane:collapse; missed lane:expand; missed lane:reorder; missed prefs:load; missed prefs:save; missed auth:sign-in; missed auth:sign-out |
| holdout4 | holdout4/kanban-board.minified.asar | IPC senders and receivers | 6 | 2 | 0 | activity:push: sender main.js missed; activity:clear: receiver main.js missed |
| holdout4 | holdout4/kanban-board.minified.asar | window settings | 16 | 0 | 0 |  |
| holdout4 | holdout4/kanban-board.minified.asar | bridge members | 22 | 0 | 0 |  |
| holdout4 | holdout4/kanban-board.minified.asar | bridge member channel | 7 | 15 | 0 | lattice.listBoards: expected board:list, got null; lattice.moveCard: expected board:move, got null; lattice.archiveBoard: expected board:archive, got null; lattice.onBoardChanged: expected board:changed, got null; lattice.collapseLane: expected lane:collapse, got null; lattice.expandLane: expected lane:expand, got null; lattice.reorderLanes: expected lane:reorder, got null; lattice.loadPrefs: expected prefs:load, got null; lattice.savePrefs: expected prefs:save, got null; lattice.signIn: expected auth:sign-in, got null; lattice.signOut: expected auth:sign-out, got null; cards.create: expected card:create, got null; cards.rename: expected card:rename, got null; cards.remove: expected card:remove, got null; cards.linkPreview: expected card:link-preview, got null |
| holdout4 | holdout4/kanban-board.minified.asar | endpoints | 5 | 2 | 0 | missed https://api.lattice.example/v1/templates; missed https://api.lattice.example/v1/feedback |
| holdout4 | holdout4/kanban-board.minified.asar | endpoint method | 2 | 0 | 0 |  |
| holdout4 | holdout4/kanban-board.minified.asar | requests with an unknown URL shown | 1 | 0 | 0 |  |
| holdout4 | holdout4/kanban-board.minified.asar | storage keys | 4 | 2 | 0 | missed file lattice-settings.json; missed cookie lattice_sid |
| holdout4 | holdout4/kanban-board.minified.asar | storage read/write/delete | 3 | 0 | 0 |  |
| holdout4 | holdout4/kanban-board.plain.asar → holdout4/kanban-board-v2.plain.asar | changes in ipcChannels | 0 | 2 | 0 | missed +board:export; missed -board:archive |
| holdout4 | holdout4/kanban-board.plain.asar → holdout4/kanban-board-v2.plain.asar | changes in contextBridge | 2 | 0 | 0 |  |
| holdout4 | holdout4/kanban-board.plain.asar → holdout4/kanban-board-v2.plain.asar | changes in interfaceLinks | 0 | 2 | 0 | missed +[object Object]; missed -[object Object] |
| holdout4 | holdout4/kanban-board.plain.asar → holdout4/kanban-board-v2.plain.asar | changes in webPreferences | 2 | 0 | 0 |  |
| holdout4 | holdout4/kanban-board.plain.asar → holdout4/kanban-board-v2.plain.asar | changes in endpoints | 0 | 1 | 0 | missed +https://api.lattice.example/v1/changelog |
| holdout4 | holdout4/kanban-board.plain.asar → holdout4/kanban-board-v2.plain.asar | changes in storage | 1 | 0 | 0 |  |
| damaged | damaged/empty.asar | damaged input | 1 | 0 | 0 | error malformed |
| damaged | damaged/header-cut.asar | damaged input | 1 | 0 | 0 | error malformed |
| damaged | damaged/header-length-lies.asar | damaged input | 1 | 0 | 0 | error malformed |
| damaged | damaged/contents-cut.asar | damaged input | 1 | 0 | 0 | flagged (package_json_invalid, js_files_skipped, ipc_channel_unresolved) |
| damaged | damaged/load-commands-cut.macho-arm64 | damaged input | 1 | 0 | 0 | flagged (load_command_invalid, file_truncated) |
| damaged | damaged/body-cut.macho-arm64 | damaged input | 1 | 0 | 0 | flagged (file_truncated) |
