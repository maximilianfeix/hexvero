# Accuracy and limits

How sure hexvero is, measured on apps with written-down answers, and what it cannot tell you.
Moved here from the README after 0.9.9; every number names the set and the date it was measured
on. The method is in [corpus/README.md](../corpus/README.md); every claim and the command behind
it is in [launch/claims.md](launch/claims.md).

## How sure is it?

- A filled dot (`●`) is read from the file, a hollow one (`○`) inferred from a pattern; endpoints say `literal` or `inferred`, interface rows `link direct`, `resolved` or `unresolved`. What could not be read is listed with its file and line, and an item in a file the other build did not read, or where it has a value that could not be resolved, is `unknown`, not removed.
- **Newest blind result** (`holdout6`, a screenshot annotator in three builds plus a later version, written by someone without access to hexvero, measured once on 2026-10-17): IPC channels 52 of 64 and storage keys 22 of 41 with none false, bridge members 60 of 80, endpoints 16 of 21 with 4 false, window settings 44 of 52 with 15 false (duplicate rows of literals that were right for their window, fixed after the measurement); of the changes to the later version, channels 4 of 4, bridge members 3 of 3, window settings 1 of 1 with 1 false, endpoints 1 of 1, storage 0 of 1 with 1 false. Details and every miss: [round 5](../corpus/results/round5/README.md). The set before it (`holdout5`, round 4): IPC channels 49 of 54, window settings 14 of 39 ([round 4](../corpus/results/round4/README.md)). Both are development sets from now on.
- **On a real app** (Electron Fiddle 0.38.0 → 0.39.0, checked against its source): 0.8.0 found no false change but missed four: a new field in an IPC payload, a new setting stored through the app's own wrapper, the request of a bundled CLI, and that CLI's file. 0.9.6 reports all four; Fiddle's handlers registered through its wrapper class (`ipcMainManager.handle`) are linked to their bridge members (45 of 46; 0.8.0: none). [Case study](case-studies/electron-fiddle-0.38.0-to-0.39.0.md).
- **Development sets** (not blind: their misses were worked on): `holdout5` IPC channels 72 of 72, window settings 32 of 52; `holdout6` window settings 44 of 52 with none false. Do not read these as the blind results above ([claims](launch/claims.md) N2, B2).

## What it cannot tell you

- It reads files and never runs the program, so a finding is what the code contains, not what it does at run time, and not whether anything is exploitable. A passing check means nothing new against the policy in what was read.
- It misses things, as the numbers above show. Absence from a list is weaker evidence than presence.
- Not executing the target is not a safety guarantee: parsing a hostile file still processes attacker-controlled bytes, within size, depth and time limits. Full list: [Limits](#limits) below.

<a id="limits"></a>

## Limits

- hexvero is static. It reads files and never observes a running program: a finding is what the code contains, not what it does at run time.
- On code it was not tuned on, it still misses things and can be wrong. On the newest blind set (`holdout6`, measured once on 2026-10-17) it found 52 of 64 IPC channels and 22 of 41 storage keys with none false, but 44 of 52 window settings with 15 false (duplicates, fixed since) and 16 of 21 endpoints with 4 false ([round 5](../corpus/results/round5/README.md)). On `holdout5` before it: 49 of 54 channels and 14 of 39 window settings ([round 4](../corpus/results/round4/README.md)). The set before it (`holdout4`, measured with 0.7.3) gave 12 of 57 channels and 36 of 48 settings with 4 wrong ([holdout4](../corpus/holdout4/README.md)). Absence from a list is weaker evidence than presence. What it saw but could not read is named in the limitations with file and line (`ipc_receiver_unresolved`, `ipc_channel_unresolved`, `webpreferences_computed`, `window_options_unresolved`).
- IPC channels are read from literals and constants, and, where those do not reach, by a bounded resolver: concatenation and templates, helper functions and class methods whose channel is bound at every readable call site, wrapper classes and objects whose method passes its parameter on as the channel (`ipcMainManager.handle(IpcEvents.X, fn)`, read at each call on an instance: `new`, a singleton exported to other modules, `this`, a chain, a parameter that receives one; also in webpack and esbuild bundles), routers that build names from a constructor argument, arrays, `Map`s and objects registered in loops or `forEach`, re-exports through index modules. A value it cannot write down exactly is left out, never guessed. Not followed: names defined in files that were not read, and values computed at run time.
- Window settings: ten `webPreferences` keys, where they are written, spread in, returned by a helper, merged with `Object.assign`, or taken from defaults and option factories in other modules (then `definedIn` names where). Navigation and new-window handlers are read (`navigationHandlers`, what a handler checks is not); Electron fuses, CSP and permission handlers are not checked, and nothing is rated by severity. The derived `windows` columns do not know the Electron version actually shipped or run-time changes.
- A JavaScript app is read 5,000 files at a time; until `--all` has run, every list covers the scanned part and says so.
- Following names costs time: a large Electron app takes 1.1 to 1.8 times as long as with 0.3.0 and about 25 to 30 % more memory (worker threads for 4 MiB of source or more), and up to 2.6 times as long with one thread ([measurements](benchmarks.md)).
- A channel name or URL computed at run time cannot be named statically; it is left out or shown as `${…}`.
- Call graphs depend on the engine's analysis; a function reached only through a pointer has no direct caller. Ghidra is verified on fixtures only.
- Very large single items are returned compacted with a marker; very large files above the per-file budget are listed as unread.
- `compare` is a per-collection diff: it does not line up renamed functions or match code by structure; a renamed window shows up as removed and added. It compares whole lists up to 200,000 items or 256 MiB per side and says when it did not. IPC argument shapes are not compared, so a new field in an existing channel's payload is not a change.
- `hexvero check` judges seven rules (new interface member, new external host, more permissive window, privileged object newly handed to pages, weakened fuse of a packaged build, @electron/remote newly enabled, a new dangerous command-line switch or accepted certificate errors); it is not a vulnerability scanner and a pass is not a security verdict.
- Native findings cite a collection (imports, symbols) rather than a file offset.
- Files above 512 MiB are read lazily only for ASAR archives; other formats that large are refused with `too_large`.
- No dynamic analysis, debugging, device access, firmware unpacking or packet capture: for those, see [REA](comparison.md#compared-with-rea).
