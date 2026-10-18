# hexvero 0.9.8 on the hexvero corpus

Tool: name hexvero · version 0.9.8 · commit 191d688 · node v22.17.1 · platform darwin arm64 · engines {"radare2":"radare2 6.2.4 +0 abi:152 @ darwin-arm_64","rizin":"rizin 0.9.1 @ darwin-arm-64, package: 0.9.1_2 (Homebrew)"}

## Per class

| set | class | inputs | hit | missed | false | not found but warned |
| --- | --- | --- | --- | --- | --- | --- |
| holdout7 | IPC channels | 4 | 23 | 29 | 0 |  |
| holdout7 | IPC senders and receivers | 4 | 34 | 12 | 0 |  |
| holdout7 | window settings | 4 | 32 | 8 | 2 |  |
| holdout7 | bridge members | 4 | 11 | 41 | 0 |  |
| holdout7 | bridge member channel | 4 | 11 | 0 | 0 |  |
| holdout7 | endpoints | 4 | 17 | 4 | 0 |  |
| holdout7 | endpoint method | 4 | 13 | 4 | 0 |  |
| holdout7 | requests with an unknown URL shown | 4 | 4 | 0 | 4 |  |
| holdout7 | storage keys | 4 | 21 | 4 | 0 |  |
| holdout7 | storage read/write/delete | 4 | 21 | 0 | 0 |  |
| holdout7 | changes in ipcChannels | 1 | 3 | 1 | 0 |  |
| holdout7 | changes in contextBridge | 1 | 1 | 1 | 0 |  |
| holdout7 | changes in webPreferences | 1 | 1 | 0 | 1 |  |
| holdout7 | changes in endpoints | 1 | 1 | 0 | 0 |  |
| holdout7 | changes in storage | 1 | 1 | 0 | 0 |  |

## Per input

