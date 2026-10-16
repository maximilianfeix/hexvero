# hexvero 0.8.0 on the hexvero corpus

Tool: name hexvero · version 0.8.0 · commit d0c2c1f · node v22.17.1 · platform darwin arm64 · engines {"radare2":"radare2 6.2.4 +0 abi:152 @ darwin-arm_64","rizin":"rizin 0.9.1 @ darwin-arm-64, package: 0.9.1_2 (Homebrew)"}

## Per class

| set | class | inputs | hit | missed | false | not found but warned |
| --- | --- | --- | --- | --- | --- | --- |
| holdout5 | IPC channels | 4 | 63 | 9 | 0 |  |
| holdout5 | IPC senders and receivers | 4 | 81 | 45 | 0 |  |
| holdout5 | IPC channels with an unknown name shown | 4 | 4 | 0 | 0 |  |
| holdout5 | window settings | 4 | 17 | 35 | 0 |  |
| holdout5 | bridge members | 4 | 76 | 0 | 0 |  |
| holdout5 | bridge member channel | 4 | 67 | 9 | 0 |  |
| holdout5 | endpoints | 4 | 21 | 4 | 0 |  |
| holdout5 | endpoint method | 4 | 5 | 16 | 0 |  |
| holdout5 | requests with an unknown URL shown | 4 | 4 | 0 | 4 |  |
| holdout5 | storage keys | 4 | 7 | 17 | 4 |  |
| holdout5 | storage read/write/delete | 4 | 7 | 0 | 0 |  |
| holdout5 | changes in ipcChannels | 1 | 3 | 1 | 0 |  |
| holdout5 | changes in contextBridge | 1 | 4 | 0 | 0 |  |
| holdout5 | changes in webPreferences | 1 | 0 | 2 | 0 |  |
| holdout5 | changes in endpoints | 1 | 1 | 0 | 0 |  |
| holdout5 | changes in storage | 1 | 0 | 0 | 0 |  |

## Per input

