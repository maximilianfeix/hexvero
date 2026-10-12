# hexvero — product context

> Written from the build brief while the owner was unavailable; items marked _assumed_ are inferences, not confirmed answers.

## What it is

hexvero is a local reverse-engineering workbench. It reads executables (ELF, PE, Mach-O), Go and .NET
binaries, WebAssembly, EVM bytecode, SQLite databases, property lists, Android APKs, Electron/JavaScript
applications, source maps and HAR captures **without running them**, and returns findings with the
evidence and the limitations behind each conclusion. It ships as a CLI, a compact MCP server for coding
agents, and a local web UI.

## Who uses it

- Developers who want to understand how a shipped app works (an Electron app's IPC, a Go binary's
  dependencies, an APK's permissions) before building something similar. _assumed: primary audience_
- Security-minded engineers doing quick triage of a binary or bundle on their own machine.
- Coding agents (Claude Code, Codex, Cursor) driving the same analyses through MCP.

## The job of the web UI (Operate mode)

Drop a file, see what it is and what matters within seconds, then dig: findings, symbols, imports,
strings, hex, the module graph. Everything stays on the machine. The UI is a workbench, not a marketing
page: scanability, dense but legible tables, keyboard navigation, honest empty/partial states.

## Non-negotiables

- Never executes a target. Never uploads anything off the machine.
- Every list is paged; large results never freeze the page.
- Findings show confidence (confirmed vs inferred); limitations are always visible, never hidden.
- Works offline; no external fonts or CDNs at runtime (fonts are self-hosted or system). _assumed_
- Dark-first, used in dim rooms next to a terminal; a light theme follows the OS setting. _assumed_

## Voice

Plain, specific, technical. Names formats and facts; no hype. Sentence case. Errors name the problem
and the fix.

## Out of scope for v1

Live debugging, patching, emulation, cloud sync, accounts.
