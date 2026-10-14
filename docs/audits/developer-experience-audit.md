# Developer experience audit

Date: 2026-10-14, branch `oss/round-4`. Every row was run on an Apple M2 with macOS 26.5 unless it
says otherwise. Fake home directories and scratch npm caches were used, so no real agent
configuration was touched.

Status: **PASS** verified, **FAIL** verified failure, **FIXED** failed and fixed in this round,
**BLOCKED** cannot be run here, **NOT RUN** not attempted.

## First useful result

| Check                                                                                         | Result                                                                                                                    | Status |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------ |
| `npx -y hexvero@0.3.0 analyze notesdesk-1.4.0.asar` with an empty npm cache and an empty home | exit 0, findings with locations, **8.8 s** including the download, one command                                            | PASS   |
| Actions needed                                                                                | one command; no account, no config, no engine                                                                             | PASS   |
| `npx hexvero doctor`                                                                          | lists Node, `node:sqlite`, radare2, rizin, Ghidra with versions; says built-in analysis needs nothing else                | PASS   |
| The same analysis on Node 22.12.0 (the minimum in `engines`)                                  | works; `doctor` reports `node:sqlite missing — SQLite inspection disabled`                                                | PASS   |
| Whole unit suite on Node 22.12.0                                                              | 2 SQLite tests assumed `node:sqlite`; now skipped there, with a test of the clear refusal instead (218 passed, 2 skipped) | FIXED  |
| README said SQLite needs Node 24 "without warnings"                                           | it is missing entirely on 22.12; corrected to "22.13 or 24"                                                               | FIXED  |

## Setup and agent registration

| Check                                                              | Result                                                                                     | Status                                                                                                                                                               |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `setup` with no client installed (empty home)                      | printed 19 "not detected" lines and no next step                                           | FIXED: three lines, how to name a client, the known ids                                                                                                              |
| `setup` is a dry run by default                                    | nothing written until `--apply`                                                            | PASS                                                                                                                                                                 |
| `--apply` with an existing Codex TOML and Claude JSON              | entry added, other servers kept, backup `*.hexvero-backup` written first                   | PASS                                                                                                                                                                 |
| `--apply` twice                                                    | second run: "already mentions mcp_servers.hexvero; left untouched", backup not overwritten | PASS                                                                                                                                                                 |
| Malformed client JSON (`{ "mcpServers": { broken`)                 | skipped with "add the entry by hand", file untouched                                       | PASS                                                                                                                                                                 |
| Upgrade: 0.3.0 `setup --apply`, then this branch's `setup --apply` | "already configured; left untouched"                                                       | PASS                                                                                                                                                                 |
| Uninstall                                                          | no way to remove the entry                                                                 | FIXED: `setup --remove` (dry run) and `--remove --apply`, backups first; files with comments left alone with a note; tested                                          |
| Claude Code with only `~/.claude.json`                             | not detected                                                                               | FIXED: detected by `~/.claude` or `~/.claude.json`                                                                                                                   |
| Claude Code plugin                                                 | none                                                                                       | FIXED: `.claude-plugin/` manifests; `claude plugin validate --strict` passes. Installing it was not tried, because that changes the user's Claude Code configuration |
| `setup --skill --apply`                                            | copies the skill directory, moves an existing copy aside                                   | PASS (existing tests)                                                                                                                                                |

## Missing dependencies and restricted environments

| Check                                                                    | Result                                                                          | Status                                                                               |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `calls` and `provider` with no engine on `PATH`                          | `provider_unavailable: radare2 is not installed or not on PATH`, no way forward | FIXED: the message names install commands and says built-in analysis needs no engine |
| Read-only cache directory (`HEXVERO_CACHE_DIR` mode 555), large app scan | `error: EACCES: permission denied, mkdir …/scans`, no result                    | FIXED: the analysis completes and carries `scan_state_not_saved`; tested             |
| Engines time out                                                         | the engine is killed, a structured error returned, no process left behind       | PASS (end-to-end test with real radare2 and rizin, `timeoutMs: 1`)                   |
| Inspected targets executed                                               | never; no code path runs a target                                               | PASS (by design; see `security-review.md`)                                           |
| Piped `--json` output larger than 64 KiB                                 | was cut at a buffer boundary                                                    | FIXED in the previous round; re-checked: 127,922 bytes both piped and to a file      |

## Platforms

| Check                                                        | Status                                                                                         |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| macOS arm64, Node 25.2, 24.21, 22.12                         | PASS                                                                                           |
| Linux                                                        | BLOCKED here; CI runs the unit tests and end-to-end flows on Ubuntu with radare2 on every push |
| Windows                                                      | BLOCKED here; CI runs the unit tests on Windows; engines on Windows untested                   |
| Clean install from the packed tarballs into an empty project | PASS (`node scripts/smoke-tarballs.mjs`: CLI, MCP over stdio, UI server)                       |
| `ui --open`                                                  | PASS by hand in this round on a 541 MiB archive in Chrome; no automated browser test           |

## Before and after

|                                                   | Before (0.3.0 or start of round) | After (this branch)                          |
| ------------------------------------------------- | -------------------------------- | -------------------------------------------- |
| Commands to a first result                        | 1                                | 1                                            |
| Seconds to a first result from an empty npm cache | 8.8 (0.3.0)                      | not re-measured; the branch is not published |
| `setup` output with no client                     | 19 lines, no next step           | 3 lines with the command to run              |
| Ways to undo `setup`                              | 0                                | `setup --remove [--apply]`                   |
| Failure modes found without a recovery hint       | missing engine, read-only cache  | none found                                   |

## Remaining

- The time to a first result is mostly npm download time, which was not separated out.
- `setup` cannot remove an entry from a file with comments; it says so.
- Windows and Linux were only exercised through CI, which runs on push; this branch has not been
  pushed.
