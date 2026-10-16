# Round 4: blind measurement on `holdout5` (2026-10-17)

`corpus/holdout5/` (Tidemark, a release-notes editor, and a later version of it) was written by
an independent author under the access rules in its README (no analyzer source, no results, no
analyzer run). It was measured here once, by an evaluator who changed no analyzer code, with three
builds of hexvero and one frozen scorer:

- **base**: `841b6db`, hexvero 0.8.0 as released, the base of the 10-hour sprint;
- **integration**: `2aed845`, the sprint's integration commit (measured from `05954f1`, whose
  `packages/` is identical to `2aed845`);
- **final**: `baa84d5`, the integration branch `sprint/10h` frozen after the resolver DoS limits
  (measured from `d0c2c1f`, the merge of `sprint/10h` into the evaluation branch, whose
  `packages/` is identical to `baa84d5`).

Measured at 01:20 to 01:40 CEST on an Apple M2, macOS 26.5.2, Node v22.17.1.

## Inputs and scorer

Built by `node corpus/build.mjs` (esbuild 0.28.2, @electron/asar 4.3.1);
`node corpus/build.mjs --check` rebuilds them to the same bytes. SHA-256:

| Input                             | SHA-256                                                            |
| --------------------------------- | ------------------------------------------------------------------ |
| `holdout5/tidemark.plain.asar`    | `c41b3cb9a90a7223cad07c2a53645e70cde4dd9b20b27bf9bb89f34b4c0ad62d` |
| `holdout5/tidemark.bundled.asar`  | `b8ec50db53ab78eb5df06043be7cb66be52728505a63d343e3ef974e359ae24b` |
| `holdout5/tidemark.minified.asar` | `e3c8cee94b0ddf5d0b871c0afe22eb640d48355509220978693fbf472664aa1d` |
| `holdout5/tidemark-v2.plain.asar` | `c999a0c0d85732bbb5ba78f0074a1b44d53e2e21169d6ccc68c8b02f36e4f10e` |

The scorer was extended for the new fields of this set before any tool output on it was seen
(every change is listed under "Scoring" in `corpus/holdout5/README.md`), checked against an
oracle observation written from the expectations (every row all hit, nothing false) and against
the committed `hexvero.observations.json` (every row of the other sets unchanged), then committed
as `05954f1` and not touched again. Git blobs used for all three measurements:

| File                         | Blob                                       |
| ---------------------------- | ------------------------------------------ |
| `corpus/score.mjs`           | `f5df4bb49c7ade8ca8c802dc90927ade537355ad` |
| `corpus/cases.mjs`           | `a550c643e669a7c5efbc7da596179f3dfd59d4fa` |
| `corpus/observe-hexvero.mjs` | `db589059544268f23a89a27987f861a908aedc68` |

## Commands

```bash
# base: its own worktree and build; the observer of this branch loads its packages/core
git -C /Users/maximilian/hexvero worktree add --detach <scratch>/eval-base 841b6db
(cd <scratch>/eval-base && npm ci && npm run build)
node corpus/observe-hexvero.mjs --core <scratch>/eval-base/packages/core \
  --out corpus/results/round4/base-841b6db.observations.json

# integration (2aed845) and final (baa84d5): this worktree, built before each run
npm run build
node corpus/observe-hexvero.mjs --out corpus/results/round4/int-2aed845.observations.json
git merge --no-ff sprint/10h && npm run build
node corpus/observe-hexvero.mjs --out corpus/results/round4/final-baa84d5.observations.json

for n in base-841b6db int-2aed845 final-baa84d5; do
  node corpus/score.mjs corpus/results/round4/$n.observations.json --set holdout5 \
    --json corpus/results/round4/$n.json --markdown corpus/results/round4/$n.md
done
```

Raw results in this directory: `<run>.observations.json` (what hexvero reported, for the whole
corpus), `<run>.json` and `<run>.md` (scored, `holdout5` only, with a note for every miss and
false report).

## Tidemark, plain, bundled and minified

The three inputs are one application built three ways, not three applications. Totals over them,
as hit / missed / false:

