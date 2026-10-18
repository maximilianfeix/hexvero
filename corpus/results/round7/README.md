# Round 7: blind measurement of `holdout8`

`holdout8` (Gristmill: three builds of v1 and a v2, 30 JavaScript files) was written in sprint 3
by an independent author who read no hexvero code, output or results and modelled its patterns on
eight open-source Electron apps the sprint's own survey had not used (see
`corpus/holdout8/README.md`). Its branch stayed unmerged and unread during the sprint. It was
measured **once**, on 2026-10-18 at 15:39Z, before anything was changed in response:

- `v0.9.8`: the published package the sprint started from, measured with this branch's observer
  (`--core <registry install>/node_modules/@hexvero/core`)
- `v0.10.0`: this branch's own core, which is main at `57adcb8` (release 0.10.0) plus the
  holdout8 files

The SHA-256 sums of the four `corpus/built/holdout8/*.asar` files matched `corpus/built/SHA256SUMS`
and the sums recorded when the author handed the set back.

```bash
node corpus/observe-hexvero.mjs --out corpus/results/round7/v0.10.0.observations.json
node corpus/observe-hexvero.mjs --core <dir>/node_modules/@hexvero/core --out corpus/results/round7/v0.9.8.observations.json
node corpus/score.mjs corpus/results/round7/<run>.observations.json --set holdout8 --json … --markdown …
```

The author also ran the set's own code in a stand-in harness (fake `electron`, `fs` and `fetch`)
to check its expectations; hexvero never runs analyzed code.

## Blind result, totals over the three builds of v1 and the v1 → v2 comparison

hit / missed / false:

| Class                              | 0.9.8     | 0.10.0    |
| ---------------------------------- | --------- | --------- |
| IPC channels                       | 136/0/0   | 136/0/0   |
| IPC senders and receivers          | 223/50/0  | 239/34/0  |
| window settings                    | 31/21/20  | 31/21/20  |
| bridge members                     | 133/0/10  | 133/0/0   |
| bridge member channel              | 133/0/0   | 133/0/0   |
| endpoints                          | 11/17/0   | 11/17/0   |
| endpoint method                    | 3/8/0     | 3/8/0     |
| requests with an unknown URL shown | 4/0/2     | 4/0/2     |
| storage keys                       | 27/21/0   | 27/21/0   |
| storage read/write/delete          | 22/5/0    | 22/5/0    |
| changes in ipcChannels             | 4/0/0     | 4/0/0     |
| changes in contextBridge           | 3/0/0     | 3/0/3     |
| changes in webPreferences          | 1/0/0     | 1/0/0     |
| changes in endpoints               | 1/1/0     | 1/1/0     |
| changes in storage                 | 2/1/0     | 2/1/0     |

## Reading

- Gains: senders and receivers 223 → 239 found, 50 → 34 missed; the 10 false bridge members of
  0.9.8 are gone. No other class gained.
- **A new false result in 0.10.0**: three changes in contextBridge, `~shopping.send`,
  `~shopping.request` and `~shopping.receive`, are reported as changed between v1 and v2 although
  those members did not change. They are generic forwarder members, the shape 0.10.0 newly reads
  (`forwards`, `guard`); most likely the detail recorded on them differs between the two builds and
  counts as a change. This is a regression of 0.10.0 on a blind set.
- Unchanged and large: 20 false and 21 missed window settings in both versions. Most of them are
  one attribution: hexvero names the file where a value is written (`config.js`), the set names the
  file that calls `new BrowserWindow` (`windows.js`, `app-window.js`; the set's README, "Format
  notes"). The same setting then counts once as false and once as missed.
- Endpoints (11 of 28) and storage keys (27 of 48) did not move: the sprint's request and storage
  work does not cover the forms this app uses.
- IPC channels were already all found by 0.9.8.

## After the measurement (development set from here on)

From now on `holdout8` is a development set. Nothing was changed before this file was written.
Never quote numbers re-scored after a change instead of, or mixed with, the blind table above.
