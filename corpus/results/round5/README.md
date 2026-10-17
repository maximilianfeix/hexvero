# Round 5: blind measurement of `holdout6`

`holdout6` (Snapdeck, a screenshot annotator: three builds of v1 and a v2) was written by an
independent author who read no hexvero code, output or results (see `corpus/holdout6/README.md`).
It was measured **once**, on 2026-10-17 at 14:58Z, before anything was changed in response:

- `final-7f38b14`: the code of `sprint/round3` at `7f38b14` (0.9.1 plus round three of the sprint)
- `v0.8.0`, `v0.9.0`, `v0.9.1`: the published packages from npm, measured with this branch's
  observer (`--core <registry install>/node_modules/@hexvero/core`)

```bash
node corpus/observe-hexvero.mjs --out corpus/results/round5/final-7f38b14.observations.json
node corpus/observe-hexvero.mjs --core <dir>/node_modules/@hexvero/core --out corpus/results/round5/v<x>.observations.json
node corpus/score.mjs corpus/results/round5/<run>.observations.json --set holdout6 --json … --markdown …
```

## Blind result, totals over the three builds of v1 and the v1 → v2 comparison

hit / missed / false:

| Class                              | 0.8.0    | 0.9.0    | 0.9.1     | final `7f38b14` |
| ---------------------------------- | -------- | -------- | --------- | --------------- |
| IPC channels                       | 52/12/0  | 52/12/0  | 52/12/0   | 52/12/0         |
| IPC senders and receivers          | 83/29/0  | 89/23/0  | 89/23/0   | 89/23/0         |
| window settings                    | 24/28/2  | 38/14/3  | 44/8/15   | 44/8/15         |
| bridge members                     | 60/20/0  | 60/20/0  | 60/20/0   | 60/20/0         |
| bridge member channel              | 60/0/0   | 60/0/0   | 60/0/0    | 60/0/0          |
| endpoints                          | 15/6/4   | 16/5/4   | 16/5/4    | 16/5/4          |
| endpoint method                    | 5/10/0   | 5/11/0   | 5/11/0    | 5/11/0          |
| requests with an unknown URL shown | 4/0/1    | 4/0/1    | 4/0/1     | 4/0/1           |
| storage keys                       | 14/27/0  | 18/23/0  | 18/23/0   | 22/19/0         |
| storage read/write/delete          | 14/0/0   | 18/0/0   | 18/0/0    | 22/0/0          |
| changes in ipcChannels             | 4/0/0    | 4/0/0    | 4/0/0     | 4/0/0           |
| changes in contextBridge           | 3/0/0    | 3/0/0    | 3/0/0     | 3/0/0           |
| changes in webPreferences          | 0/1/6    | 1/0/5    | 1/0/1     | 1/0/1           |
| changes in endpoints               | 1/0/0    | 1/0/0    | 1/0/0     | 1/0/0           |
| changes in storage                 | 0/1/1    | 0/1/1    | 0/1/1     | 0/1/1           |

## What the 15 false window settings are

Every row hexvero assigned to a window was right (library `sandbox: true`, annotator
`sandbox: false` over the defaults, overlay `webSecurity: false`). The false rows are the literals
as written in `main/windows.js` (`SECURE_DEFAULTS` lines 10–12 and the `{ sandbox: false }`
override on line 48) listed a second time **without a window**, next to the rows the evaluation of
the helper had assigned. The overlay window spreads `display.bounds` first, so not every window's
options counted as known, and windowless rows were kept. The observation format carries no window,
so each copy counts once more against an exhaustive class. A reader of hexvero saw the same line
twice in `webPreferences`, once with no window.

## After the measurement (development set from here on)

Changed in response, on `sprint/round3`: a windowless row is dropped when the evaluation has given
the same line (key, value) to a window (`packages/core/src/javascript/app.ts`, test "a placed
literal is listed once"). Re-scored, `holdout6` is now a **development set**: window settings
44/8/0, changes in webPreferences 1/0/0; nothing else moved, and `holdout5` is unchanged (window
settings 32/20/0). Never quote these instead of, or mixed with, the blind table above.
