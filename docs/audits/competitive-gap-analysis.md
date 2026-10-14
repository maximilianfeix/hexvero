# Competitive gap analysis: hexvero and REA

Date: 2026-10-14. hexvero: branch `oss/round-4` (on 0.3.0 plus unreleased work). REA: `rea-agents`
6.5.0 for public facts, 6.4.0 for the measurements in `corpus/compare/`.

Sources are marked. **[measured]** means run on this machine with the scripts in this repository;
**[doc]** means REA's own repository or documentation, with a link; **[UNVERIFIED]** means a
secondary source or a claim that could not be checked.

## 1. Where each project stands

|                            | REA                                                                                                                                                                                                                           | hexvero                                                                                                                               |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Version, date              | 6.5.0, 2026-10-14 [doc](https://github.com/morluto/rea/releases)                                                                                                                                                              | 0.3.0 on npm, 2026-10-13; this branch unreleased                                                                                      |
| Stars, forks, contributors | 231,656 / 57,732 / 215 on 2026-10-14 [doc](https://github.com/morluto/rea)                                                                                                                                                    | single maintainer, a handful of stars                                                                                                 |
| Activity                   | 2,408 commits in 30 days, nearly all since Oct 5; 937 issues and 1,517 PRs opened Oct 8 to 14 [doc](https://github.com/morluto/rea/commits/main)                                                                              | one maintainer                                                                                                                        |
| Positioning                | "Reverse Engineer Anything": understand a feature in someone else's app and rebuild it, down to the binary level [doc](https://github.com/morluto/rea)                                                                        | a fast, local, evidence-backed first look at software, for developers and agents                                                      |
| Analysis model             | static and dynamic: Frida, process capture, live browser, adb [doc](https://github.com/morluto/rea#what-you-can-analyze)                                                                                                      | static only; nothing is executed                                                                                                      |
| Native depth               | Hopper, IDA or Ghidra for pseudocode, calls and references; objdump and rizin for offline inspection [doc](https://github.com/morluto/rea#what-you-can-analyze)                                                               | own parsers for structure, imports and hardening; radare2, rizin or Ghidra for call graphs and xrefs                                  |
| MCP catalog                | 170 tools, 1,954,693 bytes (6.4.0) **[measured]**; REA's docs: 172 tools, about 496 KB, 290 KB compact, as Claude Code receives them [doc](https://github.com/morluto/rea/blob/main/docs/client-configuration.md#claude-code) | 15 tools, 14 KB, 3,300 `o200k_base` tokens **[measured]**                                                                             |
| Setup                      | `npx rea-agents setup`: writes MCP entries and a skill into up to 24 clients, can download and install Hopper [doc](https://github.com/morluto/rea/blob/main/docs/installation.md)                                            | `npx hexvero setup` is a dry run; `--apply` for 18 clients with backups, `--remove` to undo, a Claude Code plugin; installs no engine |
| Host requirements          | Node 22.19+, 24.11+ or 26+; installer script macOS and some Linux; Windows partly, Ghidra on Windows experimental [doc](https://github.com/morluto/rea/blob/main/docs/installation.md)                                        | Node 22.12+; CI on Linux, macOS and Windows; engines optional                                                                         |
| Untrusted-content marking  | `_meta.provenance.untrusted_content: true` on results [doc](https://github.com/morluto/rea/blob/main/docs/mcp-contracts.md#untrusted-target-content)                                                                          | server instructions and skill rules; a test plants injection text in a target; no per-result flag                                     |
| Community                  | CONTRIBUTING, SECURITY, issue forms, Discussions, Discord (~18k), docs site; no code of conduct [doc](https://api.github.com/repos/morluto/rea/community/profile)                                                             | CONTRIBUTING, SECURITY, CODE_OF_CONDUCT, issue forms, CODEOWNERS, good-first-issues; no Discussions, no chat                          |

## 2. Measured on the same inputs

From `corpus/compare/summary.md` (hexvero `a6d9b82`, REA 6.4.0, Node 24.21, same machine). Only
the hold-out set is level ground: neither tool had seen it, and hexvero was tuned on the other
two. Each cell is hit / missed / false over three builds of one Electron app.

| Class                           | hexvero                                | REA                                                         |
| ------------------------------- | -------------------------------------- | ----------------------------------------------------------- |
| IPC channels                    | 41 / 31 / 0                            | 33 / 39 / 0                                                 |
| Window settings                 | 12 / 21 / 0                            | 0 / 33 / 0                                                  |
| contextBridge members           | 60 / 9 / 0                             | 0 / 69 / 0                                                  |
| Endpoints                       | 24 / 18 / 5                            | 9 / 33 / 30 (9 / 33 / 3 if store calls are read as storage) |
| Storage keys                    | 42 / 9 / 0                             | 12 / 39 / 0 (30 / 21 / 9 read the other way)                |
| Native call paths, six binaries | 70 / 2 / 0 (radare2 alone: 70 / 0 / 0) | not run: no Ghidra, Hopper or IDA installed                 |
| Damaged inputs                  | 6 of 6                                 | 6 of 6 (all refused with structured errors)                 |

Times in that comparison were taken on a busy machine and support no speed claim.

## 3. The gaps, sorted

### 3.1 Verified REA capabilities hexvero does not have

- Dynamic analysis: Frida, process capture, live browser sessions, adb devices. **Deliberate**:
  hexvero is static by design and says so.
- Commercial engines (Hopper, IDA, JEB) and installing them. **Deliberate**.
- Firmware unpacking (Binwalk, Unblob), pcap and logic-signal analysis, crash dumps. Out of scope.
- Evidence ids with source ranges for every fact, renderer-to-handler pairing with handler source,
  sender-validation observations [doc](https://github.com/morluto/rea/blob/main/docs/mcp-contracts.md).
  hexvero has `file:line[:column]` per row but no stable evidence id. **Real gap.**
- Complete parsing of very large Electron apps in one call. hexvero reads in batches, and since
  this round's name resolution it is about 2.3 times slower than its own 0.3.0. **Real gap** in
  speed.

### 3.2 Verified hexvero capabilities REA does not have

- Call paths through radare2 or rizin, including tail calls, with no commercial engine.
- A small catalog (14 KB) and small first answers with suggested next calls (about 3,000 tokens for
  an Electron investigation of the hold-out app).
- A corpus with written-down correct answers, a scorer per class and a CI gate, including a set
  written blind.
- `setup` that is a dry run by default and can remove what it added; nothing installed beyond the
  MCP entry and an optional skill.
- A local web UI.

### 3.3 Features that exist in hexvero but are hard to use

- Engine operations depend on the engine being on `PATH`; the error now says how to install one,
  but nothing installs it.
- `hexvero_unknowns` and the five guided prompts are not on the first screen of the README, and it
  is **[UNVERIFIED]** how often agents use MCP prompts at all.
- Comparing two partly read apps requires reading both with `--all` first; the result warns but
  does not offer to do it.

### 3.4 Product-design gaps

- Before this round a native first look said "(no findings)" for a program that imports `system`.
  Fixed: hardening and notable imports are findings now.
- No per-result untrusted-content flag (REA has one). Low cost; no client is known to act on it.
- The UI has no comparison view; comparisons are CLI and MCP only.

### 3.5 Marketing and discoverability gaps

- Not listed in the official MCP registry (needs a publish of a version that carries `mcpName`,
  added in this round), not on Glama, not in awesome lists; no Claude Code plugin before this
  round.
- No demonstration on a well-known real application (copyright prevents bundling one; a write-up
  on a public open-source Electron app is possible).
- The README led with a feature inventory; rewritten in this round around one command and three
  use cases.

### 3.6 Deliberate architectural tradeoffs (not gaps)

| hexvero chooses                    | Instead of              | Because                                                                                                                                   |
| ---------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| static only                        | dynamic instrumentation | no execution of untrusted code; works in sandboxes and CI                                                                                 |
| own parsers, optional open engines | commercial engines      | nothing to install for the first answer, any OS                                                                                           |
| 15 tools with paging               | 170 specialised tools   | the context budget of agents; REA's own issues report catalogs too big for some clients [doc](https://github.com/morluto/rea/issues/1554) |
| reading in batches                 | one complete parse      | bounded memory (0.7 GiB on a 541 MiB archive **[measured]**)                                                                              |

### 3.7 Where to differentiate rather than imitate

1. **Trust**: measured accuracy per class, honest limits, partial results marked everywhere.
2. **Safety**: never executes, dry-run setup with removal, no global installs.
3. **Agent cost**: small catalog and small first answers, measured in tokens.
4. **Electron static triage**: IPC, bridge, settings, endpoints and storage with locations,
   compared across versions.

## 4. The brief's dimensions

| Dimension                        | REA                                                          | hexvero                                                           | Evidence                                        |
| -------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------- | ----------------------------------------------- |
| First-time setup                 | one command, interactive, writes configs, may install Hopper | one command to analyze; `setup` dry run then `--apply`            | [doc], **[measured]**                           |
| Time to first useful result      | not measured here                                            | 1 command, about 9 s from an empty npm cache                      | **[measured]**, `developer-experience-audit.md` |
| Agent discoverability            | skill on skills.sh, official MCP registry                    | plugin manifest and `mcpName` added this round; not yet published | [doc], this branch                              |
| Explanations                     | evidence bundles with per-fact provenance                    | findings with confidence and location, next steps                 | `docs/demo/agent-session.md`                    |
| Evidence traceability            | evidence ids and source ranges                               | file, line, column per row; no ids                                | corpus scorer                                   |
| Cross-platform                   | macOS and Linux installer; Windows partial                   | Node only; CI on three OSes                                       | CI workflow                                     |
| Accuracy on unseen Electron code | table 2                                                      | table 2                                                           | `corpus/compare`                                |
| Memory                           | 1.0 GiB on a 568 MB archive, complete (6.4.0)                | 0.7 GiB on the same archive, per batch                            | `docs/benchmarks.md`                            |
| Context efficiency               | 290 to 496 KB catalog by REA's docs                          | 14 KB catalog                                                     | [doc], **[measured]**                           |
| Large files                      | complete parse, minutes                                      | batches, `--all`, seconds per batch                               | **[measured]**                                  |
| Error handling                   | structured errors, `resource_constraint`                     | structured errors with codes, limitations                         | both                                            |
| Onboarding docs                  | extensive, 20 languages                                      | README, docs/, 9 languages                                        | repositories                                    |
| Installation safety              | writes configs after approval, can install apps              | dry run by default, backups, `--remove`                           | **[measured]**                                  |
| Test coverage                    | not measured                                                 | 230+ unit tests, 11 real end-to-end flows, corpus gate            | this branch                                     |
| Release engineering              | release-please, frequent releases                            | verified pipeline with provenance and a registry smoke test       | `.github/workflows/release.yml`                 |
| Community                        | very large, fast-moving                                      | small                                                             | [doc]                                           |

## 5. Prioritized backlog

Priority = user impact × confidence × differentiation ÷ effort, each on a scale of 1 to 3.

| P   | Item                                                                     | Impact | Conf. | Diff. | Effort | Score | State                                      |
| --- | ------------------------------------------------------------------------ | ------ | ----- | ----- | ------ | ----- | ------------------------------------------ |
| P0  | Analysis fails on a read-only cache directory                            | 3      | 3     | 1     | 1      | 9     | done                                       |
| P1  | First MCP answer too large (overview samples)                            | 3      | 3     | 3     | 1      | 27    | done                                       |
| P1  | Native first look says nothing useful                                    | 3      | 3     | 2     | 1      | 18    | done                                       |
| P1  | Claude Code plugin and registry metadata                                 | 3      | 3     | 2     | 1      | 18    | done (files; reaches users with a release) |
| P1  | Publish a release so the work reaches users                              | 3      | 3     | 2     | 1      | 18    | needs approval                             |
| P1  | No way to undo `setup`                                                   | 2      | 3     | 2     | 1      | 12    | done                                       |
| P1  | Hold-out misses: channels from classes and Maps, `Object.assign` options | 3      | 3     | 3     | 3      | 9     | open; write a new blind set first          |
| P1  | Speed regression from name resolution                                    | 2      | 3     | 1     | 3      | 2     | open                                       |
| P2  | Stable evidence ids per fact                                             | 2      | 2     | 2     | 2      | 4     | open                                       |
| P2  | Comparison view in the UI                                                | 2      | 2     | 2     | 2      | 4     | open                                       |
| P2  | Ghidra verified against the corpus                                       | 2      | 2     | 1     | 1      | 4     | blocked: not installed                     |
| P2  | Per-result untrusted-content flag                                        | 1      | 3     | 1     | 1      | 3     | open                                       |
| P3  | Dynamic analysis                                                         | 2      | 1     | 1     | 3      | 1     | not planned                                |

## 6. Uncertainties

- REA's popularity numbers are verified; their causes are not.
- Reddit rules could not be fetched (see `docs/growth/launch-strategy.md`).
- REA 6.5.0 was not measured; the corpus comparison is on 6.4.0.
- hexvero's corpus results describe three small Electron apps and three C programs on macOS arm64;
  nothing here measures accuracy on large real applications.