| set | input | class | hit | missed | false | notes |
| --- | --- | --- | --- | --- | --- | --- |
| holdout5 | holdout5/tidemark.plain.asar | IPC channels | 15 | 3 | 0 | missed export:markdown; missed export:html; missed export:json |
| holdout5 | holdout5/tidemark.plain.asar | IPC senders and receivers | 20 | 10 | 0 | releases:list: receiver handlers.js missed; release:load: receiver handlers.js missed; release:save: receiver handlers.js missed; release:delete: receiver handlers.js missed; settings:get: receiver handlers.js missed; settings:set: receiver handlers.js missed; publish:start: receiver handlers.js missed; publish:progress: sender publish.js missed; editor:dirty: receiver handlers.js missed; preview:update: receiver handlers.js missed |
| holdout5 | holdout5/tidemark.plain.asar | IPC channels with an unknown name shown | 1 | 0 | 0 | 6 call(s) without a channel: ipcRenderer.invoke at undefined:9, ipcRenderer.invoke at undefined:22, ipcRenderer.invoke at undefined:23, ipcRenderer.send at undefined:37, ipcMain.handle at undefined:16, ipcMain.on at undefined:28 |
| holdout5 | holdout5/tidemark.plain.asar | window settings | 3 | 10 | 0 | missed windows.js preload=preload.js; missed windows.js sandbox=false; missed windows.js webSecurity=false; missed windows.js preload=preload-preview.js; missed windows.js contextIsolation=true; missed windows.js nodeIntegration=false; missed windows.js webSecurity=true; missed windows.js contextIsolation=true; missed windows.js nodeIntegration=false; missed windows.js sandbox=true |
| holdout5 | holdout5/tidemark.plain.asar | bridge members | 19 | 0 | 0 |  |
| holdout5 | holdout5/tidemark.plain.asar | bridge member channel | 17 | 2 | 0 | tidemark.exportMarkdown: expected export:markdown, got null; tidemark.exportHtml: expected export:html, got null |
| holdout5 | holdout5/tidemark.plain.asar | endpoints | 5 | 1 | 0 | missed https://telemetry.tidemark.example/v1/events |
| holdout5 | holdout5/tidemark.plain.asar | endpoint method | 1 | 4 | 0 | https://updates.tidemark.example/desktop/latest.json: expected GET; https://api.tidemark.example/v2/projects/…: expected GET; https://code.tidemark.example/api/v1/repos/…: expected GET; https://cdn.tidemark.example/preview/themes/…: expected GET |
| holdout5 | holdout5/tidemark.plain.asar | requests with an unknown URL shown | 1 | 0 | 1 |  |
| holdout5 | holdout5/tidemark.plain.asar | storage keys | 1 | 5 | 2 | missed file tidemark-settings.json; missed file tidemark-drafts.json; missed localStorage tidemark.lastProject; missed localStorage tidemark.fontSize; missed sessionStorage tidemark.cursor; false localStorage tidemark.${…}; false sessionStorage tidemark.${…} |
| holdout5 | holdout5/tidemark.plain.asar | storage read/write/delete | 1 | 0 | 0 |  |
| holdout5 | holdout5/tidemark.bundled.asar | IPC channels | 17 | 1 | 0 | missed export:json |
| holdout5 | holdout5/tidemark.bundled.asar | IPC senders and receivers | 21 | 13 | 0 | releases:list: receiver main.js missed; release:load: receiver main.js missed; release:save: receiver main.js missed; release:delete: receiver main.js missed; settings:get: receiver main.js missed; settings:set: receiver main.js missed; export:markdown: receiver main.js missed; export:html: receiver main.js missed; publish:start: receiver main.js missed; publish:progress: sender main.js missed; editor:dirty: receiver main.js missed; preview:update: receiver main.js missed; preview:render: sender main.js missed |
| holdout5 | holdout5/tidemark.bundled.asar | IPC channels with an unknown name shown | 1 | 0 | 0 | 6 call(s) without a channel: ipcMain.handle at undefined:48, ipcMain.on at undefined:59, webContents.send at undefined:278, ipcRenderer.invoke at undefined:52, ipcRenderer.invoke at undefined:53, ipcRenderer.send at undefined:66 |
| holdout5 | holdout5/tidemark.bundled.asar | window settings | 3 | 10 | 0 | missed main.js preload=preload.js; missed main.js sandbox=false; missed main.js webSecurity=false; missed main.js preload=preload-preview.js; missed main.js contextIsolation=true; missed main.js nodeIntegration=false; missed main.js webSecurity=true; missed main.js contextIsolation=true; missed main.js nodeIntegration=false; missed main.js sandbox=true |
| holdout5 | holdout5/tidemark.bundled.asar | bridge members | 19 | 0 | 0 |  |
| holdout5 | holdout5/tidemark.bundled.asar | bridge member channel | 17 | 2 | 0 | tidemark.exportMarkdown: expected export:markdown, got null; tidemark.exportHtml: expected export:html, got null |
| holdout5 | holdout5/tidemark.bundled.asar | endpoints | 5 | 1 | 0 | missed https://telemetry.tidemark.example/v1/events |
| holdout5 | holdout5/tidemark.bundled.asar | endpoint method | 1 | 4 | 0 | https://updates.tidemark.example/desktop/latest.json: expected GET; https://api.tidemark.example/v2/projects/…: expected GET; https://code.tidemark.example/api/v1/repos/…: expected GET; https://cdn.tidemark.example/preview/themes/…: expected GET |
| holdout5 | holdout5/tidemark.bundled.asar | requests with an unknown URL shown | 1 | 0 | 1 |  |
| holdout5 | holdout5/tidemark.bundled.asar | storage keys | 4 | 2 | 0 | missed file tidemark-settings.json; missed file tidemark-drafts.json |
| holdout5 | holdout5/tidemark.bundled.asar | storage read/write/delete | 4 | 0 | 0 |  |
| holdout5 | holdout5/tidemark.minified.asar | IPC channels | 17 | 1 | 0 | missed export:json |
| holdout5 | holdout5/tidemark.minified.asar | IPC senders and receivers | 21 | 13 | 0 | releases:list: receiver main.js missed; release:load: receiver main.js missed; release:save: receiver main.js missed; release:delete: receiver main.js missed; settings:get: receiver main.js missed; settings:set: receiver main.js missed; export:markdown: receiver main.js missed; export:html: receiver main.js missed; publish:start: receiver main.js missed; publish:progress: sender main.js missed; editor:dirty: receiver main.js missed; preview:update: receiver main.js missed; preview:render: sender main.js missed |
| holdout5 | holdout5/tidemark.minified.asar | IPC channels with an unknown name shown | 1 | 0 | 0 | 6 call(s) without a channel: ipcMain.handle at undefined:1, ipcMain.on at undefined:1, webContents.send at undefined:3, ipcRenderer.invoke at undefined:1, ipcRenderer.invoke at undefined:1, ipcRenderer.send at undefined:1 |
| holdout5 | holdout5/tidemark.minified.asar | window settings | 8 | 5 | 0 | missed main.js preload=preload-preview.js; missed main.js webSecurity=true; missed main.js contextIsolation=true; missed main.js nodeIntegration=false; missed main.js sandbox=true |
| holdout5 | holdout5/tidemark.minified.asar | bridge members | 19 | 0 | 0 |  |
| holdout5 | holdout5/tidemark.minified.asar | bridge member channel | 17 | 2 | 0 | tidemark.exportMarkdown: expected export:markdown, got null; tidemark.exportHtml: expected export:html, got null |
| holdout5 | holdout5/tidemark.minified.asar | endpoints | 5 | 1 | 0 | missed https://telemetry.tidemark.example/v1/events |
| holdout5 | holdout5/tidemark.minified.asar | endpoint method | 1 | 4 | 0 | https://updates.tidemark.example/desktop/latest.json: expected GET; https://api.tidemark.example/v2/projects/…: expected GET; https://code.tidemark.example/api/v1/repos/…: expected GET; https://cdn.tidemark.example/preview/themes/…: expected GET |
| holdout5 | holdout5/tidemark.minified.asar | requests with an unknown URL shown | 1 | 0 | 1 |  |
| holdout5 | holdout5/tidemark.minified.asar | storage keys | 1 | 5 | 0 | missed file tidemark-settings.json; missed file tidemark-drafts.json; missed localStorage tidemark.lastProject; missed localStorage tidemark.fontSize; missed sessionStorage tidemark.cursor |
| holdout5 | holdout5/tidemark.minified.asar | storage read/write/delete | 1 | 0 | 0 |  |
| holdout5 | holdout5/tidemark-v2.plain.asar | IPC channels | 14 | 4 | 0 | missed export:markdown; missed export:html; missed export:json; missed export:text |
| holdout5 | holdout5/tidemark-v2.plain.asar | IPC senders and receivers | 19 | 9 | 0 | releases:list: receiver handlers.js missed; release:load: receiver handlers.js missed; release:save: receiver handlers.js missed; release:duplicate: receiver handlers.js missed; settings:get: receiver handlers.js missed; settings:set: receiver handlers.js missed; publish:start: receiver handlers.js missed; publish:progress: sender publish.js missed; preview:update: receiver handlers.js missed |
| holdout5 | holdout5/tidemark-v2.plain.asar | IPC channels with an unknown name shown | 1 | 0 | 0 | 7 call(s) without a channel: ipcRenderer.invoke at undefined:9, ipcRenderer.invoke at undefined:21, ipcRenderer.invoke at undefined:22, ipcRenderer.invoke at undefined:23, ipcRenderer.send at undefined:36, ipcMain.handle at undefined:16, ipcMain.on at undefined:28 |
| holdout5 | holdout5/tidemark-v2.plain.asar | window settings | 3 | 10 | 0 | missed windows.js preload=preload.js; missed windows.js sandbox=false; missed windows.js webSecurity=true; missed windows.js preload=preload-preview.js; missed windows.js contextIsolation=true; missed windows.js nodeIntegration=false; missed windows.js sandbox=false; missed windows.js webSecurity=true; missed windows.js contextIsolation=true; missed windows.js nodeIntegration=false |
| holdout5 | holdout5/tidemark-v2.plain.asar | bridge members | 19 | 0 | 0 |  |
| holdout5 | holdout5/tidemark-v2.plain.asar | bridge member channel | 16 | 3 | 0 | tidemark.exportMarkdown: expected export:markdown, got null; tidemark.exportHtml: expected export:html, got null; tidemark.exportText: expected export:text, got null |
| holdout5 | holdout5/tidemark-v2.plain.asar | endpoints | 6 | 1 | 0 | missed https://telemetry.tidemark.example/v1/events |
| holdout5 | holdout5/tidemark-v2.plain.asar | endpoint method | 2 | 4 | 0 | https://updates.tidemark.example/desktop/latest.json: expected GET; https://api.tidemark.example/v2/projects/…: expected GET; https://code.tidemark.example/api/v1/repos/…: expected GET; https://cdn.tidemark.example/preview/themes/…: expected GET |
| holdout5 | holdout5/tidemark-v2.plain.asar | requests with an unknown URL shown | 1 | 0 | 1 |  |
| holdout5 | holdout5/tidemark-v2.plain.asar | storage keys | 1 | 5 | 2 | missed file tidemark-settings.json; missed file tidemark-drafts.json; missed localStorage tidemark.lastProject; missed localStorage tidemark.fontSize; missed sessionStorage tidemark.cursor; false localStorage tidemark.${…}; false sessionStorage tidemark.${…} |
| holdout5 | holdout5/tidemark-v2.plain.asar | storage read/write/delete | 1 | 0 | 0 |  |
| holdout5 | holdout5/tidemark.plain.asar → holdout5/tidemark-v2.plain.asar | changes in ipcChannels | 3 | 1 | 0 | missed +export:text |
| holdout5 | holdout5/tidemark.plain.asar → holdout5/tidemark-v2.plain.asar | changes in contextBridge | 4 | 0 | 0 |  |
| holdout5 | holdout5/tidemark.plain.asar → holdout5/tidemark-v2.plain.asar | changes in webPreferences | 0 | 2 | 0 | missed ~webSecurity: false -> true; missed ~sandbox: true -> false |
| holdout5 | holdout5/tidemark.plain.asar → holdout5/tidemark-v2.plain.asar | changes in endpoints | 1 | 0 | 0 |  |
| holdout5 | holdout5/tidemark.plain.asar → holdout5/tidemark-v2.plain.asar | changes in storage | 0 | 0 | 0 |  |
