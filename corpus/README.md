# Corpus

A small set of inputs whose correct analysis results are written down, so that a tool can be
measured instead of believed. The expected results come from the source code of each input, never
from a tool's output.

Everything here is MIT licensed and was written for this corpus. Nothing is taken from a real
product, so all of it can be redistributed.

## What is in it

| Set           | Purpose                                                                                                                     | Cases                                                                                                                                                                          |
| ------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `dev/`        | written alongside hexvero and used to tune it                                                                               | an Electron app in three builds, a later version of it, a C program in two builds and a later version                                                                          |
| `validation/` | written by someone with no access to hexvero's detectors or output; measured once untouched (round 1), then used for tuning | an Electron app in three builds, a later version, a C program in two builds                                                                                                    |
| `holdout/`    | written the same way after the tuning on the other two sets; measured untouched                                             | an Electron app in three builds (Punchclock, a time tracker), a later version, a C program in two builds; see `holdout/README.md`                                              |
| `holdout2/`   | written after `holdout/`, without access to any tool's detectors, source code or output                                     | two Electron apps in three builds each (Cadence, a music player, in `tsc`-style CommonJS; Inkwell, a markdown editor), a later version of the editor; see `holdout2/README.md` |
| `holdout3/`   | written after `holdout2/` the same way                                                                                      | an Electron app (Driftwood, a podcast player, with interface links), a later version; see `holdout3/README.md`                                                                 |
| `holdout4/`   | written after `holdout3/` the same way                                                                                      | an Electron app in three builds (Lattice, a kanban board, with a `BrowserView` and an offscreen window), a later version; see `holdout4/README.md`                             |
| `holdout6/`   | written after `holdout5/` by an author without access to any tool's detectors, source code or output; measured once, blind | an Electron app in three builds (Snapdeck, a screenshot annotator, with a route table and a TypeScript-style storage enum), a later version; see `holdout6/README.md` |
| `damaged/`    | corpus inputs cut or altered at fixed places                                                                                | six files                                                                                                                                                                      |

Each hold-out README lists what its author read outside the set and what was verified, and how.
Native programs are in `dev/`, `validation/` and `holdout/` only.

Each Electron case is built three ways from the same sources: packed as written (`plain`), bundled
by esbuild (`bundled`), and bundled and minified (`minified`). The facts are the same in all three;
what differs is how hard they are to read. A later version (`-v2`) is the first version with a
listed set of edits (`changes.json`) plus comment lines in front of every file, so everything the
edits do not touch moves to another line without changing.

The classes of finding that are checked:

- IPC channels, and for each one which file sends and which receives. Cases include other names
  for `ipcMain` and `ipcRenderer`, channel names from constants and from other modules, the same
  name used twice, helper functions that pass the channel on, handlers registered from a table,
  and look-alikes that are not IPC: comments, strings, unrelated objects, unused constants, names
  computed at run time.
- Window settings per window, including options built in a variable, spread from a base object or
  returned by a helper, and an unrelated object with the same keys.
- contextBridge members and the channel each forwards to.
- Network endpoints (fully known, partly known, and calls whose address is unknown), with
  look-alikes: URLs that are only displayed, routes of a server-side router, cache lookups.
- Storage keys with what is done to them.
- Differences between two builds: what was added, removed and changed, and that nothing else is
  reported for items that merely moved.
- Native programs: imports, functions, whether a call path exists (including paths that run
  through tail calls and paths that do not exist), and direct callers (including a function nobody
  calls and one reached only through a pointer).
- Damaged inputs: the tool must end in time without crashing, and either refuse with a structured
  error or say what is missing. A result that looks complete is wrong.

## How the expectations were written

Each `expected*.json` has a `method` saying how its facts were established and a `why` for every
item. For native programs, which calls are jumps was read from the system disassembler
(`otool -tV`) and imports from `nm -u`, not from an engine under test.

`present` lists what the program does; `absent` lists look-alikes that must not be reported. Where
a class is marked `exhaustive`, anything reported beyond `present` counts as false. Expectations
describe the program, not what a tool can be expected to find: a request made through a function
parameter is a request, even if no static reader can know it.

Three expectations of the `dev` set were corrected after the first run, each against a fact of the
binary rather than against a tool: at `-O0` the import is the fortified `___snprintf_chk`, a new
import also appears as an undefined symbol, and a function reached through a pointer may be
reported with its indirect caller.

## Inputs, toolchains and hashes

`node corpus/build.mjs` builds every input into `built/` and writes `built/SHA256SUMS`, the full
SHA-256 of each file. `node corpus/build.mjs --check` rebuilds the JavaScript inputs and fails if
one differs from the committed file.