| Class                                   | base 841b6db | integration 2aed845 | final baa84d5 |
| --------------------------------------- | ------------ | ------------------- | ------------- |
| IPC channels                            | 47 / 7 / 0   | 49 / 5 / 0          | 49 / 5 / 0    |
| IPC senders and receivers               | 60 / 34 / 0  | 62 / 36 / 0         | 62 / 36 / 0   |
| IPC channels with an unknown name shown | 3 / 0 / 0    | 3 / 0 / 0           | 3 / 0 / 0     |
| window settings                         | 14 / 25 / 0  | 14 / 25 / 0         | 14 / 25 / 0   |
| bridge members                          | 57 / 0 / 0   | 57 / 0 / 0          | 57 / 0 / 0    |
| bridge member channel                   | 51 / 6 / 0   | 51 / 6 / 0          | 51 / 6 / 0    |
| endpoints                               | 15 / 3 / 0   | 15 / 3 / 0          | 15 / 3 / 0    |
| endpoint method                         | 3 / 12 / 0   | 3 / 12 / 0          | 3 / 12 / 0    |
| requests with an unknown URL shown      | 3 / 0 / 3    | 3 / 0 / 3           | 3 / 0 / 3     |
| storage keys                            | 6 / 12 / 2   | 6 / 12 / 2          | 6 / 12 / 2    |
| storage read/write/delete               | 6 / 0 / 0    | 6 / 0 / 0           | 6 / 0 / 0     |

Per input (final; base differs only where marked):

| Class                                   | plain       | bundled     | minified                      |
| --------------------------------------- | ----------- | ----------- | ----------------------------- |
| IPC channels (of 18)                    | 15 / 3 / 0  | 17 / 1 / 0  | 17 / 1 / 0 (base: 15 / 3 / 0) |
| IPC senders and receivers               | 20 / 10 / 0 | 21 / 13 / 0 | 21 / 13 / 0 (base: 19 / 11)   |
| IPC channels with an unknown name shown | 1 / 0 / 0   | 1 / 0 / 0   | 1 / 0 / 0                     |
| window settings (of 13)                 | 3 / 10 / 0  | 3 / 10 / 0  | 8 / 5 / 0                     |
| bridge members (of 19)                  | 19 / 0 / 0  | 19 / 0 / 0  | 19 / 0 / 0                    |
| bridge member channel                   | 17 / 2 / 0  | 17 / 2 / 0  | 17 / 2 / 0                    |
| endpoints (of 6)                        | 5 / 1 / 0   | 5 / 1 / 0   | 5 / 1 / 0                     |
| endpoint method                         | 1 / 4 / 0   | 1 / 4 / 0   | 1 / 4 / 0                     |
| requests with an unknown URL shown      | 1 / 0 / 1   | 1 / 0 / 1   | 1 / 0 / 1                     |
| storage keys (of 6)                     | 1 / 5 / 2   | 4 / 2 / 0   | 1 / 5 / 0                     |
| storage read/write/delete               | 1 / 0 / 0   | 4 / 0 / 0   | 1 / 0 / 0                     |

## Tidemark v2, and the changes from v1

`tidemark-v2.plain.asar` on its own, identical in all three builds of hexvero: IPC channels
14 / 4 / 0, senders and receivers 19 / 9 / 0, unknown-name channel 1 / 0 / 0, window settings
3 / 10 / 0, bridge members 19 / 0 / 0, bridge member channel 16 / 3 / 0, endpoints 6 / 1 / 0,
endpoint method 2 / 4 / 0, unknown URL 1 / 0 / 1, storage keys 1 / 5 / 2, storage operations
1 / 0 / 0.

The comparison plain v1 to plain v2, identical in all three builds:

| Changes in      | Expected                                                                     | Hit / missed / false | Missed                                         |
| --------------- | ---------------------------------------------------------------------------- | -------------------- | ---------------------------------------------- |
| ipcChannels     | +`release:duplicate` +`export:text` −`release:delete` −`editor:dirty`        | 3 / 1 / 0            | +`export:text`                                 |
| contextBridge   | +`duplicateRelease` +`exportText` −`deleteRelease` −`markDirty`              | 4 / 0 / 0            |                                                |
| webPreferences  | ~`webSecurity: false -> true` (editor), ~`sandbox: true -> false` (preview) | 0 / 2 / 0            | both                                           |
| endpoints       | +`https://api.lingoflow.example/v1/translate`                                | 1 / 0 / 0            |                                                |
| storage         | none                                                                         | 0 / 0 / 0            |                                                |

