# Round 6: blind measurement of `holdout7`

`holdout7` (Padwright, a keypad configurator: three builds of v1 and a v2) was written in sprint 2
by an independent author who read no hexvero code, output or results (see
`corpus/holdout7/README.md`). Its branch stayed unmerged and unread during the sprint. It was
measured **once**, on 2026-10-18 at 06:22Z, before anything was changed in response:

- `v0.9.6`: the published package the sprint started from, measured with this branch's observer
  (`--core <registry install>/node_modules/@hexvero/core`)
- `v0.9.8`: this branch's own core, which is main at `045de0c` (release 0.9.8) plus the
  holdout7 files
- `i2-95b7fce`: the IPC branch `sprint2/i2-ipc-tables` (route lists, generated invokers,
  `register(ipc)`), reviewed but not yet merged at the time of the measurement

The SHA-256 sums of the four `corpus/built/holdout7/*.asar` files matched `corpus/built/SHA256SUMS`
before the measurement.

```bash
node corpus/observe-hexvero.mjs --out corpus/results/round6/v0.9.8.observations.json
node corpus/observe-hexvero.mjs --core <dir>/node_modules/@hexvero/core --out corpus/results/round6/v0.9.6.observations.json
node corpus/observe-hexvero.mjs --core ~/hexvero-s2-i2/packages/core --out corpus/results/round6/i2-95b7fce.observations.json
node corpus/score.mjs corpus/results/round6/<run>.observations.json --set holdout7 --json … --markdown …
```

## Blind result, totals over the three builds of v1 and the v1 → v2 comparison

hit / missed / false:

| Class                              | 0.9.6    | 0.9.8    | `i2-95b7fce` |
| ---------------------------------- | -------- | -------- | ------------ |
| IPC channels                       | 23/29/0  | 23/29/0  | 23/29/0      |
| IPC senders and receivers          | 34/12/0  | 34/12/0  | 34/12/0      |
| window settings                    | 32/8/2   | 32/8/2   | 32/8/2       |
| bridge members                     | 11/41/0  | 11/41/0  | 11/41/0      |
| bridge member channel              | 11/0/0   | 11/0/0   | 11/0/0       |
| endpoints                          | 17/4/0   | 17/4/0   | 17/4/0       |
| endpoint method                    | 13/4/0   | 13/4/0   | 13/4/0       |
| requests with an unknown URL shown | 4/0/4    | 4/0/4    | 4/0/4        |
| storage keys                       | 14/11/0  | 21/4/0   | 21/4/0       |
| storage read/write/delete          | 14/0/0   | 21/0/0   | 21/0/0       |
| changes in ipcChannels             | 3/1/0    | 3/1/0    | 3/1/0        |
| changes in contextBridge           | 1/1/0    | 1/1/0    | 1/1/0        |
| changes in webPreferences          | 1/0/1    | 1/0/1    | 1/0/1        |
| changes in endpoints               | 1/0/0    | 1/0/0    | 1/0/0        |
| changes in storage                 | 0/1/0    | 1/0/0    | 1/0/0        |

## Reading

- The sprint's releases move one class on this set: storage keys 14 → 21 found and 11 → 4
  missed, and the storage change between v1 and v2 is now found (0.9.8, storage wrappers of
  another module, #188). No class lost a hit and no false row was added.
- IPC and the bridge are the weak spot of this set: 29 of 52 channels and 41 of 52 bridge members
  are missed by every build measured. The IPC branch, which closed every IPC and bridge miss of
  the development set `holdout6`, changes nothing here, so the forms Padwright uses are not the
  ones it reads. That is the honest result of the development-set gains on IPC: they did not
  carry over to this blind set.
- The false rows (2 window settings, 4 requests with an unknown URL, 1 change in webPreferences)
  are the same in all three builds.

## After the measurement (development set from here on)

From now on `holdout7` is a development set. The misses above were not read before this file
was written. Never quote numbers re-scored after a change instead of, or mixed with, the blind
table above.
