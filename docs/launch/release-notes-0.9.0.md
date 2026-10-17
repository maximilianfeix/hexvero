# hexvero 0.9.0: know what changed inside your Electron release

0.8.0 compared two builds and wrote a Markdown report. 0.9.0 makes that comparison something you
can rely on in a review and gate a release on: it compares whole lists, keeps "could not tell"
apart from "removed", shows the lines of both builds, and turns the same comparison into a
policy check for CI with SARIF output. Every example below is real output on the two example
builds (`npx hexvero demo`); the sources and commands are in [claims.md](claims.md).

```bash
npx hexvero@0.9.0 demo
npx hexvero@0.9.0 compare hexvero-demo/notesdesk-1.4.0.asar hexvero-demo/notesdesk-1.5.0.asar --report report.html
npx hexvero@0.9.0 check hexvero-demo/notesdesk-1.4.0.asar hexvero-demo/notesdesk-1.5.0.asar --policy hexvero-demo/policy.json
```

## What changed, before and after

| Area                  | 0.8.0                                                                                                                                                     | 0.9.0                                                                                                                                                                            |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Compare completeness  | compared the first 2,000 items per side; a change behind item 2,000 was invisible                                                                         | whole lists up to 200,000 items / 256 MiB per side, and a `completeness` record per list (compared, total, gaps) that the report and the UI print                                |
| Unknown vs removed    | `- shell:open` (removed) in the demo, although 1.5.0 builds channel names at run time next to it                                                          | `? shell:open … the other side has values there that could not be resolved`: unknown, not removed. Same for unread files, computed window settings, URLs with `${…}`             |
| Before/after evidence | one place per change (the side it was found on)                                                                                                           | changed rows carry the before place (`whereBefore`); the UI evidence panel and the HTML report show the lines of both builds side by side (`main.js:8`, lines 5–11 of 34 / 37)   |
| Release gate          | none: `hexvero check` was an unknown command                                                                                                              | `hexvero check <before> <after> --policy <file>`: three rules, exit 0/1/2/3/4, baselines, suppressions with expiry, text/JSON/Markdown/SARIF 2.1.0; GitHub Actions in docs/ci.md |
| MCP                   | 15 tools, `tools/list` 14,156 bytes                                                                                                                       | 16 tools with `hexvero_check`, `tools/list` 15,637 bytes; `hexvero_compare` pages one list at a time (breaking, below)                                                           |
| Report                | Markdown only                                                                                                                                             | `--report report.html`: one offline page (33,298 bytes for the example), strict CSP, target text escaped, invisible characters written out; Markdown unchanged in shape          |
| Interface map         | the `interfaces` list as a table                                                                                                                          | Interface map tab: window → preload member → channel → handler, each link marked literal / resolved / not read with the reason                                                   |
| Registry channels     | `defineChannels("board", ["list", …])` produced no channel                                                                                                | read by a bounded abstract evaluation (`via: "resolved"`, `method: "evaluated"`); where it stops, the call keeps no channel and says why                                         |
| IPC wrapper classes   | handlers registered through `ipcMainManager.handle(IpcEvents.X, fn)` had no channel; Electron Fiddle: 0 of 46 bridge members linked to a main-process end | a method that passes its parameter on as the channel is a wrapper; each call on an instance is an IPC row (`via: "wrapper"`); Fiddle 0.38.0 and 0.39.0: 45 of 46 linked          |
| Unpacked ASAR         | `app.asar.unpacked/` not read; reported as "too large or could not be decoded"                                                                            | read from `<archive>.unpacked/`, confined like a directory; a missing directory is named as such                                                                                 |
| Report noise          | Electron Fiddle 0.38.0 → 0.39.0: 52 interface rows "changed" only in their `reason` text, 6 findings re-titled                                            | a row whose only difference is `reason` is unchanged; findings match by kind and location                                                                                        |

## Security fixes from the independent review

An independent review of the sprint (841b6db..f8ffe2d) found 4 high, 6 medium and 11 low issues;
all are fixed in this release with regression tests:

- **Resolver:** a regular expression bypass of the ReDoS guard (H1); expressions with effects in
  initializers that were not read could produce wrong channels (H2); `var` in blocks, block
  `const` leaking, key order, `async`/generator functions (M1–M3, M6).
