# What changed in the interface between two builds

**Question:** between the previous release and this one, which IPC channels, preload members,
window settings, endpoints and storage keys appeared, disappeared or changed?

**Input:** the two builds' `app.asar` files (or directories). Neither is run.

```console
$ hexvero compare examples/notesdesk-1.4.0.asar examples/notesdesk-1.5.0.asar
13 shared collection(s), 11 with differences
  collection      added  removed  changed  unchanged
  --------------  -----  -------  -------  ---------
  findings        4      6        0        1
  modules         0      0        3        1
  edges           0      0        0        1
  externals       0      0        0        3
  ipcChannels     1      1        0        5
  webPreferences  0      0        2        2
  windows         0      0        1        0
  contextBridge   1      1        0        5
  interfaces      1      1        0        5
  ipc             2      2        0        11
  endpoints       1      0        0        2
  storage         1      0        0        1
  urls            1      0        0        2
  window settings that changed what pages may do (to review):
      main.js::win nodeIntegrationInEffect: on → off (less permissive)
      main.js::win sandboxInEffect: off → on (less permissive)
  details: hexvero compare <a> <b> interfaces
```

Then one collection at a time:

```console
$ hexvero compare examples/notesdesk-1.4.0.asar examples/notesdesk-1.5.0.asar interfaces
interfaces: 1 added, 1 removed, 0 changed, 5 unchanged · matched by file+api+member
  + preload.js::notesdesk::checkUpdate
  - preload.js::notesdesk::openInShell

$ hexvero compare examples/notesdesk-1.4.0.asar examples/notesdesk-1.5.0.asar endpoints
endpoints: 1 added, 0 removed, 0 changed, 2 unchanged · matched by file+kind+value
  + main.js::fetch::https://updates.notesdesk.example/latest.json
```

To find the exact place a change comes from, page the collection on the build that has it:
`hexvero collection examples/notesdesk-1.5.0.asar interfaces` gives the preload line and the
main-process handler with its line.

## What each verdict means

| Verdict     | Meaning                                                                                                                                                                      |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `added`     | On the new side only, and the old side read the file it would be in and compared its whole list.                                                                             |
| `removed`   | The same, the other way round.                                                                                                                                               |
| `changed`   | Matched by identity on both sides, with different content. The field paths that differ are listed.                                                                           |
| `relocated` | Matched, and only a position differs: a source line, or an address in a native binary. `--strict` counts these as changes.                                                   |
| `unknown`   | On one side only, but the other side did not read that file, read the app only in part, or was cut at 2,000 items. It is neither added nor removed, and the reason is given. |

The window-settings block lists derived settings whose change alters what a page may do (Node
integration, context isolation, sandbox, `require` in the page). It is a list of facts to review,
not a security verdict: whether a change matters depends on what the window loads.

## In CI

`--json` prints the same result as data:

```console
$ hexvero compare old/app.asar new/app.asar --json > interface-diff.json
$ hexvero compare old/app.asar new/app.asar interfaces --json > interfaces.json
```

The overview's JSON has `collections` (counts per collection), `windowChanges` and
`partialScan`. A collection's JSON has `added`, `removed`, `unknown`, `changed`, `complete` and
`limitations`. `compare` exits 0 whatever it finds. A gate, for example "fail when
`windowChanges` has a more permissive entry", is a choice your pipeline makes from the JSON, and
it stays visible in your workflow file.
