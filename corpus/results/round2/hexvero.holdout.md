# hexvero 0.3.0 on the hexvero corpus

Tool: name hexvero · version 0.3.0 · commit 1ca224b · node v25.2.1 · platform darwin arm64 · engines {"radare2":"radare2 6.2.4 +0 abi:152 @ darwin-arm_64","rizin":"rizin 0.9.1 @ darwin-arm-64, package: 0.9.1_2 (Homebrew)"}

## Per class

| set | class | inputs | hit | missed | false | not found but warned |
| --- | --- | --- | --- | --- | --- | --- |
| holdout | imports | 4 | 22 | 0 | 0 |  |
| holdout | functions | 4 | 68 | 0 | 0 |  |
| holdout | call paths | 4 | 71 | 1 | 0 |  |
| holdout | direct callers | 4 | 91 | 0 | 1 |  |
| holdout | IPC channels | 3 | 41 | 31 | 0 |  |
| holdout | IPC senders and receivers | 3 | 59 | 20 | 0 |  |
| holdout | window settings | 3 | 12 | 21 | 0 |  |
| holdout | bridge members | 3 | 60 | 9 | 0 |  |
| holdout | bridge member channel | 3 | 24 | 36 | 0 |  |
| holdout | endpoints | 3 | 24 | 18 | 5 |  |
| holdout | endpoint method | 3 | 6 | 3 | 0 |  |
| holdout | requests with an unknown URL shown | 3 | 3 | 0 | 12 |  |
| holdout | storage keys | 3 | 42 | 9 | 0 |  |
| holdout | storage read/write/delete | 3 | 30 | 6 | 0 |  |
| holdout | changes in ipcChannels | 1 | 0 | 3 | 1 |  |
| holdout | changes in contextBridge | 1 | 2 | 1 | 0 |  |
| holdout | changes in webPreferences | 1 | 0 | 2 | 1 |  |
| holdout | changes in endpoints | 1 | 4 | 4 | 0 |  |
| holdout | changes in storage | 1 | 1 | 1 | 0 |  |

## Per input

