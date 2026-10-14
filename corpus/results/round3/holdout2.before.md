# hexvero 0.3.0 on the hexvero corpus

Tool: name hexvero · version 0.3.0 · commit bdb69b6 · node v25.2.1 · platform darwin arm64 · engines {"radare2":"radare2 6.2.4 +0 abi:152 @ darwin-arm_64","rizin":"rizin 0.9.1 @ darwin-arm-64, package: 0.9.1_2 (Homebrew)"}

## Per class

| set | class | inputs | hit | missed | false | not found but warned |
| --- | --- | --- | --- | --- | --- | --- |
| holdout2 | IPC channels | 6 | 90 | 36 | 0 |  |
| holdout2 | IPC senders and receivers | 6 | 173 | 7 | 0 |  |
| holdout2 | window settings | 6 | 42 | 21 | 6 |  |
| holdout2 | bridge members | 6 | 78 | 57 | 0 |  |
| holdout2 | bridge member channel | 6 | 65 | 13 | 0 |  |
| holdout2 | endpoints | 6 | 15 | 42 | 10 |  |
| holdout2 | endpoint method | 3 | 4 | 0 | 0 |  |
| holdout2 | requests with an unknown URL shown | 6 | 6 | 0 | 12 |  |
| holdout2 | storage keys | 6 | 47 | 10 | 1 |  |
| holdout2 | storage read/write/delete | 6 | 43 | 0 | 0 |  |
| holdout2 | changes in ipcChannels | 1 | 1 | 1 | 0 |  |
| holdout2 | changes in contextBridge | 1 | 1 | 1 | 0 |  |
| holdout2 | changes in webPreferences | 1 | 1 | 0 | 0 |  |
| holdout2 | changes in endpoints | 1 | 2 | 2 | 0 |  |
| holdout2 | changes in storage | 1 | 1 | 0 | 0 |  |

## Per input