- **Policy check:** a new or renamed permissive window passed (H3); a target that is not a
  JavaScript app passed (H4); a renamed file made an old host or member "new" (M4); SARIF URIs
  could resolve onto repository files (M5, now `hexvero-build/<side>/<archive>/…` with base
  `file:///`).
- **MCP:** `hexvero_check` `policyPath` could read any path and echo it (L8); now confined to the
  allowed roots, `.json` only, never quoted.
- **File reads:** one descriptor that refuses non-regular files, `O_NOFOLLOW` and a same-inode
  check after open, so a FIFO cannot block an analysis and a swapped link cannot lead out of the
  root (L10).

## Breaking change

`hexvero_compare` (MCP) pages one list at a time. Pass `list` (`added`, `removed`, `changed`,
`unknown`) with `offset`; an `offset` without `list` is refused:

```text
invalid_input: offset needs list (added, removed, changed or unknown): each list has its own next
```

Before, one offset was applied to four lists of different lengths and returned wrong pages.

## Measured, with the method

| What                                      | Number                                                                                                                                               | Method                                                                                                                                                             |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Newest blind set `holdout5`               | IPC channels 49 of 54, none false (0.8.0: 47); bridge members 57 of 57; endpoints 15 of 18; window settings 14 of 39; storage keys 6 of 18 (2 false) | one app in three builds, independent author, measured once (round 4), `corpus/results/round4/README.md`                                                            |
| Changes v1 → v2 on that set               | channels 3 of 4, bridge members 4 of 4, window settings 0 of 2, endpoints 1 of 1; nothing that only moved reported                                   | same round; 8 expected changes                                                                                                                                     |
| MCP session start                         | 17,847 bytes, 4,158 `o200k_base` tokens (`tools/list` 15,637 bytes)                                                                                  | `node scripts/context-cost.mjs`                                                                                                                                    |
| Example check                             | exit 3, two findings; exit 0 after `--update-baseline`                                                                                               | the commands above                                                                                                                                                 |
| holdout5 as a development set (not blind) | IPC channels 72/0/0, senders and receivers 131/9/0, window settings 17/35/0 (hit/missed/false, 4 inputs)                                             | `corpus/observe-hexvero.mjs` + `corpus/score.mjs --set holdout5` on `57d0ed4`; the set's misses were worked on after round 4, so do not compare with the blind row |
| Electron Fiddle bridge links              | 45 of 46 members with a channel linked to a main-process end in both builds (0.8.0: 0)                                                               | `scripts/case-study/bridge-links.mjs` on the two release archives; case study, "IPC wrapper classes: before and after"                                             |
| Speed cost                                | Discord `analyze` median +7 to +8 % (771 → 825 ms; re-run 812 → 879 ms); Claude.app within run-to-run noise                                          | interleaved, 7 fresh runs per side against npm `hexvero@0.8.0`, Apple M2, other agents running (load 10–19)                                                        |

The blind holdout5 numbers were measured once, on the frozen integration build `baa84d5`. The
wrapper-class work and the review fixes came after; their effect on holdout5 is the
development-set row, which is not a blind result and must not be quoted as one.

## Known limits

- Static only: a finding is what the code contains, not what it does; a passing check means
  nothing new against the policy in what was read, not that the app is safe.
- Window settings built through `Object.assign({}, BASE, …)` across a binding or a class field
  are still missed (holdout5 development set: 17 of 52 settings), so both expected window-setting
  changes of that set are missed; bridge members whose channel comes from a helper in another
  module still have no channel (67 of 76).
- IPC argument shapes are not compared: a new field in an existing channel's payload is not a
  change (Electron Fiddle M1).
- Storage keys passed through a wrapper or an enum are listed as unreadable, so a new one is not
  shown as added (Fiddle M2).
- The Fiddle case study was measured with 0.8.0; with 0.9.0 only the bridge links were re-run
  (45 of 46). The noise fixes and unpacked-file reading were not re-checked on Fiddle.
- `hexvero check` has three rules. It does not rate severity and does not look for
  vulnerabilities.
