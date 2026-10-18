# Sprint 3 plan: ten hours on hexvero

Asked by the maintainer on 2026-10-18 ("mach ein ultra review und review alles nochmal finde bugs
etc mach deepsearch nach neuen features … und mach dir selber wieder ein perfketer 10h plan", then
"nimm mehrere agents und lass sie über hexvero deepsearch machen und dann sollst du alles was sie
sagen verbessern"). Same rules as sprints 1 and 2: working time counts, not wall time; every
analysis change gets an independent second reader before it ships; a blind set is measured once
and kept apart from development numbers; nothing is posted in the maintainer's name; no number is
made up; analyzed code is never executed; the good first issues #149–#153 stay with contributors.

The cloud "ultra review" (`/code-review ultra`) can only be started by the maintainer; this plan
starts from seven background agents instead (§1). Their full reports are summarized in the issues
and in the PRs that fix them.

## 1. What the background work found (2026-10-18, 06:55–07:30Z)

| Agent       | Scope                                                                                  | Top results                                                                                                                                                                                                                                                                          |
| ----------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| RA          | core analysis 0.9.6 → main, 612 random apps × 3 builds, 3 real apps, 23 hostile inputs | no crash, no unexplained lost row; **false rows**: tables changed through a passed function or `Object.assign(T[0])`, bridge members written after `exposeInMainWorld`, quoted/computed `webPreferences` keys read as "not written" (all versions), replaced `register(ipc)` methods |
| RB          | CLI, policy/SARIF, MCP, web, report escaping, docs, release                            | **security**: MCP export with `overwrite` follows a dangling symlink out of the roots; `check` passes on an empty build; suggested commands shell-injectable; line forging in `compare`; release does not wait for e2e/OS/corpus gates                                               |
| Code health | duplication, caps, tests, CI, supply chain                                             | write detection implemented ~12× — **confirmed false values** for `+=`, `++`, patterns, `for…of` (#198); caps that cut silently (limitations list 200, callSites 64, …); timing tests in ms; the 225 Dependabot alerts are corpus fixtures, not shipped                              |
| First user  | README, quickstart, real apps, peers, search                                           | a `.app`/zip silently skips the Electron layer; `check` on a real app ends exit 4 with a useless hint; 6,034-word README (peers 358–803); hexvero in none of 5 searches                                                                                                              |
| Features    | Electron security checklist, tools, advisories                                         | runtime/fuses/ASAR integrity readable from files (LM Studio: Electron 37 EOL, runAsNode on); protocols, permission handlers, unsafe switches, updater channel                                                                                                                        |
| Real apps   | IPC shapes in 20 open-source apps                                                      | generic bridge forwarders (9 apps), multiplexed sub-commands (9), bridge object from another module (7 — the cause of holdout7's 41 missed members), cross-module forwarders (6), `@electron/remote` (3)                                                                             |
| R6          | HTTP request forms `2b23cef`                                                           | merge yes → #194 merged                                                                                                                                                                                                                                                              |

## 2. Lessons carried in from sprint 2

- At most **two** CPU-heavy agents (builds, gates, probe batteries) at a time; readers and web
  research are light. Release only at load < 5. Full gates once per change, at the end, with
  `nice`; CI runs the full gate remotely on draft PRs.
- Plan two review rounds per analysis change. Brief every author with the recurring finding
  classes: a guessed value read as known; a cap that drops rows silently or by file order; a write
  form not seen; a rule reaching readers it was not meant for; a cost blow-up on hostile input;
  docs that claim more than the code.
- Design analysis rules from real apps (§1 "Real apps") and several sets, not from one fixture.
- Read `date -u` before every log entry.

## 3. Hour by hour

Hour 0 is the start of the sprint's working time (already running: W2, C3, S1, U1).

| Time       | Work                                                                                                                                                                                                                                                                                                                                                  | Heavy               |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| 0:00–0:20  | Triage done (issues #195–#202); start the blind-set author **holdout8**, built from the real-app shapes and the research's bug classes, kept unread                                                                                                                                                                                                   | light               |
| 0:00–2:30  | **Fix round** (already running): W2 one write-detection module (#198 + RA's five write cases); C3 bridge-after-expose, quoted webPreferences keys, replaced methods, bundle replacements (#199–#202); S1 security + CI hardening (RB); U1 real-app input, `check` on real apps, `hexvero init` (#195–#197). Second reader per PR; merge in that order | 2 (+2 light phases) |
| 2:30–3:00  | Quiet slot: release **0.9.9** (#191, #194, the fix round), verify npx/registry/Pages/MCP; security note in the CHANGELOG                                                                                                                                                                                                                              | 0                   |
| 3:00–6:00  | **Feature A — the Electron runtime** (F1): packaged-app mode on top of U1; `runtime` collection (Electron/Chromium/Node from the binary); fuses + ASAR integrity incl. "covers the loaded archive"; support status from an offline `releases.json` snapshot (with its date); policy rule `fuse-weakened`                                              | 1                   |
| 3:00–6:00  | **Feature B — IPC as real apps write it** (I3): bridge object built in another module (R3), generic forwarders with renderer senders (R1), cross-module forwarders + the `ipcMain` name guard (R4), `@electron/remote` enabled (R5)                                                                                                                   | 1                   |
| 3:00–6:00  | Light, in parallel: README rewrite for newcomers (≤ ~900 words before the docs links; where `app.asar` lives; Compared with Electronegativity), one positioning everywhere, npm keywords; docs fixes D1–D5 from RB                                                                                                                                    | light               |
| 6:00–7:30  | Second-reader rounds on A and B; fixes                                                                                                                                                                                                                                                                                                                | 2                   |
| 7:30–8:30  | **Silent caps** (code health §2): one entry per limitation code kept past the 200 cap; partial files past 200 not read as complete; callSites past 64 marked partial; session's unknown-vs-removed map for every code. Plus test robustness: budgets injectable in tests, the Windows-slow fixture ↓, work-unit assertions                            | 2                   |
| 8:30–9:00  | Quiet slot: release **0.10.0**                                                                                                                                                                                                                                                                                                                        | 0                   |
| 9:00–9:30  | Measure holdout8 once on 0.10.0 and 0.9.8 (round 7)                                                                                                                                                                                                                                                                                                   | light               |
| 9:30–10:00 | Sprint-3 report, time log, metrics, memory                                                                                                                                                                                                                                                                                                            | —                   |

Later (issues, not this sprint): protocols collection, permission handlers, unsafe switches and
the rest of the checklist, updater channel, sub-commands of multiplexed channels (R2), MessagePort
RPC (R6), child-window prefs in `overrideBrowserWindowOptions` (R7), openExternal reachability,
SBOM/package diff, native module diff, a GitHub Action with PR comments, compare output that shows
the security-relevant rows and folds duplicates, progress on large apps.

## 4. Definition of done

- Every high/medium finding fixed with a regression test, or filed with the reason it waits.
- 0.9.9 and 0.10.0 released and verified like 0.9.7/0.9.8.
- holdout8 measured once, before any change in response, written down as it is.
- Report: what shipped, what the reviewers found, blind and development numbers apart, a time log
  that matches the clock.
