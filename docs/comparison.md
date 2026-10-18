# Compared with other tools

hexvero answers one question: what changed inside an Electron app between two builds, with the
file and line behind each change, and does that change break a release policy. Other tools answer
other questions well. This page says what each one does that hexvero does not, and the reverse.
Moved here from the README after 0.9.9; the REA numbers are those of the measurement named below.

## What hexvero is built around

- **It never runs what it reads.** Every format is parsed by code in this repository. Engines are
  optional and only ever read files.
- **Evidence and honesty.** Findings are `confirmed` or `inferred` and carry the file and line
  where a parser records one. `limitations` say what was skipped, cut or unreadable. A partial
  result says it is partial, down to each page of a list.
- **Measured, not claimed.** A [corpus](../corpus/README.md) with written-down correct answers
  measures per kind of finding what is found, missed and wrongly reported, including on a set
  written by someone without access to hexvero. CI fails when a result gets worse. On that unseen
  set hexvero found more IPC channels, settings, endpoints and storage keys than REA 6.4.0 with
  far fewer false reports, and still misses a lot; both are shown
  [below](#compared-with-rea) and in [benchmarks](benchmarks.md#compared-with-rea-640).
- **Small answers for agents.** The MCP catalog is 15.6 KB (3,696 tokens) for 16 tools. A full
  Electron investigation of the corpus's hold-out app costs about 3,400 tokens; every list is a
  page with a hard byte budget and the complete result goes to a file on request
  ([numbers](benchmarks.md#what-an-agent-sees)).
- **Large apps, read to the end.** A JavaScript app is read 5,000 files at a time; `--continue`
  and `--all` read the rest and nothing is read twice.
- **A local UI** with findings, virtualized tables, a hex viewer and a module graph. Loopback
  only, keyboard-usable.

## Compared with Electronegativity

[Electronegativity](https://github.com/doyensec/electronegativity) by Doyensec is the best-known
open-source static checker for Electron. Its README describes it as "a tool to identify
misconfigurations and security anti-patterns in Electron-based applications", built on AST and
DOM parsing and on Doyensec's Electron Security Checklist. It reads a directory, a `.js` or
`.html` file, or an `.asar`, rates each finding by severity and confidence, writes CSV or SARIF,
and can run upgrade checks between two Electron versions (`-u 7..8`).

**Status.** Its README opens with "We're no longer actively maintaining this project" and points
to ElectroNG, Doyensec's commercial successor (checked 2026-10-18 on the repository's default
branch; the repository is not archived). The last npm release is
`@doyensec/electronegativity` 1.10.3, published 2023-03-09.

**A different question.** Electronegativity looks at one build and lists known risky patterns in
it. hexvero compares two builds of the same app and lists what changed. They can be used
together: Electronegativity for a checklist of one build, hexvero for the review of a release.

What hexvero adds:

- **A diff of two builds**, list by list: IPC channels, `contextBridge` members, windows and
  their `webPreferences`, endpoints, storage keys. An item the other build may hide (a value
  computed at run time, a file not read) is `unknown`, not removed.
- **An interface map**: window → preload member → IPC channel → main-process handler, with how
  each link was read (`direct`, `resolved`, or unresolved with the reason).
- **The place on both sides**: each change carries the file and line it was read from in its
  build; the web UI and the HTML report show the source lines of the build before and the build
  after side by side.
- **A release policy** (`hexvero check`): new interface member, new external host, more
  permissive window, privileged object newly handed to pages; a baseline, suppressions with a
  reason and an expiry date, exit `3` when violated and `4` when it cannot decide, SARIF 2.1.0
  for code scanning.
- **Packaged builds as they ship**: a macOS `.app`, a Windows or Linux install directory and a
  release ZIP are opened as the Electron app inside them.
- **An MCP server** for coding agents and a local web UI.

What Electronegativity checks that hexvero does not (yet), from its list of checks:

- Content Security Policy, in HTML `<meta>` tags and in response headers set from JavaScript.
- `shell.openExternal` calls. hexvero only reports `shell` or one of its methods handed to pages
  through `contextBridge` (`new-bridge-exposure`), not the calls and their arguments.
- Permission request handlers (`setPermissionRequestHandler`) and their absence.
- Custom protocol handlers (`setAsDefaultProtocolClient`, `registerFileProtocol` and related).
- Certificate handling: `certificate-error` listeners and `setCertificateVerifyProc`.
- Custom command-line switches such as `ignore-certificate-errors` or `disable-web-security`,
  appended in code or written into `package.json` scripts.
- What navigation handlers do. hexvero lists `setWindowOpenHandler`, `will-navigate` and
  `will-frame-navigate` handlers (`navigationHandlers`) but not what they check.
- `webPreferences` keys outside the ten hexvero reads (`enableBlinkFeatures`,
  `experimentalFeatures`, `affinity` …), `<webview>` attributes in HTML (`allowpopups`,
  `nodeintegration`, `disablewebsecurity` …), and `will-attach-webview` handlers.
- Disabled security warnings (`ELECTRON_DISABLE_SECURITY_WARNINGS`), `executeJavaScript`,
  `insertCSS` and `eval`-like calls, resources loaded over plain HTTP, and the Electron version
  against known security fixes.
- A severity for each finding. hexvero rates nothing by severity; its policy decides what fails.

The list of what hexvero reads is in [electron-findings.md](electron-findings.md) (section "Not
read" for the rest). No accuracy comparison between the two tools has been measured.

<a id="compared-with-rea"></a>

## Compared with REA

[REA](https://github.com/morluto/rea) is the larger and older project in this space, with dynamic
analysis, device and firmware work and decompiler integrations that hexvero does not attempt.
hexvero is an independent implementation (no REA code) for the first, static look. Measured on
2026-10-14 with REA 6.5.0 (`rea-agents` from npm); every row, command and checksum is in the
[scorecard](competitive/rea-scorecard.md).

On `corpus/holdout2`, two Electron applications in three builds each, written by an independent
agent without access to either tool, hit of expected (false):

| Blind set `holdout2`     | hexvero, blind (before this round) | REA 6.5.0          |
| ------------------------ | ---------------------------------- | ------------------ |
| IPC channels             | 90 of 126                          | 87 of 126          |
| Window settings          | 42 of 63 (6 false)                 | 8 of 63            |
| contextBridge members    | 78 of 135                          | 66 of 135          |
| Bridge member → channel  | 65 of 78                           | 6 of 66            |
| Network endpoints        | 15 of 57 (10 false)                | 6 of 57 (39 false) |
| Storage keys             | 47 of 57 (1 false)                 | 15 of 57           |
| Changes between versions | 6 of 10                            | 2 of 10 (4 false)  |

The current code reads 118 of 126 channels, 46 of 63 settings with none false, 129 of 135 bridge
members, 54 of 57 endpoints and 53 of 57 storage keys, none false, there, but that is after
working on the set's misses, so it is not a blind result.

- **The MCP catalog** is 16 KB for hexvero's 16 tools and 3.09 MB for REA's 207 (2.48 MB with
  its compact profile).
- **An agent experiment** (Claude Code, five graded questions about the same set, file reading
  allowed): both tools let the agent answer every item correctly; with hexvero it took 82 s and
  about 120 k tokens per question, with REA 190 s and 177 k
  ([method and limits](audits/agent-task-evaluation.md)).
- **On the Claude desktop app** (47 MiB), hexvero took about 5 s and returned 52 KB naming 233
  IPC channels; REA took 179 s and returned 123.5 MB, with 9 literal channels and 1,512 channel
  operations it did not resolve. That app has no written-down answer, so this is an observation,
  not an accuracy figure.
- **REA does things hexvero does not**: signed, hash-addressed evidence; ASAR integrity checks;
  sender-validation observations in IPC handlers; a full AST parse of every file.

Use REA when you need Hopper, IDA, JEB, Android devices over adb, browser capture, firmware, or
evidence records with provenance for every fact. Use hexvero for a fast first look, for agents
with small context windows, for call paths through radare2 or rizin, and for a UI.
