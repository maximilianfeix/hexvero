<div align="center">

<h1><img src="docs/logo-mark.svg" width="34" height="34" alt="" align="top"> hexvero</h1>

**Electron release diff for security review: what changed in IPC, the preload bridge, window settings and network hosts.**

[![CI](https://github.com/maximilianfeix/hexvero/actions/workflows/ci.yml/badge.svg)](https://github.com/maximilianfeix/hexvero/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/hexvero?style=flat-square&color=F2B84B&labelColor=1B1D21)](https://www.npmjs.com/package/hexvero)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2022.12-F2B84B?style=flat-square&labelColor=1B1D21)](package.json)
[![License](https://img.shields.io/badge/license-MIT-F2B84B?style=flat-square&labelColor=1B1D21)](LICENSE)

[Website and example report](https://maximilianfeix.github.io/hexvero/) · [Try it](#try-it) · [On your own app](#on-your-own-app) · [In CI](#in-ci) · [Docs](#docs) · [For AI agents](#for-ai-agents) · [Limits](#limits) · [FAQ](#faq)

**English** · [Deutsch](README.de.md) · [Español](README.es.md) · [Français](README.fr.md) · [Português (Brasil)](README.pt-BR.md) · [Русский](README.ru.md) · [中文](README.zh.md) · [日本語](README.ja.md) · [한국어](README.ko.md)

</div>

hexvero compares two builds of an Electron app (an `app.asar`, a `.app`, an install directory or a release ZIP) and tells you what changed inside them, with the file and line on both sides, for the security review or audit of a release. It only reads the files; nothing is executed.

## What it catches

From the two example builds that `npx hexvero demo` copies (NotesDesk 1.4.0 and 1.5.0):

- **New IPC and bridge surface**: `window.notesdesk.checkUpdate` is new in 1.5.0, read at `preload.js:9` and linked to its `ipcMain.handle` on `update:check` at `main.js:30`.
- **Window settings that change what pages may do**: on `main.js::win`, `nodeIntegration: true → false` and `sandbox: false → true`, reported as less permissive.
- **New network hosts and stored keys**: a request to `updates.notesdesk.example` at `main.js:30`; a `localStorage` key `notesdesk.telemetry` read at `renderer/app.bundle.js:15`.
- **What it could not establish**: `shell:open` is reported as `?` unknown, not as removed, because 1.5.0 builds channel names from an environment variable at `main.js:33`.

A release policy (`hexvero check`) turns these into a CI gate: a new interface member, a new external host, a more permissive window, or a privileged object such as `ipcRenderer` or `fs` handed to pages as it is. For a `.app`, an install directory or a release ZIP it also reads the shipped Electron runtime from the binary's bytes (Electron, Chromium and Node versions, fuses, the ASAR integrity record, and whether the Electron line is still supported by a dated snapshot of Electron's release data), and the policy flags a fuse that became less safe ([docs/cli.md](docs/cli.md#the-electron-runtime)).

![hexvero comparing two builds of an Electron app: counts of changed interfaces, window settings and hosts, the lists that were not compared whole, the window settings to review and the change filters](docs/screenshots/ui-compare.png)

<sub>The local web UI comparing the two example builds in [`examples/`](examples/). Real output.</sub>

![Terminal: hexvero demo, then compare showing a new preload member with its preload and handler lines and an IPC channel reported as unknown, then hexvero check failing the policy with exit 3](docs/demo/release-gate.gif)

<sub>25 seconds, real output: two releases, one new member pages can call with both places it was read from, a channel that is unknown rather than removed, and the policy failing with exit 3 · [mp4](docs/demo/release-gate.mp4) · recorded with [`docs/demo/release-gate.tape`](docs/demo/release-gate.tape)</sub>

<a id="try-it"></a>

## Try it

```bash
npx hexvero demo
```

Node.js 22.12 or newer is all it needs. `demo` copies the two example builds and an example policy into `./hexvero-demo` and shows what changed (shortened where marked `…`):

```text
$ npx hexvero demo
What changed between notesdesk-1.4.0.asar and notesdesk-1.5.0.asar
  Two builds of a small example Electron app, read statically. Nothing was executed.

  interfaces (2)
    + preload.js::notesdesk::checkUpdate  @ b: preload.js:9, handler main.js:30 · link direct
    - preload.js::notesdesk::openInShell  @ a: preload.js:9, handler main.js:30 · link direct
  …
  ipcChannels (2)
    + update:check  @ b: receiver main.js:30, sender preload.js:9
    ? shell:open  @ a: receiver main.js:30, sender preload.js:9
        the other side has values there that could not be resolved
  windows (1)
    ~ main.js::win  @ b: main.js:8
        nodeIntegration: true → false, nodeIntegrationInEffect: "on" → "off", sandbox: false → true
  …
  endpoints (1)
    + main.js::fetch::https://updates.notesdesk.example/latest.json  @ b: main.js:30 · literal
  …
  Next
    npx hexvero compare hexvero-demo/notesdesk-1.4.0.asar hexvero-demo/notesdesk-1.5.0.asar interfaces
    npx hexvero compare hexvero-demo/notesdesk-1.4.0.asar hexvero-demo/notesdesk-1.5.0.asar --report report.md
    npx hexvero check hexvero-demo/notesdesk-1.4.0.asar hexvero-demo/notesdesk-1.5.0.asar --policy hexvero-demo/policy.json
    npx hexvero ui --demo --open
```

`npx hexvero ui --demo --open` shows the same comparison in a local web UI, with the source lines of both builds side by side. Every step, with full output: [walkthrough](docs/walkthrough.md).

<a id="on-your-own-app"></a>

## On your own app

Point hexvero at two builds of your app, the one you shipped and the one you are about to ship:

| Platform      | Where the app is                                                                                          |
| ------------- | --------------------------------------------------------------------------------------------------------- |
| macOS         | the bundle itself, `/Applications/YourApp.app`, or `YourApp.app/Contents/Resources/app.asar`              |
| Windows       | the install directory (it holds `YourApp.exe` and `resources\`), or its `resources\app.asar`              |
| Linux         | the install directory (it holds `resources/` and the Electron runtime files), or its `resources/app.asar` |
| Release build | the `.zip` you publish, as it is                                                                          |

Installers (`.dmg`, a setup `.exe`, an AppImage) are not read as Electron apps: install or unpack them first.

```bash
npx hexvero compare old/YourApp.app new/YourApp.app --report report.html
npx hexvero init old/YourApp.app
npx hexvero check old/YourApp.app new/YourApp.app --policy .hexvero/policy.json
```

`compare --report` writes the review as one offline HTML page (`report.md` for Markdown). `init` writes `.hexvero/policy.json` with every rule at `fail` and the hosts the old build already talks to allowed. `check` exits `0` pass, `3` violated, `4` not decidable (a value it needs is computed at run time or was not read). To accept what is there now, add `--baseline .hexvero/baseline.json --update-baseline` once; later runs fail only on new findings.

<a id="in-ci"></a>

## In CI

A GitHub Actions job, pinned to a version so a release cannot change your results unannounced:

```yaml
jobs:
  hexvero:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7
        with:
          persist-credentials: false
      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7
        with:
          node-version: 24
      # Build your app and fetch the previous release here, e.g. into previous/ and dist/.
      - run: npx --yes hexvero@0.11.0 check previous/app.asar dist/app.asar --policy .hexvero/policy.json
```

The full workflow, with a baseline, a Markdown job summary and a least-privilege SARIF upload for code scanning: [docs/ci.md](docs/ci.md).

## How sure is it?

Each fact says how it was read (`literal`, `inferred`, `link direct`) and where; what could not be read is listed with its file and line. On the newest blind set, written by someone without access to hexvero, it found 52 of 64 IPC channels with none false, and misses and false rows remain in other lists. All numbers, every miss and the full list of limits: [accuracy and limits](docs/accuracy.md).

<a id="docs"></a>

## Docs

- [Walkthrough](docs/walkthrough.md): demo, compare, check, a single build, the web UI, with real output
- [CLI reference](docs/cli.md) · [CI](docs/ci.md) · [MCP server](docs/mcp.md) · [Policy schema](docs/policy.schema.json)
- [Accuracy and limits](docs/accuracy.md) · [Electron rules and their sources](docs/electron-findings.md) · [Benchmarks](docs/benchmarks.md) · [Accuracy corpus](corpus/README.md)
- [What it reads](docs/formats.md): Electron and JavaScript, plus native binaries, APK, .NET, WebAssembly, EVM and more, and the optional engines
- [Compared with Electronegativity and REA](docs/comparison.md)
- [Changelog](CHANGELOG.md)

<a id="install"></a>

## Install

Requires Node.js 22.12 or newer (SQLite files need 22.13 or 24 and newer).

```bash
npm install -g hexvero        # the hexvero command
hexvero doctor                # checks Node, node:sqlite and optional engines
```

Or run without installing: `npx hexvero <command>`.

<a id="for-ai-agents"></a>

## For AI agents

```bash
npx hexvero setup --apply          # registers the MCP server with the coding agents it finds (dry run without --apply)
npx hexvero setup --skill --apply  # installs a skill that teaches the investigation loop
```

In Claude Code the server and the skill also come as one plugin: `/plugin marketplace add maximilianfeix/hexvero`, then `/plugin install hexvero@hexvero`. Any other client can run `npx -y hexvero mcp` over stdio; pin a version for reproducible results (`npx -y hexvero@0.11.0 mcp`). 16 tools, including `hexvero_compare` and `hexvero_check`; answers are small pages with suggested next calls, and text inside the target is treated as data, never as instructions. The 18 supported clients, the tools and what an agent receives: [docs/mcp.md](docs/mcp.md).

<a id="limits"></a>

## Limits

- It reads files and never runs the program, so a finding is what the code contains, not what it does at run time, and not whether anything is exploitable. A passing check means nothing new against the policy in what was read.
- It misses things and can be wrong ([numbers](docs/accuracy.md)). Absence from a list is weaker evidence than presence.
- `hexvero check` judges seven rules; it is not a vulnerability scanner and a pass is not a security verdict. Content Security Policy, permission handlers and `shell.openExternal` calls are not checked, and fuses only for packaged builds ([what is not read](docs/electron-findings.md#not-read)).
- Not executing the target is not a safety guarantee: parsing a hostile file still processes attacker-controlled bytes, within size, depth and time limits.

The full list: [docs/accuracy.md](docs/accuracy.md#limits).

<a id="contributing"></a>

## Contributing

```bash
npm install && npm run check      # typecheck, lint, format, unit tests, shape rules
npm run e2e                       # the four user flows on real inputs (compiler and engines if installed)
```

[CONTRIBUTING.md](CONTRIBUTING.md) has the rules the review workflow enforces; issues labelled `good first issue` are sized for an afternoon; how the code is laid out: [How it works](docs/walkthrough.md#how-it-works). Found a wrong or missing fact? [Open a bug report](https://github.com/maximilianfeix/hexvero/issues/new?template=bug.yml) with the `hexvero doctor` output and, if you can share it, the file. If hexvero told you something true about a release, a star helps other people find it.

<a id="faq"></a>

## FAQ

<details><summary><b>Does hexvero run or upload my files?</b></summary>

No. Targets are parsed as bytes; nothing is executed. The UI server binds to 127.0.0.1 with a per-session token and rejects other hosts. There is no telemetry and no network call anywhere in the code base. When you use hexvero through a cloud-hosted agent, the results that agent requests are sent to its model provider like any other tool output; keep that in mind for files you would not share.

</details>

<details><summary><b>Is this a decompiler?</b></summary>

Not by itself. Built-in analysis gives you structure, symbols, strings, imports, metadata and hardening facts. For disassembly and pseudocode, install radare2, rizin or Ghidra and use `hexvero provider` or `hexvero calls` ([optional engines](docs/formats.md#optional-engines)).

</details>

<details><summary><b>Is "static" the same as "safe"?</b></summary>

Parsing a hostile file is still processing attacker-controlled bytes. hexvero bounds every parser (sizes, counts, depths, worker timeout and heap cap) and its tests include truncated and oversized inputs, but no parser is proven safe against every crafted file. Treat results as evidence, not as a verdict.

</details>

<details><summary><b>What about Windows?</b></summary>

Parsers, the CLI, the MCP server and the UI run on Windows (CI runs the test suite on Windows and macOS). Engine process handling is tested on POSIX only.

</details>

<details><summary><b>Legal</b></summary>

Use hexvero only on software you own, that is open source, or that you are permitted to examine. See [DISCLAIMER.md](DISCLAIMER.md).

</details>

## License

MIT