| Part                   | Tool           | Version                                       |
| ---------------------- | -------------- | --------------------------------------------- |
| Bundling and minifying | esbuild        | 0.28.2, exact, from `package.json`            |
| Packing                | @electron/asar | 4.3.1, exact, from `package.json`             |
| Native programs        | Apple clang    | 17.0.0 (clang-1700.3.19.1), arm64, macOS 26.5 |

File times are set to a fixed date before packing, so an archive depends on its content alone.
Native binaries are built only with `--native` and only when the binary does not exist: two builds
of the same source differ in a few bytes, and another compiler version may emit different code.
The committed binaries are the ones the expectations were checked against.

## Measuring a tool

```bash
npm run build
node corpus/observe-hexvero.mjs            # what hexvero reports, written to results/
node corpus/score.mjs corpus/results/hexvero.observations.json [--set dev|validation|holdout|holdout2|holdout3|holdout4|damaged]
```

The observer knows nothing about the expectations; the scorer knows nothing about the tool. They
meet in a neutral observation format (see the top of `observe-hexvero.mjs`), so another tool can be
scored by writing an observer for it. The comparison with REA in `compare/` does that.

Window settings are scored for the four keys every `expected.json` lists (`preload`,
`contextIsolation`, `nodeIntegration`, `sandbox`); a row a tool reports for another key is not
scored and its count is given in the notes. A row whose value is null, meaning the value is
computed at run time, claims no value and is likewise not scored, only counted in the notes.

Per class and input the scorer counts:

- **hit**: an expected item the tool reported
- **missed**: an expected item it did not report
- **false**: something it reported that the expectations rule out

Classes are never added up into one number. A missed channel and a missed storage key are
different failures, and a total would hide which one a tool has. For call paths there is a fourth
outcome, kept apart from both right and wrong: the path was not found, but the answer says the
graph may be incomplete.

## Keeping results honest

- `results/round1/` is hexvero on the `validation` set at commit `9d596ca`, before anything in that
  set had been looked at. After that the set was used to find general defect classes, so later
  results on it are no longer a blind measurement. `holdout/` was written afterwards for that
  reason.
- `results/hexvero.json` is the committed result of the current code. `node corpus/gate.mjs` (in
  CI, and `npm run corpus` locally) fails if any row gets worse. `npm run corpus:accept`
  regenerates it after a deliberate change.
- Engines are not ground truth either. Native rows are scored per engine, and a row for an engine
  that is not installed says NOT RUN instead of counting as passed.

## Results so far

hexvero, hit of expected (plus false reports), from `results/hexvero.json` and `results/round2/`.
The table covers `holdout/`; the rows for `holdout2/` to `holdout4/` are in `results/hexvero.md`:

| Class                                | dev      | validation | hold-out (blind)  |
| ------------------------------------ | -------- | ---------- | ----------------- |
| IPC channels                         | 18 of 18 | 51 of 51   | 41 of 72          |
| IPC senders and receivers            | 33 of 33 | 105 of 105 | 59 of 79          |
| Window settings                      | 21 of 21 | 21 of 21   | 12 of 33          |
| Bridge members                       | 18 of 18 | 39 of 39   | 60 of 69          |
| Bridge member channel                | 18 of 18 | 39 of 39   | 24 of 60          |
| Endpoints                            | 17 of 18 | 33 of 33   | 24 of 42, 5 false |
| Storage keys                         | 21 of 21 | 33 of 33   | 42 of 51          |
| Changes between builds, all lists    | 14 of 14 | 15 of 15   | 7 of 18, 2 false  |
| Native call paths, radare2 and rizin | 16 of 16 | 52 of 52   | 70 of 72          |
| Native direct callers                | 16 of 16 | 44 of 44   | 91 of 91, 1 false |
| Damaged inputs                       | 6 of 6   |            |                   |

The first two columns are sets the tool was tuned on; they show that the idioms in them are
handled and guard against regressions. Only the last column says how the tool does on code it was
not fitted to. The same blind measurement of the `validation` set, before it was used, is in
`results/round1/`: 39 of 51 IPC channels, 12 of 21 window settings, 30 of 39 bridge members, 26 of
33 endpoints with 5 false, and 52 of 52 native call paths.

What the hold-out misses have in common, as far as the scorer's notes show without tuning on them:
channels registered from a class, an array or a Map; channel names built from a prefix and a
literal or re-exported through an index module; window options assembled with `Object.assign`, a
config module or a class field; requests made through `new URL(…)` or a `Request` object.

REA 6.4.0 on the same corpus, with the harness and every mapping decision: `compare/`.

## Limits

The corpus is small: seven Electron applications of a few hundred to about a thousand lines of
JavaScript and three C programs. It
shows whether a tool reads these idioms correctly. It says nothing about speed or coverage on large
real applications, about formats other than Electron archives and Mach-O arm64 binaries, or about
obfuscated code. A perfect score here means the listed idioms are handled, not that a tool is
complete.
