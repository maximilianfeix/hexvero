# Corpus

A small set of inputs whose correct analysis results are written down, so that a tool can be
measured instead of believed. The expected results come from the source code of each input, never
from a tool's output.

Everything here is MIT licensed and was written for this corpus. Nothing is taken from a real
product, so all of it can be redistributed.

## What is in it

| Set           | Purpose                                                                                                                     | Cases                                                                                                 |
| ------------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `dev/`        | written alongside hexvero and used to tune it                                                                               | an Electron app in three builds, a later version of it, a C program in two builds and a later version |
| `validation/` | written by someone with no access to hexvero's detectors or output; measured once untouched (round 1), then used for tuning | an Electron app in three builds, a later version, a C program in two builds                           |
| `holdout/`    | written the same way after the tuning on the other two sets; measured untouched                                             | see `holdout/README.md`                                                                               |
| `damaged/`    | corpus inputs cut or altered at fixed places                                                                                | six files                                                                                             |

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
node corpus/score.mjs corpus/results/hexvero.observations.json [--set dev|validation|holdout|damaged]
```

The observer knows nothing about the expectations; the scorer knows nothing about the tool. They
meet in a neutral observation format (see the top of `observe-hexvero.mjs`), so another tool can be
scored by writing an observer for it. The comparison with REA in `compare/` does that.

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

## Limits

The corpus is small: three Electron applications of a few hundred lines and three C programs. It
shows whether a tool reads these idioms correctly. It says nothing about speed or coverage on large
real applications, about formats other than Electron archives and Mach-O arm64 binaries, or about
obfuscated code. A perfect score here means the listed idioms are handled, not that a tool is
complete.