| set | input | class | hit | missed | false | notes |
| --- | --- | --- | --- | --- | --- | --- |
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
| holdout | holdout/exprcalc.O2.macho-arm64 (rizin) | call paths | 17 | 1 | 0 | debug_level → atoi: path not found, stated without warning (no function atoi) |
| holdout | holdout/exprcalc.O2.macho-arm64 (rizin) | direct callers | 23 | 0 | 0 | state_blank: indirect caller next_token reported |
| holdout | holdout/time-tracker.plain.asar | IPC channels | 11 | 13 | 0 | missed timer:start; missed timer:stop; missed timer:tick; missed projects:list; missed projects:create; missed projects:rename; missed invoice:create; missed invoice:export; missed sync:progress; missed config:get-sync; missed menu:new-entry; missed update:ready; missed theme:changed |
| holdout | holdout/time-tracker.plain.asar | IPC senders and receivers | 17 | 4 | 0 | widget:pin: receiver main.js missed; widget:close: receiver main.js missed; invoice:exported: sender main.js missed; timer:port: sender main.js missed |
| holdout | holdout/time-tracker.plain.asar | window settings | 3 | 8 | 0 | missed main.js nodeIntegration=false; missed main.js sandbox=true; missed main.js preload=preload.js; missed main.js contextIsolation=true; missed main.js nodeIntegration=false; missed main.js preload=preload.js; missed main.js contextIsolation=true; missed main.js nodeIntegration=false |
| holdout | holdout/time-tracker.plain.asar | bridge members | 20 | 3 | 0 | missed widget.pin; missed widget.close; missed widget.connect; 1 entry reported as unreadable |
| holdout | holdout/time-tracker.plain.asar | bridge member channel | 8 | 12 | 0 | tracker.startTimer: expected timer:start, got null; tracker.stopTimer: expected timer:stop, got null; tracker.onTick: expected timer:tick, got null; tracker.listProjects: expected projects:list, got null; tracker.createProject: expected projects:create, got null; tracker.renameProject: expected projects:rename, got null; tracker.createInvoice: expected invoice:create, got null; tracker.exportInvoice: expected invoice:export, got null; tracker.onSyncProgress: expected sync:progress, got null; tracker.setting: expected config:get-sync, got null; tracker.onNewEntry: expected menu:new-entry, got null; tracker.onUpdateReady: expected update:ready, got null |
| holdout | holdout/time-tracker.plain.asar | endpoints | 8 | 6 | 1 | missed https://api.punchclock.example/v3/clients; missed https://api.punchclock.example/v3/timesheets/current…; missed https://api.punchclock.example/v3/entries; missed https://files.punchclock.example/invoices; missed wss://live.punchclock.example/team/…; missed https://updates.punchclock.example/feed/stable.json; false ${…}/team/${…} |
| holdout | holdout/time-tracker.plain.asar | endpoint method | 2 | 1 | 0 | https://hooks.punchclock.example/invoice-exported: expected POST |
| holdout | holdout/time-tracker.plain.asar | requests with an unknown URL shown | 1 | 0 | 4 |  |
| holdout | holdout/time-tracker.plain.asar | storage keys | 14 | 3 | 0 | missed localStorage punch.theme; missed localStorage punch.session; missed localStorage sidebarWidth |
| holdout | holdout/time-tracker.plain.asar | storage read/write/delete | 10 | 2 | 0 | electron-store ui.locale: expected read+write, got read; electron-store ui.currency: expected read+write, got read |
| holdout | holdout/time-tracker.bundled.asar | IPC channels | 15 | 9 | 0 | missed timer:tick; missed projects:list; missed projects:create; missed projects:rename; missed invoice:create; missed config:get-sync; missed menu:new-entry; missed update:ready; missed theme:changed |
| holdout | holdout/time-tracker.bundled.asar | IPC senders and receivers | 21 | 8 | 0 | timer:start: sender preload.js missed; timer:stop: sender preload.js missed; widget:pin: receiver main.js missed; widget:close: receiver main.js missed; invoice:export: sender preload.js missed; invoice:exported: sender main.js missed; sync:progress: receiver preload.js missed; timer:port: sender main.js missed |
| holdout | holdout/time-tracker.bundled.asar | window settings | 3 | 8 | 0 | missed main.js nodeIntegration=false; missed main.js sandbox=true; missed main.js preload=preload.js; missed main.js contextIsolation=true; missed main.js nodeIntegration=false; missed main.js preload=preload.js; missed main.js contextIsolation=true; missed main.js nodeIntegration=false |
| holdout | holdout/time-tracker.bundled.asar | bridge members | 20 | 3 | 0 | missed widget.pin; missed widget.close; missed widget.connect; 1 entry reported as unreadable |
| holdout | holdout/time-tracker.bundled.asar | bridge member channel | 8 | 12 | 0 | tracker.startTimer: expected timer:start, got null; tracker.stopTimer: expected timer:stop, got null; tracker.onTick: expected timer:tick, got null; tracker.listProjects: expected projects:list, got null; tracker.createProject: expected projects:create, got null; tracker.renameProject: expected projects:rename, got null; tracker.createInvoice: expected invoice:create, got null; tracker.exportInvoice: expected invoice:export, got null; tracker.onSyncProgress: expected sync:progress, got null; tracker.setting: expected config:get-sync, got null; tracker.onNewEntry: expected menu:new-entry, got null; tracker.onUpdateReady: expected update:ready, got null |
| holdout | holdout/time-tracker.bundled.asar | endpoints | 8 | 6 | 2 | missed https://api.punchclock.example/v3/clients; missed https://api.punchclock.example/v3/timesheets/current…; missed https://api.punchclock.example/v3/entries; missed https://files.punchclock.example/invoices; missed wss://live.punchclock.example/team/…; missed https://updates.punchclock.example/feed/stable.json; false ${…}/feed/stable.json; false ${…}/team/${…} |
| holdout | holdout/time-tracker.bundled.asar | endpoint method | 2 | 1 | 0 | https://hooks.punchclock.example/invoice-exported: expected POST |
| holdout | holdout/time-tracker.bundled.asar | requests with an unknown URL shown | 1 | 0 | 4 |  |
| holdout | holdout/time-tracker.bundled.asar | storage keys | 14 | 3 | 0 | missed localStorage punch.theme; missed localStorage punch.session; missed localStorage sidebarWidth |
| holdout | holdout/time-tracker.bundled.asar | storage read/write/delete | 10 | 2 | 0 | electron-store ui.locale: expected read+write, got read; electron-store ui.currency: expected read+write, got read |
| holdout | holdout/time-tracker.minified.asar | IPC channels | 15 | 9 | 0 | missed timer:tick; missed projects:list; missed projects:create; missed projects:rename; missed invoice:create; missed config:get-sync; missed menu:new-entry; missed update:ready; missed theme:changed |
| holdout | holdout/time-tracker.minified.asar | IPC senders and receivers | 21 | 8 | 0 | timer:start: sender preload.js missed; timer:stop: sender preload.js missed; widget:pin: receiver main.js missed; widget:close: receiver main.js missed; invoice:export: sender preload.js missed; invoice:exported: sender main.js missed; sync:progress: receiver preload.js missed; timer:port: sender main.js missed |
| holdout | holdout/time-tracker.minified.asar | window settings | 6 | 5 | 0 | missed main.js sandbox=true; missed main.js nodeIntegration=false; missed main.js preload=preload.js; missed main.js contextIsolation=true; missed main.js nodeIntegration=false |
| holdout | holdout/time-tracker.minified.asar | bridge members | 20 | 3 | 0 | missed widget.pin; missed widget.close; missed widget.connect; 1 entry reported as unreadable |
| holdout | holdout/time-tracker.minified.asar | bridge member channel | 8 | 12 | 0 | tracker.startTimer: expected timer:start, got null; tracker.stopTimer: expected timer:stop, got null; tracker.onTick: expected timer:tick, got null; tracker.listProjects: expected projects:list, got null; tracker.createProject: expected projects:create, got null; tracker.renameProject: expected projects:rename, got null; tracker.createInvoice: expected invoice:create, got null; tracker.exportInvoice: expected invoice:export, got null; tracker.onSyncProgress: expected sync:progress, got null; tracker.setting: expected config:get-sync, got null; tracker.onNewEntry: expected menu:new-entry, got null; tracker.onUpdateReady: expected update:ready, got null |
| holdout | holdout/time-tracker.minified.asar | endpoints | 8 | 6 | 2 | missed https://api.punchclock.example/v3/clients; missed https://api.punchclock.example/v3/timesheets/current…; missed https://api.punchclock.example/v3/entries; missed https://files.punchclock.example/invoices; missed wss://live.punchclock.example/team/…; missed https://updates.punchclock.example/feed/stable.json; false ${…}/feed/stable.json; false ${…}/team/${…} |
| holdout | holdout/time-tracker.minified.asar | endpoint method | 2 | 1 | 0 | https://hooks.punchclock.example/invoice-exported: expected POST |
| holdout | holdout/time-tracker.minified.asar | requests with an unknown URL shown | 1 | 0 | 4 |  |
| holdout | holdout/time-tracker.minified.asar | storage keys | 14 | 3 | 0 | missed localStorage punch.theme; missed localStorage punch.session; missed localStorage sidebarWidth |
| holdout | holdout/time-tracker.minified.asar | storage read/write/delete | 10 | 2 | 0 | electron-store ui.locale: expected read+write, got read; electron-store ui.currency: expected read+write, got read |
| holdout | holdout/time-tracker.plain.asar → holdout/time-tracker-v2.plain.asar | changes in ipcChannels | 0 | 3 | 1 | missed +projects:retitle; missed -projects:rename; missed ~widget:close; false -widget:close |
| holdout | holdout/time-tracker.plain.asar → holdout/time-tracker-v2.plain.asar | changes in contextBridge | 2 | 1 | 0 | missed -widget.close |
| holdout | holdout/time-tracker.plain.asar → holdout/time-tracker-v2.plain.asar | changes in webPreferences | 0 | 2 | 1 | missed ~sandbox: false -> true; missed ~contextIsolation: true -> false; false -main.js::2::sandbox |
| holdout | holdout/time-tracker.plain.asar → holdout/time-tracker-v2.plain.asar | changes in endpoints | 4 | 4 | 0 | missed +https://api.punchclock.example/v4/clients; missed +https://api.punchclock.example/v4/timesheets/current; missed -https://api.punchclock.example/v3/clients; missed -https://api.punchclock.example/v3/timesheets/current |
| holdout | holdout/time-tracker.plain.asar → holdout/time-tracker-v2.plain.asar | changes in storage | 1 | 1 | 0 | missed +electron-store ui.weekStart |
