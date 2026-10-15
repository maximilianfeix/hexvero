# Electron interface map

**Question:** what can a page in this Electron app call, and which main-process code answers?

**Input:** an `app.asar`, an unpacked app directory or a single bundle. Nothing is run.

```console
$ hexvero collection examples/notesdesk-1.4.0.asar interfaces
interfaces 1-6 of 6
  api        member       world  file        line  windows      channel       direction  ends               link
  ---------  -----------  -----  ----------  ----  -----------  ------------  ---------  -----------------  ------
  notesdesk  getSetting   main   preload.js  4     main.js:win  settings:get  to-main    main.js:25 handle  direct
  notesdesk  setSetting   main   preload.js  5     main.js:win  settings:set  to-main    main.js:26 handle  direct
  notesdesk  listNotes    main   preload.js  6     main.js:win  notes:list    to-main    main.js:27 handle  direct
  notesdesk  saveNote     main   preload.js  7     main.js:win  notes:save    to-main    main.js:28 handle  direct
  notesdesk  quit         main   preload.js  8     main.js:win  app:quit      to-main    main.js:29 on      direct
  notesdesk  openInShell  main   preload.js  9     main.js:win  shell:open    to-main    main.js:30 on      direct
```

Each row reads from left to right along the path a call takes:

1. **`api` and `member`**: what the page sees, `window.notesdesk.openInShell`.
2. **`file` and `line`**: where the preload exposes it (`contextBridge.exposeInMainWorld`).
3. **`windows`**: which windows load that preload, by the variable the window is assigned to.
4. **`channel`**: the IPC channel the member forwards to.
5. **`ends`**: the main-process calls on that channel, with file, line and API
   (`ipcMain.handle`, `ipcMain.on`, `webContents.send`).
6. **`link`**: how well the join holds.

| `link`       | Meaning                                                                                                              |
| ------------ | -------------------------------------------------------------------------------------------------------------------- |
| `direct`     | Every end names the channel as a literal.                                                                            |
| `resolved`   | An end was reached through a constant, an alias, a wrapper function or the resolver; `ends[].via` says which.        |
| `unresolved` | The member's own channel could not be read. It may not use IPC at all.                                               |
| `unknown`    | No end was found, but the analysis has blind spots, named in `reason` (an unread file, a channel built at run time). |
| `none`       | No end was found in an analysis that read every file and every channel.                                              |

Rows are joined on exact names: a window's resolved `preload` path and a channel string, compared
character for character. Two channels that merely look alike are never linked. When a link can't
be established, the row says why instead of guessing.

## Through an agent

The same rows come back from `hexvero_collection {targetId, collection: "interfaces"}`, paged and
size-capped like every other collection.

## Limits

- Channels generated at run time (some apps build every channel name from a UUID and a method
  name) can't be read statically. Those rows stay `unresolved` or `unknown`.
- A member that calls a helper in another module, which then calls `ipcRenderer`, is followed
  only as far as the resolver follows names; past that, its channel is null.
- The map describes code, not run-time behaviour. A handler that exists may never be registered
  on some code path.

Accuracy on the corpus (development sets, not blind) is in
[`docs/engineering/8h-mission-progress.md`](../engineering/8h-mission-progress.md#phase-3-electron-interface-map-0715-0735).
