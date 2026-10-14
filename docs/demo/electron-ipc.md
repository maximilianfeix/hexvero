# Map an Electron app's IPC surface without running it

The demo at the top of the README, step by step. Everything here is the real output of hexvero
0.4.0 on the example application in `examples/`, which is written for this repository (MIT) and
safe to share.

| Input                           | SHA-256 prefix     | What it is                                                |
| ------------------------------- | ------------------ | --------------------------------------------------------- |
| `examples/notesdesk-1.4.0.asar` | `875c2bb7fb7eebcd` | a small notes app: main process, preload, renderer bundle |
| `examples/notesdesk-1.5.0.asar` | `03ee8043a8396b7d` | the next version, with listed changes                     |

## 1. First look

```bash
npx hexvero analyze examples/notesdesk-1.4.0.asar
```

One screen with the summary, the findings with the file and line they were read from, the lists
that exist and suggested next commands. On an Apple M2 this takes 0.18 to 0.29 s and about 85 MB
(three runs, `/usr/bin/time -l`). A filled dot is a fact read from the code, a hollow one an
inference from a pattern; settings are reported as written, never as assumed defaults.

## 2. Which channels exist, and who sends and who handles each

```bash
npx hexvero collection examples/notesdesk-1.4.0.asar ipcChannels
```

```text
  channel       senders     receivers
  app:quit      preload.js  main.js
  notes:list    preload.js  main.js
  …
```

`ipc` has every call site with its line; channels the scan could not read are named in the
limitations (`ipc_channel_unresolved`) instead of being left out silently.

## 3. What a page can call

```bash
npx hexvero collection examples/notesdesk-1.4.0.asar contextBridge
```

Each member of `window.notesdesk`, the channel it forwards to and the line in `preload.js`. A
member whose body could not be read is listed with `member: null` rather than dropped.

## 4. What changed in the next version

```bash
npx hexvero compare examples/notesdesk-1.4.0.asar examples/notesdesk-1.5.0.asar contextBridge
```

```text
contextBridge: 1 added, 1 removed, 0 changed, 5 unchanged · matched by api+member
  + notesdesk::checkUpdate
  - notesdesk::openInShell
```

`webPreferences` and `windows` compare the same way (`nodeIntegration: true → false`,
`sandbox: false → true` between these two versions).

## What this does not show

- It is static: a finding is what the code contains, not what the running app does.
- A channel name computed at run time cannot be named; it is listed as unresolved.
- On larger real apps it reads more slowly and misses more; measured numbers, including a blind
  test set and a comparison with REA, are in `docs/competitive/rea-scorecard.md`.

## Re-record

```bash
npm run build && vhs docs/demo/demo.tape   # writes demo.gif and analyze.png
```