| set | input | class | hit | missed | false | notes |
| --- | --- | --- | --- | --- | --- | --- |
| holdout2 | holdout2/markdown-editor.plain.asar | IPC channels | 17 | 5 | 0 | missed settings:get; missed settings:set; missed settings:changed; missed vault:list; missed vault:search |
| holdout2 | holdout2/markdown-editor.plain.asar | IPC senders and receivers | 32 | 2 | 0 | plugins:list: receiver main.js missed; vault:reveal: receiver main.js missed |
| holdout2 | holdout2/markdown-editor.plain.asar | window settings | 7 | 2 | 2 | missed main.js contextIsolation=true; missed main.js nodeIntegration=false; false main.js nodeIntegration=true; false main.js contextIsolation=false; not scored: 1 row(s) with a computed value |
| holdout2 | holdout2/markdown-editor.plain.asar | bridge members | 21 | 2 | 0 | missed inkwell.listNotes; missed inkwell.searchNotes; 1 entry reported as unreadable |
| holdout2 | holdout2/markdown-editor.plain.asar | bridge member channel | 18 | 3 | 0 | inkwell.getSettings: expected settings:get, got null; inkwell.setSetting: expected settings:set, got null; inkwell.onSettingsChanged: expected settings:changed, got null |
| holdout2 | holdout2/markdown-editor.plain.asar | endpoints | 6 | 3 | 0 | missed https://api.inkwell.example/v1/changelog; missed https://api.inkwell.example/v1/feedback; missed https://embed.inkwell.example/oembed… |
| holdout2 | holdout2/markdown-editor.plain.asar | endpoint method | 2 | 0 | 0 |  |
| holdout2 | holdout2/markdown-editor.plain.asar | requests with an unknown URL shown | 1 | 0 | 2 |  |
| holdout2 | holdout2/markdown-editor.plain.asar | storage keys | 6 | 2 | 1 | missed localStorage inkwell.theme; missed localStorage inkwell.sidebarWidth; false localStorage inkwell.${…} |
| holdout2 | holdout2/markdown-editor.plain.asar | storage read/write/delete | 5 | 0 | 0 |  |
| holdout2 | holdout2/markdown-editor.bundled.asar | IPC channels | 17 | 5 | 0 | missed settings:get; missed settings:set; missed settings:changed; missed vault:list; missed vault:search |
| holdout2 | holdout2/markdown-editor.bundled.asar | IPC senders and receivers | 32 | 2 | 0 | plugins:list: receiver main.js missed; vault:reveal: receiver main.js missed |
| holdout2 | holdout2/markdown-editor.bundled.asar | window settings | 7 | 2 | 2 | missed main.js contextIsolation=true; missed main.js nodeIntegration=false; false main.js nodeIntegration=true; false main.js contextIsolation=false; not scored: 1 row(s) with a computed value |
| holdout2 | holdout2/markdown-editor.bundled.asar | bridge members | 21 | 2 | 0 | missed inkwell.listNotes; missed inkwell.searchNotes; 1 entry reported as unreadable |
| holdout2 | holdout2/markdown-editor.bundled.asar | bridge member channel | 18 | 3 | 0 | inkwell.getSettings: expected settings:get, got null; inkwell.setSetting: expected settings:set, got null; inkwell.onSettingsChanged: expected settings:changed, got null |
| holdout2 | holdout2/markdown-editor.bundled.asar | endpoints | 2 | 7 | 3 | missed https://plugins.inkwell.example/registry.json; missed https://cdn.inkwell.example/plugins/…; missed https://api.inkwell.example/v1/changelog; missed https://api.inkwell.example/v1/feedback; missed https://sync.inkwell.example/v2/vaults/…; missed https://embed.inkwell.example/oembed…; missed wss://collab.inkwell.example/rooms/…; false ${…}/${…}/${…}/plugin.zip; false ${…}/vaults/${…}/files/${…}; false ${…}/rooms/${…} |
| holdout2 | holdout2/markdown-editor.bundled.asar | endpoint method | 1 | 0 | 0 |  |
| holdout2 | holdout2/markdown-editor.bundled.asar | requests with an unknown URL shown | 1 | 0 | 3 |  |
| holdout2 | holdout2/markdown-editor.bundled.asar | storage keys | 4 | 4 | 0 | missed localStorage inkwell.theme; missed localStorage inkwell.sidebarWidth; missed localStorage inkwell.recent; missed indexedDB inkwell-search |
| holdout2 | holdout2/markdown-editor.bundled.asar | storage read/write/delete | 4 | 0 | 0 |  |
| holdout2 | holdout2/markdown-editor.minified.asar | IPC channels | 17 | 5 | 0 | missed settings:get; missed settings:set; missed settings:changed; missed vault:list; missed vault:search |
| holdout2 | holdout2/markdown-editor.minified.asar | IPC senders and receivers | 32 | 2 | 0 | plugins:list: receiver main.js missed; vault:reveal: receiver main.js missed |
| holdout2 | holdout2/markdown-editor.minified.asar | window settings | 7 | 2 | 2 | missed main.js contextIsolation=true; missed main.js nodeIntegration=false; false main.js nodeIntegration=true; false main.js contextIsolation=false; not scored: 1 row(s) with a computed value |
| holdout2 | holdout2/markdown-editor.minified.asar | bridge members | 21 | 2 | 0 | missed inkwell.listNotes; missed inkwell.searchNotes; 1 entry reported as unreadable |
| holdout2 | holdout2/markdown-editor.minified.asar | bridge member channel | 18 | 3 | 0 | inkwell.getSettings: expected settings:get, got null; inkwell.setSetting: expected settings:set, got null; inkwell.onSettingsChanged: expected settings:changed, got null |
| holdout2 | holdout2/markdown-editor.minified.asar | endpoints | 2 | 7 | 3 | missed https://plugins.inkwell.example/registry.json; missed https://cdn.inkwell.example/plugins/…; missed https://api.inkwell.example/v1/changelog; missed https://api.inkwell.example/v1/feedback; missed https://sync.inkwell.example/v2/vaults/…; missed https://embed.inkwell.example/oembed…; missed wss://collab.inkwell.example/rooms/…; false ${…}/${…}/${…}/plugin.zip; false ${…}/vaults/${…}/files/${…}; false ${…}/rooms/${…} |
| holdout2 | holdout2/markdown-editor.minified.asar | endpoint method | 1 | 0 | 0 |  |
| holdout2 | holdout2/markdown-editor.minified.asar | requests with an unknown URL shown | 1 | 0 | 4 |  |
| holdout2 | holdout2/markdown-editor.minified.asar | storage keys | 4 | 4 | 0 | missed localStorage inkwell.theme; missed localStorage inkwell.sidebarWidth; missed localStorage inkwell.recent; missed indexedDB inkwell-search |
| holdout2 | holdout2/markdown-editor.minified.asar | storage read/write/delete | 4 | 0 | 0 |  |
| holdout2 | holdout2/markdown-editor.plain.asar → holdout2/markdown-editor-v2.plain.asar | changes in ipcChannels | 1 | 1 | 0 | missed +vault:rename |
| holdout2 | holdout2/markdown-editor.plain.asar → holdout2/markdown-editor-v2.plain.asar | changes in contextBridge | 1 | 1 | 0 | missed +inkwell.renameNote |
| holdout2 | holdout2/markdown-editor.plain.asar → holdout2/markdown-editor-v2.plain.asar | changes in webPreferences | 1 | 0 | 0 |  |
| holdout2 | holdout2/markdown-editor.plain.asar → holdout2/markdown-editor-v2.plain.asar | changes in endpoints | 2 | 2 | 0 | missed +https://api.inkwell.example/v2/changelog; missed -https://api.inkwell.example/v1/changelog |
| holdout2 | holdout2/markdown-editor.plain.asar → holdout2/markdown-editor-v2.plain.asar | changes in storage | 1 | 0 | 0 |  |
| holdout2 | holdout2/music-player.plain.asar | IPC channels | 15 | 5 | 0 | missed playlists:list; missed playlists:save; missed settings:get; missed settings:set; missed settings:changed |
| holdout2 | holdout2/music-player.plain.asar | IPC senders and receivers | 29 | 1 | 0 | mini:get-artwork: receiver main.js missed |
| holdout2 | holdout2/music-player.plain.asar | window settings | 7 | 5 | 0 | missed main.js contextIsolation=true; missed main.js nodeIntegration=false; missed main.js contextIsolation=true; missed main.js nodeIntegration=false; missed main.js sandbox=true |
| holdout2 | holdout2/music-player.plain.asar | bridge members | 5 | 17 | 0 | missed cadence.getTracks; missed cadence.addFolder; missed cadence.onScanProgress; missed cadence.listPlaylists; missed cadence.savePlaylist; missed cadence.exportPlaylist; missed cadence.reportState; missed cadence.onMediaKey; missed cadence.onCommand; missed cadence.fetchLyrics; missed cadence.toggleMiniPlayer; missed cadence.getSettings; missed cadence.updateSettings; missed cadence.onSettingsChanged; missed cadence.minimize; missed cadence.toggleMaximize; missed cadence.getVersion; 4 entries reported as unreadable |
| holdout2 | holdout2/music-player.plain.asar | bridge member channel | 5 | 0 | 0 |  |
| holdout2 | holdout2/music-player.plain.asar | endpoints | 3 | 7 | 0 | missed https://api.cadence.example/v2/me/recommendations; missed https://api.cadence.example/v2/artists/…; missed https://api.cadence.example/v2/scrobbles; missed https://api.cadence.example/v2/me/likes/…; missed https://api.cadence.example/v2/me/likes/…; missed https://lyrics.cadence.example/v1/search?…; missed https://updates.cadence.example/stable/latest.json |
| holdout2 | holdout2/music-player.plain.asar | requests with an unknown URL shown | 1 | 0 | 1 |  |
| holdout2 | holdout2/music-player.plain.asar | storage keys | 11 | 0 | 0 |  |
| holdout2 | holdout2/music-player.plain.asar | storage read/write/delete | 10 | 0 | 0 |  |
| holdout2 | holdout2/music-player.bundled.asar | IPC channels | 12 | 8 | 0 | missed playlists:list; missed playlists:save; missed settings:get; missed settings:set; missed settings:changed; missed player:state-changed; missed player:state; missed mini:get-artwork |
| holdout2 | holdout2/music-player.bundled.asar | IPC senders and receivers | 24 | 0 | 0 |  |
| holdout2 | holdout2/music-player.bundled.asar | window settings | 7 | 5 | 0 | missed main.js contextIsolation=true; missed main.js nodeIntegration=false; missed main.js contextIsolation=true; missed main.js nodeIntegration=false; missed main.js sandbox=true |
| holdout2 | holdout2/music-player.bundled.asar | bridge members | 5 | 17 | 0 | missed cadence.getTracks; missed cadence.addFolder; missed cadence.onScanProgress; missed cadence.listPlaylists; missed cadence.savePlaylist; missed cadence.exportPlaylist; missed cadence.reportState; missed cadence.onMediaKey; missed cadence.onCommand; missed cadence.fetchLyrics; missed cadence.toggleMiniPlayer; missed cadence.getSettings; missed cadence.updateSettings; missed cadence.onSettingsChanged; missed cadence.minimize; missed cadence.toggleMaximize; missed cadence.getVersion; 4 entries reported as unreadable |
| holdout2 | holdout2/music-player.bundled.asar | bridge member channel | 3 | 2 | 0 | mini.onState: expected player:state, got null; mini.getArtwork: expected mini:get-artwork, got null |
| holdout2 | holdout2/music-player.bundled.asar | endpoints | 1 | 9 | 2 | missed https://api.cadence.example/v2/me/recommendations; missed https://api.cadence.example/v2/artists/…; missed https://api.cadence.example/v2/scrobbles; missed https://api.cadence.example/v2/me/likes/…; missed https://api.cadence.example/v2/me/likes/…; missed https://api.cadence.example/v2/live/friends; missed wss://together.cadence.example/socket?session=…; missed https://lyrics.cadence.example/v1/search?…; missed https://updates.cadence.example/stable/latest.json; false ${…}/live/friends; false ${…}?session=${…} |
| holdout2 | holdout2/music-player.bundled.asar | requests with an unknown URL shown | 1 | 0 | 1 |  |
| holdout2 | holdout2/music-player.bundled.asar | storage keys | 11 | 0 | 0 |  |
| holdout2 | holdout2/music-player.bundled.asar | storage read/write/delete | 10 | 0 | 0 |  |
| holdout2 | holdout2/music-player.minified.asar | IPC channels | 12 | 8 | 0 | missed playlists:list; missed playlists:save; missed settings:get; missed settings:set; missed settings:changed; missed player:state-changed; missed player:state; missed mini:get-artwork |
| holdout2 | holdout2/music-player.minified.asar | IPC senders and receivers | 24 | 0 | 0 |  |
| holdout2 | holdout2/music-player.minified.asar | window settings | 7 | 5 | 0 | missed main.js contextIsolation=true; missed main.js nodeIntegration=false; missed main.js contextIsolation=true; missed main.js nodeIntegration=false; missed main.js sandbox=true |
| holdout2 | holdout2/music-player.minified.asar | bridge members | 5 | 17 | 0 | missed cadence.getTracks; missed cadence.addFolder; missed cadence.onScanProgress; missed cadence.listPlaylists; missed cadence.savePlaylist; missed cadence.exportPlaylist; missed cadence.reportState; missed cadence.onMediaKey; missed cadence.onCommand; missed cadence.fetchLyrics; missed cadence.toggleMiniPlayer; missed cadence.getSettings; missed cadence.updateSettings; missed cadence.onSettingsChanged; missed cadence.minimize; missed cadence.toggleMaximize; missed cadence.getVersion; 4 entries reported as unreadable |
| holdout2 | holdout2/music-player.minified.asar | bridge member channel | 3 | 2 | 0 | mini.onState: expected player:state, got null; mini.getArtwork: expected mini:get-artwork, got null |
| holdout2 | holdout2/music-player.minified.asar | endpoints | 1 | 9 | 2 | missed https://api.cadence.example/v2/me/recommendations; missed https://api.cadence.example/v2/artists/…; missed https://api.cadence.example/v2/scrobbles; missed https://api.cadence.example/v2/me/likes/…; missed https://api.cadence.example/v2/me/likes/…; missed https://api.cadence.example/v2/live/friends; missed wss://together.cadence.example/socket?session=…; missed https://lyrics.cadence.example/v1/search?…; missed https://updates.cadence.example/stable/latest.json; false ${…}/live/friends; false ${…}?session=${…} |
| holdout2 | holdout2/music-player.minified.asar | requests with an unknown URL shown | 1 | 0 | 1 |  |
| holdout2 | holdout2/music-player.minified.asar | storage keys | 11 | 0 | 0 |  |
| holdout2 | holdout2/music-player.minified.asar | storage read/write/delete | 10 | 0 | 0 |  |
