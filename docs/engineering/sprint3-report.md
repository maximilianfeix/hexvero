# Sprint 3 report: review everything, research, improve

Asked by the maintainer on 2026-10-18 ("mach ein ultra review und review alles nochmal finde bugs
etc mach deepsearch nach neuen features … und mach dir selber wieder ein perfketer 10h plan", then
"nimm mehrere agents und lass sie über hexvero deepsearch machen und dann sollst du alles was sie
sagen verbessern"). Plan: [sprint3-plan.md](sprint3-plan.md); time log:
[sprint3-status.md](sprint3-status.md). Same rules as sprints 1 and 2.

The cloud "ultra review" can only be started by the maintainer (`/code-review ultra`); the sprint
used seven background agents instead (§2).

## 1. Time

| Field     | Value                                                                                                                                                          |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| started   | 2026-10-18T06:55Z, base `88b092a` (npm 0.9.8)                                                                                                                  |
| pause     | 10:08–12:50Z (2 h 42 min): waiting for a quiet machine to run a release gate while other sessions held the load; no agent of this sprint ran. Added to the end |
| ten hours | 19:37Z                                                                                                                                                         |

## 2. What the reviews and research found

Seven agents ran first: review of the analysis core (612 random apps × 3 builds, three real apps,
23 hostile inputs), review of everything else (CLI, policy and SARIF, MCP, web UI, report escaping,
docs, release), and research on Electron's security features, on how 20 open-source apps write IPC,
on the first-time-user experience and on code health. The most important results, each turned
into an issue:

- **False values (#198):** a `let`/`var` value changed by `+=`, `++`, a pattern or `for…of` was
  read as certain; write detection existed about a dozen times with different gaps.
- **False rows:** bridge members written after `exposeInMainWorld` (#199), `webPreferences` keys
  written as strings read as "not written" in every version (#200), replaced `register(ipc)`
  methods (#201, #202).
- **Security:** MCP `hexvero_export` with `overwrite` could follow a dangling symlink out of its
  roots; `check` passed on an empty build; suggested commands were shell-injectable; output lines
  could be forged; the release workflow did not wait for e2e, the OS tests or the corpus.
- **First use:** a `.app` or release ZIP silently skipped the Electron layer (#195); `check` on a
  real app ended "not decidable" with a hint that could not help (#196); no way to create a policy
  (#197); a 6,064-word README; hexvero in none of five relevant searches.
- **Features:** the runtime (Electron/Chromium/Node), fuses and ASAR integrity can be read from the
  files; real apps write IPC in shapes hexvero did not read (generic forwarders, bridge objects from
  other modules, cross-module wrappers, `@electron/remote`).

## 3. Shipped

**0.9.9** (run 39129101973; the first release gated on the Windows and macOS tests, e2e and the
corpus):

- #204 packaged builds (`.app`, install directories, release ZIPs) read as the Electron app inside;
  `check` names what would decide an open rule and decides `new-external-host` when every computed
  value has a literal host (a `.replace` rewriting the host is unread); `hexvero init`.
- #205 writes never follow a symlink, the MCP policy re-checks at write time, stream outputs stay
  parseable, `check` refuses a build with nothing to read, suggested commands are quoted per shell,
  output cannot be forged, releases wait for every gate.
- #206 one write detection for every reader (#198 and five related cases).
- #207 bridge members after exposure, quoted and computed `webPreferences` keys, replaced methods.
- #194 (carried from sprint 2) HTTP request libraries called directly, instances with a base URL,
  `fetch(new Request)`.

**0.10.0** (run 39141419953):

- #214 the runtime of packaged builds: versions, fuses, ASAR integrity (with "covers the archive
  Electron loads"), support status from an offline snapshot, policy rule `fuse-weakened`. Found on
  the way: 0.9.9 picked `app/` before `app.asar`, Electron's order only before 15.0.0-beta.6; the
  pick now follows the version and fuse wire, verified against Electron's source.
- #215 IPC as real apps write it: generic forwarders and the page calls through them, bridge objects
  from other modules, cross-module wrappers, `@electron/remote` with policy rule `remote-enabled`.
- #218 caps that returned data as complete: call sites past 64, the per-file limitation list, cut
  files past 200.
- #213 README for a first-time user (1,663 words, 888 before the docs links), one positioning
  everywhere, docs fixes.

## 4. Second readers

Every analysis and security change had an independent reader; none passed in its first round. Most
needed two to four rounds. Recurring finds: a value guessed and read as known (a host rewritten by
`.replace`, a shadowed `[SB]` read as `sandbox: true`, an allow-list read from a check that does not
guard); a cap that cut data silently; a rule that reached readers it was not meant for; cost
blow-ups on hostile input. The automated security review flagged about two dozen points in
in-progress commits — unbounded loops, fail-open budgets, symlink and TOCTOU gaps, ReDoS in an HTML
reader — and each was fixed before merge. One feature (page scoping through HTML script tags) was
removed after three rounds of findings on its parser, in favour of a fail-safe rule.

## 5. Blind result (round 7, holdout8)

Written in the sprint by an independent author from eight open-source apps the sprint's own survey
had not used, kept unread, measured once at 15:39Z (`corpus/results/round7/README.md`):

| Class (hit/missed/false)  | 0.9.8    | 0.10.0   |
| ------------------------- | -------- | -------- |
| IPC senders and receivers | 223/50/0 | 239/34/0 |
| bridge members            | 133/0/10 | 133/0/0  |
| changes in contextBridge  | 3/0/0    | 3/0/3    |
| window settings           | 31/21/20 | 31/21/20 |
| endpoints                 | 11/17/0  | 11/17/0  |
| storage keys              | 27/21/0  | 27/21/0  |
| every other class         | same     | same     |

The three contextBridge changes scored false turned out, on inspection after the measurement, to
be a real allow-list rename the set's expectation counts only as a channel change (#221); the
blind table stays as measured. Endpoints and storage did not move on this set, and the window
settings are mostly an attribution difference (where a value is written vs which file creates the
window).

## 6. Development sets (not blind; never mix with §5)

- holdout7 (blind in sprint 2): IPC channels 23/52 → 52/52, bridge members 11/52 → 52/52 (#215).
- Every other set: no class worse, no new false row, at every merge.

## 7. Open

- Issues filed this sprint and still open: #208 (CLI outputs follow a symlinked parent), #210
  (literal-key reads through containers), #211 (recover's after-open check, verify through the MCP
  handler), #216/#217 (Electron 45 prereleases' package.json rule), #227 (a wrapper parameter
  hidden by a block declaration), #229 (page IPC rows reported removed when a bridge value is not
  read; also on 0.9.8). Closed in round 3 and 4: #209, #219, #225.
- Features researched, not built: protocols and their privileges, permission handlers, the
  update channel, sub-commands multiplexed on one channel, MessagePort
  RPC, SBOM and package diff, a GitHub Action with PR comments, folding duplicate rows in the
  change summary, progress on large apps.
- Maintainer decisions: a security advisory for the MCP export fix in 0.9.9; the GitHub repo
  description proposed in #213.

## 8. Rounds 3 and 4 (after 0.10.0)

Each change had a second reader; every one needed a second round.

- #224 generic forwarders: the allow-list is compared as a set, so reordering it is no change;
  minified ternary checks are read; a refused channel counts as refused only behind a check that
  exits first. #226 (#209): table keys are bound only inside their own loop, and a loop body ends
  where its statement ends. Both shipped in **0.10.1** (run 39145378897, 16:39Z; npx 0.10.1 demo,
  check exit 3, compare --report 33,302 bytes from an empty cache; Pages and the MCP registry on
  0.10.1).
- #228 (#219, #225, JS_SCAN_SCHEMA 33): the new bridge limitations name their files, so compare
  opens one-sided rows as unknown only there; a file-scoped limitation without a file applies to
  the whole app unless it is proven empty. A loop variable is no longer bound where a nearer
  declaration hides it. The reader RZ found three fail-open points (an unlocated module named the
  wrong file, "no file" read as "nowhere", lost rows for re-declared `var`); all were fixed before
  merge. Corpus observations 482/482 identical, the Fiddle compare byte-identical.
- #230 (JS_SCAN_SCHEMA 34), from the feature research: a `switches` collection
  (`app.commandLine.appendSwitch`/`appendArgument`, environment writes such as
  `ELECTRON_DISABLE_SECURITY_WARNINGS`, certificate-error handlers and verify procs that accept)
  and policy rule `new-unsafe-switch`. The dangerous list quotes its sources. A receiver not proven
  to be Electron's `app` gives a row with an unknown target, never none. The reader RV found a
  cost blow-up (34.5 s on a nested hostile file, now 83 ms), rows dropped for unknown receivers, a
  missing listener form and the certificate callback read by name; the automated security review
  then found four fail-open points (padding rows past the cap used up the budget and hid a later
  `no-sandbox`, an object-literal receiver gave no row, BigInt literals read as a definite answer,
  a value cut by the budget read as complete). All fixed before merge; RV's probes are tests. Real
  apps: Claude 8 rows (two with an unknown target), Discord 12, Electron Fiddle 0.
- **0.11.0** (#228, #230; run 39151553767, 17:57Z): the local release gate first failed on four
  deep-nesting policy tests that assumed `JSON.stringify` overflows the stack; on this machine's
  Node 25.2.1 it does not, while the 0.10.1 gate passed the same tests earlier on the same Node and
  the cause of that difference was not found. The parser still throws a typed error; the test now
  accepts either quote (#231, #232). npx 0.11.0 demo, check exit 3, compare --report 33,302 bytes
  from an empty cache; Pages on 0.11.0; the MCP registry publish failed once on a registry-side
  database error and passed on re-run.
- Second readers in rounds 3 and 4 again found a fail-open point in every change; none passed in
  its first round.

## 9. Metrics (same commands as before)

| Signal                   | End of sprint 2        | End of sprint 3                   |
| ------------------------ | ---------------------- | --------------------------------- |
| Stars / forks / watchers | 5 / 0 / 0              | 6 / 0 / 0                         |
| npm downloads, last week | 364 (2026-10-10 to 16) | 364 (the API had not rolled over) |

Views and clones are unchanged within the 14-day window; downloads include this project's CI.