| set | input | class | hit | missed | false | notes |
| --- | --- | --- | --- | --- | --- | --- |
| holdout7 | holdout7/padwright.plain.asar | IPC channels | 6 | 7 | 0 | missed device:list; missed keymap:read; missed keymap:write; missed settings:get; missed settings:set; missed firmware:check; missed flasher:open |
| holdout7 | holdout7/padwright.plain.asar | IPC senders and receivers | 9 | 3 | 0 | flash:start: receiver ipc-table.js missed; device:attached: receiver preload.js missed; telemetry:event: sender preload.js missed |
| holdout7 | holdout7/padwright.plain.asar | window settings | 8 | 2 | 0 | missed windows.js preload=preload.js; missed windows.js preload=preload-flasher.js |
| holdout7 | holdout7/padwright.plain.asar | bridge members | 3 | 10 | 0 | missed padwright.isMac; missed padwright.listDevices; missed padwright.readKeymap; missed padwright.writeKeymap; missed padwright.getSettings; missed padwright.setSettings; missed padwright.checkFirmware; missed padwright.openFlasher; missed padwright.onDeviceAttached; missed padwright.track; 1 entry reported as unreadable |
| holdout7 | holdout7/padwright.plain.asar | bridge member channel | 3 | 0 | 0 |  |
| holdout7 | holdout7/padwright.plain.asar | endpoints | 4 | 1 | 0 | missed https://dl.padwright.example/firmware/… |
| holdout7 | holdout7/padwright.plain.asar | endpoint method | 3 | 1 | 0 | https://share.padwright.example/api/layouts?model=…: expected GET |
| holdout7 | holdout7/padwright.plain.asar | requests with an unknown URL shown | 1 | 0 | 1 |  |
| holdout7 | holdout7/padwright.plain.asar | storage keys | 5 | 1 | 0 | missed file padwright-settings.json |
| holdout7 | holdout7/padwright.plain.asar | storage read/write/delete | 5 | 0 | 0 |  |
| holdout7 | holdout7/padwright.bundled.asar | IPC channels | 6 | 7 | 0 | missed device:list; missed keymap:read; missed keymap:write; missed settings:get; missed settings:set; missed firmware:check; missed flasher:open |
| holdout7 | holdout7/padwright.bundled.asar | IPC senders and receivers | 9 | 3 | 0 | flash:start: receiver main.js missed; device:attached: receiver preload.js missed; telemetry:event: sender preload.js missed |
| holdout7 | holdout7/padwright.bundled.asar | window settings | 8 | 2 | 0 | missed main.js preload=preload.js; missed main.js preload=preload-flasher.js |
| holdout7 | holdout7/padwright.bundled.asar | bridge members | 3 | 10 | 0 | missed padwright.isMac; missed padwright.listDevices; missed padwright.readKeymap; missed padwright.writeKeymap; missed padwright.getSettings; missed padwright.setSettings; missed padwright.checkFirmware; missed padwright.openFlasher; missed padwright.onDeviceAttached; missed padwright.track; 1 entry reported as unreadable |
| holdout7 | holdout7/padwright.bundled.asar | bridge member channel | 3 | 0 | 0 |  |
| holdout7 | holdout7/padwright.bundled.asar | endpoints | 4 | 1 | 0 | missed https://dl.padwright.example/firmware/… |
| holdout7 | holdout7/padwright.bundled.asar | endpoint method | 3 | 1 | 0 | https://share.padwright.example/api/layouts?model=…: expected GET |
| holdout7 | holdout7/padwright.bundled.asar | requests with an unknown URL shown | 1 | 0 | 1 |  |
| holdout7 | holdout7/padwright.bundled.asar | storage keys | 5 | 1 | 0 | missed file padwright-settings.json |
| holdout7 | holdout7/padwright.bundled.asar | storage read/write/delete | 5 | 0 | 0 |  |
| holdout7 | holdout7/padwright.minified.asar | IPC channels | 6 | 7 | 0 | missed device:list; missed keymap:read; missed keymap:write; missed settings:get; missed settings:set; missed firmware:check; missed flasher:open |
| holdout7 | holdout7/padwright.minified.asar | IPC senders and receivers | 9 | 3 | 0 | flash:start: receiver main.js missed; device:attached: receiver preload.js missed; telemetry:event: sender preload.js missed |
| holdout7 | holdout7/padwright.minified.asar | window settings | 8 | 2 | 0 | missed main.js preload=preload.js; missed main.js preload=preload-flasher.js |
| holdout7 | holdout7/padwright.minified.asar | bridge members | 3 | 10 | 0 | missed padwright.isMac; missed padwright.listDevices; missed padwright.readKeymap; missed padwright.writeKeymap; missed padwright.getSettings; missed padwright.setSettings; missed padwright.checkFirmware; missed padwright.openFlasher; missed padwright.onDeviceAttached; missed padwright.track; 1 entry reported as unreadable |
| holdout7 | holdout7/padwright.minified.asar | bridge member channel | 3 | 0 | 0 |  |
| holdout7 | holdout7/padwright.minified.asar | endpoints | 4 | 1 | 0 | missed https://dl.padwright.example/firmware/… |
| holdout7 | holdout7/padwright.minified.asar | endpoint method | 3 | 1 | 0 | https://share.padwright.example/api/layouts?model=…: expected GET |
| holdout7 | holdout7/padwright.minified.asar | requests with an unknown URL shown | 1 | 0 | 1 |  |
| holdout7 | holdout7/padwright.minified.asar | storage keys | 5 | 1 | 0 | missed file padwright-settings.json |
| holdout7 | holdout7/padwright.minified.asar | storage read/write/delete | 5 | 0 | 0 |  |
| holdout7 | holdout7/padwright-v2.plain.asar | IPC channels | 5 | 8 | 0 | missed device:list; missed keymap:read; missed keymap:write; missed keymap:reset; missed settings:get; missed settings:set; missed firmware:check; missed flasher:open |
| holdout7 | holdout7/padwright-v2.plain.asar | IPC senders and receivers | 7 | 3 | 0 | flash:start: receiver ipc-table.js missed; device:attached: receiver preload.js missed; telemetry:event: sender preload.js missed |
| holdout7 | holdout7/padwright-v2.plain.asar | window settings | 8 | 2 | 2 | missed windows.js preload=preload.js; missed windows.js preload=preload-flasher.js; false windows.js sandbox=true; false windows.js sandbox=false |
| holdout7 | holdout7/padwright-v2.plain.asar | bridge members | 2 | 11 | 0 | missed padwright.listDevices; missed padwright.readKeymap; missed padwright.writeKeymap; missed padwright.resetKeymap; missed padwright.getSettings; missed padwright.setSettings; missed padwright.checkFirmware; missed padwright.openFlasher; missed padwright.onDeviceAttached; missed padwright.track; missed padwright.isMac; 1 entry reported as unreadable |
| holdout7 | holdout7/padwright-v2.plain.asar | bridge member channel | 2 | 0 | 0 |  |
| holdout7 | holdout7/padwright-v2.plain.asar | endpoints | 5 | 1 | 0 | missed https://dl.padwright.example/firmware/… |
| holdout7 | holdout7/padwright-v2.plain.asar | endpoint method | 4 | 1 | 0 | https://share.padwright.example/api/layouts?model=…: expected GET |
| holdout7 | holdout7/padwright-v2.plain.asar | requests with an unknown URL shown | 1 | 0 | 1 |  |
| holdout7 | holdout7/padwright-v2.plain.asar | storage keys | 6 | 1 | 0 | missed file padwright-settings.json |
| holdout7 | holdout7/padwright-v2.plain.asar | storage read/write/delete | 6 | 0 | 0 |  |
| holdout7 | holdout7/padwright.plain.asar → holdout7/padwright-v2.plain.asar | changes in ipcChannels | 3 | 1 | 0 | missed +keymap:reset |
| holdout7 | holdout7/padwright.plain.asar → holdout7/padwright-v2.plain.asar | changes in contextBridge | 1 | 1 | 0 | missed +padwright.resetKeymap |
| holdout7 | holdout7/padwright.plain.asar → holdout7/padwright-v2.plain.asar | changes in webPreferences | 1 | 0 | 1 | false +main/windows.js::mainWindow::sandbox |
| holdout7 | holdout7/padwright.plain.asar → holdout7/padwright-v2.plain.asar | changes in endpoints | 1 | 0 | 0 |  |
| holdout7 | holdout7/padwright.plain.asar → holdout7/padwright-v2.plain.asar | changes in storage | 1 | 0 | 0 |  |