`unchangedMoves` (27 entries: the cut-and-pasted `preview:ping` listener, the settings handlers
moved to the top, `platform` moved to the end of the bridge object, `applyFontSize` moved, the
literal `preview:render` replaced by its constant, and line shifts): none of them is reported as
an added, removed or changed item in any class, and none of the `changes.*.absent` entries is
either. hexvero lists 12 bridge members and 1 endpoint as relocated. This is partly real and
partly empty: the moves of the bridge members, channels and the endpoint are facts hexvero reads,
so not reporting them is a correct answer; the moves of the window creations and of the
registrations inside `main/handlers.js` concern facts it does not read at all in the plain build
(see below), so their silence says nothing.

## Reading

**Nothing the sprint changed shows on this set, except two channels in the minified build.**
Between `841b6db` and `baa84d5` the only difference on Tidemark is `export:markdown` and
`export:html` found in the minified build (as in the bundled build at every commit), which also
adds two receivers to check and miss. The resolver DoS limits of `baa84d5` changed nothing here.
The registry evaluation of `2aed845` reads channels built by a registry function; Tidemark builds
its channels from a frozen constants object, a template helper in a loop and a wrapper class, and
those idioms are read no better than before.

**What is missed, by cause (from the notes in `final-baa84d5.md`):**

- **The wrapper class around `ipcMain`.** No receiver of a channel attached through
  `IpcRouter.handle` / `.on` in `main/handlers.js` is found in any build: the channels are listed
  only because the preload sends on them. That is 10 to 13 of the missed receivers per input, and
  the `ipcMain.handle(channel)` / `ipcMain.on(channel)` inside the class are listed as calls
  without a channel instead. `publish:progress`, sent from `main/publish.js` on a webContents
  passed in as a parameter, has no sender.
- **Channels from `exportChannel(format)` across modules.** In the plain builds `export:markdown`,
  `export:html` and `export:json` (and `export:text` in v2) are not read, and the bridge members
  `exportMarkdown` / `exportHtml` (and `exportText`) have no channel in any build, even where the
  bundled build lists the channel. `export:json` (a receiver only, registered in the loop) is
  missed everywhere. This is also the trap of v2: `export:text` is added by editing only the
  literal array in `shared/channels.js`, and the comparison misses it.
- **Window options from `Object.assign({}, BASE_PREFS, …)` and from a class field.** In the plain
  and bundled builds only the help window's literal is read (3 of 13); the editor and preview
  windows carry the limitation `window_options_unresolved`. The minified build reads the editor
  window (8 of 13), so the gap is in following the binding, not in the idiom as such. Because the
  settings are not read, both expected window-setting changes of v2 are missed.
- **Endpoints.** `fetch(new Request(TELEMETRY_URL, { method: "POST" }))` with
  `TELEMETRY_URL = new URL("/v1/events", origin).href` is not read; it is counted as a request
  with an unknown URL instead, which is the one false in that row. Only explicit `method: "POST"`
  is given; a `fetch` without options is not reported as GET (4 of 5 method checks missed per
  input).
- **Storage.** The two JSON files in `userData` (kind `file`) are not reported in any build. The
  keys built by the helper `` `${PREFIX}${name}` `` are reported as `tidemark.${…}` in the plain
  build (two false reports, since the names come from constants passed to the helper) and not at
  all in the minified build; only the bundled build resolves them (3 of 3).

**What holds:** every bridge member in every build, with the right channel wherever a literal or
`CHANNELS.X` is passed; no false channel, no false bridge member, no false endpoint, no false
window setting; the run-time channel is not given an invented name (`TIDEMARK_DIAG_CHANNEL` is
not reported), and its sender `ipcRenderer.send(channel, …)` in `preload.js` is among the calls
shown without a channel; the bridge and endpoint changes of v2 are all right, and nothing that
only moved is reported as a change.

**Limits of this reading.** The row *IPC channels with an unknown name shown* only asks whether
the tool shows any call without a channel. hexvero shows six (seven in v2), of which one is the
run-time channel and the others are the wrapper class, the curried preload helper and, in the
bundles, a `webContents.send` on a parameter; the row would be hit by those alone. The places in
the notes print as `undefined:<line>` because the observer reads a `file` field the `ipc` rows do
not have; this affects the notes only, not any count, and was left as it was so that all three
runs use the same observer. `interfaceLinks` (and so `ends[].entryFile`) is not scored, as in
holdout3 and holdout4, so the sprint's interface work (C4) is not measured by this round.

This was the first and only blind measurement on `holdout5`. Its results are now known, so from
here on it is a development set like the others; a new set is needed for the next blind
measurement. Its rows are not yet in the committed gate baseline (`corpus/results/hexvero.*`).
